import { getAgentSessionMeta, getAgentSessionSDKMessages } from './agent-session-manager'
import { join } from 'node:path'
import type { AgentSessionMeta } from '@proma/shared'
import { getBundledCliPath, getConfigDir, type ConfigRootResolver } from './config-paths'
import { isAgentSessionUserVisible } from './agent-session-visibility'

/** 最大回填消息条数 */
export const MAX_CONTEXT_MESSAGES = 20

/** 单条工具摘要最大字符数 */
const MAX_TOOL_SUMMARY_LENGTH = 200

interface SessionPromptHint {
  agentCwd: string
  workspaceSlug?: string
  /** 当前会话使用的活动数据根解析器；测试可注入独立实例。 */
  configRootResolver?: ConfigRootResolver
}

function getSessionHistoryPath(sessionId: string, resolver?: ConfigRootResolver): string {
  return join(getConfigDir(resolver), 'agent-sessions', `${sessionId}.jsonl`)
}

function getSessionCleanerSkillName(workspaceSlug?: string): string {
  return workspaceSlug
    ? `proma-workspace-${workspaceSlug}:session-cleaner`
    : 'session-cleaner'
}

function getSessionCliCommandPrefix(): string {
  return getBundledCliPath() ? '"$PROMA_CLI"' : 'proma'
}

function buildSessionCliAccessGuide(
  sessionId: string,
  historyPath: string,
  workspaceSlug?: string,
): string {
  const cli = getSessionCliCommandPrefix()
  const skillName = getSessionCleanerSkillName(workspaceSlug)
  /** CLI 通过 Agent 运行环境中的 PROMA_CONFIG_DIR 继承活动根，命令不重复平台路径。 */
  const command = (args: string): string => `${cli} session ${args}`
  return [
    `优先使用 session-cleaner skill（${skillName}）读取当前会话历史；它是 Proma CLI 的薄封装，会把 Agent JSONL 清洗为干净对话。`,
    `可用 CLI 命令前缀: ${cli}`,
    `建议流程:`,
    `1. ${command(`info ${sessionId}`)}`,
    `2. ${command(`outline ${sessionId}`)}`,
    `3. 根据 outline/search 定位后，用 ${command(`export ${sessionId} --turns A-B`)} 或 ${command(`export ${sessionId} --tail N`)} 读取片段。`,
    `4. 只有会话很小或 CLI 护栏允许时，才用 ${command(`export ${sessionId}`)} 读取全量。`,
    `不要直接 Read 原始 .jsonl 历史文件；CLI / skill 不可用或读取失败时，才兜底读取: ${historyPath}`,
  ].join('\n')
}

function buildCurrentSessionHistoryInstruction(
  sessionId: string,
  workspaceSlug?: string,
  resolver?: ConfigRootResolver,
): string {
  const historyPath = getSessionHistoryPath(sessionId, resolver)
  return buildSessionCliAccessGuide(sessionId, historyPath, workspaceSlug)
}

function buildReferencedSessionsHistoryInstruction(workspaceSlug?: string): string {
  const skillName = getSessionCleanerSkillName(workspaceSlug)
  return `需要这些会话的上下文时，优先使用 session-cleaner skill（${skillName}）或 Proma CLI 读取清洗后的会话历史。按 info → outline/search → export 的顺序渐进式读取；不要假设会话内容，也不要直接 Read 原始 .jsonl 历史文件。`
}

/**
 * 构建当前 Agent 的轻量 Canvas 工作区提示词。
 * @param promptSummary 主进程已按权威文档解析且移除内部身份的摘要。
 * @returns 无摘要时返回空串；否则返回不含节点正文的工作区约束块。
 */
export function buildCanvasWorkspacePrompt(promptSummary?: string): string {
  /** 空摘要必须完全绕过，避免普通聊天产生额外 prompt 噪声。 */
  const summary = promptSummary?.trim()
  if (!summary) return ''
  return [
    '<canvas_workspace>',
    '你已经在当前 Agent 的画布工作区内，不得要求用户另建或切换画布。',
    summary,
    '</canvas_workspace>',
  ].join('\n')
}

