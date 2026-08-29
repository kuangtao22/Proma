import { applyCanvasMutations } from '@proma/shared'
import type {
  CanvasImagePreview,
  CanvasDocument,
  CanvasEdge,
  CanvasMutation,
  CanvasNodeKind,
  CanvasNodeIssue,
  DesignPoint,
  DesignViewport,
} from '@proma/shared'
import { Position } from '@xyflow/react'
import type { Edge, Node, NodeHandle } from '@xyflow/react'
import { AGENT_STATUS_LABELS } from './CanvasAgentNode'
import type { CanvasAgentFlowData, CanvasAgentFlowNode } from './CanvasAgentNode'
import type { CanvasNodeCardData, CanvasNodeFlowData } from './CanvasNodeCard'

/** 首版原生 Canvas 节点固定宽度，避免状态变化引发重排。 */
export const NATIVE_CANVAS_NODE_WIDTH = 288
/** 首版原生 Canvas 节点固定高度。 */
export const NATIVE_CANVAS_NODE_HEIGHT = 144
/** 生图卡片标题栏固定高度，预览比例只改变内容区。 */
export const NATIVE_CANVAS_NODE_HEADER_HEIGHT = 48
/** 极宽图片仍保留可辨识的最小预览高度。 */
export const NATIVE_CANVAS_IMAGE_PREVIEW_MIN_HEIGHT = 96
/** 极长图片限制预览高度，避免单个节点占满画布。 */
export const NATIVE_CANVAS_IMAGE_PREVIEW_MAX_HEIGHT = 320
/** 新增节点之间保留的最小间距，避免边框与选中环相互遮挡。 */
export const NATIVE_CANVAS_NODE_GAP = 24
/** 新节点避让只依赖已有节点的持久化位置。 */
export interface NativeCanvasPositionedNode {
  position: DesignPoint
}

/** 扩展落点需要同时读取稳定节点 ID 和持久化位置。 */
export interface NativeCanvasIdentifiedPositionedNode extends NativeCanvasPositionedNode {
  id: string
}

/**
 * 计算顶部独立新增节点的全局追加位置。
 * @param emptyCanvasCenter 空画布真实 surface 中心换算出的世界坐标。
 * @param nodes 当前权威文档节点顺序与位置。
 * @returns 新节点左上角世界坐标。
 */
export function findNativeCanvasGlobalAppendPosition(
  emptyCanvasCenter: DesignPoint,
  nodes: ReadonlyArray<NativeCanvasPositionedNode>,
): DesignPoint {
  if (nodes.length === 0) {
    return {
      x: emptyCanvasCenter.x - NATIVE_CANVAS_NODE_WIDTH / 2,
      y: emptyCanvasCenter.y - NATIVE_CANVAS_NODE_HEIGHT / 2,
    }
  }
  /** 文档中首个仍存在节点固定定义新增节点的纵向基线。 */
  const baselineY = nodes[0]?.position.y ?? 0
  /** 一次线性扫描得到全局最右边界，独立于当前 viewport。 */
  let maxRight = Number.NEGATIVE_INFINITY
  for (const node of nodes) {
    maxRight = Math.max(maxRight, node.position.x + NATIVE_CANVAS_NODE_WIDTH)
  }
  /** 顶部新增始终固定在全局最右侧的新列。 */
  const appendX = maxRight + NATIVE_CANVAS_NODE_GAP
  /** 新列按固定行高向下寻找首个满足间距的候选。 */
  const verticalStep = NATIVE_CANVAS_NODE_HEIGHT + NATIVE_CANVAS_NODE_GAP
  for (let row = 0; row <= nodes.length; row += 1) {
    /** 候选纵坐标保持首节点基线优先，只有占用时才向下。 */
    const candidate = { x: appendX, y: baselineY + row * verticalStep }
    if (!overlapsNativeCanvasNodes(candidate, nodes)) return candidate
  }
  throw new Error('Canvas 全局追加落点计算失败')
}

