import { describe, expect, test } from 'bun:test'
import type { ServerOpsDataRowFilters } from './server-ops-data-schema'
import {
  isServerOpsSchemaBrowsableEngine,
  parseServerOpsDataRowFilters,
  parseServerOpsDataSourceRowsInput,
  parseServerOpsDataSourceRowsResult,
  parseServerOpsDataSourceTableInput,
  parseServerOpsDataSourceTableResult,
  parseServerOpsDataSourceTablesInput,
  parseServerOpsDataSourceTablesResult,
} from './server-ops-data-schema'

describe('数据源表浏览公开合同', () => {
  test('Given 多字段筛选 When 解析 Then 保留 AND/OR、空比较值及 NULL 条件', () => {
    const filters = { match: 'any', conditions: [
      { column: 'name', operator: 'contains', value: '' },
      { column: 'deleted_at', operator: 'is-null' },
    ] } satisfies ServerOpsDataRowFilters
    expect(parseServerOpsDataRowFilters(filters)).toEqual(filters)
    expect(parseServerOpsDataSourceRowsInput({
      sourceId: 'source-1', database: 'app', table: 'users', offset: 0, limit: 50, filters,
    }).filters).toEqual(filters)
  })

  test('Given 非法筛选合同 When 解析 Then 在访问数据库之前拒绝', () => {
    const valid = { column: 'name', operator: 'eq', value: 'Alice' }
    for (const filters of [
      { match: 'all', conditions: [] },
      { match: 'any', conditions: Array.from({ length: 13 }, () => valid) },
      { match: 'all', conditions: [valid], unexpected: true },
      { match: 'all', conditions: [{ ...valid, column: 'x\n' }] },
      { match: 'all', conditions: [{ ...valid, operator: 'raw-sql' }] },
      { match: 'all', conditions: [{ ...valid, value: 'x'.repeat(1025) }] },
      { match: 'all', conditions: [{ column: 'name', operator: 'eq' }] },
      { match: 'all', conditions: [{ column: 'name', operator: 'is-null', value: '' }] },
      { match: 'all', conditions: [{ ...valid, nested: [] }] },
    ]) expect(() => parseServerOpsDataRowFilters(filters)).toThrow('SERVER_OPS_DATA_SCHEMA_FILTERS_INVALID')
  })
  test('Given 关系型引擎 When 判断结构浏览能力 Then MySQL 与 SQLite 均开放', () => {
    expect(isServerOpsSchemaBrowsableEngine('mysql')).toBe(true)
    expect(isServerOpsSchemaBrowsableEngine('postgresql')).toBe(true)
    expect(isServerOpsSchemaBrowsableEngine('sqlite')).toBe(true)
    expect(isServerOpsSchemaBrowsableEngine('redis')).toBe(false)
  })

  test('Given 表浏览输入 When 解析 Then 只接受 exact-key 且分页必须整页对齐', () => {
    expect(parseServerOpsDataSourceTablesInput({ sourceId: 'source-1' })).toEqual({ sourceId: 'source-1' })
    expect(parseServerOpsDataSourceTablesInput({ sourceId: 'source-1', database: 'chebenben' }))
      .toEqual({ sourceId: 'source-1', database: 'chebenben' })
    expect(parseServerOpsDataSourceTablesInput({ sourceId: 'source-1', database: 'chebenben', cacheMode: 'prefer-cache' }))
      .toEqual({ sourceId: 'source-1', database: 'chebenben', cacheMode: 'prefer-cache' })
    expect(parseServerOpsDataSourceTablesInput({ sourceId: 'source-1', database: 'app', tableSearch: "users_%'" }))
      .toEqual({ sourceId: 'source-1', database: 'app', tableSearch: "users_%'" })
    for (const search of ['', 'x'.repeat(129), 'a\nb']) {
      expect(() => parseServerOpsDataSourceTablesInput({ sourceId: 'source-1', database: 'app', tableSearch: search })).toThrow()
    }
    expect(() => parseServerOpsDataSourceTablesInput({ sourceId: 'source-1', tableSearch: 'users' })).toThrow()
    expect(parseServerOpsDataSourceTablesInput({ sourceId: 'source-1', cacheMode: 'refresh' }))
      .toEqual({ sourceId: 'source-1', cacheMode: 'refresh' })
    /** 库名与表名必须是有界文本，且不允许控制字符。 */
    expect(() => parseServerOpsDataSourceTablesInput({ sourceId: 'source-1', database: 'bad\nname' }))
      .toThrow('SERVER_OPS_DATA_SCHEMA_TABLES_INPUT_INVALID')
    expect(() => parseServerOpsDataSourceTablesInput({ sourceId: 'source-1', table: 'users' }))
      .toThrow('SERVER_OPS_DATA_SCHEMA_TABLES_INPUT_INVALID')
    expect(() => parseServerOpsDataSourceTablesInput({ sourceId: 'source-1', cacheMode: 'stale-ok' }))
      .toThrow('SERVER_OPS_DATA_SCHEMA_TABLES_INPUT_INVALID')
    expect(parseServerOpsDataSourceTableInput({ sourceId: 'source-1', database: 'app', table: 'users' }))
      .toEqual({ sourceId: 'source-1', database: 'app', table: 'users' })
    expect(parseServerOpsDataSourceTableInput({ sourceId: 'source-1', database: 'app', table: 'users', cacheMode: 'refresh' }))
      .toEqual({ sourceId: 'source-1', database: 'app', table: 'users', cacheMode: 'refresh' })
    expect(() => parseServerOpsDataSourceTableInput({ sourceId: 'source-1', database: 'app' }))
      .toThrow('SERVER_OPS_DATA_SCHEMA_TABLE_INPUT_INVALID')
    expect(parseServerOpsDataSourceRowsInput({ sourceId: 'source-1', database: 'app', table: 'users', offset: 100, limit: 50 }))
      .toEqual({ sourceId: 'source-1', database: 'app', table: 'users', offset: 100, limit: 50 })
    /** 偏移必须是页大小整数倍，避免出现"半页"这种无法翻页的请求。 */
    expect(() => parseServerOpsDataSourceRowsInput({ sourceId: 'source-1', database: 'app', table: 'users', offset: 30, limit: 50 }))
      .toThrow('SERVER_OPS_DATA_SCHEMA_ROWS_INPUT_INVALID')
    expect(() => parseServerOpsDataSourceRowsInput({ sourceId: 'source-1', database: 'app', table: 'users', offset: 0, limit: 500 }))
      .toThrow('SERVER_OPS_DATA_SCHEMA_ROWS_INPUT_INVALID')
  })

  test('Given 表清单结果 When 解析 Then 拒绝重复库名与越界字段', () => {
    expect(parseServerOpsDataSourceTablesResult({
      databases: ['app', 'chebenben'],
      database: 'app',
      databasesTruncated: true,
      tablesTruncated: false,
      tables: [{ name: 'users', type: 'table', engine: 'InnoDB', rows: 12, sizeBytes: 16_384, updatedAt: 1_700_000_000_000, comment: '' }],
    })).toEqual({
      databases: ['app', 'chebenben'],
      database: 'app',
      databasesTruncated: true,
      tablesTruncated: false,
      tables: [{ name: 'users', type: 'table', engine: 'InnoDB', rows: 12, sizeBytes: 16_384, updatedAt: 1_700_000_000_000, comment: '' }],
    })
    expect(() => parseServerOpsDataSourceTablesResult({ databases: ['app', 'app'], tables: [] }))
      .toThrow('SERVER_OPS_DATA_SCHEMA_TABLES_RESULT_INVALID')
    expect(() => parseServerOpsDataSourceTablesResult({ databases: ['app'], tables: [{ name: 'users', engine: 'InnoDB', extra: 1 }] }))
      .toThrow('SERVER_OPS_DATA_SCHEMA_TABLES_RESULT_INVALID')
    expect(() => parseServerOpsDataSourceTablesResult({ databases: ['app'], tables: [{ name: '' }] }))
      .toThrow('SERVER_OPS_DATA_SCHEMA_TABLES_RESULT_INVALID')
  })

  test('Given 表结构结果 When 解析 Then 列与索引都必须自洽', () => {
    expect(parseServerOpsDataSourceTableResult({
      columns: [{ name: 'id', type: 'int unsigned', nullable: false, primaryKey: true, extra: 'auto_increment' }],
      indexes: [{ name: 'PRIMARY', unique: true, columns: ['id'] }],
    })).toMatchObject({ columns: [{ name: 'id', primaryKey: true }], indexes: [{ name: 'PRIMARY', unique: true }] })
    /** 索引至少要有一列，且不允许未知字段。 */
    expect(() => parseServerOpsDataSourceTableResult({ columns: [], indexes: [{ name: 'idx', unique: false, columns: [] }] }))
      .toThrow('SERVER_OPS_DATA_SCHEMA_TABLE_RESULT_INVALID')
    expect(() => parseServerOpsDataSourceTableResult({
      columns: [{ name: 'id', type: 'int', nullable: false, primaryKey: true, serializedAt: 1 }],
      indexes: [],
    })).toThrow('SERVER_OPS_DATA_SCHEMA_TABLE_RESULT_INVALID')
  })

  test('Given 行预览结果 When 解析 Then 单元格宽度必须与列数一致且受上限约束', () => {
    expect(parseServerOpsDataSourceRowsResult({
      columns: ['id', 'name', 'payload', 'note'],
      rows: [['1', null, { kind: 'binary', bytes: 8 }, { kind: 'text', text: 'x'.repeat(256), truncated: true }]],
      offset: 0,
      limit: 50,
      truncated: true,
      hasMore: true,
      orderedByPrimaryKey: true,
      totalEstimate: 2,
    })).toMatchObject({ rows: [['1', null, { kind: 'binary', bytes: 8 }, { kind: 'text', truncated: true }]], hasMore: true, orderedByPrimaryKey: true })
    expect(() => parseServerOpsDataSourceRowsResult({ columns: ['id', 'name'], rows: [['1']], offset: 0, limit: 50, truncated: false }))
      .toThrow('SERVER_OPS_DATA_SCHEMA_ROWS_RESULT_INVALID')
    expect(() => parseServerOpsDataSourceRowsResult({ columns: ['id'], rows: [['x'.repeat(257)]], offset: 0, limit: 50, truncated: false }))
      .toThrow('SERVER_OPS_DATA_SCHEMA_ROWS_RESULT_INVALID')
    expect(() => parseServerOpsDataSourceRowsResult({ columns: ['id'], rows: [[{ kind: 'binary', bytes: -1 }]], offset: 0, limit: 50, truncated: false }))
      .toThrow('SERVER_OPS_DATA_SCHEMA_ROWS_RESULT_INVALID')
    expect(() => parseServerOpsDataSourceRowsResult({ columns: ['id'], rows: [], offset: 0, limit: 0, truncated: false }))
      .toThrow('SERVER_OPS_DATA_SCHEMA_ROWS_RESULT_INVALID')
  })

  test('Given 行数或偏移不符合声明页大小 When 解析 Then 拒绝错误分页回执', () => {
    /** 列值合法仍不能跨越结果所声明的分页边界。 */
    const result = { columns: ['id'], rows: [['1']], offset: 0, limit: 50, truncated: false }
    expect(() => parseServerOpsDataSourceRowsResult({ ...result, rows: [['1'], ['2']], limit: 1 }))
      .toThrow('SERVER_OPS_DATA_SCHEMA_ROWS_RESULT_INVALID')
    expect(() => parseServerOpsDataSourceRowsResult({ ...result, offset: 1 }))
      .toThrow('SERVER_OPS_DATA_SCHEMA_ROWS_RESULT_INVALID')
    expect(parseServerOpsDataSourceRowsResult({ ...result, offset: 50 })).toMatchObject({ offset: 50, limit: 50 })
  })
})
