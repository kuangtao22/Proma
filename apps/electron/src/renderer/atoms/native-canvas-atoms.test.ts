import { describe, expect, test } from 'bun:test'
import { createStore } from 'jotai'
import {
  canvasAgentActiveInternalInvalidSessionIdsAtom,
  canvasAgentInternalInvalidSessionIdsAtom,
  canvasAgentLifecycleAtom,
  canvasAgentOpenSessionIdsAtom,
  canvasAgentOptimisticRunGenerationsAtom,
  canvasAgentOptimisticRunTokensAtom,
  canvasAgentPendingHandoffGenerationsAtom,
  canvasAgentOwnersAtom,
  canvasAgentPersistedMessagesAtom,
  canvasAgentRunningSessionIdsAtom,
  canvasAgentRunGenerationsAtom,
  canvasAgentAuthoritativeRunningSessionIdsAtom,
  createInitialNativeCanvasState,
  createNativeCanvasKey,
  nativeCanvasStatesAtom,
  updateNativeCanvasStateAtom,
  isCanvasAgentGenerationCurrent,
  isCanvasAgentHandoffGenerationCurrent,
} from './native-canvas-atoms'
import {
  agentSessionStreamingStateAtomFamily,
  agentStreamErrorsAtom,
  agentStreamingStatesAtom,
  liveMessagesMapAtom,
} from './agent-atoms'