/**
 * 判断固定尺寸候选是否侵入任一节点要求的最小间距。
 * @param candidate 待验证节点的左上角世界坐标。
 * @param nodes 当前 Canvas 的持久化节点位置。
 * @returns 候选与任一节点横纵间距同时不足时返回 true。
 */
export function overlapsNativeCanvasNodes(
  candidate: DesignPoint,
  nodes: ReadonlyArray<NativeCanvasPositionedNode>,
): boolean {
  /** 固定卡片水平方向包含节点宽度与最小间距。 */
  const horizontalStep = NATIVE_CANVAS_NODE_WIDTH + NATIVE_CANVAS_NODE_GAP
  /** 固定卡片纵向包含节点高度与最小间距。 */
  const verticalStep = NATIVE_CANVAS_NODE_HEIGHT + NATIVE_CANVAS_NODE_GAP
  return nodes.some((node) => (
    Math.abs(candidate.x - node.position.x) < horizontalStep
    && Math.abs(candidate.y - node.position.y) < verticalStep
  ))
}

/** 四类节点投影使用的运行时状态和轻量命令能力。 */
export interface NativeCanvasProjectionOptions {
  nodeIssues: CanvasNodeIssue[]
  runningSessionIds: ReadonlySet<string>
  /** 工作区共享的素材预览索引，节点投影不得自行加载图片模块。 */
  imagePreviews?: ReadonlyMap<string, CanvasImagePreview>
  canCreateChild: boolean
  onCreateChild: (nodeId: string, kind: CanvasNodeKind) => void
  onReferenceNode?: (nodeId: string) => void
  onWorkbenchNodeChange: (nodeId: string) => void
}

/** 默认投影不暴露运行态或扩展命令，保持纯文档调用兼容。 */
const DEFAULT_NATIVE_CANVAS_PROJECTION_OPTIONS: NativeCanvasProjectionOptions = {
  nodeIssues: [],
  runningSessionIds: new Set<string>(),
  canCreateChild: false,
  onCreateChild: () => undefined,
  onWorkbenchNodeChange: () => undefined,
}

/** 非 Agent 折叠节点只附带稳定业务引用，不读取引用内容。 */
export interface NativeCanvasContentNodeData extends CanvasNodeCardData {
  kind: 'image' | 'document' | 'webview'
  imageModuleId?: string
  adoptedAssetId?: string
  previewUrl?: string
  documentId?: string
  prototypeId?: string
  contentRevision?: number
}

/** 非 Agent 展示数据与 XYFlow 索引签名要求之间的适配类型。 */
export type NativeCanvasContentFlowData = NativeCanvasContentNodeData & CanvasNodeFlowData
/** XYFlow 中的生图折叠节点。 */
export type NativeCanvasImageFlowNode = Node<NativeCanvasContentFlowData & { kind: 'image' }, 'canvasImage'>
/** XYFlow 中的文档折叠节点。 */
export type NativeCanvasDocumentFlowNode = Node<NativeCanvasContentFlowData & { kind: 'document' }, 'canvasDocument'>
/** XYFlow 中的原型折叠节点。 */
export type NativeCanvasWebviewFlowNode = Node<NativeCanvasContentFlowData & { kind: 'webview' }, 'canvasWebview'>
/** 原生 Canvas 当前全部 XYFlow 节点联合。 */
export type NativeCanvasFlowNode =
  | CanvasAgentFlowNode
  | NativeCanvasImageFlowNode
  | NativeCanvasDocumentFlowNode
  | NativeCanvasWebviewFlowNode

/**
 * 根据已验证图片尺寸计算生图节点高度。
 * @param preview 工作区 LOAD 返回的轻量安全预览元数据。
 * @returns 标题栏加受限预览区的总高度；无效尺寸回退固定高度。
 */
