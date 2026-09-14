import { describe, expect, test } from 'bun:test'
import type {
  AskUserRequest,
  ExitPlanModeRequest,
  PendingRequestsSnapshot,
  PermissionRequest,
} from '@proma/shared'
import { createStore } from 'jotai'
import {
  allPendingAskUserRequestsAtom,
  allPendingExitPlanRequestsAtom,
  allPendingPermissionRequestsAtom,
  askUserDraftsAtom,
} from '@/atoms/agent-atoms'
import { createPendingRequestRecoveryCoordinator } from './agent-pending-request-recovery'

/** 构造权限请求测试数据。 */
function createPermission(requestId: string, sessionId: string): PermissionRequest {
  return {
    requestId,
    sessionId,
    toolName: 'Bash',
    toolInput: { command: 'bun test' },
    description: '运行测试',
    dangerLevel: 'normal',
  }
}

/** 构造 AskUser 请求测试数据。 */
function createAskUser(requestId: string, sessionId: string): AskUserRequest {
  return {
    requestId,
    sessionId,
    questions: [{ question: '继续吗？', options: [{ label: '继续' }] }],
    toolInput: {},
  }
}

/** 构造退出计划审批请求测试数据。 */
function createExitPlan(requestId: string, sessionId: string): ExitPlanModeRequest {
  return { requestId, sessionId, toolInput: {}, allowedPrompts: [] }
}

/** 创建可由测试精确控制完成时机的 Promise。 */
function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolvePromise: ((value: T) => void) | undefined
  const promise = new Promise<T>((resolve) => { resolvePromise = resolve })
  return {
    promise,
    resolve: (value) => {
      if (!resolvePromise) throw new Error('DEFERRED_RESOLVER_MISSING')
      resolvePromise(value)
    },
  }
}

