import { describe, expect, test } from 'bun:test'
import type { AgentDeferredQueueMessageInput, AgentQueuedMessageStatus } from '@proma/shared'
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
  test('Given 空闲会话首次接管引用失败 When enqueue Then 同步抛出且不留幽灵队列', () => {
    const statuses: string[] = []
    const runs: AgentDeferredQueueMessageInput[] = []
    const error = new Error('CANVAS_REFERENCE_INVALID')
    const coordinator = new AgentQueueCoordinator({
      isActive: () => false,
      getWebContents: () => createWebContents(),
      prepareRun: () => { throw error },
      startRun: async (prepared) => { runs.push(prepared.input) },
      sendStatus: (_webContents, status) => { statuses.push(status.status) },
      onPrepareError: () => ({ code: 'CANVAS_REFERENCE_INVALID', message: '画布节点引用已失效，请重新选择后发送。' }),
    })

    expect(() => coordinator.enqueue(createInput())).toThrow(error)

    expect(statuses).toEqual([])
    expect(runs).toEqual([])
    expect(coordinator.hasPending('session-1')).toBe(false)
  })

  test('Given 已接管队首后来引用失效 When 后台调度 Then 发布 failed 并继续有效后续项', async () => {
    let active = true
    const statuses: AgentQueuedMessageStatus[] = []
    const runs: AgentDeferredQueueMessageInput[] = []
    const coordinator = new AgentQueueCoordinator({
      isActive: () => active,
      getWebContents: () => createWebContents(),
      prepareRun: (input) => {
        if (input.queueMessageId === 'message-1') throw new Error('CANVAS_REFERENCE_INVALID')
        return { input, extensions: {}, references: undefined }
      },
      startRun: async (prepared) => { runs.push(prepared.input) },
      sendStatus: (_webContents, status) => { statuses.push(status) },
      onPrepareError: () => ({ code: 'CANVAS_REFERENCE_INVALID', message: '画布节点引用已失效，请重新选择后发送。' }),
    })

    coordinator.enqueue(createInput())
    coordinator.enqueue({ ...createInput(), queueMessageId: 'message-2' })
    active = false
    coordinator.onRunComplete('session-1', undefined, false, false)
    await Promise.resolve()

    expect(statuses[0]).toEqual({
      sessionId: 'session-1',
      messageId: 'message-1',
      status: 'failed',
      error: { code: 'CANVAS_REFERENCE_INVALID', message: '画布节点引用已失效，请重新选择后发送。' },
    })
    expect(statuses[1]).toMatchObject({ messageId: 'message-2', status: 'started' })
    expect(JSON.stringify(statuses[0])).not.toContain('cause')
    expect(runs.map((input) => input.queueMessageId)).toEqual(['message-2'])
    expect(coordinator.hasPending('session-1')).toBe(false)
  })

  test('Given 旧 deferred 等待窗口后失效 When 新消息触发调度 Then 旧项 failed 且新项不替旧项背锅', async () => {
    let webContents: WebContents | null = null
    const statuses: AgentQueuedMessageStatus[] = []
    const runs: string[] = []
    const coordinator = new AgentQueueCoordinator({
      isActive: () => false,
      getWebContents: () => webContents,
      prepareRun: (input) => {
        if (input.queueMessageId === 'message-1') throw new Error('CANVAS_REFERENCE_INVALID')
        return { input, extensions: {}, references: undefined }
      },
      startRun: async (prepared) => { runs.push(prepared.input.queueMessageId) },
      sendStatus: (_webContents, status) => { statuses.push(status) },
      onPrepareError: () => ({ code: 'CANVAS_REFERENCE_INVALID', message: '画布节点引用已失效，请重新选择后发送。' }),
    })

    coordinator.enqueue(createInput())
    webContents = createWebContents()
    expect(() => coordinator.enqueue({ ...createInput(), queueMessageId: 'message-2' })).not.toThrow()
    await Promise.resolve()

    expect(statuses.map((status) => [status.messageId, status.status])).toEqual([
      ['message-1', 'failed'],
      ['message-2', 'started'],
    ])
    expect(runs).toEqual(['message-2'])
    expect(coordinator.hasPending('session-1')).toBe(false)
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
      sendStatus: () => { order.push('started') },
      onPrepareError: () => ({ code: 'CANVAS_REFERENCE_INVALID', message: '画布节点引用已失效，请重新选择后发送。' }),
    })

    coordinator.enqueue(createInput())
    await Promise.resolve()

    expect(prepareCalls).toBe(1)
    expect(order).toEqual(['prepare', 'started', 'run'])
  })
})
