/**
 * LAN Bridge 命令处理器
 *
 * 调用已有服务实现各个 WS 命令。
 */

import { BrowserWindow } from 'electron'
import { AGENT_IPC_CHANNELS } from '@proma/shared'
import { registerRoute, sendError } from './lan-bridge-router'
import { verifyPin, generateToken, verifyToken, refreshToken } from './lan-bridge-auth'
import type { ClientConnection } from './lan-bridge-types'
import { listConversations, searchConversationMessages, getConversationMessages } from '../conversation-manager'
import { listAgentSessions, searchAgentSessionMessages, getAgentSessionMessages, createAgentSession } from '../agent-session-manager'
import { listAgentWorkspaces } from '../agent-workspace-manager'
import { isAgentSessionActive, runAgentHeadless, stopAgent } from '../agent-service'
import { getSettings } from '../settings-service'
import { listChannels } from '../channel-manager'
import { sendMessage as chatSendMessage, stopGeneration as chatStopGeneration, type ChatStreamEvent } from '../chat-service'
import { getSessionManager } from './lan-bridge'

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
  if (!pin || !verifyPin(pin)) {
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
  return { conversations: listConversations() }
}

function handleConversationMessages(client: ClientConnection, data: Record<string, unknown>) {
  requireAuth(client, data)
  const conversationId = data.conversationId as string
  if (!conversationId) {
    throw Object.assign(new Error('conversationId required'), { errorCode: 'VALIDATION_ERROR' })
  }
  const allMessages = getConversationMessages(conversationId)
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
    for (const r of await searchConversationMessages(query)) {
      results.push({ id: r.conversationId, title: r.conversationTitle ?? '', snippet: r.snippet, type: 'chat', matchedAt: now })
    }
  }
  if (!sessionType || sessionType === 'agent') {
    for (const r of await searchAgentSessionMessages(query)) {
      results.push({ id: r.sessionId, title: r.sessionTitle ?? '', snippet: r.snippet, type: 'agent', matchedAt: now })
    }
  }
  return { results }
}

function handleAgentSessions(client: ClientConnection, data: Record<string, unknown>) {
  requireAuth(client, data)
  const sessions = listAgentSessions()
  return { sessions }
}

function handleAgentSessionMessages(client: ClientConnection, data: Record<string, unknown>) {
  requireAuth(client, data)
  const sessionId = data.sessionId as string
  if (!sessionId) {
    throw Object.assign(new Error('sessionId required'), { errorCode: 'VALIDATION_ERROR' })
  }
  const allMessages = getAgentSessionMessages(sessionId)
  const limit = typeof data.limit === 'number' ? data.limit : 100
  const messages = limit > 0 ? allMessages.slice(-limit) : allMessages
  return { messages, total: allMessages.length }
}

function handleAgentSearch(client: ClientConnection, data: Record<string, unknown>) {
  requireAuth(client, data)
  const query = data.query as string
  if (!query) {
    throw Object.assign(new Error('Query required'), { errorCode: 'VALIDATION_ERROR' })
  }
  const results = searchAgentSessionMessages(query)
  return { results }
}

function handleWorkspaces(client: ClientConnection, data: Record<string, unknown>) {
  requireAuth(client, data)
  return { workspaces: listAgentWorkspaces() }
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
  const workspaceId = (data.workspaceId as string | undefined) || getSettings().agentWorkspaceId
  const session = createAgentSession(title, undefined, workspaceId)

  // 通知桌面端刷新会话列表（复用 TITLE_UPDATED 通道，与飞书 Bridge 保持一致）
  const win = BrowserWindow.getAllWindows()[0]
  if (win && !win.isDestroyed()) {
    win.webContents.send(AGENT_IPC_CHANNELS.TITLE_UPDATED, {
      sessionId: session.id,
      title: session.title,
    })
  }

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

  if (isAgentSessionActive(sessionId)) {
    throw Object.assign(new Error('Agent session is already running'), { errorCode: 'SESSION_ACTIVE' })
  }

  const settings = getSettings()

  const permissionMode = data.permissionMode as string | undefined
  const validModes = ['auto', 'bypassPermissions', 'plan']
  const permissionModeOverride = (permissionMode && validModes.includes(permissionMode))
    ? permissionMode as 'auto' | 'bypassPermissions' | 'plan'
    : 'bypassPermissions' as const

  const input = {
    sessionId,
    userMessage,
    channelId: settings.agentChannelId || '',
    modelId: data.modelId as string | undefined || settings.agentModelId,
    workspaceId: (data.workspaceId as string | undefined) || settings.agentWorkspaceId,
    permissionModeOverride,
  };
  console.log(`[LAN Bridge] agent.send 开始: sessionId=${sessionId.slice(0, 12)} channelId=${settings.agentChannelId || '(空)'}`);
  const pushToSubs = (msg: object) => {
    const mgr = getSessionManager()
    if (!mgr) return
    for (const c of mgr.getSubscribers(sessionId)) {
      mgr.send(c, msg)
    }
  };
  runAgentHeadless(input, {
    onError: (err) => {
      console.error(`[LAN Bridge] agent.send error:`, err)
      pushToSubs({ type: 'stream.error', data: { sessionId, error: err } })
      pushToSubs({ type: 'stream.complete', data: { sessionId } })
    },
    onComplete: () => {
      console.log(`[LAN Bridge] agent.send complete`)
      pushToSubs({ type: 'stream.complete', data: { sessionId } })
    },
    onTitleUpdated: (title) => {
      console.log(`[LAN Bridge] agent.send title:`, title)
      pushToSubs({ type: 'session.updated', data: { sessionId, title } })
    },
  }).catch((err: unknown) => {
    console.error(`[LAN Bridge] agent.send 异常:`, err)
    const errMsg = err instanceof Error ? err.message : String(err)
    pushToSubs({ type: 'stream.error', data: { sessionId, error: errMsg } })
    pushToSubs({ type: 'stream.complete', data: { sessionId } })
  });

  return { sent: true, sessionId }
}

