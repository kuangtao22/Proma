import * as React from 'react'
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { Provider, createStore } from 'jotai'
import type { CanvasAgentMessagesResult } from '@proma/shared'
import {
  CanvasAgentConversation,
  createCanvasAgentConversationController,
} from './CanvasAgentConversation'

/** 创建公开消息加载结果。 */
function createResult(): CanvasAgentMessagesResult {
  return {
    sessionId: 'session-1',
    owner: { projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'node-1', title: '研究 Agent' },
    messages: [],
  }
}

describe('Canvas Agent 对话', () => {
  test('Given 面板首次打开 When load Then 按需读取一次且关闭不触发 stop', async () => {
    const calls: string[] = []
    const controller = createCanvasAgentConversationController({
      load: async () => { calls.push('load'); return createResult() },
      send: async () => { calls.push('send') },
      stop: async () => { calls.push('stop') },
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
      send: () => new Promise<void>((_resolve, reject) => { rejectSend = reject }),
      stop: async () => undefined,
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
    expect(errors).toEqual([null, '会话正在运行'])
    expect(controller.getComposerRestore()).toBe('保留这段内容')
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
        send: () => new Promise<void>((resolve, reject) => {
          settleSend = () => outcome === 'resolve' ? resolve() : reject(new Error('A 失败'))
        }),
        stop: async () => undefined,
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

  test('Given 窄屏对话面板 When SSR Then 只有文本发送停止关闭控件', () => {
    const html = renderToStaticMarkup(
      <Provider store={createStore()}>
        <CanvasAgentConversation
          target={{ projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'node-1' }}
          title="研究 Agent"
          adapter={{
            getCanvasAgentMessages: async () => createResult(),
            sendCanvasAgentMessage: async () => undefined,
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