describe('Agent 待处理交互请求恢复', () => {
  test('Given Renderer 重载且主进程仍有三类请求 When 读取一次快照 Then 按会话恢复全部横幅状态', async () => {
    const store = createStore()
    const coordinator = createPendingRequestRecoveryCoordinator(store, {
      loadSnapshot: async () => ({
        permissions: [createPermission('permission-1', 'session-1')],
        askUsers: [createAskUser('ask-1', 'session-2')],
        exitPlans: [createExitPlan('exit-1', 'session-3')],
      }),
    })

    await coordinator.start()

    expect(store.get(allPendingPermissionRequestsAtom).get('session-1')?.map(({ requestId }) => requestId))
      .toEqual(['permission-1'])
    expect(store.get(allPendingAskUserRequestsAtom).get('session-2')?.map(({ requestId }) => requestId))
      .toEqual(['ask-1'])
    expect(store.get(allPendingExitPlanRequestsAtom).get('session-3')?.map(({ requestId }) => requestId))
      .toEqual(['exit-1'])
  })

  test('Given 快照读取期间收到实时请求、resolved 与会话终态 When 快照迟到 Then 保留新请求且不复活旧请求', async () => {
    const store = createStore()
    const deferred = createDeferred<PendingRequestsSnapshot>()
    const coordinator = createPendingRequestRecoveryCoordinator(store, { loadSnapshot: () => deferred.promise })
    const startPromise = coordinator.start()

    coordinator.handle('session-live', {
      type: 'permission_request', request: createPermission('permission-live', 'session-live'),
    })
    coordinator.handle('session-live', {
      type: 'ask_user_request', request: createAskUser('ask-live', 'session-live'),
    })
    coordinator.handle('session-live', {
      type: 'exit_plan_mode_request', request: createExitPlan('exit-live', 'session-live'),
    })
    coordinator.handle('session-old', { type: 'permission_resolved', requestId: 'permission-old', behavior: 'allow' })
    coordinator.handle('session-old', { type: 'ask_user_resolved', requestId: 'ask-old' })
    coordinator.handle('session-old', { type: 'exit_plan_mode_resolved', requestId: 'exit-old' })
    coordinator.completeSession('session-terminal')

    deferred.resolve({
      permissions: [
        createPermission('permission-old', 'session-old'),
        createPermission('permission-terminal', 'session-terminal'),
      ],
      askUsers: [createAskUser('ask-old', 'session-old')],
      exitPlans: [createExitPlan('exit-old', 'session-old')],
    })
    await startPromise

    expect(store.get(allPendingPermissionRequestsAtom).get('session-live')?.map(({ requestId }) => requestId))
      .toEqual(['permission-live'])
    expect(store.get(allPendingAskUserRequestsAtom).get('session-live')?.map(({ requestId }) => requestId))
      .toEqual(['ask-live'])
    expect(store.get(allPendingExitPlanRequestsAtom).get('session-live')?.map(({ requestId }) => requestId))
      .toEqual(['exit-live'])
    expect(store.get(allPendingPermissionRequestsAtom).has('session-old')).toBe(false)
    expect(store.get(allPendingAskUserRequestsAtom).has('session-old')).toBe(false)
    expect(store.get(allPendingExitPlanRequestsAtom).has('session-old')).toBe(false)
    expect(store.get(allPendingPermissionRequestsAtom).has('session-terminal')).toBe(false)
  })

  test('Given AskUser 草稿与三类实时请求 When 请求解决或会话结束 Then 清理请求和对应草稿', async () => {
    const store = createStore()
    const coordinator = createPendingRequestRecoveryCoordinator(store, {
      loadSnapshot: async () => ({ permissions: [], askUsers: [], exitPlans: [] }),
    })
    await coordinator.start()
    coordinator.handle('session-1', {
      type: 'permission_request', request: createPermission('permission-1', 'session-1'),
    })
    coordinator.handle('session-1', {
      type: 'ask_user_request', request: createAskUser('ask-1', 'session-1'),
    })
    coordinator.handle('session-1', {
      type: 'exit_plan_mode_request', request: createExitPlan('exit-1', 'session-1'),
    })
    store.set(askUserDraftsAtom, new Map([['ask-1', { activeTab: 0, focusedOptIdx: 0, answers: new Map() }]]))

    coordinator.handle('session-1', { type: 'ask_user_resolved', requestId: 'ask-1' })
    expect(store.get(allPendingAskUserRequestsAtom).has('session-1')).toBe(false)
    expect(store.get(askUserDraftsAtom).has('ask-1')).toBe(false)
    coordinator.completeSession('session-1')

    expect(store.get(allPendingPermissionRequestsAtom).has('session-1')).toBe(false)
    expect(store.get(allPendingExitPlanRequestsAtom).has('session-1')).toBe(false)
  })

  test('Given 快照仍在读取 When coordinator 已销毁 Then 迟到结果不回写 Renderer', async () => {
    const store = createStore()
    const deferred = createDeferred<PendingRequestsSnapshot>()
    const coordinator = createPendingRequestRecoveryCoordinator(store, { loadSnapshot: () => deferred.promise })
    const startPromise = coordinator.start()
    coordinator.dispose()

    deferred.resolve({
      permissions: [createPermission('permission-late', 'session-1')],
      askUsers: [],
      exitPlans: [],
    })
    await startPromise

    expect(store.get(allPendingPermissionRequestsAtom).size).toBe(0)
  })

  test('Given 旧快照与读取期间的新请求同属一会话 When 合并 Then 保持旧请求在前且实时同 ID 正文优先', async () => {
    const store = createStore()
    const deferred = createDeferred<PendingRequestsSnapshot>()
    const coordinator = createPendingRequestRecoveryCoordinator(store, { loadSnapshot: () => deferred.promise })
    const startPromise = coordinator.start()
    const liveReplacement = createAskUser('ask-same', 'session-1')
    liveReplacement.questions[0] = { question: '实时正文', options: [] }
    coordinator.handle('session-1', { type: 'ask_user_request', request: liveReplacement })
    coordinator.handle('session-1', {
      type: 'ask_user_request', request: createAskUser('ask-new', 'session-1'),
    })

    const staleDuplicate = createAskUser('ask-same', 'session-1')
    staleDuplicate.questions[0] = { question: '快照旧正文', options: [] }
    deferred.resolve({
      permissions: [],
      askUsers: [createAskUser('ask-old', 'session-1'), staleDuplicate],
      exitPlans: [],
    })
    await startPromise

    const restored = store.get(allPendingAskUserRequestsAtom).get('session-1') ?? []
    expect(restored.map(({ requestId }) => requestId)).toEqual(['ask-old', 'ask-same', 'ask-new'])
    expect(restored[1]?.questions[0]?.question).toBe('实时正文')
  })

  test('Given preload 同步抛错 When 启动恢复 Then 交给错误处理且释放快照竞态状态', async () => {
    const store = createStore()
    const expectedError = new Error('PRELOAD_UNAVAILABLE')
    let observedError: unknown
    const coordinator = createPendingRequestRecoveryCoordinator(store, {
      loadSnapshot: () => { throw expectedError },
      onError: (error) => { observedError = error },
    })

    await coordinator.start()
    coordinator.handle('session-1', { type: 'ask_user_resolved', requestId: 'ask-reused' })
    coordinator.handle('session-1', {
      type: 'ask_user_request', request: createAskUser('ask-reused', 'session-1'),
    })

    expect(observedError).toBe(expectedError)
    expect(store.get(allPendingAskUserRequestsAtom).get('session-1')?.map(({ requestId }) => requestId))
      .toEqual(['ask-reused'])
  })
})
