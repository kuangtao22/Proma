import { createHash } from 'node:crypto'
import type {
  CanvasDocument,
  CanvasNode,
  CanvasRunNodesBatchTerminalSummary,
  CanvasRunWorkflowInput,
  CanvasRunWorkflowResult,
  CanvasTarget,
  CanvasWorkflowImageSummary,
  CanvasWorkflowNodeResult,
  CanvasWorkflowNodeStatus,
  CanvasWorkflowRun,
  CanvasWorkflowRunChangedEvent,
  CanvasWorkflowRunListInput,
  CanvasWorkflowRunNode,
  CanvasWorkflowRunPage,
} from '@proma/shared'
import { resolveCanvasEdgeBinding } from '@proma/shared'
import type {
  CanvasAgentExecutionResult,
  CanvasAgentExecutionService,
} from './canvas-agent-execution-service'
import type { CanvasImageRunService } from './canvas-image-run-service'
import type { CanvasToolRunContext } from './canvas-tool-provider'
import type { CanvasWorkflowRunStore } from './canvas-workflow-run-store'
import {
  createCanvasWorkflowGraphPlan,
  type CanvasWorkflowGraphPlan,
} from './canvas-workflow-graph'

/** 单次工作流中的 Canvas Agent 并发上限。 */
const MAX_AGENT_CONCURRENCY = 2
/** Canvas 工作流与单 Agent 长工具共用的总时限。 */
export const CANVAS_WORKFLOW_TIMEOUT_MS = 15 * 60_000

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
  /** 进程重启后按稳定 operation 对账原 Agent 子运行。 */
  recoverAgentExecution?: (input: CanvasTarget & {
    nodeId: string
    agentSessionId: string
    operationId: string
    expectedUserMessageUuid: string
    expectedStartedAt: number
  }) => Promise<
    | { status: 'running' | 'missing' | 'changed' }
    | { status: 'completed'; output: NonNullable<CanvasAgentExecutionResult['output']> }
  >
  imageRuns: Pick<CanvasImageRunService, 'run' | 'awaitBatch'> & Partial<Pick<CanvasImageRunService, 'cancelTasks'>>
  /** 注入后启用跨重启运行；缺省只用于兼容尚未完成接线的调用方。 */
  workflowRuns?: CanvasWorkflowRunStore
  /** 持久运行关键事实写入成功后的轻量通知。 */
  onRunChanged?: (event: CanvasWorkflowRunChangedEvent) => void
  /** 查询精确候选是否已由用户采用，恢复不会把采用当作自动启动信号。 */
  isImageCandidateAdopted?: (input: CanvasTarget & {
    nodeId: string
    batchId: string
    taskId: string
  }) => Promise<{ adopted: boolean; artifactHash: string | null; committedAt: number | null }>
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
    input: CanvasTarget & { runId: string },
    signal?: AbortSignal,
  ) => Promise<CanvasRunWorkflowResult>
  cancel: (
    context: CanvasToolRunContext,
    input: CanvasTarget & { runId: string },
  ) => Promise<CanvasWorkflowRun>
  get: (
    context: CanvasToolRunContext,
    input: CanvasTarget & { runId: string },
  ) => Promise<CanvasWorkflowRun>
  list: (
    context: CanvasToolRunContext,
    canvasId: string,
    options?: Pick<CanvasWorkflowRunListInput, 'cursor' | 'limit'>,
  ) => Promise<CanvasWorkflowRunPage>
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
    case 'document': return `${node.kind}\0${node.documentId}`
    case 'webview': return `${node.kind}\0${node.prototypeId}`
  }
}

/** 对稳定业务事实生成 SHA-256 指纹，布局与标题不参与恢复有效性。 */
function stableHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

/** 返回节点当前正式产物指纹；未提交节点返回 null。 */
function nodeArtifactHash(node: CanvasNode): string | null {
  switch (node.kind) {
    case 'agent': return node.outputPointer?.contentSha256 ?? null
    case 'image': return node.adoptedAssetId ? stableHash(['image-asset', node.adoptedAssetId]) : null
    case 'document': return stableHash(['document', node.documentId, node.contentRevision])
    case 'webview': return stableHash(['webview', node.prototypeId, node.contentRevision, node.devicePreset])
  }
}

