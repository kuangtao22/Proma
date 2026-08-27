import { applyCanvasMutations } from '@proma/shared'
import type {
  CanvasDocument,
  CanvasEdge,
  CanvasMutation,
  CanvasNodeIssue,
  DesignPoint,
  DesignViewport,
} from '@proma/shared'
import { Position } from '@xyflow/react'
import type { Edge, Node, NodeHandle } from '@xyflow/react'
import type { CanvasAgentNodeData, CanvasAgentFlowNode } from './CanvasAgentNode'

/** 首版原生 Canvas 节点固定宽度，避免状态变化引发重排。 */
export const NATIVE_CANVAS_NODE_WIDTH = 288
/** 首版原生 Canvas 节点固定高度。 */
export const NATIVE_CANVAS_NODE_HEIGHT = 144
/** 新增节点之间保留的最小间距，避免边框与选中环相互遮挡。 */
export const NATIVE_CANVAS_NODE_GAP = 24
/** 未正式接入的节点类别统一使用简洁占位。 */
export const NATIVE_CANVAS_UNSUPPORTED_LABEL = '当前版本暂不支持'

/** 新节点避让只依赖已有节点的持久化位置。 */
export interface NativeCanvasPositionedNode {
  position: DesignPoint
}

/** 扩展落点需要同时读取稳定节点 ID 和持久化位置。 */
export interface NativeCanvasIdentifiedPositionedNode extends NativeCanvasPositionedNode {
  id: string
}

/** Renderer 可用于判断节点是否被面板裁剪的画布尺寸。 */
export interface NativeCanvasSurfaceBounds {
  width: number
  height: number
}

/** 节点与画布边缘保留的最小屏幕间距。 */
const NATIVE_CANVAS_REVEAL_PADDING = 24

/**
 * 节点被收窄画布裁剪时计算一次居中 viewport。
 * @param position 节点左上角世界坐标。
 * @param viewport 当前持久化 viewport。
 * @param bounds 当前真实 Canvas surface 尺寸。
 * @returns 节点已完整可见时返回 null，否则返回保持原缩放的新 viewport。
 */
export function createNativeCanvasNodeRevealViewport(
  position: DesignPoint,
  viewport: DesignViewport,
  bounds: NativeCanvasSurfaceBounds,
): DesignViewport | null {
  if (bounds.width <= 0 || bounds.height <= 0) return null
  /** 节点当前投影到 surface 内的屏幕边界。 */
  const left = position.x * viewport.zoom + viewport.x
  const top = position.y * viewport.zoom + viewport.y
  const right = left + NATIVE_CANVAS_NODE_WIDTH * viewport.zoom
  const bottom = top + NATIVE_CANVAS_NODE_HEIGHT * viewport.zoom
  /** 完整落在安全区域内时不制造 viewport mutation 或磁盘写入。 */
  if (left >= NATIVE_CANVAS_REVEAL_PADDING
    && top >= NATIVE_CANVAS_REVEAL_PADDING
    && right <= bounds.width - NATIVE_CANVAS_REVEAL_PADDING
    && bottom <= bounds.height - NATIVE_CANVAS_REVEAL_PADDING) {
    return null
  }
  /** 仅平移到当前 surface 中心，保留用户原有缩放级别。 */
  return {
    x: bounds.width / 2 - (position.x + NATIVE_CANVAS_NODE_WIDTH / 2) * viewport.zoom,
    y: bounds.height / 2 - (position.y + NATIVE_CANVAS_NODE_HEIGHT / 2) * viewport.zoom,
    zoom: viewport.zoom,
  }
}

/** Agent 节点投影使用的运行时状态和命令能力。 */
export interface NativeCanvasProjectionOptions {
  nodeIssues: CanvasNodeIssue[]
  runningSessionIds: ReadonlySet<string>
  canExpand: boolean
  onExpand: (nodeId: string) => void
}

/** 默认投影不暴露运行态或扩展命令，保持纯文档调用兼容。 */
const DEFAULT_NATIVE_CANVAS_PROJECTION_OPTIONS: NativeCanvasProjectionOptions = {
  nodeIssues: [],
  runningSessionIds: new Set<string>(),
  canExpand: false,
  onExpand: () => undefined,
}

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

