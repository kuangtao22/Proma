import type { AgentSessionMeta, AgentToolMode, ServerOpsConnectionDraft } from '@proma/shared'
import { isOrdinaryTopLevelAgentSession } from '../agent-session-visibility'
import { serverOpsConnectionDraftStore } from './server-ops-connection-draft-store'

/** Pi 只能提交公开连接参数，真实会话与运行身份由宿主闭包提供。 */
export interface ServerOpsConnectionDraftAgent {
  prepare(input: unknown, signal?: AbortSignal): ServerOpsConnectionDraft
}

/** 创建入口需要的可信身份与可替换测试依赖。 */
interface ServerOpsConnectionDraftAgentInput {
  sessionId: string
  toolMode: AgentToolMode
  triggeredBy?: 'user' | 'automation' | 'delegation' | 'external'
  getSession: (id: string) => AgentSessionMeta | undefined
  runSignal: AbortSignal
  assertRunActive: () => void
  /** 测试替换内存写入，生产沿用唯一草稿 Store。 */
  prepare?: (sessionId: string, input: unknown) => ServerOpsConnectionDraft
}

/** 只为普通用户会话构建内存草稿入口；每次调用重新检查会话与本轮生命周期。 */
export function createServerOpsConnectionDraftAgent(input: ServerOpsConnectionDraftAgentInput): ServerOpsConnectionDraftAgent | null {
  if (input.toolMode !== 'standard' || (input.triggeredBy !== undefined && input.triggeredBy !== 'user')) return null
  /** 会话归档、委派及隐藏会话不得借已有闭包生成草稿。 */
  const allowed = (): boolean => {
    const session = input.getSession(input.sessionId)
    return isOrdinaryTopLevelAgentSession(session) && !session?.archived
  }
  if (!allowed()) return null
  return {
    prepare(value, signal) {
      if (input.runSignal.aborted || signal?.aborted) throw new Error('SERVER_OPS_AGENT_RUN_CANCELLED')
      input.assertRunActive()
      if (!allowed()) throw new Error('SERVER_OPS_AGENT_SESSION_NOT_ALLOWED')
      return input.prepare
        ? input.prepare(input.sessionId, value)
        : serverOpsConnectionDraftStore.prepare(input.sessionId, value)
    },
  }
}
