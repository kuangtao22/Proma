import { createCanvasLayoutSpatialIndex } from '@proma/shared'
import type { CanvasEdge, CanvasLayoutRect, CanvasMutation, DesignPoint } from '@proma/shared'
import type { ElkNode, ElkExtendedEdge } from 'elkjs/lib/elk-api'
import type { NativeCanvasLayoutEngine } from './native-canvas-layout-client'

/** 布局只接收轻量几何与关系，不复制图片、消息或节点配置。 */
export interface NativeCanvasLayoutInput {
  nodes: readonly CanvasLayoutRect[]
  edges: readonly Pick<CanvasEdge, 'sourceNodeId' | 'targetNodeId' | 'relation'>[]
  scopeNodeIds: readonly string[]
  blockedNodeIds: ReadonlySet<string>
}

/** 单次整理的计算上限；超大画布可通过选区分批处理。 */
const MAX_MOVABLE_NODES = 2_000
/** 投影边预算独立于磁盘历史，不允许密集图无限扩大 Worker 请求。 */
const MAX_LAYOUT_EDGES = 10_000
/** 既有卡片最小净间距；引擎间距略大，为坐标取整保留余量。 */
const MIN_GAP = 24
/** 子流程保持左右方向，交叉优化由成熟分层引擎执行。 */
const FLOW_OPTIONS = {
  'elk.algorithm': 'layered',
  'elk.direction': 'RIGHT',
  'elk.edgeRouting': 'POLYLINE',
  'elk.randomSeed': '1',
  'elk.padding': '[top=0,left=0,bottom=0,right=0]',
  'elk.spacing.nodeNode': '40',
  'elk.spacing.componentComponent': '80',
  'elk.layered.spacing.nodeNodeBetweenLayers': '80',
  'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
  'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
}
/** 关联组仅紧凑打包，不给无向关联制造左右层级。 */
const PACK_OPTIONS = {
  'elk.algorithm': 'rectpacking',
  'elk.padding': '[top=0,left=0,bottom=0,right=0]',
  'elk.spacing.nodeNode': '80',
  'elk.aspectRatio': '1.6',
}

/**
 * 以无向连通性收集节点组，顺序沿用权威文档，栈遍历避免深链递归溢出。
 * @param ids 待分组的稳定节点顺序。
 * @param edges 仅表达本轮分组用途的端点对。
 * @returns 连通组及常数时间的节点归属索引。
 */
function connectedGroups(ids: readonly string[], edges: readonly (readonly [string, string])[]): {
  groups: string[][]
  membership: Map<string, number>
} {
  /** 邻接表只构造一次，分组开销为 O(V + E)。 */
  const neighbors = new Map(ids.map((id) => [id, [] as string[]]))
  for (const [source, target] of edges) {
    neighbors.get(source)?.push(target)
    neighbors.get(target)?.push(source)
  }
  /** 归属同时作为已访问集合，循环图不会重复入栈。 */
  const membership = new Map<string, number>()
  const groups: string[][] = []
  for (const id of ids) {
    if (membership.has(id)) continue
    const groupIndex = groups.length
    const pending = [id]
    const group: string[] = []
    membership.set(id, groupIndex)
    while (pending.length > 0) {
      const current = pending.pop()!
      group.push(current)
      for (const neighbor of neighbors.get(current) ?? []) {
        if (membership.has(neighbor)) continue
        membership.set(neighbor, groupIndex)
        pending.push(neighbor)
      }
    }
    groups.push(group)
  }
  return { groups, membership }
}

/**
 * 将同一参考源的大量末端流程紧凑打包，避免星形图拉成数万像素的单列。
 * @param groups 已完成强关系布局的流程边界。
 * @param references 去重后的流程引用边。
 * @param createId 与业务身份隔离的容器身份生成器。
 * @returns 仅用于第二次 ELK 计算的节点与边，业务图和流程内部几何不变。
 */