function handleAgentStop(client: ClientConnection, data: Record<string, unknown>) {
  requireAuth(client, data)
  const sessionId = data.sessionId as string | undefined
  if (!sessionId) {
    throw Object.assign(new Error('sessionId required'), { errorCode: 'VALIDATION_ERROR' })
  }
  stopAgent(sessionId)
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

  const settings = getSettings()
  const channelId = data.channelId as string | undefined || settings.agentChannelId
  const modelId = data.modelId as string | undefined || settings.agentModelId
  if (!channelId || !modelId) {
    throw Object.assign(new Error('channelId and modelId required'), { errorCode: 'VALIDATION_ERROR' })
  }

  const pushToSubs = (event: ChatStreamEvent) => {
    const mgr = getSessionManager()
    if (!mgr) return
    let wsType = ''
    let wsData: Record<string, unknown> = { conversationId }
    switch (event.type) {
      case 'chunk':
        wsType = 'stream.chunk'
        wsData = { conversationId, text: event.delta ?? '' }
        break
      case 'reasoning':
        wsType = 'stream.reasoning'
        wsData = { conversationId, text: event.delta ?? '' }
        break
      case 'complete':
        wsType = 'stream.complete'
        break
      case 'error':
        wsType = 'stream.error'
        wsData = { conversationId, error: event.error }
        break
      default:
        return
    }
    for (const c of mgr.getSubscribers(conversationId)) {
      mgr.send(c, { type: wsType, data: wsData })
    }
  }

  const history = getConversationMessages(conversationId)

  // 获取 webContents 用于 sendMessage 签名（实际走 onEvent 回调，不使用 webContents）
  const win = BrowserWindow.getAllWindows()[0]

  chatSendMessage(
    {
      conversationId,
      userMessage,
      messageHistory: history,
      channelId,
      modelId,
    },
    win?.webContents ?? null,
    pushToSubs,
  ).catch((err: unknown) => {
    const errMsg = err instanceof Error ? err.message : String(err)
    pushToSubs({ type: 'error', conversationId, error: errMsg })
    pushToSubs({ type: 'complete', conversationId, model: modelId })
  })

  return { sent: true, conversationId }
}

function handleConversationStop(client: ClientConnection, data: Record<string, unknown>) {
  requireAuth(client, data)
  const conversationId = data.conversationId as string | undefined
  if (!conversationId) {
    throw Object.assign(new Error('conversationId required'), { errorCode: 'VALIDATION_ERROR' })
  }
  chatStopGeneration(conversationId)
  return { stopped: true, conversationId }
}

// ===== 设置 =====

function handleSettingsGet(client: ClientConnection, data: Record<string, unknown>) {
  requireAuth(client, data)
  const settings = getSettings()
  let channelBaseUrl: string | null = null
  if (settings.agentChannelId) {
    const ch = listChannels().find(c => c.id === settings.agentChannelId)
    if (ch) channelBaseUrl = ch.baseUrl || null
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
  const channels = listChannels()
    .filter(c => c.enabled)
    .map(c => ({
      id: c.id,
      name: c.name,
      provider: c.provider,
      baseUrl: c.baseUrl,
      models: c.models.filter(m => m.enabled),
    }))
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

