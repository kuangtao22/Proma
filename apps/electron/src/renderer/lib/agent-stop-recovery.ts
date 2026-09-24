import type { Store } from 'jotai/vanilla/store'
import type { AgentStopResult } from '@proma/shared'
import {
  agentMessageRefreshAtom,
  agentSessionStreamingStateAtomFamily,
} from '@/atoms/agent-atoms'
import { completePendingRequestSession } from './agent-pending-request-recovery'
import { recordAgentTerminalRun } from './agent-active-session-snapshot'

/**
 * 请求后台停止，并用明确的已停止回执恢复丢失终态的界面。
 * @param store 当前 Renderer 的状态容器。
 * @param sessionId 用户要求停止的会话。
 * @param stopAgent 原有停止 IPC；旧主进程可能返回 void，此时继续等待正常终态。
 * @returns 是否为同一轮运行恢复了已停止状态。
 */
export async function stopAgentWithRecovery(
  store: Store,
  sessionId: string,
  stopAgent: (sessionId: string) => Promise<AgentStopResult | void>,
): Promise<boolean> {
  /** 请求发出时的运行身份，不能拿旧回执清除新一轮。 */
  const stoppingRun = store.get(agentSessionStreamingStateAtomFamily(sessionId))
  /** 主进程确认的真实运行状态；仅接收请求不代表已停止。 */
  const result = await stopAgent(sessionId)
  if (result?.status !== 'stopped') return false
  /** IPC 等待期间可能已收到正常终态或新运行。 */
  const current = store.get(agentSessionStreamingStateAtomFamily(sessionId))
  if (!current || (!current.running && !current.backgroundWaiting)) return false
  if (current !== stoppingRun && (
    stoppingRun?.startedAt == null
    || current.startedAt !== stoppingRun.startedAt
    || current.runGeneration !== stoppingRun.runGeneration
  )) return false

  // 消息交接会清理展示状态，终态身份独立保留以拒绝迟到的运行快照。
  recordAgentTerminalRun(store, sessionId, current)
  store.set(agentSessionStreamingStateAtomFamily(sessionId), {
    ...current, running: false, backgroundWaiting: false, retrying: undefined,
  })
  // 与正常终态共用请求恢复器，让在途旧快照也知道本轮已结束。
  completePendingRequestSession(store, sessionId)
  store.set(agentMessageRefreshAtom, (previous) => {
    /** 让现有消息加载流程从 JSONL 接管最终消息，再正常回收流式状态。 */
    const next = new Map(previous)
    next.set(sessionId, (previous.get(sessionId) ?? 0) + 1)
    return next
  })
  return true
}
