import { describe, expect, test } from 'bun:test'
import type { ServerOpsConsoleExitEvent, ServerOpsConsoleIdentity, ServerOpsConsoleOutputEvent } from '@proma/shared'
import { ServerOpsDockerConsoleService } from './server-ops-docker-console-service'
import type { ServerOpsConnectionConsoleExitEvent, ServerOpsConnectionConsoleOutputEvent } from './server-ops-connection-service'

const containerId = 'a'.repeat(64)

interface Deferred<T> { promise: Promise<T>; resolve(value: T): void }

/** 创建可控 Promise，用于验证 start/close 的异步窗口。 */
function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((nextResolve) => { resolve = nextResolve })
  return { promise, resolve }
}

function fixture(options: {
  start?: (identity: ServerOpsConsoleIdentity) => Promise<ServerOpsConsoleIdentity>
  stop?: (identity: ServerOpsConsoleIdentity) => Promise<void>
} = {}) {
  let identity = { hostId: 'host-1', connectionId: 'connection-1', generation: 1 }
  let outputListener: (event: ServerOpsConnectionConsoleOutputEvent) => void = () => undefined
  let exitListener: (event: ServerOpsConnectionConsoleExitEvent) => void = () => undefined
  const calls: Array<{ type: string; input: unknown }> = []
  const outputs: Array<{ ownerId: number; event: ServerOpsConsoleOutputEvent }> = []
  const exits: Array<{ ownerId: number; event: ServerOpsConsoleExitEvent }> = []
  const service = new ServerOpsDockerConsoleService({
    connection: {
      getActiveIdentity: () => ({ ...identity }),
      startConsole: async (current, consoleId, nextContainerId) => {
        const session = { consoleId, hostId: current.hostId, connectionId: current.connectionId, containerId: nextContainerId }
        return options.start ? await options.start(session) : session
      },
      stopConsole: async (input) => { calls.push({ type: 'stop', input }); await options.stop?.(input) },
      writeConsole: (input) => { calls.push({ type: 'write', input }) },
      resizeConsole: (input) => { calls.push({ type: 'resize', input }) },
      acknowledgeConsole: (input) => { calls.push({ type: 'ack', input }) },
      onConsoleOutput: (listener) => { outputListener = listener; return () => undefined },
      onConsoleExit: (listener) => { exitListener = listener; return () => undefined },
    },
    publishOutput: (ownerId, event) => { outputs.push({ ownerId, event }) },
    publishExit: (ownerId, event) => { exits.push({ ownerId, event }) },
    uuid: () => 'console-1',
  })
  return { service, calls, outputs, exits, emitOutput: (event: ServerOpsConnectionConsoleOutputEvent) => outputListener(event),
    emitExit: (event: ServerOpsConnectionConsoleExitEvent) => exitListener(event),
    setIdentity: (next: typeof identity) => { identity = { ...next } } }
}

