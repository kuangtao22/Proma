import type { WebContents } from 'electron'
import type {
  AgentSendInput,
  ChatSendInput,
  LanBridgeAgentSessionDto,
  LanBridgeAgentSessionRuntimeStatus,
  LanBridgeConversationDto,
} from '@proma/shared'

/** LAN Bridge 对外暴露的稳定工作区摘要。 */
export interface LanBridgeWorkspaceDto {
  id: string
  name: string
  slug: string
  createdAt: number
}

/** LAN Bridge 对外暴露的统一搜索结果。 */
export interface LanBridgeSearchResultDto {
  id: string
  title: string
  snippet: string
  type: 'chat' | 'agent'
  matchedAt: number
}

/** LAN Bridge 发送 Agent 时使用的最小设置。 */
export interface LanBridgeSettingsDto {
  agentChannelId?: string
  agentModelId?: string
  agentWorkspaceId?: string
}

/** LAN Bridge 对外暴露的稳定渠道摘要。 */
export interface LanBridgeChannelDto {
  id: string
  name: string
  provider: string
  enabled: boolean
}

/** LAN Bridge 模型选择所需的稳定模型字段。 */
export interface LanBridgeChannelModelDto {
  id: string
  name: string
  enabled: boolean
  source?: 'manual' | 'fetched'
}

/** LAN Bridge 移动端模型选择所需的渠道详情，不包含凭据和供应商内部配置。 */
export interface LanBridgeChannelOptionDto {
  id: string
  name: string
  provider: string
  baseUrl: string
  models: LanBridgeChannelModelDto[]
}

/** LAN Bridge Agent 发送命令。 */
export interface LanBridgeAgentSendCommand {
  sessionId: string
  userMessage: string
  workspaceId?: string
  modelId?: string
  permissionMode?: 'auto' | 'bypassPermissions' | 'plan'
}

/** LAN Bridge 普通对话发送命令。 */
export interface LanBridgeConversationSendCommand {
  conversationId: string
  userMessage: string
  channelId?: string
  modelId?: string
}

/** LAN Bridge 正文或思考增量载荷。 */
export interface LanBridgeStreamTextPayload {
  text: string
}

/** LAN Bridge 流式错误载荷。 */
export interface LanBridgeStreamErrorPayload {
  error: string
}

/** LAN Bridge 标题更新载荷。 */
export interface LanBridgeTitleUpdatedPayload {
  title: string
}

/** Adapter 向 handlers 暴露的稳定流式回调。 */
export interface LanBridgeStreamCallbacks {
  onText?: (payload: LanBridgeStreamTextPayload) => void
  onReasoning?: (payload: LanBridgeStreamTextPayload) => void
  onError?: (payload: LanBridgeStreamErrorPayload) => void
  onComplete?: () => void
  onTitleUpdated?: (payload: LanBridgeTitleUpdatedPayload) => void
}

/** 官方对话对象的最小可读形状。 */
interface UpstreamConversation {
  id: string
  title: string
  pinned?: boolean
  archived?: boolean
  createdAt: number
  updatedAt: number
}

/** 官方 Agent 会话对象的最小可读形状。 */
interface UpstreamAgentSession extends UpstreamConversation {
  workspaceId?: string
  manualWorking?: boolean
  starred?: boolean
}

/** 官方工作区对象的最小可读形状。 */
interface UpstreamWorkspace {
  id: string
  name: string
  slug: string
  createdAt: number
}

/** 官方 Chat 搜索结果的最小可读形状。 */
interface UpstreamConversationSearchResult {
  conversationId: string
  conversationTitle?: string
  snippet: string
}

/** 官方 Agent 搜索结果的最小可读形状。 */
interface UpstreamAgentSearchResult {
  sessionId: string
  sessionTitle?: string
  snippet: string
}

/** 官方设置对象的最小可读形状。 */
interface UpstreamSettings extends LanBridgeSettingsDto {}

