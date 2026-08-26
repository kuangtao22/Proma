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
import { FileImage, FileText, Monitor } from 'lucide-react'
import { cn } from '@/lib/utils'
import { CanvasAgentNode } from './CanvasAgentNode'
import {
  createMoveCanvasNodesMutation,
  createViewportCanvasMutation,
  toNativeCanvasFlowEdges,
  toNativeCanvasFlowNodes,
} from './native-canvas-model'
import type {
  NativeCanvasFlowNode,
  NativeCanvasUnsupportedFlowNode,
} from './native-canvas-model'

/** 渲染尚未正式接入的持久节点，保留身份但不伪造能力。 */
function NativeCanvasUnsupportedNode({
  data,
  selected,
}: NodeProps<NativeCanvasUnsupportedFlowNode>): React.ReactElement {
  /** 每类占位节点使用可辨识但克制的图标。 */
  const Icon = data.kind === 'image' ? FileImage : data.kind === 'visual-document' ? FileText : Monitor
  return (
    <article
      className={cn(
        'flex h-[144px] w-[288px] flex-col overflow-hidden rounded-[8px] border bg-card px-4 py-3 text-card-foreground shadow-sm',
        selected ? 'border-primary ring-2 ring-primary/25' : 'border-border',
      )}
      aria-label={`${data.title}，${data.unsupportedLabel}`}
    >
      <div className="flex items-center gap-2 text-muted-foreground">
        <Icon className="size-4 shrink-0" aria-hidden="true" />
        <span className="text-xs font-medium">{data.kind}</span>
      </div>
      <h3 className="mt-3 line-clamp-2 overflow-hidden break-words text-sm font-medium leading-5">
        {data.title}
      </h3>
      <p className="mt-auto text-xs text-muted-foreground">{data.unsupportedLabel}</p>
    </article>
  )
}

/** 模块级稳定节点表，避免 XYFlow 在重渲染时重复注册节点组件。 */
export const NATIVE_CANVAS_NODE_TYPES = {
  canvasAgent: CanvasAgentNode,
  canvasUnsupported: NativeCanvasUnsupportedNode,
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
  /** 只响应显式节点点击或选区清空，控制 Agent 对话开关。 */
  onConversationNodeChange: (nodeId: string | null) => void
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
  flowRenderer,
}: NativeCanvasGraphProps): React.ReactElement {
  /** 首帧投影只使用 Canvas 文档内存数据，不读取 Agent 消息。 */
  const [flowNodes, setFlowNodes] = React.useState<NativeCanvasFlowNode[]>(() => (
    toNativeCanvasFlowNodes(document, {
      nodeIssues,
      runningSessionIds,
      canExpand: writable && canExpand,
      onExpand,
    }).map((node) => ({
      ...node,
      selected: node.id === selectedNodeId,
    }))
  ))
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
    setFlowNodes(toNativeCanvasFlowNodes(document, {
      nodeIssues,
      runningSessionIds,
      canExpand: writable && canExpand,
      onExpand,
    }).map((node) => ({
      ...node,
      selected: node.id === selectedNodeId,
    })))
  }, [canExpand, document, nodeIssues, onExpand, runningSessionIds, selectedNodeId, writable])

  React.useEffect(() => {
    updateViewportState({ type: 'document-sync', viewport: document.viewport })
  }, [document.viewport, updateViewportState])

  /** 逐帧节点变化只更新组件局部状态。 */
  const handleNodesChange = React.useCallback<OnNodesChange<NativeCanvasFlowNode>>((changes) => {
    setFlowNodes((current) => applyNodeChanges(changes, current))
  }, [])

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
    onNodeSelect(node.id)
    onConversationNodeChange(node.type === 'canvasAgent' ? node.id : null)
  }, [activeTool, onConversationNodeChange, onNodeSelect])

  /** XYFlow 选区变化只同步选中节点；仅在清空选区时同步关闭对话。 */
  const handleSelectionChange = React.useCallback<NonNullable<NativeCanvasFlowProps['onSelectionChange']>>(({ nodes }) => {
    /** 首个节点是单选合同下的唯一选区。 */
    const node = nodes[0]
    if (!node) {
      onNodeSelect(null)
      onConversationNodeChange(null)
      return
    }
    onNodeSelect(node.id)
  }, [onConversationNodeChange, onNodeSelect])

  /** 点击空白 pane 时立即清理选区，覆盖 XYFlow 未产生 selection change 的路径。 */
  const handlePaneClick = React.useCallback((): void => {
    if (activeTool !== 'select') return
    onNodeSelect(null)
    onConversationNodeChange(null)
  }, [activeTool, onConversationNodeChange, onNodeSelect])

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
    onSelectionChange: handleSelectionChange,
    onPaneClick: handlePaneClick,
  }

  return (
    <div className="relative h-full w-full" aria-label="Canvas 画布">
      {flowRenderer ? flowRenderer(flowProps) : (
        <ReactFlow<NativeCanvasFlowNode, Edge> {...flowProps}>
          <Background gap={24} size={1} />
          <Controls showInteractive={false} />
        </ReactFlow>
      )}
    </div>
  )
}
