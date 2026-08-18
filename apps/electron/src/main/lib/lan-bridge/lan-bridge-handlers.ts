/**
 * LAN Bridge 命令处理器
 *
 * 调用已有服务实现各个 WS 命令。
 */

import { registerRoute, sendError } from './lan-bridge-router'
import { verifyPairingPin, generateToken, verifyToken, refreshToken } from './lan-bridge-auth'
import type { ClientConnection } from './lan-bridge-types'
import { getSessionManager } from './lan-bridge'
import { lanBridgePromaAdapter } from './lan-bridge-proma-adapter'

// ===== 注册所有路由 =====

registerRoute('auth.pair', handlePair)
registerRoute('auth.verify', handleVerify)
registerRoute('auth.refresh', handleRefresh)
registerRoute('ping', handlePing)
registerRoute('conversations.list', handleListConversations)
registerRoute('conversations.messages', handleConversationMessages)
registerRoute('conversations.search', handleSearch)
registerRoute('agent.sessions', handleAgentSessions)
registerRoute('agent.sessions.messages', handleAgentSessionMessages)
registerRoute('agent.sessions.search', handleAgentSearch)
registerRoute('workspaces.list', handleWorkspaces)
registerRoute('subscribe', handleSubscribe)
registerRoute('unsubscribe', handleUnsubscribe)
registerRoute('agent.send', handleAgentSend)
registerRoute('agent.stop', handleAgentStop)
registerRoute('conversations.send', handleConversationSend)
registerRoute('conversations.stop', handleConversationStop)
registerRoute('settings.get', handleSettingsGet)
registerRoute('settings.channels', handleSettingsChannels)

// ===== 认证 =====

function handlePair(client: ClientConnection, data: Record<string, unknown>) {
  const pin = data.pin as string | undefined
  const result = pin ? verifyPairingPin(pin, client.ip) : 'invalid'
  if (result === 'rate_limited') {
    throw Object.assign(new Error('Too many pairing attempts'), { errorCode: 'RATE_LIMITED' })
  }
  if (result !== 'valid') {
    throw Object.assign(new Error('Invalid PIN'), { errorCode: 'AUTH_FAILED' })
  }
  client.authenticated = true
  return generateToken(client.ip)
}

function handleVerify(client: ClientConnection, data: Record<string, unknown>) {
  const token = data.token as string | undefined
  if (!token) return { valid: false }
  return { valid: verifyToken(token, client.ip) }
}

function handleRefresh(client: ClientConnection, data: Record<string, unknown>) {
  const token = data.token as string | undefined
  if (!token) {
    throw Object.assign(new Error('Token required'), { errorCode: 'AUTH_REQUIRED' })
  }
  const result = refreshToken(token, client.ip)
  if (!result) {
    throw Object.assign(new Error('Token invalid or expired'), { errorCode: 'TOKEN_EXPIRED' })
  }
  client.authenticated = true
  return result
}

// ===== 心跳 =====

function handlePing(_client: ClientConnection, _data: Record<string, unknown>) {
  return { pong: true }
}

// ===== 数据查询 =====

function handleListConversations(client: ClientConnection, data: Record<string, unknown>) {
  requireAuth(client, data)
  return { conversations: lanBridgePromaAdapter.listConversations() }
}

function handleConversationMessages(client: ClientConnection, data: Record<string, unknown>) {
  requireAuth(client, data)
  const conversationId = data.conversationId as string
  if (!conversationId) {
    throw Object.assign(new Error('conversationId required'), { errorCode: 'VALIDATION_ERROR' })
  }
  const allMessages = lanBridgePromaAdapter.getConversationMessages(conversationId)
  const limit = typeof data.limit === 'number' ? data.limit : 100
  const messages = limit > 0 ? allMessages.slice(-limit) : allMessages
  return { messages, total: allMessages.length }
}

async function handleSearch(client: ClientConnection, data: Record<string, unknown>) {
  requireAuth(client, data)
  const query = data.query as string
  if (!query) {
    throw Object.assign(new Error('Query required'), { errorCode: 'VALIDATION_ERROR' })
  }
  const sessionType = data.sessionType as string | undefined
  const now = Date.now()
  const results: Array<{ id: string; title: string; snippet: string; type: 'chat' | 'agent'; matchedAt: number }> = []
  if (!sessionType || sessionType === 'chat') {
    results.push(...await lanBridgePromaAdapter.searchConversations(query, now))
  }
  if (!sessionType || sessionType === 'agent') {
    results.push(...await lanBridgePromaAdapter.searchAgentSessions(query, now))
  }
  return { results }
}

function handleAgentSessions(client: ClientConnection, data: Record<string, unknown>) {
  requireAuth(client, data)
  const sessions = lanBridgePromaAdapter.listAgentSessions()
  return { sessions }
}

function handleAgentSessionMessages(client: ClientConnection, data: Record<string, unknown>) {
  requireAuth(client, data)
  const sessionId = data.sessionId as string
  if (!sessionId) {
    throw Object.assign(new Error('sessionId required'), { errorCode: 'VALIDATION_ERROR' })
  }
  const allMessages = lanBridgePromaAdapter.getAgentMessages(sessionId)
  const limit = typeof data.limit === 'number' ? data.limit : 100
  const messages = limit > 0 ? allMessages.slice(-limit) : allMessages
  return { messages, total: allMessages.length }
}

async function handleAgentSearch(client: ClientConnection, data: Record<string, unknown>) {
  requireAuth(client, data)
  const query = data.query as string
  if (!query) {
    throw Object.assign(new Error('Query required'), { errorCode: 'VALIDATION_ERROR' })
  }
  const results = await lanBridgePromaAdapter.searchAgentSessions(query)
  return { results }
}

