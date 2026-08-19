import { describe, expect, test } from 'bun:test'
import { Provider, createStore } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'

/** 测试专用内存存储，满足 App 模块初始化依赖。 */
const storageValues = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => storageValues.get(key) ?? null,
    setItem: (key: string, value: string) => storageValues.set(key, value),
    removeItem: (key: string) => storageValues.delete(key),
  },
})

/** 提供 AppShell 间接加载 App 时所需的最小页面环境。 */
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

describe('移动端应用外壳', () => {
  test('Given 抽屉关闭或打开 When 渲染外壳 Then 关闭态不会留下可聚焦抽屉控件', async () => {
    const { drawerOpenAtom, viewAtom } = await import('../../atoms')
    const { AppShell } = await import('./AppShell')
    /** 关闭态 store 验证抽屉不在 DOM 中。 */
    const closedStore = createStore()
    closedStore.set(viewAtom, 'chat')
    closedStore.set(drawerOpenAtom, false)
    /** 打开态 store 验证抽屉仍可正常渲染。 */
    const openStore = createStore()
    openStore.set(viewAtom, 'chat')
    openStore.set(drawerOpenAtom, true)
    /** 两种状态的静态标记。 */
    const closedMarkup = renderToStaticMarkup(<Provider store={closedStore}><AppShell /></Provider>)
    const openMarkup = renderToStaticMarkup(<Provider store={openStore}><AppShell /></Provider>)

    expect(closedMarkup).not.toContain('aria-label="会话抽屉"')
    expect(openMarkup).toContain('aria-label="会话抽屉"')
  })
})
