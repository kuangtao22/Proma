import { AGENT_IPC_CHANNELS } from '@proma/shared'
import type {
  AgentSendInput,
  AgentSessionMeta,
  AgentStreamCompletePayload,
} from '@proma/shared'

export type AgentStreamCompletionDetails = Omit<
  AgentStreamCompletePayload,
  'sessionId' | 'triggeredBy'
>

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

export function buildAgentStreamCompletePayload(
  run: Readonly<Pick<AgentSendInput, 'sessionId' | 'triggeredBy'>>,
  details: AgentStreamCompletionDetails = {},
): AgentStreamCompletePayload {
  return {
    sessionId: run.sessionId,
    triggeredBy: run.triggeredBy,
    ...details,
  }
}

export function sendAgentStreamComplete(
  target: AgentStreamCompleteTarget,
  run: Readonly<Pick<AgentSendInput, 'sessionId' | 'triggeredBy'>>,
  details: AgentStreamCompletionDetails = {},
): void {
  target.send(
    AGENT_IPC_CHANNELS.STREAM_COMPLETE,
    buildAgentStreamCompletePayload(run, details),
  )
}