export function resolveNativeCanvasImageNodeHeight(
  preview?: Pick<CanvasImagePreview, 'width' | 'height'>,
): number {
  if (!preview
    || !Number.isFinite(preview.width)
    || !Number.isFinite(preview.height)
    || preview.width <= 0
    || preview.height <= 0) return NATIVE_CANVAS_NODE_HEIGHT
  /** 按固定节点宽度换算的原始预览高度。 */
  const proportionalHeight = NATIVE_CANVAS_NODE_WIDTH * preview.height / preview.width
  /** 受限预览高度同时避免极宽图不可见和极长图撑乱画布。 */
  const previewHeight = Math.min(
    NATIVE_CANVAS_IMAGE_PREVIEW_MAX_HEIGHT,
    Math.max(NATIVE_CANVAS_IMAGE_PREVIEW_MIN_HEIGHT, proportionalHeight),
  )
  return NATIVE_CANVAS_NODE_HEADER_HEIGHT + previewHeight
}

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

  if (!overlapsNativeCanvasNodes(origin, nodes)) return origin
  for (let radius = 1; inspectedCandidates <= candidateLimit; radius += 1) {
    /** 当前环按用户最常用的从左到右流程优先检查右侧位置。 */
    const offsets = createRingOffsets(radius)
    for (const offset of offsets) {
      /** 当前网格偏移对应的真实候选位置。 */
      const candidate = resolveCandidate(offset.x, offset.y)
      inspectedCandidates += 1
      if (!overlapsNativeCanvasNodes(candidate, nodes)) return candidate
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
  /** 纵向避让间距与当前固定卡片尺寸对齐。 */
  const verticalStep = NATIVE_CANVAS_NODE_HEIGHT + NATIVE_CANVAS_NODE_GAP
  for (let row = 0; row <= nodes.length; row += 1) {
    /** 候选始终位于同一右侧列，避免扩展关系在画布上来回跳跃。 */
    const candidate = { x: start.x, y: start.y + row * verticalStep }
    if (!overlapsNativeCanvasNodes(candidate, nodes)) return candidate
  }
  throw new Error('Canvas 扩展落点计算失败')
}

/** 将持久节点投影为固定尺寸且无消息读取能力的 XYFlow 节点。 */
export function toNativeCanvasFlowNodes(
  document: CanvasDocument,
  options: NativeCanvasProjectionOptions = DEFAULT_NATIVE_CANVAS_PROJECTION_OPTIONS,
): NativeCanvasFlowNode[] {
  /** 节点问题先建索引，避免大画布逐节点线性扫描全部问题。 */
  const unavailableNodeIds = new Set(options.nodeIssues.map((issue) => issue.nodeId))
  /** 每个节点高度只计算一次，节点本体和静态 Handle 共用同一几何事实。 */
  const nodeHeightById = new Map(document.nodes.map((node) => {
    /** 只有已采用素材且预览索引命中时，生图节点才使用动态比例。 */
    const preview = node.kind === 'image' && node.adoptedAssetId
      ? options.imagePreviews?.get(node.adoptedAssetId)
      : undefined
    return [node.id, node.kind === 'image'
      ? resolveNativeCanvasImageNodeHeight(preview)
      : NATIVE_CANVAS_NODE_HEIGHT] as const
  }))
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
    /** 源节点当前高度决定输出 Handle 的垂直中点。 */
    const sourceHeight = nodeHeightById.get(edge.sourceNodeId) ?? NATIVE_CANVAS_NODE_HEIGHT
    /** 目标节点当前高度决定输入 Handle 的垂直中点。 */
    const targetHeight = nodeHeightById.get(edge.targetNodeId) ?? NATIVE_CANVAS_NODE_HEIGHT
    appendHandle(edge.sourceNodeId, {
      id: edge.sourcePort,
      type: 'source',
      position: Position.Right,
      x: NATIVE_CANVAS_NODE_WIDTH,
      y: sourceHeight / 2,
    })
    appendHandle(edge.targetNodeId, {
      id: edge.targetPort,
      type: 'target',
      position: Position.Left,
      x: 0,
      y: targetHeight / 2,
    })
  }
  return document.nodes.map((node): NativeCanvasFlowNode => {
    /** 投影尺寸复用预先计算结果，避免边和节点使用不同高度。 */
    const nodeHeight = nodeHeightById.get(node.id) ?? NATIVE_CANVAS_NODE_HEIGHT
    /** 四类节点共享稳定布局；无边节点继续显式空 handles 以支持可见区裁剪。 */
    const base = {
      id: node.id,
      position: node.position,
      width: NATIVE_CANVAS_NODE_WIDTH,
      height: nodeHeight,
      handles: handlesByNodeId.get(node.id) ?? [],
    }
    if (node.kind === 'agent') {
      /** unavailable 优先于运行态，坏节点不得继续扩展。 */
      const unavailable = unavailableNodeIds.has(node.id)
      /** 只有可写且健康的 Agent 节点才能创建下游节点。 */
      const canCreateChild = options.canCreateChild && !unavailable
      /** 当前 Agent 的轻量运行态不读取消息历史。 */
      const status = unavailable
        ? 'unavailable'
        : options.runningSessionIds.has(node.agentSessionId) ? 'running' : 'idle'
      const data: CanvasAgentFlowData = {
        id: node.id,
        kind: node.kind,
        title: node.title,
        agentSessionId: node.agentSessionId,
        status,
        statusLabel: AGENT_STATUS_LABELS[status],
        summary: unavailable ? '需要重建或删除节点' : '独立 Agent 会话',
        canOpenWorkbench: true,
        onOpenWorkbench: options.onWorkbenchNodeChange,
        canCreateChild,
        ...(canCreateChild ? { onCreateChild: options.onCreateChild } : {}),
        ...(options.onReferenceNode ? { onReferenceNode: options.onReferenceNode } : {}),
      }
      return { ...base, type: 'canvasAgent', data }
    }
    if (node.kind === 'image') {
      /** 只有已采用素材且工作区成功解析时才向卡片注入安全 URL。 */
      const preview = node.adoptedAssetId
        ? options.imagePreviews?.get(node.adoptedAssetId)
        : undefined
      return {
        ...base,
        type: 'canvasImage',
        data: {
          id: node.id,
          kind: node.kind,
          title: node.title,
          imageModuleId: node.imageModuleId,
          ...(node.adoptedAssetId ? { adoptedAssetId: node.adoptedAssetId } : {}),
          ...(preview ? { previewUrl: preview.previewUrl, nodeHeight } : {}),
          statusLabel: node.adoptedAssetId ? '已有素材' : '待创作',
          summary: node.adoptedAssetId ? '已采用画布素材' : '尚未生成图片',
          canOpenWorkbench: true,
          onOpenWorkbench: options.onWorkbenchNodeChange,
          canCreateChild: options.canCreateChild,
          ...(options.canCreateChild ? { onCreateChild: options.onCreateChild } : {}),
          ...(options.onReferenceNode ? { onReferenceNode: options.onReferenceNode } : {}),
        },
      }
    }
    if (node.kind === 'document') {
      return {
        ...base,
        type: 'canvasDocument',
        data: {
          id: node.id,
          kind: node.kind,
          title: node.title,
          documentId: node.documentId,
          contentRevision: node.contentRevision,
          statusLabel: '已创建',
          summary: `内容版本 ${node.contentRevision}`,
          canOpenWorkbench: true,
          onOpenWorkbench: options.onWorkbenchNodeChange,
          canCreateChild: options.canCreateChild,
          ...(options.canCreateChild ? { onCreateChild: options.onCreateChild } : {}),
          ...(options.onReferenceNode ? { onReferenceNode: options.onReferenceNode } : {}),
        },
      }
    }
    return {
      ...base,
      type: 'canvasWebview',
      data: {
        id: node.id,
        kind: node.kind,
        title: node.title,
        prototypeId: node.prototypeId,
        contentRevision: node.contentRevision,
        statusLabel: '已创建',
        summary: `内容版本 ${node.contentRevision}`,
        canOpenWorkbench: true,
        onOpenWorkbench: options.onWorkbenchNodeChange,
        canCreateChild: options.canCreateChild,
        ...(options.canCreateChild ? { onCreateChild: options.onCreateChild } : {}),
        ...(options.onReferenceNode ? { onReferenceNode: options.onReferenceNode } : {}),
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
