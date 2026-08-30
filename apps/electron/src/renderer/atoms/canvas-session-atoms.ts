import type { CanvasSessionMeta } from '@proma/shared'
import { atom } from 'jotai'

/** Canvas registry 写操作使用的双重稳定身份。 */
export interface CanvasSessionTarget {
  projectId: string
  canvasId: string
}

/** 替换单项目 Canvas 权威列表的输入。 */
export interface ReplaceCanvasSessionsInput {
  projectId: string
  sessions: CanvasSessionMeta[]
}

/** 单项目 Canvas 索引的 Renderer 加载状态。 */
export interface CanvasSessionProjectStatus {
  phase: 'idle' | 'loading' | 'ready' | 'failed'
  error: string | null
}

/** 更新单项目 Canvas 加载状态的输入。 */
export interface SetCanvasSessionProjectStatusInput extends CanvasSessionProjectStatus {
  projectId: string
}

/** 按项目保存全部 Canvas 元数据，归档筛选由消费组件完成。 */
export const canvasSessionsByProjectAtom = atom<Map<string, CanvasSessionMeta[]>>(new Map())

/** 按项目隔离 Canvas 索引加载状态，避免单项目故障阻断整个侧栏。 */
export const canvasSessionStatusByProjectAtom = atom<Map<string, CanvasSessionProjectStatus>>(new Map())

/** 只更新目标项目的 Canvas 索引加载状态。 */
export const setCanvasSessionProjectStatusAtom = atom(
  null,
  (get, set, input: SetCanvasSessionProjectStatusInput): void => {
    /** 只复制 Map 与目标状态对象，保持其它项目引用稳定。 */
    const next = new Map(get(canvasSessionStatusByProjectAtom))
    next.set(input.projectId, { phase: input.phase, error: input.error })
    set(canvasSessionStatusByProjectAtom, next)
  },
)

/** 替换单项目 Canvas registry 列表。 */
export const replaceCanvasSessionsAtom = atom(
  null,
  (get, set, input: ReplaceCanvasSessionsInput): void => {
    if (input.sessions.some((session) => session.projectId !== input.projectId)) {
      throw new Error('Canvas 会话项目归属不匹配')
    }
    /** 只复制 Map 和目标项目数组，保持其它项目引用稳定。 */
    const next = new Map(get(canvasSessionsByProjectAtom))
    next.set(input.projectId, [...input.sessions])
    set(canvasSessionsByProjectAtom, next)
  },
)

/** 插入或替换单条 Canvas 元数据，并按更新时间倒序维护项目列表。 */
export const upsertCanvasSessionAtom = atom(
  null,
  (get, set, session: CanvasSessionMeta): void => {
    /** 当前项目列表可能尚未加载，单次创建结果仍可直接建立缓存。 */
    const current = get(canvasSessionsByProjectAtom).get(session.projectId) ?? []
    const nextSessions = current
      .filter((item) => item.id !== session.id)
      .concat(session)
      .sort((left, right) => right.updatedAt - left.updatedAt)
    set(replaceCanvasSessionsAtom, {
      projectId: session.projectId,
      sessions: nextSessions,
    })
  },
)

/** 删除单条 Canvas 元数据。 */
export const removeCanvasSessionAtom = atom(
  null,
  (get, set, input: CanvasSessionTarget): void => {
    /** 只复制目标项目列表，保持其它项目引用和加载状态稳定。 */
    const current = get(canvasSessionsByProjectAtom).get(input.projectId) ?? []
    const nextSessions = current.filter((session) => session.id !== input.canvasId)
    set(replaceCanvasSessionsAtom, { projectId: input.projectId, sessions: nextSessions })
  },
)
