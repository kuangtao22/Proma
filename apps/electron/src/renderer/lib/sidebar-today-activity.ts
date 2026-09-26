/**
 * 侧栏「今日活动」视图的数据选择逻辑。
 *
 * 只做内存过滤与排序，不读取磁盘、不发起 IPC，便于单独测试：
 * - 保留「最后一次对话发生在本地今日」的会话；
 * - 按最后一次对话时间（`updatedAt`）降序，供跨项目的当日活动列表直接渲染。
 *
 * 有意排除的两类：已归档会话（归档有独立入口，且 active 视图不加载归档元数据）
 * 与未发送首条消息的草稿会话（避免侧栏冒出空会话）。
 */

import type { AgentSessionMeta, ConversationMeta } from '@proma/shared'
import { sortAgentSessionsByUpdatedAtDesc } from './agent-session-list'

/**
 * 计算某时间戳所属自然日的起点（本地时区 00:00:00.000）。
 *
 * 由调用方传入「当前时间」，一方面便于测试固定时间点，另一方面让跨零点后
 * 列表能随相对时间刷新自动重算。
 *
 * @param now 作为「今天」判据的当前时间戳
 * @returns 本地当日零点的时间戳
 */
export function getTodayStartTimestamp(now: number): number {
  const date = new Date(now)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

interface TodaySelectionInput {
  /** 用于判断「今天」的当前时间戳 */
  now: number
  /** 需要排除的会话 id（渲染进程内尚未落盘的输入态草稿会话） */
  excludedSessionIds?: ReadonlySet<string>
}

/**
 * 筛选今日 Chat 对话。
 *
 * @param conversations 已加载的对话元数据（active 视图只含未归档数据）
 * @param now 当前时间戳
 * @param excludedSessionIds 需要额外排除的草稿会话 id
 * @returns 今日对话按最后一次对话时间降序的副本；不修改入参数组
 */
export function selectTodayConversations({
  conversations,
  now,
  excludedSessionIds = new Set<string>(),
}: TodaySelectionInput & {
  conversations: readonly ConversationMeta[]
}): ConversationMeta[] {
  const todayStart = getTodayStartTimestamp(now)
  return conversations
    .filter((conversation) => (
      !conversation.archived
      && !excludedSessionIds.has(conversation.id)
      && conversation.updatedAt >= todayStart
    ))
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

/**
 * 筛选今日 Agent 会话。
 *
 * 保留委派子会话与定时任务会话（它们同样属于当天的会话活动），
 * 仅排除已归档、草稿与内部执行会话（内部执行会话由
 * `sortAgentSessionsByUpdatedAtDesc` 统一过滤，与侧栏其它入口保持一致）。
 *
 * @param sessions 已加载的 Agent 会话元数据（active 视图只含未归档数据）
 * @param now 当前时间戳
 * @param excludedSessionIds 需要额外排除的草稿会话 id
 * @returns 今日会话按最后一次对话时间降序的副本；不修改入参数组
 */
export function selectTodayAgentSessions({
  sessions,
  now,
  excludedSessionIds = new Set<string>(),
}: TodaySelectionInput & {
  sessions: readonly AgentSessionMeta[]
}): AgentSessionMeta[] {
  const todayStart = getTodayStartTimestamp(now)
  return sortAgentSessionsByUpdatedAtDesc(
    sessions.filter((session) => (
      !session.archived
      && !session.isDraft
      && !excludedSessionIds.has(session.id)
      && session.updatedAt >= todayStart
    )),
  )
}
