import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { CanvasArtifactVersionPanel } from './CanvasArtifactVersionPanel'

/** 创建固定文档修订摘要。 */
function createRevision(revision: number) {
  return {
    kind: 'document' as const,
    contentId: 'content-1',
    revision,
    parentRevision: revision === 0 ? null : revision - 1,
    contentHash: String(revision).padStart(64, 'a'),
    createdBy: { type: 'user' as const },
    createdAt: revision + 1,
  }
}

describe('Canvas 产物版本面板', () => {
  test('Given 版本仍在加载或列表为空 When 渲染 Then 显示明确状态而不是空白面板', () => {
    const loadingHtml = renderToStaticMarkup(
      <CanvasArtifactVersionPanel
        revisions={[]}
        currentRevision={2}
        selectedRevision={null}
        loading
        writable
        onSelect={() => undefined}
        onAdopt={() => undefined}
      />,
    )
    const emptyHtml = renderToStaticMarkup(
      <CanvasArtifactVersionPanel
        revisions={[]}
        currentRevision={2}
        selectedRevision={null}
        loading={false}
        writable
        onSelect={() => undefined}
        onAdopt={() => undefined}
      />,
    )
    const errorHtml = renderToStaticMarkup(
      <CanvasArtifactVersionPanel
        revisions={[createRevision(2), createRevision(1)]}
        currentRevision={2}
        selectedRevision={1}
        loading={false}
        writable
        error="版本内容加载失败"
        onSelect={() => undefined}
        onAdopt={() => undefined}
      />,
    )

    expect(loadingHtml).toContain('正在加载版本')
    expect(emptyHtml).toContain('暂无历史版本')
    expect(errorHtml).toContain('版本内容加载失败')
    expect(errorHtml).toContain('role="alert"')
  })

  test('Given 当前版与历史版 When 选择历史 Then 列表可键盘聚焦并显示只读双栏比较', () => {
    const html = renderToStaticMarkup(
      <CanvasArtifactVersionPanel
        revisions={[createRevision(2), createRevision(1)]}
        currentRevision={2}
        selectedRevision={1}
        loading={false}
        writable
        currentContent="# 当前版"
        selectedContent="# 历史版"
        onSelect={() => undefined}
        onAdopt={() => undefined}
      />,
    )

    expect(html).toContain('aria-label="版本 2（当前）"')
    expect(html).toContain('aria-label="版本 1"')
    expect(html).toContain('aria-label="当前版本内容"')
    expect(html).toContain('aria-label="历史版本内容"')
    expect(html).toContain('# 当前版')
    expect(html).toContain('# 历史版')
    expect(html).toContain('采用版本 1')
  })

  test('Given 选择当前版或项目只读 When 渲染采用动作 Then 按合同禁用', () => {
    const currentHtml = renderToStaticMarkup(
      <CanvasArtifactVersionPanel
        revisions={[createRevision(2)]}
        currentRevision={2}
        selectedRevision={2}
        loading={false}
        writable
        onSelect={() => undefined}
        onAdopt={() => undefined}
      />,
    )
    const readOnlyHtml = renderToStaticMarkup(
      <CanvasArtifactVersionPanel
        revisions={[createRevision(2), createRevision(1)]}
        currentRevision={2}
        selectedRevision={1}
        loading={false}
        writable={false}
        onSelect={() => undefined}
        onAdopt={() => undefined}
      />,
    )

    expect(currentHtml).toContain('采用当前版本')
    expect(currentHtml).toContain('disabled=""')
    expect(readOnlyHtml).toContain('采用版本 1')
    expect(readOnlyHtml).toContain('disabled=""')
  })
})
