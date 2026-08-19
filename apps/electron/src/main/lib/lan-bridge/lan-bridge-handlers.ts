/**
 * LAN Bridge 命令处理器
 *
 * 调用已有服务实现各个 WS 命令。
 */

import { registerRoute } from './lan-bridge-router'
import type { LanBridgeAuthService, TokenVerificationResult } from './lan-bridge-auth'
import type { ClientConnection, RouteHandler } from './lan-bridge-types'
import type { LanBridgeSessionManager } from './lan-bridge-session'
import { isValidLanBridgeSessionId } from './lan-bridge-proma-adapter-core'
import type { LanBridgePromaAdapter } from './lan-bridge-proma-adapter-core'
import {
  LAN_BRIDGE_MAX_PROTOCOL_VERSION,
  LAN_BRIDGE_MIN_PROTOCOL_VERSION,
  LAN_BRIDGE_PROTOCOL_VERSION,
  LAN_BRIDGE_WS_CAPABILITIES,
} from '@proma/shared'
import type { LanBridgeConnectedPayload } from '@proma/shared'

/** 构造 WebSocket 建连后的协议能力声明。 */
export function createLanBridgeConnectedPayload(serverVersion: string): LanBridgeConnectedPayload {
  return {
    message: 'Proma LAN Bridge',
    protocolVersion: LAN_BRIDGE_PROTOCOL_VERSION,
    minProtocolVersion: LAN_BRIDGE_MIN_PROTOCOL_VERSION,
    maxProtocolVersion: LAN_BRIDGE_MAX_PROTOCOL_VERSION,
    serverVersion,
    capabilities: [...LAN_BRIDGE_WS_CAPABILITIES],
  }
}

/** handlers 的进程级组合依赖。 */
export interface LanBridgeHandlerDependencies {
  /** 生产唯一或测试隔离的认证服务。 */
  authService: LanBridgeAuthService
  /** 稳定的 Proma 业务适配器。 */
  promaAdapter: LanBridgePromaAdapter
  /** 获取当前 Bridge 会话管理器。 */
  getSessionManager: () => LanBridgeSessionManager | null
}

/** 注册全部 LAN Bridge 路由；重复注册会按 type 原子替换 handler。 */
export function registerLanBridgeHandlers(dependencies: LanBridgeHandlerDependencies): void {
  /** 将依赖上下文绑定到现有 RouteHandler 签名。 */
  const bind = (
    handler: (
      context: LanBridgeHandlerDependencies,
      client: ClientConnection,
      data: Record<string, unknown>,
    ) => unknown,
  ): RouteHandler => (client, data) => handler(dependencies, client, data)

  registerRoute('auth.pair', bind(handlePair))
  registerRoute('protocol.hello', bind(handleProtocolHello))
  registerRoute('auth.pairTicket', bind(handlePairTicket))
  registerRoute('auth.verify', bind(handleVerify))
  registerRoute('auth.refresh', bind(handleRefresh))
  registerRoute('ping', bind(handlePing))
  registerRoute('conversations.list', bind(handleListConversations))
  registerRoute('conversations.messages', bind(handleConversationMessages))
  registerRoute('conversations.search', bind(handleSearch))
  registerRoute('agent.sessions', bind(handleAgentSessions))
  registerRoute('agent.sessions.messages', bind(handleAgentSessionMessages))
  registerRoute('agent.sessions.search', bind(handleAgentSearch))
  registerRoute('workspaces.list', bind(handleWorkspaces))
  registerRoute('subscribe', bind(handleSubscribe))
  registerRoute('unsubscribe', bind(handleUnsubscribe))
  registerRoute('agent.session.create', bind(handleAgentSessionCreate))
  registerRoute('agent.send', bind(handleAgentSend))
  registerRoute('agent.stop', bind(handleAgentStop))
  registerRoute('conversations.send', bind(handleConversationSend))
  registerRoute('conversations.stop', bind(handleConversationStop))
  registerRoute('settings.get', bind(handleSettingsGet))
  registerRoute('settings.channels', bind(handleSettingsChannels))
}

