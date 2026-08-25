import { mock } from 'bun:test'
import type { AgentSessionMeta, SDKMessage } from '@proma/shared'

/** Agent 会话管理器共享测试替身状态，避免 Bun 进程级 mock.module 相互覆盖。 */
class AgentSessionManagerTestMock {
  /** 当前测试可见的权威会话索引。 */
  readonly sessions = new Map<string, AgentSessionMeta>()
  /** 当前测试创建过的会话 ID。 */
  readonly createdSessionIds: string[] = []
  /** 自动生成会话 ID 的前缀。 */
  sessionIdPrefix = 'created'
  /** 可选元数据读取覆盖，仅供需要独立变量驱动的调度器测试。 */
  getSessionMetaOverride?: (sessionId: string) => AgentSessionMeta | undefined
  /** 可选 SDK 消息读取覆盖，用于计数或注入历史消息。 */
  getAgentSessionSDKMessagesOverride?: (sessionId: string) => SDKMessage[]

  /** 恢复共享替身的空白状态。 */
  reset(): void {
    this.sessions.clear()
    this.createdSessionIds.length = 0
    this.sessionIdPrefix = 'created'
    this.getSessionMetaOverride = undefined
    this.getAgentSessionSDKMessagesOverride = undefined
  }
}

export const agentSessionManagerTestMock = new AgentSessionManagerTestMock()

/** 判断测试会话是否属于普通用户入口。 */
function isVisible(session: AgentSessionMeta): boolean {
  return session.sourceDesignProjectId === undefined
    && session.sourceDesignJobId === undefined
    && session.sourceCanvasProjectId === undefined
    && session.sourceCanvasId === undefined
    && session.sourceCanvasNodeId === undefined
}

mock.module('./agent-session-manager', () => ({
  listAgentSessions: () => Array.from(agentSessionManagerTestMock.sessions.values()),
  listVisibleAgentSessions: () => Array.from(agentSessionManagerTestMock.sessions.values()).filter(isVisible),
  getAgentSessionMeta: (sessionId: string) => agentSessionManagerTestMock.getSessionMetaOverride?.(sessionId)
    ?? agentSessionManagerTestMock.sessions.get(sessionId),
  createAgentSession: (title: string, channelId: string, workspaceId?: string, modelId?: string) => {
    const id = `${agentSessionManagerTestMock.sessionIdPrefix}-${agentSessionManagerTestMock.createdSessionIds.length + 1}`
    const created: AgentSessionMeta = {
      id,
      title,
      channelId,
      modelId,
      workspaceId,
      createdAt: 1,
      updatedAt: 1,
    }
    agentSessionManagerTestMock.sessions.set(id, created)
    agentSessionManagerTestMock.createdSessionIds.push(id)
    return created
  },
  updateAgentSessionMeta: (sessionId: string, updates: Partial<AgentSessionMeta>) => {
    const session = agentSessionManagerTestMock.sessions.get(sessionId)
    if (session) agentSessionManagerTestMock.sessions.set(sessionId, { ...session, ...updates })
  },
  getAgentSessionMessages: () => [],
  getAgentSessionSDKMessages: (sessionId: string) => agentSessionManagerTestMock.getAgentSessionSDKMessagesOverride?.(sessionId) ?? [],
}))
