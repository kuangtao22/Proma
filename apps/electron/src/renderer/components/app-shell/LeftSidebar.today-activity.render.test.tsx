import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Provider, createStore } from 'jotai'
import type { AgentSessionMeta, AgentWorkspace, ConversationMeta } from '@proma/shared'
import { appModeAtom, type AppMode } from '@/atoms/app-mode'
import { conversationsAtom } from '@/atoms/chat-atoms'
import { agentSessionsAtom, agentWorkspacesAtom } from '@/atoms/agent-atoms'
import { sidebarViewModeAtom, type SidebarViewMode } from '@/atoms/sidebar-atoms'
import { TooltipProvider } from '@/components/ui/tooltip'
import { LeftSidebar } from './LeftSidebar'

/**
 * 侧栏「今日活动」的渲染回归。
 *
 * LeftSidebar 依赖 window.electronAPI 与 Jotai atom，这里用 SSR 方式渲染真实组件：
 * IPC 只在 effect 中调用（SSR 不执行），因此以桩兜底；会话数据直接写入 store。
 * 覆盖入口是否常驻且位于已归档入口之上、今日计数是否排除非今日与草稿数据、
 * 空态文案是否出现。列表行由 VirtualSidebarList 虚拟化，SSR 不产出可见行，
 * 行级筛选与排序由 `src/renderer/lib/sidebar-today-activity.test.ts` 覆盖。
 */

/** 时间锚点相对当前时刻构造，避免测试依赖真实日期。 */
const NOW = Date.now()
const TODAY_MORNING = NOW - 60 * 60 * 1000
const TODAY_NOON = NOW - 30 * 60 * 1000
const YESTERDAY = NOW - 26 * 60 * 60 * 1000

const originalWindow = Reflect.get(globalThis, 'window')

/** 组件 effect 内调用到的 IPC 桩；SSR 不执行 effect，仅作防御。 */
const ELECTRON_API_STUB = new Proxy({}, {
  get: () => (): Promise<unknown> => Promise.resolve(undefined),
})

beforeAll(() => {
  Reflect.set(globalThis, 'window', {
    electronAPI: ELECTRON_API_STUB,
    addEventListener: () => {},
    removeEventListener: () => {},
  })
})

afterAll(() => {
  if (originalWindow === undefined) {
    Reflect.deleteProperty(globalThis, 'window')
    return
  }
  Reflect.set(globalThis, 'window', originalWindow)
})

function makeSession(id: string, updatedAt: number, extra: Partial<AgentSessionMeta> = {}): AgentSessionMeta {
  return { id, title: id, createdAt: updatedAt, updatedAt, ...extra }
}

function makeConversation(id: string, updatedAt: number, extra: Partial<ConversationMeta> = {}): ConversationMeta {
  return { id, title: id, createdAt: updatedAt, updatedAt, ...extra }
}

function renderSidebar({
  viewMode,
  sessions,
  conversations = [],
  mode = 'agent',
}: {
  viewMode: SidebarViewMode
  sessions: AgentSessionMeta[]
  conversations?: ConversationMeta[]
  mode?: AppMode
}): string {
  const store = createStore()
  store.set(appModeAtom, mode)
  store.set(sidebarViewModeAtom, viewMode)
  store.set(agentSessionsAtom, sessions)
  store.set(conversationsAtom, conversations)
  store.set(agentWorkspacesAtom, [
    { id: 'project-1', name: '测试项目', slug: 'project-1', createdAt: 0, updatedAt: 0 } satisfies AgentWorkspace,
  ])
  return renderToStaticMarkup(
    <Provider store={store}>
      <TooltipProvider>
        <LeftSidebar />
      </TooltipProvider>
    </Provider>,
  )
}

describe('侧栏今日活动渲染', () => {
  test('Given 活跃视图 When 渲染侧栏 Then 今日活动入口常驻且位于已归档入口之上', () => {
    const markup = renderSidebar({
      viewMode: 'active',
      mode: 'chat',
      sessions: [],
      conversations: [
        makeConversation('今天对话', TODAY_MORNING),
        makeConversation('已归档对话', YESTERDAY, { archived: true }),
      ],
    })

    const todayIndex = markup.indexOf('今日活动 (1)')
    const archivedIndex = markup.indexOf('已归档 (1)')

    expect(todayIndex).toBeGreaterThan(-1)
    expect(archivedIndex).toBeGreaterThan(-1)
    expect(todayIndex).toBeLessThan(archivedIndex)
  })

  test('Given 今日会话有 2 条且含昨天数据 When 打开今日活动 Then 计数只算今天且不显示空态', () => {
    const markup = renderSidebar({
      viewMode: 'today',
      sessions: [
        makeSession('今天较早', TODAY_MORNING),
        makeSession('今天较晚', TODAY_NOON),
        makeSession('昨天', YESTERDAY),
      ],
    })

    expect(markup).toContain('今日活动 · 2')
    expect(markup).not.toContain('今天还没有会话')
  })

  test('Given 今日只有归档与草稿会话 When 打开今日活动 Then 显示空态且入口不显示计数', () => {
    const markup = renderSidebar({
      viewMode: 'today',
      sessions: [
        makeSession('已归档', TODAY_MORNING, { archived: true }),
        makeSession('草稿', TODAY_NOON, { isDraft: true }),
      ],
    })

    expect(markup).toContain('今天还没有会话')
    expect(markup).not.toContain('今日活动 · ')
  })

  test('Given Chat 模式 When 打开今日活动 Then 使用对话口径的计数与空态', () => {
    const withToday = renderSidebar({
      viewMode: 'today',
      mode: 'chat',
      sessions: [],
      conversations: [
        makeConversation('今天对话较早', TODAY_MORNING),
        makeConversation('今天对话较晚', TODAY_NOON),
        makeConversation('昨天对话', YESTERDAY),
      ],
    })
    expect(withToday).toContain('今日活动 · 2')

    const empty = renderSidebar({ viewMode: 'today', mode: 'chat', sessions: [], conversations: [] })
    expect(empty).toContain('今天还没有对话')
  })
})
