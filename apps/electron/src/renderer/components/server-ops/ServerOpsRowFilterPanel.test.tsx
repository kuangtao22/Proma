import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ServerOpsDataRowFilters, ServerOpsDataSchemaColumn } from '@proma/shared'
import {
  ServerOpsRowFilterPanel,
  addServerOpsFilterCondition,
  createServerOpsFilterDraft,
  removeServerOpsFilterCondition,
  updateServerOpsFilterCondition,
  validateServerOpsFilterDraft,
} from './ServerOpsRowFilterPanel'

/** 两种字段类型用于验证字段白名单及条件组合。 */
const columns: ServerOpsDataSchemaColumn[] = [
  { name: 'member_id', type: 'bigint', nullable: false, primaryKey: true, comment: '用户编号' },
  { name: 'nickname', type: 'varchar(64)', nullable: true, primaryKey: false, comment: '昵称' },
]

/** 为静态可访问状态测试提供稳定参数。 */
function renderPanel(overrides: Partial<React.ComponentProps<typeof ServerOpsRowFilterPanel>> = {}): string {
  return renderToStaticMarkup(<ServerOpsRowFilterPanel open columns={columns} structureStatus="ready" structureError={null} appliedFilters={null} busy={false} onApply={() => undefined} onRetryFields={() => undefined} {...overrides} />)
}

describe('数据行多条件筛选面板', () => {
  test('Given 两个字段 When 添加 AND/OR 条件 Then 保留字段操作符和值的先后顺序', () => {
    let draft = createServerOpsFilterDraft(null)
    draft = addServerOpsFilterCondition(draft, columns)
    draft = updateServerOpsFilterCondition(draft, draft.conditions[0]!.id, { column: 'member_id', operator: 'gte', value: '100' })
    draft = addServerOpsFilterCondition(draft, columns)
    draft = updateServerOpsFilterCondition(draft, draft.conditions[1]!.id, { column: 'nickname', operator: 'contains', value: '张' })
    expect(validateServerOpsFilterDraft(draft, columns)).toEqual({ filters: { match: 'all', conditions: [
      { column: 'member_id', operator: 'gte', value: '100' },
      { column: 'nickname', operator: 'contains', value: '张' },
    ] }, error: null })
    expect(validateServerOpsFilterDraft({ ...draft, match: 'any' }, columns).filters?.match).toBe('any')
  })

  test('Given 空文本与 NULL 操作符 When 验证 Then 空字符串是可筛选值，NULL 不带 value', () => {
    const applied: ServerOpsDataRowFilters = { match: 'any', conditions: [
      { column: 'nickname', operator: 'eq', value: '' },
      { column: 'nickname', operator: 'is-null' },
    ] }
    const draft = createServerOpsFilterDraft(applied)
    expect(validateServerOpsFilterDraft(draft, columns)).toEqual({ filters: applied, error: null })
    expect(updateServerOpsFilterCondition(draft, draft.conditions[0]!.id, { operator: 'is-not-null' }).conditions[0]!.value).toBe('')
    expect(validateServerOpsFilterDraft(updateServerOpsFilterCondition(draft, draft.conditions[0]!.id, { operator: 'is-not-null' }), columns).filters?.conditions[0]).toEqual({ column: 'nickname', operator: 'is-not-null' })
  })

  test('Given 已载入条件 When 删除与新增 Then 仅改变目标条件且行数受限', () => {
    const applied: ServerOpsDataRowFilters = { match: 'all', conditions: [{ column: 'member_id', operator: 'eq', value: '1' }, { column: 'nickname', operator: 'eq', value: '乙' }] }
    const draft = createServerOpsFilterDraft(applied)
    const remaining = removeServerOpsFilterCondition(draft, draft.conditions[0]!.id)
    expect(validateServerOpsFilterDraft(remaining, columns).filters?.conditions).toEqual([applied.conditions[1]!])
    expect(removeServerOpsFilterCondition(remaining, remaining.conditions[0]!.id).conditions).toEqual([])
    let full = draft
    for (let index = draft.conditions.length; index < 12; index += 1) full = addServerOpsFilterCondition(full, columns)
    expect(addServerOpsFilterCondition(full, columns)).toEqual(full)
  })

  test('Given 字段变化、缺字段或过长值 When 应用 Then 拒绝无效条件', () => {
    const draft = createServerOpsFilterDraft({ match: 'all', conditions: [{ column: 'old_column', operator: 'eq', value: 'x' }] })
    expect(validateServerOpsFilterDraft(draft, columns).error).toContain('字段')
    const missing = updateServerOpsFilterCondition(draft, draft.conditions[0]!.id, { column: '' })
    expect(validateServerOpsFilterDraft(missing, columns).error).toContain('字段')
    const overlong = updateServerOpsFilterCondition(missing, missing.conditions[0]!.id, { column: 'member_id', value: 'x'.repeat(1025) })
    expect(validateServerOpsFilterDraft(overlong, columns).error).toContain('长度')
    const nullCondition = updateServerOpsFilterCondition(overlong, overlong.conditions[0]!.id, { operator: 'is-null' })
    expect(validateServerOpsFilterDraft(nullCondition, columns).filters?.conditions[0]).toEqual({ column: 'member_id', operator: 'is-null' })
    expect(validateServerOpsFilterDraft(createServerOpsFilterDraft(null), columns).filters).toBeNull()
  })

  test('Given 字段名被后端认定敏感 When 编辑或恢复旧条件 Then 不展示字段并拒绝应用', () => {
    const sensitive = [{ name: 'access_token', type: 'varchar(255)', nullable: true, primaryKey: false }, ...columns]
    const draft = createServerOpsFilterDraft({ match: 'all', conditions: [{ column: 'access_token', operator: 'eq', value: 'guess' }] })
    expect(validateServerOpsFilterDraft(draft, sensitive).error).toContain('敏感字段')
    expect(addServerOpsFilterCondition(createServerOpsFilterDraft(null), sensitive).conditions[0]?.column).toBe('member_id')
    expect(renderPanel({ columns: sensitive.filter((column) => column.name === 'access_token') })).toContain('没有可用字段')
  })

  test('Given 字段尚未载入或载入失败 When 打开 Then 显示明确状态并提供重试', () => {
    expect(renderPanel({ structureStatus: 'loading', columns: [] })).toContain('正在读取字段')
    const error = renderPanel({ structureStatus: 'error', columns: [], structureError: '连接已断开' })
    expect(error).toContain('连接已断开')
    expect(error).toContain('重试读取字段')
    expect(renderPanel({ structureStatus: 'ready', columns: [] })).toContain('没有可用字段')
    expect(renderPanel({ open: false })).toBe('')
  })

  test('Given 已应用筛选 When 重新打开 Then 显示条件与重置入口；查询在途不禁用编辑', () => {
    const html = renderPanel({ appliedFilters: { match: 'all', conditions: [{ column: 'nickname', operator: 'eq', value: 'Alice' }] }, busy: true })
    expect(html).toContain('Alice')
    expect(html).toContain('重置筛选')
    expect(html).toContain('正在读取结果')
    expect(html).toContain('aria-label="删除第 1 条条件"')
    expect(html).not.toContain('disabled="" aria-label="字段')
  })
})
