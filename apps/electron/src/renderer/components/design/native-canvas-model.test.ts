import { describe, expect, test } from 'bun:test'
import { createEmptyCanvasDocument } from '@proma/shared'
import type { CanvasDocument, CanvasMutation } from '@proma/shared'
import { Position } from '@xyflow/react'
import {
  areNativeCanvasMutationsPositionOnly,
  coalesceNativeCanvasMutationsForSave,
  createMoveCanvasNodesMutation,
  createViewportCanvasMutation,
  findAvailableNativeCanvasChildPosition,
  findAvailableNativeCanvasNodePosition,
  findNativeCanvasGlobalAppendPosition,
  NATIVE_CANVAS_NODE_GAP,
  NATIVE_CANVAS_NODE_HEIGHT,
  NATIVE_CANVAS_NODE_WIDTH,
  replayNativeCanvasPositionMutations,
  toNativeCanvasFlowEdges,
  toNativeCanvasFlowNodes,
} from './native-canvas-model'

/** 创建覆盖四类持久节点的测试文档。 */
function createDocument(): CanvasDocument {
  const document = createEmptyCanvasDocument('project-1', 'canvas-1', 1)
  document.nodes = [
    { id: 'agent-1', kind: 'agent', title: '研究助手', agentSessionId: 'session-1', position: { x: 1, y: 2 } },
    {
      id: 'image-1', kind: 'image', title: '主视觉', imageModuleId: 'image-1',
      adoptedAssetId: 'asset-1', position: { x: 3, y: 4 },
    },
    {
      id: 'doc-1', kind: 'document', title: '分镜', documentId: 'document-1',
      contentRevision: 2, position: { x: 5, y: 6 },
    },
    {
      id: 'web-1', kind: 'webview', title: '原型', prototypeId: 'prototype-1',
      contentRevision: 3, position: { x: 7, y: 8 },
    },
  ]
  document.edges = [{
    id: 'edge-1', sourceNodeId: 'agent-1', sourcePort: 'output',
    targetNodeId: 'image-1', targetPort: 'input',
  }]
  return document
}

