import { describe, expect, test } from 'bun:test'
import type { CanvasNodeKind } from '@proma/shared'
import { ReactFlowProvider } from '@xyflow/react'
import { renderToStaticMarkup } from 'react-dom/server'
import { CanvasNodeCard, createCanvasNodeChildTypeSelectHandler } from './CanvasNodeCard'
import type { CanvasNodeCardProps } from './CanvasNodeCard'

/** 创建不含任何重内容读取能力的折叠卡片输入。 */
function createProps(kind: CanvasNodeKind): CanvasNodeCardProps {
  return {
    id: `${kind}-1`,
    kind,
    title: '一个需要最多显示两行的很长节点标题',
    statusLabel: '已创建',
    summary: '这是只来自画布文档的单行摘要',
    selected: kind === 'agent',
    canExpand: true,
    onExpand: () => undefined,
    onCreateChild: () => undefined,
  }
}

/** 在 XYFlow 上下文中渲染折叠节点卡片。 */
function renderCard(kind: CanvasNodeKind): string {
  return renderToStaticMarkup(
    <ReactFlowProvider>
      <CanvasNodeCard {...createProps(kind)} />
    </ReactFlowProvider>,
  )
}

/** 折叠卡片类型禁止注入内容读取函数。 */
// @ts-expect-error loadContent 不属于折叠卡片的轻量展示合同。
const propsWithLoadContent: CanvasNodeCardProps = { ...createProps('document'), loadContent: () => undefined }
/** 折叠卡片类型禁止注入消息读取函数。 */
// @ts-expect-error loadMessages 不属于折叠卡片的轻量展示合同。
const propsWithLoadMessages: CanvasNodeCardProps = { ...createProps('agent'), loadMessages: () => undefined }
/** 折叠卡片类型禁止直接携带原型 HTML 正文。 */
// @ts-expect-error html 正文只能由展开后的工作台按需读取。
const propsWithHtml: CanvasNodeCardProps = { ...createProps('webview'), html: '<main />' }

describe('Canvas 通用折叠节点卡片', () => {
  test('Given 节点侧选择文档 When 扩展 Then 同时传递源节点和目标类型', () => {
    const calls: Array<[string, CanvasNodeKind]> = []
    const handler = createCanvasNodeChildTypeSelectHandler(
      { kind: 'document', label: '文档', enabled: true },
      'source-1',
      (sourceNodeId, kind) => calls.push([sourceNodeId, kind]),
    )
    handler?.()
    expect(calls).toEqual([['source-1', 'document']])
  })

  test('Given 节点侧选择视频 When 菜单项禁用 Then 不生成选择处理器', () => {
    expect(createCanvasNodeChildTypeSelectHandler(
      { kind: 'video', label: '视频', enabled: false },
      'source-1',
      () => undefined,
    )).toBeUndefined()
  })

  test.each([
    ['agent', 'Agent'],
    ['image', '生图'],
    ['document', '文档'],
    ['webview', '原型'],
  ] as const)('Given %s 节点 When 折叠渲染 Then 显示类型和展开入口', (kind, label) => {
    const html = renderCard(kind)

    expect(html).toContain(`>${label}<`)
    expect(html).toContain(`aria-label="展开${label}工作台"`)
    expect(html).toContain('w-[288px]')
    expect(html).toContain('h-[144px]')
    expect(html).toContain('line-clamp-2')
    expect(html).toContain('truncate')
  })

  test('Given 节点允许创建下游 When 折叠渲染 Then 保留节点侧扩展入口和静态端口', () => {
    const html = renderCard('image')

    expect(html).toContain('aria-label="从此节点扩展"')
    expect(html).toContain('data-handleid="input"')
    expect(html).toContain('data-handleid="output"')
  })

  test('Given 卡片输入 When 检查公开合同 Then 不接受内容加载函数', () => {
    const props = createProps('document')
    const propNames = Object.keys(props)

    expect(propNames).not.toContain('loadContent')
    expect(propNames).not.toContain('loadMessages')
    expect(propNames).not.toContain('loadPreview')
    expect([propsWithLoadContent, propsWithLoadMessages, propsWithHtml]).toHaveLength(3)
  })
})
