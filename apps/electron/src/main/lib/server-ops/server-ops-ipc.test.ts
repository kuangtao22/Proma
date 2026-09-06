import { describe, expect, spyOn, test } from 'bun:test'
import { SERVER_OPS_IPC_CHANNELS } from '@proma/shared'
import type { AgentSessionMeta, ServerOpsAuditListResult, ServerOpsConnectionState, ServerOpsHost, ServerOpsLogExitEvent, ServerOpsLogOutputEvent, ServerOpsTerminalExitEvent, ServerOpsTerminalOutputEvent, ServerOpsUpsertHostInput } from '@proma/shared'
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { registerServerOpsIpcHandlers } from './server-ops-ipc'
import type { ServerOpsIpcOptions } from './server-ops-ipc'
import { ServerOpsAgentAccessStore } from './server-ops-agent-access-store'

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
    getState: () => ({ hostId: 'host-1', phase: 'disconnected' as const }),
    exec: async () => ({ stdout: '', stderr: '', truncated: false }),
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

/** 创建 access IPC 使用的普通顶层 Agent 会话。 */
function createAgentSession(overrides: Partial<AgentSessionMeta> = {}): AgentSessionMeta {
  return {
    id: 'session-1',
    title: '普通会话',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

/** 创建 Agent 授权 IPC 的集中测试夹具，避免各边界重复完整注册。 */
function createAgentAccessHarness(options: {
  visible?: boolean
  session?: AgentSessionMeta
  hostExists?: boolean
  forgetHost?: (hostId: string) => void
  auditResult?: unknown
} = {}) {
  const handlers = new Map<string, TestHandler>()
  const events: Array<{ channel: string; payload: unknown }> = []
  const access = new ServerOpsAgentAccessStore()
  /** 审计列表 IPC 收到的严格筛选输入。 */
  const auditCalls: unknown[] = []
  const sender = {
    id: 7,
    isDestroyed: () => false,
    send: (channel: string, payload: unknown) => { events.push({ channel, payload }) },
  } as unknown as WebContents
  registerServerOpsIpcHandlers({
    ipc: { handle: (channel, handler) => { handlers.set(channel, handler) }, removeHandler: (channel) => { handlers.delete(channel) } },
    listAuthorizedWebContents: () => [sender],
    hosts: {
      list: () => options.hostExists === false ? [] : [createHost()],
      get: () => options.hostExists === false ? undefined : createHost(),
      upsert: () => createHost(),
      setCredentialRef: () => createHost(),
      remove: () => true,
    },
    credentials: {
      remember: () => 'credential-1',
      forgetHost: options.forgetHost ?? (() => undefined),
    },
    connections: createConnections(),
    access,
    audit: {
      list: (input) => {
        auditCalls.push(input)
        return (options.auditResult ?? { records: [] }) as ServerOpsAuditListResult
      },
    },
    requireUserVisibleSession: () => {
      if (options.visible === false) throw new Error('SESSION_NOT_VISIBLE')
      return options.session ?? createAgentSession()
    },
  })
  return { access, auditCalls, events, handlers, sender }
}

describe('服务器运维 IPC', () => {
  test('LIST_AUDIT 仅允许授权主窗口并把严格解析后的筛选发送给 Store', async () => {
    const harness = createAgentAccessHarness()
    await expect(invoke(harness.handlers, SERVER_OPS_IPC_CHANNELS.LIST_AUDIT, harness.sender, {
      hostId: 'host-1', operation: 'exec', limit: 50,
    })).resolves.toEqual({ records: [] })
    expect(harness.auditCalls).toEqual([{ hostId: 'host-1', operation: 'exec', limit: 50 }])

    await expect(invoke(harness.handlers, SERVER_OPS_IPC_CHANNELS.LIST_AUDIT, createSender(8), {}))
      .rejects.toThrow('SERVER_OPS_ACCESS_DENIED')
    await expect(invoke(harness.handlers, SERVER_OPS_IPC_CHANNELS.LIST_AUDIT, harness.sender, { extra: true }))
      .rejects.toThrow('SERVER_OPS_AUDIT_LIST_INPUT_INVALID')
  })

  test('LIST_AUDIT 对 Store 返回的未知字段执行 fail closed', async () => {
    const harness = createAgentAccessHarness({ auditResult: { records: [], internalPath: '/secret/audit.json' } })

    await expect(invoke(harness.handlers, SERVER_OPS_IPC_CHANNELS.LIST_AUDIT, harness.sender, {}))
      .rejects.toThrow('SERVER_OPS_AUDIT_LIST_RESULT_INVALID')
  })

  test('GET 和 SET 均拒绝非授权窗口', async () => {
    const harness = createAgentAccessHarness()
    const outsider = createSender(8)
    const cases = [
      { channel: SERVER_OPS_IPC_CHANNELS.GET_AGENT_ACCESS, input: { sessionId: 'session-1', hostId: 'host-1' } },
      { channel: SERVER_OPS_IPC_CHANNELS.SET_AGENT_ACCESS, input: { sessionId: 'session-1', hostId: 'host-1', granted: true } },
    ]

    for (const item of cases) {
      await expect(invoke(harness.handlers, item.channel, outsider, item.input)).rejects.toThrow('SERVER_OPS_ACCESS_DENIED')
    }
  })

  test('常驻 AppShell 可按上一会话撤销授权且非法或未授权调用 fail closed', async () => {
    const harness = createAgentAccessHarness()
    harness.access.grant({ sessionId: 'session-1', hostId: 'host-1', granted: true })

    await expect(invoke(
      harness.handlers,
      SERVER_OPS_IPC_CHANNELS.REVOKE_AGENT_ACCESS_SESSION,
      harness.sender,
      'session-1',
    )).resolves.toBeUndefined()
    expect(harness.access.getCurrent()).toBeUndefined()
    expect(harness.events).toContainEqual({
      channel: SERVER_OPS_IPC_CHANNELS.AGENT_ACCESS_CHANGED,
      payload: {
        previous: { sessionId: 'session-1', hostId: 'host-1', granted: true },
        current: null,
      },
    })

    await expect(invoke(
      harness.handlers,
      SERVER_OPS_IPC_CHANNELS.REVOKE_AGENT_ACCESS_SESSION,
      createSender(8),
      'session-1',
    )).rejects.toThrow('SERVER_OPS_ACCESS_DENIED')
    await expect(invoke(
      harness.handlers,
      SERVER_OPS_IPC_CHANNELS.REVOKE_AGENT_ACCESS_SESSION,
      harness.sender,
      'session.1',
    )).rejects.toThrow()
  })

  test('SET 拒绝隐藏或内部 Agent 会话', async () => {
    const harness = createAgentAccessHarness({ visible: false })

    await expect(invoke(harness.handlers, SERVER_OPS_IPC_CHANNELS.SET_AGENT_ACCESS, harness.sender, {
      sessionId: 'internal-session-1',
      hostId: 'host-1',
      granted: true,
    })).rejects.toThrow('SESSION_NOT_VISIBLE')
  })

  test.each([
    { sourceDesignProjectId: 'project-1' },
    { sourceDesignJobId: 'job-1' },
    { sourceCanvasProjectId: 'project-1' },
    { sourceCanvasId: 'canvas-1' },
    { sourceCanvasNodeId: 'node-1' },
    { sourceAutomationId: 'automation-1' },
    { automationGraduated: true },
    { parentSessionId: 'parent-1' },
    { rootSessionId: 'root-1' },
    { sourceDelegationId: 'delegation-1' },
    { delegationRole: 'explore' as const },
    { delegationStatus: 'running' as const },
    { delegationDepth: 1 },
    { delegationGoal: '排查服务' },
  ])('Given access IPC 的可见会话带有内部来源或父子残留 %# When GET 或 SET Then 均 fail closed', async (contamination) => {
    const harness = createAgentAccessHarness({ session: createAgentSession(contamination) })
    const cases = [
      { channel: SERVER_OPS_IPC_CHANNELS.GET_AGENT_ACCESS, input: { sessionId: 'session-1', hostId: 'host-1' } },
      { channel: SERVER_OPS_IPC_CHANNELS.SET_AGENT_ACCESS, input: { sessionId: 'session-1', hostId: 'host-1', granted: true } },
    ]

    for (const item of cases) {
      await expect(invoke(harness.handlers, item.channel, harness.sender, item.input))
        .rejects.toThrow('Agent 会话不存在')
    }
    expect(harness.access.getCurrent()).toBeUndefined()
  })

  test('GET 和 SET 均拒绝不存在的服务器', async () => {
    const harness = createAgentAccessHarness({ hostExists: false })
    const cases = [
      { channel: SERVER_OPS_IPC_CHANNELS.GET_AGENT_ACCESS, input: { sessionId: 'session-1', hostId: 'host-1' } },
      { channel: SERVER_OPS_IPC_CHANNELS.SET_AGENT_ACCESS, input: { sessionId: 'session-1', hostId: 'host-1', granted: true } },
    ]

    for (const item of cases) {
      await expect(invoke(harness.handlers, item.channel, harness.sender, item.input)).rejects.toThrow('SERVER_OPS_HOST_NOT_FOUND')
    }
  })

  test('删除已授权服务器后撤销授权并广播旧新权威状态', async () => {
    const harness = createAgentAccessHarness()
    harness.access.grant({ sessionId: 'session-1', hostId: 'host-1', granted: true })

    await expect(invoke(harness.handlers, SERVER_OPS_IPC_CHANNELS.DELETE_HOST, harness.sender, 'host-1')).resolves.toBe(true)

    expect(harness.access.getCurrent()).toBeUndefined()
    expect(harness.events).toContainEqual({
      channel: SERVER_OPS_IPC_CHANNELS.AGENT_ACCESS_CHANGED,
      payload: {
        previous: { sessionId: 'session-1', hostId: 'host-1', granted: true },
        current: null,
      },
    })
  })

  test('主机删除后的凭据清理失败也必须先撤销授权并广播', async () => {
    const harness = createAgentAccessHarness({
      forgetHost: () => { throw new Error('CREDENTIAL_FORGET_FAILED') },
    })
    harness.access.grant({ sessionId: 'session-1', hostId: 'host-1', granted: true })

    await expect(invoke(harness.handlers, SERVER_OPS_IPC_CHANNELS.DELETE_HOST, harness.sender, 'host-1')).rejects.toThrow('CREDENTIAL_FORGET_FAILED')

    expect(harness.access.getCurrent()).toBeUndefined()
    expect(harness.events).toContainEqual({
      channel: SERVER_OPS_IPC_CHANNELS.AGENT_ACCESS_CHANGED,
      payload: {
        previous: { sessionId: 'session-1', hostId: 'host-1', granted: true },
        current: null,
      },
    })
  })

  test('Agent 授权要求可见会话和主机，并广播旧新权威状态', async () => {
    const handlers = new Map<string, TestHandler>()
    const sender = createSender(7)
    const events: unknown[] = []
    const access = new ServerOpsAgentAccessStore()
    let visible = true
    registerServerOpsIpcHandlers({
      ipc: { handle: (channel, handler) => { handlers.set(channel, handler) }, removeHandler: (channel) => { handlers.delete(channel) } },
      listAuthorizedWebContents: () => [{ ...sender, send: (_channel: string, payload: unknown) => { events.push(payload) } } as unknown as WebContents],
      hosts: { list: () => [createHost()], get: (hostId) => hostId === 'host-1' ? createHost() : undefined, upsert: () => createHost(), setCredentialRef: () => createHost(), remove: () => true },
      credentials: { remember: () => 'credential-1', forgetHost: () => undefined },
      connections: createConnections(),
      access,
      audit: { list: () => ({ records: [] }) },
      requireUserVisibleSession: () => {
        if (!visible) throw new Error('SESSION_NOT_VISIBLE')
        return createAgentSession()
      },
    })
    const target = { sessionId: 'session-1', hostId: 'host-1' }
    await expect(invoke(handlers, SERVER_OPS_IPC_CHANNELS.GET_AGENT_ACCESS, sender, target)).resolves.toBeNull()
    await expect(invoke(handlers, SERVER_OPS_IPC_CHANNELS.SET_AGENT_ACCESS, sender, { ...target, granted: true })).resolves.toEqual({ ...target, granted: true })
    expect(events.at(-1)).toEqual({ previous: null, current: { ...target, granted: true } })
    await expect(invoke(handlers, SERVER_OPS_IPC_CHANNELS.SET_AGENT_ACCESS, sender, { sessionId: 'session-2', hostId: 'host-1', granted: true })).resolves.toEqual({ sessionId: 'session-2', hostId: 'host-1', granted: true })
    expect(events.at(-1)).toEqual({ previous: { ...target, granted: true }, current: { sessionId: 'session-2', hostId: 'host-1', granted: true } })
    visible = false
    await expect(invoke(handlers, SERVER_OPS_IPC_CHANNELS.GET_AGENT_ACCESS, sender, target)).rejects.toThrow('SESSION_NOT_VISIBLE')
  })

  test('断开服务器时撤销匹配授权并广播旧新权威状态', async () => {
    const handlers = new Map<string, TestHandler>()
    const events: Array<{ channel: string; payload: unknown }> = []
    const sender = {
      id: 7,
      isDestroyed: () => false,
      send: (channel: string, payload: unknown) => { events.push({ channel, payload }) },
    } as unknown as WebContents
    const access = new ServerOpsAgentAccessStore()
    access.grant({ sessionId: 'session-1', hostId: 'host-1', granted: true })
    registerServerOpsIpcHandlers({
      ipc: { handle: (channel, handler) => { handlers.set(channel, handler) }, removeHandler: (channel) => { handlers.delete(channel) } },
      listAuthorizedWebContents: () => [sender],
      hosts: { list: () => [createHost()], get: () => createHost(), upsert: () => createHost(), setCredentialRef: () => createHost(), remove: () => true },
      credentials: { remember: () => 'credential-1', forgetHost: () => undefined },
      connections: createConnections(),
      access,
      audit: { list: () => ({ records: [] }) },
      requireUserVisibleSession: () => createAgentSession(),
    })

    await expect(invoke(handlers, SERVER_OPS_IPC_CHANNELS.DISCONNECT, sender, 'host-1')).resolves.toEqual({
      hostId: 'host-1',
      phase: 'disconnected',
    })
    expect(access.getCurrent()).toBeUndefined()
    expect(events).toContainEqual({
      channel: SERVER_OPS_IPC_CHANNELS.AGENT_ACCESS_CHANGED,
      payload: {
        previous: { sessionId: 'session-1', hostId: 'host-1', granted: true },
        current: null,
      },
    })
  })

  test('删除 Agent 会话可通过注册结果撤销匹配授权并广播', () => {
    const handlers = new Map<string, TestHandler>()
    const events: Array<{ channel: string; payload: unknown }> = []
    const sender = {
      id: 7,
      isDestroyed: () => false,
      send: (channel: string, payload: unknown) => { events.push({ channel, payload }) },
    } as unknown as WebContents
    const access = new ServerOpsAgentAccessStore()
    access.grant({ sessionId: 'session-1', hostId: 'host-1', granted: true })
    const registration = registerServerOpsIpcHandlers({
      ipc: { handle: (channel, handler) => { handlers.set(channel, handler) }, removeHandler: (channel) => { handlers.delete(channel) } },
      listAuthorizedWebContents: () => [sender],
      hosts: { list: () => [createHost()], get: () => createHost(), upsert: () => createHost(), setCredentialRef: () => createHost(), remove: () => true },
      credentials: { remember: () => 'credential-1', forgetHost: () => undefined },
      connections: createConnections(),
      access,
      audit: { list: () => ({ records: [] }) },
      requireUserVisibleSession: () => createAgentSession(),
    })

    registration.revokeSession('session-1')

    expect(access.getCurrent()).toBeUndefined()
    expect(events).toContainEqual({
      channel: SERVER_OPS_IPC_CHANNELS.AGENT_ACCESS_CHANGED,
      payload: {
        previous: { sessionId: 'session-1', hostId: 'host-1', granted: true },
        current: null,
      },
    })
  })
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
        get: () => createHost(),
        upsert: (input: ServerOpsUpsertHostInput) => { calls.push(`upsert:${input.name}`); return createHost(input.name) },
        setCredentialRef: (_hostId, credentialRef) => ({ ...createHost(), ...(credentialRef ? { credentialRef } : {}) }),
        remove: (hostId: string) => { calls.push(`remove:${hostId}`); return true },
      },
      credentials: { remember: () => 'credential-1', forgetHost: () => undefined },
      connections: createConnections(),
      access: new ServerOpsAgentAccessStore(),
      audit: { list: () => ({ records: [] }) },
      requireUserVisibleSession: () => createAgentSession(),
    })

    expect(registration.channels).toEqual(Object.values(SERVER_OPS_IPC_CHANNELS).filter((channel) => !([
      SERVER_OPS_IPC_CHANNELS.CONNECTION_STATE,
      SERVER_OPS_IPC_CHANNELS.TERMINAL_OUTPUT,
      SERVER_OPS_IPC_CHANNELS.TERMINAL_EXIT,
      SERVER_OPS_IPC_CHANNELS.AGENT_ACCESS_CHANGED,
      SERVER_OPS_IPC_CHANNELS.LOG_OUTPUT,
      SERVER_OPS_IPC_CHANNELS.LOG_EXIT,
    ] as readonly string[]).includes(channel)))
    expect(await invoke(handlers, SERVER_OPS_IPC_CHANNELS.LIST_HOSTS, sender)).toEqual([createHost()])
    expect(await invoke(handlers, SERVER_OPS_IPC_CHANNELS.UPSERT_HOST, sender, {
      host: {
        name: ' 生产 API 01 ',
        address: '10.0.0.8',
        port: 22,
        username: 'deploy',
        authMethod: 'ssh-agent',
        tags: [],
      },
      credentialUpdate: { action: 'clear' },
    })).toMatchObject({ name: '生产 API 01' })
    expect(await invoke(handlers, SERVER_OPS_IPC_CHANNELS.DELETE_HOST, sender, 'host-1')).toBe(true)
    expect(calls).toEqual(['list', 'upsert:生产 API 01', 'remove:host-1'])

    registration.dispose()
    expect(handlers.size).toBe(0)
  })

  test('保存服务器时组合写入、保留和清除安全凭据', async () => {
    /** 每个通道注册的测试 handler。 */
    const handlers = new Map<string, TestHandler>()
    /** 唯一授权主窗口。 */
    const sender = createSender(7)
    /** 主机与凭据 Store 的调用顺序。 */
    const calls: string[] = []
    /** 当前测试模拟的已保存主机。 */
    let currentHost: ServerOpsHost | undefined

    registerServerOpsIpcHandlers({
      ipc: {
        handle: (channel, handler) => { handlers.set(channel, handler) },
        removeHandler: (channel) => { handlers.delete(channel) },
      },
      listAuthorizedWebContents: () => [sender],
      hosts: {
        list: () => currentHost ? [currentHost] : [],
        get: () => currentHost,
        upsert: (input: ServerOpsUpsertHostInput) => {
          calls.push(`upsert:${input.name}`)
          /** 同认证方式编辑时模拟真实 Host Store 保留凭据引用。 */
          const credentialRef = input.id && currentHost?.authMethod === input.authMethod ? currentHost.credentialRef : undefined
          currentHost = { ...createHost(input.name), authMethod: input.authMethod, ...(credentialRef ? { credentialRef } : {}) }
          return currentHost
        },
        setCredentialRef: (hostId, credentialRef) => {
          calls.push(`set-ref:${hostId}:${credentialRef ?? 'clear'}`)
          if (!currentHost) throw new Error('测试主机应存在')
          currentHost = { ...currentHost, ...(credentialRef ? { credentialRef } : {}) }
          if (!credentialRef) delete currentHost.credentialRef
          return currentHost
        },
        remove: () => true,
      },
      credentials: {
        remember: (hostId, credential) => {
          calls.push(`remember:${hostId}:${credential.kind}`)
          return 'credential-1'
        },
        forgetHost: (hostId) => { calls.push(`forget:${hostId}`) },
      },
      connections: createConnections(),
      access: new ServerOpsAgentAccessStore(),
      audit: { list: () => ({ records: [] }) },
      requireUserVisibleSession: () => createAgentSession(),
    })

    expect(await invoke(handlers, SERVER_OPS_IPC_CHANNELS.UPSERT_HOST, sender, {
      host: {
        name: '生产 API',
        address: '10.0.0.8',
        port: 22,
        username: 'deploy',
        authMethod: 'password',
        tags: [],
      },
      credentialUpdate: {
        action: 'replace',
        credential: { kind: 'password', password: 'password-canary' },
      },
    })).toMatchObject({ credentialRef: 'credential-1' })
    expect(calls).toEqual([
      'upsert:生产 API',
      'remember:host-1:password',
      'set-ref:host-1:credential-1',
    ])

    calls.length = 0
    expect(await invoke(handlers, SERVER_OPS_IPC_CHANNELS.UPSERT_HOST, sender, {
      host: {
        id: 'host-1',
        name: '生产 API 01',
        address: '10.0.0.8',
        port: 22,
        username: 'deploy',
        authMethod: 'password',
        tags: [],
      },
      credentialUpdate: { action: 'keep' },
    })).toMatchObject({ credentialRef: 'credential-1' })
    expect(calls).toEqual(['upsert:生产 API 01'])

    calls.length = 0
    expect(await invoke(handlers, SERVER_OPS_IPC_CHANNELS.UPSERT_HOST, sender, {
      host: {
        id: 'host-1',
        name: '生产 API 01',
        address: '10.0.0.8',
        port: 22,
        username: 'deploy',
        authMethod: 'password',
        tags: [],
      },
      credentialUpdate: { action: 'clear' },
    })).not.toHaveProperty('credentialRef')
    expect(calls).toEqual([
      'upsert:生产 API 01',
      'forget:host-1',
      'set-ref:host-1:clear',
    ])
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
        get: () => undefined,
        upsert: () => createHost(),
        setCredentialRef: () => createHost(),
        remove: () => true,
      },
      credentials: { remember: () => 'credential-1', forgetHost: () => undefined },
      connections: createConnections(),
      access: new ServerOpsAgentAccessStore(),
      audit: { list: () => ({ records: [] }) },
      requireUserVisibleSession: () => createAgentSession(),
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
    /** runtime 退出前后用于验证授权自动收口的主进程 Store。 */
    const access = new ServerOpsAgentAccessStore()

    registerServerOpsIpcHandlers({
      ipc: {
        handle: (channel, handler) => { handlers.set(channel, handler) },
        removeHandler: (channel) => { handlers.delete(channel) },
      },
      listAuthorizedWebContents: () => [sender],
      hosts: {
        list: () => [createHost()],
        get: () => createHost(),
        upsert: () => createHost(),
        setCredentialRef: () => createHost(),
        remove: () => true,
      },
      credentials: { remember: () => 'credential-1', forgetHost: () => undefined },
      connections: {
        ...createConnections(),
        connect: async (input) => ({ hostId: input.hostId, connectionId: 'connection-1', phase: 'connected' }),
        writeTerminal: (input) => { writes.push(input.data) },
        onState: (listener) => { stateListener = listener; return () => { stateListener = undefined } },
        onOutput: (listener) => { outputListener = listener; return () => { outputListener = undefined } },
        onExit: (listener) => { exitListener = listener; return () => { exitListener = undefined } },
      },
      access,
      audit: { list: () => ({ records: [] }) },
      requireUserVisibleSession: () => createAgentSession(),
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
    access.grant({ sessionId: 'session-1', hostId: 'host-1', granted: true })
    exitListener?.({ hostId: 'host-1', connectionId: 'connection-1', message: 'closed' })
    expect(access.getCurrent()).toBeUndefined()
    expect(events.map((event) => event.channel)).toEqual([
      SERVER_OPS_IPC_CHANNELS.CONNECTION_STATE,
      SERVER_OPS_IPC_CHANNELS.TERMINAL_OUTPUT,
      SERVER_OPS_IPC_CHANNELS.AGENT_ACCESS_CHANGED,
      SERVER_OPS_IPC_CHANNELS.TERMINAL_EXIT,
    ])
    expect(JSON.stringify(events)).not.toContain('password-canary')
  })

  test('观测 handler 先授权和严格解析，再调用领域并严格解析结果', async () => {
    const fixture = createObservabilityHarness()
    await expect(invoke(fixture.handlers, SERVER_OPS_IPC_CHANNELS.GET_OVERVIEW, createSender(99), { hostId: 'host-1' }))
      .rejects.toThrow('SERVER_OPS_ACCESS_DENIED')
    await expect(invoke(fixture.handlers, SERVER_OPS_IPC_CHANNELS.LIST_SERVICES, fixture.sender, { hostId: 'host-1', extra: true }))
      .rejects.toThrow('SERVER_OPS_SERVICE_LIST_INPUT_INVALID')
    expect(fixture.domainCalls).toEqual([])

    await expect(invoke(fixture.handlers, SERVER_OPS_IPC_CHANNELS.GET_OVERVIEW, fixture.sender, { hostId: 'host-1' }))
      .resolves.toMatchObject({ hostId: 'host-1' })
    fixture.results.overview = { hostId: 'host-1', capturedAt: 1, sampleWindowMs: 1, filesystems: [], processes: [], warnings: [], connectionId: 'secret' }
    await expect(invoke(fixture.handlers, SERVER_OPS_IPC_CHANNELS.GET_OVERVIEW, fixture.sender, { hostId: 'host-1' }))
      .rejects.toThrow('SERVER_OPS_OVERVIEW_RESULT_INVALID')
  })

  test('服务动作验证普通可见顶层会话且不读取 Agent 临时授权', async () => {
    const fixture = createObservabilityHarness()
    await expect(invoke(fixture.handlers, SERVER_OPS_IPC_CHANNELS.RUN_SERVICE_ACTION, fixture.sender, {
      sessionId: 'session-1', hostId: 'host-1', unitId: 'nginx.service', action: 'restart',
    })).resolves.toMatchObject({ action: 'restart' })
    expect(fixture.visibleSessions).toEqual(['session-1'])
    expect(fixture.accessReads()).toBe(0)
    expect(fixture.domainCalls).toContain('action:restart')
  })

  test('日志 owner 仅由 sender 窗口推导且事件只发送给所属存活窗口', async () => {
    const fixture = createObservabilityHarness()
    await expect(invoke(fixture.handlers, SERVER_OPS_IPC_CHANNELS.START_LOG_STREAM, fixture.sender, {
      hostId: 'host-1', source: { kind: 'system' }, since: '15m', priority: 'info', tailLines: 100, ownerKey: 'window:999',
    })).rejects.toThrow('SERVER_OPS_LOG_START_INPUT_INVALID')
    await invoke(fixture.handlers, SERVER_OPS_IPC_CHANNELS.START_LOG_STREAM, fixture.sender, {
      hostId: 'host-1', source: { kind: 'system' }, since: '15m', priority: 'info', tailLines: 100,
    })
    expect(fixture.logCalls).toContain('start:window:7')

    fixture.emitLogOutput({ hostId: 'host-1', streamId: 'stream-1', sequence: 1, data: 'owner only' })
    expect(fixture.eventsOne).toEqual([{ channel: SERVER_OPS_IPC_CHANNELS.LOG_OUTPUT, payload: { hostId: 'host-1', streamId: 'stream-1', sequence: 1, data: 'owner only' } }])
    expect(fixture.eventsTwo).toEqual([])

    fixture.destroyOne()
    fixture.emitLogExit({ hostId: 'host-1', streamId: 'stream-1', reason: 'stopped' })
    expect(fixture.eventsOne).toHaveLength(1)
    expect(fixture.logCalls).toContain('dispose-owner:window:7')
  })

  test('污染日志领域事件 fail closed 且不反向击穿订阅者', async () => {
    const fixture = createObservabilityHarness()
    await invoke(fixture.handlers, SERVER_OPS_IPC_CHANNELS.START_LOG_STREAM, fixture.sender, {
      hostId: 'host-1', source: { kind: 'system' }, since: '15m', priority: 'info', tailLines: 100,
    })

    expect(() => fixture.emitLogOutput({
      hostId: 'host-1', streamId: 'stream-1', sequence: 1, data: 'secret', connectionId: 'internal',
    } as unknown as ServerOpsLogOutputEvent)).not.toThrow()
    expect(fixture.eventsOne).toEqual([])
  })

  test('日志启动结果污染时精确停止本次远端流且不登记公开路由', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => undefined)
    const fixture = createObservabilityHarness({
      startResult: { hostId: 'host-1', streamId: 'stream-1', connectionId: 'internal' },
      stopError: new Error('STOP_FAILED'),
    })

    try {
      await expect(invoke(fixture.handlers, SERVER_OPS_IPC_CHANNELS.START_LOG_STREAM, fixture.sender, {
        hostId: 'host-1', source: { kind: 'system' }, since: '15m', priority: 'info', tailLines: 100,
      })).rejects.toThrow('SERVER_OPS_LOG_START_RESULT_INVALID')
      expect(fixture.stops).toEqual([{ ownerKey: 'window:7', hostId: 'host-1', streamId: 'stream-1' }])
      expect(errorSpy).toHaveBeenCalledWith('[Server Ops] 污染日志启动结果回滚失败:', expect.any(Error))

      fixture.emitLogOutput({ hostId: 'host-1', streamId: 'stream-1', sequence: 1, data: 'must-not-route' })
      expect(fixture.eventsOne).toEqual([])
    } finally {
      errorSpy.mockRestore()
    }
  })

  test('污染日志 exit 在可证明 streamId 时清除公开路由且不转发', async () => {
    const fixture = createObservabilityHarness()
    await invoke(fixture.handlers, SERVER_OPS_IPC_CHANNELS.START_LOG_STREAM, fixture.sender, {
      hostId: 'host-1', source: { kind: 'system' }, since: '15m', priority: 'info', tailLines: 100,
    })

    expect(() => fixture.emitLogExit({
      hostId: 'host-1', streamId: 'stream-1', reason: 'stopped', connectionId: 'internal',
    } as unknown as ServerOpsLogExitEvent)).not.toThrow()
    fixture.emitLogOutput({ hostId: 'host-1', streamId: 'stream-1', sequence: 1, data: 'must-not-route' })
    expect(fixture.eventsOne).toEqual([])
  })

  test('日志 stop/ack 绑定 sender owner，registration dispose 先退订并释放 owner 后移除 handler', async () => {
    const fixture = createObservabilityHarness()
    await invoke(fixture.handlers, SERVER_OPS_IPC_CHANNELS.START_LOG_STREAM, fixture.sender, {
      hostId: 'host-1', source: { kind: 'system' }, since: '15m', priority: 'info', tailLines: 100,
    })
    await invoke(fixture.handlers, SERVER_OPS_IPC_CHANNELS.STOP_LOG_STREAM, fixture.sender, { hostId: 'host-1', streamId: 'stream-1' })
    await invoke(fixture.handlers, SERVER_OPS_IPC_CHANNELS.ACK_LOG_OUTPUT, fixture.sender, { hostId: 'host-1', streamId: 'stream-1', sequence: 1 })
    expect(fixture.logCalls).toContain('stop:window:7')
    expect(fixture.logCalls).toContain('ack:window:7:1')

    fixture.registration.dispose()
    fixture.registration.dispose()
    expect(fixture.cleanupCalls.slice(0, 3)).toEqual(['unsubscribe-output', 'unsubscribe-exit', 'dispose-owner:window:7'])
    expect(fixture.handlers.size).toBe(0)
  })

  test('领域订阅注册中途失败会完整回滚已安装订阅和全部 handler', () => {
    const handlers = new Map<string, TestHandler>()
    const cleanup: string[] = []
    const options = createMinimalRegistrationOptions(handlers, cleanup)
    options.logs = {
      ...options.logs!,
      onOutput: () => () => { cleanup.push('unsubscribe-log-output') },
      onExit: () => { throw new Error('LOG_EXIT_SUBSCRIBE_FAILED') },
    }

    expect(() => registerServerOpsIpcHandlers(options)).toThrow('LOG_EXIT_SUBSCRIBE_FAILED')
    expect(handlers.size).toBe(0)
    expect(cleanup.filter((entry) => entry.startsWith('unsubscribe-'))).toEqual([
      'unsubscribe-log-output',
      'unsubscribe-connection-exit',
      'unsubscribe-connection-output',
      'unsubscribe-connection-state',
    ])
    expect(cleanup.filter((entry) => entry.startsWith('remove-handler:'))).toHaveLength(22)
  })

  test('dispose 中首个 unsubscribe 失败仍解绑 closed listener、释放 owner 和全部 handler', async () => {
    const handlers = new Map<string, TestHandler>()
    const cleanup: string[] = []
    const options = createMinimalRegistrationOptions(handlers, cleanup, true)
    const registration = registerServerOpsIpcHandlers(options)
    const sender = options.listAuthorizedWebContents()[0]!
    await invoke(handlers, SERVER_OPS_IPC_CHANNELS.START_LOG_STREAM, sender, {
      hostId: 'host-1', source: { kind: 'system' }, since: '15m', priority: 'info', tailLines: 100,
    })

    expect(() => registration.dispose()).toThrow('FIRST_UNSUBSCRIBE_FAILED')
    const afterFirstDispose = [...cleanup]
    expect(cleanup).toContain('unsubscribe-connection-output')
    expect(cleanup).toContain('unsubscribe-log-exit')
    expect(cleanup).toContain('remove-closed')
    expect(cleanup).toContain('dispose-owner:window:7')
    expect(cleanup.filter((entry) => entry.startsWith('remove-handler:'))).toHaveLength(22)
    expect(handlers.size).toBe(0)
    expect(() => registration.dispose()).not.toThrow()
    expect(cleanup).toEqual(afterFirstDispose)

    const disposeOwnerCount = cleanup.filter((entry) => entry === 'dispose-owner:window:7').length
    ;(options.resolveOwnerWindow?.(sender) as TestOwnerWindow).emitClosed()
    expect(cleanup.filter((entry) => entry === 'dispose-owner:window:7')).toHaveLength(disposeOwnerCount)
  })

  test('日志导出拒绝 Renderer 路径，取消不写入，成功使用清洗文件名原子写', async () => {
    const fixture = createObservabilityHarness({ hostName: '../../生产/API' })
    await expect(invoke(fixture.handlers, SERVER_OPS_IPC_CHANNELS.EXPORT_LOG, fixture.sender, {
      hostId: 'host-1', content: 'line', path: '/tmp/stolen.log',
    })).rejects.toThrow('SERVER_OPS_LOG_EXPORT_INPUT_INVALID')
    expect(fixture.dialogCalls).toHaveLength(0)

    fixture.dialogResult = { canceled: true }
    await expect(invoke(fixture.handlers, SERVER_OPS_IPC_CHANNELS.EXPORT_LOG, fixture.sender, { hostId: 'host-1', content: 'line' }))
      .resolves.toEqual({ saved: false })
    expect(fixture.writes).toEqual([])

    fixture.dialogResult = { canceled: false, filePath: '/chosen/server.log' }
    await expect(invoke(fixture.handlers, SERVER_OPS_IPC_CHANNELS.EXPORT_LOG, fixture.sender, { hostId: 'host-1', content: 'line' }))
      .resolves.toEqual({ saved: true })
    expect(fixture.writes).toEqual([{ path: '/chosen/server.log', content: 'line' }])
    expect(fixture.dialogCalls[1]?.defaultPath).not.toContain('/')
    expect(fixture.dialogCalls[1]?.defaultPath).not.toContain('..')
  })
})