/** 在任何认证材料提交前协商双方共同支持的协议主版本。 */
function handleProtocolHello(
  _context: LanBridgeHandlerDependencies,
  client: ClientConnection,
  data: Record<string, unknown>,
) {
  /** 客户端声明的最低主版本。 */
  const minimum = data.minProtocolVersion
  /** 客户端声明的最高主版本。 */
  const maximum = data.maxProtocolVersion
  if (!Number.isSafeInteger(minimum) || !Number.isSafeInteger(maximum)
    || (minimum as number) > (maximum as number)
    || (maximum as number) < LAN_BRIDGE_MIN_PROTOCOL_VERSION
    || (minimum as number) > LAN_BRIDGE_MAX_PROTOCOL_VERSION) {
    throw Object.assign(new Error('Protocol version unsupported'), { errorCode: 'PROTOCOL_UNSUPPORTED' })
  }
  /** 当前范围只有一个稳定主版本；显式记录到连接状态供认证门禁使用。 */
  const protocolVersion = Math.min(maximum as number, LAN_BRIDGE_MAX_PROTOCOL_VERSION)
  client.protocolVersion = protocolVersion
  return { protocolVersion, capabilities: [...LAN_BRIDGE_WS_CAPABILITIES] }
}

// ===== 认证 =====

function handlePair(
  context: LanBridgeHandlerDependencies,
  client: ClientConnection,
  data: Record<string, unknown>,
) {
  const pin = data.pin as string | undefined
  const result = pin ? context.authService.verifyPairingPin(pin, client.ip) : 'invalid'
  if (result === 'rate_limited') {
    throw Object.assign(new Error('Too many pairing attempts'), { errorCode: 'RATE_LIMITED' })
  }
  if (result !== 'valid') {
    throw Object.assign(new Error('Invalid PIN'), { errorCode: 'AUTH_FAILED' })
  }
  /** PIN 配对注册并签发的真实设备 Token。 */
  const issuedToken = context.authService.generateToken(
    client.ip,
    typeof data.deviceName === 'string' ? data.deviceName : undefined,
    Date.now(),
    typeof data.deviceId === 'string' ? data.deviceId : undefined,
  )
  markAuthenticated(client, issuedToken.token, issuedToken.deviceId, issuedToken.expiresAt)
  return issuedToken
}

function handlePairTicket(
  context: LanBridgeHandlerDependencies,
  client: ClientConnection,
  data: Record<string, unknown>,
) {
  /** 客户端提交的一次性票据。 */
  const ticket = typeof data.ticket === 'string' ? data.ticket : ''
  /** 票据配对签发的真实设备 Token。 */
  const issuedToken = context.authService.consumePairingTicket(
    ticket,
    client.ip,
    typeof data.deviceName === 'string' ? data.deviceName : 'LAN 设备',
    Date.now(),
    typeof data.deviceId === 'string' ? data.deviceId : undefined,
  )
  markAuthenticated(client, issuedToken.token, issuedToken.deviceId, issuedToken.expiresAt)
  return issuedToken
}

function handleVerify(
  context: LanBridgeHandlerDependencies,
  client: ClientConnection,
  data: Record<string, unknown>,
) {
  const token = data.token as string | undefined
  if (!token) return { valid: false, errorCode: 'TOKEN_INVALID' }
  /** 保留具体失败语义的结构化验证结果。 */
  const verification = context.authService.verifyTokenDetails(token, client.ip)
  if (verification.valid) {
    markAuthenticated(client, token, verification.deviceId, verification.expiresAt)
  }
  return verification
}

