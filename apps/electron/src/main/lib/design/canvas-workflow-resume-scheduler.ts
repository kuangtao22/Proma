import type { CanvasWorkflowRun } from '@proma/shared'

/** 仅由持久工作流服务提供的绝对恢复时刻，不接收 Renderer 的任意计时请求。 */
export interface CanvasWorkflowResumeSchedule {
  projectId: string
  canvasId: string
  workflowRunId: string
  ownerSessionId: string
  resumeAt: number
}

/** 生产只复用原工作流恢复入口；可注入时钟用于验证期限不被延长。 */
export interface CanvasWorkflowResumeSchedulerDependencies {
  resume(input: CanvasWorkflowResumeSchedule): Promise<void>
  onError(error: unknown): void
  now?: () => number
  setTimer?: (callback: () => void, timeoutMs: number) => { cancel(): void }
}

/** 启动和事件恢复都必须处理未收敛取消，自动采用设置只约束等待后的推进。 */
export function shouldResumeCanvasWorkflow(run: CanvasWorkflowRun): boolean {
  if (run.status === 'completed' || run.status === 'cancelled') return false
  return run.cancelRequestedAt !== null || run.status === 'running'
    || (run.autoResumeAfterAdoption && (run.status === 'waiting-review' || run.status === 'partial'))
}

/** 每个活跃工作流保留一个截止计时器，等待采用和终态立即释放。 */
export function createCanvasWorkflowResumeScheduler(dependencies: CanvasWorkflowResumeSchedulerDependencies): {
  schedule(input: CanvasWorkflowResumeSchedule): void
  changed(run: CanvasWorkflowRun): void
  dispose(): void
} {
  const timers = new Map<string, { cancel(): void }>()
  const now = dependencies.now ?? Date.now
  const setTimer = dependencies.setTimer ?? ((callback: () => void, timeoutMs: number) => {
    const timer = setTimeout(callback, timeoutMs)
    timer.unref?.()
    return { cancel: () => clearTimeout(timer) }
  })
  let disposed = false
  const keyFor = (input: { projectId: string; canvasId: string; workflowRunId: string }): string => JSON.stringify([input.projectId, input.canvasId, input.workflowRunId])
  /** 瞬时恢复错误保留原期限，以最多一分钟的间隔重试，不重置预算。 */
  const scheduleAttempt = (input: CanvasWorkflowResumeSchedule, attempt: number): void => {
    if (disposed) return
    const key = keyFor(input)
    if (!Number.isSafeInteger(input.resumeAt) || input.resumeAt < 0) throw new Error('CANVAS_WORKFLOW_DEADLINE_INVALID')
    if (!timers.has(key) && timers.size >= 128) throw new Error('CANVAS_WORKFLOW_ACTIVE_LIMIT')
    timers.get(key)?.cancel()
    const timer = setTimer(() => {
      if (disposed || timers.get(key) !== timer) return
      void dependencies.resume(input).then(() => {
        if (timers.get(key) === timer) timers.delete(key)
      }).catch((error: unknown) => {
        if (disposed || timers.get(key) !== timer) return
        try { dependencies.onError(error) } catch { /* 诊断异常不得丢失唯一期限唤醒。 */ }
        scheduleAttempt(input, Math.min(attempt + 1, 7))
      })
    }, attempt === 0 ? Math.max(0, Math.min(2_147_483_647, input.resumeAt - now())) : Math.min(60_000, 1000 * 2 ** (attempt - 1)))
    timers.set(key, timer)
  }
  return {
    schedule: (input) => scheduleAttempt(input, 0),
    changed(run) {
      if (shouldResumeCanvasWorkflow(run) && run.cancelRequestedAt !== null) {
        scheduleAttempt({ projectId: run.projectId, canvasId: run.canvasId,
          workflowRunId: run.id, ownerSessionId: run.owner.sessionId, resumeAt: now() }, 0)
        return
      }
      if (run.status === 'running' && run.cancelRequestedAt === null) {
        if (run.budget.activeStartedAt !== null) scheduleAttempt({ projectId: run.projectId, canvasId: run.canvasId,
          workflowRunId: run.id, ownerSessionId: run.owner.sessionId,
          resumeAt: run.budget.activeStartedAt + run.budget.remainingDurationMs }, 0)
        return
      }
      const key = keyFor({ ...run, workflowRunId: run.id })
      timers.get(key)?.cancel()
      timers.delete(key)
    },
    dispose() {
      disposed = true
      for (const timer of timers.values()) timer.cancel()
      timers.clear()
    },
  }
}
