import { createHash } from 'node:crypto'
import {
  CANVAS_WORKFLOW_IMAGE_RUN_LIMIT,
  CANVAS_WORKFLOW_RUN_NODE_LIMIT,
  resolveCanvasEdgeBinding,
} from '@proma/shared'
import type {
  CanvasDocument,
  CanvasNode,
  CanvasRunWorkflowInput,
  CanvasWorkflowRun,
  CanvasWorkflowRunInputBinding,
  CanvasWorkflowRunNode,
  MediaInputValue,
} from '@proma/shared'
import { createCanvasWorkflowGraphPlan } from './canvas-workflow-graph'

/** 首次规划输出，可直接交给 workflow run store 创建不可变计划。 */
export interface CanvasWorkflowPlanSnapshot {
  rootNodeIds: string[]
  nodes: CanvasWorkflowRunNode[]
}

/** 图片候选精确采用查询，不接受只按节点判断的模糊结果。 */
export interface CanvasWorkflowImageAdoptionQuery {
  projectId: string
  canvasId: string
  nodeId: string
  batchId: string
  taskId: string
}

/** 已采用候选返回正式产物身份与提交时间。 */
export interface CanvasWorkflowAdoptionFact {
  adopted: boolean
  artifactHash: string | null
  committedAt: number | null
}

/** 音视频输出必须同时匹配本次 run 与 workflow output key。 */
export interface CanvasWorkflowMediaAdoptionQuery {
  projectId: string
  canvasId: string
  nodeId: string
  mediaRunId: string
  outputKey: string
}

/** typed DAG resolver 返回的单槽事实；resolvedValue 仅在提交临界区短暂持有。 */
export interface CanvasWorkflowResolvedMediaInput {
  targetInputKey: string
  requiredKind: CanvasWorkflowRunInputBinding['requiredKind']
  sourceNodeId: string | null
  sourceOutputKey: string | null
  sourceArtifactHash: string | null
  resolvedValue: MediaInputValue | null
  errorCode: string | null
}

/** 单个媒体节点的配置版本与全部槽位解析结果。 */
export interface CanvasWorkflowResolvedMediaInputs {
  configRevision: number
  ready: boolean
  bindings: CanvasWorkflowResolvedMediaInput[]
}

/** 提交媒体节点前返回完整短生命周期值与更新后的 journal 节点。 */
export interface CanvasWorkflowPreparedMediaInputs {
  node: CanvasWorkflowRunNode
  resolvedValues: Record<string, MediaInputValue>
}

/** 恢复规划所需的窄事实查询。 */
export interface ReconcileCanvasWorkflowRunDependencies {
  isImageCandidateAdopted: (
    query: CanvasWorkflowImageAdoptionQuery,
  ) => CanvasWorkflowAdoptionFact | Promise<CanvasWorkflowAdoptionFact>
  isMediaOutputAdopted?: (
    query: CanvasWorkflowMediaAdoptionQuery,
  ) => CanvasWorkflowAdoptionFact | Promise<CanvasWorkflowAdoptionFact>
}

/** 对媒体输入值做稳定结构哈希，journal 不保存正文与资产路径。 */
function hashResolvedMediaValue(value: MediaInputValue): string {
  return createHash('sha256').update(JSON.stringify([
    'canvas-workflow-media-input', value,
  ])).digest('hex')
}

