import { describe, expect, test } from 'bun:test'
import { SERVER_OPS_IPC_CHANNELS } from '@proma/shared'
import type { ServerOpsConnectionState, ServerOpsHost, ServerOpsTerminalExitEvent, ServerOpsTerminalOutputEvent, ServerOpsUpsertHostInput } from '@proma/shared'
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { registerServerOpsIpcHandlers } from './server-ops-ipc'

/** 测试 IPC handler 的最小签名。 */
type TestHandler = (event: IpcMainInvokeEvent, input?: unknown) => unknown

/** 创建带固定 ID 的测试窗口。 */
function createSender(id: number): WebContents {
  return { id, isDestroyed: () => false, send: () => undefined } as unknown as WebContents
}

/** 创建 IPC 测试使用的连接 Service。 */
function createConnections() {
  return {
    connect: async () => ({ hostId: 'host-1', connectionId: 'connection-1', phase: 'connected' as const }),
    confirmHostKey: async () => ({ hostId: 'host-1', connectionId: 'connection-1', phase: 'connected' as const }),
    disconnect: (hostId: string) => ({ hostId, phase: 'disconnected' as const }),
    writeTerminal: () => undefined,
    resizeTerminal: () => undefined,
    acknowledgeOutput: () => undefined,
    getTerminalSnapshot: () => undefined,
    onState: () => () => undefined,
    onOutput: () => () => undefined,
    onExit: () => () => undefined,
  }
}

/** 调用已注册的指定 handler。 */
function invoke(
  handlers: Map<string, TestHandler>,
  channel: string,
  sender: WebContents,
  input?: unknown,
): Promise<unknown> {
  /** 指定通道对应的 handler。 */
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`handler 未注册: ${channel}`)
  return Promise.resolve().then(() => handler({ sender } as IpcMainInvokeEvent, input))
}

/** 创建供 IPC 测试使用的完整主机。 */
function createHost(name = '生产 API'): ServerOpsHost {
  return {
    id: 'host-1',
    name,
    address: '10.0.0.8',
    port: 22,
    username: 'deploy',
    authMethod: 'ssh-agent',
    tags: ['生产'],
    createdAt: 1_000,
    updatedAt: 1_000,
  }
}

