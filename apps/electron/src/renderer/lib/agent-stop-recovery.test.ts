import { describe, expect, test } from 'bun:test'
import { createStore } from 'jotai'
import type { AgentStopResult, PendingRequestsSnapshot } from '@proma/shared'
import {
  agentMessageRefreshAtom,
  agentSessionStreamingStateAtomFamily,
  agentSessionDraftsAtom,
  allPendingAskUserRequestsAtom,
  allPendingPermissionRequestsAtom,
  allPendingExitPlanRequestsAtom,
  askUserDraftsAtom,
  liveMessagesMapAtom,
} from '@/atoms/agent-atoms'
import { stopAgentWithRecovery } from './agent-stop-recovery'
import { createPendingRequestRecoveryCoordinator } from './agent-pending-request-recovery'
import { agentTerminalRunMarkersAtom, mergeActiveAgentSessionSnapshot } from './agent-active-session-snapshot'

/** 建立丢失 STREAM_COMPLETE 的同一轮状态，不触碰真实客户端。 */
function createFixture() {
  /** 每例使用独立 Jotai store，避免状态跨测试泄漏。 */
  const store = createStore()
  store.set(agentSessionStreamingStateAtomFamily('session-1'), { running: true, startedAt: 100, runGeneration: 1 })
  store.set(agentSessionDraftsAtom, new Map([['session-1', '尚未发送的内容']]))
  store.set(allPendingAskUserRequestsAtom, new Map([['session-1', [{
    requestId: 'question-1', sessionId: 'session-1', questions: [], toolInput: {},
  }]]]))
  return store
}

