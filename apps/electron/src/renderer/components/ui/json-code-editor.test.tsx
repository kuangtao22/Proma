import { describe, expect, test } from 'bun:test'
import { EditorState } from '@codemirror/state'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  collectVisibleJsonLines,
  createJsonCodeEditorContentAttributes,
  isJsonCodeEditorLineHighlightable,
  JSON_CODE_EDITOR_CONTENT_ATTRIBUTES,
  MAX_JSON_CODE_EDITOR_HIGHLIGHT_LINE_LENGTH,
  JsonCodeEditor,
} from './json-code-editor'

describe('JsonCodeEditor', () => {
  test('Given 工作流 JSON When 服务端渲染 Then 暴露只读代码区域语义', () => {
    const html = renderToStaticMarkup(<JsonCodeEditor value={'{\n  "name": "demo"\n}'} className="test-editor" />)

    expect(html).toContain('data-json-code-editor="true"')
    expect(html).toContain('role="region"')
    expect(html).toContain('aria-label="完整工作流 JSON"')
    expect(html).toContain('test-editor')
  })

  test('Given 只读编辑器 When 挂载内容区 Then 支持聚焦选择且暴露只读状态', () => {
    expect(JSON_CODE_EDITOR_CONTENT_ATTRIBUTES).toMatchObject({
      'aria-label': '完整工作流 JSON',
      'aria-readonly': 'true',
      tabindex: '0',
    })
  })

  test('Given 业务详情提供名称 When 渲染只读编辑器 Then 根区域与内容区使用同一名称且旧默认不变', () => {
    /** 单元格详情使用的自定义无障碍名称。 */
    const ariaLabel = '单元格原文'
    const html = renderToStaticMarkup(<JsonCodeEditor value="text" ariaLabel={ariaLabel} />)
    expect(html).toContain(`aria-label="${ariaLabel}"`)
    expect(createJsonCodeEditorContentAttributes(ariaLabel)).toMatchObject({ 'aria-label': ariaLabel, 'aria-readonly': 'true' })
    expect(createJsonCodeEditorContentAttributes()).toEqual(JSON_CODE_EDITOR_CONTENT_ATTRIBUTES)
  })

  test('Given 大型 JSON When 生成高亮输入 Then 只收集可见范围覆盖的行', () => {
    const lines = Array.from({ length: 10_000 }, (_, index) => `  "node-${index}": ${index}`)
    const state = EditorState.create({ doc: `{\n${lines.join(',\n')}\n}` })
    const from = state.doc.line(5_000).from
    const to = state.doc.line(5_002).to

    const visibleLines = collectVisibleJsonLines(state, [{ from, to }])

    expect(visibleLines.map((line) => line.number)).toEqual([5_000, 5_001, 5_002])
    expect(visibleLines.map((line) => line.text)).toEqual([
      '  "node-4998": 4998,',
      '  "node-4999": 4999,',
      '  "node-5000": 5000,',
    ])
  })

  test('Given 单行内容超过高亮预算 When 判断装饰范围 Then 跳过 token 化但不裁剪正文', () => {
    /** 超长单元格原文仍完整写入 EditorState。 */
    const source = `{"body":"${'x'.repeat(MAX_JSON_CODE_EDITOR_HIGHLIGHT_LINE_LENGTH)}"}`
    const state = EditorState.create({ doc: source })
    expect(isJsonCodeEditorLineHighlightable(state.doc.line(1).text)).toBe(false)
    expect(state.doc.toString()).toBe(source)
  })
})