/**
 * 从 SDKMessage assistant 消息的 content 中提取工具活动摘要
 *
 * 扫描 tool_use 块，提取工具名称和关键参数，帮助新 SDK 会话理解之前做过什么。
 */
function extractSDKToolSummary(content: Array<{ type: string; name?: string; input?: Record<string, unknown> }>): string {
  const summaries: string[] = []
  for (const block of content) {
    if (block.type === 'tool_use' && block.name) {
      const input = block.input ?? {}
      const keyParam = input.file_path ?? input.command ?? input.path ?? input.query ?? ''
      const paramStr = keyParam ? `: ${String(keyParam).slice(0, 100)}` : ''
      summaries.push(`[tool: ${block.name}${paramStr}]`)
    }
  }
  if (summaries.length === 0) return ''
  const joined = summaries.join(' ')
  return joined.length > MAX_TOOL_SUMMARY_LENGTH
    ? joined.slice(0, MAX_TOOL_SUMMARY_LENGTH) + '...'
    : joined
}

/**
 * 构建带历史上下文的 prompt
 *
 * 当 resume 不可用时，将最近消息拼接为上下文注入 prompt，
 * 让新 SDK 会话保留对话记忆。包含文本内容和工具活动摘要。
 */
export function buildContextPrompt(sessionId: string, currentUserMessage: string, sessionHint?: SessionPromptHint): string {
  const allMessages = getAgentSessionSDKMessages(sessionId)
  if (allMessages.length === 0) return currentUserMessage

  // 排除最后一条（当前用户消息，刚刚才 append 的）
  const history = allMessages.slice(0, -1)
  if (history.length === 0) return currentUserMessage

  const recent = history.slice(-MAX_CONTEXT_MESSAGES)
  const lines = recent
    .filter((m) => (m.type === 'user' || m.type === 'assistant'))
    .map((m) => {
      // 从 SDKMessage 的 message.content 中提取文本
      const content = (m as { message?: { content?: Array<{ type: string; text?: string; name?: string; input?: Record<string, unknown> }> } }).message?.content
      if (!Array.isArray(content)) return null

      const textParts = content
        .filter((b) => b.type === 'text' && b.text)
        .map((b) => b.text!)
      const text = textParts.join('\n')
      if (!text) return null

      let line = `[${m.type}]: ${text}`
      // assistant 消息附带工具活动摘要
      if (m.type === 'assistant') {
        const toolSummary = extractSDKToolSummary(content)
        if (toolSummary) {
          line += `\n  工具活动: ${toolSummary}`
        }
      }
      return line
    })
    .filter(Boolean)

  if (lines.length === 0) return currentUserMessage

  // 注入 session 元信息 + 强指令：兜底场景（resume 指针丢失）下，仅靠最近
  // MAX_CONTEXT_MESSAGES 条摘要不足以让长任务无缝接续，必须引导模型读取完整历史，
  // 避免「从零重新执行整个任务」（#903）。
  const sessionInfoBlock = sessionHint
    ? `\n<session_info>\nSession ID: ${sessionId}\nSession CWD: ${sessionHint.agentCwd}\n` +
      `History path: ${getSessionHistoryPath(sessionId, sessionHint.configRootResolver)}\n` +
      `重要：上方仅为最近 ${MAX_CONTEXT_MESSAGES} 条对话摘要，可能不完整。在继续之前，` +
      `${buildCurrentSessionHistoryInstruction(sessionId, sessionHint.workspaceSlug, sessionHint.configRootResolver)}\n` +
      `恢复时先确认「已经完成了哪些工作、进行到哪一步」，然后从中断处继续，切勿重复执行已完成的步骤。\n</session_info>\n`
    : ''

  console.log(`[Agent 编排] buildContextPrompt: 读取 ${allMessages.length} 条消息，注入 ${lines.length} 条历史${sessionHint ? '（含 session 元信息）' : ''}`)
  return `<conversation_history>${sessionInfoBlock}\n${lines.join('\n')}\n</conversation_history>\n\n${currentUserMessage}`
}