function handleRefresh(
  context: LanBridgeHandlerDependencies,
  client: ClientConnection,
  data: Record<string, unknown>,
) {
  /** 新客户端优先提交的长期设备凭证。 */
  const credential = typeof data.credential === 'string' ? data.credential : undefined
  const token = data.token as string | undefined
  if (!credential && !token) {
    throw Object.assign(new Error('Token required'), { errorCode: 'AUTH_REQUIRED' })
  }
  /** 长期设备凭证支持跨 IP、跨进程续签；旧 Token 路径继续兼容既有客户端。 */
  const result = credential
    ? context.authService.refreshDeviceCredential(credential, client.ip)
    : context.authService.refreshTokenDetails(token!, client.ip)
  if (!result.valid) throwAuthError(result.errorCode)
  markAuthenticated(client, result.token, result.deviceId, result.expiresAt)
  /** 旧客户端继续读取 token/expiresIn，新增 deviceId 不破坏兼容。 */
  const { valid: _valid, ...issuedToken } = result
  return issuedToken
}

// ===== 心跳 =====

function handlePing(
  _context: LanBridgeHandlerDependencies,
  _client: ClientConnection,
  _data: Record<string, unknown>,
) {
  return { pong: true }
}

// ===== 数据查询 =====

function handleListConversations(context: LanBridgeHandlerDependencies, client: ClientConnection, data: Record<string, unknown>) {
  requireAuth(context.authService, client, data)
  return { conversations: context.promaAdapter.listConversations() }
}

function handleConversationMessages(context: LanBridgeHandlerDependencies, client: ClientConnection, data: Record<string, unknown>) {
  requireAuth(context.authService, client, data)
  const conversationId = data.conversationId as string
  if (!conversationId) {
    throw Object.assign(new Error('conversationId required'), { errorCode: 'VALIDATION_ERROR' })
  }
  requireExistingConversation(context.promaAdapter, conversationId)
  const allMessages = context.promaAdapter.getConversationMessages(conversationId)
  const limit = typeof data.limit === 'number' ? data.limit : 100
  const messages = limit > 0 ? allMessages.slice(-limit) : allMessages
  return { messages, total: allMessages.length }
}

async function handleSearch(context: LanBridgeHandlerDependencies, client: ClientConnection, data: Record<string, unknown>) {
  requireAuth(context.authService, client, data)
  const query = data.query as string
  if (!query) {
    throw Object.assign(new Error('Query required'), { errorCode: 'VALIDATION_ERROR' })
  }
  const sessionType = data.sessionType as string | undefined
  const now = Date.now()
  const results: Array<{ id: string; title: string; snippet: string; type: 'chat' | 'agent'; matchedAt: number }> = []
  if (!sessionType || sessionType === 'chat') {
    results.push(...await context.promaAdapter.searchConversations(query, now))
  }
  if (!sessionType || sessionType === 'agent') {
    results.push(...await context.promaAdapter.searchAgentSessions(query, now))
  }
  return { results }
}

function handleAgentSessions(context: LanBridgeHandlerDependencies, client: ClientConnection, data: Record<string, unknown>) {
  requireAuth(context.authService, client, data)
  const sessions = context.promaAdapter.listAgentSessions()
  return { sessions }
}

function handleAgentSessionMessages(context: LanBridgeHandlerDependencies, client: ClientConnection, data: Record<string, unknown>) {
  requireAuth(context.authService, client, data)
  const sessionId = data.sessionId as string
  if (!sessionId) {
    throw Object.assign(new Error('sessionId required'), { errorCode: 'VALIDATION_ERROR' })
  }
  requireExistingAgentSession(context.promaAdapter, sessionId)
  const allMessages = context.promaAdapter.getAgentMessages(sessionId)
  const limit = typeof data.limit === 'number' ? data.limit : 100
  const messages = limit > 0 ? allMessages.slice(-limit) : allMessages
  return { messages, total: allMessages.length }
}

