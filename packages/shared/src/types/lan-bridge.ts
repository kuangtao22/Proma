/**
 * LAN Bridge — 局域网远程连接标准接口类型定义
 *
 * 基于 WebSocket 双向通信，支持 PIN 码认证、数据查询、实时订阅和 Agent 交互。
 * 配置持久化到 ~/.proma/lan-bridge.json。
 */

/** 当前 LAN Bridge 协议主版本。 */
export const LAN_BRIDGE_PROTOCOL_VERSION = 2

/** 客户端与服务端当前可协商的最低协议主版本。 */
export const LAN_BRIDGE_MIN_PROTOCOL_VERSION = 2

/** 客户端与服务端当前可协商的最高协议主版本。 */
export const LAN_BRIDGE_MAX_PROTOCOL_VERSION = LAN_BRIDGE_PROTOCOL_VERSION

/** 当前服务端稳定支持的 LAN Bridge 能力集合。 */
export const LAN_BRIDGE_CAPABILITIES = [
  'pin-pairing',
  'pairing-ticket',
  'device-revocation',
  'streaming',
  'connection-recovery',
] as const

/** LAN Bridge 可协商能力。 */
export type LanBridgeCapability = typeof LAN_BRIDGE_CAPABILITIES[number]

/** WebSocket 远端客户端可实际调用或依赖的能力集合。 */
export const LAN_BRIDGE_WS_CAPABILITIES = [
  'pin-pairing',
  'pairing-ticket',
  'streaming',
  'connection-recovery',
] as const satisfies readonly LanBridgeCapability[]

/** WebSocket 连接建立后的协议协商信息。 */
export interface LanBridgeConnectedPayload {
  message: string
  protocolVersion: number
  minProtocolVersion: number
  maxProtocolVersion: number
  serverVersion: string
  capabilities: LanBridgeCapability[]
}

/** 客户端在提交认证材料前声明的协议支持范围。 */
export interface LanBridgeProtocolHelloInput {
  minProtocolVersion: number
  maxProtocolVersion: number
}

/** 服务端确认的协议主版本和本连接可用能力。 */
export interface LanBridgeProtocolHelloResult {
  protocolVersion: number
  capabilities: LanBridgeCapability[]
}

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
  | 'DEVICE_REVOKED'
  | 'PAIRING_TICKET_INVALID'
  | 'PAIRING_TICKET_EXPIRED'
  | 'PROTOCOL_UNSUPPORTED'
  | 'CONNECTION_LOST'
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

/** 一次性配对票据认证请求。 */
export interface LanBridgeAuthPairTicketInput {
  ticket: string
  deviceName: string
}

/** 一次性配对票据认证响应。 */
export interface LanBridgeAuthPairTicketResult {
  token: string
  expiresIn: number
  deviceId: string
}

// ===== 数据查询 =====

/** LAN Bridge 对外暴露的稳定对话摘要。 */
export interface LanBridgeConversationDto {
  id: string
  title: string
  /** 是否置顶。 */
  pinned?: boolean
  /** 是否归档。 */
  archived?: boolean
  createdAt: number
  updatedAt: number
}

/** LAN Bridge 对外暴露的稳定 Agent 会话摘要。 */
export interface LanBridgeAgentSessionDto {
  id: string
  title: string
  workspaceId?: string
  /** 是否置顶。 */
  pinned?: boolean
  /** 是否归档。 */
  archived?: boolean
  /** 是否标记为手动工作中。 */
  manualWorking?: boolean
  createdAt: number
  updatedAt: number
}

/** 对话列表查询结果 */
export interface LanBridgeConversationsResult {
  conversations: LanBridgeConversationDto[]
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
  sessions: LanBridgeAgentSessionDto[]
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

// ===== 配对与设备管理 IPC =====

/** 已配对设备的安全元数据，不包含 Token、票据或签名凭据。 */
export interface LanBridgeDeviceDto {
  id: string
  name: string
  createdAt: number
  lastSeenAt: number
  tokenVersion: number
  revokedAt?: number
}

/** 获取配对二维码请求；当前无需传入参数。 */
export type LanBridgeGetPairingQrRequest = Record<string, never>

/** 获取配对二维码响应。 */
export interface LanBridgeGetPairingQrResponse {
  qrCodeData: string
  expiresAt: number
}

/** 查询已配对设备请求。 */
export interface LanBridgeListDevicesRequest {
  /** 是否包含已撤销设备，默认不包含。 */
  includeRevoked?: boolean
}

/** 查询已配对设备响应。 */
export interface LanBridgeListDevicesResponse {
  devices: LanBridgeDeviceDto[]
}

/** 撤销设备请求。 */
export interface LanBridgeRevokeDeviceRequest {
  deviceId: string
}

/** 撤销设备响应。 */
export interface LanBridgeRevokeDeviceResponse {
  revoked: boolean
  device: LanBridgeDeviceDto
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
  /** 获取一次性配对二维码 */
  GET_PAIRING_QR: 'lan-bridge:get-pairing-qr',
  /** 查询已配对设备 */
  LIST_DEVICES: 'lan-bridge:list-devices',
  /** 撤销已配对设备 */
  REVOKE_DEVICE: 'lan-bridge:revoke-device',
  /** 状态变更推送 */
  STATUS_CHANGED: 'lan-bridge:status-changed',
  /** 连接列表变更推送 */
  CLIENTS_CHANGED: 'lan-bridge:clients-changed',
} as const
