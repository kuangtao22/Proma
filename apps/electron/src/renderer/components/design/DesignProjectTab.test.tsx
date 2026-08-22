import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AgentWorkspace } from '@proma/shared'
import { DesignProjectTab } from './DesignProjectTab'

/** 测试使用的稳定项目，覆盖项目级设计入口所需字段。 */
const workspace: AgentWorkspace = {
  id: 'project-1',
  name: '品牌焕新',
  slug: 'brand-refresh',
  createdAt: 1,
  updatedAt: 1,
}

describe('项目级设计标签', () => {
  test('Given 当前项目 When 渲染标签 Then 显示项目名且提供固定 tab 语义', () => {
    const html = renderToStaticMarkup(
      <DesignProjectTab workspace={workspace} active={false} onActivate={() => undefined} />,
    )

    expect(html).toContain('设计 · 品牌焕新')
    expect(html).toContain('role="tab"')
    expect(html).toContain('aria-selected="false"')
    expect(html).not.toContain('aria-label="关闭')
  })

  test('Given 设计视图已激活 When 渲染标签 Then 暴露激活态且仍不可关闭', () => {
    const html = renderToStaticMarkup(
      <DesignProjectTab workspace={workspace} active onActivate={() => undefined} />,
    )

    expect(html).toContain('aria-selected="true"')
    expect(html).toContain('data-active="true"')
    expect(html).not.toContain('lucide-x')
  })
})
