import type { AgentStreamState } from '@/atoms/agent-atoms'
import type { QuotedSelection } from '@/atoms/preview-atoms'
import type { CanvasNodeReference } from '@proma/shared'
import {
  buildAgentHistoryQuoteLabel,
  expandAgentHistoryQuoteMentions,
  parseAgentHistoryQuoteMention,
} from './quoted-selection'
import { ENCODED_MENTION_VALUE_PATTERN, PLAIN_MENTION_VALUE_PATTERN } from './mention-patterns'

export type QueueDropPlacement = 'before' | 'after'

export interface AgentQueuedAttachment {
  filename: string
  mediaType: string
  size: number
  targetPath: string
}

export interface AgentQueuedMessage {
  id: string
  text: string
  createdAt: number
  quotedSelection?: QuotedSelection
  fileReferenceBlock?: string
  attachments?: AgentQueuedAttachment[]
  additionalDirectories?: string[]
  /** 发送时使用的 Canvas 节点公开快照。 */
  canvasNodeReferences?: CanvasNodeReference[]
}

/** 生成 Canvas 引用的稳定去重键；项目归属由引用合同继续完整保留。 */
function createCanvasNodeReferenceKey(reference: CanvasNodeReference): string {
  return `${reference.canvasId}\u0000${reference.nodeId}`
}

/**
 * 把新 Canvas 节点引用追加到已有引用，按 canvasId + nodeId 去重并保留首次出现顺序。
 * @param current composer 或队列已有引用。
 * @param additions 本次从权威 Canvas 快照生成的引用。
 * @returns 新的去重数组；不会修改正文或输入数组。
 */
export function addCanvasNodeReferences(
  current: readonly CanvasNodeReference[],
  additions: readonly CanvasNodeReference[],
): CanvasNodeReference[] {
  /** 首次出现的引用决定展示与发送顺序。 */
  const seen = new Set<string>()
  /** 输出使用完整 shared 快照，不降级为仅 ID。 */
  const references: CanvasNodeReference[] = []
  for (const reference of [...current, ...additions]) {
    /** 同一画布同一节点只保留首次出现版本。 */
    const key = createCanvasNodeReferenceKey(reference)
    if (seen.has(key)) continue
    seen.add(key)
    references.push(reference)
  }
  return references
}

/** 从引用数组删除指定画布节点，供 composer chip 与并发发送清理复用。 */
export function removeCanvasNodeReference(
  references: readonly CanvasNodeReference[],
  target: Pick<CanvasNodeReference, 'canvasId' | 'nodeId'>,
): CanvasNodeReference[] {
  /** 删除只比较稳定身份，保留其它节点首次出现顺序。 */
  const targetKey = `${target.canvasId}\u0000${target.nodeId}`
  return references.filter((reference) => createCanvasNodeReferenceKey(reference) !== targetKey)
}

/** 判断 composer 当前引用是否仍与一次发送捕获的完整快照一致。 */
function isSameCanvasNodeReference(
  current: CanvasNodeReference,
  sent: CanvasNodeReference,
): boolean {
  return current.projectId === sent.projectId
    && current.canvasId === sent.canvasId
    && current.nodeId === sent.nodeId
    && current.nodeType === sent.nodeType
    && current.nodeRevision === sent.nodeRevision
    && current.title === sent.title
}

/**
 * 正式发送或入队后只清除本次捕获且仍未变化的引用。
 * 用户在异步请求期间重新引用的新 revision 会被保留。
 */
export function removeSentCanvasNodeReferences(
  current: readonly CanvasNodeReference[],
  sent: readonly CanvasNodeReference[],
): CanvasNodeReference[] {
  return current.filter((reference) => !sent.some((sentReference) => (
    isSameCanvasNodeReference(reference, sentReference)
  )))
}

/**
 * 队列的自动消费必须由常驻调度器执行，不能依赖某个 AgentView 是否仍挂载。
 * 保留停止、后台等待和交互阻塞状态，避免在不安全的时机意外开启新一轮 run。
 */
export function shouldAutoDispatchQueuedMessage(options: {
  queueLength: number
  running: boolean
  backgroundWaiting: boolean
  stoppedByUser: boolean
  hasBlockingRequests: boolean
  hasChannel: boolean
  hasAvailableModel: boolean
}): boolean {
  return options.queueLength > 0 &&
    !options.running &&
    !options.backgroundWaiting &&
    !options.stoppedByUser &&
    !options.hasBlockingRequests &&
    options.hasChannel &&
    options.hasAvailableModel
}

