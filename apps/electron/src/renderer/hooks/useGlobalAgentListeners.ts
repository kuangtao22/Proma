/**
 * useGlobalAgentListeners — 全局 Agent IPC 监听器
 *
 * 在应用顶层挂载，永不销毁。将所有 Agent 流式事件、
 * 权限请求、AskUser 请求写入对应 Jotai atoms。
 *
 * 使用 useStore() 直接操作 atoms，避免 React 订阅。
 */

import { useEffect } from 'react'
import { unstable_batchedUpdates } from 'react-dom'
import { useStore } from 'jotai'
import type { Store } from 'jotai/vanilla/store'
import {
  agentStreamingStatesAtom,
  agentSessionStreamingStateAtomFamily,
  agentStreamErrorsAtom,
  agentSessionMessageQueueAtom,
  agentPendingFilesAtomFamily,
  agentCanvasNodeReferencesAtomFamily,
  agentSessionDraftsAtom,
  agentSessionDraftHtmlAtom,
  agentSessionsAtom,
  agentMessageRefreshAtom,
  allPendingPermissionRequestsAtom,
  allPendingAskUserRequestsAtom,
  allPendingExitPlanRequestsAtom,
  agentPromptSuggestionsAtom,
  recentlyModifiedPathsAtom,
  RECENTLY_MODIFIED_TTL_MS,
  applyAgentEvent,
  clearAgentStreamError,
  resumeAgentStreamState,
  isRetryEventForCurrentStream,
  liveMessagesMapAtom,
  agentSessionModelMapAtom,
  agentSessionChannelMapAtom,
  agentModelIdAtom,
  agentChannelIdAtom,
  agentPermissionModeMapAtom,
  agentDefaultPermissionModeAtom,
  stoppedByUserSessionsAtom,
  agentPlanModeSessionsAtom,
  currentAgentSessionIdAtom,
  currentAgentWorkspaceIdAtom,
  agentWorkspacesAtom,
  agentAttachedDirectoriesMapAtom,
  agentAttachedFilesMapAtom,
  workspaceAttachedDirectoriesMapAtom,
  workspaceAttachedFilesMapAtom,
  unviewedCompletedSessionIdsAtom,
  agentSessionPathMapAtom,
  agentDiffRefreshVersionAtom,
  agentDiffPanelTabAtom,
  agentSelectedWorktreeAtom,
  agentNonGitFileChangesAtom,
  agentFileChangesCurrentRunAtom,
  agentSidePanelOpenAtomFamily,
  revealChangedWorkspaceComponentAtom,
  agentSideDelegationMapAtom,
  getCanvasWorkspaceTab,
  getDelegationSidePanelTab,
  askUserDraftsAtom,
  agentPendingPromptAtom,
  agentCanvasWorkspaceOpenTabsAtom,
} from '@/atoms/agent-atoms'
import {
  notificationsEnabledAtom,
  notificationSoundEnabledAtom,
  notificationSoundsAtom,
  sendDesktopNotification,
  playNotificationSoundForType,
} from '@/atoms/notifications'
import { appModeAtom } from '@/atoms/app-mode'
import { activeViewAtom } from '@/atoms/active-view'
import {
  canvasAgentOwnersAtom,
  canvasAgentInternalInvalidSessionIdsAtom,
  canvasAgentLifecycleAtom,
  canvasAgentOpenSessionIdsAtom,
  canvasAgentRunningSessionIdsAtom,
  isCanvasAgentHandoffGenerationCurrent,
  isCanvasAgentGenerationCurrent,
} from '@/atoms/native-canvas-atoms'
import {
  createAgentCanvasViewKey,
  navigateAgentCanvasViewAtom,
  recordAgentCanvasActivityAtom,
  reconcileAgentCanvasActivityBindingAtom,
} from '@/atoms/agent-canvas-atoms'
import { tabsAtom, activeTabIdAtom, activeSessionIdAtom, openTab, updateTabTitle } from '@/atoms/tab-atoms'
import type { AgentStreamState } from '@/atoms/agent-atoms'
import { agentDiffUnseenChangesAtom, agentDiffUnseenFilesAtom } from '@/atoms/agent-atoms'
import { channelsAtom } from '@/atoms/chat-atoms'
import {
  getPreviewContentRefreshKey,
  previewContentRefreshVersionAtom,
  previewResolvedPathAtom,
  previewFileMapAtom,
  previewFilesMapAtom,
  quotedSelectionMapAtom,
  type PreviewFile,
} from '@/atoms/preview-atoms'
import type { NotificationSoundType } from '@/types/settings'
import { toast } from 'sonner'
import type { AgentCanvasBinding, AgentCanvasBindingChangeEvent, AgentStreamEvent, AgentStreamCompletePayload, AgentStreamErrorPayload, AgentEvent, AgentStreamPayload, AgentAssistantDelta, AgentAssistantDeltaPayload, CanvasChangeEvent, SDKAssistantMessage, SDKMessage, SDKUserMessage, SDKSystemMessage, PromaEvent, AgentSessionMeta, ProviderType, SDKContentBlock, SDKUserContentBlock, AgentQueuedMessageStatus } from '@proma/shared'
import { inferContextWindow } from '@proma/shared'
import {
  buildExternalAgentRunActivation,
  shouldActivateExternalAgentRun,
  shouldRevealDelegatedSession,
} from '@/lib/external-agent-run'
import { upsertAgentSession, mergeFetchedAgentSessions } from '@/lib/agent-session-list'
import {
  getAgentCompletionMarkers,
  notifyAgentCompletion,
  notifyAgentCompletionWarning,
} from '@/lib/agent-completion-presence'
import { getPlanModeChangeFromToolName, updatePlanModeSessionSet } from '@/lib/agent-plan-mode'
import { detectIsWindows } from '@/lib/platform'
import { getSessionFileChangeKind, getOwnedSessionWatcherPaths, upsertSessionFileChange } from '@/lib/session-file-changes'
import { doesWorkspaceChangeAffectPreview } from '@/components/diff/preview-open-path'
import {
  createQueuedAgentStreamState,
  mergeAgentDraftWithRestoredMessage,
  removeQueuedMessage,
  restoreMissingCanvasNodeReferences,
} from '@/lib/agent-message-queue'
import { createAgentStreamEventBatcher } from '@/lib/agent-stream-event-batcher'
import {
  isSameOrNewerRun,
  isTerminalEventForCurrentRun,
  type AgentRunMarker,
} from '@/lib/agent-active-session-snapshot'
import { createAgentQueuedMessage } from '@/lib/agent-message-queue'
import { designAdapter } from '@/lib/design-adapter'
import {
  createCanvasAgentBootstrapCoordinator,
  resolveCanvasAgentCompletion,
} from '@/lib/canvas-agent-event-routing'
import type { CanvasAgentOwner } from '@/lib/canvas-agent-event-routing'
import { getChangedWorkspaceComponentFromSdkMessage, shouldRevealChangedWorkspaceComponentImmediately } from '@/lib/agent-component-activation'
import { mergeActiveAgentSessionSnapshot } from '@/lib/agent-active-session-snapshot'
import { buildTodoAgentPrompt } from '@/lib/todo-agent-prompt'
import { parseCanvasArtifactToolResult } from '@/lib/agent-canvas-artifact-result'

/** 触发右侧文件浏览器自动定位的写入类工具集合 */
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Update'])

/** 会改变 git 工作树状态的子命令（用于识别 Bash 中触发 diff 刷新的 git 操作） */
const GIT_MUTATING_SUBCOMMANDS = /\bgit\s+(commit|checkout|reset|restore|stash|clean|add|rm|mv|pull|merge|rebase|cherry-pick|revert|switch|am|apply)\b/

/**
 * 从主进程会话与 binding 快照中解析 Canvas 通知应返回的普通 Agent。
 * @param owner Canvas 内部 Agent 的权威节点归属。
 * @param bindings 项目内的权威 Agent-Canvas 关联快照。
 * @param sessions 主进程返回的普通 Agent 会话列表。
 * @returns 同项目且确实关联目标 Canvas 的最近普通 Agent；缺任一事实时返回 null。
 */
export function resolveCanvasAgentWorkspaceOwner(
  owner: CanvasAgentOwner,
  bindings: readonly AgentCanvasBinding[],
  sessions: readonly AgentSessionMeta[],
): AgentSessionMeta | null {
  /** 最近查看目标 Canvas 的 binding 优先，随后按 binding 更新时间稳定选择。 */
  const candidates = bindings
    .filter((binding) => binding.projectId === owner.projectId
      && binding.linkedCanvasIds.includes(owner.canvasId))
    .sort((left, right) => {
      const leftActive = left.lastActiveCanvasId === owner.canvasId ? 1 : 0
      const rightActive = right.lastActiveCanvasId === owner.canvasId ? 1 : 0
      return rightActive - leftActive
        || right.updatedAt - left.updatedAt
        || left.sessionId.localeCompare(right.sessionId)
    })
  for (const binding of candidates) {
    const session = sessions.find((item) => item.id === binding.sessionId)
    if (session?.workspaceId === owner.projectId) return session
  }
  return null
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || path.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(path)
}

function getParentDir(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const idx = normalized.lastIndexOf('/')
  if (idx <= 0) return ''
  return normalized.slice(0, idx)
}

/** cyrb53: 快速字符串 hash，遍历完整内容避免边缘碰撞 */
function cyrb53(str: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16)
}

function uniqueTruthyPaths(paths: Array<string | null | undefined>): string[] {
  return Array.from(new Set(paths.filter((p): p is string => typeof p === 'string' && p.length > 0)))
}

// ============================================================================
// Phase 1 临时兼容层：将 AgentStreamPayload 转换为旧 AgentEvent
// Phase 2 将移除此转换，直接使用 SDKMessage 渲染
// ============================================================================

function isRunScopedRetryEvent(event: AgentEvent): event is Extract<AgentEvent, {
  type: 'retrying' | 'retry_attempt' | 'retry_cleared' | 'retry_failed' | 'retry_cancelled'
}> {
  return event.type === 'retrying'
    || event.type === 'retry_attempt'
    || event.type === 'retry_cleared'
    || event.type === 'retry_failed'
    || event.type === 'retry_cancelled'
}

function deltaToLegacyControlEvents(delta: AgentAssistantDelta): AgentEvent[] {
  if (delta.type !== 'toolcall_start' && delta.type !== 'toolcall_end') return []
  const toolCall = delta.toolCall
  if (!toolCall) return []
  return [{
    type: 'tool_start',
    toolName: toolCall.name,
    toolUseId: toolCall.id,
    input: toolCall.arguments ?? {},
    parentToolUseId: undefined,
  }]
}

function applyAssistantDeltasToPreview(
  message: SDKAssistantMessage,
  deltas: readonly AgentAssistantDelta[],
): SDKAssistantMessage {
  if (deltas.length === 0) return message
  // 整批 delta 共用一份 content 并只产出一个消息对象。
  // batcher 会把同一帧内的几十个 delta 合并，逐个复制会在一帧内产生几十份
  // content 数组与消息对象，在多 Agent 并发下形成持续的 GC 压力。
  const content = [...message.message.content] as SDKContentBlock[]
  for (const delta of deltas) {
    const index = 'contentIndex' in delta ? delta.contentIndex : undefined
    const ensureBlock = (fallback: SDKContentBlock): number => {
      if (index == null) {
        content.push(fallback)
        return content.length - 1
      }
      while (content.length <= index) content.push({ type: 'text', text: '' })
      return index
    }
    const existing = index != null ? content[index] : undefined
    switch (delta.type) {
      case 'text_start':
        content[ensureBlock({ type: 'text', text: '' })] = { type: 'text', text: '' }
        break
      case 'text_delta': {
        const blockIndex = ensureBlock({ type: 'text', text: '' })
        const text = existing?.type === 'text' && 'text' in existing && typeof existing.text === 'string' ? existing.text : ''
        content[blockIndex] = { type: 'text', text: text + delta.delta }
        break
      }
      case 'text_end':
        content[ensureBlock({ type: 'text', text: '' })] = { type: 'text', text: delta.content }
        break
      case 'thinking_start':
        content[ensureBlock({ type: 'thinking', thinking: '' })] = { type: 'thinking', thinking: '' }
        break
      case 'thinking_delta': {
        const blockIndex = ensureBlock({ type: 'thinking', thinking: '' })
        const thinking = existing?.type === 'thinking' && 'thinking' in existing && typeof existing.thinking === 'string' ? existing.thinking : ''
        content[blockIndex] = { type: 'thinking', thinking: thinking + delta.delta }
        break
      }
      case 'thinking_end':
        content[ensureBlock({ type: 'thinking', thinking: '' })] = { type: 'thinking', thinking: delta.content }
        break
      case 'toolcall_start':
      case 'toolcall_delta':
      case 'toolcall_end': {
        const toolCall = delta.toolCall
        if (!toolCall) break
        const blockIndex = ensureBlock({ type: 'tool_use', id: toolCall.id, name: toolCall.name, input: {} })
        const previous = content[blockIndex]
        content[blockIndex] = {
          type: 'tool_use',
          id: toolCall.id,
          name: toolCall.name,
          input: toolCall.arguments ?? (previous?.type === 'tool_use' && 'input' in previous ? previous.input : {}),
        }
        break
      }
      case 'start':
        break
    }
  }
  return { ...message, message: { ...message.message, content }, _partial: true } as SDKAssistantMessage
}

function createAssistantDeltaPreview(payload: AgentAssistantDeltaPayload, metadata: Partial<SDKAssistantMessage>): SDKAssistantMessage {
  return {
    type: 'assistant',
    message: { content: [] },
    parent_tool_use_id: null,
    session_id: payload.session_id,
    uuid: payload.uuid,
    _partial: true,
    _createdAt: payload.runStartedAt ?? Date.now(),
    ...metadata,
  } as SDKAssistantMessage
}

