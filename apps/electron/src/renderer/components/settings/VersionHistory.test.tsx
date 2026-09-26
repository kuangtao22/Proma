import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { VersionHistory } from './VersionHistory'

describe('VersionHistory', () => {
  test('Given 首次渲染版本历史 When 只展示本仓库历史 Then 不出现来源切换与上游版本', () => {
    const html = renderToStaticMarkup(<VersionHistory />)

    expect(html).toContain('版本历史')
    expect(html).toContain('刷新')
    // 只保留本仓库自己的历史：不再有「官方版本」来源标签，也不再有来源切换区。
    expect(html).not.toContain('官方版本')
    expect(html).not.toContain('aria-label="版本历史来源"')
    expect(html).not.toContain('role="tab"')
  })

  test('Given 首次渲染且尚未加载完成 When 渲染列表区 Then 展示加载中或暂无历史', () => {
    const html = renderToStaticMarkup(<VersionHistory />)

    expect(html.includes('加载中...') || html.includes('暂无版本历史')).toBe(true)
  })
})
