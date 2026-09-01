import { describe, expect, test } from 'bun:test'
import { createEmptyCanvasDocument } from '@proma/shared'
import type { CanvasDocument, CanvasMutation } from '@proma/shared'
import { Position } from '@xyflow/react'
import {
  areNativeCanvasMutationsPositionOnly,
  coalesceNativeCanvasMutationsForSave,
  createArrangeCanvasNodesMutation,
  createMoveCanvasNodesMutation,
  createNativeCanvasUserEdge,
  createViewportCanvasMutation,
  findAvailableNativeCanvasChildPosition,
  findAvailableNativeCanvasNodePosition,
  findNativeCanvasGlobalAppendPosition,
  NATIVE_CANVAS_NODE_GAP,
  NATIVE_CANVAS_NODE_HEIGHT,
  NATIVE_CANVAS_NODE_WIDTH,
  overlapsNativeCanvasNodes,
  replayNativeCanvasPositionMutations,
  resolveNativeCanvasNodeSize,
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
      contentRevision: 3, devicePreset: 'desktop', position: { x: 7, y: 8 },
    },
  ]
  document.edges = [{
    id: 'edge-1', sourceNodeId: 'agent-1', sourcePort: 'output',
    targetNodeId: 'image-1', targetPort: 'input', relation: 'reference',
  }]
  return document
}

describe('原生 Canvas 纯投影', () => {
  test('Given 四类节点活动映射 When 投影 Then 按节点 ID 注入且未命中节点保持 idle', () => {
    const nodes = toNativeCanvasFlowNodes(createDocument(), {
      nodeIssues: [],
      runningSessionIds: new Set(),
      nodeActivityStates: new Map([
        ['agent-1', 'running'],
        ['image-1', 'queued'],
        ['doc-1', 'waiting-approval'],
      ]),
      canCreateChild: false,
      onCreateChild: () => undefined,
      onWorkbenchNodeChange: () => undefined,
    })

    expect(nodes.map((node) => [node.id, node.data.activityState])).toEqual([
      ['agent-1', 'running'],
      ['image-1', 'queued'],
      ['doc-1', 'waiting-approval'],
      ['web-1', 'idle'],
    ])
  })

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
    expect(nodes.slice(0, 3).every((node) => node.width === 288 && node.height === 144)).toBe(true)
    expect(nodes[3]).toMatchObject({ width: 384, height: 316 })
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
      status: 'idle', statusLabel: '空闲', activityState: 'idle', summary: '独立 Agent 会话',
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
      devicePreset: 'desktop',
      statusLabel: '已创建', summary: '内容版本 3',
      canOpenWorkbench: true, canCreateChild: false,
    })
    expect(serialized).not.toContain('messages')
    expect(serialized).not.toContain('messageCount')
    expect(serialized).not.toContain('relativePath')
    expect(serialized).not.toContain('data:image')
  })

  test('Given WebView 设备预设 When 计算节点几何 Then 返回稳定网页与手机卡片尺寸', () => {
    expect(resolveNativeCanvasNodeSize({ kind: 'webview', devicePreset: 'desktop' }))
      .toEqual({ width: 384, height: 316 })
    expect(resolveNativeCanvasNodeSize({ kind: 'webview', devicePreset: 'mobile' }))
      .toEqual({ width: 232, height: 578 })
    expect(resolveNativeCanvasNodeSize({ kind: 'agent' }))
      .toEqual({ width: NATIVE_CANVAS_NODE_WIDTH, height: NATIVE_CANVAS_NODE_HEIGHT })
  })

  test('Given 手机 WebView 候选 When 从视口中心新增 Then 使用候选真实尺寸居中并避让', () => {
    const position = findAvailableNativeCanvasNodePosition(
      { x: 600, y: 400 },
      [],
      { kind: 'webview', devicePreset: 'mobile' },
    )

    expect(position).toEqual({ x: 484, y: 111 })
  })

  test('Given 连续新增 14 个常规节点 When 复用当前视口锚点 Then 形成紧凑多行且不移动旧节点', () => {
    /** 模拟顶部新增逐次写入文档，每轮只寻找新节点位置。 */
    const nodes: Array<{ id: string; kind: 'agent'; position: { x: number; y: number } }> = []
    for (let order = 0; order < 14; order += 1) {
      const position = findAvailableNativeCanvasNodePosition({ x: 600, y: 400 }, nodes, { kind: 'agent' })
      nodes.push({ id: `node-${order}`, kind: 'agent', position })
    }

    expect(new Set(nodes.map((node) => node.position.y)).size).toBeGreaterThan(1)
    expect(Math.max(...nodes.map((node) => node.position.x))).toBeLessThan(1_600)
  })

  test('Given WebView 预览能力 When 投影节点 Then 注入完整预览目标、统一尺寸和设备回调', () => {
    const document = createDocument()
    const loadCanvasWebviewPreview = async (target: never) => target
    const onWebviewDevicePresetChange = () => undefined

    const node = toNativeCanvasFlowNodes(document, {
      nodeIssues: [],
      runningSessionIds: new Set(),
      canCreateChild: false,
      onCreateChild: () => undefined,
      onWorkbenchNodeChange: () => undefined,
      loadCanvasWebviewPreview,
      onWebviewDevicePresetChange,
      pendingWebviewDeviceNodeIds: new Set(['web-1']),
    } as never).find((candidate) => candidate.id === 'web-1')

    expect(node).toMatchObject({ width: 384, height: 316 })
    expect(node?.data).toMatchObject({
      nodeWidth: 384,
      nodeHeight: 316,
      webviewPreviewTarget: {
        projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'web-1',
        prototypeId: 'prototype-1', contentRevision: 3, devicePreset: 'desktop',
      },
      loadCanvasWebviewPreview,
      onWebviewDevicePresetChange,
      webviewPreviewRequestReady: false,
    })
  })

  test('Given desktop WebView 源节点 When 扩展子节点 Then 从真实右边界开始并避让动态矩形', () => {
    const nodes = [
      {
        id: 'web-1', kind: 'webview' as const, devicePreset: 'desktop' as const,
        position: { x: 100, y: 100 },
      },
      {
        id: 'blocker', kind: 'agent' as const,
        position: { x: 100 + 384 + NATIVE_CANVAS_NODE_GAP, y: 100 },
      },
    ]

    expect(findAvailableNativeCanvasChildPosition('web-1', nodes)).toEqual({
      x: 100 + 384 + NATIVE_CANVAS_NODE_GAP,
      y: 100 + NATIVE_CANVAS_NODE_HEIGHT + NATIVE_CANVAS_NODE_GAP,
    })
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

  test('Given 持久边 When 投影 Then 端口与引用语义保留并显示中文标签', () => {
    expect(toNativeCanvasFlowEdges(createDocument())).toEqual([{
      id: 'edge-1', source: 'agent-1', sourceHandle: 'output',
      target: 'image-1', targetHandle: 'input', selectable: false,
      deletable: false, focusable: false, animated: false,
      data: { relation: 'reference' }, label: '引用',
    }])
  })

  test('Given 四种语义边 When 投影 Then 显示稳定中文标签', () => {
    /** 按共享语义顺序构造四条独立边，避免标签映射遗漏。 */
    const relations = ['association', 'reference', 'depends-on', 'derives'] as const
    const document = createDocument()
    document.edges = relations.map((relation, index) => ({
      id: `edge-${index}`, sourceNodeId: 'agent-1', sourcePort: 'output',
      targetNodeId: 'image-1', targetPort: 'input', relation,
    }))

    expect(toNativeCanvasFlowEdges(document).map((edge) => [edge.data?.relation, edge.label]))
      .toEqual([
        ['association', '关联'],
        ['reference', '引用'],
        ['depends-on', '依赖'],
        ['derives', '衍生'],
      ])
  })

  test('Given 用户拖线 When 构造持久边 Then 默认语义为关联', () => {
    expect(createNativeCanvasUserEdge({
      id: 'edge-user', sourceNodeId: 'agent-1', sourcePort: 'output',
      targetNodeId: 'image-1', targetPort: 'input',
    })).toEqual({
      id: 'edge-user', sourceNodeId: 'agent-1', sourcePort: 'output',
      targetNodeId: 'image-1', targetPort: 'input', relation: 'association',
    })
  })
})

