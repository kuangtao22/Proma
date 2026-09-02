import { AGENT_IPC_CHANNELS } from '@proma/shared'
import type {
  AgentSendInput,
  AgentSessionMeta,
  AgentStreamErrorPayload,
  AgentStreamCompletePayload,
  AgentStreamSessionMeta,
  PromaEvent,
} from '@proma/shared'

type AgentStreamCompletionPayloadDetails = Omit<
  AgentStreamCompletePayload,
  'sessionId' | 'triggeredBy'
>
type AgentRunIdentity = Readonly<Pick<AgentSendInput, 'sessionId' | 'triggeredBy'> & { runGeneration?: number }>

/** completion producer 可提供的业务字段；session 必须由主进程权威索引注入。 */
export type AgentStreamCompletionDetails = Omit<AgentStreamCompletionPayloadDetails, 'session'>

export interface AgentStreamCompleteTarget {
  send(channel: string, payload: AgentStreamCompletePayload): void
}

/**
 * 从主进程权威 session 索引选择 completion 可公开的轻量 metadata。
 * @param sessionId completion 对应的会话 ID。
 * @param getSession 主进程权威 session getter，禁止替换为 Renderer 输入。
 * @returns 不含 Pi entry 映射的公开会话 metadata；会话不存在时返回 undefined。
 */
export function selectAgentCompletionSessionMeta(
  sessionId: string,
  getSession: (sessionId: string) => AgentSessionMeta | undefined,
): AgentStreamSessionMeta | undefined {
  const session = getSession(sessionId)
  if (!session) return undefined
  /** 只先建立全部会话共有字段，其余可选字段逐项复制。 */
  const meta: AgentStreamSessionMeta = {
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  }
  if (session.workspaceId !== undefined) meta.workspaceId = session.workspaceId
  if (session.sourceAutomationId !== undefined) meta.sourceAutomationId = session.sourceAutomationId
  if (session.sourceDesignProjectId !== undefined) meta.sourceDesignProjectId = session.sourceDesignProjectId
  if (session.sourceDesignJobId !== undefined) meta.sourceDesignJobId = session.sourceDesignJobId
  if (session.sourceCanvasProjectId !== undefined) meta.sourceCanvasProjectId = session.sourceCanvasProjectId
  if (session.sourceCanvasId !== undefined) meta.sourceCanvasId = session.sourceCanvasId
  if (session.sourceCanvasNodeId !== undefined) meta.sourceCanvasNodeId = session.sourceCanvasNodeId
  if (session.automationGraduated !== undefined) meta.automationGraduated = session.automationGraduated
  if (session.parentSessionId !== undefined) meta.parentSessionId = session.parentSessionId
  if (session.rootSessionId !== undefined) meta.rootSessionId = session.rootSessionId
  if (session.sourceDelegationId !== undefined) meta.sourceDelegationId = session.sourceDelegationId
  if (session.delegationRole !== undefined) meta.delegationRole = session.delegationRole
  if (session.delegationStatus !== undefined) meta.delegationStatus = session.delegationStatus
  if (session.delegationDepth !== undefined) meta.delegationDepth = session.delegationDepth
  if (session.delegationGoal !== undefined) meta.delegationGoal = session.delegationGoal
  return meta
}

/**
 * 构造携带主进程权威轻量 metadata 的 run_started 事件。
 * @param sessionId 已由 Orchestrator 准入的会话 ID。
 * @param startedAt 本轮权威运行代次。
 * @param getSession 主进程权威 session getter。
 * @returns 不暴露路径或运行时存储字段的启动事件。
 */
export function buildAuthoritativeAgentRunStartedEvent(
  sessionId: string,
  startedAt: number,
  getSession: (sessionId: string) => AgentSessionMeta | undefined,
): Extract<PromaEvent, { type: 'run_started' }> {
  return {
    type: 'run_started',
    startedAt,
    session: selectAgentCompletionSessionMeta(sessionId, getSession),
  }
}

/** 使用与 completion 相同的公开元数据构造流式错误载荷。 */
export function buildAuthoritativeAgentStreamErrorPayload(
  sessionId: string,
  error: string,
  getSession: (sessionId: string) => AgentSessionMeta | undefined,
  startedAt?: number,
): AgentStreamErrorPayload {
  return {
    sessionId,
    error,
    ...(startedAt !== undefined ? { startedAt } : {}),
    session: selectAgentCompletionSessionMeta(sessionId, getSession),
  }
}

function buildAgentStreamCompletePayload(
  run: AgentRunIdentity,
  details: AgentStreamCompletionPayloadDetails = {},
): AgentStreamCompletePayload {
  const { runGeneration, ...otherDetails } = details
  return {
    sessionId: run.sessionId,
    triggeredBy: run.triggeredBy,
    ...otherDetails,
    ...(runGeneration != null ? { runGeneration } : run.runGeneration != null ? { runGeneration: run.runGeneration } : {}),
  }
}

/**
 * 使用主进程权威 session 索引构造 completion payload。
 * @param run completion 对应的运行身份。
 * @param getSession 主进程权威 session getter。
 * @param details completion 的业务终态字段。
 * @returns 始终经过轻量 metadata 选择器的 completion payload。
 */
export function buildAuthoritativeAgentStreamCompletePayload(
  run: AgentRunIdentity,
  getSession: (sessionId: string) => AgentSessionMeta | undefined,
  details: AgentStreamCompletionDetails = {},
): AgentStreamCompletePayload {
  return buildAgentStreamCompletePayload(run, {
    ...details,
    session: selectAgentCompletionSessionMeta(run.sessionId, getSession),
  })
}

/**
 * 向目标 Renderer 发送带权威轻量 metadata 的 completion。
 * @param target Electron webContents 兼容发送目标。
 * @param run completion 对应的运行身份。
 * @param getSession 主进程权威 session getter。
 * @param details completion 的业务终态字段。
 */
export function sendAuthoritativeAgentStreamComplete(
  target: AgentStreamCompleteTarget,
  run: Readonly<Pick<AgentSendInput, 'sessionId' | 'triggeredBy'>>,
  getSession: (sessionId: string) => AgentSessionMeta | undefined,
  details: AgentStreamCompletionDetails = {},
): void {
  target.send(
    AGENT_IPC_CHANNELS.STREAM_COMPLETE,
    buildAuthoritativeAgentStreamCompletePayload(run, getSession, details),
  )
}
