/**
 * LAN Bridge 实时订阅 — agentEventBus → WS 推送
 *
 * 订阅 agentEventBus 事件，将 Agent 流式输出推送给已订阅的 WS 客户端。
 */

import type { AgentStreamPayload } from '@proma/shared'
import type { AgentEventBus } from '../agent-event-bus'
import { getSessionManager } from './lan-bridge'
import { mapAgentPayloadToLanMessages } from './lan-bridge-event-mapper'

let unsubscribe: (() => void) | null = null

/** 启动 EventBus 订阅 */
export function startSubscription(eventBus: AgentEventBus): void {
  stopSubscription()
  unsubscribe = eventBus.on(handleAgentPayload)
}

/** 停止 EventBus 订阅 */
export function stopSubscription(): void {
  if (unsubscribe) {
    unsubscribe()
    unsubscribe = null
  }
}

function handleAgentPayload(sessionId: string, payload: AgentStreamPayload): void {
  const manager = getSessionManager()
  if (!manager) return
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
