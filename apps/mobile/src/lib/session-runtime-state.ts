import type { ConvItem } from '../atoms'

/** 手机端支持的 Agent 会话稳定四态。 */
export type AgentRuntimeStatus = 'idle' | 'running' | 'blocked' | 'completed'

/** 单个 Agent 运行状态推送的安全结构。 */
export interface AgentRuntimeUpdate {
  sessionId: string
  runtimeStatus: AgentRuntimeStatus
}

/** 单个 Agent 星标响应的安全结构。 */
export interface AgentStarUpdate {
  sessionId: string
  starred: boolean
}

/**
 * 规范化服务端运行状态，未知新值按空闲兼容。
 *
 * @param value LAN Bridge 返回的未知状态值
 * @returns 手机端可安全渲染的四态
 */
export function normalizeAgentRuntimeStatus(value: unknown): AgentRuntimeStatus {
  return value === 'running' || value === 'blocked' || value === 'completed'
    ? value
    : 'idle'
}

/** 判断当前 Agent 状态是否仍可由用户停止。 */
export function isAgentRuntimeBusy(status: AgentRuntimeStatus | undefined): boolean {
  return status === 'running' || status === 'blocked'
}

/**
 * 规范化重连或刷新得到的 Agent 会话快照。
 *
 * @param session 服务端返回的 Agent 会话
 * @returns 状态与星标均可稳定渲染的会话
 */
export function normalizeAgentSessionSnapshot(session: ConvItem): ConvItem {
  return {
    ...session,
    runtimeStatus: normalizeAgentRuntimeStatus(session.runtimeStatus),
    starred: Boolean(session.starred),
  }
}

/**
 * 校验 WebSocket 运行状态推送并规范化四态。
 *
 * @param data 未知的推送数据
 * @returns 有效的状态更新；结构无效时返回 null
 */
export function readAgentRuntimeUpdate(data: unknown): AgentRuntimeUpdate | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null
  /** 推送字段在结构校验后再读取，避免不可信数据污染状态。 */
  const record = data as Record<string, unknown>
  if (typeof record.sessionId !== 'string' || typeof record.runtimeStatus !== 'string') return null
  return {
    sessionId: record.sessionId,
    runtimeStatus: normalizeAgentRuntimeStatus(record.runtimeStatus),
  }
}

/**
 * 校验星标命令响应，只提取界面需要的确认结果。
 *
 * @param data 未知的命令响应
 * @returns 有效的星标更新；结构无效时返回 null
 */
export function readAgentStarUpdate(data: unknown): AgentStarUpdate | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null
  /** 星标响应由 session 对象承载。 */
  const session = (data as Record<string, unknown>).session
  if (typeof session !== 'object' || session === null || Array.isArray(session)) return null
  /** 只接受稳定 ID 和布尔值，拒绝隐式类型转换。 */
  const record = session as Record<string, unknown>
  if (typeof record.id !== 'string' || typeof record.starred !== 'boolean') return null
  return { sessionId: record.id, starred: record.starred }
}

/**
 * 合并单个 Agent 会话的实时状态。
 *
 * @param conversations 当前权威会话列表
 * @param sessionId 需要更新的 Agent 会话 ID
 * @param runtimeStatus 新的稳定四态
 * @returns 有变化时返回新数组，否则保留原引用
 */
export function updateAgentRuntimeStatus(
  conversations: ConvItem[],
  sessionId: string,
  runtimeStatus: AgentRuntimeStatus,
): ConvItem[] {
  /** 记录本次是否命中真实变化，避免无效重渲染。 */
  let changed = false
  /** 仅替换目标 Agent，Chat 即使 ID 相同也保持不变。 */
  const updated = conversations.map((conversation) => {
    if (conversation.type !== 'agent' || conversation.id !== sessionId) return conversation
    if (conversation.runtimeStatus === runtimeStatus) return conversation
    changed = true
    return { ...conversation, runtimeStatus }
  })
  return changed ? updated : conversations
}

/**
 * 合并单个 Agent 会话的星标响应。
 *
 * @param conversations 当前权威会话列表
 * @param sessionId 需要更新的 Agent 会话 ID
 * @param starred 服务端确认后的星标值
 * @returns 有变化时返回新数组，否则保留原引用
 */
export function updateAgentStarred(
  conversations: ConvItem[],
  sessionId: string,
  starred: boolean,
): ConvItem[] {
  /** 记录目标星标是否实际变化。 */
  let changed = false
  /** 只修改 Agent 类型，保持其他列表项结构共享。 */
  const updated = conversations.map((conversation) => {
    if (conversation.type !== 'agent' || conversation.id !== sessionId) return conversation
    if (!!conversation.starred === starred) return conversation
    changed = true
    return { ...conversation, starred }
  })
  return changed ? updated : conversations
}

/**
 * 合并当前 Agent 会话的实时状态。
 *
 * @param active 当前会话
 * @param sessionId 需要更新的 Agent 会话 ID
 * @param runtimeStatus 新的稳定四态
 * @returns 命中且变化时的新会话，否则保留原引用
 */
export function updateActiveAgentRuntimeStatus(
  active: ConvItem | null,
  sessionId: string,
  runtimeStatus: AgentRuntimeStatus,
): ConvItem | null {
  if (!active || active.type !== 'agent' || active.id !== sessionId) return active
  if (active.runtimeStatus === runtimeStatus) return active
  return { ...active, runtimeStatus }
}

/**
 * 合并当前 Agent 会话的星标状态。
 *
 * @param active 当前会话
 * @param sessionId 需要更新的 Agent 会话 ID
 * @param starred 服务端确认后的星标值
 * @returns 命中且变化时的新会话，否则保留原引用
 */
export function updateActiveAgentStarred(
  active: ConvItem | null,
  sessionId: string,
  starred: boolean,
): ConvItem | null {
  if (!active || active.type !== 'agent' || active.id !== sessionId) return active
  if (Boolean(active.starred) === starred) return active
  return { ...active, starred }
}