/** 官方渠道模型对象的最小可读形状。 */
interface UpstreamChannelModel {
  id: string
  name: string
  enabled: boolean
  source?: 'manual' | 'fetched'
}

/** 官方渠道对象的最小可读形状。 */
interface UpstreamChannel {
  id: string
  name: string
  provider: string
  enabled: boolean
  baseUrl: string
  models: UpstreamChannelModel[]
}

/** 官方 Agent 执行回调的最小签名。 */
interface UpstreamAgentCallbacks {
  onError: (error: string) => void
  onComplete: (messages?: unknown[]) => void
  onTitleUpdated: (title: string) => void
}

/** 官方 Chat 流事件的最小联合类型。 */
type UpstreamChatStreamEvent =
  | { type: 'chunk'; conversationId: string; delta?: string }
  | { type: 'reasoning'; conversationId: string; delta?: string }
  | { type: 'tool_activity'; conversationId: string; activity: unknown }
  | { type: 'error'; conversationId: string; error: string }
  | { type: 'complete'; conversationId: string; model: string; messageId?: string }

/** 可注入的官方依赖集合，使字段映射可以脱离真实文件和 Electron 窗口测试。 */
export interface LanBridgePromaDependencies {
  listConversations: () => UpstreamConversation[]
  getConversationMessages: (conversationId: string) => ChatSendInput['messageHistory']
  searchConversationMessages: (query: string) => Promise<UpstreamConversationSearchResult[]>
  listAgentSessions: () => UpstreamAgentSession[]
  getAgentSessionMessages: (sessionId: string) => unknown[]
  searchAgentSessionMessages: (query: string) => Promise<UpstreamAgentSearchResult[]>
  listAgentWorkspaces: () => UpstreamWorkspace[]
  createAgentSession: (title?: string, channelId?: string, workspaceId?: string) => UpstreamAgentSession
  isAgentSessionActive: (sessionId: string) => boolean
  getAgentSessionRuntimeStatus: (sessionId: string) => LanBridgeAgentSessionRuntimeStatus
  updateAgentSessionStarred: (sessionId: string) => UpstreamAgentSession
  markAgentSessionViewed: (sessionId: string) => boolean
  runAgentHeadless: (input: AgentSendInput, callbacks: UpstreamAgentCallbacks) => Promise<void>
  stopAgent: (sessionId: string) => void
  getSettings: () => UpstreamSettings
  listChannels: () => UpstreamChannel[]
  sendConversationMessage: (
    input: ChatSendInput,
    webContents: WebContents | null,
    onEvent?: (event: UpstreamChatStreamEvent) => void,
  ) => Promise<void>
  stopConversation: (conversationId: string) => void
  getPrimaryWebContents: () => WebContents | null
  notifyAgentTitleUpdated: (session: LanBridgeAgentSessionDto) => void
}

/** LAN Bridge handlers 使用的 Proma 稳定能力集合。 */
export interface LanBridgePromaAdapter {
  listConversations: () => LanBridgeConversationDto[]
  hasConversation: (conversationId: string) => boolean
  getConversationMessages: (conversationId: string) => ChatSendInput['messageHistory']
  searchConversations: (query: string, matchedAt?: number) => Promise<LanBridgeSearchResultDto[]>
  listAgentSessions: () => LanBridgeAgentSessionDto[]
  hasAgentSession: (sessionId: string) => boolean
  getAgentMessages: (sessionId: string) => unknown[]
  searchAgentSessions: (query: string, matchedAt?: number) => Promise<LanBridgeSearchResultDto[]>
  listWorkspaces: () => LanBridgeWorkspaceDto[]
  createAgentSession: (title?: string, workspaceId?: string) => LanBridgeAgentSessionDto
  isAgentSessionActive: (sessionId: string) => boolean
  getAgentSessionRuntimeStatus: (sessionId: string) => LanBridgeAgentSessionRuntimeStatus
  toggleAgentSessionStar: (sessionId: string) => LanBridgeAgentSessionDto
  markAgentSessionViewed: (sessionId: string) => {
    changed: boolean
    runtimeStatus: LanBridgeAgentSessionRuntimeStatus
  }
  sendAgent: (command: LanBridgeAgentSendCommand, callbacks: LanBridgeStreamCallbacks) => Promise<void>
  stopAgent: (sessionId: string) => void
  sendConversation: (command: LanBridgeConversationSendCommand, callbacks: LanBridgeStreamCallbacks) => Promise<void>
  stopConversation: (conversationId: string) => void
  getSettings: () => LanBridgeSettingsDto
  listChannels: () => LanBridgeChannelDto[]
  getChannelBaseUrl: (channelId: string) => string | null
  listEnabledChannelOptions: () => LanBridgeChannelOptionDto[]
}

