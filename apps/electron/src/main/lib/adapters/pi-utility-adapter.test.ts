import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { AGENT_RUNTIME_METHODS } from '@proma/shared'
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

/** 当前测试 runtime 的关闭边界。 */
let runtimeStop = createDeferred()
/** 记录发往 utility runtime 的方法。 */
let runtimeCalls: string[] = []
/** 记录底层 stop 实际调用次数。 */
let runtimeStopCalls = 0

mock.module('../agent-runtime-client', () => ({
  AgentRuntimeClient: class {
    setRequestHandler(): void {}
    onEvent(): () => void { return () => undefined }
    async call(method: string): Promise<unknown> {
      runtimeCalls.push(method)
      return undefined
    }
    stop(): Promise<void> {
      runtimeStopCalls += 1
      return runtimeStop.promise
    }
  },
}))

const { PiUtilityAdapter } = await import('./pi-utility-adapter')

beforeEach(() => {
  runtimeStop = createDeferred()
  runtimeCalls = []
  runtimeStopCalls = 0
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
    const iterator = adapter.query(createQueryInput('session-1'))[Symbol.asyncIterator]()
    /** 永久等待 queue.next 的 pending next。 */
    const pendingNext = iterator.next()
    await Promise.resolve()
    await Promise.resolve()
    expect(runtimeCalls).toContain(AGENT_RUNTIME_METHODS.QUERY_START)

    /** 两个并发关闭调用必须复用同一个底层关闭过程。 */
    const firstClose = adapter.forceCloseQuery('session-1')
    const secondClose = adapter.forceCloseQuery('session-1')
    await waitUntil(() => runtimeStopCalls === 1)

    expect(runtimeCalls).toContain(AGENT_RUNTIME_METHODS.QUERY_ABORT)
    expect(runtimeStopCalls).toBe(1)
    expect(await Promise.race([
      pendingNext.then(() => 'settled' as const),
      Bun.sleep(20).then(() => 'pending' as const),
    ])).toBe('pending')

    runtimeStop.resolve()
    await expect(Promise.all([firstClose, secondClose])).resolves.toEqual([undefined, undefined])
    await expect(pendingNext).resolves.toMatchObject({ done: true })
    await expect(iterator.return?.()).resolves.toMatchObject({ done: true })
    expect(runtimeStopCalls).toBe(1)
  })

  test('Given 强制关闭拒绝且并发 stopAll When 收尾 Then 所有拒绝被消费且底层 stop 不重复', async () => {
    /** 被测 utility adapter。 */
    const adapter = new PiUtilityAdapter()
    /** 真实 async generator iterator。 */
    const iterator = adapter.query(createQueryInput('session-reject'))[Symbol.asyncIterator]()
    /** 永久等待 queue.next 的 pending next。 */
    const pendingNext = iterator.next()
    await Promise.resolve()
    await Promise.resolve()

    const forcedClose = adapter.forceCloseQuery('session-reject')
    adapter.abort('session-reject')
    adapter.dispose()
    await waitUntil(() => runtimeStopCalls === 1)
    /** 模拟底层 runtime stop 最终拒绝。 */
    const stopError = new Error('runtime stop failed')
    runtimeStop.reject(stopError)

    const results = await Promise.allSettled([forcedClose, pendingNext, iterator.return?.()])
    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected', 'fulfilled'])
    expect(runtimeStopCalls).toBe(1)
  })
})
