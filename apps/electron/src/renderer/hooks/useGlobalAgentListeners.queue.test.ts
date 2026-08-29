import { describe, expect, test } from 'bun:test'
import { createStore } from 'jotai'
import type { AgentQueuedMessageStatus, CanvasNodeReference, SDKUserMessage } from '@proma/shared'
import {
  agentSessionMessageQueueAtom,
  liveMessagesMapAtom,
} from '@/atoms/agent-atoms'
import { createAgentQueuedMessage } from '@/lib/agent-message-queue'
import { applyAgentQueuedMessageStartedStatus } from './useGlobalAgentListeners'

/** started-event 回归使用的完整 Canvas 引用快照。 */
const canvasReference: CanvasNodeReference = {
  projectId: 'project-1',
  canvasId: 'canvas-1',
  nodeId: 'node-1',
  nodeType: 'document',
  nodeRevision: 7,
  title: '需求说明 v7',
}

describe('全局 Agent listener 的 after-current started 投影', () => {
  test('Given refs-only 队列项 When started 事件移除队列 Then optimistic 用户消息保留引用快照', () => {
    const store = createStore()
    const queuedMessage = createAgentQueuedMessage('', 'message-refs-only', 100, null, {
      canvasNodeReferences: [canvasReference],
    })
    store.set(agentSessionMessageQueueAtom, new Map([
      ['session-1', [queuedMessage]],
    ]))
    const status: AgentQueuedMessageStatus = {
      sessionId: 'session-1',
      messageId: queuedMessage.id,
      status: 'started',
      userMessage: '',
      rawUserMessage: '',
      startedAt: 200,
    }

    applyAgentQueuedMessageStartedStatus(store, status)

    expect(store.get(agentSessionMessageQueueAtom).has('session-1')).toBe(false)
    const liveMessage = store.get(liveMessagesMapAtom).get('session-1')?.[0] as SDKUserMessage | undefined
    expect(liveMessage?._canvasNodeReferences).toEqual([canvasReference])
    expect(liveMessage?.message?.content).toEqual([{ type: 'text', text: '' }])
  })
})
