import { describe, expect, test } from 'bun:test'
import type { AgentStreamPayload } from '@proma/shared'
import * as mapper from './lan-bridge-event-mapper'

interface LanMessage {
  type: string
  data: Record<string, unknown>
}

describe('LAN Bridge Pi 增量事件映射', () => {
  test('将正文、思考和工具调用增量转换为移动端推送', () => {
    const mapPayload = (mapper as unknown as {
      mapAgentPayloadToLanMessages?: (sessionId: string, payload: AgentStreamPayload) => LanMessage[]
    }).mapAgentPayloadToLanMessages

    expect(typeof mapPayload).toBe('function')

    const messages = mapPayload?.('session-1', {
      kind: 'sdk_delta',
      delta: {
        uuid: 'assistant-1',
        deltas: [
          { type: 'text_delta', contentIndex: 0, delta: '正文' },
          { type: 'thinking_delta', contentIndex: 1, delta: '思考' },
          {
            type: 'toolcall_start',
            contentIndex: 2,
            toolCall: { id: 'tool-1', name: 'Read', arguments: { path: '/tmp/a' } },
          },
          { type: 'toolcall_delta', contentIndex: 2, delta: '{"path":' },
          {
            type: 'toolcall_end',
            contentIndex: 2,
            toolCall: { id: 'tool-1', name: 'Read', arguments: { path: '/tmp/a' } },
          },
        ],
      },
    })

    expect(messages).toEqual([
      { type: 'stream.chunk', data: { sessionId: 'session-1', text: '正文' } },
      { type: 'stream.reasoning', data: { sessionId: 'session-1', text: '思考' } },
      {
        type: 'stream.tool_start',
        data: { sessionId: 'session-1', toolUseId: 'tool-1', toolName: 'Read', toolInput: '{"path":"/tmp/a"}' },
      },
      {
        type: 'stream.tool_delta',
        data: { sessionId: 'session-1', toolInputDelta: '{"path":' },
      },
      {
        type: 'stream.tool_end',
        data: { sessionId: 'session-1', toolUseId: 'tool-1', toolName: 'Read', toolInput: '{"path":"/tmp/a"}' },
      },
    ])
  })
})
