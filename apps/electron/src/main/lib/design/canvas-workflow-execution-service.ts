import { createHash } from 'node:crypto'
import type {
  CanvasDocument,
  CanvasNode,
  CanvasRunNodesBatchTerminalSummary,
  CanvasRunWorkflowInput,
  CanvasRunWorkflowResult,
  CanvasTarget,
  CanvasWorkflowRun,
  CanvasWorkflowRunChangedEvent,
  CanvasWorkflowImageSummary,
  CanvasWorkflowRunListInput,
  CanvasWorkflowNodeResult,
  CanvasWorkflowNodeStatus,
  CanvasWorkflowRunPage,
  MediaInputValue,
} from '@proma/shared'
import {
  CANVAS_WORKFLOW_RUN_DURATION_MS,
  CANVAS_WORKFLOW_RUN_NODE_LIMIT,
  resolveCanvasEdgeBinding,
} from '@proma/shared'
import type { CanvasAgentExecutionService } from './canvas-agent-execution-service'
import type { CanvasAgentOutputCommitResult } from './canvas-agent-output-service'
import type { CanvasImageRunService } from './canvas-image-run-service'
import type { CanvasWorkflowRunStore } from './canvas-workflow-run-store'
import type { CanvasToolRunContext } from './canvas-tool-provider'
import {
  createCanvasWorkflowNodeOperationId,
  createCanvasWorkflowNodeIdentityHash,
  createCanvasWorkflowPlanSnapshot,
  createCanvasWorkflowDynamicSuccessorAmendment,
  bindCanvasWorkflowMediaInputDeclarations,
  prepareCanvasWorkflowMediaInputs,
  reconcileCanvasWorkflowRun,
  type CanvasWorkflowAdoptionFact,
  type CanvasWorkflowImageAdoptionQuery,
  type CanvasWorkflowMediaAdoptionQuery,
  type CanvasWorkflowResolvedMediaInputs,
} from './canvas-workflow-planner'
import {
  createCanvasWorkflowGraphPlan,
  type CanvasWorkflowGraphPlan,
} from './canvas-workflow-graph'

/** 单次工作流中的 Canvas Agent 并发上限。 */
const MAX_AGENT_CONCURRENCY = 2
/** Canvas 工作流与单 Agent 长工具共用的总时限。 */
export const CANVAS_WORKFLOW_TIMEOUT_MS = CANVAS_WORKFLOW_RUN_DURATION_MS

/** 为单个图片节点派生跨分波重放稳定且互不冲突的安全 operationId。 */
function createWorkflowImageOperationId(
  parentOperationId: string,
  nodeId: string,
): string {
  /** 只哈希稳定业务身份，不包含节点标题、提示词或其它正文。 */
  const digest = createHash('sha256').update(JSON.stringify([
    'canvas-workflow-image-node',
    parentOperationId,
    nodeId,
  ])).digest('hex')
  return `workflow-image-${digest}`
}

/** 可取消 deadline 的窄句柄，便于测试不依赖真实时钟。 */
export interface CanvasWorkflowDeadlineHandle {
  cancel: () => void
}

/** 主进程工作流调度器依赖，只复用既有 Agent 与图片业务服务。 */
export interface CanvasWorkflowExecutionServiceDependencies {
  load: (target: CanvasTarget) => CanvasDocument | Promise<CanvasDocument>
  validateAccess: (context: CanvasToolRunContext, canvasId: string) => void | Promise<void>
  isAgentBusy: (node: Extract<CanvasNode, { kind: 'agent' }>) => boolean
  agentExecution: Pick<CanvasAgentExecutionService, 'execute'>
  /** 只按原父工作流消息身份查询已运行 Agent，不允许读取当前末条输出代替。 */
  recoverAgentExecution?: (input: CanvasTarget & {
    nodeId: string
    agentSessionId: string
    operationId: string
    expectedUserMessageUuid: string
    expectedStartedAt: number
  }) => Promise<
    | { status: 'completed'; output: CanvasAgentOutputCommitResult }
    | { status: 'running' | 'missing' | 'changed' }
  >
  imageRuns: Pick<CanvasImageRunService, 'run' | 'awaitBatch' | 'cancelTasks'>
  /** 注入后启用跨重启固定计划；缺省仅供旧调用与存量测试兼容。 */
  workflowRuns?: CanvasWorkflowRunStore
  /** 持久运行关键事实写入成功后的轻量通知。 */
  onRunChanged?: (event: CanvasWorkflowRunChangedEvent) => void
  /**
   * 外部 Agent/媒体任务仍运行时，按 workflowRunId 替换已有唤醒并在 resumeAt 前后恢复一次。
   * 远端终态事件可提前触发同一恢复；协调器须在工作流进入用户边界或终态后清理旧唤醒。
   */
  scheduleDurableResume?: (input: CanvasTarget & {
    workflowRunId: string
    ownerSessionId: string
    resumeAt: number
  }) => void | Promise<void>
  /** 仅接收 Host journal 中由已完成 child 为固定直接下游准备的配置修订。 */
  applyPreparedHandoffs?: (run: CanvasWorkflowRun, document: CanvasDocument) => Promise<CanvasWorkflowRun>
  /** 只接受精确 batch/task 的图片采用事实。 */
  isImageCandidateAdopted?: (
    query: CanvasWorkflowImageAdoptionQuery,
  ) => CanvasWorkflowAdoptionFact | Promise<CanvasWorkflowAdoptionFact>
  /** 音视频执行通过适配器消费 typed DAG resolver，禁止从边端口猜输入。 */
  mediaRuns?: {
    resolveInputs: (target: CanvasTarget & {
      nodeId: string
      mediaModuleId: string
      mediaKind: 'audio' | 'video'
    }) => Promise<CanvasWorkflowResolvedMediaInputs>
    run: (input: CanvasTarget & {
      nodeId: string
      mediaModuleId: string
      mediaKind: 'audio' | 'video'
      expectedConfigRevision: number
      operationId: string
      resolvedValues: Record<string, MediaInputValue>
      expectedInputHashes: Record<string, string>
      /** 父工作流的真实调用主体由调度器传给提交授权边界。 */
      context: CanvasToolRunContext
      workflowRunId: string
      signal: AbortSignal
    }) => Promise<{
      status: 'running' | 'waiting-adoption' | 'failed' | 'cancelled'
      mediaRunId: string
      outputKeys: string[]
      errorCode: string | null
      retryable?: boolean
    }>
    /** 恢复已取得 mediaRunId 的原任务，包括 collection-failed 的下载续跑。 */
    reconcile?: (input: CanvasTarget & {
      nodeId: string
      mediaModuleId: string
      mediaKind: 'audio' | 'video'
      operationId: string
      mediaRunId: string
      context: CanvasToolRunContext
      workflowRunId: string
      signal: AbortSignal
      deadlineAt: number
    }) => Promise<{
      status: 'running' | 'waiting-adoption' | 'failed' | 'cancelled'
      mediaRunId: string
      outputKeys: string[]
      errorCode: string | null
      retryable?: boolean
    }>
    cancel: (input: CanvasTarget & {
      nodeId: string
      mediaModuleId: string
      mediaKind: 'audio' | 'video'
      mediaRunId: string
    }) => Promise<void>
  }
  /** 音视频采用必须精确匹配当前 workflow 的 run/output key。 */
  isMediaOutputAdopted?: (
    query: CanvasWorkflowMediaAdoptionQuery,
  ) => CanvasWorkflowAdoptionFact | Promise<CanvasWorkflowAdoptionFact>
  now?: () => number
  setDeadline?: (callback: () => void, timeoutMs: number) => CanvasWorkflowDeadlineHandle
}

/** 普通 Agent 调用工作流服务的进程内接口。 */
export interface CanvasWorkflowExecutionService {
  execute: (
    context: CanvasToolRunContext,
    input: CanvasRunWorkflowInput,
    toolCallId: string,
    signal?: AbortSignal,
  ) => Promise<CanvasRunWorkflowResult>
  resume: (
    context: CanvasToolRunContext,
    input: CanvasTarget & {
      runId: string
      expectedRunRevision?: number
      resumeOperationId?: string
      addDurationMs?: number
      addMediaRuns?: number
      retryNodeIds?: string[]
    },
    signal?: AbortSignal,
  ) => Promise<CanvasRunWorkflowResult>
  cancel: (
    context: CanvasToolRunContext,
    input: CanvasTarget & { runId: string },
  ) => Promise<CanvasWorkflowRun>
  /** 登记 Host 创建事务点名的单个动态后继，不接受 Agent 自报节点集合。 */
  registerCreatedSuccessor: (
    context: CanvasToolRunContext,
    input: CanvasTarget & { nodeId: string; sourceToolCallId: string },
  ) => Promise<CanvasWorkflowSuccessorRegistrationResult>
  /** 创建已提交但正常登记异常时，持久化精确节点的阻断事实。 */
  recordCreatedSuccessorRegistrationFailure: (
    context: CanvasToolRunContext,
    input: CanvasTarget & { nodeId: string; sourceToolCallId: string },
  ) => Promise<CanvasWorkflowSuccessorRegistrationResult>
  get: (context: CanvasToolRunContext, input: CanvasTarget & { runId: string }) => Promise<CanvasWorkflowRun>
  list: (context: CanvasToolRunContext, canvasId: string) => Promise<CanvasWorkflowRun[]>
  listPage: (
    context: CanvasToolRunContext,
    canvasId: string,
    options?: Pick<CanvasWorkflowRunListInput, 'cursor' | 'limit'>,
  ) => Promise<CanvasWorkflowRunPage>
}

/** 创建成功后的父工作流登记结果；未纳入计划不反转节点创建事实。 */
export interface CanvasWorkflowSuccessorRegistrationResult {
  status: 'registered' | 'already-registered' | 'blocked'
  workflowRunId: string
  workflowRunRevision: number
  reasonCode: string | null
}

/** 只追加创建事务点名的失败节点；该事实不会授予任何执行能力。 */
function createBlockedSuccessorAmendment(
  run: CanvasWorkflowRun,
  document: CanvasDocument,
  parentAgentNodeId: string,
  createdNodeId: string,
  reasonCode: string,
): CanvasWorkflowRun {
  const createdNode = document.nodes.find((node) => node.id === createdNodeId)
  if (!createdNode) throw new Error('CANVAS_WORKFLOW_DYNAMIC_SUCCESSOR_NOT_FOUND')
  if (run.nodes.length >= CANVAS_WORKFLOW_RUN_NODE_LIMIT) {
    throw new Error('CANVAS_WORKFLOW_NODE_LIMIT_EXCEEDED')
  }
  const next = structuredClone(run)
  next.status = 'partial'
  next.observedCanvasRevision = Math.max(next.observedCanvasRevision, document.revision)
  next.nodes.push({
    nodeId: createdNode.id,
    kind: createdNode.kind,
    identityHash: createCanvasWorkflowNodeIdentityHash(createdNode),
    plannedArtifactHash: null,
    mediaConfigRevision: null,
    inputBindings: [],
    dependencyNodeIds: [parentAgentNodeId],
    status: 'blocked',
    errorCode: reasonCode,
    execution: null,
    executionHistory: [],
    retryDisposition: 'none',
    completedArtifactHash: null,
    completedAt: null,
  })
  return next
}

