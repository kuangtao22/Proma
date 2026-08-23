import { describe, expect, test } from 'bun:test'
import { Provider, createStore } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'

/** 测试专用浏览器状态，满足下拉框间接导入 App 的初始化依赖。 */
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  },
})

/** 提供模块初始化所需的最小页面环境。 */
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: {
    location: {
      hostname: '127.0.0.1',
      href: 'http://127.0.0.1:29888/',
      protocol: 'http:',
    },
    history: { replaceState: () => undefined },
  },
})

describe('移动端会话下拉框', () => {
  test('Given 同工作区 Agent 会话 When 渲染 Then 复用四列状态与星标布局', async () => {
    const { activeConvAtom, channelsAtom, conversationsAtom, tokenAtom } = await import('../../atoms')
    const { ConvDropdown } = await import('./ConvDropdown')
    /** 独立 store 提供当前工作区的两个 Agent 会话。 */
    const store = createStore()
    const active = {
      id: 'agent-1', title: '当前会话', type: 'agent' as const, workspaceId: 'ws-1',
      updatedAt: 2, runtimeStatus: 'completed' as const, starred: true,
    }
    store.set(tokenAtom, 'token')
    store.set(activeConvAtom, active)
    store.set(conversationsAtom, [
      active,
      { id: 'agent-2', title: '其他会话', type: 'agent', workspaceId: 'ws-1', updatedAt: 1, runtimeStatus: 'idle' },
    ])
    store.set(channelsAtom, [])

    const markup = renderToStaticMarkup(
      <Provider store={store}><ConvDropdown onClose={() => undefined} /></Provider>,
    )

    expect(markup.match(/data-agent-session-row="four-column"/g)).toHaveLength(2)
    expect(markup).toContain('aria-label="已完成未查看"')
    expect(markup).toContain('aria-label="取消星标"')
  })

  test('Given Chat 会话 When 渲染 Then 保留相对时间与当前会话标记', async () => {
    const { activeConvAtom, channelsAtom, conversationsAtom, tokenAtom } = await import('../../atoms')
    const { ConvDropdown } = await import('./ConvDropdown')
    /** Chat 分支必须保持功能改动前的列表信息密度。 */
    const store = createStore()
    const active = { id: 'chat-1', title: '当前 Chat', type: 'chat' as const, updatedAt: Date.now() }
    store.set(tokenAtom, 'token')
    store.set(activeConvAtom, active)
    store.set(conversationsAtom, [active])
    store.set(channelsAtom, [])

    const markup = renderToStaticMarkup(
      <Provider store={store}><ConvDropdown onClose={() => undefined} /></Provider>,
    )

    expect(markup).toContain('刚刚')
    expect(markup).toContain('aria-label="当前会话"')
    expect(markup).not.toContain('data-agent-session-row="four-column"')
  })
})
