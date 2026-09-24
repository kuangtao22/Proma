import { describe, expect, test } from 'bun:test'
import { isServerOpsAgentTableAllowed, parseServerOpsAgentReadAccess, parseServerOpsAgentReadGrant } from './server-ops-agent-read'
import type { ServerOpsAgentReadGrant, ServerOpsAgentReadResource } from './server-ops-agent-read'

describe('运维只读授权合同', () => {
  test('Given PostgreSQL 大小写不同 canonical 表 When 保存排除项 Then 精确保留且分别匹配', () => {
    const resource: ServerOpsAgentReadResource = { kind: 'postgresql', sourceId: 'pg-1', instance: false, databases: [{
      database: 'postgres', tables: null, excludedTables: ['"public"."Users"'], readRows: true,
    }] }
    const parsed = parseServerOpsAgentReadGrant({ sessionId: 'session-1', resources: [resource] })
    expect(parsed.resources[0]).toEqual(resource)
    expect(isServerOpsAgentTableAllowed('postgresql', resource.databases[0]!, '"public"."Users"')).toBe(false)
    expect(isServerOpsAgentTableAllowed('postgresql', resource.databases[0]!, '"public"."users"')).toBe(true)
    expect(() => parseServerOpsAgentReadGrant({ sessionId: 'session-1', resources: [{
      ...resource, databases: [{ ...resource.databases[0], excludedTables: ['public.users'] }],
    }] })).toThrow('SERVER_OPS_READ_ACCESS_INVALID')
  })
  test('Given 旧行权限或显式 SQL 权限 When 解析 Then 不自动升级且 SQL 必须同时允许行读取', () => {
    /** 查询开关与旧行权限独立，省略时不能获得新能力。 */
    const base = { database: 'app', tables: ['orders'], readRows: true }
    /** 使用完整会话授权验证新增可选字段，不绕过实际公开 parser。 */
    const input = (scope: object) => ({ sessionId: 'session-1', resources: [{ kind: 'mysql', sourceId: 'db-1', instance: false, databases: [scope] }] })
    expect(JSON.stringify(parseServerOpsAgentReadGrant(input(base)))).toBe(JSON.stringify(input(base)))
    expect(JSON.stringify(parseServerOpsAgentReadGrant(input({ ...base, query: true })))).toBe(JSON.stringify(input({ ...base, query: true })))
    expect(() => parseServerOpsAgentReadGrant(input({ ...base, query: true, readRows: false }))).toThrow()
    expect(() => parseServerOpsAgentReadGrant(input({ ...base, query: 'true' }))).toThrow()
  })
  /** 带独立实例权限和精确表范围的正常输入。 */
  const grant: ServerOpsAgentReadGrant = { sessionId: 'session-1', resources: [{ kind: 'mysql', sourceId: 'db-1', instance: false, databases: [{ database: 'app', tables: ['orders'], readRows: false }] }] }
  test('Given 明确资源与库表范围 When 解析 Then 保留范围并深复制', () => {
    const parsed = parseServerOpsAgentReadGrant(grant)
    expect(parsed).toEqual(grant)
    expect(parsed.resources).not.toBe(grant.resources)
    expect(parseServerOpsAgentReadAccess({ ...grant, revision: 1, grantedAt: 1, expiresAt: 1_800_001 })).toEqual({ ...grant, revision: 1, grantedAt: 1, expiresAt: 1_800_001 })
    expect(parseServerOpsAgentReadAccess(null)).toBeNull()
    expect(() => parseServerOpsAgentReadAccess({ ...grant, revision: 1, grantedAt: 1 })).toThrow('SERVER_OPS_READ_ACCESS_INVALID')
    expect(() => parseServerOpsAgentReadAccess({ ...grant, revision: 1, grantedAt: 1, expiresAt: 1 })).toThrow('SERVER_OPS_READ_ACCESS_INVALID')
  })
  test('Given 未知字段、重复资源、空表授权或非布尔权限 Then 拒绝', () => {
    for (const input of [
      { ...grant, password: 'not-allowed' },
      { ...grant, resources: [...grant.resources, ...grant.resources] },
      { ...grant, resources: [{ kind: 'mysql', sourceId: 'db-1', instance: false, databases: [] }] },
      { ...grant, resources: [{ kind: 'mysql', sourceId: 'db-1', instance: false, databases: [{ database: 'app', tables: [], readRows: false }] }] },
      { ...grant, resources: [{ kind: 'mysql', sourceId: 'db-1', instance: 'yes', databases: [] }] },
      { ...grant, resources: Array.from({ length: 33 }, (_, index) => ({ kind: 'ssh', hostId: `host-${index}` })) },
    ]) expect(() => parseServerOpsAgentReadGrant(input)).toThrow('SERVER_OPS_READ_ACCESS_INVALID')
  })
  test('Given 空集合 Then 表示撤销；全部表须显式 null', () => {
    expect(parseServerOpsAgentReadGrant({ sessionId: 'session-1', resources: [] }).resources).toEqual([])
    expect(() => parseServerOpsAgentReadGrant({ ...grant, resources: [{ kind: 'mysql', sourceId: 'db-1', instance: false, databases: [{ database: 'app', readRows: true }] }] })).toThrow()
  })
  test('Given 全表授权含排除表 When 解析和匹配 Then 忽略大小写拒绝排除表且保留其它表', () => {
    const input: ServerOpsAgentReadGrant = { sessionId: 'session-1', resources: [{ kind: 'mysql', sourceId: 'db-1', instance: false,
      databases: [{ database: 'app', tables: null, excludedTables: ['Private_Data'], readRows: true, query: true }] }] }
    const parsed = parseServerOpsAgentReadGrant(input)
    expect(parsed).toEqual(input)
    const resource = parsed.resources[0]
    if (!resource || resource.kind !== 'mysql') throw new Error('无效测试授权')
    const scope = resource.databases[0]!
    expect(isServerOpsAgentTableAllowed('mysql', scope, 'private_data')).toBe(false)
    expect(isServerOpsAgentTableAllowed('mysql', scope, 'PUBLIC_DATA')).toBe(true)
    expect(isServerOpsAgentTableAllowed('mysql', { database: 'app', tables: ['Users'], readRows: true }, 'users')).toBe(false)
    expect(isServerOpsAgentTableAllowed('mysql', {
      database: 'app', tables: null, excludedTables: ['"public"."Users"'], readRows: true,
    }, '"public"."users"')).toBe(false)
    expect(parseServerOpsAgentReadGrant({ ...input, resources: [{ ...input.resources[0],
      databases: [{ database: 'app', tables: null, excludedTables: [], readRows: false }] }] }).resources[0]).toMatchObject({
      databases: [{ excludedTables: [] }],
    })
  })
  test('Given 旧白名单或不合法排除列表 When 解析 Then 拒绝隐式扩大范围', () => {
    const scope = { database: 'app', tables: null, readRows: true }
    /** 使用完整授权合同触发同一解析路径。 */
    const input = (candidate: object) => ({ sessionId: 'session-1', resources: [{ kind: 'mysql', sourceId: 'db-1', instance: false, databases: [candidate] }] })
    for (const invalid of [
      { ...scope, tables: ['users'], excludedTables: ['private'] },
      { ...scope, excludedTables: 'private' },
      { ...scope, excludedTables: Array.from({ length: 101 }, (_, index) => `table_${index}`) },
      { ...scope, excludedTables: ['Private', 'private'] },
      { ...scope, excludedTables: ['bad\nname'] },
      { ...scope, excludedTables: [], password: 'secret' },
    ]) expect(() => parseServerOpsAgentReadGrant(input(invalid))).toThrow('SERVER_OPS_READ_ACCESS_INVALID')
  })
  test('Given 分层数量合法但总字节过大 Then 拒绝，避免复制广播放大', () => {
    const resources = Array.from({ length: 20 }, (_, index) => ({ kind: 'mysql', sourceId: `db-${index}`, instance: false,
      databases: [{ database: 'app', tables: Array.from({ length: 30 }, (_, table) => `${table}-${'名'.repeat(120)}`), readRows: false }] }))
    expect(() => parseServerOpsAgentReadGrant({ sessionId: 'session-1', resources })).toThrow('SERVER_OPS_READ_ACCESS_INVALID')
  })
  test('Given SQLite 资源 When 授权 Then 仅允许 main 且禁止实例范围', () => {
    /** SQLite 仍需显式授予表、行和 SQL 查询，不能从 SSH 或 MySQL 权限继承。 */
    const sqliteGrant: ServerOpsAgentReadGrant = {
      sessionId: 'session-1',
      resources: [{
        kind: 'sqlite', sourceId: 'sqlite-1', instance: false,
        databases: [{ database: 'main', tables: ['orders'], readRows: true, query: true }],
      }],
    }
    expect(parseServerOpsAgentReadGrant(sqliteGrant)).toEqual(sqliteGrant)
    for (const resource of [
      { ...sqliteGrant.resources[0], instance: true },
      { ...sqliteGrant.resources[0], databases: [{ database: 'other', tables: ['orders'], readRows: true }] },
      { ...sqliteGrant.resources[0], databases: [] },
    ]) expect(() => parseServerOpsAgentReadGrant({ sessionId: 'session-1', resources: [resource] }))
      .toThrow('SERVER_OPS_READ_ACCESS_INVALID')
  })
  test('Given 旧 SSH 授权 When 解析 Then 不获得日志；显式授权只接受布尔值', () => {
    const old = parseServerOpsAgentReadGrant({ sessionId: 'session-1', resources: [{ kind: 'ssh', hostId: 'host-1' }] })
    expect(old.resources[0]).toEqual({ kind: 'ssh', hostId: 'host-1' })
    expect(parseServerOpsAgentReadGrant({ sessionId: 'session-1', resources: [{ kind: 'ssh', hostId: 'host-1', readLogs: true }] }).resources[0]).toEqual({ kind: 'ssh', hostId: 'host-1', readLogs: true })
    for (const resource of [{ kind: 'ssh', hostId: 'host-1', readLogs: 'true' }, { kind: 'ssh', hostId: 'host-1', readLogs: true, command: 'id' }]) {
      expect(() => parseServerOpsAgentReadGrant({ sessionId: 'session-1', resources: [resource] })).toThrow('SERVER_OPS_READ_ACCESS_INVALID')
    }
  })
})
