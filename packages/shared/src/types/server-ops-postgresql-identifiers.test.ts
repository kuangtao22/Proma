import { describe, expect, test } from 'bun:test'
import { formatServerOpsPostgresTable, parseServerOpsPostgresTable } from './server-ops-postgresql-identifiers'

describe('PostgreSQL 表身份', () => {
  test('Given schema 与 table 含引号和同名 When 格式化 Then 返回可逆 canonical 身份', () => {
    const identity = formatServerOpsPostgresTable('tenant"a', 'tenant"a')
    expect(identity).toBe('"tenant""a"."tenant""a"')
    expect(parseServerOpsPostgresTable(identity)).toEqual({ schema: 'tenant"a', table: 'tenant"a' })
  })

  test('Given 非 canonical 或超过 PostgreSQL 63 字节标识符 When 解析 Then 明确拒绝', () => {
    expect(() => parseServerOpsPostgresTable('public.users')).toThrow('SERVER_OPS_POSTGRES_TABLE_INVALID')
    expect(() => parseServerOpsPostgresTable('"public"."users" ')).toThrow('SERVER_OPS_POSTGRES_TABLE_INVALID')
    expect(() => formatServerOpsPostgresTable('测'.repeat(22), 'users')).toThrow('SERVER_OPS_POSTGRES_TABLE_INVALID')
  })
})
