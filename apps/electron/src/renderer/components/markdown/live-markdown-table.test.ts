import { describe, expect, test } from 'bun:test'
import {
  type LiveMarkdownTable,
  updateLiveMarkdownTableCell,
} from './live-markdown-table'

describe('实时 Markdown 表格编辑', () => {
  test('Given 两列表格 When 正常更新正文单元格 Then 返回新表格且不变异原表', () => {
    /** 更新前的两列表格。 */
    const table: LiveMarkdownTable = {
      header: ['名称', '状态'],
      alignments: [null, null],
      rows: [['任务', '完成']],
    }
    /** 正常更新正文后的新表格。 */
    const updated = updateLiveMarkdownTableCell(table, 1, 1, '进行中')

    expect(updated).not.toBe(table)
    expect(updated.rows).toEqual([['任务', '进行中']])
    expect(table.rows).toEqual([['任务', '完成']])
    expect(updated.rows).not.toBe(table.rows)
    expect(updated.rows[0]).not.toBe(table.rows[0])
  })

  test('Given 两列表格 When 更新表头或正文第三列 Then 都忽略越界写入且不扩展表格', () => {
    /** 用于验证表头和正文列上界一致的两列表格。 */
    const table: LiveMarkdownTable = {
      header: ['名称', '状态'],
      alignments: [null, null],
      rows: [['任务', '完成']],
    }
    /** 尝试越界更新表头后的结果。 */
    const headerUpdated = updateLiveMarkdownTableCell(table, 0, 2, '越界表头')
    /** 尝试越界更新正文后的结果。 */
    const rowUpdated = updateLiveMarkdownTableCell(table, 1, 2, '越界正文')

    expect(headerUpdated).toBe(table)
    expect(rowUpdated).toBe(table)
    expect(table.header).toEqual(['名称', '状态'])
    expect(table.rows).toEqual([['任务', '完成']])
  })

  test('Given 两列表格 When 行或列索引为负数 Then 拒绝更新', () => {
    /** 用于验证负索引保护的两列表格。 */
    const table: LiveMarkdownTable = {
      header: ['名称', '状态'],
      alignments: [null, null],
      rows: [['任务', '完成']],
    }

    expect(updateLiveMarkdownTableCell(table, -1, 0, '非法行')).toBe(table)
    expect(updateLiveMarkdownTableCell(table, 0, -1, '非法列')).toBe(table)
  })
})