/** 调度器内部节点状态，错误只保存稳定错误码。 */
interface InternalNodeState {
  status: CanvasWorkflowNodeStatus
  errorCode: string | null
}

/** 从受控异常中提取稳定错误码，未知异常统一降级。 */
function stableErrorCode(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback
  /** 仅接受单段大写错误码，路径、凭据和异常正文不会进入公开结果。 */
  const code = error.message.split(':', 1)[0]?.trim() ?? ''
  return /^[A-Z][A-Z0-9_]{0,119}$/.test(code) ? code : fallback
}

/** 返回节点不会随 revision 改变的执行身份。 */
function nodeIdentity(node: CanvasNode): string {
  switch (node.kind) {
    case 'agent': return `${node.kind}\0${node.agentSessionId}`
    case 'image': return `${node.kind}\0${node.imageModuleId}`
    case 'audio':
    case 'video': return `${node.kind}\0${node.mediaModuleId}`
    case 'document': return `${node.kind}\0${node.documentId}`
    case 'webview': return `${node.kind}\0${node.prototypeId}`
  }
}

/** 返回单条合法 bound 边不会随 revision 改变的执行身份。 */
function edgeIdentity(edge: CanvasDocument['edges'][number]): string {
  return [edge.id, edge.sourceNodeId, edge.sourcePort, edge.sourceOutputKey ?? '', edge.targetNodeId, edge.targetPort, edge.relation].join('\0')
}

/** 只索引共享解析器确认的 bound 执行边，association 不参与稳定性。 */
function indexBoundEdges(document: CanvasDocument): Map<string, CanvasDocument['edges'][number]> {
  /** 节点索引用于按权威类别解析端口语义。 */
  const nodesById = new Map(document.nodes.map((node) => [node.id, node]))
  /** 结果按完整执行身份索引，避免仅比较 edge ID。 */
  const edges = new Map<string, CanvasDocument['edges'][number]>()
  for (const edge of document.edges) {
    if (edge.relation === 'association') continue
    /** 悬空或未解析边由 fresh planner 负责判错，不伪装成稳定 bound 边。 */
    const source = nodesById.get(edge.sourceNodeId)
    const target = nodesById.get(edge.targetNodeId)
    if (!source || !target) continue
    if (resolveCanvasEdgeBinding(edge, source.kind, target.kind).state !== 'bound') continue
    edges.set(edgeIdentity(edge), edge)
  }
  return edges
}

/** 动态重算前确认根、已执行身份和已执行链路没有被并发改写。 */
function assertExecutedGraphStable(
  previous: CanvasDocument,
  next: CanvasDocument,
  rootNodeIds: readonly string[],
  executedNodeIds: ReadonlySet<string>,
): void {
  /** 前后节点身份索引用于检查已进入本轮所有权的节点。 */
  const previousNodes = new Map(previous.nodes.map((node) => [node.id, node]))
  const nextNodes = new Map(next.nodes.map((node) => [node.id, node]))
  for (const nodeId of new Set([...rootNodeIds, ...executedNodeIds])) {
    const before = previousNodes.get(nodeId)
    const after = nextNodes.get(nodeId)
    if (!before || !after || nodeIdentity(before) !== nodeIdentity(after)) {
      throw new Error('CANVAS_WORKFLOW_GRAPH_CHANGED')
    }
  }

  /** 只比较合法 bound 执行边，展示关联变化不会中止工作流。 */
  const previousEdges = indexBoundEdges(previous)
  const nextEdges = indexBoundEdges(next)
  const previousNodeIds = new Set(previous.nodes.map((node) => node.id))
  for (const [identity, edge] of previousEdges) {
    if ((executedNodeIds.has(edge.sourceNodeId) || executedNodeIds.has(edge.targetNodeId))
      && !nextEdges.has(identity)) {
      throw new Error('CANVAS_WORKFLOW_GRAPH_CHANGED')
    }
  }
  for (const [identity, edge] of nextEdges) {
    if (previousEdges.has(identity)) continue
    /** 已执行节点只可向本轮新节点追加出边，不能新增入边或改写既有链路。 */
    if ((executedNodeIds.has(edge.sourceNodeId) || executedNodeIds.has(edge.targetNodeId))
      && !(executedNodeIds.has(edge.sourceNodeId) && !previousNodeIds.has(edge.targetNodeId))) {
      throw new Error('CANVAS_WORKFLOW_GRAPH_CHANGED')
    }
  }
}

/** 从规划状态构造内部状态，并补充稳定阻断原因。 */
function plannedState(status: CanvasWorkflowNodeStatus): InternalNodeState {
  return { status, errorCode: status === 'blocked' ? 'CANVAS_WORKFLOW_NODE_UNSUPPORTED' : null }
}

/** fresh plan 仅保留本轮已执行终态，其余节点完全按最新图重建。 */
function rebuildPlanStates(
  previousStates: ReadonlyMap<string, InternalNodeState>,
  plan: CanvasWorkflowGraphPlan,
  executedNodeIds: ReadonlySet<string>,
  imageRunsStarted: number,
  maxImageRuns: number,
  nodesById: ReadonlyMap<string, CanvasNode>,
): Map<string, InternalNodeState> {
  /** 新状态只包含 fresh plan 当前仍可达的节点。 */
  const nextStates = new Map<string, InternalNodeState>()
  /** 本轮尚可分配给未执行图片的剩余额度。 */
  let remainingImageRuns = Math.max(0, maxImageRuns - imageRunsStarted)
  for (const nodeId of plan.reachableNodeIds) {
    const previous = previousStates.get(nodeId)
    if (executedNodeIds.has(nodeId) && previous && previous.status !== 'started') {
      nextStates.set(nodeId, previous)
      continue
    }
    /** planner 的两种图片规划态都由真实已启动数重新分配额度。 */
    const status = plan.initialStates.get(nodeId) ?? 'blocked'
    if (nodesById.get(nodeId)?.kind === 'image'
      && (status === 'started' || status === 'waiting-approval')) {
      if (remainingImageRuns > 0) {
        remainingImageRuns -= 1
        nextStates.set(nodeId, plannedState('started'))
      } else {
        nextStates.set(nodeId, plannedState('waiting-approval'))
      }
      continue
    }
    nextStates.set(nodeId, plannedState(status))
  }
  return nextStates
}

/** 依赖终态向仍未启动的后继传播稳定阻断原因。 */
function propagateBlockedDependencies(
  plan: CanvasWorkflowGraphPlan,
  states: Map<string, InternalNodeState>,
): boolean {
  let changed = false
  for (const nodeId of plan.reachableNodeIds) {
    const state = states.get(nodeId)
    if (!state || state.status !== 'started') continue
    /** 直接依赖只读取本轮公开终态，不查询模型或磁盘。 */
    const upstreamStates = (plan.dependenciesByNodeId.get(nodeId) ?? []).map((id) => states.get(id))
    let errorCode: string | null = null
    if (upstreamStates.some((upstream) => upstream?.status === 'waiting-review')) {
      errorCode = 'WAITING_FOR_IMAGE_ADOPTION'
    } else if (upstreamStates.some((upstream) => upstream?.status === 'waiting-approval')) {
      errorCode = 'WAITING_FOR_IMAGE_APPROVAL'
    } else if (upstreamStates.some((upstream) => (
      upstream?.status === 'failed' || upstream?.status === 'blocked' || upstream?.status === 'cancelled'
    ))) {
      errorCode = 'UPSTREAM_FAILED'
    }
    if (!errorCode) continue
    states.set(nodeId, { status: 'blocked', errorCode })
    changed = true
  }
  return changed
}

/** 节点只有在所有直接上游已有正式满足结果时才可启动。 */
function isReady(
  nodeId: string,
  plan: CanvasWorkflowGraphPlan,
  states: ReadonlyMap<string, InternalNodeState>,
): boolean {
  return (plan.dependenciesByNodeId.get(nodeId) ?? []).every((dependencyId) => {
    const status = states.get(dependencyId)?.status
    return status === 'satisfied' || status === 'completed'
  })
}

/** 将低层候选批次摘要裁剪为工作流公开计数。 */
function toWorkflowImageSummary(summary: CanvasRunNodesBatchTerminalSummary): CanvasWorkflowImageSummary {
  return {
    status: summary.status,
    totalCount: summary.totalCount,
    candidateCount: summary.candidateCount,
    failedCount: summary.failedCount,
    runningCount: summary.runningCount,
  }
}

/** 累加不同单节点子批和动态波次的终态计数。 */
function mergeWorkflowImageSummary(
  current: CanvasWorkflowImageSummary | null,
  next: CanvasWorkflowImageSummary,
): CanvasWorkflowImageSummary {
  const totalCount = (current?.totalCount ?? 0) + next.totalCount
  const candidateCount = (current?.candidateCount ?? 0) + next.candidateCount
  const failedCount = (current?.failedCount ?? 0) + next.failedCount
  const runningCount = (current?.runningCount ?? 0) + next.runningCount
  return {
    status: failedCount === 0 && runningCount === 0 && candidateCount === totalCount ? 'ready' : 'partial',
    totalCount,
    candidateCount,
    failedCount,
    runningCount,
  }
}

/** 为未产生可信终态的已尝试节点构造公开失败计数。 */
function failedWorkflowImageSummary(): CanvasWorkflowImageSummary {
  return { status: 'partial', totalCount: 1, candidateCount: 0, failedCount: 1, runningCount: 0 }
}

