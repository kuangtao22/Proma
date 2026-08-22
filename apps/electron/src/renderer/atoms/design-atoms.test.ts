import { describe, expect, test } from 'bun:test'
import { createEmptyDesignDocument } from '@proma/shared'
import type { DesignWorkspaceSnapshot } from '@proma/shared'
import { createStore } from 'jotai'
import {
  createInitialDesignProjectState,
  designProjectStatesAtom,
  updateDesignProjectStateAtom,
} from './design-atoms'

/** 创建指定项目的可写测试快照。 */
function createSnapshot(projectId: string): DesignWorkspaceSnapshot {
  return { document: createEmptyDesignDocument(projectId, 10), writable: true }
}

describe('Design 项目状态', () => {
  test('Given 新项目 When 创建初始状态 Then 不携带冲突恢复任务', () => {
    expect(createInitialDesignProjectState().conflictRecoveryPending).toBe(false)
  })

  test('Given 两个项目 When 更新其中一个 Then 另一个画布状态保持引用与内容', () => {
    const store = createStore()
    store.set(updateDesignProjectStateAtom, {
      projectId: 'project-1',
      update: { phase: 'ready', snapshot: createSnapshot('project-1') },
    })
    store.set(updateDesignProjectStateAtom, {
      projectId: 'project-2',
      update: { phase: 'ready', snapshot: createSnapshot('project-2') },
    })
    /** 更新前第二个项目对象用于验证引用稳定性。 */
    const before = store.get(designProjectStatesAtom).get('project-2')

    store.set(updateDesignProjectStateAtom, {
      projectId: 'project-1',
      update: { selectedNodeIds: ['node-1'] },
    })

    expect(store.get(designProjectStatesAtom).get('project-2')).toBe(before)
    expect(store.get(designProjectStatesAtom).get('project-1')?.selectedNodeIds).toEqual(['node-1'])
  })

  test('Given 历史超过上限 When 更新项目状态 Then 只保留最近 100 项', () => {
    const store = createStore()
    /** 超出上限的历史用于验证统一裁剪。 */
    const history = Array.from({ length: 101 }, (_, index) => ({
      forward: [{ type: 'set-viewport' as const, viewport: { x: index, y: 0, zoom: 1 } }],
      inverse: [{ type: 'set-viewport' as const, viewport: { x: index - 1, y: 0, zoom: 1 } }],
    }))

    store.set(updateDesignProjectStateAtom, { projectId: 'project-1', update: { history } })

    const state = store.get(designProjectStatesAtom).get('project-1') ?? createInitialDesignProjectState()
    expect(state.history).toHaveLength(100)
    expect(state.history[0]?.forward[0]).toMatchObject({ type: 'set-viewport', viewport: { x: 1 } })
  })
})
