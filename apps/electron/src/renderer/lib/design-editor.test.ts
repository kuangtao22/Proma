import { describe, expect, test } from 'bun:test'
import { createEmptyDesignDocument } from '@proma/shared'
import type { DesignCanvasDocument, DesignCanvasNode } from '@proma/shared'
import { createStore } from 'jotai'
import {
  createInitialDesignProjectState,
  designProjectStatesAtom,
  executeDesignEditAtom,
  redoDesignEditAtom,
  undoDesignEditAtom,
} from '@/atoms/design-atoms'
import {
  applyDesignMutations,
  reduceDesignEdit,
  resolveDesignKeyboardAction,
} from './design-editor'
import type { DesignEditCommand } from './design-editor'

/** 创建用于编辑器命令测试的固定节点。 */
function createNode(id: string, x: number, groupId?: string): DesignCanvasNode {
  return {
    id,
    kind: 'asset',
    assetId: `asset-${id}`,
    position: { x, y: x + 10 },
    width: 320,
    height: 240,
    zIndex: 0,
    ...(groupId ? { groupId } : {}),
  }
}

/** 创建只能移动和选择、不能由画布结构命令改写的任务节点。 */
function createJobNode(id: string, x: number, groupId?: string): DesignCanvasNode {
  return {
    id,
    kind: 'job',
    jobId: `job-${id}`,
    position: { x, y: x + 10 },
    width: 320,
    height: 240,
    zIndex: 0,
    ...(groupId ? { groupId } : {}),
  }
}

/** 创建包含两个素材节点的确定性画布文档。 */
function createDocument(): DesignCanvasDocument {
  /** 固定时间避免测试依赖系统时钟。 */
  const document = createEmptyDesignDocument('project-1', 100)
  document.nodes = [createNode('n1', 10), createNode('n2', 40)]
  document.assets = [
    {
      id: 'asset-n1',
      filename: 'one.png',
      relativePath: 'assets/one.png',
      thumbnailRelativePath: 'thumbs/one.webp',
      mediaType: 'image/png',
      width: 320,
      height: 240,
      byteSize: 10,
      sha256: 'one',
      createdAt: 100,
    },
    {
      id: 'asset-n2',
      filename: 'two.png',
      relativePath: 'assets/two.png',
      thumbnailRelativePath: 'thumbs/two.webp',
      mediaType: 'image/png',
      width: 320,
      height: 240,
      byteSize: 20,
      sha256: 'two',
      createdAt: 100,
    },
  ]
  return document
}

