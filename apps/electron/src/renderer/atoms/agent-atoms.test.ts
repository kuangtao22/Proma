import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { createStore } from 'jotai/vanilla'
import type { FilePanelDragItem } from '@/lib/file-panel-drag'
import {
  agentAckPendingMentionsAtom,
  agentPendingMentionsAtomFamily,
  agentSessionInputStreamStateAtomFamily,
  agentSessionPendingMentionsAtom,
  agentSessionStreamingStateAtomFamily,
  agentStreamingStatesAtom,
  applyAgentEvent,
  clearAgentStreamError,
  forgetAgentCanvasWorkspaceTab,
  isRetryEventForCurrentStream,
  pruneAgentCanvasWorkspaceStates,
  rememberAgentCanvasWorkspaceTab,
  sanitizeAgentCanvasWorkspaceState,
  sanitizeAgentCanvasWorkspaceStateMap,
  setActiveAgentCanvasWorkspaceTab,
  type AgentCanvasWorkspaceTab,
  type AgentStreamState,
  type PersistedAgentCanvasWorkspaceState,
} from './agent-atoms'

describe('Agent 右侧画布标签', () => {
  test('Given 动态画布标签 When 解析 Then 只接受非空 canvas ID', () => {
    const source = readFileSync(new URL('./agent-atoms.ts', import.meta.url), 'utf8')

    expect(source).toContain('| `canvas:${string}`')
    expect(source).toContain('export function parseCanvasWorkspaceTab')
    expect(source).toContain("tab.slice('canvas:'.length) || null")
  })

  test('Given 损坏或失效持久化值 When 清洗 Then 只保留有效且去重的具体 Canvas', () => {
    expect(sanitizeAgentCanvasWorkspaceState({
      openTabs: ['canvas', 'files', 'canvas:valid', 'canvas:valid', 'canvas:'],
      activeTab: 'canvas:missing',
    })).toEqual({ openTabs: ['canvas:valid'], activeTab: null })

    expect(sanitizeAgentCanvasWorkspaceState(null)).toEqual({ openTabs: [], activeTab: null })
  })

  test('Given 顶层 localStorage 不是合法 Record When 清洗 Then 坏值降级且不影响其它会话', () => {
    expect(sanitizeAgentCanvasWorkspaceStateMap(['canvas:a'])).toEqual({})
    expect(sanitizeAgentCanvasWorkspaceStateMap({
      'session-a': { openTabs: ['canvas:a'], activeTab: 'canvas:a' },
      'session-empty': { openTabs: 'broken', activeTab: 42 },
    })).toEqual({
      'session-a': { openTabs: ['canvas:a'], activeTab: 'canvas:a' },
    })
  })

  test('Given 打开、切换和关闭 Canvas When 更新持久化状态 Then 标签与活动项保持一致', () => {
    /** 首次打开但尚未成为前台的 Canvas 状态。 */
    const opened = rememberAgentCanvasWorkspaceTab(undefined, 'canvas:a', false)
    /** 用户切换到第二张 Canvas 后的状态。 */
    const activated = rememberAgentCanvasWorkspaceTab(opened, 'canvas:b', true)
    /** 用户切换到普通右侧标签后的状态。 */
    const backgrounded = setActiveAgentCanvasWorkspaceTab(activated, 'files')
    /** 关闭第一张非活动 Canvas 后的状态。 */
    const closedBackground = forgetAgentCanvasWorkspaceTab(backgrounded, 'canvas:a')
    /** 再次激活并关闭最后一张 Canvas 后的状态。 */
    const closedActive = forgetAgentCanvasWorkspaceTab(
      setActiveAgentCanvasWorkspaceTab(closedBackground, 'canvas:b'),
      'canvas:b',
    )

    expect(opened).toEqual({ openTabs: ['canvas:a'], activeTab: null })
    expect(activated).toEqual({ openTabs: ['canvas:a', 'canvas:b'], activeTab: 'canvas:b' })
    expect(backgrounded).toEqual({ openTabs: ['canvas:a', 'canvas:b'], activeTab: null })
    expect(closedBackground).toEqual({ openTabs: ['canvas:b'], activeTab: null })
    expect(closedActive).toEqual({ openTabs: [], activeTab: null })
  })

  test('Given 超过上限的历史会话 When 裁剪 Then 保留最近 50 个并始终保留当前会话', () => {
    /** 由旧到新排列的 51 个普通 Agent 会话。 */
    const sessions = Array.from({ length: 51 }, (_, index) => ({
      id: `session-${index}`,
      updatedAt: index,
    }))
    /** 每个会话各自保存一张已打开 Canvas。 */
    const states: Record<string, PersistedAgentCanvasWorkspaceState> = Object.fromEntries(
      sessions.map((session) => {
        /** 模板字符串在测试边界显式收紧为具体 Canvas 标签。 */
        const canvasTab = `canvas:${session.id}` as AgentCanvasWorkspaceTab
        return [session.id, { openTabs: [canvasTab], activeTab: canvasTab }]
      }),
    )

    const pruned = pruneAgentCanvasWorkspaceStates(states, sessions, 'session-0')

    expect(Object.keys(pruned)).toHaveLength(50)
    expect(pruned['session-0']).toBeDefined()
    expect(pruned['session-1']).toBeUndefined()
    expect(pruned['session-50']).toBeDefined()
  })
})