function payloadToLegacyEvents(payload: AgentStreamPayload): AgentEvent[] {
  // sdk_delta 的文本和 thinking 已直接写入 liveMessages；只保留工具启动控制状态，
  // 避免每个 token 都触发第二份 AgentStreamState 更新和渲染路径。
  if (payload.kind === 'sdk_delta') return payload.delta.deltas.flatMap(deltaToLegacyControlEvents)
  if (payload.kind === 'proma_event') {
    const evt = payload.event
    switch (evt.type) {
      case 'permission_request':
        return [{ type: 'permission_request', request: evt.request }]
      case 'permission_resolved':
        return [{ type: 'permission_resolved', requestId: evt.requestId, behavior: evt.behavior }]
      case 'ask_user_request':
        return [{ type: 'ask_user_request', request: evt.request }]
      case 'ask_user_resolved':
        return [{ type: 'ask_user_resolved', requestId: evt.requestId }]
      case 'exit_plan_mode_request':
        return [{ type: 'exit_plan_mode_request', request: evt.request }]
      case 'exit_plan_mode_resolved':
        return [{ type: 'exit_plan_mode_resolved', requestId: evt.requestId }]
      case 'enter_plan_mode':
        return [{ type: 'enter_plan_mode', sessionId: evt.sessionId }]
      case 'plan_mode_changed':
        return [{ type: 'plan_mode_changed', active: evt.active, source: evt.source }]
      case 'model_resolved':
        return [{ type: 'model_resolved', model: evt.model }]
      case 'context_window':
        // main 进程从 SDK result 拿到的真实 contextWindow，转成 usage_update 让 atom 合并到 streamState
        return [{ type: 'usage_update', usage: { contextWindow: evt.contextWindow } }]
      case 'permission_mode_changed':
        return [{ type: 'permission_mode_changed', mode: evt.mode }]
      case 'run_resumed':
        return [{ type: 'run_resumed' }]
      case 'retry': {
        const events: AgentEvent[] = []
        const retryScope = {
          runStartedAt: evt.runStartedAt,
          totalAttempt: evt.totalAttempt,
          maxTotalAttempts: evt.maxTotalAttempts,
        }
        if (evt.status === 'starting' && evt.attempt != null && evt.maxAttempts != null) {
          events.push({
            type: 'retrying',
            attempt: evt.attempt,
            maxAttempts: evt.maxAttempts,
            delaySeconds: evt.delaySeconds ?? 0,
            reason: evt.reason ?? '',
            scheduledAt: evt.scheduledAt,
            ...retryScope,
          })
        }
        if (evt.status === 'attempt' && evt.attemptData) {
          events.push({
            type: 'retry_attempt',
            attemptData: evt.attemptData,
            maxAttempts: evt.maxAttempts,
            ...retryScope,
          })
        }
        if (evt.status === 'cleared') {
          events.push({
            type: 'retry_cleared',
            attempt: evt.attempt,
            maxAttempts: evt.maxAttempts,
            ...retryScope,
          })
        }
        if (evt.status === 'failed' && evt.attemptData) {
          events.push({
            type: 'retry_failed',
            finalAttempt: evt.attemptData,
            maxAttempts: evt.maxAttempts,
            ...retryScope,
          })
        }
        if (evt.status === 'cancelled' && evt.attempt != null && evt.maxAttempts != null) {
          events.push({
            type: 'retry_cancelled',
            attempt: evt.attempt,
            maxAttempts: evt.maxAttempts,
            reason: evt.reason,
            ...retryScope,
          })
        }
        return events
      }
      default:
        return []
    }
  }

  // sdk_message → 转换为对应的 AgentEvent
  const msg = payload.message

  switch (msg.type) {
    case 'assistant': {
      const aMsg = msg as SDKAssistantMessage
      if (aMsg.isReplay) return []
      if (aMsg.error) {
        // 错误已在主进程处理，这里仅作为 typed_error 透传
        return [{ type: 'error', message: aMsg.error.message }]
      }
      const events: AgentEvent[] = []
      for (const block of aMsg.message.content) {
        if (block.type === 'tool_use') {
          const tb = block as SDKContentBlock & { id: string; name: string; input: Record<string, unknown> }
          const intent = (tb.input._intent as string | undefined)
            ?? (tb.name === 'Bash' ? (tb.input.description as string | undefined) : undefined)
          const planModeChange = getPlanModeChangeFromToolName(tb.name)
          if (planModeChange) {
            events.push({
              type: 'plan_mode_changed',
              active: planModeChange.active,
              source: planModeChange.source,
            })
          }
          events.push({
            type: 'tool_start',
            toolName: tb.name,
            toolUseId: tb.id,
            input: tb.input,
            intent,
            displayName: tb.input._displayName as string | undefined,
            parentToolUseId: aMsg.parent_tool_use_id ?? undefined,
          })
        }
      }
      // Usage（保留完整字段用于详细展示）
      if (!aMsg.parent_tool_use_id && aMsg.message.usage) {
        const u = aMsg.message.usage
        const inputTokens = u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
        // 流式过程中 SDK 不返回 contextWindow，按模型名推断一个默认值作为 fallback。
        // 注意：必须优先用 _channelModelId（用户在 UI 上选择的原始模型 ID），
        // 因为部分端点（如智谱）会在 message.model 里剥掉 [1m] 等规格后缀，
        // 导致 glm-x-preview[1m] 被识别成 glm-x-preview（200K）。
        const modelName = aMsg._channelModelId ?? aMsg.message.model
        const fallbackWindow = inferContextWindow(modelName)
        events.push({
          type: 'usage_update',
          usage: {
            inputTokens,
            outputTokens: u.output_tokens,
            cacheReadTokens: u.cache_read_input_tokens,
            cacheCreationTokens: u.cache_creation_input_tokens,
            ...(fallbackWindow ? { contextWindow: fallbackWindow } : {}),
          },
        })
      }
      return events
    }

    case 'user': {
      const uMsg = msg as SDKUserMessage
      if (uMsg.isReplay) return []
      const events: AgentEvent[] = []
      const contentBlocks = uMsg.message?.content ?? []
      for (const block of contentBlocks) {
        if (block.type === 'tool_result') {
          const tb = block as SDKUserContentBlock & { tool_use_id: string; content?: unknown; is_error?: boolean }
          const resultStr = typeof tb.content === 'string' ? tb.content : (tb.content != null ? JSON.stringify(tb.content) : '')
          events.push({
            type: 'tool_result',
            toolUseId: tb.tool_use_id,
            result: resultStr,
            isError: tb.is_error ?? false,
            parentToolUseId: uMsg.parent_tool_use_id ?? undefined,
          })
        }
      }
      return events
    }

    case 'result': {
      const rMsg = msg as {
        subtype: string
        total_cost_usd?: number
        modelUsage?: Record<string, { contextWindow?: number }>
        usage?: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }
        isSyntheticCompactionResult?: boolean
        _channelModelId?: string
        _channelProvider?: ProviderType
      }
      if (rMsg.isSyntheticCompactionResult) {
        return [{
          type: 'complete',
          stopReason: rMsg.subtype === 'success' ? 'end_turn' : 'error',
        }]
      }
      // 多 entry 场景（Task 子 Agent 等）：取最大 contextWindow，
      // 避免子 Agent 的小窗口覆盖主模型的大窗口、导致指示器飘忽。
      let contextWindow: number | undefined
      const fallbackWindow = inferContextWindow(rMsg._channelModelId)
      if (rMsg.modelUsage) {
        for (const [modelId, info] of Object.entries(rMsg.modelUsage)) {
          const modelFallbackWindow = inferContextWindow(rMsg._channelModelId ?? modelId)
          const candidate = Math.max(info?.contextWindow ?? 0, modelFallbackWindow ?? 0) || undefined
          if (candidate && (contextWindow === undefined || candidate > contextWindow)) {
            contextWindow = candidate
          }
        }
      } else {
        contextWindow = fallbackWindow
      }
      // result.usage 是整个 query 内所有模型调用的累计求和，不能当成当前上下文占用，
      // 否则进度环会虚高、冲破 100%（PR #821 修的正是这个问题）。
      //
      // 但 GLM-5.2 等走 Anthropic 兼容端点的渠道，流式 assistant 消息不携带 usage 字段，
      // 真实值只在 result 中返回。若完全不透传，这些渠道的 ContextUsageBadge 永远不显示。
      //
      // 折中：完整透传 result.usage 字段，由 agent-atoms 的 complete 分支按
      // 「流式 usage_update 从未写入过」条件兜底（needFallback），避免覆盖流式真实值。
      const u = rMsg.usage
      const inputTokens = u ? u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) : undefined
      return [{
        type: 'complete',
        stopReason: rMsg.subtype === 'success' ? 'end_turn' : 'error',
        usage: (rMsg.total_cost_usd != null || contextWindow != null || u != null) ? {
          costUsd: rMsg.total_cost_usd,
          contextWindow,
          ...(inputTokens != null && { inputTokens }),
          ...(u && { outputTokens: u.output_tokens }),
          ...(u && { cacheReadTokens: u.cache_read_input_tokens }),
          ...(u && { cacheCreationTokens: u.cache_creation_input_tokens }),
        } : undefined,
      }]
    }

    case 'system': {
      const sMsg = msg as SDKSystemMessage
      if (sMsg.subtype === 'compact_boundary') {
        const estimatedTokensAfter = sMsg.compactionEstimatedTokensAfter
        return [{
          type: 'compact_complete',
          status: 'success',
          summary: sMsg.summary,
          ...(typeof estimatedTokensAfter === 'number' && estimatedTokensAfter > 0 && { estimatedTokensAfter }),
        }]
      }
      if (sMsg.subtype === 'compacting') {
        return [{ type: 'compacting', afterCompletedTurn: sMsg.afterCompletedTurn === true }]
      }
      if (sMsg.subtype === 'status') {
        if (sMsg.status === 'compacting') {
          return [{ type: 'compacting', afterCompletedTurn: sMsg.afterCompletedTurn === true }]
        }
        if (sMsg.compact_result === 'success' || sMsg.compact_result === 'failed' || sMsg.compact_result === 'noop') {
          return [{
            type: 'compact_complete',
            status: sMsg.compact_result,
            summary: sMsg.summary,
            message: sMsg.compact_error ?? sMsg.message,
          }]
        }
        if (typeof sMsg.compact_error === 'string') {
          return [{ type: 'compact_complete', status: 'failed', message: sMsg.compact_error }]
        }
      }
      if (sMsg.subtype === 'task_started' && sMsg.task_id) {
        return [{ type: 'task_started', taskId: sMsg.task_id, description: sMsg.description ?? '', taskType: sMsg.task_type, toolUseId: sMsg.tool_use_id }]
      }
      if (sMsg.subtype === 'task_notification' && sMsg.task_id) {
        return [{
          type: 'task_notification',
          taskId: sMsg.task_id,
          status: (sMsg.status as 'completed' | 'failed' | 'stopped') ?? 'completed',
          summary: sMsg.summary ?? '',
          outputFile: sMsg.output_file,
          toolUseId: sMsg.tool_use_id,
          usage: sMsg.usage ? {
            totalTokens: sMsg.usage.total_tokens ?? 0,
            toolUses: sMsg.usage.tool_uses ?? 0,
            durationMs: sMsg.usage.duration_ms ?? 0,
          } : undefined,
        }]
      }
      if (sMsg.subtype === 'task_progress' && sMsg.task_id) {
        return [{
          type: 'task_progress',
          taskId: sMsg.task_id,
          toolUseId: sMsg.tool_use_id ?? sMsg.task_id,
          description: sMsg.description,
          lastToolName: sMsg.last_tool_name,
          usage: sMsg.usage ? {
            totalTokens: sMsg.usage.total_tokens ?? 0,
            toolUses: sMsg.usage.tool_uses ?? 0,
            durationMs: sMsg.usage.duration_ms ?? 0,
          } : undefined,
        }]
      }
      if (sMsg.subtype === 'thinking_tokens' && typeof sMsg.estimated_tokens === 'number') {
        return [{
          type: 'thinking_tokens',
          estimatedTokens: sMsg.estimated_tokens,
          estimatedTokensDelta: typeof sMsg.estimated_tokens_delta === 'number' ? sMsg.estimated_tokens_delta : 0,
        }]
      }
      return []
    }

    case 'tool_progress': {
      const tpMsg = msg as { tool_use_id: string; elapsed_time_seconds?: number; task_id?: string }
      return [{
        type: 'task_progress',
        toolUseId: tpMsg.tool_use_id,
        elapsedSeconds: tpMsg.elapsed_time_seconds,
        taskId: tpMsg.task_id,
      }]
    }

    case 'prompt_suggestion': {
      const psMsg = msg as { suggestion?: string }
      if (psMsg.suggestion) return [{ type: 'prompt_suggestion', suggestion: psMsg.suggestion }]
      return []
    }

    case 'tool_use_summary': {
      const tusMsg = msg as { summary?: string; preceding_tool_use_ids?: string[] }
      if (tusMsg.summary) return [{ type: 'tool_use_summary', summary: tusMsg.summary, precedingToolUseIds: tusMsg.preceding_tool_use_ids ?? [] }]
      return []
    }

    default:
      return []
  }
}

/**
 * 应用主进程 after-current started 状态，并在删除队列项前捕获其结构化引用。
 * @param store Renderer 全局 Jotai store。
 * @param status 主进程已启动队列消息的权威状态。
 * @returns 无返回值；同步更新运行态、队列、live 消息与错误状态。
 */
