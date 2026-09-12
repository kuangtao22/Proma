import type { SDKAssistantMessage, SDKMessage, SDKResultMessage } from '@proma/shared'

/** Agent 回合结束后需要向用户明确展示的 Host 终态。 */
export interface AgentTerminalNotice {
  kind: 'blocked' | 'error'
  title: string
  detail: string
}

/** Host 完成策略终态与用户可理解标题的稳定映射。 */
const COMPLETION_TITLES: Readonly<Record<string, { kind: AgentTerminalNotice['kind']; title: string }>> = {
  completion_blocked: { kind: 'blocked', title: '交付检查尚未通过' },
  completion_check_failed: { kind: 'error', title: '交付检查失败' },
  completion_continuation_limit: { kind: 'blocked', title: '自动续行已达上限' },
  completion_continuation_unavailable: { kind: 'blocked', title: '当前无法继续完成任务' },
}

/** 从一次回合的消息中选择最终非压缩结果，确保显示以 Host 最终事实为准。 */
function findFinalResult(messages: readonly SDKMessage[]): SDKResultMessage | undefined {
  return messages.findLast((message): message is SDKResultMessage => (
    message.type === 'result' && !(message as SDKResultMessage).isSyntheticCompactionResult
  ))
}

/**
 * 解析需要贴在助手回复后的 Host 终态提示。
 *
 * 成功结果无需额外占用界面；已有助手错误横幅时也不重复展示同一轮运行错误。
 */
export function resolveAgentTerminalNotice(
  turnMessages: readonly SDKMessage[],
  assistantMessages: readonly SDKAssistantMessage[],
): AgentTerminalNotice | null {
  const terminalResult = findFinalResult(turnMessages)
  if (!terminalResult || terminalResult.subtype === 'success') return null

  const completionPresentation = terminalResult.terminal_reason
    ? COMPLETION_TITLES[terminalResult.terminal_reason]
    : undefined
  if (!completionPresentation && assistantMessages.some((message) => message.error != null)) return null

  const detail = terminalResult.errors
    ?.find((error) => error.trim().length > 0)
    ?.trim()
    ?? '本轮任务尚未确认完成，请检查当前状态后继续。'

  return completionPresentation
    ? { ...completionPresentation, detail }
    : { kind: 'error', title: '任务异常结束', detail }
}
