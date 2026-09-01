import { describe, expect, test } from 'bun:test'
import type { CanvasNode } from '@proma/shared'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  CanvasNodeWorkbenchOverlay,
  calculateCanvasWorkbenchInitialPosition,
  calculateCanvasWorkbenchResize,
  createCanvasWorkbenchMoveGestureController,
  createCanvasWorkbenchResizeGestureController,
  resolveCanvasWorkbenchDefaultSize,
} from './CanvasNodeWorkbenchOverlay'

/** 创建四类最小节点，验证工作台壳不依赖正文或执行结果。 */
function createNode(kind: CanvasNode['kind']): CanvasNode {
  const base = { id: `node-${kind}`, title: `${kind} 节点`, position: { x: 0, y: 0 } }
  if (kind === 'agent') return { ...base, kind, agentSessionId: 'session-1' }
  if (kind === 'image') return { ...base, kind, imageModuleId: 'image-module-1' }
  if (kind === 'document') return { ...base, kind, documentId: 'document-1', contentRevision: 0 }
  return { ...base, kind, prototypeId: 'prototype-1', contentRevision: 0, devicePreset: 'desktop' }
}

describe('Canvas 节点工作台覆盖层', () => {
  test.each([
    ['agent', 'Agent'],
    ['image', '生图'],
    ['document', '文档'],
    ['webview', '原型'],
  ] as const)('Given %s 节点 When 渲染基础工作台 Then 使用稳定中文标签与锚定尺寸', (kind, label) => {
    const html = renderToStaticMarkup(
      <CanvasNodeWorkbenchOverlay
        node={createNode(kind)}
        dirty={false}
        surfaceSize={{ width: 1_200, height: 800 }}
        nodeScreenRect={{ left: 40, right: 328, top: 60 }}
        position={null}
        size={null}
        onPositionChange={() => undefined}
        onSizeChange={() => undefined}
        onDirtyChange={() => undefined}
        onClose={() => undefined}
      />,
    )

    expect(html).toContain(`aria-label="${label}工作台"`)
    expect(html).toContain(`aria-label="收起${label}工作台"`)
    expect(html).not.toContain('top-[calc(100%+8px)]')
    expect(html).toContain('absolute z-30')
    expect(html).toContain('nodrag nopan nowheel')
    expect(html).toContain('cursor-auto')
    expect(html).toContain(`data-workbench-kind="${kind}"`)
    expect(html).toContain('aria-label="调整工作台大小"')
    expect(html).toContain('cursor-se-resize')
  })

  test.each([
    ['agent', undefined, { width: 760, height: 640 }],
    ['image', undefined, { width: 960, height: 700 }],
    ['document', undefined, { width: 900, height: 700 }],
    ['webview', 'desktop', { width: 960, height: 720 }],
    ['webview', 'mobile', { width: 520, height: 720 }],
  ] as const)('Given %s %s 节点首次打开 When 解析默认尺寸 Then 使用稳定屏幕像素', (kind, preset, expected) => {
    const node = createNode(kind)
    if (node.kind === 'webview' && preset) node.devicePreset = preset
    expect(resolveCanvasWorkbenchDefaultSize(node)).toEqual(expected)
  })

  test.each([
    {
      name: '右侧空间充足',
      nodeRect: { left: 120, right: 408, top: 80 },
      surfaceSize: { width: 1_400, height: 900 },
      workbenchSize: { width: 760, height: 640 },
      expected: { x: 420, y: 80 },
    },
    {
      name: '右侧不足但左侧充足',
      nodeRect: { left: 900, right: 1_188, top: 80 },
      surfaceSize: { width: 1_400, height: 900 },
      workbenchSize: { width: 760, height: 640 },
      expected: { x: 128, y: 80 },
    },
    {
      name: '两侧都不足',
      nodeRect: { left: 300, right: 588, top: 80 },
      surfaceSize: { width: 820, height: 700 },
      workbenchSize: { width: 760, height: 640 },
      expected: { x: 30, y: 30 },
    },
  ])('Given $name When 首次选位 Then 右侧、左侧或居中且保持边距', ({ nodeRect, surfaceSize, workbenchSize, expected }) => {
    expect(calculateCanvasWorkbenchInitialPosition({ nodeRect, surfaceSize, workbenchSize })).toEqual(expected)
  })

  test('Given Canvas zoom 不同 When 使用相同屏幕指针位移缩放 Then 得到相同浮窗尺寸', () => {
    expect(calculateCanvasWorkbenchResize({
      initialSize: { width: 720, height: 620 },
      pointerDelta: { x: 120, y: 80 },
      canvasScale: { x: 2, y: 2 },
      availableSize: { width: 900, height: 760 },
    })).toEqual({ width: 840, height: 700 })
  })

  test('Given 标题栏连续拖动 When 结束手势 Then 只提交一次最终屏幕位置', () => {
    const previews: Array<{ x: number; y: number }> = []
    const commits: Array<{ x: number; y: number }> = []
    const controller = createCanvasWorkbenchMoveGestureController({
      onPreview: (position) => previews.push(position),
      onCommit: (position) => commits.push(position),
    })
    controller.start({
      initialPosition: { x: 200, y: 120 },
      workbenchSize: { width: 520, height: 600 },
      surfaceSize: { width: 1_200, height: 800 },
    })
    controller.move({ x: 40, y: 30 })
    controller.move({ x: 90, y: 70 })
    controller.finish()

    expect(previews).toEqual([{ x: 240, y: 150 }, { x: 290, y: 188 }])
    expect(commits).toEqual([{ x: 290, y: 188 }])
  })

  test('Given 缩放指针连续移动多次 When 结束手势 Then 只提交一次最终尺寸', () => {
    const previews: Array<{ width: number; height: number }> = []
    const commits: Array<{ width: number; height: number }> = []
    const controller = createCanvasWorkbenchResizeGestureController({
      onPreview: (size) => previews.push(size),
      onCommit: (size) => commits.push(size),
    })
    controller.start({
      initialSize: { width: 600, height: 500 },
      pointerDelta: { x: 0, y: 0 },
      canvasScale: { x: 1, y: 1 },
      availableSize: { width: 900, height: 800 },
    })

    controller.move({ x: 20, y: 30 })
    controller.move({ x: 40, y: 50 })
    controller.move({ x: 80, y: 90 })
    controller.finish()

    expect(previews).toEqual([
      { width: 620, height: 530 },
      { width: 640, height: 550 },
      { width: 680, height: 590 },
    ])
    expect(commits).toEqual([{ width: 680, height: 590 }])
  })

  test('Given 工作台接近画布边界 When 放大或缩小超过范围 Then 尺寸限制在可视范围和最小值内', () => {
    expect(calculateCanvasWorkbenchResize({
      initialSize: { width: 720, height: 620 },
      pointerDelta: { x: 500, y: 500 },
      canvasScale: { x: 1, y: 1 },
      availableSize: { width: 800, height: 700 },
    })).toEqual({ width: 800, height: 700 })

    expect(calculateCanvasWorkbenchResize({
      initialSize: { width: 720, height: 620 },
      pointerDelta: { x: -800, y: -800 },
      canvasScale: { x: 1, y: 1 },
      availableSize: { width: 800, height: 700 },
    })).toEqual({ width: 360, height: 320 })
  })

  test('Given 节点贴近画布边缘 When 剩余空间小于常规最小值 Then 优先收进可视区以保留缩放手柄', () => {
    expect(calculateCanvasWorkbenchResize({
      initialSize: { width: 720, height: 620 },
      pointerDelta: { x: 0, y: 0 },
      canvasScale: { x: 1, y: 1 },
      availableSize: { width: 300, height: 240 },
    })).toEqual({ width: 300, height: 240 })
  })

  test('Given Agent 工作台有对话内容 When 渲染 Then 只使用传入内容入口且不显示非 Agent 空状态', () => {
    const html = renderToStaticMarkup(
      <CanvasNodeWorkbenchOverlay
        node={createNode('agent')}
        dirty={false}
        surfaceSize={{ width: 1_200, height: 800 }}
        nodeScreenRect={{ left: 40, right: 328, top: 60 }}
        position={{ x: 340, y: 60 }}
        size={{ width: 680, height: 540 }}
        onPositionChange={() => undefined}
        onSizeChange={() => undefined}
        onDirtyChange={() => undefined}
        onClose={() => undefined}
      >
        <div data-testid="agent-conversation">对话内容</div>
      </CanvasNodeWorkbenchOverlay>,
    )

    expect(html).toContain('data-testid="agent-conversation"')
    expect(html).not.toContain('下一步：')
  })
})
