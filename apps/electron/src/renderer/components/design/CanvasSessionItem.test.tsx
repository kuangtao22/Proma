import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import type { CanvasSessionMeta } from '@proma/shared'
import type { ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { TooltipProvider } from '@/components/ui/tooltip'
import { CanvasSessionItem } from './CanvasSessionItem'

/** 测试使用的稳定 Canvas 会话。 */
const session: CanvasSessionMeta = {
  id: 'canvas-1',
  projectId: 'project-1',
  title: '首页视觉方案',
  archived: false,
  createdAt: 1,
  updatedAt: 2,
}

/** 使用与主应用一致的 Tooltip 上下文渲染 Canvas 会话行。 */
function renderCanvasSessionItem(
  props: ComponentProps<typeof CanvasSessionItem>,
): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <CanvasSessionItem {...props} />
    </TooltipProvider>,
  )
}

describe('Canvas 会话侧栏行', () => {
  test('Given 普通 Canvas When 渲染 Then 显示类型图标、标题和可聚焦会话语义', () => {
    const html = renderCanvasSessionItem({
      session,
      active: false,
      onSelect: () => undefined,
      onRename: async () => undefined,
      onToggleArchive: async () => undefined,
      onRequestDelete: () => undefined,
    })

    expect(html).toContain('首页视觉方案')
    expect(html).toContain('lucide-workflow')
    expect(html).toContain('role="button"')
    expect(html).toContain('tabindex="0"')
    expect(html).toContain('aria-label="Canvas 会话菜单"')
  })

  test('Given 当前 Canvas When 渲染 Then 暴露选中态而不伪装 Agent 运行状态', () => {
    const html = renderCanvasSessionItem({
      session,
      active: true,
      onSelect: () => undefined,
      onRename: async () => undefined,
      onToggleArchive: async () => undefined,
      onRequestDelete: () => undefined,
    })

    expect(html).toContain('aria-current="page"')
    expect(html).toContain('canvas-session-item-active')
    expect(html).not.toContain('animate-pulse')
  })

  test('Given 已归档 Canvas When 渲染 Then 快捷操作明确为取消归档', () => {
    const html = renderCanvasSessionItem({
      session: { ...session, archived: true },
      active: false,
      selectDisabled: true,
      onSelect: () => undefined,
      onRename: async () => undefined,
      onToggleArchive: async () => undefined,
      onRequestDelete: () => undefined,
    })

    expect(html).toContain('aria-label="取消归档 Canvas"')
    expect(html).toContain('disabled=""')
  })

  test('Given Canvas 会话菜单 When 检查操作 Then 提供独立删除入口且使用危险样式', () => {
    /** 菜单内容由 Radix Portal 延迟挂载，源码合同用于锁定入口与回调。 */
    const source = readFileSync(new URL('./CanvasSessionItem.tsx', import.meta.url), 'utf8')

    expect(source).toContain('onRequestDelete')
    expect(source).toContain('删除 Canvas')
    expect(source).toContain('text-destructive')
    expect(source).toContain('LEGACY_DESIGN_CANVAS_ID')
    expect(source).toContain('旧版默认设计画布不能删除')
  })
})
