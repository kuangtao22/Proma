/**
 * 侧边栏状态 Atoms
 *
 * 管理侧边栏视图模式（活跃 / 今日活动 / 已归档）。
 */

import { atom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'

/**
 * 侧边栏视图模式。
 * - `active`：活跃视图（置顶 + 项目/对话历史），侧栏默认视图；
 * - `today`：今日活动视图，跨项目展示「最后一次对话发生在今天」的会话；
 * - `archived`：已归档视图，按需加载归档元数据。
 */
export type SidebarViewMode = 'active' | 'archived' | 'today'

/** 侧边栏视图模式（active = 活跃，today = 今日活动，archived = 已归档） */
export const sidebarViewModeAtom = atom<SidebarViewMode>('active')

/** 项目列表高度（px），用户可拖拽调整，持久化到 localStorage */
export const projectListHeightAtom = atomWithStorage<number>(
  'proma-workspace-list-height',
  120,
)

/** 左侧边栏宽度（px），用户可拖拽调整，持久化到 localStorage */
export const leftSidebarWidthAtom = atomWithStorage<number>(
  'proma-left-sidebar-width',
  240,
)
