import { describe, expect, test } from 'bun:test'
import {
  combineAuthoritativeLists,
  createGenerationTracker,
  createPriorityTaskCoordinator,
  isAuthenticationFailureCode,
  shouldClearMessagesBeforeLoad,
} from './recovery-guards'

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(reason: unknown): void
}

/** 创建可手动完成的 Promise，用于稳定复现请求乱序。 */
function createDeferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | null = null
  let rejectPromise: ((reason: unknown) => void) | null = null
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  return {
    promise,
    resolve: value => {
      if (!resolvePromise) throw new Error('Promise 尚未初始化')
      resolvePromise(value)
    },
    reject: reason => {
      if (!rejectPromise) throw new Error('Promise 尚未初始化')
      rejectPromise(reason)
    },
  }
}

describe('移动端恢复认证分类', () => {
  test('Given 明确认证错误 When 分类 Then 仅认证错误触发登出', () => {
    for (const code of ['AUTH_REQUIRED', 'TOKEN_EXPIRED', 'TOKEN_INVALID', 'DEVICE_REVOKED']) {
      expect(isAuthenticationFailureCode(code)).toBe(true)
    }
    for (const code of ['CONNECTION_LOST', 'TIMEOUT', 'SEND_FAILED', 'NOT_CONNECTED', undefined]) {
      expect(isAuthenticationFailureCode(code)).toBe(false)
    }
  })
})

describe('移动端权威列表快照', () => {
  test('Given 两类列表均成功 When 合并 Then 提交排序后的权威快照', () => {
    const result = combineAuthoritativeLists(
      { status: 'fulfilled', value: [{ id: 'old', updatedAt: 1 }] },
      { status: 'fulfilled', value: [{ id: 'new', updatedAt: 2 }] },
      (left, right) => right.updatedAt - left.updatedAt,
    )

    expect(result).toEqual({ updated: true, items: [{ id: 'new', updatedAt: 2 }, { id: 'old', updatedAt: 1 }] })
  })

  test('Given 任一或全部列表失败 When 合并 Then 不生成空快照覆盖现态', () => {
    const failure = { status: 'rejected', reason: new Error('network') } as const
    const success = { status: 'fulfilled', value: [{ id: 'kept' }] } as const

    expect(combineAuthoritativeLists(success, failure)).toEqual({ updated: false })
    expect(combineAuthoritativeLists(failure, success)).toEqual({ updated: false })
    expect(combineAuthoritativeLists(failure, failure)).toEqual({ updated: false })
  })

  test('Given 两类列表均成功且为空 When 合并 Then 允许提交权威空快照', () => {
    const empty = { status: 'fulfilled', value: [] } as const

    expect(combineAuthoritativeLists(empty, empty)).toEqual({ updated: true, items: [] })
  })
})

describe('移动端异步 generation', () => {
  test('Given 较旧慢请求晚于新请求完成 When 提交 Then 仅最新批次可写入', async () => {
    const tracker = createGenerationTracker()
    const oldRequest = createDeferred<string>()
    const newRequest = createDeferred<string>()
    const commits: string[] = []
    /** 仅当前 generation 能提交异步结果。 */
    const run = async (request: Promise<string>) => {
      const generation = tracker.begin()
      const value = await request
      if (tracker.isCurrent(generation)) commits.push(value)
    }

    const oldRun = run(oldRequest.promise)
    const newRun = run(newRequest.promise)
    newRequest.resolve('new')
    await newRun
    oldRequest.resolve('old')
    await oldRun

    expect(commits).toEqual(['new'])
  })

  test('Given effect cleanup 已失效 generation When 响应到达 Then 不提交结果', async () => {
    const tracker = createGenerationTracker()
    const request = createDeferred<string>()
    const commits: string[] = []
    const generation = tracker.begin()
    const pendingCommit = request.promise.then(value => {
      if (tracker.isCurrent(generation)) commits.push(value)
    })

    tracker.invalidate()
    request.resolve('stale')
    await pendingCommit

    expect(commits).toEqual([])
  })

  test('Given logout 已失效 generation When 恢复结果到达 Then 不把 view 写回 chat', async () => {
    const tracker = createGenerationTracker()
    const request = createDeferred<'chat'>()
    let view: 'auth' | 'chat' = 'auth'
    const generation = tracker.begin()
    const pendingView = request.promise.then(nextView => {
      if (tracker.isCurrent(generation)) view = nextView
    })

    tracker.invalidate()
    request.resolve('chat')
    await pendingView

    expect(view).toBe('auth')
  })
})