/** 判断外部会话 ID 是否为不改变路径层级的单段标识。 */
export function isValidLanBridgeSessionId(sessionId: unknown): sessionId is string {
  return typeof sessionId === 'string'
    && sessionId.length > 0
    && sessionId.length <= 256
    && sessionId !== '.'
    && sessionId !== '..'
    && !sessionId.includes('/')
    && !sessionId.includes('\\')
    && !sessionId.includes('\0')
}

/** 在进入官方文件或运行时能力前验证 ID 格式与实体存在性。 */
function assertExistingAgentSession(dependencies: LanBridgePromaDependencies, sessionId: string): void {
  if (!isValidLanBridgeSessionId(sessionId)) {
    throw Object.assign(new Error('无效的会话 ID'), { errorCode: 'VALIDATION_ERROR' })
  }
  if (!dependencies.listAgentSessions().some(session => session.id === sessionId)) {
    throw Object.assign(new Error('会话不存在'), { errorCode: 'NOT_FOUND' })
  }
}

/** 在进入官方对话文件或发送能力前验证 ID 格式与实体存在性。 */
function assertExistingConversation(dependencies: LanBridgePromaDependencies, conversationId: string): void {
  if (!isValidLanBridgeSessionId(conversationId)) {
    throw Object.assign(new Error('无效的会话 ID'), { errorCode: 'VALIDATION_ERROR' })
  }
  if (!dependencies.listConversations().some(conversation => conversation.id === conversationId)) {
    throw Object.assign(new Error('会话不存在'), { errorCode: 'NOT_FOUND' })
  }
}

/** 将官方对话对象映射为 shared 定义的 LAN 稳定字段。 */
function mapConversation(conversation: UpstreamConversation): LanBridgeConversationDto {
  return {
    id: conversation.id,
    title: conversation.title,
    ...(conversation.pinned === undefined ? {} : { pinned: conversation.pinned }),
    ...(conversation.archived === undefined ? {} : { archived: conversation.archived }),
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
  }
}

/** 将官方 Agent 会话对象映射为 shared 定义的 LAN 稳定字段。 */
function mapAgentSession(
  session: UpstreamAgentSession,
  runtimeStatus: LanBridgeAgentSessionRuntimeStatus,
): LanBridgeAgentSessionDto {
  return {
    id: session.id,
    title: session.title,
    ...(session.workspaceId === undefined ? {} : { workspaceId: session.workspaceId }),
    ...(session.pinned === undefined ? {} : { pinned: session.pinned }),
    ...(session.archived === undefined ? {} : { archived: session.archived }),
    ...(session.manualWorking === undefined ? {} : { manualWorking: session.manualWorking }),
    ...(session.starred === undefined ? {} : { starred: session.starred }),
    runtimeStatus,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  }
}

