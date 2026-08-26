import { describe, expect, test } from 'bun:test'
import type { AgentSessionMeta, AgentStreamSessionMeta, CanvasAgentActiveRunSnapshot } from '@proma/shared'
import { createStore } from 'jotai/vanilla'
import {
  canvasAgentAuthoritativeRunningSessionIdsAtom,
  canvasAgentLifecycleAtom,
  canvasAgentOwnersAtom,
  canvasAgentRunGenerationsAtom,
  canvasAgentRunningSessionIdsAtom,
  isCanvasAgentGenerationCurrent,
} from '@/atoms/native-canvas-atoms'
import { agentSessionStreamingStateAtomFamily, liveMessagesMapAtom } from '@/atoms/agent-atoms'
import * as routing from './canvas-agent-event-routing'
import { routeCanvasAgentEvent } from './canvas-agent-event-routing'

/** 可由测试精确控制完成时机的 Promise。 */
function createDeferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} {
  /** 由 Promise executor 同步赋值的成功回调。 */
  let resolvePromise!: (value: T) => void
  /** 由 Promise executor 同步赋值的失败回调。 */
  let rejectPromise!: (error: unknown) => void
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  return { promise, resolve: resolvePromise, reject: rejectPromise }
}

/** coordinator 测试使用的最小生命周期事件。 */
interface CoordinatorEvent {
  type: 'run-started' | 'token' | 'complete'
  sessionId: string
  startedAt: number
  session?: AgentStreamSessionMeta
}

/** coordinator 的可注入 API 合同。 */
interface CoordinatorOptions {
  loadSnapshot: () => Promise<CanvasAgentActiveRunSnapshot>
  applySnapshot: (snapshot: CanvasAgentActiveRunSnapshot) => void
  classify: (event: CoordinatorEvent) => routing.CanvasAgentBootstrapEventKind
  dispatch: (event: CoordinatorEvent) => void
  allowUnknownAfterReady?: (event: CoordinatorEvent) => boolean
  allowInternalInvalid?: (event: CoordinatorEvent) => boolean
  isTerminalEvent?: (event: CoordinatorEvent) => boolean
  onError?: (error: unknown) => void
}

/** coordinator 的生命周期控制面。 */
interface Coordinator {
  handle: (event: CoordinatorEvent) => void
  start: () => Promise<void>
  dispose: () => void
}

/** 测试动态探测 coordinator 导出时使用的精确构造签名。 */
type CreateCoordinator = (options: CoordinatorOptions) => Coordinator

