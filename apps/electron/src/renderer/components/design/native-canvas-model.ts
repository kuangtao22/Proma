import { applyCanvasMutations } from '@proma/shared'
import type {
  CanvasDocument,
  CanvasEdge,
  CanvasMutation,
  DesignViewport,
} from '@proma/shared'
import { Position } from '@xyflow/react'
import type { Edge, Node, NodeHandle } from '@xyflow/react'
import type { CanvasAgentNodeData, CanvasAgentFlowNode } from './CanvasAgentNode'

/** 首版原生 Canvas 节点固定宽度，避免状态变化引发重排。 */
export const NATIVE_CANVAS_NODE_WIDTH = 288
/** 首版原生 Canvas 节点固定高度。 */
export const NATIVE_CANVAS_NODE_HEIGHT = 144
/** 未正式接入的节点类别统一使用简洁占位。 */
export const NATIVE_CANVAS_UNSUPPORTED_LABEL = '当前版本暂不支持'

/** 暂未接入交互的原生 Canvas 节点安全展示数据。 */
export interface NativeCanvasUnsupportedNodeData extends Record<string, unknown> {
  id: string
  kind: 'image' | 'visual-document' | 'webview'
  title: string
  unsupportedLabel: typeof NATIVE_CANVAS_UNSUPPORTED_LABEL
  assetId?: string
  visualDocumentId?: string
  url?: string
}

/** XYFlow 中的未支持节点占位类型。 */
export type NativeCanvasUnsupportedFlowNode = Node<NativeCanvasUnsupportedNodeData, 'canvasUnsupported'>
/** 原生 Canvas 当前全部 XYFlow 节点联合。 */
export type NativeCanvasFlowNode = CanvasAgentFlowNode | NativeCanvasUnsupportedFlowNode

/** 仅允许可恢复的网页地址进入 Renderer 投影，阻断文件路径与内嵌数据。 */
function projectSafeWebviewUrl(url: string): string | undefined {
  return /^https?:\/\//u.test(url) ? url : undefined
}

/** 将持久节点投影为固定尺寸且无消息读取能力的 XYFlow 节点。 */
export function toNativeCanvasFlowNodes(document: CanvasDocument): NativeCanvasFlowNode[] {
  /** 仅为真实边涉及的节点建立端口索引，避免无边大画布节点承担 handle 成本。 */
  const handlesByNodeId = new Map<string, NodeHandle[]>()
  /** 向节点追加一次静态端口；相同方向与 ID 的端口只保留一个。 */
  const appendHandle = (nodeId: string, handle: NodeHandle): void => {
    /** 当前节点已登记的静态端口。 */
    const handles = handlesByNodeId.get(nodeId) ?? []
    if (handles.some((current) => current.id === handle.id && current.type === handle.type)) return
    handles.push(handle)
    handlesByNodeId.set(nodeId, handles)
  }
  for (const edge of document.edges) {
    appendHandle(edge.sourceNodeId, {
      id: edge.sourcePort,
      type: 'source',
      position: Position.Right,
      x: NATIVE_CANVAS_NODE_WIDTH,
      y: NATIVE_CANVAS_NODE_HEIGHT / 2,
    })
    appendHandle(edge.targetNodeId, {
      id: edge.targetPort,
      type: 'target',
      position: Position.Left,
      x: 0,
      y: NATIVE_CANVAS_NODE_HEIGHT / 2,
    })
  }
  return document.nodes.map((node): NativeCanvasFlowNode => {
    /** 四类节点共享稳定布局；无边节点继续显式空 handles 以支持可见区裁剪。 */
    const base = {
      id: node.id,
      position: node.position,
      width: NATIVE_CANVAS_NODE_WIDTH,
      height: NATIVE_CANVAS_NODE_HEIGHT,
      handles: handlesByNodeId.get(node.id) ?? [],
    }
    if (node.kind === 'agent') {
      /** 当前文档只持有会话引用；在对话状态接通前采用本地空闲态。 */
      const data: CanvasAgentNodeData = {
        id: node.id,
        title: node.title,
        agentSessionId: node.agentSessionId,
        status: 'idle',
      }
      return { ...base, type: 'canvasAgent', data }
    }
    if (node.kind === 'image') {
      return {
        ...base,
        type: 'canvasUnsupported',
        data: {
          id: node.id,
          kind: node.kind,
          title: node.title,
          assetId: node.assetId,
          unsupportedLabel: NATIVE_CANVAS_UNSUPPORTED_LABEL,
        },
      }
    }
    if (node.kind === 'visual-document') {
      return {
        ...base,
        type: 'canvasUnsupported',
        data: {
          id: node.id,
          kind: node.kind,
          title: node.title,
          visualDocumentId: node.visualDocumentId,
          unsupportedLabel: NATIVE_CANVAS_UNSUPPORTED_LABEL,
        },
      }
    }
    return {
      ...base,
      type: 'canvasUnsupported',
      data: {
        id: node.id,
        kind: node.kind,
        title: node.title,
        url: projectSafeWebviewUrl(node.url),
        unsupportedLabel: NATIVE_CANVAS_UNSUPPORTED_LABEL,
      },
    }
  })
}

/** 将持久端口连线投影为完全只读的 XYFlow 边。 */
export function toNativeCanvasFlowEdges(document: CanvasDocument): Edge[] {
  return document.edges.map((edge: CanvasEdge): Edge => ({
    id: edge.id,
    source: edge.sourceNodeId,
    sourceHandle: edge.sourcePort,
    target: edge.targetNodeId,
    targetHandle: edge.targetPort,
    selectable: false,
    deletable: false,
    focusable: false,
    animated: false,
  }))
}

/** 将一次拖动中的全部节点位置合成单个 mutation。 */
export function createMoveCanvasNodesMutation(
  nodes: ReadonlyArray<Pick<NativeCanvasFlowNode, 'id' | 'position'>>,
): CanvasMutation {
  return {
    type: 'move-nodes',
    positions: nodes.map((node) => ({ nodeId: node.id, position: node.position })),
  }
}

/** 将一次视口结束事件转换为持久 mutation。 */
export function createViewportCanvasMutation(viewport: DesignViewport): CanvasMutation {
  return { type: 'set-viewport', viewport }
}

/** 保存前只保留最后一个视口 mutation，并保持所有其他 mutation 原顺序。 */
export function coalesceNativeCanvasMutationsForSave(mutations: CanvasMutation[]): CanvasMutation[] {
  /** 最后视口单独放到批次末尾，锁定 trailing debounce 的最终视觉状态。 */
  const lastViewport = mutations.findLast((mutation) => mutation.type === 'set-viewport')
  const others = mutations.filter((mutation) => mutation.type !== 'set-viewport')
  return lastViewport ? [...others, lastViewport] : others
}

/** 判断单个 mutation 是否只改变布局位置。 */
export function isNativeCanvasPositionMutation(mutation: CanvasMutation): boolean {
  return mutation.type === 'set-viewport' || mutation.type === 'move-nodes'
}

/** 判断整个待保存批次能否安全重放到恢复后的权威结构。 */
export function areNativeCanvasMutationsPositionOnly(mutations: CanvasMutation[]): boolean {
  return mutations.every(isNativeCanvasPositionMutation)
}

/** 在恢复后的权威文档上按顺序重放位置类 pending。 */
export function replayNativeCanvasPositionMutations(
  authoritativeDocument: CanvasDocument,
  mutations: CanvasMutation[],
): CanvasDocument {
  if (!areNativeCanvasMutationsPositionOnly(mutations)) return authoritativeDocument
  return applyCanvasMutations(authoritativeDocument, mutations)
}