async function handleAgentSearch(context: LanBridgeHandlerDependencies, client: ClientConnection, data: Record<string, unknown>) {
  requireAuth(context.authService, client, data)
  const query = data.query as string
  if (!query) {
    throw Object.assign(new Error('Query required'), { errorCode: 'VALIDATION_ERROR' })
  }
  const results = await context.promaAdapter.searchAgentSessions(query)
  return { results }
}

function handleWorkspaces(context: LanBridgeHandlerDependencies, client: ClientConnection, data: Record<string, unknown>) {
  requireAuth(context.authService, client, data)
  return { workspaces: context.promaAdapter.listWorkspaces() }
}

// ===== 订阅 =====

function handleSubscribe(context: LanBridgeHandlerDependencies, client: ClientConnection, data: Record<string, unknown>) {
  requireAuth(context.authService, client, data)
  const id = (data.sessionId ?? data.conversationId) as string | undefined
  if (!id) {
    throw Object.assign(new Error('sessionId or conversationId required'), { errorCode: 'VALIDATION_ERROR' })
  }
  if (data.sessionId !== undefined) requireExistingAgentSession(context.promaAdapter, id)
  if (data.conversationId !== undefined) requireExistingConversation(context.promaAdapter, id)
  client.subscriptions.add(id)
  return { subscribed: id }
}

function handleUnsubscribe(context: LanBridgeHandlerDependencies, client: ClientConnection, data: Record<string, unknown>) {
  requireAuth(context.authService, client, data)
  const id = (data.sessionId ?? data.conversationId) as string | undefined
  if (id) {
    if (data.sessionId !== undefined) requireExistingAgentSession(context.promaAdapter, id)
    if (data.conversationId !== undefined) requireExistingConversation(context.promaAdapter, id)
    client.subscriptions.delete(id)
  }
  return { unsubscribed: id }
}

// ===== Agent 交互 =====

function handleAgentSessionCreate(context: LanBridgeHandlerDependencies, client: ClientConnection, data: Record<string, unknown>) {
  requireAuth(context.authService, client, data)
  const title = data.title as string | undefined
  /** 新会话默认工作区保持与桌面设置一致。 */
  const workspaceId = (data.workspaceId as string | undefined) || context.promaAdapter.getSettings().agentWorkspaceId
  /** Adapter 同时负责稳定字段映射和桌面标题通知。 */
  const session = context.promaAdapter.createAgentSession(title, workspaceId)

  return { session }
}
function handleAgentSend(context: LanBridgeHandlerDependencies, client: ClientConnection, data: Record<string, unknown>) {
  requireAuth(context.authService, client, data)
  const sessionId = data.sessionId as string | undefined
  const userMessage = data.userMessage as string | undefined
  if (!sessionId || !userMessage) {
    throw Object.assign(new Error('sessionId and userMessage required'), { errorCode: 'VALIDATION_ERROR' })
  }
  requireExistingAgentSession(context.promaAdapter, sessionId)

  if (context.promaAdapter.isAgentSessionActive(sessionId)) {
    throw Object.assign(new Error('Agent session is already running'), { errorCode: 'SESSION_ACTIVE' })
  }

  /** 设置快照只用于日志；官方设置对象不会越过 Adapter。 */
  const settings = context.promaAdapter.getSettings()
  /** 仅接受协议支持的权限值，未知值保持旧行为并回退 bypassPermissions。 */
  const requestedPermissionMode = data.permissionMode
  /** 识别后的 LAN 权限模式由 Adapter 转换为官方运行时字段。 */
  const permissionMode = requestedPermissionMode === 'auto'
    || requestedPermissionMode === 'bypassPermissions'
    || requestedPermissionMode === 'plan'
    ? requestedPermissionMode
    : undefined
  console.log(`[LAN Bridge] agent.send 开始: sessionId=${sessionId.slice(0, 12)} channelId=${settings.agentChannelId || '(空)'}`)
  const pushToSubs = (msg: object) => {
    const mgr = context.getSessionManager()
    if (!mgr) return
    for (const c of mgr.getSubscribers(sessionId)) {
      mgr.send(c, msg)
    }
  }
  context.promaAdapter.sendAgent({
    sessionId,
    userMessage,
    modelId: data.modelId as string | undefined,
    workspaceId: data.workspaceId as string | undefined,
    permissionMode,
  }, {
    onError: ({ error }) => {
      console.error(`[LAN Bridge] agent.send error:`, error)
      pushToSubs({ type: 'stream.error', data: { sessionId, error } })
      pushToSubs({ type: 'stream.complete', data: { sessionId } })
    },
    onComplete: () => {
      console.log(`[LAN Bridge] agent.send complete`)
      pushToSubs({ type: 'stream.complete', data: { sessionId } })
    },
    onTitleUpdated: ({ title }) => {
      console.log(`[LAN Bridge] agent.send title:`, title)
      pushToSubs({ type: 'session.updated', data: { sessionId, title } })
    },
  }).catch((err: unknown) => {
    console.error(`[LAN Bridge] agent.send 异常:`, err)
    const errMsg = err instanceof Error ? err.message : String(err)
    pushToSubs({ type: 'stream.error', data: { sessionId, error: errMsg } })
    pushToSubs({ type: 'stream.complete', data: { sessionId } })
  })

  return { sent: true, sessionId }
}

