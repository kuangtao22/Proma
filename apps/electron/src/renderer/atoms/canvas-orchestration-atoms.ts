import type { CanvasOrchestrationRecord } from '@proma/shared'
import { atom } from 'jotai'

/** 单个画布编排记录的 Renderer 加载状态。 */
export interface CanvasOrchestrationState {
  phase: 'idle' | 'loading' | 'ready' | 'error'
  record: CanvasOrchestrationRecord | null
  error: string | null
}

/** 创建不共享对象引用的编排初始状态。 */
export function createInitialCanvasOrchestrationState(): CanvasOrchestrationState {
  return { phase: 'idle', record: null, error: null }
}

/** 使用结构化编码创建项目与画布双身份键。 */
export function createCanvasOrchestrationKey(projectId: string, canvasId: string): string {
  return JSON.stringify([projectId, canvasId])
}

/** 所有已读取画布的轻量编排状态。 */
export const canvasOrchestrationStatesAtom = atom<Map<string, CanvasOrchestrationState>>(new Map())

/** 创建只订阅单个画布编排状态的派生 atom。 */
export function createCanvasOrchestrationStateAtom(key: string) {
  return atom((get) => get(canvasOrchestrationStatesAtom).get(key) ?? null)
}

/** 编排状态支持局部对象或基于当前值的函数更新。 */
export type CanvasOrchestrationStateUpdate = Partial<CanvasOrchestrationState>
  | ((current: CanvasOrchestrationState) => Partial<CanvasOrchestrationState>)

/** 更新单个画布编排状态的完整输入。 */
export interface UpdateCanvasOrchestrationStateInput {
  key: string
  update: CanvasOrchestrationStateUpdate
}

/** 只复制状态 Map 与目标对象，避免其它画布订阅发生无关重绘。 */
export const updateCanvasOrchestrationStateAtom = atom(
  null,
  (get, set, input: UpdateCanvasOrchestrationStateInput): void => {
    const states = get(canvasOrchestrationStatesAtom)
    const current = states.get(input.key) ?? createInitialCanvasOrchestrationState()
    const update = typeof input.update === 'function' ? input.update(current) : input.update
    const nextStates = new Map(states)
    nextStates.set(input.key, { ...current, ...update })
    set(canvasOrchestrationStatesAtom, nextStates)
  },
)

/** 删除最后一个视图已释放的画布编排状态，保留其它画布对象引用稳定。 */
export const removeCanvasOrchestrationStateAtom = atom(
  null,
  (get, set, key: string): void => {
    const states = get(canvasOrchestrationStatesAtom)
    if (!states.has(key)) return
    const nextStates = new Map(states)
    nextStates.delete(key)
    set(canvasOrchestrationStatesAtom, nextStates)
  },
)