export function applyAgentQueuedMessageStartedStatus(
  store: Store,
  status: Extract<AgentQueuedMessageStatus, { status: 'started' }>,
): void {
  unstable_batchedUpdates(() => {
    /** started 状态本身不携带 Canvas 引用，必须在队列删除前保存匹配快照。 */
    const queuedMessage = store.get(agentSessionMessageQueueAtom)
      .get(status.sessionId)
      ?.find((message) => message.id === status.messageId)
    // 主进程在启动 deferred run 前先发送 started 投影。这里必须先建立完整的
    // 当前 run 状态，否则首个 SDK/tool 事件到达前会被当成空闲；后续事件只能
    // 隐式创建一个没有 startedAt 的状态，导致续跑的运行计时和 run 边界丢失。
    store.set(agentStreamingStatesAtom, (prev) => {
      const current = prev.get(status.sessionId)
      // 不让迟到的队列状态覆盖已经开始的新一轮 run。
      if (current?.startedAt != null && current.startedAt > status.startedAt) return prev
      const map = new Map(prev)
      map.set(status.sessionId, createQueuedAgentStreamState(current, status.startedAt))
      return map
    })
    store.set(agentSessionMessageQueueAtom, (prev) => {
      const current = prev.get(status.sessionId) ?? []
      const next = removeQueuedMessage(current, status.messageId)
      if (next.length === current.length) return prev
      const map = new Map(prev)
      if (next.length === 0) map.delete(status.sessionId)
      else map.set(status.sessionId, next)
      return map
    })
    store.set(liveMessagesMapAtom, (prev) => {
      const current = prev.get(status.sessionId) ?? []
      const uuid = status.messageId
      if (current.some((message) => (message as unknown as { uuid?: string }).uuid === uuid)) return prev
      const optimisticMessage: SDKMessage = {
        type: "user",
        uuid,
        message: { content: [{ type: "text", text: status.rawUserMessage ?? status.userMessage }] },
        parent_tool_use_id: null,
        _createdAt: status.startedAt,
        _promaLiveRunStartedAt: status.startedAt,
        ...(queuedMessage?.canvasNodeReferences && queuedMessage.canvasNodeReferences.length > 0
          ? { _canvasNodeReferences: [...queuedMessage.canvasNodeReferences] }
          : {}),
      } as unknown as SDKMessage
      const map = new Map(prev)
      map.set(status.sessionId, [...current, optimisticMessage])
      return map
    })
    store.set(agentStreamErrorsAtom, (prev) => {
      if (!prev.has(status.sessionId)) return prev
      const map = new Map(prev)
      map.delete(status.sessionId)
      return map
    })
  })
}

/** 恢复后台准备失败的 deferred 消息，重复状态不会重复写入。 */
export function applyAgentQueuedMessageFailedStatus(
  store: Store,
  status: Extract<AgentQueuedMessageStatus, { status: 'failed' }>,
): boolean {
  const queuedMessage = store.get(agentSessionMessageQueueAtom)
    .get(status.sessionId)
    ?.find((message) => message.id === status.messageId)
  if (!queuedMessage) return false
  const attachments = queuedMessage.attachments
  const canvasNodeReferences = queuedMessage.canvasNodeReferences
  const quotedSelection = queuedMessage.quotedSelection

  unstable_batchedUpdates(() => {
    store.set(agentSessionMessageQueueAtom, (previous) => {
      const current = previous.get(status.sessionId) ?? []
      const next = removeQueuedMessage(current, status.messageId)
      const map = new Map(previous)
      if (next.length === 0) map.delete(status.sessionId)
      else map.set(status.sessionId, next)
      return map
    })
    store.set(agentSessionDraftsAtom, (previous) => {
      const map = new Map(previous)
      map.set(
        status.sessionId,
        mergeAgentDraftWithRestoredMessage(previous.get(status.sessionId) ?? '', queuedMessage.text),
      )
      return map
    })
    /** 恢复为纯文本草稿，避免旧富文本结构与新合并正文不一致。 */
    store.set(agentSessionDraftHtmlAtom, (previous) => {
      if (!previous.has(status.sessionId)) return previous
      const map = new Map(previous)
      map.delete(status.sessionId)
      return map
    })
    if (attachments?.length) {
      store.set(agentPendingFilesAtomFamily(status.sessionId), (current) => [
        ...current,
        ...attachments.map((attachment, index) => ({
          id: `deferred-failed-${status.messageId}-${index}`,
          filename: attachment.filename,
          mediaType: attachment.mediaType,
          size: attachment.size,
          sourcePath: attachment.targetPath,
        })),
      ])
    }
    if (canvasNodeReferences?.length) {
      store.set(agentCanvasNodeReferencesAtomFamily(status.sessionId), (current) => (
        restoreMissingCanvasNodeReferences(current, canvasNodeReferences)
      ))
    }
    if (quotedSelection) {
      store.set(quotedSelectionMapAtom, (previous) => {
        /** 用户在等待期间创建的新选区优先，失败恢复只补回当前缺失的旧选区。 */
        if (previous.has(status.sessionId)) return previous
        const map = new Map(previous)
        map.set(status.sessionId, quotedSelection)
        return map
      })
    }
  })
  return true
}

/** 按权威终态分派 deferred 消息状态。 */
export function applyAgentQueuedMessageStatus(store: Store, status: AgentQueuedMessageStatus): boolean {
  if (status.status === 'started') {
    applyAgentQueuedMessageStartedStatus(store, status)
    return true
  }
  return applyAgentQueuedMessageFailedStatus(store, status)
}

/** 全局 Canvas activity consumer 的可测试窄依赖。 */
export interface GlobalAgentCanvasActivityDependencies {
  listBindings: (projectId: string) => Promise<AgentCanvasBinding[]>
  onCanvasChanged: (listener: (event: CanvasChangeEvent) => void) => () => void
  onBindingChanged: (listener: (event: AgentCanvasBindingChangeEvent) => void) => () => void
}

/** 在应用顶层建立唯一 Canvas activity listener，不依赖任何 SidePanel 或 Canvas controller。 */
export function startGlobalAgentCanvasActivityConsumer(
  store: Store,
  dependencies: GlobalAgentCanvasActivityDependencies,
): { dispose: () => void } {
  /** binding 变化代次用于阻止在途旧 LIST 恢复已撤销授权。 */
  const bindingGenerationByProject = new Map<string, number>()
  let disposed = false
  const releaseBinding = dependencies.onBindingChanged((event) => {
    bindingGenerationByProject.set(
      event.projectId,
      (bindingGenerationByProject.get(event.projectId) ?? 0) + 1,
    )
    store.set(
      reconcileAgentCanvasActivityBindingAtom,
      event.binding,
      event.projectId,
      event.sessionId,
    )
  })
  const releaseCanvas = dependencies.onCanvasChanged((event) => {
    void (async () => {
      let bindings: AgentCanvasBinding[]
      while (true) {
        const generation = bindingGenerationByProject.get(event.projectId) ?? 0
        bindings = await dependencies.listBindings(event.projectId)
        if (disposed) return
        if ((bindingGenerationByProject.get(event.projectId) ?? 0) === generation) break
      }
      store.set(recordAgentCanvasActivityAtom, { event, bindings })
    })().catch(() => {
      console.error('[Agent-Canvas activity] 权威关联读取失败')
    })
  })
  return {
    dispose: () => {
      if (disposed) return
      disposed = true
      releaseCanvas()
      releaseBinding()
    },
  }
}

/** 全局 Agent 产物工具消费者公开的最小生命周期。 */
export interface GlobalAgentCanvasArtifactConsumer {
  handle: (sessionId: string, event: AgentEvent) => void
  dispose: () => void
}

/** 为会话与工具调用构造不会跨会话碰撞的短期身份。 */
function createCanvasArtifactToolKey(sessionId: string, toolUseId: string): string {
  return JSON.stringify([sessionId, toolUseId])
}

/**
 * 监听普通 Agent 的画布产物工具结果，只记录稍后打开时需要定位的节点。
 * @param store Renderer 进程内唯一 Jotai store。
 * @returns 可接收扁平 AgentEvent 的消费者与清理函数。
 */
export function startGlobalAgentCanvasArtifactConsumer(store: Store): GlobalAgentCanvasArtifactConsumer {
  /** 只有真实 canvas_create_artifact start 才能授权同会话结果触发导航。 */
  const pendingToolKeys = new Set<string>()
  return {
    handle: (sessionId, event) => {
      if (event.type === 'tool_start') {
        if (event.toolName === 'canvas_create_artifact') {
          pendingToolKeys.add(createCanvasArtifactToolKey(sessionId, event.toolUseId))
        }
        return
      }
      if (event.type === 'complete' || event.type === 'error') {
        const prefix = `[${JSON.stringify(sessionId)},`
        for (const key of pendingToolKeys) {
          if (key.startsWith(prefix)) pendingToolKeys.delete(key)
        }
        return
      }
      if (event.type !== 'tool_result') return
      const key = createCanvasArtifactToolKey(sessionId, event.toolUseId)
      if (!pendingToolKeys.delete(key) || event.isError) return
      const result = parseCanvasArtifactToolResult(event.result)
      if (!result) return
      /** 会话项目是构造完整 view key 的权威 Renderer 快照；缺失时禁止猜测项目。 */
      const session = store.get(agentSessionsAtom).find((candidate) => candidate.id === sessionId)
      if (!session?.workspaceId) return
      const viewKey = createAgentCanvasViewKey(sessionId, session.workspaceId, result.canvasId)
      store.set(navigateAgentCanvasViewAtom, { key: viewKey, nodeId: result.nodeId })
    },
    dispose: () => pendingToolKeys.clear(),
  }
}

