import { describe, expect, test } from 'bun:test'
import { PiAgentAdapter } from './pi-agent-adapter'

/** 创建可控 Promise，用于模拟指定 in-process query 的 cleanup。 */
function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  /** 完成 cleanup 的函数。 */
  let resolve = (): void => undefined
  /** 等待测试显式完成的 cleanup Promise。 */
  const promise = new Promise<void>((complete) => { resolve = complete })
  return { promise, resolve }
}

/** 测试所需的最小 active query 形状。 */
interface TestActiveQuery {
  session: {
    abortCompaction: () => void
    abort: () => Promise<void>
  }
  closed: Promise<void>
  forceClosePromise?: Promise<void>
  abortRequested: boolean
  pendingInterruptPrompts: []
  readySettled: boolean
}

/** 暴露 adapter 内部 query 所有权表的测试视图。 */
interface TestPiAgentAdapterState {
  activeSessions: Map<string, TestActiveQuery>
  activeQueries: Map<string, TestActiveQuery>
}

describe('Pi in-process query 所有权', () => {
  test('Given generation1 cleanup 延迟且 generation2 已成为当前 When force-close generation1 token Then 只中止 generation1', async () => {
    /** 被测 in-process adapter。 */
    const adapter = new PiAgentAdapter()
    /** adapter 内部所有权表的测试视图。 */
    const state = adapter as unknown as TestPiAgentAdapterState
    /** 两代 query 各自独立的 cleanup 边界。 */
    const oldClosed = createDeferred()
    const currentClosed = createDeferred()
    /** 两代 query 的 abort 次数。 */
    let oldAbortCalls = 0
    let currentAbortCalls = 0
    const oldQuery: TestActiveQuery = {
      session: {
        abortCompaction: () => undefined,
        abort: async () => { oldAbortCalls += 1 },
      },
      closed: oldClosed.promise,
      abortRequested: false,
      pendingInterruptPrompts: [],
      readySettled: true,
    }
    const currentQuery: TestActiveQuery = {
      session: {
        abortCompaction: () => undefined,
        abort: async () => { currentAbortCalls += 1 },
      },
      closed: currentClosed.promise,
      abortRequested: false,
      pendingInterruptPrompts: [],
      readySettled: true,
    }
    state.activeSessions.set('session-shared', currentQuery)
    state.activeQueries.set('query-old', oldQuery)
    state.activeQueries.set('query-current', currentQuery)

    const closingOld = adapter.forceCloseQuery('query-old')
    await Promise.resolve()
    expect(oldAbortCalls).toBe(1)
    expect(currentAbortCalls).toBe(0)
    expect(currentQuery.abortRequested).toBe(false)
    expect(await Promise.race([
      closingOld.then(() => 'settled' as const),
      Bun.sleep(20).then(() => 'pending' as const),
    ])).toBe('pending')

    oldClosed.resolve()
    await closingOld
    expect(currentAbortCalls).toBe(0)
  })

  test('Given generation1 abort reject When generation2 已成为当前 Then reject 被消费且 generation2 仍安全', async () => {
    /** 被测 in-process adapter。 */
    const adapter = new PiAgentAdapter()
    /** adapter 内部所有权表的测试视图。 */
    const state = adapter as unknown as TestPiAgentAdapterState
    const oldClosed = createDeferred()
    const currentClosed = createDeferred()
    let currentAbortCalls = 0
    const oldQuery: TestActiveQuery = {
      session: {
        abortCompaction: () => undefined,
        abort: async () => { throw new Error('old abort failed') },
      },
      closed: oldClosed.promise,
      abortRequested: false,
      pendingInterruptPrompts: [],
      readySettled: true,
    }
    const currentQuery: TestActiveQuery = {
      session: {
        abortCompaction: () => undefined,
        abort: async () => { currentAbortCalls += 1 },
      },
      closed: currentClosed.promise,
      abortRequested: false,
      pendingInterruptPrompts: [],
      readySettled: true,
    }
    state.activeSessions.set('session-shared', currentQuery)
    state.activeQueries.set('query-old-reject', oldQuery)
    state.activeQueries.set('query-current-safe', currentQuery)

    const closingOld = adapter.forceCloseQuery('query-old-reject')
    await Promise.resolve()
    await Promise.resolve()
    expect(currentAbortCalls).toBe(0)
    expect(currentQuery.abortRequested).toBe(false)
    oldClosed.resolve()
    await expect(closingOld).resolves.toBeUndefined()
    expect(currentAbortCalls).toBe(0)
  })
})
