import { describe, expect, test } from 'bun:test'
import { createStore } from 'jotai'
import type { AgentQueuedMessageStatus, CanvasNodeReference, SDKUserMessage } from '@proma/shared'
import type { QuotedSelection } from '@/atoms/preview-atoms'
import {
  agentCanvasNodeReferencesAtomFamily,
  agentPendingFilesAtomFamily,
  agentSessionDraftsAtom,
  agentSessionMessageQueueAtom,
  liveMessagesMapAtom,
} from '@/atoms/agent-atoms'
import { quotedSelectionMapAtom } from '@/atoms/preview-atoms'
import { createAgentQueuedMessage } from '@/lib/agent-message-queue'
import { applyAgentQueuedMessageStatus } from './useGlobalAgentListeners'

/** started-event 回归使用的完整 Canvas 引用快照。 */
const canvasReference: CanvasNodeReference = {
  projectId: 'project-1',
  canvasId: 'canvas-1',
  nodeId: 'node-1',
  nodeType: 'document',
  nodeRevision: 7,
  title: '需求说明 v7',
}

/** deferred 失败后应恢复的历史引用选区。 */
const queuedQuotedSelection: QuotedSelection = {
  text: '旧选区',
  filePath: '/tmp/old.ts',
  startLine: 2,
  endLine: 3,
  capturedAt: 100,
}

/** 用户在等待期间新建的选区，失败恢复不得覆盖。 */
const newerQuotedSelection: QuotedSelection = {
  text: '新选区',
  filePath: '/tmp/new.ts',
  startLine: 8,
  endLine: 9,
  capturedAt: 200,
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

    applyAgentQueuedMessageStatus(store, status)

    expect(store.get(agentSessionMessageQueueAtom).has('session-1')).toBe(false)
    const liveMessage = store.get(liveMessagesMapAtom).get('session-1')?.[0] as SDKUserMessage | undefined
    expect(liveMessage?._canvasNodeReferences).toEqual([canvasReference])
    expect(liveMessage?.message?.content).toEqual([{ type: 'text', text: '' }])
  })

  test('Given 后台 deferred 引用失效 When failed 状态到达两次 Then 恢复完整输入和旧选区且不重复', () => {
    const store = createStore()
    const queuedMessage = createAgentQueuedMessage('保留正文', 'message-failed', 100, queuedQuotedSelection, {
      attachments: [{ filename: 'brief.png', mediaType: 'image/png', size: 8, targetPath: '/tmp/brief.png' }],
      canvasNodeReferences: [canvasReference],
    })
    store.set(agentSessionMessageQueueAtom, new Map([['session-1', [queuedMessage]]]))
    store.set(agentSessionDraftsAtom, new Map([['session-1', '当前草稿']]))
    const status: AgentQueuedMessageStatus = {
      sessionId: 'session-1',
      messageId: queuedMessage.id,
      status: 'failed',
      error: { code: 'CANVAS_REFERENCE_INVALID', message: '画布节点引用已失效，请重新选择后发送。' },
    }

    applyAgentQueuedMessageStatus(store, status)
    applyAgentQueuedMessageStatus(store, status)

    expect(store.get(agentSessionMessageQueueAtom).has('session-1')).toBe(false)
    expect(store.get(agentSessionDraftsAtom).get('session-1')).toBe('当前草稿\n\n保留正文')
    expect(store.get(agentPendingFilesAtomFamily('session-1'))).toMatchObject([
      { filename: 'brief.png', sourcePath: '/tmp/brief.png' },
    ])
    expect(store.get(agentCanvasNodeReferencesAtomFamily('session-1'))).toEqual([canvasReference])
    expect(store.get(quotedSelectionMapAtom).get('session-1')).toEqual(queuedQuotedSelection)
  })

  test('Given 用户在 deferred 等待期间创建新选区 When 旧消息 failed 重复到达 Then 保留新选区', () => {
    const store = createStore()
    const queuedMessage = createAgentQueuedMessage(
      '旧消息',
      'message-with-old-selection',
      100,
      queuedQuotedSelection,
    )
    store.set(agentSessionMessageQueueAtom, new Map([['session-1', [queuedMessage]]]))
    store.set(quotedSelectionMapAtom, new Map([['session-1', newerQuotedSelection]]))
    const status: AgentQueuedMessageStatus = {
      sessionId: 'session-1',
      messageId: queuedMessage.id,
      status: 'failed',
      error: { code: 'CANVAS_REFERENCE_INVALID', message: '画布节点引用已失效，请重新选择后发送。' },
    }

    applyAgentQueuedMessageStatus(store, status)
    applyAgentQueuedMessageStatus(store, status)

    expect(store.get(quotedSelectionMapAtom).get('session-1')).toEqual(newerQuotedSelection)
    expect(store.get(agentSessionMessageQueueAtom).has('session-1')).toBe(false)
  })
})
