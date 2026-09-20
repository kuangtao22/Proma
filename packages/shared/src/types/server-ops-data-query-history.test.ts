import { describe, expect, test } from 'bun:test'
import {
  SERVER_OPS_DATA_QUERY_HISTORY_CHANNELS,
  SERVER_OPS_DATA_QUERY_HISTORY_LIMIT,
  parseServerOpsDataQueryHistoryRecordInput,
  parseServerOpsDataQueryHistoryResult,
  parseServerOpsDataQueryHistoryScope,
} from './server-ops-data-query-history'

describe('数据源 SQL 查询历史公开合同', () => {
  test('Given 合法 scope、记录与结果 When 解析 Then 保留原始 SQL 并暴露稳定通道', () => {
    expect(SERVER_OPS_DATA_QUERY_HISTORY_CHANNELS).toEqual({
      LIST: 'server-ops:data-query-history-list',
      SAVE: 'server-ops:data-query-history-save',
    })
    expect(SERVER_OPS_DATA_QUERY_HISTORY_LIMIT).toBe(100)
    expect(parseServerOpsDataQueryHistoryScope({ sourceId: 'source-1', database: 'app' }))
      .toEqual({ sourceId: 'source-1', database: 'app' })
    const sql = '  SELECT id\nFROM users  '
    expect(parseServerOpsDataQueryHistoryRecordInput({ sourceId: 'source-1', database: 'app', sql }))
      .toEqual({ sourceId: 'source-1', database: 'app', sql })
    expect(parseServerOpsDataQueryHistoryResult({ entries: [{
      id: 'history-1', sourceId: 'source-1', database: 'app', sql, createdAt: 1,
    }] })).toEqual({ entries: [{ id: 'history-1', sourceId: 'source-1', database: 'app', sql, createdAt: 1 }] })
  })

  test('Given 未知字段、空 SQL、NUL 或超过 16 KiB When 解析 Then 稳定拒绝', () => {
    expect(() => parseServerOpsDataQueryHistoryScope({ sourceId: 'source-1', database: 'app', extra: true }))
      .toThrow('SERVER_OPS_DATA_QUERY_HISTORY_SCOPE_INVALID')
    expect(() => parseServerOpsDataQueryHistoryRecordInput({ sourceId: 'source-1', database: 'app', sql: '   ' }))
      .toThrow('SERVER_OPS_DATA_QUERY_HISTORY_RECORD_INVALID')
    expect(() => parseServerOpsDataQueryHistoryRecordInput({ sourceId: 'source-1', database: 'app', sql: 'SELECT\u0000 1' }))
      .toThrow('SERVER_OPS_DATA_QUERY_HISTORY_RECORD_INVALID')
    expect(() => parseServerOpsDataQueryHistoryRecordInput({
      sourceId: 'source-1', database: 'app', sql: `SELECT '${'你'.repeat(5_462)}'`,
    })).toThrow('SERVER_OPS_DATA_QUERY_HISTORY_RECORD_INVALID')
  })

  test('Given 结果未知字段、重复 ID、越界条数或非法时间 When 解析 Then 拒绝整个结果', () => {
    const entry = { id: 'history-1', sourceId: 'source-1', database: 'app', sql: 'SELECT 1', createdAt: 1 }
    expect(() => parseServerOpsDataQueryHistoryResult({ entries: [{ ...entry, extra: true }] }))
      .toThrow('SERVER_OPS_DATA_QUERY_HISTORY_RESULT_INVALID')
    expect(() => parseServerOpsDataQueryHistoryResult({ entries: [entry, entry] }))
      .toThrow('SERVER_OPS_DATA_QUERY_HISTORY_RESULT_INVALID')
    expect(() => parseServerOpsDataQueryHistoryResult({ entries: Array.from({ length: 101 }, (_, index) => ({ ...entry, id: `history-${index}` })) }))
      .toThrow('SERVER_OPS_DATA_QUERY_HISTORY_RESULT_INVALID')
    expect(() => parseServerOpsDataQueryHistoryResult({ entries: [{ ...entry, createdAt: -1 }] }))
      .toThrow('SERVER_OPS_DATA_QUERY_HISTORY_RESULT_INVALID')
    expect(() => parseServerOpsDataQueryHistoryResult({ entries: [{ ...entry, createdAt: 8_640_000_000_000_001 }] }))
      .toThrow('SERVER_OPS_DATA_QUERY_HISTORY_RESULT_INVALID')
  })
})
