import { describe, expect, test } from 'bun:test'
import { createStore } from 'jotai'
import {
  agentCanvasViewStatesAtom,
  createAgentCanvasViewKey,
  initializeAgentCanvasViewStateAtom,
  navigateAgentCanvasViewAtom,
  removeAgentCanvasViewStateAtom,
  updateAgentCanvasViewStateAtom,
} from './agent-canvas-atoms'

describe('Agent Canvas 视图状态隔离', () => {
  test('Given 同一项目画布的两个 Agent 会话 When 分别更新视口和选区 Then 视图状态互不污染', () => {
    const store = createStore()
    const firstKey = createAgentCanvasViewKey('session-a', 'project-a', 'canvas-a')
    const secondKey = createAgentCanvasViewKey('session-b', 'project-a', 'canvas-a')

    store.set(initializeAgentCanvasViewStateAtom, {
      key: firstKey,
      viewport: { x: 0, y: 0, zoom: 1 },
    })
    store.set(initializeAgentCanvasViewStateAtom, {
      key: secondKey,
      viewport: { x: 0, y: 0, zoom: 1 },
    })
    store.set(updateAgentCanvasViewStateAtom, {
      key: firstKey,
      update: {
        viewport: { x: 120, y: 80, zoom: 1.5 },
        selectedNodeId: 'node-a',
        selectedNodeIds: ['node-a', 'node-b'],
      },
    })

    const states = store.get(agentCanvasViewStatesAtom)
    expect(JSON.parse(firstKey)).toEqual(['session-a', 'project-a', 'canvas-a'])
    expect(states.get(firstKey)).toMatchObject({
      viewport: { x: 120, y: 80, zoom: 1.5 },
      selectedNodeId: 'node-a',
      selectedNodeIds: ['node-a', 'node-b'],
    })
    expect(states.get(secondKey)).toMatchObject({
      viewport: { x: 0, y: 0, zoom: 1 },
      selectedNodeId: null,
      selectedNodeIds: [],
    })
  })

  test('Given 已初始化的会话视图 When 共享画布重新加载 Then 不用文档视口覆盖会话视口', () => {
    const store = createStore()
    const key = createAgentCanvasViewKey('session-a', 'project-a', 'canvas-a')
    store.set(initializeAgentCanvasViewStateAtom, {
      key,
      viewport: { x: 10, y: 20, zoom: 1.2 },
    })
    store.set(updateAgentCanvasViewStateAtom, {
      key,
      update: { viewport: { x: 90, y: 70, zoom: 1.8 } },
    })

    store.set(initializeAgentCanvasViewStateAtom, {
      key,
      viewport: { x: 0, y: 0, zoom: 1 },
    })

    expect(store.get(agentCanvasViewStatesAtom).get(key)?.viewport)
      .toEqual({ x: 90, y: 70, zoom: 1.8 })
  })

  test('Given Canvas 完成导航先于 LOAD When 首个权威文档初始化 Then 首次接管文档视口后应用节点导航', () => {
    const store = createStore()
    const key = createAgentCanvasViewKey('session-a', 'project-a', 'canvas-a')

    store.set(navigateAgentCanvasViewAtom, { key, nodeId: 'node-a' })

    expect(store.get(agentCanvasViewStatesAtom).has(key)).toBe(false)

    store.set(initializeAgentCanvasViewStateAtom, {
      key,
      viewport: { x: 160, y: 90, zoom: 1.6 },
    })

    expect(store.get(agentCanvasViewStatesAtom).get(key)).toMatchObject({
      viewport: { x: 160, y: 90, zoom: 1.6 },
      selectedNodeId: 'node-a',
      selectedNodeIds: ['node-a'],
      expandedNodeId: 'node-a',
    })
  })

  test('Given 两个会话视图 When 删除当前视图 Then 共享画布的另一会话视图仍保留', () => {
    const store = createStore()
    const firstKey = createAgentCanvasViewKey('session-a', 'project-a', 'canvas-a')
    const secondKey = createAgentCanvasViewKey('session-b', 'project-a', 'canvas-a')
    store.set(initializeAgentCanvasViewStateAtom, {
      key: firstKey,
      viewport: { x: 0, y: 0, zoom: 1 },
    })
    store.set(initializeAgentCanvasViewStateAtom, {
      key: secondKey,
      viewport: { x: 0, y: 0, zoom: 1 },
    })

    store.set(removeAgentCanvasViewStateAtom, firstKey)

    const states = store.get(agentCanvasViewStatesAtom)
    expect(states.has(firstKey)).toBe(false)
    expect(states.has(secondKey)).toBe(true)
  })

  test('Given LOAD 前已有待导航 When Workspace 真实卸载 Then 后续初始化不复活旧导航', () => {
    const store = createStore()
    const key = createAgentCanvasViewKey('session-a', 'project-a', 'canvas-a')
    store.set(navigateAgentCanvasViewAtom, { key, nodeId: 'node-old' })

    store.set(removeAgentCanvasViewStateAtom, key)
    store.set(initializeAgentCanvasViewStateAtom, {
      key,
      viewport: { x: 40, y: 50, zoom: 1.3 },
    })

    expect(store.get(agentCanvasViewStatesAtom).get(key)).toMatchObject({
      viewport: { x: 40, y: 50, zoom: 1.3 },
      selectedNodeId: null,
      selectedNodeIds: [],
      expandedNodeId: null,
    })
  })
})
