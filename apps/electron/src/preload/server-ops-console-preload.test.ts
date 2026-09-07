import { describe, expect, test } from 'bun:test'
import { SERVER_OPS_CONSOLE_IPC_CHANNELS } from '@proma/shared'
import { createServerOpsConsolePreload } from './server-ops-console-preload'

const session = { consoleId: 'console-1', hostId: 'host-1', connectionId: 'connection-1', containerId: 'a'.repeat(64) }

describe('Server Ops Docker Console preload', () => {
  test('Given 合法请求与事件 When bridge 调用 Then 使用独立通道并严格重建身份', async () => {
    const calls: string[] = []
    const listeners = new Map<string, (_event: unknown, value: unknown) => void>()
    const bridge = createServerOpsConsolePreload({
      invoke: async (channel) => { calls.push(channel); return channel === SERVER_OPS_CONSOLE_IPC_CHANNELS.START ? session : undefined },
      on: (channel, listener) => { listeners.set(channel, listener) },
      removeListener: (channel) => { listeners.delete(channel) },
    })
    await expect(bridge.startServerOpsConsole({ hostId: 'host-1', containerId: session.containerId, cols: 80, rows: 24 })).resolves.toEqual(session)
    await bridge.writeServerOpsConsole({ ...session, data: 'pwd\n' })
    const outputs: string[] = []
    const dispose = bridge.onServerOpsConsoleOutput((event) => outputs.push(event.data))
    listeners.get(SERVER_OPS_CONSOLE_IPC_CHANNELS.OUTPUT)?.({}, { ...session, sequence: 1, data: 'hello' })
    expect(outputs).toEqual(['hello'])
    dispose()
    expect(calls).toEqual([SERVER_OPS_CONSOLE_IPC_CHANNELS.START, SERVER_OPS_CONSOLE_IPC_CHANNELS.WRITE])
  })

  test('Given Renderer 或 Main 夹带字段 When bridge 解析 Then fail closed', async () => {
    const bridge = createServerOpsConsolePreload({ invoke: async () => ({ ...session, secret: true }), on: () => undefined, removeListener: () => undefined })
    await expect(bridge.startServerOpsConsole({ hostId: 'host-1', containerId: session.containerId, cols: 80, rows: 24, shell: 'bash' } as never)).rejects.toThrow()
    await expect(bridge.startServerOpsConsole({ hostId: 'host-1', containerId: session.containerId, cols: 80, rows: 24 })).rejects.toThrow()
  })
})
