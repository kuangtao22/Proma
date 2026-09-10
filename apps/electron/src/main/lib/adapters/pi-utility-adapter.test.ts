import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { AGENT_RUNTIME_METHODS, createAgentRuntimeRequest } from '@proma/shared'
import type { AgentRuntimeEvent } from '@proma/shared'
import type { PiAgentQueryOptions } from './pi-agent-adapter'
import { createRunToolCallLimiter } from '../agent-run-tool-policy'
import type { CanUseToolOptions } from '../agent-permission-service'

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
  /** 发往 runtime 的请求参数，用于验证函数不会被序列化。 */
  requestPayloads: unknown[]
  /** 底层 stop 实际调用次数。 */
  stopCalls: number
  /** query abort 的协议响应。 */
  abortResponse: { accepted: boolean; completed?: boolean }
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
      this.state = {
        stop: createDeferred(),
        calls: [],
        requestPayloads: [],
        stopCalls: 0,
        abortResponse: { accepted: true, completed: true },
      }
      runtimeStates.push(this.state)
    }
    setRequestHandler(): void {}
    onEvent(listener: (event: AgentRuntimeEvent) => void): () => void {
      this.state.eventListener = listener
      return () => undefined
    }
    async call(method: string, payload?: unknown): Promise<unknown> {
      this.state.calls.push(method)
      this.state.requestPayloads.push(payload)
      if (method === AGENT_RUNTIME_METHODS.QUERY_ABORT) return this.state.abortResponse
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
  test('Given Host 提供完成检查 When 启动 utility query Then 只序列化能力标记并通过独立 RPC 调用', async () => {
    const evaluations: AbortSignal[] = []
    const input = {
      ...createQueryInput('session-completion'),
      evaluateCompletion: async (signal: AbortSignal) => {
        evaluations.push(signal)
        return { action: 'complete' as const }
      },
    } as PiAgentQueryOptions
    const adapter = new PiUtilityAdapter()
    const iterator = adapter.query(input, 'query-completion')[Symbol.asyncIterator]()
    const pendingNext = iterator.next()
    await waitUntil(() => runtimeStates.length === 1)

    const startPayload = runtimeStates[0]!.requestPayloads[0] as { input?: Record<string, unknown> }
    expect(startPayload.input?.evaluateCompletion).toBeUndefined()
    expect(startPayload.input?.completionEvaluationEnabled).toBe(true)
    await expect(adapter.handleRuntimeRequest(createAgentRuntimeRequest(
      'agent.capability.evaluateCompletion',
      { queryId: 'query-completion', sessionId: 'session-completion' },
      { queryId: 'query-completion', sessionId: 'session-completion' },
    ))).resolves.toEqual({ action: 'complete' })
    expect(evaluations).toHaveLength(1)

    runtimeStates[0]!.stop.resolve()
    runtimeStates[0]!.eventListener?.({
      kind: 'event', method: AGENT_RUNTIME_METHODS.EVENT_QUERY_END,
      queryId: 'query-completion', sessionId: 'session-completion', payload: {},
    } as AgentRuntimeEvent)
    await expect(pendingNext).resolves.toMatchObject({ done: true })
  })

  test('Given utility 完成检查仍等待 When capability 取消 Then AbortSignal 终止检查', async () => {
    let evaluationEntered = false
    const input = {
      ...createQueryInput('session-completion-cancel'),
      evaluateCompletion: async (signal: AbortSignal) => new Promise((resolve) => {
        evaluationEntered = true
        signal.addEventListener('abort', () => resolve({ action: 'blocked' as const, message: '检查已取消' }), { once: true })
      }),
    } as PiAgentQueryOptions
    const adapter = new PiUtilityAdapter()
    const iterator = adapter.query(input, 'query-completion-cancel')[Symbol.asyncIterator]()
    const pendingNext = iterator.next()
    await waitUntil(() => runtimeStates.length === 1)
    const request = createAgentRuntimeRequest(
      'agent.capability.evaluateCompletion',
      { queryId: 'query-completion-cancel', sessionId: 'session-completion-cancel' },
      { queryId: 'query-completion-cancel', sessionId: 'session-completion-cancel' },
    )
    const evaluation = adapter.handleRuntimeRequest(request)
    await waitUntil(() => evaluationEntered)

    await adapter.handleRuntimeRequest(createAgentRuntimeRequest(
      AGENT_RUNTIME_METHODS.CAPABILITY_CANCEL,
      { requestId: request.requestId },
      { queryId: 'query-completion-cancel', sessionId: 'session-completion-cancel' },
    ))
    await expect(evaluation).resolves.toEqual({ action: 'blocked', message: '检查已取消' })

    runtimeStates[0]!.stop.resolve()
    runtimeStates[0]!.eventListener?.({
      kind: 'event', method: AGENT_RUNTIME_METHODS.EVENT_QUERY_END,
      queryId: 'query-completion-cancel', sessionId: 'session-completion-cancel', payload: {},
    } as AgentRuntimeEvent)
    await expect(pendingNext).resolves.toMatchObject({ done: true })
  })

  test('Given 主进程权限请求仍等待 When utility 取消对应 capability Then AbortSignal 终结审批且不影响 query', async () => {
    /** 权限回调是否已进入等待。 */
    let permissionEntered = false
    /** 带可观察取消信号的 query 输入。 */
    const input = {
      ...createQueryInput('session-permission-cancel'),
      canUseTool: async (_toolName: string, _toolInput: Record<string, unknown>, options: CanUseToolOptions) => (
        new Promise((resolve) => {
          permissionEntered = true
          options.signal.addEventListener('abort', () => {
            resolve({ behavior: 'deny' as const, message: '操作已中止', toolUseID: options.toolUseID })
          }, { once: true })
        })
      ),
    } as PiAgentQueryOptions
    /** 启动 query 以注册 capability 上下文。 */
    const adapter = new PiUtilityAdapter()
    /** 真实 async generator iterator。 */
    const iterator = adapter.query(input, 'query-permission-cancel')[Symbol.asyncIterator]()
    /** 等待 query 事件队列。 */
    const pendingNext = iterator.next()
    await waitUntil(() => runtimeStates.length === 1)
    /** utility 发起的待审批能力请求。 */
    const permissionRequest = createAgentRuntimeRequest(
      AGENT_RUNTIME_METHODS.CAPABILITY_CAN_USE_TOOL,
      {
        queryId: 'query-permission-cancel', sessionId: 'session-permission-cancel',
        toolName: 'Write', input: { file_path: 'result.txt' }, options: { toolUseID: 'tool-permission-cancel' },
      },
      { queryId: 'query-permission-cancel', sessionId: 'session-permission-cancel' },
    )
    /** 主进程中仍在等待用户响应的权限结果。 */
    const permissionResult = adapter.handleRuntimeRequest(permissionRequest)
    await waitUntil(() => permissionEntered)

    /** utility 在运行取消时发出的精确 capability 取消请求。 */
    const cancelRequest = createAgentRuntimeRequest(
      AGENT_RUNTIME_METHODS.CAPABILITY_CANCEL,
      { requestId: permissionRequest.requestId },
      { queryId: 'query-permission-cancel', sessionId: 'session-permission-cancel' },
    )
    await expect(adapter.handleRuntimeRequest(cancelRequest)).resolves.toEqual({ accepted: true })
    await expect(permissionResult).resolves.toEqual({
      behavior: 'deny', message: '操作已中止', toolUseID: 'tool-permission-cancel',
    })

    runtimeStates[0]!.stop.resolve()
    runtimeStates[0]!.eventListener?.({
      kind: 'event', method: AGENT_RUNTIME_METHODS.EVENT_QUERY_END,
      queryId: 'query-permission-cancel', sessionId: 'session-permission-cancel', payload: {},
    } as AgentRuntimeEvent)
    await expect(pendingNext).resolves.toMatchObject({ done: true })
  })

  test('Given 主进程权限请求仍等待 When 用户停止整轮 query Then AbortSignal 终结审批', async () => {
    /** 权限回调是否已进入等待。 */
    let permissionEntered = false
    /** 带可观察取消信号的 query 输入。 */
    const input = {
      ...createQueryInput('session-query-stop'),
      canUseTool: async (_toolName: string, _toolInput: Record<string, unknown>, options: CanUseToolOptions) => (
        new Promise((resolve) => {
          permissionEntered = true
          options.signal.addEventListener('abort', () => {
            resolve({ behavior: 'deny' as const, message: '操作已中止', toolUseID: options.toolUseID })
          }, { once: true })
        })
      ),
    } as PiAgentQueryOptions
    /** 启动 query 以注册 capability 上下文。 */
    const adapter = new PiUtilityAdapter()
    /** 真实 async generator iterator。 */
    const iterator = adapter.query(input, 'query-stop-permission')[Symbol.asyncIterator]()
    /** 等待 query 事件队列。 */
    const pendingNext = iterator.next()
    await waitUntil(() => runtimeStates.length === 1)
    /** 主进程中仍在等待用户响应的权限结果。 */
    const permissionResult = adapter.handleRuntimeRequest(createAgentRuntimeRequest(
      AGENT_RUNTIME_METHODS.CAPABILITY_CAN_USE_TOOL,
      {
        queryId: 'query-stop-permission', sessionId: 'session-query-stop',
        toolName: 'Write', input: { file_path: 'result.txt' }, options: { toolUseID: 'tool-query-stop' },
      },
      { queryId: 'query-stop-permission', sessionId: 'session-query-stop' },
    ))
    await waitUntil(() => permissionEntered)

    adapter.abort('session-query-stop')

    await expect(permissionResult).resolves.toEqual({
      behavior: 'deny', message: '操作已中止', toolUseID: 'tool-query-stop',
    })
    expect(runtimeStates[0]!.calls).toContain(AGENT_RUNTIME_METHODS.QUERY_ABORT)

    runtimeStates[0]!.stop.resolve()
    runtimeStates[0]!.eventListener?.({
      kind: 'event', method: AGENT_RUNTIME_METHODS.EVENT_QUERY_END,
      queryId: 'query-stop-permission', sessionId: 'session-query-stop', payload: {},
    } as AgentRuntimeEvent)
    await expect(pendingNext).resolves.toMatchObject({ done: true })
  })

  test('Given utility run 的付费工具上限为一 When runtime 连续请求两次准入 Then 主进程共享同一本轮计数器', async () => {
    /** 被测 utility adapter。 */
    const adapter = new PiUtilityAdapter()
    /** 单次主进程 run 独享的工具调用计数器。 */
    const consumeLimit = createRunToolCallLimiter({ mcp__nano_banana__generate_image: 1 })
    /** 带主进程权限回调的 query 输入。 */
    const input = {
      ...createQueryInput('session-tool-limit'),
      canUseTool: async (toolName: string, toolInput: Record<string, unknown>) => (
        consumeLimit(toolName) ?? { behavior: 'allow' as const, updatedInput: toolInput }
      ),
    } as PiAgentQueryOptions
    /** 启动 query 以注册 pending capability 上下文。 */
    const iterator = adapter.query(input, 'query-tool-limit')[Symbol.asyncIterator]()
    const pendingNext = iterator.next()
    await waitUntil(() => runtimeStates.length === 1)

    /** 构造来自 utility runtime 的两次同工具权限请求。 */
    const request = (requestId: string) => createAgentRuntimeRequest(
      AGENT_RUNTIME_METHODS.CAPABILITY_CAN_USE_TOOL,
      {
        queryId: 'query-tool-limit',
        sessionId: 'session-tool-limit',
        toolName: 'mcp__nano_banana__generate_image',
        input: { prompt: 'draw' },
        options: { toolUseID: requestId },
      },
      { queryId: 'query-tool-limit', sessionId: 'session-tool-limit' },
    )

    await expect(adapter.handleRuntimeRequest(request('tool-1'))).resolves.toMatchObject({ behavior: 'allow' })
    await expect(adapter.handleRuntimeRequest(request('tool-2'))).resolves.toEqual({
      behavior: 'deny',
      message: '当前任务工具调用次数已达上限: mcp__nano_banana__generate_image',
    })

    runtimeStates[0]!.stop.resolve()
    runtimeStates[0]!.eventListener?.({
      kind: 'event',
      method: AGENT_RUNTIME_METHODS.EVENT_QUERY_END,
      queryId: 'query-tool-limit',
      sessionId: 'session-tool-limit',
      payload: { queryId: 'query-tool-limit' },
    } as AgentRuntimeEvent)
    await expect(pendingNext).resolves.toMatchObject({ done: true })
  })

  test('Given runtime 停止超时 When 普通停止后强制关闭 Then 共享一次底层关闭', async () => {
    /** 被测 utility adapter。 */
    const adapter = new PiUtilityAdapter()
    /** 真实 async generator iterator。 */
    const iterator = adapter.query(createQueryInput('session-timeout'), 'query-timeout')[Symbol.asyncIterator]()
    /** 等待停止错误的 pending next。 */
    const pendingNext = iterator.next()
    /** 提前消费异步拒绝，避免测试运行器将预期错误判为未处理 Promise。 */
    const pendingOutcome = pendingNext.then(
      () => undefined,
      (error: unknown) => error,
    )
    await waitUntil(() => runtimeStates.length === 1)
    const runtime = runtimeStates[0]!
    runtime.abortResponse = { accepted: true, completed: false }

    adapter.abort('session-timeout')
    await waitUntil(() => runtime.stopCalls === 1)
    const forcedClose = adapter.forceCloseQuery('query-timeout')

    expect(runtime.stopCalls).toBe(1)
    runtime.stop.resolve()
    await expect(forcedClose).resolves.toBeUndefined()
    await expect(pendingOutcome).resolves.toBeInstanceOf(Error)
    expect((await pendingOutcome as Error).message).toContain('停止 Agent 超时')
    await expect(iterator.return?.()).resolves.toMatchObject({ done: true })
    expect(runtime.stopCalls).toBe(1)
  })

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
