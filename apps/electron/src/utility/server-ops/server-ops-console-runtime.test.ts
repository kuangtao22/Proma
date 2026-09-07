import { describe, expect, test } from 'bun:test'
import { SERVER_OPS_DOCKER_CONSOLE_COMMAND_PREFIX, ServerOpsConsoleRuntimeController } from './server-ops-console-runtime'
import type { ServerOpsConsoleRuntimeChannel, ServerOpsConsoleRuntimeMessage } from './server-ops-console-runtime'

const identity = { consoleId: 'console-1', hostId: 'host-1', connectionId: 'connection-1', containerId: 'a'.repeat(64) }

describe('Server Ops Docker Console utility controller', () => {
  test('Given 合法身份 When 启动 Console Then 使用独立 exec PTY、固定 shell 与 ACK 输出窗口', () => {
    const messages: ServerOpsConsoleRuntimeMessage[] = []
    let command = ''
    let options: unknown
    let dataListener: ((data: string) => void) | undefined
    let closeListener: (() => void) | undefined
    const scheduledFlushes: Array<() => void> = []
    const writes: string[] = []
    const channel: ServerOpsConsoleRuntimeChannel = {
      write: (data) => { writes.push(data) }, setWindow: () => undefined,
      onData: (listener) => { dataListener = listener as (data: string) => void }, onStderrData: () => undefined,
      onceExit: () => undefined, onceClose: (listener) => { closeListener = listener }, close: () => { closeListener?.() },
    }
    const controller = new ServerOpsConsoleRuntimeController<number>({
      execute: (nextCommand, nextOptions, callback) => { command = nextCommand; options = nextOptions; callback(undefined, channel) },
      post: (message) => { messages.push(message) },
      setTimer: (callback) => { scheduledFlushes.push(callback); return scheduledFlushes.length },
      clearTimer: () => undefined,
    })

    controller.start({ ...identity, cols: 80, rows: 24 })
    controller.write({ ...identity, data: 'pwd\n' })
    dataListener?.('hello')
    expect(command).toBe(`${SERVER_OPS_DOCKER_CONSOLE_COMMAND_PREFIX} container exec -it -- ${identity.containerId} /bin/sh`)
    expect(options).toEqual({ pty: { term: 'xterm-256color', cols: 80, rows: 24 } })
    expect(writes).toEqual(['pwd\n'])
    expect(messages).toEqual([{ type: 'server-ops.console-started', session: identity }])
    scheduledFlushes[0]?.()
    expect(messages).toMatchObject([
      { type: 'server-ops.console-started', session: identity },
      { type: 'server-ops.console-output', event: { ...identity, sequence: 1, data: 'hello' } },
    ])
    closeListener?.()
    expect(messages.at(-1)?.type).toBe('server-ops.console-output')
    controller.acknowledge({ ...identity, sequence: 1 })
    expect(messages.at(-1)).toMatchObject({ type: 'server-ops.console-exit', event: identity })
  })

  test('Given 伪造容器或连接身份 When 输入、调整、ACK 或关闭 Then 不命中真实 channel', () => {
    let writes = 0
    let closes = 0
    const channel: ServerOpsConsoleRuntimeChannel = {
      write: () => { writes += 1 }, setWindow: () => { writes += 1 }, onData: () => undefined, onStderrData: () => undefined,
      onceExit: () => undefined, onceClose: () => undefined, close: () => { closes += 1 },
    }
    const controller = new ServerOpsConsoleRuntimeController<number>({ execute: (_command, _options, callback) => callback(undefined, channel),
      post: () => undefined, setTimer: () => 1, clearTimer: () => undefined })
    controller.start({ ...identity, cols: 80, rows: 24 })
    const forged = { ...identity, containerId: 'b'.repeat(64) }
    controller.write({ ...forged, data: 'id\n' }); controller.resize({ ...forged, cols: 90, rows: 30 }); controller.stop(forged)
    controller.acknowledge({ ...forged, sequence: 1 })
    expect(writes).toBe(0)
    expect(closes).toBe(0)
  })
})
