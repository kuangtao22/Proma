import {
  LEGACY_DESIGN_CANVAS_ID,
  type CanvasSessionMeta,
} from '@proma/shared'
import { atom } from 'jotai'

/** 当前主视图选择的 Canvas 双重稳定身份。 */
export interface ActiveCanvasSelection {
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

/** 当前打开的 Canvas；null 表示主视图未处于 Canvas 会话。 */
export const activeCanvasSelectionAtom = atom<ActiveCanvasSelection | null>(null)

/**
 * 解析当前选择对应的可见 Canvas。
 * legacy 兼容入口允许在旧画布首次落盘前使用确定性虚拟元数据，其它缺失会话一律返回 null。
 */
export function resolveActiveCanvasSession(
  selection: ActiveCanvasSelection | null,
  sessionsByProject: Map<string, CanvasSessionMeta[]>,
): CanvasSessionMeta | null {
  if (!selection) return null
  /** 只允许在选择所属项目中按 ID 命中，避免跨项目同名会话串用。 */
  const existing = sessionsByProject
    .get(selection.projectId)
    ?.find((session) => session.id === selection.canvasId)
  if (existing) return existing.archived ? null : existing
  if (selection.canvasId !== LEGACY_DESIGN_CANVAS_ID) return null
  return {
    id: LEGACY_DESIGN_CANVAS_ID,
    projectId: selection.projectId,
    title: '默认设计画布',
    archived: false,
    createdAt: 0,
    updatedAt: 0,
  }
}

/** 已通过项目归属、归档状态和 legacy 兼容规则解析的当前 Canvas。 */
export const activeCanvasSessionAtom = atom((get): CanvasSessionMeta | null => (
  resolveActiveCanvasSession(
    get(activeCanvasSelectionAtom),
    get(canvasSessionsByProjectAtom),
  )
))

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

/** 判断当前选择是否仍指向指定项目中的可见 Canvas。 */
function hasActiveCanvas(
  selection: ActiveCanvasSelection,
  projectId: string,
  sessions: CanvasSessionMeta[],
): boolean {
  if (selection.projectId !== projectId) return true
  if (selection.canvasId === LEGACY_DESIGN_CANVAS_ID
    && !sessions.some((session) => session.id === LEGACY_DESIGN_CANVAS_ID && session.archived)) {
    return true
  }
  return sessions.some((session) => session.id === selection.canvasId && !session.archived)
}

/** 替换单项目列表，同时清理已消失或归档的当前选择。 */
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

    /** 权威列表更新后不允许主视图继续引用已归档 Canvas。 */
    const selection = get(activeCanvasSelectionAtom)
    if (selection && !hasActiveCanvas(selection, input.projectId, input.sessions)) {
      set(activeCanvasSelectionAtom, null)
    }
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

/** 删除单条 Canvas 元数据，并在命中当前选择时同步关闭 Canvas 入口。 */
export const removeCanvasSessionAtom = atom(
  null,
  (get, set, input: ActiveCanvasSelection): void => {
    /** 只复制目标项目列表，保持其它项目引用和加载状态稳定。 */
    const current = get(canvasSessionsByProjectAtom).get(input.projectId) ?? []
    const nextSessions = current.filter((session) => session.id !== input.canvasId)
    set(replaceCanvasSessionsAtom, { projectId: input.projectId, sessions: nextSessions })
  },
)