/** 返回单条合法 bound 边不会随 revision 改变的执行身份。 */
function edgeIdentity(edge: CanvasDocument['edges'][number]): string {
  return [edge.id, edge.sourceNodeId, edge.sourcePort, edge.targetNodeId, edge.targetPort, edge.relation].join('\0')
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

/** 把图规划快照转换成可跨重启验证的持久节点。 */
function createPersistentNodes(
  document: CanvasDocument,
  plan: CanvasWorkflowGraphPlan,
): CanvasWorkflowRunNode[] {
  const nodesById = new Map(document.nodes.map((node) => [node.id, node]))
  return plan.reachableNodeIds.map((nodeId) => {
    const node = nodesById.get(nodeId)
    if (!node) throw new Error('CANVAS_WORKFLOW_GRAPH_CHANGED')
    const initial = plan.initialStates.get(nodeId) ?? 'blocked'
    const artifactHash = nodeArtifactHash(node)
    const inputBindings = document.edges.flatMap((edge) => {
      if (edge.targetNodeId !== nodeId || edge.relation === 'association') return []
      const source = nodesById.get(edge.sourceNodeId)
      if (!source) return []
      const resolution = resolveCanvasEdgeBinding(edge, source.kind, node.kind)
      if (resolution.state !== 'bound') return []
      const externalArtifactHash = plan.reachableNodeIds.includes(source.id)
        ? null : nodeArtifactHash(source)
      return [{
        targetInputKey: `${resolution.targetSlot}:${edge.id}`,
        requiredKind: resolution.targetSlot === 'context.image' || resolution.targetSlot === 'image.reference'
          ? 'image' as const : 'text' as const,
        sourceNodeId: source.id,
        sourceOutputKey: resolution.sourceCapability,
        sourceArtifactHash: externalArtifactHash,
        resolvedValueHash: externalArtifactHash,
      }]
    }).sort((left, right) => left.targetInputKey.localeCompare(right.targetInputKey)
      || (left.sourceNodeId ?? '').localeCompare(right.sourceNodeId ?? ''))
    return {
      nodeId,
      kind: node.kind,
      identityHash: stableHash(nodeIdentity(node)),
      plannedArtifactHash: artifactHash,
      mediaConfigRevision: null,
      inputBindings,
      dependencyNodeIds: [...(plan.dependenciesByNodeId.get(nodeId) ?? [])],
      status: initial === 'satisfied' ? 'satisfied'
        : initial === 'started' ? 'ready'
          : initial === 'waiting-approval' ? 'waiting-approval'
            : 'blocked',
      errorCode: initial === 'blocked' ? 'CANVAS_WORKFLOW_NODE_UNSUPPORTED' : null,
      execution: null,
      completedArtifactHash: null,
      completedAt: null,
    }
  })
}

/** 将持久节点状态映射到既有公开工具结果。 */
function projectPersistentNode(node: CanvasWorkflowRunNode): CanvasWorkflowNodeResult {
  if (node.status === 'blocked' || node.status === 'failed') {
    return { nodeId: node.nodeId, status: node.status, errorCode: node.errorCode ?? 'CANVAS_WORKFLOW_INCOMPLETE' }
  }
  if (node.status === 'ready' || node.status === 'running') {
    return node.status === 'running'
      ? { nodeId: node.nodeId, status: 'blocked', errorCode: 'CANVAS_WORKFLOW_ALREADY_RUNNING' }
      : { nodeId: node.nodeId, status: 'started', errorCode: null }
  }
  if (node.status === 'waiting-adoption') {
    return { nodeId: node.nodeId, status: 'waiting-review', errorCode: null }
  }
  return { nodeId: node.nodeId, status: node.status, errorCode: null }
}

/** 从唯一持久事实生成既有有界工作流结果。 */
function projectPersistentResult(run: CanvasWorkflowRun): CanvasRunWorkflowResult {
  const nodes = run.nodes.map(projectPersistentNode)
  const waitingImages = run.nodes.filter((node) => node.kind === 'image' && node.status === 'waiting-adoption')
  const failedImages = run.nodes.filter((node) => node.kind === 'image' && node.status === 'failed')
  const imageCount = run.nodes.filter((node) => node.kind === 'image' && node.execution !== null).length
  const imageSummary: CanvasWorkflowImageSummary | null = imageCount === 0 ? null : {
    status: failedImages.length > 0 ? 'partial' : waitingImages.length > 0 ? 'ready' : 'adopted',
    totalCount: imageCount,
    candidateCount: waitingImages.length + run.nodes.filter((node) => (
      node.kind === 'image' && node.status === 'completed'
    )).length,
    failedCount: failedImages.length,
    runningCount: run.nodes.filter((node) => node.kind === 'image' && node.status === 'running').length,
  }
  const base = {
    runId: run.id,
    initialRevision: run.initialCanvasRevision,
    finalRevision: run.observedCanvasRevision,
    nodes,
    imageSummary,
  }
  if (run.status === 'completed') return { ...base, status: 'completed', requiresReview: false, errorCode: null }
  if (run.status === 'waiting-review') return { ...base, status: 'waiting-review', requiresReview: true, errorCode: null }
  if (run.status === 'cancelled') {
    return { ...base, status: 'cancelled', requiresReview: false, errorCode: 'CANVAS_WORKFLOW_CANCELLED' }
  }
  if (run.status === 'failed') {
    return { ...base, status: 'failed', requiresReview: false, errorCode: 'CANVAS_WORKFLOW_FAILED' }
  }
  return {
    ...base,
    status: 'partial',
    requiresReview: waitingImages.length > 0,
    errorCode: run.nodes.some((node) => node.status === 'running') ? 'CANVAS_WORKFLOW_ALREADY_RUNNING' : null,
  }
}

/** 判断持久节点的全部直接依赖是否已有正式产物。 */
function isPersistentNodeReady(node: CanvasWorkflowRunNode, run: CanvasWorkflowRun): boolean {
  return node.dependencyNodeIds.every((dependencyId) => {
    const dependency = run.nodes.find((candidate) => candidate.nodeId === dependencyId)
    return dependency?.status === 'satisfied' || dependency?.status === 'completed'
  })
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

  /** 旧调用方未接入 Store 时继续使用原有进程内执行语义。 */
  const executeVolatile = async (
    context: CanvasToolRunContext,
    input: CanvasRunWorkflowInput,
    toolCallId: string,
    parentSignal?: AbortSignal,
  ): Promise<CanvasRunWorkflowResult> => {
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
  }

  const workflowRuns = dependencies.workflowRuns
  /** 当前服务实例的持久执行控制器用于 owner cancel 精确终止等待。 */
  const durableControllers = new Map<string, AbortController>()

  /** 保存持久运行并接管 Store 分配的新 revision。 */
  const persistRun = (run: CanvasWorkflowRun): CanvasWorkflowRun => {
    if (!workflowRuns) throw new Error('CANVAS_WORKFLOW_RUN_STORE_UNAVAILABLE')
    const saved = workflowRuns.save(run, run.revision)
    dependencies.onRunChanged?.({
      projectId: saved.projectId, canvasId: saved.canvasId,
      runId: saved.id, revision: saved.revision,
    })
    return saved
  }

  /** 校验调用者仍来自创建该工作流的普通 Agent 会话。 */
  const assertSessionOwner = (context: CanvasToolRunContext, run: CanvasWorkflowRun): void => {
    if (run.projectId !== context.projectId
      || run.owner.sessionId !== context.sessionId) {
      throw new Error('CANVAS_WORKFLOW_RUN_OWNER_INVALID')
    }
  }

  /** execute 的幂等重放必须仍属于首次父运行，防止复用旧 operation。 */
  const assertOriginalOwner = (context: CanvasToolRunContext, run: CanvasWorkflowRun): void => {
    assertSessionOwner(context, run)
    if (run.owner.runStartedAt !== context.runStartedAt) {
      throw new Error('CANVAS_WORKFLOW_RUN_OWNER_INVALID')
    }
  }

  /** 验证固定计划仍指向相同业务节点，布局和标题变化不参与失效。 */
  const assertPersistentGraphValid = (run: CanvasWorkflowRun, document: CanvasDocument): void => {
    const nodesById = new Map(document.nodes.map((node) => [node.id, node]))
    for (const runNode of run.nodes) {
      const node = nodesById.get(runNode.nodeId)
      if (!node || node.kind !== runNode.kind || stableHash(nodeIdentity(node)) !== runNode.identityHash) {
        throw new Error('CANVAS_WORKFLOW_GRAPH_CHANGED')
      }
      if (runNode.status === 'satisfied' && nodeArtifactHash(node) !== runNode.plannedArtifactHash) {
        throw new Error('CANVAS_WORKFLOW_INPUT_CHANGED')
      }
      if (runNode.status === 'completed' && runNode.kind === 'agent'
        && nodeArtifactHash(node) !== runNode.completedArtifactHash) {
        throw new Error('CANVAS_WORKFLOW_OUTPUT_CHANGED')
      }
      const currentBindings = document.edges.flatMap((edge) => {
        if (edge.targetNodeId !== runNode.nodeId || edge.relation === 'association') return []
        const source = nodesById.get(edge.sourceNodeId)
        if (!source) throw new Error('CANVAS_WORKFLOW_GRAPH_CHANGED')
        const resolution = resolveCanvasEdgeBinding(edge, source.kind, node.kind)
        if (resolution.state !== 'bound') throw new Error('CANVAS_WORKFLOW_GRAPH_CHANGED')
        return [{
          targetInputKey: `${resolution.targetSlot}:${edge.id}`,
          sourceNodeId: source.id,
          sourceOutputKey: resolution.sourceCapability,
        }]
      }).sort((left, right) => left.targetInputKey.localeCompare(right.targetInputKey))
      const plannedBindings = runNode.inputBindings.map((binding) => ({
        targetInputKey: binding.targetInputKey,
        sourceNodeId: binding.sourceNodeId,
        sourceOutputKey: binding.sourceOutputKey,
      })).sort((left, right) => left.targetInputKey.localeCompare(right.targetInputKey))
      if (JSON.stringify(currentBindings) !== JSON.stringify(plannedBindings)) {
        throw new Error('CANVAS_WORKFLOW_GRAPH_CHANGED')
      }
    }
  }

  /** 在副作用前固化直接上游正式产物哈希，恢复时拒绝输入漂移。 */
  const freezePersistentInputs = (
    node: CanvasWorkflowRunNode,
    run: CanvasWorkflowRun,
    document: CanvasDocument,
  ): void => {
    const documentNodes = new Map(document.nodes.map((candidate) => [candidate.id, candidate]))
    for (const binding of node.inputBindings) {
      if (!binding.sourceNodeId) continue
      const sourceRunNode = run.nodes.find((candidate) => candidate.nodeId === binding.sourceNodeId)
      const sourceDocumentNode = documentNodes.get(binding.sourceNodeId)
      const artifactHash = sourceRunNode?.completedArtifactHash
        ?? sourceRunNode?.plannedArtifactHash
        ?? (sourceDocumentNode ? nodeArtifactHash(sourceDocumentNode) : null)
      if (!artifactHash) throw new Error('CANVAS_WORKFLOW_INPUT_UNAVAILABLE')
      if ((binding.sourceArtifactHash !== null && binding.sourceArtifactHash !== artifactHash)
        || (binding.resolvedValueHash !== null && binding.resolvedValueHash !== artifactHash)) {
        throw new Error('CANVAS_WORKFLOW_INPUT_CHANGED')
      }
      binding.sourceArtifactHash = artifactHash
      binding.resolvedValueHash = artifactHash
    }
  }

  /** 根据节点终态收敛运行状态，等待采用保持人工边界。 */
  const reconcileRunStatus = (run: CanvasWorkflowRun): void => {
    if (run.status === 'cancelled') return
    if (run.nodes.some((node) => node.status === 'waiting-adoption')) {
      run.status = 'waiting-review'
      return
    }
    if (run.nodes.every((node) => node.status === 'satisfied' || node.status === 'completed')) {
      run.status = 'completed'
      return
    }
    if (run.nodes.some((node) => (
      node.status === 'failed' || node.status === 'blocked'
      || node.status === 'waiting-approval' || node.status === 'cancelled'
    ))) {
      run.status = 'partial'
      return
    }
    run.status = 'running'
  }

  /** 固化恢复期间发现的 Agent 输出漂移，让 UI 可明确提示重新规划。 */
  const failRecoveredAgentOutputChanged = (
    run: CanvasWorkflowRun,
    node: CanvasWorkflowRunNode,
  ): never => {
    node.status = 'failed'
    node.errorCode = 'CANVAS_WORKFLOW_OUTPUT_CHANGED'
    node.completedArtifactHash = null
    node.completedAt = null
    reconcileRunStatus(run)
    persistRun(run)
    throw new Error('CANVAS_WORKFLOW_OUTPUT_CHANGED')
  }

  /** 在跨进程租约内恢复原子任务并推进到下一个人工边界。 */
  const drivePersistentRun = async (
    context: CanvasToolRunContext,
    initialRun: CanvasWorkflowRun,
    parentSignal?: AbortSignal,
  ): Promise<CanvasWorkflowRun> => {
    if (!workflowRuns) throw new Error('CANVAS_WORKFLOW_RUN_STORE_UNAVAILABLE')
    assertSessionOwner(context, initialRun)
    const target = { projectId: initialRun.projectId, canvasId: initialRun.canvasId }
    const releaseLease = workflowRuns.acquireLease(target, initialRun.id)
    if (!releaseLease) return workflowRuns.get(target, initialRun.id)
    const controller = new AbortController()
    const onParentAbort = (): void => controller.abort('parent')
    parentSignal?.addEventListener('abort', onParentAbort, { once: true })
    if (parentSignal?.aborted) controller.abort('parent')
    durableControllers.set(initialRun.id, controller)
    let run = workflowRuns.get(target, initialRun.id)
    let deadlineExpired = false
    const deadlineMs = Math.max(1, run.budget.remainingDurationMs)
    const deadlineAt = now() + deadlineMs
    const deadline = setDeadline(() => {
      deadlineExpired = true
      controller.abort('deadline')
    }, deadlineMs)

    /** 异步结果提交前重新读取取消事实，迟到结果只能保留外部产物。 */
    const reloadBeforeCommit = (): boolean => {
      const fresh = workflowRuns.get(target, run.id)
      if (fresh.status === 'cancelled') {
        run = fresh
        return false
      }
      if (fresh.revision !== run.revision) {
        run = fresh
        return false
      }
      return true
    }

    try {
      if (run.status === 'cancelled' || run.status === 'completed') return run
      if (run.budget.activeStartedAt === null) {
        run.budget.activeStartedAt = now()
        run = persistRun(run)
      }
      await dependencies.validateAccess(context, run.canvasId)
      let document = await dependencies.load(target)
      await dependencies.validateAccess(context, run.canvasId)
      assertPersistentGraphValid(run, document)
      run.observedCanvasRevision = Math.max(run.observedCanvasRevision, document.revision)

      /** 先对账已完成候选；采用只改变状态，不自动触发本函数。 */
      if (dependencies.isImageCandidateAdopted) {
        for (const node of run.nodes) {
          if (node.status !== 'waiting-adoption' || node.execution?.kind !== 'image'
            || !node.execution.batchId || !node.execution.taskId) continue
          const adoption = await dependencies.isImageCandidateAdopted({
            ...target,
            nodeId: node.nodeId,
            batchId: node.execution.batchId,
            taskId: node.execution.taskId,
          })
          if (!adoption.adopted) continue
          if (!adoption.artifactHash || !adoption.committedAt) {
            node.status = 'failed'
            node.errorCode = 'CANVAS_IMAGE_ADOPTION_INVALID'
          } else {
            node.status = 'completed'
            node.errorCode = null
            node.completedArtifactHash = adoption.artifactHash
            node.completedAt = adoption.committedAt
          }
          run = persistRun(run)
        }
      }

      /** 进程崩溃后先按稳定身份对账原 Agent，提交未知时绝不重放。 */
      let agentStillRunning = false
      for (const node of run.nodes) {
        if (node.status !== 'running' || node.execution?.kind !== 'agent') continue
        const canvasNode = document.nodes.find((candidate): candidate is Extract<CanvasNode, { kind: 'agent' }> => (
          candidate.id === node.nodeId && candidate.kind === 'agent'
        ))
        if (!canvasNode || !dependencies.recoverAgentExecution) {
          node.status = 'failed'
          node.errorCode = 'CANVAS_AGENT_RUN_OUTCOME_UNKNOWN'
          continue
        }
        const recovered = await dependencies.recoverAgentExecution({
          ...target,
          nodeId: node.nodeId,
          agentSessionId: canvasNode.agentSessionId,
          operationId: node.execution.operationId,
          expectedUserMessageUuid: run.operationId,
          expectedStartedAt: run.owner.runStartedAt,
        })
        if (recovered.status === 'running') {
          agentStillRunning = true
        } else if (recovered.status === 'changed') {
          failRecoveredAgentOutputChanged(run, node)
        } else if (recovered.status === 'completed'
          && recovered.output.target.projectId === target.projectId
          && recovered.output.target.canvasId === target.canvasId
          && recovered.output.target.nodeId === node.nodeId
          && recovered.output.pointer.completedAt >= run.owner.runStartedAt) {
          node.status = 'completed'
          node.errorCode = null
          node.completedArtifactHash = recovered.output.pointer.contentSha256
          node.completedAt = recovered.output.pointer.completedAt
          run.observedCanvasRevision = Math.max(run.observedCanvasRevision, recovered.output.revision)
          /** 恢复等待期间正式输出可能被其它运行替换，推进任何下游前复查当前图。 */
          document = await dependencies.load(target)
          await dependencies.validateAccess(context, run.canvasId)
          /** 当前节点仍存在但正式指纹变化时先固化可重规划终态，再向调用方返回冲突。 */
          const refreshedNode = document.nodes.find((candidate): candidate is Extract<CanvasNode, { kind: 'agent' }> => (
            candidate.id === node.nodeId && candidate.kind === 'agent'
            && candidate.agentSessionId === canvasNode.agentSessionId
          ))
          if (refreshedNode
            && nodeArtifactHash(refreshedNode) !== recovered.output.pointer.contentSha256) {
            failRecoveredAgentOutputChanged(run, node)
          }
          assertPersistentGraphValid(run, document)
        } else {
          node.status = 'failed'
          node.errorCode = 'CANVAS_AGENT_RUN_OUTCOME_UNKNOWN'
        }
      }
      if (agentStillRunning || run.nodes.some((node) => node.errorCode === 'CANVAS_AGENT_RUN_OUTCOME_UNKNOWN')) {
        reconcileRunStatus(run)
        return persistRun(run)
      }

      while (!controller.signal.aborted) {
        /** 已有精确图片批次时只等待原任务，不创建新消费。 */
        const runningImage = run.nodes.find((node) => (
          node.status === 'running' && node.execution?.kind === 'image'
        ))
        if (runningImage?.execution?.kind === 'image') {
          const operationId = runningImage.execution.operationId
          let batchId = runningImage.execution.batchId
          let taskId = runningImage.execution.taskId
          const canvasNode = document.nodes.find((node): node is Extract<CanvasNode, { kind: 'image' }> => (
            node.id === runningImage.nodeId && node.kind === 'image'
          ))
          if (!canvasNode) throw new Error('CANVAS_WORKFLOW_GRAPH_CHANGED')
          if (!batchId || !taskId) {
            const started = await dependencies.imageRuns.run(
              context, target, [canvasNode], operationId, { signal: controller.signal, deadlineAt },
            )
            const task = started.tasks.find((candidate) => candidate.nodeId === runningImage.nodeId)
            if (!started.batch || !task?.taskId) throw new Error('CANVAS_IMAGE_BATCH_MISSING')
            if (!reloadBeforeCommit()) break
            batchId = started.batch.batchId
            taskId = task.taskId
            runningImage.execution = { kind: 'image', operationId, batchId, taskId }
            run = persistRun(run)
          }
          const terminal = await dependencies.imageRuns.awaitBatch({
            ...target, batchId, taskIds: [taskId], signal: controller.signal, deadlineAt,
          })
          if (!reloadBeforeCommit()) break
          const entry = terminal.entries.find((candidate) => (
            candidate.nodeId === runningImage.nodeId && candidate.taskId === taskId
          ))
          if (entry?.status === 'candidate') {
            runningImage.status = 'waiting-adoption'
            runningImage.errorCode = null
          } else {
            runningImage.status = 'failed'
            runningImage.errorCode = entry?.status === 'failed'
              ? 'CANVAS_IMAGE_RUN_FAILED' : 'CANVAS_IMAGE_RESULT_INVALID'
          }
          run = persistRun(run)
          continue
        }

        const readyAgents = run.nodes.filter((node) => (
          node.kind === 'agent' && node.status === 'ready' && isPersistentNodeReady(node, run)
        )).slice(0, MAX_AGENT_CONCURRENCY)
        if (readyAgents.length > 0) {
          for (const node of readyAgents) {
            freezePersistentInputs(node, run, document)
            node.status = 'running'
            node.execution = {
              kind: 'agent',
              operationId: `workflow-node-${stableHash(['agent', run.operationId, node.nodeId])}`,
            }
          }
          run = persistRun(run)
          const results = await Promise.allSettled(readyAgents.map((node) => (
            dependencies.agentExecution.execute({
              mode: 'parent-orchestrated',
              target: { ...target, nodeId: node.nodeId },
              parentSessionId: context.sessionId,
              expectedGraphRevision: document.revision,
              instruction: run.goal,
              userMessageUuid: run.operationId,
              startedAt: run.owner.runStartedAt,
              signal: controller.signal,
            })
          )))
          if (!reloadBeforeCommit()) break
          for (let index = 0; index < readyAgents.length; index += 1) {
            const node = run.nodes.find((candidate) => candidate.nodeId === readyAgents[index]!.nodeId)!
            const result = results[index]!
            if (result.status === 'fulfilled' && result.value.status === 'completed' && result.value.output) {
              node.status = 'completed'
              node.errorCode = null
              node.completedArtifactHash = result.value.output.pointer.contentSha256
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
            }
          }
          run = persistRun(run)
          if (controller.signal.aborted) break
          document = await dependencies.load(target)
          assertPersistentGraphValid(run, document)
          run.observedCanvasRevision = Math.max(run.observedCanvasRevision, document.revision)
          continue
        }

        const readyImage = run.nodes.find((node) => (
          node.kind === 'image' && node.status === 'ready' && isPersistentNodeReady(node, run)
        ))
        if (readyImage) {
          if (run.budget.remainingMediaRuns === 0) {
            readyImage.status = 'waiting-approval'
            run = persistRun(run)
            continue
          }
          freezePersistentInputs(readyImage, run, document)
          readyImage.status = 'running'
          readyImage.execution = {
            kind: 'image',
            operationId: createWorkflowImageOperationId(run.operationId, readyImage.nodeId),
            batchId: null,
            taskId: null,
          }
          run.budget.consumedMediaRuns += 1
          run.budget.remainingMediaRuns -= 1
          run = persistRun(run)
          continue
        }
        break
      }

      run = workflowRuns.get(target, run.id)
      if (run.status !== 'cancelled') {
        if (controller.signal.aborted) {
          for (const node of run.nodes) {
            if (node.status === 'ready' || node.status === 'running') {
              node.status = 'cancelled'
              node.errorCode = null
            }
          }
          run.status = 'cancelled'
          run.cancelRequestedAt = run.cancelRequestedAt ?? now()
          run.cancelledAt = now()
        } else {
          reconcileRunStatus(run)
        }
        const elapsed = run.budget.activeStartedAt === null
          ? 0 : Math.max(0, now() - run.budget.activeStartedAt)
        run.budget.remainingDurationMs = Math.max(0, run.budget.remainingDurationMs - elapsed)
        run.budget.activeStartedAt = null
        run = persistRun(run)
      }
      if (deadlineExpired && run.status !== 'cancelled') {
        throw new Error('CANVAS_WORKFLOW_TIMEOUT')
      }
      return run
    } finally {
      deadline.cancel()
      durableControllers.delete(initialRun.id)
      parentSignal?.removeEventListener('abort', onParentAbort)
      releaseLease()
    }
  }

  /** 持久入口先幂等创建固定计划，再由跨进程租约推进。 */
  const executePersistent = async (
    context: CanvasToolRunContext,
    input: CanvasRunWorkflowInput,
    toolCallId: string,
    signal?: AbortSignal,
  ): Promise<CanvasRunWorkflowResult> => {
    if (!workflowRuns) return executeVolatile(context, input, toolCallId, signal)
    const target = { projectId: context.projectId, canvasId: input.canvasId }
    /** operation 查找必须带完整父运行身份，避免其它 session 或代次的同名工具调用占位。 */
    const owner = { sessionId: context.sessionId, runStartedAt: context.runStartedAt }
    await dependencies.validateAccess(context, input.canvasId)
    const existing = workflowRuns.findByOperation(target, toolCallId, owner)
    if (existing) {
      assertOriginalOwner(context, existing)
      return projectPersistentResult(await drivePersistentRun(context, existing, signal))
    }
    const document = await dependencies.load(target)
    await dependencies.validateAccess(context, input.canvasId)
    if (document.revision !== input.expectedRevision) throw new Error('CANVAS_REVISION_CONFLICT')
    const plan = createCanvasWorkflowGraphPlan({
      document, startNodeIds: input.startNodeIds, maxImageRuns: input.maxImageRuns,
    })
    for (const rootNodeId of plan.rootNodeIds) {
      const rootNode = document.nodes.find((node): node is Extract<CanvasNode, { kind: 'agent' }> => (
        node.id === rootNodeId && node.kind === 'agent'
      ))
      if (rootNode && dependencies.isAgentBusy(rootNode)) throw new Error('SESSION_BUSY')
    }
    const run = workflowRuns.create({
      ...target,
      operationId: toolCallId,
      owner,
      initialCanvasRevision: document.revision,
      rootNodeIds: plan.rootNodeIds,
      goal: input.goal,
      nodes: createPersistentNodes(document, plan),
      maxMediaRuns: input.maxImageRuns,
      consumedMediaRuns: 0,
      maxDurationMs: CANVAS_WORKFLOW_TIMEOUT_MS,
      autoResumeAfterAdoption: false,
    })
    dependencies.onRunChanged?.({
      projectId: run.projectId, canvasId: run.canvasId, runId: run.id, revision: run.revision,
    })
    return projectPersistentResult(await drivePersistentRun(context, run, signal))
  }

  return {
    execute: executePersistent,
    resume: async (context, input, signal) => {
      if (!workflowRuns) throw new Error('CANVAS_WORKFLOW_RUN_STORE_UNAVAILABLE')
      if (input.projectId !== context.projectId) throw new Error('CANVAS_WORKFLOW_RUN_TARGET_INVALID')
      await dependencies.validateAccess(context, input.canvasId)
      const run = workflowRuns.get(input, input.runId)
      assertSessionOwner(context, run)
      return projectPersistentResult(await drivePersistentRun(context, run, signal))
    },
    cancel: async (context, input) => {
      if (!workflowRuns) throw new Error('CANVAS_WORKFLOW_RUN_STORE_UNAVAILABLE')
      if (input.projectId !== context.projectId) throw new Error('CANVAS_WORKFLOW_RUN_TARGET_INVALID')
      await dependencies.validateAccess(context, input.canvasId)
      let run = workflowRuns.get(input, input.runId)
      assertSessionOwner(context, run)
      if (run.status === 'cancelled') return run
      durableControllers.get(run.id)?.abort('cancel')
      for (const node of run.nodes) {
        if (node.status === 'running' && node.execution?.kind === 'image'
          && node.execution.batchId && node.execution.taskId && dependencies.imageRuns.cancelTasks) {
          await dependencies.imageRuns.cancelTasks({
            ...input,
            batchId: node.execution.batchId,
            taskIds: [node.execution.taskId],
          })
        }
      }
      run = workflowRuns.get(input, input.runId)
      if (run.status === 'cancelled') return run
      const timestamp = now()
      for (const node of run.nodes) {
        if (node.status === 'ready' || node.status === 'running' || node.status === 'waiting-approval') {
          node.status = 'cancelled'
          node.errorCode = null
        }
      }
      run.cancelRequestedAt = run.cancelRequestedAt ?? timestamp
      run.cancelledAt = timestamp
      run.status = 'cancelled'
      return persistRun(run)
    },
    get: async (context, input) => {
      if (!workflowRuns) throw new Error('CANVAS_WORKFLOW_RUN_STORE_UNAVAILABLE')
      if (input.projectId !== context.projectId) throw new Error('CANVAS_WORKFLOW_RUN_TARGET_INVALID')
      await dependencies.validateAccess(context, input.canvasId)
      const run = workflowRuns.get(input, input.runId)
      assertSessionOwner(context, run)
      return run
    },
    list: async (context, canvasId, options) => {
      if (!workflowRuns) throw new Error('CANVAS_WORKFLOW_RUN_STORE_UNAVAILABLE')
      await dependencies.validateAccess(context, canvasId)
      return workflowRuns.listPage(
        { projectId: context.projectId, canvasId },
        { ...options, ownerSessionId: context.sessionId },
      )
    },
  }
}
