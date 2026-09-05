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
} from '@proma/shared'
import { resolveCanvasEdgeBinding } from '@proma/shared'
import type { CanvasAgentExecutionService } from './canvas-agent-execution-service'
import type { CanvasImageRunService } from './canvas-image-run-service'
import type { CanvasToolRunContext } from './canvas-tool-provider'
import {
  createCanvasWorkflowGraphPlan,
  type CanvasWorkflowGraphPlan,
} from './canvas-workflow-graph'

/** 单次工作流中的 Canvas Agent 并发上限。 */
const MAX_AGENT_CONCURRENCY = 2
/** Canvas 工作流与单 Agent 长工具共用的总时限。 */
export const CANVAS_WORKFLOW_TIMEOUT_MS = 15 * 60_000

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
  imageRuns: Pick<CanvasImageRunService, 'run' | 'awaitBatch'>
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

  return {
    execute: async (context, input, toolCallId, parentSignal) => {
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
      let imageSummary: CanvasWorkflowImageSummary | null = null
      let workflowErrorCode: string | null = null

      /** 统一构造取消结果，避免取消清理异常覆盖主事实。 */
      const cancelledResult = (): CanvasRunWorkflowResult => {
        for (const [nodeId, state] of states) {
          if (state.status === 'started') states.set(nodeId, { status: 'cancelled', errorCode: null })
        }
        return {
          status: 'cancelled',
          initialRevision: input.expectedRevision,
          finalRevision: Math.max(input.expectedRevision, document?.revision ?? input.expectedRevision),
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

        /** 每轮只取当前 fresh plan 的首个双槽批次，完成后立即返回外层重算。 */
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
          if (batchNodeIds.length === 0) break
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
        }

        if (controller.signal.aborted) return cancelledResult()
        if (plan) {
          while (propagateBlockedDependencies(plan, states)) {
            // Agent 终态传播完成后再计算一次图片 readiness。
          }
        }

        if (!workflowErrorCode && document && plan) {
          /** 图片阶段同样固定 fresh plan 快照，避免异步闭包扩大可空类型。 */
          const currentPlan = plan
          const nodesById = new Map(document.nodes.map((node) => [node.id, node]))
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
            try {
              const runResult = await dependencies.imageRuns.run(
                context, target, readyImages, toolCallId, { signal: controller.signal, deadlineAt },
              )
              if (!controller.signal.aborted) {
                const batch = runResult.batch
                /** 只把实际返回且带任务身份的节点移交给 awaitBatch。 */
                const taskIds = runResult.tasks.flatMap((task) => task.taskId ? [task.taskId] : [])
                if (batch && taskIds.length > 0) {
                  const terminal = await dependencies.imageRuns.awaitBatch({
                    ...target, batchId: batch.batchId, taskIds, signal: controller.signal, deadlineAt,
                  })
                  imageSummary = toWorkflowImageSummary(terminal)
                  /** 逐节点终态必须同时匹配 run 返回的 nodeId 和 owned taskId。 */
                  const entriesByNodeId = new Map(terminal.entries.map((entry) => [entry.nodeId, entry]))
                  for (const node of readyImages) {
                    const task = runResult.tasks.find((candidate) => candidate.nodeId === node.id)
                    const entry = entriesByNodeId.get(node.id)
                    if (!task?.taskId || !entry || entry.taskId !== task.taskId || entry.nodeId !== node.id) {
                      states.set(node.id, { status: 'failed', errorCode: 'CANVAS_IMAGE_RESULT_INVALID' })
                    } else if (entry.status === 'candidate') {
                      states.set(node.id, { status: 'waiting-review', errorCode: null })
                    } else if (entry.status === 'failed') {
                      states.set(node.id, { status: 'failed', errorCode: 'CANVAS_IMAGE_RUN_FAILED' })
                    } else {
                      states.set(node.id, { status: 'failed', errorCode: 'CANVAS_IMAGE_RESULT_INVALID' })
                    }
                  }
                  if (!controller.signal.aborted) await refreshPlan()
                } else {
                  for (const node of readyImages) {
                    const task = runResult.tasks.find((candidate) => candidate.nodeId === node.id)
                    states.set(node.id, task?.status === 'failed'
                      ? { status: 'failed', errorCode: 'CANVAS_IMAGE_RUN_FAILED' }
                      : { status: 'blocked', errorCode: 'CANVAS_IMAGE_BATCH_MISSING' })
                  }
                }
              }
            } catch (error) {
              if (!controller.signal.aborted) {
                const errorCode = stableErrorCode(error, 'CANVAS_IMAGE_RUN_FAILED')
                for (const node of readyImages) states.set(node.id, { status: 'failed', errorCode })
              }
            }
          }
        }

        if (controller.signal.aborted) return cancelledResult()
        if (plan) {
          while (propagateBlockedDependencies(plan, states)) {
            // 图片逐节点终态只阻断自身后继，不影响独立分支。
          }
        }
        const nodes = projectNodeResults(plan, states)
        const finalRevision = Math.max(input.expectedRevision, document?.revision ?? input.expectedRevision)
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
  }
}
