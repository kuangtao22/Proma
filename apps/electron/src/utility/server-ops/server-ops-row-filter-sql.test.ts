import { describe, expect, test } from 'bun:test'
import { buildServerOpsRowFilterSql, getServerOpsRowFilterPublicError } from './server-ops-row-filter-sql'

describe('运维行预览 SQL 筛选', () => {
  test('Given 多字段条件 When 构建 MySQL 过滤 Then 只拼元数据列并绑定所有值', () => {
    const result = buildServerOpsRowFilterSql({ match: 'all', conditions: [
      { column: 'odd`name', operator: 'contains', value: "x%'_! OR 1=1" },
      { column: 'deleted', operator: 'is-null' },
      { column: 'price', operator: 'gte', value: '100' },
    ] }, ['odd`name', 'deleted', 'price'], 'mysql')
    expect(result.clause).toBe(" WHERE (`odd``name` LIKE ? ESCAPE '!' AND `deleted` IS NULL AND `price` >= ?)")
    expect(result.values).toEqual(["%x!%'!_!! OR 1=1%", '100'])
    expect(result.clause).not.toContain('OR 1=1')
  })

  test('Given OR、NULL 否定与前缀 When 构建 SQLite 过滤 Then 条件顺序稳定', () => {
    expect(buildServerOpsRowFilterSql({ match: 'any', conditions: [
      { column: 'odd"name', operator: 'is-not-null' },
      { column: 'name', operator: 'starts-with', value: 'a_' },
      { column: 'name', operator: 'not-contains', value: '%' },
    ] }, ['odd"name', 'name'], 'sqlite')).toEqual({
      clause: ' WHERE ("odd""name" IS NOT NULL OR "name" LIKE ? ESCAPE \'!\' OR "name" NOT LIKE ? ESCAPE \'!\')',
      values: ['a!_%', '%!%%'],
    })
  })

  test('Given 不存在或被遮罩的列 When 编译 Then 拒绝预览旁路', () => {
    for (const column of ['missing', 'authorization']) {
      expect(() => buildServerOpsRowFilterSql({ match: 'all', conditions: [
        { column, operator: 'eq', value: 'secret' },
      ] }, ['authorization'], 'mysql')).toThrow('SERVER_OPS_DATA_SCHEMA_FILTERS_INVALID')
    }
    expect(getServerOpsRowFilterPublicError(new Error('SERVER_OPS_DATA_SCHEMA_FILTERS_INVALID'))).toEqual({
      code: 'SERVER_OPS_DATA_SCHEMA_FILTERS_INVALID', message: '筛选条件无效或字段不可用于筛选',
    })
    expect(getServerOpsRowFilterPublicError(new Error('SERVER_OPS_DATA_SCHEMA_FILTERS_UNAVAILABLE'))).toEqual({
      code: 'SERVER_OPS_DATA_SCHEMA_FILTERS_UNAVAILABLE', message: '当前连接不支持安全筛选，请重连后重试',
    })
    expect(getServerOpsRowFilterPublicError(new Error('database password leaked'))).toBeNull()
  })
})
