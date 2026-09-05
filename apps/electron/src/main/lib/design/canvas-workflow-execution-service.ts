import type {
  CanvasDocument,
  CanvasNode,
  CanvasRunWorkflowInput,
  CanvasRunWorkflowResult,
  CanvasWorkflowImageSummary,
  CanvasWorkflowNodeResult,
  CanvasWorkflowNodeStatus,
} from '@proma/shared'
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
  load: (target: { projectId: string; canvasId: string }) => CanvasDocument | Promise<CanvasDocument>
  validateAccess: (context: CanvasToolRunContext, canvasId: string) => void
  isAgentBusy: (node: Extract<CanvasNode, { kind: 'agent' }>) => boolean
  agentExecution: Pick<CanvasAgentExecutionService, 'execute'>
  imageRuns: Pick<CanvasImageRunService, 'run' | 'awaitBatch' | 'cancelTasks'>
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

/** 当前图片批次的 owned 身份，仅用于等待和精确取消。 */
interface OwnedImageBatch {
  batchId: string
  taskIds: string[]
}

/** 从受控异常中提取稳定错误码，未知异常统一降级。 */
function stableErrorCode(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback
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

/** 返回单条边不会随 revision 改变的执行身份。 */
function edgeIdentity(edge: CanvasDocument['edges'][number]): string {
  return [
      edge.id,
      edge.sourceNodeId,
      edge.sourcePort,
      edge.targetNodeId,
      edge.targetPort,
      edge.relation,
    ].join('\0')
}

/** 动态重算前确认根、已执行身份和已执行链路没有被并发改写。 */
function assertExecutedGraphStable(
  previous: CanvasDocument,
  next: CanvasDocument,
  rootNodeIds: readonly string[],
  executedNodeIds: ReadonlySet<string>,
): void {
  const previousNodes = new Map(previous.nodes.map((node) => [node.id, node]))
  const nextNodes = new Map(next.nodes.map((node) => [node.id, node]))
  for (const nodeId of new Set([...rootNodeIds, ...executedNodeIds])) {
    const before = previousNodes.get(nodeId)
    const after = nextNodes.get(nodeId)
    if (!before || !after || nodeIdentity(before) !== nodeIdentity(after)) {
      throw new Error('CANVAS_WORKFLOW_GRAPH_CHANGED')
    }
  }
  const previousNodeIds = new Set(previous.nodes.map((node) => node.id))
  const previousEdges = new Set(previous.edges.map(edgeIdentity))
  const nextEdges = new Set(next.edges.map(edgeIdentity))
  for (const edge of previous.edges) {
    if ((executedNodeIds.has(edge.sourceNodeId) || executedNodeIds.has(edge.targetNodeId))
      && !nextEdges.has(edgeIdentity(edge))) {
      throw new Error('CANVAS_WORKFLOW_GRAPH_CHANGED')
    }
  }
  for (const edge of next.edges) {
    if (previousEdges.has(edgeIdentity(edge))) continue
    /** 已执行节点只可向本轮新节点追加出边，不能改写已存在链路或新增入边。 */
    if ((executedNodeIds.has(edge.sourceNodeId) || executedNodeIds.has(edge.targetNodeId))
      && !(executedNodeIds.has(edge.sourceNodeId) && !previousNodeIds.has(edge.targetNodeId))) {
      throw new Error('CANVAS_WORKFLOW_GRAPH_CHANGED')
    }
  }
}

/** 从计划初始化状态表；后续 fresh plan 只补入新节点，不覆盖已运行事实。 */
function mergePlanStates(
  states: Map<string, InternalNodeState>,
  plan: CanvasWorkflowGraphPlan,
): void {
  for (const nodeId of plan.reachableNodeIds) {
    if (states.has(nodeId)) continue
    const status = plan.initialStates.get(nodeId) ?? 'blocked'
    states.set(nodeId, {
      status,
      errorCode: status === 'blocked' ? 'CANVAS_WORKFLOW_NODE_UNSUPPORTED' : null,
    })
  }
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
    const dependencies = (plan.dependenciesByNodeId.get(nodeId) ?? []).map((id) => states.get(id))
    let errorCode: string | null = null
    if (dependencies.some((dependency) => dependency?.status === 'waiting-review')) {
      errorCode = 'WAITING_FOR_IMAGE_ADOPTION'
    } else if (dependencies.some((dependency) => dependency?.status === 'waiting-approval')) {
      errorCode = 'WAITING_FOR_IMAGE_APPROVAL'
    } else if (dependencies.some((dependency) => (
      dependency?.status === 'failed'
      || dependency?.status === 'blocked'
      || dependency?.status === 'cancelled'
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
function toWorkflowImageSummary(summary: NonNullable<Awaited<ReturnType<CanvasImageRunService['awaitBatch']>>>): CanvasWorkflowImageSummary {
  return {
    status: summary.status,
    totalCount: summary.totalCount,
    candidateCount: summary.candidateCount,
    failedCount: summary.failedCount,
    runningCount: summary.runningCount,
  }
}

/** 创建一次性、无持久运行计划的 Canvas 工作流调度器。 */
export function createCanvasWorkflowExecutionService(
  dependencies: CanvasWorkflowExecutionServiceDependencies,
): CanvasWorkflowExecutionService {
  const activeRuns = new Map<string, symbol>()
  const now = dependencies.now ?? Date.now
  const setDeadline = dependencies.setDeadline ?? ((callback, timeoutMs) => {
    const timer = setTimeout(callback, timeoutMs)
    return { cancel: () => clearTimeout(timer) }
  })

  return {
    execute: async (context, input, toolCallId, parentSignal) => {
      const target = { projectId: context.projectId, canvasId: input.canvasId }
      const activeKey = `${target.projectId}\0${target.canvasId}`
      if (activeRuns.has(activeKey)) throw new Error('CANVAS_WORKFLOW_ACTIVE')
      const owner = Symbol(toolCallId)
      activeRuns.set(activeKey, owner)
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
      let ownedImageBatch: OwnedImageBatch | null = null

      try {
        dependencies.validateAccess(context, input.canvasId)
        let document = await dependencies.load(target)
        dependencies.validateAccess(context, input.canvasId)
        if (document.revision !== input.expectedRevision) throw new Error('CANVAS_REVISION_CONFLICT')
        let plan = createCanvasWorkflowGraphPlan({
          document,
          startNodeIds: input.startNodeIds,
          maxImageRuns: input.maxImageRuns,
        })
        for (const rootNodeId of plan.rootNodeIds) {
          const rootNode = document.nodes.find((node): node is Extract<CanvasNode, { kind: 'agent' }> => (
            node.id === rootNodeId && node.kind === 'agent'
          ))
          if (!rootNode || dependencies.isAgentBusy(rootNode)) {
            throw new Error('SESSION_BUSY')
          }
        }

        const states = new Map<string, InternalNodeState>()
        mergePlanStates(states, plan)
        const executedNodeIds = new Set<string>()
        let imageSummary: CanvasWorkflowImageSummary | null = null
        let workflowErrorCode: string | null = null

        /** 每批 Agent 后 fresh-read 并从原根重算，合法新增节点会被并入状态表。 */
        const refreshPlan = async (): Promise<boolean> => {
          dependencies.validateAccess(context, input.canvasId)
          const nextDocument = await dependencies.load(target)
          if (controller.signal.aborted) return false
          dependencies.validateAccess(context, input.canvasId)
          try {
            assertExecutedGraphStable(document, nextDocument, plan.rootNodeIds, executedNodeIds)
            const nextPlan = createCanvasWorkflowGraphPlan({
              document: nextDocument,
              startNodeIds: plan.rootNodeIds,
              maxImageRuns: input.maxImageRuns,
            })
            document = nextDocument
            plan = nextPlan
            mergePlanStates(states, plan)
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

        while (!controller.signal.aborted && !workflowErrorCode) {
          while (propagateBlockedDependencies(plan, states)) {
            // 有界 DAG 每轮至少终结一个节点，最多 32 次。
          }
          const nodesById = new Map(document.nodes.map((node) => [node.id, node]))
          const readyAgents = plan.reachableNodeIds.filter((nodeId) => (
            states.get(nodeId)?.status === 'started'
            && nodesById.get(nodeId)?.kind === 'agent'
            && !executedNodeIds.has(nodeId)
            && isReady(nodeId, plan, states)
          ))
          if (readyAgents.length === 0) break

          for (let offset = 0; offset < readyAgents.length && !controller.signal.aborted; offset += MAX_AGENT_CONCURRENCY) {
            const batchNodeIds = readyAgents.slice(offset, offset + MAX_AGENT_CONCURRENCY)
            const batchRevision = document.revision
            const results = await Promise.allSettled(batchNodeIds.map((nodeId) => {
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
            for (let index = 0; index < batchNodeIds.length; index += 1) {
              const nodeId = batchNodeIds[index]!
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
            if (!await refreshPlan()) break
          }
        }

        while (propagateBlockedDependencies(plan, states)) {
          // Agent 终态传播完成后再计算一次图片 readiness。
        }
        if (!controller.signal.aborted && !workflowErrorCode) {
          const nodesById = new Map(document.nodes.map((node) => [node.id, node]))
          const readyImages = plan.reachableNodeIds
            .filter((nodeId) => (
              states.get(nodeId)?.status === 'started'
              && nodesById.get(nodeId)?.kind === 'image'
              && !executedNodeIds.has(nodeId)
              && isReady(nodeId, plan, states)
            ))
            .map((nodeId) => nodesById.get(nodeId)!)
          if (readyImages.length > 0) {
            for (const node of readyImages) executedNodeIds.add(node.id)
            try {
              const runResult = await dependencies.imageRuns.run(context, target, readyImages, toolCallId)
              if (!controller.signal.aborted) {
                dependencies.validateAccess(context, input.canvasId)
                const batch = runResult.batch
                const taskIds = runResult.tasks.flatMap((task) => task.taskId ? [task.taskId] : [])
                if (batch && taskIds.length > 0) {
                  ownedImageBatch = { batchId: batch.batchId, taskIds }
                  const terminal = await dependencies.imageRuns.awaitBatch({
                    ...target,
                    batchId: batch.batchId,
                    taskIds,
                    signal: controller.signal,
                    deadlineAt,
                  })
                  imageSummary = toWorkflowImageSummary(terminal)
                  if (!controller.signal.aborted && await refreshPlan()) {
                    for (const node of readyImages) {
                      const task = runResult.tasks.find((candidate) => candidate.nodeId === node.id)
                      states.set(node.id, terminal.candidateCount > 0 && task?.status !== 'failed'
                        ? { status: 'waiting-review', errorCode: null }
                        : { status: 'failed', errorCode: 'CANVAS_IMAGE_RUN_FAILED' })
                    }
                  }
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
                for (const node of readyImages) {
                  states.set(node.id, { status: 'failed', errorCode })
                }
              }
            }
          }
        }

        if (controller.signal.aborted && ownedImageBatch) {
          await dependencies.imageRuns.cancelTasks({ ...target, ...ownedImageBatch })
        }
        if (controller.signal.aborted) {
          for (const [nodeId, state] of states) {
            if (state.status === 'started') states.set(nodeId, { status: 'cancelled', errorCode: null })
          }
        } else {
          while (propagateBlockedDependencies(plan, states)) {
            // 图片待验收或失败只阻断其后继，不改变独立分支。
          }
        }

        dependencies.validateAccess(context, input.canvasId)
        const finalDocument = await dependencies.load(target)
        const nodes: CanvasWorkflowNodeResult[] = plan.reachableNodeIds.map((nodeId) => {
          const state = states.get(nodeId) ?? { status: 'blocked' as const, errorCode: 'CANVAS_WORKFLOW_INCOMPLETE' }
          if (state.status === 'failed' || state.status === 'blocked') {
            return { nodeId, status: state.status, errorCode: state.errorCode ?? 'CANVAS_WORKFLOW_INCOMPLETE' }
          }
          return { nodeId, status: state.status, errorCode: null }
        })
        if (controller.signal.aborted) {
          return {
            status: 'cancelled',
            initialRevision: input.expectedRevision,
            finalRevision: Math.max(input.expectedRevision, finalDocument.revision),
            nodes,
            imageSummary,
            requiresReview: false,
            errorCode: deadlineExpired ? 'CANVAS_WORKFLOW_TIMEOUT' : 'CANVAS_WORKFLOW_CANCELLED',
          }
        }
        if (workflowErrorCode) {
          return {
            status: 'partial',
            initialRevision: input.expectedRevision,
            finalRevision: Math.max(input.expectedRevision, finalDocument.revision),
            nodes,
            imageSummary,
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
            status: 'partial',
            initialRevision: input.expectedRevision,
            finalRevision: Math.max(input.expectedRevision, finalDocument.revision),
            nodes,
            imageSummary,
            requiresReview,
            errorCode: null,
          }
        }
        if (requiresReview) {
          return {
            status: 'waiting-review',
            initialRevision: input.expectedRevision,
            finalRevision: Math.max(input.expectedRevision, finalDocument.revision),
            nodes,
            imageSummary,
            requiresReview: true,
            errorCode: null,
          }
        }
        return {
          status: 'completed',
          initialRevision: input.expectedRevision,
          finalRevision: Math.max(input.expectedRevision, finalDocument.revision),
          nodes,
          imageSummary,
          requiresReview: false,
          errorCode: null,
        }
      } finally {
        deadline.cancel()
        parentSignal?.removeEventListener('abort', onParentAbort)
        if (activeRuns.get(activeKey) === owner) activeRuns.delete(activeKey)
      }
    },
  }
}
