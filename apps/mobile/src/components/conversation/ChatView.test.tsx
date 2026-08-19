import { describe, expect, test } from 'bun:test'
import { Provider, createStore } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'

/** 提供移动端 atoms 初始化所需的最小浏览器环境。 */
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: { getItem: () => null },
})
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: { location: { hostname: '127.0.0.1' } },
})

describe('移动端历史消息状态', () => {
  test('Given 切换到有待加载历史的会话 When 首次渲染 Then 显示加载态而非新对话空态', async () => {
    const { activeConvAtom, messagesAtom, tokenAtom } = await import('../../atoms')
    const { ChatView } = await import('./ChatView')
    /** 独立 store 模拟刚切换到一个尚未返回历史的会话。 */
    const store = createStore()
    store.set(activeConvAtom, { id: 'conv-1', title: '已有会话', type: 'agent', updatedAt: 1 })
    store.set(messagesAtom, [])
    store.set(tokenAtom, 'token')
    /** effect 执行前的静态标记代表切换瞬间。 */
    const markup = renderToStaticMarkup(<Provider store={store}><ChatView /></Provider>)

    expect(markup).toContain('正在加载对话')
    expect(markup).not.toContain('开始一段新对话')
  })

  test('Given 历史消息加载失败 When 渲染状态 Then 提供错误说明和重试入口', async () => {
    const { ConversationHistoryState } = await import('./ChatView')
    /** 错误态组件无需网络环境即可验证用户可恢复路径。 */
    const markup = renderToStaticMarkup(
      <ConversationHistoryState status="error" messageCount={0} onRetry={() => undefined} />,
    )

    expect(markup).toContain('对话加载失败')
    expect(markup).toContain('aria-label="重新加载对话"')
    expect(markup).not.toContain('开始一段新对话')
  })

  test('Given 切换会话时仍有旧消息 When 计算可见消息 Then 不把旧会话内容显示给新会话', async () => {
    const { selectVisibleMessages } = await import('./ChatView')
    /** 旧消息用于锁定会话切换 effect 执行前的隔离边界。 */
    const oldMessages = [{ id: 'old-1', role: 'user' as const, content: '旧会话内容', createdAt: 1 }]

    expect(selectVisibleMessages(oldMessages, 'agent:old', 'agent:new')).toEqual([])
    expect(selectVisibleMessages(oldMessages, 'agent:new', 'agent:new')).toEqual(oldMessages)
  })
})
