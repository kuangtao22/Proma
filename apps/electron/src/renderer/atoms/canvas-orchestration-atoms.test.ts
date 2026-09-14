import { describe, expect, test } from 'bun:test'
import type { CanvasOrchestrationRecord } from '@proma/shared'
import { createStore } from 'jotai'
import {
  canvasOrchestrationStatesAtom,
  createCanvasOrchestrationKey,
  createCanvasOrchestrationStateAtom,
  createInitialCanvasOrchestrationState,
  removeCanvasOrchestrationStateAtom,
  updateCanvasOrchestrationStateAtom,
} from './canvas-orchestration-atoms'

/** 创建 Jotai 隔离测试使用的最小编排记录。 */
function createRecord(canvasId: string): CanvasOrchestrationRecord {
  return {
    schemaVersion: 1,
    id: `orchestration-${canvasId}`,
    revision: 1,
    projectId: 'project-1',
    canvasId,
    ownerSessionId: 'session-1',
    request: {
      requestId: 'request-1', goal: '完成交付', intent: 'produce', constraints: [],
      referenceNodeIds: [], deliverables: [],
    },
    coordinatorNodeId: null,
    coordinatorSessionId: null,
    status: 'planning',
    steps: [],
    summary: '正在规划',
    runStartedAt: null,
    createdAt: 1,
    updatedAt: 1,
  }
}

describe('Canvas 编排 Renderer 状态', () => {
  test('Given 两个画布 When 更新其中一个编排记录 Then 另一个画布保持独立', () => {
    const store = createStore()
    const keyA = createCanvasOrchestrationKey('project-1', 'canvas-a')
    const keyB = createCanvasOrchestrationKey('project-1', 'canvas-b')
    store.set(updateCanvasOrchestrationStateAtom, {
      key: keyA,
      update: { phase: 'ready', record: createRecord('canvas-a') },
    })

    expect(store.get(canvasOrchestrationStatesAtom).get(keyA)?.record?.canvasId).toBe('canvas-a')
    expect(store.get(canvasOrchestrationStatesAtom).get(keyB)).toBeUndefined()
    expect(createInitialCanvasOrchestrationState()).not.toBe(createInitialCanvasOrchestrationState())
  })

  test('Given A 画布派生订阅 When 只更新 B Then A 不发生无关重绘', () => {
    const store = createStore()
    const keyA = createCanvasOrchestrationKey('project-1', 'canvas-a')
    const keyB = createCanvasOrchestrationKey('project-1', 'canvas-b')
    const stateAtomA = createCanvasOrchestrationStateAtom(keyA)
    let notifications = 0
    const release = store.sub(stateAtomA, () => { notifications += 1 })

    store.set(updateCanvasOrchestrationStateAtom, { key: keyB, update: { phase: 'loading' } })
    expect(notifications).toBe(0)
    store.set(updateCanvasOrchestrationStateAtom, { key: keyA, update: { phase: 'loading' } })
    expect(notifications).toBe(1)
    release()
  })

  test('Given A 与 B 都有编排状态 When 最后一个 A 视图释放 Then 只回收 A 且 B 订阅不触发', () => {
    const store = createStore()
    const keyA = createCanvasOrchestrationKey('project-1', 'canvas-a')
    const keyB = createCanvasOrchestrationKey('project-1', 'canvas-b')
    store.set(updateCanvasOrchestrationStateAtom, { key: keyA, update: { phase: 'ready', record: createRecord('canvas-a') } })
    store.set(updateCanvasOrchestrationStateAtom, { key: keyB, update: { phase: 'ready', record: createRecord('canvas-b') } })
    const stateAtomB = createCanvasOrchestrationStateAtom(keyB)
    let notifications = 0
    const release = store.sub(stateAtomB, () => { notifications += 1 })

    store.set(removeCanvasOrchestrationStateAtom, keyA)

    expect(store.get(canvasOrchestrationStatesAtom).has(keyA)).toBe(false)
    expect(store.get(canvasOrchestrationStatesAtom).get(keyB)?.record?.canvasId).toBe('canvas-b')
    expect(notifications).toBe(0)
    release()
  })
})
