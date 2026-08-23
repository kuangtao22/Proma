import type {
  AgentIslandPhase,
  LanBridgeAgentSessionRuntimeStatus,
} from '@proma/shared'

/** Agent Island 投影四态所需的最小内部快照。 */
export interface AgentIslandRuntimeState {
  phase: AgentIslandPhase
  unread: boolean
  attention?: boolean
}

/**
 * 将 Agent Island 的展示阶段投影为移动端稳定四态。
 *
 * @param session 主进程中的最小会话状态；缺失表示空闲
 * @returns LAN Bridge 对外使用的稳定运行状态
 */
export function projectAgentIslandRuntimeStatus(
  session: AgentIslandRuntimeState | undefined,
): LanBridgeAgentSessionRuntimeStatus {
  if (session?.phase === 'needs-interaction') return 'blocked'
  if (session?.phase === 'running') return 'running'
  if ((session?.phase === 'completed' || session?.phase === 'error') && session.unread) {
    return 'completed'
  }
  return 'idle'
}

/**
 * 清除完成或异常会话的未查看标记。
 *
 * @param session 主进程中的可变会话状态
 * @returns 状态确实发生变化时返回 true
 */
export function markAgentIslandRuntimeViewed(
  session: AgentIslandRuntimeState | undefined,
): boolean {
  if (!session || (session.phase !== 'completed' && session.phase !== 'error')) return false
  if (session.phase === 'completed' && !session.unread) return false
  if (!session.attention && !session.unread) return false
  session.unread = false
  session.attention = false
  return true
}
