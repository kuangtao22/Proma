import { describe, expect, test } from 'bun:test'
import { unwrapAgentMessageInvokeResult } from './agent-message-preload'

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
})