describe('Server Ops Docker Console Service', () => {
  test('Given owner 启动 Console When 输入、resize、output 与 ACK Then 全程绑定完整身份且恢复 snapshot', async () => {
    const f = fixture()
    const session = await f.service.start(7, { hostId: 'host-1', containerId, cols: 80, rows: 24 })
    f.service.write(7, { ...session, data: 'pwd\n' })
    f.service.resize(7, { ...session, cols: 100, rows: 30 })
    f.emitOutput({ ...session, generation: 1, sequence: 1, data: 'hello' })
    expect(f.service.getSnapshot(7, session)).toMatchObject({ sequence: 1, data: 'hello' })
    f.service.acknowledge(7, { ...session, sequence: 1 })
    expect(f.service.getSnapshot(7, session)).toBeUndefined()
    expect(f.outputs).toEqual([{ ownerId: 7, event: { ...session, sequence: 1, data: 'hello' } }])
    expect(f.calls.map((call) => call.type)).toEqual(['write', 'resize', 'ack'])
  })

  test('Given owner 已有 Console 或伪造 owner/container When 操作 Then 拒绝且不命中 channel', async () => {
    const f = fixture()
    const session = await f.service.start(7, { hostId: 'host-1', containerId, cols: 80, rows: 24 })
    await expect(f.service.start(7, { hostId: 'host-1', containerId, cols: 80, rows: 24 })).rejects.toThrow('SERVER_OPS_CONSOLE_BUSY')
    expect(() => f.service.write(8, { ...session, data: 'id\n' })).toThrow('SERVER_OPS_CONSOLE_NOT_ACTIVE')
    expect(() => f.service.write(7, { ...session, containerId: 'b'.repeat(64), data: 'id\n' })).toThrow('SERVER_OPS_CONSOLE_NOT_ACTIVE')
    expect(f.calls).toHaveLength(0)
  })

  test('Given 连接变化或窗口销毁 When 收口 Then 旧事件不发布且精确关闭 owner Console', async () => {
    const f = fixture()
    const session = await f.service.start(7, { hostId: 'host-1', containerId, cols: 80, rows: 24 })
    f.setIdentity({ hostId: 'host-1', connectionId: 'connection-2', generation: 2 })
    expect(() => f.service.write(7, { ...session, data: 'id\n' })).toThrow('SERVER_OPS_CONSOLE_NOT_ACTIVE')
    f.emitOutput({ ...session, generation: 1, sequence: 1, data: 'late' })
    f.service.disposeOwner(7)
    await Promise.resolve()
    expect(f.outputs).toHaveLength(0)
    expect(f.calls).toEqual([{ type: 'stop', input: session }])
  })

  test('Given start 等待期间 owner 销毁 When runtime 迟到确认 Then start 拒绝且不会返回已关闭 session', async () => {
    const started = createDeferred<ServerOpsConsoleIdentity>()
    const f = fixture({ start: async () => await started.promise })
    const pending = f.service.start(7, { hostId: 'host-1', containerId, cols: 80, rows: 24 })
    await Promise.resolve()
    f.service.disposeOwner(7)
    await Promise.resolve()
    const session = { consoleId: 'console-1', hostId: 'host-1', connectionId: 'connection-1', containerId }
    started.resolve(session)

    await expect(pending).rejects.toThrow('SERVER_OPS_CONSOLE_CONNECTION_CHANGED')
    expect(f.calls).toEqual([{ type: 'stop', input: session }])
  })

  test('Given close 已开始但 runtime 尚未确认 When 输入、resize、ACK、snapshot 与 output 到达 Then 全部拒绝', async () => {
    const stopped = createDeferred<void>()
    const f = fixture({ stop: async () => await stopped.promise })
    const session = await f.service.start(7, { hostId: 'host-1', containerId, cols: 80, rows: 24 })
    const closing = f.service.close(7, session)

    expect(() => f.service.write(7, { ...session, data: 'id\n' })).toThrow('SERVER_OPS_CONSOLE_NOT_ACTIVE')
    expect(() => f.service.resize(7, { ...session, cols: 100, rows: 30 })).toThrow('SERVER_OPS_CONSOLE_NOT_ACTIVE')
    expect(() => f.service.acknowledge(7, { ...session, sequence: 1 })).toThrow('SERVER_OPS_CONSOLE_NOT_ACTIVE')
    expect(() => f.service.getSnapshot(7, session)).toThrow('SERVER_OPS_CONSOLE_NOT_ACTIVE')
    f.emitOutput({ ...session, generation: 1, sequence: 1, data: 'late' })
    expect(f.outputs).toHaveLength(0)
    stopped.resolve()
    await closing
  })

  test('Given service 已 dispose When 再启动 Console Then 拒绝创建新生命周期', async () => {
    const f = fixture()
    f.service.dispose()
    await expect(f.service.start(7, { hostId: 'host-1', containerId, cols: 80, rows: 24 }))
      .rejects.toThrow('SERVER_OPS_CONSOLE_UNAVAILABLE')
  })
})