describe('停止回执恢复丢失的 Agent 终态', () => {
  test('Given 完成通知丢失 When 后台确认已无在途运行 Then 释放界面并刷新消息，保留输入草稿', async () => {
    /** 模拟正在卡住的 renderer 状态。 */
    const store = createFixture()
    /** 消息交接前的原引用必须保留，避免恢复时气泡闪空。 */
    const messages = store.get(liveMessagesMapAtom)
    expect(await stopAgentWithRecovery(store, 'session-1', async () => ({ status: 'stopped' }))).toBe(true)
    expect(store.get(agentSessionStreamingStateAtomFamily('session-1'))).toMatchObject({ running: false, backgroundWaiting: false })
    expect(store.get(agentMessageRefreshAtom).get('session-1')).toBe(1)
    expect(store.get(allPendingAskUserRequestsAtom).has('session-1')).toBe(false)
    expect(store.get(agentSessionDraftsAtom).get('session-1')).toBe('尚未发送的内容')
    expect(store.get(liveMessagesMapAtom)).toBe(messages)
  })

  test.each([{ status: 'stopping' } as const, undefined])('Given 后台仍收尾或旧客户端没有回执 When 停止返回 %j Then 保持运行锁', async (result) => {
    /** 尚不能证明已结束的运行。 */
    const store = createFixture()
    expect(await stopAgentWithRecovery(store, 'session-1', async () => result)).toBe(false)
    expect(store.get(agentSessionStreamingStateAtomFamily('session-1'))?.running).toBe(true)
    expect(store.get(agentMessageRefreshAtom).has('session-1')).toBe(false)
  })

  test('Given 旧停止回执延迟 When 同毫秒的新代际已经启动 Then 不清新任务及其问答', async () => {
    /** 原任务与稍后启动的新任务共用会话。 */
    const store = createFixture()
    /** 可控制的 IPC 回执，用于复现跨代际竞态。 */
    let finish!: (result: AgentStopResult) => void
    /** 尚未返回的停止请求。 */
    const pending = stopAgentWithRecovery(store, 'session-1', () => new Promise((resolve) => { finish = resolve }))
    store.set(agentSessionStreamingStateAtomFamily('session-1'), { running: true, startedAt: 100, runGeneration: 2 })
    finish({ status: 'stopped' })
    expect(await pending).toBe(false)
    expect(store.get(agentSessionStreamingStateAtomFamily('session-1'))?.running).toBe(true)
    expect(store.get(allPendingAskUserRequestsAtom).has('session-1')).toBe(true)
  })

  test('Given 重载快照仍在途 When 停止已确认后旧快照返回 Then 不复活旧横幅且保留新请求和其他会话', async () => {
    /** 同一轮在主进程已结束，但 Renderer 还保留运行标记。 */
    const store = createFixture()
    /** 控制旧快照返回时间，复现 reload 与停止交错。 */
    let resolveSnapshot!: (snapshot: PendingRequestsSnapshot) => void
    /** 正在等待读取结果的真实启动恢复器。 */
    const coordinator = createPendingRequestRecoveryCoordinator(store, {
      loadSnapshot: () => new Promise((resolve) => { resolveSnapshot = resolve }),
    })
    /** start 的微任务先进入 loadSnapshot。 */
    const bootstrap = coordinator.start()
    await Promise.resolve()
    store.set(askUserDraftsAtom, new Map([['question-1', { activeTab: 0, focusedOptIdx: 0, answers: new Map() }]]))
    await stopAgentWithRecovery(store, 'session-1', async () => ({ status: 'stopped' }))
    coordinator.handle('session-1', {
      type: 'ask_user_request', request: { requestId: 'new-question', sessionId: 'session-1', questions: [], toolInput: {} },
    })
    resolveSnapshot({
      permissions: [{ requestId: 'old-permission', sessionId: 'session-1', toolName: 'Bash', toolInput: {}, description: '旧审批', dangerLevel: 'normal' }],
      askUsers: [
        { requestId: 'old-question', sessionId: 'session-1', questions: [], toolInput: {} },
        { requestId: 'other-question', sessionId: 'session-2', questions: [], toolInput: {} },
      ],
      exitPlans: [{ requestId: 'old-plan', sessionId: 'session-1', toolInput: {}, allowedPrompts: [] }],
    })
    await bootstrap
    expect(store.get(allPendingPermissionRequestsAtom).has('session-1')).toBe(false)
    expect(store.get(allPendingExitPlanRequestsAtom).has('session-1')).toBe(false)
    expect(store.get(allPendingAskUserRequestsAtom).get('session-1')?.map((request) => request.requestId)).toEqual(['new-question'])
    expect(store.get(allPendingAskUserRequestsAtom).get('session-2')?.map((request) => request.requestId)).toEqual(['other-question'])
    expect(store.get(askUserDraftsAtom).has('question-1')).toBe(false)
    coordinator.dispose()
  })

  test('Given 停止后的消息交接已清理展示状态 When 迟到的运行快照返回 Then 不重新显示运行中', async () => {
    /** 模拟当前截图中的丢失终态场景。 */
    const store = createFixture()
    await stopAgentWithRecovery(store, 'session-1', async () => ({ status: 'stopped' }))
    // AgentView 完成 JSONL 消息交接后可能移除流式展示状态。
    store.set(agentSessionStreamingStateAtomFamily('session-1'), undefined)
    /** 重载时已经取到但较晚抵达的旧运行快照。 */
    const restored = mergeActiveAgentSessionSnapshot(
      store.get(agentSessionStreamingStateAtomFamily('session-1')),
      { sessionId: 'session-1', startedAt: 100, runGeneration: 1 },
      store.get(agentTerminalRunMarkersAtom).get('session-1'),
    )
    expect(restored?.running ?? false).toBe(false)
  })

  test('Given 停止 IPC 拒绝 When 用户重试前 Then 不伪造已停止', async () => {
    /** 未得到后台确认的运行。 */
    const store = createFixture()
    await expect(stopAgentWithRecovery(store, 'session-1', async () => { throw new Error('IPC unavailable') })).rejects.toThrow('IPC unavailable')
    expect(store.get(agentSessionStreamingStateAtomFamily('session-1'))?.running).toBe(true)
  })

  test('Given 普通完成通知已先收口 When 迟到停止回执到达 Then 不重复刷新', async () => {
    /** 已通过正常完成路径释放的运行。 */
    const store = createFixture()
    expect(await stopAgentWithRecovery(store, 'session-1', async () => {
      store.set(agentSessionStreamingStateAtomFamily('session-1'), { running: false, startedAt: 100, runGeneration: 1 })
      return { status: 'stopped' }
    })).toBe(false)
    expect(store.get(agentMessageRefreshAtom).has('session-1')).toBe(false)
  })
})
