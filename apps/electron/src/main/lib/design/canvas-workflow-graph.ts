import {
  CANVAS_WORKFLOW_IMAGE_RUN_LIMIT,
  CANVAS_WORKFLOW_NODE_LIMIT,
  CANVAS_WORKFLOW_START_NODE_LIMIT,
  compareCanvasStableIds,
  resolveCanvasEdgeBinding,
} from '@proma/shared'
import type {
  CanvasDocument,
  CanvasEdge,
  CanvasEdgeRelation,
  CanvasNode,
  CanvasWorkflowNodeStatus,
} from '@proma/shared'
import { canvasNodeCapabilityRegistry } from './canvas-node-capability-registry'

/** 单次工作流可达范围允许包含的最大 Agent 数。 */
const MAX_WORKFLOW_AGENTS = 8
/** 单次工作流允许的最大依赖深度。 */
const MAX_WORKFLOW_DEPTH = 8
/** 规划器接受的权威 Canvas 总节点上限。 */
const MAX_CANVAS_GRAPH_NODES = 1_024
/** 规划器接受的权威 Canvas 总边上限。 */
const MAX_CANVAS_GRAPH_EDGES = 4_096

/** 纯规划器输入，不包含项目服务或运行时依赖。 */
export interface CreateCanvasWorkflowGraphPlanInput {
  document: CanvasDocument
  startNodeIds: readonly string[]
  maxImageRuns: number
}

/** 确定性 Canvas 执行图，Map 的插入顺序同样使用稳定节点 ID。 */
export interface CanvasWorkflowGraphPlan {
  rootNodeIds: string[]
  reachableNodeIds: string[]
  executableNodeIds: string[]
  dependenciesByNodeId: ReadonlyMap<string, readonly string[]>
  downstreamByNodeId: ReadonlyMap<string, readonly string[]>
  depthByNodeId: ReadonlyMap<string, number>
  initialStates: ReadonlyMap<string, CanvasWorkflowNodeStatus>
}

/** 可达范围内会阻止执行的边问题。 */
interface CanvasWorkflowEdgeIssue {
  edge: CanvasEdge
  code:
    | 'CANVAS_WORKFLOW_EDGE_DANGLING'
    | 'CANVAS_WORKFLOW_EDGE_UNRESOLVED'
    | 'CANVAS_WORKFLOW_EDGE_INCOMPATIBLE'
    | 'CANVAS_WORKFLOW_EDGE_DUPLICATE'
}

/** 可达图预检失败时公开的单条 canonical 边诊断。 */
export interface CanvasWorkflowEdgeDiagnostic {
  code: CanvasWorkflowEdgeIssue['code']
  edgeId: string
  sourceNodeId: string
  sourcePort: string
  targetNodeId: string
  targetPort: string
  relation: CanvasEdgeRelation
}

/** 携带首个稳定边事实的工作流图预检错误。 */
export class CanvasWorkflowGraphError extends Error {
  readonly diagnostics: readonly CanvasWorkflowEdgeDiagnostic[]

  /**
   * 构造不暴露内部异常的图预检错误。
   * @param issue 按完整边字段选出的 canonical 首个问题。
   */
  constructor(issue: CanvasWorkflowEdgeIssue) {
    super(issue.code)
    this.name = 'CanvasWorkflowGraphError'
    this.diagnostics = [{
      code: issue.code,
      edgeId: issue.edge.id,
      sourceNodeId: issue.edge.sourceNodeId,
      sourcePort: issue.edge.sourcePort,
      targetNodeId: issue.edge.targetNodeId,
      targetPort: issue.edge.targetPort,
      relation: issue.edge.relation,
    }]
  }
}

/** 按稳定 edge ID 与完整字段比较边，保证重复边主事实与输入排列无关。 */
function compareEdges(left: CanvasEdge, right: CanvasEdge): number {
  /** 比较字段覆盖边的完整执行身份。 */
  const leftFields = [
    left.id,
    left.sourceNodeId,
    left.sourcePort,
    left.targetNodeId,
    left.targetPort,
    left.relation,
  ]
  /** 右侧字段与左侧使用相同规范顺序。 */
  const rightFields = [
    right.id,
    right.sourceNodeId,
    right.sourcePort,
    right.targetNodeId,
    right.targetPort,
    right.relation,
  ]
  for (let index = 0; index < leftFields.length; index += 1) {
    const comparison = compareCanvasStableIds(leftFields[index]!, rightFields[index]!)
    if (comparison !== 0) return comparison
  }
  return 0
}

