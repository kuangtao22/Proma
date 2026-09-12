import { describe, expect, test } from 'bun:test'
import type { SDKAssistantMessage, SDKMessage, SDKResultMessage } from '@proma/shared'
import { groupIntoTurns } from '@proma/session-core'
import { resolveAgentTerminalNotice } from './agent-terminal-result'

/** 创建一条真实 Host 终态，覆盖历史重放与实时消息共同使用的字段。 */
function result(overrides: Partial<SDKResultMessage> = {}): SDKResultMessage {
  return {
    type: 'result',
    subtype: 'error_during_execution',
    terminal_reason: 'completion_blocked',
    errors: ['缺少可验证交付物'],
    session_id: 'session-1',
    ...overrides,
  }
}

/** 创建含已有错误横幅的助手消息，用于验证终态提示不会重复。 */
function assistantWithError(): SDKAssistantMessage {
  return {
    type: 'assistant',
    uuid: 'assistant-1',
    parent_tool_use_id: null,
    message: { content: [], model: 'test-model' },
    error: { message: '模型连接失败' },
  }
}

describe('Agent Host 终态提示', () => {
  test.each([
    ['completion_blocked', '交付检查尚未通过', '缺少可验证交付物'],
    ['completion_check_failed', '交付检查失败', '尚未确认交付完成'],
    ['completion_continuation_limit', '自动续行已达上限', '已执行 3 次'],
    ['completion_continuation_unavailable', '当前无法继续完成任务', '预算已耗尽'],
  ])('Given 助手正文可能声称成功 When Host 终态为 %s Then 显示准确宿主结论', (terminalReason, title, detail) => {
    expect(resolveAgentTerminalNotice([
      result({ terminal_reason: terminalReason, errors: [detail] }),
    ], [])).toEqual({
      kind: terminalReason === 'completion_check_failed' ? 'error' : 'blocked',
      title,
      detail,
    })
  })

  test('Given 普通执行失败且助手没有错误横幅 When 解析终态 Then 显示真实错误', () => {
    expect(resolveAgentTerminalNotice([
      result({ terminal_reason: 'provider_error', errors: ['上游连接中断'] }),
    ], [])).toEqual({
      kind: 'error',
      title: '任务异常结束',
      detail: '上游连接中断',
    })
  })

  test('Given 同一轮有多个结果 When 最终 Host 结果失败 Then 以最后终态为准', () => {
    expect(resolveAgentTerminalNotice([
      result({ subtype: 'success', terminal_reason: 'completed', errors: undefined }),
      result({ terminal_reason: 'completion_blocked', errors: ['终验记录不完整'] }),
    ], [])?.detail).toBe('终验记录不完整')
  })

  test('Given TaskUpdate 子阶段已 completed When 同轮最终 result 被 Host 阻塞 Then 总体仍显示未通过验收', () => {
    const messages: SDKMessage[] = [
      {
        type: 'user',
        parent_tool_use_id: null,
        message: { content: [{ type: 'text', text: '完成画布终验' }] },
      },
      {
        type: 'assistant',
        uuid: 'assistant-1',
        parent_tool_use_id: null,
        message: {
          content: [
            { type: 'tool_use', id: 'task-update-1', name: 'TaskUpdate', input: { status: 'completed' } },
            { type: 'text', text: '全镜终验通过' },
          ],
        },
      },
      {
        type: 'user',
        parent_tool_use_id: null,
        message: {
          content: [{
            type: 'tool_result',
            tool_use_id: 'task-update-1',
            content: JSON.stringify({ status: 'completed' }),
          }],
        },
      },
      result({ errors: ['交付合同登记晚于成果创建'] }),
    ]
    const turn = groupIntoTurns(messages).find((group) => group.type === 'assistant-turn')

    expect(turn?.type).toBe('assistant-turn')
    if (!turn || turn.type !== 'assistant-turn') throw new Error('缺少助手回合')
    expect(resolveAgentTerminalNotice(turn.turnMessages, turn.assistantMessages)).toEqual({
      kind: 'blocked',
      title: '交付检查尚未通过',
      detail: '交付合同登记晚于成果创建',
    })
  })

  test.each([
    ['普通成功', [result({ subtype: 'success', terminal_reason: 'completed', errors: undefined })], []],
    ['压缩内部结果', [result({ isSyntheticCompactionResult: true })], []],
    ['已有助手错误横幅', [result({ terminal_reason: 'provider_error' })], [assistantWithError()]],
  ] as const)('Given %s When 解析终态 Then 不重复显示失败提示', (_name, messages, assistants) => {
    expect(resolveAgentTerminalNotice(messages, assistants)).toBeNull()
  })
})
