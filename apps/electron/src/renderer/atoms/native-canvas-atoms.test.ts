import { describe, expect, test } from 'bun:test'
import { createStore } from 'jotai'
import {
  canvasAgentOwnersAtom,
  canvasAgentPersistedMessagesAtom,
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
})
