import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { AGENT_RUNTIME_METHODS } from '@proma/shared'
import type { AgentRuntimeEvent } from '@proma/shared'
import type { PiAgentQueryOptions } from './pi-agent-adapter'

/** 创建可控 Promise，用于模拟 utility runtime 的真实关闭耗时。 */
function createDeferred(): {
  promise: Promise<void>
  resolve: () => void
  reject: (error: Error) => void
} {
  /** 完成 Promise 的函数。 */
  let resolve = (): void => undefined
  /** 拒绝 Promise 的函数。 */
  let reject = (_error: Error): void => undefined
  /** 等待测试显式控制的 Promise。 */
  const promise = new Promise<void>((complete, fail) => {
    resolve = complete
    reject = fail
  })
  return { promise, resolve, reject }
}

/** 单个 fake utility runtime 的可观察状态。 */
interface FakeRuntimeState {
  /** runtime 关闭边界。 */
  stop: ReturnType<typeof createDeferred>
  /** 发往 runtime 的方法。 */
  calls: string[]
  /** 底层 stop 实际调用次数。 */
  stopCalls: number
  /** adapter 注册的 runtime 事件监听器。 */
  eventListener?: (event: AgentRuntimeEvent) => void
}

/** 每次 query 创建的独立 utility runtime。 */
let runtimeStates: FakeRuntimeState[] = []

mock.module('../agent-runtime-client', () => ({
  AgentRuntimeClient: class {
    /** 当前 client 独占的 runtime 状态。 */
    private readonly state: FakeRuntimeState
    constructor() {
      this.state = { stop: createDeferred(), calls: [], stopCalls: 0 }
      runtimeStates.push(this.state)
    }
    setRequestHandler(): void {}
    onEvent(listener: (event: AgentRuntimeEvent) => void): () => void {
      this.state.eventListener = listener
      return () => undefined
    }
    async call(method: string): Promise<unknown> {
      this.state.calls.push(method)
      return undefined
    }
    stop(): Promise<void> {
      this.state.stopCalls += 1
      return this.state.stop.promise
    }
  },
}))

const { PiUtilityAdapter } = await import('./pi-utility-adapter')

beforeEach(() => {
  runtimeStates = []
})

/** 创建只包含 utility query 启动所需字段的输入。 */
function createQueryInput(sessionId: string): PiAgentQueryOptions {
  return { sessionId } as unknown as PiAgentQueryOptions
}

/** 等待异步关闭流程到达指定可观察状态，避免绑定固定微任务次数。 */
async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return
    await Promise.resolve()
  }
  throw new Error('等待 utility adapter 状态超时')
}

