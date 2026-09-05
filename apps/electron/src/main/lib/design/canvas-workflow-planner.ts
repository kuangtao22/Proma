import {
  CANVAS_WORKFLOW_IMAGE_RUN_LIMIT,
  CANVAS_WORKFLOW_NODE_LIMIT,
  resolveCanvasEdgeBinding,
} from '@proma/shared'
import type {
  CanvasDocument,
  CanvasEdge,
  CanvasNode,
  CanvasWorkflowNodeStatus,
} from '@proma/shared'

/** 单次规划允许检查的权威画布节点总量，先限制输入再建立索引。 */
export const CANVAS_WORKFLOW_GRAPH_NODE_LIMIT = 1_024
/** 单次规划允许检查的权威画布边总量，避免异常文档放大内存。 */
export const CANVAS_WORKFLOW_EDGE_LIMIT = 4_096
/** 单次工作流最多包含的 Canvas Agent 数量。 */
export const CANVAS_WORKFLOW_AGENT_LIMIT = 8
/** 单次工作流允许的最长依赖边数。 */
export const CANVAS_WORKFLOW_DEPTH_LIMIT = 8

/** 规划器可公开的稳定图诊断。 */
export type CanvasWorkflowDiagnosticCode =
  | 'CANVAS_WORKFLOW_EDGE_DANGLING'
  | 'CANVAS_WORKFLOW_EDGE_UNRESOLVED'
  | 'CANVAS_WORKFLOW_EDGE_INCOMPATIBLE'
  | 'CANVAS_WORKFLOW_EDGE_DUPLICATE'
  | 'CANVAS_WORKFLOW_CYCLE'
  | 'CANVAS_WORKFLOW_NON_RUNNABLE_INPUT_STALE'

/** 单条诊断只携带稳定图身份，不暴露内部异常。 */
export interface CanvasWorkflowDiagnostic {
  code: CanvasWorkflowDiagnosticCode
  nodeId: string | null
  edgeId: string | null
}

/** 纯规划器输入；requestedNodeIds 是本次唯一执行许可范围。 */
export interface CreateCanvasWorkflowPlanInput {
  document: CanvasDocument
  requestedNodeIds: readonly string[]
  maxImageRuns: number
}

/** 无服务、无 I/O 的确定性工作流计划。 */
export interface CanvasWorkflowPlan {
  requestedNodeIds: string[]
  orderedNodeIds: string[]
  executableNodeIds: string[]
  dependenciesByNodeId: ReadonlyMap<string, readonly string[]>
  downstreamByNodeId: ReadonlyMap<string, readonly string[]>
  depthByNodeId: ReadonlyMap<string, number>
  initialStates: ReadonlyMap<string, CanvasWorkflowNodeStatus>
  diagnostics: CanvasWorkflowDiagnostic[]
}

/** 被非法入边直接阻断的目标节点及其诊断。 */
interface InvalidInboundEdge {
  edge: CanvasEdge
  diagnosticCode: Extract<
    CanvasWorkflowDiagnosticCode,
    'CANVAS_WORKFLOW_EDGE_DANGLING'
      | 'CANVAS_WORKFLOW_EDGE_UNRESOLVED'
      | 'CANVAS_WORKFLOW_EDGE_INCOMPATIBLE'
      | 'CANVAS_WORKFLOW_EDGE_DUPLICATE'
  >
}

/** 返回节点是否已有可向下游传播的正式产物。 */
function hasCommittedArtifact(node: CanvasNode): boolean {
  switch (node.kind) {
    case 'agent': return node.outputPointer !== undefined
    case 'image': return node.adoptedAssetId !== undefined
    case 'document':
    case 'webview': return Number.isSafeInteger(node.contentRevision) && node.contentRevision >= 0
  }
}

/** 将 Map 中的 Set 按权威节点顺序投影为只读数组，避免边 JSON 顺序影响结果。 */
function projectAdjacency(
  nodeIdsInDocumentOrder: readonly string[],
  adjacency: ReadonlyMap<string, ReadonlySet<string>>,
  ownersByMember: ReadonlyMap<string, ReadonlySet<string>>,
  plannedNodeIds: ReadonlySet<string>,
): ReadonlyMap<string, readonly string[]> {
  /** 可变构建数组为每个计划节点预建，最后只通过只读接口公开。 */
  const projected = new Map<string, string[]>()
  for (const ownerId of nodeIdsInDocumentOrder) {
    if (!plannedNodeIds.has(ownerId)) continue
    projected.set(ownerId, [])
  }
  /** 成员只扫描一次，并通过反向索引追加到所属数组，保持 O(nodes + edges)。 */
  for (const memberId of nodeIdsInDocumentOrder) {
    if (!plannedNodeIds.has(memberId)) continue
    for (const ownerId of ownersByMember.get(memberId) ?? []) {
      if (!plannedNodeIds.has(ownerId) || !adjacency.get(ownerId)?.has(memberId)) continue
      projected.get(ownerId)?.push(memberId)
    }
  }
  return projected
}

