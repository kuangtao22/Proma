import { describe, expect, test } from 'bun:test'
import { parseServerOpsAgentReadAccess, parseServerOpsAgentReadGrant } from './server-ops-agent-read'
import type { ServerOpsAgentReadGrant } from './server-ops-agent-read'

describe('运维只读授权合同', () => {
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
})
