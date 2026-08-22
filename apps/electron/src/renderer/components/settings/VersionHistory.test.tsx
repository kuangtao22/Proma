import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { VersionHistory } from './VersionHistory'

describe('VersionHistory', () => {
  test('Given 首次渲染版本历史 When 未切换来源 Then 展示双标签且默认 Bone', () => {
    const html = renderToStaticMarkup(<VersionHistory />)

    expect(html).toContain('Proma 修改')
    expect(html).toContain('官方版本')
    expect(html).toMatch(/role="tab" aria-selected="true" aria-controls="[^"]*-content-bone"[^>]*>Proma 修改<\/button>/)
    expect(html).toContain('aria-selected="false"')
  })
})
