import { describe, expect, test } from 'bun:test'
import type { AgentStreamEvent, SDKMessage } from '@proma/shared'
import { AgentStreamForwarder } from './agent-stream-forwarder'

/** 仅收集 main → renderer 的结果，不调用模型或持久化。 */
function forwardMessage(message: SDKMessage): AgentStreamEvent {
  /** 捕获同步终态消息，原消息对象继续归运行时所有。 */
  const delivered: AgentStreamEvent[] = []
  new AgentStreamForwarder().forward(
    { sessionId: 'session-1', payload: { kind: 'sdk_message', message } },
    (event) => delivered.push(event),
    true,
  )
  return delivered[0]!
}

describe('Agent 图片展示投影', () => {
  test('Given Pi 与旧格式工具图片 When 转发到界面 Then 不发送图片字节且保留原始运行消息', () => {
    /** 两种运行时图片格式共享相同的展示边界。 */
    const message = {
      type: 'user', uuid: 'result-1', parent_tool_use_id: null,
      message: { content: [{ type: 'tool_result', tool_use_id: 'read-1', content: [
        { type: 'text', text: '图片已读取' },
        { type: 'image', data: 'A'.repeat(400_000), mimeType: 'image/png' },
        { type: 'image', source: { type: 'base64', data: 'B'.repeat(400_000), media_type: 'image/jpeg' } },
      ], imageAttachments: [{ localPath: 'session/a.png', filename: 'a.png', mediaType: 'image/png' }] }] },
    } satisfies SDKMessage
    /** 原始序列化快照用于证明未影响模型输入及后续落盘。 */
    const original = JSON.stringify(message)
    /** Renderer 收到的是小型投影，文本、UUID 和图片附件仍然存在。 */
    const event = forwardMessage(message)
    expect(JSON.stringify(event).length).toBeLessThan(2_000)
    expect(event.payload.kind).toBe('sdk_message')
    if (event.payload.kind !== 'sdk_message') throw new Error('缺少消息')
    expect(event.payload.message).toMatchObject({
      uuid: 'result-1', message: { content: [{ tool_use_id: 'read-1', content: [
        { type: 'text', text: '图片已读取' },
        { type: 'image', mimeType: 'image/png', _promaDeferred: true, _originalLength: 400_000 },
        { type: 'image', mimeType: 'image/jpeg', _promaDeferred: true, _originalLength: 400_000 },
      ], imageAttachments: message.message.content[0]!.imageAttachments }] },
    })
    expect(JSON.stringify(message)).toBe(original)
  })

  test('Given 普通文字和工具参数 data 字段 When 转发 Then 复用原消息且不更改工具输入', () => {
    /** data 只有位于图片内容块时才允许投影。 */
    const message = { type: 'assistant', parent_tool_use_id: null, message: { content: [
      { type: 'tool_use', id: 'tool-1', name: 'Write', input: { type: 'image', data: '必须保留' } },
    ] } } satisfies SDKMessage
    /** 无图片路径应保持引用，避免为普通 token 增加对象复制。 */
    const event = forwardMessage(message)
    if (event.payload.kind !== 'sdk_message') throw new Error('缺少消息')
    expect(event.payload.message).toBe(message)
  })

  test('Given 顶层用户图片与远程图片 When 转发 Then 只延迟内嵌字节而保留远程引用', () => {
    /** 顶层图片与工具结果必须共用格式识别，URL 不是内嵌字节。 */
    const message = { type: 'user', parent_tool_use_id: null, message: { content: [
      { type: 'image', data: 'YWJj', mimeType: 'image/webp' },
      { type: 'image', source: { type: 'url', url: 'https://example.com/image.png' } },
    ] } } satisfies SDKMessage
    /** 验证原图引用没有被当作二进制裁掉。 */
    const event = forwardMessage(message)
    if (event.payload.kind !== 'sdk_message') throw new Error('缺少消息')
    expect(event.payload.message).toMatchObject({ message: { content: [
      { type: 'image', mimeType: 'image/webp', _promaDeferred: true, _originalLength: 4 },
      message.message.content[1],
    ] } })
    expect(JSON.stringify(event)).not.toContain('YWJj')
  })
})
