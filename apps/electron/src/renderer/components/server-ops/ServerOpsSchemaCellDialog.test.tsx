import { describe, expect, test } from 'bun:test'
import type { ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Dialog } from '@/components/ui/dialog'
import { ServerOpsSchemaCellDialogContent } from './ServerOpsSchemaCellDialog'

/** 在 Radix Root 语义内静态渲染可独立验证的详情正文。 */
function renderContent(detail: ComponentProps<typeof ServerOpsSchemaCellDialogContent>['detail']): string {
  return renderToStaticMarkup(<Dialog open><ServerOpsSchemaCellDialogContent detail={detail} /></Dialog>)
}

describe('数据库单元格详情弹窗', () => {
  test('Given 有效 JSON 全文 When 打开详情 Then 提供原文、无损格式化和复制当前内容', () => {
    /** 详情投影只存在内存，不包含数据库连接凭据。 */
    const detail = { status: 'ready' as const, error: null, column: 'payload', absoluteOffset: 7,
      preview: { kind: 'text' as const, text: 'preview', truncated: true as const, sha256: 'a'.repeat(64) }, value: '{"id":90071992547409931234,"id":2}' }
    const html = renderContent(detail)
    expect(html).toContain('第 8 行')
    expect(html).toContain('原文')
    expect(html).toContain('JSON 格式化')
    expect(html).toContain('复制当前内容')
    expect(html).toContain('aria-label="单元格原文"')
  })

  test('Given 无效 JSON 或旧截断预览 When 打开详情 Then 只允许原文并明确完整性限制', () => {
    /** 无效 JSON 仍可原样查看。 */
    const invalid = { status: 'ready' as const, error: null, column: 'payload', absoluteOffset: 0, preview: '{"id":1,}', value: '{"id":1,}' }
    const invalidHtml = renderContent(invalid)
    expect(invalidHtml).toContain('不是有效 JSON')
    expect(invalidHtml).not.toContain('>JSON 格式化<')
    /** 旧预览不可被标记为完整正文。 */
    const unavailable = { status: 'unavailable' as const, error: '当前预览缺少校验摘要，无法读取完整内容', column: 'payload', absoluteOffset: 0,
      preview: { kind: 'text' as const, text: '旧预览', truncated: true as const } }
    const unavailableHtml = renderContent(unavailable)
    expect(unavailableHtml).toContain('无法读取完整内容')
    expect(unavailableHtml).toContain('当前仅显示截断预览')
  })
})
