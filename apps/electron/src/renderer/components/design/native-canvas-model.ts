import {
  applyCanvasMutations,
  CANVAS_UNBOUND_PORT,
  createCanvasBoundEdge,
  createCanvasLayoutSpatialIndex,
  findCompactCanvasSlot,
  resolveCanvasEdgeBinding,
} from '@proma/shared'
import type {
  CanvasLayoutRect,
  CanvasImagePreview,
  CanvasWebviewDevicePreset,
  CanvasWebviewPreviewSnapshot,
  CanvasWebviewPreviewTarget,
  CanvasDocument,
  CanvasEdge,
  CanvasEdgeRelation,
  CanvasMutation,
  CanvasNode,
  CanvasNodeActivityState,
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

/** Canvas 语义边在画布上的稳定中文标签。 */
const CANVAS_EDGE_RELATION_LABELS: Readonly<Record<CanvasEdgeRelation, string>> = {
  association: '关联',
  reference: '引用',
  'depends-on': '依赖',
  derives: '衍生',
}

/** 首版原生 Canvas 节点固定宽度，避免状态变化引发重排。 */
export const NATIVE_CANVAS_NODE_WIDTH = 288
/** 首版原生 Canvas 节点固定高度。 */
export const NATIVE_CANVAS_NODE_HEIGHT = 144
/** 网页 WebView 卡片固定宽度。 */
export const NATIVE_CANVAS_WEBVIEW_DESKTOP_WIDTH = 384
/** 网页 WebView 卡片固定高度。 */
export const NATIVE_CANVAS_WEBVIEW_DESKTOP_HEIGHT = 316
/** 手机 WebView 卡片固定宽度。 */
export const NATIVE_CANVAS_WEBVIEW_MOBILE_WIDTH = 232
/** 手机 WebView 卡片固定高度。 */
export const NATIVE_CANVAS_WEBVIEW_MOBILE_HEIGHT = 578
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
  kind?: CanvasNodeKind
  devicePreset?: 'desktop' | 'mobile'
  /** 已知动态卡片宽度优先于类型默认值。 */
  nodeWidth?: number
  /** 已知动态卡片高度优先于类型默认值。 */
  nodeHeight?: number
}

/** 扩展落点需要同时读取稳定节点 ID 和持久化位置。 */
export interface NativeCanvasIdentifiedPositionedNode extends NativeCanvasPositionedNode {
  id: string
}

/** Canvas 节点在世界坐标中使用的稳定矩形尺寸。 */
export interface NativeCanvasNodeSize {
  width: number
  height: number
}

/**
 * 解析节点类型对应的稳定卡片尺寸。
 * @param node 至少包含节点类别；WebView 同时读取设备预设。
 * @returns 画布布局、Handle 与卡片共同使用的宽高。
 */
export function resolveNativeCanvasNodeSize(
  node: Pick<NativeCanvasPositionedNode, 'kind' | 'devicePreset' | 'nodeWidth' | 'nodeHeight'>,
): NativeCanvasNodeSize {
  /** 有限正数的投影尺寸代表 Renderer 当前最准确的卡片几何。 */
  const explicitWidth = Number.isFinite(node.nodeWidth) && (node.nodeWidth ?? 0) > 0
    ? node.nodeWidth
    : undefined
  /** 生图比例等动态高度由投影层显式传入。 */
  const explicitHeight = Number.isFinite(node.nodeHeight) && (node.nodeHeight ?? 0) > 0
    ? node.nodeHeight
    : undefined
  if (explicitWidth !== undefined && explicitHeight !== undefined) {
    return { width: explicitWidth, height: explicitHeight }
  }
  if (node.kind !== 'webview') {
    return {
      width: explicitWidth ?? NATIVE_CANVAS_NODE_WIDTH,
      height: explicitHeight ?? NATIVE_CANVAS_NODE_HEIGHT,
    }
  }
  const preset = node.devicePreset === 'mobile'
    ? { width: NATIVE_CANVAS_WEBVIEW_MOBILE_WIDTH, height: NATIVE_CANVAS_WEBVIEW_MOBILE_HEIGHT }
    : { width: NATIVE_CANVAS_WEBVIEW_DESKTOP_WIDTH, height: NATIVE_CANVAS_WEBVIEW_DESKTOP_HEIGHT }
  return { width: explicitWidth ?? preset.width, height: explicitHeight ?? preset.height }
}

