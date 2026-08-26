import * as React from 'react'
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { CanvasAgentRecoveryPanel } from './CanvasAgentRecoveryPanel'

describe('Canvas Agent 坏节点恢复面板', () => {
  test('Given Agent 会话不可用 When 打开节点 Then 提供重建、删除和关闭且说明旧记录保留', () => {
    const html = renderToStaticMarkup(
      <CanvasAgentRecoveryPanel
        title="首页设计"
        rebuilding={false}
        error={null}
        onRebuild={() => undefined}
        onDelete={() => undefined}
        onClose={() => undefined}
      />,
    )

    expect(html).toContain('此节点关联的 Agent 会话不可用。')
    expect(html).toContain('新会话将从空白对话开始，旧对话记录不会删除。')
    expect(html).toContain('重建会话')
    expect(html).toContain('删除节点')
    expect(html).toContain('aria-label="关闭恢复面板"')
  })

  test('Given 正在重建 When 渲染面板 Then 禁止重复提交并显示进度', () => {
    const html = renderToStaticMarkup(
      <CanvasAgentRecoveryPanel
        title="首页设计"
        rebuilding
        error={null}
        onRebuild={() => undefined}
        onDelete={() => undefined}
        onClose={() => undefined}
      />,
    )

    expect(html).toContain('正在重建')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[^<]*(?:<[^>]+>)*正在重建/u)
  })
})