function handleWorkspaces(client: ClientConnection, data: Record<string, unknown>) {
  requireAuth(client, data)
  return { workspaces: lanBridgePromaAdapter.listWorkspaces() }
}

// ===== 订阅 =====

function handleSubscribe(client: ClientConnection, data: Record<string, unknown>) {
  requireAuth(client, data)
  const id = (data.sessionId ?? data.conversationId) as string | undefined
  if (!id) {
    throw Object.assign(new Error('sessionId or conversationId required'), { errorCode: 'VALIDATION_ERROR' })
  }
  client.subscriptions.add(id)
  return { subscribed: id }
}

function handleUnsubscribe(client: ClientConnection, data: Record<string, unknown>) {
  requireAuth(client, data)
  const id = (data.sessionId ?? data.conversationId) as string | undefined
  if (id) {
    client.subscriptions.delete(id)
  }
  return { unsubscribed: id }
}

// ===== Agent 交互 =====

function handleAgentSessionCreate(client: ClientConnection, data: Record<string, unknown>) {
  requireAuth(client, data)
  const title = data.title as string | undefined
  /** 新会话默认工作区保持与桌面设置一致。 */
  const workspaceId = (data.workspaceId as string | undefined) || lanBridgePromaAdapter.getSettings().agentWorkspaceId
  /** Adapter 同时负责稳定字段映射和桌面标题通知。 */
  const session = lanBridgePromaAdapter.createAgentSession(title, workspaceId)

  return { session }
}
registerRoute('agent.session.create', handleAgentSessionCreate)

function handleAgentSend(client: ClientConnection, data: Record<string, unknown>) {
  requireAuth(client, data)
  const sessionId = data.sessionId as string | undefined
  const userMessage = data.userMessage as string | undefined
  if (!sessionId || !userMessage) {
    throw Object.assign(new Error('sessionId and userMessage required'), { errorCode: 'VALIDATION_ERROR' })
  }

  if (lanBridgePromaAdapter.isAgentSessionActive(sessionId)) {
    throw Object.assign(new Error('Agent session is already running'), { errorCode: 'SESSION_ACTIVE' })
  }

  /** 设置快照只用于日志；官方设置对象不会越过 Adapter。 */
  const settings = lanBridgePromaAdapter.getSettings()
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
    const mgr = getSessionManager()
    if (!mgr) return
    for (const c of mgr.getSubscribers(sessionId)) {
      mgr.send(c, msg)
    }
  }
  lanBridgePromaAdapter.sendAgent({
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

function handleAgentStop(client: ClientConnection, data: Record<string, unknown>) {
  requireAuth(client, data)
  const sessionId = data.sessionId as string | undefined
  if (!sessionId) {
    throw Object.assign(new Error('sessionId required'), { errorCode: 'VALIDATION_ERROR' })
  }
  lanBridgePromaAdapter.stopAgent(sessionId)
  return { stopped: true, sessionId }
}

// ===== Chat 对话发送 =====

function handleConversationSend(client: ClientConnection, data: Record<string, unknown>) {
  requireAuth(client, data)
  const conversationId = data.conversationId as string | undefined
  const userMessage = data.userMessage as string | undefined
  if (!conversationId || !userMessage) {
    throw Object.assign(new Error('conversationId and userMessage required'), { errorCode: 'VALIDATION_ERROR' })
  }

  /** 默认渠道和模型通过稳定设置 DTO 解析。 */
  const settings = lanBridgePromaAdapter.getSettings()
  const channelId = data.channelId as string | undefined || settings.agentChannelId
  const modelId = data.modelId as string | undefined || settings.agentModelId
  if (!channelId || !modelId) {
    throw Object.assign(new Error('channelId and modelId required'), { errorCode: 'VALIDATION_ERROR' })
  }

  /** 将 Adapter 的 LAN 自有回调转换为既有 WebSocket 推送。 */
  const pushToSubs = (type: string, payload: Record<string, unknown>) => {
    const mgr = getSessionManager()
    if (!mgr) return
    for (const c of mgr.getSubscribers(conversationId)) {
      mgr.send(c, { type, data: { conversationId, ...payload } })
    }
  }

  lanBridgePromaAdapter.sendConversation({
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

function handleConversationStop(client: ClientConnection, data: Record<string, unknown>) {
  requireAuth(client, data)
  const conversationId = data.conversationId as string | undefined
  if (!conversationId) {
    throw Object.assign(new Error('conversationId required'), { errorCode: 'VALIDATION_ERROR' })
  }
  lanBridgePromaAdapter.stopConversation(conversationId)
  return { stopped: true, conversationId }
}

// ===== 设置 =====

function handleSettingsGet(client: ClientConnection, data: Record<string, unknown>) {
  requireAuth(client, data)
  const settings = lanBridgePromaAdapter.getSettings()
  let channelBaseUrl: string | null = null
  if (settings.agentChannelId) {
    channelBaseUrl = lanBridgePromaAdapter.getChannelBaseUrl(settings.agentChannelId)
  }
  return {
    agentWorkspaceId: settings.agentWorkspaceId || null,
    agentModelId: settings.agentModelId || null,
    agentChannelId: settings.agentChannelId || null,
    channelBaseUrl,
  }
}

function handleSettingsChannels(client: ClientConnection, data: Record<string, unknown>) {
  requireAuth(client, data)
  const channels = lanBridgePromaAdapter.listEnabledChannelOptions()
  return { channels }
}

// ===== 工具 =====

function requireAuth(client: ClientConnection, data: Record<string, unknown>): void {
  if (client.authenticated) return
  const token = data.token as string | undefined
  if (token && verifyToken(token, client.ip)) {
    client.authenticated = true
    return
  }
  throw Object.assign(new Error('Authentication required'), { errorCode: 'AUTH_REQUIRED' })
}
