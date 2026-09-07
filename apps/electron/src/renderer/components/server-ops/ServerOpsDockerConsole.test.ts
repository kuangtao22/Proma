import { describe, expect, test } from 'bun:test'
import type { ServerOpsConsoleExitEvent, ServerOpsConsoleIdentity, ServerOpsConsoleOutputEvent } from '@proma/shared'
import type { ServerOpsConsolePreloadApi } from '../../../preload/server-ops-console-preload'
import {
  attachServerOpsDockerConsole,
  type ServerOpsDockerConsoleTerminal,
} from './ServerOpsDockerConsole'

/** 测试使用的完整 Console 身份。 */
const session = { consoleId: 'console-1', hostId: 'host-1', connectionId: 'connection-1', containerId: 'a'.repeat(64) }

/** 等待 start、snapshot 与 ACK 的微任务链完成。 */
async function flushPromises(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('Server Ops Docker Console 组件生命周期', () => {
  test('Given 输出先于 start 完成 When snapshot 恢复并写入 xterm Then write callback 后 ACK 且卸载精确关闭', async () => {
    let outputListener: (event: ServerOpsConsoleOutputEvent) => void = () => undefined
    let exitListener: (event: ServerOpsConsoleExitEvent) => void = () => undefined
    let inputListener: (data: string) => void = () => undefined
    let resolveStart!: (value: ServerOpsConsoleIdentity) => void
    const start = new Promise<ServerOpsConsoleIdentity>((resolve) => { resolveStart = resolve })
    const acknowledgements: ServerOpsConsoleOutputEvent[] = []
    const closes: ServerOpsConsoleIdentity[] = []
    const sessions: Array<ServerOpsConsoleIdentity | null> = []
    const writes: Array<{ data: string; callback?: () => void }> = []
    let disposed = false
    const snapshot = { ...session, sequence: 1, data: 'snapshot' }
    const api: ServerOpsConsolePreloadApi = {
      startServerOpsConsole: async () => await start,
      closeServerOpsConsole: async (input) => { closes.push(input) },
      writeServerOpsConsole: async () => undefined,
      resizeServerOpsConsole: async () => undefined,
      acknowledgeServerOpsConsoleOutput: async (input) => { acknowledgements.push({ ...snapshot, sequence: input.sequence }) },
      getServerOpsConsoleSnapshot: async () => snapshot,
      onServerOpsConsoleOutput: (listener) => { outputListener = listener; return () => { outputListener = () => undefined } },
      onServerOpsConsoleExit: (listener) => { exitListener = listener; return () => { exitListener = () => undefined } },
    }
    const terminal: ServerOpsDockerConsoleTerminal = {
      cols: 80,
      rows: 24,
      write: (data, callback) => { writes.push({ data, callback }) },
      focus: () => undefined,
      onData: (listener) => { inputListener = listener; return { dispose: () => { inputListener = () => undefined } } },
      dispose: () => { disposed = true },
    }

    const detach = attachServerOpsDockerConsole({
      api, hostId: session.hostId, containerId: session.containerId, active: true, terminal,
      fit: () => undefined, observeResize: () => () => undefined, onSession: (value) => sessions.push(value),
    })
    /** 订阅已建立但 session 尚未确认，实时事件必须等待 snapshot 恢复。 */
    outputListener(snapshot)
    expect(writes).toHaveLength(0)
    resolveStart(session)
    await flushPromises()
    expect(writes.map((entry) => entry.data)).toEqual(['snapshot'])
    expect(acknowledgements).toHaveLength(0)
    writes[0]?.callback?.()
    await flushPromises()
    expect(acknowledgements).toHaveLength(1)
    expect(sessions[0]).toEqual(session)

    detach()
    await flushPromises()
    expect(closes).toEqual([session])
    expect(sessions.at(-1)).toBeNull()
    expect(disposed).toBe(true)
    /** 清理后的旧监听和输入均不能产生副作用。 */
    outputListener({ ...snapshot, sequence: 2 })
    exitListener({ ...session, message: 'late' })
    inputListener('id\n')
    expect(writes).toHaveLength(1)
  })
})
