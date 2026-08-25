import * as React from 'react'
import type { CanvasDocument, CanvasMutation } from '@proma/shared'
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
  OnMoveEnd,
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

/** 原生 Canvas Graph 组件输入。 */
export interface NativeCanvasGraphProps {
  document: CanvasDocument
  writable: boolean
  selectedNodeId: string | null
  onMutation: (mutation: CanvasMutation) => void
  onNodeSelect: (nodeId: string, conversationNodeId: string | null) => void
  flowRenderer?: NativeCanvasFlowRenderer
}

/** 实际传给 XYFlow 或无 DOM 测试 renderer 的属性。 */
export interface NativeCanvasFlowProps extends ReactFlowProps<NativeCanvasFlowNode, Edge> {
  nodes: NativeCanvasFlowNode[]
  edges: Edge[]
  onNodeDragStop: OnNodeDrag<NativeCanvasFlowNode>
  onMoveEnd: OnMoveEnd
}

/** 无 DOM 测试可注入的 Flow renderer。 */
export type NativeCanvasFlowRenderer = (props: NativeCanvasFlowProps) => React.ReactNode

/** 原生 Canvas 无限画布；逐帧拖动留在本地，结束手势才提交 mutation。 */
export function NativeCanvasGraph({
  document,
  writable,
  selectedNodeId,
  onMutation,
  onNodeSelect,
  flowRenderer,
}: NativeCanvasGraphProps): React.ReactElement {
  /** 首帧投影只使用 Canvas 文档内存数据，不读取 Agent 消息。 */
  const [flowNodes, setFlowNodes] = React.useState<NativeCanvasFlowNode[]>(() => (
    toNativeCanvasFlowNodes(document).map((node) => ({
      ...node,
      selected: node.id === selectedNodeId,
    }))
  ))

  React.useEffect(() => {
    /** 权威文档变化时同步稳定展示字段与选中态。 */
    setFlowNodes(toNativeCanvasFlowNodes(document).map((node) => ({
      ...node,
      selected: node.id === selectedNodeId,
    })))
  }, [document, selectedNodeId])

  /** 逐帧节点变化只更新组件局部状态。 */
  const handleNodesChange = React.useCallback<OnNodesChange<NativeCanvasFlowNode>>((changes) => {
    setFlowNodes((current) => applyNodeChanges(changes, current))
  }, [])

  /** 拖动结束后把多选集合合成单一 move mutation。 */
  const handleNodeDragStop = React.useCallback<OnNodeDrag<NativeCanvasFlowNode>>((_event, node, nodes) => {
    if (!writable) return
    /** XYFlow 单节点拖动可能不给多选集合，此时显式回退到当前节点。 */
    const movedNodes = nodes.length > 0 ? nodes : [node]
    onMutation(createMoveCanvasNodesMutation(movedNodes))
  }, [onMutation, writable])

  /** 视口手势结束时只提交最终 viewport。 */
  const handleMoveEnd = React.useCallback<OnMoveEnd>((_event, viewport) => {
    if (!writable) return
    onMutation(createViewportCanvasMutation(viewport))
  }, [onMutation, writable])

  /** 点击 Agent 时同时记录未来对话节点身份；其他节点只更新选中态。 */
  const handleNodeClick = React.useCallback<NonNullable<NativeCanvasFlowProps['onNodeClick']>>((_event, node) => {
    onNodeSelect(node.id, node.type === 'canvasAgent' ? node.id : null)
  }, [onNodeSelect])

  /** 受控 Flow 属性集中声明只读连线合同。 */
  const flowProps: NativeCanvasFlowProps = {
    nodes: flowNodes,
    edges: toNativeCanvasFlowEdges(document),
    nodeTypes: NATIVE_CANVAS_NODE_TYPES,
    defaultViewport: document.viewport,
    minZoom: 0.05,
    maxZoom: 8,
    onlyRenderVisibleElements: true,
    nodesDraggable: writable,
    nodesConnectable: false,
    elementsSelectable: true,
    edgesFocusable: false,
    edgesReconnectable: false,
    deleteKeyCode: null,
    onNodesChange: handleNodesChange,
    onNodeDragStop: handleNodeDragStop,
    onMoveEnd: handleMoveEnd,
    onNodeClick: handleNodeClick,
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