describe('原生 Canvas 状态隔离', () => {
  test('Given 新建状态 When 切换工具 Then activeTool 只允许 select 或 pan', () => {
    const initial = createInitialNativeCanvasState()

    expect(initial.activeTool).toBe('select')
    expect(initial).toMatchObject({
      expandedNodeId: null,
      pendingWorkbenchSwitchNodeId: null,
      workbenchDraft: null,
    })
    expect({ ...initial, activeTool: 'pan' as const }.activeTool).toBe('pan')
  })

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
      type: 'bootstrap', owners: [{ ...owner('running'), startedAt: 100 }], internalInvalidRuns: [],
    })
    store.set(canvasAgentLifecycleAtom, {
      type: 'opened', owner: owner('running'), messages: [],
    })
    store.set(canvasAgentLifecycleAtom, { type: 'closed', sessionId: 'running' })
    expect(store.get(canvasAgentOwnersAtom).has('running')).toBe(true)
    expect(store.get(canvasAgentPersistedMessagesAtom).has('running')).toBe(true)

    store.set(canvasAgentLifecycleAtom, { type: 'completed', sessionId: 'running', startedAt: 100 })
    expect(store.get(canvasAgentOwnersAtom).has('running')).toBe(false)
    expect(store.get(canvasAgentPersistedMessagesAtom).has('running')).toBe(false)

    store.set(canvasAgentLifecycleAtom, {
      type: 'opened', owner: owner('open'), messages: [],
    })
    store.set(canvasAgentLifecycleAtom, { type: 'started', owner: owner('open'), startedAt: 200 })
    store.set(canvasAgentLifecycleAtom, { type: 'completed', sessionId: 'open', startedAt: 200 })
    expect(store.get(canvasAgentOwnersAtom).has('open')).toBe(true)
    store.set(canvasAgentLifecycleAtom, { type: 'closed', sessionId: 'open' })
    expect(store.get(canvasAgentOwnersAtom).has('open')).toBe(false)
    expect(store.get(canvasAgentOpenSessionIdsAtom).size).toBe(0)
  })

  test.each(['bootstrap', 'run_started'] as const)(
    'Given 权威 %s 先于 busy 返回 When 本轮乐观 SEND 被拒绝 Then 真实运行与 owner 保留',
    (authoritativeSource) => {
      const store = createStore()
      const owner = {
        sessionId: 'session-busy', projectId: 'project-a', canvasId: 'canvas-a', nodeId: 'node-a', title: 'Agent A',
      }
      store.set(canvasAgentLifecycleAtom, { type: 'opened', owner, messages: [] })
      store.set(canvasAgentLifecycleAtom, {
        type: 'optimistic-started', owner, token: 'message-old', startedAt: 100,
      })
      if (authoritativeSource === 'bootstrap') {
        store.set(canvasAgentLifecycleAtom, {
          type: 'bootstrap', owners: [{ ...owner, startedAt: 100 }], internalInvalidRuns: [],
        })
      } else {
        store.set(canvasAgentLifecycleAtom, { type: 'started', owner, startedAt: 100 })
      }

      store.set(canvasAgentLifecycleAtom, {
        type: 'send-rejected', sessionId: owner.sessionId, token: 'message-old', preserveRunning: true,
      })

      expect(store.get(canvasAgentAuthoritativeRunningSessionIdsAtom).has(owner.sessionId)).toBe(true)
      expect(store.get(canvasAgentOptimisticRunTokensAtom).has(owner.sessionId)).toBe(false)
      expect(store.get(canvasAgentRunningSessionIdsAtom).has(owner.sessionId)).toBe(true)
      expect(store.get(canvasAgentOwnersAtom).get(owner.sessionId)).toEqual(owner)
    },
  )

  test('Given 权威运行 100 已存在 When 误发乐观 200 后 busy Then 100 仍可完成交接且 200 仅由新 run_started 接管', () => {
    const store = createStore()
    /** 同一 Canvas 节点在旧运行尚未结束时误触发第二次发送。 */
    const owner = {
      sessionId: 'authoritative-generation', projectId: 'project-a', canvasId: 'canvas-a', nodeId: 'node-a', title: 'Agent A',
    }
    store.set(canvasAgentLifecycleAtom, { type: 'opened', owner, messages: [] })
    store.set(canvasAgentLifecycleAtom, { type: 'started', owner, startedAt: 100 })
    store.set(canvasAgentLifecycleAtom, {
      type: 'optimistic-started', owner, token: 'message-200', startedAt: 200,
    })

    expect(store.get(canvasAgentRunGenerationsAtom).get(owner.sessionId)).toBe(100)
    store.set(canvasAgentLifecycleAtom, {
      type: 'send-rejected', sessionId: owner.sessionId, token: 'message-200', preserveRunning: true,
    })
    expect(store.get(canvasAgentRunGenerationsAtom).get(owner.sessionId)).toBe(100)
    expect(store.get(canvasAgentOptimisticRunTokensAtom).has(owner.sessionId)).toBe(false)

    store.set(canvasAgentLifecycleAtom, { type: 'completed', sessionId: owner.sessionId, startedAt: 100 })
    expect(store.get(canvasAgentAuthoritativeRunningSessionIdsAtom).has(owner.sessionId)).toBe(false)
    expect(isCanvasAgentGenerationCurrent(store, owner.sessionId, 100)).toBe(false)
    expect(isCanvasAgentHandoffGenerationCurrent(store, owner.sessionId, 100)).toBe(true)
    store.set(canvasAgentLifecycleAtom, { type: 'settled', sessionId: owner.sessionId, startedAt: 100 })
    expect(store.get(canvasAgentRunGenerationsAtom).has(owner.sessionId)).toBe(false)

    store.set(canvasAgentLifecycleAtom, {
      type: 'optimistic-started', owner, token: 'message-200-new', startedAt: 200,
    })
    expect(store.get(canvasAgentRunGenerationsAtom).has(owner.sessionId)).toBe(false)
    store.set(canvasAgentLifecycleAtom, { type: 'started', owner, startedAt: 200 })
    expect(store.get(canvasAgentRunGenerationsAtom).get(owner.sessionId)).toBe(200)
  })

  test('Given 无权威运行 When 普通 SEND 准入失败 Then 只清除匹配的乐观运行', () => {
    const store = createStore()
    const owner = {
      sessionId: 'session-failed', projectId: 'project-a', canvasId: 'canvas-a', nodeId: 'node-a', title: 'Agent A',
    }
    store.set(canvasAgentLifecycleAtom, { type: 'opened', owner, messages: [] })
    store.set(canvasAgentLifecycleAtom, {
      type: 'optimistic-started', owner, token: 'message-1', startedAt: 100,
    })

    store.set(canvasAgentLifecycleAtom, {
      type: 'send-rejected', sessionId: owner.sessionId, token: 'message-1', preserveRunning: false,
    })

    expect(store.get(canvasAgentAuthoritativeRunningSessionIdsAtom).has(owner.sessionId)).toBe(false)
    expect(store.get(canvasAgentOptimisticRunTokensAtom).has(owner.sessionId)).toBe(false)
    expect(store.get(canvasAgentRunningSessionIdsAtom).has(owner.sessionId)).toBe(false)
    expect(store.get(canvasAgentOwnersAtom).get(owner.sessionId)).toEqual(owner)
  })

  test('Given 同一 session 已开始新一轮 When 旧 token reject 到达 Then 新运行不被覆盖', () => {
    const store = createStore()
    const owner = {
      sessionId: 'session-new', projectId: 'project-a', canvasId: 'canvas-a', nodeId: 'node-a', title: 'Agent A',
    }
    store.set(canvasAgentLifecycleAtom, { type: 'opened', owner, messages: [] })
    store.set(canvasAgentLifecycleAtom, {
      type: 'optimistic-started', owner, token: 'message-old', startedAt: 100,
    })
    store.set(canvasAgentLifecycleAtom, {
      type: 'optimistic-started', owner, token: 'message-new', startedAt: 200,
    })

    store.set(canvasAgentLifecycleAtom, {
      type: 'send-rejected', sessionId: owner.sessionId, token: 'message-old', preserveRunning: false,
    })

    expect(store.get(canvasAgentOptimisticRunTokensAtom).get(owner.sessionId)).toBe('message-new')
    expect(store.get(canvasAgentRunningSessionIdsAtom).has(owner.sessionId)).toBe(true)
  })

  test('Given 新 run_started 已接管 When 旧 completion 到达 Then busy、token 与共享流状态完全保留', () => {
    const store = createStore()
    const owner = {
      sessionId: 'generation-guard', projectId: 'project-a', canvasId: 'canvas-a', nodeId: 'node-a', title: 'Agent A',
    }
    store.set(canvasAgentLifecycleAtom, { type: 'opened', owner, messages: [] })
    store.set(canvasAgentLifecycleAtom, {
      type: 'optimistic-started', owner, token: 'message-new', startedAt: 200,
    })
    store.set(canvasAgentLifecycleAtom, { type: 'started', owner, startedAt: 200 })
    store.set(liveMessagesMapAtom, new Map([[owner.sessionId, []]]))
    store.set(agentStreamErrorsAtom, new Map([[owner.sessionId, '新运行错误']]))
    store.set(agentSessionStreamingStateAtomFamily(owner.sessionId), { running: true, startedAt: 200 })

    store.set(canvasAgentLifecycleAtom, { type: 'completed', sessionId: owner.sessionId, startedAt: 100 })
    store.set(canvasAgentLifecycleAtom, { type: 'settled', sessionId: owner.sessionId, startedAt: 100 })

    expect(store.get(canvasAgentRunGenerationsAtom).get(owner.sessionId)).toBe(200)
    expect(store.get(canvasAgentAuthoritativeRunningSessionIdsAtom).has(owner.sessionId)).toBe(true)
    expect(store.get(canvasAgentOptimisticRunTokensAtom).get(owner.sessionId)).toBe('message-new')
    expect(store.get(canvasAgentRunningSessionIdsAtom).has(owner.sessionId)).toBe(true)
    expect(store.get(liveMessagesMapAtom).has(owner.sessionId)).toBe(true)
    expect(store.get(agentStreamErrorsAtom).has(owner.sessionId)).toBe(true)
    expect(store.get(agentStreamingStatesAtom).get(owner.sessionId)?.startedAt).toBe(200)
  })

  test('Given 新 completion GET 先回且随后已启动更新一轮 When 旧 GET 后回 Then generation 二次校验拒绝覆盖', () => {
    const store = createStore()
    const owner = {
      sessionId: 'handoff-generation', projectId: 'project-a', canvasId: 'canvas-a', nodeId: 'node-a', title: 'Agent A',
    }
    store.set(canvasAgentLifecycleAtom, { type: 'opened', owner, messages: [] })
    store.set(canvasAgentLifecycleAtom, { type: 'started', owner, startedAt: 200 })
    store.set(canvasAgentLifecycleAtom, { type: 'completed', sessionId: owner.sessionId, startedAt: 200 })
    expect(isCanvasAgentGenerationCurrent(store, owner.sessionId, 200)).toBe(false)
    expect(isCanvasAgentHandoffGenerationCurrent(store, owner.sessionId, 200)).toBe(true)

    store.set(canvasAgentLifecycleAtom, { type: 'optimistic-started', owner, token: 'message-next', startedAt: 300 })
    store.set(canvasAgentLifecycleAtom, { type: 'started', owner, startedAt: 300 })

    expect(isCanvasAgentGenerationCurrent(store, owner.sessionId, 200)).toBe(false)
    expect(isCanvasAgentGenerationCurrent(store, owner.sessionId, 300)).toBe(true)
  })

  test('Given open 运行完成且权威 GET 在途 When 空 bootstrap 替换快照 Then handoff 代次保留到 GET settled', () => {
    const store = createStore()
    const owner = {
      sessionId: 'handoff-bootstrap', projectId: 'project-a', canvasId: 'canvas-a', nodeId: 'node-a', title: 'Agent A',
    }
    const finalMessages = [{
      type: 'assistant' as const,
      message: { content: [{ type: 'text' as const, text: '最终结果' }] },
    }]
    store.set(canvasAgentLifecycleAtom, { type: 'opened', owner, messages: [] })
    store.set(canvasAgentLifecycleAtom, { type: 'started', owner, startedAt: 100 })
    store.set(canvasAgentLifecycleAtom, { type: 'completed', sessionId: owner.sessionId, startedAt: 100 })

    store.set(canvasAgentLifecycleAtom, { type: 'bootstrap', owners: [], internalInvalidRuns: [] })

    expect(store.get(canvasAgentRunGenerationsAtom).has(owner.sessionId)).toBe(false)
    expect(isCanvasAgentGenerationCurrent(store, owner.sessionId, 100)).toBe(false)
    expect(isCanvasAgentHandoffGenerationCurrent(store, owner.sessionId, 100)).toBe(true)
    store.set(canvasAgentLifecycleAtom, { type: 'opened', owner, messages: finalMessages })
    store.set(canvasAgentLifecycleAtom, { type: 'settled', sessionId: owner.sessionId, startedAt: 100 })
    expect(store.get(canvasAgentPersistedMessagesAtom).get(owner.sessionId)).toEqual(finalMessages)
    expect(isCanvasAgentHandoffGenerationCurrent(store, owner.sessionId, 100)).toBe(false)
  })

  test('Given authority 100 与 optimistic 200 并存 When 空 bootstrap 替换快照 Then 删除旧 authority 并由 200 接管', () => {
    const store = createStore()
    const owner = {
      sessionId: 'optimistic-after-bootstrap', projectId: 'project-a', canvasId: 'canvas-a', nodeId: 'node-a', title: 'Agent A',
    }
    store.set(canvasAgentLifecycleAtom, { type: 'started', owner, startedAt: 100 })
    store.set(canvasAgentLifecycleAtom, {
      type: 'optimistic-started', owner, token: 'message-200', startedAt: 200,
    })

    store.set(canvasAgentLifecycleAtom, { type: 'bootstrap', owners: [], internalInvalidRuns: [] })

    expect(store.get(canvasAgentRunGenerationsAtom).has(owner.sessionId)).toBe(false)
    expect(store.get(canvasAgentOptimisticRunTokensAtom).get(owner.sessionId)).toBe('message-200')
    expect(store.get(canvasAgentOptimisticRunGenerationsAtom).get(owner.sessionId)).toBe(200)
    expect(isCanvasAgentGenerationCurrent(store, owner.sessionId, 100)).toBe(false)
    expect(isCanvasAgentGenerationCurrent(store, owner.sessionId, 200)).toBe(true)
  })

  test('Given completion 100 正在 handoff When 新权威 run_started 200 到达 Then 清除过期 handoff', () => {
    const store = createStore()
    const owner = {
      sessionId: 'handoff-replaced', projectId: 'project-a', canvasId: 'canvas-a', nodeId: 'node-a', title: 'Agent A',
    }
    store.set(canvasAgentLifecycleAtom, { type: 'opened', owner, messages: [] })
    store.set(canvasAgentLifecycleAtom, { type: 'started', owner, startedAt: 100 })
    store.set(canvasAgentLifecycleAtom, { type: 'completed', sessionId: owner.sessionId, startedAt: 100 })
    store.set(canvasAgentLifecycleAtom, { type: 'bootstrap', owners: [], internalInvalidRuns: [] })
    expect(isCanvasAgentHandoffGenerationCurrent(store, owner.sessionId, 100)).toBe(true)

    store.set(canvasAgentLifecycleAtom, { type: 'started', owner, startedAt: 200 })
    store.set(canvasAgentLifecycleAtom, { type: 'settled', sessionId: owner.sessionId, startedAt: 100 })

    expect(isCanvasAgentGenerationCurrent(store, owner.sessionId, 100)).toBe(false)
    expect(isCanvasAgentGenerationCurrent(store, owner.sessionId, 200)).toBe(true)
    expect(store.get(canvasAgentAuthoritativeRunningSessionIdsAtom).has(owner.sessionId)).toBe(true)
  })

  test('Given 120 个 handoff、authority 与 optimistic 混合状态 When snapshot 替换并全部终态 Then generation 状态有界清零', () => {
    const store = createStore()
    for (let index = 0; index < 40; index += 1) {
      const sessionId = `handoff-mixed-${index}`
      const owner = {
        sessionId, projectId: 'project-a', canvasId: 'canvas-a', nodeId: `node-${index}`, title: 'Agent',
      }
      store.set(canvasAgentLifecycleAtom, { type: 'opened', owner, messages: [] })
      store.set(canvasAgentLifecycleAtom, { type: 'started', owner, startedAt: index })
      store.set(canvasAgentLifecycleAtom, { type: 'completed', sessionId, startedAt: index })
    }
    for (let index = 40; index < 80; index += 1) {
      store.set(canvasAgentLifecycleAtom, {
        type: 'started',
        owner: {
          sessionId: `authority-mixed-${index}`, projectId: 'project-a', canvasId: 'canvas-a',
          nodeId: `node-${index}`, title: 'Agent',
        },
        startedAt: index,
      })
    }
    for (let index = 80; index < 120; index += 1) {
      store.set(canvasAgentLifecycleAtom, {
        type: 'optimistic-started',
        owner: {
          sessionId: `optimistic-mixed-${index}`, projectId: 'project-a', canvasId: 'canvas-a',
          nodeId: `node-${index}`, title: 'Agent',
        },
        token: `message-${index}`,
        startedAt: index,
      })
    }

    store.set(canvasAgentLifecycleAtom, { type: 'bootstrap', owners: [], internalInvalidRuns: [] })
    expect(store.get(canvasAgentRunGenerationsAtom).size).toBe(0)
    expect(store.get(canvasAgentPendingHandoffGenerationsAtom).size).toBe(40)
    for (let index = 0; index < 40; index += 1) {
      expect(isCanvasAgentHandoffGenerationCurrent(store, `handoff-mixed-${index}`, index)).toBe(true)
      store.set(canvasAgentLifecycleAtom, { type: 'settled', sessionId: `handoff-mixed-${index}`, startedAt: index })
      store.set(canvasAgentLifecycleAtom, { type: 'closed', sessionId: `handoff-mixed-${index}` })
    }
    for (let index = 80; index < 120; index += 1) {
      const sessionId = `optimistic-mixed-${index}`
      expect(isCanvasAgentGenerationCurrent(store, sessionId, index)).toBe(true)
      store.set(canvasAgentLifecycleAtom, { type: 'completed', sessionId, startedAt: index })
    }

    expect(store.get(canvasAgentRunGenerationsAtom).size).toBe(0)
    expect(store.get(canvasAgentOptimisticRunTokensAtom).size).toBe(0)
    expect(store.get(canvasAgentOptimisticRunGenerationsAtom).size).toBe(0)
    expect(store.get(canvasAgentPendingHandoffGenerationsAtom).size).toBe(0)
    for (let index = 0; index < 120; index += 1) {
      const prefix = index < 40 ? 'handoff' : index < 80 ? 'authority' : 'optimistic'
      expect(isCanvasAgentGenerationCurrent(store, `${prefix}-mixed-${index}`, index)).toBe(false)
    }
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

    store.set(canvasAgentLifecycleAtom, { type: 'invalid-started', sessionId: 'session-24', startedAt: 24 })
    store.set(canvasAgentLifecycleAtom, {
      type: 'invalidated', sessionId: 'session-24', terminal: true, startedAt: 24,
    })
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

    store.set(canvasAgentLifecycleAtom, { type: 'started', owner, startedAt: 100 })
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
      type: 'bootstrap',
      owners: [],
      internalInvalidRuns: activeInvalidIds.map((sessionId, startedAt) => ({
        sessionId, startedAt, valid: false as const,
      })),
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
    for (const [startedAt, sessionId] of activeInvalidIds.entries()) {
      store.set(canvasAgentLifecycleAtom, { type: 'invalidated', sessionId, terminal: true, startedAt })
    }
    expect(store.get(canvasAgentInternalInvalidSessionIdsAtom).size).toBeLessThanOrEqual(100)
  })

  test('Given invalid active snapshot 带权威代次 When hard terminal 到达 Then 仅匹配代次可终态化回收', () => {
    const store = createStore()
    const sessionId = 'invalid-generation'
    store.set(canvasAgentLifecycleAtom, {
      type: 'bootstrap',
      owners: [],
      internalInvalidRuns: [{ sessionId, startedAt: 100, valid: false }],
    })

    expect(store.get(canvasAgentRunGenerationsAtom).get(sessionId)).toBe(100)
    store.set(canvasAgentLifecycleAtom, { type: 'invalidated', sessionId, terminal: true, startedAt: 100 })
    expect(store.get(canvasAgentActiveInternalInvalidSessionIdsAtom).has(sessionId)).toBe(false)
    expect(store.get(canvasAgentRunGenerationsAtom).has(sessionId)).toBe(false)

    store.set(canvasAgentLifecycleAtom, {
      type: 'bootstrap',
      owners: [],
      internalInvalidRuns: [{ sessionId, startedAt: 200, valid: false }],
    })
    store.set(canvasAgentLifecycleAtom, { type: 'invalidated', sessionId, terminal: true, startedAt: 100 })
    expect(store.get(canvasAgentActiveInternalInvalidSessionIdsAtom).has(sessionId)).toBe(true)
    expect(store.get(canvasAgentRunGenerationsAtom).get(sessionId)).toBe(200)
  })

  test('Given 损坏 active session 无安全 owner When 新 run_started 到达 Then 只更新权威代次并保持 fail closed', () => {
    const store = createStore()
    const sessionId = 'invalid-run-started'
    store.set(canvasAgentLifecycleAtom, {
      type: 'bootstrap',
      owners: [],
      internalInvalidRuns: [{ sessionId, startedAt: 100, valid: false }],
    })

    store.set(canvasAgentLifecycleAtom, { type: 'invalid-started', sessionId, startedAt: 200 })

    expect(store.get(canvasAgentRunGenerationsAtom).get(sessionId)).toBe(200)
    expect(store.get(canvasAgentActiveInternalInvalidSessionIdsAtom).has(sessionId)).toBe(true)
    expect(store.get(canvasAgentOwnersAtom).has(sessionId)).toBe(false)
  })

  test('Given 120 个 stale generation When StrictMode 重复空 bootstrap Then 全部回收', () => {
    const store = createStore()
    for (let index = 0; index < 120; index += 1) {
      store.set(canvasAgentLifecycleAtom, {
        type: 'started',
        owner: {
          sessionId: `stale-${index}`, projectId: 'project-a', canvasId: 'canvas-a',
          nodeId: `node-${index}`, title: 'Agent',
        },
        startedAt: index,
      })
    }

    store.set(canvasAgentLifecycleAtom, { type: 'bootstrap', owners: [], internalInvalidRuns: [] })
    store.set(canvasAgentLifecycleAtom, { type: 'bootstrap', owners: [], internalInvalidRuns: [] })

    expect(store.get(canvasAgentRunGenerationsAtom).size).toBe(0)
  })

  test('Given 120 个损坏 session 持有共享流状态 When hard invalid Then 三类运行时状态全部有界回收', () => {
    const store = createStore()
    for (let index = 0; index < 120; index += 1) {
      const sessionId = `hard-invalid-${index}`
      store.set(liveMessagesMapAtom, (previous) => new Map(previous).set(sessionId, []))
      store.set(agentStreamErrorsAtom, (previous) => new Map(previous).set(sessionId, '损坏事件'))
      store.set(agentSessionStreamingStateAtomFamily(sessionId), { running: true })
      store.set(canvasAgentLifecycleAtom, { type: 'invalid-started', sessionId, startedAt: index })
      store.set(canvasAgentLifecycleAtom, { type: 'invalidated', sessionId, terminal: true, startedAt: index })
    }

    expect(store.get(liveMessagesMapAtom).size).toBe(0)
    expect(store.get(agentStreamErrorsAtom).size).toBe(0)
    expect(store.get(agentStreamingStatesAtom).size).toBe(0)
  })

  test('Given active invalid 仍可能恢复 When soft invalid Then 保留共享流状态', () => {
    const store = createStore()
    const sessionId = 'soft-invalid-runtime'
    store.set(liveMessagesMapAtom, new Map([[sessionId, []]]))
    store.set(agentStreamErrorsAtom, new Map([[sessionId, '等待恢复']]))
    store.set(agentSessionStreamingStateAtomFamily(sessionId), { running: true })

    store.set(canvasAgentLifecycleAtom, { type: 'invalidated', sessionId, terminal: false })

    expect(store.get(liveMessagesMapAtom).has(sessionId)).toBe(true)
    expect(store.get(agentStreamErrorsAtom).get(sessionId)).toBe('等待恢复')
    expect(store.get(agentStreamingStatesAtom).get(sessionId)?.running).toBe(true)
  })

  test('Given 合法 Canvas owner 正在运行 When soft completion 到达 Then owner 与 running 都保留', () => {
    const store = createStore()
    /** soft completion 只更新流式软空闲态，不结束 Canvas lifecycle。 */
    const owner = {
      sessionId: 'canvas-soft', projectId: 'project-a', canvasId: 'canvas-a', nodeId: 'node-a', title: 'Agent A',
    }
    store.set(canvasAgentLifecycleAtom, { type: 'opened', owner, messages: [] })
    store.set(canvasAgentLifecycleAtom, { type: 'started', owner, startedAt: 100 })
    store.set(canvasAgentLifecycleAtom, { type: 'owner-updated', owner })

    expect(store.get(canvasAgentOwnersAtom).has(owner.sessionId)).toBe(true)
    expect(store.get(canvasAgentRunningSessionIdsAtom).has(owner.sessionId)).toBe(true)
  })

  test('Given 120 个已关闭 Canvas session When hard completion 收口 Then 所有运行时 Map 最终有界', () => {
    const store = createStore()
    for (let index = 0; index < 120; index += 1) {
      const sessionId = `closed-${index}`
      const owner = {
        sessionId, projectId: 'project-a', canvasId: 'canvas-a', nodeId: `node-${index}`, title: 'Agent',
      }
      store.set(canvasAgentLifecycleAtom, { type: 'opened', owner, messages: [] })
      store.set(canvasAgentLifecycleAtom, { type: 'started', owner, startedAt: index })
      store.set(liveMessagesMapAtom, (previous) => new Map(previous).set(sessionId, []))
      store.set(agentStreamErrorsAtom, (previous) => new Map(previous).set(sessionId, '旧错误'))
      store.set(agentSessionStreamingStateAtomFamily(sessionId), { running: true })
      store.set(canvasAgentLifecycleAtom, { type: 'closed', sessionId })
      store.set(canvasAgentLifecycleAtom, { type: 'completed', sessionId, startedAt: index })
    }

    expect(store.get(liveMessagesMapAtom).size).toBe(0)
    expect(store.get(agentStreamErrorsAtom).size).toBe(0)
    expect(store.get(canvasAgentOwnersAtom).size).toBe(0)
    expect(store.get(canvasAgentPersistedMessagesAtom).size).toBe(0)
    expect(store.get(canvasAgentRunningSessionIdsAtom).size).toBe(0)
    expect(store.get(canvasAgentRunGenerationsAtom).size).toBe(0)
  })

  test('Given 打开的 Canvas session hard completion When 权威 GET 交接 Then 最终 assistant 保留且 live/error/stream 清理', () => {
    const store = createStore()
    const owner = {
      sessionId: 'opened-final', projectId: 'project-a', canvasId: 'canvas-a', nodeId: 'node-a', title: 'Agent',
    }
    const finalMessages = [{
      type: 'assistant' as const,
      message: { content: [{ type: 'text' as const, text: '最终结果' }] },
    }]
    store.set(canvasAgentLifecycleAtom, { type: 'opened', owner, messages: [] })
    store.set(canvasAgentLifecycleAtom, { type: 'started', owner, startedAt: 100 })
    store.set(liveMessagesMapAtom, new Map([[owner.sessionId, finalMessages]]))
    store.set(agentStreamErrorsAtom, new Map([[owner.sessionId, '旧错误']]))
    store.set(agentSessionStreamingStateAtomFamily(owner.sessionId), { running: true })

    store.set(canvasAgentLifecycleAtom, { type: 'completed', sessionId: owner.sessionId, startedAt: 100 })
    expect(store.get(liveMessagesMapAtom).has(owner.sessionId)).toBe(true)
    store.set(canvasAgentLifecycleAtom, { type: 'opened', owner, messages: finalMessages })
    store.set(canvasAgentLifecycleAtom, { type: 'settled', sessionId: owner.sessionId, startedAt: 100 })

    expect(store.get(canvasAgentPersistedMessagesAtom).get(owner.sessionId)).toEqual(finalMessages)
    expect(store.get(liveMessagesMapAtom).has(owner.sessionId)).toBe(false)
    expect(store.get(agentStreamErrorsAtom).has(owner.sessionId)).toBe(false)
    expect(store.get(agentSessionStreamingStateAtomFamily(owner.sessionId))).toBeUndefined()
    expect(store.get(canvasAgentRunGenerationsAtom).has(owner.sessionId)).toBe(false)
  })
})