export function createAgentQueuedMessage(
  text: string,
  id: string,
  createdAt: number,
  quotedSelection?: QuotedSelection | null,
  options?: {
    fileReferenceBlock?: string
    attachments?: AgentQueuedAttachment[]
    additionalDirectories?: string[]
    canvasNodeReferences?: CanvasNodeReference[]
  },
): AgentQueuedMessage {
  const message: AgentQueuedMessage = {
    id,
    text: text.trim(),
    createdAt,
  }
  if (quotedSelection) message.quotedSelection = quotedSelection
  if (options?.fileReferenceBlock) message.fileReferenceBlock = options.fileReferenceBlock
  if (options?.attachments && options.attachments.length > 0) message.attachments = options.attachments
  if (options?.additionalDirectories && options.additionalDirectories.length > 0) message.additionalDirectories = options.additionalDirectories
  if (options?.canvasNodeReferences && options.canvasNodeReferences.length > 0) {
    message.canvasNodeReferences = [...options.canvasNodeReferences]
  }
  return message
}

export function createQueuedAgentStreamState(
  previous: Pick<AgentStreamState, 'model' | 'inputTokens' | 'contextWindow'> | undefined,
  startedAt: number,
): AgentStreamState {
  return {
    running: true,
    backgroundWaiting: false,
    model: previous?.model,
    startedAt,
    inputTokens: previous?.inputTokens,
    contextWindow: previous?.contextWindow,
  }
}

export function removeQueuedMessage(
  queue: AgentQueuedMessage[],
  messageId: string,
): AgentQueuedMessage[] {
  return queue.filter((item) => item.id !== messageId)
}

export function restoreQueuedMessageToFront(
  queue: AgentQueuedMessage[],
  message: AgentQueuedMessage,
): AgentQueuedMessage[] {
  if (queue.some((item) => item.id === message.id)) return queue
  return [message, ...queue]
}

/**
 * 将失败消息正文恢复到当前草稿末尾，不覆盖请求期间的新输入，也不重复相同正文。
 * @param currentDraft 失败回调发生时当前 session 的最新草稿。
 * @param restoredMessage 本次失败发送需要恢复的原正文。
 * @returns 同时保留新旧内容的 composer 文本。
 */
export function mergeAgentDraftWithRestoredMessage(
  currentDraft: string,
  restoredMessage: string,
): string {
  /** 恢复只使用规范化边界，正文内部内容保持原样。 */
  const current = currentDraft.trim()
  /** 空消息不改变用户当前草稿。 */
  const restored = restoredMessage.trim()
  if (!restored || current === restored) return current
  if (!current) return restored
  return `${current}\n\n${restored}`
}

export function moveQueuedMessage(
  queue: AgentQueuedMessage[],
  sourceId: string,
  targetId: string,
  placement: QueueDropPlacement,
): AgentQueuedMessage[] {
  if (sourceId === targetId) return queue

  const source = queue.find((item) => item.id === sourceId)
  if (!source) return queue

  const withoutSource = queue.filter((item) => item.id !== sourceId)
  const targetIndex = withoutSource.findIndex((item) => item.id === targetId)
  if (targetIndex === -1) return queue

  const insertIndex = placement === 'after' ? targetIndex + 1 : targetIndex
  return [
    ...withoutSource.slice(0, insertIndex),
    source,
    ...withoutSource.slice(insertIndex),
  ]
}

export interface ParsedQueuedMessageMentions {
  cleanedText: string
  mentionedSkills: string[]
  mentionedMcpServers: string[]
  mentionedSessionIds: string[]
  mentionedTodoIds: string[]
  mentionedCalendarEventIds: string[]
}

export interface QueuedMessageSendPayload {
  rawText: string
  sdkText: string
  mentions: ParsedQueuedMessageMentions
  canvasNodeReferences?: CanvasNodeReference[]
}

/** Renderer 消息提交结果；skipped 表示没有任何可发送内容。 */
export type AgentMessageSubmissionOutcome = 'submitted' | 'skipped'

/**
 * 仅在正文或 Canvas 引用至少一项非空时进入真实提交边界。
 * @param payload 已解析的队列消息载荷。
 * @param submit 调用主进程并等待其接管消息的提交函数。
 * @returns submitted 表示主进程已成功接管；skipped 表示消息为空且未调用提交函数。
 */
export async function submitQueuedMessagePayload(
  payload: QueuedMessageSendPayload,
  submit: (payload: QueuedMessageSendPayload) => Promise<void>,
): Promise<AgentMessageSubmissionOutcome> {
  /** 结构化 Canvas 引用与正文都是独立、合法的用户输入。 */
  const hasCanvasNodeReferences = (payload.canvasNodeReferences?.length ?? 0) > 0
  if (!payload.rawText && !hasCanvasNodeReferences) return 'skipped'

  await submit(payload)
  return 'submitted'
}

