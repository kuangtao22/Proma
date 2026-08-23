import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import type { AgentStreamPayload } from '@proma/shared'
import { AgentEventBus } from '../agent-event-bus'
import * as mapper from './lan-bridge-event-mapper'

interface LanMessage {
  type: string
  data: Record<string, unknown>
}

/** 订阅模块的运行时接口，动态导入可在测试中隔离 LAN Server。 */
type SubscriptionModule = typeof import('./lan-bridge-subscription')

/** 全局状态广播记录。 */
const broadcastMessages: LanMessage[] = []
/** 会话订阅正文记录。 */
const subscriberMessages: LanMessage[] = []
/** 测试用会话管理器只实现订阅模块依赖的方法。 */
const fakeManager = {
  broadcast: (message: object) => broadcastMessages.push(message as LanMessage),
  getSubscribers: () => [{
    ws: {
      readyState: 1,
      send: (message: string) => subscriberMessages.push(JSON.parse(message) as LanMessage),
    },
  }],
}

mock.module('./lan-bridge', () => ({
  getSessionManager: () => fakeManager,
}))

let subscription: SubscriptionModule

beforeAll(async () => {
  subscription = await import('./lan-bridge-subscription')
})

afterAll(() => {
  subscription.stopSubscription()
})

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

  test('状态事件向所有认证客户端广播且正文仍保持会话订阅隔离', async () => {
    /** 每个用例清空可观察输出，避免前序断言污染。 */
    broadcastMessages.length = 0
    subscriberMessages.length = 0
    /** 真实事件总线用于验证订阅注册与异步状态读取。 */
    const eventBus = new AgentEventBus()

    subscription.startSubscription(eventBus, () => 'blocked')
    eventBus.emit('session-1', {
      kind: 'proma_event',
      event: { type: 'run_started', startedAt: 1 },
    })
    await Promise.resolve()

    expect(broadcastMessages).toEqual([{
      type: 'agent.session.runtime_updated',
      data: { sessionId: 'session-1', runtimeStatus: 'blocked' },
    }])
    expect(subscriberMessages).toEqual([])

    eventBus.emit('session-1', {
      kind: 'sdk_delta',
      delta: {
        uuid: 'assistant-1',
        deltas: [{ type: 'text_delta', contentIndex: 0, delta: '正文' }],
      },
    })
    await Promise.resolve()

    expect(broadcastMessages).toHaveLength(1)
    expect(subscriberMessages).toEqual([{
      type: 'stream.chunk',
      data: { sessionId: 'session-1', text: '正文' },
    }])
  })
})
