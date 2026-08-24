import { BrowserWindow } from 'electron'
import { AGENT_IPC_CHANNELS } from '@proma/shared'
import {
  getConversationMessages,
  listConversations,
  searchConversationMessages,
} from '../conversation-manager'
import {
  createAgentSession,
  getAgentSessionMeta,
  getAgentSessionMessages,
  listVisibleAgentSessions,
  searchAgentSessionMessages,
  updateAgentSessionMeta,
} from '../agent-session-manager'
import { listAgentWorkspaces } from '../agent-workspace-manager'
import { isAgentSessionActive, runAgentHeadless, stopAgent } from '../agent-service'
import { getSettings } from '../settings-service'
import { listChannels } from '../channel-manager'
import {
  sendMessage as sendConversationMessage,
  stopGeneration as stopConversation,
} from '../chat-service'
import {
  createLanBridgePromaAdapter,
  type LanBridgePromaDependencies,
} from './lan-bridge-proma-adapter-core'
import {
  getAgentIslandSessionRuntimeStatus,
  markAgentIslandSessionViewed,
} from '../agent-island-service'

/** 默认依赖只在组合根绑定官方模块，handlers 不再承受上游签名变化。 */
const defaultDependencies: LanBridgePromaDependencies = {
  listConversations: () => listConversations(),
  getConversationMessages: (conversationId) => getConversationMessages(conversationId),
  searchConversationMessages: (query) => searchConversationMessages(query),
  listAgentSessions: () => listVisibleAgentSessions(),
  getAgentSessionMessages: (sessionId) => getAgentSessionMessages(sessionId),
  searchAgentSessionMessages: (query) => searchAgentSessionMessages(query),
  listAgentWorkspaces: () => listAgentWorkspaces(),
  createAgentSession: (title, channelId, workspaceId) => createAgentSession(title, channelId, workspaceId),
  isAgentSessionActive: (sessionId) => isAgentSessionActive(sessionId),
  getAgentSessionRuntimeStatus: (sessionId) => getAgentIslandSessionRuntimeStatus(sessionId),
  updateAgentSessionStarred: (sessionId) => {
    /** 星标沿用官方会话元数据原子更新路径。 */
    const current = getAgentSessionMeta(sessionId)
    if (!current) throw new Error('会话不存在')
    return updateAgentSessionMeta(sessionId, { starred: !current.starred })
  },
  markAgentSessionViewed: (sessionId) => markAgentIslandSessionViewed(sessionId),
  runAgentHeadless: (input, callbacks) => runAgentHeadless(input, callbacks),
  stopAgent: (sessionId) => stopAgent(sessionId),
  getSettings: () => getSettings(),
  listChannels: () => listChannels(),
  sendConversationMessage: (input, webContents, onEvent) => sendConversationMessage(input, webContents, onEvent),
  stopConversation: (conversationId) => stopConversation(conversationId),
  getPrimaryWebContents: () => BrowserWindow.getAllWindows()[0]?.webContents ?? null,
  notifyAgentTitleUpdated: (session) => {
    /** 首个可用窗口沿用原 handler 的桌面会话列表刷新语义。 */
    const window = BrowserWindow.getAllWindows()[0]
    if (window && !window.isDestroyed()) {
      window.webContents.send(AGENT_IPC_CHANNELS.TITLE_UPDATED, {
        sessionId: session.id,
        title: session.title,
      })
    }
  },
}

/** handlers 使用的默认 Adapter 单例。 */
export const lanBridgePromaAdapter = createLanBridgePromaAdapter(defaultDependencies)