/**
 * 构建 Session 恢复 prompt
 *
 * 当 SDK resume 失败（session 过期、thinking signature 不兼容等）时，
 * 注入 <session_recovery> 标签指向当前会话，并优先让 Agent 通过 session-cleaner
 * 读取干净会话历史后无缝继续工作。
 */
export function buildRecoveryPrompt(
  sessionId: string,
  currentUserMessage: string,
  sessionHint: SessionPromptHint,
): string {
  const meta = getAgentSessionMeta(sessionId)
  const title = meta ? escapeContextAttr(meta.title) : sessionId
  const historyPath = getSessionHistoryPath(sessionId, sessionHint.configRootResolver)

  const recoveryBlock =
    `<session_recovery>\n` +
    `你正在接续一个已有的 Agent 会话（因模型切换等原因需要重新建立连接）。\n` +
    `当前会话的完整历史记录在下方会话信息中，请先恢复上下文，然后继续处理用户的最新请求。\n` +
    `<session id="${sessionId}" title="${title}" cwd="${sessionHint.agentCwd}">\n` +
    `History path: ${historyPath}\n` +
    `</session>\n` +
    `${buildCurrentSessionHistoryInstruction(sessionId, sessionHint.workspaceSlug, sessionHint.configRootResolver)}\n` +
    `</session_recovery>`

  console.log(`[Agent 编排] buildRecoveryPrompt: 注入 session 自引用 → ${historyPath}`)
  return `${recoveryBlock}\n\n${currentUserMessage}`
}

function escapeContextAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

export function buildReferencedSessionsPrompt(
  currentSessionId: string,
  mentionedSessionIds?: string[],
  workspaceSlug?: string,
  configRootResolver?: ConfigRootResolver,
): string {
  const uniqueIds = [...new Set((mentionedSessionIds ?? []).filter(Boolean))]
  if (uniqueIds.length === 0) return ''

  const sessionBlocks: string[] = []

  for (const referencedSessionId of uniqueIds) {
    if (referencedSessionId === currentSessionId) continue

    /** Renderer 候选列表不构成授权；只有明确缺失或内部会话可被静默过滤。 */
    const meta: AgentSessionMeta | undefined = getAgentSessionMeta(referencedSessionId)
    if (!meta || !isAgentSessionUserVisible(meta)) continue
    if (meta.archived) continue

    const title = escapeContextAttr(meta.title)
    const historyPath = getSessionHistoryPath(referencedSessionId, configRootResolver)
    const explorationBoundary = meta.explorationParentSessionId && meta.explorationSourceMessageId
      ? `\n<exploration_delta parentSessionId="${escapeContextAttr(meta.explorationParentSessionId)}" sourceMessageId="${escapeContextAttr(meta.explorationSourceMessageId)}">\n` +
        '此会话是从主线分叉的探索分支；用户引用的仅是 sourceMessageId 之后新增的探索内容。\n' +
        '分叉前复制的主线历史不是本次引用内容：不要读取、总结或重复处理它。\n' +
        `请先用 ${getSessionCliCommandPrefix()} session export ${referencedSessionId} --after-message ${meta.explorationSourceMessageId} 精确读取分叉后的内容。\n` +
        '仅当必须核验分支内更早的新增内容时，才在该边界之后渐进读取；不要导出完整 fork 历史。\n' +
        '</exploration_delta>'
      : ''
    sessionBlocks.push(
      `<session id="${referencedSessionId}" title="${title}" updatedAt="${meta.updatedAt}">\n` +
      `CLI target: ${referencedSessionId}\n` +
      `History path: ${historyPath}\n` +
      `</session>${explorationBoundary}`,
    )
  }

  if (sessionBlocks.length === 0) return ''

  return `<referenced_sessions>\n用户在消息中明确引用了以下 Agent 会话。${buildReferencedSessionsHistoryInstruction(workspaceSlug)}\n${sessionBlocks.join('\n\n')}\n</referenced_sessions>`
}
