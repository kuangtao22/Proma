import { describe, expect, test } from 'bun:test'
import { createEmptyCanvasDocument } from '@proma/shared'
import type { CanvasMutation } from '@proma/shared'
import { ReactFlow } from '@xyflow/react'
import { renderToStaticMarkup } from 'react-dom/server'
import { NativeCanvasGraph, reduceNativeCanvasViewportState } from './NativeCanvasGraph'
import type { NativeCanvasFlowProps } from './NativeCanvasGraph'
import {
  createNativeCanvasNodeRevealViewport,
  findAvailableNativeCanvasNodePosition,
  NATIVE_CANVAS_NODE_GAP,
  NATIVE_CANVAS_NODE_HEIGHT,
  NATIVE_CANVAS_NODE_WIDTH,
  toNativeCanvasFlowNodes,
} from './native-canvas-model'

describe('原生 Canvas 大画布性能预算', () => {
  test('Given 1,000 个 Agent 节点 When 投影 Then 纯内存完成且 API 不接受消息读取器', () => {
    const document = createEmptyCanvasDocument('project-1', 'canvas-1', 1)
    document.nodes = Array.from({ length: 1_000 }, (_, index) => ({
      id: `agent-${index}`,
      kind: 'agent' as const,
      title: `Agent ${index}`,
      agentSessionId: `session-${index}`,
      position: { x: (index % 40) * 320, y: Math.floor(index / 40) * 180 },
    }))

    const nodes = toNativeCanvasFlowNodes(document)

    expect(nodes).toHaveLength(1_000)
    expect(nodes.every((node) => node.handles?.length === 0)).toBe(true)
    expect(toNativeCanvasFlowNodes.length).toBe(1)
  })

  test('Given 1,024 个多环密集节点 When 查找落点 Then 在宽松预算内保持固定尺寸与间距', () => {
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

    const startedAt = performance.now()
    const position = findAvailableNativeCanvasNodePosition(visibleCenter, nodes)
    const elapsedMs = performance.now() - startedAt

    expect(nodes.every((node) => (
      Math.abs(position.x - node.position.x) >= horizontalStep
      || Math.abs(position.y - node.position.y) >= verticalStep
    ))).toBe(true)
    /** 预算刻意宽松，只锁定算法没有退化到不可交互级别。 */
    expect(elapsedMs).toBeLessThan(2_000)
  })

  test('Given 对话面板裁掉选中节点 When 计算可见 viewport Then 保持缩放并把节点移回画布中心', () => {
    const viewport = createNativeCanvasNodeRevealViewport(
      { x: 400, y: 300 },
      { x: 0, y: 0, zoom: 1 },
      { width: 360, height: 600 },
    )

    expect(viewport).toEqual({ x: -364, y: -72, zoom: 1 })
  })

  test('Given 节点完整位于收窄画布 When 计算可见 viewport Then 不制造额外保存', () => {
    const viewport = createNativeCanvasNodeRevealViewport(
      { x: 40, y: 80 },
      { x: 0, y: 0, zoom: 1 },
      { width: 800, height: 600 },
    )

    expect(viewport).toBeNull()
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

    expect(html).toContain('class="design-canvas relative h-full w-full"')
  })

  test('Given select 或 pan 工具 When 构造 Flow Then 交互配置互斥且布局稳定', () => {
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
      selectionOnDrag: true,
    })
    expect(captured[1]).toMatchObject({
      nodesDraggable: false,
      elementsSelectable: false,
      panOnDrag: true,
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

  test('Given 持久连线 When 构造 Flow props Then 禁止连线、删除与边交互', () => {
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
      targetNodeId: 'image-1', targetPort: 'in',
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

    expect(captured).toMatchObject({
      nodesConnectable: false,
      edgesFocusable: false,
      edgesReconnectable: false,
      deleteKeyCode: null,
      onlyRenderVisibleElements: true,
    })
    expect(captured?.edges[0]).toMatchObject({ selectable: false, deletable: false, focusable: false })
    expect('onConnect' in captured!).toBe(false)
    expect('onEdgesDelete' in captured!).toBe(false)
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
      targetNodeId: 'image-1', targetPort: 'in',
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
    })
  })

  test('Given Agent 点击后收到迟到空选区 When 用户未点击空白处 Then 保持对话直到显式 pane 点击', () => {
    const document = createEmptyCanvasDocument('project-1', 'canvas-1', 1)
    document.nodes = [{
      id: 'agent-1', kind: 'agent', title: 'Agent',
      agentSessionId: 'session-1', position: { x: 0, y: 0 },
    }]
    const selected: Array<string | null> = []
    const conversations: Array<string | null> = []
    const mutations: CanvasMutation[] = []
    let captured: NativeCanvasFlowProps | undefined
    renderToStaticMarkup(
      <NativeCanvasGraph
        document={document}
        writable
        selectedNodeId={null}
        onMutation={(mutation) => mutations.push(mutation)}
        onNodeSelect={(nodeId) => selected.push(nodeId)}
        onConversationNodeChange={(nodeId) => conversations.push(nodeId)}
        flowRenderer={(props) => { captured = props; return <div /> }}
      />,
    )

    captured!.onNodeClick?.({} as never, captured!.nodes[0]!)
    captured!.onMoveEnd(null, { x: 4, y: 5, zoom: 1.2 })

    expect(selected).toEqual(['agent-1'])
    expect(conversations).toEqual(['agent-1'])
    expect(captured!.onSelectionChange).toBeUndefined()
    captured!.onPaneClick?.({} as never)

    expect(selected).toEqual(['agent-1', null])
    expect(conversations).toEqual(['agent-1', null])
    expect(mutations).toEqual([{
      type: 'set-viewport', viewport: { x: 4, y: 5, zoom: 1.2 },
    }])
    expect(captured?.multiSelectionKeyCode).toBeNull()
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

    expect(selected).toEqual(['agent-1'])
    expect(conversations).toEqual([])
    expect(captured!.onSelectionChange).toBeUndefined()
  })
})
