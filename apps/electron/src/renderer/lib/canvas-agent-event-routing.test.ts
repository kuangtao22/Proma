import { describe, expect, test } from 'bun:test'
import type { AgentSessionMeta } from '@proma/shared'
import * as routing from './canvas-agent-event-routing'
import { routeCanvasAgentEvent } from './canvas-agent-event-routing'

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
        const owner = owners.get(event.sessionId)
        if (event.session === undefined && !owner) return 'unknown'
        return routing.resolveCanvasAgentCompletion(event.sessionId, event.session, owner).kind
      },
      dispatch: (event) => {
        const route = routing.resolveCanvasAgentCompletion(
          event.sessionId,
          event.session,
          owners.get(event.sessionId),
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
    expect(canvasRoutes).toEqual(['deferred-canvas', 'trusted-canvas'])
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
        cachedOwner: routing.CanvasAgentOwner | undefined,
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
      cachedOwner,
    )).toEqual({ kind: 'internal-invalid' })
    expect(resolveCompletion('session-1', undefined, cachedOwner)).toEqual({
      kind: 'canvas', owner: cachedOwner,
    })
    expect(resolveCompletion('session-1', {
      id: 'session-1', title: '普通会话', createdAt: 1, updatedAt: 1,
    }, cachedOwner)).toEqual({ kind: 'agent' })
  })
})