describe('原生 Canvas 纯投影', () => {
  test('Given Agent 节点存在问题和运行快照 When 投影 Then unavailable 优先且不可扩展', () => {
    const document = createDocument()
    const nodes = toNativeCanvasFlowNodes(document, {
      nodeIssues: [{
        nodeId: 'agent-1',
        code: 'AGENT_SESSION_UNAVAILABLE',
        allowedActions: ['rebuild-agent-session', 'remove-node'],
      }],
      runningSessionIds: new Set(['session-1']),
      canCreateChild: true,
      onCreateChild: () => undefined,
      onWorkbenchNodeChange: () => undefined,
    })

    expect(nodes[0]?.data).toMatchObject({
      status: 'unavailable', canOpenWorkbench: true, canCreateChild: false,
    })
    expect(nodes[0]?.data.onCreateChild).toBeUndefined()
  })

  test('Given 四类节点 When 投影 Then 只公开稳定展示字段且不携带消息或路径', () => {
    const nodes = toNativeCanvasFlowNodes(createDocument())
    const serialized = JSON.stringify(nodes)

    expect(nodes.map((node) => [node.id, node.type, node.position])).toEqual([
      ['agent-1', 'canvasAgent', { x: 1, y: 2 }],
      ['image-1', 'canvasImage', { x: 3, y: 4 }],
      ['doc-1', 'canvasDocument', { x: 5, y: 6 }],
      ['web-1', 'canvasWebview', { x: 7, y: 8 }],
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
      id: 'agent-1', kind: 'agent', title: '研究助手', agentSessionId: 'session-1',
      status: 'idle', statusLabel: '空闲', summary: '独立 Agent 会话',
      canOpenWorkbench: true, onOpenWorkbench: expect.any(Function), canCreateChild: false,
    })
    expect(nodes[1]?.data).toMatchObject({
      kind: 'image', imageModuleId: 'image-1', adoptedAssetId: 'asset-1',
      statusLabel: '已有素材', summary: '已采用画布素材',
      canOpenWorkbench: true, canCreateChild: false,
    })
    expect(nodes[2]?.data).toMatchObject({
      kind: 'document', documentId: 'document-1', contentRevision: 2,
      statusLabel: '已创建', summary: '内容版本 2',
      canOpenWorkbench: true, canCreateChild: false,
    })
    expect(nodes[3]?.data).toMatchObject({
      kind: 'webview', prototypeId: 'prototype-1', contentRevision: 3,
      statusLabel: '已创建', summary: '内容版本 3',
      canOpenWorkbench: true, canCreateChild: false,
    })
    expect(serialized).not.toContain('messages')
    expect(serialized).not.toContain('messageCount')
    expect(serialized).not.toContain('relativePath')
    expect(serialized).not.toContain('data:image')
  })

  test('Given 已采用图片素材存在工作区预览 When 投影 Then 只给匹配生图节点注入安全缩略图地址', () => {
    const document = createDocument()
    document.nodes.push({
      id: 'image-2', kind: 'image', title: '次视觉', imageModuleId: 'image-2',
      adoptedAssetId: 'asset-missing', position: { x: 9, y: 10 },
    })
    const nodes = toNativeCanvasFlowNodes(document, {
      nodeIssues: [],
      runningSessionIds: new Set(),
      canCreateChild: false,
      onCreateChild: () => undefined,
      onWorkbenchNodeChange: () => undefined,
      imagePreviews: new Map([['asset-1', {
        assetId: 'asset-1',
        previewUrl: 'proma-file://thumbnail-token/result.webp',
        width: 1600,
        height: 900,
      }]]),
    } as never)

    const imageNode = nodes.find((node) => node.id === 'image-1')
    expect(imageNode?.data).toMatchObject({
      adoptedAssetId: 'asset-1',
      previewUrl: 'proma-file://thumbnail-token/result.webp',
      nodeHeight: 210,
    })
    expect(imageNode?.height).toBe(210)
    expect(imageNode?.handles).toEqual([{
      id: 'input', type: 'target', position: Position.Left, x: 0, y: 105,
    }])
    expect(nodes.find((node) => node.id === 'image-2')?.data).not.toHaveProperty('previewUrl')
  })

  test('Given 图片比例极端或尺寸无效 When 计算节点高度 Then 限制预览高度并稳定回退', () => {
    /** 通过公开投影入口读取高度，避免测试绑定内部计算实现。 */
    const projectHeight = (width?: number, height?: number): number | undefined => {
      const preview = width !== undefined && height !== undefined
        ? new Map([['asset-1', {
            assetId: 'asset-1', previewUrl: 'proma-file://thumbnail/result.webp', width, height,
          }]])
        : new Map()
      return toNativeCanvasFlowNodes(createDocument(), {
        nodeIssues: [], runningSessionIds: new Set(), canCreateChild: false,
        onCreateChild: () => undefined, onWorkbenchNodeChange: () => undefined,
        imagePreviews: preview,
      } as never).find((node) => node.id === 'image-1')?.height
    }

    expect(projectHeight(1600, 900)).toBe(210)
    expect(projectHeight(900, 1600)).toBe(368)
    expect(projectHeight(1, 100)).toBe(368)
    expect(projectHeight(100, 1)).toBe(144)
    expect(projectHeight(0, 100)).toBe(144)
    expect(projectHeight()).toBe(144)
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
  test('Given 空画布 When 全局新增 Then 固定节点中心对齐真实画布世界中心', () => {
    expect(findNativeCanvasGlobalAppendPosition({ x: 500, y: 300 }, []))
      .toEqual({ x: 356, y: 228 })
  })

  test('Given 多列节点含负坐标 When 全局新增 Then 追加到全局最右并沿用首节点基线', () => {
    const nodes = [
      { position: { x: -200, y: 40 } },
      { position: { x: 500, y: 300 } },
      { position: { x: 20, y: -500 } },
    ]

    expect(findNativeCanvasGlobalAppendPosition({ x: -9_999, y: 9_999 }, nodes)).toEqual({
      x: 500 + NATIVE_CANVAS_NODE_WIDTH + NATIVE_CANVAS_NODE_GAP,
      y: 40,
    })
  })

  test('Given 首节点右侧列同 x 已占用 When 扩展节点 Then 沿固定列向下避让且关系落点语义不变', () => {
    const nodes = [
      { id: 'source', position: { x: -200, y: 40 } },
      {
        id: 'occupied-1',
        position: { x: -200 + NATIVE_CANVAS_NODE_WIDTH + NATIVE_CANVAS_NODE_GAP, y: 40 },
      },
      {
        id: 'occupied-2',
        position: {
          x: -200 + NATIVE_CANVAS_NODE_WIDTH + NATIVE_CANVAS_NODE_GAP,
          y: 40 + NATIVE_CANVAS_NODE_HEIGHT + NATIVE_CANVAS_NODE_GAP,
        },
      },
    ]

    expect(findAvailableNativeCanvasChildPosition('source', nodes)).toEqual({
      x: -200 + NATIVE_CANVAS_NODE_WIDTH + NATIVE_CANVAS_NODE_GAP,
      y: 40 + 2 * (NATIVE_CANVAS_NODE_HEIGHT + NATIVE_CANVAS_NODE_GAP),
    })
  })

  test('Given 源节点右侧被占用 When 计算扩展落点 Then 确定性寻找下一处不重叠位置', () => {
    const nodes = [
      { id: 'source', position: { x: 100, y: 100 } },
      {
        id: 'occupied',
        position: { x: 100 + NATIVE_CANVAS_NODE_WIDTH + NATIVE_CANVAS_NODE_GAP, y: 100 },
      },
    ]

    expect(findAvailableNativeCanvasChildPosition('source', nodes)).toEqual({
      x: 100 + NATIVE_CANVAS_NODE_WIDTH + NATIVE_CANVAS_NODE_GAP,
      y: 100 + NATIVE_CANVAS_NODE_HEIGHT + NATIVE_CANVAS_NODE_GAP,
    })
  })

  test('Given 可视中心已有节点 When 添加 Agent Then 选择不重叠的相邻位置', () => {
    const visibleCenter = { x: 500, y: 300 }
    const centeredPosition = { x: 356, y: 228 }

    expect(findAvailableNativeCanvasNodePosition(visibleCenter, []))
      .toEqual(centeredPosition)
    expect(findAvailableNativeCanvasNodePosition(visibleCenter, [
      { position: centeredPosition },
    ])).toEqual({ x: 668, y: 228 })
  })

  test('Given 半网格节点同时阻塞四个候选 When 添加 Agent Then 越过四候选并保持固定间距', () => {
    const visibleCenter = { x: 500, y: 300 }
    const origin = { x: 356, y: 228 }
    const horizontalStep = NATIVE_CANVAS_NODE_WIDTH + NATIVE_CANVAS_NODE_GAP
    const verticalStep = NATIVE_CANVAS_NODE_HEIGHT + NATIVE_CANVAS_NODE_GAP
    /** 半网格位置会同时覆盖中心、右、右下和下方四个整数网格候选。 */
    const blocker = {
      position: {
        x: origin.x + horizontalStep / 2,
        y: origin.y + verticalStep / 2,
      },
    }

    const position = findAvailableNativeCanvasNodePosition(visibleCenter, [blocker])

    expect(position).toEqual({ x: origin.x - horizontalStep, y: origin.y + verticalStep })
    expect(
      Math.abs(position.x - blocker.position.x) >= horizontalStep
      || Math.abs(position.y - blocker.position.y) >= verticalStep,
    ).toBe(true)
  })

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
