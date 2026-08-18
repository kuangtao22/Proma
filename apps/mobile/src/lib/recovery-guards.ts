export interface GenerationTracker {
  begin(): number
  invalidate(): void
  isCurrent(generation: number): boolean
}

export type TaskPriority = 'normal' | 'recovery'
export type MessageLoadReason = 'active-change' | 'reconnect' | 'stream-complete'

export interface PriorityTaskCoordinator<T> {
  run(priority: TaskPriority, task: () => Promise<T>): Promise<T>
}

interface TrailingTask<T> {
  task: () => Promise<T>
  promise: Promise<T>
  resolve(value: T): void
  reject(reason: unknown): void
}

export type AuthoritativeListResult<T> =
  | { updated: true; items: T[] }
  | { updated: false }

export type AuthenticationFailureCode =
  | 'AUTH_REQUIRED'
  | 'TOKEN_EXPIRED'
  | 'TOKEN_INVALID'
  | 'DEVICE_REVOKED'

/** 创建单调递增的异步代际跟踪器，旧任务无法提交到新状态。 */
export function createGenerationTracker(): GenerationTracker {
  let currentGeneration = 0
  return {
    begin: () => {
      currentGeneration += 1
      return currentGeneration
    },
    invalidate: () => { currentGeneration += 1 },
    isCurrent: generation => generation === currentGeneration,
  }
}

/** 让普通刷新复用正在执行的恢复任务，同时允许新恢复取代旧恢复。 */
export function createPriorityTaskCoordinator<T>(): PriorityTaskCoordinator<T> {
  let activeRecovery: Promise<T> | null = null
  let trailingTask: TrailingTask<T> | null = null

  /** 为 recovery 期间的 normal 调用创建共享的尾随结果。 */
  function createTrailingTask(task: () => Promise<T>): TrailingTask<T> {
    let resolvePromise: ((value: T) => void) | null = null
    let rejectPromise: ((reason: unknown) => void) | null = null
    const promise = new Promise<T>((resolve, reject) => {
      resolvePromise = resolve
      rejectPromise = reject
    })
    return {
      task,
      promise,
      resolve: value => resolvePromise?.(value),
      reject: reason => rejectPromise?.(reason),
    }
  }

  /** 当前有效 recovery 完成后启动至多一个尾随 normal，无论成功或失败。 */
  function finishRecovery(recovery: Promise<T>): void {
    if (activeRecovery !== recovery) return
    activeRecovery = null
    const queuedTask = trailingTask
    if (!queuedTask) return
    trailingTask = null
    try {
      const execution = queuedTask.task()
      void execution.then(queuedTask.resolve, queuedTask.reject)
    } catch (error) {
      queuedTask.reject(error)
    }
  }

  return {
    run: (priority, task) => {
      if (priority === 'normal' && activeRecovery) {
        if (!trailingTask) trailingTask = createTrailingTask(task)
        return trailingTask.promise
      }
      const taskPromise = task()
      if (priority !== 'recovery') return taskPromise
      activeRecovery = taskPromise
      /** 身份校验保证旧 recovery settle 不会影响新的 active recovery。 */
      void taskPromise.then(
        () => finishRecovery(taskPromise),
        () => finishRecovery(taskPromise),
      )
      return taskPromise
    },
  }
}

/** 只有切换会话需要立即清空，后台恢复继续展示现有历史。 */
export function shouldClearMessagesBeforeLoad(reason: MessageLoadReason): boolean {
  return reason === 'active-change'
}

/** 判断错误码是否明确表示本地认证已失效。 */
export function isAuthenticationFailureCode(code: unknown): code is AuthenticationFailureCode {
  return code === 'AUTH_REQUIRED'
    || code === 'TOKEN_EXPIRED'
    || code === 'TOKEN_INVALID'
    || code === 'DEVICE_REVOKED'
}

/** 仅在两路列表均成功时生成权威快照，避免部分失败伪装为空列表。 */
export function combineAuthoritativeLists<T>(
  first: PromiseSettledResult<readonly T[]>,
  second: PromiseSettledResult<readonly T[]>,
  compare?: (left: T, right: T) => number,
): AuthoritativeListResult<T> {
  if (first.status !== 'fulfilled' || second.status !== 'fulfilled') return { updated: false }
  const items = [...first.value, ...second.value]
  if (compare) items.sort(compare)
  return { updated: true, items }
}
