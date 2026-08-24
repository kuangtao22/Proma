import { describe, expect, test } from 'bun:test'
import type { AgentSessionMeta, SDKMessage, SDKToolUseBlock } from '@proma/shared'
import { createStore, Provider } from 'jotai'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { agentSessionsAtom } from '@/atoms/agent-atoms'
import { activeTabIdAtom, tabsAtom } from '@/atoms/tab-atoms'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ContentBlock } from './ContentBlock'

/** 渲染带一张已持久化图片附件的 Nano Banana 工具结果。 */
function renderNanoBananaResult(session: AgentSessionMeta, activeSessionId = session.id): string {
  const store = createStore()
  const activeSession: AgentSessionMeta = { id: activeSessionId, title: '其它活跃会话', workspaceId: 'project-b', createdAt: 1, updatedAt: 1 }
  store.set(agentSessionsAtom, activeSessionId === session.id ? [session] : [session, activeSession])
  store.set(tabsAtom, [{ id: activeSession.id, type: 'agent', sessionId: activeSession.id, title: activeSession.title }])
  store.set(activeTabIdAtom, activeSession.id)
  const block: SDKToolUseBlock = {
    type: 'tool_use', id: 'tool-1', name: 'mcp__nano_banana__generate_image', input: {},
  }
  const allMessages = [{
    type: 'user',
    message: { content: [{
      type: 'tool_result', tool_use_id: 'tool-1', content: 'ok',
      imageAttachments: [{ localPath: 'session/a.png', filename: 'a.png', mediaType: 'image/png' }],
    }] },
  }] as unknown as SDKMessage[]
  return renderToStaticMarkup(
    <Provider store={store}>
      <TooltipProvider>
        <ContentBlock block={block} allMessages={allMessages} sessionId={session.id} />
      </TooltipProvider>
    </Provider>,
  )
}

describe('Nano Banana 工具结果', () => {
  test('Given 会话属于项目 When 渲染图片结果 Then 显示可用的加入设计图标按钮', () => {
    const html = renderNanoBananaResult({
      id: 'session-1', title: '项目会话', workspaceId: 'project-1', createdAt: 1, updatedAt: 1,
    })

    expect(html).toMatch(/aria-label="加入设计"(?![^>]*disabled)/)
  })

  test('Given 会话没有项目 When 渲染图片结果 Then 加入设计按钮禁用', () => {
    const html = renderNanoBananaResult({
      id: 'session-1', title: '临时会话', createdAt: 1, updatedAt: 1,
    })

    expect(html).toMatch(/data-design-import-tooltip-trigger="true"[^>]*tabindex="0"/)
    expect(html).toMatch(/aria-label="加入设计"[^>]*disabled/)
    expect(html).toContain('aria-description="该会话不属于项目"')
  })

  test('Given 消息属于会话 A 但当前活跃会话为 B When 渲染图片结果 Then 按消息会话 A 解析项目归属', () => {
    const html = renderNanoBananaResult({
      id: 'session-a', title: '消息会话', workspaceId: 'project-a', createdAt: 1, updatedAt: 1,
    }, 'session-b')

    expect(html).toContain('data-design-import-session-id="session-a"')
    expect(html).toMatch(/aria-label="加入设计"(?![^>]*disabled)/)
  })
})