describe('移动端恢复优先任务协调', () => {
  test('Given recovery 未完成 When 两个 normal 调用 Then 不并发执行且完成后合并为一次 trailing refresh', async () => {
    const coordinator = createPriorityTaskCoordinator<string>()
    const recoveryTask = createDeferred<string>()
    let normalRuns = 0
    const recovery = coordinator.run('recovery', () => recoveryTask.promise)
    const firstNormal = coordinator.run('normal', async () => { normalRuns += 1; return 'normal-1' })
    const secondNormal = coordinator.run('normal', async () => { normalRuns += 1; return 'normal-2' })

    expect(firstNormal).not.toBe(recovery)
    expect(secondNormal).toBe(firstNormal)
    expect(normalRuns).toBe(0)
    recoveryTask.resolve('recovered')
    expect(await recovery).toBe('recovered')
    expect(await Promise.all([firstNormal, secondNormal])).toEqual(['normal-1', 'normal-1'])
    expect(normalRuns).toBe(1)
  })

  test('Given recovery 已完成 When normal 调用 Then 可独立执行新任务', async () => {
    const coordinator = createPriorityTaskCoordinator<string>()
    const recoveryTask = createDeferred<string>()
    const recovery = coordinator.run('recovery', () => recoveryTask.promise)
    recoveryTask.resolve('recovered')
    await recovery

    const normal = coordinator.run('normal', async () => 'normal')

    expect(await normal).toBe('normal')
    expect(normal).not.toBe(recovery)
  })

  test('Given recovery 失败 When normal 已排队 Then 失败后仍执行一次 trailing refresh', async () => {
    const coordinator = createPriorityTaskCoordinator<string>()
    const recoveryTask = createDeferred<string>()
    let normalRuns = 0
    const recovery = coordinator.run('recovery', () => recoveryTask.promise)
    const trailing = coordinator.run('normal', async () => { normalRuns += 1; return 'after-failure' })

    recoveryTask.reject(new Error('recovery failed'))
    await expect(recovery).rejects.toThrow('recovery failed')
    expect(await trailing).toBe('after-failure')
    expect(normalRuns).toBe(1)
  })

  test('Given 新 recovery 已取代旧任务 When 旧任务完成 Then trailing 等待新 recovery 且旧 cleanup 不清新 active', async () => {
    const coordinator = createPriorityTaskCoordinator<string>()
    const oldTask = createDeferred<string>()
    const newTask = createDeferred<string>()
    let normalRuns = 0
    const oldRecovery = coordinator.run('recovery', () => oldTask.promise)
    const trailing = coordinator.run('normal', async () => { normalRuns += 1; return 'normal' })
    const newRecovery = coordinator.run('recovery', () => newTask.promise)
    oldTask.resolve('old')
    await oldRecovery

    expect(normalRuns).toBe(0)
    newTask.resolve('new')
    expect(await newRecovery).toBe('new')
    expect(await trailing).toBe('normal')
    expect(normalRuns).toBe(1)
  })
})

describe('移动端消息刷新策略', () => {
  test('Given 不同刷新原因 When 判断预清空 Then 仅 active-change 清空历史', () => {
    expect(shouldClearMessagesBeforeLoad('active-change')).toBe(true)
    expect(shouldClearMessagesBeforeLoad('reconnect')).toBe(false)
    expect(shouldClearMessagesBeforeLoad('stream-complete')).toBe(false)
  })
})