describe('Agent 会话待插入引用队列', () => {
  test('Given 两个会话各有待插入引用 When 成功后确认其中一个 Then 不串线且同一引用只确认一次', () => {
    const store = createStore()
    /** 会话 A 等待插入的项目素材引用。 */
    const sessionAMention = {
      path: '/project-a/.proma/design/assets/a.png',
      name: 'a.png',
      isDirectory: false,
      scope: 'project' as const,
    }
    /** 会话 B 等待插入的项目素材引用。 */
    const sessionBMention = {
      path: '/project-b/.proma/design/assets/b.png',
      name: 'b.png',
      isDirectory: false,
      scope: 'project' as const,
    }

    store.set(agentPendingMentionsAtomFamily('session-a'), [sessionAMention])
    store.set(agentPendingMentionsAtomFamily('session-b'), [sessionBMention])

    /** AgentView 本次尝试插入的稳定队列引用。 */
    const pendingSessionA = store.get(agentPendingMentionsAtomFamily('session-a'))

    expect(store.set(agentAckPendingMentionsAtom, { sessionId: 'session-a', items: pendingSessionA })).toBe(true)
    expect(store.set(agentAckPendingMentionsAtom, { sessionId: 'session-a', items: pendingSessionA })).toBe(false)
    expect(store.get(agentSessionPendingMentionsAtom)).toEqual(new Map([
      ['session-b', [sessionBMention]],
    ]))
  })

  test('Given 插入使用的不是当前队列引用 When 请求确认 Then 保留队列', () => {
    const store = createStore()
    /** 当前会话真实等待插入的引用。 */
    const pending: FilePanelDragItem[] = [{
      path: '/project/a.png', name: 'a.png', isDirectory: false, scope: 'project',
    }]
    store.set(agentPendingMentionsAtomFamily('session-a'), pending)

    expect(store.set(agentAckPendingMentionsAtom, { sessionId: 'session-a', items: [...pending] })).toBe(false)
    expect(store.get(agentPendingMentionsAtomFamily('session-a'))).toBe(pending)
  })
})

function createStreamState(overrides: Partial<AgentStreamState> = {}): AgentStreamState {
  return {
    running: true,
    inputTokens: 180_000,
    outputTokens: 2_000,
    cacheReadTokens: 160_000,
    cacheCreationTokens: 18_000,
    contextWindow: 200_000,
    ...overrides,
  }
}

