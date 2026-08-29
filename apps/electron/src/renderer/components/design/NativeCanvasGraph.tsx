import * as React from 'react'
import type { CanvasDocument, CanvasImagePreview, CanvasMutation, CanvasNode, CanvasNodeIssue, CanvasNodeKind } from '@proma/shared'
import {
  Background,
  Controls,
  ReactFlow,
  applyNodeChanges,
} from '@xyflow/react'
import type {
  Edge,
  NodeProps,
  NodeTypes,
  OnMove,
  OnMoveEnd,
  OnMoveStart,
  OnNodeDrag,
  OnNodesChange,
  ReactFlowProps,
} from '@xyflow/react'
import { CanvasAgentNode } from './CanvasAgentNode'
import { CanvasNodeCard } from './CanvasNodeCard'
import {
  createMoveCanvasNodesMutation,
  createViewportCanvasMutation,
  toNativeCanvasFlowEdges,
  toNativeCanvasFlowNodes,
} from './native-canvas-model'
import type {
  NativeCanvasDocumentFlowNode,
  NativeCanvasFlowNode,
  NativeCanvasImageFlowNode,
  NativeCanvasWebviewFlowNode,
} from './native-canvas-model'

/** 从节点轻量数据中读取当前唯一覆盖层；折叠节点没有该字段。 */
function getNativeCanvasNodeWorkbench(data: Record<string, unknown>): React.ReactNode {
  return React.isValidElement(data.workbench) ? data.workbench : null
}

/** 渲染 Agent 折叠节点及其可选锚定工作台。 */
function NativeCanvasAgentWorkbenchNode(props: NodeProps<Extract<NativeCanvasFlowNode, { type: 'canvasAgent' }>>): React.ReactElement {
  return (
    <div className="relative">
      <CanvasAgentNode {...props} />
      {getNativeCanvasNodeWorkbench(props.data)}
    </div>
  )
}

/** 渲染生图折叠节点，不读取图片历史。 */
function NativeCanvasImageNode({ data, selected }: NodeProps<NativeCanvasImageFlowNode>): React.ReactElement {
  return (
    <div className="relative">
      <CanvasNodeCard {...data} selected={selected} />
      {getNativeCanvasNodeWorkbench(data)}
    </div>
  )
}

/** 渲染文档折叠节点，不读取 Markdown 正文。 */
function NativeCanvasDocumentNode({ data, selected }: NodeProps<NativeCanvasDocumentFlowNode>): React.ReactElement {
  return (
    <div className="relative">
      <CanvasNodeCard {...data} selected={selected} />
      {getNativeCanvasNodeWorkbench(data)}
    </div>
  )
}

/** 渲染原型折叠节点，不加载 HTML 或 iframe。 */
function NativeCanvasWebviewNode({ data, selected }: NodeProps<NativeCanvasWebviewFlowNode>): React.ReactElement {
  return (
    <div className="relative">
      <CanvasNodeCard {...data} selected={selected} />
      {getNativeCanvasNodeWorkbench(data)}
    </div>
  )
}

/** 模块级稳定节点表，避免 XYFlow 在重渲染时重复注册节点组件。 */
export const NATIVE_CANVAS_NODE_TYPES = {
  canvasAgent: NativeCanvasAgentWorkbenchNode,
  canvasImage: NativeCanvasImageNode,
  canvasDocument: NativeCanvasDocumentNode,
  canvasWebview: NativeCanvasWebviewNode,
} satisfies NodeTypes

/** 未提供运行时问题时复用稳定空数组，避免投影 effect 每次重跑。 */
const EMPTY_CANVAS_NODE_ISSUES: CanvasNodeIssue[] = []
/** 未提供运行态时复用稳定空集合。 */
const EMPTY_RUNNING_SESSION_IDS = new Set<string>()
/** 未接通扩展命令时使用稳定空操作。 */
const NOOP_EXPAND = (): void => undefined
/** 未接通类型化扩展命令时使用稳定空操作。 */
const NOOP_CREATE_CHILD = (): void => undefined

/** 按节点权威身份构造当前工作台内容。 */
export type NativeCanvasWorkbenchRenderer = (node: CanvasNode) => React.ReactNode

