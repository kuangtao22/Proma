import type { AgentStreamPayload } from '@proma/shared'

/** LAN Bridge 主动推送给移动端的消息。 */
export interface LanBridgeOutboundMessage {
  type: string
  data: Record<string, unknown>
}

/**
 * 将 Agent 运行时事件转换为 LAN Bridge 的稳定推送协议。
 *
 * @param sessionId Agent 会话 ID
 * @param payload Agent EventBus 原始事件
 * @returns 可直接通过 WebSocket 发送的消息列表
 */
export function mapAgentPayloadToLanMessages(
  sessionId: string,
  payload: AgentStreamPayload,
): LanBridgeOutboundMessage[] {
  if (payload.kind === 'sdk_delta') {
    const messages: LanBridgeOutboundMessage[] = []
    for (const delta of payload.delta.deltas) {
      switch (delta.type) {
        case 'text_delta':
          if (delta.delta) messages.push({ type: 'stream.chunk', data: { sessionId, text: delta.delta } })
          break
        case 'thinking_delta':
          if (delta.delta) messages.push({ type: 'stream.reasoning', data: { sessionId, text: delta.delta } })
          break
        case 'toolcall_start':
          if (delta.toolCall) {
            messages.push({
              type: 'stream.tool_start',
              data: {
                sessionId,
                toolUseId: delta.toolCall.id,
                toolName: delta.toolCall.name,
                toolInput: JSON.stringify(delta.toolCall.arguments ?? {}),
              },
            })
          }
          break
        case 'toolcall_delta':
          if (delta.delta) {
            messages.push({ type: 'stream.tool_delta', data: { sessionId, toolInputDelta: delta.delta } })
          }
          break
        case 'toolcall_end':
          messages.push({
            type: 'stream.tool_end',
            data: {
              sessionId,
              toolUseId: delta.toolCall.id,
              toolName: delta.toolCall.name,
              toolInput: JSON.stringify(delta.toolCall.arguments ?? {}),
            },
          })
          break
        default:
          break
      }
    }
    return messages
  }

  if (payload.kind === 'sdk_message') {
    if (payload.message.type !== 'result') return []
    return [{ type: 'stream.complete', data: { sessionId } }]
  }

  if (payload.event.type === 'title_updated') {
    return [{ type: 'session.updated', data: { sessionId, title: payload.event.title } }]
  }
  return []
}
