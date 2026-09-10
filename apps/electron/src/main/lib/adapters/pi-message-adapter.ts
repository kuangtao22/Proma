/**
 * Pi Agent 消息兼容层。
 *
 * 主进程和渲染层仍使用 Claude SDK 兼容的 SDKMessage 协议；本模块集中处理
 * Pi AgentMessage 与 SDKMessage 之间的形状转换，避免 session 编排代码混入 UI 协议细节。
 */

import { randomUUID } from 'node:crypto'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { AssistantMessage, ToolResultMessage, UserMessage } from '@earendil-works/pi-ai/compat'
import type { SDKAssistantMessage, SDKMessage, SDKResultMessage } from '@proma/shared'
import type { RuntimeGuardResultOverride } from '../agent-runtime-guards'
import { isMalformedResponseError, isTransientNetworkError } from '../error-patterns'
import { sanitizeToolResultImageContent } from '../image-content-validation'

function getPiEditItems(input: Record<string, unknown>): Array<Record<string, unknown>> {
  return Array.isArray(input.edits)
    ? input.edits.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    : []
}

function isMultiEditInput(piName: string, input: Record<string, unknown>): boolean {
  return piName === 'edit' && getPiEditItems(input).length > 1
}

export function displayToolName(piName: string, input?: Record<string, unknown>): string {
  switch (piName) {
    case 'read':
      return 'Read'
    case 'write':
      return 'Write'
    case 'edit':
      return input && isMultiEditInput(piName, input) ? 'MultiEdit' : 'Edit'
    case 'bash':
      return 'Bash'
    case 'powershell':
      return 'PowerShell'
    case 'grep':
      return 'Grep'
    case 'find':
      return 'Glob'
    case 'ls':
      return 'LS'
    default:
      return piName
  }
}

export function normalizePermissionInput(piName: string, input: Record<string, unknown>): Record<string, unknown> {
  switch (piName) {
    case 'read':
    case 'write':
      return { ...input, file_path: input.path }
    case 'edit': {
      const editItems = getPiEditItems(input)
      const firstEdit = editItems[0]
      return {
        ...input,
        file_path: input.path,
        edits: editItems.map((edit) => ({
          ...edit,
          old_string: edit.old_string ?? edit.oldText,
          new_string: edit.new_string ?? edit.newText,
        })),
        old_string: firstEdit?.old_string ?? firstEdit?.oldText,
        new_string: firstEdit?.new_string ?? firstEdit?.newText,
      }
    }
    case 'find':
      return { ...input, pattern: input.pattern }
    case 'ls':
      return { ...input, file_path: input.path ?? '.' }
    default:
      return input
  }
}

function normalizeToolUseInput(piName: string, input: Record<string, unknown>): Record<string, unknown> {
  switch (piName) {
    case 'read':
    case 'write':
      return { ...input, file_path: input.file_path ?? input.path }
    case 'edit': {
      const editItems = getPiEditItems(input)
      const firstEdit = editItems[0]
      const normalizedEdits = editItems.map((edit) => ({
        ...edit,
        old_string: edit.old_string ?? edit.oldText,
        new_string: edit.new_string ?? edit.newText,
      }))
      const joinedOld = normalizedEdits
        .map((edit, index) => `--- Edit ${index + 1} ---\n${String(edit.old_string ?? '')}`)
        .join('\n')
      const joinedNew = normalizedEdits
        .map((edit, index) => `--- Edit ${index + 1} ---\n${String(edit.new_string ?? '')}`)
        .join('\n')
      return {
        ...input,
        file_path: input.file_path ?? input.path,
        edits: normalizedEdits,
        old_string: input.old_string ?? (normalizedEdits.length > 1 ? joinedOld : firstEdit?.old_string ?? firstEdit?.oldText),
        new_string: input.new_string ?? (normalizedEdits.length > 1 ? joinedNew : firstEdit?.new_string ?? firstEdit?.newText),
      }
    }
    case 'find':
      return { ...input, pattern: input.pattern }
    case 'ls':
      return { ...input, file_path: input.file_path ?? input.path ?? '.' }
    default:
      return input
  }
}

export function restorePiInput(
  piName: string,
  original: Record<string, unknown>,
  updated?: Record<string, unknown>,
): Record<string, unknown> {
  if (!updated) return original
  switch (piName) {
    case 'read':
    case 'write':
      return { ...original, ...updated, path: updated.file_path ?? updated.path ?? original.path }
    case 'edit':
      return { ...original, ...updated, path: updated.file_path ?? updated.path ?? original.path }
    default:
      return { ...original, ...updated }
  }
}

function normalizeToolResultContent(content: unknown): unknown {
  if (!Array.isArray(content)) return content
  const normalized = content.map((item) => {
    if (!item || typeof item !== 'object') return item
    const record = item as Record<string, unknown>
    if (record.type === 'text' && typeof record.text === 'string') {
      return { type: 'text', text: record.text }
    }
    if (record.type === 'image') {
      return record
    }
    return record
  })
  return sanitizeToolResultImageContent(normalized as Parameters<typeof sanitizeToolResultImageContent>[0])
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((block) => {
      if (block && typeof block === 'object' && 'type' in block && block.type === 'text' && 'text' in block) {
        return typeof block.text === 'string' ? block.text : ''
      }
      return ''
    }).join('')
  }
  return ''
}