/** 只给目标节点复制并注入工作台元素，其他折叠节点保持原引用。 */
function attachNativeCanvasWorkbench(
  nodes: NativeCanvasFlowNode[],
  document: CanvasDocument,
  expandedNodeId: string | null,
  renderWorkbench: NativeCanvasWorkbenchRenderer | undefined,
): NativeCanvasFlowNode[] {
  if (!expandedNodeId || !renderWorkbench) return nodes
  /** 权威文档节点决定工作台类型与内容身份。 */
  const canvasNode = document.nodes.find((node) => node.id === expandedNodeId)
  const flowNodeIndex = nodes.findIndex((node) => node.id === expandedNodeId)
  if (!canvasNode || flowNodeIndex < 0) return nodes
  const targetNode = nodes[flowNodeIndex]
  if (!targetNode) return nodes
  /** 只复制节点数组和唯一目标节点，避免展开导致全图数据对象重建。 */
  const nextNodes = [...nodes]
  nextNodes[flowNodeIndex] = {
    ...targetNode,
    data: { ...targetNode.data, workbench: renderWorkbench(canvasNode) },
  } as NativeCanvasFlowNode
  return nextNodes
}

/** 原生 Canvas Graph 组件输入。 */
export interface NativeCanvasGraphProps {
  document: CanvasDocument
  writable: boolean
  activeTool?: 'select' | 'pan'
  nodeIssues?: CanvasNodeIssue[]
  runningSessionIds?: ReadonlySet<string>
  /** Canvas 工作区一次加载得到的素材缩略图索引。 */
  imagePreviews?: ReadonlyMap<string, CanvasImagePreview>
  canCreateChild?: boolean
  onCreateChild?: (nodeId: string, kind: CanvasNodeKind) => void
  /** 单节点引用动作只传节点 ID，快照构造由 Workspace 完成。 */
  onReferenceNode?: (nodeId: string) => void
  selectedNodeId: string | null
  /** 完整受控选区；未提供时兼容旧单选调用方。 */
  selectedNodeIds?: readonly string[]
  onMutation: (mutation: CanvasMutation) => void
  /** 只同步 XYFlow 当前选区，不隐式打开 Agent 对话。 */
  onNodeSelect: (nodeId: string | null) => void
  /** 同步框选产生的完整节点集合，供批量拖动和删除使用。 */
  onNodeSelectionChange?: (nodeIds: readonly string[]) => void
  /** 只响应显式节点点击或空白 pane 点击，控制 Agent 对话开关。 */
  onConversationNodeChange: (nodeId: string | null) => void
  /** 双击或卡片按钮只切换节点工作台，不改变图文档。 */
  onWorkbenchNodeChange?: (nodeId: string) => void
  /** 当前唯一工作台节点；null 时所有节点保持折叠。 */
  expandedNodeId?: string | null
  /** 工作台内容由 Workspace 构造，Graph 只负责锚定。 */
  renderWorkbench?: NativeCanvasWorkbenchRenderer
  flowRenderer?: NativeCanvasFlowRenderer
}

/** 实际传给 XYFlow 或无 DOM 测试 renderer 的属性。 */
export interface NativeCanvasFlowProps extends ReactFlowProps<NativeCanvasFlowNode, Edge> {
  nodes: NativeCanvasFlowNode[]
  edges: Edge[]
  onNodeDragStop: OnNodeDrag<NativeCanvasFlowNode>
  onMoveEnd: OnMoveEnd
}

/** 受控 viewport 在手势期间保留远端更新，结束时优先采用权威值。 */
export interface NativeCanvasViewportState {
  viewport: CanvasDocument['viewport']
  gestureActive: boolean
  deferredViewport: CanvasDocument['viewport'] | null
}

/** viewport reducer 支持文档重渲染与手势事件按单一顺序收敛。 */
export type NativeCanvasViewportEvent =
  | { type: 'document-sync'; viewport: CanvasDocument['viewport'] }
  | { type: 'move-start' }
  | { type: 'move'; viewport: CanvasDocument['viewport'] }
  | { type: 'move-end'; viewport: CanvasDocument['viewport'] }

