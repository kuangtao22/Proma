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
/** 当前 LAN Bridge 判断会话是否允许进入普通 Agent 推送的函数。 */
let agentSessionVisibilityReader: ((sessionId: string) => boolean) | null = null

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
  isAgentSessionVisible: (sessionId: string) => boolean,
): void {
  stopSubscription()
  runtimeStatusReader = readRuntimeStatus
  agentSessionVisibilityReader = isAgentSessionVisible
  unsubscribe = eventBus.on(handleAgentPayload)
}

/** 停止 EventBus 订阅 */
export function stopSubscription(): void {
  if (unsubscribe) {
    unsubscribe()
    unsubscribe = null
  }
  runtimeStatusReader = null
  agentSessionVisibilityReader = null
}

function handleAgentPayload(sessionId: string, payload: AgentStreamPayload): void {
  const manager = getSessionManager()
  if (!manager) return
  if (runtimeStatusReader && affectsAgentRuntimeStatus(payload)) {
    /** 等 EventBus 的同步监听器全部更新状态后再读取，避免得到前一阶段。 */
    queueMicrotask(() => {
      const currentManager = getSessionManager()
      const currentReader = runtimeStatusReader
      /** 微任务执行时重新取得当前会话可见性读取器，避免 Bridge 停止后使用旧引用。 */
      const currentVisibilityReader = agentSessionVisibilityReader
      if (!currentManager || !currentReader || !currentVisibilityReader) return
      try {
        if (!currentVisibilityReader(sessionId)) return
        currentManager.broadcast({
          type: 'agent.session.runtime_updated',
          data: {
            sessionId,
            runtimeStatus: currentReader(sessionId),
          },
        })
      } catch (error) {
        /** 异步订阅错误只能降级当前状态推送，不能升级为 Electron 主进程未捕获异常。 */
        console.error(`[LAN Bridge] 读取 Agent 会话运行状态失败: sessionId=${sessionId}`, error)
      }
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
