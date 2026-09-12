import {
  createCanvasLayoutSpatialIndex,
  findCompactCanvasSlot,
} from '@proma/shared'
import type {
  CanvasDocument,
  CanvasLayoutRect,
  CanvasLayoutSize,
  CanvasNode,
  DesignPoint,
} from '@proma/shared'

/** 普通 Agent 和媒体节点的稳定卡片尺寸。 */
const STANDARD_NODE_SIZE: CanvasLayoutSize = { width: 288, height: 144 }
/** 已采用图片缺少预览比例元数据时，按 Renderer 允许的最大高度保守避让。 */
const ADOPTED_IMAGE_MAX_NODE_SIZE: CanvasLayoutSize = { width: 288, height: 368 }
/** 桌面 WebView 的稳定卡片尺寸。 */
const DESKTOP_WEBVIEW_SIZE: CanvasLayoutSize = { width: 384, height: 316 }
/** 手机 WebView 的稳定卡片尺寸。 */
const MOBILE_WEBVIEW_SIZE: CanvasLayoutSize = { width: 232, height: 578 }
/** 节点间必须保留的视觉净间距。 */
const CANVAS_NODE_GAP = 24
/** 一次审核只接受有限目标，防止不受限数组放大布局计算。 */
const MAX_REVIEW_TARGETS = 128

/**
 * 返回节点用于 Canvas 碰撞计算的稳定矩形尺寸。
 *
 * 入参为已持久化 Canvas 节点，返回值与 Renderer 固定卡片尺寸一致。
 */
function resolveCanvasNodeSize(node: CanvasNode): CanvasLayoutSize {
  if (node.kind === 'image' && node.adoptedAssetId !== undefined) return ADOPTED_IMAGE_MAX_NODE_SIZE
  if (node.kind !== 'webview') return STANDARD_NODE_SIZE
  return node.devicePreset === 'mobile' ? MOBILE_WEBVIEW_SIZE : DESKTOP_WEBVIEW_SIZE
}

/**
 * 将持久节点转换为真实画布中的碰撞矩形。
 *
 * 入参为节点；返回值保留原始左上角和对应的稳定卡片尺寸。
 */
function createCanvasRect(node: CanvasNode): CanvasLayoutRect {
  return { id: node.id, ...node.position, ...resolveCanvasNodeSize(node) }
}

/**
 * 将真实画布矩形沿 X 轴镜像，以复用仅向右扩展的共享槽位搜索。
 *
 * 入参为节点；返回值的虚拟 X 轴向右对应真实画布向左。
 */
function createMirroredCanvasRect(node: CanvasNode): CanvasLayoutRect {
  /** 节点尺寸决定镜像时以右边界为基准的位置。 */
  const rect = createCanvasRect(node)
  return {
    ...rect,
    x: -(rect.x + rect.width),
  }
}

/**
 * 验证并按文档顺序解析审核目标节点。
 *
 * 入参为当前文档、审核 Agent ID 与制作节点 ID；返回值为已存在且去重的目标节点。
 */
function resolveReviewTargets(
  document: CanvasDocument,
  agentNodeId: string,
  beforeNodeIds: readonly string[],
): CanvasNode[] {
  if (!Array.isArray(beforeNodeIds) || beforeNodeIds.length === 0 || beforeNodeIds.length > MAX_REVIEW_TARGETS) {
    throw new Error('CANVAS_AGENT_REVIEW_TARGETS_INVALID')
  }
  /** 严格拒绝重复 ID，调用方必须先明确制作节点集合。 */
  const targetIds = new Set<string>()
  for (const nodeId of beforeNodeIds) {
    if (typeof nodeId !== 'string' || nodeId.trim().length === 0) throw new Error('CANVAS_AGENT_REVIEW_TARGETS_INVALID')
    if (nodeId === agentNodeId) throw new Error('CANVAS_AGENT_REVIEW_TARGET_SELF')
    if (targetIds.has(nodeId)) throw new Error('CANVAS_AGENT_REVIEW_TARGETS_DUPLICATE')
    targetIds.add(nodeId)
  }
  /** 先建立节点索引，避免每个目标在大画布上重复扫描。 */
  const nodeById = new Map(document.nodes.map((node) => [node.id, node]))
  for (const nodeId of targetIds) {
    if (!nodeById.has(nodeId)) throw new Error('CANVAS_AGENT_REVIEW_TARGET_INVALID')
  }
  /** 文档顺序是持久化稳定顺序，避免调用方数组排列改变布局结果。 */
  return document.nodes.filter((node) => targetIds.has(node.id))
}

