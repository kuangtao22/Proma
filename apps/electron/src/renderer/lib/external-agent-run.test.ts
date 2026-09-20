import { describe, expect, test } from 'bun:test'
import type { SDKMessage } from '@proma/shared'
import { appendExternalAgentRunUserMessage, shouldActivateExternalAgentRun } from './external-agent-run'

describe('外部输入的实时消息投影', () => {
  test('Given 已持久化的外部原文 When 启动事件到达 Then 立即追加相同 UUID 的用户消息', () => {
    /** 事件沿用持久化身份，不能生成新的展示 UUID。 */
    const event = { userMessage: '原始问题\n<attached_files>图.png</attached_files>', userMessageUuid: 'user-1', startedAt: 123 }
    /** 原消息数组不能被原地修改，以便 Jotai 正确传播更新。 */
    const previous: SDKMessage[] = []
    expect(appendExternalAgentRunUserMessage(previous, event)).toEqual([{
      type: 'user', uuid: 'user-1', parent_tool_use_id: null,
      message: { content: [{ type: 'text', text: event.userMessage }] },
      _createdAt: 123, _promaLiveRunStartedAt: 123,
    }])
    expect(previous).toEqual([])
  })

  test('Given 同一启动事件重复到达 When 追加实时消息 Then 不重复消息也不触发数组更新', () => {
    /** 同一 UUID 的回执代表同一条已持久化用户输入。 */
    const event = { userMessage: '原文', userMessageUuid: 'user-1', startedAt: 123 }
    /** 首次投影供重复派发复用。 */
    const previous = appendExternalAgentRunUserMessage([], event)
    expect(appendExternalAgentRunUserMessage(previous, event)).toBe(previous)
  })

  test.each([{ startedAt: 123 }, { userMessage: '旧协议', startedAt: 123 }, { userMessageUuid: 'user-1', startedAt: 123 }])(
    'Given 不含完整持久化身份的旧事件 When 投影 Then 保留原消息引用',
    (event) => {
      /** 不完整事件不能伪造或覆盖用户输入。 */
      const previous: SDKMessage[] = []
      expect(appendExternalAgentRunUserMessage(previous, event)).toBe(previous)
    },
  )

  test('Given 运行已结束或更高代次已经开始 When 收到迟到事件 Then 不允许恢复旧运行', () => {
    expect(shouldActivateExternalAgentRun({ running: false, startedAt: 123, runGeneration: 2 }, 123, 2)).toBe(false)
    expect(shouldActivateExternalAgentRun({ running: true, startedAt: 456, runGeneration: 3 }, 123, 2)).toBe(false)
  })
})