function handleAgentStop(context: LanBridgeHandlerDependencies, client: ClientConnection, data: Record<string, unknown>) {
  requireAuth(context.authService, client, data)
  const sessionId = data.sessionId as string | undefined
  if (!sessionId) {
    throw Object.assign(new Error('sessionId required'), { errorCode: 'VALIDATION_ERROR' })
  }
  requireExistingAgentSession(context.promaAdapter, sessionId)
  context.promaAdapter.stopAgent(sessionId)
  return { stopped: true, sessionId }
}

// ===== Chat 对话发送 =====

function handleConversationSend(context: LanBridgeHandlerDependencies, client: ClientConnection, data: Record<string, unknown>) {
  requireAuth(context.authService, client, data)
  const conversationId = data.conversationId as string | undefined
  const userMessage = data.userMessage as string | undefined
  if (!conversationId || !userMessage) {
    throw Object.assign(new Error('conversationId and userMessage required'), { errorCode: 'VALIDATION_ERROR' })
  }
  requireExistingConversation(context.promaAdapter, conversationId)

  /** 默认渠道和模型通过稳定设置 DTO 解析。 */
  const settings = context.promaAdapter.getSettings()
  const channelId = data.channelId as string | undefined || settings.agentChannelId
  const modelId = data.modelId as string | undefined || settings.agentModelId
  if (!channelId || !modelId) {
    throw Object.assign(new Error('channelId and modelId required'), { errorCode: 'VALIDATION_ERROR' })
  }

  /** 将 Adapter 的 LAN 自有回调转换为既有 WebSocket 推送。 */
  const pushToSubs = (type: string, payload: Record<string, unknown>) => {
    const mgr = context.getSessionManager()
    if (!mgr) return
    for (const c of mgr.getSubscribers(conversationId)) {
      mgr.send(c, { type, data: { conversationId, ...payload } })
    }
  }

  context.promaAdapter.sendConversation({
    conversationId,
    userMessage,
    channelId,
    modelId,
  }, {
    onText: ({ text }) => pushToSubs('stream.chunk', { text }),
    onReasoning: ({ text }) => pushToSubs('stream.reasoning', { text }),
    onError: ({ error }) => pushToSubs('stream.error', { error }),
    onComplete: () => pushToSubs('stream.complete', {}),
  }).catch((err: unknown) => {
    /** Promise 级异常保持旧行为：先错误，再完成。 */
    const errMsg = err instanceof Error ? err.message : String(err)
    pushToSubs('stream.error', { error: errMsg })
    pushToSubs('stream.complete', {})
  })

  return { sent: true, conversationId }
}

