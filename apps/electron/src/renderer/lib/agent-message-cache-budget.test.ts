import { describe, expect, test } from 'bun:test'
import type { SDKMessage } from '@proma/shared'
import {
  estimateSDKMessageCacheBytes,
  setBoundedSDKMessageCache,
} from './agent-message-cache-budget'

/** 创建具有指定文本长度的最小 SDK 消息，供缓存预算边界测试复用。 */
function createTextMessage(length: number): SDKMessage {
  return {
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'x'.repeat(length) }] },
  } as SDKMessage
}

describe('Agent 历史消息缓存预算', () => {
  test('Given 嵌套工具图片数据超过预算 When 写入 Then 不缓存该单会话', () => {
    /** 模拟未投影的历史工具结果，数据位于嵌套数组中。 */
    const messages = [{
      type: 'user',
      message: {
        content: [{
          type: 'tool_result',
          content: [{ type: 'image', data: 'x'.repeat(400) }],
        }],
      },
    }] as SDKMessage[]

    const result = setBoundedSDKMessageCache(new Map(), 'large-session', messages, {
      maxEntries: 20,
      maxEstimatedBytes: 256,
    })

    expect(result.has('large-session')).toBe(false)
  })

  test('Given 嵌套 source 图片数据超过预算 When 写入 Then 不缓存该单会话', () => {
    /** 兼容旧 Anthropic 图片结构，source 比 Pi 图片结构多一层嵌套。 */
    const messages = [{
      type: 'user',
      message: {
        content: [{
          type: 'tool_result',
          content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x'.repeat(400) } }],
        }],
      },
    }] as SDKMessage[]

    const result = setBoundedSDKMessageCache(new Map(), 'legacy-image-session', messages, {
      maxEntries: 20,
      maxEstimatedBytes: 450,
    })

    expect(result.has('legacy-image-session')).toBe(false)
  })

  test('Given 重载已缓存会话 When 旧条目被替换 Then 只按新消息计量且维持 LRU 顺序', () => {
    /** 初始 A、B 都在缓存中，A 是较早访问的条目。 */
    const initial = setBoundedSDKMessageCache(new Map(), 'session-a', [createTextMessage(300)], {
      maxEntries: 2,
      maxEstimatedBytes: 2_000,
    })
    const withB = setBoundedSDKMessageCache(initial, 'session-b', [createTextMessage(300)], {
      maxEntries: 2,
      maxEstimatedBytes: 2_000,
    })

    /** A 换成小消息后成为最新项，再插入 C 应淘汰 B。 */
    const replacedA = setBoundedSDKMessageCache(withB, 'session-a', [createTextMessage(10)], {
      maxEntries: 2,
      maxEstimatedBytes: 2_000,
    })
    const result = setBoundedSDKMessageCache(replacedA, 'session-c', [createTextMessage(300)], {
      maxEntries: 2,
      maxEstimatedBytes: 2_000,
    })

    expect([...result.keys()]).toEqual(['session-a', 'session-c'])
  })

  test('Given Renderer 后续注入稳定键 When 再次估算 Then 内部字段不增加历史消息权重', () => {
    /** Renderer 会就地写入该字段以稳定列表 key。 */
    const message = createTextMessage(20) as SDKMessage & Record<string, unknown>
    const before = estimateSDKMessageCacheBytes(message)
    message._promaStableKey = 'stable-key-'.repeat(100)

    expect(estimateSDKMessageCacheBytes(message)).toBe(before)
  })

  test('Given 两个会话共享同一消息对象 When 写入 Then 正文权重只计一次', () => {
    /** 同一对象会在切换会话的视图合并路径被多处短暂引用。 */
    const shared = createTextMessage(300)
    const messageBytes = estimateSDKMessageCacheBytes(shared)
    const limits = { maxEntries: 20, maxEstimatedBytes: messageBytes + 96 }
    const first = setBoundedSDKMessageCache(new Map(), 'session-a', [shared], limits)
    const result = setBoundedSDKMessageCache(first, 'session-b', [shared], limits)

    expect([...result.keys()]).toEqual(['session-a', 'session-b'])
  })
})