describe('原生 Canvas mutation', () => {
  test('Given 选区含运行节点 When 整理选中节点 Then 只移动空闲节点且不改关系', () => {
    const document = createDocument()
    const beforeEdges = structuredClone(document.edges)

    const mutation = createArrangeCanvasNodesMutation(
      document,
      ['agent-1', 'image-1', 'doc-1'],
      new Set(['agent-1']),
    )

    expect(mutation.positions.map((entry) => entry.nodeId).sort()).toEqual(['doc-1', 'image-1'])
    expect(mutation.positions.every((entry) => entry.nodeId !== 'agent-1')).toBeTrue()
    expect(document.edges).toEqual(beforeEdges)
  })

  test('Given 来源和衍生节点都可移动 When 整理布局 Then 保持左到右层级且结果确定', () => {
    const document = createDocument()
    document.edges[0] = { ...document.edges[0]!, relation: 'derives' }

    const first = createArrangeCanvasNodesMutation(document, ['agent-1', 'image-1'], new Set())
    const second = createArrangeCanvasNodesMutation(document, ['image-1', 'agent-1'], new Set())
    const positions = new Map(first.positions.map((entry) => [entry.nodeId, entry.position]))

    expect(positions.get('image-1')!.x).toBeGreaterThan(positions.get('agent-1')!.x)
    expect(second).toEqual(first)
  })

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

  test('Given 来源右侧多个槽位已占用 When 扩展节点 Then 使用同一右侧紧凑区域的最近空槽', () => {
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

    const position = findAvailableNativeCanvasChildPosition('source', nodes)
    expect(position).toEqual({
      x: -200 + NATIVE_CANVAS_NODE_WIDTH + NATIVE_CANVAS_NODE_GAP,
      y: 40 - (NATIVE_CANVAS_NODE_HEIGHT + NATIVE_CANVAS_NODE_GAP),
    })
    expect(overlapsNativeCanvasNodes(position, nodes)).toBe(false)
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
    ])).toEqual({ x: 668, y: 60 })
  })

  test('Given 半网格节点阻塞中心候选 When 添加 Agent Then 寻找不重叠的相邻环槽', () => {
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

    expect(position).toEqual({ x: origin.x + horizontalStep, y: origin.y - verticalStep })
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
