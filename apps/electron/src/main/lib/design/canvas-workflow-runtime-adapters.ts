import type { CanvasDocument, CanvasMediaAdoptedOutput, CanvasTarget, MediaRunSnapshot } from '@proma/shared'
import type { MediaRunService } from '../media/media-run-service'
import type { MediaRunSupervisor } from '../media/media-run-supervisor'
import type { CanvasAgentOutputService } from './canvas-agent-output-service'
import type { CanvasMediaService } from './canvas-media-service'
import type { CanvasWorkflowExecutionServiceDependencies } from './canvas-workflow-execution-service'

/** 只认可指定运行和输出的明确采用，默认首选不能替代工作流验收。 */
export function findCanvasWorkflowConfirmedMediaOutput(
  outputs: readonly CanvasMediaAdoptedOutput[],
  runId: string,
  outputKey: string,
): CanvasMediaAdoptedOutput | null {
  return outputs.find((output) => output.key === outputKey && output.runId === runId
    && output.selectionOrigin !== 'initial') ?? null
}

/** 工作流只通过已有媒体服务提交，恢复时保持原 run 和调用主体。 */
export interface CanvasWorkflowMediaAdapterDependencies {
  media: Pick<CanvasMediaService, 'run' | 'cancel' | 'refreshCompleted'>
  runs: Pick<MediaRunService, 'get' | 'getOrigin'>
  supervisor: Pick<MediaRunSupervisor, 'start' | 'watch' | 'wait'>
  resolveInputs: NonNullable<CanvasWorkflowExecutionServiceDependencies['mediaRuns']>['resolveInputs']
  claimOptions: ReturnType<typeof import('./canvas-media-handoff-service').createCanvasMediaHandoffService>['claimOptions']
  onCancelError?: (error: unknown) => void
  now?: () => number
}

/** 将远端事实映射到工作流状态；下载失败仍允许收集原任务。 */
function workflowMediaResult(run: MediaRunSnapshot): Awaited<ReturnType<NonNullable<CanvasWorkflowExecutionServiceDependencies['mediaRuns']>['run']>> {
  return {
    status: run.phase === 'succeeded' ? 'waiting-adoption' : run.phase === 'cancelled' ? 'cancelled'
      : run.phase === 'failed' ? 'failed' : 'running',
    mediaRunId: run.id,
    outputKeys: run.outputs.map((output) => output.outputKey),
    errorCode: run.error,
    retryable: run.phase === 'failed',
  }
}