/** 计算下一 viewport 状态，确保恢复快照不会被迟到的本地手势覆盖。 */
export function reduceNativeCanvasViewportState(
  state: NativeCanvasViewportState,
  event: NativeCanvasViewportEvent,
): NativeCanvasViewportState {
  if (event.type === 'document-sync') {
    return state.gestureActive
      ? { ...state, deferredViewport: event.viewport }
      : { ...state, viewport: event.viewport, deferredViewport: null }
  }
  if (event.type === 'move-start') return { ...state, gestureActive: true, deferredViewport: null }
  if (event.type === 'move') return { ...state, viewport: event.viewport }
  return {
    viewport: state.deferredViewport ?? event.viewport,
    gestureActive: false,
    deferredViewport: null,
  }
}

/** 无 DOM 测试可注入的 Flow renderer。 */
export type NativeCanvasFlowRenderer = (props: NativeCanvasFlowProps) => React.ReactNode

/** 原生 Canvas 无限画布；逐帧拖动留在本地，结束手势才提交 mutation。 */
export function NativeCanvasGraph({
  document,
  writable,
  activeTool = 'select',
  nodeIssues = EMPTY_CANVAS_NODE_ISSUES,
  runningSessionIds = EMPTY_RUNNING_SESSION_IDS,
  imagePreviews,
  canCreateChild = false,
  onCreateChild = NOOP_CREATE_CHILD,
  onReferenceNode,
  selectedNodeId,
  selectedNodeIds,
  onMutation,
  onNodeSelect,
  onNodeSelectionChange,
  onConversationNodeChange,
  onWorkbenchNodeChange,
  expandedNodeId = null,
  renderWorkbench,
  flowRenderer,
}: NativeCanvasGraphProps): React.ReactElement {
  /** 旧调用方只传主节点时退化为单选集合。 */
  const controlledSelectedNodeIds = React.useMemo(
    () => selectedNodeIds ?? (selectedNodeId ? [selectedNodeId] : []),
    [selectedNodeId, selectedNodeIds],
  )
  /** 集合用于 O(1) 投影选中态，避免大画布逐节点扫描数组。 */
  const controlledSelectedNodeIdSet = React.useMemo(
    () => new Set(controlledSelectedNodeIds),
    [controlledSelectedNodeIds],
  )
  /** 未接通工作台状态前仍渲染稳定入口，Task 8 可直接注入真实切换命令。 */
  const workbenchNodeChange = onWorkbenchNodeChange ?? NOOP_EXPAND
  /** 首帧投影只使用 Canvas 文档内存数据，不读取 Agent 消息。 */
  const [flowNodes, setFlowNodes] = React.useState<NativeCanvasFlowNode[]>(() => (
    attachNativeCanvasWorkbench(toNativeCanvasFlowNodes(document, {
      nodeIssues,
      runningSessionIds,
      imagePreviews,
      canCreateChild: writable && canCreateChild,
      onCreateChild,
      onReferenceNode,
      onWorkbenchNodeChange: workbenchNodeChange,
    }).map((node) => ({
      ...node,
      selected: controlledSelectedNodeIdSet.has(node.id),
    })), document, expandedNodeId, renderWorkbench)
  ))
  /** 最新局部节点用于在同一批 React 更新内连续应用 XYFlow change。 */
  const flowNodesRef = React.useRef(flowNodes)
  flowNodesRef.current = flowNodes
  /** 选中身份由 Canvas 单向管理，避免 XYFlow 派生选区再次反写形成反馈循环。 */
  const selectedNodeIdRef = React.useRef(selectedNodeId)
  selectedNodeIdRef.current = selectedNodeId
  /** 完整选区镜像避免连续 selection change 受 React 批处理时序影响。 */
  const selectedNodeIdsRef = React.useRef<readonly string[]>(controlledSelectedNodeIds)
  selectedNodeIdsRef.current = controlledSelectedNodeIds
  /** 父级回调保存在 ref 中，使 onNodesChange 不因父组件渲染而改变身份。 */
  const onNodeSelectRef = React.useRef(onNodeSelect)
  onNodeSelectRef.current = onNodeSelect
  /** 多选回调同样使用 ref，保持 XYFlow handler 身份稳定。 */
  const onNodeSelectionChangeRef = React.useRef(onNodeSelectionChange)
  onNodeSelectionChangeRef.current = onNodeSelectionChange
  /** viewport reducer 让挂载后的远端文档更新实际同步给 XYFlow。 */
  const [viewportState, setViewportState] = React.useState<NativeCanvasViewportState>({
    viewport: document.viewport,
    gestureActive: false,
    deferredViewport: null,
  })
  /** 同步镜像供结束回调判断手势中是否收到了权威 viewport。 */
  const viewportStateRef = React.useRef(viewportState)
  viewportStateRef.current = viewportState
  /** 同步推进 ref 与 React 状态，避免连续 XYFlow 事件受批处理时序影响。 */
  const updateViewportState = React.useCallback((event: NativeCanvasViewportEvent): NativeCanvasViewportState => {
    /** 基于最近一次事件结果而非最近一次 React render 计算下一状态。 */
    const nextState = reduceNativeCanvasViewportState(viewportStateRef.current, event)
    viewportStateRef.current = nextState
    setViewportState(nextState)
    return nextState
  }, [])

  React.useEffect(() => {
    /** 权威文档变化时同步稳定展示字段与选中态。 */
    const nextNodes = attachNativeCanvasWorkbench(toNativeCanvasFlowNodes(document, {
      nodeIssues,
      runningSessionIds,
      imagePreviews,
      canCreateChild: writable && canCreateChild,
      onCreateChild,
      onReferenceNode,
      onWorkbenchNodeChange: workbenchNodeChange,
    }).map((node) => ({
      ...node,
      selected: controlledSelectedNodeIdSet.has(node.id),
    })), document, expandedNodeId, renderWorkbench)
    flowNodesRef.current = nextNodes
    setFlowNodes(nextNodes)
  }, [canCreateChild, controlledSelectedNodeIdSet, document, expandedNodeId, imagePreviews, nodeIssues, onCreateChild, onReferenceNode, renderWorkbench, runningSessionIds, workbenchNodeChange, writable])

  React.useEffect(() => {
    updateViewportState({ type: 'document-sync', viewport: document.viewport })
  }, [document.viewport, updateViewportState])

  /**
   * 同步 Canvas 的单一选中身份。
   * @param nodeId 用户交互产生的新选中节点；null 表示清空。
   * @returns 无返回值；相同身份不会重复写入 Jotai。
   */
  const syncSelectedNodeId = React.useCallback((nodeId: string | null): void => {
    if (selectedNodeIdRef.current === nodeId) return
    selectedNodeIdRef.current = nodeId
    onNodeSelectRef.current(nodeId)
  }, [])

  /**
   * 同步完整节点选区，并把首个节点继续作为详情兼容主选中节点。
   * @param nodeIds XYFlow 当前全部选中节点 ID。
   * @returns 无返回值；集合未变化时不触发父级更新。
   */
  const syncSelectedNodeIds = React.useCallback((nodeIds: readonly string[]): void => {
    const current = selectedNodeIdsRef.current
    if (current.length === nodeIds.length
      && current.every((nodeId, index) => nodeId === nodeIds[index])) return
    selectedNodeIdsRef.current = nodeIds
    onNodeSelectionChangeRef.current?.(nodeIds)
    syncSelectedNodeId(nodeIds[0] ?? null)
  }, [syncSelectedNodeId])

  /** 逐帧节点变化只更新组件局部状态；用户选择 change 同步完整 Canvas 选区。 */
  const handleNodesChange = React.useCallback<OnNodesChange<NativeCanvasFlowNode>>((changes) => {
    const nextNodes = applyNodeChanges(changes, flowNodesRef.current)
    flowNodesRef.current = nextNodes
    setFlowNodes(nextNodes)
    if (!changes.some((change) => change.type === 'select')) return
    /** 按文档稳定顺序保留所有选中节点，避免框选被压缩成单选。 */
    const nextSelectedNodeIds = nextNodes.filter((node) => node.selected).map((node) => node.id)
    syncSelectedNodeIds(nextSelectedNodeIds)
  }, [syncSelectedNodeIds])

  /** 拖动结束后把多选集合合成单一 move mutation。 */
  const handleNodeDragStop = React.useCallback<OnNodeDrag<NativeCanvasFlowNode>>((_event, node, nodes) => {
    if (!writable || activeTool !== 'select') return
    /** XYFlow 单节点拖动可能不给多选集合，此时显式回退到当前节点。 */
    const movedNodes = nodes.length > 0 ? nodes : [node]
    onMutation(createMoveCanvasNodesMutation(movedNodes))
  }, [activeTool, onMutation, writable])

  /** 视口手势开始后暂缓远端 viewport 覆盖本地逐帧反馈。 */
  const handleMoveStart = React.useCallback<OnMoveStart>(() => {
    updateViewportState({ type: 'move-start' })
  }, [updateViewportState])

  /** 视口逐帧变化只更新组件局部受控值。 */
  const handleMove = React.useCallback<OnMove>((_event, viewport) => {
    updateViewportState({ type: 'move', viewport })
  }, [updateViewportState])

  /** 视口手势结束时只提交最终 viewport；权威更新在途时直接采用远端且不回写旧值。 */
  const handleMoveEnd = React.useCallback<OnMoveEnd>((_event, viewport) => {
    /** 手势中收到的远端 viewport 优先级高于本地结束事件。 */
    const hasDeferredViewport = viewportStateRef.current.deferredViewport !== null
    updateViewportState({ type: 'move-end', viewport })
    if (!writable) return
    if (hasDeferredViewport) return
    onMutation(createViewportCanvasMutation(viewport))
  }, [onMutation, updateViewportState, writable])

  /** 普通节点单击只更新选中态，不隐式打开旧对话或工作台。 */
  const handleNodeClick = React.useCallback<NonNullable<NativeCanvasFlowProps['onNodeClick']>>((_event, node) => {
    if (activeTool !== 'select') return
    syncSelectedNodeIds([node.id])
  }, [activeTool, syncSelectedNodeIds])

  /** 双击节点只打开对应工作台；普通单击始终只选择节点。 */
  const handleNodeDoubleClick = React.useCallback<NonNullable<NativeCanvasFlowProps['onNodeDoubleClick']>>((_event, node) => {
    if (activeTool !== 'select') return
    syncSelectedNodeIds([node.id])
    workbenchNodeChange(node.id)
  }, [activeTool, syncSelectedNodeIds, workbenchNodeChange])

  /** 点击空白 pane 时立即清理选区，覆盖 XYFlow 未产生 selection change 的路径。 */
  const handlePaneClick = React.useCallback((): void => {
    if (activeTool !== 'select') return
    syncSelectedNodeIds([])
    onConversationNodeChange(null)
  }, [activeTool, onConversationNodeChange, syncSelectedNodeIds])

  /** 受控 Flow 属性集中声明只读连线合同。 */
  const flowProps: NativeCanvasFlowProps = {
    nodes: flowNodes,
    edges: toNativeCanvasFlowEdges(document),
    nodeTypes: NATIVE_CANVAS_NODE_TYPES,
    viewport: viewportState.viewport,
    minZoom: 0.05,
    maxZoom: 8,
    onlyRenderVisibleElements: true,
    nodesDraggable: writable && activeTool === 'select',
    nodesConnectable: false,
    elementsSelectable: activeTool === 'select',
    panOnDrag: activeTool === 'pan' ? true : [1],
    selectionOnDrag: activeTool === 'select',
    multiSelectionKeyCode: null,
    edgesFocusable: false,
    edgesReconnectable: false,
    deleteKeyCode: null,
    onNodesChange: handleNodesChange,
    onNodeDragStop: handleNodeDragStop,
    onMoveStart: handleMoveStart,
    onMove: handleMove,
    onMoveEnd: handleMoveEnd,
    onNodeClick: handleNodeClick,
    onNodeDoubleClick: handleNodeDoubleClick,
    onPaneClick: handlePaneClick,
  }

  return (
    <div className="design-canvas relative h-full w-full" aria-label="Canvas 画布">
      {flowRenderer ? flowRenderer(flowProps) : (
        <ReactFlow<NativeCanvasFlowNode, Edge> {...flowProps}>
          <Background gap={24} size={1} />
          <Controls showInteractive={false} />
        </ReactFlow>
      )}
    </div>
  )
}