/** 创建隔离官方实现细节的纯 LAN Bridge Proma Adapter。 */
export function createLanBridgePromaAdapter(
  dependencies: LanBridgePromaDependencies,
): LanBridgePromaAdapter {
  return {
    listConversations: () => dependencies.listConversations().map(mapConversation),
    hasConversation: (conversationId) => isValidLanBridgeSessionId(conversationId)
      && dependencies.listConversations().some(conversation => conversation.id === conversationId),
    getConversationMessages: (conversationId) => {
      assertExistingConversation(dependencies, conversationId)
      return dependencies.getConversationMessages(conversationId)
    },
    searchConversations: async (query, matchedAt = Date.now()) => {
      /** 官方 Chat 搜索结果只在此处转换为 LAN 字段。 */
      const results = await dependencies.searchConversationMessages(query)
      return results.map((result) => ({
        id: result.conversationId,
        title: result.conversationTitle ?? '',
        snippet: result.snippet,
        type: 'chat',
        matchedAt,
      }))
    },
    listAgentSessions: () => dependencies.listAgentSessions().map((session) => (
      mapAgentSession(session, dependencies.getAgentSessionRuntimeStatus(session.id))
    )),
    hasAgentSession: (sessionId) => isValidLanBridgeSessionId(sessionId)
      && dependencies.listAgentSessions().some(session => session.id === sessionId),
    getAgentMessages: (sessionId) => {
      assertExistingAgentSession(dependencies, sessionId)
      return dependencies.getAgentSessionMessages(sessionId)
    },
    searchAgentSessions: async (query, matchedAt = Date.now()) => {
      /** 官方 Agent 搜索结果只在此处转换为 LAN 字段。 */
      const results = await dependencies.searchAgentSessionMessages(query)
      return results.map((result) => ({
        id: result.sessionId,
        title: result.sessionTitle ?? '',
        snippet: result.snippet,
        type: 'agent',
        matchedAt,
      }))
    },
    listWorkspaces: () => dependencies.listAgentWorkspaces().map((workspace) => ({
      id: workspace.id,
      name: workspace.name,
      slug: workspace.slug,
      createdAt: workspace.createdAt,
    })),
    createAgentSession: (title, workspaceId) => {
      /** 新会话先映射为稳定 DTO，再用于 LAN 返回和桌面标题通知。 */
      const created = dependencies.createAgentSession(title, undefined, workspaceId)
      const session = mapAgentSession(
        created,
        dependencies.getAgentSessionRuntimeStatus(created.id),
      )
      dependencies.notifyAgentTitleUpdated(session)
      return session
    },
    isAgentSessionActive: (sessionId) => {
      assertExistingAgentSession(dependencies, sessionId)
      return dependencies.isAgentSessionActive(sessionId)
    },
    getAgentSessionRuntimeStatus: (sessionId) => {
      assertExistingAgentSession(dependencies, sessionId)
      return dependencies.getAgentSessionRuntimeStatus(sessionId)
    },
    toggleAgentSessionStar: (sessionId) => {
      assertExistingAgentSession(dependencies, sessionId)
      const session = dependencies.updateAgentSessionStarred(sessionId)
      return mapAgentSession(session, dependencies.getAgentSessionRuntimeStatus(sessionId))
    },
    markAgentSessionViewed: (sessionId) => {
      assertExistingAgentSession(dependencies, sessionId)
      const changed = dependencies.markAgentSessionViewed(sessionId)
      return {
        changed,
        runtimeStatus: dependencies.getAgentSessionRuntimeStatus(sessionId),
      }
    },
    sendAgent: async (command, callbacks) => {
      assertExistingAgentSession(dependencies, command.sessionId)
      /** 默认设置仅从 Adapter 白名单读取，避免 handlers 接触官方设置对象。 */
      const settings = dependencies.getSettings()
      /** LAN 的 auto 表示交给运行时默认权限，其余值显式覆盖。 */
      const permissionModeOverride = command.permissionMode === 'auto'
        ? undefined
        : command.permissionMode ?? 'bypassPermissions'
      /** 官方 Agent 输入仅在隔离层组装。 */
      const input: AgentSendInput = {
        sessionId: command.sessionId,
        userMessage: command.userMessage,
        channelId: settings.agentChannelId ?? '',
        modelId: command.modelId || settings.agentModelId,
        workspaceId: command.workspaceId || settings.agentWorkspaceId,
        permissionModeOverride,
      }
      /** 首个错误或完成信号结束本次 LAN 回调链，拒绝官方迟到的重复终止事件。 */
      let terminated = false
      await dependencies.runAgentHeadless(input, {
        onError: (error) => {
          if (terminated) return
          terminated = true
          callbacks.onError?.({ error })
        },
        onComplete: () => {
          if (terminated) return
          terminated = true
          callbacks.onComplete?.()
        },
        onTitleUpdated: (title) => callbacks.onTitleUpdated?.({ title }),
      })
    },
    stopAgent: (sessionId) => {
      assertExistingAgentSession(dependencies, sessionId)
      dependencies.stopAgent(sessionId)
    },
    sendConversation: async (command, callbacks) => {
      assertExistingConversation(dependencies, command.conversationId)
      /** 发送前读取消息历史，保持官方 Chat 上下文语义。 */
      const messageHistory = dependencies.getConversationMessages(command.conversationId)
      /** 可选渠道和模型在 Adapter 内独立兑现默认设置语义。 */
      const settings = dependencies.getSettings()
      /** 官方 Chat 输入要求渠道和模型；handlers 已完成缺失值校验。 */
      const input: ChatSendInput = {
        conversationId: command.conversationId,
        userMessage: command.userMessage,
        messageHistory,
        channelId: command.channelId ?? settings.agentChannelId ?? '',
        modelId: command.modelId ?? settings.agentModelId ?? '',
      }
      /** 将官方 Chat 事件转换为 LAN 自有回调，工具事件当前不对移动端推送。 */
      const onEvent = (event: UpstreamChatStreamEvent): void => {
        switch (event.type) {
          case 'chunk':
            callbacks.onText?.({ text: event.delta ?? '' })
            break
          case 'reasoning':
            callbacks.onReasoning?.({ text: event.delta ?? '' })
            break
          case 'error':
            callbacks.onError?.({ error: event.error })
            break
          case 'complete':
            callbacks.onComplete?.()
            break
          default:
            break
        }
      }
      await dependencies.sendConversationMessage(
        input,
        dependencies.getPrimaryWebContents(),
        onEvent,
      )
    },
    stopConversation: (conversationId) => {
      assertExistingConversation(dependencies, conversationId)
      dependencies.stopConversation(conversationId)
    },
    getSettings: () => {
      /** 设置对象按字段重建，禁止凭据或供应商配置越过 Adapter。 */
      const settings = dependencies.getSettings()
      return {
        ...(settings.agentChannelId === undefined ? {} : { agentChannelId: settings.agentChannelId }),
        ...(settings.agentModelId === undefined ? {} : { agentModelId: settings.agentModelId }),
        ...(settings.agentWorkspaceId === undefined ? {} : { agentWorkspaceId: settings.agentWorkspaceId }),
      }
    },
    listChannels: () => dependencies.listChannels().map((channel) => ({
      id: channel.id,
      name: channel.name,
      provider: channel.provider,
      enabled: channel.enabled,
    })),
    getChannelBaseUrl: (channelId) => {
      /** Base URL 是现有移动端图标选择所需的唯一额外渠道字段。 */
      const channel = dependencies.listChannels().find((candidate) => candidate.id === channelId)
      return channel?.baseUrl || null
    },
    listEnabledChannelOptions: () => dependencies.listChannels()
      .filter((channel) => channel.enabled)
      .map((channel) => ({
        id: channel.id,
        name: channel.name,
        provider: channel.provider,
        baseUrl: channel.baseUrl,
        models: channel.models
          .filter((model) => model.enabled)
          .map((model) => ({
            id: model.id,
            name: model.name,
            enabled: model.enabled,
            ...(model.source === undefined ? {} : { source: model.source }),
          })),
      })),
  }
}