/**
 * 从可视区域中心开始按顺时针方形环寻找首个不重叠位置。
 * @param visibleCenter 当前视口中心对应的世界坐标。
 * @param nodes 当前 Canvas 内已有节点的位置集合。
 * @returns 以固定节点尺寸和间距计算出的左上角世界坐标。
 */
export function findAvailableNativeCanvasNodePosition(
  visibleCenter: DesignPoint,
  nodes: ReadonlyArray<NativeCanvasPositionedNode>,
): DesignPoint {
  /** 首选位置让节点本身居中，而不是让节点左上角落在视口中心。 */
  const origin = {
    x: visibleCenter.x - NATIVE_CANVAS_NODE_WIDTH / 2,
    y: visibleCenter.y - NATIVE_CANVAS_NODE_HEIGHT / 2,
  }
  /** 相邻网格列之间的固定跨度。 */
  const horizontalStep = NATIVE_CANVAS_NODE_WIDTH + NATIVE_CANVAS_NODE_GAP
  /** 相邻网格行之间的固定跨度。 */
  const verticalStep = NATIVE_CANVAS_NODE_HEIGHT + NATIVE_CANVAS_NODE_GAP
  /** 单个任意位置节点最多阻塞相邻四个网格候选，因此检查 4N+1 个即可找到空位。 */
  const candidateLimit = nodes.length * 4 + 1
  /** 已检查候选数包含中心原点。 */
  let inspectedCandidates = 1

  /** 判断候选矩形与任一固定尺寸节点是否小于最小间距。 */
  const overlapsExistingNode = (candidate: DesignPoint): boolean => nodes.some((node) => (
    Math.abs(candidate.x - node.position.x) < horizontalStep
    && Math.abs(candidate.y - node.position.y) < verticalStep
  ))
  /** 将整数网格偏移转换为真实世界坐标。 */
  const resolveCandidate = (gridX: number, gridY: number): DesignPoint => ({
    x: origin.x + gridX * horizontalStep,
    y: origin.y + gridY * verticalStep,
  })
  /** 按顺时针顺序检查单个方形环，首个候选固定在中心右侧。 */
  const createRingOffsets = (radius: number): DesignPoint[] => {
    /** 当前半径上的全部整数网格偏移。 */
    const offsets: DesignPoint[] = [{ x: radius, y: 0 }]
    for (let y = 1; y <= radius; y += 1) offsets.push({ x: radius, y })
    for (let x = radius - 1; x >= -radius; x -= 1) offsets.push({ x, y: radius })
    for (let y = radius - 1; y >= -radius; y -= 1) offsets.push({ x: -radius, y })
    for (let x = -radius + 1; x <= radius; x += 1) offsets.push({ x, y: -radius })
    for (let y = -radius + 1; y < 0; y += 1) offsets.push({ x: radius, y })
    return offsets
  }

  if (!overlapsExistingNode(origin)) return origin
  for (let radius = 1; inspectedCandidates <= candidateLimit; radius += 1) {
    /** 当前环按用户最常用的从左到右流程优先检查右侧位置。 */
    const offsets = createRingOffsets(radius)
    for (const offset of offsets) {
      /** 当前网格偏移对应的真实候选位置。 */
      const candidate = resolveCandidate(offset.x, offset.y)
      inspectedCandidates += 1
      if (!overlapsExistingNode(candidate)) return candidate
      if (inspectedCandidates > candidateLimit) break
    }
  }
  throw new Error('Canvas 节点落点计算失败')
}

/**
 * 从源节点右侧开始按行向下寻找首个不重叠位置。
 * @param sourceNodeId 扩展关系的源节点 ID。
 * @param nodes 当前 Canvas 全部节点身份与位置。
 * @returns 与固定节点尺寸和间距对齐的确定性右侧落点。
 */