/** 创建覆盖观测、日志 owner 与导出边界的集中夹具。 */
function createObservabilityHarness(options: { hostName?: string; startResult?: unknown; stopError?: Error } = {}) {
  const handlers = new Map<string, TestHandler>()
  const domainCalls: string[] = []
  const logCalls: string[] = []
  const cleanupCalls: string[] = []
  const visibleSessions: string[] = []
  const eventsOne: Array<{ channel: string; payload: unknown }> = []
  const eventsTwo: Array<{ channel: string; payload: unknown }> = []
  const dialogCalls: Array<{ defaultPath?: string }> = []
  const writes: Array<{ path: string; content: string }> = []
  /** 日志 stop 调用保留完整公开身份，用于证明失败回滚不扩大 owner 范围。 */
  const stops: Array<{ ownerKey: string; hostId: string; streamId: string }> = []
  let accessReadCount = 0
  let destroyedOne = false
  let closedOne: (() => void) | undefined
  let outputListener: ((event: ServerOpsLogOutputEvent) => void) | undefined
  let logExitListener: ((event: ServerOpsLogExitEvent) => void) | undefined
  const sender = { id: 7, isDestroyed: () => destroyedOne, send: (channel: string, payload: unknown) => eventsOne.push({ channel, payload }) } as unknown as WebContents
  const senderTwo = { id: 8, isDestroyed: () => false, send: (channel: string, payload: unknown) => eventsTwo.push({ channel, payload }) } as unknown as WebContents
  const windowOne = { id: 7, webContents: sender, isDestroyed: () => destroyedOne, once: (_event: 'closed', listener: () => void) => { closedOne = listener }, removeListener: (_event: 'closed', listener: () => void) => { if (closedOne === listener) closedOne = undefined } }
  const windowTwo = { id: 8, webContents: senderTwo, isDestroyed: () => false, once: () => undefined, removeListener: () => undefined }
  const access = new ServerOpsAgentAccessStore()
  access.get = () => { accessReadCount += 1; return undefined }
  const results: { overview: unknown } = {
    overview: { hostId: 'host-1', capturedAt: 1, sampleWindowMs: 1, filesystems: [], processes: [], warnings: [] },
  }
  let dialogResult: { canceled: boolean; filePath?: string } = { canceled: false, filePath: '/chosen/server.log' }
  const registration = registerServerOpsIpcHandlers({
    ipc: {
      handle: (channel, handler) => { handlers.set(channel, handler) },
      removeHandler: (channel) => { cleanupCalls.push(`remove:${channel}`); handlers.delete(channel) },
    },
    listAuthorizedWebContents: () => [sender, senderTwo],
    hosts: { list: () => [], get: () => createHost(options.hostName), upsert: () => createHost(), setCredentialRef: () => createHost(), remove: () => true },
    credentials: { remember: () => 'credential-1', forgetHost: () => undefined },
    connections: createConnections(),
    access,
    audit: { list: () => ({ records: [] }) },
    overview: { getOverview: async () => { domainCalls.push('overview'); return results.overview } },
    systemd: {
      listServices: async () => { domainCalls.push('list'); return { hostId: 'host-1', capability: 'available', services: [], warnings: [] } },
      getServiceDetail: async () => { domainCalls.push('detail'); return { hostId: 'host-1', capability: 'available', statusLines: [], recentLogLines: [], warnings: [] } },
      runAction: async (input) => { domainCalls.push(`action:${input.action}`); return { hostId: input.hostId, unitId: input.unitId, action: input.action, warnings: [] } },
    },
    logs: {
      start: async (ownerKey) => { logCalls.push(`start:${ownerKey}`); return options.startResult ?? { hostId: 'host-1', streamId: 'stream-1' } },
      stop: (ownerKey, input) => {
        logCalls.push(`stop:${ownerKey}`)
        stops.push({ ownerKey, hostId: input.hostId, streamId: input.streamId })
        if (options.stopError) throw options.stopError
      },
      acknowledge: (ownerKey, input) => { logCalls.push(`ack:${ownerKey}:${input.sequence}`) },
      disposeOwner: (ownerKey) => { logCalls.push(`dispose-owner:${ownerKey}`); cleanupCalls.push(`dispose-owner:${ownerKey}`) },
      onOutput: (listener) => { outputListener = listener; return () => { cleanupCalls.push('unsubscribe-output'); outputListener = undefined } },
      onExit: (listener) => { logExitListener = listener; return () => { cleanupCalls.push('unsubscribe-exit'); logExitListener = undefined } },
    },
    resolveOwnerWindow: (contents) => contents.id === 7 ? windowOne : contents.id === 8 ? windowTwo : null,
    showLogSaveDialog: async (_window, dialogOptions) => { dialogCalls.push(dialogOptions); return dialogResult },
    writeTextFileAtomic: (path, content) => { writes.push({ path, content }) },
    now: () => new Date('2026-09-05T01:02:03.000Z'),
    requireUserVisibleSession: (sessionId) => { visibleSessions.push(sessionId); return createAgentSession() },
  })
  return {
    handlers, sender, domainCalls, logCalls, cleanupCalls, eventsOne, eventsTwo, dialogCalls, writes, results, stops,
    registration, visibleSessions, accessReads: () => accessReadCount,
    emitLogOutput: (event: ServerOpsLogOutputEvent) => outputListener?.(event),
    emitLogExit: (event: ServerOpsLogExitEvent) => logExitListener?.(event),
    destroyOne: () => { destroyedOne = true; closedOne?.() },
    set dialogResult(value: { canceled: boolean; filePath?: string }) { dialogResult = value },
  }
}