describe('Agent 上下文压缩状态', () => {
  test('given Pi 手动压缩提供预估 token when 压缩完成 then 显示预估值并清除旧明细', () => {
    const result = applyAgentEvent(createStreamState(), {
      type: 'compact_complete',
      status: 'success',
      estimatedTokensAfter: 32_000,
    })

    expect(result).toMatchObject({
      isCompacting: false,
      inputTokens: 32_000,
      contextWindow: 200_000,
      contextUsageIsEstimated: true,
    })
    expect(result.outputTokens).toBeUndefined()
    expect(result.cacheReadTokens).toBeUndefined()
    expect(result.cacheCreationTokens).toBeUndefined()
  })

  test('given 压缩后的预估值 when 当前压缩操作的收尾 result 没有 usage then 保留预估状态', () => {
    const compacted = applyAgentEvent(createStreamState(), {
      type: 'compact_complete',
      status: 'success',
      estimatedTokensAfter: 32_000,
    })
    const result = applyAgentEvent(compacted, { type: 'complete' })

    expect(result).toMatchObject({
      inputTokens: 32_000,
      contextUsageIsEstimated: true,
    })
  })

  test('given 压缩后的预估值 when 收到零 token result then 保留预估状态', () => {
    const compacted = applyAgentEvent(createStreamState(), {
      type: 'compact_complete',
      status: 'success',
      estimatedTokensAfter: 32_000,
    })
    const result = applyAgentEvent(compacted, {
      type: 'complete',
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
    })

    expect(result).toMatchObject({
      inputTokens: 32_000,
      contextUsageIsEstimated: true,
    })
  })

  test('given 压缩后的预估值 when 下一轮收到真实 usage then 用真实值覆盖预估状态', () => {
    const compacted = applyAgentEvent(createStreamState(), {
      type: 'compact_complete',
      status: 'success',
      estimatedTokensAfter: 32_000,
    })
    const result = applyAgentEvent(compacted, {
      type: 'usage_update',
      usage: {
        inputTokens: 36_000,
        cacheReadTokens: 30_000,
        outputTokens: 800,
      },
    })

    expect(result).toMatchObject({
      inputTokens: 36_000,
      cacheReadTokens: 30_000,
      outputTokens: 800,
      contextUsageIsEstimated: false,
    })
  })

  test('given 压缩后的预估值 when 下一轮仅在 result 返回 usage then 用真实值覆盖预估状态', () => {
    const compacted = applyAgentEvent(createStreamState(), {
      type: 'compact_complete',
      status: 'success',
      estimatedTokensAfter: 32_000,
    })
    const result = applyAgentEvent(compacted, {
      type: 'complete',
      usage: {
        inputTokens: 40_000,
        cacheReadTokens: 34_000,
      },
    })

    expect(result).toMatchObject({
      inputTokens: 40_000,
      cacheReadTokens: 34_000,
      contextUsageIsEstimated: false,
    })
  })

  test('given 没有 Pi 预估 token 的压缩完成事件 when 处理 then 保持既有上下文用量', () => {
    const result = applyAgentEvent(createStreamState(), { type: 'compact_complete', status: 'success' })

    expect(result).toMatchObject({
      isCompacting: false,
      inputTokens: 180_000,
    })
    expect(result.contextUsageIsEstimated).toBeUndefined()
  })

  test('given 压缩成功 when 同一流开始下一项工具工作 then 清除压缩终态并恢复正常进度', () => {
    const compacting = applyAgentEvent(createStreamState(), { type: 'compacting' })
    const compacted = applyAgentEvent(compacting, { type: 'compact_complete', status: 'success' })
    const resumed = applyAgentEvent(compacted, {
      type: 'tool_start',
      toolName: 'TaskCreate',
      toolUseId: 'resume-task',
      input: {},
    })

    expect(compacted).toMatchObject({
      isCompacting: false,
      compactInFlight: true,
      contextCompaction: { status: 'success' },
    })
    expect(resumed.contextCompaction).toBeUndefined()
    expect(resumed.compactInFlight).toBe(false)
    expect('toolActivities' in resumed).toBe(false)
  })

  test('given 压缩成功 when 当前流直接结束 then 保留终态反馈给短时完成提示', () => {
    const compacting = applyAgentEvent(createStreamState(), { type: 'compacting' })
    const compacted = applyAgentEvent(compacting, { type: 'compact_complete', status: 'success' })
    const result = applyAgentEvent(compacted, { type: 'complete' })

    expect(result).toMatchObject({
      compactInFlight: true,
      contextCompaction: { status: 'success' },
    })
  })
})

