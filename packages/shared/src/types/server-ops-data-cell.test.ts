import { describe, expect, test } from 'bun:test'
import {
  MAX_SERVER_OPS_CELL_BYTES,
  parseServerOpsDataSourceCellInput,
  parseServerOpsDataSourceCellResult,
  parseServerOpsDataSourceRowsResult,
} from './server-ops-data-schema'

/** 合成单元格身份，正文摘要不依赖用户数据库。 */
const input = { sourceId: 'source-1', database: 'main', table: 'entries', offset: 53,
  columnIndex: 1, expectedColumn: 'payload', sha256: 'a'.repeat(64) }

describe('单元格完整内容合同', () => {
  test('Given 页内单元格 When 解析请求 Then 接受绝对行偏移并复制受控筛选', () => {
    expect(parseServerOpsDataSourceCellInput(input)).toEqual(input)
    expect(parseServerOpsDataSourceCellInput({ ...input, filters: { match: 'all', conditions: [
      { column: 'id', operator: 'eq', value: '42' },
    ] } })).toHaveProperty('filters.conditions.0.value', '42')
  })
  test('Given 非法定位或额外字段 When 解析 Then 访问数据库之前拒绝', () => {
    for (const update of [{ offset: -1 }, { offset: 1_000_200 }, { columnIndex: 64 },
      { expectedColumn: '' }, { sha256: 'short' }, { sha256: 'A'.repeat(64) }, { sql: 'SELECT 1' }]) {
      expect(() => parseServerOpsDataSourceCellInput({ ...input, ...update })).toThrow()
    }
  })
  test('Given 完整文本 When 解析结果 Then 保留换行制表符和大整数原文', () => {
    /** 不经 JSON 数值往返，避免精度变化。 */
    const value = '{\n\t"id":90071992547409931234,"body":"' + '长'.repeat(1000) + '"\n}'
    expect(parseServerOpsDataSourceCellResult({ value })).toEqual({ value })
    expect(parseServerOpsDataSourceCellResult({ value: null })).toEqual({ value: null })
    expect(parseServerOpsDataSourceCellResult({ value: { kind: 'binary', bytes: 3 } })).toEqual({ value: { kind: 'binary', bytes: 3 } })
  })
  test('Given 超限正文或伪造字段 When 解析结果 Then 不返回伪装完整的截断值', () => {
    expect(() => parseServerOpsDataSourceCellResult({ value: '中'.repeat(Math.ceil(MAX_SERVER_OPS_CELL_BYTES / 3)) })).toThrow()
    expect(() => parseServerOpsDataSourceCellResult({ value: 'text', truncated: true })).toThrow()
  })
  test('Given 有损预览 When 解析 Then 保留用于验证全文的摘要而不放宽预览长度', () => {
    /** 预览仍限制 256 字，详情单独读取。 */
    const preview = { columns: ['payload'], rows: [[{ kind: 'text' as const, text: 'x'.repeat(256), truncated: true as const, sha256: input.sha256 }]], offset: 0, limit: 50, truncated: true }
    expect(parseServerOpsDataSourceRowsResult(preview)).toEqual(preview)
    expect(() => parseServerOpsDataSourceRowsResult({ ...preview, rows: [[{ ...preview.rows[0]![0], sha256: 'bad' }]] })).toThrow()
  })
  test('Given 200行64列预览 When 摘要超过原正文预算 Then 保留页内行且不放宽正文预算', () => {
    /** 每格固定摘要单独计量，防止宽表因详情功能失去已有分页能力。 */
    const columns = Array.from({ length: 64 }, (_, index) => `field_${index}`)
    const rows = Array.from({ length: 200 }, () => columns.map(() => ({ kind: 'text' as const, text: '', truncated: true as const, sha256: input.sha256 })))
    expect(parseServerOpsDataSourceRowsResult({ columns, rows, offset: 0, limit: 200, truncated: true }).rows).toHaveLength(200)
    expect(() => parseServerOpsDataSourceRowsResult({ columns, rows: rows.map((row) => row.map((cell) => ({ ...cell, text: 'x'.repeat(256) }))), offset: 0, limit: 200, truncated: true })).toThrow()
  })
})
