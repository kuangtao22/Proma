import { describe, expect, test } from 'bun:test'
import { AGENT_IPC_CHANNELS } from '@proma/shared'
import { invokeAgentMessage, unwrapAgentMessageInvokeResult } from './agent-message-preload'

describe('Agent 消息 Preload 公开错误', () => {
  test('Given 主进程拒绝 Canvas 引用 When unwrap Then Promise 以稳定 code/message 拒绝', async () => {
    const promise = unwrapAgentMessageInvokeResult(Promise.resolve({
      ok: false as const,
      error: { code: 'CANVAS_REFERENCE_INVALID' as const, message: '画布节点引用已失效，请重新选择后发送。' },
    }))

    await expect(promise).rejects.toMatchObject({
      code: 'CANVAS_REFERENCE_INVALID',
      message: '画布节点引用已失效，请重新选择后发送。',
    })
  })

  test('Given IPC 成功信封 When invoke Then 使用真实通道和输入并返回 value', async () => {
    const calls: Array<{ channel: string; input: unknown }> = []
    const input = { sessionId: 'session-1', userMessage: '继续' }
    const value = await invokeAgentMessage<string>({
      invoke: async (channel, actualInput) => {
        calls.push({ channel, input: actualInput })
        return { ok: true, value: 'uuid-1' }
      },
    }, AGENT_IPC_CHANNELS.QUEUE_MESSAGE, input)

    expect(value).toBe('uuid-1')
    expect(calls).toEqual([{ channel: AGENT_IPC_CHANNELS.QUEUE_MESSAGE, input }])
  })

  test('Given 畸形引用输入收到稳定失败信封 When invoke Then 保留公开 code 并拒绝', async () => {
    const malformed = { sessionId: 'session-1', userMessage: '继续', canvasNodeReferences: null }
    const promise = invokeAgentMessage({
      invoke: async (_channel, input) => {
        expect(input).toBe(malformed)
        return {
          ok: false,
          error: { code: 'CANVAS_REFERENCE_INVALID', message: '画布节点引用已失效，请重新选择后发送。' },
        }
      },
    }, AGENT_IPC_CHANNELS.QUEUE_MESSAGE, malformed)

    await expect(promise).rejects.toMatchObject({
      message: '画布节点引用已失效，请重新选择后发送。',
      code: 'CANVAS_REFERENCE_INVALID',
    })
  })
})