export function isAssistantPiMessage(message: AgentMessage): message is AssistantMessage {
  return !!message && typeof message === 'object' && 'role' in message && message.role === 'assistant'
}

/** Pi's terminal error and any generated assistant content are independent fields. */
export function getPiAssistantErrorDetails(message: SDKAssistantMessage): {
  detailedMessage: string
  originalError: string
} {
  const errorMessage = message.error?.message?.trim() || 'Unknown error'
  return { detailedMessage: errorMessage, originalError: errorMessage }
}

/** Pi can generate text before a stream failure; preserve it as normal assistant output. */
export function hasPiAssistantTextContent(message: SDKAssistantMessage): boolean {
  return message.message.content.some(
    (block) => block.type === 'text' && 'text' in block && typeof block.text === 'string' && block.text.trim().length > 0,
  )
}

/** Copy Pi's generated output without the terminal transport/provider failure. */
export function stripPiAssistantError(message: SDKAssistantMessage): SDKAssistantMessage {
  const contentMessage = { ...message }
  delete contentMessage.error
  return contentMessage
}

export function isAbortedAssistantMessage(message: AgentMessage): message is AssistantMessage {
  return isAssistantPiMessage(message) && message.stopReason === 'aborted'
}

export function dropTrailingAbortedAssistant(messages: AgentMessage[]): AgentMessage[] {
  const lastMessage = messages[messages.length - 1]
  return lastMessage && isAbortedAssistantMessage(lastMessage) ? messages.slice(0, -1) : messages
}

/** 将完整有效的供应商统计映射为 SDK 用量；缺失统计返回 undefined，保留真实零值。 */
function usageFromAssistant(message: AssistantMessage): SDKResultMessage['usage'] {
  /** Pi 显式报告状态保留到 JSONL，避免把 SDK 占位零用于统计。 */
  const usage = message.usage
  if (!usage || usage.reported === false) return undefined
  /** 不接受不完整主计数或非有限计数；缓存字段缺省按协议代表没有缓存。 */
  const counts = [usage.input, usage.output, usage.cacheRead ?? 0, usage.cacheWrite ?? 0]
  if (!counts.every((value) => Number.isSafeInteger(value) && value >= 0)) return undefined
  // 旧 SDK 的失败消息用全零占位；没有明确报告证据时不可把它当作真实账单。
  if (usage.reported !== true && (message.stopReason === 'error' || message.stopReason === 'aborted')
    && counts.every((value) => value === 0)) return undefined
  return {
    input_tokens: usage.input,
    output_tokens: usage.output,
    cache_read_input_tokens: usage.cacheRead ?? 0,
    cache_creation_input_tokens: usage.cacheWrite ?? 0,
  }
}

/** 校验完成消息是否包含正文、思考或工具；流式 pending 不做空回复终态判断。 */
function getAssistantTerminalError(message: AssistantMessage): string | undefined {
  if (message.stopReason === 'error') return message.errorMessage || 'Provider returned an error stop reason'
  if (message.stopReason !== 'stop' && message.stopReason !== 'toolUse') return undefined
  /** 工具和非空思考同样属于有效输出；只有重放签名的空思考不代表用户收到了内容。 */
  const hasContent = message.content.some((block) => block.type === 'toolCall'
    ? Boolean(block.name?.trim() && block.id?.trim())
    : block.type === 'text' ? Boolean(block.text?.trim())
      : block.type === 'thinking' && Boolean(block.thinking?.trim()))
  return hasContent ? undefined : 'Empty assistant response: provider returned no text, thinking or tool calls'
}