/** 对不接受 signal 的只读短 I/O 加 deadline gate，迟到结果不会触发后续副作用。 */
async function awaitReadOnlyWithinDeadline<T>(
  operation: () => T | Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) throw new Error('CANVAS_WORKFLOW_ABORTED')
  /** 操作只允许权威读取或授权复核，因此底层迟到完成本身没有写副作用。 */
  const operationPromise = Promise.resolve().then(operation)
  return new Promise<T>((resolve, reject) => {
    /** 完成标记保证操作和取消只有一个结果能离开 gate。 */
    let settled = false
    /** 取消监听只终止调度器等待，不尝试伪造底层 I/O 取消。 */
    const onAbort = (): void => {
      if (settled) return
      settled = true
      reject(new Error('CANVAS_WORKFLOW_ABORTED'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    operationPromise.then(
      (value) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

/** 把状态表裁剪成共享公开结果，不透传任务、路径或异常正文。 */
function projectNodeResults(
  plan: CanvasWorkflowGraphPlan | null,
  states: ReadonlyMap<string, InternalNodeState>,
): CanvasWorkflowNodeResult[] {
  if (!plan) return []
  return plan.reachableNodeIds.map((nodeId) => {
    const state = states.get(nodeId) ?? {
      status: 'blocked' as const,
      errorCode: 'CANVAS_WORKFLOW_INCOMPLETE',
    }
    if (state.status === 'failed' || state.status === 'blocked') {
      return { nodeId, status: state.status, errorCode: state.errorCode ?? 'CANVAS_WORKFLOW_INCOMPLETE' }
    }
    return { nodeId, status: state.status, errorCode: null }
  })
}

/** 将持久节点状态映射为现有公开工作流结果，内部身份不会跨工具合同泄露。 */
function projectDurableRunResult(run: CanvasWorkflowRun): CanvasRunWorkflowResult {
  const nodes: CanvasWorkflowNodeResult[] = run.nodes.map((node) => {
    const status: CanvasWorkflowNodeStatus = node.status === 'ready' || node.status === 'running'
      ? 'started'
      : node.status === 'waiting-adoption'
        ? 'waiting-review'
        : node.status
    if (status === 'failed' || status === 'blocked') {
      return { nodeId: node.nodeId, status, errorCode: node.errorCode ?? 'CANVAS_WORKFLOW_INCOMPLETE' }
    }
    return { nodeId: node.nodeId, status, errorCode: null }
  })
  const imageNodes = run.nodes.filter((node) => node.kind === 'image' && node.execution?.kind === 'image')
  const candidateCount = imageNodes.filter((node) => node.status === 'waiting-adoption' || node.status === 'completed').length
  const failedCount = imageNodes.filter((node) => node.status === 'failed').length
  const runningCount = imageNodes.filter((node) => node.status === 'running').length
  const imageSummary: CanvasWorkflowImageSummary | null = imageNodes.length === 0 ? null : {
    status: candidateCount === imageNodes.length ? 'ready' : failedCount > 0 ? 'partial' : 'running',
    totalCount: imageNodes.length,
    candidateCount,
    failedCount,
    runningCount,
  }
  const base = {
    initialRevision: run.initialCanvasRevision,
    finalRevision: run.observedCanvasRevision,
    nodes,
    imageSummary,
  }
  if (run.status === 'completed') {
    return { ...base, status: 'completed', requiresReview: false, errorCode: null }
  }
  if (run.status === 'waiting-review') {
    return { ...base, status: 'waiting-review', requiresReview: true, errorCode: null }
  }
  if (run.status === 'cancelled') {
    return { ...base, status: 'cancelled', requiresReview: false, errorCode: null }
  }
  if (run.status === 'failed') {
    return { ...base, status: 'failed', requiresReview: false, errorCode: 'CANVAS_WORKFLOW_FAILED' }
  }
  if (run.status === 'waiting-budget') {
    return {
      ...base,
      status: 'partial',
      requiresReview: false,
      errorCode: 'CANVAS_WORKFLOW_BUDGET_EXHAUSTED',
    }
  }
  return {
    ...base,
    status: 'partial',
    requiresReview: nodes.some((node) => node.status === 'waiting-review'),
    errorCode: null,
  }
}

/** 从已提交 Agent 指针派生完成事实，不保存消息正文。 */
function hashAgentCompletion(output: NonNullable<Awaited<ReturnType<CanvasAgentExecutionService['execute']>>['output']>): string {
  return createHash('sha256').update(JSON.stringify([
    'canvas-workflow-agent-output', output.pointer,
  ])).digest('hex')
}

/** 扣减一个已持久执行段的保守耗时，并暂停时钟。 */
function pauseDurableRunDuration(run: CanvasWorkflowRun, timestamp: number): void {
  const activeStartedAt = run.budget.activeStartedAt
  if (activeStartedAt === null) return
  const elapsed = Math.max(0, timestamp - activeStartedAt)
  run.budget.remainingDurationMs = Math.max(0, run.budget.remainingDurationMs - elapsed)
  run.budget.activeStartedAt = null
}

/** 开始新的执行计时段；调用方须立即持久化该起点。 */
function startDurableRunDuration(run: CanvasWorkflowRun, timestamp: number): void {
  if (run.budget.activeStartedAt !== null) return
  run.budget.activeStartedAt = timestamp
}

/** 校验恢复回调只能提交当前节点的精确正式输出。 */
function assertRecoveredAgentOutput(
  output: CanvasAgentOutputCommitResult,
  target: CanvasTarget & { nodeId: string },
  expectedStartedAt: number,
): void {
  if (output.target.projectId !== target.projectId
    || output.target.canvasId !== target.canvasId
    || output.target.nodeId !== target.nodeId
    || output.pointer.completedAt < expectedStartedAt) {
    throw new Error('CANVAS_AGENT_RECOVERY_OUTPUT_INVALID')
  }
}

/** 创建一次性、无持久运行计划的 Canvas 工作流调度器。 */
export function createCanvasWorkflowExecutionService(
  dependencies: CanvasWorkflowExecutionServiceDependencies,
): CanvasWorkflowExecutionService {
  /** 活跃表只按项目和 Canvas 限制单工作流，不持久化运行计划。 */
  const activeRuns = new Map<string, symbol>()
  const now = dependencies.now ?? Date.now
  const setDeadline = dependencies.setDeadline ?? ((callback, timeoutMs) => {
    const timer = setTimeout(callback, timeoutMs)
    return { cancel: () => clearTimeout(timer) }
  })
  /** 持久运行的活动控制器按 Canvas 隔离，取消可精确终止当前等待。 */
  const durableControllers = new Map<string, AbortController>()

  /** journal 提交后发送轻量变化事实；通知失败不能反转权威保存。 */
  const notifyRunChanged = (run: CanvasWorkflowRun): void => {
    try {
      dependencies.onRunChanged?.({
        projectId: run.projectId,
        canvasId: run.canvasId,
        runId: run.id,
        revision: run.revision,
      })
    } catch {
      /** 观察者只负责唤醒界面，不参与状态事务。 */
    }
  }

  /** 返回保存结果并发布对应 revision，供各专用 CAS 入口统一使用。 */
  const publishSavedRun = (run: CanvasWorkflowRun): CanvasWorkflowRun => {
    notifyRunChanged(run)
    return run
  }

  /** 保存一次持久状态推进并接管新的 revision。 */
  const persistRun = (run: CanvasWorkflowRun): CanvasWorkflowRun => {
    if (!dependencies.workflowRuns) throw new Error('CANVAS_WORKFLOW_RUN_STORE_UNAVAILABLE')
    const saved = dependencies.workflowRuns.saveExecutionProgress(run, run.revision)
    return publishSavedRun(saved)
  }

  /** 判断异常是否为持久运行并发提交冲突。 */
  const isWorkflowRunConflict = (error: unknown): boolean => (
    error instanceof Error && error.message === 'CANVAS_WORKFLOW_RUN_CONFLICT'
  )

  /** 先以 fresh-read + CAS 记录取消意图，使后续清理失败也不会丢失用户事实。 */
  const requestDurableCancellation = (
    target: CanvasTarget,
    runId: string,
    timestamp: number,
  ): CanvasWorkflowRun => {
    if (!dependencies.workflowRuns) throw new Error('CANVAS_WORKFLOW_RUN_STORE_UNAVAILABLE')
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const current = dependencies.workflowRuns.get(target, runId)
      if (current.status === 'cancelled' || current.status === 'completed'
        || current.cancelRequestedAt !== null) return current
      current.cancelRequestedAt = timestamp
      try {
        return publishSavedRun(dependencies.workflowRuns.save(current, current.revision))
      } catch (error) {
        if (!isWorkflowRunConflict(error) || attempt === 3) throw error
      }
    }
    throw new Error('CANVAS_WORKFLOW_RUN_CONFLICT')
  }

  /** 从最新 journal 收敛取消终态，避免覆盖并发执行刚提交的节点事实。 */
  const finalizeDurableCancellation = (
    target: CanvasTarget,
    runId: string,
    timestamp: number,
    deadlineExpired: boolean,
  ): CanvasWorkflowRun => {
    if (!dependencies.workflowRuns) throw new Error('CANVAS_WORKFLOW_RUN_STORE_UNAVAILABLE')
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const current = dependencies.workflowRuns.get(target, runId)
      if (current.status === 'cancelled' || current.status === 'completed') return current
      for (const node of current.nodes) {
        if (node.status === 'ready' || node.status === 'running' || node.status === 'waiting-approval') {
          node.status = 'cancelled'
          node.errorCode = null
        }
      }
      /** 已持久化 intent 时，预算只累计到用户实际请求取消的时刻。 */
      pauseDurableRunDuration(current, current.cancelRequestedAt ?? timestamp)
      if (deadlineExpired) current.budget.remainingDurationMs = 0
      current.cancelRequestedAt = current.cancelRequestedAt ?? timestamp
      current.cancelledAt = timestamp
      current.status = 'cancelled'
      try {
        return publishSavedRun(dependencies.workflowRuns.save(current, current.revision))
      } catch (error) {
        if (!isWorkflowRunConflict(error) || attempt === 3) throw error
      }
    }
    throw new Error('CANVAS_WORKFLOW_RUN_CONFLICT')
  }

  /** deadline 只暂停本地推进，不伪造用户取消，也不改写已提交远端任务身份。 */
  const pauseDurableRunForBudget = (
    target: CanvasTarget,
    runId: string,
    timestamp: number,
  ): CanvasWorkflowRun => {
    if (!dependencies.workflowRuns) throw new Error('CANVAS_WORKFLOW_RUN_STORE_UNAVAILABLE')
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const current = dependencies.workflowRuns.get(target, runId)
      if (current.status === 'cancelled' || current.status === 'completed') return current
      pauseDurableRunDuration(current, timestamp)
      current.budget.remainingDurationMs = 0
      current.status = current.nodes.some((node) => node.status === 'waiting-adoption')
        ? 'waiting-review'
        : 'waiting-budget'
      try {
        return publishSavedRun(dependencies.workflowRuns.save(current, current.revision))
      } catch (error) {
        if (!isWorkflowRunConflict(error) || attempt === 3) throw error
      }
    }
    throw new Error('CANVAS_WORKFLOW_RUN_CONFLICT')
  }

  /** 将持久运行恢复并推进到下一个用户边界或终态。 */
  const driveDurableRun = async (
    context: CanvasToolRunContext,
    initialRun: CanvasWorkflowRun,
    parentSignal?: AbortSignal,
  ): Promise<CanvasWorkflowRun> => {
    if (!dependencies.workflowRuns) throw new Error('CANVAS_WORKFLOW_RUN_STORE_UNAVAILABLE')
    if (initialRun.projectId !== context.projectId || initialRun.owner.sessionId !== context.sessionId) {
      throw new Error('CANVAS_WORKFLOW_RUN_OWNER_INVALID')
    }
    if (initialRun.status === 'cancelled' || initialRun.status === 'completed') return initialRun
    if (initialRun.status === 'waiting-budget' && initialRun.budget.remainingDurationMs === 0) {
      return initialRun
    }
    const initialTarget = { projectId: initialRun.projectId, canvasId: initialRun.canvasId }
    if (initialRun.cancelRequestedAt !== null) {
      return finalizeDurableCancellation(initialTarget, initialRun.id, now(), false)
    }
    const releaseLease = dependencies.workflowRuns.acquireLease(initialTarget, initialRun.id)
    if (!releaseLease) return dependencies.workflowRuns.get(initialTarget, initialRun.id)
    const activeKey = `${initialRun.projectId}\0${initialRun.canvasId}`
    if (durableControllers.has(activeKey)) {
      releaseLease()
      throw new Error('CANVAS_WORKFLOW_ACTIVE')
    }
    const controller = new AbortController()
    durableControllers.set(activeKey, controller)
    const onParentAbort = (): void => controller.abort('cancel')
    parentSignal?.addEventListener('abort', onParentAbort, { once: true })
    if (parentSignal?.aborted) controller.abort('cancel')
    let run = initialRun
    const target = initialTarget
    /** 权限始终复核当前调用者；外部执行身份固定为 journal 中的原始工作流 owner。 */
    const executionContext: CanvasToolRunContext = {
      ...context,
      sessionId: initialRun.owner.sessionId,
      runStartedAt: initialRun.owner.runStartedAt,
    }
    /** 当前进程只为实际执行段注册 deadline；等待 review 时没有计时器。 */
    const deadlineState: { handle: CanvasWorkflowDeadlineHandle | null } = { handle: null }
    let deadlineAt = now() + run.budget.remainingDurationMs
    let deadlineExpired = false

    /** 恢复或开始执行段，并按 journal 剩余时长设置唯一 deadline。 */
    const activateDurationBudget = (): void => {
      if (deadlineState.handle || controller.signal.aborted) return
      const timestamp = now()
      pauseDurableRunDuration(run, timestamp)
      if (run.budget.remainingDurationMs === 0) {
        deadlineExpired = true
        controller.abort('deadline')
        return
      }
      startDurableRunDuration(run, timestamp)
      run = persistRun(run)
      deadlineAt = timestamp + run.budget.remainingDurationMs
      deadlineState.handle = setDeadline(() => {
        deadlineExpired = true
        controller.abort('deadline')
      }, run.budget.remainingDurationMs)
    }

    /** 用户边界或终态暂停计时并持久化真实剩余值。 */
    const pauseAndPersistDurationBudget = (): void => {
      if (run.budget.activeStartedAt === null) return
      pauseDurableRunDuration(run, now())
      run = persistRun(run)
      deadlineState.handle?.cancel()
      deadlineState.handle = null
    }

    try {
      if (run.status === 'running') activateDurationBudget()
      while (!controller.signal.aborted) {
        await awaitReadOnlyWithinDeadline(
          () => dependencies.validateAccess(context, run.canvasId), controller.signal,
        )
        const document = await awaitReadOnlyWithinDeadline(() => dependencies.load(target), controller.signal)
        await awaitReadOnlyWithinDeadline(
          () => dependencies.validateAccess(context, run.canvasId), controller.signal,
        )

        /** 先以原消息身份恢复已启动 Agent；不得用当前末条输出或节点旧指针替代。 */
        let changed = false
        let externalExecutionStillRunning = false
        for (const node of run.nodes) {
          if (node.status !== 'running' || node.execution?.kind !== 'agent') continue
          const canvasNode = document.nodes.find((candidate): candidate is Extract<CanvasNode, { kind: 'agent' }> => (
            candidate.id === node.nodeId && candidate.kind === 'agent'
          ))
          if (!canvasNode || !dependencies.recoverAgentExecution) {
            node.status = 'failed'
            node.errorCode = 'CANVAS_AGENT_RUN_INTERRUPTED'
            changed = true
            continue
          }
          const recovered = await dependencies.recoverAgentExecution({
            ...target,
            nodeId: node.nodeId,
            agentSessionId: canvasNode.agentSessionId,
            operationId: node.execution.operationId,
            expectedUserMessageUuid: (node.executionHistory?.length ?? 0) > 0
              ? node.execution.operationId
              : run.operationId,
            expectedStartedAt: run.owner.runStartedAt,
          })
          if (recovered.status === 'completed') {
            assertRecoveredAgentOutput(recovered.output, { ...target, nodeId: node.nodeId }, run.owner.runStartedAt)
            node.status = 'completed'
            node.errorCode = null
            node.completedArtifactHash = hashAgentCompletion(recovered.output)
            node.completedAt = recovered.output.pointer.completedAt
            run.observedCanvasRevision = Math.max(run.observedCanvasRevision, recovered.output.revision)
          } else if (recovered.status === 'running') {
            externalExecutionStillRunning = true
          } else if (recovered.status === 'changed') {
            node.status = 'failed'
            node.errorCode = 'CANVAS_WORKFLOW_OUTPUT_CHANGED'
          } else {
            node.status = 'failed'
            node.errorCode = 'CANVAS_AGENT_RUN_INTERRUPTED'
          }
          changed = true
        }

        /** 已取得 mediaRunId 的节点只恢复原运行和下载收集，不重新提交媒体任务。 */
        for (const node of run.nodes) {
          if (node.status !== 'running' || node.execution?.kind !== 'media'
            || !node.execution.mediaRunId) continue
          const canvasNode = document.nodes.find((candidate): candidate is Extract<CanvasNode, {
            kind: 'audio' | 'video'
          }> => candidate.id === node.nodeId && (candidate.kind === 'audio' || candidate.kind === 'video'))
          if (!canvasNode || !dependencies.mediaRuns?.reconcile) {
            node.status = 'failed'
            node.errorCode = 'CANVAS_MEDIA_RUN_INTERRUPTED'
            changed = true
            continue
          }
          const originalMediaRunId = node.execution.mediaRunId
          const recovered = await dependencies.mediaRuns.reconcile({
            ...target,
            nodeId: node.nodeId,
            mediaModuleId: canvasNode.mediaModuleId,
            mediaKind: canvasNode.kind,
            operationId: node.execution.operationId,
            mediaRunId: originalMediaRunId,
            context: executionContext,
            workflowRunId: run.id,
            signal: controller.signal,
            deadlineAt,
          })
          if (recovered.mediaRunId !== originalMediaRunId) {
            throw new Error('CANVAS_MEDIA_RUN_ID_MISMATCH')
          }
          node.execution.outputKeys = [...recovered.outputKeys]
          node.status = recovered.status
          node.errorCode = recovered.status === 'failed'
            ? recovered.errorCode ?? 'CANVAS_MEDIA_RUN_FAILED'
            : null
          node.retryDisposition = recovered.status === 'failed'
            ? recovered.retryable ? 'terminal-failed' : 'submission-unknown'
            : 'none'
          if (recovered.status === 'running') externalExecutionStillRunning = true
          changed = true
        }

        /** 提交确认前崩溃只可按原 operationId 幂等重放。 */
        for (const node of run.nodes) {
          if (node.status === 'running' && node.execution?.kind === 'image'
            && node.execution.batchId === null) {
            node.status = 'ready'
            changed = true
          } else if (node.status === 'running' && node.execution?.kind === 'media'
            && node.execution.mediaRunId === null) {
            node.status = 'ready'
            changed = true
          }
        }
        if (changed) run = persistRun(run)
        if (externalExecutionStillRunning) {
          await dependencies.scheduleDurableResume?.({
            ...target,
            workflowRunId: run.id,
            ownerSessionId: run.owner.sessionId,
            resumeAt: deadlineAt,
          })
          break
        }

        if (dependencies.applyPreparedHandoffs) {
          const prepared = await dependencies.applyPreparedHandoffs(run, document)
          if (JSON.stringify(prepared) !== JSON.stringify(run)) {
            run = publishSavedRun(dependencies.workflowRuns.savePreparedMediaAmendment(prepared, run.revision))
          }
        }

        const reconciled = await reconcileCanvasWorkflowRun(run, document, {
          isImageCandidateAdopted: dependencies.isImageCandidateAdopted ?? (() => ({
            adopted: false, artifactHash: null, committedAt: null,
          })),
          isMediaOutputAdopted: dependencies.isMediaOutputAdopted,
        })
        /** 已完成上游使原正式下游变为待更新时，只重跑固定范围内该后继。 */
        const completedIds = new Set(reconciled.run.nodes
          .filter((node) => node.status === 'completed')
          .map((node) => node.nodeId))
        for (const node of reconciled.run.nodes) {
          const current = document.nodes.find((candidate) => candidate.id === node.nodeId)
          if (node.status === 'satisfied'
            && current?.upstreamChange?.sourceNodeIds.some((nodeId) => completedIds.has(nodeId))) {
            node.status = 'ready'
          }
        }
        if (JSON.stringify(reconciled.run) !== JSON.stringify(run)) {
          run = persistRun(reconciled.run)
        } else {
          run = reconciled.run
        }
        /** waiting-review 采用成功后才重新开始扣减执行时长。 */
        if (run.status === 'running' && !deadlineState.handle) activateDurationBudget()
        if (controller.signal.aborted) break

        /** 恢复图片已提交任务时继续等待原 batch/task，不重投生成。 */
        const waitingImage = run.nodes.find((node) => (
          node.status === 'running'
          && node.execution?.kind === 'image'
          && node.execution.batchId !== null
          && node.execution.taskId !== null
        ))
        if (waitingImage?.execution?.kind === 'image'
          && waitingImage.execution.batchId
          && waitingImage.execution.taskId) {
          const batchId = waitingImage.execution.batchId
          const taskId = waitingImage.execution.taskId
          try {
            const terminal = await dependencies.imageRuns.awaitBatch({
              ...target,
              batchId,
              taskIds: [taskId],
              signal: controller.signal,
              deadlineAt,
            })
            const entry = terminal.entries.find((candidate) => (
              candidate.nodeId === waitingImage.nodeId
              && candidate.taskId === taskId
            ))
            if (entry?.status === 'candidate') {
              waitingImage.status = 'waiting-adoption'
              waitingImage.errorCode = null
              waitingImage.retryDisposition = 'none'
            } else {
              waitingImage.status = 'failed'
              waitingImage.errorCode = entry?.status === 'failed'
                ? 'CANVAS_IMAGE_RUN_FAILED'
                : 'CANVAS_IMAGE_RESULT_INVALID'
              waitingImage.retryDisposition = entry?.status === 'failed'
                ? 'terminal-failed'
                : 'submission-unknown'
            }
          } catch (error) {
            if (controller.signal.aborted) break
            waitingImage.status = 'failed'
            waitingImage.errorCode = stableErrorCode(error, 'CANVAS_IMAGE_RUN_FAILED')
            waitingImage.retryDisposition = 'submission-unknown'
          }
          run = persistRun(run)
          continue
        }

        const readyAgentIds = reconciled.readyNodeIds.filter((nodeId) => (
          run.nodes.find((node) => node.nodeId === nodeId)?.kind === 'agent'
        )).slice(0, MAX_AGENT_CONCURRENCY)
        if (readyAgentIds.length > 0) {
          for (const nodeId of readyAgentIds) {
            const node = run.nodes.find((candidate) => candidate.nodeId === nodeId)!
            node.status = 'running'
            node.execution = {
              kind: 'agent',
              operationId: createCanvasWorkflowNodeOperationId(
                run.operationId, nodeId, 'agent', node.executionHistory?.length ?? 0,
              ),
            }
          }
          run = persistRun(run)
          /** 子 Agent 可在运行中登记动态后继，完成回写前必须接管最新 journal revision。 */
          const expectedAgentOperations = new Map(readyAgentIds.map((nodeId) => {
            const execution = run.nodes.find((node) => node.nodeId === nodeId)?.execution
            if (execution?.kind !== 'agent') throw new Error('CANVAS_AGENT_RUN_IDENTITY_INVALID')
            return [nodeId, execution.operationId]
          }))
          const results = await Promise.allSettled(readyAgentIds.map((nodeId) => (
            dependencies.agentExecution.execute({
              mode: 'parent-orchestrated',
              target: { ...target, nodeId },
              parentSessionId: executionContext.sessionId,
              expectedGraphRevision: document.revision,
              parentWorkflow: { runId: run.id, parentSessionId: executionContext.sessionId },
              instruction: run.goal,
              userMessageUuid: (run.nodes.find((node) => node.nodeId === nodeId)?.executionHistory?.length ?? 0) > 0
                ? expectedAgentOperations.get(nodeId)!
                : run.operationId,
              startedAt: run.owner.runStartedAt,
              signal: controller.signal,
            })
          )))
          run = dependencies.workflowRuns.get(target, run.id)
          let agentCommitInterrupted = false
          for (let index = 0; index < readyAgentIds.length; index += 1) {
            const nodeId = readyAgentIds[index]!
            const node = run.nodes.find((candidate) => candidate.nodeId === nodeId)
            if (!node || node.status !== 'running' || node.execution?.kind !== 'agent'
              || node.execution.operationId !== expectedAgentOperations.get(nodeId)) {
              if (controller.signal.aborted || run.cancelRequestedAt !== null || run.status === 'cancelled') {
                agentCommitInterrupted = true
                break
              }
              throw new Error('CANVAS_AGENT_RUN_IDENTITY_INVALID')
            }
            const result = results[index]!
            if (result.status === 'fulfilled' && result.value.status === 'completed' && result.value.output) {
              node.status = 'completed'
              node.errorCode = null
              node.completedArtifactHash = hashAgentCompletion(result.value.output)
              node.completedAt = result.value.output.pointer.completedAt
              run.observedCanvasRevision = Math.max(run.observedCanvasRevision, result.value.output.revision)
            } else if (result.status === 'fulfilled' && result.value.status === 'cancelled') {
              node.status = 'cancelled'
              node.errorCode = null
            } else {
              node.status = 'failed'
              node.errorCode = result.status === 'rejected'
                ? stableErrorCode(result.reason, 'CANVAS_AGENT_RUN_FAILED')
                : 'CANVAS_AGENT_RUN_FAILED'
              node.retryDisposition = result.status === 'fulfilled'
                ? 'terminal-failed'
                : 'submission-unknown'
            }
          }
          if (agentCommitInterrupted) break
          run = persistRun(run)
          continue
        }

        const readyImageId = reconciled.readyNodeIds.find((nodeId) => (
          run.nodes.find((node) => node.nodeId === nodeId)?.kind === 'image'
        ))
        if (readyImageId) {
          const node = document.nodes.find((candidate): candidate is Extract<CanvasNode, { kind: 'image' }> => (
            candidate.id === readyImageId && candidate.kind === 'image'
          ))
          const runNode = run.nodes.find((candidate) => candidate.nodeId === readyImageId)!
          if (!node) throw new Error('CANVAS_WORKFLOW_GRAPH_CHANGED')
          const isReplay = runNode.execution?.kind === 'image'
          const operationId = isReplay
            ? runNode.execution!.operationId
            : createCanvasWorkflowNodeOperationId(
                run.operationId, readyImageId, 'image', runNode.executionHistory?.length ?? 0,
              )
          runNode.status = 'running'
          runNode.execution = { kind: 'image', operationId, batchId: null, taskId: null }
          if (!isReplay) {
            run.budget.consumedMediaRuns += 1
            run.budget.remainingMediaRuns -= 1
          }
          run = persistRun(run)
          try {
            const started = await dependencies.imageRuns.run(
              executionContext, target, [node], operationId, { signal: controller.signal, deadlineAt },
            )
            const task = started.tasks.find((candidate) => candidate.nodeId === readyImageId)
            if (!started.batch || !task?.taskId) throw new Error('CANVAS_IMAGE_BATCH_MISSING')
            const persistedNode = run.nodes.find((candidate) => candidate.nodeId === readyImageId)!
            persistedNode.execution = {
              kind: 'image', operationId, batchId: started.batch.batchId, taskId: task.taskId,
            }
            run = persistRun(run)
          } catch (error) {
            if (controller.signal.aborted) break
            const persistedNode = run.nodes.find((candidate) => candidate.nodeId === readyImageId)!
            persistedNode.status = 'failed'
            persistedNode.errorCode = stableErrorCode(error, 'CANVAS_IMAGE_RUN_FAILED')
            persistedNode.retryDisposition = 'submission-unknown'
            run = persistRun(run)
          }
          continue
        }

        const readyMediaIds = reconciled.readyNodeIds.filter((nodeId) => {
          const kind = run.nodes.find((node) => node.nodeId === nodeId)?.kind
          return kind === 'audio' || kind === 'video'
        })
        if (readyMediaIds.length > 0) {
          const nodeId = readyMediaIds[0]!
          const canvasNode = document.nodes.find((candidate): candidate is Extract<CanvasNode, {
            kind: 'audio' | 'video'
          }> => candidate.id === nodeId && (candidate.kind === 'audio' || candidate.kind === 'video'))
          const runNode = run.nodes.find((candidate) => candidate.nodeId === nodeId)!
          if (!canvasNode) throw new Error('CANVAS_WORKFLOW_GRAPH_CHANGED')
          if (!dependencies.mediaRuns) {
            runNode.status = 'blocked'
            runNode.errorCode = 'CANVAS_WORKFLOW_MEDIA_EXECUTOR_UNAVAILABLE'
            run.status = 'partial'
            run = persistRun(run)
            break
          }
          const resolved = await dependencies.mediaRuns.resolveInputs({
            ...target,
            nodeId,
            mediaModuleId: canvasNode.mediaModuleId,
            mediaKind: canvasNode.kind,
          })
          const prepared = prepareCanvasWorkflowMediaInputs(run, nodeId, resolved)
          const isReplay = runNode.execution?.kind === 'media'
          const operationId = isReplay
            ? runNode.execution!.operationId
            : createCanvasWorkflowNodeOperationId(
                run.operationId, nodeId, canvasNode.kind, runNode.executionHistory?.length ?? 0,
              )
          const preparedIndex = run.nodes.findIndex((candidate) => candidate.nodeId === nodeId)
          prepared.node.status = 'running'
          prepared.node.errorCode = null
          prepared.node.execution = {
            kind: 'media', operationId, mediaRunId: null, outputKeys: [],
          }
          run.nodes[preparedIndex] = prepared.node
          if (!isReplay) {
            run.budget.consumedMediaRuns += 1
            run.budget.remainingMediaRuns -= 1
          }
          run = persistRun(run)
          const expectedInputHashes = Object.fromEntries(prepared.node.inputBindings.map((binding) => [
            binding.targetInputKey,
            binding.resolvedValueHash!,
          ]))
          try {
            const result = await dependencies.mediaRuns.run({
              ...target,
              nodeId,
              mediaModuleId: canvasNode.mediaModuleId,
              mediaKind: canvasNode.kind,
              expectedConfigRevision: resolved.configRevision,
              operationId,
              resolvedValues: prepared.resolvedValues,
              expectedInputHashes,
              context: executionContext,
              workflowRunId: run.id,
              signal: controller.signal,
            })
            const persistedNode = run.nodes.find((candidate) => candidate.nodeId === nodeId)!
            persistedNode.execution = {
              kind: 'media',
              operationId,
              mediaRunId: result.mediaRunId,
              outputKeys: [...result.outputKeys],
            }
            persistedNode.status = result.status
            persistedNode.errorCode = result.status === 'failed'
              ? result.errorCode ?? 'CANVAS_MEDIA_RUN_FAILED'
              : null
            persistedNode.retryDisposition = result.status === 'failed'
              ? result.retryable ? 'terminal-failed' : 'submission-unknown'
              : 'none'
            run = persistRun(run)
          } catch (error) {
            if (controller.signal.aborted) break
            const persistedNode = run.nodes.find((candidate) => candidate.nodeId === nodeId)!
            persistedNode.status = 'failed'
            persistedNode.errorCode = stableErrorCode(error, 'CANVAS_MEDIA_RUN_FAILED')
            persistedNode.retryDisposition = 'submission-unknown'
            run = persistRun(run)
          }
          continue
        }

        if (run.status === 'running') {
          const hasWaitingApproval = run.nodes.some((node) => node.status === 'waiting-approval')
          run.status = hasWaitingApproval ? 'partial' : 'failed'
          run = persistRun(run)
        }
        break
      }

      if (controller.signal.aborted) {
        run = deadlineExpired
          ? pauseDurableRunForBudget(target, run.id, now())
          : finalizeDurableCancellation(target, run.id, now(), false)
      } else if (run.status !== 'running') {
        /** review、审批或终态不占用执行预算。 */
        pauseAndPersistDurationBudget()
      }
      return run
    } catch (error) {
      if (!controller.signal.aborted) throw error
      return deadlineExpired
        ? pauseDurableRunForBudget(target, run.id, now())
        : finalizeDurableCancellation(target, run.id, now(), false)
    } finally {
      deadlineState.handle?.cancel()
      parentSignal?.removeEventListener('abort', onParentAbort)
      if (durableControllers.get(activeKey) === controller) durableControllers.delete(activeKey)
      releaseLease()
    }
  }

  /** 创建副作用完成后若无法正常扩展计划，保存精确失败节点或将当前分支置为失败。 */
  const persistCreatedSuccessorFailure = async (
    context: CanvasToolRunContext,
    input: CanvasTarget & { nodeId: string; sourceToolCallId: string },
    reasonCode: string,
  ): Promise<CanvasWorkflowSuccessorRegistrationResult> => {
    if (!dependencies.workflowRuns) throw new Error('CANVAS_WORKFLOW_RUN_STORE_UNAVAILABLE')
    const parentWorkflow = context.parentWorkflow
    const branchTarget = context.canvasAgentTarget
    if (context.canvasAgentMode !== 'parent-orchestrated' || !parentWorkflow || !branchTarget
      || input.projectId !== context.projectId
      || branchTarget.projectId !== input.projectId || branchTarget.canvasId !== input.canvasId
      || !/^[A-Za-z0-9_-]{1,160}$/.test(input.nodeId)
      || !/^[A-Za-z0-9_-]{1,160}$/.test(input.sourceToolCallId)) {
      throw new Error('CANVAS_WORKFLOW_DYNAMIC_SUCCESSOR_CONTEXT_INVALID')
    }
    await dependencies.validateAccess(context, input.canvasId)
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const current = dependencies.workflowRuns.get(input, parentWorkflow.runId)
      if (current.owner.sessionId !== parentWorkflow.parentSessionId
        || current.owner.runStartedAt !== context.runStartedAt) {
        throw new Error('CANVAS_WORKFLOW_RUN_OWNER_INVALID')
      }
      if (current.cancelRequestedAt !== null || current.status !== 'running') {
        return { status: 'blocked', workflowRunId: current.id, workflowRunRevision: current.revision,
          reasonCode: 'CANVAS_WORKFLOW_DYNAMIC_SUCCESSOR_RUN_CLOSED' }
      }
      const document = await dependencies.load(input)
      await dependencies.validateAccess(context, input.canvasId)
      const branchCanvasNode = document.nodes.find((node) => node.id === branchTarget.nodeId)
      const branchRunNode = current.nodes.find((node) => node.nodeId === branchTarget.nodeId)
      if (branchCanvasNode?.kind !== 'agent' || branchCanvasNode.agentSessionId !== context.sessionId
        || branchRunNode?.kind !== 'agent' || branchRunNode.status !== 'running'
        || branchRunNode.execution?.kind !== 'agent') {
        throw new Error('CANVAS_WORKFLOW_DYNAMIC_SUCCESSOR_BRANCH_INACTIVE')
      }
      const existing = current.nodes.find((node) => node.nodeId === input.nodeId)
      if (existing) {
        const createdNode = document.nodes.find((node) => node.id === input.nodeId)
        if (!createdNode || createdNode.kind !== existing.kind
          || createCanvasWorkflowNodeIdentityHash(createdNode) !== existing.identityHash) {
          throw new Error('CANVAS_WORKFLOW_GRAPH_CHANGED')
        }
        return existing.status === 'blocked'
          ? { status: 'blocked', workflowRunId: current.id, workflowRunRevision: current.revision,
              reasonCode: existing.errorCode ?? reasonCode }
          : { status: 'already-registered', workflowRunId: current.id,
              workflowRunRevision: current.revision, reasonCode: null }
      }
      try {
        if (current.nodes.length < CANVAS_WORKFLOW_RUN_NODE_LIMIT) {
          const blocked = createBlockedSuccessorAmendment(
            current, document, branchTarget.nodeId, input.nodeId, reasonCode,
          )
          const saved = publishSavedRun(dependencies.workflowRuns.saveDynamicSuccessorAmendment(blocked, current.revision))
          return { status: 'blocked', workflowRunId: saved.id, workflowRunRevision: saved.revision, reasonCode }
        }
        /** 节点上限下无法追加身份，至少让原父分支跨重启明确失败。 */
        const failed = structuredClone(current)
        const failedBranch = failed.nodes.find((node) => node.nodeId === branchTarget.nodeId)!
        failedBranch.status = 'failed'
        failedBranch.errorCode = reasonCode
        failed.status = 'partial'
        const saved = publishSavedRun(dependencies.workflowRuns.save(failed, current.revision))
        return { status: 'blocked', workflowRunId: saved.id, workflowRunRevision: saved.revision, reasonCode }
      } catch (error) {
        if (!isWorkflowRunConflict(error) || attempt === 3) throw error
      }
    }
    throw new Error('CANVAS_WORKFLOW_RUN_CONFLICT')
  }

  return {
    execute: async (context, input, toolCallId, parentSignal) => {
      if (dependencies.workflowRuns) {
        const target = { projectId: context.projectId, canvasId: input.canvasId }
        await dependencies.validateAccess(context, input.canvasId)
        const document = await dependencies.load(target)
        await dependencies.validateAccess(context, input.canvasId)
        if (document.revision !== input.expectedRevision) throw new Error('CANVAS_REVISION_CONFLICT')
        const snapshot = createCanvasWorkflowPlanSnapshot(document, input)
        if (dependencies.mediaRuns) {
          for (let index = 0; index < snapshot.nodes.length; index += 1) {
            const plannedNode = snapshot.nodes[index]!
            if (plannedNode.kind !== 'audio' && plannedNode.kind !== 'video') continue
            const canvasNode = document.nodes.find((node) => node.id === plannedNode.nodeId)
            if (!canvasNode || (canvasNode.kind !== 'audio' && canvasNode.kind !== 'video')) {
              throw new Error('CANVAS_WORKFLOW_GRAPH_CHANGED')
            }
            const resolved = await dependencies.mediaRuns.resolveInputs({
              ...target,
              nodeId: canvasNode.id,
              mediaModuleId: canvasNode.mediaModuleId,
              mediaKind: canvasNode.kind,
            })
            snapshot.nodes[index] = bindCanvasWorkflowMediaInputDeclarations(plannedNode, resolved)
          }
        }
        for (const rootNodeId of snapshot.rootNodeIds) {
          const rootNode = document.nodes.find((node) => node.id === rootNodeId)
          if (rootNode?.kind === 'agent' && dependencies.isAgentBusy(rootNode)) throw new Error('SESSION_BUSY')
        }
        const run = dependencies.workflowRuns.create({
          ...target,
          operationId: toolCallId,
          owner: { sessionId: context.sessionId, runStartedAt: context.runStartedAt },
          initialCanvasRevision: document.revision,
          rootNodeIds: snapshot.rootNodeIds,
          goal: input.goal,
          nodes: snapshot.nodes,
          maxMediaRuns: input.maxImageRuns,
          consumedMediaRuns: 0,
          autoResumeAfterAdoption: true,
        })
        notifyRunChanged(run)
        return projectDurableRunResult(await driveDurableRun(context, run, parentSignal))
      }
      /** 目标身份只来自父运行项目和已解析输入 Canvas。 */
      const target = { projectId: context.projectId, canvasId: input.canvasId }
      const activeKey = `${target.projectId}\0${target.canvasId}`
      if (activeRuns.has(activeKey)) throw new Error('CANVAS_WORKFLOW_ACTIVE')
      const owner = Symbol(toolCallId)
      activeRuns.set(activeKey, owner)

      /** 单一控制器同时传播父取消和十五分钟总 deadline。 */
      const controller = new AbortController()
      const onParentAbort = (): void => controller.abort('parent')
      parentSignal?.addEventListener('abort', onParentAbort, { once: true })
      if (parentSignal?.aborted) controller.abort('parent')
      let deadlineExpired = false
      const deadlineAt = now() + CANVAS_WORKFLOW_TIMEOUT_MS
      const deadline = setDeadline(() => {
        deadlineExpired = true
        controller.abort('deadline')
      }, CANVAS_WORKFLOW_TIMEOUT_MS)

      /** 以下变量只保存本次工作流的有界内存事实。 */
      let document: CanvasDocument | null = null
      let plan: CanvasWorkflowGraphPlan | null = null
      let states = new Map<string, InternalNodeState>()
      const executedNodeIds = new Set<string>()
      let imageRunsStarted = 0
      let maxObservedRevision = input.expectedRevision
      let imageSummary: CanvasWorkflowImageSummary | null = null
      let workflowErrorCode: string | null = null

      /** 终态版本必须包含已提交 Agent 输出，即使随后的 fresh-load 被取消。 */
      const resolveFinalRevision = (): number => Math.max(
        input.expectedRevision,
        document?.revision ?? input.expectedRevision,
        maxObservedRevision,
      )

      /** 统一构造取消结果，避免取消清理异常覆盖主事实。 */
      const cancelledResult = (): CanvasRunWorkflowResult => {
        for (const [nodeId, state] of states) {
          if (state.status === 'started') states.set(nodeId, { status: 'cancelled', errorCode: null })
        }
        return {
          status: 'cancelled',
          initialRevision: input.expectedRevision,
          finalRevision: resolveFinalRevision(),
          nodes: projectNodeResults(plan, states),
          imageSummary,
          requiresReview: false,
          errorCode: deadlineExpired ? 'CANVAS_WORKFLOW_TIMEOUT' : 'CANVAS_WORKFLOW_CANCELLED',
        }
      }

      try {
        try {
          await awaitReadOnlyWithinDeadline(
            () => dependencies.validateAccess(context, input.canvasId), controller.signal,
          )
          document = await awaitReadOnlyWithinDeadline(() => dependencies.load(target), controller.signal)
          await awaitReadOnlyWithinDeadline(
            () => dependencies.validateAccess(context, input.canvasId), controller.signal,
          )
        } catch (error) {
          if (controller.signal.aborted) return cancelledResult()
          throw error
        }
        if (document.revision !== input.expectedRevision) throw new Error('CANVAS_REVISION_CONFLICT')
        plan = createCanvasWorkflowGraphPlan({
          document, startNodeIds: input.startNodeIds, maxImageRuns: input.maxImageRuns,
        })
        for (const rootNodeId of plan.rootNodeIds) {
          const rootNode = document.nodes.find((node): node is Extract<CanvasNode, { kind: 'agent' }> => (
            node.id === rootNodeId && node.kind === 'agent'
          ))
          if (!rootNode || dependencies.isAgentBusy(rootNode)) throw new Error('SESSION_BUSY')
        }
        states = rebuildPlanStates(
          states, plan, executedNodeIds, imageRunsStarted, input.maxImageRuns,
          new Map(document.nodes.map((node) => [node.id, node])),
        )

        /** 每次外部执行完成后 fresh-read，并从原始根重新构建可达计划和未执行状态。 */
        const refreshPlan = async (): Promise<boolean> => {
          if (!document || !plan) return false
          let nextDocument: CanvasDocument
          try {
            await awaitReadOnlyWithinDeadline(
              () => dependencies.validateAccess(context, input.canvasId), controller.signal,
            )
            nextDocument = await awaitReadOnlyWithinDeadline(() => dependencies.load(target), controller.signal)
            await awaitReadOnlyWithinDeadline(
              () => dependencies.validateAccess(context, input.canvasId), controller.signal,
            )
          } catch (error) {
            /** 取消只终止当前 fresh-read；其它授权或读取错误仍保留原失败语义。 */
            if (controller.signal.aborted) return false
            throw error
          }
          try {
            assertExecutedGraphStable(document, nextDocument, plan.rootNodeIds, executedNodeIds)
            /** fresh planner 仍接收完整上限，实际剩余额度由状态重建按 started 数核算。 */
            const nextPlan = createCanvasWorkflowGraphPlan({
              document: nextDocument,
              startNodeIds: plan.rootNodeIds,
              maxImageRuns: input.maxImageRuns,
            })
            document = nextDocument
            plan = nextPlan
            states = rebuildPlanStates(
              states, nextPlan, executedNodeIds, imageRunsStarted, input.maxImageRuns,
              new Map(nextDocument.nodes.map((node) => [node.id, node])),
            )
            return true
          } catch {
            document = nextDocument
            workflowErrorCode = 'CANVAS_WORKFLOW_GRAPH_CHANGED'
            for (const nodeId of plan.reachableNodeIds) {
              if (states.get(nodeId)?.status === 'started') {
                states.set(nodeId, { status: 'blocked', errorCode: 'CANVAS_WORKFLOW_GRAPH_CHANGED' })
              }
            }
            return false
          }
        }

        /** 统一循环每轮只执行一种 ready 节点，外部执行后必须 fresh-read 再继续。 */
        while (!controller.signal.aborted && !workflowErrorCode && document && plan) {
          /** 当前轮次使用固定计划快照，外部执行结束前不会被替换。 */
          const currentPlan = plan
          while (propagateBlockedDependencies(currentPlan, states)) {
            // 有界 DAG 每轮至少终结一个节点，最多 32 次。
          }
          const nodesById = new Map(document.nodes.map((node) => [node.id, node]))
          const batchNodeIds = currentPlan.reachableNodeIds.filter((nodeId) => (
            states.get(nodeId)?.status === 'started'
            && nodesById.get(nodeId)?.kind === 'agent'
            && !executedNodeIds.has(nodeId)
            && isReady(nodeId, currentPlan, states)
          )).slice(0, MAX_AGENT_CONCURRENCY)
          if (batchNodeIds.length > 0) {
            const batchRevision = document.revision
            /** 启动前再次确认每个节点仍处于当前可达、ready 且类型正确的计划。 */
            const confirmedNodeIds = batchNodeIds.filter((nodeId) => (
              currentPlan.reachableNodeIds.includes(nodeId)
              && states.get(nodeId)?.status === 'started'
              && nodesById.get(nodeId)?.kind === 'agent'
              && isReady(nodeId, currentPlan, states)
            ))
            const results = await Promise.allSettled(confirmedNodeIds.map((nodeId) => {
              executedNodeIds.add(nodeId)
              return dependencies.agentExecution.execute({
                mode: 'parent-orchestrated',
                target: { ...target, nodeId },
                parentSessionId: context.sessionId,
                expectedGraphRevision: batchRevision,
                instruction: input.goal,
                userMessageUuid: toolCallId,
                startedAt: context.runStartedAt,
                signal: controller.signal,
              })
            }))
            for (let index = 0; index < confirmedNodeIds.length; index += 1) {
              const nodeId = confirmedNodeIds[index]!
              const result = results[index]!
              if (result.status === 'fulfilled' && result.value.status === 'completed') {
                states.set(nodeId, { status: 'completed', errorCode: null })
                if (result.value.output) {
                  maxObservedRevision = Math.max(maxObservedRevision, result.value.output.revision)
                }
              } else if (result.status === 'fulfilled' && result.value.status === 'cancelled') {
                states.set(nodeId, { status: 'cancelled', errorCode: null })
              } else {
                states.set(nodeId, {
                  status: 'failed',
                  errorCode: result.status === 'rejected'
                    ? stableErrorCode(result.reason, 'CANVAS_AGENT_RUN_FAILED')
                    : 'CANVAS_AGENT_RUN_FAILED',
                })
              }
            }
            if (controller.signal.aborted) break
            if (!await refreshPlan()) break
            continue
          }

          /** 图片只选择 fresh plan 当前 ready 且仍有显式剩余额度的节点。 */
          const readyImages = currentPlan.reachableNodeIds
            .filter((nodeId) => (
              states.get(nodeId)?.status === 'started'
              && nodesById.get(nodeId)?.kind === 'image'
              && !executedNodeIds.has(nodeId)
              && isReady(nodeId, currentPlan, states)
            ))
            .slice(0, Math.max(0, input.maxImageRuns - imageRunsStarted))
            .map((nodeId) => nodesById.get(nodeId)!)
          if (readyImages.length > 0) {
            for (const node of readyImages) executedNodeIds.add(node.id)
            imageRunsStarted += readyImages.length
            /** 每节点独立稳定子批；同一波并发，避免稳定身份以串行性能为代价。 */
            const outcomes = await Promise.all(readyImages.map(async (node) => {
              let runResult: Awaited<ReturnType<CanvasImageRunService['run']>>
              try {
                runResult = await dependencies.imageRuns.run(
                  context,
                  target,
                  [node],
                  createWorkflowImageOperationId(toolCallId, node.id),
                  { signal: controller.signal, deadlineAt },
                )
              } catch (error) {
                /** run 拒绝前由 Task 9 自行清理，取消时保留 started 供统一投影。 */
                return controller.signal.aborted ? null : {
                  nodeId: node.id,
                  state: {
                    status: 'failed' as const,
                    errorCode: stableErrorCode(error, 'CANVAS_IMAGE_RUN_FAILED'),
                  },
                  summary: failedWorkflowImageSummary(),
                }
              }

              const task = runResult.tasks.find((candidate) => candidate.nodeId === node.id)
              if (!runResult.batch || !task?.taskId) {
                return {
                  nodeId: node.id,
                  state: task?.status === 'failed'
                    ? { status: 'failed' as const, errorCode: 'CANVAS_IMAGE_RUN_FAILED' }
                    : { status: 'blocked' as const, errorCode: 'CANVAS_IMAGE_BATCH_MISSING' },
                  summary: failedWorkflowImageSummary(),
                }
              }

              let terminal: CanvasRunNodesBatchTerminalSummary
              try {
                /** owned 子批必须无条件交给 awaitBatch，即使父 signal 已在 run 返回后取消。 */
                terminal = await dependencies.imageRuns.awaitBatch({
                  ...target,
                  batchId: runResult.batch.batchId,
                  taskIds: [task.taskId],
                  signal: controller.signal,
                  deadlineAt,
                })
              } catch (error) {
                return controller.signal.aborted ? null : {
                  nodeId: node.id,
                  state: { status: 'failed' as const, errorCode: stableErrorCode(error, 'CANVAS_IMAGE_RUN_FAILED') },
                  summary: failedWorkflowImageSummary(),
                }
              }

              const entry = terminal.entries.find((candidate) => candidate.nodeId === node.id)
              let state: InternalNodeState
              if (!entry || entry.taskId !== task.taskId) {
                state = { status: 'failed', errorCode: 'CANVAS_IMAGE_RESULT_INVALID' }
              } else if (entry.status === 'candidate') {
                state = { status: 'waiting-review', errorCode: null }
              } else if (entry.status === 'failed') {
                state = { status: 'failed', errorCode: 'CANVAS_IMAGE_RUN_FAILED' }
              } else {
                state = { status: 'failed', errorCode: 'CANVAS_IMAGE_RESULT_INVALID' }
              }
              return { nodeId: node.id, state, summary: toWorkflowImageSummary(terminal) }
            }))
            for (const outcome of outcomes) {
              if (!outcome) continue
              states.set(outcome.nodeId, outcome.state)
              imageSummary = mergeWorkflowImageSummary(imageSummary, outcome.summary)
            }
            if (controller.signal.aborted) break
            /** refresh 不属于图片调用异常域，授权或读取错误必须保持顶层语义。 */
            if (!await refreshPlan()) break
            continue
          }

          /** 无 ready Agent 或图片时，本轮有界工作流达到稳定终态。 */
          break
        }

        if (controller.signal.aborted) return cancelledResult()
        if (plan) {
          while (propagateBlockedDependencies(plan, states)) {
            // 图片逐节点终态只阻断自身后继，不影响独立分支。
          }
        }
        const nodes = projectNodeResults(plan, states)
        const finalRevision = resolveFinalRevision()
        if (workflowErrorCode) {
          return {
            status: 'partial', initialRevision: input.expectedRevision, finalRevision, nodes, imageSummary,
            requiresReview: nodes.some((node) => node.status === 'waiting-review'),
            errorCode: workflowErrorCode,
          }
        }
        const requiresReview = nodes.some((node) => node.status === 'waiting-review')
        const hasPartial = nodes.some((node) => node.status === 'failed'
          || node.status === 'waiting-approval'
          || (node.status === 'blocked' && node.errorCode !== 'WAITING_FOR_IMAGE_ADOPTION'))
        if (hasPartial) {
          return {
            status: 'partial', initialRevision: input.expectedRevision, finalRevision, nodes, imageSummary,
            requiresReview, errorCode: null,
          }
        }
        if (requiresReview) {
          return {
            status: 'waiting-review', initialRevision: input.expectedRevision, finalRevision, nodes, imageSummary,
            requiresReview: true, errorCode: null,
          }
        }
        return {
          status: 'completed', initialRevision: input.expectedRevision, finalRevision, nodes, imageSummary,
          requiresReview: false, errorCode: null,
        }
      } finally {
        deadline.cancel()
        parentSignal?.removeEventListener('abort', onParentAbort)
        if (activeRuns.get(activeKey) === owner) activeRuns.delete(activeKey)
      }
    },
    resume: async (context, input, signal) => {
      if (!dependencies.workflowRuns) throw new Error('CANVAS_WORKFLOW_RUN_STORE_UNAVAILABLE')
      if (input.projectId !== context.projectId) throw new Error('CANVAS_WORKFLOW_RUN_TARGET_INVALID')
      await dependencies.validateAccess(context, input.canvasId)
      const hasAmendment = input.expectedRunRevision !== undefined
        || input.resumeOperationId !== undefined
        || input.addDurationMs !== undefined
        || input.addMediaRuns !== undefined
        || input.retryNodeIds !== undefined
      if ((input.expectedRunRevision === undefined) !== (input.resumeOperationId === undefined)) {
        throw new Error('CANVAS_WORKFLOW_RESUME_AMENDMENT_INVALID')
      }
      let run = dependencies.workflowRuns.get(input, input.runId)
      if (run.owner.sessionId !== context.sessionId) {
        throw new Error('CANVAS_WORKFLOW_RUN_OWNER_INVALID')
      }
      if (hasAmendment) {
        if (signal?.aborted) throw new Error('CANVAS_WORKFLOW_ABORTED')
        if (input.expectedRunRevision === undefined || input.resumeOperationId === undefined) {
          throw new Error('CANVAS_WORKFLOW_RESUME_AMENDMENT_INVALID')
        }
        run = publishSavedRun(dependencies.workflowRuns.amendForResume({
          projectId: input.projectId,
          canvasId: input.canvasId,
          runId: input.runId,
          expectedRevision: input.expectedRunRevision,
          operationId: input.resumeOperationId,
          addDurationMs: input.addDurationMs ?? 0,
          addMediaRuns: input.addMediaRuns ?? 0,
          retryNodeIds: input.retryNodeIds ?? [],
        }))
      }
      if (!signal?.aborted && run.status !== 'completed' && run.status !== 'cancelled'
        && run.cancelRequestedAt === null) {
        /** 未取得提交回执时只重放原 operation；已有远端 ID 则只恢复原任务。 */
        let shouldRecoverUnknownSubmission = false
        for (const node of run.nodes) {
          if (node.status !== 'failed' || node.retryDisposition !== 'submission-unknown') continue
          if (node.execution?.kind === 'image') {
            node.status = node.execution.batchId && node.execution.taskId ? 'running' : 'ready'
          } else if (node.execution?.kind === 'media') {
            node.status = node.execution.mediaRunId ? 'running' : 'ready'
          } else {
            continue
          }
          node.errorCode = null
          shouldRecoverUnknownSubmission = true
        }
        if (shouldRecoverUnknownSubmission) {
          run.status = 'running'
          run = publishSavedRun(dependencies.workflowRuns.saveExecutionProgress(run, run.revision))
        }
      }
      return projectDurableRunResult(await driveDurableRun(context, run, signal))
    },
    cancel: async (context, input) => {
      if (!dependencies.workflowRuns) throw new Error('CANVAS_WORKFLOW_RUN_STORE_UNAVAILABLE')
      if (input.projectId !== context.projectId) throw new Error('CANVAS_WORKFLOW_RUN_TARGET_INVALID')
      await dependencies.validateAccess(context, input.canvasId)
      let run = dependencies.workflowRuns.get(input, input.runId)
      if (run.owner.sessionId !== context.sessionId) throw new Error('CANVAS_WORKFLOW_RUN_OWNER_INVALID')
      if (run.status === 'cancelled' || run.status === 'completed') return run
      const timestamp = now()
      run = requestDurableCancellation(input, input.runId, timestamp)
      if (run.status === 'cancelled' || run.status === 'completed') return run
      durableControllers.get(`${input.projectId}\0${input.canvasId}`)?.abort('cancel')
      /** 各外部清理互相隔离；取消事实不能被单个适配器异常反转。 */
      const cleanupTasks: Promise<unknown>[] = []
      for (const node of run.nodes) {
        if (node.status === 'running' && node.execution?.kind === 'image'
          && node.execution.batchId && node.execution.taskId) {
          const batchId = node.execution.batchId
          const taskId = node.execution.taskId
          cleanupTasks.push(Promise.resolve().then(() => dependencies.imageRuns.cancelTasks({
            projectId: input.projectId, canvasId: input.canvasId, batchId, taskIds: [taskId],
          })))
        }
      }
      const mediaRuns = dependencies.mediaRuns
      if (mediaRuns) {
        cleanupTasks.push((async () => {
          let document: CanvasDocument
          try {
            document = await dependencies.load(input)
          } catch {
            /** 文档读取失败时仍继续图片清理与 journal 终态收敛。 */
            return
          }
          /** 同一工作流内的远端媒体取消也逐项隔离。 */
          const mediaCleanupTasks: Promise<unknown>[] = []
          for (const node of run.nodes) {
            if (node.status !== 'running' || node.execution?.kind !== 'media'
              || !node.execution.mediaRunId || (node.kind !== 'audio' && node.kind !== 'video')) continue
            const canvasNode = document.nodes.find((candidate) => candidate.id === node.nodeId)
            if (!canvasNode || (canvasNode.kind !== 'audio' && canvasNode.kind !== 'video')) continue
            const mediaRunId = node.execution.mediaRunId
            mediaCleanupTasks.push(Promise.resolve().then(() => mediaRuns.cancel({
              projectId: input.projectId, canvasId: input.canvasId, nodeId: node.nodeId,
              mediaModuleId: canvasNode.mediaModuleId, mediaKind: canvasNode.kind, mediaRunId,
            })))
          }
          await Promise.allSettled(mediaCleanupTasks)
        })())
      }
      await Promise.allSettled(cleanupTasks)
      return finalizeDurableCancellation(input, input.runId, timestamp, false)
    },
    registerCreatedSuccessor: async (context, input) => {
      if (!dependencies.workflowRuns) throw new Error('CANVAS_WORKFLOW_RUN_STORE_UNAVAILABLE')
      const parentWorkflow = context.parentWorkflow
      const branchTarget = context.canvasAgentTarget
      if (context.canvasAgentMode !== 'parent-orchestrated' || !parentWorkflow || !branchTarget
        || input.projectId !== context.projectId
        || branchTarget.projectId !== input.projectId || branchTarget.canvasId !== input.canvasId
        || !/^[A-Za-z0-9_-]{1,160}$/.test(input.nodeId)
        || !/^[A-Za-z0-9_-]{1,160}$/.test(input.sourceToolCallId)) {
        throw new Error('CANVAS_WORKFLOW_DYNAMIC_SUCCESSOR_CONTEXT_INVALID')
      }
      await dependencies.validateAccess(context, input.canvasId)
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const current = dependencies.workflowRuns.get(input, parentWorkflow.runId)
        if (current.owner.sessionId !== parentWorkflow.parentSessionId
          || current.owner.runStartedAt !== context.runStartedAt) {
          throw new Error('CANVAS_WORKFLOW_RUN_OWNER_INVALID')
        }
        if (current.cancelRequestedAt !== null || current.status !== 'running') {
          return {
            status: 'blocked', workflowRunId: current.id,
            workflowRunRevision: current.revision,
            reasonCode: 'CANVAS_WORKFLOW_DYNAMIC_SUCCESSOR_RUN_CLOSED',
          }
        }
        const document = await dependencies.load(input)
        await dependencies.validateAccess(context, input.canvasId)
        const branchCanvasNode = document.nodes.find((node) => node.id === branchTarget.nodeId)
        const branchRunNode = current.nodes.find((node) => node.nodeId === branchTarget.nodeId)
        if (branchCanvasNode?.kind !== 'agent' || branchCanvasNode.agentSessionId !== context.sessionId
          || branchRunNode?.kind !== 'agent' || branchRunNode.status !== 'running'
          || branchRunNode.execution?.kind !== 'agent') {
          throw new Error('CANVAS_WORKFLOW_DYNAMIC_SUCCESSOR_BRANCH_INACTIVE')
        }
        const existing = current.nodes.find((node) => node.nodeId === input.nodeId)
        if (existing) {
          const createdNode = document.nodes.find((node) => node.id === input.nodeId)
          if (!createdNode || createdNode.kind !== existing.kind
            || createCanvasWorkflowNodeIdentityHash(createdNode) !== existing.identityHash) {
            throw new Error('CANVAS_WORKFLOW_GRAPH_CHANGED')
          }
          return existing.status === 'blocked'
            ? { status: 'blocked', workflowRunId: current.id, workflowRunRevision: current.revision,
                reasonCode: existing.errorCode ?? 'CANVAS_WORKFLOW_DYNAMIC_SUCCESSOR_REGISTRATION_FAILED' }
            : { status: 'already-registered', workflowRunId: current.id,
                workflowRunRevision: current.revision, reasonCode: null }
        }
        let amended: CanvasWorkflowRun
        try {
          amended = createCanvasWorkflowDynamicSuccessorAmendment(
            current, document, branchTarget.nodeId, input.nodeId,
          )
        } catch (error) {
          return persistCreatedSuccessorFailure(context, input,
            stableErrorCode(error, 'CANVAS_WORKFLOW_DYNAMIC_SUCCESSOR_INVALID'))
        }
        try {
          const saved = publishSavedRun(dependencies.workflowRuns.saveDynamicSuccessorAmendment(amended, current.revision))
          return {
            status: 'registered', workflowRunId: saved.id,
            workflowRunRevision: saved.revision, reasonCode: null,
          }
        } catch (error) {
          if (!isWorkflowRunConflict(error) || attempt === 3) throw error
        }
      }
      throw new Error('CANVAS_WORKFLOW_RUN_CONFLICT')
    },
    recordCreatedSuccessorRegistrationFailure: async (context, input) => (
      persistCreatedSuccessorFailure(
        context,
        input,
        'CANVAS_WORKFLOW_DYNAMIC_SUCCESSOR_REGISTRATION_FAILED',
      )
    ),
    get: async (context, input) => {
      if (!dependencies.workflowRuns) throw new Error('CANVAS_WORKFLOW_RUN_STORE_UNAVAILABLE')
      if (input.projectId !== context.projectId) throw new Error('CANVAS_WORKFLOW_RUN_TARGET_INVALID')
      await dependencies.validateAccess(context, input.canvasId)
      return dependencies.workflowRuns.get(input, input.runId)
    },
    list: async (context, canvasId) => {
      if (!dependencies.workflowRuns) throw new Error('CANVAS_WORKFLOW_RUN_STORE_UNAVAILABLE')
      await dependencies.validateAccess(context, canvasId)
      return dependencies.workflowRuns.list({ projectId: context.projectId, canvasId })
    },
    listPage: async (context, canvasId, options) => {
      if (!dependencies.workflowRuns) throw new Error('CANVAS_WORKFLOW_RUN_STORE_UNAVAILABLE')
      await dependencies.validateAccess(context, canvasId)
      return dependencies.workflowRuns.listPage(
        { projectId: context.projectId, canvasId },
        { ...options, ownerSessionId: context.sessionId },
      )
    },
  }
}
