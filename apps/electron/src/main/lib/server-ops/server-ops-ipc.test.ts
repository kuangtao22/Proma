import { SERVER_OPS_AGENT_ACCESS_MANAGEMENT_CHANNELS } from '@proma/shared'
import { describe, expect, spyOn, test } from 'bun:test'
import { SERVER_OPS_IPC_CHANNELS, SERVER_OPS_TRUST_CHANNELS, SERVER_OPS_DOCKER_CHANNELS, SERVER_OPS_FILE_CHANNELS, SERVER_OPS_CONSOLE_IPC_CHANNELS, SERVER_OPS_TRANSFER_CHANNELS, SERVER_OPS_DATA_CHANNELS, SERVER_OPS_DATA_SCHEMA_CHANNELS, SERVER_OPS_PROJECT_CHANNELS } from '@proma/shared'
import type { AgentSessionMeta, ServerOpsAuditListResult, ServerOpsConnectionState, ServerOpsHost, ServerOpsLogExitEvent, ServerOpsLogOutputEvent, ServerOpsTerminalExitEvent, ServerOpsTerminalOutputEvent, ServerOpsUpsertHostInput } from '@proma/shared'
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { registerServerOpsIpcHandlers } from './server-ops-ipc'
import type { ServerOpsIpcOptions } from './server-ops-ipc'
import { ServerOpsAgentAccessStore } from './server-ops-agent-access-store'
import { ServerOpsFileService } from './server-ops-file-service'
import { ServerOpsSftpRuntimeError } from '../../../utility/server-ops/server-ops-sftp-runtime'
import { SERVER_OPS_AGENT_READ_CHANNELS, SERVER_OPS_DATA_QUERY_CHANNELS, SERVER_OPS_DATA_QUERY_HISTORY_CHANNELS, isServerOpsAuditRecord } from '@proma/shared'
import { SERVER_OPS_CONNECTION_DRAFT_CHANNELS } from '@proma/shared'
import { serverOpsConnectionDraftStore } from './server-ops-connection-draft-store'

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
    testConnection: async () => ({
      status: 'reachable' as const,
      message: '连接成功',
      hostKey: { algorithm: 'ssh-ed25519', fingerprint: `SHA256:${'A'.repeat(43)}` },
      latencyMs: 12,
    }),
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
  trustManagement?: ServerOpsIpcOptions['trustManagement']
  docker?: ServerOpsIpcOptions['docker']
  files?: ServerOpsIpcOptions['files']
  console?: ServerOpsIpcOptions['console']
  transfers?: ServerOpsIpcOptions['transfers']
  fileLeases?: ServerOpsIpcOptions['fileLeases']
  data?: ServerOpsIpcOptions['data']
  queryHistory?: ServerOpsIpcOptions['queryHistory']
  auditAppend?: NonNullable<ServerOpsIpcOptions['audit']['append']>
  moveHost?: ServerOpsIpcOptions['hosts']['move']
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
  /** 模拟主窗口的关闭回调，验证候选不能在销毁后使用。 */
  let closeOwner = (): void => undefined
  const registration = registerServerOpsIpcHandlers({
    ipc: { handle: (channel, handler) => { handlers.set(channel, handler) }, removeHandler: (channel) => { handlers.delete(channel) } },
    listAuthorizedWebContents: () => [sender],
    hosts: {
      list: () => options.hostExists === false ? [] : [createHost()],
      get: () => options.hostExists === false ? undefined : createHost(),
      upsert: () => createHost(),
      setCredentialRef: () => createHost(),
      remove: () => true,
      move: options.moveHost,
    },
    credentials: {
      remember: () => 'credential-1',
      forgetHost: options.forgetHost ?? (() => undefined),
    },
    connections: createConnections(),
    access,
    audit: {
      append: options.auditAppend ?? ((input) => ({ ...input, id: 'audit-1', timestamp: Date.now() })),
      list: (input) => {
        auditCalls.push(input)
        return (options.auditResult ?? { records: [] }) as ServerOpsAuditListResult
      },
    },
    trustManagement: options.trustManagement,
    docker: options.docker,
    files: options.files,
    console: options.console,
    transfers: options.transfers,
    fileLeases: options.fileLeases,
    data: options.data,
    queryHistory: options.queryHistory,
    resolveOwnerWindow: () => ({ id: 70, webContents: sender, isDestroyed: () => false,
      once: (_event, callback) => { closeOwner = callback }, removeListener: () => undefined }),
    requireUserVisibleSession: () => {
      if (options.visible === false) throw new Error('SESSION_NOT_VISIBLE')
      return options.session ?? createAgentSession()
    },
  })
  return { access, auditCalls, events, handlers, sender, registration, closeOwner: () => closeOwner() }
}