function packReferenceSiblings(
  groups: readonly ElkNode[],
  references: readonly ElkExtendedEdge[],
  createId: () => string,
): Pick<ElkNode, 'children' | 'edges'> {
  /** 有后续引用或多个引用来源的流程不折叠，保留跨流程方向和汇合关系。 */
  const outgoing = new Set(references.map((edge) => edge.sources[0]!))
  const parents = new Map<string, string | null>()
  for (const edge of references) {
    const target = edge.targets[0]!
    parents.set(target, parents.has(target) ? null : edge.sources[0]!)
  }
  /** 稳定文档顺序收集同源末端，整个预处理为 O(V + E)。 */
  const siblings = new Map<string, ElkNode[]>()
  for (const group of groups) {
    const parent = parents.get(group.id)
    if (!parent || outgoing.has(group.id)) continue
    const bucket = siblings.get(parent) ?? []
    bucket.push(group)
    siblings.set(parent, bucket)
  }
  /** 只传流程边界给第二轮，不能再次计算已固定的内部强关系。 */
  const boxes = new Map(groups.map((group) => [group.id, {
    id: group.id, width: group.width, height: group.height,
  }]))
  const packed = new Map<string, ElkNode>()
  for (const bucket of siblings.values()) {
    if (bucket.length < 4) continue
    const container: ElkNode = {
      id: createId(), layoutOptions: { ...PACK_OPTIONS },
      children: bucket.map((group) => boxes.get(group.id)!),
    }
    for (const group of bucket) packed.set(group.id, container)
  }
  /** 每个容器与引用只输出一次；身份集合不依赖节点标题或随机 ID 排序。 */
  const children = [...new Map(groups.map((group) => {
    const box = packed.get(group.id) ?? boxes.get(group.id)!
    return [box.id, box] as const
  })).values()]
  const edges = new Map<string, ElkExtendedEdge>()
  for (const edge of references) {
    const source = edge.sources[0]!
    const target = packed.get(edge.targets[0]!)?.id ?? edge.targets[0]!
    const key = JSON.stringify([source, target])
    if (!edges.has(key)) edges.set(key, { ...edge, sources: [source], targets: [target] })
  }
  return { children, edges: [...edges.values()] }
}

/** 检查几何范围，避免异常尺寸令空间桶枚举占用无界内存。 */
function assertRect(rect: CanvasLayoutRect): void {
  if (!rect.id || !Number.isFinite(rect.x) || !Number.isFinite(rect.y)
    || Math.abs(rect.x) > 1e9 || Math.abs(rect.y) > 1e9
    || !Number.isFinite(rect.width) || !Number.isFinite(rect.height)
    || rect.width <= 0 || rect.height <= 0 || rect.width > 4096 || rect.height > 4096) {
    throw new Error('CANVAS_LAYOUT_GEOMETRY_INVALID')
  }
}

/**
 * 读取三层布局的叶节点绝对位置，严格拒绝缺项、重复身份和非有限坐标。
 * @param graph 引擎返回的层次图。
 * @param nodeIds 本次确实允许移动的叶节点集合。
 * @returns 未归一化的节点坐标；不接受部分成功结果。
 */
function readPositions(graph: ElkNode, nodeIds: ReadonlySet<string>): Map<string, DesignPoint> {
  const positions = new Map<string, DesignPoint>()
  /** 显式栈同时限制深度与元素数量，防止错误引擎结果无限展开。 */
  const pending = [{ node: graph, x: 0, y: 0, depth: 0 }]
  let visited = 0
  while (pending.length > 0) {
    const { node, x, y, depth } = pending.pop()!
    if (++visited > nodeIds.size * 4 + 1 || depth > 3) throw new Error('CANVAS_LAYOUT_RESULT_INVALID')
    const point = { x: x + (node.x ?? 0), y: y + (node.y ?? 0) }
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)
      || Math.abs(point.x) > 1e9 || Math.abs(point.y) > 1e9) throw new Error('CANVAS_LAYOUT_RESULT_INVALID')
    if (nodeIds.has(node.id)) {
      if (positions.has(node.id) || node.x === undefined || node.y === undefined) {
        throw new Error('CANVAS_LAYOUT_RESULT_INVALID')
      }
      positions.set(node.id, point)
    } else if (!node.children?.length) {
      throw new Error('CANVAS_LAYOUT_RESULT_INVALID')
    }
    for (const child of node.children ?? []) pending.push({ node: child, ...point, depth: depth + 1 })
  }
  if (positions.size !== nodeIds.size) throw new Error('CANVAS_LAYOUT_RESULT_INVALID')
  return positions
}

/**
 * 将稳定布局放回原范围附近，整体避让固定卡片，内部依赖链不被逐点挪散。
 * @param movable 当前允许移动且带真实尺寸的卡片。
 * @param fixed 范围外及运行中的固定卡片。
 * @param positions 引擎计算的相对位置。
 * @returns 只包含发生变化节点的单次位置 mutation。
 */