describe('Design 编辑 reducer', () => {
  test('Given 已选节点和调用方新 ID When 复制 Then 新节点偏移 24px 且选中新副本', () => {
    /** 原始文档用于验证 reducer 不修改输入。 */
    const document = createDocument()

    const result = reduceDesignEdit(document, {
      type: 'duplicate-selection',
      nodeIds: ['n1'],
      duplicateNodeIds: ['n1-copy'],
    })

    expect(result.document.nodes).toHaveLength(3)
    expect(result.document.nodes[2]).toMatchObject({
      id: 'n1-copy',
      assetId: 'asset-n1',
      position: { x: 34, y: 44 },
    })
    expect(result.selection).toEqual(['n1-copy'])
    expect(document.nodes).toHaveLength(2)
  })

  test('Given 素材节点被选中 When 删除 Then 只删除节点并保留素材记录', () => {
    /** 包含素材记录的原始文档。 */
    const document = createDocument()

    const result = reduceDesignEdit(document, {
      type: 'delete-selection',
      nodeIds: ['n1'],
    })

    expect(result.document.nodes.map((node) => node.id)).toEqual(['n2'])
    expect(result.document.assets.map((asset) => asset.id)).toEqual(['asset-n1', 'asset-n2'])
    expect(result.forward).not.toContainEqual({ type: 'remove-assets', assetIds: ['asset-n1'] })
  })

  test('Given 选区包含 job 节点 When 复制删除分组或取消分组 Then 全部结构命令保持 no-op', () => {
    /** 混合选区用于确认不会只修改其中的素材节点。 */
    const document = createDocument()
    document.nodes.push(createJobNode('j1', 80, 'job-group'))
    document.groups = [{ id: 'job-group', name: '任务组', nodeIds: ['j1'] }]

    const results = [
      reduceDesignEdit(document, {
        type: 'duplicate-selection',
        nodeIds: ['j1'],
        duplicateNodeIds: ['j1-copy'],
      }),
      reduceDesignEdit(document, { type: 'delete-selection', nodeIds: ['n1', 'j1'] }),
      reduceDesignEdit(document, {
        type: 'group-selection',
        nodeIds: ['n1', 'j1'],
        groupId: 'mixed-group',
        name: '混合组',
      }),
      reduceDesignEdit(document, { type: 'ungroup-selection', nodeIds: ['j1'] }),
    ]

    for (const result of results) {
      expect(result.document).toEqual(document)
      expect(result.forward).toEqual([])
      expect(result.inverse).toEqual([])
    }
  })

  test('Given 两个选中节点 When 分组并撤销 Then group 和 node groupId 可完整恢复', () => {
    /** 未分组的原始文档。 */
    const document = createDocument()

    const grouped = reduceDesignEdit(document, {
      type: 'group-selection',
      nodeIds: ['n1', 'n2'],
      groupId: 'g1',
      name: '组 1',
    })

    expect(grouped.document.groups[0]?.nodeIds).toEqual(['n1', 'n2'])
    expect(grouped.document.nodes.map((node) => node.groupId)).toEqual(['g1', 'g1'])
    expect(applyDesignMutations(grouped.document, grouped.inverse)).toEqual(document)
  })

  test('Given 组内全部节点被取消分组 When ungroup Then 清理空组且 inverse 可恢复', () => {
    /** 已分组文档用于验证空组清理。 */
    const document = createDocument()
    document.nodes = [createNode('n1', 10, 'g1'), createNode('n2', 40, 'g1')]
    document.groups = [{ id: 'g1', name: '组 1', nodeIds: ['n1', 'n2'] }]

    const result = reduceDesignEdit(document, {
      type: 'ungroup-selection',
      nodeIds: ['n1', 'n2'],
    })

    expect(result.document.groups).toEqual([])
    expect(result.document.nodes.every((node) => node.groupId === undefined)).toBe(true)
    expect(applyDesignMutations(result.document, result.inverse)).toEqual(document)
  })

  test('Given 箭头批注 When 添加并应用 inverse Then 两点批注可撤销', () => {
    /** 调用方已生成完整且确定的箭头批注。 */
    const annotation = {
      id: 'annotation-1',
      kind: 'arrow' as const,
      from: { x: 1, y: 2 },
      to: { x: 10, y: 20 },
      color: 'hsl(var(--destructive))',
      width: 12,
      createdAt: 200,
    }
    /** 空批注画布。 */
    const document = createDocument()

    const result = reduceDesignEdit(document, { type: 'add-annotation', annotation })

    expect(result.document.annotations[0]).toEqual(annotation)
    expect(applyDesignMutations(result.document, result.inverse)).toEqual(document)
  })

  test('Given 删除非末尾批注 When 应用 inverse Then 精确恢复原绘制层级顺序', () => {
    /** 三条批注的数组顺序即 SVG 绘制层级。 */
    const document = createDocument()
    document.annotations = ['a1', 'a2', 'a3'].map((id, index) => ({
      id,
      kind: 'arrow' as const,
      from: { x: index, y: index },
      to: { x: index + 10, y: index + 10 },
      color: '#000000',
      width: 12,
      createdAt: 200 + index,
    }))

    const removed = reduceDesignEdit(document, { type: 'remove-annotation', annotationId: 'a2' })

    expect(removed.document.annotations.map((annotation) => annotation.id)).toEqual(['a1', 'a3'])
    expect(applyDesignMutations(removed.document, removed.inverse)).toEqual(document)
  })

  test('Given 千节点画布 When 删除分组与取消分组 Then 历史载荷只随选区和受影响分组增长', () => {
    /** 大画布用于识别把完整节点数组塞入 history 的实现。 */
    const document = createDocument()
    document.nodes = Array.from({ length: 1_000 }, (_, index) => createNode(`n${index}`, index))
    document.groups = [{ id: 'existing-group', name: '已有组', nodeIds: ['n10', 'n11'] }]
    document.nodes[10] = createNode('n10', 10, 'existing-group')
    document.nodes[11] = createNode('n11', 11, 'existing-group')

    /** 三类结构编辑均只能携带局部实体。 */
    const deleted = reduceDesignEdit(document, { type: 'delete-selection', nodeIds: ['n500'] })
    const grouped = reduceDesignEdit(document, {
      type: 'group-selection',
      nodeIds: ['n20', 'n21'],
      groupId: 'new-group',
      name: '新组',
    })
    const ungrouped = reduceDesignEdit(document, {
      type: 'ungroup-selection',
      nodeIds: ['n10', 'n11'],
    })

    for (const result of [deleted, grouped, ungrouped]) {
      expect(JSON.stringify({ forward: result.forward, inverse: result.inverse }).length).toBeLessThan(5_000)
    }
    expect(applyDesignMutations(deleted.document, deleted.inverse)).toEqual(document)
    expect(applyDesignMutations(grouped.document, grouped.inverse)).toEqual(document)
    expect(applyDesignMutations(ungrouped.document, ungrouped.inverse)).toEqual(document)
  })
})

