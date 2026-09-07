import { describe, expect, test } from 'bun:test'
import type { CanvasNode } from '@proma/shared'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  CanvasNodeWorkbenchOverlay,
  calculateCanvasWorkbenchResize,
  createCanvasWorkbenchResizeGestureController,
  resolveCanvasWorkbenchDefaultSize,
} from './CanvasNodeWorkbenchOverlay'

/** 创建四类最小节点，验证详情位置不依赖正文或执行结果。 */
function createNode(kind: CanvasNode['kind']): CanvasNode {
  const base = { id: `node-${kind}`, title: `${kind} 节点`, position: { x: 40, y: 60 } }
  if (kind === 'agent') return { ...base, kind, agentSessionId: 'session-1' }
  if (kind === 'image') return { ...base, kind, imageModuleId: 'image-module-1' }
  if (kind === 'document') return { ...base, kind, documentId: 'document-1', contentRevision: 0 }
  return { ...base, kind, prototypeId: 'prototype-1', contentRevision: 0, devicePreset: 'desktop' }
}

/** 使用当前卡片世界矩形渲染详情，默认卡片底边为 240。 */
function renderWorkbench(kind: CanvasNode['kind'], x = 40, y = 60, zoom = 1): string {
  return renderToStaticMarkup(<CanvasNodeWorkbenchOverlay
    node={createNode(kind)} dirty={false}
    nodeBounds={{ id: `node-${kind}`, x, y, width: 288, height: 180 }}
    viewport={{ x: 100, y: 80, zoom }}
    surfaceSize={{ width: 1_200, height: 800 }}
    size={{ width: 640, height: 520 }}
    onSizeChange={() => undefined} onDirtyChange={() => undefined} onClose={() => undefined}
  />)
}

describe('Canvas 节点下方详情', () => {
  test.each([
    ['agent', 'Agent'], ['image', '生图'], ['document', '文档'], ['webview', '原型'],
  ] as const)('Given %s 节点 When 展开详情 Then 固定在卡片下方且不可独立拖动', (kind, label) => {
    const html = renderWorkbench(kind)
    expect(html).toContain(`aria-label="${label}工作台"`)
    expect(html).toContain(`aria-label="收起${label}工作台"`)
    expect(html).toContain('left:40px;top:252px')
    expect(html).toContain('nodrag nopan nowheel')
    expect(html).toContain('pointer-events-auto')
    expect(html).not.toContain('cursor-move')
    expect(html).toContain('aria-label="调整工作台大小"')
  })

  test.each([
    ['agent', undefined, { width: 760, height: 640 }],
    ['image', undefined, { width: 960, height: 700 }],
    ['document', undefined, { width: 900, height: 700 }],
    ['webview', 'desktop', { width: 960, height: 720 }],
    ['webview', 'mobile', { width: 520, height: 720 }],
  ] as const)('Given %s %s 首次打开 When 解析默认尺寸 Then 保留各类内容的可读尺寸', (kind, preset, expected) => {
    const node = createNode(kind)
    if (node.kind === 'webview' && preset) node.devicePreset = preset
    expect(resolveCanvasWorkbenchDefaultSize(node)).toEqual(expected)
  })

  test('Given 卡片移动或画布缩放 When 重渲染详情 Then 仅跟随卡片世界位置而不夹回视口', () => {
    expect(renderWorkbench('image', 120, 110, 0.5)).toContain('left:120px;top:302px')
    expect(renderWorkbench('image', -700, -300, 2)).toContain('left:-700px;top:-108px')
    expect(renderWorkbench('image', 1_400, 900, 1)).toContain('left:1400px;top:1092px')
    expect(renderWorkbench('image', 40, 60, 0.5)).toContain('width:640px;height:520px')
    expect(renderWorkbench('image', 40, 60, 2)).toContain('width:640px;height:520px')
  })

  test('Given 不同尺寸的卡片 When 展开详情 Then 使用实际底边并保留固定画布间距', () => {
    const html = renderToStaticMarkup(<CanvasNodeWorkbenchOverlay
      node={createNode('webview')} dirty={false}
      nodeBounds={{ id: 'node-webview', x: 80, y: 100, width: 360, height: 640 }}
      onDirtyChange={() => undefined} onClose={() => undefined}
    />)
    expect(html).toContain('left:80px;top:752px')
  })

  test('Given 小画布与已保存的大详情 When 打开 Then 不因可视范围缩小而改写尺寸', () => {
    const html = renderToStaticMarkup(<CanvasNodeWorkbenchOverlay
      node={createNode('document')} dirty={false}
      nodeBounds={{ id: 'node-document', x: 40, y: 60, width: 288, height: 180 }}
      surfaceSize={{ width: 390, height: 600 }} size={{ width: 900, height: 700 }}
      onDirtyChange={() => undefined} onClose={() => undefined}
    />)
    expect(html).toContain('width:900px;height:700px')
  })

  test('Given 画布缩放为两倍 When 拖动尺寸手柄 Then 屏幕位移换算为画布尺寸', () => {
    expect(calculateCanvasWorkbenchResize({
      initialSize: { width: 720, height: 620 }, pointerDelta: { x: 120, y: 80 },
      canvasScale: { x: 2, y: 2 }, availableSize: { width: 2_000, height: 2_000 },
    })).toEqual({ width: 780, height: 660 })
  })

  test('Given 缩放指针连续移动 When 结束手势 Then 只提交一次最终尺寸', () => {
    const previews: Array<{ width: number; height: number }> = []
    const commits: Array<{ width: number; height: number }> = []
    const controller = createCanvasWorkbenchResizeGestureController({
      onPreview: (size) => previews.push(size), onCommit: (size) => commits.push(size),
    })
    controller.start({
      initialSize: { width: 600, height: 500 }, pointerDelta: { x: 0, y: 0 },
      canvasScale: { x: 0.5, y: 0.5 }, availableSize: { width: 2_000, height: 2_000 },
    })
    controller.move({ x: 20, y: 30 })
    controller.move({ x: 40, y: 50 })
    controller.finish()
    controller.finish()
    expect(previews).toEqual([{ width: 640, height: 560 }, { width: 680, height: 600 }])
    expect(commits).toEqual([{ width: 680, height: 600 }])
  })

  test('Given 非法缩放比例或过小尺寸 When 调整详情 Then 使用有限坐标并保留最小尺寸', () => {
    expect(calculateCanvasWorkbenchResize({
      initialSize: { width: 720, height: 620 }, pointerDelta: { x: -800, y: -800 },
      canvasScale: { x: 0, y: Number.NaN }, availableSize: { width: 2_000, height: 2_000 },
    })).toEqual({ width: 360, height: 320 })
  })
})