function placeLayout(
  movable: readonly CanvasLayoutRect[],
  fixed: readonly CanvasLayoutRect[],
  positions: ReadonlyMap<string, DesignPoint>,
): Extract<CanvasMutation, { type: 'move-nodes' }> {
  /** 原范围左上角稳定锚定；重复整理不会随引擎 padding 漂移。 */
  const origin = { x: Infinity, y: Infinity }
  const minimum = { x: Infinity, y: Infinity }
  for (const node of movable) {
    origin.x = Math.min(origin.x, node.x)
    origin.y = Math.min(origin.y, node.y)
    minimum.x = Math.min(minimum.x, positions.get(node.id)!.x)
    minimum.y = Math.min(minimum.y, positions.get(node.id)!.y)
  }
  /** 先验证引擎内部几何，发现重叠时不输出部分布局。 */
  const internal = createCanvasLayoutSpatialIndex([], MIN_GAP)
  const rectangles = movable.map((node) => {
    const point = positions.get(node.id)!
    const rect = {
      ...node,
      x: Math.round((point.x - minimum.x + origin.x) * 100) / 100,
      y: Math.round((point.y - minimum.y + origin.y) * 100) / 100,
    }
    assertRect(rect)
    if (internal.overlaps(rect)) throw new Error('CANVAS_LAYOUT_RESULT_OVERLAP')
    internal.insert(rect)
    return rect
  })
  /** 固定障碍仅建一次空间索引，每次试放按局部桶查询。 */
  const obstacles = createCanvasLayoutSpatialIndex(fixed, MIN_GAP)
  const bounds = rectangles.reduce((result, rect) => ({
    right: Math.max(result.right, rect.x + rect.width),
    bottom: Math.max(result.bottom, rect.y + rect.height),
  }), { right: origin.x, bottom: origin.y })
  let shiftY = 0
  /** 最多八轮局部避让；极密障碍最后整体放到固定区下方，必然终止。 */
  for (let attempt = 0; rectangles.some((rect) => obstacles.overlaps({ ...rect, y: rect.y + shiftY })); attempt += 1) {
    let nextBottom = origin.y + shiftY
    for (const rect of fixed) {
      if (attempt >= 7 || (rect.x < bounds.right + MIN_GAP && rect.x + rect.width + MIN_GAP > origin.x
        && rect.y < bounds.bottom + shiftY + MIN_GAP && rect.y + rect.height + MIN_GAP > origin.y + shiftY)) {
        nextBottom = Math.max(nextBottom, rect.y + rect.height + MIN_GAP)
      }
    }
    shiftY = nextBottom - origin.y
    if (attempt >= 8) throw new Error('CANVAS_LAYOUT_RESULT_OVERLAP')
  }
  return {
    type: 'move-nodes',
    positions: rectangles.flatMap((rect, index) => {
      const position = { x: rect.x, y: rect.y + shiftY }
      assertRect({ ...rect, ...position })
      const original = movable[index]!
      return position.x === original.x && position.y === original.y ? [] : [{ nodeId: rect.id, position }]
    }),
  }
}

/**
 * 两阶段关系排版：依赖链内部使用 layered，关联组件打包，引用安排组件相对位置。
 * @param input 当前卡片矩形、业务连线及显式整理范围。
 * @param layoutGraph 由本次独立 Worker 提供的 ELK 调用，不允许 UI 线程重算法兜底。
 * @returns 经过完整性和碰撞验证的单次位置 mutation，不修改业务图。
 */