/** 将 Renderer 已知节点转换为共享布局矩形。 */
function toNativeCanvasLayoutRects(
  nodes: ReadonlyArray<NativeCanvasPositionedNode>,
): CanvasLayoutRect[] {
  return nodes.map((node, index) => {
    /** 动态图片和 WebView 尺寸只在此处解析一次。 */
    const size = resolveNativeCanvasNodeSize(node)
    /** 无 ID 的旧调用使用稳定数组序号，仅用于本次内存碰撞查询。 */
    const id = 'id' in node && typeof node.id === 'string' ? node.id : `node-${index}`
    return { id, ...node.position, ...size }
  })
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
    const nodeSize = resolveNativeCanvasNodeSize(node)
    maxRight = Math.max(maxRight, node.position.x + nodeSize.width)
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
  candidateNode: Pick<NativeCanvasPositionedNode, 'kind' | 'devicePreset'> = {},
): boolean {
  /** 候选尺寸与既有节点尺寸共同决定真实矩形是否侵入最小间距。 */
  const candidateSize = resolveNativeCanvasNodeSize(candidateNode)
  return nodes.some((node) => {
    const nodeSize = resolveNativeCanvasNodeSize(node)
    return candidate.x < node.position.x + nodeSize.width + NATIVE_CANVAS_NODE_GAP
      && candidate.x + candidateSize.width + NATIVE_CANVAS_NODE_GAP > node.position.x
      && candidate.y < node.position.y + nodeSize.height + NATIVE_CANVAS_NODE_GAP
      && candidate.y + candidateSize.height + NATIVE_CANVAS_NODE_GAP > node.position.y
  })
}

/** 四类节点投影使用的运行时状态和轻量命令能力。 */
export interface NativeCanvasProjectionOptions {
  nodeIssues: CanvasNodeIssue[]
  runningSessionIds: ReadonlySet<string>
  /** Workspace 已按节点 ID 聚合的最终瞬时活动状态。 */
  nodeActivityStates?: ReadonlyMap<string, CanvasNodeActivityState>
  /** 图片候选只改变卡片标记，不替换 adopted 缩略图。 */
  imageCandidateStates?: ReadonlyMap<string, 'new-version' | 'partial'>
  /** 工作区共享的素材预览索引，节点投影不得自行加载图片模块。 */
  imagePreviews?: ReadonlyMap<string, CanvasImagePreview>
  canCreateChild: boolean
  onCreateChild: (nodeId: string, kind: CanvasNodeKind) => void
  onReferenceNode?: (nodeId: string) => void
  onWorkbenchNodeChange: (nodeId: string) => void
  /** WebView 折叠卡片只加载主进程生成的静态预览。 */
  loadCanvasWebviewPreview?: (target: CanvasWebviewPreviewTarget) => Promise<CanvasWebviewPreviewSnapshot>
  /** 设备预设仍在保存中的 WebView 节点不得提前请求新设备预览。 */
  pendingWebviewDeviceNodeIds?: ReadonlySet<string>
  /** 设备切换只提交图 mutation，不调用 Agent。 */
  onWebviewDevicePresetChange?: (nodeId: string, devicePreset: CanvasWebviewDevicePreset) => void
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
  devicePreset?: 'desktop' | 'mobile'
  nodeWidth?: number
  nodeHeight?: number
  webviewPreviewTarget?: CanvasWebviewPreviewTarget
  webviewPreviewRequestReady?: boolean
  loadCanvasWebviewPreview?: (target: CanvasWebviewPreviewTarget) => Promise<CanvasWebviewPreviewSnapshot>
  onWebviewDevicePresetChange?: (nodeId: string, devicePreset: CanvasWebviewDevicePreset) => void
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
  candidateNode: Pick<NativeCanvasPositionedNode, 'kind' | 'devicePreset' | 'nodeWidth' | 'nodeHeight'> = {},
): DesignPoint {
  /** 候选真实尺寸决定其左上角如何围绕视口中心布局。 */
  const candidateSize = resolveNativeCanvasNodeSize(candidateNode)
  /** 视口中心转换为候选左上角锚点，避免不同类型视觉中心偏移。 */
  const anchor = {
    x: visibleCenter.x - candidateSize.width / 2,
    y: visibleCenter.y - candidateSize.height / 2,
  }
  return findCompactCanvasSlot(
    createCanvasLayoutSpatialIndex(toNativeCanvasLayoutRects(nodes), NATIVE_CANVAS_NODE_GAP),
    {
      anchor,
      size: candidateSize,
      order: 0,
      direction: 'ring',
    },
  )
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
  candidateNode: Pick<NativeCanvasPositionedNode, 'kind' | 'devicePreset' | 'nodeWidth' | 'nodeHeight'> = {},
): DesignPoint {
  /** 源节点必须来自当前权威文档，禁止为迟到命令猜测位置。 */
  const source = nodes.find((node) => node.id === sourceNodeId)
  if (!source) throw new Error('Canvas 扩展源节点不存在')
  /** 扩展默认从源节点正右侧开始。 */
  const sourceSize = resolveNativeCanvasNodeSize(source)
  const start = {
    x: source.position.x + sourceSize.width + NATIVE_CANVAS_NODE_GAP,
    y: source.position.y,
  }
  /** 目标类型的真实尺寸参与同源兄弟槽位避让。 */
  const candidateSize = resolveNativeCanvasNodeSize(candidateNode)
  return findCompactCanvasSlot(
    createCanvasLayoutSpatialIndex(toNativeCanvasLayoutRects(nodes), NATIVE_CANVAS_NODE_GAP),
    {
      anchor: start,
      size: candidateSize,
      order: 0,
      direction: 'right',
    },
  )
}

