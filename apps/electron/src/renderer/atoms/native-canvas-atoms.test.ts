import { describe, expect, test } from 'bun:test'
import { createStore } from 'jotai'
import {
  canvasAgentActiveInternalInvalidSessionIdsAtom,
  canvasAgentInternalInvalidSessionIdsAtom,
  canvasAgentLifecycleAtom,
  canvasAgentOpenSessionIdsAtom,
  canvasAgentOwnersAtom,
  canvasAgentPersistedMessagesAtom,
  canvasAgentRunningSessionIdsAtom,
  createInitialNativeCanvasState,
  createNativeCanvasKey,
  nativeCanvasStatesAtom,
  updateNativeCanvasStateAtom,
} from './native-canvas-atoms'

describe('原生 Canvas 状态隔离', () => {
  test('Given 两个 Canvas When 更新其中一个 Then pending、错误与选区不会串用', () => {
    const store = createStore()
    const firstKey = createNativeCanvasKey('project-a', 'canvas-a')
    const secondKey = createNativeCanvasKey('project-a', 'canvas-b')

    store.set(updateNativeCanvasStateAtom, {
      key: firstKey,
      update: {
        phase: 'error',
        pendingMutations: [{ type: 'set-viewport', viewport: { x: 1, y: 2, zoom: 1 } }],
        selectedNodeId: 'node-a',
        error: 'A 失败',
      },
    })
    store.set(updateNativeCanvasStateAtom, {
      key: secondKey,
      update: { phase: 'ready' },
    })

    const states = store.get(nativeCanvasStatesAtom)
    expect(states.get(firstKey)?.error).toBe('A 失败')
    expect(states.get(secondKey)).toMatchObject({
      phase: 'ready',
      pendingMutations: [],
      selectedNodeId: null,
      error: null,
    })
  })

  test('Given 两次初始化 When 修改数组 Then 初始数组互不共享', () => {
    const first = createInitialNativeCanvasState()
    const second = createInitialNativeCanvasState()

    expect(first.pendingMutations).not.toBe(second.pendingMutations)
    expect(first.inFlightMutations).not.toBe(second.inFlightMutations)
    expect(createNativeCanvasKey('project-a', 'canvas-a')).toBe('project-a:canvas-a')
  })

  test('Given 未打开 Canvas 的 Agent 仍在运行 When 切换 Canvas Then owner 和按会话消息缓存不丢失', () => {
    const store = createStore()
    store.set(canvasAgentOwnersAtom, new Map([['session-1', {
      sessionId: 'session-1', projectId: 'project-a', canvasId: 'canvas-a', nodeId: 'node-a', title: 'Agent A',
    }]]))
    store.set(canvasAgentPersistedMessagesAtom, new Map([['session-1', []]]))
    store.set(updateNativeCanvasStateAtom, {
      key: createNativeCanvasKey('project-a', 'canvas-b'),
      update: { phase: 'ready', conversationNodeId: null },
    })

    expect(store.get(canvasAgentOwnersAtom).get('session-1')?.canvasId).toBe('canvas-a')
    expect(store.get(canvasAgentPersistedMessagesAtom).has('session-1')).toBe(true)
  })

  test('Given Canvas session 生命周期 When 完成或关闭 Then 只保留仍运行或仍打开的缓存', () => {
    const store = createStore()
    /** 两个会话分别覆盖“运行中关闭”和“终态仍打开”。 */
    const owner = (sessionId: string) => ({
      sessionId, projectId: 'project-a', canvasId: 'canvas-a', nodeId: `node-${sessionId}`, title: sessionId,
    })
    store.set(canvasAgentLifecycleAtom, {
      type: 'bootstrap', owners: [owner('running')], internalInvalidSessionIds: [],
    })
    store.set(canvasAgentLifecycleAtom, {
      type: 'opened', owner: owner('running'), messages: [],
    })
    store.set(canvasAgentLifecycleAtom, { type: 'closed', sessionId: 'running' })
    expect(store.get(canvasAgentOwnersAtom).has('running')).toBe(true)
    expect(store.get(canvasAgentPersistedMessagesAtom).has('running')).toBe(true)

    store.set(canvasAgentLifecycleAtom, { type: 'completed', sessionId: 'running' })
    expect(store.get(canvasAgentOwnersAtom).has('running')).toBe(false)
    expect(store.get(canvasAgentPersistedMessagesAtom).has('running')).toBe(false)

    store.set(canvasAgentLifecycleAtom, {
      type: 'opened', owner: owner('open'), messages: [],
    })
    store.set(canvasAgentLifecycleAtom, { type: 'completed', sessionId: 'open' })
    expect(store.get(canvasAgentOwnersAtom).has('open')).toBe(true)
    store.set(canvasAgentLifecycleAtom, { type: 'closed', sessionId: 'open' })
    expect(store.get(canvasAgentOwnersAtom).has('open')).toBe(false)
    expect(store.get(canvasAgentOpenSessionIdsAtom).size).toBe(0)
  })

  test('Given 损坏 completion 与大量关闭缓存 When 生命周期收口 Then 立即失效且非保护缓存有界', () => {
    const store = createStore()
    /** 生成超过非保护缓存上限的历史会话。 */
    for (let index = 0; index < 25; index += 1) {
      const sessionId = `session-${index}`
      store.set(canvasAgentOwnersAtom, (current) => new Map(current).set(sessionId, {
        sessionId, projectId: 'project-a', canvasId: 'canvas-a', nodeId: `node-${index}`, title: sessionId,
      }))
      store.set(canvasAgentPersistedMessagesAtom, (current) => new Map(current).set(sessionId, []))
    }
    store.set(canvasAgentLifecycleAtom, { type: 'prune' })
    expect(store.get(canvasAgentPersistedMessagesAtom).size).toBeLessThanOrEqual(20)

    store.set(canvasAgentLifecycleAtom, { type: 'invalidated', sessionId: 'session-24', terminal: true })
    expect(store.get(canvasAgentOwnersAtom).has('session-24')).toBe(false)
    expect(store.get(canvasAgentPersistedMessagesAtom).has('session-24')).toBe(false)
    expect(store.get(canvasAgentInternalInvalidSessionIdsAtom).has('session-24')).toBe(true)
  })

  test('Given open 或 running 会话加载 501 条权威消息 When 生命周期修剪 Then 完整历史不被静默截断', () => {
    const store = createStore()
    /** 构造超过旧单会话上限的权威 JSONL 消息。 */
    const messages = Array.from({ length: 501 }, (_, index) => ({
      type: 'user' as const,
      message: { content: [{ type: 'text' as const, text: String(index) }] },
    }))
    /** 测试使用的最小 Canvas owner。 */
    const owner = {
      sessionId: 'protected', projectId: 'project-a', canvasId: 'canvas-a', nodeId: 'node-a', title: 'Agent A',
    }
    store.set(canvasAgentLifecycleAtom, { type: 'opened', owner, messages })
    expect(store.get(canvasAgentPersistedMessagesAtom).get('protected')).toHaveLength(501)

    store.set(canvasAgentLifecycleAtom, { type: 'started', owner })
    store.set(canvasAgentLifecycleAtom, { type: 'closed', sessionId: 'protected' })
    store.set(canvasAgentLifecycleAtom, { type: 'prune' })
    expect(store.get(canvasAgentPersistedMessagesAtom).get('protected')).toHaveLength(501)
  })

  test('Given closed terminal 非保护会话有 501 条消息 When 修剪 Then 只裁剪非保护历史', () => {
    const store = createStore()
    /** 非保护历史允许进入数量上限，避免缓存无限增长。 */
    const messages = Array.from({ length: 501 }, (_, index) => ({
      type: 'user' as const,
      message: { content: [{ type: 'text' as const, text: String(index) }] },
    }))
    store.set(canvasAgentOwnersAtom, new Map([['closed', {
      sessionId: 'closed', projectId: 'project-a', canvasId: 'canvas-a', nodeId: 'node-a', title: 'Agent A',
    }]]))
    store.set(canvasAgentPersistedMessagesAtom, new Map([['closed', messages]]))
    store.set(canvasAgentLifecycleAtom, { type: 'prune' })
    expect(store.get(canvasAgentPersistedMessagesAtom).get('closed')).toHaveLength(500)
  })

  test('Given 1000 个仍运行的损坏 session When soft completion 到达 Then 全部保持 active fail closed', () => {
    const store = createStore()
    /** active invalid 属于安全保护集合，数量可超过 terminal tombstone 上限。 */
    const activeInvalidIds = Array.from({ length: 1_000 }, (_, index) => `active-invalid-${index}`)
    store.set(canvasAgentLifecycleAtom, {
      type: 'bootstrap', owners: [], internalInvalidSessionIds: activeInvalidIds,
    })
    expect(store.get(canvasAgentInternalInvalidSessionIdsAtom).size).toBe(1_000)
    expect(store.get(canvasAgentInternalInvalidSessionIdsAtom).has('active-invalid-0')).toBe(true)

    /** soft completion 不是终态，不得把 active invalid 降级成可淘汰 tombstone。 */
    for (const sessionId of activeInvalidIds) {
      store.set(canvasAgentLifecycleAtom, { type: 'invalidated', sessionId, terminal: false })
    }
    expect(store.get(canvasAgentActiveInternalInvalidSessionIdsAtom).size).toBe(1_000)
    expect(store.get(canvasAgentInternalInvalidSessionIdsAtom).size).toBe(1_000)
    expect(store.get(canvasAgentInternalInvalidSessionIdsAtom).has('active-invalid-0')).toBe(true)

    /** 只有 hard terminal completion 才转为有界 terminal tombstone。 */
    for (const sessionId of activeInvalidIds) {
      store.set(canvasAgentLifecycleAtom, { type: 'invalidated', sessionId, terminal: true })
    }
    expect(store.get(canvasAgentInternalInvalidSessionIdsAtom).size).toBeLessThanOrEqual(100)
  })

  test('Given 合法 Canvas owner 正在运行 When soft completion 到达 Then owner 与 running 都保留', () => {
    const store = createStore()
    /** soft completion 只更新流式软空闲态，不结束 Canvas lifecycle。 */
    const owner = {
      sessionId: 'canvas-soft', projectId: 'project-a', canvasId: 'canvas-a', nodeId: 'node-a', title: 'Agent A',
    }
    store.set(canvasAgentLifecycleAtom, { type: 'opened', owner, messages: [] })
    store.set(canvasAgentLifecycleAtom, { type: 'started', owner })
    store.set(canvasAgentLifecycleAtom, { type: 'owner-updated', owner })

    expect(store.get(canvasAgentOwnersAtom).has(owner.sessionId)).toBe(true)
    expect(store.get(canvasAgentRunningSessionIdsAtom).has(owner.sessionId)).toBe(true)
  })
})