/** 测试 BrowserWindow 的精确 closed listener 生命周期。 */
interface TestOwnerWindow {
  id: number
  webContents: WebContents
  isDestroyed(): boolean
  once(event: 'closed', listener: () => void): void
  removeListener(event: 'closed', listener: () => void): void
  emitClosed(): void
}

/** 创建注册事务与异常清理测试所需的最小完整依赖。 */
function createMinimalRegistrationOptions(
  handlers: Map<string, TestHandler>,
  cleanup: string[],
  failFirstUnsubscribe = false,
): ServerOpsIpcOptions {
  const sender = createSender(7)
  let closedListener: (() => void) | undefined
  const window: TestOwnerWindow = {
    id: 7,
    webContents: sender,
    isDestroyed: () => false,
    once: (_event, listener) => { closedListener = listener },
    removeListener: (_event, listener) => {
      cleanup.push('remove-closed')
      if (closedListener === listener) closedListener = undefined
    },
    emitClosed: () => { closedListener?.() },
  }
  return {
    ipc: {
      handle: (channel, handler) => { handlers.set(channel, handler) },
      removeHandler: (channel) => { cleanup.push(`remove-handler:${channel}`); handlers.delete(channel) },
    },
    listAuthorizedWebContents: () => [sender],
    hosts: { list: () => [], get: () => createHost(), upsert: () => createHost(), setCredentialRef: () => createHost(), remove: () => true },
    credentials: { remember: () => 'credential-1', forgetHost: () => undefined },
    connections: {
      ...createConnections(),
      onState: () => () => {
        cleanup.push('unsubscribe-connection-state')
        if (failFirstUnsubscribe) throw new Error('FIRST_UNSUBSCRIBE_FAILED')
      },
      onOutput: () => () => { cleanup.push('unsubscribe-connection-output') },
      onExit: () => () => { cleanup.push('unsubscribe-connection-exit') },
    },
    access: new ServerOpsAgentAccessStore(),
    audit: { list: () => ({ records: [] }) },
    overview: { getOverview: async () => ({ hostId: 'host-1', capturedAt: 1, sampleWindowMs: 1, filesystems: [], processes: [], warnings: [] }) },
    systemd: {
      listServices: async () => ({ hostId: 'host-1', capability: 'available', services: [], warnings: [] }),
      getServiceDetail: async () => ({ hostId: 'host-1', capability: 'available', statusLines: [], recentLogLines: [], warnings: [] }),
      runAction: async (input) => ({ hostId: input.hostId, unitId: input.unitId, action: input.action, warnings: [] }),
    },
    logs: {
      start: async () => ({ hostId: 'host-1', streamId: 'stream-1' }),
      stop: () => undefined,
      acknowledge: () => undefined,
      disposeOwner: (ownerKey) => { cleanup.push(`dispose-owner:${ownerKey}`) },
      onOutput: () => () => { cleanup.push('unsubscribe-log-output') },
      onExit: () => () => { cleanup.push('unsubscribe-log-exit') },
    },
    resolveOwnerWindow: () => window,
    showLogSaveDialog: async () => ({ canceled: true }),
    writeTextFileAtomic: () => undefined,
    requireUserVisibleSession: () => createAgentSession(),
  }
}
