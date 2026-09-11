import type { CanvasEdge, CanvasEdgeRelation, CanvasNode, CanvasNodeKind, DesignViewport } from '@proma/shared'

/** 导航关系保留稳定身份和方向，不复制节点内容或执行数据。 */
export interface NativeCanvasNavigationRelation {
  nodeId: string
  title: string
  direction: 'upstream' | 'downstream' | 'association'
  relation: CanvasEdgeRelation
}

/** 菜单所需的轻量节点摘要；同名节点依靠 ID 保持独立。 */
export interface NativeCanvasNavigationItem {
  id: string
  title: string
  kind: CanvasNodeKind
  relations: NativeCanvasNavigationRelation[]
}

/**
 * 按文档顺序生成导航索引，不把多父或循环图改造成树。
 * @param nodes 当前画布节点，只读取身份、名称与类型。
 * @param edges 当前真实连线；忽略端点已不存在的边。
 * @returns 一次 O(V + E) 扫描得到的所有节点与直接关系。
 */
export function buildNativeCanvasNavigationItems(
  nodes: readonly Pick<CanvasNode, 'id' | 'title' | 'kind'>[],
  edges: readonly Pick<CanvasEdge, 'id' | 'sourceNodeId' | 'targetNodeId' | 'relation'>[],
): NativeCanvasNavigationItem[] {
  /** 单一索引保证同名节点、多父节点与孤立节点都完整保留。 */
  const items = new Map(nodes.map((node) => [node.id, {
    id: node.id, title: node.title, kind: node.kind, relations: [],
  } as NativeCanvasNavigationItem]))
  for (const edge of edges) {
    /** 仅对有效端点建双向查询入口，关联边不伪造上下游。 */
    const source = items.get(edge.sourceNodeId)
    const target = items.get(edge.targetNodeId)
    if (!source || !target) continue
    source.relations.push({ nodeId: target.id, title: target.title, relation: edge.relation,
      direction: edge.relation === 'association' ? 'association' : 'downstream' })
    if (source !== target || edge.relation !== 'association') {
      target.relations.push({ nodeId: source.id, title: source.title, relation: edge.relation,
        direction: edge.relation === 'association' ? 'association' : 'upstream' })
    }
  }
  return [...items.values()]
}

/** 定位只修改会话视图，不携带图保存或工作台切换意图。 */
export interface NativeCanvasNodeFocusUpdate {
  viewport: DesignViewport
  selectedNodeId: string
  selectedNodeIds: string[]
}

/**
 * 将指定卡片居中到工具栏下方的可视区域，并恢复适合阅读的缩放。
 * @param node 当前权威节点，位置使用画布世界坐标。
 * @param size 与 Renderer 卡片一致的实际宽高。
 * @param viewport 当前会话视口。
 * @param surface 当前画布表面的可用像素尺寸。
 * @returns 可原子写入当前会话的选择和视口补丁。
 */
export function createNativeCanvasNodeFocusUpdate(
  node: Pick<CanvasNode, 'id' | 'position'>,
  size: { width: number; height: number },
  viewport: DesignViewport,
  surface: { width: number; height: number },
): NativeCanvasNodeFocusUpdate {
  /** 隐藏面板尚未测量时保留视口，避免产生 NaN 或无意义的缩放。 */
  const update = { viewport, selectedNodeId: node.id, selectedNodeIds: [node.id] }
  if (![surface.width, surface.height, size.width, size.height].every((value) => Number.isFinite(value) && value > 0)
    || !Number.isFinite(node.position.x) || !Number.isFinite(node.position.y)) return update
  /** 顶部预留工具栏，底部与左右各保留 24px；小面板按比例缩小边距。 */
  const top = Math.min(64, surface.height / 4)
  const bottom = Math.min(24, surface.height / 8)
  const horizontal = Math.min(24, surface.width / 8)
  /** 远景至少恢复到 75%，同时让高卡片或窄面板完整容纳目标。 */
  const readableZoom = Number.isFinite(viewport.zoom) ? Math.min(1, Math.max(0.75, viewport.zoom)) : 1
  const zoom = Math.max(0.05, Math.min(readableZoom,
    (surface.width - horizontal * 2) / size.width, (surface.height - top - bottom) / size.height))
  return { ...update, viewport: {
    x: surface.width / 2 - (node.position.x + size.width / 2) * zoom,
    y: top + (surface.height - top - bottom) / 2 - (node.position.y + size.height / 2) * zoom,
    zoom,
  } }
}
