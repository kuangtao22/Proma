import { AGENT_IPC_CHANNELS } from '@proma/shared'
import type {
  AgentSendInput,
  AgentSessionMeta,
  AgentStreamCompletePayload,
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
): AgentSessionMeta | undefined {
  const session = getSession(sessionId)
  if (!session) return undefined
  const { piEntryBindings: _piEntryBindings, ...meta } = session
  return meta
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
