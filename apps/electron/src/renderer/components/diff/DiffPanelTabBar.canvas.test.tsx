import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'bun:test'

describe('右侧工作区画布菜单', () => {
  test('Given 无关联画布 When 打开加号菜单 Then 仍提供新建和现有画布子菜单', () => {
    const source = readFileSync(new URL('./DiffPanelTabBar.tsx', import.meta.url), 'utf8')

    expect(source).toContain('DropdownMenuSubTrigger')
    expect(source).toContain('新建画布')
    expect(source).toContain('现有画布')
  })

  test('Given 现有画布 When 选择菜单项 Then 交给宿主关联并打开对应标签', () => {
    const source = readFileSync(new URL('./DiffPanelTabBar.tsx', import.meta.url), 'utf8')

    expect(source).toContain('onOpenCanvas')
    expect(source).toContain('onCreateCanvas')
  })

  test('Given Canvas 管理菜单 When 检查动作 Then 复用重命名、默认、归档恢复和删除合同', () => {
    const source = readFileSync(new URL('./DiffPanelTabBar.tsx', import.meta.url), 'utf8')

    expect(source).toContain('onRenameCanvas')
    expect(source).toContain('onSetDefaultCanvas')
    expect(source).toContain('onToggleArchiveCanvas')
    expect(source).toContain('onRequestDeleteCanvas')
    expect(source).toContain('LEGACY_DESIGN_CANVAS_ID')
    expect(source).toContain('旧版默认设计画布不能删除')
  })

  test('Given 行内重命名 When 按 Enter Then 只通过 blur 提交一次', () => {
    const source = readFileSync(new URL('./DiffPanelTabBar.tsx', import.meta.url), 'utf8')

    expect(source).toContain("if (event.key === 'Enter') event.currentTarget.blur()")
    expect(source).not.toContain("if (event.key === 'Enter') void submitCanvasRename(session)")
  })
})
