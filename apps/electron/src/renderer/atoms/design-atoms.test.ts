import { describe, expect, test } from 'bun:test'
import { createEmptyDesignDocument } from '@proma/shared'
import type { DesignWorkspaceSnapshot } from '@proma/shared'
import { createStore } from 'jotai'
import {
  consumeDesignRecoveryRequestAtom,
  createInitialDesignProjectState,
  designRecoveryRequestsAtom,
  designProjectStatesAtom,
  executeDesignEditAtom,
  requestDesignRecoveryAtom,
  undoDesignEditAtom,
  updateDesignProjectStateAtom,
} from './design-atoms'

/** 创建指定项目的可写测试快照。 */
function createSnapshot(projectId: string): DesignWorkspaceSnapshot {
  return { document: createEmptyDesignDocument(projectId, 10), writable: true }
}

describe('Design 项目状态', () => {
  test('Given 右栏请求项目恢复 When 画布消费请求 Then 仅清除目标项目的一次性信号', () => {
    const store = createStore()

    store.set(requestDesignRecoveryAtom, { projectId: 'project-1' })
    store.set(requestDesignRecoveryAtom, { projectId: 'project-2' })
    expect(store.get(designRecoveryRequestsAtom)).toEqual(new Set(['project-1', 'project-2']))

    store.set(consumeDesignRecoveryRequestAtom, { projectId: 'project-1' })
    expect(store.get(designRecoveryRequestsAtom)).toEqual(new Set(['project-2']))
  })

  test('Given 新项目 When 创建初始状态 Then 不携带冲突恢复任务', () => {
    expect(createInitialDesignProjectState().conflictRecoveryPending).toBe(false)
    expect(createInitialDesignProjectState().authoritativeRecoveryState).toBe('idle')
  })

  test('Given 两个新项目 When 创建初始状态 Then 生图模型状态独立且不共享空数组', () => {
    const first = createInitialDesignProjectState()
    const second = createInitialDesignProjectState()

    expect(first.imageModelLoadState).toBe('idle')
    expect(first.imageModelProfileId).toBeNull()
    expect(first.invalidImageModelProfileId).toBeNull()
    expect(first.imageModelError).toBeNull()
    expect(first.imageModelOptions).toEqual([])
    expect(first.imageModelOptions).not.toBe(second.imageModelOptions)
  })

  test('Given 权威恢复正在加载 When 执行编辑或撤销 Then 旧快照保持不变', () => {
    const store = createStore()
    const snapshot = createSnapshot('project-1')
    snapshot.document.assets = [{
      id: 'asset-1', filename: 'old.png', relativePath: 'assets/old.png',
      thumbnailRelativePath: 'thumbnails/old.webp', mediaType: 'image/png',
      width: 100, height: 100, byteSize: 10, sha256: 'hash', createdAt: 1,
    }]
    snapshot.document.nodes = [{
      id: 'node-1', kind: 'asset', assetId: 'asset-1', position: { x: 0, y: 0 },
      width: 100, height: 100, zIndex: 0,
    }]
    /** 旧基线历史用于验证恢复中撤销同样被阻断。 */
    const history = [{
      forward: [{ type: 'set-viewport' as const, viewport: { x: 1, y: 1, zoom: 1 } }],
      inverse: [{ type: 'set-viewport' as const, viewport: { x: 0, y: 0, zoom: 1 } }],
    }]
    store.set(designProjectStatesAtom, new Map([['project-1', {
      ...createInitialDesignProjectState(),
      phase: 'ready',
      snapshot,
      selectedNodeIds: ['node-1'],
      history,
      authoritativeRecoveryState: 'loading',
      saveState: 'failed',
    }]]))

    store.set(executeDesignEditAtom, {
      projectId: 'project-1',
      command: {
        type: 'duplicate-selection',
        nodeIds: ['node-1'],
        duplicateNodeIds: ['node-copy'],
      },
    })
    store.set(undoDesignEditAtom, { projectId: 'project-1' })

    const state = store.get(designProjectStatesAtom).get('project-1')!
    expect(state.snapshot).toBe(snapshot)
    expect(state.snapshot?.document.nodes.map((node) => node.id)).toEqual(['node-1'])
    expect(state.history).toBe(history)
    expect(state.pendingMutations).toEqual([])
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