/** 首次计划只固定媒体配置与槽位声明，允许上游尚未产出正式值。 */
export function bindCanvasWorkflowMediaInputDeclarations(
  node: CanvasWorkflowRunNode,
  resolved: CanvasWorkflowResolvedMediaInputs,
): CanvasWorkflowRunNode {
  if (node.kind !== 'audio' && node.kind !== 'video') {
    throw new Error('CANVAS_WORKFLOW_MEDIA_NODE_INVALID')
  }
  if (!Number.isSafeInteger(resolved.configRevision) || resolved.configRevision < 0
    || !Array.isArray(resolved.bindings)
    || new Set(resolved.bindings.map((binding) => binding.targetInputKey)).size !== resolved.bindings.length) {
    throw new Error('CANVAS_WORKFLOW_MEDIA_INPUT_INVALID')
  }
  const next = structuredClone(node)
  const declarations = resolved.bindings.map((binding): CanvasWorkflowRunInputBinding => ({
    targetInputKey: binding.targetInputKey,
    requiredKind: binding.requiredKind,
    sourceNodeId: binding.sourceNodeId,
    sourceOutputKey: binding.sourceOutputKey,
    sourceArtifactHash: null,
    resolvedValueHash: null,
  }))
  const existingDeclarations = next.inputBindings.map((binding) => ({
    targetInputKey: binding.targetInputKey,
    requiredKind: binding.requiredKind,
    sourceNodeId: binding.sourceNodeId,
    sourceOutputKey: binding.sourceOutputKey,
  }))
  const incomingDeclarations = declarations.map((binding) => ({
    targetInputKey: binding.targetInputKey,
    requiredKind: binding.requiredKind,
    sourceNodeId: binding.sourceNodeId,
    sourceOutputKey: binding.sourceOutputKey,
  }))
  if (next.mediaConfigRevision !== null
    && (next.mediaConfigRevision !== resolved.configRevision
      || JSON.stringify(existingDeclarations) !== JSON.stringify(incomingDeclarations))) {
    throw new Error('CANVAS_WORKFLOW_MEDIA_CONFIG_CHANGED')
  }
  next.mediaConfigRevision = resolved.configRevision
  if (next.inputBindings.length === 0) next.inputBindings = declarations
  return next
}

/** 消费 typed DAG resolver 并冻结媒体配置、槽位声明与确切输入版本。 */
export function prepareCanvasWorkflowMediaInputs(
  run: CanvasWorkflowRun,
  nodeId: string,
  resolved: CanvasWorkflowResolvedMediaInputs,
): CanvasWorkflowPreparedMediaInputs {
  const node = structuredClone(run.nodes.find((candidate) => candidate.nodeId === nodeId))
  if (!node || (node.kind !== 'audio' && node.kind !== 'video')) {
    throw new Error('CANVAS_WORKFLOW_MEDIA_NODE_INVALID')
  }
  const declaredNode = bindCanvasWorkflowMediaInputDeclarations(node, resolved)
  const declarations = resolved.bindings.map((binding) => ({
    targetInputKey: binding.targetInputKey,
    requiredKind: binding.requiredKind,
    sourceNodeId: binding.sourceNodeId,
    sourceOutputKey: binding.sourceOutputKey,
  }))
  const existingDeclarations = declaredNode.inputBindings.map((binding) => ({
    targetInputKey: binding.targetInputKey,
    requiredKind: binding.requiredKind,
    sourceNodeId: binding.sourceNodeId,
    sourceOutputKey: binding.sourceOutputKey,
  }))
  if (declaredNode.mediaConfigRevision !== resolved.configRevision
    || JSON.stringify(existingDeclarations) !== JSON.stringify(declarations)) {
    throw new Error('CANVAS_WORKFLOW_MEDIA_CONFIG_CHANGED')
  }
  if (!resolved.ready || resolved.bindings.some((binding) => binding.errorCode || !binding.resolvedValue)) {
    throw new Error(resolved.bindings.find((binding) => binding.errorCode)?.errorCode
      ?? 'CANVAS_WORKFLOW_MEDIA_INPUTS_NOT_READY')
  }
  const resolvedValues: Record<string, MediaInputValue> = {}
  const nextBindings = resolved.bindings.map((binding): CanvasWorkflowRunInputBinding => {
    if (!binding.resolvedValue) throw new Error('CANVAS_WORKFLOW_MEDIA_INPUTS_NOT_READY')
    if (binding.sourceNodeId !== null
      && (!binding.sourceOutputKey
        || !binding.sourceArtifactHash
        || !declaredNode.dependencyNodeIds.includes(binding.sourceNodeId))) {
      throw new Error('CANVAS_WORKFLOW_MEDIA_INPUT_SOURCE_INVALID')
    }
    const resolvedValueHash = hashResolvedMediaValue(binding.resolvedValue)
    const existing = declaredNode.inputBindings.find((candidate) => (
      candidate.targetInputKey === binding.targetInputKey
    ))
    if ((existing?.sourceArtifactHash && existing.sourceArtifactHash !== binding.sourceArtifactHash)
      || (existing?.resolvedValueHash && existing.resolvedValueHash !== resolvedValueHash)) {
      throw new Error('CANVAS_WORKFLOW_INPUT_CHANGED')
    }
    resolvedValues[binding.targetInputKey] = structuredClone(binding.resolvedValue)
    return {
      ...declarations.find((candidate) => candidate.targetInputKey === binding.targetInputKey)!,
      sourceArtifactHash: binding.sourceArtifactHash,
      resolvedValueHash,
    }
  })
  declaredNode.inputBindings = nextBindings
  return { node: declaredNode, resolvedValues }
}

