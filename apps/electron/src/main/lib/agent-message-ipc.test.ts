import { describe, expect, test } from 'bun:test'
import type {
  AgentMessageInvokeResult,
  AgentQueueMessageInput,
  AgentSendInput,
  AgentSubmitOrEnqueueInput,
  AgentSubmitOrEnqueueResult,
} from '@proma/shared'
import { AGENT_IPC_CHANNELS } from '@proma/shared'
import type { IpcMainInvokeEvent } from 'electron'
import { prepareAgentCanvasMessageForSend } from './agent-canvas-message-preparation'
import { registerAgentMessageIpcHandlers } from './agent-message-ipc'

type CapturedHandler = (event: IpcMainInvokeEvent, input: never) => Promise<unknown>

/** 捕获生产注册函数交给 ipcMain 的真实 handler。 */
function createIpcCapture(): { handlers: Map<string, CapturedHandler>; handle: (channel: string, handler: CapturedHandler) => void } {
  const handlers = new Map<string, CapturedHandler>()
  return { handlers, handle: (channel, handler) => { handlers.set(channel, handler) } }
}

describe('Agent 消息真实 IPC handler', () => {
  test('Given 普通发送携带畸形引用 When 调用真实 handler Then 单次 prepare、resolver 零调用且零接管副作用', async () => {
    const ipc = createIpcCapture()
    let prepareCalls = 0
    let resolverCalls = 0
    let sideEffects = 0
    registerAgentMessageIpcHandlers({
      ipc,
      requireVisibleSession: () => ({ id: 'session-1' }),
      prepareRun: (input) => {
        prepareCalls += 1
        return prepareAgentCanvasMessageForSend(input, {}, {
          resolveForSend: () => { resolverCalls += 1; throw new Error('不应调用') },
        })
      },
      reserveStart: () => { sideEffects += 1; return () => undefined },
      startSessionMirrorRun: async () => { sideEffects += 1 },
      runPrepared: async () => { sideEffects += 1 },
      queueMessage: async () => 'queued',
      submitOrEnqueue: async () => ({ disposition: 'queued' }),
    })
    const handler = ipc.handlers.get(AGENT_IPC_CHANNELS.SEND_MESSAGE)!

    const result = await handler({ sender: {} } as IpcMainInvokeEvent, {
      sessionId: 'session-1', userMessage: '继续', channelId: 'channel-1',
      canvasNodeReferences: null,
    } as never) as AgentMessageInvokeResult<void>

    expect(prepareCalls).toBe(1)
    expect(resolverCalls).toBe(0)
    expect(sideEffects).toBe(0)
    expect(result).toEqual({
      ok: false,
      error: { code: 'CANVAS_REFERENCE_INVALID', message: '画布节点引用已失效，请重新选择后发送。' },
    })
    expect(JSON.stringify(result)).not.toContain('CANVAS_NODE_REFERENCES_INVALID')
  })

  test('Given queue-now 或 queue 输入 When 调用真实 handler Then 各委托一次并保留安全信封', async () => {
    const ipc = createIpcCapture()
    const calls: string[] = []
    registerAgentMessageIpcHandlers({
      ipc,
      requireVisibleSession: () => ({ id: 'session-1' }),
      prepareRun: (input) => ({ input, extensions: {}, references: undefined }),
      reserveStart: () => () => undefined,
      startSessionMirrorRun: async () => undefined,
      runPrepared: async () => undefined,
      queueMessage: async (_input: AgentQueueMessageInput) => { calls.push('queue'); return 'uuid-1' },
      submitOrEnqueue: async (_input: AgentSubmitOrEnqueueInput): Promise<AgentSubmitOrEnqueueResult> => {
        calls.push('submit')
        return { disposition: 'queued' }
      },
    })

    const queueResult = await ipc.handlers.get(AGENT_IPC_CHANNELS.QUEUE_MESSAGE)!(
      { sender: {} } as IpcMainInvokeEvent,
      { sessionId: 'session-1', userMessage: '追加' } as never,
    ) as AgentMessageInvokeResult<string>
    const submitResult = await ipc.handlers.get(AGENT_IPC_CHANNELS.SUBMIT_OR_ENQUEUE_MESSAGE)!(
      { sender: {} } as IpcMainInvokeEvent,
      { sessionId: 'session-1', queueMessageId: 'message-1', userMessage: '稍后', channelId: 'channel-1', dispatch: 'now' } as never,
    ) as AgentMessageInvokeResult<AgentSubmitOrEnqueueResult>

    expect(calls).toEqual(['queue', 'submit'])
    expect(queueResult).toEqual({ ok: true, value: 'uuid-1' })
    expect(submitResult).toEqual({ ok: true, value: { disposition: 'queued' } })
  })
})
