import { AGENT_IPC_CHANNELS } from '@proma/shared'
import type {
  AgentSendInput,
  AgentSessionMeta,
  AgentStreamErrorPayload,
  AgentStreamCompletePayload,
  AgentStreamSessionMeta,
} from '@proma/shared'

type AgentStreamCompletionPayloadDetails = Omit<
  AgentStreamCompletePayload,
  'sessionId' | 'triggeredBy'
>

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

/** 使用与 completion 相同的公开元数据构造流式错误载荷。 */
export function buildAuthoritativeAgentStreamErrorPayload(
  sessionId: string,
  error: string,
  getSession: (sessionId: string) => AgentSessionMeta | undefined,
): AgentStreamErrorPayload {
  return { sessionId, error, session: selectAgentCompletionSessionMeta(sessionId, getSession) }
}

function buildAgentStreamCompletePayload(
  run: Readonly<Pick<AgentSendInput, 'sessionId' | 'triggeredBy'>>,
  details: AgentStreamCompletionPayloadDetails = {},
): AgentStreamCompletePayload {
  return {
    sessionId: run.sessionId,
    triggeredBy: run.triggeredBy,
    ...details,
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
  run: Readonly<Pick<AgentSendInput, 'sessionId' | 'triggeredBy'>>,
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
