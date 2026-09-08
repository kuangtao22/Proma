import { describe, expect, test } from 'bun:test'
import { createStore } from 'jotai'
import {
  agentCanvasViewStatesAtom,
  createInitialAgentCanvasViewState,
  createAgentCanvasViewKey,
  initializeAgentCanvasViewStateAtom,
  navigateAgentCanvasViewAtom,
  removeAgentCanvasViewStateAtom,
  resolveAgentCanvasWorkbenchSize,
  updateAgentCanvasViewStateAtom,
  type AgentCanvasViewStateUpdate,
} from './agent-canvas-atoms'

describe('Agent Canvas 视图状态隔离', () => {
  test('Given 已初始化的会话视图 When 收到空更新或相同字段 Then 保留状态引用且不通知订阅者', () => {
    /** 真实 Jotai store 用于检测空更新是否仍触发画布订阅。 */
    const store = createStore()
    const key = createAgentCanvasViewKey('session-a', 'project-a', 'canvas-a')
    store.set(initializeAgentCanvasViewStateAtom, { key, viewport: { x: 0, y: 0, zoom: 1 } })
    /** 覆盖对象、函数及显式重复值三种合法无变化输入。 */
    const updates: AgentCanvasViewStateUpdate[] = [
      {},
      () => ({}),
      (current) => ({ workbenchDraft: current.workbenchDraft, viewport: current.viewport }),
    ]
    const originalStates = store.get(agentCanvasViewStatesAtom)
    let notifications = 0
    const unsubscribe = store.sub(agentCanvasViewStatesAtom, () => { notifications += 1 })
    try {
      for (const update of updates) store.set(updateAgentCanvasViewStateAtom, { key, update })
      expect(notifications).toBe(0)
      expect(store.get(agentCanvasViewStatesAtom)).toBe(originalStates)
    } finally {
      unsubscribe()
    }
  })

  test('Given 工作台在视图变化后重复上报已知状态 When 编辑并保存草稿 Then 每次真实变化只通知一次', () => {
    /** 订阅后再次上报空更新，复现工作台 Effect 与父视图之间的反馈链。 */
    const store = createStore()
    const key = createAgentCanvasViewKey('session-a', 'project-a', 'canvas-a')
    store.set(initializeAgentCanvasViewStateAtom, { key, viewport: { x: 0, y: 0, zoom: 1 } })
    store.set(updateAgentCanvasViewStateAtom, { key, update: { expandedNodeId: 'node-a' } })
    let notifications = 0
    const unsubscribe = store.sub(agentCanvasViewStatesAtom, () => {
      notifications += 1
      /** 失败时有界退出，防止回归测试本身进入无限循环。 */
      if (notifications < 10) store.set(updateAgentCanvasViewStateAtom, { key, update: () => ({}) })
    })
    try {
      store.set(updateAgentCanvasViewStateAtom, {
        key,
        update: { workbenchDraft: { nodeId: 'node-a', dirty: true } },
      })
      expect(notifications).toBe(1)
      expect(store.get(agentCanvasViewStatesAtom).get(key)?.workbenchDraft)
        .toEqual({ nodeId: 'node-a', dirty: true })

      store.set(updateAgentCanvasViewStateAtom, { key, update: { workbenchDraft: null } })
      expect(notifications).toBe(2)
      expect(store.get(agentCanvasViewStatesAtom).get(key)?.workbenchDraft).toBeNull()
    } finally {
      unsubscribe()
    }
  })

  test('Given 旧屏幕尺寸尚未迁移 When 连续收到空更新 Then 首次完成迁移且不重复通知', () => {
    /** 空业务更新仍须完成 HMR 遗留尺寸的一次性迁移。 */
    const store = createStore()
    const key = createAgentCanvasViewKey('session-a', 'project-a', 'canvas-a')
    const legacy = createInitialAgentCanvasViewState({ x: 0, y: 0, zoom: 2 })
    delete legacy.workbenchSizeSpace
    legacy.workbenchSizesByNodeId = { 'node-a': { width: 1_000, height: 720 } }
    store.set(agentCanvasViewStatesAtom, new Map([[key, legacy]]))
    let notifications = 0
    const unsubscribe = store.sub(agentCanvasViewStatesAtom, () => { notifications += 1 })
    try {
      store.set(updateAgentCanvasViewStateAtom, { key, update: () => ({}) })
      expect(notifications).toBe(1)
      expect(store.get(agentCanvasViewStatesAtom).get(key)).toMatchObject({
        workbenchSizeSpace: 'canvas',
        workbenchSizesByNodeId: { 'node-a': { width: 500, height: 360 } },
      })
      store.set(updateAgentCanvasViewStateAtom, { key, update: () => ({}) })
      expect(notifications).toBe(1)
    } finally {
      unsubscribe()
    }
  })

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

  test('Given HMR 已有旧屏幕尺寸 When 同一视图重新初始化 Then 使用旧 zoom 固化为画布尺寸', () => {
    const store = createStore()
    const key = createAgentCanvasViewKey('session-a', 'project-a', 'canvas-a')
    const legacy = createInitialAgentCanvasViewState({ x: 10, y: 20, zoom: 2 })
    delete legacy.workbenchSizeSpace
    legacy.workbenchSizesByNodeId = { 'node-a': { width: 1_000, height: 720 } }
    store.set(agentCanvasViewStatesAtom, new Map([[key, legacy]]))

    store.set(initializeAgentCanvasViewStateAtom, {
      key,
      viewport: { x: 0, y: 0, zoom: 1 },
    })

    expect(store.get(agentCanvasViewStatesAtom).get(key)).toMatchObject({
      viewport: { x: 10, y: 20, zoom: 2 },
      workbenchSizeSpace: 'canvas',
      workbenchSizesByNodeId: { 'node-a': { width: 500, height: 360 } },
    })
  })

  test('Given 旧屏幕尺寸尚未初始化迁移 When 用户先缩放 Then 按旧 zoom 固化后再更新视口', () => {
    const store = createStore()
    const key = createAgentCanvasViewKey('session-a', 'project-a', 'canvas-a')
    const legacy = createInitialAgentCanvasViewState({ x: 0, y: 0, zoom: 2 })
    delete legacy.workbenchSizeSpace
    legacy.workbenchSizesByNodeId = { 'node-a': { width: 1_000, height: 720 } }
    store.set(agentCanvasViewStatesAtom, new Map([[key, legacy]]))

    store.set(updateAgentCanvasViewStateAtom, {
      key,
      update: { viewport: { x: 30, y: 40, zoom: 4 } },
    })

    const next = store.get(agentCanvasViewStatesAtom).get(key)
    expect(next?.viewport).toEqual({ x: 30, y: 40, zoom: 4 })
    expect(next && resolveAgentCanvasWorkbenchSize(next, 'node-a'))
      .toEqual({ width: 500, height: 360 })
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