/** 恢复结果只返回固定范围内可启动节点，不创建任何外部副作用。 */
export interface ReconciledCanvasWorkflowPlan {
  run: CanvasWorkflowRun
  readyNodeIds: string[]
}

/** 返回节点结构身份；可变标题、位置和活动状态不参与。 */
export function createCanvasWorkflowNodeIdentityHash(node: CanvasNode): string {
  let identity: string
  switch (node.kind) {
    case 'agent': identity = node.agentSessionId; break
    case 'image': identity = node.imageModuleId; break
    case 'audio':
    case 'video': identity = node.mediaModuleId; break
    case 'document': identity = node.documentId; break
    case 'webview': identity = node.prototypeId; break
  }
  return createHash('sha256').update(JSON.stringify([
    'canvas-workflow-node', node.kind, identity,
  ])).digest('hex')
}

/** 返回当前正式产物的非敏感稳定身份。 */
export function createCanvasWorkflowArtifactHash(node: CanvasNode): string | null {
  let identity: object | string | null = null
  switch (node.kind) {
    case 'agent': identity = node.outputPointer ?? null; break
    case 'image': identity = node.adoptedAssetId ?? null; break
    case 'audio':
    case 'video': identity = null; break
    case 'document': identity = { contentRevision: node.contentRevision }; break
    case 'webview': identity = { contentRevision: node.contentRevision }; break
  }
  if (identity === null) return null
  return createHash('sha256').update(JSON.stringify([
    'canvas-workflow-artifact', node.kind, identity,
  ])).digest('hex')
}

/** 为子节点派生跨重启稳定 operationId。 */
export function createCanvasWorkflowNodeOperationId(
  workflowOperationId: string,
  nodeId: string,
  kind: CanvasNode['kind'],
  attempt = 0,
): string {
  const identity = ['canvas-workflow-node-operation', workflowOperationId, nodeId, kind]
  if (attempt > 0) identity.push(`retry-${attempt}`)
  return `workflow-node-${createHash('sha256').update(JSON.stringify(identity)).digest('hex')}`
}

/** 从权威 Canvas 创建首次固定范围，不把后续图变化隐式纳入。 */
export function createCanvasWorkflowPlanSnapshot(
  document: CanvasDocument,
  input: Pick<CanvasRunWorkflowInput, 'startNodeIds' | 'maxImageRuns'>,
): CanvasWorkflowPlanSnapshot {
  const plan = createCanvasWorkflowGraphPlan({
    document,
    startNodeIds: input.startNodeIds,
    maxImageRuns: input.maxImageRuns,
    allowedStartNodeKinds: ['agent', 'image', 'audio', 'video', 'document', 'webview'],
    countAudioVideoRunsInBudget: true,
  })
  const nodesById = new Map(document.nodes.map((node) => [node.id, node]))
  const nodes = plan.reachableNodeIds.map((nodeId): CanvasWorkflowRunNode => {
    const node = nodesById.get(nodeId)
    if (!node) throw new Error('CANVAS_WORKFLOW_GRAPH_CHANGED')
    const initialStatus = plan.initialStates.get(nodeId) ?? 'blocked'
    const status = initialStatus === 'started' ? 'ready' : initialStatus
    return {
      nodeId,
      kind: node.kind,
      identityHash: createCanvasWorkflowNodeIdentityHash(node),
      plannedArtifactHash: status === 'satisfied' ? createCanvasWorkflowArtifactHash(node) : null,
      mediaConfigRevision: null,
      inputBindings: node.kind === 'image' ? imageMediaRoleBindings(document, nodeId) : [],
      dependencyNodeIds: [...(plan.dependenciesByNodeId.get(nodeId) ?? [])],
      status: status === 'waiting-review' ? 'waiting-adoption' : status,
      errorCode: status === 'blocked' ? 'CANVAS_WORKFLOW_NODE_UNSUPPORTED' : null,
      execution: null,
      executionHistory: [],
      retryDisposition: 'none',
      completedArtifactHash: null,
      completedAt: null,
    }
  })
  return { rootNodeIds: [...plan.rootNodeIds], nodes }
}

/**
 * 只把 Host 创建事务点名的新节点追加到当前受管专业分支。
 * 未点名的最新图节点即使新近连入，也不会被扫描进原运行计划。
 */