function handleConversationStop(context: LanBridgeHandlerDependencies, client: ClientConnection, data: Record<string, unknown>) {
  requireAuth(context.authService, client, data)
  const conversationId = data.conversationId as string | undefined
  if (!conversationId) {
    throw Object.assign(new Error('conversationId required'), { errorCode: 'VALIDATION_ERROR' })
  }
  requireExistingConversation(context.promaAdapter, conversationId)
  context.promaAdapter.stopConversation(conversationId)
  return { stopped: true, conversationId }
}

// ===== 设置 =====

function handleSettingsGet(context: LanBridgeHandlerDependencies, client: ClientConnection, data: Record<string, unknown>) {
  requireAuth(context.authService, client, data)
  const settings = context.promaAdapter.getSettings()
  let channelBaseUrl: string | null = null
  if (settings.agentChannelId) {
    channelBaseUrl = context.promaAdapter.getChannelBaseUrl(settings.agentChannelId)
  }
  return {
    agentWorkspaceId: settings.agentWorkspaceId || null,
    agentModelId: settings.agentModelId || null,
    agentChannelId: settings.agentChannelId || null,
    channelBaseUrl,
  }
}

function handleSettingsChannels(context: LanBridgeHandlerDependencies, client: ClientConnection, data: Record<string, unknown>) {
  requireAuth(context.authService, client, data)
  const channels = context.promaAdapter.listEnabledChannelOptions()
  return { channels }
}

// ===== 工具 =====

function requireAuth(
  authService: LanBridgeAuthService,
  client: ClientConnection,
  data: Record<string, unknown>,
): void {
  /** 请求显式 Token 优先，否则复验连接最近一次通过的 Token。 */
  const token = typeof data.token === 'string' ? data.token : client.authToken
  if (!token) throw Object.assign(new Error('Authentication required'), { errorCode: 'AUTH_REQUIRED' })
  /** 每个受保护请求都复验设备状态，禁止 authenticated 布尔旁路撤销。 */
  const verification = authService.verifyTokenDetails(token, client.ip)
  if (!verification.valid) throwAuthError(verification.errorCode)
  markAuthenticated(client, token, verification.deviceId, verification.expiresAt)
}

/** 在 Handler 边界拒绝路径型 ID，并确认目标 Agent 会话真实存在。 */
function requireExistingAgentSession(adapter: LanBridgePromaAdapter, sessionId: unknown): asserts sessionId is string {
  if (!isValidLanBridgeSessionId(sessionId)) {
    throw Object.assign(new Error('无效的会话 ID'), { errorCode: 'VALIDATION_ERROR' })
  }
  if (!adapter.hasAgentSession(sessionId)) {
    throw Object.assign(new Error('会话不存在'), { errorCode: 'NOT_FOUND' })
  }
}

/** 在 Handler 边界拒绝路径型 ID，并确认目标普通对话真实存在。 */
function requireExistingConversation(adapter: LanBridgePromaAdapter, conversationId: unknown): asserts conversationId is string {
  if (!isValidLanBridgeSessionId(conversationId)) {
    throw Object.assign(new Error('无效的会话 ID'), { errorCode: 'VALIDATION_ERROR' })
  }
  if (!adapter.hasConversation(conversationId)) {
    throw Object.assign(new Error('会话不存在'), { errorCode: 'NOT_FOUND' })
  }
}

/** 同时提交连接认证布尔、设备 ID 和已验证 Token。 */
function markAuthenticated(
  client: ClientConnection,
  token: string,
  deviceId: string,
  expiresAt: number,
): void {
  client.authenticated = true
  client.deviceId = deviceId
  client.authToken = token
  client.authExpiresAt = expiresAt
}

/** 将结构化认证失败转换为保留稳定错误码的路由异常。 */
function throwAuthError(errorCode: Extract<TokenVerificationResult, { valid: false }>['errorCode']): never {
  throw Object.assign(new Error(errorCode), { errorCode })
}
