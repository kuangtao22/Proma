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
function renderNanoBananaResult(session: AgentSessionMeta): string {
  const store = createStore()
  store.set(agentSessionsAtom, [session])
  store.set(tabsAtom, [{ id: session.id, type: 'agent', sessionId: session.id, title: session.title }])
  store.set(activeTabIdAtom, session.id)
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
        <ContentBlock block={block} allMessages={allMessages} />
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

    expect(html).toMatch(/aria-label="加入设计"[^>]*disabled/)
  })
})