export function createCanvasWorkflowDynamicSuccessorAmendment(
  run: CanvasWorkflowRun,
  document: CanvasDocument,
  parentAgentNodeId: string,
  createdNodeId: string,
): CanvasWorkflowRun {
  if (document.projectId !== run.projectId || document.canvasId !== run.canvasId) {
    throw new Error('CANVAS_WORKFLOW_RUN_TARGET_INVALID')
  }
  if (run.cancelRequestedAt !== null || run.status !== 'running') {
    throw new Error('CANVAS_WORKFLOW_DYNAMIC_SUCCESSOR_RUN_CLOSED')
  }
  const currentNodes = new Map(document.nodes.map((node) => [node.id, node]))
  const parentRunNode = run.nodes.find((node) => node.nodeId === parentAgentNodeId)
  if (!parentRunNode || parentRunNode.kind !== 'agent') {
    throw new Error('CANVAS_WORKFLOW_DYNAMIC_SUCCESSOR_PARENT_INVALID')
  }
  const createdNode = currentNodes.get(createdNodeId)
  if (!createdNode) throw new Error('CANVAS_WORKFLOW_DYNAMIC_SUCCESSOR_NOT_FOUND')
  const existingRunNode = run.nodes.find((node) => node.nodeId === createdNodeId)
  if (existingRunNode) {
    if (existingRunNode.kind !== createdNode.kind
      || existingRunNode.identityHash !== createCanvasWorkflowNodeIdentityHash(createdNode)) {
      throw new Error('CANVAS_WORKFLOW_GRAPH_CHANGED')
    }
    return structuredClone(run)
  }

  const plannedNodeIds = new Set(run.nodes.map((node) => node.nodeId))
  if (run.nodes.length >= CANVAS_WORKFLOW_RUN_NODE_LIMIT) {
    throw new Error('CANVAS_WORKFLOW_NODE_LIMIT_EXCEEDED')
  }
  const currentDependencyMap = currentDependencies(document, plannedNodeIds)
  for (const runNode of run.nodes) {
    const currentNode = currentNodes.get(runNode.nodeId)
    if (!currentNode || currentNode.kind !== runNode.kind
      || createCanvasWorkflowNodeIdentityHash(currentNode) !== runNode.identityHash
      || JSON.stringify(currentDependencyMap.get(runNode.nodeId) ?? [])
        !== JSON.stringify([...runNode.dependencyNodeIds].sort((left, right) => left.localeCompare(right)))) {
      throw new Error('CANVAS_WORKFLOW_GRAPH_CHANGED')
    }
    if (runNode.kind === 'image'
      && JSON.stringify(runNode.inputBindings) !== JSON.stringify(imageMediaRoleBindings(document, runNode.nodeId))) {
      throw new Error('CANVAS_WORKFLOW_INPUT_CHANGED')
    }
    if (runNode.status === 'satisfied'
      && runNode.plannedArtifactHash !== createCanvasWorkflowArtifactHash(currentNode)) {
      throw new Error('CANVAS_WORKFLOW_INPUT_CHANGED')
    }
  }

  /** 新节点不得从未登记的既有节点取得输入，否则会间接扩大原授权范围。 */
  for (const edge of document.edges) {
    if (edge.targetNodeId !== createdNodeId || edge.relation === 'association') continue
    const source = currentNodes.get(edge.sourceNodeId)
    if (!source) throw new Error('CANVAS_WORKFLOW_GRAPH_CHANGED')
    const binding = resolveCanvasEdgeBinding(edge, source.kind, createdNode.kind)
    if (binding.state !== 'bound') throw new Error('CANVAS_WORKFLOW_GRAPH_CHANGED')
    if (!plannedNodeIds.has(source.id)) throw new Error('CANVAS_WORKFLOW_DYNAMIC_SUCCESSOR_SCOPE_INVALID')
  }

  /** 只用旧计划与这一个候选构造验证图，天然排除其它已有节点。 */
  const amendmentNodeIds = new Set([...plannedNodeIds, createdNodeId])
  const amendmentDocument: CanvasDocument = {
    ...document,
    nodes: document.nodes.filter((node) => amendmentNodeIds.has(node.id)),
    edges: document.edges.filter((edge) => (
      amendmentNodeIds.has(edge.sourceNodeId) && amendmentNodeIds.has(edge.targetNodeId)
    )),
  }
  const fullPlan = createCanvasWorkflowGraphPlan({
    document: amendmentDocument,
    startNodeIds: run.rootNodeIds,
    maxImageRuns: CANVAS_WORKFLOW_IMAGE_RUN_LIMIT,
    allowedStartNodeKinds: ['agent', 'image', 'audio', 'video', 'document', 'webview'],
    countAudioVideoRunsInBudget: true,
  })
  const branchPlan = createCanvasWorkflowGraphPlan({
    document: amendmentDocument,
    startNodeIds: [parentAgentNodeId],
    maxImageRuns: CANVAS_WORKFLOW_IMAGE_RUN_LIMIT,
    allowedStartNodeKinds: ['agent'],
    countAudioVideoRunsInBudget: true,
  })
  if (!fullPlan.reachableNodeIds.includes(createdNodeId)
    || !branchPlan.reachableNodeIds.includes(createdNodeId)) {
    throw new Error('CANVAS_WORKFLOW_DYNAMIC_SUCCESSOR_NOT_BOUND')
  }

  const initialStatus = fullPlan.initialStates.get(createdNodeId) ?? 'blocked'
  const isMediaNode = createdNode.kind === 'image' || createdNode.kind === 'audio' || createdNode.kind === 'video'
  const status = initialStatus === 'satisfied'
    ? 'satisfied'
    : initialStatus === 'blocked'
      ? 'blocked'
      : isMediaNode && run.budget.remainingMediaRuns === 0
        ? 'waiting-approval'
        : 'ready'
  const next = structuredClone(run)
  next.observedCanvasRevision = Math.max(next.observedCanvasRevision, document.revision)
  next.nodes.push({
    nodeId: createdNode.id,
    kind: createdNode.kind,
    identityHash: createCanvasWorkflowNodeIdentityHash(createdNode),
    plannedArtifactHash: status === 'satisfied' ? createCanvasWorkflowArtifactHash(createdNode) : null,
    mediaConfigRevision: null,
    inputBindings: createdNode.kind === 'image' ? imageMediaRoleBindings(document, createdNode.id) : [],
    dependencyNodeIds: [...(fullPlan.dependenciesByNodeId.get(createdNode.id) ?? [])],
    status,
    errorCode: status === 'blocked' ? 'CANVAS_WORKFLOW_NODE_UNSUPPORTED' : null,
    execution: null,
    executionHistory: [],
    retryDisposition: 'none',
    completedArtifactHash: null,
    completedAt: null,
  })
  return next
}

