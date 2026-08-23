/**
 * LAN Bridge 实时订阅 — agentEventBus → WS 推送
 *
 * 订阅 agentEventBus 事件，将 Agent 流式输出推送给已订阅的 WS 客户端。
 */

import type {
  AgentStreamPayload,
  LanBridgeAgentSessionRuntimeStatus,
} from '@proma/shared'
import type { AgentEventBus } from '../agent-event-bus'
import { getSessionManager } from './lan-bridge'
import { mapAgentPayloadToLanMessages } from './lan-bridge-event-mapper'

let unsubscribe: (() => void) | null = null
/** 当前 LAN Bridge 用于读取主进程权威四态的函数。 */
let runtimeStatusReader: ((sessionId: string) => LanBridgeAgentSessionRuntimeStatus) | null = null

/** 判断事件是否可能改变会话四态，过滤 token 级高频增量。 */
function affectsAgentRuntimeStatus(payload: AgentStreamPayload): boolean {
  if (payload.kind === 'sdk_message') {
    return payload.message.type === 'result'
      || (payload.message.type === 'assistant' && Boolean(payload.message.error))
  }
  if (payload.kind !== 'proma_event') return false
  return [
    'permission_request',
    'ask_user_request',
    'exit_plan_mode_request',
    'permission_resolved',
    'ask_user_resolved',
    'exit_plan_mode_resolved',
    'run_started',
    'external_run_started',
    'run_resumed',
    'run_stopped',
    'retry',
  ].includes(payload.event.type)
}

/** 启动 EventBus 订阅 */
export function startSubscription(
  eventBus: AgentEventBus,
  readRuntimeStatus: (sessionId: string) => LanBridgeAgentSessionRuntimeStatus,
): void {
  stopSubscription()
  runtimeStatusReader = readRuntimeStatus
  unsubscribe = eventBus.on(handleAgentPayload)
}

/** 停止 EventBus 订阅 */
export function stopSubscription(): void {
  if (unsubscribe) {
    unsubscribe()
    unsubscribe = null
  }
  runtimeStatusReader = null
}

function handleAgentPayload(sessionId: string, payload: AgentStreamPayload): void {
  const manager = getSessionManager()
  if (!manager) return
  if (runtimeStatusReader && affectsAgentRuntimeStatus(payload)) {
    /** 等 EventBus 的同步监听器全部更新状态后再读取，避免得到前一阶段。 */
    queueMicrotask(() => {
      const currentManager = getSessionManager()
      const currentReader = runtimeStatusReader
      if (!currentManager || !currentReader) return
      currentManager.broadcast({
        type: 'agent.session.runtime_updated',
        data: {
          sessionId,
          runtimeStatus: currentReader(sessionId),
        },
      })
    })
  }
  const subscribers = manager.getSubscribers(sessionId)
  if (subscribers.length === 0) return

  for (const message of mapAgentPayloadToLanMessages(sessionId, payload)) {
    broadcastTo(subscribers, message)
  }
}

function broadcastTo(clients: Array<{ ws: { send: (data: string) => void; readyState: number } }>, message: object): void {
  const data = JSON.stringify(message)
  for (const client of clients) {
    if (client.ws.readyState === 1) {
      client.ws.send(data)
    }
  }
}
