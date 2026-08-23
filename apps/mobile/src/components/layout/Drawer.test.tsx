import { describe, expect, test } from 'bun:test'
import { Provider, createStore } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'

/** 测试专用内存存储，满足移动端模块初始化依赖。 */
const storageValues = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => storageValues.get(key) ?? null,
    setItem: (key: string, value: string) => storageValues.set(key, value),
    removeItem: (key: string) => storageValues.delete(key),
  },
})

/** 提供 Drawer 间接加载 App 时所需的最小页面环境。 */
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

describe('移动端会话抽屉', () => {
  test('Given 空会话列表 When 渲染 Agent 抽屉 Then 展示可访问动作和真实空态', async () => {
    const {
      activeTabAtom,
      conversationsAtom,
      currentWorkspaceIdAtom,
      tokenAtom,
      workspacesAtom,
    } = await import('../../atoms')
    const { Drawer } = await import('./Drawer')
    /** 独立 store 防止测试污染应用全局 atoms。 */
    const store = createStore()
    store.set(tokenAtom, 'token')
    store.set(activeTabAtom, 'agent')
    store.set(conversationsAtom, [])
    store.set(workspacesAtom, [])
    store.set(currentWorkspaceIdAtom, null)
    /** 服务端静态标记用于检查无需交互即可确认的抽屉契约。 */
    const markup = renderToStaticMarkup(
      <Provider store={store}><Drawer onClose={() => undefined} /></Provider>,
    )

    expect(markup).toContain('aria-label="关闭会话抽屉"')
    expect(markup).toContain('新建对话')
    expect(markup).toContain('暂无 Agent 对话')
    expect(markup).toContain('刷新')
    expect(markup).toContain('断开')
  })

  test('Given 不同运行态会话 When 渲染抽屉 Then 使用统一四列会话行', async () => {
    const { activeTabAtom, conversationsAtom, tokenAtom } = await import('../../atoms')
    const { Drawer } = await import('./Drawer')
    /** 独立 store 提供两种会话状态。 */
    const store = createStore()
    store.set(tokenAtom, 'token')
    store.set(activeTabAtom, 'agent')
    store.set(conversationsAtom, [
      { id: 'running', title: '运行会话', type: 'agent', updatedAt: 2, runtimeStatus: 'running', starred: true },
      { id: 'blocked', title: '等待会话', type: 'agent', updatedAt: 1, runtimeStatus: 'blocked' },
    ])
    /** 抽屉必须复用状态、标题、星标、时间四列契约。 */
    const markup = renderToStaticMarkup(
      <Provider store={store}><Drawer onClose={() => undefined} /></Provider>,
    )

    expect(markup.match(/data-agent-session-row="four-column"/g)).toHaveLength(2)
    expect(markup).toContain('aria-label="运行中"')
    expect(markup).toContain('aria-label="等待处理"')
    expect(markup.indexOf('aria-label="取消星标"')).toBeLessThan(markup.indexOf('data-session-time'))
  })
})