describe('Design 编辑历史 Jotai action', () => {
  test('Given 执行编辑 When undo 再 redo Then inverse 入 future 且 forward 恢复', () => {
    /** 独立 store 用于观察完整历史状态机。 */
    const store = createStore()
    /** 可写项目初始状态。 */
    const initialState = {
      ...createInitialDesignProjectState(),
      phase: 'ready' as const,
      snapshot: { document: createDocument(), writable: true },
      selectedNodeIds: ['n1'],
    }
    store.set(designProjectStatesAtom, new Map([['project-1', initialState]]))

    store.set(executeDesignEditAtom, {
      projectId: 'project-1',
      command: { type: 'delete-selection', nodeIds: ['n1'] },
    })
    /** 编辑后的项目状态。 */
    const edited = store.get(designProjectStatesAtom).get('project-1')!
    expect(edited.snapshot?.document.nodes.map((node) => node.id)).toEqual(['n2'])
    expect(edited.history).toHaveLength(1)
    expect(edited.future).toEqual([])
    const historyEntry = edited.history[0]!
    expect(edited.pendingMutations).toEqual(historyEntry.forward)

    store.set(undoDesignEditAtom, { projectId: 'project-1' })
    /** 撤销后的项目状态。 */
    const undone = store.get(designProjectStatesAtom).get('project-1')!
    expect(undone.snapshot?.document.nodes.map((node) => node.id)).toEqual(['n1', 'n2'])
    expect(undone.history).toEqual([])
    expect(undone.future).toHaveLength(1)
    /** pending 队尾必须完整追加本次可能包含多条 mutation 的 inverse。 */
    const inverseLength = historyEntry.inverse.length
    expect(undone.pendingMutations.slice(-inverseLength)).toEqual(historyEntry.inverse)

    store.set(redoDesignEditAtom, { projectId: 'project-1' })
    /** 重做后的项目状态。 */
    const redone = store.get(designProjectStatesAtom).get('project-1')!
    expect(redone.snapshot?.document.nodes.map((node) => node.id)).toEqual(['n2'])
    expect(redone.history).toHaveLength(1)
    expect(redone.future).toEqual([])
    /** redo 同样按原顺序完整追加全部 forward mutation。 */
    const forwardLength = historyEntry.forward.length
    expect(redone.pendingMutations.slice(-forwardLength)).toEqual(historyEntry.forward)
  })

  test('Given job 结构命令或 job 历史 When 执行与撤销 Then 不产生乐观 mutation 或保存状态', () => {
    /** job 节点由任务生命周期拥有，Renderer 只允许移动。 */
    const document = createDocument()
    const jobNode = createJobNode('j1', 80)
    document.nodes.push(jobNode)
    const store = createStore()
    const unsafeHistory = {
      forward: [{ type: 'patch-nodes' as const, removeIds: ['j1'], upserts: [] }],
      inverse: [{
        type: 'patch-nodes' as const,
        removeIds: [],
        upserts: [{ entity: jobNode, index: document.nodes.length - 1 }],
      }],
    }
    store.set(designProjectStatesAtom, new Map([['project-1', {
      ...createInitialDesignProjectState(),
      phase: 'ready' as const,
      snapshot: { document, writable: true },
    }]]))

    store.set(executeDesignEditAtom, {
      projectId: 'project-1',
      command: { type: 'delete-selection', nodeIds: ['j1'] },
    })
    const afterDelete = store.get(designProjectStatesAtom).get('project-1')!
    expect(afterDelete.snapshot?.document).toEqual(document)
    expect(afterDelete.pendingMutations).toEqual([])
    expect(afterDelete.history).toEqual([])
    expect(afterDelete.saveState).toBe('saved')

    store.set(designProjectStatesAtom, new Map([['project-1', {
      ...afterDelete,
      history: [unsafeHistory],
    }]]))
    store.set(undoDesignEditAtom, { projectId: 'project-1' })
    const afterUndo = store.get(designProjectStatesAtom).get('project-1')!
    expect(afterUndo.snapshot?.document).toEqual(document)
    expect(afterUndo.pendingMutations).toEqual([])
    expect(afterUndo.history).toEqual([unsafeHistory])
    expect(afterUndo.saveState).toBe('saved')
  })

  test('Given 混合组只选素材 When 删除分组或取消分组 Then atom 最终防线拒绝间接改写 job 分组', () => {
    /** 混合组内 job 未被选择，但任何成员变更都会间接改写其所属分组。 */
    const document = createDocument()
    document.nodes = [
      createNode('n1', 10, 'mixed-group'),
      createNode('n2', 40, 'mixed-group'),
      createJobNode('j1', 80, 'mixed-group'),
    ]
    document.groups = [{ id: 'mixed-group', name: '混合组', nodeIds: ['n1', 'n2', 'j1'] }]
    /** 三种命令均只选择素材节点，覆盖工具栏与键盘可能绕过的具体 command。 */
    const commands: Array<Extract<DesignEditCommand, { nodeIds: string[] }>> = [
      { type: 'delete-selection', nodeIds: ['n1'] },
      { type: 'group-selection', nodeIds: ['n1', 'n2'], groupId: 'asset-group', name: '素材组' },
      { type: 'ungroup-selection', nodeIds: ['n1'] },
    ]

    for (const command of commands) {
      const store = createStore()
      store.set(designProjectStatesAtom, new Map([['project-1', {
        ...createInitialDesignProjectState(),
        phase: 'ready' as const,
        snapshot: { document, writable: true },
        selectedNodeIds: command.nodeIds,
      }]]))

      store.set(executeDesignEditAtom, { projectId: 'project-1', command })

      const blocked = store.get(designProjectStatesAtom).get('project-1')!
      expect(blocked.snapshot?.document).toBe(document)
      expect(blocked.pendingMutations).toEqual([])
      expect(blocked.history).toEqual([])
      expect(blocked.saveState).toBe('saved')
    }
  })

  test('Given 结构冲突尚未采用远端版本 When 执行结构命令 Then 不追加乐观文档或 pending', () => {
    /** 冲突已接管远端文档，但旧 pending 仍等待用户明确放弃。 */
    const document = createDocument()
    const oldPending = [{ type: 'remove-nodes' as const, nodeIds: ['n2'] }]
    const store = createStore()
    store.set(designProjectStatesAtom, new Map([['project-1', {
      ...createInitialDesignProjectState(),
      phase: 'ready' as const,
      snapshot: { document, writable: true },
      pendingMutations: oldPending,
      conflictRecoveryPending: true,
      saveState: 'failed' as const,
      error: '结构冲突',
    }]]))

    store.set(executeDesignEditAtom, {
      projectId: 'project-1',
      command: { type: 'delete-selection', nodeIds: ['n1'] },
    })

    const blocked = store.get(designProjectStatesAtom).get('project-1')!
    expect(blocked.snapshot?.document).toEqual(document)
    expect(blocked.pendingMutations).toBe(oldPending)
    expect(blocked.history).toEqual([])
    expect(blocked.saveState).toBe('failed')
  })
})