/** 首次提交立即返回已持久化 ID；后续调用只监督原 ID，不创建第二次生成。 */
export function createCanvasWorkflowMediaAdapter(dependencies: CanvasWorkflowMediaAdapterDependencies): NonNullable<CanvasWorkflowExecutionServiceDependencies['mediaRuns']> {
  const now = dependencies.now ?? Date.now
  /** 父工作流停止推进与远端精确取消是独立事实；失败后保留原任务监督。 */
  const requestCancellation = async (target: Parameters<CanvasMediaService['cancel']>[0], runId: string): Promise<void> => {
    try { await dependencies.media.cancel(target, runId) } catch (error) {
      try { dependencies.onCancelError?.(error) } catch { /* 诊断不得阻止父运行记录取消。 */ }
    }
  }
  return {
    resolveInputs: dependencies.resolveInputs,
    run: async (input) => {
      if (input.signal.aborted) throw new Error('CANVAS_WORKFLOW_ABORTED')
      const target = { projectId: input.projectId, canvasId: input.canvasId, nodeId: input.nodeId,
        mediaModuleId: input.mediaModuleId, mediaKind: input.mediaKind }
      const run = await dependencies.media.run({ ...target, expectedConfigRevision: input.expectedConfigRevision, operationId: input.operationId }, {
        canvasMedia: target,
        actor: { sessionId: input.context.sessionId, runStartedAt: input.context.runStartedAt, mode: 'project-agent' },
      }, { expectedInputHashes: input.expectedInputHashes, signal: input.signal,
        ...dependencies.claimOptions(target, input.workflowRunId) })
      if (run.phase === 'succeeded') await dependencies.media.refreshCompleted(target)
      return workflowMediaResult(run)
    },
    reconcile: async (input) => {
      const origin = dependencies.runs.getOrigin(input.projectId, input.mediaRunId)
      const target = origin.canvasMedia
      if (!target || target.projectId !== input.projectId || target.canvasId !== input.canvasId
        || target.nodeId !== input.nodeId || target.mediaModuleId !== input.mediaModuleId || target.mediaKind !== input.mediaKind
        || origin.actor?.mode !== 'project-agent' || origin.actor.sessionId !== input.context.sessionId
        || origin.actor.runStartedAt !== input.context.runStartedAt) throw new Error('CANVAS_MEDIA_RUN_OWNER_INVALID')
      let run = dependencies.runs.get(input.projectId, input.mediaRunId)
      if (input.signal.aborted && input.signal.reason === 'cancel') {
        await requestCancellation(target, run.id)
        run = dependencies.runs.get(input.projectId, input.mediaRunId)
        return workflowMediaResult(run)
      }
      if (input.signal.aborted) return workflowMediaResult(run)
      if (run.phase === 'prepared') dependencies.supervisor.start(input.projectId, run.id, run.revision)
      else dependencies.supervisor.watch(input.projectId, run.id)
      run = await dependencies.supervisor.wait(input.projectId, run.id,
        Math.max(0, Math.min(30_000, input.deadlineAt - now())), undefined, input.signal)
      if (input.signal.aborted && input.signal.reason === 'cancel') {
        await requestCancellation(target, run.id)
        run = dependencies.runs.get(input.projectId, input.mediaRunId)
      }
      if (run.phase === 'succeeded') await dependencies.media.refreshCompleted(target)
      return workflowMediaResult(run)
    },
    cancel: async (input) => { await requestCancellation(input, input.mediaRunId) },
  }
}

/** 恢复 Agent 时只读取当前权威节点及既有正式输出解析器。 */
export interface CanvasWorkflowAgentRecoveryDependencies {
  load(target: CanvasTarget): CanvasDocument
  outputs: Pick<CanvasAgentOutputService, 'resolveCompletedOutput'>
  isBusy(sessionId: string): boolean
}

/** 当前指针必须属于原用户锚点，旧正式输出或后续轮次都不能冒充本次完成。 */
export function createCanvasWorkflowAgentRecovery(dependencies: CanvasWorkflowAgentRecoveryDependencies): NonNullable<CanvasWorkflowExecutionServiceDependencies['recoverAgentExecution']> {
  return async (input) => {
    const document = dependencies.load(input)
    const node = document.nodes.find((candidate) => candidate.id === input.nodeId)
    if (node?.kind !== 'agent' || node.agentSessionId !== input.agentSessionId) return { status: 'missing' }
    if (node.outputPointer && node.outputPointer.completedAt >= input.expectedStartedAt) {
      try {
        const resolved = dependencies.outputs.resolveCompletedOutput({ target: input, userMessageUuid: input.expectedUserMessageUuid,
          startedAt: input.expectedStartedAt, runGeneration: 1, completedAt: node.outputPointer.completedAt, terminalStatus: 'completed' })
        if (resolved.pointer.messageUuid === node.outputPointer.messageUuid
          && resolved.pointer.contentSha256 === node.outputPointer.contentSha256) {
          return { status: 'completed', output: { target: { projectId: input.projectId, canvasId: input.canvasId, nodeId: input.nodeId },
            revision: document.revision, pointer: node.outputPointer, downstreamNodeIds: [] } }
        }
      } catch { /* 没有原锚点的正式输出证据时只报告运行中或中断。 */ }
    }
    return { status: dependencies.isBusy(input.agentSessionId) ? 'running' : 'missing' }
  }
}