describe('服务器运维 IPC', () => {
  test('授权主窗口可列出、新增编辑并删除主机', async () => {
    /** 每个通道注册的测试 handler。 */
    const handlers = new Map<string, TestHandler>()
    /** 被允许访问运维资产的主窗口。 */
    const sender = createSender(7)
    /** Store 收到的调用记录。 */
    const calls: string[] = []
    /** 测试用 IPC 注册结果。 */
    const registration = registerServerOpsIpcHandlers({
      ipc: {
        handle: (channel, handler) => { handlers.set(channel, handler) },
        removeHandler: (channel) => { handlers.delete(channel) },
      },
      listAuthorizedWebContents: () => [sender],
      hosts: {
        list: () => { calls.push('list'); return [createHost()] },
        upsert: (input: ServerOpsUpsertHostInput) => { calls.push(`upsert:${input.name}`); return createHost(input.name) },
        remove: (hostId: string) => { calls.push(`remove:${hostId}`); return true },
      },
      connections: createConnections(),
    })

    expect(registration.channels).toEqual(Object.values(SERVER_OPS_IPC_CHANNELS).filter((channel) => !([
      SERVER_OPS_IPC_CHANNELS.CONNECTION_STATE,
      SERVER_OPS_IPC_CHANNELS.TERMINAL_OUTPUT,
      SERVER_OPS_IPC_CHANNELS.TERMINAL_EXIT,
    ] as readonly string[]).includes(channel)))
    expect(await invoke(handlers, SERVER_OPS_IPC_CHANNELS.LIST_HOSTS, sender)).toEqual([createHost()])
    expect(await invoke(handlers, SERVER_OPS_IPC_CHANNELS.UPSERT_HOST, sender, {
      name: ' 生产 API 01 ',
      address: '10.0.0.8',
      port: 22,
      username: 'deploy',
      authMethod: 'ssh-agent',
      tags: [],
    })).toMatchObject({ name: '生产 API 01' })
    expect(await invoke(handlers, SERVER_OPS_IPC_CHANNELS.DELETE_HOST, sender, 'host-1')).toBe(true)
    expect(calls).toEqual(['list', 'upsert:生产 API 01', 'remove:host-1'])

    registration.dispose()
    expect(handlers.size).toBe(0)
  })

  test('拒绝非主窗口、未知字段和密码字段', async () => {
    /** 测试 handler 注册表。 */
    const handlers = new Map<string, TestHandler>()
    /** 唯一授权主窗口。 */
    const sender = createSender(7)
    registerServerOpsIpcHandlers({
      ipc: {
        handle: (channel, handler) => { handlers.set(channel, handler) },
        removeHandler: (channel) => { handlers.delete(channel) },
      },
      listAuthorizedWebContents: () => [sender],
      hosts: {
        list: () => [],
        upsert: () => createHost(),
        remove: () => true,
      },
      connections: createConnections(),
    })

    await expect(invoke(handlers, SERVER_OPS_IPC_CHANNELS.LIST_HOSTS, createSender(8))).rejects.toThrow('SERVER_OPS_ACCESS_DENIED')
    await expect(invoke(handlers, SERVER_OPS_IPC_CHANNELS.UPSERT_HOST, sender, {
      name: '生产 API',
      address: '10.0.0.8',
      port: 22,
      username: 'deploy',
      authMethod: 'ssh-agent',
      tags: [],
      password: 'secret',
    })).rejects.toThrow('SERVER_OPS_HOST_INPUT_INVALID')
    await expect(invoke(handlers, SERVER_OPS_IPC_CHANNELS.DELETE_HOST, sender, '../outside')).rejects.toThrow('SERVER_OPS_HOST_ID_INVALID')
  })

  test('连接、终端操作与公开事件均绑定授权窗口', async () => {
    /** 每个通道注册的测试 handler。 */
    const handlers = new Map<string, TestHandler>()
    /** 主进程推送给 Renderer 的公开事件。 */
    const events: Array<{ channel: string; payload: unknown }> = []
    /** 唯一授权主窗口。 */
    const sender = {
      id: 7,
      isDestroyed: () => false,
      send: (channel: string, payload: unknown) => { events.push({ channel, payload }) },
    } as unknown as WebContents
    /** 连接 Service 的订阅回调。 */
    let stateListener: ((state: ServerOpsConnectionState) => void) | undefined
    let outputListener: ((event: ServerOpsTerminalOutputEvent) => void) | undefined
    let exitListener: ((event: ServerOpsTerminalExitEvent) => void) | undefined
    /** 终端写入收到的数据。 */
    const writes: string[] = []

    registerServerOpsIpcHandlers({
      ipc: {
        handle: (channel, handler) => { handlers.set(channel, handler) },
        removeHandler: (channel) => { handlers.delete(channel) },
      },
      listAuthorizedWebContents: () => [sender],
      hosts: { list: () => [createHost()], upsert: () => createHost(), remove: () => true },
      connections: {
        ...createConnections(),
        connect: async (input) => ({ hostId: input.hostId, connectionId: 'connection-1', phase: 'connected' }),
        writeTerminal: (input) => { writes.push(input.data) },
        onState: (listener) => { stateListener = listener; return () => { stateListener = undefined } },
        onOutput: (listener) => { outputListener = listener; return () => { outputListener = undefined } },
        onExit: (listener) => { exitListener = listener; return () => { exitListener = undefined } },
      },
    })

    expect(await invoke(handlers, SERVER_OPS_IPC_CHANNELS.CONNECT, sender, {
      hostId: 'host-1', cols: 80, rows: 24,
      credential: { kind: 'password', password: 'password-canary', remember: false },
    })).toMatchObject({ phase: 'connected' })
    await invoke(handlers, SERVER_OPS_IPC_CHANNELS.WRITE_TERMINAL, sender, {
      hostId: 'host-1', connectionId: 'connection-1', data: 'uptime\r',
    })
    expect(writes).toEqual(['uptime\r'])

    stateListener?.({ hostId: 'host-1', connectionId: 'connection-1', phase: 'connected' })
    outputListener?.({ hostId: 'host-1', connectionId: 'connection-1', sequence: 1, data: 'ok' })
    exitListener?.({ hostId: 'host-1', connectionId: 'connection-1', message: 'closed' })
    expect(events.map((event) => event.channel)).toEqual([
      SERVER_OPS_IPC_CHANNELS.CONNECTION_STATE,
      SERVER_OPS_IPC_CHANNELS.TERMINAL_OUTPUT,
      SERVER_OPS_IPC_CHANNELS.TERMINAL_EXIT,
    ])
    expect(JSON.stringify(events)).not.toContain('password-canary')
  })
})