/** 图片节点把 AV 封面角色固化到既有槽位合同，支持按单角色采用释放下游。 */
function imageMediaRoleBindings(document: CanvasDocument, nodeId: string): CanvasWorkflowRunInputBinding[] {
  const nodes = new Map(document.nodes.map((node) => [node.id, node]))
  return document.edges.flatMap((edge): CanvasWorkflowRunInputBinding[] => {
    const source = nodes.get(edge.sourceNodeId)
    if (edge.targetNodeId !== nodeId || edge.relation === 'association' || !source
      || (source.kind !== 'audio' && source.kind !== 'video') || edge.sourcePort !== 'image.asset'
      || edge.targetPort !== 'image.reference' || !edge.sourceOutputKey) return []
    return [{ targetInputKey: `reference:${edge.id}`, requiredKind: 'image', sourceNodeId: source.id,
      sourceOutputKey: edge.sourceOutputKey, sourceArtifactHash: null, resolvedValueHash: null }]
  }).sort((left, right) => left.targetInputKey.localeCompare(right.targetInputKey))
}

/** 读取当前图中进入固定范围节点的精确依赖，新增范围外后继不参与。 */
function currentDependencies(
  document: CanvasDocument,
  plannedNodeIds: ReadonlySet<string>,
): Map<string, string[]> {
  const nodesById = new Map(document.nodes.map((node) => [node.id, node]))
  const dependencies = new Map<string, Set<string>>()
  for (const nodeId of plannedNodeIds) dependencies.set(nodeId, new Set())
  for (const edge of document.edges) {
    if (edge.relation === 'association') continue
    const source = nodesById.get(edge.sourceNodeId)
    const target = nodesById.get(edge.targetNodeId)
    const touchesPlan = plannedNodeIds.has(edge.sourceNodeId) || plannedNodeIds.has(edge.targetNodeId)
    if (!source || !target) {
      if (touchesPlan) throw new Error('CANVAS_WORKFLOW_GRAPH_CHANGED')
      continue
    }
    const binding = resolveCanvasEdgeBinding(edge, source.kind, target.kind)
    if (binding.state !== 'bound') {
      if (touchesPlan) throw new Error('CANVAS_WORKFLOW_GRAPH_CHANGED')
      continue
    }
    /** 固定节点新增范围外后继允许存在；范围外新增前置依赖会改变运行输入。 */
    if (!plannedNodeIds.has(target.id)) continue
    if (!plannedNodeIds.has(source.id)) throw new Error('CANVAS_WORKFLOW_GRAPH_CHANGED')
    dependencies.get(target.id)?.add(source.id)
  }
  return new Map([...dependencies].map(([nodeId, values]) => [
    nodeId, [...values].sort((left, right) => left.localeCompare(right)),
  ]))
}

