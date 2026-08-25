import { describe, expect, test } from 'bun:test'
import { createStore } from 'jotai'
import {
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
})