/**
 * 规划用户明确请求的节点及其必要可信上游。
 * @param input 权威文档、明确请求节点和本次图片授权数。
 * @returns 无副作用、预算有界且拓扑顺序稳定的执行计划。
 */
export function createCanvasWorkflowPlan(input: CreateCanvasWorkflowPlanInput): CanvasWorkflowPlan {
  if (input.document.nodes.length > CANVAS_WORKFLOW_GRAPH_NODE_LIMIT) {
    throw new Error('CANVAS_WORKFLOW_GRAPH_NODE_LIMIT_EXCEEDED')
  }
  if (input.document.edges.length > CANVAS_WORKFLOW_EDGE_LIMIT) {
    throw new Error('CANVAS_WORKFLOW_EDGE_LIMIT_EXCEEDED')
  }
  if (!Number.isSafeInteger(input.maxImageRuns)
    || input.maxImageRuns < 0
    || input.maxImageRuns > CANVAS_WORKFLOW_IMAGE_RUN_LIMIT) {
    throw new Error('CANVAS_WORKFLOW_IMAGE_RUN_LIMIT_INVALID')
  }
  /** 去重后的请求集合同时用于拒绝歧义输入和限定反向闭包。 */
  const requestedNodeIdSet = new Set(input.requestedNodeIds)
  if (requestedNodeIdSet.size !== input.requestedNodeIds.length
    || input.requestedNodeIds.length > CANVAS_WORKFLOW_NODE_LIMIT) {
    throw new Error('CANVAS_WORKFLOW_REQUEST_INVALID')
  }

  /** 权威节点索引只建立一次，后续所有边校验保持常数时间查询。 */
  const nodesById = new Map<string, CanvasNode>()
  /** 权威节点顺序用于稳定投影和分层拓扑。 */
  const nodeIdsInDocumentOrder: string[] = []
  for (const node of input.document.nodes) {
    if (nodesById.has(node.id)) throw new Error('CANVAS_WORKFLOW_GRAPH_INVALID')
    nodesById.set(node.id, node)
    nodeIdsInDocumentOrder.push(node.id)
  }
  for (const requestedNodeId of input.requestedNodeIds) {
    if (!nodesById.has(requestedNodeId)) {
      throw new Error('CANVAS_WORKFLOW_REQUEST_NODE_NOT_FOUND')
    }
  }

  /** bound 入边索引用于反向收集必要上游。 */
  const dependencies = new Map<string, Set<string>>()
  /** bound 出边索引用于拓扑推进和阻断传播。 */
  const downstream = new Map<string, Set<string>>()
  /** 非法执行边按目标聚合，只阻断实际进入计划的分支。 */
  const invalidInboundEdges = new Map<string, InvalidInboundEdge[]>()
  /** 非法边对象直接映射诊断码，输出诊断时无需重新扫描目标数组。 */
  const invalidCodeByEdge = new Map<CanvasEdge, InvalidInboundEdge['diagnosticCode']>()
  /** 所有悬空边仍形成诊断，便于调用方展示图问题。 */
  const globalDanglingDiagnostics: CanvasWorkflowDiagnostic[] = []
  /** 同一 source/target 的第二条 bound 边属于歧义执行依赖。 */
  const executablePairs = new Set<string>()

  for (const edge of input.document.edges) {
    if (edge.relation === 'association') continue
    /** 两端必须来自本次权威节点索引。 */
    const source = nodesById.get(edge.sourceNodeId)
    const target = nodesById.get(edge.targetNodeId)
    if (!source || !target) {
      const nodeId = target?.id ?? source?.id ?? null
      const diagnostic = { code: 'CANVAS_WORKFLOW_EDGE_DANGLING' as const, nodeId, edgeId: edge.id }
      globalDanglingDiagnostics.push(diagnostic)
      if (target) {
        const invalid = invalidInboundEdges.get(target.id) ?? []
        invalid.push({ edge, diagnosticCode: diagnostic.code })
        invalidInboundEdges.set(target.id, invalid)
        invalidCodeByEdge.set(edge, diagnostic.code)
      }
      continue
    }
    /** 共享解析器是端口与节点类型兼容性的唯一权威。 */
    const resolution = resolveCanvasEdgeBinding(edge, source.kind, target.kind)
    if (resolution.state !== 'bound') {
      const diagnosticCode = resolution.state === 'incompatible'
        ? 'CANVAS_WORKFLOW_EDGE_INCOMPATIBLE'
        : 'CANVAS_WORKFLOW_EDGE_UNRESOLVED'
      const invalid = invalidInboundEdges.get(target.id) ?? []
      invalid.push({ edge, diagnosticCode })
      invalidInboundEdges.set(target.id, invalid)
      invalidCodeByEdge.set(edge, diagnosticCode)
      continue
    }
    /** 多种关系若连接相同方向的节点，只能形成一条执行依赖。 */
    const pairKey = `${source.id}\0${target.id}`
    if (executablePairs.has(pairKey)) {
      const invalid = invalidInboundEdges.get(target.id) ?? []
      invalid.push({ edge, diagnosticCode: 'CANVAS_WORKFLOW_EDGE_DUPLICATE' })
      invalidInboundEdges.set(target.id, invalid)
      invalidCodeByEdge.set(edge, 'CANVAS_WORKFLOW_EDGE_DUPLICATE')
      continue
    }
    executablePairs.add(pairKey)
    const incoming = dependencies.get(target.id) ?? new Set<string>()
    incoming.add(source.id)
    dependencies.set(target.id, incoming)
    const outgoing = downstream.get(source.id) ?? new Set<string>()
    outgoing.add(target.id)
    downstream.set(source.id, outgoing)
  }

  /** 从明确请求向上遍历 bound 入边，只收集必要依赖闭包。 */
  const plannedNodeIds = new Set<string>()
  /** 栈中每个节点最多入栈一次，避免环路导致无界遍历。 */
  const pendingNodeIds = [...input.requestedNodeIds]
  while (pendingNodeIds.length > 0) {
    const nodeId = pendingNodeIds.pop()!
    if (plannedNodeIds.has(nodeId)) continue
    plannedNodeIds.add(nodeId)
    for (const dependencyId of dependencies.get(nodeId) ?? []) {
      if (!plannedNodeIds.has(dependencyId)) pendingNodeIds.push(dependencyId)
    }
  }
  if (plannedNodeIds.size > CANVAS_WORKFLOW_NODE_LIMIT) {
    throw new Error('CANVAS_WORKFLOW_NODE_LIMIT_EXCEEDED')
  }
  /** Agent 总数独立于执行状态限制，防止动态图放大子会话范围。 */
  let agentCount = 0
  for (const nodeId of plannedNodeIds) {
    if (nodesById.get(nodeId)?.kind === 'agent') agentCount += 1
  }
  if (agentCount > CANVAS_WORKFLOW_AGENT_LIMIT) {
    throw new Error('CANVAS_WORKFLOW_AGENT_LIMIT_EXCEEDED')
  }

  /** 计划内部入边和出边按节点顺序投影，不保留 JSON 边顺序。 */
  const dependenciesByNodeId = projectAdjacency(
    nodeIdsInDocumentOrder, dependencies, downstream, plannedNodeIds,
  )
  const downstreamByNodeId = projectAdjacency(
    nodeIdsInDocumentOrder, downstream, dependencies, plannedNodeIds,
  )
  /** Kahn 入度只统计计划闭包内的唯一 bound 依赖。 */
  const indegreeByNodeId = new Map<string, number>()
  for (const nodeId of plannedNodeIds) {
    indegreeByNodeId.set(nodeId, dependenciesByNodeId.get(nodeId)?.length ?? 0)
  }
  /** 每层按权威节点顺序推进，层数受固定深度预算约束。 */
  let readyNodeIds = nodeIdsInDocumentOrder.filter((nodeId) => (
    plannedNodeIds.has(nodeId) && indegreeByNodeId.get(nodeId) === 0
  ))
  /** 已完成拓扑排序的节点顺序。 */
  const orderedNodeIds: string[] = []
  /** 每个节点到最远必要上游的依赖深度。 */
  const depthByNodeId = new Map<string, number>()
  while (readyNodeIds.length > 0) {
    /** 下一层使用 Set 聚合，再按节点权威顺序投影。 */
    const nextReadyNodeIds = new Set<string>()
    for (const nodeId of readyNodeIds) {
      orderedNodeIds.push(nodeId)
      const dependenciesForNode = dependenciesByNodeId.get(nodeId) ?? []
      let nodeDepth = 0
      for (const dependencyId of dependenciesForNode) {
        nodeDepth = Math.max(nodeDepth, (depthByNodeId.get(dependencyId) ?? 0) + 1)
      }
      if (nodeDepth > CANVAS_WORKFLOW_DEPTH_LIMIT) {
        throw new Error('CANVAS_WORKFLOW_DEPTH_LIMIT_EXCEEDED')
      }
      depthByNodeId.set(nodeId, nodeDepth)
      for (const targetId of downstreamByNodeId.get(nodeId) ?? []) {
        const nextIndegree = (indegreeByNodeId.get(targetId) ?? 0) - 1
        indegreeByNodeId.set(targetId, nextIndegree)
        if (nextIndegree === 0) nextReadyNodeIds.add(targetId)
      }
    }
    readyNodeIds = nodeIdsInDocumentOrder.filter((nodeId) => nextReadyNodeIds.has(nodeId))
  }

  /** 未被 Kahn 消费的节点位于环中或依赖环，必须全部阻断。 */
  const cyclicOrDependentNodeIds = new Set<string>()
  for (const nodeId of plannedNodeIds) {
    if (!depthByNodeId.has(nodeId)) cyclicOrDependentNodeIds.add(nodeId)
  }
  /** 诊断首先保持文档边顺序，随后追加稳定节点顺序的环/状态诊断。 */
  const diagnostics: CanvasWorkflowDiagnostic[] = []
  /** 已公开的边诊断使用 Set 去重，避免诊断数量放大时反复扫描。 */
  const diagnosedEdgeIds = new Set<string>()
  for (const edge of input.document.edges) {
    const diagnosticCode = invalidCodeByEdge.get(edge)
    if (diagnosticCode && plannedNodeIds.has(edge.targetNodeId)) {
      diagnostics.push({ code: diagnosticCode, nodeId: edge.targetNodeId, edgeId: edge.id })
      diagnosedEdgeIds.add(edge.id)
    }
  }
  for (const diagnostic of globalDanglingDiagnostics) {
    if (!diagnostic.edgeId || diagnosedEdgeIds.has(diagnostic.edgeId)) continue
    diagnostics.push(diagnostic)
    diagnosedEdgeIds.add(diagnostic.edgeId)
  }
  for (const nodeId of nodeIdsInDocumentOrder) {
    if (cyclicOrDependentNodeIds.has(nodeId)) {
      diagnostics.push({ code: 'CANVAS_WORKFLOW_CYCLE', nodeId, edgeId: null })
    }
  }

  /** 初始状态沿拓扑顺序传播，任何无效或阻断上游都会阻止下游运行。 */
  const initialStates = new Map<string, CanvasWorkflowNodeStatus>()
  /** 本次已分配的图片费用许可数量。 */
  let plannedImageRuns = 0
  for (const nodeId of orderedNodeIds) {
    const node = nodesById.get(nodeId)!
    const hasInvalidInbound = (invalidInboundEdges.get(nodeId)?.length ?? 0) > 0
    const hasBlockedDependency = (dependenciesByNodeId.get(nodeId) ?? []).some((dependencyId) => (
      initialStates.get(dependencyId) === 'blocked'
      || initialStates.get(dependencyId) === 'waiting-approval'
    ))
    if (hasInvalidInbound || hasBlockedDependency) {
      initialStates.set(nodeId, 'blocked')
      continue
    }
    const artifactIsCurrent = hasCommittedArtifact(node) && node.upstreamChange === undefined
    if (artifactIsCurrent) {
      initialStates.set(nodeId, 'satisfied')
      continue
    }
    if (node.kind === 'document' || node.kind === 'webview') {
      initialStates.set(nodeId, 'blocked')
      diagnostics.push({
        code: 'CANVAS_WORKFLOW_NON_RUNNABLE_INPUT_STALE', nodeId: node.id, edgeId: null,
      })
      continue
    }
    if (node.kind === 'image') {
      if (plannedImageRuns >= input.maxImageRuns) {
        initialStates.set(nodeId, 'waiting-approval')
        continue
      }
      plannedImageRuns += 1
    }
    initialStates.set(nodeId, 'started')
  }
  for (const nodeId of cyclicOrDependentNodeIds) initialStates.set(nodeId, 'blocked')

  /** 只有明确规划为 started 的 Agent/Image 才形成调度器执行许可。 */
  const executableNodeIds = orderedNodeIds.filter((nodeId) => initialStates.get(nodeId) === 'started')
  return {
    requestedNodeIds: [...input.requestedNodeIds],
    orderedNodeIds,
    executableNodeIds,
    dependenciesByNodeId,
    downstreamByNodeId,
    depthByNodeId,
    initialStates,
    diagnostics,
  }
}