/** 按完整边字段和错误码比较问题，保证输入置换不改变首个错误。 */
function compareEdgeIssues(left: CanvasWorkflowEdgeIssue, right: CanvasWorkflowEdgeIssue): number {
  const edgeComparison = compareEdges(left.edge, right.edge)
  return edgeComparison === 0 ? compareCanvasStableIds(left.code, right.code) : edgeComparison
}

/** 将一条边问题加入线性预检集合。 */
function appendEdgeIssue(
  issues: CanvasWorkflowEdgeIssue[],
  edge: CanvasEdge,
  code: CanvasWorkflowEdgeIssue['code'],
): void {
  issues.push({ edge, code })
}

/** 返回节点当前是否已有可以满足下游的正式产物。 */
function hasCommittedArtifact(node: CanvasNode): boolean {
  switch (node.kind) {
    case 'agent': return node.outputPointer !== undefined
    case 'image': return node.adoptedAssetId !== undefined
    case 'document':
    case 'webview': return Number.isSafeInteger(node.contentRevision) && node.contentRevision >= 0
  }
}

/** 通过能力注册表判断节点是否支持运行，避免调度器自行维护节点类型名单。 */
function canRunNode(node: CanvasNode): boolean {
  /** available 表示规划阶段只检查静态能力，运行态冲突由调度服务复核。 */
  const capabilities = canvasNodeCapabilityRegistry.list(node, { availability: 'available' })
  return capabilities.includes('run')
}

/**
 * 按 canonical 节点顺序投影邻接表。
 * @param canonicalNodeIds 已按稳定 ID 排序的可达节点。
 * @param adjacency owner 到 member 的 Set 索引。
 * @param ownersByMember member 到 owner 的反向 Set 索引。
 * @returns Map 和成员数组均按稳定节点 ID 排列。
 */
function projectCanonicalAdjacency(
  canonicalNodeIds: readonly string[],
  adjacency: ReadonlyMap<string, ReadonlySet<string>>,
  ownersByMember: ReadonlyMap<string, ReadonlySet<string>>,
): ReadonlyMap<string, readonly string[]> {
  /** 构建阶段使用可变数组，返回后仅通过只读合同公开。 */
  const projected = new Map<string, string[]>()
  for (const ownerId of canonicalNodeIds) projected.set(ownerId, [])
  for (const memberId of canonicalNodeIds) {
    for (const ownerId of ownersByMember.get(memberId) ?? []) {
      if (!projected.has(ownerId) || !adjacency.get(ownerId)?.has(memberId)) continue
      projected.get(ownerId)?.push(memberId)
    }
  }
  return projected
}

/**
 * 从一个或多个 Agent 根构建无副作用的正向可达执行图。
 * @param input 权威 Canvas 文档、Agent 根和本次图片授权数。
 * @returns 可供调度器消费的稳定、有界拓扑计划。
 */
