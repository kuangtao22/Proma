import type { AgentSessionMeta, SDKMessage, SDKUserMessage } from '@proma/shared'
import type { AgentStreamState } from '@/atoms/agent-atoms'
import type { TabItem } from '@/atoms/tab-atoms'

/** 顶部入口与 TabItem 保持同一类型契约，避免已删除的入口类型回流。 */
export type ExternalAgentRunTab = TabItem

export interface ExternalAgentRunActivationInput {
  tabs: ExternalAgentRunTab[]
  sessions: AgentSessionMeta[]
  sessionId: string
  title?: string
  workspaceId?: string
  modelId?: string
  startedAt: number
  runGeneration?: number
  currentStreamState?: AgentStreamState
}

export interface ExternalAgentRunActivation {
  tabs: ExternalAgentRunTab[]
  activeTabId: string
  title: string
  workspaceId?: string
  modelId?: string
  streamState: AgentStreamState
}

/** 已持久化外部消息的实时展示字段，兼容旧版缺少正文或 UUID 的事件。 */
interface ExternalAgentRunMessageInput {
  /** 原始用户正文，不含模型专用平台标记。 */
  userMessage?: string
  /** 主进程签发并持久化的消息 UUID。 */
  userMessageUuid?: string
  /** 当前运行的权威开始时间。 */
  startedAt: number
}

/** 实时消息在基础 SDK 形状之外携带时间，以复用当前轮分组逻辑。 */
interface ExternalAgentRunUserMessage extends SDKUserMessage {
  /** 展示排序时间，与启动事件一致。 */
  _createdAt: number
  /** 当前轮标记，避免用户输入被分到上一轮。 */
  _promaLiveRunStartedAt: number
}

/** 追加已持久化的外部输入；旧事件或重复 UUID 返回原数组，避免额外渲染。 */
export function appendExternalAgentRunUserMessage(
  messages: SDKMessage[],
  input: ExternalAgentRunMessageInput,
): SDKMessage[] {
  if (input.userMessage === undefined || !input.userMessageUuid) return messages
  if (messages.some((message) => 'uuid' in message && message.uuid === input.userMessageUuid)) return messages
  /** 展示副本复用持久化身份，不再生成消息 ID。 */
  const userMessage: ExternalAgentRunUserMessage = {
    type: 'user',
    uuid: input.userMessageUuid,
    message: { content: [{ type: 'text', text: input.userMessage }] },
    parent_tool_use_id: null,
    _createdAt: input.startedAt,
    _promaLiveRunStartedAt: input.startedAt,
  }
  return [...messages, userMessage]
}

/** 迟到的启动事件不得复活已结束运行，或覆盖同一会话的更新运行。 */
export function shouldActivateExternalAgentRun(
  currentStreamState: AgentStreamState | undefined,
  startedAt: number,
  runGeneration?: number,
): boolean {
  if (!currentStreamState || currentStreamState.startedAt == null) return true
  if (currentStreamState.runGeneration != null && runGeneration != null) {
    if (currentStreamState.runGeneration > runGeneration) return false
    if (currentStreamState.runGeneration === runGeneration) {
      return currentStreamState.running && !currentStreamState.backgroundWaiting
    }
    return true
  }
  if (currentStreamState.startedAt > startedAt) return false
  if (currentStreamState.startedAt === startedAt) {
    return currentStreamState.running && !currentStreamState.backgroundWaiting
  }
  return true
}

/**
 * 自动派生的协作子会话只能在其父会话正处于用户前台视图时展开。
 * 后台父会话的事件仍会更新运行状态和侧栏树，但绝不能改变用户当前焦点。
 */
export function shouldRevealDelegatedSession(
  parentSessionId: string,
  activeSessionId: string | null,
): boolean {
  return parentSessionId === activeSessionId
}

export function buildExternalAgentRunActivation(
  input: ExternalAgentRunActivationInput,
): ExternalAgentRunActivation {
  const session = input.sessions.find((item) => item.id === input.sessionId)
  const title = input.title ?? session?.title ?? '新 Agent 会话'
  const tabsWithoutPreview = input.tabs.filter((tab) => tab.type !== 'preview')
  const existingTab = tabsWithoutPreview.find((tab) => tab.type === 'agent' && tab.sessionId === input.sessionId)
  const tabs = existingTab
    ? (tabsWithoutPreview.length === input.tabs.length ? input.tabs : tabsWithoutPreview)
    : [...tabsWithoutPreview, { id: input.sessionId, type: 'agent' as const, sessionId: input.sessionId, title }]
  const activeTabId = existingTab?.id ?? input.sessionId

  return {
    tabs,
    activeTabId,
    title,
    workspaceId: session?.workspaceId ?? input.workspaceId,
    modelId: input.modelId,
    streamState: {
      ...input.currentStreamState,
      running: true,
      model: input.modelId ?? input.currentStreamState?.model,
      startedAt: input.startedAt,
      ...(input.runGeneration != null ? { runGeneration: input.runGeneration } : {}),
    },
  }
}
