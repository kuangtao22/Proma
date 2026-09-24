import { describe, expect, test } from 'bun:test'
import { isServerOpsAuditRecord, parseServerOpsAuditListResult } from './server-ops'
import { formatServerOpsPostgresTable } from './server-ops-postgresql-identifiers'

/** SQL 审计只保留不可逆摘要与实际表集合，不接收语句或行数据。 */
const record = { id: 'audit-1', operationId: 'query-1', timestamp: 1, actor: 'agent', sessionId: 'session-1',
  sourceId: 'source-1', operation: 'data-query', resourceType: 'data-query', database: 'app',
  queryHash: `sha256:${'a'.repeat(64)}`, tables: ['orders', 'users'], phase: 'result', outcome: 'success' }

describe('SQL 查询审计合同', () => {
  test('Given Agent 或真实窗口查询 When 审计 Then 保留明确库表与摘要', () => {
    expect(isServerOpsAuditRecord(record)).toBe(true)
    expect(isServerOpsAuditRecord({ ...record, actor: 'user', sessionId: undefined, windowId: 7 })).toBe(true)
    expect(isServerOpsAuditRecord({ ...record, tables: [] })).toBe(true)
    expect(isServerOpsAuditRecord({ ...record, tables: [formatServerOpsPostgresTable('s'.repeat(63), 't'.repeat(63))] })).toBe(true)
  })
  test('Given 缺少范围或注入正文 When 审计 Then 一律拒绝', () => {
    for (const patch of [{ database: undefined }, { tables: undefined }, { tables: ['orders', 'orders'] },
      { tables: ['x'.repeat(261)] }, { tables: Array.from({ length: 17 }, (_, index) => `t${index}`) },
      { queryHash: 'select secret' }, { operationId: undefined }, { hostId: 'host-1' },
      { sourceId: undefined }, { table: 'users' }, { scope: 'database' }, { readAction: 'rows-read' },
      { sql: 'SELECT 1' }, { rows: [['secret']] }]) expect(isServerOpsAuditRecord({ ...record, ...patch })).toBe(false)
  })
  test('Given SQL 表集合 When 解析公开结果后修改 Then 不污染输入', () => {
    /** parser 输出必须深复制新增的数组字段。 */
    const parsed = parseServerOpsAuditListResult({ records: [record] })
    parsed.records[0]!.tables!.push('other')
    expect(record.tables).toEqual(['orders', 'users'])
  })
})