/** 队列预览专用片段：保留原始消息用于发送，同时把引用协议渲染为可读芯片。 */
export type QueuedMessageReferenceType = 'file' | 'skill' | 'mcp' | 'session' | 'todo' | 'calendar_event' | 'quote'

export type QueuedMessageDisplayPart =
  | { type: 'text'; value: string }
  | {
      type: 'reference'
      referenceType: QueuedMessageReferenceType
      id: string
      label: string
    }

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function escapeHtmlAttribute(text: string): string {
  return escapeHtml(text)
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function renderQueuedParagraphHtml(text: string): string {
  const quoteMarkerPattern = /&quote:[A-Za-z0-9%_.!~*'()-]+/g
  let html = ''
  let lastIndex = 0

  for (const match of text.matchAll(quoteMarkerPattern)) {
    if (match.index > lastIndex) {
      html += escapeHtml(text.slice(lastIndex, match.index))
    }

    const marker = match[0]
    const quote = parseAgentHistoryQuoteMention(marker)
    if (!quote) {
      html += escapeHtml(marker)
    } else {
      const payload = marker.slice('&quote:'.length)
      const id = `${quote.messageId ?? ''}:${quote.selectionStart ?? ''}:${quote.selectionEnd ?? ''}`
      const label = buildAgentHistoryQuoteLabel(quote)
      html += `<span data-type="mention" data-id="${escapeHtmlAttribute(id)}" data-label="${escapeHtmlAttribute(label)}" data-mention-suggestion-char="&" data-mention-quote="${escapeHtmlAttribute(payload)}">${escapeHtml(label)}</span>`
    }
    lastIndex = match.index + marker.length
  }

  html += escapeHtml(text.slice(lastIndex))
  return html.replace(/\n/g, '<br>')
}

/**
 * 把纯文本队列消息转成与 RichTextInput 段落渲染一致的 HTML：
 * 双换行分段落，单换行转 <br>，并转义 HTML 特殊字符避免破坏结构。
 * 用于撤回时保留已有草稿的富文本节点（mention 等），同时让队列文本按正常段落显示。
 */
export function queuedTextToParagraphHtml(text: string): string {
  const normalized = text.trim()
  if (!normalized) return ''
  return normalized
    .split(/\n\n+/)
    .map((para) => `<p>${renderQueuedParagraphHtml(para)}</p>`)
    .join('')
}

const REF_PATTERN = new RegExp(
  String.raw`/skill:(?<skill>${PLAIN_MENTION_VALUE_PATTERN})|#mcp:(?<mcp>${PLAIN_MENTION_VALUE_PATTERN})|&session:(?<session>[A-Za-z0-9-]+)(?:(?:~|::)${ENCODED_MENTION_VALUE_PATTERN})?|&todo:(?<todo>[A-Za-z0-9-]+)(?:(?:~|::)${ENCODED_MENTION_VALUE_PATTERN})?|&calendar_event:(?<calendarEvent>[A-Za-z0-9-]+)(?:(?:~|::)${ENCODED_MENTION_VALUE_PATTERN})?`,
  'gu',
)
const DISPLAY_REFERENCE_PATTERN = new RegExp(
  String.raw`&quote:(?<quote>[A-Za-z0-9%_.!~*'()-]+)|@file:(?<file>${ENCODED_MENTION_VALUE_PATTERN})|/skill:(?<skill>${PLAIN_MENTION_VALUE_PATTERN})|#mcp:(?<mcp>${PLAIN_MENTION_VALUE_PATTERN})|&session:(?<session>[A-Za-z0-9-]+)(?:(?:~|::)(?<sessionLabel>${ENCODED_MENTION_VALUE_PATTERN}))?|&todo:(?<todo>[A-Za-z0-9-]+)(?:(?:~|::)(?<todoLabel>${ENCODED_MENTION_VALUE_PATTERN}))?|&calendar_event:(?<calendarEvent>[A-Za-z0-9-]+)(?:(?:~|::)(?<calendarEventLabel>${ENCODED_MENTION_VALUE_PATTERN}))?`,
  'gu',
)

function decodeReferenceLabel(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/**
 * 将排队消息中的文件、Skill、MCP、会话、历史引用和规划协议转换为展示片段。
 * `item.text` 仍完整保留，发送时继续通过 parseQueuedMessageMentions 提取原始 ID。
 */
export function getQueuedMessageDisplayParts(text: string): QueuedMessageDisplayPart[] {
  const parts: QueuedMessageDisplayPart[] = []
  let lastIndex = 0

  for (const match of text.matchAll(DISPLAY_REFERENCE_PATTERN)) {
    if (match.index > lastIndex) {
      parts.push({ type: 'text', value: text.slice(lastIndex, match.index) })
    }

    const groups = match.groups ?? {}
    if (groups.quote) {
      const quote = parseAgentHistoryQuoteMention(`&quote:${groups.quote}`)
      if (quote) {
        parts.push({
          type: 'reference',
          referenceType: 'quote',
          id: `${quote.messageId ?? ''}:${quote.selectionStart ?? ''}:${quote.selectionEnd ?? ''}`,
          label: buildAgentHistoryQuoteLabel(quote),
        })
      } else {
        parts.push({ type: 'text', value: match[0] })
      }
      lastIndex = match.index + match[0].length
      continue
    }

    let referenceType: QueuedMessageReferenceType
    let id: string
    let rawLabel: string | undefined

    if (groups.file) {
      referenceType = 'file'
      id = groups.file
    } else if (groups.skill) {
      referenceType = 'skill'
      id = groups.skill
    } else if (groups.mcp) {
      referenceType = 'mcp'
      id = groups.mcp
    } else if (groups.session) {
      referenceType = 'session'
      id = groups.session
      rawLabel = groups.sessionLabel
    } else if (groups.todo) {
      referenceType = 'todo'
      id = groups.todo
      rawLabel = groups.todoLabel
    } else if (groups.calendarEvent) {
      referenceType = 'calendar_event'
      id = groups.calendarEvent
      rawLabel = groups.calendarEventLabel
    } else {
      continue
    }

    const decodedId = decodeReferenceLabel(id)
    const label = rawLabel
      ? decodeReferenceLabel(rawLabel)
      : referenceType === 'file'
        ? (decodedId.split(/[\\/]/).pop() || decodedId)
        : referenceType === 'session'
          ? `会话 ${id.slice(0, 8)}`
          : referenceType === 'todo'
            ? `Todo ${id.slice(0, 8)}`
            : referenceType === 'calendar_event'
              ? `日程 ${id.slice(0, 8)}`
              : decodedId

    parts.push({ type: 'reference', referenceType, id, label })
    lastIndex = match.index + match[0].length
  }

  if (lastIndex < text.length) {
    parts.push({ type: 'text', value: text.slice(lastIndex) })
  }

  return parts.length > 0 ? parts : [{ type: 'text', value: text }]
}

export function parseQueuedMessageMentions(text: string): ParsedQueuedMessageMentions {
  const mentionedSkills: string[] = []
  const mentionedMcpServers: string[] = []
  const mentionedSessionIds: string[] = []
  const mentionedTodoIds: string[] = []
  const mentionedCalendarEventIds: string[] = []

  for (const match of text.matchAll(REF_PATTERN)) {
    const { skill, mcp, session, todo, calendarEvent } = match.groups ?? {}
    if (skill) mentionedSkills.push(skill)
    else if (mcp) mentionedMcpServers.push(mcp)
    else if (session) mentionedSessionIds.push(session)
    else if (todo) mentionedTodoIds.push(todo)
    else if (calendarEvent) mentionedCalendarEventIds.push(calendarEvent)
  }

  return {
    cleanedText: text
      .replace(REF_PATTERN, '')
      // @file: 路径在 htmlToMarkdown 序列化时已 encodeURIComponent（路径可能含空格），
      // 这里还原为真实路径，保证 Agent 侧读取的是可访问的完整路径；
      // 仅当含百分号编码时解码，避免破坏旧的未编码路径。
      .replace(new RegExp(String.raw`@file:(${ENCODED_MENTION_VALUE_PATTERN})`, 'gu'), (full, encodedPath: string) =>
        /%[0-9A-Fa-f]{2}/.test(encodedPath)
          ? `@file:${decodeReferenceLabel(encodedPath)}`
          : full
      )
      .trim(),
    mentionedSkills,
    mentionedMcpServers,
    mentionedSessionIds,
    mentionedTodoIds,
    mentionedCalendarEventIds,
  }
}

export function buildQueuedMessageSendPayload(
  message: AgentQueuedMessage,
  quotedSelectionBlock = '',
): QueuedMessageSendPayload {
  const text = message.text.trim()
  const mentions = parseQueuedMessageMentions(text)
  const contextBlocks = [
    message.fileReferenceBlock?.trim(),
    quotedSelectionBlock.trim(),
  ].filter((block): block is string => Boolean(block))
  const prefix = contextBlocks.length > 0
    ? `${contextBlocks.join('\n\n')}\n\n`
    : ''

  const payload: QueuedMessageSendPayload = {
    rawText: `${prefix}${expandAgentHistoryQuoteMentions(text)}`.trim(),
    sdkText: `${prefix}${expandAgentHistoryQuoteMentions(mentions.cleanedText)}`.trim(),
    mentions,
  }
  if (message.canvasNodeReferences && message.canvasNodeReferences.length > 0) {
    payload.canvasNodeReferences = [...message.canvasNodeReferences]
  }
  return payload
}