export async function arrangeNativeCanvasLayout(
  input: NativeCanvasLayoutInput,
  layoutGraph: NativeCanvasLayoutEngine,
): Promise<Extract<CanvasMutation, { type: 'move-nodes' }>> {
  const scope = new Set(input.scopeNodeIds)
  const movable = input.nodes.filter((node) => scope.has(node.id) && !input.blockedNodeIds.has(node.id))
  if (movable.length === 0) return { type: 'move-nodes', positions: [] }
  if (movable.length > MAX_MOVABLE_NODES) throw new Error('CANVAS_LAYOUT_TOO_LARGE')
  for (const node of input.nodes) assertRect(node)
  const ids = new Set(movable.map((node) => node.id))
  if (ids.size !== movable.length) throw new Error('CANVAS_LAYOUT_GEOMETRY_INVALID')
  const fixed = input.nodes.filter((node) => !ids.has(node.id))
  if (movable.length === 1) return placeLayout(movable, fixed, new Map([[movable[0]!.id, { x: 0, y: 0 }]]))
  const edges = input.edges.filter((edge) => ids.has(edge.sourceNodeId) && ids.has(edge.targetNodeId)
    && edge.sourceNodeId !== edge.targetNodeId)
  if (edges.length > MAX_LAYOUT_EDGES) throw new Error('CANVAS_LAYOUT_TOO_LARGE')
  /** 真实依赖先划分组件；弱关系永远不能改变组件内部的依赖层级。 */
  const strongEdges = edges.filter((edge) => edge.relation === 'derives' || edge.relation === 'depends-on')
  const strong = connectedGroups([...ids], strongEdges.map((edge) => [edge.sourceNodeId, edge.targetNodeId]))
  /** 合成身份与所有业务节点身份隔离，避免自定义 ID 与容器 ID 碰撞。 */
  const reserved = new Set(ids)
  let nextId = 0
  const syntheticId = (): string => {
    let id: string
    do { id = `canvas-layout-${nextId++}` } while (reserved.has(id))
    reserved.add(id)
    return id
  }
  const components: ElkNode[] = strong.groups.map(() => ({
    id: syntheticId(), layoutOptions: { ...FLOW_OPTIONS }, children: [], edges: [],
  }))
  for (const node of movable) components[strong.membership.get(node.id)!]!.children!.push({
    id: node.id, width: node.width, height: node.height,
  })
  for (const edge of strongEdges) components[strong.membership.get(edge.sourceNodeId)!]!.edges!.push({
    id: syntheticId(), sources: [edge.sourceNodeId], targets: [edge.targetNodeId],
  })
  /** 无向关联只把流程放进同一个紧凑包，不生成有向执行边。 */
  const componentIds = components.map((component) => component.id)
  const componentId = (nodeId: string): string => components[strong.membership.get(nodeId)!]!.id
  const associations = connectedGroups(componentIds, edges.filter((edge) => edge.relation === 'association')
    .map((edge) => [componentId(edge.sourceNodeId), componentId(edge.targetNodeId)]))
  const groups: ElkNode[] = associations.groups.map(() => ({
    id: syntheticId(), layoutOptions: { ...PACK_OPTIONS }, children: [],
  }))
  for (const component of components) groups[associations.membership.get(component.id)!]!.children!.push(component)
  const rootId = syntheticId()
  const prepared = await layoutGraph({ id: rootId, layoutOptions: { ...PACK_OPTIONS }, children: groups })
  /** 第一轮结果先严格核验，避免缺失子图被第二轮打包掩盖。 */
  readPositions(prepared, ids)
  const groupId = (nodeId: string): string => groups[associations.membership.get(componentId(nodeId))!]!.id
  const referencePairs = new Map<string, Set<string>>()
  for (const edge of edges) {
    if (edge.relation !== 'reference') continue
    const source = groupId(edge.sourceNodeId)
    const target = groupId(edge.targetNodeId)
    if (source === target) continue
    const targets = referencePairs.get(source) ?? new Set<string>()
    targets.add(target)
    referencePairs.set(source, targets)
  }
  /** 组件间重复引用合并，只影响视觉布局，不复制或改写原边。 */
  const references: ElkExtendedEdge[] = []
  for (const [source, targets] of referencePairs) for (const target of targets) {
    references.push({ id: syntheticId(), sources: [source], targets: [target] })
  }
  if (references.length === 0) return placeLayout(movable, fixed, readPositions(prepared, ids))
  const positioned = await layoutGraph({
    id: rootId, layoutOptions: { ...FLOW_OPTIONS },
    ...packReferenceSiblings(prepared.children!, references, syntheticId),
  })
  /** 第二轮只更新外层组位置，内部上下游仍保持第一轮已核验的几何。 */
  const offsets = readPositions(positioned, new Set(groups.map((group) => group.id)))
  const combined: ElkNode = {
    id: rootId,
    children: prepared.children!.map((group) => ({ ...group, ...offsets.get(group.id)! })),
  }
  return placeLayout(movable, fixed, readPositions(combined, ids))
}
