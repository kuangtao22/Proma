import * as React from 'react'
import type { CanvasDocument, CanvasMutation, CanvasNodeIssue } from '@proma/shared'
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

/** 渲染生图折叠节点，不读取图片历史。 */
function NativeCanvasImageNode({ data, selected }: NodeProps<NativeCanvasImageFlowNode>): React.ReactElement {
  return <CanvasNodeCard {...data} selected={selected} />
}

/** 渲染文档折叠节点，不读取 Markdown 正文。 */
function NativeCanvasDocumentNode({ data, selected }: NodeProps<NativeCanvasDocumentFlowNode>): React.ReactElement {
  return <CanvasNodeCard {...data} selected={selected} />
}

/** 渲染原型折叠节点，不加载 HTML 或 iframe。 */
function NativeCanvasWebviewNode({ data, selected }: NodeProps<NativeCanvasWebviewFlowNode>): React.ReactElement {
  return <CanvasNodeCard {...data} selected={selected} />
}

/** 模块级稳定节点表，避免 XYFlow 在重渲染时重复注册节点组件。 */
export const NATIVE_CANVAS_NODE_TYPES = {
  canvasAgent: CanvasAgentNode,
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

/** 原生 Canvas Graph 组件输入。 */
export interface NativeCanvasGraphProps {
  document: CanvasDocument
  writable: boolean
  activeTool?: 'select' | 'pan'
  nodeIssues?: CanvasNodeIssue[]
  runningSessionIds?: ReadonlySet<string>
  canExpand?: boolean
  onExpand?: (nodeId: string) => void
  selectedNodeId: string | null
  onMutation: (mutation: CanvasMutation) => void
  /** 只同步 XYFlow 当前选区，不隐式打开 Agent 对话。 */
  onNodeSelect: (nodeId: string | null) => void
  /** 只响应显式节点点击或空白 pane 点击，控制 Agent 对话开关。 */
  onConversationNodeChange: (nodeId: string | null) => void
  /** 双击或卡片按钮只切换节点工作台，不改变图文档。 */
  onWorkbenchNodeChange?: (nodeId: string) => void
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
  canExpand = false,
  onExpand = NOOP_EXPAND,
  selectedNodeId,
  onMutation,
  onNodeSelect,
  onConversationNodeChange,
  onWorkbenchNodeChange,
  flowRenderer,
}: NativeCanvasGraphProps): React.ReactElement {
  /** 未接通工作台状态前仍渲染稳定入口，Task 8 可直接注入真实切换命令。 */
  const workbenchNodeChange = onWorkbenchNodeChange ?? NOOP_EXPAND
  /** 首帧投影只使用 Canvas 文档内存数据，不读取 Agent 消息。 */
  const [flowNodes, setFlowNodes] = React.useState<NativeCanvasFlowNode[]>(() => (
    toNativeCanvasFlowNodes(document, {
      nodeIssues,
      runningSessionIds,
      canCreateChild: writable && canExpand,
      onCreateChild: onExpand,
      onWorkbenchNodeChange: workbenchNodeChange,
    }).map((node) => ({
      ...node,
      selected: node.id === selectedNodeId,
    }))
  ))
  /** 最新局部节点用于在同一批 React 更新内连续应用 XYFlow change。 */
  const flowNodesRef = React.useRef(flowNodes)
  flowNodesRef.current = flowNodes
  /** 选中身份由 Canvas 单向管理，避免 XYFlow 派生选区再次反写形成反馈循环。 */
  const selectedNodeIdRef = React.useRef(selectedNodeId)
  selectedNodeIdRef.current = selectedNodeId
  /** 父级回调保存在 ref 中，使 onNodesChange 不因父组件渲染而改变身份。 */
  const onNodeSelectRef = React.useRef(onNodeSelect)
  onNodeSelectRef.current = onNodeSelect
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
    const nextNodes = toNativeCanvasFlowNodes(document, {
      nodeIssues,
      runningSessionIds,
      canCreateChild: writable && canExpand,
      onCreateChild: onExpand,
      onWorkbenchNodeChange: workbenchNodeChange,
    }).map((node) => ({
      ...node,
      selected: node.id === selectedNodeId,
    }))
    flowNodesRef.current = nextNodes
    setFlowNodes(nextNodes)
  }, [canExpand, document, nodeIssues, onExpand, runningSessionIds, selectedNodeId, workbenchNodeChange, writable])

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

  /** 逐帧节点变化只更新组件局部状态；用户选择 change 同步到 Canvas 单选状态。 */
  const handleNodesChange = React.useCallback<OnNodesChange<NativeCanvasFlowNode>>((changes) => {
    const nextNodes = applyNodeChanges(changes, flowNodesRef.current)
    flowNodesRef.current = nextNodes
    setFlowNodes(nextNodes)
    if (!changes.some((change) => change.type === 'select')) return
    /** 当前合同只允许一个选中节点；框选返回多个时沿用文档顺序的首个节点。 */
    const nextSelectedNodeId = nextNodes.find((node) => node.selected)?.id ?? null
    syncSelectedNodeId(nextSelectedNodeId)
  }, [syncSelectedNodeId])

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

  /** 点击 Agent 时同时记录未来对话节点身份；其他节点只更新选中态。 */
  const handleNodeClick = React.useCallback<NonNullable<NativeCanvasFlowProps['onNodeClick']>>((_event, node) => {
    if (activeTool !== 'select') return
    syncSelectedNodeId(node.id)
    onConversationNodeChange(node.type === 'canvasAgent' ? node.id : null)
  }, [activeTool, onConversationNodeChange, syncSelectedNodeId])

  /** 双击节点只打开对应工作台；普通单击语义保持选择或 Agent 对话。 */
  const handleNodeDoubleClick = React.useCallback<NonNullable<NativeCanvasFlowProps['onNodeDoubleClick']>>((_event, node) => {
    if (activeTool !== 'select') return
    syncSelectedNodeId(node.id)
    workbenchNodeChange(node.id)
  }, [activeTool, syncSelectedNodeId, workbenchNodeChange])

  /** 点击空白 pane 时立即清理选区，覆盖 XYFlow 未产生 selection change 的路径。 */
  const handlePaneClick = React.useCallback((): void => {
    if (activeTool !== 'select') return
    syncSelectedNodeId(null)
    onConversationNodeChange(null)
  }, [activeTool, onConversationNodeChange, syncSelectedNodeId])

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
