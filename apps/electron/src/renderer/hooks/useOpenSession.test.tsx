import { describe, expect, test } from 'bun:test'
import { Provider, createStore } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import { activeViewAtom } from '@/atoms/active-view'
import {
  channelFormDirtyAtom,
  settingsOpenAtom,
  settingsPendingSessionNavigationAtom,
} from '@/atoms/settings-tab'
import type { TabType } from '@/atoms/tab-atoms'
import { useOpenSession } from './useOpenSession'

/** 捕获统一会话打开命令，便于直接验证跨视图状态联动。 */
function captureOpenSession(
  store: ReturnType<typeof createStore>,
): (type: TabType, sessionId: string, title: string) => void {
  /** 静态渲染期间由测试探针写入的真实 hook 回调。 */
  let openSession: ReturnType<typeof useOpenSession> | null = null
  /** 测试探针只负责取得统一会话打开命令。 */
  const Probe = (): null => {
    openSession = useOpenSession()
    return null
  }

  renderToStaticMarkup(<Provider store={store}><Probe /></Provider>)
  if (!openSession) throw new Error('未捕获会话打开命令')
  return openSession
}

describe('统一会话打开', () => {
  test('Given 当前显示其它顶层能力 When 打开普通会话 Then 只依赖普通会话状态并切回会话视图', () => {
    const store = createStore()
    store.set(activeViewAtom, 'planning')
    /** 通过真实 hook 执行普通会话导航。 */
    const openSession = captureOpenSession(store)

    openSession('chat', 'chat-1', '需求讨论')

    expect(store.get(activeViewAtom)).toBe('conversations')
  })

  test('Given 设置页存在未保存配置 When 会话导航被拦截 Then 保留当前顶层视图', () => {
    const store = createStore()
    store.set(settingsOpenAtom, true)
    store.set(channelFormDirtyAtom, true)
    store.set(activeViewAtom, 'planning')
    /** 通过真实 hook 触发会被设置守卫延后的导航。 */
    const openSession = captureOpenSession(store)

    openSession('chat', 'chat-1', '需求讨论')

    expect(store.get(activeViewAtom)).toBe('planning')
    expect(store.get(settingsPendingSessionNavigationAtom)).toEqual({
      type: 'chat',
      sessionId: 'chat-1',
      title: '需求讨论',
    })
  })
})
