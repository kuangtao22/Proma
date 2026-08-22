import type {
  DesignJobRecord,
  DesignMutation,
  DesignPoint,
  DesignViewport,
  DesignWorkspaceSnapshot,
} from '@proma/shared'
import { atom } from 'jotai'
import type { DesignEditCommand } from '@/lib/design-editor'
import {
  applyDesignMutations,
  areDesignMutationsJobSafe,
  reduceDesignEdit,
} from '@/lib/design-editor'

/** 单次可撤销编辑对应的正向与逆向 mutation。 */
export interface DesignHistoryEntry {
  forward: DesignMutation[]
  inverse: DesignMutation[]
}

/** 单个项目完整的设计工作区内存状态。 */
export interface DesignProjectState {
  phase: 'idle' | 'loading' | 'ready' | 'error'
  snapshot: DesignWorkspaceSnapshot | null
  jobs: DesignJobRecord[]
  selectedNodeIds: string[]
  /** 右栏直接选中的素材；允许无画布节点素材进入详情与删除流程。 */
  inspectorAssetId: string | null
  activeTool: 'select' | 'pan' | 'arrow' | 'mask'
  inspectorTab: 'assets' | 'ai' | 'versions'
  history: DesignHistoryEntry[]
  future: DesignHistoryEntry[]
  pendingMutations: DesignMutation[]
  saveState: 'saved' | 'dirty' | 'saving' | 'failed'
  /** revision 冲突后是否仍需加载最新服务端快照并重放 pending。 */
  conflictRecoveryPending: boolean
  error: string | null
  generationPrompt: string
  editPrompt: string
  maskDraft: DesignPoint[]
  viewportDraft: DesignViewport | null
}

/** 单项目撤销历史上限，避免长时间编辑无限增长。 */
const DESIGN_HISTORY_LIMIT = 100

/** 创建互不共享数组引用的项目初始状态。 */
export function createInitialDesignProjectState(): DesignProjectState {
  return {
    phase: 'idle',
    snapshot: null,
    jobs: [],
    selectedNodeIds: [],
    inspectorAssetId: null,
    activeTool: 'select',
    inspectorTab: 'assets',
    history: [],
    future: [],
    pendingMutations: [],
    saveState: 'saved',
    conflictRecoveryPending: false,
    error: null,
    generationPrompt: '',
    editPrompt: '',
    maskDraft: [],
    viewportDraft: null,
  }
}

/** 按稳定项目 ID 保存状态，项目切换不会销毁其他项目内存。 */
export const designProjectStatesAtom = atom<Map<string, DesignProjectState>>(new Map())

export interface UpdateDesignProjectStateInput {
  /** 待更新项目的稳定 ID。 */
  projectId: string
  /** 局部状态，或基于最新状态计算局部更新的函数。 */
  update: Partial<DesignProjectState> | ((current: DesignProjectState) => Partial<DesignProjectState>)
}

/** 只复制 Map 和目标项目对象的局部更新入口。 */
export const updateDesignProjectStateAtom = atom(
  null,
  (get, set, input: UpdateDesignProjectStateInput): void => {
    const states = get(designProjectStatesAtom)
    const current = states.get(input.projectId) ?? createInitialDesignProjectState()
    const update = typeof input.update === 'function' ? input.update(current) : input.update
    /** 历史与 future 均在统一入口裁剪，调用方无需重复维护资源上限。 */
    const next: DesignProjectState = {
      ...current,
      ...update,
      history: update.history?.slice(-DESIGN_HISTORY_LIMIT) ?? current.history,
      future: update.future?.slice(-DESIGN_HISTORY_LIMIT) ?? current.future,
    }
    const nextStates = new Map(states)
    nextStates.set(input.projectId, next)
    set(designProjectStatesAtom, nextStates)
  },
)

/** 对指定项目执行一次可撤销编辑。 */
export interface ExecuteDesignEditInput {
  projectId: string
  command: DesignEditCommand
}

/** 指定项目的历史移动输入。 */
export interface DesignHistoryActionInput {
  projectId: string
}

/** 有未保存编辑时保留 failed 提示，否则进入 dirty 自动保存状态。 */
function nextEditedSaveState(current: DesignProjectState): DesignProjectState['saveState'] {
  return current.saveState === 'failed' ? 'failed' : 'dirty'
}

/** 应用 reducer 正向 mutation、压入历史并清空 redo future。 */
export const executeDesignEditAtom = atom(
  null,
  (get, set, input: ExecuteDesignEditInput): void => {
    /** 项目状态始终按稳定 projectId 读取，避免切项目后的迟到事件污染当前项目。 */
    const current = get(designProjectStatesAtom).get(input.projectId)
    if (!current?.snapshot?.writable || current.conflictRecoveryPending) return
    /** 纯 reducer 同时生成乐观文档和确定性 inverse。 */
    const result = reduceDesignEdit(current.snapshot.document, input.command)
    if (result.forward.length === 0) return
    /** 最终写入口按当前文档复核完整 mutation，阻止间接改写含 job 的分组。 */
    if (!areDesignMutationsJobSafe(current.snapshot.document, result.forward)) return
    set(updateDesignProjectStateAtom, {
      projectId: input.projectId,
      update: {
        snapshot: { ...current.snapshot, document: result.document },
        selectedNodeIds: result.selection,
        inspectorAssetId: null,
        history: [...current.history, { forward: result.forward, inverse: result.inverse }],
        future: [],
        pendingMutations: [...current.pendingMutations, ...result.forward],
        saveState: nextEditedSaveState(current),
      },
    })
  },
)

/** 应用最近一次 inverse，并把历史项移入 future。 */
export const undoDesignEditAtom = atom(
  null,
  (get, set, input: DesignHistoryActionInput): void => {
    /** 撤销必须基于项目最新乐观文档。 */
    const current = get(designProjectStatesAtom).get(input.projectId)
    const entry = current?.history.at(-1)
    if (!current?.snapshot?.writable || current.conflictRecoveryPending || !entry) return
    if (!areDesignMutationsJobSafe(current.snapshot.document, entry.inverse)) return
    set(updateDesignProjectStateAtom, {
      projectId: input.projectId,
      update: {
        snapshot: {
          ...current.snapshot,
          document: applyDesignMutations(current.snapshot.document, entry.inverse),
        },
        selectedNodeIds: [],
        inspectorAssetId: null,
        history: current.history.slice(0, -1),
        future: [...current.future, entry],
        pendingMutations: [...current.pendingMutations, ...entry.inverse],
        saveState: nextEditedSaveState(current),
      },
    })
  },
)

/** 应用 future 最近一次 forward，并把历史项恢复到 history。 */
export const redoDesignEditAtom = atom(
  null,
  (get, set, input: DesignHistoryActionInput): void => {
    /** 重做必须基于项目最新乐观文档。 */
    const current = get(designProjectStatesAtom).get(input.projectId)
    const entry = current?.future.at(-1)
    if (!current?.snapshot?.writable || current.conflictRecoveryPending || !entry) return
    if (!areDesignMutationsJobSafe(current.snapshot.document, entry.forward)) return
    set(updateDesignProjectStateAtom, {
      projectId: input.projectId,
      update: {
        snapshot: {
          ...current.snapshot,
          document: applyDesignMutations(current.snapshot.document, entry.forward),
        },
        selectedNodeIds: [],
        inspectorAssetId: null,
        history: [...current.history, entry],
        future: current.future.slice(0, -1),
        pendingMutations: [...current.pendingMutations, ...entry.forward],
        saveState: nextEditedSaveState(current),
      },
    })
  },
)
