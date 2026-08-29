import { describe, expect, test } from 'bun:test'
import type { AgentDeferredQueueMessageInput } from '@proma/shared'
import type { WebContents } from 'electron'
import { AgentQueueCoordinator } from './agent-queue-coordinator'

/** 构造 deferred 消息输入。 */
function createInput(): AgentDeferredQueueMessageInput {
  return {
    sessionId: 'session-1', queueMessageId: 'message-1', userMessage: '继续', channelId: 'channel-1',
  }
}

/** 构造未销毁的最小 WebContents。 */
function createWebContents(): WebContents {
  return { isDestroyed: () => false } as unknown as WebContents
}

describe('Agent deferred Canvas 引用接管', () => {
  test('Given 引用预解析失败 When 尝试启动 deferred Then 不发 started、不启动且保留队列', async () => {
    const started: string[] = []
    const runs: AgentDeferredQueueMessageInput[] = []
    const coordinator = new AgentQueueCoordinator({
      isActive: () => false,
      getWebContents: () => createWebContents(),
      prepareRun: () => { throw new Error('CANVAS_REFERENCE_INVALID') },
      startRun: async (prepared) => { runs.push(prepared.input) },
      sendStarted: (_webContents, status) => { started.push(status.messageId) },
      onPrepareError: () => undefined,
    })

    coordinator.enqueue(createInput())
    await Promise.resolve()

    expect(started).toEqual([])
    expect(runs).toEqual([])
    expect(coordinator.hasPending('session-1')).toBe(true)
  })

  test('Given 引用预解析成功 When 启动 deferred Then 恰好解析一次后再发布 started', async () => {
    const order: string[] = []
    let prepareCalls = 0
    const coordinator = new AgentQueueCoordinator({
      isActive: () => false,
      getWebContents: () => createWebContents(),
      prepareRun: (input) => {
        prepareCalls += 1
        order.push('prepare')
        return { input, extensions: {}, references: undefined }
      },
      startRun: async () => { order.push('run') },
      sendStarted: () => { order.push('started') },
      onPrepareError: () => undefined,
    })

    coordinator.enqueue(createInput())
    await Promise.resolve()

    expect(prepareCalls).toBe(1)
    expect(order).toEqual(['prepare', 'started', 'run'])
  })
})
