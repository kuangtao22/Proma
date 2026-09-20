import { describe, expect, test } from 'bun:test'
import {
  SERVER_OPS_DATA_QUERY_CHANNELS,
  parseServerOpsDataQueryCancelInput,
  parseServerOpsDataQueryInput,
  parseServerOpsDataQueryResult,
} from './server-ops-data-query'

describe('数据源 SQL 查询公开合同', () => {
  test('Given 合法执行与取消请求 When 解析 Then 保留 required 字段并暴露稳定通道', () => {
    expect(SERVER_OPS_DATA_QUERY_CHANNELS).toEqual({
      EXECUTE: 'server-ops:data-query',
      CANCEL: 'server-ops:data-query-cancel',
    })
    expect(parseServerOpsDataQueryInput({
      sourceId: 'source-1',
      database: 'app',
      queryId: 'query-1',
      sql: 'SELECT `id` FROM `users`',
      maxRows: 50,
    })).toEqual({
      sourceId: 'source-1',
      database: 'app',
      queryId: 'query-1',
      sql: 'SELECT `id` FROM `users`',
      maxRows: 50,
    })
    expect(parseServerOpsDataQueryCancelInput({ sourceId: 'source-1', queryId: 'query-1' }))
      .toEqual({ sourceId: 'source-1', queryId: 'query-1' })
  })

  test('Given 输入存在缺项、未知字段或越界 When 解析 Then 稳定拒绝', () => {
    /** SQL 字节预算以 UTF-8 计算，避免多字节文本绕过 16 KiB 上限。 */
    const oversizedSql = `SELECT '${'你'.repeat(5_462)}'`
    expect(() => parseServerOpsDataQueryInput({ sourceId: 'source-1', database: 'app', queryId: 'query-1', sql: oversizedSql, maxRows: 50 }))
      .toThrow('SERVER_OPS_DATA_QUERY_INPUT_INVALID')
    expect(() => parseServerOpsDataQueryInput({ sourceId: 'source-1', database: 'app', queryId: 'query-1', sql: 'SELECT 1', maxRows: 0 }))
      .toThrow('SERVER_OPS_DATA_QUERY_INPUT_INVALID')
    expect(() => parseServerOpsDataQueryInput({ sourceId: 'source-1', database: 'app', queryId: 'query-1', sql: 'SELECT 1', maxRows: 201 }))
      .toThrow('SERVER_OPS_DATA_QUERY_INPUT_INVALID')
    expect(() => parseServerOpsDataQueryInput({ sourceId: 'source-1', database: 'app', queryId: 'query-1', sql: 'SELECT 1', maxRows: 50, extra: true }))
      .toThrow('SERVER_OPS_DATA_QUERY_INPUT_INVALID')
    expect(() => parseServerOpsDataQueryCancelInput({ sourceId: 'source-1' }))
      .toThrow('SERVER_OPS_DATA_QUERY_CANCEL_INPUT_INVALID')
  })

  test('Given 自洽有界查询结果 When 解析 Then 保留 cell 公开形状', () => {
    expect(parseServerOpsDataQueryResult({
      queryId: 'query-1',
      database: 'app',
      columns: ['id', 'payload', ''],
      rows: [['1', { kind: 'binary', bytes: 16 }, { kind: 'text', text: 'x'.repeat(256), truncated: true }]],
      rowCount: 1,
      durationMs: 12,
      truncated: false,
      warnings: ['使用了估算行数'],
    })).toEqual({
      queryId: 'query-1',
      database: 'app',
      columns: ['id', 'payload', ''],
      rows: [['1', { kind: 'binary', bytes: 16 }, { kind: 'text', text: 'x'.repeat(256), truncated: true }]],
      rowCount: 1,
      durationMs: 12,
      truncated: false,
      warnings: ['使用了估算行数'],
    })
  })

  test('Given 结果列宽、行数或最终 JSON 预算不自洽 When 解析 Then 拒绝整个结果', () => {
    /** 基准结果用于逐项证明跨字段约束。 */
    const result = {
      queryId: 'query-1',
      database: 'app',
      columns: ['id'],
      rows: [['1']],
      rowCount: 1,
      durationMs: 12,
      truncated: false,
      warnings: [],
    }
    expect(() => parseServerOpsDataQueryResult({ ...result, rowCount: 0 }))
      .toThrow('SERVER_OPS_DATA_QUERY_RESULT_INVALID')
    expect(() => parseServerOpsDataQueryResult({ ...result, rows: [['1', 'extra']] }))
      .toThrow('SERVER_OPS_DATA_QUERY_RESULT_INVALID')
    expect(() => parseServerOpsDataQueryResult({ ...result, columns: Array.from({ length: 65 }, (_, index) => `column_${index}`), rows: [] , rowCount: 0 }))
      .toThrow('SERVER_OPS_DATA_QUERY_RESULT_INVALID')
    /** pretty JSON 的转义与缩进均属于跨 IPC 的真实预算。 */
    expect(() => parseServerOpsDataQueryResult({
      ...result,
      rows: Array.from({ length: 200 }, () => ['x'.repeat(256)]),
      rowCount: 200,
    })).toThrow('SERVER_OPS_DATA_QUERY_RESULT_INVALID')
    expect(() => parseServerOpsDataQueryResult({ ...result, warnings: ['bad\nwarning'] }))
      .toThrow('SERVER_OPS_DATA_QUERY_RESULT_INVALID')
    expect(() => parseServerOpsDataQueryResult({ ...result, rows: [[{ kind: 'binary', bytes: -1 }]] }))
      .toThrow('SERVER_OPS_DATA_QUERY_RESULT_INVALID')
  })
})
