import { describe, expect, test } from 'bun:test'
import {
  parseAgentDeferredQueueMessageInput,
  parseAgentQueueMessageInput,
  parseAgentSendInput,
  parseAgentSubmitOrEnqueueInput,
} from './agent'
import type { CanvasNodeReference } from './canvas'
import type { SDKUserMessage } from './agent'

/** 测试使用的结构化 Canvas 节点引用。 */
const canvasNodeReference = {
  projectId: 'project-1',
  canvasId: 'canvas-1',
  nodeId: 'node-1',
  nodeType: 'document',
  nodeRevision: 3,
  title: '需求文档',
} satisfies CanvasNodeReference

describe('Agent Canvas 节点引用合同', () => {
  test('Given 普通发送与流式队列输入 When 严格解析 Then 保留结构化节点引用', () => {
    /** 普通发送输入必须使用公开字段名。 */
    const sendInput = parseAgentSendInput({
      sessionId: 'session-1', userMessage: '总结这个节点', channelId: 'channel-1',
      canvasNodeReferences: [canvasNodeReference],
    })
    /** 活跃 Agent 队列输入使用同一公开字段名。 */
    const queueInput = parseAgentQueueMessageInput({
      sessionId: 'session-1', userMessage: '继续处理',
      canvasNodeReferences: [canvasNodeReference],
    })

    expect(sendInput.canvasNodeReferences).toEqual([canvasNodeReference])
    expect(queueInput.canvasNodeReferences).toEqual([canvasNodeReference])
  })

  test('Given deferred 与原子提交输入 When 严格解析 Then 引用随消息进入后续发送路径', () => {
    /** deferred queue 必须保留首次提交时的节点 revision。 */
    const deferredInput = parseAgentDeferredQueueMessageInput({
      sessionId: 'session-1', userMessage: '稍后处理', channelId: 'channel-1',
      queueMessageId: 'queue-1', canvasNodeReferences: [canvasNodeReference],
    })
    /** 原子提交在 injected/queued 两个分支间共享同一引用事实。 */
    const submitInput = parseAgentSubmitOrEnqueueInput({
      ...deferredInput,
      dispatch: 'after_current',
    })

    expect(deferredInput.canvasNodeReferences).toEqual([canvasNodeReference])
    expect(submitInput.canvasNodeReferences).toEqual([canvasNodeReference])
  })

  test('Given 引用不是数组或包含非法字段 When 严格解析 Then fail closed', () => {
    /** 合法发送基线用于只改变引用载荷。 */
    const sendInput = {
      sessionId: 'session-1', userMessage: '总结', channelId: 'channel-1',
    }

    expect(() => parseAgentSendInput({ ...sendInput, canvasNodeReferences: canvasNodeReference })).toThrow()
    expect(() => parseAgentSendInput({
      ...sendInput,
      canvasNodeReferences: [{ ...canvasNodeReference, nodeRevision: -1 }],
    })).toThrow()
    expect(() => parseAgentQueueMessageInput({
      sessionId: 'session-1', userMessage: '继续',
      canvasNodeReferences: [{ ...canvasNodeReference, unknown: true }],
    })).toThrow()
    expect(() => parseAgentSendInput({ ...sendInput, internalPath: '/private/session.jsonl' })).toThrow()
    expect(() => parseAgentQueueMessageInput({
      sessionId: 'session-1', userMessage: '继续', internal: true,
    })).toThrow()
  })

  test('Given 普通无引用输入 When 严格解析 Then 保持向后兼容且不合成字段', () => {
    const sendInput = parseAgentSendInput({
      sessionId: 'session-1', userMessage: '普通消息', channelId: 'channel-1',
    })
    const queueInput = parseAgentQueueMessageInput({
      sessionId: 'session-1', userMessage: '普通队列消息',
    })

    expect('canvasNodeReferences' in sendInput).toBe(false)
    expect('canvasNodeReferences' in queueInput).toBe(false)
  })

  test('Given SDK 用户消息 When 持久化 Canvas 引用 Then 只使用 JSONL 私有字段名', () => {
    /** JSONL 消息使用私有字段，避免与发送 IPC 输入混淆。 */
    const message: SDKUserMessage = {
      type: 'user',
      parent_tool_use_id: null,
      _canvasNodeReferences: [canvasNodeReference],
    }

    expect(message._canvasNodeReferences).toEqual([canvasNodeReference])
    expect('canvasNodeReferences' in message).toBe(false)
  })
})