/**
 * 判断 Agent 是否已位于目标范围左侧的合法相邻位置。
 *
 * 入参为 Agent、目标水平边界和空间索引；返回 true 时调用方应保留原坐标。
 */
function isAdjacentReviewPosition(
  agent: CanvasNode,
  targetMinX: number,
  targetTop: number,
  targetBottom: number,
  index: ReturnType<typeof createCanvasLayoutSpatialIndex>,
): boolean {
  /** 审核 Agent 本身固定采用标准尺寸。 */
  const agentSize = resolveCanvasNodeSize(agent)
  const isImmediatelyLeft = agent.position.x + agentSize.width + CANVAS_NODE_GAP === targetMinX
  const staysNearTargetRange = agent.position.y + agentSize.height + CANVAS_NODE_GAP > targetTop
    && agent.position.y < targetBottom + CANVAS_NODE_GAP
  return isImmediatelyLeft
    && staysNearTargetRange
    && !index.overlaps({ ...agent.position, ...agentSize })
}

/**
 * 计算审核 Agent 放在指定制作节点左侧的无碰撞位置。
 *
 * 入参为权威 Canvas 文档、Agent 节点 ID 与制作节点集合；返回值只含建议坐标，不改动文档、边或其它节点。
 */
export function resolveCanvasAgentReviewPosition(
  document: CanvasDocument,
  agentNodeId: string,
  beforeNodeIds: readonly string[],
): DesignPoint {
  /** 审核角色由节点类别而非标题或边语义决定。 */
  const agent = document.nodes.find((node) => node.id === agentNodeId)
  if (!agent || agent.kind !== 'agent') throw new Error('CANVAS_AGENT_REVIEW_AGENT_INVALID')
  /** 校验集合后按文档顺序取得稳定目标。 */
  const targets = resolveReviewTargets(document, agentNodeId, beforeNodeIds)
  /** 所有目标最左边界定义 Agent 必须位于其前的硬约束。 */
  const targetMinX = Math.min(...targets.map((node) => node.position.x))
  /** 目标纵向包围盒用于令 Agent 优先落在制作范围中央。 */
  const targetTop = Math.min(...targets.map((node) => node.position.y))
  const targetBottom = Math.max(...targets.map((node) => node.position.y + resolveCanvasNodeSize(node).height))
  /** Agent 自身不应作为碰撞障碍，才能判断保位与计算新的推荐槽位。 */
  const occupiedNodes = document.nodes.filter((node) => node.id !== agent.id)
  const realIndex = createCanvasLayoutSpatialIndex(
    occupiedNodes.map(createCanvasRect),
    CANVAS_NODE_GAP,
  )

  if (isAdjacentReviewPosition(agent, targetMinX, targetTop, targetBottom, realIndex)) {
    return { ...agent.position }
  }

  /** 镜像空间中起点为目标最左边界，向右搜索即真实空间向左搜索。 */
  const mirroredIndex = createCanvasLayoutSpatialIndex(
    occupiedNodes.map(createMirroredCanvasRect),
    CANVAS_NODE_GAP,
  )
  const agentSize = resolveCanvasNodeSize(agent)
  const mirroredAnchor = {
    x: -targetMinX + CANVAS_NODE_GAP,
    y: targetTop + (targetBottom - targetTop - agentSize.height) / 2,
  }
  const mirroredPosition = findCompactCanvasSlot(mirroredIndex, {
    anchor: mirroredAnchor,
    size: agentSize,
    order: 0,
    direction: 'right',
  })
  /** 镜像坐标还原后，候选右边界加 gap 必然不超过目标最左边界。 */
  return { x: -mirroredPosition.x - agentSize.width, y: mirroredPosition.y }
}
