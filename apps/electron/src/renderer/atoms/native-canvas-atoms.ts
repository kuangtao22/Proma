import type { CanvasMutation, CanvasWorkspaceSnapshot } from '@proma/shared'
import { atom } from 'jotai'

/** 原生 Canvas 单工作区的加载阶段。 */
export type NativeCanvasPhase = 'idle' | 'loading' | 'ready' | 'error'

/** 原生 Canvas mutation 保存阶段。 */
export type NativeCanvasSaveState = 'saved' | 'dirty' | 'saving' | 'failed' | 'conflict'

/** 按项目与 Canvas 双重身份隔离的 Renderer 状态。 */
export interface NativeCanvasState {
  phase: NativeCanvasPhase
  snapshot: CanvasWorkspaceSnapshot | null
  pendingMutations: CanvasMutation[]
  inFlightMutations: CanvasMutation[]
  saveState: NativeCanvasSaveState
  selectedNodeId: string | null
  conversationNodeId: string | null
  authoritativeRecoveryState: 'idle' | 'loading' | 'failed'
  error: string | null
}

/** 创建互不共享数组引用的原生 Canvas 初始状态。 */
export function createInitialNativeCanvasState(): NativeCanvasState {
  return {
    phase: 'idle',
    snapshot: null,
    pendingMutations: [],
    inFlightMutations: [],
    saveState: 'saved',
    selectedNodeId: null,
    conversationNodeId: null,
    authoritativeRecoveryState: 'idle',
    error: null,
  }
}

/**
 * 创建项目与 Canvas 组合键。
 * @param projectId Canvas 所属项目 ID。
 * @param canvasId Canvas 会话 ID。
 * @returns 用于 Renderer Map 隔离的稳定键。
 */
export function createNativeCanvasKey(projectId: string, canvasId: string): string {
  return `${projectId}:${canvasId}`
}

/** 所有已挂载原生 Canvas 的隔离状态。 */
export const nativeCanvasStatesAtom = atom<Map<string, NativeCanvasState>>(new Map())

/** 单个原生 Canvas 状态更新输入。 */
export interface UpdateNativeCanvasStateInput {
  key: string
  update: Partial<NativeCanvasState> | ((current: NativeCanvasState) => Partial<NativeCanvasState>)
}

/** 只复制 Map 与目标状态的原子更新入口。 */
export const updateNativeCanvasStateAtom = atom(
  null,
  (get, set, input: UpdateNativeCanvasStateInput): void => {
    /** 未挂载过的键始终取得全新数组，避免跨 Canvas 共享队列。 */
    const states = get(nativeCanvasStatesAtom)
    const current = states.get(input.key) ?? createInitialNativeCanvasState()
    const update = typeof input.update === 'function' ? input.update(current) : input.update
    const nextStates = new Map(states)
    nextStates.set(input.key, { ...current, ...update })
    set(nativeCanvasStatesAtom, nextStates)
  },
)
