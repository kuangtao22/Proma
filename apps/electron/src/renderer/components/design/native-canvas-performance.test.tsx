import { describe, expect, test } from 'bun:test'
import { createEmptyCanvasDocument } from '@proma/shared'
import type { CanvasMutation } from '@proma/shared'
import { ReactFlow } from '@xyflow/react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  NativeCanvasEdgeRelationMenu,
  NativeCanvasGraph,
  createNativeCanvasFlowEdgeProjector,
  createNativeCanvasProjectionCallbackBridge,
  createNativeCanvasTransientGeometryStore,
  reconcileNativeCanvasFlowNodes,
  reduceNativeCanvasViewportState,
} from './NativeCanvasGraph'
import type { NativeCanvasFlowProps } from './NativeCanvasGraph'
import {
  findAvailableNativeCanvasNodePosition,
  findNativeCanvasGlobalAppendPosition,
  NATIVE_CANVAS_NODE_GAP,
  NATIVE_CANVAS_NODE_HEIGHT,
  NATIVE_CANVAS_NODE_WIDTH,
  toNativeCanvasFlowEdges,
  toNativeCanvasFlowNodes,
} from './native-canvas-model'

describe('原生 Canvas 大画布性能预算', () => {
  test('Given 1,000 个四类折叠节点 When 投影 Then 纯内存完成且无边节点使用空 handles', () => {
    const document = createEmptyCanvasDocument('project-1', 'canvas-1', 1)
    document.nodes = Array.from({ length: 1_000 }, (_, index) => {
      const position = { x: (index % 40) * 320, y: Math.floor(index / 40) * 180 }
      const kindIndex = index % 4
      if (kindIndex === 0) return {
        id: `agent-${index}`, kind: 'agent' as const, title: `Agent ${index}`,
        agentSessionId: `session-${index}`, position,
      }
      if (kindIndex === 1) return {
        id: `image-${index}`, kind: 'image' as const, title: `生图 ${index}`,
        imageModuleId: `image-module-${index}`, position,
      }
      if (kindIndex === 2) return {
        id: `document-${index}`, kind: 'document' as const, title: `文档 ${index}`,
        documentId: `document-content-${index}`, contentRevision: 0, position,
      }
      return {
        id: `webview-${index}`, kind: 'webview' as const, title: `原型 ${index}`,
        prototypeId: `prototype-${index}`, contentRevision: 0, devicePreset: 'desktop' as const, position,
      }
    })

    const nodes = toNativeCanvasFlowNodes(document)

    expect(nodes).toHaveLength(1_000)
    expect(nodes.every((node) => node.handles?.length === 0)).toBe(true)
    expect(new Set(nodes.map((node) => node.type))).toEqual(new Set([
      'canvasAgent', 'canvasImage', 'canvasDocument', 'canvasWebview',
    ]))
  })

  test('Given 1,000 节点与 999 条边 When 单个图片任务状态变化 Then 只替换对应节点并复用边投影', () => {
    const document = createEmptyCanvasDocument('project-1', 'canvas-1', 1)
    document.nodes = Array.from({ length: 1_000 }, (_, index) => ({
      id: `image-${index}`,
      kind: 'image' as const,
      title: `生图 ${index}`,
      imageModuleId: `image-module-${index}`,
      position: { x: (index % 40) * 320, y: Math.floor(index / 40) * 180 },
    }))
    document.edges = Array.from({ length: 999 }, (_, index) => ({
      id: `edge-${index}`,
      sourceNodeId: `image-${index}`,
      sourcePort: 'unbound',
      targetNodeId: `image-${index + 1}`,
      targetPort: 'unbound',
      relation: 'association' as const,
    }))
    const firstCallbackCalls: string[] = []
    const latestCallbackCalls: string[] = []
    /** 模拟 Workspace 每次 render 新建行内回调，由桥接层保持节点数据入口稳定。 */
    const callbackBridge = createNativeCanvasProjectionCallbackBridge({
      onCreateChild: (nodeId) => { firstCallbackCalls.push(nodeId) },
      onReferenceNode: (nodeId) => { firstCallbackCalls.push(nodeId) },
      onWorkbenchNodeChange: (nodeId) => { firstCallbackCalls.push(nodeId) },
    })
    const stableCreateChild = callbackBridge.onCreateChild
    const stableWorkbenchNodeChange = callbackBridge.onWorkbenchNodeChange
    /** 固定投影入口，只让单个节点活动态成为两次投影的唯一数据差异。 */
    const projectionOptions = {
      nodeIssues: [],
      runningSessionIds: new Set<string>(),
      nodeActivityStates: new Map<string, 'running'>(),
      canCreateChild: false,
      onCreateChild: callbackBridge.onCreateChild,
      onReferenceNode: callbackBridge.onReferenceNode,
      onWorkbenchNodeChange: callbackBridge.onWorkbenchNodeChange,
    }
    /** 首版纯投影代表 Graph 上一次接收的权威展示字段。 */
    const previousProjection = toNativeCanvasFlowNodes(document, projectionOptions)
    /** 当前节点模拟 XYFlow 已附加局部运行状态，未变化节点应原样保留。 */
    const currentNodes = previousProjection.map((node, index) => (
      index === 500
        ? {
            ...node,
            position: { x: node.position.x + 48, y: node.position.y + 24 },
            measured: { width: node.width, height: node.height },
            dragging: true,
          }
        : index === 700 ? { ...node, dragging: true } : node
    ))
    callbackBridge.update({
      onCreateChild: (nodeId) => { latestCallbackCalls.push(nodeId) },
      onReferenceNode: (nodeId) => { latestCallbackCalls.push(nodeId) },
      onWorkbenchNodeChange: (nodeId) => { latestCallbackCalls.push(nodeId) },
    })
    const nextProjection = toNativeCanvasFlowNodes(document, {
      ...projectionOptions,
      nodeActivityStates: new Map([['image-500', 'running']]),
    })

    const nextNodes = reconcileNativeCanvasFlowNodes(
      currentNodes,
      previousProjection,
      nextProjection,
    )
    const projectEdges = createNativeCanvasFlowEdgeProjector()
    const firstEdges = projectEdges(document)
    const repeatedEdges = Array.from({ length: 100 }, () => projectEdges(document))

    /** 旧全量替换路径的对象抖动作为同夹具基线，便于与合并结果直接比较。 */
    expect(nextProjection.filter((node, index) => node !== previousProjection[index])).toHaveLength(1_000)
    expect(toNativeCanvasFlowEdges(document)).not.toBe(toNativeCanvasFlowEdges(document))

    expect(nextNodes.filter((node, index) => node !== currentNodes[index])).toHaveLength(1)
    expect(nextNodes[500]?.data.activityState).toBe('running')
    expect(nextNodes[500]?.position).toEqual(currentNodes[500]?.position)
    expect(nextNodes[500]?.measured).toEqual(currentNodes[500]?.measured)
    expect(nextNodes[500]?.dragging).toBe(true)
    expect(nextNodes[700]).toBe(currentNodes[700])
    expect(nextNodes[700]?.dragging).toBe(true)
    expect(firstEdges).toHaveLength(999)
    expect(repeatedEdges.every((edges) => edges === firstEdges)).toBe(true)
    expect(callbackBridge.onCreateChild).toBe(stableCreateChild)
    expect(callbackBridge.onWorkbenchNodeChange).toBe(stableWorkbenchNodeChange)
    callbackBridge.onCreateChild('image-500', 'image')
    callbackBridge.onReferenceNode('image-500')
    callbackBridge.onWorkbenchNodeChange('image-500')
    expect(firstCallbackCalls).toEqual([])
    expect(latestCallbackCalls).toEqual(['image-500', 'image-500', 'image-500'])

    /** 同 revision 乐观位置 mutation 会替换 nodes 数组，必须让缓存立即失效。 */
    const optimisticDocument = {
      ...document,
      nodes: document.nodes.map((node, index) => index === 10
        ? { ...node, position: { x: node.position.x + 16, y: node.position.y } }
        : node),
    }
    const optimisticEdges = projectEdges(optimisticDocument)
    const optimisticProjection = toNativeCanvasFlowNodes(optimisticDocument, projectionOptions)
    const optimisticNodes = reconcileNativeCanvasFlowNodes(
      nextNodes,
      nextProjection,
      optimisticProjection,
    )

    expect(optimisticDocument.revision).toBe(document.revision)
    expect(optimisticEdges).not.toBe(firstEdges)
    expect(optimisticNodes[10]).not.toBe(nextNodes[10])
    expect(optimisticNodes[10]?.position.x).toBe(document.nodes[10]!.position.x + 16)

    /** 同一活动节点的权威位置后来变化时，必须覆盖仍在内存里的拖动坐标。 */
    const movedActiveDocument = {
      ...document,
      nodes: document.nodes.map((node, index) => index === 500
        ? { ...node, position: { x: node.position.x + 96, y: node.position.y + 32 } }
        : node),
    }
    const movedActiveProjection = toNativeCanvasFlowNodes(movedActiveDocument, {
      ...projectionOptions,
      nodeActivityStates: new Map([['image-500', 'running']]),
    })
    const movedActiveNodes = reconcileNativeCanvasFlowNodes(
      nextNodes,
      nextProjection,
      movedActiveProjection,
    )
    expect(movedActiveNodes[500]?.position).toEqual(movedActiveDocument.nodes[500]?.position)
    expect(movedActiveNodes[500]?.measured).toEqual(currentNodes[500]?.measured)
  })

  test('Given WebView 回调每次 render 都更新 When 通过稳定桥调用 Then 使用最新预览与设备实现', async () => {
    const calls: string[] = []
    const target = {
      projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'webview-1',
      prototypeId: 'prototype-1', contentRevision: 1, devicePreset: 'desktop' as const,
    }
    const callbackBridge = createNativeCanvasProjectionCallbackBridge({
      onCreateChild: () => undefined,
      loadCanvasWebviewPreview: async () => ({ target, previewUrl: 'old', width: 1, height: 1 }),
      onWebviewDevicePresetChange: () => { calls.push('old') },
    })
    const stableLoader = callbackBridge.loadCanvasWebviewPreview
    const stableDeviceChange = callbackBridge.onWebviewDevicePresetChange
    callbackBridge.update({
      onCreateChild: () => undefined,
      loadCanvasWebviewPreview: async (nextTarget) => ({
        target: nextTarget, previewUrl: 'latest', width: 320, height: 180,
      }),
      onWebviewDevicePresetChange: (_nodeId, preset) => { calls.push(preset) },
    })

    expect(callbackBridge.loadCanvasWebviewPreview).toBe(stableLoader)
    expect(callbackBridge.onWebviewDevicePresetChange).toBe(stableDeviceChange)
    expect(await callbackBridge.loadCanvasWebviewPreview(target)).toMatchObject({ previewUrl: 'latest' })
    callbackBridge.onWebviewDevicePresetChange('webview-1', 'mobile')
    expect(calls).toEqual(['mobile'])
  })

  test('Given 1,024 个多环密集节点 When 查找落点 Then 保持固定尺寸与间距', () => {
    const visibleCenter = { x: 4_000, y: 3_000 }
    const origin = {
      x: visibleCenter.x - NATIVE_CANVAS_NODE_WIDTH / 2,
      y: visibleCenter.y - NATIVE_CANVAS_NODE_HEIGHT / 2,
    }
    const horizontalStep = NATIVE_CANVAS_NODE_WIDTH + NATIVE_CANVAS_NODE_GAP
    const verticalStep = NATIVE_CANVAS_NODE_HEIGHT + NATIVE_CANVAS_NODE_GAP
    /** 32x32 网格覆盖中心周围多个完整方形环。 */
    const nodes = Array.from({ length: 1_024 }, (_, index) => ({
      position: {
        x: origin.x + (index % 32 - 16) * horizontalStep,
        y: origin.y + (Math.floor(index / 32) - 16) * verticalStep,
      },
    }))

    const position = findAvailableNativeCanvasNodePosition(visibleCenter, nodes)

    expect(nodes.every((node) => (
      Math.abs(position.x - node.position.x) >= horizontalStep
      || Math.abs(position.y - node.position.y) >= verticalStep
    ))).toBe(true)
  })

  test('Given 节点规模翻倍 When 全局新增 Then 位置读取次数保持线性增长', () => {
    /** 统计指定规模下落点算法读取持久位置的次数。 */
    const countPositionReads = (nodeCount: number): number => {
      /** getter 只观察读取次数，不改变节点位置语义。 */
      let reads = 0
      const nodes = Array.from({ length: nodeCount }, (_, index) => {
        /** 每个节点使用独立稳定位置，避免 getter 返回新对象干扰算法。 */
        const position = { x: index * 320, y: 0 }
        return {
          get position() {
            reads += 1
            return position
          },
        }
      })
      findNativeCanvasGlobalAppendPosition({ x: 0, y: 0 }, nodes)
      return reads
    }

    /** 一千节点作为线性增长基线。 */
    const thousandReads = countPositionReads(1_000)
    /** 两千节点用于验证规模翻倍后读取次数不超线性上界。 */
    const twoThousandReads = countPositionReads(2_000)

    expect(thousandReads).toBeGreaterThanOrEqual(1_000)
    expect(twoThousandReads).toBeLessThanOrEqual(thousandReads * 2 + 2)
  })

  test('Given 1,000 节点和远端 viewport When 连续计算 20 次全局追加 Then 落点与 viewport 输入无关且文档不变', () => {
    /** 远离节点布局的持久 viewport，用于证明计算不会读写它。 */
    const distantViewport = { x: -80_000, y: 25_000, zoom: 0.2 }
    /** 固定一千节点的权威文档，连续计算期间保持不可变。 */
    const document = createEmptyCanvasDocument('project-1', 'canvas-1', 1)
    document.viewport = distantViewport
    document.nodes = Array.from({ length: 1_000 }, (_, index) => ({
      id: `node-${index}`,
      kind: 'agent' as const,
      title: `Agent ${index}`,
      position: { x: index * 312, y: 0 },
      agentSessionId: `session-${index}`,
    }))

    for (let index = 0; index < 20; index += 1) {
      /** 原点中心输入得到的非空画布全局落点。 */
      const originViewport = findNativeCanvasGlobalAppendPosition({ x: 0, y: 0 }, document.nodes)
      /** 极远中心输入得到的同一非空画布全局落点。 */
      const distantViewportPosition = findNativeCanvasGlobalAppendPosition(
        { x: 99_999, y: -99_999 },
        document.nodes,
      )
      expect(distantViewportPosition).toEqual(originViewport)
    }

    expect(document.viewport).toEqual(distantViewport)
    expect(toNativeCanvasFlowNodes(document)).toHaveLength(1_000)
    expect(toNativeCanvasFlowNodes(document).every((node) => node.handles?.length === 0)).toBe(true)
  })

  test('Given 原生 Canvas Graph When 构造 Flow Then 只渲染可见元素', () => {
    const document = createEmptyCanvasDocument('project-1', 'canvas-1', 1)
    let captured: NativeCanvasFlowProps | undefined

    renderToStaticMarkup(
      <NativeCanvasGraph
        document={document}
        writable
        selectedNodeId={null}
        onMutation={() => {}}
        onNodeSelect={() => {}}
        onConversationNodeChange={() => {}}
        flowRenderer={(props) => { captured = props; return <div /> }}
      />,
    )

    expect(captured?.onlyRenderVisibleElements).toBe(true)
    expect(Object.keys(captured?.nodeTypes ?? {}).sort()).toEqual([
      'canvasAgent', 'canvasDocument', 'canvasImage', 'canvasMedia', 'canvasWebview',
    ])
  })

  test('Given 离屏节点已有稳定尺寸 When 配置 Fit View Then 在保持可见区裁剪时纳入未测量节点', () => {
    const document = createEmptyCanvasDocument('project-1', 'canvas-1', 1)
    document.nodes = [{
      id: 'document-offscreen',
      kind: 'document',
      title: '离屏文档',
      documentId: 'document-content-offscreen',
      contentRevision: 0,
      position: { x: 10_000, y: 10_000 },
    }]
    let captured: NativeCanvasFlowProps | undefined

    renderToStaticMarkup(
      <NativeCanvasGraph
        document={document}
        writable
        selectedNodeId={null}
        onMutation={() => {}}
        onNodeSelect={() => {}}
        onConversationNodeChange={() => {}}
        flowRenderer={(props) => { captured = props; return <div /> }}
      />,
    )

    expect(captured?.nodes[0]?.width).toBe(NATIVE_CANVAS_NODE_WIDTH)
    expect(captured?.nodes[0]?.height).toBe(NATIVE_CANVAS_NODE_HEIGHT)
    expect(captured?.onlyRenderVisibleElements).toBe(true)
    expect(captured?.fitViewOptions?.includeHiddenNodes).toBe(true)
  })

  test('Given Agent 与非 Agent 折叠节点 When 单击和双击 Then 单击只选择而双击打开工作台', () => {
    const document = createEmptyCanvasDocument('project-1', 'canvas-1', 1)
    document.nodes = [
      {
        id: 'agent-1', kind: 'agent', title: '研究助手', agentSessionId: 'session-1',
        position: { x: 0, y: 0 },
      },
      {
        id: 'image-1', kind: 'image', title: '主视觉', imageModuleId: 'image-module-1',
        position: { x: 320, y: 0 },
      },
    ]
    const selected: Array<string | null> = []
    const conversations: Array<string | null> = []
    const workbenches: string[] = []
    let captured: NativeCanvasFlowProps | undefined

    renderToStaticMarkup(
      <NativeCanvasGraph
        document={document}
        writable
        selectedNodeId={null}
        onMutation={() => {}}
        onNodeSelect={(nodeId) => selected.push(nodeId)}
        onConversationNodeChange={(nodeId) => conversations.push(nodeId)}
        onWorkbenchNodeChange={(nodeId) => workbenches.push(nodeId)}
        flowRenderer={(props) => { captured = props; return <div /> }}
      />,
    )

    for (const node of captured!.nodes) captured!.onNodeClick?.({} as never, node)
    expect(selected).toEqual(['agent-1', 'image-1'])
    expect(conversations).toEqual([])
    expect(workbenches).toEqual([])

    for (const node of captured!.nodes) captured!.onNodeDoubleClick?.({} as never, node)
    expect(workbenches).toEqual(['agent-1', 'image-1'])
  })

  test('Given 框选两个节点 When XYFlow 同步选区 Then 保留完整多选集合', () => {
    const document = createEmptyCanvasDocument('project-1', 'canvas-1', 1)
    document.nodes = [
      {
        id: 'agent-1', kind: 'agent', title: 'Agent 1',
        agentSessionId: 'session-1', position: { x: 0, y: 0 },
      },
      {
        id: 'image-1', kind: 'image', title: '生图 1',
        imageModuleId: 'image-module-1', position: { x: 320, y: 0 },
      },
    ]
    const selections: string[][] = []
    let captured: NativeCanvasFlowProps | undefined

    renderToStaticMarkup(
      <NativeCanvasGraph
        document={document}
        writable
        selectedNodeId={null}
        selectedNodeIds={[]}
        onMutation={() => {}}
        onNodeSelect={() => {}}
        onNodeSelectionChange={(nodeIds) => selections.push([...nodeIds])}
        onConversationNodeChange={() => {}}
        flowRenderer={(props) => { captured = props; return <div /> }}
      />,
    )

    captured?.onNodesChange?.([
      { id: 'agent-1', type: 'select', selected: true },
      { id: 'image-1', type: 'select', selected: true },
    ])

    expect(selections).toEqual([['agent-1', 'image-1']])
  })

  test('Given 受控多选集合 When Graph 渲染 Then 每个节点都保持选中', () => {
    const document = createEmptyCanvasDocument('project-1', 'canvas-1', 1)
    document.nodes = [
      {
        id: 'agent-1', kind: 'agent', title: 'Agent 1',
        agentSessionId: 'session-1', position: { x: 0, y: 0 },
      },
      {
        id: 'image-1', kind: 'image', title: '生图 1',
        imageModuleId: 'image-module-1', position: { x: 320, y: 0 },
      },
    ]
    let captured: NativeCanvasFlowProps | undefined

    renderToStaticMarkup(
      <NativeCanvasGraph
        document={document}
        writable
        selectedNodeId="agent-1"
        selectedNodeIds={['agent-1', 'image-1']}
        onMutation={() => {}}
        onNodeSelect={() => {}}
        onNodeSelectionChange={() => {}}
        onConversationNodeChange={() => {}}
        flowRenderer={(props) => { captured = props; return <div /> }}
      />,
    )

    expect(captured?.nodes.filter((node) => node.selected).map((node) => node.id)).toEqual([
      'agent-1',
      'image-1',
    ])
  })

  test('Given 深色主题 When 渲染原生 Canvas Then 根容器进入统一设计画布主题作用域', () => {
    const document = createEmptyCanvasDocument('project-1', 'canvas-1', 1)

    const html = renderToStaticMarkup(
      <NativeCanvasGraph
        document={document}
        writable
        selectedNodeId={null}
        onMutation={() => {}}
        onNodeSelect={() => {}}
        onConversationNodeChange={() => {}}
        flowRenderer={() => <div />}
      />,
    )

    expect(html).toContain('class="design-canvas relative h-full w-full overflow-hidden"')
  })

  test('Given select 或 pan 工具 When 构造 Flow Then 手型模式保留节点选择且禁用结构编辑', () => {
    const document = createEmptyCanvasDocument('project-1', 'canvas-1', 1)
    /** 两种工具各自捕获一次 XYFlow 属性。 */
    const captured: NativeCanvasFlowProps[] = []
    for (const activeTool of ['select', 'pan'] as const) {
      renderToStaticMarkup(
        <NativeCanvasGraph
          document={document}
          writable
          activeTool={activeTool}
          selectedNodeId={null}
          onMutation={() => {}}
          onNodeSelect={() => {}}
          onConversationNodeChange={() => {}}
          flowRenderer={(props) => { captured.push(props); return <div /> }}
        />,
      )
    }

    expect(captured[0]).toMatchObject({
      nodesDraggable: true,
      elementsSelectable: true,
      panOnDrag: [1],
      panOnScroll: true,
      zoomOnScroll: false,
      zoomOnPinch: true,
      preventScrolling: true,
      selectionOnDrag: true,
    })
    expect(captured[1]).toMatchObject({
      nodesDraggable: false,
      elementsSelectable: true,
      panOnDrag: true,
      panOnScroll: true,
      zoomOnScroll: false,
      zoomOnPinch: true,
      preventScrolling: true,
      selectionOnDrag: false,
    })
  })

  test('Given 节点拖动 When 手势结束 Then 只提交一次批量 move mutation', () => {
    const document = createEmptyCanvasDocument('project-1', 'canvas-1', 1)
    document.nodes = [{
      id: 'agent-1', kind: 'agent', title: 'Agent',
      agentSessionId: 'session-1', position: { x: 0, y: 0 },
    }]
    const mutations: CanvasMutation[] = []
    let captured: NativeCanvasFlowProps | undefined
    renderToStaticMarkup(
      <NativeCanvasGraph
        document={document}
        writable
        selectedNodeId={null}
        onMutation={(mutation) => mutations.push(mutation)}
        onNodeSelect={() => {}}
        onConversationNodeChange={() => {}}
        flowRenderer={(props) => { captured = props; return <div /> }}
      />,
    )
    const dragged = { ...captured!.nodes[0]!, position: { x: 20, y: 30 } }

    captured!.onNodeDragStop({} as never, dragged, [dragged])

    expect(mutations).toEqual([{
      type: 'move-nodes', positions: [{ nodeId: 'agent-1', position: { x: 20, y: 30 } }],
    }])
  })

  test('Given 工作台已展开 When 平移缩放或拖动节点 Then 瞬时几何立即更新且不提交文档 mutation', () => {
    const document = createEmptyCanvasDocument('project-1', 'canvas-1', 1)
    document.nodes = [{
      id: 'agent-1', kind: 'agent', title: 'Agent',
      agentSessionId: 'session-1', position: { x: 10, y: 20 },
    }]
    /** 独立瞬时 Store 用于观察真实 Flow 回调产生的逐帧位置。 */
    const geometryStore = createNativeCanvasTransientGeometryStore(document)
    /** mutation 数量证明逐帧更新没有进入文档持久化链路。 */
    const mutations: CanvasMutation[] = []
    let captured: NativeCanvasFlowProps | undefined
    renderToStaticMarkup(
      <NativeCanvasGraph
        document={document}
        writable
        selectedNodeId="agent-1"
        transientGeometryStore={geometryStore}
        onMutation={(mutation) => mutations.push(mutation)}
        onNodeSelect={() => {}}
        onConversationNodeChange={() => {}}
        flowRenderer={(props) => { captured = props; return <div /> }}
      />,
    )

    captured!.onMove?.({} as never, { x: 100, y: 200, zoom: 2 })
    expect(geometryStore.getSnapshot().viewport).toEqual({ x: 100, y: 200, zoom: 2 })
    expect(geometryStore.getSnapshot().nodePositions.get('agent-1')).toEqual({ x: 10, y: 20 })

    captured!.onNodesChange?.([{
      id: 'agent-1', type: 'position', position: { x: 30, y: 40 }, dragging: true,
    }])
    expect(geometryStore.getSnapshot().nodePositions.get('agent-1')).toEqual({ x: 30, y: 40 })
    expect(mutations).toEqual([])
  })

  test('Given 可写选择工具 When 用户拖线 Then 创建默认关联边且保留边删除禁用合同', () => {
    const document = createEmptyCanvasDocument('project-1', 'canvas-1', 1)
    document.nodes = [
      { id: 'agent-1', kind: 'agent', title: 'Agent', agentSessionId: 'session-1', position: { x: 0, y: 0 } },
      {
        id: 'image-1', kind: 'image', title: 'Image', imageModuleId: 'image-1',
        adoptedAssetId: 'asset-1', position: { x: 300, y: 0 },
      },
    ]
    document.edges = [{
      id: 'edge-1', sourceNodeId: 'agent-1', sourcePort: 'out',
      targetNodeId: 'image-1', targetPort: 'in', relation: 'association',
    }]
    /** 捕获拖线提交，证明 Graph 已真实接入默认关系 helper。 */
    const mutations: CanvasMutation[] = []
    let captured: NativeCanvasFlowProps | undefined
    renderToStaticMarkup(
      <NativeCanvasGraph
        document={document}
        writable
        selectedNodeId={null}
        onMutation={(mutation) => mutations.push(mutation)}
        onNodeSelect={() => {}}
        onConversationNodeChange={() => {}}
        createEdgeId={() => 'edge-created'}
        flowRenderer={(props) => { captured = props; return <div /> }}
      />,
    )

    expect(captured).toMatchObject({
      nodesConnectable: true,
      edgesFocusable: true,
      edgesReconnectable: false,
      deleteKeyCode: null,
      onlyRenderVisibleElements: true,
    })
    expect(captured?.edges[0]).toMatchObject({
      sourceHandle: 'output', targetHandle: 'input',
      selectable: true, deletable: false, focusable: true,
    })
    expect(typeof captured?.onConnect).toBe('function')
    expect(typeof captured?.onEdgeClick).toBe('function')
    expect('onEdgesDelete' in captured!).toBe(false)

    captured!.onConnect!({
      source: 'agent-1', sourceHandle: 'output',
      target: 'image-1', targetHandle: 'input',
    })
    expect(mutations).toEqual([{
      type: 'upsert-edges',
      edges: [{
        id: 'edge-created', sourceNodeId: 'agent-1', sourcePort: 'unbound',
        targetNodeId: 'image-1', targetPort: 'unbound', relation: 'association',
      }],
    }])
  })

  test('Given 拖线已创建默认关联 When 显示语义菜单 Then 提供四种中文关系选择', () => {
    /** 菜单输入使用已经按默认 association 写入的稳定边。 */
    const document = createEmptyCanvasDocument('project-1', 'canvas-1', 1)
    document.nodes = [
      { id: 'agent-1', kind: 'agent', title: 'Agent', agentSessionId: 'session-1', position: { x: 0, y: 0 } },
      { id: 'image-1', kind: 'image', title: 'Image', imageModuleId: 'image-1', position: { x: 300, y: 0 } },
    ]
    const edge = {
      id: 'edge-1', sourceNodeId: 'agent-1', sourcePort: 'unbound',
      targetNodeId: 'image-1', targetPort: 'unbound', relation: 'association' as const,
    }
    const html = renderToStaticMarkup(
      <NativeCanvasEdgeRelationMenu edge={edge} document={document} onSelect={() => undefined} />,
    )

    expect(html).toContain('aria-label="选择连线关系"')
    expect(html).toContain('>仅关联<')
    expect(html).toContain('>引用 · 文字上下文<')
    expect(html).toContain('>依赖 · 文字上下文<')
    expect(html).toContain('>衍生 · 文字上下文<')
  })

  test('Given 关系菜单仍持有上一张画布的边 When 当前文档已切换 Then 不渲染失效菜单且不抛错', () => {
    /** 模拟画布切换后仍残留在组件局部状态中的旧边。 */
    const staleEdge = {
      id: 'edge-stale', sourceNodeId: 'agent-old', sourcePort: 'unbound',
      targetNodeId: 'image-old', targetPort: 'unbound', relation: 'reference' as const,
    }
    /** 新画布不包含旧边的任何端点。 */
    const currentDocument = createEmptyCanvasDocument('project-1', 'canvas-new', 1)

    expect(() => renderToStaticMarkup(
      <NativeCanvasEdgeRelationMenu
        edge={staleEdge}
        document={currentDocument}
        onSelect={() => undefined}
      />,
    )).not.toThrow()
    expect(renderToStaticMarkup(
      <NativeCanvasEdgeRelationMenu
        edge={staleEdge}
        document={currentDocument}
        onSelect={() => undefined}
      />,
    )).toBe('')
  })

  test('Given 持久连线 When 使用真实 ReactFlow 渲染 Then 输出可见 edge path', () => {
    const document = createEmptyCanvasDocument('project-1', 'canvas-1', 1)
    document.nodes = [
      { id: 'agent-1', kind: 'agent', title: 'Agent', agentSessionId: 'session-1', position: { x: 0, y: 0 } },
      {
        id: 'image-1', kind: 'image', title: 'Image', imageModuleId: 'image-1',
        adoptedAssetId: 'asset-1', position: { x: 360, y: 0 },
      },
    ]
    document.edges = [{
      id: 'edge-1', sourceNodeId: 'agent-1', sourcePort: 'out',
      targetNodeId: 'image-1', targetPort: 'in', relation: 'association',
    }]

    const html = renderToStaticMarkup(
      <NativeCanvasGraph
        document={document}
        writable
        selectedNodeId={null}
        onMutation={() => {}}
        onNodeSelect={() => {}}
        onConversationNodeChange={() => {}}
        flowRenderer={(props) => <ReactFlow {...props} width={1_200} height={800} />}
      />,
    )

    expect(html).toContain('react-flow__edge-path')
  })

  test('Given 远端 viewport 在手势期间更新 When 手势结束 Then 不把旧 viewport 写回', () => {
    const initial = {
      viewport: { x: 0, y: 0, zoom: 1 }, gestureActive: false, deferredViewport: null,
      documentViewport: { x: 0, y: 0, zoom: 1 },
    }
    const moving = reduceNativeCanvasViewportState(initial, { type: 'move-start' })
    const local = reduceNativeCanvasViewportState(moving, {
      type: 'move', viewport: { x: 10, y: 20, zoom: 1.5 },
    })
    const recovered = reduceNativeCanvasViewportState(local, {
      type: 'document-sync', viewport: { x: 90, y: 80, zoom: 0.8 },
    })
    const ended = reduceNativeCanvasViewportState(recovered, {
      type: 'move-end', viewport: { x: 10, y: 20, zoom: 1.5 },
    })

    expect(recovered.viewport).toEqual({ x: 10, y: 20, zoom: 1.5 })
    expect(ended).toEqual({
      viewport: { x: 90, y: 80, zoom: 0.8 }, gestureActive: false, deferredViewport: null,
      documentViewport: { x: 90, y: 80, zoom: 0.8 },
    })
  })

  test('Given 手势中仅 graph revision 更新且权威 viewport 未变 When 手势结束 Then 提交用户最终 viewport', () => {
    const initial = {
      viewport: { x: 0, y: 0, zoom: 1 }, gestureActive: false, deferredViewport: null,
      documentViewport: { x: 0, y: 0, zoom: 1 },
    }
    const moving = reduceNativeCanvasViewportState(initial, { type: 'move-start' })
    const local = reduceNativeCanvasViewportState(moving, {
      type: 'move', viewport: { x: 24, y: 36, zoom: 1.4 },
    })
    /** 图片采用等普通 graph 更新会生成新文档对象，但没有改变权威 viewport。 */
    const graphUpdated = reduceNativeCanvasViewportState(local, {
      type: 'document-sync', viewport: { x: 0, y: 0, zoom: 1 },
    })
    const ended = reduceNativeCanvasViewportState(graphUpdated, {
      type: 'move-end', viewport: { x: 24, y: 36, zoom: 1.4 },
    })

    expect(graphUpdated.deferredViewport).toBeNull()
    expect(ended).toEqual({
      viewport: { x: 24, y: 36, zoom: 1.4 }, gestureActive: false, deferredViewport: null,
      documentViewport: { x: 0, y: 0, zoom: 1 },
    })
  })

  test('Given XYFlow 产生节点选择 change When 同步单选 Then 更新选中节点但不隐式打开对话', () => {
    const document = createEmptyCanvasDocument('project-1', 'canvas-1', 1)
    document.nodes = [{
      id: 'agent-1', kind: 'agent', title: 'Agent',
      agentSessionId: 'session-1', position: { x: 0, y: 0 },
    }]
    const selected: Array<string | null> = []
    const conversations: Array<string | null> = []
    let captured: NativeCanvasFlowProps | undefined
    renderToStaticMarkup(
      <NativeCanvasGraph
        document={document}
        writable
        selectedNodeId={null}
        onMutation={() => {}}
        onNodeSelect={(nodeId) => selected.push(nodeId)}
        onConversationNodeChange={(nodeId) => conversations.push(nodeId)}
        flowRenderer={(props) => { captured = props; return <div /> }}
      />,
    )

    captured!.onNodesChange?.([{ id: 'agent-1', type: 'select', selected: true }])
    captured!.onSelectionChange?.({ nodes: captured!.nodes, edges: [] })

    expect(selected).toEqual(['agent-1'])
    expect(conversations).toEqual([])
    expect(typeof captured!.onSelectionChange).toBe('function')
  })
})