/** 创建用于事件路由的完整 Canvas owner 元数据。 */
function createCanvasSession(overrides: Partial<AgentSessionMeta> = {}): AgentSessionMeta {
  return {
    id: 'session-1',
    title: 'Canvas Agent',
    workspaceId: 'project-1',
    sourceCanvasProjectId: 'project-1',
    sourceCanvasId: 'canvas-1',
    sourceCanvasNodeId: 'node-1',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

describe('Canvas Agent 全局事件路由', () => {
  test('Given 旧 Renderer SEND reconcile pending When 新 Renderer 空 snapshot 后收到 run_started 与 completion Then Canvas 终态完整收口', async () => {
    /** 待实现的 bootstrap-listener coordinator，动态读取用于先观察 RED。 */
    const createCoordinator = (routing as unknown as {
      createCanvasAgentBootstrapCoordinator?: CreateCoordinator
    }).createCanvasAgentBootstrapCoordinator
    expect(createCoordinator).toBeFunction()
    if (!createCoordinator) return

    const store = createStore()
    const snapshot = createDeferred<CanvasAgentActiveRunSnapshot>()
    const session = createCanvasSession({ id: 'reload-canvas' })
    /** 普通 Agent 分支副作用，可信 Canvas 生命周期中必须始终为零。 */
    const ordinaryEffects = { listUpserts: 0, toasts: 0 }
    const classify = (event: CoordinatorEvent): routing.CanvasAgentBootstrapEventKind => {
      if (event.session) return routing.resolveCanvasAgentCompletion(event.sessionId, event.session).kind
      if (store.get(canvasAgentOwnersAtom).has(event.sessionId)) return 'canvas'
      return 'unknown'
    }
    const coordinator = createCoordinator({
      loadSnapshot: () => snapshot.promise,
      applySnapshot: (value) => store.set(canvasAgentLifecycleAtom, { type: 'bootstrap', ...value }),
      classify,
      dispatch: (event) => {
        /** metadata 事件使用完整 route；无 metadata token 只读取当前 kind。 */
        const route = event.session
          ? routing.resolveCanvasAgentCompletion(event.sessionId, event.session)
          : undefined
        const kind = route?.kind ?? classify(event)
        if (event.type === 'run-started' && route?.kind === 'canvas') {
          store.set(canvasAgentLifecycleAtom, { type: 'started', owner: route.owner, startedAt: event.startedAt })
          store.set(liveMessagesMapAtom, new Map([[event.sessionId, []]]))
          store.set(agentSessionStreamingStateAtomFamily(event.sessionId), {
            sessionId: event.sessionId,
            running: true,
            startedAt: event.startedAt,
            lastActivityAt: event.startedAt,
          })
          return
        }
        if (event.type === 'token' && kind === 'canvas') return
        if (event.type === 'complete' && route?.kind === 'canvas'
          && isCanvasAgentGenerationCurrent(store, event.sessionId, event.startedAt)) {
          store.set(canvasAgentLifecycleAtom, {
            type: 'completed', sessionId: event.sessionId, startedAt: event.startedAt,
          })
          return
        }
        if (kind === 'agent') {
          ordinaryEffects.listUpserts += 1
          ordinaryEffects.toasts += 1
        }
      },
      allowUnknownAfterReady: () => false,
      isTerminalEvent: (event) => event.type === 'complete',
    })
    const started = coordinator.start()
    coordinator.handle({ type: 'run-started', sessionId: session.id, startedAt: 200, session })
    coordinator.handle({ type: 'token', sessionId: session.id, startedAt: 200 })
    coordinator.handle({ type: 'complete', sessionId: session.id, startedAt: 200, session })

    snapshot.resolve({ owners: [], internalInvalidRuns: [] })
    await started

    expect(store.get(canvasAgentRunningSessionIdsAtom).has(session.id)).toBe(false)
    expect(store.get(canvasAgentAuthoritativeRunningSessionIdsAtom).has(session.id)).toBe(false)
    expect(store.get(liveMessagesMapAtom).has(session.id)).toBe(false)
    expect(store.get(agentSessionStreamingStateAtomFamily(session.id))).toBeUndefined()
    expect(ordinaryEffects).toEqual({ listUpserts: 0, toasts: 0 })
  })

  test('Given StrictMode 旧 snapshot 晚回 When 新 coordinator 已建立更新代次 Then 旧快照无副作用', async () => {
    const createCoordinator = (routing as unknown as {
      createCanvasAgentBootstrapCoordinator?: CreateCoordinator
    }).createCanvasAgentBootstrapCoordinator
    expect(createCoordinator).toBeFunction()
    if (!createCoordinator) return

    const store = createStore()
    const oldSnapshot = createDeferred<CanvasAgentActiveRunSnapshot>()
    const currentSnapshot = createDeferred<CanvasAgentActiveRunSnapshot>()
    const session = createCanvasSession({ id: 'strict-canvas' })
    /** 构造共享 store 的 coordinator，模拟 StrictMode cleanup 后重新挂载。 */
    const buildCoordinator = (snapshot: ReturnType<typeof createDeferred<CanvasAgentActiveRunSnapshot>>) => (
      createCoordinator({
        loadSnapshot: () => snapshot.promise,
        applySnapshot: (value) => store.set(canvasAgentLifecycleAtom, { type: 'bootstrap', ...value }),
        classify: (event) => event.session
          ? routing.resolveCanvasAgentCompletion(event.sessionId, event.session).kind
          : 'unknown',
        dispatch: (event) => {
          if (event.type !== 'run-started' || !event.session) return
          const route = routing.resolveCanvasAgentCompletion(event.sessionId, event.session)
          if (route.kind === 'canvas') store.set(canvasAgentLifecycleAtom, {
            type: 'started', owner: route.owner, startedAt: event.startedAt,
          })
        },
        allowUnknownAfterReady: () => false,
      })
    )
    const oldCoordinator = buildCoordinator(oldSnapshot)
    const oldStarted = oldCoordinator.start()
    oldCoordinator.dispose()
    const currentCoordinator = buildCoordinator(currentSnapshot)
    const currentStarted = currentCoordinator.start()
    currentCoordinator.handle({ type: 'run-started', sessionId: session.id, startedAt: 200, session })
    currentSnapshot.resolve({ owners: [], internalInvalidRuns: [] })
    await currentStarted

    /** 旧快照携带同 session 的旧代次，必须被已 dispose coordinator 丢弃。 */
    const oldRoute = routing.routeCanvasAgentEvent(session)
    expect(oldRoute.kind).toBe('canvas')
    if (oldRoute.kind !== 'canvas') return
    oldSnapshot.resolve({ owners: [{ ...oldRoute.owner, startedAt: 100 }], internalInvalidRuns: [] })
    await oldStarted

    expect(store.get(canvasAgentRunGenerationsAtom).get(session.id)).toBe(200)
    expect(store.get(canvasAgentRunningSessionIdsAtom).has(session.id)).toBe(true)
  })

  test('Given bootstrap 正常、invalid 或失败 When coordinator 收口 Then 快照生效且未知事件 fail closed', async () => {
    const createCoordinator = (routing as unknown as {
      createCanvasAgentBootstrapCoordinator?: CreateCoordinator
    }).createCanvasAgentBootstrapCoordinator
    expect(createCoordinator).toBeFunction()
    if (!createCoordinator) return

    const store = createStore()
    const invalidSnapshot = createDeferred<CanvasAgentActiveRunSnapshot>()
    const dispatched: string[] = []
    const errors: unknown[] = []
    const coordinator = createCoordinator({
      loadSnapshot: () => invalidSnapshot.promise,
      applySnapshot: (value) => store.set(canvasAgentLifecycleAtom, { type: 'bootstrap', ...value }),
      classify: (event) => store.get(canvasAgentOwnersAtom).has(event.sessionId) ? 'canvas' : 'unknown',
      dispatch: (event) => dispatched.push(event.sessionId),
      allowUnknownAfterReady: () => false,
      onError: (error) => errors.push(error),
    })
    const started = coordinator.start()
    invalidSnapshot.resolve({
      owners: [{ sessionId: 'normal', projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'node-1', title: '正常', startedAt: 10 }],
      internalInvalidRuns: [{ sessionId: 'invalid', startedAt: 20, valid: false }],
    })
    await started

    expect(store.get(canvasAgentOwnersAtom).has('normal')).toBe(true)
    expect(store.get(canvasAgentRunGenerationsAtom).get('normal')).toBe(10)
    expect(store.get(canvasAgentRunGenerationsAtom).get('invalid')).toBe(20)

    const failed = createDeferred<CanvasAgentActiveRunSnapshot>()
    const failedCoordinator = createCoordinator({
      loadSnapshot: () => failed.promise,
      applySnapshot: () => { throw new Error('失败快照不应应用') },
      classify: () => 'unknown',
      dispatch: (event) => dispatched.push(event.sessionId),
      allowUnknownAfterReady: () => false,
      onError: (error) => errors.push(error),
    })
    const failedStarted = failedCoordinator.start()
    failedCoordinator.handle({ type: 'token', sessionId: 'unknown', startedAt: 30 })
    failed.reject(new Error('snapshot failed'))
    await failedStarted

    expect(dispatched).toEqual([])
    expect(errors).toHaveLength(1)
  })

  test('Given bootstrap pending When 未知 stream/title 先到 Then owner 恢复后按原顺序重放且只重放一次', () => {
    /** 待实现的一次性 bootstrap gate，动态读取用于先观察缺失行为。 */
    const createGate = (routing as typeof routing & {
      createCanvasAgentBootstrapGate?: <T extends { sessionId: string }>(options: {
        classify: (event: T) => 'canvas' | 'agent' | 'internal-invalid' | 'unknown'
        dispatch: (event: T) => void
      }) => { handle: (event: T) => void; complete: () => void; fail: () => void }
    }).createCanvasAgentBootstrapGate
    expect(createGate).toBeFunction()
    if (!createGate) return
    /** bootstrap 前后由测试切换的 owner 集合。 */
    const canvasIds = new Set<string>()
    /** 实际进入业务 handler 的事件序列。 */
    const dispatched: string[] = []
    const gate = createGate<{ sessionId: string; kind: 'stream' | 'title' }>({
      classify: (event) => canvasIds.has(event.sessionId) ? 'canvas' : 'unknown',
      dispatch: (event) => dispatched.push(event.kind),
    })
    gate.handle({ sessionId: 'canvas-session', kind: 'stream' })
    gate.handle({ sessionId: 'canvas-session', kind: 'title' })
    expect(dispatched).toEqual([])

    canvasIds.add('canvas-session')
    gate.complete()
    gate.complete()
    expect(dispatched).toEqual(['stream', 'title'])
  })

  test('Given bootstrap 失败 When 未知内部事件到达 Then fail closed 且已知普通事件仍可处理', () => {
    /** 使用同一 gate 合同验证失败态不泄漏未知 Canvas。 */
    const createGate = (routing as typeof routing & {
      createCanvasAgentBootstrapGate?: <T extends { sessionId: string }>(options: {
        classify: (event: T) => 'canvas' | 'agent' | 'internal-invalid' | 'unknown'
        dispatch: (event: T) => void
      }) => { handle: (event: T) => void; complete: () => void; fail: () => void }
    }).createCanvasAgentBootstrapGate
    expect(createGate).toBeFunction()
    if (!createGate) return
    /** 记录失败后仍被允许的普通事件。 */
    const dispatched: string[] = []
    const gate = createGate<{ sessionId: string }>({
      classify: (event) => event.sessionId === 'ordinary' ? 'agent' : 'unknown',
      dispatch: (event) => dispatched.push(event.sessionId),
    })
    gate.fail()
    gate.handle({ sessionId: 'unknown' })
    gate.handle({ sessionId: 'ordinary' })
    expect(dispatched).toEqual(['ordinary'])
  })

  test('Given completion 缺少 metadata When bootstrap 完成或失败 Then 未知会话始终禁止普通分发', () => {
    /** completion 未知态在 ready 后也必须 fail closed，不能降级成普通 Agent。 */
    const dispatched: string[] = []
    const readyGate = routing.createCanvasAgentBootstrapGate<{ sessionId: string; type: 'complete' }>({
      classify: () => 'unknown',
      dispatch: (event) => dispatched.push(event.sessionId),
      allowUnknownAfterReady: () => false,
    })
    readyGate.handle({ sessionId: 'canvas-early-error', type: 'complete' })
    readyGate.complete()
    readyGate.handle({ sessionId: 'canvas-after-bootstrap', type: 'complete' })

    const failedGate = routing.createCanvasAgentBootstrapGate<{ sessionId: string; type: 'complete' }>({
      classify: () => 'unknown',
      dispatch: (event) => dispatched.push(event.sessionId),
      allowUnknownAfterReady: () => false,
    })
    failedGate.handle({ sessionId: 'canvas-before-failure', type: 'complete' })
    failedGate.fail()
    failedGate.handle({ sessionId: 'canvas-after-failure', type: 'complete' })
    expect(dispatched).toEqual([])
  })

  test('Given bootstrap 恢复 active invalid When completion 重放 Then 进入内部终态而非普通通知', () => {
    /** active invalid completion 允许进入内部清理 handler，但不能进入普通 Agent handler。 */
    const invalidIds = new Set<string>()
    const dispatchedKinds: routing.CanvasAgentBootstrapEventKind[] = []
    const gate = routing.createCanvasAgentBootstrapGate<{ sessionId: string; type: 'complete' }>({
      classify: (event) => invalidIds.has(event.sessionId) ? 'internal-invalid' : 'unknown',
      dispatch: (event) => dispatchedKinds.push(invalidIds.has(event.sessionId) ? 'internal-invalid' : 'unknown'),
      allowUnknownAfterReady: () => false,
      allowInternalInvalid: (event) => event.type === 'complete',
    })
    gate.handle({ sessionId: 'active-invalid', type: 'complete' })
    invalidIds.add('active-invalid')
    gate.complete()
    expect(dispatchedKinds).toEqual(['internal-invalid'])
  })

  test('Given max 为 3 且 token 与 completion 交错 When bootstrap 恢复 Then completion 不被 token 洪水淘汰', () => {
    /** bootstrap 恢复后所有测试会话都成为普通 Agent。 */
    let ready = false
    /** 模拟普通终态清理：completion 必须移除对应 running lifecycle。 */
    const runningIds = new Set(['session-1', 'session-2', 'session-3'])
    /** 记录重放顺序，要求每个 session 的 stream 先于 completion。 */
    const dispatched: string[] = []
    interface BufferedEvent {
      sessionId: string
      type: 'stream' | 'complete'
    }
    const gate = routing.createCanvasAgentBootstrapGate<BufferedEvent>({
      classify: () => ready ? 'agent' : 'unknown',
      dispatch: (event) => {
        dispatched.push(`${event.sessionId}:${event.type}`)
        if (event.type === 'complete') runningIds.delete(event.sessionId)
      },
      maxBufferedEvents: 3,
      isTerminalEvent: (event) => event.type === 'complete',
    })

    for (let index = 1; index <= 3; index += 1) {
      gate.handle({ sessionId: `session-${index}`, type: 'complete' })
      gate.handle({ sessionId: `session-${index}`, type: 'stream' })
    }
    ready = true
    gate.complete()

    expect(dispatched).toEqual([
      'session-1:stream', 'session-2:stream', 'session-3:stream',
      'session-1:complete', 'session-2:complete', 'session-3:complete',
    ])
    expect(runningIds.size).toBe(0)
  })

  test('Given run_started 后出现 token 洪峰 When bootstrap 恢复 Then 启动先于流与终态重放', () => {
    /** run_started 是建立 owner 与 generation 的权威事实，不能被普通流事件淘汰。 */
    let ownerReady = false
    let completed = false
    const dispatched: string[] = []
    interface BufferedEvent {
      sessionId: string
      type: 'run-started' | 'token' | 'complete'
    }
    const gate = routing.createCanvasAgentBootstrapGate<BufferedEvent>({
      classify: (event) => event.type === 'run-started' || ownerReady ? 'canvas' : 'unknown',
      dispatch: (event) => {
        dispatched.push(event.type)
        if (event.type === 'run-started') ownerReady = true
        if (event.type === 'complete' && ownerReady) completed = true
      },
      maxBufferedEvents: 3,
      deferNonAgentWhilePending: true,
      isStartEvent: (event) => event.type === 'run-started',
      isTerminalEvent: (event) => event.type === 'complete',
    })

    gate.handle({ sessionId: 'canvas-session', type: 'run-started' })
    for (let index = 0; index < 5; index += 1) {
      gate.handle({ sessionId: 'canvas-session', type: 'token' })
    }
    gate.handle({ sessionId: 'canvas-session', type: 'complete' })
    gate.complete()

    expect(dispatched).toEqual(['run-started', 'token', 'token', 'token', 'complete'])
    expect(completed).toBe(true)
  })

  test('Given 同一 Canvas error 与 completion 在 bootstrap pending When owner 恢复 Then 两类关键事件都重放', () => {
    let ready = false
    const dispatched: string[] = []
    interface BufferedEvent {
      sessionId: string
      type: 'error' | 'complete'
    }
    const gate = routing.createCanvasAgentBootstrapGate<BufferedEvent>({
      classify: () => ready ? 'canvas' : 'unknown',
      dispatch: (event) => dispatched.push(event.type),
      maxBufferedEvents: 2,
      isTerminalEvent: () => true,
      getTerminalEventKey: (event) => `${event.type}:${event.sessionId}`,
    })
    gate.handle({ sessionId: 'canvas-session', type: 'error' })
    gate.handle({ sessionId: 'canvas-session', type: 'complete' })
    ready = true
    gate.complete()

    expect(dispatched).toEqual(['error', 'complete'])
  })

  test('Given 普通 headless completion 携带 metadata When Renderer gate ready Then 保留普通终态清理与通知', () => {
    /** 普通 metadata 必须明确分类为 agent，不能因 Canvas fail-closed 丢终态。 */
    let cleaned = false
    let notifications = 0
    const gate = routing.createCanvasAgentBootstrapGate<{
      sessionId: string
      type: 'complete'
      session: AgentSessionMeta
    }>({
      classify: (event) => routing.routeCanvasAgentEvent(event.session).kind,
      dispatch: () => {
        cleaned = true
        notifications += 1
      },
      allowUnknownAfterReady: () => false,
      isTerminalEvent: () => true,
    })
    gate.complete()
    gate.handle({
      sessionId: 'ordinary-headless',
      type: 'complete',
      session: createCanvasSession({
        id: 'ordinary-headless',
        sourceCanvasProjectId: undefined,
        sourceCanvasId: undefined,
        sourceCanvasNodeId: undefined,
      }),
    })

    expect(cleaned).toBe(true)
    expect(notifications).toBe(1)
  })

  test('Given renderer reload 与 Canvas 早期 completion When deferred、failed 或有可信 meta Then 普通副作用始终为零', () => {
    /** 模拟 reload 后由 bootstrap 恢复的最小 owner 索引。 */
    const owners = new Map<string, routing.CanvasAgentOwner>()
    /** 记录普通通知与列表 upsert，Canvas completion 不得触发两者。 */
    let ordinaryNotifications = 0
    let ordinaryListUpserts = 0
    /** 记录正确恢复的 Canvas completion。 */
    const canvasRoutes: string[] = []
    interface CompletionEvent {
      sessionId: string
      session?: AgentSessionMeta
    }
    /** 创建与真实 hook 相同的 completion gate 分类。 */
    const createCompletionGate = () => routing.createCanvasAgentBootstrapGate<CompletionEvent>({
      classify: (event) => {
        if (event.session === undefined) return 'unknown'
        return routing.resolveCanvasAgentCompletion(event.sessionId, event.session).kind
      },
      dispatch: (event) => {
        const route = routing.resolveCanvasAgentCompletion(
          event.sessionId,
          event.session,
        )
        if (route.kind === 'canvas') canvasRoutes.push(route.owner.sessionId)
        else if (route.kind === 'agent') {
          ordinaryNotifications += 1
          ordinaryListUpserts += 1
        }
      },
      allowUnknownAfterReady: () => false,
    })

    const deferredGate = createCompletionGate()
    deferredGate.handle({ sessionId: 'deferred-canvas' })
    expect(canvasRoutes).toEqual([])
    owners.set('deferred-canvas', {
      sessionId: 'deferred-canvas', projectId: 'project-1', canvasId: 'canvas-1',
      nodeId: 'node-1', title: '恢复 Canvas',
    })
    deferredGate.complete()

    const failedGate = createCompletionGate()
    failedGate.handle({ sessionId: 'failed-canvas' })
    failedGate.fail()
    failedGate.handle({ sessionId: 'failed-canvas' })

    const trustedMetaGate = createCompletionGate()
    trustedMetaGate.handle({ sessionId: 'trusted-canvas', session: createCanvasSession({ id: 'trusted-canvas' }) })
    expect(canvasRoutes).toEqual(['trusted-canvas'])
    expect(ordinaryNotifications).toBe(0)
    expect(ordinaryListUpserts).toBe(0)
  })

  test('Given 完整 Canvas owner When 路由 Then 保留 O(1) owner 且禁止普通会话副作用', () => {
    expect(routeCanvasAgentEvent(createCanvasSession())).toEqual({
      kind: 'canvas',
      owner: {
        sessionId: 'session-1',
        projectId: 'project-1',
        canvasId: 'canvas-1',
        nodeId: 'node-1',
        title: 'Canvas Agent',
      },
    })
  })

  test('Given 普通会话 When 路由 Then 保持普通 Agent 路径', () => {
    expect(routeCanvasAgentEvent(createCanvasSession({
      sourceCanvasProjectId: undefined, sourceCanvasId: undefined, sourceCanvasNodeId: undefined,
    })).kind).toBe('agent')
  })

  test.each([
    ['半归属会话', createCanvasSession({ sourceCanvasNodeId: undefined })],
    ['空项目归属', createCanvasSession({ sourceCanvasProjectId: '' })],
    ['项目归属带空格', createCanvasSession({ sourceCanvasProjectId: ' project-1 ' })],
    ['工作区不匹配', createCanvasSession({ workspaceId: 'project-2' })],
    ['混入委派归属', createCanvasSession({ sourceDelegationId: 'delegation-1' })],
  ])('Given %s When 路由 Then fail closed 为损坏内部会话', (_name, session) => {
    expect(routeCanvasAgentEvent(session).kind).toBe('internal-invalid')
  })

  test('Given 已缓存合法 owner When completion 明确携带损坏归属 Then 失效且禁止旧缓存 fallback', () => {
    /** 待实现的 completion 决策函数。 */
    const resolveCompletion = (routing as typeof routing & {
      resolveCanvasAgentCompletion?: (
        sessionId: string,
        session: AgentSessionMeta | undefined,
      ) => routing.CanvasAgentEventRoute
    }).resolveCanvasAgentCompletion
    expect(resolveCompletion).toBeFunction()
    if (!resolveCompletion) return
    /** Renderer reload 或面板打开后留下的合法旧 owner。 */
    const cachedOwner: routing.CanvasAgentOwner = {
      sessionId: 'session-1', projectId: 'project-1', canvasId: 'canvas-1',
      nodeId: 'node-1', title: '旧标题',
    }
    expect(resolveCompletion(
      'session-1',
      createCanvasSession({ sourceCanvasNodeId: undefined }),
    )).toEqual({ kind: 'internal-invalid' })
    expect(resolveCompletion('session-1', undefined)).toEqual({ kind: 'internal-invalid' })
    expect(resolveCompletion('session-1', {
      id: 'session-1', title: '普通会话', createdAt: 1, updatedAt: 1,
    })).toEqual({ kind: 'agent' })
  })
})