describe('服务器运维 IPC', () => {
  test('Given Agent 草稿已生成 When 授权面板读取、忽略或伪造会话 Then 仅按可见会话领取', async () => {
    const fixture = createAgentAccessHarness()
    const draft = serverOpsConnectionDraftStore.prepare('session-a', { kind: 'ssh', name: '测试服务器', address: '10.0.0.8', port: 22, username: 'ops' })
    try {
      await expect(invoke(fixture.handlers, SERVER_OPS_CONNECTION_DRAFT_CHANNELS.LIST, createSender(99), 'session-a')).rejects.toThrow('SERVER_OPS_ACCESS_DENIED')
      await expect(invoke(fixture.handlers, SERVER_OPS_CONNECTION_DRAFT_CHANNELS.LIST, fixture.sender, 'session-a')).resolves.toEqual([draft])
      await expect(invoke(fixture.handlers, SERVER_OPS_CONNECTION_DRAFT_CHANNELS.DISMISS, fixture.sender, { sessionId: 'session-b', id: draft.id })).resolves.toBe(false)
      await expect(invoke(fixture.handlers, SERVER_OPS_CONNECTION_DRAFT_CHANNELS.LIST, fixture.sender, 'session-a')).resolves.toEqual([draft])
    } finally {
      serverOpsConnectionDraftStore.dismiss('session-a', draft.id)
      fixture.registration.dispose()
    }
  })
  test('Given 查询历史 IPC When sender、输入或数据源不可信 Then 拒绝；合法 MySQL 只访问本地 Store', async () => {
    /** 记录本地历史调用，证明 handler 不经过远端查询服务。 */
    const calls: unknown[] = []
    const createFixture = (engine: 'mysql' | 'redis' | 'sqlite' = 'mysql') => createAgentAccessHarness({
      data: {
        listSources: () => ({ sources: [{
          id: 'source-1', engine, label: '主库',
          ...(engine === 'sqlite' ? { transport: 'ssh' as const, hostId: 'host-1', filePath: '/srv/app.db', database: 'main' } : { transport: 'direct' as const, address: '127.0.0.1', port: engine === 'mysql' ? 3306 : 6379, database: 'app' }),
          tlsMode: 'disabled', hasPassword: false, createdAt: 1, updatedAt: 1,
        }] }),
        upsertSource: () => { throw new Error('NOT_USED') }, deleteSource: () => undefined,
        probeSource: async () => { throw new Error('NOT_USED') }, diagnoseSource: async () => { throw new Error('NOT_USED') },
        revealSourcePassword: () => ({ password: null }), listSchemaTables: async () => ({ databases: [], tables: [] }),
        describeSchemaTable: async () => ({ columns: [], indexes: [] }), readSchemaRows: async () => ({ columns: [], rows: [], offset: 0, limit: 50, truncated: false }), removeHost: () => undefined,
      },
      queryHistory: {
        list: (scope) => { calls.push(['list', scope]); return { entries: [] } },
        save: (input) => { calls.push(['save', input]); return { entries: [{ id: 'history-1', ...input, createdAt: 1 }] } },
      },
    })
    const fixture = createFixture()
    /** 对外声明须覆盖实际安装的 handler，避免新增历史接口遗漏在能力清单之外。 */
    expect(new Set(fixture.registration.channels)).toEqual(new Set(fixture.handlers.keys()))
    const scope = { sourceId: 'source-1', database: 'app' }
    await expect(invoke(fixture.handlers, SERVER_OPS_DATA_QUERY_HISTORY_CHANNELS.LIST, createSender(99), scope))
      .rejects.toThrow('SERVER_OPS_ACCESS_DENIED')
    await expect(invoke(fixture.handlers, SERVER_OPS_DATA_QUERY_HISTORY_CHANNELS.LIST, fixture.sender, { ...scope, extra: true }))
      .rejects.toThrow('SERVER_OPS_DATA_QUERY_HISTORY_SCOPE_INVALID')
    await expect(invoke(fixture.handlers, SERVER_OPS_DATA_QUERY_HISTORY_CHANNELS.LIST, fixture.sender, scope))
      .resolves.toEqual({ entries: [] })
    await expect(invoke(fixture.handlers, SERVER_OPS_DATA_QUERY_HISTORY_CHANNELS.SAVE, fixture.sender, { ...scope, sql: 'SELECT 1' }))
      .resolves.toMatchObject({ entries: [{ sql: 'SELECT 1' }] })
    expect(calls).toEqual([['list', scope], ['save', { ...scope, sql: 'SELECT 1' }]])

    const redis = createFixture('redis')
    await expect(invoke(redis.handlers, SERVER_OPS_DATA_QUERY_HISTORY_CHANNELS.LIST, redis.sender, scope))
      .rejects.toThrow('SERVER_OPS_DATA_QUERY_HISTORY_SOURCE_UNAVAILABLE')
    /** SQLite 历史也只读本地 Store，且不得写到附加库名下。 */
    const sqlite = createFixture('sqlite')
    await expect(invoke(sqlite.handlers, SERVER_OPS_DATA_QUERY_HISTORY_CHANNELS.LIST, sqlite.sender, { ...scope, database: 'main' })).resolves.toEqual({ entries: [] })
    await expect(invoke(sqlite.handlers, SERVER_OPS_DATA_QUERY_HISTORY_CHANNELS.LIST, sqlite.sender, { ...scope, database: 'other' })).rejects.toThrow('SERVER_OPS_DATA_QUERY_HISTORY_SOURCE_UNAVAILABLE')
    sqlite.registration.dispose()
    fixture.registration.dispose()
    redis.registration.dispose()
  })

  test.each(['mysql', 'sqlite'] as const)('Given %s SQL IPC When 授权窗口执行或关闭 Then 验证结果、记录审计并取消真实 signal', async (engine) => {
    /** 不含网络实现的服务桩，只观察 IPC 到服务的真实取消与审计顺序。 */
    let signal: AbortSignal | undefined
    let finish!: () => void
    const records: unknown[] = []
    const fixture = createAgentAccessHarness({
      auditAppend: (input) => { const record = { ...input, id: 'audit-1', timestamp: Date.now() }; expect(isServerOpsAuditRecord(record)).toBe(true); records.push(record); return record },
      data: {
        listSources: () => ({ sources: [{ id: 'db-1', engine, label: '查询数据库', ...(engine === 'sqlite' ? { transport: 'ssh' as const, hostId: 'host-1', filePath: '/srv/app.db', database: 'main' } : { transport: 'direct' as const, address: '127.0.0.1', port: 3306, database: 'app' }), tlsMode: 'disabled' as const, hasPassword: false, createdAt: 1, updatedAt: 1 }] }), upsertSource: () => { throw new Error('NOT_USED') }, deleteSource: () => undefined,
        probeSource: async () => { throw new Error('NOT_USED') }, diagnoseSource: async () => { throw new Error('NOT_USED') },
        revealSourcePassword: () => ({ password: null }), listSchemaTables: async () => ({ databases: [], tables: [] }),
        describeSchemaTable: async () => ({ columns: [], indexes: [] }), readSchemaRows: async () => ({ columns: [], rows: [], offset: 0, limit: 50, truncated: false }), removeHost: () => undefined,
        querySource: async (input, currentSignal) => {
          signal = currentSignal
          await new Promise<void>((resolve) => { finish = resolve })
          return { queryId: input.queryId, database: input.database, columns: ['id'], rows: [['1']], rowCount: 1, durationMs: 1, truncated: false, warnings: [] }
        },
      },
    })
    const input = { sourceId: 'db-1', queryId: 'query-1', database: engine === 'sqlite' ? 'main' : 'app', sql: engine === 'sqlite' ? 'SELECT "id" FROM "users"' : 'SELECT id FROM users', maxRows: 50 }
    await expect(invoke(fixture.handlers, SERVER_OPS_DATA_QUERY_CHANNELS.EXECUTE, createSender(99), input)).rejects.toThrow('SERVER_OPS_ACCESS_DENIED')
    const running = invoke(fixture.handlers, SERVER_OPS_DATA_QUERY_CHANNELS.EXECUTE, fixture.sender, input)
    /** 两个微任务分别经过 IPC 分派与开始审计准备。 */
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    expect(signal?.aborted).toBe(false)
    fixture.closeOwner()
    expect(signal?.aborted).toBe(true)
    finish()
    await expect(running).rejects.toThrow('SERVER_OPS_SQL_CANCELLED')
    expect(records).toHaveLength(2)
    expect(JSON.stringify(records)).not.toContain('SELECT')
    fixture.registration.dispose()
  })
  test('Given 已有 SSH 操作授权 When 未确认影响直接授予读取 Then 拒绝且保留原授权', async () => {
    /** 窗口不能静默替换另一任务权限。 */
    const fixture = createAgentAccessHarness()
    fixture.access.grant({ sessionId: 'session-1', hostId: 'host-1', granted: true })
    await expect(invoke(fixture.handlers, SERVER_OPS_AGENT_READ_CHANNELS.SET, fixture.sender,
      { sessionId: 'session-1', resources: [{ kind: 'ssh', hostId: 'host-1' }] })).rejects.toThrow('SERVER_OPS_ACCESS_IMPACT_CHANGED')
    expect(fixture.access.getCurrent()).toBeDefined()
    fixture.registration.dispose()
  })

  test('Given 当前会话有只读租约 When 切换会话撤销旧操作授权 Then 保留只读租约', async () => {
    const fixture = createAgentAccessHarness()
    await invoke(fixture.handlers, SERVER_OPS_AGENT_READ_CHANNELS.SET, fixture.sender,
      { sessionId: 'session-1', resources: [{ kind: 'ssh', hostId: 'host-1' }] })
    await invoke(fixture.handlers, 'server-ops:revoke-legacy-agent-access-session', fixture.sender, 'session-1')
    expect(fixture.access.getReadAccess('session-1')).toBeDefined()
    fixture.registration.dispose()
  })

  test('Given 窗口已预览影响 When 另一会话新增授权 Then 陈旧操作确认被拒绝且全部只读租约保留', async () => {
    /** 真实 IPC 快照与 Store 配合验证，不依赖 UI 是否正确显示。 */
    const fixture = createAgentAccessHarness()
    const grant = { sessionId: 'session-1', resources: [{ kind: 'ssh', hostId: 'host-1' }] }
    await invoke(fixture.handlers, SERVER_OPS_AGENT_READ_CHANNELS.SET, fixture.sender, grant)
    const preview = await invoke(fixture.handlers, SERVER_OPS_AGENT_ACCESS_MANAGEMENT_CHANNELS.IMPACT, fixture.sender) as { token: string }
    fixture.access.grantRead({ ...grant, sessionId: 'session-2' } as import('@proma/shared').ServerOpsAgentReadGrant,
      [{ key: 'ssh:host-1', fingerprint: 'other-host', hostId: 'host-1' }])
    const access = { sessionId: 'session-1', hostId: 'host-1', granted: true }
    await expect(invoke(fixture.handlers, SERVER_OPS_IPC_CHANNELS.SET_AGENT_ACCESS, fixture.sender, { access, impactToken: preview.token })).rejects.toThrow('SERVER_OPS_ACCESS_IMPACT_CHANGED')
    expect(fixture.access.listReadAccesses()).toHaveLength(2)
    /** 用户看到最新影响后才允许撤销两份租约。 */
    const current = fixture.access.listReadAccesses().sort((left, right) => left.sessionId.localeCompare(right.sessionId))
    const token = JSON.stringify({ legacy: null, reads: current.map(({ sessionId, revision }) => ({ sessionId, revision })) })
    await invoke(fixture.handlers, SERVER_OPS_IPC_CHANNELS.SET_AGENT_ACCESS, fixture.sender, { access, impactToken: token })
    expect(fixture.access.listReadAccesses()).toHaveLength(0)
    expect(fixture.access.getCurrent()).toEqual(access)
    fixture.registration.dispose()
  })

  test('Given 非授权窗口或归档会话 When 预览或申请读取 Then 在授权变化前拒绝', async () => {
    const fixture = createAgentAccessHarness({ session: createAgentSession({ archived: true }) })
    await expect(invoke(fixture.handlers, SERVER_OPS_AGENT_ACCESS_MANAGEMENT_CHANNELS.IMPACT, createSender(99))).rejects.toThrow('SERVER_OPS_ACCESS_DENIED')
    await expect(invoke(fixture.handlers, SERVER_OPS_AGENT_READ_CHANNELS.SET, fixture.sender,
      { sessionId: 'session-1', resources: [{ kind: 'ssh', hostId: 'host-1' }] })).rejects.toThrow('SERVER_OPS_AGENT_SESSION_NOT_ALLOWED')
    expect(fixture.access.listReadAccesses()).toHaveLength(0)
    fixture.registration.dispose()
  })

  test('Given 普通会话 When 授予只读资源 Then 互斥广播并沿用会话与主机撤权入口', async () => {
    const fixture = createAgentAccessHarness()
    fixture.access.grant({ sessionId: 'session-1', hostId: 'host-1', granted: true })
    const input = { sessionId: 'session-1', resources: [{ kind: 'ssh', hostId: 'host-1' }] }
    const impact = await invoke(fixture.handlers, SERVER_OPS_AGENT_ACCESS_MANAGEMENT_CHANNELS.IMPACT, fixture.sender) as { token: string }
    const result = await invoke(fixture.handlers, SERVER_OPS_AGENT_READ_CHANNELS.SET, fixture.sender, { grant: input, impactToken: impact.token })
    expect(result).toMatchObject(input)
    expect(fixture.access.getCurrent()).toBeUndefined()
    expect(fixture.events.some((event) => event.channel === SERVER_OPS_AGENT_READ_CHANNELS.CHANGED)).toBe(true)
    expect(fixture.events.some((event) => event.channel === SERVER_OPS_IPC_CHANNELS.AGENT_ACCESS_CHANGED && (event.payload as { current: unknown }).current === null)).toBe(true)
    fixture.registration.revokeSession('session-1')
    expect(fixture.access.getReadAccess('session-1')).toBeUndefined()
    await invoke(fixture.handlers, SERVER_OPS_AGENT_READ_CHANNELS.SET, fixture.sender, input)
    fixture.registration.revokeHost('host-1')
    expect(fixture.access.getReadAccess('session-1')).toBeUndefined()
    fixture.registration.dispose()
  })

  test('Given 未授权窗口、内部会话或不存在的资源 When 请求读授权 Then 拒绝', async () => {
    const fixture = createAgentAccessHarness()
    const input = { sessionId: 'session-1', resources: [{ kind: 'ssh', hostId: 'host-1' }] }
    await expect(invoke(fixture.handlers, SERVER_OPS_AGENT_READ_CHANNELS.SET, createSender(99), input)).rejects.toThrow()
    const hidden = createAgentAccessHarness({ session: createAgentSession({ sourceAutomationId: 'automation-1' }) })
    await expect(invoke(hidden.handlers, SERVER_OPS_AGENT_READ_CHANNELS.SET, hidden.sender, input)).rejects.toThrow()
    // 使用既有隐藏可见性检查，不能由 renderer 自称普通会话。
    const invisible = createAgentAccessHarness({ visible: false })
    await expect(invoke(invisible.handlers, SERVER_OPS_AGENT_READ_CHANNELS.SET, invisible.sender, input)).rejects.toThrow('SESSION_NOT_VISIBLE')
    const missing = createAgentAccessHarness({ hostExists: false })
    await expect(invoke(missing.handlers, SERVER_OPS_AGENT_READ_CHANNELS.SET, missing.sender, input)).rejects.toThrow('SERVER_OPS_HOST_NOT_FOUND')
    expect(fixture.access.getReadAccess('session-1')).toBeUndefined()
    for (const harness of [fixture, hidden, invisible, missing]) harness.registration.dispose()
  })

  test('Given 未授权窗口或被污染回执 When 移动连接 Then 拒绝分派或返回', async () => {
    let moveCalls = 0
    const fixture = createAgentAccessHarness({
      moveHost: (_hostId, _fromProjectId, targetProjectId) => {
        moveCalls += 1
        return { ...createHost(), projectId: targetProjectId }
      },
      data: {
        listSources: () => ({ sources: [] }),
        moveSource: () => ({
          id: 'source-1', projectId: 'project-2', transport: 'direct', engine: 'redis', label: '缓存',
          address: '127.0.0.1', port: 6379, tlsMode: 'disabled', hasPassword: true,
          credentialRef: 'credential-1', createdAt: 1, updatedAt: 2,
        } as never),
        upsertSource: () => { throw new Error('NOT_USED') },
        deleteSource: () => undefined,
        probeSource: async () => { throw new Error('NOT_USED') },
        diagnoseSource: async () => { throw new Error('NOT_USED') },
        revealSourcePassword: () => ({ password: null }),
        listSchemaTables: async () => ({ databases: [], tables: [] }),
        describeSchemaTable: async () => ({ columns: [], indexes: [] }),
        readSchemaRows: async () => ({ columns: [], rows: [], offset: 0, limit: 50, truncated: false }),
        removeHost: () => undefined,
      },
    })
    const sshInput = { kind: 'ssh', id: 'host-1', fromProjectId: 'project-1', targetProjectId: 'project-2' }
    await expect(invoke(fixture.handlers, SERVER_OPS_PROJECT_CHANNELS.MOVE_CONNECTION, createSender(99), sshInput))
      .rejects.toThrow('SERVER_OPS_ACCESS_DENIED')
    expect(moveCalls).toBe(0)
    await expect(invoke(fixture.handlers, SERVER_OPS_PROJECT_CHANNELS.MOVE_CONNECTION, fixture.sender, sshInput))
      .resolves.toMatchObject({ kind: 'ssh', host: { id: 'host-1', projectId: 'project-2' } })
    await expect(invoke(fixture.handlers, SERVER_OPS_PROJECT_CHANNELS.MOVE_CONNECTION, fixture.sender, {
      kind: 'data', id: 'source-1', fromProjectId: 'project-1', targetProjectId: 'project-2',
    })).rejects.toThrow('SERVER_OPS_CONNECTION_MOVE_RESULT_INVALID')
  })

  test('Given MySQL 按库诊断 When 调用 IPC Then 严格解析并保留 section 与 database', async () => {
    /** 记录服务层收到的诊断输入。 */
    const diagnoseCalls: unknown[] = []
    const fixture = createAgentAccessHarness({
      data: {
        listSources: () => ({ sources: [] }),
        moveSource: () => { throw new Error('NOT_USED') },
        upsertSource: () => { throw new Error('NOT_USED') },
        deleteSource: () => undefined,
        probeSource: async () => { throw new Error('NOT_USED') },
        diagnoseSource: async (input) => {
          diagnoseCalls.push(input)
          return {
            sourceId: input.sourceId, engine: 'mysql', capability: 'available', collectedAt: 1,
            metrics: [], tables: [], parameters: [], parametersTruncated: false, warnings: [],
          }
        },
        revealSourcePassword: () => ({ password: null }),
        listSchemaTables: async () => ({ databases: [], tables: [] }),
        describeSchemaTable: async () => ({ columns: [], indexes: [] }),
        readSchemaRows: async () => ({ columns: [], rows: [], offset: 0, limit: 50, truncated: false }),
        removeHost: () => undefined,
      },
    })
    await expect(invoke(fixture.handlers, SERVER_OPS_DATA_CHANNELS.DIAGNOSE_SOURCE, fixture.sender,
      { sourceId: 'source-1', section: 'sessions', database: ' app data ' }))
      .resolves.toMatchObject({ parametersTruncated: false })
    expect(diagnoseCalls).toEqual([{ sourceId: 'source-1', section: 'sessions', database: ' app data ' }])
    await expect(invoke(fixture.handlers, SERVER_OPS_DATA_CHANNELS.DIAGNOSE_SOURCE, fixture.sender,
      { sourceId: 'source-1', section: 'unknown' })).rejects.toThrow('SERVER_OPS_DATA_DIAGNOSE_INPUT_INVALID')
  })

  test('Given 传输请求 When Renderer 伪造本地路径或owner Then 拒绝且关闭等待传输与lease同时收口', async () => {
    /** 分别控制传输任务和未领取 fd 的清理完成时间。 */
    let finishTransfers!: () => void
    let finishLeases!: () => void
    const transferClose = new Promise<void>((resolve) => { finishTransfers = resolve })
    const leaseClose = new Promise<void>((resolve) => { finishLeases = resolve })
    const calls: unknown[] = []
    const fixture = createAgentAccessHarness({
      transfers: {
        start: async (ownerId, ownerKey, input) => {
          calls.push({ ownerId, ownerKey, input })
          return { transferId: 'transfer-1', hostId: 'host-1', direction: 'upload', fileName: 'test.txt', remotePath: '/test.txt', status: 'queued', transferredBytes: 0, totalBytes: 10, createdAt: 1, updatedAt: 1 }
        },
        list: () => [], cancel: async () => undefined,
        closeOwner: async (ownerId, ownerKey) => { calls.push({ transferClose: ownerId, ownerKey }); await transferClose },
      },
      fileLeases: {
        selectUpload: async () => null, selectDownload: async () => null,
        release: async (ownerId, ownerKey, leaseId) => { calls.push({ ownerId, ownerKey, leaseId }) },
        closeOwner: async (ownerId, ownerKey) => { calls.push({ leaseClose: ownerId, ownerKey }); await leaseClose },
      },
    })
    const input = { hostId: 'host-1', direction: 'upload', remotePath: '/test.txt', leaseId: 'lease-1' }
    await expect(invoke(fixture.handlers, SERVER_OPS_TRANSFER_CHANNELS.START, createSender(99), input)).rejects.toThrow('SERVER_OPS_ACCESS_DENIED')
    await expect(invoke(fixture.handlers, SERVER_OPS_TRANSFER_CHANNELS.START, fixture.sender, { ...input, localPath: '/private/file' })).rejects.toThrow()
    expect(calls).toEqual([])
    await invoke(fixture.handlers, SERVER_OPS_TRANSFER_CHANNELS.START, fixture.sender, input)
    expect(calls).toContainEqual({ ownerId: 70, ownerKey: 'window:70:transfers', input })
    await invoke(fixture.handlers, SERVER_OPS_TRANSFER_CHANNELS.RELEASE_SELECTION, fixture.sender, { leaseId: 'lease-2' })
    expect(calls).toContainEqual({ ownerId: 70, ownerKey: 'window:70:transfers', leaseId: 'lease-2' })
    let closed = false
    const closing = invoke(fixture.handlers, SERVER_OPS_TRANSFER_CHANNELS.CLOSE_OWNER, fixture.sender, {}).then(() => { closed = true })
    await Promise.resolve()
    finishTransfers()
    await Promise.resolve()
    expect(closed).toBe(false)
    finishLeases()
    await closing
    expect(closed).toBe(true)
    fixture.registration.dispose()
  })
  test('Given 文件请求 When 非授权窗口或伪造 owner 调用 Then 拒绝且正常窗口关闭精确释放文件 owner', async () => {
    /** 记录通过真实窗口身份调用文件服务的操作。 */
    const calls: unknown[] = []
    const fixture = createAgentAccessHarness({ files: {
      list: async (ownerKey, input) => { calls.push({ ownerKey, input }); return { hostId: input.hostId, path: '/', entries: [] } },
      preview: async () => { throw new Error('unused') },
      prepare: async () => { throw new Error('unused') },
      commit: async () => { throw new Error('unused') },
      cancel: () => undefined,
      closeOwner: async (ownerId, ownerKey) => { calls.push({ closed: ownerId, ownerKey }) },
    } })
    await expect(invoke(fixture.handlers, SERVER_OPS_FILE_CHANNELS.LIST, createSender(99), { hostId: 'host-1', path: '/' })).rejects.toThrow('SERVER_OPS_ACCESS_DENIED')
    await expect(invoke(fixture.handlers, SERVER_OPS_FILE_CHANNELS.LIST, fixture.sender, { hostId: 'host-1', path: '/', ownerKey: 'other' })).rejects.toThrow()
    expect(calls).toEqual([])
    await expect(invoke(fixture.handlers, SERVER_OPS_FILE_CHANNELS.LIST, fixture.sender, { hostId: 'host-1', path: '/' })).resolves.toMatchObject({ entries: [] })
    expect(calls).toContainEqual({ ownerKey: 'window:70:files:host-1', input: { hostId: 'host-1', path: '/' } })
    fixture.closeOwner()
    expect(calls).toContainEqual({ closed: 70, ownerKey: 'window:70:files:host-1' })
    fixture.registration.dispose()
  })

  test('Given 文件页清理尚未确认 When 立即重新挂载 Then 新读取等待清理且不会复用关闭中的 owner', async () => {
    /** 真实文件服务配合可控清理屏障，复现 StrictMode 的挂载/清理/重挂载。 */
    const fixture = createFileLifecycleHarness()
    try {
      await fixture.list('host-1')
      /** 关闭与重挂载均在清理完成前保持等待，不能提前宣告成功或失败。 */
      let closed = false
      let loaded = false
      const closing = fixture.close('host-1').then(() => { closed = true })
      const reloading = fixture.list('host-1').then(() => { loaded = true })
      // 提前订阅拒绝，旧实现的预期失败不得变成未处理 rejection。
      void reloading.catch(() => undefined)
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      expect(closed).toBe(false)
      expect(loaded).toBe(false)
      expect(fixture.readOwners).toHaveLength(1)
      fixture.finishCleanup()
      await closing
      await reloading
      expect(loaded).toBe(true)
      expect(fixture.readOwners).toHaveLength(2)
    } finally { fixture.dispose() }
  })

  test('Given 同窗口切换主机 When 旧主机文件页迟到关闭 Then 新主机仍可读取且退出释放全部活动 owner', async () => {
    /** 不同主机的浏览资源必须独立，旧主机关闭不应阻断当前主机。 */
    const fixture = createFileLifecycleHarness()
    try {
      await fixture.list('host-1')
      await fixture.list('host-2')
      expect(fixture.readOwners[0]).not.toBe(fixture.readOwners[1])
      const closing = fixture.close('host-1')
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      await expect(fixture.list('host-2')).resolves.toMatchObject({ hostId: 'host-2' })
      fixture.finishCleanup()
      await closing
      fixture.registration.dispose()
      expect(fixture.closedOwners).toEqual([fixture.readOwners[0]!, fixture.readOwners[1]!])
    } finally { fixture.dispose() }
  })

  test('Given 重挂载读取正在等待旧清理 When 页面再次关闭 Then 迟到等待者不得重新打开远端目录', async () => {
    /** 等待清理的读取也属于原页面代次，页面关闭后必须失效。 */
    const fixture = createFileLifecycleHarness()
    try {
      await fixture.list('host-1')
      const closing = fixture.close('host-1')
      const reloading = fixture.list('host-1')
      void reloading.catch(() => undefined)
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      const closingAgain = fixture.close('host-1')
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      fixture.finishCleanup()
      await Promise.all([closing, closingAgain])
      await expect(reloading).rejects.toThrow('SERVER_OPS_FILE_OWNER_CLOSED')
      expect(fixture.readOwners).toHaveLength(1)
    } finally { fixture.dispose() }
  })

  test('Given 独立容器终端 When 输入带额外命令字段或窗口关闭 Then 严格拒绝并释放该窗口终端', async () => {
    /** 完整容器身份与主窗口调用记录。 */
    const identity = { hostId: 'host-1', connectionId: 'connection-1', consoleId: 'console-1', containerId: 'a'.repeat(64) }
    const calls: unknown[] = []
    const fixture = createAgentAccessHarness({ console: {
      start: async (ownerId) => { calls.push({ start: ownerId }); return identity },
      close: async () => undefined,
      write: (ownerId, input) => { calls.push({ ownerId, input }) },
      resize: () => undefined,
      acknowledge: () => undefined,
      getSnapshot: () => undefined,
      disposeOwner: (ownerId) => { calls.push({ closed: ownerId }) },
    } })
    await expect(invoke(fixture.handlers, SERVER_OPS_CONSOLE_IPC_CHANNELS.START, createSender(99), { hostId: 'host-1', containerId: identity.containerId, cols: 80, rows: 24 })).rejects.toThrow('SERVER_OPS_ACCESS_DENIED')
    await expect(invoke(fixture.handlers, SERVER_OPS_CONSOLE_IPC_CHANNELS.WRITE, fixture.sender, { ...identity, data: 'pwd\n', command: 'extra' })).rejects.toThrow()
    expect(calls).toEqual([])
    await expect(invoke(fixture.handlers, SERVER_OPS_CONSOLE_IPC_CHANNELS.START, fixture.sender, { hostId: 'host-1', containerId: identity.containerId, cols: 80, rows: 24 })).resolves.toEqual(identity)
    await invoke(fixture.handlers, SERVER_OPS_CONSOLE_IPC_CHANNELS.WRITE, fixture.sender, { ...identity, data: 'pwd\n' })
    expect(calls).toContainEqual({ ownerId: 70, input: { ...identity, data: 'pwd\n' } })
    fixture.closeOwner()
    expect(calls).toContainEqual({ closed: 70 })
    fixture.registration.dispose()
  })

  test('Given Docker IPC When 访问、取消与窗口关闭 Then 校验授权、字段及可信 owner', async () => {
    const calls: unknown[] = []
    const fixture = createAgentAccessHarness({ docker: {
      listResources: async (input) => { calls.push(input); return { hostId: 'host-1', capability: 'available', containers: [], images: [], networks: [], volumes: [], warnings: [] } },
      getContainerDetail: async () => { throw new Error('unused') },
      prepareAction: async () => { throw new Error('unused') },
      commitAction: async () => { throw new Error('unused') },
      cancelAction: (owner, input) => { calls.push({ owner, input }) },
      disposeOwner: (owner) => { calls.push({ closed: owner }) },
    } })
    await expect(invoke(fixture.handlers, SERVER_OPS_DOCKER_CHANNELS.LIST_RESOURCES, createSender(99), { hostId: 'host-1' })).rejects.toThrow('SERVER_OPS_ACCESS_DENIED')
    await expect(invoke(fixture.handlers, SERVER_OPS_DOCKER_CHANNELS.LIST_RESOURCES, fixture.sender, { hostId: 'host-1', command: 'arbitrary' })).rejects.toThrow('SERVER_OPS_DOCKER_RESOURCES_INPUT_INVALID')
    expect(calls).toEqual([])
    await expect(invoke(fixture.handlers, SERVER_OPS_DOCKER_CHANNELS.LIST_RESOURCES, fixture.sender, { hostId: 'host-1' })).resolves.toMatchObject({ capability: 'available' })
    await invoke(fixture.handlers, SERVER_OPS_DOCKER_CHANNELS.CANCEL_ACTION, fixture.sender, { hostId: 'host-1', candidateId: 'candidate-1' })
    expect(calls).toContainEqual({ owner: 70, input: { hostId: 'host-1', candidateId: 'candidate-1' } })
    fixture.closeOwner()
    expect(calls).toContainEqual({ closed: 70 })
    fixture.registration.dispose()
  })
  test('Given 信任管理请求 When 主窗口调用 Then owner 来自 Electron 且销毁后清理候选', async () => {
    /** 信任服务公开输出及所有权调用记录。 */
    const snapshot = { hostId: 'host-1', name: '测试', address: 'localhost', port: 22,
      trustedKey: { algorithm: 'ssh-ed25519', fingerprint: 'SHA256:first' },
      observedKey: { algorithm: 'ssh-ed25519', fingerprint: 'SHA256:second' }, affectedHosts: [{ id: 'host-1', name: '测试' }] }
    const owners: number[] = []
    const disposed: number[] = []
    const harness = createAgentAccessHarness({ trustManagement: {
      get: () => snapshot,
      prepare: (owner, input) => { owners.push(owner); return { ...snapshot, action: input.action, candidateId: 'candidate-1', expiresAt: 300_000 } },
      commit: async (owner) => { owners.push(owner); return { hostId: 'host-1', action: 'replace', affectedHostIds: ['host-1'] } },
      cancel: (owner) => { owners.push(owner) }, disposeOwner: (owner) => { disposed.push(owner) },
    } })
    try {
      await expect(invoke(harness.handlers, SERVER_OPS_TRUST_CHANNELS.PREPARE, createSender(8), { hostId: 'host-1', action: 'replace' })).rejects.toThrow('SERVER_OPS_ACCESS_DENIED')
      await expect(invoke(harness.handlers, SERVER_OPS_TRUST_CHANNELS.PREPARE, harness.sender, { hostId: 'host-1', action: 'replace', windowId: 9 })).rejects.toThrow()
      expect(owners).toHaveLength(0)
      expect(await invoke(harness.handlers, SERVER_OPS_TRUST_CHANNELS.PREPARE, harness.sender, { hostId: 'host-1', action: 'replace' })).toMatchObject({ candidateId: 'candidate-1' })
      await invoke(harness.handlers, SERVER_OPS_TRUST_CHANNELS.COMMIT, harness.sender, { hostId: 'host-1', candidateId: 'candidate-1', confirmationName: '测试' })
      expect(owners).toEqual([70, 70])
      harness.closeOwner()
      expect(disposed).toEqual([70])
    } finally { harness.registration.dispose() }
  })

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
    await expect(invoke(handlers, SERVER_OPS_IPC_CHANNELS.SET_AGENT_ACCESS, sender, { access: { sessionId: 'session-2', hostId: 'host-1', granted: true }, impactToken: (await invoke(handlers, SERVER_OPS_AGENT_ACCESS_MANAGEMENT_CHANNELS.IMPACT, sender) as { token: string }).token })).resolves.toEqual({ sessionId: 'session-2', hostId: 'host-1', granted: true })
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

    expect(registration.channels).toEqual([...Object.values(SERVER_OPS_IPC_CHANNELS).filter((channel) => !([
      SERVER_OPS_IPC_CHANNELS.CONNECTION_STATE,
      SERVER_OPS_IPC_CHANNELS.TERMINAL_OUTPUT,
      SERVER_OPS_IPC_CHANNELS.TERMINAL_EXIT,
      SERVER_OPS_IPC_CHANNELS.AGENT_ACCESS_CHANGED,
      SERVER_OPS_IPC_CHANNELS.LOG_OUTPUT,
      SERVER_OPS_IPC_CHANNELS.LOG_EXIT,
    ] as readonly string[]).includes(channel)).flatMap((channel) => channel === SERVER_OPS_IPC_CHANNELS.REVOKE_AGENT_ACCESS_SESSION ? [channel, ...Object.values(SERVER_OPS_AGENT_ACCESS_MANAGEMENT_CHANNELS)] : [channel]), SERVER_OPS_AGENT_READ_CHANNELS.GET, SERVER_OPS_AGENT_READ_CHANNELS.SET, SERVER_OPS_CONNECTION_DRAFT_CHANNELS.LIST, SERVER_OPS_CONNECTION_DRAFT_CHANNELS.DISMISS, ...Object.values(SERVER_OPS_TRUST_CHANNELS), ...Object.values(SERVER_OPS_DOCKER_CHANNELS),
      ...Object.values(SERVER_OPS_FILE_CHANNELS),
      ...Object.values(SERVER_OPS_CONSOLE_IPC_CHANNELS).filter((channel) => channel !== SERVER_OPS_CONSOLE_IPC_CHANNELS.OUTPUT && channel !== SERVER_OPS_CONSOLE_IPC_CHANNELS.EXIT),
      ...Object.values(SERVER_OPS_TRANSFER_CHANNELS).filter((channel) => channel !== SERVER_OPS_TRANSFER_CHANNELS.PROGRESS),
      ...Object.values(SERVER_OPS_DATA_CHANNELS),
      ...Object.values(SERVER_OPS_DATA_SCHEMA_CHANNELS),
      ...Object.values(SERVER_OPS_DATA_QUERY_CHANNELS),
      ...Object.values(SERVER_OPS_DATA_QUERY_HISTORY_CHANNELS),
      ...Object.values(SERVER_OPS_PROJECT_CHANNELS)])
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

  test('Given 非授权 BrowserWindow When 执行服务动作 Then 在领域调用前拒绝', async () => {
    const fixture = createObservabilityHarness({ authorizeSecondWindow: false })
    await expect(invoke(fixture.handlers, SERVER_OPS_IPC_CHANNELS.RUN_SERVICE_ACTION, fixture.senderTwo, {
      sessionId: 'session-1', hostId: 'host-1', unitId: 'nginx.service', action: 'restart',
    })).rejects.toThrow('SERVER_OPS_ACCESS_DENIED')
    expect(fixture.domainCalls).toEqual([])
    fixture.registration.dispose()
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
    expect(cleanup.filter((entry) => entry.startsWith('remove-handler:'))).toHaveLength(75)
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
    expect(cleanup.filter((entry) => entry.startsWith('remove-handler:'))).toHaveLength(75)
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

/** 创建真实 IPC + 文件服务夹具；仅替代 SSH 传输，返回可手动完成的 owner 清理屏障。 */
function createFileLifecycleHarness() {
  /** 记录成功发往 SSH 的读取和关闭，用于验证跨主机及跨代次隔离。 */
  const readOwners: string[] = []
  const closedOwners: string[] = []
  const closingOwners = new Set<string>()
  /** 控制第一次远端清理 ACK；后续关闭共享已完成屏障。 */
  let finishCleanup!: () => void
  const cleanup = new Promise<void>((resolve) => { finishCleanup = resolve })
  const files = new ServerOpsFileService({
    hosts: { get: (hostId) => ({ id: hostId, name: '测试服务器' }) },
    connections: {
      getActiveIdentity: (hostId) => ({ hostId, connectionId: `connection-${hostId}`, generation: 1 }),
      sftp: async (input) => {
        if (closingOwners.has(input.input.ownerKey)) throw new ServerOpsSftpRuntimeError('SERVER_OPS_SFTP_OWNER_CLOSED')
        if (input.type !== 'list') throw new Error('unexpected SFTP operation')
        readOwners.push(input.input.ownerKey)
        return { type: 'list', requestId: 'request-1', result: { path: input.input.path, entries: [] } }
      },
      closeSftpOwner: async (ownerKey) => {
        closedOwners.push(ownerKey)
        closingOwners.add(ownerKey)
        await cleanup
        closingOwners.delete(ownerKey)
      },
    },
    audit: { append: () => undefined },
  })
  /** 所有调用均穿过真实解析、窗口授权及文件服务边界。 */
  const fixture = createAgentAccessHarness({ files })
  return {
    registration: fixture.registration, readOwners, closedOwners, finishCleanup,
    list: (hostId: string) => invoke(fixture.handlers, SERVER_OPS_FILE_CHANNELS.LIST, fixture.sender, { hostId, path: '/' }),
    close: (hostId: string) => invoke(fixture.handlers, SERVER_OPS_FILE_CHANNELS.CLOSE_OWNER, fixture.sender, { hostId }),
    dispose: () => { finishCleanup(); fixture.registration.dispose(); files.dispose() },
  }
}

/** 创建覆盖观测、日志 owner 与导出边界的集中夹具。 */
function createObservabilityHarness(options: { hostName?: string; startResult?: unknown; stopError?: Error; authorizeSecondWindow?: boolean } = {}) {
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
    listAuthorizedWebContents: () => options.authorizeSecondWindow === false ? [sender] : [sender, senderTwo],
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
    handlers, sender, senderTwo, domainCalls, logCalls, cleanupCalls, eventsOne, eventsTwo, dialogCalls, writes, results, stops,
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
