import { describe, expect, test } from 'bun:test'
import { createStore } from 'jotai'
import type { BrowserViewState } from '@proma/shared'
import {
  browserFocusRequestMapAtom,
  browserPanelMinimizedMapAtom,
  browserPanelOpenMapAtom,
  browserPendingNavigationMapAtom,
  browserStateMapAtom,
  clearBrowserSessionStateAtom,
} from './browser-atoms'

function browserState(sessionId: string): BrowserViewState {
  return {
    sessionId,
    executionSource: 'user',
    activeTabId: `${sessionId}-tab`,
    agentTabId: null,
    tabs: [],
    url: 'https://example.com',
    title: 'Example',
    loading: false,
    visible: true,
    canGoBack: false,
    canGoForward: false,
    trace: [],
    activity: null,
  }
}

describe('删除会话的浏览器状态清理', () => {
  test('Given 两个会话都有浏览器状态 When 删除会话 A 成功 Then 清理 A 的五个 map 且保留 B', () => {
    const store = createStore()
    const sessionIds = ['session-a', 'session-b']
    store.set(browserPanelOpenMapAtom, new Map(sessionIds.map((id) => [id, true])))
    store.set(browserPanelMinimizedMapAtom, new Map(sessionIds.map((id) => [id, true])))
    store.set(browserStateMapAtom, new Map(sessionIds.map((id) => [id, browserState(id)])))
    store.set(browserFocusRequestMapAtom, new Map(sessionIds.map((id) => [id, `${id}-tab`])))
    store.set(browserPendingNavigationMapAtom, new Map(sessionIds.map((id) => [id, `https://${id}.example.com`])))

    store.set(clearBrowserSessionStateAtom, 'session-a')

    const sessionPresence = [
      store.get(browserPanelOpenMapAtom),
      store.get(browserPanelMinimizedMapAtom),
      store.get(browserStateMapAtom),
      store.get(browserFocusRequestMapAtom),
      store.get(browserPendingNavigationMapAtom),
    ].map((state) => ({ hasA: state.has('session-a'), hasB: state.has('session-b') }))

    expect(sessionPresence).toEqual(Array.from({ length: 5 }, () => ({ hasA: false, hasB: true })))
  })
})
