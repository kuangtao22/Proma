import { describe, expect, test } from 'bun:test'
import type { CanvasNode } from '@proma/shared'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  CanvasNodeWorkbenchOverlay,
  calculateCanvasWorkbenchResize,
} from './CanvasNodeWorkbenchOverlay'

/** 创建四类最小节点，验证工作台壳不依赖正文或执行结果。 */
function createNode(kind: CanvasNode['kind']): CanvasNode {
  const base = { id: `node-${kind}`, title: `${kind} 节点`, position: { x: 0, y: 0 } }
  if (kind === 'agent') return { ...base, kind, agentSessionId: 'session-1' }
  if (kind === 'image') return { ...base, kind, imageModuleId: 'image-module-1' }
  if (kind === 'document') return { ...base, kind, documentId: 'document-1', contentRevision: 0 }
  return { ...base, kind, prototypeId: 'prototype-1', contentRevision: 0 }
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
        workbenchSize={null}
        onWorkbenchSizeChange={() => undefined}
        onDirtyChange={() => undefined}
        onClose={() => undefined}
      />,
    )

    expect(html).toContain(`aria-label="${label}工作台"`)
    expect(html).toContain(`aria-label="收起${label}工作台"`)
    expect(html).toContain('top-[calc(100%+8px)]')
    expect(html).toContain('nodrag nopan nowheel')
    expect(html).toContain('cursor-auto')
    expect(html).toContain('aria-label="调整工作台大小"')
    expect(html).toContain('cursor-se-resize')
  })

  test('Given 工作台拖拽缩放 When 同时移动横纵指针 Then 按画布缩放比例更新宽高', () => {
    expect(calculateCanvasWorkbenchResize({
      initialSize: { width: 720, height: 620 },
      pointerDelta: { x: 120, y: 80 },
      canvasScale: { x: 2, y: 2 },
      availableSize: { width: 900, height: 760 },
    })).toEqual({ width: 780, height: 660 })
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
        workbenchSize={{ width: 680, height: 540 }}
        onWorkbenchSizeChange={() => undefined}
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
