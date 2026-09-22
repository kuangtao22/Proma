import { describe, expect, test } from 'bun:test'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { isServerOpsAuditRecord, parseServerOpsAgentReadGrant } from '@proma/shared'
import type {
  AgentSessionMeta,
  ServerOpsAgentReadAccess,
  ServerOpsAgentReadGrant,
  ServerOpsAuditAppendInput,
  ServerOpsAuditRecord,
  ServerOpsDataSource,
  ServerOpsHost,
} from '@proma/shared'
import { buildServerOpsReadTools } from '../adapters/pi-server-ops-read-tools'
import { ServerOpsAgentAccessStore } from './server-ops-agent-access-store'
import { captureServerOpsReadBindings } from './server-ops-agent-read-identity'
import { prepareServerOpsDatabaseChangeContext } from './server-ops-database-change-context'
import {
  createServerOpsAgentReadFacade,
  type ServerOpsAgentReadFacadeDependencies,
} from './server-ops-agent-read-facade'

/** 构造不含业务差异的普通用户会话。 */
function session(overrides: Partial<AgentSessionMeta> = {}): AgentSessionMeta {
  return { id: 'session-1', title: '普通会话', createdAt: 1, updatedAt: 1, ...overrides } as AgentSessionMeta
}

/** 构造一台已保存服务器，凭据字段用于验证公开投影不会泄漏。 */
function host(overrides: Partial<ServerOpsHost> = {}): ServerOpsHost {
  return {
    id: 'host-1', projectId: 'project-1', name: '生产机', address: '10.0.0.1', port: 22,
    username: 'deploy', authMethod: 'password', credentialRef: 'secret-ref', tags: ['prod'],
    createdAt: 1, updatedAt: 2, ...overrides,
  }
}

/** 构造一个 MySQL 数据源，保留公开字段但不提供任何密码。 */
function source(overrides: Partial<ServerOpsDataSource> = {}): ServerOpsDataSource {
  return {
    id: 'source-1', projectId: 'project-1', transport: 'direct', engine: 'mysql', label: '订单库',
    address: '10.0.0.2', port: 3306, database: 'app', username: 'reader', tlsMode: 'disabled',
    hasPassword: true, createdAt: 1, updatedAt: 2, ...overrides,
  }
}

/** 构造默认授权与完整服务桩；测试只覆盖 Facade 自身安全行为。 */
function dependencies(options: {
  access?: ServerOpsAgentReadAccess
  session?: AgentSessionMeta
  auditAppend?: (input: ServerOpsAuditAppendInput) => ServerOpsAuditRecord | void
  prepareAudit?: () => Promise<void>
} = {}): ServerOpsAgentReadFacadeDependencies {
  /** 当前授权可在测试过程中原子替换，模拟撤销与重新授权。 */
  const access = options.access ?? {
    sessionId: 'session-1', revision: 7, grantedAt: 10, expiresAt: Date.now() + 1_800_000,
    resources: [
      { kind: 'ssh' as const, hostId: 'host-1' },
      {
        kind: 'mysql' as const, sourceId: 'source-1', instance: true,
        databases: [{ database: 'app', tables: ['users'], readRows: true }],
      },
    ],
  }
  /** 连接绑定只包含配置事实摘要；项目移动与改名不改变该摘要。 */
  const bindings = new Map([
    ['ssh:host-1', { key: 'ssh:host-1', fingerprint: 'host-fingerprint', hostId: 'host-1' }],
    ['data:source-1', { key: 'data:source-1', fingerprint: 'data-fingerprint' }],
  ])
  return {
    getSession: () => options.session ?? session(),
    captureBindings: (resources) => resources.map((resource) => bindings.get(resource.kind === 'ssh' ? `ssh:${resource.hostId}` : `data:${resource.sourceId}`)!).filter(Boolean),
    services: {
      credentials: { getVersion: () => 'host-credential-version' },
      hosts: { get: (hostId) => hostId === 'host-1' ? host() : undefined },
      access: {
        getReadAccess: () => access,
        getReadBinding: (_sessionId, key) => bindings.get(key),
      },
      databasePolicy: { get: () => ({ revision: 0, exclusions: access.resources.flatMap((resource) => resource.kind === 'mysql' || resource.kind === 'sqlite'
        ? resource.databases.filter((scope) => scope.excludedTables?.length).map((scope) => ({ sourceId: resource.sourceId, database: scope.database, excludedTables: scope.excludedTables! })) : []) }) },
      overview: {
        getOverview: async ({ hostId }) => ({
          hostId, capturedAt: 100, sampleWindowMs: 500, system: {
            hostname: 'prod-1', osName: 'Linux', osVersion: '1', kernel: '6', arch: 'x64', uptimeSeconds: 99,
          }, filesystems: [], processes: [], warnings: [],
        }),
      },
      systemd: {
        listServices: async ({ hostId }) => ({ hostId, capability: 'available' as const, services: [], warnings: [] }),
      },
      data: {
        getReadCredentialVersion: () => 'data-credential-version',
        listSources: () => ({ sources: [source()] }),
        probeSource: async (input) => {
          if (!('sourceId' in input)) throw new Error('unexpected draft')
          return { sourceId: input.sourceId, engine: 'mysql' as const, capability: 'available' as const, serverVersion: '8.0', latencyMs: 12, warnings: [] }
        },
        diagnoseSource: async ({ sourceId }) => ({
          sourceId, engine: 'mysql' as const, capability: 'available' as const, collectedAt: 100,
          metrics: [], parameters: [{ name: 'max_connections', value: '100', scope: 'global' as const }],
          tables: [{
            id: 'statements', title: '语句', truncated: false,
            columns: [{ id: 'sql', label: 'SQL' }, { id: 'database', label: '库' }],
            rows: [['SELECT secret FROM other.orders WHERE password = 1', 'other']],
          }], warnings: [],
        }),
        listSchemaTables: async ({ database }) => ({
          database, databases: ['app', 'secret'],
          tables: [{ name: 'users', type: 'table' as const }, { name: 'payments', type: 'table' as const }],
        }),
        describeSchemaTable: async () => ({
          columns: [
            { name: 'id', type: 'bigint', nullable: false, primaryKey: true },
            { name: 'password_hash', type: 'varchar(255)', nullable: false, primaryKey: false, defaultText: 'secret-default', comment: 'secret-comment' },
          ],
          indexes: [{ name: 'PRIMARY', unique: true, columns: ['id'] }],
        }),
        readSchemaRows: async ({ offset, limit }) => ({
          columns: ['id', 'password_hash'], rows: [['1', 'do-not-leak']], offset, limit,
          truncated: false, hasMore: false, orderedByPrimaryKey: true, totalEstimate: 1,
        }),
      },
      audit: {
        prepareForWrites: options.prepareAudit,
        append: (input) => options.auditAppend?.(input) ?? { id: 'audit-1', timestamp: 1, ...input },
      },
    },
  }
}

