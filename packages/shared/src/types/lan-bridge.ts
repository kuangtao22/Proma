/**
 * LAN Bridge — 局域网远程连接标准接口类型定义
 *
 * 基于 WebSocket 双向通信，支持 PIN 码认证、数据查询、实时订阅和 Agent 交互。
 * 配置持久化到 ~/.proma/lan-bridge.json。
 */

// ===== WS 消息格式 =====

/** WS 请求消息（客户端 → Proma） */
export interface LanBridgeRequest {
  /** 消息类型，如 'auth.pair', 'conversations.list' */
  type: string
  /** 请求 ID，用于匹配 request/response */
  id?: string
  /** 请求参数 */
  data?: Record<string, unknown>
}

/** WS 响应消息（Proma → 客户端） */
export interface LanBridgeResponse {
  /** 响应类型，与请求 type 一致 */
  type: string
  /** 对应请求的 ID */
  id?: string
  /** 是否成功 */
  ok: boolean
  /** 响应数据（成功时） */
  data?: unknown
  /** 错误信息（失败时） */
  error?: string
  /** 错误码 */
  errorCode?: LanBridgeErrorCode
}

/** WS 推送消息（Proma → 客户端，服务端主动） */
export interface LanBridgePush {
  /** 推送类型 */
  type: string
  /** 推送数据 */
  data: unknown
}

/** 错误码 */
export type LanBridgeErrorCode =
  | 'AUTH_REQUIRED'
  | 'AUTH_FAILED'
  | 'TOKEN_EXPIRED'
  | 'TOKEN_INVALID'
  | 'RATE_LIMITED'
  | 'PERMISSION_DENIED'
  | 'NOT_FOUND'
  | 'SESSION_ACTIVE'
  | 'VALIDATION_ERROR'
  | 'INTERNAL_ERROR'

// ===== 认证 =====

/** PIN 配对请求 */
export interface LanBridgeAuthPairInput {
  pin: string
}

/** PIN 配对响应 */
export interface LanBridgeAuthPairResult {
  token: string
  expiresIn: number
}

/** Token 验证请求 */
export interface LanBridgeAuthVerifyInput {
  token: string
}

/** Token 验证响应 */
export interface LanBridgeAuthVerifyResult {
  valid: boolean
}

/** Token 刷新请求 */
export interface LanBridgeAuthRefreshInput {
  token: string
}

/** Token 刷新响应 */
export interface LanBridgeAuthRefreshResult {
  token: string
  expiresIn: number
}

// ===== 数据查询 =====

/** 对话列表查询结果 */
export interface LanBridgeConversationsResult {
  conversations: import('./chat').ConversationMeta[]
}

/** 对话消息查询 */
export interface LanBridgeMessagesInput {
  token: string
  conversationId: string
  limit?: number
  before?: string
}

/** 对话消息查询结果 */
export interface LanBridgeMessagesResult {
  messages: unknown[]
  total: number
}

/** 搜索请求 */
export interface LanBridgeSearchInput {
  token: string
  query: string
  sessionType?: 'chat' | 'agent'
}

/** 搜索结果 */
export interface LanBridgeSearchResult {
  results: Array<{
    id: string
    title: string
    snippet: string
    type: 'chat' | 'agent'
    matchedAt: number
  }>
}

/** Agent 会话列表结果 */
export interface LanBridgeAgentSessionsResult {
  sessions: import('./agent').AgentSessionMeta[]
  workspaces: Array<{ id: string; name: string; slug: string }>
}

/** Agent 会话消息查询 */
export interface LanBridgeAgentMessagesInput {
  token: string
  sessionId: string
  limit?: number
}

/** Agent 消息查询结果 */
export interface LanBridgeAgentMessagesResult {
  messages: unknown[]
  total: number
}

/** 工作区列表结果 */
export interface LanBridgeWorkspacesResult {
  workspaces: Array<{ id: string; name: string; slug: string; createdAt: number }>
}

// ===== 交互 =====

/** 发送消息请求 */
export interface LanBridgeAgentSendInput {
  token: string
  sessionId: string
  userMessage: string
  workspaceId?: string
}

/** 停止 Agent 请求 */
export interface LanBridgeAgentStopInput {
  token: string
  sessionId: string
}

// ===== 订阅 =====

/** 订阅请求 */
export interface LanBridgeSubscribeInput {
  token: string
  sessionId: string
}

/** 取消订阅请求 */
export interface LanBridgeUnsubscribeInput {
  sessionId: string
}

// ===== 流式推送数据 =====

/** 流式文本片段 */
export interface LanBridgeStreamChunk {
  sessionId: string
  text: string
}

/** 流式思考片段 */
export interface LanBridgeStreamReasoning extends LanBridgeStreamChunk {}

/** 工具调用开始 */
export interface LanBridgeStreamToolStart {
  sessionId: string
  toolUseId?: string
  toolName: string
  toolInput?: string
}

/** 工具调用参数增量 */
export interface LanBridgeStreamToolDelta {
  sessionId: string
  toolInputDelta: string
}

/** 工具调用结束 */
export interface LanBridgeStreamToolEnd extends LanBridgeStreamToolStart {}

/** 流式完成 */
export interface LanBridgeStreamComplete {
  sessionId: string
}

/** 流式错误 */
export interface LanBridgeStreamError {
  sessionId: string
  error: string
}

/** 会话元数据变更 */
export interface LanBridgeSessionUpdated {
  sessionId: string
  title?: string
}

// ===== 配置 =====

/** LAN Bridge 配置（持久化到 ~/.proma/lan-bridge.json） */
export interface LanBridgeConfig {
  /** 是否启用 */
  enabled: boolean
  /** 监听端口 */
  port: number
  /** 最大连接数 */
  maxConnections: number
}

/** 默认配置 */
export const DEFAULT_LAN_BRIDGE_CONFIG: LanBridgeConfig = {
  enabled: false,
  port: 29888,
  maxConnections: 20,
}

// ===== 运行状态 =====

/** LAN Bridge 运行状态 */
export type LanBridgeStatus = 'stopped' | 'starting' | 'running' | 'error'

/** 已连接客户端信息 */
export interface LanBridgeClientInfo {
  id: string
  ip: string
  authenticated: boolean
  connectedAt: number
  subscriptions: string[]
}

/** LAN Bridge 完整运行时状态 */
export interface LanBridgeRuntimeState {
  status: LanBridgeStatus
  pin: string
  port: number
  localIp: string
  connectedClients: LanBridgeClientInfo[]
  errorMessage?: string
}

// ===== IPC 通道 =====

/** LAN Bridge IPC 通道 */
export const LAN_BRIDGE_IPC_CHANNELS = {
  /** 获取配置 */
  GET_CONFIG: 'lan-bridge:get-config',
  /** 更新配置 */
  UPDATE_CONFIG: 'lan-bridge:update-config',
  /** 获取运行时状态 */
  GET_STATUS: 'lan-bridge:get-status',
  /** 启动服务 */
  START: 'lan-bridge:start',
  /** 停止服务 */
  STOP: 'lan-bridge:stop',
  /** 获取当前 PIN 码 */
  GET_PIN: 'lan-bridge:get-pin',
  /** 刷新 PIN 码 */
  REFRESH_PIN: 'lan-bridge:refresh-pin',
  /** 状态变更推送 */
  STATUS_CHANGED: 'lan-bridge:status-changed',
  /** 连接列表变更推送 */
  CLIENTS_CHANGED: 'lan-bridge:clients-changed',
} as const