describe('Pi utility 强制关闭合同', () => {
  test('Given async generator 的 next 永久等待队列 When 强制关闭 Then runtime 真正停止后 iterator 才完成', async () => {
    /** 被测 utility adapter。 */
    const adapter = new PiUtilityAdapter()
    /** 真实 async generator iterator。 */
    const iterator = adapter.query(createQueryInput('session-1'), 'query-1')[Symbol.asyncIterator]()
    /** 永久等待 queue.next 的 pending next。 */
    const pendingNext = iterator.next()
    await Promise.resolve()
    await Promise.resolve()
    const runtime = runtimeStates[0]!
    expect(runtime.calls).toContain(AGENT_RUNTIME_METHODS.QUERY_START)

    /** 两个并发关闭调用必须复用同一个底层关闭过程。 */
    const firstClose = adapter.forceCloseQuery('query-1')
    const secondClose = adapter.forceCloseQuery('query-1')
    await waitUntil(() => runtime.stopCalls === 1)

    expect(runtime.calls).toContain(AGENT_RUNTIME_METHODS.QUERY_ABORT)
    expect(runtime.stopCalls).toBe(1)
    expect(await Promise.race([
      pendingNext.then(() => 'settled' as const),
      Bun.sleep(20).then(() => 'pending' as const),
    ])).toBe('pending')

    runtime.stop.resolve()
    await expect(Promise.all([firstClose, secondClose])).resolves.toEqual([undefined, undefined])
    await expect(pendingNext).resolves.toMatchObject({ done: true })
    await expect(iterator.return?.()).resolves.toMatchObject({ done: true })
    expect(runtime.stopCalls).toBe(1)
  })

  test('Given 强制关闭拒绝且并发 stopAll When 收尾 Then 所有拒绝被消费且底层 stop 不重复', async () => {
    /** 被测 utility adapter。 */
    const adapter = new PiUtilityAdapter()
    /** 真实 async generator iterator。 */
    const iterator = adapter.query(createQueryInput('session-reject'), 'query-reject')[Symbol.asyncIterator]()
    /** 永久等待 queue.next 的 pending next。 */
    const pendingNext = iterator.next()
    await Promise.resolve()
    await Promise.resolve()

    const runtime = runtimeStates[0]!
    const forcedClose = adapter.forceCloseQuery('query-reject')
    adapter.abort('session-reject')
    adapter.dispose()
    await waitUntil(() => runtime.stopCalls === 1)
    /** 模拟底层 runtime stop 最终拒绝。 */
    const stopError = new Error('runtime stop failed')
    runtime.stop.reject(stopError)

    const results = await Promise.allSettled([forcedClose, pendingNext, iterator.return?.()])
    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected', 'fulfilled'])
    expect(runtime.stopCalls).toBe(1)
  })

  test('Given generation1 draining 且同 session generation2 已启动 When 按 token 强制关闭 generation1 Then generation2 继续产出并完成', async () => {
    /** 被测 utility adapter。 */
    const adapter = new PiUtilityAdapter()
    /** 同会话旧 generation iterator。 */
    const oldIterator = adapter.query(createQueryInput('session-shared'), 'query-old')[Symbol.asyncIterator]()
    /** 让旧 generation 永久等待其独立事件队列。 */
    const oldNext = oldIterator.next()
    await waitUntil(() => runtimeStates.length === 1)
    /** 同会话新 generation iterator。 */
    const currentIterator = adapter.query(createQueryInput('session-shared'), 'query-current')[Symbol.asyncIterator]()
    /** 等待新 generation 的首个事件。 */
    const currentNext = currentIterator.next()
    await waitUntil(() => runtimeStates.length === 2)
    const oldRuntime = runtimeStates[0]!
    const currentRuntime = runtimeStates[1]!

    const oldClose = adapter.forceCloseQuery('query-old')
    await waitUntil(() => oldRuntime.stopCalls === 1)
    expect(currentRuntime.calls).not.toContain(AGENT_RUNTIME_METHODS.QUERY_ABORT)
    expect(currentRuntime.stopCalls).toBe(0)

    /** generation2 在旧 generation cleanup 期间仍可产出事件。 */
    const currentMessage = { type: 'assistant', uuid: 'current-message' }
    currentRuntime.eventListener?.({
      kind: 'event',
      method: AGENT_RUNTIME_METHODS.EVENT_QUERY,
      queryId: 'query-current',
      sessionId: 'session-shared',
      payload: { queryId: 'query-current', message: currentMessage },
    } as AgentRuntimeEvent)
    await expect(currentNext).resolves.toMatchObject({ done: false, value: currentMessage })

    oldRuntime.stop.resolve()
    await oldClose
    await expect(oldNext).resolves.toMatchObject({ done: true })

    /** generation2 独立收到自然结束事件并完成。 */
    currentRuntime.stop.resolve()
    currentRuntime.eventListener?.({
      kind: 'event',
      method: AGENT_RUNTIME_METHODS.EVENT_QUERY_END,
      queryId: 'query-current',
      sessionId: 'session-shared',
      payload: { queryId: 'query-current' },
    } as AgentRuntimeEvent)
    await expect(currentIterator.next()).resolves.toMatchObject({ done: true })
  })

  test('Given generation1 强制关闭 reject When generation2 已成为当前 Then reject 被消费且 generation2 不受影响', async () => {
    /** 被测 utility adapter。 */
    const adapter = new PiUtilityAdapter()
    const oldIterator = adapter.query(createQueryInput('session-shared'), 'query-old-reject')[Symbol.asyncIterator]()
    const oldNext = oldIterator.next()
    await waitUntil(() => runtimeStates.length === 1)
    const currentIterator = adapter.query(createQueryInput('session-shared'), 'query-current-safe')[Symbol.asyncIterator]()
    const currentNext = currentIterator.next()
    await waitUntil(() => runtimeStates.length === 2)
    const oldRuntime = runtimeStates[0]!
    const currentRuntime = runtimeStates[1]!

    const oldClose = adapter.forceCloseQuery('query-old-reject')
    await waitUntil(() => oldRuntime.stopCalls === 1)
    oldRuntime.stop.reject(new Error('old runtime stop failed'))
    const oldResults = await Promise.allSettled([oldClose, oldNext, oldIterator.return?.()])
    expect(oldResults.map((result) => result.status)).toEqual(['rejected', 'rejected', 'fulfilled'])
    expect(currentRuntime.calls).not.toContain(AGENT_RUNTIME_METHODS.QUERY_ABORT)

    const currentMessage = { type: 'assistant', uuid: 'still-current' }
    currentRuntime.eventListener?.({
      kind: 'event',
      method: AGENT_RUNTIME_METHODS.EVENT_QUERY,
      queryId: 'query-current-safe',
      sessionId: 'session-shared',
      payload: { queryId: 'query-current-safe', message: currentMessage },
    } as AgentRuntimeEvent)
    await expect(currentNext).resolves.toMatchObject({ done: false, value: currentMessage })
    currentRuntime.stop.resolve()
    currentRuntime.eventListener?.({
      kind: 'event',
      method: AGENT_RUNTIME_METHODS.EVENT_QUERY_END,
      queryId: 'query-current-safe',
      sessionId: 'session-shared',
      payload: { queryId: 'query-current-safe' },
    } as AgentRuntimeEvent)
    await expect(currentIterator.next()).resolves.toMatchObject({ done: true })
  })
})