describe('Server Ops Agent 多资源只读 Facade', () => {
  test('Given 已保存数据库无会话租约且禁用名单为空 When 发现并读取 Then 所有普通表默认只读可用', async () => {
    const deps = dependencies()
    deps.services.access.getReadAccess = () => undefined
    deps.services.databasePolicy = { get: () => ({ revision: 0, exclusions: [] }) }
    const facade = createServerOpsAgentReadFacade({ sessionId: 'session-1', dependencies: deps })!
    expect(facade.resources().resources).toContainEqual(expect.objectContaining({ kind: 'mysql', sourceId: 'source-1' }))
    deps.services.data!.listSchemaTables = async ({ database }) => ({ database: database ?? 'app', databases: ['app', 'mysql'], tables: [{ name: 'users' }, { name: 'payments' }] })
    expect((await facade.databaseTables({ sourceId: 'source-1' })).databases).toEqual(['app'])
    expect((await facade.databaseTables({ sourceId: 'source-1', database: 'app' })).tables.map((table) => table.name)).toEqual(['users', 'payments'])
    await expect(facade.databaseRows({ sourceId: 'source-1', database: 'app', table: 'payments', offset: 0, limit: 50 })).resolves.toMatchObject({ offset: 0 })
  })

  test('Given 持久禁用表 When 查询联表及读取结构 Then 拒绝禁用表并允许同库其余表', async () => {
    const deps = dependencies()
    deps.services.access.getReadAccess = () => undefined
    deps.services.databasePolicy = { get: () => ({ revision: 3, exclusions: [{ sourceId: 'source-1', database: 'app', excludedTables: ['payments'] }] }) }
    const facade = createServerOpsAgentReadFacade({ sessionId: 'session-1', dependencies: deps })!
    expect((await facade.databaseTables({ sourceId: 'source-1', database: 'app' })).tables.map((table) => table.name)).toEqual(['users'])
    deps.services.data!.listSchemaTables = async () => ({ database: 'app', databases: ['app'], tables: [
      { name: 'users', type: 'table' }, { name: 'payments', type: 'table' }, { name: 'payments_view', type: 'view' },
    ] })
    expect((await facade.databaseTables({ sourceId: 'source-1' })).tables.map((table) => table.name)).toEqual(['users'])
    await expect(facade.databaseDescribe({ sourceId: 'source-1', database: 'app', table: 'PAYMENTS' })).rejects.toThrow('SERVER_OPS_AGENT_SCOPE_REQUIRED')
    await expect(facade.databaseQuery({ sourceId: 'source-1', database: 'app', sql: 'SELECT users.id FROM users JOIN payments ON users.id = payments.id', maxRows: 10 })).rejects.toThrow('SERVER_OPS_AGENT_SCOPE_REQUIRED')
    await expect(facade.dataDiagnose({ sourceId: 'source-1', scope: 'instance', section: 'statements' })).rejects.toThrow('SERVER_OPS_AGENT_SCOPE_REQUIRED')
    // 默认业务表读取不能扩大为全局参数或实例指标访问。
    await expect(facade.dataDiagnose({ sourceId: 'source-1', scope: 'instance', section: 'parameters' })).rejects.toThrow('SERVER_OPS_AGENT_SCOPE_REQUIRED')
    await expect(facade.dataDiagnose({ sourceId: 'source-1', scope: 'instance', section: 'overview' })).rejects.toThrow('SERVER_OPS_AGENT_SCOPE_REQUIRED')
    await expect(facade.dataProbe({ sourceId: 'source-1' })).resolves.toMatchObject({ capability: 'available' })
  })

  test('Given 库名大小写变体分别保存禁用项 When 读取任一变体 Then 合并全部禁用表', async () => {
    const deps = dependencies()
    deps.services.databasePolicy = { get: () => ({ revision: 4, exclusions: [
      { sourceId: 'source-1', database: 'app', excludedTables: ['users'] },
      { sourceId: 'source-1', database: 'App', excludedTables: ['payments'] },
    ] }) }
    const facade = createServerOpsAgentReadFacade({ sessionId: 'session-1', dependencies: deps })!
    expect((await facade.databaseTables({ sourceId: 'source-1', database: 'app' })).tables).toEqual([])
    await expect(facade.databaseRows({ sourceId: 'source-1', database: 'app', table: 'payments', offset: 0, limit: 10 })).rejects.toThrow('SERVER_OPS_AGENT_SCOPE_REQUIRED')
  })

  test('Given 超大库目录 When 按需发现 Then 仅返回预算内的库名前缀', async () => {
    const deps = dependencies()
    deps.services.data!.listSchemaTables = async () => ({ databases: Array.from({ length: 200 }, (_, index) => `库${index}_${'库'.repeat(55)}`), tables: [] })
    const facade = createServerOpsAgentReadFacade({ sessionId: 'session-1', dependencies: deps })!
    const result = await facade.databaseTables({ sourceId: 'source-1' })
    expect(result.truncated).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(result, null, 2), 'utf8')).toBeLessThanOrEqual(32_768)
  })

  test('Given 系统库或缺少持久策略 When 请求读取 Then 连接默认开放不扩大至敏感库或失效配置', async () => {
    const deps = dependencies()
    deps.services.access.getReadAccess = () => undefined
    deps.services.databasePolicy = { get: () => ({ revision: 0, exclusions: [] }) }
    const facade = createServerOpsAgentReadFacade({ sessionId: 'session-1', dependencies: deps })!
    await expect(facade.databaseTables({ sourceId: 'source-1', database: 'mysql' })).rejects.toThrow('SERVER_OPS_AGENT_SCOPE_REQUIRED')
    await expect(facade.databaseRows({ sourceId: 'source-1', database: 'information_schema', table: 'tables', offset: 0, limit: 10 })).rejects.toThrow('SERVER_OPS_AGENT_SCOPE_REQUIRED')
    const withoutPolicy = dependencies()
    withoutPolicy.services.databasePolicy = undefined
    await expect(createServerOpsAgentReadFacade({ sessionId: 'session-1', dependencies: withoutPolicy })!.databaseTables({ sourceId: 'source-1', database: 'app' })).rejects.toThrow('SERVER_OPS_AGENT_ACCESS_REQUIRED')
  })
  test('Given 展示投影省略合法库 When 生成变更依据 Then 精确授权仍允许目标且拒绝禁用表与跨库', async () => {
    /** 授权受 16 KiB 文档预算约束，模拟展示裁剪只修改公开目录，不修改真实 Facade。 */
    const scopes = Array.from({ length: 4 }, (_, index) => ({
      database: `database_${index}`, tables: null, readRows: true,
      excludedTables: Array.from({ length: 20 }, (_, tableIndex) => `private_${tableIndex}_${'x'.repeat(110)}`),
    }))
    const access: ServerOpsAgentReadAccess = {
      sessionId: 'session-1', revision: 7, grantedAt: 10, expiresAt: Date.now() + 1_800_000,
      resources: [{ kind: 'mysql', sourceId: 'source-1', instance: false,
        databases: [...scopes, { database: 'target', tables: null, excludedTables: ['secret'], readRows: true }] }],
    }
    expect(parseServerOpsAgentReadGrant({ sessionId: access.sessionId, resources: access.resources }).resources).toEqual(access.resources)
    const deps = dependencies({ access })
    const reads: string[] = []
    deps.services.data!.describeSchemaTable = async ({ table }) => {
      reads.push(table)
      return { columns: [], indexes: [] }
    }
    const facade = createServerOpsAgentReadFacade({ sessionId: 'session-1', dependencies: deps })!
    const actualDirectory = facade.resources()
    expect(actualDirectory.resources.some((resource) => resource.kind === 'mysql')).toBe(true)
    facade.resources = () => ({ ...actualDirectory, resources: [], truncated: true })
    const directory = facade.resources()
    expect(directory.truncated).toBe(true)
    expect(directory.resources).toEqual([])
    await expect(prepareServerOpsDatabaseChangeContext(facade, { sourceId: 'source-1', database: 'target', tables: ['users'] }))
      .resolves.toMatchObject({ engine: 'mysql', tables: [{ name: 'users' }] })
    expect(reads).toEqual(['users'])
    await expect(prepareServerOpsDatabaseChangeContext(facade, { sourceId: 'source-1', database: 'target', tables: ['users', 'SECRET'] }))
      .rejects.toThrow('SERVER_OPS_AGENT_SCOPE_REQUIRED')
    await expect(prepareServerOpsDatabaseChangeContext(facade, { sourceId: 'source-1', database: 'mysql', tables: ['users'] }))
      .rejects.toThrow('SERVER_OPS_AGENT_SCOPE_REQUIRED')
    expect(reads).toEqual(['users'])
    const initial = deps.services.databasePolicy!.get()
    deps.services.databasePolicy!.get = () => ({ ...initial, revision: 8 })
    await expect(prepareServerOpsDatabaseChangeContext(facade, { sourceId: 'source-1', database: 'target', tables: ['users'] }))
      .rejects.toThrow('SERVER_OPS_AGENT_ACCESS_CHANGED')
    expect(reads).toEqual(['users'])
  })
  test('Given 停止本轮运行 When 再次调用工具 Then 保留会话租约但拒绝旧闭包', async () => {
    /** 运行取消与授权生命周期相互独立。 */
    const deps = dependencies()
    const controller = new AbortController()
    const facade = createServerOpsAgentReadFacade({ sessionId: 'session-1', dependencies: deps, runSignal: controller.signal })!
    controller.abort()
    await expect(facade.databaseTables({ sourceId: 'source-1', database: 'app' })).rejects.toThrow('SERVER_OPS_AGENT_RUN_CANCELLED')
    expect(deps.services.access.getReadAccess('session-1')).toBeDefined()
  })

  test('Given 结构读取已执行 When 工具取消 Then 信号到服务且底层拒绝归因明确', async () => {
    /** 服务主动响应 abort，避免迟到成功桩掩盖取消错误。 */
    const deps = dependencies()
    const entered = Promise.withResolvers<void>()
    deps.services.data!.listSchemaTables = async (_request, signal) => {
      entered.resolve()
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('SERVER_OPS_DATA_CANCELLED')), { once: true })
      })
    }
    const facade = createServerOpsAgentReadFacade({ sessionId: 'session-1', dependencies: deps })!
    const controller = new AbortController()
    const result = facade.databaseTables({ sourceId: 'source-1', database: 'app' }, controller.signal).catch((error: Error) => error.message)
    await entered.promise
    controller.abort()
    expect(await Promise.race([result, new Promise((resolve) => setTimeout(() => resolve('cancel did not reach runtime'), 50))])).toBe('SERVER_OPS_AGENT_READ_CANCELLED')
  })

  test('Given 本轮已绑定持久策略 When 修改禁用名单 Then 旧闭包不继承，新运行按新规则读取', async () => {
    const deps = dependencies()
    let policy = deps.services.databasePolicy!.get()
    deps.services.databasePolicy!.get = () => policy
    const old = createServerOpsAgentReadFacade({ sessionId: 'session-1', dependencies: deps })!
    policy = { revision: policy.revision + 1, exclusions: [{ sourceId: 'source-1', database: 'app', excludedTables: ['payments'] }] }
    await expect(old.databaseTables({ sourceId: 'source-1', database: 'app' })).rejects.toThrow('SERVER_OPS_AGENT_ACCESS_CHANGED')
    const fresh = createServerOpsAgentReadFacade({ sessionId: 'session-1', dependencies: deps })!
    await expect(fresh.databaseTables({ sourceId: 'source-1', database: 'app' })).resolves.toMatchObject({ database: 'app' })
    deps.services.access.getReadAccess = () => undefined
    const ungranted = createServerOpsAgentReadFacade({ sessionId: 'session-1', dependencies: deps })!
    expect(ungranted.resources().resources).toContainEqual(expect.objectContaining({ kind: 'mysql' }))
    await expect(ungranted.databaseTables({ sourceId: 'source-1', database: 'app' })).resolves.toMatchObject({ tables: [{ name: 'users', type: 'table' }] })
  })

  test('Given SDK 结构工具 When 传入取消信号 Then execute 将信号传至 Facade', async () => {
    const deps = dependencies()
    const facade = createServerOpsAgentReadFacade({ sessionId: 'session-1', dependencies: deps })!
    const sdk = { defineTool: (definition: ToolDefinition) => definition } as typeof import('@earendil-works/pi-coding-agent')
    const controller = new AbortController()
    const seen: AbortSignal[] = []
    facade.databaseTables = async (_request, signal) => { if (signal) seen.push(signal); return { database: 'app', databases: ['app'], tables: [] } }
    const tool = buildServerOpsReadTools(sdk, facade).find((entry) => entry.name === 'ops_database_tables')!
    const execute = tool.execute as unknown as (id: string, request: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>
    await execute('call-1', { sourceId: 'source-1', database: 'app' }, controller.signal)
    expect(seen).toEqual([controller.signal])
  })

  test('Given 已保存 SQLite When 读取 main 与执行 SQL Then 禁用表不可见且不开放 temp', async () => {
    const deps = dependencies({ access: { sessionId: 'session-1', revision: 7, grantedAt: 10, expiresAt: Date.now() + 1_800_000, resources: [{ kind: 'sqlite', sourceId: 'source-1', instance: false, databases: [{ database: 'main', tables: ['users'], readRows: true, query: true }] }] } })
    deps.services.data!.listSources = () => ({ sources: [{ id: 'source-1', label: '业务 SQLite', transport: 'ssh', hostId: 'host-1', engine: 'sqlite', filePath: '/srv/data.db', database: 'main', tlsMode: 'disabled', hasPassword: false, createdAt: 1, updatedAt: 1 }] })
    deps.services.data!.listSchemaTables = async () => ({ database: 'main', databases: ['main'], tables: [{ name: 'users' }, { name: 'private_data' }] })
    deps.services.databasePolicy = { get: () => ({ revision: 1, exclusions: [{ sourceId: 'source-1', database: 'main', excludedTables: ['private_data'] }] }) }
    /** 仅记录真正到达执行服务的语句数量。 */
    let queries = 0
    deps.services.data!.querySource = async (input) => {
      queries += 1
      return { queryId: input.queryId, database: input.database, columns: ['id'], rows: [['1']], rowCount: 1, durationMs: 1, truncated: false, warnings: [] }
    }
    const facade = createServerOpsAgentReadFacade({ sessionId: 'session-1', dependencies: deps })
    if (!facade) throw new Error('SQLite 测试会话未创建 Facade')
    expect(facade.resources().resources[0]).toMatchObject({ kind: 'sqlite', instance: false })
    expect((await facade.databaseTables({ sourceId: 'source-1', database: 'main' })).tables).toEqual([{ name: 'users' }])
    expect((await facade.databaseRows({ sourceId: 'source-1', database: 'main', table: 'users', offset: 0, limit: 50 })).rows[0]).toEqual(['1', '[MASKED]'])
    await expect(facade.databaseQuery({ sourceId: 'source-1', database: 'main', sql: 'SELECT "id" FROM "users"', maxRows: 10 })).resolves.toMatchObject({ rowCount: 1 })
    await expect(facade.databaseQuery({ sourceId: 'source-1', database: 'main', sql: 'SELECT id FROM private_data', maxRows: 10 })).rejects.toThrow('SERVER_OPS_AGENT_SCOPE_REQUIRED')
    await expect(facade.databaseTables({ sourceId: 'source-1', database: 'temp' })).rejects.toThrow('SERVER_OPS_AGENT_SCOPE_REQUIRED')
    expect(queries).toBe(1)
  })
  test('Given 已保存数据库 When 查询单表和联表 Then 禁用表不得参与 SQL', async () => {
    /** 实际 Facade 服务调用计数，证明越界在数据库执行前被阻断。 */
    const deps = dependencies()
    deps.services.databasePolicy!.get = () => ({ revision: 1, exclusions: [{ sourceId: 'source-1', database: 'app', excludedTables: ['payments'] }] })
    let calls = 0
    deps.services.data!.querySource = async (input) => {
      calls += 1
      return { queryId: input.queryId, database: input.database, columns: ['id'], rows: [['1']], rowCount: 1, durationMs: 1, truncated: false, warnings: [] }
    }
    const facade = createServerOpsAgentReadFacade({ sessionId: 'session-1', dependencies: deps })!
    const input = { sourceId: 'source-1', database: 'app', sql: 'SELECT id FROM users', maxRows: 50 }
    await expect(facade.databaseQuery(input)).resolves.toMatchObject({ rows: [['1']] })
    await expect(facade.databaseQuery({ ...input, sql: 'SELECT u.id FROM users u JOIN payments p ON u.id = p.user_id' })).rejects.toThrow('SERVER_OPS_AGENT_SCOPE_REQUIRED')
    await expect(facade.databaseQuery({ ...input, maxRows: 51 })).rejects.toThrow()
    expect(calls).toBe(1)
  })

  test('Given 持久禁用规则与 SQL 工具 When 执行中修改禁用或取消 Then 真实信号终止且迟到行不返回', async () => {
    /** 工具、策略版本与审计走正式 Facade 路径，仅数据库查询由内存桩替代。 */
    const records: ServerOpsAuditRecord[] = []
    const deps = dependencies({ auditAppend: (input) => {
      const record = { id: `sql-audit-${records.length}`, timestamp: Date.now(), ...input }
      expect(isServerOpsAuditRecord(record)).toBe(true)
      records.push(record)
      return record
    } })
    const access = new ServerOpsAgentAccessStore()
    deps.services.access = access
    deps.captureBindings = (resources) => captureServerOpsReadBindings(resources, deps.services)
    const grant: ServerOpsAgentReadGrant = {
      sessionId: 'session-1', resources: [{ kind: 'mysql', sourceId: 'source-1', instance: false,
        databases: [{ database: 'app', tables: ['users'], readRows: true, query: true }] }],
    }
    access.grantRead(grant, deps.captureBindings(grant.resources))
    let policy = { revision: 0, exclusions: [{ sourceId: 'source-1', database: 'app', excludedTables: [] as string[] }] }
    const listeners = new Set<() => void>()
    deps.services.databasePolicy = { get: () => policy, onChanged: (listener) => {
      const callback = () => listener(policy)
      listeners.add(callback)
      return () => { listeners.delete(callback) }
    } }
    const facade = createServerOpsAgentReadFacade({ sessionId: 'session-1', dependencies: deps })!
    const sdk = { defineTool: (definition: ToolDefinition) => definition } as typeof import('@earendil-works/pi-coding-agent')
    const tool = buildServerOpsReadTools(sdk, facade).find((entry) => entry.name === 'ops_database_query')!
    const execute = tool.execute as unknown as (id: string, input: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>
    const input = { sourceId: 'source-1', database: 'app', sql: "SELECT id FROM users WHERE name = 'PRIVATE_LITERAL'", maxRows: 50 }
    /** 先等实际服务收到请求再撤权，避免测试仅覆盖首次权限检查。 */
    let entered = Promise.withResolvers<void>()
    let finish = Promise.withResolvers<void>()
    let actualSignal: AbortSignal | undefined
    let calls = 0
    deps.services.data!.querySource = async (request, signal) => {
      calls += 1
      actualSignal = signal
      entered.resolve()
      await finish.promise
      return { queryId: request.queryId, database: request.database, columns: ['id'], rows: [['PRIVATE_ROW']],
        rowCount: 1, durationMs: 1, truncated: false, warnings: [] }
    }
    const revokedQuery = execute('query-1', input).then(() => 'unexpected success', (error: unknown) => error instanceof Error ? error.message : 'unexpected error')
    await entered.promise
    policy = { revision: 1, exclusions: [{ sourceId: 'source-1', database: 'app', excludedTables: ['users'] }] }
    listeners.forEach((listener) => listener())
    expect(actualSignal?.aborted).toBe(true)
    finish.resolve()
    expect(await revokedQuery).toBe('SERVER_OPS_AGENT_ACCESS_CHANGED')
    expect(records.at(-1)).toMatchObject({ outcome: 'error', errorCode: 'SERVER_OPS_AGENT_ACCESS_CHANGED' })
    expect(JSON.stringify(records)).not.toMatch(/PRIVATE_LITERAL|PRIVATE_ROW|SELECT/)
    await expect(execute('query-2', input)).rejects.toThrow('SERVER_OPS_AGENT_ACCESS_CHANGED')
    expect(calls).toBe(1)

    /** 保存空禁用列表后开启新运行；SDK 的本轮取消必须传到新请求。 */
    policy = { revision: 2, exclusions: [] }
    entered = Promise.withResolvers<void>()
    finish = Promise.withResolvers<void>()
    const controller = new AbortController()
    const newFacade = createServerOpsAgentReadFacade({ sessionId: 'session-1', dependencies: deps })!
    const cancelledQuery = newFacade.databaseQuery(input, controller.signal).then(() => 'unexpected success', (error: unknown) => error instanceof Error ? error.message : 'unexpected error')
    await entered.promise
    controller.abort()
    expect(actualSignal?.aborted).toBe(true)
    finish.resolve()
    expect(await cancelledQuery).toBe('SERVER_OPS_SQL_CANCELLED')
    expect(records.at(-1)).toMatchObject({ outcome: 'error', errorCode: 'SERVER_OPS_SQL_CANCELLED' })
    expect(calls).toBe(2)
  })

  test('Given 持久禁用表和 Pi 读取工具 When 读取、越界或中途变更 Then 仅返回允许的数据并留下严格审计', async () => {
    /** 使用共享合同验证每条实际 Facade 审计，代替文件落盘且不接触用户配置。 */
    const records: ServerOpsAuditRecord[] = []
    /** 仅远程服务使用内存桩；授权、身份捕获、Facade 与工具适配均走真实实现。 */
    const deps = dependencies({ auditAppend: (input) => {
      /** 为开始和结果生成不同记录 ID，由业务 operationId 关联同次读取。 */
      const record = { id: `audit-${records.length + 1}`, timestamp: Date.now(), ...input }
      expect(isServerOpsAuditRecord(record)).toBe(true)
      records.push(record)
      return record
    } })
    /** 实际内存授权对象，验证工具不会缓存首次检查结果。 */
    const access = new ServerOpsAgentAccessStore()
    deps.services.access = access
    deps.captureBindings = (resources) => captureServerOpsReadBindings(resources, deps.services)
    /** 旧租约存在不影响数据库禁用规则；禁用 app.payments。 */
    const grant: ServerOpsAgentReadGrant = {
      sessionId: 'session-1', resources: [{
        kind: 'mysql', sourceId: 'source-1', instance: false,
        databases: [{ database: 'app', tables: ['users'], readRows: true }],
      }],
    }
    access.grantRead(grant, deps.captureBindings(grant.resources))
    let policy = { revision: 0, exclusions: [{ sourceId: 'source-1', database: 'app', excludedTables: ['payments'] }] }
    deps.services.databasePolicy = { get: () => policy }
    /** 普通会话通过真实 Facade 获取工具闭包，SDK 仅保留工具定义。 */
    const facade = createServerOpsAgentReadFacade({ sessionId: 'session-1', dependencies: deps })!
    const sdk = { defineTool: (definition: ToolDefinition) => definition } as typeof import('@earendil-works/pi-coding-agent')
    const tool = buildServerOpsReadTools(sdk, facade).find((entry) => entry.name === 'ops_database_rows')!
    /** 此工具不依赖 SDK 执行上下文，使用真实 execute 闭包验证输入与输出。 */
    const execute = tool.execute as unknown as (id: string, input: Record<string, unknown>) => Promise<{
      content: Array<{ type: string; text: string }>
    }>
    /** 所有请求走同一远程读取桩，调用次数可证明越权在服务前被阻止。 */
    const data = deps.services.data!
    const readRows = data.readSchemaRows
    let calls = 0
    data.readSchemaRows = async (input) => { calls += 1; return readRows(input) }
    /** 模拟 Agent 提交的完整、精确分页输入。 */
    const input = { sourceId: 'source-1', database: 'app', table: 'users', offset: 0, limit: 50 }
    const result = await execute('call-1', input)
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ rows: [['1', '[MASKED]']], maskedColumns: ['password_hash'] })
    expect(calls).toBe(1)
    expect(records.map((record) => record.phase)).toEqual(['start', 'result'])
    expect(records[1]).toMatchObject({ operationId: records[0]!.operationId, outcome: 'success', scope: 'database', database: 'app', table: 'users' })
    expect(JSON.stringify(records)).not.toContain('do-not-leak')

    await expect(execute('call-2', { ...input, table: 'payments' })).rejects.toThrow('SERVER_OPS_AGENT_SCOPE_REQUIRED')
    expect(calls).toBe(1)
    expect(records).toHaveLength(2)

    data.readSchemaRows = async (request) => {
      calls += 1
      policy = { revision: 1, exclusions: [...policy.exclusions] }
      return readRows(request)
    }
    await expect(execute('call-3', input)).rejects.toThrow('SERVER_OPS_AGENT_ACCESS_CHANGED')
    expect(calls).toBe(2)
    expect(records).toHaveLength(4)
    expect(records[3]).toMatchObject({ operationId: records[2]!.operationId, outcome: 'error', errorCode: 'SERVER_OPS_AGENT_ACCESS_CHANGED' })
    await expect(execute('call-4', input)).rejects.toThrow('SERVER_OPS_AGENT_ACCESS_CHANGED')
    expect(calls).toBe(2)
  })

  test('Given 内部会话或自动化来源 When 创建 Facade Then 不注册只读能力', () => {
    expect(createServerOpsAgentReadFacade({ sessionId: 'session-1', triggeredBy: 'automation', dependencies: dependencies() })).toBeNull()
    expect(createServerOpsAgentReadFacade({
      sessionId: 'session-1',
      dependencies: dependencies({ session: session({ sourceAutomationId: 'automation-1' }) }),
    })).toBeNull()
  })

  test('Given 多资源授权 When 查询目录 Then 数据库采用持久默认读并隐藏连接秘密', () => {
    const facade = createServerOpsAgentReadFacade({ sessionId: 'session-1', dependencies: dependencies() })!
    const result = facade.resources()
    expect(result.resources).toEqual([
      { kind: 'ssh', hostId: 'host-1', projectId: 'project-1', name: '生产机' },
      {
        kind: 'mysql', sourceId: 'source-1', projectId: 'project-1', name: '订单库', instance: false,
        databases: [{ database: 'app', tables: null, excludedTables: [], readRows: true, query: true }],
      },
    ])
    expect(JSON.stringify(result)).not.toMatch(/secret-ref|10\.0\.0\.|reader|hasPassword/)
  })

  test('Given 旧授权范围本身超过工具预算 When 查询目录 Then 不把旧表白名单扩充为持久目录', () => {
    const access: ServerOpsAgentReadAccess = {
      sessionId: 'session-1', revision: 9, grantedAt: 10, expiresAt: Date.now() + 1_800_000,
      resources: [{
        kind: 'mysql', sourceId: 'source-1', instance: false,
        databases: Array.from({ length: 20 }, (_, databaseIndex) => ({
          database: `database_${databaseIndex}_${'d'.repeat(40)}`,
          tables: Array.from({ length: 100 }, (_, tableIndex) => `table_${tableIndex}_${'t'.repeat(100)}`),
          readRows: false,
        })),
      }],
    }
    const facade = createServerOpsAgentReadFacade({ sessionId: 'session-1', dependencies: dependencies({ access }) })!
    const result = facade.resources()
    expect(result.resources).toHaveLength(1)
    expect(Buffer.byteLength(JSON.stringify(result, null, 2), 'utf8')).toBeLessThanOrEqual(32_768)
  })

  test('Given 旧会话排除名单导致目录超限 When 查询目录 Then 不把旧范围当作持久禁用规则', () => {
    /** 大量结构标识逼近模型输出预算；授权事实仍应保持完整。 */
    const excludedTables = Array.from({ length: 100 }, (_, index) => `private_${index}_${'x'.repeat(110)}`)
    const access: ServerOpsAgentReadAccess = {
      sessionId: 'session-1', revision: 9, grantedAt: 10, expiresAt: Date.now() + 1_800_000,
      resources: [{ kind: 'mysql', sourceId: 'source-1', instance: false,
        databases: Array.from({ length: 4 }, (_, index) => ({ database: `database_${index}`,
          tables: null, excludedTables, readRows: false })) }],
    }
    const facade = createServerOpsAgentReadFacade({ sessionId: 'session-1', dependencies: dependencies({ access }) })!
    const result = facade.resources()
    expect(result.resources).toHaveLength(1)
    expect(Buffer.byteLength(JSON.stringify(result, null, 2), 'utf8')).toBeLessThanOrEqual(32_768)
    for (const resource of result.resources) {
      if (resource.kind === 'mysql') for (const scope of resource.databases) expect(scope.excludedTables).toEqual([])
    }
  })

  test('Given 持久禁用表 When 列目录和读取行 Then 过滤目录并遮罩敏感列', async () => {
    const deps = dependencies()
    deps.services.databasePolicy!.get = () => ({ revision: 1, exclusions: [{ sourceId: 'source-1', database: 'app', excludedTables: ['payments'] }] })
    const facade = createServerOpsAgentReadFacade({ sessionId: 'session-1', dependencies: deps })!
    await expect(facade.databaseTables({ sourceId: 'source-1', database: 'app' })).resolves.toEqual({
      database: 'app', databases: ['app', 'secret'], tables: [{ name: 'users', type: 'table' }],
    })
    await expect(facade.databaseRows({ sourceId: 'source-1', database: 'app', table: 'users', offset: 0, limit: 50 })).resolves.toMatchObject({
      columns: ['id', 'password_hash'], rows: [['1', '[MASKED]']], maskedColumns: ['password_hash'], hasMore: false,
    })
    await expect(facade.databaseRows({ sourceId: 'source-1', database: 'app', table: 'payments', offset: 0, limit: 50 })).rejects.toThrow('SERVER_OPS_AGENT_SCOPE_REQUIRED')
    await expect(facade.databaseRows({ sourceId: 'source-1', database: 'app', table: 'users', offset: 0, limit: 51 })).rejects.toThrow('SERVER_OPS_AGENT_READ_INPUT_INVALID')
  })

  test('Given 库表排除名单 When 查询目录结构行和联表 SQL Then 大小写变化也不能访问屏蔽表', async () => {
    const access: ServerOpsAgentReadAccess = {
      sessionId: 'session-1', revision: 7, grantedAt: 10, expiresAt: Date.now() + 1_800_000,
      resources: [{ kind: 'mysql', sourceId: 'source-1', instance: false,
        databases: [{ database: 'app', tables: null, excludedTables: ['Payments'], readRows: true, query: true }] }],
    }
    const deps = dependencies({ access })
    /** 记录真正到达数据库的 SQL，证明权限检查早于底层请求。 */
    let queries = 0
    deps.services.data!.querySource = async (request) => {
      queries += 1
      return { queryId: request.queryId, database: request.database, columns: ['id'], rows: [['1']],
        rowCount: 1, durationMs: 1, truncated: false, warnings: [] }
    }
    const facade = createServerOpsAgentReadFacade({ sessionId: 'session-1', dependencies: deps })!
    expect((await facade.databaseTables({ sourceId: 'source-1', database: 'app' })).tables).toEqual([{ name: 'users', type: 'table' }])
    await expect(facade.databaseDescribe({ sourceId: 'source-1', database: 'app', table: 'payments' })).rejects.toThrow('SERVER_OPS_AGENT_SCOPE_REQUIRED')
    await expect(facade.databaseRows({ sourceId: 'source-1', database: 'app', table: 'PAYMENTS', offset: 0, limit: 50 })).rejects.toThrow('SERVER_OPS_AGENT_SCOPE_REQUIRED')
    await expect(facade.databaseQuery({ sourceId: 'source-1', database: 'app', sql: 'SELECT users.id FROM users JOIN payments ON users.id = payments.id', maxRows: 10 }))
      .rejects.toThrow('SERVER_OPS_AGENT_SCOPE_REQUIRED')
    expect(queries).toBe(0)
    await expect(facade.databaseQuery({ sourceId: 'source-1', database: 'app', sql: 'SELECT id FROM users', maxRows: 10 })).resolves.toMatchObject({ rowCount: 1 })
    expect(queries).toBe(1)
  })

  test('Given 排除表同时存在实例权限 When 诊断 Then 整库与实例汇总都拒绝但连接测试仍可用', async () => {
    const access: ServerOpsAgentReadAccess = {
      sessionId: 'session-1', revision: 7, grantedAt: 10, expiresAt: Date.now() + 1_800_000,
      resources: [{ kind: 'mysql', sourceId: 'source-1', instance: true,
        databases: [{ database: 'app', tables: null, excludedTables: ['payments'], readRows: true }] }],
    }
    const facade = createServerOpsAgentReadFacade({ sessionId: 'session-1', dependencies: dependencies({ access }) })!
    await expect(facade.dataDiagnose({ sourceId: 'source-1', scope: 'database', database: 'app', section: 'statements' }))
      .rejects.toThrow('SERVER_OPS_AGENT_SCOPE_REQUIRED')
    await expect(facade.dataDiagnose({ sourceId: 'source-1', scope: 'instance', section: 'statements' }))
      .rejects.toThrow('SERVER_OPS_AGENT_SCOPE_REQUIRED')
    await expect(facade.dataProbe({ sourceId: 'source-1' })).resolves.toMatchObject({ capability: 'available' })
  })

  test('Given 数据库无禁用表 When 运行诊断 Then 显式库诊断不带 SQL 正文且拒绝缺省扩大', async () => {
    const facade = createServerOpsAgentReadFacade({ sessionId: 'session-1', dependencies: dependencies() })!
    const result = await facade.dataDiagnose({ sourceId: 'source-1', scope: 'database', database: 'app', section: 'statements' })
    expect(JSON.stringify(result)).not.toMatch(/SELECT|secret|password/)
    await expect(facade.dataDiagnose({ sourceId: 'source-1', scope: 'instance', section: 'parameters' })).rejects.toThrow('SERVER_OPS_AGENT_SCOPE_REQUIRED')
    await expect(facade.dataDiagnose({ sourceId: 'source-1', scope: 'instance', section: 'overview' })).rejects.toThrow('SERVER_OPS_AGENT_SCOPE_REQUIRED')
    await expect(facade.dataDiagnose({ sourceId: 'source-1', scope: 'instance', section: 'statements' })).rejects.toThrow('SERVER_OPS_AGENT_SCOPE_REQUIRED')
    await expect(facade.dataDiagnose({ sourceId: 'source-1', scope: 'database', section: 'overview' } as never)).rejects.toThrow('SERVER_OPS_AGENT_READ_INPUT_INVALID')
  })

  test('Given 仅授权 Redis 数据源 When 测试连接 Then 不会先按 MySQL 权限拒绝', async () => {
    const access: ServerOpsAgentReadAccess = {
      sessionId: 'session-1', revision: 8, grantedAt: 10, expiresAt: Date.now() + 1_800_000,
      resources: [{ kind: 'redis', sourceId: 'source-1' }],
    }
    const deps = dependencies({ access })
    deps.services.data!.listSources = () => ({ sources: [source({ engine: 'redis', port: 6379, database: '0' })] })
    deps.services.data!.probeSource = async (input) => {
      if (!('sourceId' in input)) throw new Error('unexpected draft')
      return { sourceId: input.sourceId, engine: 'redis', capability: 'available', serverVersion: '7.2', latencyMs: 4, warnings: [] }
    }
    const facade = createServerOpsAgentReadFacade({ sessionId: 'session-1', dependencies: deps })!
    await expect(facade.dataProbe({ sourceId: 'source-1' })).resolves.toMatchObject({
      sourceId: 'source-1', engine: 'redis', capability: 'available',
    })
  })

  test('Given 审计准备失败 When 读取服务器 Then 不调用真实服务', async () => {
    let calls = 0
    const deps = dependencies({ prepareAudit: async () => { throw new Error('disk') } })
    deps.services.overview.getOverview = async () => { calls += 1; throw new Error('unexpected') }
    const facade = createServerOpsAgentReadFacade({ sessionId: 'session-1', dependencies: deps })!
    await expect(facade.serverOverview({ hostId: 'host-1' })).rejects.toThrow('SERVER_OPS_AUDIT_START_WRITE_FAILED')
    expect(calls).toBe(0)
  })

  test('Given 读取期间撤销或重新授权 When 迟到结果返回 Then 不发布旧数据', async () => {
    const deps = dependencies()
    let current = deps.services.access.getReadAccess('session-1')
    deps.services.access.getReadAccess = () => current
    deps.services.overview.getOverview = async ({ hostId }) => {
      current = current ? { ...current, revision: current.revision + 1 } : undefined
      return { hostId, capturedAt: 1, sampleWindowMs: 1, filesystems: [], processes: [], warnings: [] }
    }
    const facade = createServerOpsAgentReadFacade({ sessionId: 'session-1', dependencies: deps })!
    await expect(facade.serverOverview({ hostId: 'host-1' })).rejects.toThrow('SERVER_OPS_AGENT_ACCESS_CHANGED')
  })

  test('Given 配置身份改变 When 读取 Then 失效资源且不调用服务', async () => {
    const deps = dependencies()
    let captureCount = 0
    deps.captureBindings = (resources) => resources.map((resource) => ({
      key: resource.kind === 'ssh' ? `ssh:${resource.hostId}` : `data:${resource.sourceId}`,
      fingerprint: captureCount++ === 0 ? 'host-fingerprint' : 'changed',
      ...(resource.kind === 'ssh' ? { hostId: resource.hostId } : {}),
    }))
    let calls = 0
    deps.services.overview.getOverview = async () => { calls += 1; throw new Error('unexpected') }
    const facade = createServerOpsAgentReadFacade({ sessionId: 'session-1', dependencies: deps })!
    await expect(facade.serverOverview({ hostId: 'host-1' })).rejects.toThrow('SERVER_OPS_AGENT_RESOURCE_CHANGED')
    expect(calls).toBe(0)
  })

  test('Given 结果审计写入失败 When 读取成功 Then 返回固定 warning 且不泄漏原始错误', async () => {
    let auditCount = 0
    const deps = dependencies({ auditAppend: (input) => {
      auditCount += 1
      if (input.phase === 'result') throw new Error('private path')
    } })
    const facade = createServerOpsAgentReadFacade({ sessionId: 'session-1', dependencies: deps })!
    await expect(facade.dataProbe({ sourceId: 'source-1' })).resolves.toMatchObject({
      sourceId: 'source-1', warnings: ['SERVER_OPS_AUDIT_RESULT_WRITE_FAILED'],
    })
    expect(auditCount).toBe(2)
  })

  test('Given 数据服务失败且结果审计也失败 When 返回错误 Then 仅暴露稳定码和固定 warning', async () => {
    const deps = dependencies({ auditAppend: (input) => {
      if (input.phase === 'result') throw new Error('/private/audit/path')
    } })
    deps.services.data!.probeSource = async () => { throw new Error('Access denied for password super-secret') }
    const facade = createServerOpsAgentReadFacade({ sessionId: 'session-1', dependencies: deps })!
    try {
      await facade.dataProbe({ sourceId: 'source-1' })
      throw new Error('expected rejection')
    } catch (error) {
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toBe('SERVER_OPS_AGENT_READ_FAILED')
      expect((error as Error & { warnings?: string[] }).warnings).toEqual(['SERVER_OPS_AUDIT_RESULT_WRITE_FAILED'])
      expect(JSON.stringify(error)).not.toMatch(/super-secret|private\/audit/)
    }
  })

  test('Given 结果审计写入时撤权 When 即将返回 Then 最后一次复核阻止发布结果', async () => {
    const deps = dependencies()
    let current = deps.services.access.getReadAccess('session-1')
    deps.services.access.getReadAccess = () => current
    deps.services.audit.append = (input) => {
      if (input.phase === 'result') current = undefined
      return { id: 'audit-1', timestamp: 1, ...input }
    }
    const facade = createServerOpsAgentReadFacade({ sessionId: 'session-1', dependencies: deps })!
    await expect(facade.serverOverview({ hostId: 'host-1' })).rejects.toThrow('SERVER_OPS_AGENT_ACCESS_CHANGED')
  })

  test('Given 服务返回污染字段或错目标 When Facade 投影 Then 拒绝而不复制未知字段', async () => {
    const deps = dependencies()
    deps.services.overview.getOverview = async () => ({
      hostId: 'host-other', capturedAt: 1, sampleWindowMs: 1, filesystems: [], processes: [], warnings: [],
      password: 'leak',
    } as never)
    const facade = createServerOpsAgentReadFacade({ sessionId: 'session-1', dependencies: deps })!
    await expect(facade.serverOverview({ hostId: 'host-1' })).rejects.toThrow('SERVER_OPS_AGENT_READ_RESULT_INVALID')
  })

  test('Given 敏感列结构含默认值 When 读取结构 Then 默认值与注释同样遮罩', async () => {
    const facade = createServerOpsAgentReadFacade({ sessionId: 'session-1', dependencies: dependencies() })!
    const result = await facade.databaseDescribe({ sourceId: 'source-1', database: 'app', table: 'users' })
    expect(result.columns[1]).toMatchObject({ name: 'password_hash', defaultText: '[MASKED]', comment: '[MASKED]' })
  })

  test('Given 单页行值超过预算 When Facade 裁剪 Then 提供不跳行的下一偏移和安全页大小', async () => {
    const deps = dependencies()
    deps.services.data!.readSchemaRows = async ({ offset, limit }) => ({
      columns: ['id', ...Array.from({ length: 20 }, (_, index) => `payload_${index}`)],
      rows: Array.from({ length: limit }, (_, index) => [
        `${offset + index}`,
        ...Array.from({ length: 20 }, () => 'x'.repeat(256)),
      ]),
      offset, limit, truncated: false, hasMore: false, orderedByPrimaryKey: true,
    })
    const facade = createServerOpsAgentReadFacade({ sessionId: 'session-1', dependencies: deps })!
    const result = await facade.databaseRows({ sourceId: 'source-1', database: 'app', table: 'users', offset: 0, limit: 50 })
    expect(Buffer.byteLength(JSON.stringify(result, null, 2), 'utf8')).toBeLessThanOrEqual(32_768)
    expect(result.truncated).toBe(true)
    expect(result.hasMore).toBe(true)
    expect(result.continuation).toEqual({ nextOffset: result.rows.length, recommendedLimit: 1 })
  })

  test('Given 最终漂亮 JSON 超过 32 KiB When 返回服务清单 Then 显式截断并保持可序列化', async () => {
    const deps = dependencies()
    deps.services.systemd.listServices = async ({ hostId }) => ({
      hostId, capability: 'available', warnings: [],
      services: Array.from({ length: 1_000 }, (_, index) => ({
        unitId: `service-${index}.service`, description: 'x'.repeat(80), loadState: 'loaded',
        activeState: 'active', subState: 'running', enabled: true,
      })),
    })
    const facade = createServerOpsAgentReadFacade({ sessionId: 'session-1', dependencies: deps })!
    const result = await facade.serverServices({ hostId: 'host-1' })
    expect(Buffer.byteLength(JSON.stringify(result, null, 2), 'utf8')).toBeLessThanOrEqual(32_768)
    expect(result.truncated).toBe(true)
    expect(result.services.length).toBeLessThan(1_000)
  })
  test('Given 已授权 SSH When 服务发现 Then 仅返回有限摘要和明确部分结果', async () => {
    const deps = dependencies()
    deps.services.systemd.listServices = async ({ hostId }) => ({ hostId, capability: 'available', warnings: [], services: [{
      unitId: 'mysql.service', description: 'MySQL', activeState: 'active', loadState: 'loaded', subState: 'running', enabled: true,
    }] })
    const facade = createServerOpsAgentReadFacade({ sessionId: 'session-1', dependencies: deps })!
    const result = await facade.serverDiscover({ hostId: 'host-1' })
    expect(result).toMatchObject({ systemd: { capability: 'available', services: [{ unitId: 'mysql.service' }] }, docker: { capability: 'unavailable' }, partial: true })
    expect(JSON.stringify(result)).not.toContain('loadState')
  })

  test('Given Docker 发布端口 When 发现服务 Then 有界展示绑定且不返回挂载或环境变量', async () => {
    const deps = dependencies()
    deps.services.docker = { listContainers: async ({ hostId }) => ({ hostId, capability: 'available', containers: [{
      containerId: 'a'.repeat(64), names: ['db'], image: 'mysql:8', state: 'running', status: 'up', createdAt: 'now',
      publishedPorts: ['127.0.0.1:3306->3306/tcp'], mountNames: ['secret-volume'],
    }] }) }
    const facade = createServerOpsAgentReadFacade({ sessionId: 'session-1', dependencies: deps })!
    const result = await facade.serverDiscover({ hostId: 'host-1' })
    expect(result.docker.containers[0]).toMatchObject({ name: 'db', publishedPorts: ['127.0.0.1:3306->3306/tcp'] })
    expect(JSON.stringify(result)).not.toContain('secret-volume')
  })

  test('Given 旧 SSH 授权 When 要求日志 Then 不调用日志服务；新授权可调用并审计', async () => {
    const deps = dependencies()
    let reads = 0
    const actions: string[] = []
    deps.services.logs = { snapshot: async ({ hostId }) => { reads++; return { hostId, lines: ['[MASKED]'], truncated: false, warnings: [] } } }
    deps.services.audit.append = (entry) => { actions.push(entry.readAction ?? ''); return { id: 'audit-1', timestamp: 1, ...entry } }
    const old = createServerOpsAgentReadFacade({ sessionId: 'session-1', dependencies: deps })!
    const request = { hostId: 'host-1', source: { kind: 'system' } as const, since: '15m' as const, priority: 'warning' as const, tailLines: 20 }
    await expect(old.serverLogs(request)).rejects.toThrow('SERVER_OPS_AGENT_SCOPE_REQUIRED')
    expect(reads).toBe(0)
    const current = deps.services.access.getReadAccess('session-1')!
    deps.services.access.getReadAccess = () => ({ ...current, revision: 8, resources: current.resources.map((resource) => resource.kind === 'ssh' ? { ...resource, readLogs: true } : resource) })
    const fresh = createServerOpsAgentReadFacade({ sessionId: 'session-1', dependencies: deps })!
    expect((await fresh.serverLogs(request)).lines).toEqual(['[MASKED]'])
    expect(actions).toEqual(['server-logs', 'server-logs'])
    await expect(old.serverLogs(request)).rejects.toThrow('SERVER_OPS_AGENT_ACCESS_CHANGED')
  })

  test('Given 注入的日志来源 When 解析输入 Then 在远程调用前拒绝', async () => {
    const deps = dependencies()
    deps.services.access.getReadAccess = () => ({ ...dependencies().services.access.getReadAccess('session-1')!, resources: [{ kind: 'ssh', hostId: 'host-1', readLogs: true }] })
    const facade = createServerOpsAgentReadFacade({ sessionId: 'session-1', dependencies: deps })!
    await expect(facade.serverLogs({ hostId: 'host-1', source: { kind: 'unit', unitId: "ssh.service'; echo leak" }, since: '1h', priority: 'info', tailLines: 20 })).rejects.toThrow('SERVER_OPS_AGENT_READ_INPUT_INVALID')
  })
  test('Given 日志在途 When 取消、撤权或重授 Then 不返回旧日志', async () => {
    const deps = dependencies()
    let access = { ...deps.services.access.getReadAccess('session-1')!, resources: [{ kind: 'ssh' as const, hostId: 'host-1', readLogs: true }] }
    deps.services.access.getReadAccess = () => access
    const entered = Promise.withResolvers<void>()
    const gate = Promise.withResolvers<void>()
    deps.services.logs = { snapshot: async ({ hostId }) => { entered.resolve(); await gate.promise; return { hostId, lines: ['private'], truncated: false, warnings: [] } } }
    const facade = createServerOpsAgentReadFacade({ sessionId: 'session-1', dependencies: deps })!
    const request = { hostId: 'host-1', source: { kind: 'system' } as const, since: '15m' as const, priority: 'info' as const, tailLines: 10 }
    const result = facade.serverLogs(request)
    await entered.promise
    access = { ...access, revision: 8 }
    gate.resolve()
    await expect(result).rejects.toThrow('SERVER_OPS_AGENT_ACCESS_CHANGED')
  })
})
