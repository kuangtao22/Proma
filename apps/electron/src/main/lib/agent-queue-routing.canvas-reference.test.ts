import { describe, expect, test } from 'bun:test'
import type { AgentSubmitOrEnqueueInput } from '@proma/shared'
import {
  createAgentQueueNowInput,
  prepareAgentCanvasMessageForSend,
} from './agent-canvas-message-preparation'
import { routeAgentSubmitOrEnqueue } from './agent-queue-routing'

/** 构造立即发送输入。 */
function createInput(): AgentSubmitOrEnqueueInput {
  return {
    sessionId: 'session-1', queueMessageId: 'message-1', userMessage: '继续',
    channelId: 'channel-1', dispatch: 'now',
  }
}

describe('Agent queue-now Canvas 引用路由', () => {
  test('Given 活跃会话的普通无引用消息 When 经 service queue-now 转换并注入 Then 保持字段缺失且 resolver 零调用', async () => {
    let resolverCalls = 0
    let injected = 0

    const result = await routeAgentSubmitOrEnqueue(createInput(), {
      isActive: () => true,
      prepareNow: (candidate) => prepareAgentCanvasMessageForSend(
        createAgentQueueNowInput(candidate),
        {},
        { resolveForSend: () => { resolverCalls += 1; throw new Error('不应调用') } },
      ),
      injectPrepared: async () => { injected += 1 },
      enqueue: () => { throw new Error('不应排队') },
      onStaleActive: () => undefined,
    })

    expect(result).toEqual({ disposition: 'injected' })
    expect(resolverCalls).toBe(0)
    expect(injected).toBe(1)
  })

  test('Given queue-now 显式携带 undefined 引用 When 经 service 转换 Then 保留畸形字段并稳定拒绝', async () => {
    let resolverCalls = 0
    let injected = 0
    const malformedInput = { ...createInput(), canvasNodeReferences: undefined }

    await expect(routeAgentSubmitOrEnqueue(malformedInput, {
      isActive: () => true,
      prepareNow: (candidate) => prepareAgentCanvasMessageForSend(
        createAgentQueueNowInput(candidate),
        {},
        { resolveForSend: () => { resolverCalls += 1; throw new Error('不应调用') } },
      ),
      injectPrepared: async () => { injected += 1 },
      enqueue: () => { throw new Error('不应排队') },
      onStaleActive: () => undefined,
    })).rejects.toMatchObject({ code: 'CANVAS_REFERENCE_INVALID' })

    expect(resolverCalls).toBe(0)
    expect(injected).toBe(0)
  })

  test('Given resolver 抛出与 stale-active 文案相同的错误 When 路由 Then 仍拒绝且不入 deferred', async () => {
    let enqueued = 0
    let prepareCalls = 0
    const error = Object.assign(new Error('当前会话没有正在运行的 Agent'), { code: 'CANVAS_REFERENCE_INVALID' })

    await expect(routeAgentSubmitOrEnqueue(createInput(), {
      isActive: () => true,
      prepareNow: () => { prepareCalls += 1; throw error },
      injectPrepared: async () => undefined,
      enqueue: () => { enqueued += 1 },
      onStaleActive: () => undefined,
    })).rejects.toBe(error)
    expect(prepareCalls).toBe(1)
    expect(enqueued).toBe(0)
  })

  test('Given Pi 注入返回 stale-active When 路由 Then 才降级 deferred', async () => {
    let enqueued = 0
    let prepareCalls = 0
    const result = await routeAgentSubmitOrEnqueue(createInput(), {
      isActive: () => true,
      prepareNow: () => { prepareCalls += 1; return { prepared: true } },
      injectPrepared: async () => { throw new Error('当前会话没有正在运行的 Agent') },
      enqueue: () => { enqueued += 1 },
      onStaleActive: () => undefined,
    })

    expect(result).toEqual({ disposition: 'queued' })
    expect(prepareCalls).toBe(1)
    expect(enqueued).toBe(1)
  })
})
