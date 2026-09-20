import { describe, expect, test } from 'bun:test'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { isServerOpsAuditRecord } from '@proma/shared'
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
    sessionId: 'session-1', revision: 7, grantedAt: 10,
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
      hosts: { get: (hostId) => hostId === 'host-1' ? host() : undefined },
      access: {
        getReadCurrent: () => access,
        getReadBinding: (key) => bindings.get(key),
      },
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
  test('Given SQL 独立权限 When 查询授权表 Then 旧行权限不升级，JOIN 全表必须授权', async () => {
    /** 实际 Facade 服务调用计数，证明越界在数据库执行前被阻断。 */
    const deps = dependencies()
    let calls = 0
    deps.services.data!.querySource = async (input) => {
      calls += 1
      return { queryId: input.queryId, database: input.database, columns: ['id'], rows: [['1']], rowCount: 1, durationMs: 1, truncated: false, warnings: [] }
    }
    const facade = createServerOpsAgentReadFacade({ sessionId: 'session-1', dependencies: deps })!
    const input = { sourceId: 'source-1', database: 'app', sql: 'SELECT id FROM users', maxRows: 50 }
    await expect(facade.databaseQuery(input)).rejects.toThrow('SERVER_OPS_AGENT_SCOPE_REQUIRED')
    expect(calls).toBe(0)
    /** 测试桩保持同一授权对象，显式模拟用户启用新查询开关。 */
    const access = deps.services.access.getReadCurrent()!
    const mysql = access.resources.find((resource) => resource.kind === 'mysql')!
    if (mysql.kind !== 'mysql') throw new Error('expected mysql')
    mysql.databases[0]!.query = true
    await expect(facade.databaseQuery(input)).resolves.toMatchObject({ rows: [['1']] })
    await expect(facade.databaseQuery({ ...input, sql: 'SELECT u.id FROM users u JOIN payments p ON u.id = p.user_id' })).rejects.toThrow('SERVER_OPS_AGENT_SCOPE_REQUIRED')
    await expect(facade.databaseQuery({ ...input, maxRows: 51 })).rejects.toThrow()
    expect(calls).toBe(1)
  })

  test('Given 真实授权与 SQL 工具 When 执行中撤权或取消 Then 真实信号终止且迟到行不返回', async () => {
    /** 授权、工具与审计均走正式实现，仅数据库查询由内存桩替代。 */
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
    access.revokeSession('session-1')
    expect(actualSignal?.aborted).toBe(true)
    finish.resolve()
    expect(await revokedQuery).toBe('SERVER_OPS_AGENT_ACCESS_CHANGED')
    expect(records.at(-1)).toMatchObject({ outcome: 'error', errorCode: 'SERVER_OPS_AGENT_ACCESS_CHANGED' })
    expect(JSON.stringify(records)).not.toMatch(/PRIVATE_LITERAL|PRIVATE_ROW|SELECT/)
    await expect(execute('query-2', input)).rejects.toThrow('SERVER_OPS_AGENT_ACCESS_REQUIRED')
    expect(calls).toBe(1)

    /** 重新授权不复用旧运行；SDK 的本轮取消必须传到新请求。 */
    access.grantRead(grant, deps.captureBindings(grant.resources))
    entered = Promise.withResolvers<void>()
    finish = Promise.withResolvers<void>()
    const controller = new AbortController()
    const cancelledQuery = execute('query-3', input, controller.signal).then(() => 'unexpected success', (error: unknown) => error instanceof Error ? error.message : 'unexpected error')
    await entered.promise
    controller.abort()
    expect(actualSignal?.aborted).toBe(true)
    finish.resolve()
    expect(await cancelledQuery).toBe('SERVER_OPS_SQL_CANCELLED')
    expect(records.at(-1)).toMatchObject({ outcome: 'error', errorCode: 'SERVER_OPS_SQL_CANCELLED' })
    expect(calls).toBe(2)
  })

  test('Given 真实授权 Store 和 Pi 读取工具 When 读取白名单表、越界或中途撤权 Then 仅返回有效授权的数据并留下严格审计', async () => {
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
    /** 用户只授权 app.users 的结构与行，不包含同库其它表或实例诊断。 */
    const grant: ServerOpsAgentReadGrant = {
      sessionId: 'session-1', resources: [{
        kind: 'mysql', sourceId: 'source-1', instance: false,
        databases: [{ database: 'app', tables: ['users'], readRows: true }],
      }],
    }
    access.grantRead(grant, deps.captureBindings(grant.resources))
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
      access.revokeSession('session-1')
      return readRows(request)
    }
    await expect(execute('call-3', input)).rejects.toThrow('SERVER_OPS_AGENT_ACCESS_CHANGED')
    expect(calls).toBe(2)
    expect(records).toHaveLength(4)
    expect(records[3]).toMatchObject({ operationId: records[2]!.operationId, outcome: 'error', errorCode: 'SERVER_OPS_AGENT_ACCESS_CHANGED' })
    await expect(execute('call-4', input)).rejects.toThrow('SERVER_OPS_AGENT_ACCESS_REQUIRED')
    expect(calls).toBe(2)
  })

  test('Given 内部会话或自动化来源 When 创建 Facade Then 不注册只读能力', () => {
    expect(createServerOpsAgentReadFacade({ sessionId: 'session-1', triggeredBy: 'automation', dependencies: dependencies() })).toBeNull()
    expect(createServerOpsAgentReadFacade({
      sessionId: 'session-1',
      dependencies: dependencies({ session: session({ sourceAutomationId: 'automation-1' }) }),
    })).toBeNull()
  })

  test('Given 多资源授权 When 查询目录 Then 只返回非秘密名称、项目和显式范围', () => {
    const facade = createServerOpsAgentReadFacade({ sessionId: 'session-1', dependencies: dependencies() })!
    const result = facade.resources()
    expect(result.resources).toEqual([
      { kind: 'ssh', hostId: 'host-1', projectId: 'project-1', name: '生产机' },
      {
        kind: 'mysql', sourceId: 'source-1', projectId: 'project-1', name: '订单库', instance: true,
        databases: [{ database: 'app', tables: ['users'], readRows: true }],
      },
    ])
    expect(JSON.stringify(result)).not.toMatch(/secret-ref|10\.0\.0\.|reader|hasPassword/)
  })

  test('Given 授权范围本身超过工具预算 When 查询目录 Then 显式截断且最终 JSON 不超限', () => {
    const access: ServerOpsAgentReadAccess = {
      sessionId: 'session-1', revision: 9, grantedAt: 10,
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
    expect(result.truncated).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(result, null, 2), 'utf8')).toBeLessThanOrEqual(32_768)
  })

  test('Given 数据库只授权指定库表 When 列目录和读取行 Then 过滤目录并遮罩敏感列', async () => {
    const facade = createServerOpsAgentReadFacade({ sessionId: 'session-1', dependencies: dependencies() })!
    await expect(facade.databaseTables({ sourceId: 'source-1', database: 'app' })).resolves.toEqual({
      database: 'app', databases: ['app'], tables: [{ name: 'users', type: 'table' }],
    })
    await expect(facade.databaseRows({ sourceId: 'source-1', database: 'app', table: 'users', offset: 0, limit: 50 })).resolves.toMatchObject({
      columns: ['id', 'password_hash'], rows: [['1', '[MASKED]']], maskedColumns: ['password_hash'], hasMore: false,
    })
    await expect(facade.databaseRows({ sourceId: 'source-1', database: 'app', table: 'payments', offset: 0, limit: 50 })).rejects.toThrow('SERVER_OPS_AGENT_SCOPE_REQUIRED')
    await expect(facade.databaseRows({ sourceId: 'source-1', database: 'app', table: 'users', offset: 0, limit: 51 })).rejects.toThrow('SERVER_OPS_AGENT_READ_INPUT_INVALID')
  })

  test('Given 实例与数据库范围分离 When 运行诊断 Then 不允许缺省扩大且删除 SQL 正文', async () => {
    const facade = createServerOpsAgentReadFacade({ sessionId: 'session-1', dependencies: dependencies() })!
    await expect(facade.dataDiagnose({ sourceId: 'source-1', scope: 'database', database: 'app', section: 'statements' })).rejects.toThrow('SERVER_OPS_AGENT_SCOPE_REQUIRED')
    const result = await facade.dataDiagnose({ sourceId: 'source-1', scope: 'instance', section: 'statements' })
    expect(JSON.stringify(result)).not.toMatch(/SELECT|secret|password/)
    await expect(facade.dataDiagnose({ sourceId: 'source-1', scope: 'database', section: 'overview' } as never)).rejects.toThrow('SERVER_OPS_AGENT_READ_INPUT_INVALID')
  })

  test('Given 仅授权 Redis 数据源 When 测试连接 Then 不会先按 MySQL 权限拒绝', async () => {
    const access: ServerOpsAgentReadAccess = {
      sessionId: 'session-1', revision: 8, grantedAt: 10,
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
    let current = deps.services.access.getReadCurrent()
    deps.services.access.getReadCurrent = () => current
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
    let current = deps.services.access.getReadCurrent()
    deps.services.access.getReadCurrent = () => current
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
})
