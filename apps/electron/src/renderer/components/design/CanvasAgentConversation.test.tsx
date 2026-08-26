import * as React from 'react'
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { Provider, createStore } from 'jotai'
import type { CanvasAgentMessagesResult } from '@proma/shared'
import {
  CanvasAgentConversation,
  createCanvasAgentConversationController,
  getCanvasAgentConversationErrorMessage,
} from './CanvasAgentConversation'
import { CanvasPublicOperationError } from '@/lib/design-adapter'
import {
  canvasAgentLifecycleAtom,
  canvasAgentOwnersAtom,
  canvasAgentPersistedMessagesAtom,
  canvasAgentRunningSessionIdsAtom,
} from '../../atoms/native-canvas-atoms'

/** 创建公开消息加载结果。 */
function createResult(): CanvasAgentMessagesResult {
  return {
    sessionId: 'session-1',
    owner: { projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'node-1', title: '研究 Agent' },
    messages: [],
  }
}

describe('Canvas Agent 对话', () => {
  test('Given API 异常含内部正文 When 生成界面错误 Then 只保留固定公开文案', () => {
    const internalError = new Error(
      'Error invoking remote method /Users/name 11111111-1111-4111-8111-111111111111',
    )

    expect(getCanvasAgentConversationErrorMessage('load', internalError)).toBe('对话暂时无法加载。')
    expect(getCanvasAgentConversationErrorMessage('send', internalError)).toBe('发送失败，请重试。')
    expect(getCanvasAgentConversationErrorMessage('stop', internalError)).toBe('停止失败，请重试。')
  })

  test('Given Adapter 已提供公开错误 When 生成界面错误 Then 允许显示共享安全文案', () => {
    const publicError = new CanvasPublicOperationError(
      'CANVAS_AGENT_SEND_FAILED',
      '消息发送失败，请重试。',
    )

    expect(getCanvasAgentConversationErrorMessage('send', publicError))
      .toBe('消息发送失败，请重试。')
  })

  test('Given 面板首次打开 When load Then 按需读取一次且关闭不触发 stop', async () => {
    const calls: string[] = []
    const controller = createCanvasAgentConversationController({
      load: async () => { calls.push('load'); return createResult() },
      send: async () => { calls.push('send'); return { ok: true } },
      stop: async () => { calls.push('stop') },
      isBusy: () => false,
      onLoaded: () => calls.push('loaded'),
      onComposerChange: () => undefined,
      onSendingChange: () => undefined,
      onError: () => undefined,
    })

    await controller.load()
    controller.dispose()
    expect(calls).toEqual(['load', 'loaded'])
  })

  test('Given 发送失败 When 重复点击 Then 共享同一请求并恢复 composer 与错误', async () => {
    let rejectSend: ((error: Error) => void) | undefined
    const composer: string[] = []
    const sending: boolean[] = []
    const errors: Array<string | null> = []
    const controller = createCanvasAgentConversationController({
      load: async () => createResult(),
      send: () => new Promise((_resolve, reject) => { rejectSend = reject }),
      stop: async () => undefined,
      isBusy: () => false,
      onLoaded: () => undefined,
      onComposerChange: (value) => composer.push(value),
      onSendingChange: (value) => sending.push(value),
      onError: (value) => errors.push(value),
    })

    const first = controller.send('保留这段内容', 'message-1', 10)
    const second = controller.send('保留这段内容', 'message-1', 10)
    expect(second).toBe(first)
    rejectSend?.(new Error('会话正在运行'))
    await expect(first).rejects.toThrow('会话正在运行')
    expect(composer).toEqual(['', '保留这段内容'])
    expect(sending).toEqual([true, false])
    expect(errors).toEqual([null, '发送失败，请重试。'])
    expect(controller.getComposerRestore()).toBe('保留这段内容')
  })

  test('Given reload 恢复的权威运行态 When controller submit Then 不调用 SEND 且 STOP 仍可用', async () => {
    const calls: string[] = []
    let busy = true
    const controller = createCanvasAgentConversationController({
      load: async () => createResult(),
      send: async () => { calls.push('send'); return { ok: true } },
      stop: async () => { calls.push('stop') },
      isBusy: () => busy,
      onLoaded: () => undefined,
      onComposerChange: () => undefined,
      onSendingChange: () => undefined,
      onError: () => undefined,
    })

    await controller.send('不能重复发送', 'message-1', 10)
    await controller.stop()
    expect(calls).toEqual(['stop'])

    busy = false
    await controller.send('可以发送', 'message-2', 20)
    expect(calls).toEqual(['stop', 'send'])
  })

  test.each(['resolve', 'reject'] as const)(
    'Given A 节点 SEND 未完成 When 切到 B 后旧请求 %s Then 不污染 B 的 composer、sending 或 error',
    async (outcome) => {
      /** 控制 A 节点请求终态的 deferred。 */
      let settleSend: (() => void) | undefined
      /** 收集切换后仍可能发生的旧 A UI 回调。 */
      const callbacks: string[] = []
      const controller = createCanvasAgentConversationController({
        load: async () => createResult(),
        send: () => new Promise((resolve, reject) => {
          settleSend = () => outcome === 'resolve' ? resolve({ ok: true }) : reject(new Error('A 失败'))
        }),
        stop: async () => undefined,
        isBusy: () => false,
        onLoaded: () => undefined,
        onComposerChange: (value) => callbacks.push(`composer:${value}`),
        onSendingChange: (value) => callbacks.push(`sending:${value}`),
        onError: (value) => callbacks.push(`error:${value ?? ''}`),
      })
      const request = controller.send('A 草稿', 'message-a', 10)
      expect(callbacks).toEqual(['composer:', 'sending:true', 'error:'])
      controller.dispose()
      callbacks.length = 0

      settleSend?.()
      if (outcome === 'reject') await expect(request).rejects.toThrow('A 失败')
      else await request
      expect(callbacks).toEqual([])
    },
  )

  test('Given A SEND 准入拒绝后已切到 B When 旧请求 reject Then A 全局 lifecycle 回收且 B UI 不污染', async () => {
    const store = createStore()
    /** 重复构造准入拒绝，验证 owner/messages/running 不随切换单调增长。 */
    for (let index = 0; index < 100; index += 1) {
      const sessionId = `session-${index}`
      /** 当前 A 节点的全局 owner。 */
      const owner = {
        sessionId, projectId: 'project-1', canvasId: 'canvas-a', nodeId: `node-${index}`, title: 'Agent A',
      }
      store.set(canvasAgentLifecycleAtom, { type: 'opened', owner, messages: [] })
      store.set(canvasAgentLifecycleAtom, {
        type: 'optimistic-started', owner, token: `message-${index}`, startedAt: index,
      })
      /** 切换到 B 后所有旧 A UI callback 必须被抑制。 */
      const uiCallbacks: string[] = []
      const controller = createCanvasAgentConversationController({
        load: async () => createResult(),
        send: async () => { throw new Error('会话正在启动或运行中') },
        stop: async () => undefined,
        isBusy: () => false,
        onLoaded: () => undefined,
        onComposerChange: (value) => uiCallbacks.push(`composer:${value}`),
        onSendingChange: (value) => uiCallbacks.push(`sending:${value}`),
        onError: (value) => uiCallbacks.push(`error:${value ?? ''}`),
        onSendRejected: ({ token, preserveRunning }) => store.set(canvasAgentLifecycleAtom, {
          type: 'send-rejected', sessionId, token, preserveRunning,
        }),
      })
      const request = controller.send('A 草稿', `message-${index}`, index)
      controller.dispose()
      store.set(canvasAgentLifecycleAtom, { type: 'closed', sessionId })
      uiCallbacks.length = 0
      await expect(request).rejects.toThrow('会话正在启动或运行中')
      expect(uiCallbacks).toEqual([])
    }
    expect(store.get(canvasAgentRunningSessionIdsAtom).size).toBe(0)
    expect(store.get(canvasAgentOwnersAtom).size).toBe(0)
    expect(store.get(canvasAgentPersistedMessagesAtom).size).toBe(0)
  })

  test('Given 主进程返回 SESSION_BUSY When controller 收口 Then 恢复输入并保留全局真实运行', async () => {
    const store = createStore()
    const owner = {
      sessionId: 'session-busy', projectId: 'project-1', canvasId: 'canvas-a', nodeId: 'node-a', title: 'Agent A',
    }
    store.set(canvasAgentLifecycleAtom, { type: 'opened', owner, messages: [] })
    store.set(canvasAgentLifecycleAtom, {
      type: 'optimistic-started', owner, token: 'message-busy', startedAt: 10,
    })
    store.set(canvasAgentLifecycleAtom, { type: 'started', owner, startedAt: 10 })
    const composer: string[] = []
    const sending: boolean[] = []
    const errors: Array<string | null> = []
    const controller = createCanvasAgentConversationController({
      load: async () => createResult(),
      send: async () => ({
        ok: false,
        error: { code: 'SESSION_BUSY', message: '会话正在运行，请先停止当前任务。' },
      }),
      stop: async () => undefined,
      isBusy: () => false,
      onLoaded: () => undefined,
      onComposerChange: (value) => composer.push(value),
      onSendingChange: (value) => sending.push(value),
      onError: (value) => errors.push(value),
      onSendRejected: ({ token, preserveRunning }) => store.set(canvasAgentLifecycleAtom, {
        type: 'send-rejected', sessionId: owner.sessionId, token, preserveRunning,
      }),
    })

    await expect(controller.send('保留输入', 'message-busy', 10))
      .rejects.toThrow('会话正在运行，请先停止当前任务。')
    expect(composer).toEqual(['', '保留输入'])
    expect(sending).toEqual([true, false])
    expect(errors).toEqual([null, '会话正在运行，请先停止当前任务。'])
    expect(store.get(canvasAgentRunningSessionIdsAtom).has(owner.sessionId)).toBe(true)
    expect(store.get(canvasAgentOwnersAtom).get(owner.sessionId)).toEqual(owner)
  })

  test('Given 窄屏对话面板 When SSR Then 只有文本发送停止关闭控件', () => {
    const html = renderToStaticMarkup(
      <Provider store={createStore()}>
        <CanvasAgentConversation
          target={{ projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'node-1' }}
          title="研究 Agent"
          adapter={{
            getCanvasAgentMessages: async () => createResult(),
            sendCanvasAgentMessage: async () => ({ ok: true }),
            stopCanvasAgent: async () => undefined,
          }}
          onClose={() => undefined}
        />
      </Provider>,
    )
    expect(html).toContain('aria-label="关闭对话"')
    expect(html).toContain('aria-label="停止 Agent"')
    expect(html).toContain('aria-label="发送消息"')
    expect(html).toContain('aria-label="Canvas Agent 消息输入"')
    expect(html).toMatch(/<textarea[^>]*aria-label="Canvas Agent 消息输入"[^>]*disabled=""/)
    expect(html).not.toContain('附件')
    expect(html).not.toContain('模型切换')
    expect(html).not.toContain('权限模式')
  })
})
