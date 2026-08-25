import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CanvasSessionMeta } from '@proma/shared'
import { renderToStaticMarkup } from 'react-dom/server'
import { CanvasSessionTab } from './CanvasSessionTab'

/** 测试使用的稳定 Canvas 会话。 */
const session: CanvasSessionMeta = {
  id: 'canvas-1',
  projectId: 'project-1',
  title: '首页视觉探索',
  archived: false,
  createdAt: 1,
  updatedAt: 2,
}

describe('Canvas 顶部标签', () => {
  test('Given 当前 Canvas When 渲染 Then 显示标题、类型图标和固定 tab 语义', () => {
    const html = renderToStaticMarkup(
      <CanvasSessionTab session={session} active={false} onActivate={() => undefined} />,
    )

    expect(html).toContain('首页视觉探索')
    expect(html).toContain('lucide-workflow')
    expect(html).toContain('role="tab"')
    expect(html).toContain('aria-selected="false"')
    expect(html).not.toContain('aria-label="关闭')
  })

  test('Given Canvas 主视图已激活 When 渲染 Then 暴露激活态且不可关闭', () => {
    const html = renderToStaticMarkup(
      <CanvasSessionTab session={session} active onActivate={() => undefined} />,
    )

    expect(html).toContain('aria-selected="true"')
    expect(html).toContain('data-active="true"')
    expect(html).not.toContain('lucide-x')
  })

  test('Given 用户激活普通 tab When 切回会话视图 Then 先清除 Canvas 选择', () => {
    const source = readFileSync(join(import.meta.dir, '../tabs/TabBar.tsx'), 'utf8')
    const handlerStart = source.indexOf('const handleActivate')
    const handlerEnd = source.indexOf('/** 恢复当前 Canvas', handlerStart)
    const handlerBody = source.slice(handlerStart, handlerEnd)
    const clearSelectionIndex = handlerBody.indexOf('setActiveCanvasSelection(null)')
    const conversationViewIndex = handlerBody.indexOf("setActiveView('conversations')")

    expect(handlerStart).toBeGreaterThan(-1)
    expect(clearSelectionIndex).toBeGreaterThan(-1)
    expect(conversationViewIndex).toBeGreaterThan(clearSelectionIndex)
  })
})