export function findAvailableNativeCanvasChildPosition(
  sourceNodeId: string,
  nodes: ReadonlyArray<NativeCanvasIdentifiedPositionedNode>,
): DesignPoint {
  /** 源节点必须来自当前权威文档，禁止为迟到命令猜测位置。 */
  const source = nodes.find((node) => node.id === sourceNodeId)
  if (!source) throw new Error('Canvas 扩展源节点不存在')
  /** 扩展默认从源节点正右侧开始。 */
  const start = {
    x: source.position.x + NATIVE_CANVAS_NODE_WIDTH + NATIVE_CANVAS_NODE_GAP,
    y: source.position.y,
  }
  /** 横纵间距分别与当前固定卡片尺寸对齐。 */
  const horizontalStep = NATIVE_CANVAS_NODE_WIDTH + NATIVE_CANVAS_NODE_GAP
  const verticalStep = NATIVE_CANVAS_NODE_HEIGHT + NATIVE_CANVAS_NODE_GAP
  /** 任意位置节点只要进入固定间距范围即视为占用候选。 */
  const overlapsExistingNode = (candidate: DesignPoint): boolean => nodes.some((node) => (
    Math.abs(candidate.x - node.position.x) < horizontalStep
    && Math.abs(candidate.y - node.position.y) < verticalStep
  ))
  for (let row = 0; row <= nodes.length; row += 1) {
    /** 候选始终位于同一右侧列，避免扩展关系在画布上来回跳跃。 */
    const candidate = { x: start.x, y: start.y + row * verticalStep }
    if (!overlapsExistingNode(candidate)) return candidate
  }
  throw new Error('Canvas 扩展落点计算失败')
}

/** 仅允许可恢复的网页地址进入 Renderer 投影，阻断文件路径与内嵌数据。 */
function projectSafeWebviewUrl(url: string): string | undefined {
  return /^https?:\/\//u.test(url) ? url : undefined
}

/** 将持久节点投影为固定尺寸且无消息读取能力的 XYFlow 节点。 */
export function toNativeCanvasFlowNodes(
  document: CanvasDocument,
  options: NativeCanvasProjectionOptions = DEFAULT_NATIVE_CANVAS_PROJECTION_OPTIONS,
): NativeCanvasFlowNode[] {
  /** 节点问题先建索引，避免大画布逐节点线性扫描全部问题。 */
  const unavailableNodeIds = new Set(options.nodeIssues.map((issue) => issue.nodeId))
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
      /** unavailable 优先于运行态，坏节点不得继续扩展。 */
      const unavailable = unavailableNodeIds.has(node.id)
      /** 只有可写且健康的 Agent 节点才能创建下游节点。 */
      const canExpand = options.canExpand && !unavailable
      const data: CanvasAgentNodeData = {
        id: node.id,
        title: node.title,
        agentSessionId: node.agentSessionId,
        status: unavailable
          ? 'unavailable'
          : options.runningSessionIds.has(node.agentSessionId) ? 'running' : 'idle',
        canExpand,
        ...(canExpand ? { onExpand: options.onExpand } : {}),
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

/** 判断位置 mutation 的全部节点引用能否在指定权威文档上安全重放。 */
export function canReplayNativeCanvasPositionMutations(
  authoritativeDocument: CanvasDocument,
  mutations: CanvasMutation[],
): boolean {
  if (!areNativeCanvasMutationsPositionOnly(mutations)) return false
  /** 权威节点集合用于线性校验全部待移动引用，避免恢复后提交无效 mutation。 */
  const authoritativeNodeIds = new Set(authoritativeDocument.nodes.map((node) => node.id))
  return mutations.every((mutation) => mutation.type !== 'move-nodes'
    || mutation.positions.every((position) => authoritativeNodeIds.has(position.nodeId)))
}

/** 在恢复后的权威文档上按顺序重放位置类 pending。 */
export function replayNativeCanvasPositionMutations(
  authoritativeDocument: CanvasDocument,
  mutations: CanvasMutation[],
): CanvasDocument {
  if (!areNativeCanvasMutationsPositionOnly(mutations)) return authoritativeDocument
  return applyCanvasMutations(authoritativeDocument, mutations)
}
