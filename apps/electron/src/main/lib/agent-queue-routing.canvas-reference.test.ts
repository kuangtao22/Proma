import { describe, expect, test } from 'bun:test'
import type { AgentSubmitOrEnqueueInput } from '@proma/shared'
import { routeAgentSubmitOrEnqueue } from './agent-queue-routing'

/** 构造立即发送输入。 */
function createInput(): AgentSubmitOrEnqueueInput {
  return {
    sessionId: 'session-1', queueMessageId: 'message-1', userMessage: '继续',
    channelId: 'channel-1', dispatch: 'now',
  }
}

describe('Agent queue-now Canvas 引用路由', () => {
  test('Given resolver 抛出与 stale-active 文案相同的错误 When 路由 Then 仍拒绝且不入 deferred', async () => {
    let enqueued = 0
    const error = Object.assign(new Error('当前会话没有正在运行的 Agent'), { code: 'CANVAS_REFERENCE_INVALID' })

    await expect(routeAgentSubmitOrEnqueue(createInput(), {
      isActive: () => true,
      prepareNow: () => { throw error },
      injectPrepared: async () => undefined,
      enqueue: () => { enqueued += 1 },
      onStaleActive: () => undefined,
    })).rejects.toBe(error)
    expect(enqueued).toBe(0)
  })

  test('Given Pi 注入返回 stale-active When 路由 Then 才降级 deferred', async () => {
    let enqueued = 0
    const result = await routeAgentSubmitOrEnqueue(createInput(), {
      isActive: () => true,
      prepareNow: () => ({ prepared: true }),
      injectPrepared: async () => { throw new Error('当前会话没有正在运行的 Agent') },
      enqueue: () => { enqueued += 1 },
      onStaleActive: () => undefined,
    })

    expect(result).toEqual({ disposition: 'queued' })
    expect(enqueued).toBe(1)
  })
})