describe('Agent retry 状态机', () => {
  const runStartedAt = 1_000
  const retryAttempt = {
    attempt: 8,
    totalAttempt: 8,
    maxTotalAttempts: 8,
    timestamp: 2_000,
    reason: 'TypeError: Failed to fetch',
    errorMessage: 'TypeError: Failed to fetch',
    delaySeconds: 128,
  }

  test('given retry 已安排 when 实际请求尚未开始 then 不把它记入执行历史', () => {
    const scheduled = applyAgentEvent(createStreamState({ startedAt: runStartedAt }), {
      type: 'retrying',
      attempt: 8,
      maxAttempts: 8,
      totalAttempt: 8,
      maxTotalAttempts: 8,
      runStartedAt,
      scheduledAt: 1_500,
      delaySeconds: 128,
      reason: 'TypeError: Failed to fetch',
    })

    expect(scheduled.retrying).toMatchObject({
      phase: 'scheduled',
      currentAttempt: 8,
      maxAttempts: 8,
      history: [],
    })
  })

  test('given 第 8 次 retry 已实际开始且最终耗尽 when 更新终态 then 历史不重复追加第 8 项', () => {
    const started = applyAgentEvent(createStreamState({ startedAt: runStartedAt }), {
      type: 'retry_attempt',
      attemptData: retryAttempt,
      runStartedAt,
      maxAttempts: 8,
      totalAttempt: 8,
      maxTotalAttempts: 8,
    })
    const exhausted = applyAgentEvent(started, {
      type: 'retry_failed',
      finalAttempt: { ...retryAttempt, errorMessage: '最终请求仍然失败', reason: '最终请求仍然失败' },
      runStartedAt,
      maxAttempts: 8,
      totalAttempt: 8,
      maxTotalAttempts: 8,
    })

    expect(exhausted.retrying).toMatchObject({ phase: 'exhausted', currentAttempt: 8 })
    expect(exhausted.retrying?.history).toHaveLength(1)
    expect(exhausted.retrying?.history[0]).toMatchObject({ attempt: 8, timestamp: 2_000, reason: '最终请求仍然失败' })
  })

  test('given retry 成功 when 后续工具调用到达 then 成功状态被自然收起', () => {
    const running = applyAgentEvent(createStreamState({ startedAt: runStartedAt }), {
      type: 'retry_attempt',
      attemptData: retryAttempt,
      runStartedAt,
      maxAttempts: 8,
    })
    const succeeded = applyAgentEvent(running, {
      type: 'retry_cleared',
      runStartedAt,
      attempt: 8,
      maxAttempts: 8,
    })

    expect(succeeded.retrying?.phase).toBe('succeeded')
    expect(applyAgentEvent(succeeded, {
      type: 'tool_start',
      toolName: 'Read',
      toolUseId: 'resume-read',
      input: {},
    }).retrying).toBeUndefined()
  })

  test('given legacy text delta when the runtime reducer receives it then it does not duplicate the live transcript', () => {
    const state = createStreamState()

    expect(applyAgentEvent(state, { type: 'text_delta', text: '只由 live SDKMessage 渲染' })).toBe(state)
  })

  test('given 旧 run 的 retry 终态 when 新流已经开始 then 忽略迟到事件', () => {
    const current = createStreamState({ startedAt: runStartedAt + 1 })
    expect(applyAgentEvent(current, {
      type: 'retry_cancelled',
      runStartedAt,
      attempt: 1,
      maxAttempts: 8,
      reason: 'Retry cancelled',
    })).toBe(current)
  })

  test('given 带 run 标识的 retry 事件 when 流式状态缺少同一 startedAt then 严格拒绝它', () => {
    expect(isRetryEventForCurrentStream(createStreamState(), { runStartedAt })).toBe(false)
  })

  test('given retry 终态或错误 when STREAM_COMPLETE 尚未到达 then 不提前释放运行锁', () => {
    const exhausted = applyAgentEvent(createStreamState({ startedAt: runStartedAt }), {
      type: 'retry_failed',
      finalAttempt: retryAttempt,
      runStartedAt,
      maxAttempts: 8,
    })
    const cancelled = applyAgentEvent(createStreamState({ startedAt: runStartedAt }), {
      type: 'retry_cancelled',
      runStartedAt,
      attempt: 1,
      maxAttempts: 8,
      reason: 'Retry cancelled',
    })

    expect(exhausted.running).toBe(true)
    expect(cancelled.running).toBe(true)
    expect(applyAgentEvent(createStreamState(), { type: 'error', message: '终态错误' }).running).toBe(true)
  })
})