/** 基于首次固定范围恢复，只把精确已采用候选推进为完成。 */
export async function reconcileCanvasWorkflowRun(
  run: CanvasWorkflowRun,
  document: CanvasDocument,
  dependencies: ReconcileCanvasWorkflowRunDependencies,
): Promise<ReconciledCanvasWorkflowPlan> {
  if (document.projectId !== run.projectId || document.canvasId !== run.canvasId) {
    throw new Error('CANVAS_WORKFLOW_RUN_TARGET_INVALID')
  }
  const currentNodes = new Map(document.nodes.map((node) => [node.id, node]))
  const plannedNodeIds = new Set(run.nodes.map((node) => node.nodeId))
  const currentDependencyMap = currentDependencies(document, plannedNodeIds)
  const next = structuredClone(run)
  next.observedCanvasRevision = Math.max(next.observedCanvasRevision, document.revision)

  for (const node of next.nodes) {
    const current = currentNodes.get(node.nodeId)
    if (!current || current.kind !== node.kind
      || createCanvasWorkflowNodeIdentityHash(current) !== node.identityHash) {
      throw new Error('CANVAS_WORKFLOW_GRAPH_CHANGED')
    }
    const expectedDependencies = [...node.dependencyNodeIds].sort((left, right) => left.localeCompare(right))
    if (JSON.stringify(currentDependencyMap.get(node.nodeId) ?? []) !== JSON.stringify(expectedDependencies)) {
      throw new Error('CANVAS_WORKFLOW_GRAPH_CHANGED')
    }
    if (node.kind === 'image' && JSON.stringify(node.inputBindings) !== JSON.stringify(imageMediaRoleBindings(document, node.nodeId))) {
      throw new Error('CANVAS_WORKFLOW_INPUT_CHANGED')
    }
    if (node.status === 'satisfied'
      && node.plannedArtifactHash !== createCanvasWorkflowArtifactHash(current)) {
      throw new Error('CANVAS_WORKFLOW_INPUT_CHANGED')
    }
    if (node.status !== 'waiting-adoption' || node.execution?.kind !== 'image') continue
    if (!node.execution.batchId || !node.execution.taskId) {
      throw new Error('CANVAS_WORKFLOW_IMAGE_FACT_MISSING')
    }
    const adoption = await dependencies.isImageCandidateAdopted({
      projectId: run.projectId,
      canvasId: run.canvasId,
      nodeId: node.nodeId,
      batchId: node.execution.batchId,
      taskId: node.execution.taskId,
    })
    if (!adoption.adopted) continue
    if (!adoption.artifactHash || adoption.committedAt === null) {
      throw new Error('CANVAS_WORKFLOW_ADOPTION_FACT_INVALID')
    }
    node.status = 'completed'
    node.completedArtifactHash = adoption.artifactHash
    node.completedAt = adoption.committedAt
  }

  /** 媒体节点只有本次 run 的全部声明输出已采用时才整体完成。 */
  for (const node of next.nodes) {
    if (node.status !== 'waiting-adoption' || node.execution?.kind !== 'media'
      || !node.execution.mediaRunId || node.execution.outputKeys.length === 0
      || !dependencies.isMediaOutputAdopted) continue
    const mediaRunId = node.execution.mediaRunId
    const outputKeys = [...node.execution.outputKeys]
    const facts = await Promise.all(outputKeys.map((outputKey) => (
      dependencies.isMediaOutputAdopted!({
        projectId: run.projectId,
        canvasId: run.canvasId,
        nodeId: node.nodeId,
        mediaRunId,
        outputKey,
      })
    )))
    if (!facts.every((fact) => fact.adopted && fact.artifactHash && fact.committedAt !== null)) continue
    node.status = 'completed'
    node.completedArtifactHash = createHash('sha256').update(JSON.stringify(
      facts.map((fact, index) => [outputKeys[index], fact.artifactHash]),
    )).digest('hex')
    node.completedAt = Math.max(...facts.map((fact) => fact.committedAt!))
  }

  /** 依赖失败形成的阻塞在上游重试成功后可恢复，其它结构或配置阻断仍保持 fail closed。 */
  const recoverableDependencyErrors = new Set([
    'UPSTREAM_FAILED', 'UPSTREAM_BLOCKED', 'CANVAS_WORKFLOW_DEPENDENCY_PENDING',
  ])
  for (const node of next.nodes) {
    if (node.status !== 'blocked' || !node.errorCode || !recoverableDependencyErrors.has(node.errorCode)) continue
    const dependenciesCompleted = node.dependencyNodeIds.every((nodeId) => {
      const dependency = next.nodes.find((candidate) => candidate.nodeId === nodeId)
      return dependency?.status === 'satisfied' || dependency?.status === 'completed'
    })
    if (dependenciesCompleted) {
      node.status = 'ready'
      node.errorCode = null
    }
  }

  /** 仅固定范围内、未完成且所有依赖正式满足的节点可继续。 */
  const statusByNodeId = new Map(next.nodes.map((node) => [node.nodeId, node.status]))
  const readyNodeIds: string[] = []
  let remainingMediaRuns = next.budget.remainingMediaRuns
  for (const node of next.nodes) {
    if (node.status !== 'ready') continue
    let dependenciesCompleted = node.dependencyNodeIds.every((nodeId) => {
      const status = statusByNodeId.get(nodeId)
      return status === 'satisfied' || status === 'completed'
    })
    /** 媒体多输出允许按具体 adopted output key 释放对应后继。 */
    if (!dependenciesCompleted && dependencies.isMediaOutputAdopted) {
      dependenciesCompleted = true
      for (const dependencyId of node.dependencyNodeIds) {
        const dependencyNode = next.nodes.find((candidate) => candidate.nodeId === dependencyId)
        if (dependencyNode?.status === 'satisfied' || dependencyNode?.status === 'completed') continue
        if (dependencyNode?.status !== 'waiting-adoption'
          || dependencyNode.execution?.kind !== 'media'
          || !dependencyNode.execution.mediaRunId) {
          dependenciesCompleted = false
          break
        }
        const mediaRunId = dependencyNode.execution.mediaRunId
        const bindings = node.inputBindings.filter((binding) => binding.sourceNodeId === dependencyId)
        if (bindings.length === 0) {
          dependenciesCompleted = false
          break
        }
        const facts = await Promise.all(bindings.map((binding) => dependencies.isMediaOutputAdopted!({
          projectId: run.projectId,
          canvasId: run.canvasId,
          nodeId: dependencyId,
          mediaRunId,
          outputKey: binding.sourceOutputKey ?? '',
        })))
        if (!facts.every((fact) => fact.adopted)) {
          dependenciesCompleted = false
          break
        }
      }
    }
    if (!dependenciesCompleted) continue
    if (node.kind === 'image' || node.kind === 'audio' || node.kind === 'video') {
      /** 已有 execution 表示预算在首次提交前已经持久扣除，恢复重放不得再次申请额度。 */
      const isOwnedReplay = (node.kind === 'image' && node.execution?.kind === 'image')
        || ((node.kind === 'audio' || node.kind === 'video') && node.execution?.kind === 'media')
      if (!isOwnedReplay && remainingMediaRuns === 0) {
        node.status = 'waiting-approval'
        continue
      }
      if (!isOwnedReplay) remainingMediaRuns -= 1
    }
    readyNodeIds.push(node.nodeId)
  }
  const hasWaitingAdoption = next.nodes.some((node) => node.status === 'waiting-adoption')
  const hasFailure = next.nodes.some((node) => node.status === 'failed' || node.status === 'blocked')
  const allComplete = next.nodes.every((node) => node.status === 'satisfied' || node.status === 'completed')
  next.status = allComplete
    ? 'completed'
    : hasWaitingAdoption
      ? 'waiting-review'
      : hasFailure
        ? 'partial'
        : 'running'
  return { run: next, readyNodeIds }
}