// 说明：本函数产出的消息 parent_tool_use_id 恒为 null。Pi 的事件模型（AgentEvent）不存在
// 子代理/sidechain 概念，AgentMessage 也无父子关联字段，故 pi 会话的所有消息都是主线。
// 渲染层（SDKMessageRenderer 的 childBlocksMap/agentToolIds 分组）不是死代码：迁移前用旧
// claude-sdk 持久化的历史会话 JSONL 里子代理消息带非空 parent_tool_use_id，打开老会话时仍
// 依赖该逻辑正确嵌套显示，不可删除。
export function convertPiMessage(
  message: AgentMessage,
  sessionId: string,
  channelModelId?: string,
  options: { uuid?: string } = {},
): SDKMessage | null {
  if (!message || typeof message !== 'object' || !('role' in message)) return null

  if (message.role === 'user') {
    const user = message as UserMessage
    return {
      type: 'user',
      message: {
        content: [{ type: 'text', text: contentToText(user.content) }],
      },
      parent_tool_use_id: null,
      session_id: sessionId,
      uuid: options.uuid ?? randomUUID(),
    } as unknown as SDKMessage
  }

  if (message.role === 'assistant') {
    const assistant = message as AssistantMessage
    // 保留 SDK 错误，并保护旧记录/其它 provider 的空成功边界；任意附带 errorMessage 不等同于终态失败。
    const terminalError = getAssistantTerminalError(assistant)
    const isTerminalError = Boolean(terminalError)
    const usage = usageFromAssistant(assistant)
    const errorType = terminalError && isMalformedResponseError(terminalError)
      ? 'service_error'
      : assistant.errorMessage && isTransientNetworkError(assistant.errorMessage)
        ? 'network_error'
        : 'provider_error'
    if (assistant.errorMessage && !isTerminalError) {
      console.warn(
        `[pi-adapter] 忽略非终态 errorMessage（stopReason=${assistant.stopReason}）: ${assistant.errorMessage}`,
      )
    }
    return {
      type: 'assistant',
      message: {
        content: assistant.content.map((block) => {
          if (block.type === 'text') return { type: 'text', text: block.text }
          if (block.type === 'thinking') return { type: 'thinking', thinking: block.thinking }
          if (block.type === 'toolCall') {
            return {
              type: 'tool_use',
              id: block.id,
              name: displayToolName(block.name, block.arguments as Record<string, unknown>),
              input: normalizeToolUseInput(block.name, block.arguments as Record<string, unknown>),
            }
          }
          return block as unknown as Record<string, unknown>
        }),
        ...(usage && { usage }),
        usageStatus: usage ? 'known' : 'unknown',
        model: assistant.model,
        stop_reason: isTerminalError ? 'error' : assistant.stopReason,
      },
      parent_tool_use_id: null,
      session_id: sessionId,
      uuid: options.uuid ?? randomUUID(),
      ...(terminalError && {
        error: { message: terminalError, errorType },
      }),
      ...(channelModelId && { _channelModelId: channelModelId }),
    } as unknown as SDKMessage
  }

  if (message.role === 'toolResult') {
    const toolResult = message as ToolResultMessage
    return {
      type: 'user',
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: toolResult.toolCallId,
          content: normalizeToolResultContent(toolResult.content),
          is_error: toolResult.isError,
        }],
      },
      tool_use_result: toolResult.details,
      parent_tool_use_id: null,
      session_id: sessionId,
      uuid: randomUUID(),
    } as unknown as SDKMessage
  }

  return null
}

export function hasToolResult(message: SDKMessage): boolean {
  if (message.type !== 'user') return false
  const content = (message as { message?: { content?: Array<{ type?: string }> } }).message?.content
  return Array.isArray(content) && content.some((block) => block.type === 'tool_result')
}

export function convertResultMessage(
  messages: AgentMessage[],
  sessionId: string,
  override?: RuntimeGuardResultOverride,
): SDKResultMessage {
  const assistants = messages.filter((m): m is AssistantMessage =>
    !!m && typeof m === 'object' && 'role' in m && m.role === 'assistant')
  /** 只累加有完整报告的调用；未知调用保留状态，不补零伪造完整统计。 */
  const knownUsages = assistants.map(usageFromAssistant)
    .filter((usage): usage is NonNullable<typeof usage> => usage !== undefined)
  /** 汇总状态区分整轮完整统计、仅已知小计和完全未知。 */
  const usageStatus = knownUsages.length === 0 ? 'unknown'
    : knownUsages.length === assistants.length ? 'known' : 'partial'
  const costValues = assistants
    .map((msg) => msg.usage?.cost?.total)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0)
  const usage = knownUsages.reduce(
    (acc, current) => ({
      input_tokens: acc.input_tokens + current.input_tokens,
      output_tokens: acc.output_tokens + current.output_tokens,
      cache_read_input_tokens: (acc.cache_read_input_tokens ?? 0) + (current.cache_read_input_tokens ?? 0),
      cache_creation_input_tokens: (acc.cache_creation_input_tokens ?? 0) + (current.cache_creation_input_tokens ?? 0),
    }),
    { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  )
  const lastAssistant = assistants[assistants.length - 1]
  const assistantError = lastAssistant ? getAssistantTerminalError(lastAssistant) : 'Empty assistant response: no assistant message'
  /** 取消拥有独立终态，不能因没有 errorMessage 而落入成功。 */
  const aborted = lastAssistant?.stopReason === 'aborted'
  const terminalReason = override?.terminalReason ?? (aborted ? 'aborted' : assistantError ? 'error'
    : lastAssistant?.stopReason === 'length' ? 'max_tokens' : 'completed')
  return {
    type: 'result',
    subtype: override?.subtype ?? (assistantError || aborted ? 'error_during_execution' : terminalReason === 'max_tokens' ? 'max_tokens' : 'success'),
    ...(usageStatus !== 'unknown' && { usage }),
    usageStatus,
    total_cost_usd: usageStatus === 'known' && costValues.length === assistants.length
      ? costValues.reduce((sum, cost) => sum + cost, 0) : undefined,
    terminal_reason: terminalReason,
    errors: override?.errors ?? (assistantError ? [assistantError] : undefined),
    session_id: sessionId,
  }
}
