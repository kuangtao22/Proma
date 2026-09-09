import type { DesignJobRecord, DesignJobStatus } from '@proma/shared'
import type { DesignJobChangedEvent, DesignJobChangedListener } from './design-job-manager'

/** 等待器只接受由 Canvas 文档解析出的完整图片任务身份。 */
export interface CanvasImageTaskWaitTarget {
  projectId: string
  canvasId: string
  nodeId: string
  imageModuleId: string
  jobId: string
}

/** 等待结束只返回小型状态标记，完整详情由调用方重新受控读取。 */
export interface CanvasImageTaskWaitResult {
  outcome: 'terminal' | 'timeout'
  status: DesignJobStatus
}

/** 等待器复用 Job Manager 事件，并在订阅后复读以封闭漏事件窗口。 */
export interface CanvasImageTaskWaitDependencies {
  readCurrent: () => DesignJobRecord | undefined
  subscribe: (listener: DesignJobChangedListener) => () => void
  signal?: AbortSignal
}

/** queued 与 running 之外的状态均为不可继续运行的任务终态。 */
function isTerminalStatus(status: DesignJobStatus): boolean {
  return status !== 'queued' && status !== 'running'
}

/** 验证事件同时匹配项目、Canvas、节点、模块和任务，避免相邻任务误唤醒。 */
function matchesExactTask(job: DesignJobRecord, target: CanvasImageTaskWaitTarget): boolean {
  return job.projectId === target.projectId
    && job.id === target.jobId
    && job.target?.kind === 'canvas-image'
    && job.target.canvasId === target.canvasId
    && job.target.nodeId === target.nodeId
    && job.target.imageModuleId === target.imageModuleId
}

/**
 * 在指定时间内等待精确图片任务进入终态。
 * @param target 已由 Host 解析并授权的完整任务身份。
 * @param waitMs 最大等待毫秒数，调用方负责限制范围。
 * @param dependencies 当前任务复读、事件订阅和可选取消信号。
 * @returns 命中终态或超时时的最小状态，完整业务详情须再次查询。
 */
export function waitForCanvasImageTaskTerminal(
  target: CanvasImageTaskWaitTarget,
  waitMs: number,
  dependencies: CanvasImageTaskWaitDependencies,
): Promise<CanvasImageTaskWaitResult> {
  if (dependencies.signal?.aborted) return Promise.reject(new Error('CANVAS_OPERATION_CANCELLED'))

  return new Promise((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let unsubscribe: (() => void) | undefined

    /** 所有终止路径统一释放监听器、定时器和取消监听。 */
    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer)
      dependencies.signal?.removeEventListener('abort', onAbort)
      unsubscribe?.()
    }
    /** 只允许首个终止事实完成等待 Promise。 */
    const finish = (result: CanvasImageTaskWaitResult): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve(result)
    }
    /** 读取、订阅或取消失败均在拒绝前完成相同资源清理。 */
    const fail = (error: unknown): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(error instanceof Error ? error : new Error('CANVAS_OPERATION_FAILED'))
    }
    /** 调用方取消立即终止等待，并释放全部资源。 */
    const onAbort = (): void => {
      fail(new Error('CANVAS_OPERATION_CANCELLED'))
    }
    /** 仅精确任务的终态事件可以结束等待。 */
    const onChanged = ({ job }: DesignJobChangedEvent): void => {
      if (matchesExactTask(job, target) && isTerminalStatus(job.status)) {
        finish({ outcome: 'terminal', status: job.status })
      }
    }

    try {
      unsubscribe = dependencies.subscribe(onChanged)
    } catch (error) {
      fail(error)
      return
    }
    /** 兼容订阅实现同步发布当前状态，确保返回的退订函数不会遗留。 */
    if (settled) {
      unsubscribe()
      unsubscribe = undefined
      return
    }
    dependencies.signal?.addEventListener('abort', onAbort, { once: true })
    if (dependencies.signal?.aborted) {
      onAbort()
      return
    }
    let current: DesignJobRecord | undefined
    try {
      current = dependencies.readCurrent()
    } catch (error) {
      fail(error)
      return
    }
    if (settled) return
    if (!current || !matchesExactTask(current, target)) {
      fail(new Error('CANVAS_TASK_IDENTITY_MISMATCH'))
      return
    }
    if (isTerminalStatus(current.status)) {
      finish({ outcome: 'terminal', status: current.status })
      return
    }
    timer = setTimeout(() => {
      try {
        const latest = dependencies.readCurrent()
        if (!latest || !matchesExactTask(latest, target)) {
          fail(new Error('CANVAS_TASK_IDENTITY_MISMATCH'))
          return
        }
        finish(isTerminalStatus(latest.status)
          ? { outcome: 'terminal', status: latest.status }
          : { outcome: 'timeout', status: latest.status })
      } catch (error) {
        fail(error)
      }
    }, waitMs)
  })
}
