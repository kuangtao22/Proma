import type { AgentStreamCompletePayload, AgentStreamSessionMeta } from '@proma/shared'
import type { TabItem } from '@/atoms/tab-atoms'
import { isDelegationObservationVisible } from '@/lib/agent-session-list'

export interface AgentCompletionPresenceInput {
  tabs: TabItem[]
  activeTabId: string | null
  currentAgentSessionId: string | null
  sessionId: string
  /** 委派子会话由父会话汇总，不计入用户级未读完成。 */
  session?: Pick<AgentStreamSessionMeta, 'sourceDelegationId' | 'sourceCanvasProjectId'>
  /** 完成发生时应用窗口是否处于前台。窗口失焦时即使是当前 Tab 也不算"正在查看"。 */
  documentHasFocus: boolean
}

export interface AgentCompletionMarkers {
  markUnviewedCompleted: boolean
}

export interface AgentCompletionNotificationInput {
  completion: AgentStreamCompletePayload
  session?: Pick<AgentStreamSessionMeta, 'sourceDelegationId' | 'sourceCanvasProjectId' | 'parentSessionId'>
}

export interface NotifyAgentCompletionInput extends AgentCompletionNotificationInput {
  hasStreamError: boolean
  notify: () => void
}

/** 仅顶层 Agent 会话完成属于用户级任务完成提醒边界 */
export function shouldNotifyAgentCompletion({
  completion,
  session,
}: AgentCompletionNotificationInput): boolean {
  return completion.triggeredBy !== 'delegation'
    && !session?.sourceDelegationId
    && !session?.sourceCanvasProjectId
}

export function markSessionCompletionUnviewed(
  sessionIds: Set<string>,
  sessionId: string,
): Set<string> {
  if (sessionIds.has(sessionId)) return sessionIds
  const next = new Set(sessionIds)
  next.add(sessionId)
  return next
}

export function markSessionCompletionViewed(
  sessionIds: Set<string>,
  sessionId: string,
): Set<string> {
  if (!sessionIds.has(sessionId)) return sessionIds
  const next = new Set(sessionIds)
  next.delete(sessionId)
  return next
}

export function isSuccessfulAgentCompletion(
  completion: AgentStreamCompletePayload,
  hasStreamError: boolean,
): boolean {
  return !completion.stoppedByUser &&
    !hasStreamError &&
    (!completion.resultSubtype || completion.resultSubtype === 'success')
}

export type DelegatedCompletionAttention = 'viewed' | 'unviewed' | null

interface DelegatedCompletionAttentionInput extends AgentCompletionNotificationInput {
  hasStreamError: boolean
  activeSessionId: string | null
  selectedDelegationSessionId: string | null
  activeSidePanelTab: string | undefined
  split: { leftTab: string; rightTab: string } | null
  sidePanelOpen: boolean
  windowHasFocus: boolean
}

/** Resolve delegated completion to one attention transition; null means no state change. */
export function getDelegatedCompletionAttention({
  completion,
  session,
  hasStreamError,
  activeSessionId,
  selectedDelegationSessionId,
  activeSidePanelTab,
  split,
  sidePanelOpen,
  windowHasFocus,
}: DelegatedCompletionAttentionInput): DelegatedCompletionAttention {
  if (session?.sourceCanvasProjectId) return null
  if (completion.triggeredBy !== 'delegation' && !session?.sourceDelegationId) return null

  const visible = !!session?.parentSessionId
    && windowHasFocus
    && activeSessionId === session.parentSessionId
    && selectedDelegationSessionId === completion.sessionId
    && isDelegationObservationVisible(sidePanelOpen, activeSidePanelTab, split)
  if (visible) return 'viewed'

  return !completion.backgroundTasksPending && isSuccessfulAgentCompletion(completion, hasStreamError)
    ? 'unviewed'
    : null
}

/** 仅在真正成功且无需等待后台任务时调用完成通知 callback */
export function notifyAgentCompletion({
  completion,
  session,
  hasStreamError,
  notify,
}: NotifyAgentCompletionInput): void {
  if (!completion.backgroundTasksPending &&
    isSuccessfulAgentCompletion(completion, hasStreamError) &&
    shouldNotifyAgentCompletion({ completion, session })) {
    notify()
  }
}

/** 仅为普通 Agent 分派异常完成 toast，Canvas 与损坏内部会话使用各自状态表面。 */
export function notifyAgentCompletionWarning(
  routeKind: 'agent' | 'canvas' | 'internal-invalid',
  completion: AgentStreamCompletePayload,
  warn: (message: string) => void,
): void {
  if (routeKind !== 'agent'
    || !completion.resultSubtype
    || completion.resultSubtype === 'success'
    || completion.stoppedByUser) return
  /** 各 SDK 终态的稳定用户提示。 */
  const messages: Record<string, string> = {
    error_max_turns: '任务被中断：已达到轮次上限。继续对话可让 Agent 接着完成。',
    error_max_budget_usd: '任务被中断：已达到预算上限。',
    error_during_execution: '任务执行过程中发生错误。',
    empty_response: 'Agent 本轮结束了，但没有返回任何可展示内容。你的消息已保留，可以直接重试或切换模型。',
  }
  const detail = completion.resultErrors?.find((error) => error.trim().length > 0)?.trim()
  warn(detail
    ? `任务执行出错：${detail}`
    : messages[completion.resultSubtype] ?? `任务异常结束（${completion.resultSubtype}）`)
}

/** 判断 Agent 完成时用户是否仍停留在该会话入口 */
export function isAgentSessionActiveForCompletion({
  tabs,
  activeTabId,
  currentAgentSessionId,
  sessionId,
  documentHasFocus,
}: AgentCompletionPresenceInput): boolean {
  // 窗口不在前台时用户不可能正在查看，一律按"未查看"处理，
  // 与角标清除端（依赖 document.hasFocus()）的语义保持对齐。
  if (!documentHasFocus) return false

  const activeTab = activeTabId ? tabs.find((tab) => tab.id === activeTabId) : null
  if (activeTab) {
    return (activeTab.type === 'agent' || activeTab.type === 'preview') && activeTab.sessionId === sessionId
  }

  return currentAgentSessionId === sessionId
}

/** 计算 Agent 完成后是否需要写入侧边栏完成提醒 */
export function getAgentCompletionMarkers(input: AgentCompletionPresenceInput): AgentCompletionMarkers {
  const isActiveSession = isAgentSessionActiveForCompletion(input)
  return {
    markUnviewedCompleted: !input.session?.sourceDelegationId
      && !input.session?.sourceCanvasProjectId
      && !isActiveSession,
  }
}