export function useGlobalAgentListeners(): void {
  const store = useStore()

  useEffect(() => {
    /** 正在执行的写工具；写入前的文件存在性用于区分新建和编辑。 */
    const pendingWriteTools = new Map<string, {
      path: string
      sessionId: string
      toolName: string
      existedBefore?: boolean
      runId: string
    }>()
    /** 正在执行的 git 突变 Bash 命令：toolUseId → sessionId（完成后触发 diff 刷新） */
    const pendingGitMutateTools = new Map<string, string>()
    /** 创建产物后只导航执行该工具的普通 Agent 会话。 */
    const canvasArtifactConsumer = startGlobalAgentCanvasArtifactConsumer(store)

    /** 普通 Agent Canvas activity 只在应用顶层消费一次，不依赖 SidePanel 挂载。 */
    const canvasActivityConsumer = startGlobalAgentCanvasActivityConsumer(store, {
      listBindings: (projectId) => designAdapter.listAgentCanvasBindings({ projectId }),
      onCanvasChanged: (listener) => window.electronAPI.onCanvasChanged(listener),
      onBindingChanged: (listener) => window.electronAPI.onAgentCanvasBindingChanged(listener),
    })

    const cleanupQueuedMessageStatus = window.electronAPI.onAgentQueuedMessageStatus((status) => {
      const applied = applyAgentQueuedMessageStatus(store, status)
      if (applied && status.status === 'failed') {
        toast.error('队列消息发送失败', { description: status.error.message })
      }
    })

    /** 构建导航到指定会话的回调 */
    const makeNavigateToSession = (sessionId: string, sessionTitle: string) => () => {
      const tabs = store.get(tabsAtom)
      const result = openTab(tabs, { type: 'agent', sessionId, title: sessionTitle })
      store.set(tabsAtom, result.tabs)
      store.set(activeTabIdAtom, result.activeTabId)
      store.set(appModeAtom, 'agent')
      store.set(currentAgentSessionIdAtom, sessionId)
      const sessions = store.get(agentSessionsAtom)
      const session = sessions.find((s) => s.id === sessionId)
      if (session?.workspaceId) {
        store.set(currentAgentWorkspaceIdAtom, session.workspaceId)
      }
    }

    /** 构建返回普通 Agent 右侧 Canvas 与节点对话的通知动作。 */
    const makeNavigateToCanvasAgent = (owner: CanvasAgentOwner) => () => {
      void Promise.all([
        designAdapter.listAgentCanvasBindings({ projectId: owner.projectId }),
        window.electronAPI.listAgentSessions(),
      ]).then(([bindings, sessions]) => {
        /** 通知点击时重新交叉验证两个主进程事实，陈旧 owner 缺任一事实均拒绝导航。 */
        const workspaceOwner = resolveCanvasAgentWorkspaceOwner(owner, bindings, sessions)
        if (!workspaceOwner) return
        const result = openTab(store.get(tabsAtom), {
          type: 'agent',
          sessionId: workspaceOwner.id,
          title: workspaceOwner.title,
        })
        store.set(tabsAtom, result.tabs)
        store.set(activeTabIdAtom, result.activeTabId)
        store.set(agentSidePanelOpenAtomFamily(workspaceOwner.id), true)
        store.set(agentCanvasWorkspaceOpenTabsAtom, (previous) => {
          const targetTab = getCanvasWorkspaceTab(owner.canvasId)
          const current = previous.get(workspaceOwner.id) ?? []
          const withoutLauncher = current.filter((tab) => tab !== 'canvas')
          if (withoutLauncher.includes(targetTab) && withoutLauncher.length === current.length) return previous
          const next = new Map(previous)
          next.set(workspaceOwner.id, withoutLauncher.includes(targetTab)
            ? withoutLauncher
            : [...withoutLauncher, targetTab])
          return next
        })
        store.set(agentDiffPanelTabAtom, (previous) => {
          const next = new Map(previous)
          next.set(workspaceOwner.id, getCanvasWorkspaceTab(owner.canvasId))
          return next
        })
        /** 未 LOAD 时只暂存节点导航意图，首个权威文档仍拥有 viewport 初始化权。 */
        const viewKey = createAgentCanvasViewKey(workspaceOwner.id, owner.projectId, owner.canvasId)
        store.set(navigateAgentCanvasViewAtom, { key: viewKey, nodeId: owner.nodeId })
        store.set(appModeAtom, 'agent')
        store.set(activeViewAtom, 'conversations')
        store.set(currentAgentSessionIdAtom, workspaceOwner.id)
        store.set(currentAgentWorkspaceIdAtom, owner.projectId)
      }).catch((error: unknown) => {
        console.error('[Canvas Agent] 返回所属 Agent 失败:', error)
      })
    }

    /** 获取会话标题 */
    const getSessionTitle = (sessionId: string): string => {
      const sessions = store.get(agentSessionsAtom)
      return sessions.find((s) => s.id === sessionId)?.title ?? '未命名会话'
    }

    const activateExternalAgentRun = (event: Extract<PromaEvent, { type: 'external_run_started' }>): void => {
      const applyActivation = (sessions: AgentSessionMeta[]): void => {
        const currentStreamState = store.get(agentStreamingStatesAtom).get(event.sessionId)
        if (!shouldActivateExternalAgentRun(currentStreamState, event.startedAt, event.runGeneration)) {
          return
        }

        const eventSession = event.session
        const activationSessions = eventSession ? [eventSession] : sessions
        const activation = buildExternalAgentRunActivation({
          tabs: store.get(tabsAtom),
          sessions: activationSessions,
          sessionId: event.sessionId,
          title: event.title,
          workspaceId: event.workspaceId,
          modelId: event.modelId,
          startedAt: event.startedAt,
          runGeneration: event.runGeneration,
          currentStreamState,
        })

        // 外部来源（飞书/钉钉/微信/bridge）唤起的 run 不抢占前台：
        // 不打开新 Tab、不切换激活 Tab、不切换 appMode/当前会话/当前工作区。
        // 只更新驱动左侧边栏列表与状态指示条所需的状态，让用户自行决定是否切过去。
        // 若该会话恰好是用户当前正在查看的会话，这里不动 Tab/激活，流式内容会通过
        // agentStreamingStatesAtom 自然刷新，用户视角无任何跳动。
        // 只 upsert 本次 event 对应的会话，绝不用这份快照整体覆盖列表。
        //
        // 一次派发多个子会话时，多个 external_run_started 回调会各自带着
        // 「事件触发那一刻」或「异步 fetch 那一刻」的快照进来。若整体覆盖
        // agentSessionsAtom，后 resolve 的回调会用自己那份可能缺失了刚结束
        // turn 的父会话的快照，把父会话冲掉——父会话从列表消失后，其子会话
        // 因找不到父而从树形子节点变成根节点直接显示（用户观察到的现象）。
        // 改为单条 upsert 后，每个回调只负责自己那一个会话，互不干扰。
        const sessionMeta = eventSession ?? sessions.find((item) => item.id === event.sessionId)
        const upserted: AgentSessionMeta = sessionMeta ?? {
          id: event.sessionId,
          title: activation.title,
          workspaceId: activation.workspaceId,
          modelId: activation.modelId,
          createdAt: event.startedAt,
          updatedAt: event.startedAt,
        }
        store.set(agentSessionsAtom, (prev) => upsertAgentSession(prev, upserted))
        const activationModelId = activation.modelId
        if (activationModelId) {
          store.set(agentSessionModelMapAtom, (prev) => {
            const map = new Map(prev)
            map.set(event.sessionId, activationModelId)
            return map
          })
        }
        store.set(unviewedCompletedSessionIdsAtom, (prev) => {
          if (!prev.has(event.sessionId)) return prev
          const next = new Set(prev)
          next.delete(event.sessionId)
          return next
        })
        store.set(agentStreamingStatesAtom, (prev) => {
          const map = new Map(prev)
          map.set(event.sessionId, activation.streamState)
          return map
        })

        // 协作子 Agent 仅在用户正查看其父会话时才自动展开到右侧工作区。
        // 后台父会话派生子会话时，仍更新运行状态和侧栏树，但不能抢走用户焦点。
        if (
          upserted.sourceDelegationId
          && upserted.parentSessionId
          && shouldRevealDelegatedSession(upserted.parentSessionId, store.get(activeSessionIdAtom))
        ) {
          store.set(agentSideDelegationMapAtom, (previous) => {
            const openChildIds = previous.get(upserted.parentSessionId!) ?? []
            if (openChildIds.includes(upserted.id)) return previous
            const next = new Map(previous)
            next.set(upserted.parentSessionId!, [...openChildIds, upserted.id])
            return next
          })
          store.set(agentSidePanelOpenAtomFamily(upserted.parentSessionId), true)
          store.set(agentDiffPanelTabAtom, (previous) => {
            const next = new Map(previous)
            next.set(upserted.parentSessionId!, getDelegationSidePanelTab(upserted.id))
            return next
          })
        }
      }

      if (event.session) {
        applyActivation([event.session])
        return
      }

      const knownSessions = store.get(agentSessionsAtom)
      if (knownSessions.some((session) => session.id === event.sessionId)) {
        applyActivation(knownSessions)
        return
      }

      window.electronAPI.listActiveAgentSessions()
        .then((sessions) => {
          unstable_batchedUpdates(() => applyActivation(sessions))
        })
        .catch(console.error)
    }

    /** 发送阻塞通知（带提示音 + 会话导航） */
    const sendBlockingNotification = (sessionId: string, title: string, body: string, soundType: NotificationSoundType) => {
      const enabled = store.get(notificationsEnabledAtom)
      const soundEnabled = store.get(notificationSoundEnabledAtom)
      const sounds = store.get(notificationSoundsAtom)
      const sessionTitle = getSessionTitle(sessionId)
      sendDesktopNotification(
        title,
        `[${sessionTitle}] ${body}`,
        enabled,
        {
          force: true,
          playSound: enabled && soundEnabled,
          soundType,
          sounds,
          onNavigate: makeNavigateToSession(sessionId, sessionTitle),
        }
      )
    }

    const workspaceFilesPathCache = new Map<string, string>()

    const getWorkspaceIdForSession = (sid: string): string | null => {
      const session = store.get(agentSessionsAtom).find((s) => s.id === sid)
      return session?.workspaceId ?? store.get(currentAgentWorkspaceIdAtom)
    }

    const getWorkspaceSlugForSession = (sid: string): string | null => {
      const workspaceId = getWorkspaceIdForSession(sid)
      if (!workspaceId) return null
      return store.get(agentWorkspacesAtom).find((w) => w.id === workspaceId)?.slug ?? null
    }

    const getWorkspaceFilesPathForSession = async (sid: string): Promise<string | null> => {
      const slug = getWorkspaceSlugForSession(sid)
      if (!slug) return null
      const cached = workspaceFilesPathCache.get(slug)
      if (cached) return cached
      try {
        const path = await window.electronAPI.getWorkspaceFilesPath(slug)
        workspaceFilesPathCache.set(slug, path)
        return path
      } catch {
        return null
      }
    }

    const getWorkspaceAttachmentsForSession = async (sid: string): Promise<{
      directories: string[]
      files: string[]
      complete: boolean
    }> => {
      const slug = getWorkspaceSlugForSession(sid)
      if (!slug) return { directories: [], files: [], complete: true }
      try {
        const [directories, files] = await Promise.all([
          window.electronAPI.getWorkspaceDirectories(slug),
          window.electronAPI.getWorkspaceAttachedFiles(slug),
        ])
        return { directories, files, complete: true }
      } catch {
        return { directories: [], files: [], complete: false }
      }
    }

    const buildWrittenFilePreviewInfo = async (sid: string, targetPath: string) => {
      const sessionPath = store.get(agentSessionPathMapAtom).get(sid) ?? ''
      const parentDir = getParentDir(targetPath)
      const dirPath = isAbsolutePath(targetPath) ? parentDir : (sessionPath || parentDir)
      const workspaceId = getWorkspaceIdForSession(sid)
      const workspaceFilesPath = await getWorkspaceFilesPathForSession(sid)
      const sessionAttachedDirs = store.get(agentAttachedDirectoriesMapAtom).get(sid) ?? []
      const sessionAttachedFiles = store.get(agentAttachedFilesMapAtom).get(sid) ?? []
      const workspaceAttachedDirs = workspaceId
        ? (store.get(workspaceAttachedDirectoriesMapAtom).get(workspaceId) ?? [])
        : []
      const workspaceAttachedFiles = workspaceId
        ? (store.get(workspaceAttachedFilesMapAtom).get(workspaceId) ?? [])
        : []
      const basePaths = uniqueTruthyPaths([
        sessionPath,
        workspaceFilesPath,
        dirPath,
        ...sessionAttachedDirs,
        ...sessionAttachedFiles,
        ...workspaceAttachedDirs,
        ...workspaceAttachedFiles,
      ])

      let previewOnly = true
      if (dirPath) {
        try {
          const status = await window.electronAPI.getGitRepoStatus(dirPath, { sessionId: sid })
          previewOnly = status?.isRepo !== true
        } catch {
          previewOnly = true
        }
      }

      // 右侧改动面板应记录 Agent 实际写入的所有路径；会话附件只约束初始上下文，
      // 不应让已完成的外部文件操作从用户可见的变更记录中消失。
      return {
        filePath: targetPath,
        dirPath: dirPath || undefined,
        previewOnly,
        basePaths: basePaths.length > 0 ? basePaths : undefined,
      }
    }

    const isWindows = detectIsWindows()
    // 初始化快照与 STREAM_COMPLETE 可跨 IPC channel 乱序抵达。完成处理回收
    // startedAt 后仍需保留一个短生命周期的终态标记，避免迟到快照复活旧 run。
    // 新协议用 runGeneration；只有老协议才回退到 startedAt。
    const latestTerminalRun = new Map<string, AgentRunMarker>()
    const latestTerminalRunStartedAt = new Map<string, number>()

    const bumpPreviewContentRefresh = (sessionId: string, file: PreviewFile): void => {
      const key = getPreviewContentRefreshKey(sessionId, file)
      store.set(previewContentRefreshVersionAtom, (previous) => {
        const next = new Map(previous)
        next.set(key, (previous.get(key) ?? 0) + 1)
        return next
      })
    }

    const refreshAffectedPreviews = (filePaths: readonly string[]): void => {
      if (filePaths.length === 0) return
      const previewsBySession = store.get(previewFilesMapAtom)
      const sessionPaths = store.get(agentSessionPathMapAtom)
      const resolvedPaths = store.get(previewResolvedPathAtom)
      const affectedKeys = new Set<string>()

      for (const [sessionId, previews] of previewsBySession) {
        const sessionPath = sessionPaths.get(sessionId)
        for (const preview of previews) {
          if (!preview.previewOnly) continue
          const key = getPreviewContentRefreshKey(sessionId, preview)
          const resolvedPath = resolvedPaths.get(key)
          const fileForMatch = resolvedPath ? { ...preview, filePath: resolvedPath } : preview
          if (!doesWorkspaceChangeAffectPreview(fileForMatch, filePaths, sessionPath, isWindows)) continue
          affectedKeys.add(key)
        }
      }
      if (affectedKeys.size === 0) return

      // 单次 watcher 事件最多更新一次 atom，避免多个已打开预览导致连续渲染。
      store.set(previewContentRefreshVersionAtom, (previous) => {
        const next = new Map(previous)
        for (const key of affectedKeys) next.set(key, (previous.get(key) ?? 0) + 1)
        return next
      })
    }

    const cleanupWatchedFileChanges = window.electronAPI.onWorkspaceFilesChanged((changedPaths) => {
      const filePaths = (changedPaths ?? []).filter(isAbsolutePath)
      refreshAffectedPreviews(filePaths)
      if (filePaths.length === 0) return

      void (async () => {
        const streamingStates = store.get(agentStreamingStatesAtom)
        const sessionPaths = store.get(agentSessionPathMapAtom)
        const candidateIds = [...streamingStates.entries()]
          .filter(([, state]) => state.running)
          .map(([sessionId]) => sessionId)

        const candidates = await Promise.all(candidateIds.map(async (sessionId) => {
          const session = store.get(agentSessionsAtom).find((item) => item.id === sessionId)
          const sessionPath = sessionPaths.get(sessionId)
          const workspaceFilesPath = await getWorkspaceFilesPathForSession(sessionId)
          const workspaceAttachments = await getWorkspaceAttachmentsForSession(sessionId)
          const matchingPaths = getOwnedSessionWatcherPaths(filePaths, {
            sessionExists: Boolean(session),
            sessionPath,
            sessionAttachedDirectories: session?.attachedDirectories ?? [],
            sessionAttachedFiles: session?.attachedFiles ?? [],
            workspaceAttachmentsComplete: workspaceAttachments.complete,
            workspaceFilesPath,
            workspaceAttachedDirectories: workspaceAttachments.directories,
            workspaceAttachedFiles: workspaceAttachments.files,
          }, isWindows)
          return { sessionId, matchingPaths }
        }))

        for (const { sessionId, matchingPaths } of candidates) {
          // watcher 事件没有来源 session。路径被多个运行中会话覆盖时不能可靠归属，
          // 因此仅记录唯一匹配的路径，避免把后台会话的写入显示在错误会话中。
          const uniquelyMatchingPaths = matchingPaths.filter((changedPath) => (
            candidates.filter((candidate) => candidate.matchingPaths.includes(changedPath)).length === 1
          ))
          if (uniquelyMatchingPaths.length === 0) continue

          const runId = store.get(agentFileChangesCurrentRunAtom).get(sessionId)
            ?? String(streamingStates.get(sessionId)?.startedAt ?? Date.now())
          for (const changedPath of uniquelyMatchingPaths) {
            // watcher 现在也会携带删除/目录路径；这些不应进入会话的文件改动记录。
            const existingFile = await window.electronAPI.resolveAndReadFile(changedPath, { sessionId, unrestricted: true })
            if (!existingFile) continue
            const previewFile = await buildWrittenFilePreviewInfo(sessionId, changedPath)
            if (previewFile.previewOnly) {
              store.set(agentNonGitFileChangesAtom, (prev) => {
                const map = new Map(prev)
                const current = map.get(sessionId) ?? []
                map.set(sessionId, upsertSessionFileChange(current, {
                  path: changedPath,
                  kind: 'edited',
                  runId,
                  updatedAt: Date.now(),
                }, isWindows))
                return map
              })
            }
          }
        }
      })().catch(() => { /* 文件监听不应影响会话流 */ })
    })

    // ===== 0. 初始化：恢复 stoppedByUser、主进程真实运行态与 deferred queue 投影 =====
    // 队列由主进程持有。reload 后只将还在主进程队列中的项合并到本地，
    // 使用 queueMessageId 去重，绝不覆盖用户在 reload 窗口内刚更新的本地投影。
    const restoreQueuedMessages = async (): Promise<void> => {
      const sessionIds = new Set<string>([
        ...store.get(agentSessionsAtom).map((session) => session.id),
        ...store.get(agentSessionMessageQueueAtom).keys(),
      ])
      for (const sessionId of sessionIds) {
        const snapshots = await window.electronAPI.getQueuedAgentMessages(sessionId)
        if (snapshots.length === 0) continue
        store.set(agentSessionMessageQueueAtom, (previous) => {
          const current = previous.get(sessionId) ?? []
          const knownIds = new Set(current.map((message) => message.id))
          const recovered = snapshots
            .filter(({ input }) => !knownIds.has(input.queueMessageId))
            .map(({ input, queuedAt }) => createAgentQueuedMessage(
              input.rawUserMessage ?? input.userMessage,
              input.queueMessageId,
              queuedAt,
              null,
              { additionalDirectories: input.additionalDirectories },
            ))
          if (recovered.length === 0) return previous
          const next = new Map(previous)
          next.set(sessionId, [...current, ...recovered])
          return next
        })
      }
    }
    void restoreQueuedMessages().catch(console.error)

    // ===== 0. 初始化：恢复 stoppedByUser 与主进程真实运行态 =====
    // 运行态不落盘，窗口重载或 renderer 晚订阅时必须从主进程 activeSessions
    // 补一份快照；快照只提升缺失/更旧的状态，不覆盖已收到的完成态。
    window.electronAPI.listActiveAgentSessionSnapshots().then((snapshots) => {
      unstable_batchedUpdates(() => {
        for (const snapshot of snapshots) {
          store.set(agentSessionStreamingStateAtomFamily(snapshot.sessionId), (existing) => {
            return mergeActiveAgentSessionSnapshot(
              existing,
              snapshot,
              latestTerminalRun.get(snapshot.sessionId),
            )
          })
        }
      })
    }).catch(console.error)

    window.electronAPI.listActiveAgentSessions().then((sessions) => {
      const stoppedIds = new Set<string>(
        sessions.filter((s) => s.stoppedByUser).map((s) => s.id)
      )
      if (stoppedIds.size > 0) {
        store.set(stoppedByUserSessionsAtom, stoppedIds)
      }
    }).catch(console.error)

    // ===== 1. 流式事件 =====
    const handleStreamEvent = (streamEvent: AgentStreamEvent): void => {
        const { sessionId, payload } = streamEvent
        /** Canvas owner 或损坏内部身份存在于全局索引，不依赖当前打开的 Canvas。 */
        const isCanvasAgent = store.get(canvasAgentOwnersAtom).has(sessionId)
          || store.get(canvasAgentInternalInvalidSessionIdsAtom).has(sessionId)

        unstable_batchedUpdates(() => {

        if (!isCanvasAgent && payload.kind === 'proma_event' && payload.event.type === 'external_run_started') {
          activateExternalAgentRun(payload.event)
        }

        const runStartedEvent = payload.kind === 'proma_event' && payload.event.type === 'run_started'
          ? payload.event
          : null
        if (runStartedEvent) {
          const canvasOwner = store.get(canvasAgentOwnersAtom).get(sessionId)
          if (canvasOwner) store.set(canvasAgentLifecycleAtom, {
            type: 'started', owner: canvasOwner, startedAt: runStartedEvent.startedAt,
          })
          else if (store.get(canvasAgentInternalInvalidSessionIdsAtom).has(sessionId)) {
            store.set(canvasAgentLifecycleAtom, {
              type: 'invalid-started', sessionId, startedAt: runStartedEvent.startedAt,
            })
          }
          const latestTerminalStartedAt = latestTerminalRunStartedAt.get(sessionId)
          if (latestTerminalStartedAt != null && runStartedEvent.startedAt > latestTerminalStartedAt) {
            latestTerminalRunStartedAt.delete(sessionId)
          }
          // 队列 run 会先通过独立 IPC 发送 started 投影，但该投影可能在窗口
          // 重载或跨 renderer 路由时丢失。run_started 是同一轮的第二个权威启动信号，
          // 必须在首个 SDK/tool 事件之前恢复 running、startedAt 和正常的 live UI。
          store.set(agentStreamingStatesAtom, (prev) => {
            const current = prev.get(sessionId)
            if (
              current?.runGeneration != null
              && runStartedEvent.runGeneration != null
            ) {
              if (current.runGeneration > runStartedEvent.runGeneration) return prev
              // 重复 start 保留已有 live 状态；已结束 run 更不能被重复 start 复活。
              if (current.runGeneration === runStartedEvent.runGeneration) return prev
            }
            // 旧协议事件没有代际，只能保留 startedAt 回退比较。
            if (runStartedEvent.runGeneration == null && current?.startedAt != null && (
              current.startedAt > runStartedEvent.startedAt
              || (current.startedAt === runStartedEvent.startedAt && current.running)
            )) return prev
            const map = new Map(prev)
            map.set(sessionId, {
              ...createQueuedAgentStreamState(current, runStartedEvent.startedAt),
              ...(runStartedEvent.runGeneration != null ? { runGeneration: runStartedEvent.runGeneration } : {}),
            })
            return map
          })
          if (!isCanvasAgent) store.set(unviewedCompletedSessionIdsAtom, (prev) => {
            if (!prev.has(sessionId)) return prev
            const next = new Set(prev)
            next.delete(sessionId)
            return next
          })
        }

        // 自动任务会话被用户接管（毕业）：向用户提示，后续定时运行将新建独立会话
        if (payload.kind === 'proma_event' && payload.event.type === 'automation_graduated') {
          toast('已接管自动任务会话，后续定时运行将创建新会话。', { duration: 3000 })
          window.electronAPI.listAgentSessions()
            .then((sessions) => store.set(agentSessionsAtom, (prev) => mergeFetchedAgentSessions(prev, sessions)))
            .catch(console.error)
        }


        // 如果收到未知会话的事件（跨工作区场景），立即刷新会话列表
        const knownSessions = store.get(agentSessionsAtom)
        if (!isCanvasAgent && !knownSessions.some((s) => s.id === sessionId)) {
          window.electronAPI.listAgentSessions()
            .then((sessions) => store.set(agentSessionsAtom, (prev) => mergeFetchedAgentSessions(prev, sessions)))
            .catch(console.error)
        }

        // Phase 2: 直接累积 SDKMessage 到 liveMessagesMapAtom（跳过 replay 消息，避免与持久化消息重复）
        if (payload.kind === 'sdk_delta') {
          const deltaPayload = payload.delta
          const currentRun = store.get(agentSessionStreamingStateAtomFamily(sessionId))
          // Delta 必须属于当前运行。新协议以 generation 为准，老协议才比较 startedAt。
          if (currentRun?.runGeneration != null && deltaPayload.runGeneration != null) {
            if (currentRun.runGeneration !== deltaPayload.runGeneration) return
          } else if (currentRun?.startedAt != null && deltaPayload.runStartedAt !== currentRun.startedAt) return
          const deltaRunStartedAt = deltaPayload.runStartedAt
          const sessionModelMap = store.get(agentSessionModelMapAtom)
          const defaultModelId = store.get(agentModelIdAtom)
          const modelId = deltaPayload._channelModelId ?? sessionModelMap.get(sessionId) ?? defaultModelId ?? undefined
          const sessionChannelMap = store.get(agentSessionChannelMapAtom)
          const defaultChannelId = store.get(agentChannelIdAtom)
          const channelId = sessionChannelMap.get(sessionId) ?? defaultChannelId ?? undefined
          const provider = store.get(channelsAtom).find((c) => c.id === channelId)?.provider
          store.set(liveMessagesMapAtom, (prev) => {
            const map = new Map(prev)
            const current = map.get(sessionId) ?? []
            const existingIndex = current.findIndex((message) => {
              const record = message as unknown as Record<string, unknown>
              if (record.uuid !== deltaPayload.uuid) return false
              return deltaRunStartedAt == null || record._promaLiveRunStartedAt === deltaRunStartedAt
            })
            const existing = existingIndex >= 0 && current[existingIndex]?.type === 'assistant'
              ? current[existingIndex] as SDKAssistantMessage
              : createAssistantDeltaPreview(deltaPayload, {
                ...(modelId ? { _channelModelId: modelId } : {}),
                ...(provider ? { _channelProvider: provider } : {}),
                ...(deltaRunStartedAt != null ? { _promaLiveRunStartedAt: deltaRunStartedAt } : {}),
              })
            const nextMessage = applyAssistantDeltasToPreview(existing, deltaPayload.deltas)
            // live-group-set 依赖 run 标记区分当前队列轮次；Delta 预览也必须携带它，
            // 否则 transcript 已有 assistant，但会被误判为非 live 并额外渲染 smooth fallback。
            const markedMessage = deltaRunStartedAt != null
              && (nextMessage as unknown as Record<string, unknown>)._promaLiveRunStartedAt !== deltaRunStartedAt
              ? { ...nextMessage, _promaLiveRunStartedAt: deltaRunStartedAt } as SDKAssistantMessage
              : nextMessage
            if (existingIndex >= 0) {
              const next = [...current]
              next[existingIndex] = markedMessage
              map.set(sessionId, next)
            } else {
              map.set(sessionId, [...current, markedMessage])
            }
            return map
          })

          // 文本/思考恢复后只收束一次 retry 或已完成的压缩状态；正常 token
          // 不会触碰 AgentStreamState，从而避免重新引入逐 token 的第二次 Map 更新。
          const hasAssistantActivity = deltaPayload.deltas.some((delta) => delta.type !== 'start')
          if (hasAssistantActivity) {
            store.set(agentSessionStreamingStateAtomFamily(sessionId), (current) => {
              const shouldResume = current?.retrying !== undefined
                || current?.contextCompaction?.status === 'success'
                || current?.contextCompaction?.status === 'noop'
              if (!current || !shouldResume) return current
              return resumeAgentStreamState(current)
            })
          }
        }

        if (payload.kind === 'sdk_message') {
          const msgRecord = payload.message as Record<string, unknown>
          // 仅在 Agent 发出变更工具调用时展示对应项目组件；右侧 Tab 严格归属产生变更的 session，
          // 同一 workspace 的其他活跃会话不得被后台变更抢走焦点。
          if (!msgRecord.isReplay) {
            const changedComponent = getChangedWorkspaceComponentFromSdkMessage(payload.message)
            if (changedComponent && shouldRevealChangedWorkspaceComponentImmediately(changedComponent)) {
              store.set(revealChangedWorkspaceComponentAtom, { sessionId, component: changedComponent })
            }
          }

          // prompt_suggestion 不是对话转录消息，不能进入 liveMessages（会被错误渲染到最后一条助手消息中）
          // 它通过下方 legacyEvents 分支写入 agentPromptSuggestionsAtom，显示在输入框上方
          if (msgRecord.type === 'prompt_suggestion') {
            // 跳过写入 liveMessages
          } else if (msgRecord.type === 'system' && msgRecord.subtype === 'thinking_tokens') {
            // thinking_tokens 是高频进度估算，只更新流式状态，不进入消息转录。
          } else if (!msgRecord.isReplay) {
            // 当前 run 的 assistant 消息沿用 run 起始时间，与首个 Delta 预览和乐观 header 保持一致。
            const activeRunStartedAt = store.get(agentSessionStreamingStateAtomFamily(sessionId))?.startedAt
            // 为实时消息补充 _createdAt 时间戳（与持久化时的逻辑一致），
            // 避免 AssistantTurnRenderer 因缺少时间戳导致 header 时间消失
            if (typeof msgRecord._createdAt !== 'number') {
              msgRecord._createdAt = msgRecord.type === 'assistant'
                ? (activeRunStartedAt ?? Date.now())
                : Date.now()
            }

            // 队列自动派发会在上一轮实时消息尚未落盘刷新时开始下一轮。
            // 标记每条实时消息所属 run，渲染层即可把上一轮立即视为完成并自动收起过程块。
            if (activeRunStartedAt != null) {
              msgRecord._promaLiveRunStartedAt = activeRunStartedAt
            }

            // 为 assistant 消息注入渠道信息，确保流式期间就绑定正确模型与 Agent SDK 窗口
            if (msgRecord.type === 'assistant' && !msgRecord._channelModelId) {
              const sessionModelMap = store.get(agentSessionModelMapAtom)
              const defaultModelId = store.get(agentModelIdAtom)
              msgRecord._channelModelId = sessionModelMap.get(sessionId) ?? defaultModelId ?? undefined
            }
            if (msgRecord.type === 'assistant' && !msgRecord._channelProvider) {
              const sessionChannelMap = store.get(agentSessionChannelMapAtom)
              const defaultChannelId = store.get(agentChannelIdAtom)
              const channelId = sessionChannelMap.get(sessionId) ?? defaultChannelId ?? undefined
              const channels = store.get(channelsAtom)
              const provider = channels.find((c) => c.id === channelId)?.provider
              if (provider) {
                msgRecord._channelProvider = provider as ProviderType
              }
            }

            store.set(liveMessagesMapAtom, (prev) => {
              const map = new Map(prev)
              const current = map.get(sessionId) ?? []

              // 队列用户消息仍可能与 SDK 推送同 UUID；Delta 预览先写入临时 assistant，
              // 终态 SDK message 到达后用同 UUID 替换并校正最终内容。
              const incomingUuid = msgRecord.uuid as string | undefined
              if (incomingUuid) {
                const existingIndex = current.findIndex((m) => (m as Record<string, unknown>).uuid === incomingUuid)
                if (existingIndex >= 0) {
                  const existing = current[existingIndex] as Record<string, unknown>
                  const incomingIsPartial = msgRecord._partial === true
                  const existingIsPartial = existing._partial === true

                  if (incomingIsPartial || existingIsPartial) {
                    const next = [...current]
                    next[existingIndex] = payload.message
                    map.set(sessionId, next)
                    return map
                  }

                  return prev
                }
              }

              map.set(sessionId, [...current, payload.message])
              return map
            })
          }
        }

        // Phase 1 兼容：将新 AgentStreamPayload 转换为旧 AgentEvent[]
        const legacyEvents = payloadToLegacyEvents(payload)

        for (const event of legacyEvents) {
          // 带 run 标识的 retry 事件必须在所有外围副作用前严格匹配当前流；
          // 否则旧 IPC 事件会复活已结束的 stream，或错误清掉新 run 的完成提醒。
          const eventStreamState = store.get(agentSessionStreamingStateAtomFamily(sessionId))
          if (isRunScopedRetryEvent(event) && event.runStartedAt != null && (
            !eventStreamState || !isRetryEventForCurrentStream(eventStreamState, event)
          )) {
            continue
          }

          canvasArtifactConsumer.handle(sessionId, event)

          // 会话首次进入 running 时，清除旧的完成提醒状态
          if (event.type !== 'prompt_suggestion') {
            const prevState = store.get(agentSessionStreamingStateAtomFamily(sessionId))
            if (!prevState || !prevState.running) {
              store.set(unviewedCompletedSessionIdsAtom, (prev: Set<string>) => {
                if (!prev.has(sessionId)) return prev
                const next = new Set(prev)
                next.delete(sessionId)
                return next
              })
            }
          }

          // 更新流式状态（prompt_suggestion 不影响流式状态，跳过以避免在 session 结束后用默认值 running:true 重新激活）
          if (event.type !== 'prompt_suggestion') {
            store.set(agentSessionStreamingStateAtomFamily(sessionId), (existing) => {
              // 再做一次 scope 校验，防止同一 batch 内其它回调更新流状态后旧事件落入。
              if (isRunScopedRetryEvent(event) && event.runStartedAt != null && (
                !existing || !isRetryEventForCurrentStream(existing, event)
              )) {
                return existing
              }
              const current: AgentStreamState = existing ?? {
                running: true,
                model: undefined,
                // 无 run 标识的历史事件才允许 fallback；带标识的 retry 必须已在上方匹配。
                startedAt: undefined,
              }
              return applyAgentEvent(current, event)
            })
          }

          const activeRunStartedAt = store.get(agentSessionStreamingStateAtomFamily(sessionId))?.startedAt
          if (activeRunStartedAt != null) {
            const activeRunId = String(activeRunStartedAt)
            store.set(agentFileChangesCurrentRunAtom, (prev) => {
              if (prev.get(sessionId) === activeRunId) return prev
              const map = new Map(prev)
              map.set(sessionId, activeRunId)
              return map
            })
          }

          // Pi 原生重试成功后仍会沿用同一会话；仅在事件属于当前 stream run 时
          // 清掉过期错误，避免迟到的旧 retry_cleared 掩盖新一轮真实失败。
          if (event.type === 'retry_cleared') {
            const current = store.get(agentSessionStreamingStateAtomFamily(sessionId))
            if (current && isRetryEventForCurrentStream(current, event)) {
              store.set(agentStreamErrorsAtom, (prev) => clearAgentStreamError(prev, sessionId))
            }
          }

          // Agent 写入完成后刷新 Git / 非 Git 改动数据，并保留未读改动提示。

          // Agent 修改文件时，记入「最近修改」状态，用于 60s 内左侧竖条标记
          if (event.type === 'tool_start' && WRITE_TOOLS.has(event.toolName)) {
            const input = event.input as Record<string, unknown> | undefined
            const targetPath =
              (input?.file_path as string | undefined)
              ?? (input?.path as string | undefined)
              ?? (input?.notebook_path as string | undefined)
            const runId = store.get(agentFileChangesCurrentRunAtom).get(sessionId)
              ?? String(store.get(agentSessionStreamingStateAtomFamily(sessionId))?.startedAt ?? event.turnId ?? Date.now())
            const entry = {
              path: targetPath || '',
              sessionId,
              toolName: event.toolName,
              runId,
            }
            pendingWriteTools.set(event.toolUseId, entry)
            if (typeof targetPath === 'string' && targetPath.length > 0) {
              void window.electronAPI.resolveAndReadFile(targetPath, { sessionId })
                .then((file) => {
                  const pending = pendingWriteTools.get(event.toolUseId)
                  if (pending) pending.existedBefore = file !== null
                })
                .catch(() => {
                  // 文件不存在和暂时无法读取都按未知处理，避免阻断写入反馈。
                })
            }
            if (typeof targetPath === 'string' && targetPath.length > 0) {
              const now = Date.now()
              // 记入「最近修改」状态，用于 60s 内左侧竖条标记
              store.set(recentlyModifiedPathsAtom, (prev) => {
                const map = new Map(prev)
                const inner = new Map(map.get(sessionId) ?? new Map())
                inner.set(targetPath, now)
                map.set(sessionId, inner)
                return map
              })
            }
          }

          // Bash 工具执行 git 突变命令时，标记为待刷新（完成后刷新 diff 列表）
          if (event.type === 'tool_start' && event.toolName === 'Bash') {
            const input = event.input as Record<string, unknown> | undefined
            const command = typeof input?.command === 'string' ? input.command : ''
            if (command && GIT_MUTATING_SUBCOMMANDS.test(command)) {
              pendingGitMutateTools.set(event.toolUseId, sessionId)
            }
          }

          if (event.type === 'tool_result') {
            // Agent 写类工具成功时刷新 Git diff；非 Git 目录记录为本会话文件变更。
            if (pendingWriteTools.has(event.toolUseId)) {
              const entry = pendingWriteTools.get(event.toolUseId)!
              const writtenPath = entry.path
              pendingWriteTools.delete(event.toolUseId)
              if (event.isError) continue
              // 相对路径的 cwd 由 Agent 决定，不能按 Electron cwd 错配到别的仓库；改为保守全量失效。
              const cacheInvalidationPath = writtenPath && isAbsolutePath(writtenPath) ? writtenPath : undefined
              void window.electronAPI.invalidateGitDiffCache(cacheInvalidationPath).finally(() => {
                store.set(agentDiffRefreshVersionAtom, (prev) => {
                  const m = new Map(prev); m.set(sessionId, (prev.get(sessionId) ?? 0) + 1); return m
                })
              })
              if (writtenPath) {
                buildWrittenFilePreviewInfo(sessionId, writtenPath).then((previewFile) => {
                  if (!previewFile) return

                  store.set(agentDiffUnseenChangesAtom, (prev) => {
                    const m = new Map(prev); m.set(sessionId, true); return m
                  })
                  store.set(agentDiffUnseenFilesAtom, (prev) => {
                    const m = new Map(prev)
                    const s = new Set(m.get(sessionId) ?? [])
                    s.add(writtenPath)
                    m.set(sessionId, s)
                    return m
                  })

                  if (previewFile.previewOnly) {
                    store.set(agentNonGitFileChangesAtom, (prev) => {
                      const m = new Map(prev)
                      const current = m.get(sessionId) ?? []
                      m.set(sessionId, upsertSessionFileChange(current, {
                        path: writtenPath,
                        kind: getSessionFileChangeKind(entry.toolName, entry.existedBefore),
                        runId: entry.runId,
                        updatedAt: Date.now(),
                      }, isWindows))
                      return m
                    })
                  }

                }).catch(() => { /* 改动提示不应影响流式输出 */ })
              }
            }
            // Bash git 突变命令完成时，仅刷新 diff 列表（不标记 unseen，避免红点）
            if (pendingGitMutateTools.has(event.toolUseId)) {
              pendingGitMutateTools.delete(event.toolUseId)
              void window.electronAPI.invalidateGitDiffCache().finally(() => {
                store.set(agentDiffRefreshVersionAtom, (prev) => {
                  const m = new Map(prev); m.set(sessionId, (prev.get(sessionId) ?? 0) + 1); return m
                })
              })
            }
          } else if (event.type === 'prompt_suggestion') {
            // 存储提示建议到 atom
            console.log(`[GlobalAgentListeners] 收到建议: sessionId=${sessionId}, suggestion="${event.suggestion.slice(0, 50)}..."`)
            store.set(agentPromptSuggestionsAtom, (prev) => {
              const map = new Map(prev)
              map.set(sessionId, event.suggestion)
              return map
            })
          } else if (event.type === 'permission_request') {
            // 权限请求入队（统一通道，不区分当前/后台会话）
            store.set(allPendingPermissionRequestsAtom, (prev) => {
              const map = new Map(prev)
              const current = map.get(sessionId) ?? []
              map.set(sessionId, [...current, event.request])
              return map
            })
            // 桌面通知（带提示音 + 会话导航）
            sendBlockingNotification(
              sessionId,
              '需要权限确认',
              event.request.toolName
                ? `Agent 请求使用工具: ${event.request.toolName}`
                : 'Agent 需要你的权限确认',
              'permissionRequest'
            )
          } else if (event.type === 'ask_user_request') {
            // AskUser 请求入队（统一通道，不区分当前/后台会话）
            store.set(allPendingAskUserRequestsAtom, (prev) => {
              const map = new Map(prev)
              const current = map.get(sessionId) ?? []
              map.set(sessionId, [...current, event.request])
              return map
            })
            // 桌面通知（带提示音 + 会话导航）
            sendBlockingNotification(
              sessionId,
              'Agent 需要你的输入',
              event.request.questions[0]?.question ?? 'Agent 有问题需要你回答',
              'permissionRequest'
            )
          } else if (event.type === 'ask_user_resolved') {
            // AskUser 可能由协作父会话代答，收到 resolved 后清理所有会话中的残留请求和草稿
            store.set(allPendingAskUserRequestsAtom, (prev) => {
              let changed = false
              const map = new Map(prev)
              prev.forEach((requests, pendingSessionId) => {
                const nextRequests = requests.filter((request) => request.requestId !== event.requestId)
                if (nextRequests.length !== requests.length) changed = true
                if (nextRequests.length === 0) map.delete(pendingSessionId)
                else map.set(pendingSessionId, nextRequests)
              })
              return changed ? map : prev
            })
            store.set(askUserDraftsAtom, (prev) => {
              if (!prev.has(event.requestId)) return prev
              const map = new Map(prev)
              map.delete(event.requestId)
              return map
            })
          } else if (event.type === 'exit_plan_mode_request') {
            // ExitPlanMode 请求入队
            store.set(allPendingExitPlanRequestsAtom, (prev) => {
              const map = new Map(prev)
              const current = map.get(sessionId) ?? []
              map.set(sessionId, [...current, event.request])
              return map
            })
            // 退出 Plan 模式指示状态
            store.set(agentPlanModeSessionsAtom, (prev: Set<string>) => {
              if (!prev.has(sessionId)) return prev
              const next = new Set(prev)
              next.delete(sessionId)
              return next
            })
            // 桌面通知（带提示音 + 会话导航）
            sendBlockingNotification(
              sessionId,
              'Agent 计划待审批',
              'Agent 已完成计划，等待你的审批',
              'exitPlanMode'
            )
          } else if (event.type === 'enter_plan_mode') {
            // 进入 Plan 模式
            store.set(agentPlanModeSessionsAtom, (prev: Set<string>) =>
              updatePlanModeSessionSet(prev, sessionId, true)
            )
          } else if (event.type === 'plan_mode_changed') {
            // 计划阶段变化只影响输入框/横幅状态，不改用户选择的权限模式
            store.set(agentPlanModeSessionsAtom, (prev: Set<string>) =>
              updatePlanModeSessionSet(prev, sessionId, event.active)
            )
          } else if (event.type === 'permission_mode_changed') {
            // 权限模式变更（如 Plan 模式退出后切换到完全自动）
            console.log(`[GlobalAgentListeners] 权限模式变更: ${event.mode}`)
            store.set(agentPermissionModeMapAtom, (prev: Map<string, import('@proma/shared').PromaPermissionMode>) => {
              const next = new Map(prev)
              next.set(sessionId, event.mode)
              return next
            })
            store.set(agentPlanModeSessionsAtom, (prev: Set<string>) =>
              updatePlanModeSessionSet(prev, sessionId, event.mode === 'plan')
            )
          } else if (event.type === 'run_resumed') {
            // 后台任务完成自动唤醒：从"空闲可输入"恢复到"运行中"。
            store.set(agentSessionStreamingStateAtomFamily(sessionId), (current) => {
              if (!current || current.running) return current
              return { ...current, running: true }
            })
          }
        }
        }) // unstable_batchedUpdates
    }
    /** 按权威 metadata 处理错误；Canvas 错误禁止触发普通消息刷新。 */
    const handleAgentError = (data: AgentStreamErrorPayload): void => {
      unstable_batchedUpdates(() => {
        console.error('[GlobalAgentListeners] 流式错误:', data.error)
        const route = resolveCanvasAgentCompletion(
          data.sessionId,
          data.session,
          store.get(canvasAgentInternalInvalidSessionIdsAtom).has(data.sessionId),
        )
        if (route.kind !== 'agent'
          && (data.startedAt == null
            || !isCanvasAgentGenerationCurrent(store, data.sessionId, data.startedAt))) return
        if (route.kind === 'internal-invalid') {
          store.set(canvasAgentLifecycleAtom, {
            type: 'invalidated', sessionId: data.sessionId, terminal: true, startedAt: data.startedAt,
          })
          return
        }
        if (route.kind === 'canvas') {
          store.set(canvasAgentLifecycleAtom, { type: 'owner-updated', owner: route.owner })
        }
        store.set(agentStreamErrorsAtom, (prev) => {
          const map = new Map(prev)
          map.set(data.sessionId, data.error)
          return map
        })
        if (route.kind === 'canvas') return
        const state = store.get(agentStreamingStatesAtom).get(data.sessionId)
        if (!state?.running) {
          store.set(agentMessageRefreshAtom, (prev) => {
            const map = new Map(prev)
            map.set(data.sessionId, (prev.get(data.sessionId) ?? 0) + 1)
            return map
          })
        }
      })
    }

    /** bootstrap gate 统一承载流式、标题、错误与完成事件，保证跨类型到达顺序。 */
    type CanvasBootstrapEvent =
      | { type: 'stream'; sessionId: string; value: AgentStreamEvent }
      | { type: 'title'; sessionId: string; value: { sessionId: string; title: string } }
      | { type: 'complete'; sessionId: string; value: AgentStreamCompletePayload }
      | { type: 'error'; sessionId: string; value: AgentStreamErrorPayload }

    /** 标题事件的真实处理器；Canvas 标题只更新 owner，不接触普通 tab 或会话列表。 */
    const handleTitleUpdated = ({ sessionId, title }: { sessionId: string; title: string }): void => {
      const canvasOwner = store.get(canvasAgentOwnersAtom).get(sessionId)
      if (canvasOwner) {
        store.set(canvasAgentLifecycleAtom, {
          type: 'owner-updated',
          owner: { ...canvasOwner, title },
        })
        return
      }
      // 先使用事件 payload 立即同步标签页，避免依赖会话列表旧快照比较。
      store.set(tabsAtom, (tabs) => updateTabTitle(tabs, sessionId, title))
      const existing = store.get(agentSessionsAtom).find((session) => session.id === sessionId)
      if (existing) {
        // 标题写入会更新 updatedAt；本地以当前时刻维持与后端一致的“最近会话”排序。
        store.set(agentSessionsAtom, (prev) => upsertAgentSession(prev, {
          ...existing,
          title,
          updatedAt: Date.now(),
        }))
        return
      }
      window.electronAPI
        .listAgentSessions()
        .then((sessions) => store.set(agentSessionsAtom, (prev) => mergeFetchedAgentSessions(prev, sessions)))
        .catch(console.error)
    }

    /** reload 期间用 snapshot + 事件重放建立线性化边界，普通 Agent 仍即时分发。 */
    const canvasAgentBootstrapCoordinator = createCanvasAgentBootstrapCoordinator<
      CanvasBootstrapEvent,
      Awaited<ReturnType<typeof window.electronAPI.listActiveCanvasAgentRuns>>
    >({
      loadSnapshot: () => window.electronAPI.listActiveCanvasAgentRuns(),
      applySnapshot: (snapshot) => store.set(canvasAgentLifecycleAtom, {
        type: 'bootstrap',
        owners: snapshot.owners,
        internalInvalidRuns: snapshot.internalInvalidRuns,
      }),
      classify: (event) => {
        const { sessionId } = event
        /** run_started/completion/error 携权威 metadata 时优先分类；缺失时等待 bootstrap。 */
        if (event.type === 'complete' || event.type === 'error') {
          const knownInvalid = store.get(canvasAgentInternalInvalidSessionIdsAtom).has(sessionId)
          if (event.value.session === undefined) return 'unknown'
          return resolveCanvasAgentCompletion(
            sessionId,
            event.value.session,
            knownInvalid,
          ).kind
        }
        if (event.type === 'stream'
          && event.value.payload.kind === 'proma_event'
          && event.value.payload.event.type === 'run_started'
          && event.value.payload.event.session !== undefined) {
          return resolveCanvasAgentCompletion(
            sessionId,
            event.value.payload.event.session,
            store.get(canvasAgentInternalInvalidSessionIdsAtom).has(sessionId),
          ).kind
        }
        if (store.get(canvasAgentOwnersAtom).has(sessionId)) return 'canvas'
        if (store.get(canvasAgentInternalInvalidSessionIdsAtom).has(sessionId)) return 'internal-invalid'
        if (store.get(agentSessionsAtom).some((session) => session.id === sessionId)) return 'agent'
        return 'unknown'
      },
      dispatch: (event) => {
        /** snapshot 为空时先用 run_started 的权威 metadata 建立 owner/generation。 */
        if (event.type === 'stream'
          && event.value.payload.kind === 'proma_event'
          && event.value.payload.event.type === 'run_started'
          && event.value.payload.event.session !== undefined) {
          const runStartedEvent = event.value.payload.event
          const route = resolveCanvasAgentCompletion(
            event.sessionId,
            runStartedEvent.session,
            store.get(canvasAgentInternalInvalidSessionIdsAtom).has(event.sessionId),
          )
          if (route.kind === 'canvas') store.set(canvasAgentLifecycleAtom, {
            type: 'started', owner: route.owner, startedAt: runStartedEvent.startedAt,
          })
          else if (route.kind === 'internal-invalid') store.set(canvasAgentLifecycleAtom, {
            type: 'invalid-started', sessionId: event.sessionId, startedAt: runStartedEvent.startedAt,
          })
        }
        if (event.type === 'stream') handleStreamEvent(event.value)
        else if (event.type === 'title') handleTitleUpdated(event.value)
        else if (event.type === 'complete') handleAgentComplete(event.value)
        else handleAgentError(event.value)
      },
      allowUnknownAfterReady: (event) => event.type !== 'complete' && event.type !== 'error',
      allowInternalInvalid: (event) => event.type === 'complete'
        || event.type === 'error'
        || (event.type === 'stream'
          && event.value.payload.kind === 'proma_event'
          && event.value.payload.event.type === 'run_started'),
      isStartEvent: (event) => event.type === 'stream'
        && event.value.payload.kind === 'proma_event'
        && event.value.payload.event.type === 'run_started',
      isTerminalEvent: (event) => event.type === 'complete' || event.type === 'error',
      getTerminalEventKey: (event) => `${event.type}:${event.sessionId}`,
      onError: (error) => {
        console.error('[GlobalAgentListeners] Canvas Agent 运行快照恢复失败:', error)
      },
    })
    // partial 仅保留每个会话在一帧内最新的累计全文，非 partial（尤其 final）立即处理。
    const streamEventBatcher = createAgentStreamEventBatcher({
      dispatch: (streamEvent) => canvasAgentBootstrapCoordinator.handle({
        type: 'stream', sessionId: streamEvent.sessionId, value: streamEvent,
      }),
    })
    const cleanupEvent = window.electronAPI.onAgentStreamEvent((streamEvent) => {
      streamEventBatcher.push(streamEvent)
    })

    // ===== 2. 流式完成 =====
    const handleAgentComplete = (data: AgentStreamCompletePayload): void => {
        unstable_batchedUpdates(() => {
        // 后台任务等待态：turn 主体结束但仍有后台任务在飞行，UI 进入"空闲可输入"。
        // 不发"任务已完成"通知（任务并未真正完成）、不清后台任务列表、不重载消息——
        // 等后台任务完成时 Agent 会自动唤醒续轮。
        const backgroundTasksPending = data.backgroundTasksPending === true
        if (!backgroundTasksPending && (data.runGeneration != null || data.startedAt != null)) {
          const terminalRun = { startedAt: data.startedAt, runGeneration: data.runGeneration }
          const previousTerminalRun = latestTerminalRun.get(data.sessionId)
          if (!previousTerminalRun || !isSameOrNewerRun(previousTerminalRun, terminalRun)) {
            latestTerminalRun.set(data.sessionId, terminalRun)
          }
        }
        const hasStreamError = store.get(agentStreamErrorsAtom).has(data.sessionId)

        /** completion 只信任 payload 的权威 metadata；缺失或损坏时 fail closed。 */
        const completionRoute = resolveCanvasAgentCompletion(
          data.sessionId,
          data.session,
          store.get(canvasAgentInternalInvalidSessionIdsAtom).has(data.sessionId),
        )
        if (completionRoute.kind !== 'agent') {
          /** 未知 bootstrap 代次或迟到 completion 均不得产生任何终态副作用。 */
          if (data.startedAt == null
            || !isCanvasAgentGenerationCurrent(store, data.sessionId, data.startedAt)) return
        }
        if (completionRoute.kind === 'internal-invalid') {
          store.set(canvasAgentLifecycleAtom, {
            type: 'invalidated',
            sessionId: data.sessionId,
            terminal: !backgroundTasksPending,
            ...(!backgroundTasksPending ? { startedAt: data.startedAt } : {}),
          })
        } else if (completionRoute.kind === 'canvas') {
          store.set(canvasAgentLifecycleAtom, { type: 'owner-updated', owner: completionRoute.owner })
        }
        const canvasOwner = completionRoute.kind === 'canvas' ? completionRoute.owner : undefined
        const isCanvasAgentCompletion = canvasOwner !== undefined
          || completionRoute.kind === 'internal-invalid'

        // 主进程随完成事件携带刚落盘的单条 meta；不要为此重新拉取整个会话索引。
        // 后台任务的轻量完成并未更新会话新鲜度，保留现有列表顺序。
        if (!isCanvasAgentCompletion && data.session && !backgroundTasksPending) {
          store.set(agentSessionsAtom, (prev) => upsertAgentSession(prev, data.session!))
        }

        // 发送桌面通知（仅真正成功完成时播放提示音，错误/中断/异常完成不伪装成完成）
        const completionSession = data.session ?? store.get(agentSessionsAtom)
          .find((session) => session.id === data.sessionId)
        const enabled = store.get(notificationsEnabledAtom)
        const soundEnabled = store.get(notificationSoundEnabledAtom)
        const sounds = store.get(notificationSoundsAtom)
        const sessionTitle = getSessionTitle(data.sessionId)
        if (canvasOwner) {
          const isSuccessfulCompletion = !data.stoppedByUser
            && !hasStreamError
            && (!data.resultSubtype || data.resultSubtype === 'success')
          if (!backgroundTasksPending && isSuccessfulCompletion) {
            sendDesktopNotification(
              'Canvas Agent 任务完成',
              `[${canvasOwner.title}] 任务已完成`,
              enabled,
              {
                playSound: enabled && soundEnabled,
                soundType: 'taskComplete',
                sounds,
                onNavigate: makeNavigateToCanvasAgent(canvasOwner),
              },
            )
          }
        } else if (!isCanvasAgentCompletion) notifyAgentCompletion({
          completion: data,
          session: completionSession,
          hasStreamError,
          notify: () => {
            sendDesktopNotification(
              'Agent 任务完成',
              `[${sessionTitle}] 任务已完成`,
              enabled,
              {
                playSound: enabled && soundEnabled,
                soundType: 'taskComplete',
                sounds,
                onNavigate: makeNavigateToSession(data.sessionId, sessionTitle),
              }
            )
          },
        })

        // STREAM_COMPLETE 表示后端已完全结束 — 立即标记 running: false
        // 同时将所有未完成的工具活动标记为已完成，防止 subagent spinner 继续转动
        // （complete 事件只清除 retrying，保持 running: true 以防竞态）
        // 竞态保护：通过 startedAt 区分新旧流，防止旧流的 complete 事件重置新流的 running 状态
        store.set(agentStreamingStatesAtom, (prev) => {
          const current = prev.get(data.sessionId)
          // 既非运行中、也非软空闲态 → 已彻底结束，忽略重复/陈旧的完成事件。
          // 软空闲态（running=false 但 backgroundWaiting=true）也要处理：空闲超时/用户停止
          // 触发的真正完成会带 backgroundTasksPending=false，需借此清除 backgroundWaiting。
          if (!current || (!current.running && !current.backgroundWaiting)) {
            return prev
          }
          if (!isTerminalEventForCurrentRun(current, data)) return prev
          const map = new Map(prev)
          map.set(data.sessionId, {
            ...current,
            running: false,
            // backgroundTasksPending=true → 进入/保持软空闲态（通道仍开着，handleSend 走注入路径）；
            // false → 真正结束，清除软空闲态，新消息回到新建 run 路径。
            backgroundWaiting: backgroundTasksPending,
          })
          return map
        })

        // 只有未激活会话才进入"未查看完成"，避免当前页面完成时出现额外未读提醒。
        const currentSessionId = store.get(currentAgentSessionIdAtom)
        const completionMarkers = getAgentCompletionMarkers({
          tabs: store.get(tabsAtom),
          activeTabId: store.get(activeTabIdAtom),
          currentAgentSessionId: currentSessionId,
          sessionId: data.sessionId,
          session: completionSession,
          documentHasFocus: document.hasFocus(),
        })
        if (!isCanvasAgentCompletion && completionMarkers.markUnviewedCompleted && !backgroundTasksPending) {
          store.set(unviewedCompletedSessionIdsAtom, (prev: Set<string>) => {
            const next = new Set(prev)
            next.add(data.sessionId)
            return next
          })
        } else if (!isCanvasAgentCompletion && !backgroundTasksPending) {
          // 当前聚焦会话已在主应用可见；同步确认，避免灵动岛把这次完成继续当未读。
          void window.electronAPI.agentIsland.markSessionViewed(data.sessionId).catch(console.error)
        }

        // 对齐本次会话的主动打断状态，无需借助全量列表刷新重建整个 Set。
        if (!isCanvasAgentCompletion) store.set(stoppedByUserSessionsAtom, (prev: Set<string>) => {
          const wasStopped = prev.has(data.sessionId)
          if (data.stoppedByUser === true && !wasStopped) {
            const next = new Set(prev)
            next.add(data.sessionId)
            return next
          }
          if (data.stoppedByUser !== true && wasStopped) {
            const next = new Set(prev)
            next.delete(data.sessionId)
            return next
          }
          return prev
        })

        notifyAgentCompletionWarning(completionRoute.kind, data, (message) => {
          toast.warning(message, { duration: 8000 })
        })

        // 清除 Plan 模式状态（防止异常退出时残留）
        if (!isCanvasAgentCompletion) store.set(agentPlanModeSessionsAtom, (prev: Set<string>) => {
          if (!prev.has(data.sessionId)) return prev
          const next = new Set(prev)
          next.delete(data.sessionId)
          return next
        })

        /** Canvas 终态按面板打开态回收 owner/messages；live 消息仍留给已打开面板。 */
        if (isCanvasAgentCompletion) {
          if (canvasOwner && !backgroundTasksPending) {
            store.set(canvasAgentLifecycleAtom, {
              type: 'completed', sessionId: data.sessionId, startedAt: data.startedAt!,
            })
            /** 打开面板先以权威 JSONL 接管最终消息，再释放 live/error/stream。 */
            if (store.get(canvasAgentOpenSessionIdsAtom).has(data.sessionId)) {
              void designAdapter.getCanvasAgentMessages({
                projectId: canvasOwner.projectId,
                canvasId: canvasOwner.canvasId,
                nodeId: canvasOwner.nodeId,
              }).then((result) => {
                if (!isCanvasAgentHandoffGenerationCurrent(store, data.sessionId, data.startedAt!)) return
                if (!store.get(canvasAgentOpenSessionIdsAtom).has(data.sessionId)) return
                if (store.get(canvasAgentRunningSessionIdsAtom).has(data.sessionId)) return
                store.set(canvasAgentLifecycleAtom, {
                  type: 'opened',
                  owner: { sessionId: result.sessionId, ...result.owner },
                  messages: result.messages,
                })
                store.set(canvasAgentLifecycleAtom, {
                  type: 'settled', sessionId: data.sessionId, startedAt: data.startedAt!,
                })
              }).catch((error: unknown) => {
                console.error('[GlobalAgentListeners] Canvas Agent 最终消息交接失败:', error)
              })
            }
          }
          return
        }

        /** 竞态保护：检查该会话是否已有新的流式请求正在运行 */
        const isNewStreamRunning = (): boolean => {
          const state = store.get(agentStreamingStatesAtom).get(data.sessionId)
          return state?.running === true
        }

        /** 递增消息刷新版本号，通知 AgentView 重新加载消息 */
        const bumpRefresh = (): void => {
          store.set(agentMessageRefreshAtom, (prev) => {
            const map = new Map(prev)
            map.set(data.sessionId, (prev.get(data.sessionId) ?? 0) + 1)
            return map
          })
        }

        const finalize = (): void => {
          // 竞态保护：新流已启动时不要清理状态
          if (isNewStreamRunning()) return

          // 后台任务等待态由运行时状态控制；任务完成会自动唤醒续轮。
          if (backgroundTasksPending) return

          // 后台会话没有挂载的 AgentView 来执行收尾清理（MainArea 只渲染活动 Tab）。
          // 若不在此处回收，liveMessagesMap 与流式状态索引会随运行时长单调增长，
          // 让每个 delta 的 Map 复制与聚合读取越来越慢（表现为“同样 1 个 Agent 越跑越卡”）。
          // 可见会话仍由 AgentView 在消息加载完成后清理，以保留防闪烁语义。
          if (store.get(activeSessionIdAtom) !== data.sessionId) {
            store.set(liveMessagesMapAtom, (prev) => {
              if (!prev.has(data.sessionId)) return prev
              const map = new Map(prev)
              map.delete(data.sessionId)
              return map
            })
            store.set(agentSessionStreamingStateAtomFamily(data.sessionId), (state) => {
              if (!state || state.running || state.backgroundWaiting) return state
              // 上下文用量圆环需要 usage；其余运行态随本轮结束回收。
              if (state.inputTokens !== undefined) {
                return {
                  running: false,
                  inputTokens: state.inputTokens,
                  outputTokens: state.outputTokens,
                  cacheReadTokens: state.cacheReadTokens,
                  cacheCreationTokens: state.cacheCreationTokens,
                  contextWindow: state.contextWindow,
                  contextUsageIsEstimated: state.contextUsageIsEstimated,
                  model: state.model,
                  contextCompaction: state.contextCompaction,
                }
              }
              if (state.contextCompaction) {
                return { running: false, contextCompaction: state.contextCompaction }
              }
              // 无需保留的会话彼底移出索引，避免聚合视图无限遍历。
              return undefined
            })
          }

          // 清理该 session 关联的未完成写工具记录，防止内存泄漏
          for (const [toolId, entry] of pendingWriteTools) {
            if (entry.sessionId === data.sessionId) {
              pendingWriteTools.delete(toolId)
            }
          }
          for (const [toolId, sid] of pendingGitMutateTools) {
            if (sid === data.sessionId) {
              pendingGitMutateTools.delete(toolId)
            }
          }

          // 注意：liveMessages 的清理已移至 AgentView 消息加载完成后执行，
          // 与 streamingState 清理同步，避免「实时消息已清 → 持久化消息未到」的空档闪烁

          // 完成事件已携带当前会话 meta，顶部已增量更新列表；全量会话同步仅保留给启动、
          // 窗口重新聚焦和未知会话等恢复路径，避免完成一个 Agent 就传输整个会话索引。

          // 注意：流式状态的完全清除由 AgentView 在消息加载完成后执行，
          // 确保不会出现「气泡消失 → 持久化消息尚未加载」的空档闪烁
        }

        // 通知 AgentView 重新加载消息（无论是否为当前会话）
        if (!isNewStreamRunning()) {
          bumpRefresh()
        }
        finalize()
        }) // unstable_batchedUpdates
    }
    const cleanupComplete = window.electronAPI.onAgentStreamComplete(
      (data: AgentStreamCompletePayload) => {
        // 无终态 assistant 的异常路径也不能让等待中的 partial 在完成后倒灌。
        streamEventBatcher.clear(data.sessionId)
        canvasAgentBootstrapCoordinator.handle({
          type: 'complete', sessionId: data.sessionId, value: data,
        })
      },
    )

    // ===== 3. 流式错误 =====
    const cleanupError = window.electronAPI.onAgentStreamError(
      (data: AgentStreamErrorPayload) => {
        canvasAgentBootstrapCoordinator.handle({
          type: 'error', sessionId: data.sessionId, value: data,
        })
      }
    )

    // ===== 4. 独立规划窗口 → 主窗口 Todo Agent 接力 =====
    const cleanupTodoAgentSessionReady = window.electronAPI.onTodoAgentSessionReady(({ todo, session }) => {
      unstable_batchedUpdates(() => {
        store.set(agentSessionsAtom, (prev) => upsertAgentSession(prev, session))
        const result = openTab(store.get(tabsAtom), { type: 'agent', sessionId: session.id, title: session.title })
        store.set(tabsAtom, result.tabs)
        store.set(activeTabIdAtom, result.activeTabId)
        store.set(appModeAtom, 'agent')
        store.set(currentAgentSessionIdAtom, session.id)
        if (session.workspaceId) {
          store.set(currentAgentWorkspaceIdAtom, session.workspaceId)
          void window.electronAPI.updateSettings({ agentWorkspaceId: session.workspaceId }).catch(console.error)
        }
        store.set(agentPendingPromptAtom, {
          sessionId: session.id,
          message: buildTodoAgentPrompt(todo.id, true),
          mentionedTodoIds: [todo.id],
        })
      })
    })

    // ===== 5. 标题更新 =====
    const cleanupTitleUpdated = window.electronAPI.onAgentTitleUpdated((value) => {
      canvasAgentBootstrapCoordinator.handle({ type: 'title', sessionId: value.sessionId, value })
    })

    const cleanupActiveWorktreeUpdated = window.electronAPI.onAgentActiveWorktreeUpdated((session) => {
      store.set(agentSessionsAtom, (previous) => upsertAgentSession(previous, session))
      store.set(agentSelectedWorktreeAtom, (previous) => {
        const next = new Map(previous)
        if (session.activeWorktree?.path) next.set(session.id, session.activeWorktree.path)
        else next.delete(session.id)
        return next
      })
    })

    // ===== 5. Windows Agent Island 提示音委托 =====
    const cleanupPlaySound = window.electronAPI.onWindowsAgentIslandPlaySound(({ type }) => {
      const sounds = store.get(notificationSoundsAtom)
      void playNotificationSoundForType(type, sounds)
    })

    // 定期清理 60s 前的「最近修改」标记，避免 atom 无限增长
    const pruneTimer = setInterval(() => {
      const cutoff = Date.now() - RECENTLY_MODIFIED_TTL_MS
      store.set(recentlyModifiedPathsAtom, (prev) => {
        let changed = false
        const next = new Map<string, Map<string, number>>()
        for (const [sid, inner] of prev) {
          const filtered = new Map<string, number>()
          for (const [p, t] of inner) {
            if (t > cutoff) filtered.set(p, t)
            else changed = true
          }
          if (filtered.size > 0) next.set(sid, filtered)
          else changed = true
        }
        return changed ? next : prev
      })
    }, 15_000)

    // 窗口重新聚焦时检测当前预览文件是否有外部修改，有变化才刷新
    /** sessionId:filePath → 内容 hash（用于检测外部编辑器修改） */
    const fileContentHashMap = new Map<string, string>()
    const HASH_MAX = 100
    let focusCheckSeq = 0
    const bumpDiffRefresh = (sessionId: string) => {
      void window.electronAPI.invalidateGitDiffCache().finally(() => {
        store.set(agentDiffRefreshVersionAtom, (prev) => {
          const m = new Map(prev)
          m.set(sessionId, (prev.get(sessionId) ?? 0) + 1)
          return m
        })
      })
    }

    const onWindowFocus = async () => {
      const activeSessionId = store.get(currentAgentSessionIdAtom)
      if (!activeSessionId) return

      const previewFile = store.get(previewFileMapAtom).get(activeSessionId)
      if (!previewFile || previewFile.previewOnly !== true) {
        bumpDiffRefresh(activeSessionId)
        return
      }

      const candidateBasePaths = uniqueTruthyPaths([
        ...(previewFile.basePaths ?? []),
        previewFile.dirPath,
        previewFile.gitRoot,
        getParentDir(previewFile.filePath),
        store.get(agentSessionPathMapAtom).get(activeSessionId),
      ])
      const hashKey = `${activeSessionId}:${previewFile.filePath}:${candidateBasePaths.join('\u001f')}`
      const seq = ++focusCheckSeq

      try {
        const result = await window.electronAPI.resolveAndReadFile(previewFile.filePath, {
          sessionId: activeSessionId,
          candidateBasePaths: candidateBasePaths.length > 0 ? candidateBasePaths : undefined,
        })

        // 丢弃过期结果（快速切换窗口时）
        if (seq !== focusCheckSeq) return

        const content = result?.content ?? ''
        // cyrb53 hash：遍历完整内容，避免边缘碰撞
        const hash = cyrb53(content)
        const prevHash = fileContentHashMap.get(hashKey)

        if (prevHash === undefined || prevHash !== hash) {
          // 首次建立 hash 基准时也刷新一次，避免用户离开窗口后首次外部修改被吞掉。
          bumpDiffRefresh(activeSessionId)
          bumpPreviewContentRefresh(activeSessionId, previewFile)
        }
        fileContentHashMap.set(hashKey, hash)

        // LRU 淘汰：限制 Map 大小
        if (fileContentHashMap.size > HASH_MAX) {
          const oldestKey = fileContentHashMap.keys().next().value
          if (oldestKey !== undefined) fileContentHashMap.delete(oldestKey)
        }
      } catch {
        // 读取失败时删除旧 hash，并触发一次刷新让预览进入真实失败/空状态。
        fileContentHashMap.delete(hashKey)
        bumpDiffRefresh(activeSessionId)
        bumpPreviewContentRefresh(activeSessionId, previewFile)
      }
    }
    window.addEventListener('focus', onWindowFocus)

    const syncVisibleAgentStreamSession = (): void => {
      const sessionId = store.get(activeSessionIdAtom)
      const activeTab = store.get(tabsAtom).find((tab) => tab.id === store.get(activeTabIdAtom))
      const visibleAgentSessionId = activeTab?.type === 'agent' || activeTab?.type === 'preview'
        ? sessionId
        : null
      // 开发时 renderer HMR 可能先于 preload/main 重启；缺少新 IPC 不应让整个应用白屏。
      const setVisibleAgentStreamSession = window.electronAPI.setVisibleAgentStreamSession
      if (setVisibleAgentStreamSession) {
        void setVisibleAgentStreamSession(visibleAgentSessionId).catch(console.error)
      }
    }
    syncVisibleAgentStreamSession()
    const unsubscribeVisibleSession = store.sub(activeSessionIdAtom, syncVisibleAgentStreamSession)
    /** 所有 lifecycle listener 注册完成后再发起 snapshot，消除订阅建立前的事件窗口。 */
    void canvasAgentBootstrapCoordinator.start()

    return () => {
      canvasAgentBootstrapCoordinator.dispose()
      cleanupEvent()
      streamEventBatcher.dispose()
      unsubscribeVisibleSession()
      cleanupComplete()
      cleanupError()
      cleanupTodoAgentSessionReady()
      cleanupTitleUpdated()
      cleanupActiveWorktreeUpdated()
      cleanupPlaySound()
      cleanupWatchedFileChanges()
      cleanupQueuedMessageStatus()
      canvasActivityConsumer.dispose()
      canvasArtifactConsumer.dispose()
      clearInterval(pruneTimer)
      window.removeEventListener('focus', onWindowFocus)
    }
  }, [store]) // store 引用稳定，effect 只执行一次
}