export function createCanvasWorkflowGraphPlan(
  input: CreateCanvasWorkflowGraphPlanInput,
): CanvasWorkflowGraphPlan {
  if (input.document.nodes.length > MAX_CANVAS_GRAPH_NODES) {
    throw new Error('CANVAS_WORKFLOW_GRAPH_NODE_LIMIT_EXCEEDED')
  }
  if (input.document.edges.length > MAX_CANVAS_GRAPH_EDGES) {
    throw new Error('CANVAS_WORKFLOW_EDGE_LIMIT_EXCEEDED')
  }
  if (!Number.isSafeInteger(input.maxImageRuns)
    || input.maxImageRuns < 0
    || input.maxImageRuns > CANVAS_WORKFLOW_IMAGE_RUN_LIMIT) {
    throw new Error('CANVAS_WORKFLOW_IMAGE_RUN_LIMIT_INVALID')
  }
  /** 根集合拒绝空输入、重复身份和超过 Agent 总预算的请求。 */
  const rootNodeIdSet = new Set(input.startNodeIds)
  if (input.startNodeIds.length < 1
    || input.startNodeIds.length > CANVAS_WORKFLOW_START_NODE_LIMIT
    || rootNodeIdSet.size !== input.startNodeIds.length) {
    throw new Error('CANVAS_WORKFLOW_START_NODE_INVALID')
  }

  /** 权威节点索引确保后续边解析均为常数时间。 */
  const nodesById = new Map<string, CanvasNode>()
  for (const node of input.document.nodes) {
    if (nodesById.has(node.id)) throw new Error('CANVAS_WORKFLOW_GRAPH_INVALID')
    nodesById.set(node.id, node)
  }
  for (const rootNodeId of input.startNodeIds) {
    if (nodesById.get(rootNodeId)?.kind !== 'agent') {
      throw new Error('CANVAS_WORKFLOW_START_NODE_INVALID')
    }
  }

  /** 所有合法 bound 出边只建立一次。 */
  const downstream = new Map<string, Set<string>>()
  /** 所有合法 bound 入边只建立一次。 */
  const dependencies = new Map<string, Set<string>>()
  /** 非 association 图问题先收集，待可达范围确定后再判断是否阻断。 */
  const edgeIssues: CanvasWorkflowEdgeIssue[] = []
  /** 每个 source/target 方向聚合全部 bound 边，扫描后选择 canonical 主边。 */
  const executablePairEdges = new Map<string, CanvasEdge[]>()

  for (const edge of input.document.edges) {
    if (edge.relation === 'association') continue
    /** 边两端必须同时存在于权威节点表。 */
    const source = nodesById.get(edge.sourceNodeId)
    const target = nodesById.get(edge.targetNodeId)
    if (!source || !target) {
      appendEdgeIssue(edgeIssues, edge, 'CANVAS_WORKFLOW_EDGE_DANGLING')
      continue
    }
    /** 共享解析器是端口和节点类型兼容性的唯一事实源。 */
    const resolution = resolveCanvasEdgeBinding(edge, source.kind, target.kind)
    if (resolution.state !== 'bound') {
      appendEdgeIssue(
        edgeIssues,
        edge,
        resolution.state === 'incompatible'
          ? 'CANVAS_WORKFLOW_EDGE_INCOMPATIBLE'
          : 'CANVAS_WORKFLOW_EDGE_UNRESOLVED',
      )
      continue
    }
    /** 重复执行方向先聚合，邻接图只保留一次依赖。 */
    const pairKey = `${source.id}\0${target.id}`
    const pairEdges = executablePairEdges.get(pairKey) ?? []
    pairEdges.push(edge)
    executablePairEdges.set(pairKey, pairEdges)
    const outgoing = downstream.get(source.id) ?? new Set<string>()
    outgoing.add(target.id)
    downstream.set(source.id, outgoing)
    const incoming = dependencies.get(target.id) ?? new Set<string>()
    incoming.add(source.id)
    dependencies.set(target.id, incoming)
  }
  /** 每组保留完整字段最小的 canonical 主边，其余边稳定判为重复。 */
  for (const pairEdges of executablePairEdges.values()) {
    if (pairEdges.length < 2) continue
    let canonicalEdge = pairEdges[0]!
    for (let index = 1; index < pairEdges.length; index += 1) {
      if (compareEdges(pairEdges[index]!, canonicalEdge) < 0) canonicalEdge = pairEdges[index]!
    }
    for (const edge of pairEdges) {
      if (edge !== canonicalEdge) appendEdgeIssue(edgeIssues, edge, 'CANVAS_WORKFLOW_EDGE_DUPLICATE')
    }
  }

  /** 从 Agent 根沿合法 bound 出边正向收集可达节点。 */
  const reachableNodeIds = new Set<string>()
  /** 每个可达节点最多进入待处理栈一次。 */
  const pendingNodeIds = [...input.startNodeIds]
  while (pendingNodeIds.length > 0) {
    const nodeId = pendingNodeIds.pop()!
    if (reachableNodeIds.has(nodeId)) continue
    reachableNodeIds.add(nodeId)
    if (reachableNodeIds.size > CANVAS_WORKFLOW_NODE_LIMIT) {
      throw new Error('CANVAS_WORKFLOW_NODE_LIMIT_EXCEEDED')
    }
    for (const targetId of downstream.get(nodeId) ?? []) {
      if (!reachableNodeIds.has(targetId)) pendingNodeIds.push(targetId)
    }
  }

  /** 只有任一现存端点进入可达范围的坏边才属于本次执行预检。 */
  let canonicalReachableIssue: CanvasWorkflowEdgeIssue | undefined
  for (const issue of edgeIssues) {
    if (!reachableNodeIds.has(issue.edge.sourceNodeId)
      && !reachableNodeIds.has(issue.edge.targetNodeId)) continue
    if (!canonicalReachableIssue || compareEdgeIssues(issue, canonicalReachableIssue) < 0) {
      canonicalReachableIssue = issue
    }
  }
  if (canonicalReachableIssue) throw new CanvasWorkflowGraphError(canonicalReachableIssue)

  /** 可达 Agent 数量包含 roots 和下游 Agent，不受当前是否已有输出影响。 */
  let reachableAgentCount = 0
  for (const nodeId of reachableNodeIds) {
    if (nodesById.get(nodeId)?.kind === 'agent') reachableAgentCount += 1
  }
  if (reachableAgentCount > MAX_WORKFLOW_AGENTS) {
    throw new Error('CANVAS_WORKFLOW_AGENT_LIMIT_EXCEEDED')
  }

  /** 计划内最多 32 个节点，因此稳定 ID 排序具有固定上界。 */
  const canonicalNodeIds = [...reachableNodeIds].sort(compareCanvasStableIds)
  /** 入边与出边 Map 及成员数组全部规范为稳定节点顺序。 */
  const dependenciesByNodeId = projectCanonicalAdjacency(canonicalNodeIds, dependencies, downstream)
  const downstreamByNodeId = projectCanonicalAdjacency(canonicalNodeIds, downstream, dependencies)
  /** Kahn 入度只统计可达子图内部依赖。 */
  const indegreeByNodeId = new Map<string, number>()
  for (const nodeId of canonicalNodeIds) {
    indegreeByNodeId.set(nodeId, dependenciesByNodeId.get(nodeId)?.length ?? 0)
  }
  /** 第一层使用 canonical 顺序，后续每层沿用相同规则。 */
  let readyNodeIds = canonicalNodeIds.filter((nodeId) => indegreeByNodeId.get(nodeId) === 0)
  /** 最终拓扑顺序同时作为 reachableNodeIds 与状态 Map 的公开顺序。 */
  const orderedNodeIds: string[] = []
  /** 节点深度取所有直接上游深度的最大值加一。 */
  const depthByNodeId = new Map<string, number>()
  while (readyNodeIds.length > 0) {
    /** 下一层先用 Set 聚合，再通过 canonical 节点数组规范顺序。 */
    const nextReadyNodeIds = new Set<string>()
    for (const nodeId of readyNodeIds) {
      orderedNodeIds.push(nodeId)
      let depth = 0
      for (const dependencyId of dependenciesByNodeId.get(nodeId) ?? []) {
        depth = Math.max(depth, (depthByNodeId.get(dependencyId) ?? 0) + 1)
      }
      if (depth > MAX_WORKFLOW_DEPTH) throw new Error('CANVAS_WORKFLOW_DEPTH_LIMIT_EXCEEDED')
      depthByNodeId.set(nodeId, depth)
      for (const targetId of downstreamByNodeId.get(nodeId) ?? []) {
        const nextIndegree = (indegreeByNodeId.get(targetId) ?? 0) - 1
        indegreeByNodeId.set(targetId, nextIndegree)
        if (nextIndegree === 0) nextReadyNodeIds.add(targetId)
      }
    }
    readyNodeIds = canonicalNodeIds.filter((nodeId) => nextReadyNodeIds.has(nodeId))
  }
  if (orderedNodeIds.length !== canonicalNodeIds.length) throw new Error('CANVAS_WORKFLOW_CYCLE')

  /** 初始状态与图片授权按稳定拓扑顺序分配。 */
  const initialStates = new Map<string, CanvasWorkflowNodeStatus>()
  /** 已占用的图片任务授权数。 */
  let imageRunCount = 0
  for (const nodeId of orderedNodeIds) {
    const node = nodesById.get(nodeId)!
    if (rootNodeIdSet.has(nodeId)) {
      initialStates.set(nodeId, 'started')
      continue
    }
    if (hasCommittedArtifact(node) && node.upstreamChange === undefined) {
      initialStates.set(nodeId, 'satisfied')
      continue
    }
    if (!canRunNode(node)) {
      initialStates.set(nodeId, 'blocked')
      continue
    }
    if (node.kind === 'image') {
      if (imageRunCount >= input.maxImageRuns) {
        initialStates.set(nodeId, 'waiting-approval')
        continue
      }
      imageRunCount += 1
    }
    initialStates.set(nodeId, 'started')
  }

  /** 调度器仍须按 dependenciesByNodeId 等待上游，列表本身只是一次执行许可集合。 */
  const executableNodeIds = orderedNodeIds.filter((nodeId) => initialStates.get(nodeId) === 'started')
  return {
    rootNodeIds: [...rootNodeIdSet].sort(compareCanvasStableIds),
    reachableNodeIds: orderedNodeIds,
    executableNodeIds,
    dependenciesByNodeId,
    downstreamByNodeId,
    depthByNodeId,
    initialStates,
  }
}
