import { describe, expect, test } from 'bun:test'
import type { CanvasNodeActivityState, CanvasNodeKind } from '@proma/shared'
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
    canOpenWorkbench: true,
    onOpenWorkbench: () => undefined,
    canCreateChild: true,
    onCreateChild: () => undefined,
    onReferenceNode: () => undefined,
  }
}

/** 在 XYFlow 上下文中渲染折叠节点卡片。 */
function renderCard(
  kind: CanvasNodeKind,
  overrides: Partial<CanvasNodeCardProps> = {},
): string {
  return renderToStaticMarkup(
    <ReactFlowProvider>
      <CanvasNodeCard {...createProps(kind)} {...overrides} />
    </ReactFlowProvider>,
  )
}

/** 在 XYFlow 上下文中渲染带缩略图地址的生图卡片。 */
function renderImagePreviewCard(previewUrl?: string, nodeHeight?: number): string {
  return renderToStaticMarkup(
    <ReactFlowProvider>
      <CanvasNodeCard
        {...createProps('image')}
        {...(previewUrl ? { previewUrl } : {})}
        {...(nodeHeight ? { nodeHeight } : {})}
      />
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
  test.each([
    ['idle', false, null],
    ['queued', true, 'canvas-queued-dash'],
    ['running', true, 'canvas-running-dash'],
    ['waiting-approval', true, null],
  ] as const)('Given %s When 渲染卡片 Then 轮廓与动画符合合同', (activityState, outline, animationClass) => {
    const html = renderCard('image', { activityState })

    expect(html.includes('data-canvas-activity-outline')).toBe(outline)
    if (animationClass) expect(html).toContain(animationClass)
    else {
      expect(html).not.toContain('canvas-queued-dash')
      expect(html).not.toContain('canvas-running-dash')
    }
  })

  test('Given 节点选中且运行 When 渲染卡片 Then 选中 ring 与外层运行轮廓同时保留', () => {
    const html = renderCard('agent', { activityState: 'running', selected: true })

    expect(html).toContain('ring-2')
    expect(html).toContain('data-canvas-activity-outline')
    expect(html).toContain('pointer-events-none')
    expect(html).toContain('aria-hidden="true"')
  })

  test.each([
    ['image', 288, 210],
    ['webview', 384, 316],
  ] as const)('Given %s 使用动态尺寸且运行 When 渲染轮廓 Then SVG 跟随卡片几何', (kind, nodeWidth, nodeHeight) => {
    const activityState: CanvasNodeActivityState = 'running'
    const html = renderCard(kind, { activityState, nodeWidth, nodeHeight })

    expect(html).toContain(nodeWidth === 288 ? 'w-[288px]' : `width:${nodeWidth}px`)
    expect(html).toContain(`height:${nodeHeight}px`)
    expect(html).toContain('data-canvas-activity-outline')
    expect(html).toContain('width="100%"')
    expect(html).toContain('height="100%"')
  })

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
    expect(html).toContain('connectable')
  })

  test('Given 节点存在宿主 Agent When 折叠渲染 Then 单节点菜单提供引用到对话动作', () => {
    const html = renderCard('document')

    expect(html).toContain('aria-label="节点操作"')
    expect(html).toContain('引用到对话')
  })

  test('Given 节点不可创建下游 When 折叠渲染 Then 不显示节点侧加号但保留详情入口', () => {
    const html = renderToStaticMarkup(
      <ReactFlowProvider>
        <CanvasNodeCard {...createProps('image')} canCreateChild={false} />
      </ReactFlowProvider>,
    )

    expect(html).not.toContain('aria-label="从此节点扩展"')
    expect(html).toContain('aria-label="展开生图工作台"')
  })

  test('Given 生图节点存在安全预览地址和比例高度 When 折叠渲染 Then 完整显示图片并同步卡片高度', () => {
    const html = renderImagePreviewCard('proma-file://thumbnail-token/result.webp', 210)

    expect(html).toContain('src="proma-file://thumbnail-token/result.webp"')
    expect(html).toContain('alt="一个需要最多显示两行的很长节点标题缩略图"')
    expect(html).toContain('w-[288px]')
    expect(html).toContain('height:210px')
    expect(html).toContain('object-contain')
    expect(html).not.toContain('object-cover')
  })

  test('Given WebView 投影提供网页设备尺寸 When 折叠渲染 Then 卡片使用统一几何且承载静态预览内容', () => {
    const html = renderToStaticMarkup(
      <ReactFlowProvider>
        <CanvasNodeCard
          {...createProps('webview')}
          nodeWidth={384}
          nodeHeight={316}
        >
          <div data-webview-static-preview>静态页面</div>
        </CanvasNodeCard>
      </ReactFlowProvider>,
    )

    expect(html).toContain('width:384px')
    expect(html).toContain('height:316px')
    expect(html).toContain('data-webview-static-preview="true"')
    expect(html).not.toContain('w-[288px]')
  })

  test('Given 生图节点没有预览地址 When 折叠渲染 Then 保留原有文字回退内容且不产生破图元素', () => {
    const html = renderImagePreviewCard()

    expect(html).not.toContain('<img')
    expect(html).toContain('这是只来自画布文档的单行摘要')
    expect(html).toContain('已创建')
  })

  test('Given 生图节点展示正式采用版本 When 折叠渲染 Then 不暴露候选批次状态或入口', () => {
    const html = renderCard('image', {
      previewUrl: 'proma-file://thumbnail-token/adopted.webp',
    })

    expect(html).toContain('proma-file://thumbnail-token/adopted.webp')
    expect(html).not.toContain('有新版本')
    expect(html).not.toContain('部分完成')
    expect(html).not.toContain('aria-label="查看图片候选详情"')
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