describe('Design 编辑键盘路由', () => {
  test('Given 画布有选区 When 按平台编辑快捷键 Then 返回对应编辑动作', () => {
    expect(resolveDesignKeyboardAction({ key: 'c', metaKey: true }, true)).toBe('duplicate')
    expect(resolveDesignKeyboardAction({ key: 'z', ctrlKey: true }, true)).toBe('undo')
    expect(resolveDesignKeyboardAction({ key: 'Z', ctrlKey: true, shiftKey: true }, true)).toBe('redo')
    expect(resolveDesignKeyboardAction({ key: 'Backspace' }, true)).toBe('delete')
    expect(resolveDesignKeyboardAction({ key: 'Delete' }, true)).toBe('delete')
    expect(resolveDesignKeyboardAction({ key: 'g', metaKey: true }, true)).toBe('group')
    expect(resolveDesignKeyboardAction({ key: 'g', metaKey: true, shiftKey: true }, true)).toBe('ungroup')
  })

  test('Given 输入框或 contenteditable 聚焦 When 按编辑快捷键 Then 不拦截输入', () => {
    expect(resolveDesignKeyboardAction({
      key: 'Backspace',
      target: { tagName: 'INPUT', isContentEditable: false },
    }, true)).toBeNull()
    expect(resolveDesignKeyboardAction({
      key: 'g',
      metaKey: true,
      target: { tagName: 'DIV', isContentEditable: true },
    }, true)).toBeNull()
    expect(resolveDesignKeyboardAction({ key: 'c', metaKey: true }, false)).toBeNull()
  })

  test('Given 选区包含 job 节点 When 按结构编辑快捷键 Then 全部保持 no-op', () => {
    expect(resolveDesignKeyboardAction({ key: 'c', metaKey: true }, true, false)).toBeNull()
    expect(resolveDesignKeyboardAction({ key: 'Backspace' }, true, false)).toBeNull()
    expect(resolveDesignKeyboardAction({ key: 'Delete' }, true, false)).toBeNull()
    expect(resolveDesignKeyboardAction({ key: 'g', metaKey: true }, true, false)).toBeNull()
    expect(resolveDesignKeyboardAction({ key: 'g', metaKey: true, shiftKey: true }, true, false)).toBeNull()
    expect(resolveDesignKeyboardAction({ key: 'z', metaKey: true }, true, false, false)).toBeNull()
    expect(resolveDesignKeyboardAction({ key: 'z', metaKey: true, shiftKey: true }, true, false, true, false)).toBeNull()
  })
})
