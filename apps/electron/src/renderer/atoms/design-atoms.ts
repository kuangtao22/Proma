import type {
  DesignJobRecord,
  DesignMutation,
  DesignPoint,
  DesignViewport,
  DesignWorkspaceSnapshot,
} from '@proma/shared'
import { atom } from 'jotai'

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
