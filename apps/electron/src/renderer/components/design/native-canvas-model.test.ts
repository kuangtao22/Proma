import { describe, expect, test } from 'bun:test'
import { createEmptyCanvasDocument } from '@proma/shared'
import type { CanvasDocument, CanvasMutation } from '@proma/shared'
import { Position } from '@xyflow/react'
import {
  areNativeCanvasMutationsPositionOnly,
  coalesceNativeCanvasMutationsForSave,
  createMoveCanvasNodesMutation,
  createViewportCanvasMutation,
  replayNativeCanvasPositionMutations,
  toNativeCanvasFlowEdges,
  toNativeCanvasFlowNodes,
} from './native-canvas-model'

/** 创建覆盖四类持久节点的测试文档。 */
function createDocument(): CanvasDocument {
  const document = createEmptyCanvasDocument('project-1', 'canvas-1', 1)
  document.nodes = [
    { id: 'agent-1', kind: 'agent', title: '研究助手', agentSessionId: 'session-1', position: { x: 1, y: 2 } },
    { id: 'image-1', kind: 'image', title: '主视觉', assetId: 'asset-1', position: { x: 3, y: 4 } },
    { id: 'doc-1', kind: 'visual-document', title: '分镜', visualDocumentId: 'visual-1', position: { x: 5, y: 6 } },
    { id: 'web-1', kind: 'webview', title: '原型', url: 'https://example.com/prototype', position: { x: 7, y: 8 } },
  ]
  document.edges = [{
    id: 'edge-1', sourceNodeId: 'agent-1', sourcePort: 'output',
    targetNodeId: 'image-1', targetPort: 'input',
  }]
  return document
}

describe('原生 Canvas 纯投影', () => {
  test('Given 四类节点 When 投影 Then 只公开稳定展示字段且不携带消息或路径', () => {
    const nodes = toNativeCanvasFlowNodes(createDocument())
    const serialized = JSON.stringify(nodes)

    expect(nodes.map((node) => [node.id, node.type, node.position])).toEqual([
      ['agent-1', 'canvasAgent', { x: 1, y: 2 }],
      ['image-1', 'canvasUnsupported', { x: 3, y: 4 }],
      ['doc-1', 'canvasUnsupported', { x: 5, y: 6 }],
      ['web-1', 'canvasUnsupported', { x: 7, y: 8 }],
    ])
    expect(nodes.every((node) => node.width === 288 && node.height === 144)).toBe(true)
    expect(nodes.find((node) => node.id === 'agent-1')?.handles).toEqual([{
      id: 'output', type: 'source', position: Position.Right, x: 288, y: 72,
    }])
    expect(nodes.find((node) => node.id === 'image-1')?.handles).toEqual([{
      id: 'input', type: 'target', position: Position.Left, x: 0, y: 72,
    }])
    expect(nodes.filter((node) => node.id !== 'agent-1' && node.id !== 'image-1')
      .every((node) => node.handles?.length === 0)).toBe(true)
    expect(nodes[0]?.data).toEqual({
      id: 'agent-1', title: '研究助手', agentSessionId: 'session-1', status: 'idle',
    })
    expect(nodes[1]?.data).toMatchObject({ assetId: 'asset-1', unsupportedLabel: '当前版本暂不支持' })
    expect(nodes[2]?.data).toMatchObject({ visualDocumentId: 'visual-1', unsupportedLabel: '当前版本暂不支持' })
    expect(nodes[3]?.data).toMatchObject({ url: 'https://example.com/prototype', unsupportedLabel: '当前版本暂不支持' })
    expect(serialized).not.toContain('messages')
    expect(serialized).not.toContain('messageCount')
    expect(serialized).not.toContain('relativePath')
    expect(serialized).not.toContain('data:image')
  })

  test('Given 持久边 When 投影 Then 端口身份保留且边完全只读', () => {
    expect(toNativeCanvasFlowEdges(createDocument())).toEqual([{
      id: 'edge-1', source: 'agent-1', sourceHandle: 'output',
      target: 'image-1', targetHandle: 'input', selectable: false,
      deletable: false, focusable: false, animated: false,
    }])
  })
})

describe('原生 Canvas mutation', () => {
  test('Given 多节点拖动与视口 When 创建 mutation Then 分别形成单批位置变更', () => {
    expect(createMoveCanvasNodesMutation([
      { id: 'a', position: { x: 10, y: 20 } },
      { id: 'b', position: { x: 30, y: 40 } },
    ])).toEqual({ type: 'move-nodes', positions: [
      { nodeId: 'a', position: { x: 10, y: 20 } },
      { nodeId: 'b', position: { x: 30, y: 40 } },
    ] })
    expect(createViewportCanvasMutation({ x: 4, y: 5, zoom: 1.2 })).toEqual({
      type: 'set-viewport', viewport: { x: 4, y: 5, zoom: 1.2 },
    })
  })

  test('Given 连续视口事件 When 压缩保存批次 Then 其他 mutation 保序且最后视口置于末尾', () => {
    const mutations: CanvasMutation[] = [
      { type: 'set-viewport', viewport: { x: 1, y: 1, zoom: 1 } },
      { type: 'move-nodes', positions: [{ nodeId: 'a', position: { x: 2, y: 3 } }] },
      { type: 'set-viewport', viewport: { x: 8, y: 9, zoom: 1.5 } },
      { type: 'remove-edges', edgeIds: ['edge-1'] },
    ]

    expect(coalesceNativeCanvasMutationsForSave(mutations)).toEqual([
      { type: 'move-nodes', positions: [{ nodeId: 'a', position: { x: 2, y: 3 } }] },
      { type: 'remove-edges', edgeIds: ['edge-1'] },
      { type: 'set-viewport', viewport: { x: 8, y: 9, zoom: 1.5 } },
    ])
  })

  test('Given 权威恢复 When pending 仅位置类 Then 可按顺序重放', () => {
    const document = createDocument()
    const pending: CanvasMutation[] = [
      { type: 'move-nodes', positions: [{ nodeId: 'agent-1', position: { x: 30, y: 40 } }] },
      { type: 'set-viewport', viewport: { x: 9, y: 8, zoom: 2 } },
    ]

    expect(areNativeCanvasMutationsPositionOnly(pending)).toBe(true)
    const replayed = replayNativeCanvasPositionMutations(document, pending)
    expect(replayed.viewport).toEqual({ x: 9, y: 8, zoom: 2 })
    expect(replayed.nodes.find((node) => node.id === 'agent-1')).toMatchObject({
      id: 'agent-1', position: { x: 30, y: 40 },
    })
    expect(replayed.nodes).toHaveLength(4)
    expect(areNativeCanvasMutationsPositionOnly([
      ...pending,
      { type: 'remove-nodes', nodeIds: ['agent-1'] },
    ])).toBe(false)
  })
})