/** 将持久节点投影为固定尺寸且无消息读取能力的 XYFlow 节点。 */
export function toNativeCanvasFlowNodes(
  document: CanvasDocument,
  options: NativeCanvasProjectionOptions = DEFAULT_NATIVE_CANVAS_PROJECTION_OPTIONS,
): NativeCanvasFlowNode[] {
  /** 节点问题先建索引，避免大画布逐节点线性扫描全部问题。 */
  const unavailableNodeIds = new Set(options.nodeIssues.map((issue) => issue.nodeId))
  /** 每个节点尺寸只计算一次，节点本体和静态 Handle 共用同一几何事实。 */
  const nodeSizeById = new Map(document.nodes.map((node) => {
    /** 只有已采用素材且预览索引命中时，生图节点才使用动态比例。 */
    const preview = node.kind === 'image' && node.adoptedAssetId
      ? options.imagePreviews?.get(node.adoptedAssetId)
      : undefined
    const baseSize = resolveNativeCanvasNodeSize(node)
    return [node.id, node.kind === 'image'
      ? { ...baseSize, height: resolveNativeCanvasImageNodeHeight(preview) }
      : baseSize] as const
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
    const sourceSize = nodeSizeById.get(edge.sourceNodeId)
    /** 目标节点当前高度决定输入 Handle 的垂直中点。 */
    const targetSize = nodeSizeById.get(edge.targetNodeId)
    appendHandle(edge.sourceNodeId, {
      id: 'output',
      type: 'source',
      position: Position.Right,
      x: sourceSize?.width ?? NATIVE_CANVAS_NODE_WIDTH,
      y: (sourceSize?.height ?? NATIVE_CANVAS_NODE_HEIGHT) / 2,
    })
    appendHandle(edge.targetNodeId, {
      id: 'input',
      type: 'target',
      position: Position.Left,
      x: 0,
      y: (targetSize?.height ?? NATIVE_CANVAS_NODE_HEIGHT) / 2,
    })
  }
  return document.nodes.map((node): NativeCanvasFlowNode => {
    /** 投影尺寸复用预先计算结果，避免边和节点使用不同高度。 */
    const nodeSize = nodeSizeById.get(node.id) ?? resolveNativeCanvasNodeSize(node)
    /** 活动映射按节点 ID 常量时间查询，未命中节点保持零动画的空闲态。 */
    const activityState = options.nodeActivityStates?.get(node.id) ?? 'idle'
    /** 四类节点共享稳定布局；无边节点继续显式空 handles 以支持可见区裁剪。 */
    const base = {
      id: node.id,
      position: node.position,
      width: nodeSize.width,
      height: nodeSize.height,
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
        activityState,
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
          activityState,
          candidateState: options.imageCandidateStates?.get(node.id),
          ...(node.adoptedAssetId ? { adoptedAssetId: node.adoptedAssetId } : {}),
          ...(preview ? { previewUrl: preview.previewUrl, nodeHeight: nodeSize.height } : {}),
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
          activityState,
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
        activityState,
        contentRevision: node.contentRevision,
        devicePreset: node.devicePreset,
        nodeWidth: nodeSize.width,
        nodeHeight: nodeSize.height,
        webviewPreviewTarget: {
          projectId: document.projectId,
          canvasId: document.canvasId,
          nodeId: node.id,
          prototypeId: node.prototypeId,
          contentRevision: node.contentRevision,
          devicePreset: node.devicePreset,
        },
        webviewPreviewRequestReady: !options.pendingWebviewDeviceNodeIds?.has(node.id),
        ...(options.loadCanvasWebviewPreview
          ? { loadCanvasWebviewPreview: options.loadCanvasWebviewPreview }
          : {}),
        ...(options.onWebviewDevicePresetChange
          ? { onWebviewDevicePresetChange: options.onWebviewDevicePresetChange }
          : {}),
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

/** 将持久业务端口投影到固定 XYFlow 结构 Handle，并附带绑定状态。 */
export function toNativeCanvasFlowEdges(document: CanvasDocument): Edge[] {
  /** 节点类别决定业务端口是否合法；索引避免逐边线性搜索。 */
  const nodesById = new Map(document.nodes.map((node) => [node.id, node]))
  return document.edges.map((edge: CanvasEdge): Edge => {
    const source = nodesById.get(edge.sourceNodeId)
    const target = nodesById.get(edge.targetNodeId)
    if (!source || !target) throw new Error('CANVAS_EDGE_ENDPOINT_MISSING')
    const binding = resolveCanvasEdgeBinding(edge, source.kind, target.kind)
    return {
      id: edge.id,
      source: edge.sourceNodeId,
      sourceHandle: 'output',
      target: edge.targetNodeId,
      targetHandle: 'input',
      selectable: true,
      deletable: false,
      focusable: true,
      animated: false,
      data: { relation: edge.relation, bindingState: binding.state },
      label: binding.state === 'unresolved'
        ? `${CANVAS_EDGE_RELATION_LABELS[edge.relation]} · 待确认`
        : CANVAS_EDGE_RELATION_LABELS[edge.relation],
    }
  })
}

/**
 * 为用户手动拖线构造默认关联边。
 * @param edge 不含语义和业务端口的稳定结构边。
 * @returns 明确携带 association 的持久 Canvas 边。
 */
export function createNativeCanvasUserEdge(
  edge: Omit<CanvasEdge, 'relation' | 'sourcePort' | 'targetPort'>,
): CanvasEdge {
  return {
    ...edge,
    sourcePort: CANVAS_UNBOUND_PORT,
    targetPort: CANVAS_UNBOUND_PORT,
    relation: 'association',
  }
}

/**
 * 使用当前权威节点类别重新确认一条持久边的业务用途。
 * @param edge 待确认的新边或历史边。
 * @param relation 用户选择的关系语义。
 * @param document 当前权威 Canvas 文档。
 * @returns 保留 edge ID 且写入类型化业务端口的新边。
 */
export function confirmNativeCanvasEdge(
  edge: CanvasEdge,
  relation: CanvasEdgeRelation,
  document: CanvasDocument,
): CanvasEdge {
  /** 端点必须仍存在于当前权威文档，避免用陈旧菜单写回悬空边。 */
  const nodesById = new Map(document.nodes.map((node) => [node.id, node]))
  const source = nodesById.get(edge.sourceNodeId)
  const target = nodesById.get(edge.targetNodeId)
  if (!source || !target) throw new Error('CANVAS_EDGE_ENDPOINT_MISSING')
  return createCanvasBoundEdge(source, target, {
    id: edge.id,
    sourceNodeId: edge.sourceNodeId,
    targetNodeId: edge.targetNodeId,
    relation,
  })
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

/** 只有衍生与依赖关系参与整理层级，引用和关联不强迫左右方向。 */
function isDirectedCanvasLayoutRelation(relation: CanvasEdgeRelation): boolean {
  return relation === 'derives' || relation === 'depends-on'
}

/**
 * 为指定范围建立确定性紧凑位置 mutation，运行或等待审批节点保持原位。
 * @param document 当前权威 Canvas 文档。
 * @param scopeNodeIds 用户明确选择的整理范围。
 * @param blockedNodeIds 当前不可移动的节点集合。
 * @returns 只包含真实位置变化的单个 move-nodes mutation。
 */
export function createArrangeCanvasNodesMutation(
  document: CanvasDocument,
  scopeNodeIds: readonly string[],
  blockedNodeIds: ReadonlySet<string>,
): Extract<CanvasMutation, { type: 'move-nodes' }> {
  /** 范围去重并按稳定节点 ID 排序，调用方传入顺序不影响结果。 */
  const scope = new Set(scopeNodeIds)
  /** 真正参与移动的节点必须存在、在范围内且没有活动阻断。 */
  const movableNodes = document.nodes
    .filter((node) => scope.has(node.id) && !blockedNodeIds.has(node.id))
    .sort((left, right) => left.id.localeCompare(right.id))
  if (movableNodes.length === 0) return { type: 'move-nodes', positions: [] }

  /** 范围外节点和阻断节点作为不可穿越的固定障碍。 */
  const movableIds = new Set(movableNodes.map((node) => node.id))
  const fixedRects: CanvasLayoutRect[] = document.nodes
    .filter((node) => !movableIds.has(node.id))
    .map((node) => ({ ...node.position, ...resolveNativeCanvasNodeSize(node), id: node.id }))
  const index = createCanvasLayoutSpatialIndex(fixedRects, NATIVE_CANVAS_NODE_GAP)

  /** 每个节点的入边列表用于计算最长前驱层级。 */
  const incomingByNodeId = new Map<string, string[]>()
  for (const edge of document.edges) {
    if (!isDirectedCanvasLayoutRelation(edge.relation)
      || !movableIds.has(edge.sourceNodeId)
      || !movableIds.has(edge.targetNodeId)) continue
    const incoming = incomingByNodeId.get(edge.targetNodeId) ?? []
    incoming.push(edge.sourceNodeId)
    incomingByNodeId.set(edge.targetNodeId, incoming)
  }
  /** 递归层级遇到循环时回退当前层，保证坏图也能有限完成。 */
  const layerByNodeId = new Map<string, number>()
  const resolving = new Set<string>()
  const resolveLayer = (nodeId: string): number => {
    const cached = layerByNodeId.get(nodeId)
    if (cached !== undefined) return cached
    if (resolving.has(nodeId)) return 0
    resolving.add(nodeId)
    const incoming = incomingByNodeId.get(nodeId) ?? []
    const layer = incoming.length === 0
      ? 0
      : Math.max(...incoming.map((sourceNodeId) => resolveLayer(sourceNodeId) + 1))
    resolving.delete(nodeId)
    layerByNodeId.set(nodeId, layer)
    return layer
  }
  for (const node of movableNodes) resolveLayer(node.id)

  /** 以原范围左上角为锚点，整理不会把整个分组跳到远处。 */
  const origin = {
    x: Math.min(...movableNodes.map((node) => node.position.x)),
    y: Math.min(...movableNodes.map((node) => node.position.y)),
  }
  /** 各层最大宽度决定下一层 X，保持有向关系从左到右。 */
  const layerWidths = new Map<number, number>()
  for (const node of movableNodes) {
    const layer = layerByNodeId.get(node.id) ?? 0
    layerWidths.set(layer, Math.max(layerWidths.get(layer) ?? 0, resolveNativeCanvasNodeSize(node).width))
  }
  const sortedLayers = [...new Set(layerByNodeId.values())].sort((left, right) => left - right)
  const layerX = new Map<number, number>()
  let nextX = origin.x
  for (const layer of sortedLayers) {
    layerX.set(layer, nextX)
    nextX += (layerWidths.get(layer) ?? NATIVE_CANVAS_NODE_WIDTH) + NATIVE_CANVAS_NODE_GAP
  }

  /** 同层按 ID 稳定纵向堆叠；固定障碍只让当前项向下寻找，不移动旧节点。 */
  const nextYByLayer = new Map<number, number>()
  const positions: Array<{ nodeId: string; position: DesignPoint }> = []
  for (const node of movableNodes.sort((left, right) => {
    const layerDifference = (layerByNodeId.get(left.id) ?? 0) - (layerByNodeId.get(right.id) ?? 0)
    return layerDifference || left.id.localeCompare(right.id)
  })) {
    const layer = layerByNodeId.get(node.id) ?? 0
    const size = resolveNativeCanvasNodeSize(node)
    const x = layerX.get(layer) ?? origin.x
    let y = nextYByLayer.get(layer) ?? origin.y
    /** 搜索次数受节点总数限制，异常密集障碍仍保持有限。 */
    for (let attempt = 0; attempt <= document.nodes.length; attempt += 1) {
      if (!index.overlaps({ x, y, ...size })) break
      y += size.height + NATIVE_CANVAS_NODE_GAP
    }
    index.insert({ id: node.id, x, y, ...size })
    nextYByLayer.set(layer, y + size.height + NATIVE_CANVAS_NODE_GAP)
    if (node.position.x !== x || node.position.y !== y) {
      positions.push({ nodeId: node.id, position: { x, y } })
    }
  }
  return { type: 'move-nodes', positions }
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