describe('Agent 流式错误状态', () => {
  test('given Pi 原生重试成功 when 清理会话错误 then 仅移除该会话的过期记录', () => {
    const errors = new Map([
      ['retried-session', '服务繁忙'],
      ['failed-session', '认证失败'],
    ])

    expect(clearAgentStreamError(errors, 'retried-session')).toEqual(new Map([
      ['failed-session', '认证失败'],
    ]))
  })

  test('given 当前会话没有流式错误 when 清理 then 保持原 Map 引用', () => {
    const errors = new Map([['failed-session', '认证失败']])

    expect(clearAgentStreamError(errors, 'retried-session')).toBe(errors)
  })
})

describe('Agent per-session 流式状态 family', () => {
  test('given another session changes when the active family is subscribed then it does not notify', () => {
    const store = createStore()
    const activeAtom = agentSessionStreamingStateAtomFamily('active-session')
    const otherAtom = agentSessionStreamingStateAtomFamily('other-session')
    const activeState = createStreamState()
    const otherState = createStreamState({ inputTokens: 20_000 })

    store.set(activeAtom, activeState)
    store.set(otherAtom, otherState)
    store.get(activeAtom)

    let notifications = 0
    const unsubscribe = store.sub(activeAtom, () => {
      notifications += 1
    })

    store.set(otherAtom, { ...otherState, inputTokens: 21_000 })

    expect(notifications).toBe(0)
    expect(store.get(agentStreamingStatesAtom).get('active-session')).toBe(activeState)
    expect(store.get(agentStreamingStatesAtom).get('other-session')?.inputTokens).toBe(21_000)
    unsubscribe()
  })

  test('given a session family update when the aggregate compatibility atom is read then it reflects the same state reference', () => {
    const store = createStore()
    const state = createStreamState({ running: true })
    store.set(agentSessionStreamingStateAtomFamily('active-session'), state)

    expect(store.get(agentStreamingStatesAtom)).toEqual(new Map([['active-session', state]]))
  })
})


describe('Agent 输入流状态订阅隔离', () => {
  test('given usage changes in the active session when the input selector is subscribed then it does not notify', () => {
    const store = createStore()
    const inputStateAtom = agentSessionInputStreamStateAtomFamily('active-session')
    const runningState = createStreamState({ inputTokens: 10_000 })
    store.set(agentStreamingStatesAtom, new Map([['active-session', runningState]]))
    store.get(inputStateAtom)

    let notifications = 0
    const unsubscribe = store.sub(inputStateAtom, () => {
      notifications += 1
    })

    store.set(agentStreamingStatesAtom, new Map([[
      'active-session',
      { ...runningState, inputTokens: 12_000, outputTokens: 900 },
    ]]))

    expect(notifications).toBe(0)
    unsubscribe()
  })

  test('given another session changes when the input selector is subscribed then it does not notify', () => {
    const store = createStore()
    const inputStateAtom = agentSessionInputStreamStateAtomFamily('active-session')
    const activeState = createStreamState()
    const otherState = createStreamState({ inputTokens: 20_000 })
    store.set(agentStreamingStatesAtom, new Map([
      ['active-session', activeState],
      ['other-session', otherState],
    ]))
    store.get(inputStateAtom)

    let notifications = 0
    const unsubscribe = store.sub(inputStateAtom, () => {
      notifications += 1
    })

    store.set(agentStreamingStatesAtom, new Map([
      ['active-session', activeState],
      ['other-session', { ...otherState, inputTokens: 21_000 }],
    ]))

    expect(notifications).toBe(0)
    unsubscribe()
  })
})
