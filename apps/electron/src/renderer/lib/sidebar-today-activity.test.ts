import { describe, expect, test } from 'bun:test'
import type { AgentSessionMeta, ConversationMeta } from '@proma/shared'
import {
  getTodayStartTimestamp,
  selectTodayAgentSessions,
  selectTodayConversations,
} from './sidebar-today-activity'

/** 固定「当前时间」为本地 2026-09-26 14:30，避免测试依赖机器时区偏移 */
const NOW = new Date(2026, 8, 26, 14, 30, 0).getTime()
const TODAY_START = new Date(2026, 8, 26, 0, 0, 0).getTime()
const YESTERDAY_END = TODAY_START - 1
const OLDER = new Date(2026, 8, 20, 9, 0, 0).getTime()

function makeConversation(
  id: string,
  updatedAt: number,
  extra: Partial<ConversationMeta> = {},
): ConversationMeta {
  return { id, title: id, createdAt: updatedAt, updatedAt, ...extra }
}

function makeSession(
  id: string,
  updatedAt: number,
  extra: Partial<AgentSessionMeta> = {},
): AgentSessionMeta {
  return { id, title: id, createdAt: updatedAt, updatedAt, ...extra }
}

describe('getTodayStartTimestamp', () => {
  test('Given 任意时刻 When 求当日起点 Then 返回本地零点且当天内恒定', () => {
    const morning = new Date(2026, 8, 26, 0, 0, 0).getTime()
    const lateNight = new Date(2026, 8, 26, 23, 59, 59, 999).getTime()

    expect(getTodayStartTimestamp(NOW)).toBe(TODAY_START)
    expect(getTodayStartTimestamp(morning)).toBe(TODAY_START)
    expect(getTodayStartTimestamp(lateNight)).toBe(TODAY_START)
  })
})

describe('selectTodayConversations', () => {
  test('Given 今日对话乱序 When 选择 Then 按最后一次对话时间降序', () => {
    const result = selectTodayConversations({
      conversations: [
        makeConversation('a', new Date(2026, 8, 26, 9, 0, 0).getTime()),
        makeConversation('b', new Date(2026, 8, 26, 13, 0, 0).getTime()),
        makeConversation('c', new Date(2026, 8, 26, 11, 0, 0).getTime()),
      ],
      now: NOW,
    })

    expect(result.map((conversation) => conversation.id)).toEqual(['b', 'c', 'a'])
  })

  test('Given 昨天与更早的对话 When 选择 Then 只保留今天且含零点边界', () => {
    const result = selectTodayConversations({
      conversations: [
        makeConversation('today-first-second', TODAY_START),
        makeConversation('yesterday-last-second', YESTERDAY_END),
        makeConversation('older', OLDER),
      ],
      now: NOW,
    })

    expect(result.map((conversation) => conversation.id)).toEqual(['today-first-second'])
  })

  test('Given 归档对话与草稿对话 When 选择 Then 两者都不进入今日活动', () => {
    const result = selectTodayConversations({
      conversations: [
        makeConversation('normal', new Date(2026, 8, 26, 10, 0, 0).getTime()),
        makeConversation('archived', new Date(2026, 8, 26, 11, 0, 0).getTime(), { archived: true }),
        makeConversation('draft', new Date(2026, 8, 26, 12, 0, 0).getTime()),
      ],
      now: NOW,
      excludedSessionIds: new Set(['draft']),
    })

    expect(result.map((conversation) => conversation.id)).toEqual(['normal'])
  })

  test('Given 无今日对话 When 选择 Then 返回空列表且不修改入参顺序', () => {
    const conversations = [
      makeConversation('older', OLDER),
      makeConversation('yesterday', YESTERDAY_END),
    ]

    expect(selectTodayConversations({ conversations, now: NOW })).toEqual([])
    expect(conversations.map((conversation) => conversation.id)).toEqual(['older', 'yesterday'])
  })
})

describe('selectTodayAgentSessions', () => {
  test('Given 今日会话乱序 When 选择 Then 按最后一次对话时间降序', () => {
    const result = selectTodayAgentSessions({
      sessions: [
        makeSession('a', new Date(2026, 8, 26, 8, 0, 0).getTime()),
        makeSession('b', new Date(2026, 8, 26, 14, 0, 0).getTime()),
        makeSession('c', new Date(2026, 8, 26, 12, 0, 0).getTime()),
      ],
      now: NOW,
    })

    expect(result.map((session) => session.id)).toEqual(['b', 'c', 'a'])
  })

  test('Given 归档/草稿/未发送首条消息的会话 When 选择 Then 全部排除', () => {
    const result = selectTodayAgentSessions({
      sessions: [
        makeSession('normal', new Date(2026, 8, 26, 10, 0, 0).getTime()),
        makeSession('archived', new Date(2026, 8, 26, 11, 0, 0).getTime(), { archived: true }),
        makeSession('is-draft', new Date(2026, 8, 26, 12, 0, 0).getTime(), { isDraft: true }),
        makeSession('renderer-draft', new Date(2026, 8, 26, 13, 0, 0).getTime()),
      ],
      now: NOW,
      excludedSessionIds: new Set(['renderer-draft']),
    })

    expect(result.map((session) => session.id)).toEqual(['normal'])
  })

  test('Given 委派子会话与定时任务会话 When 选择 Then 视为今日会话保留', () => {
    const result = selectTodayAgentSessions({
      sessions: [
        makeSession('parent', new Date(2026, 8, 26, 9, 0, 0).getTime()),
        makeSession('child', new Date(2026, 8, 26, 10, 0, 0).getTime(), {
          parentSessionId: 'parent',
          sourceDelegationId: 'delegation-1',
        }),
        makeSession('automation', new Date(2026, 8, 26, 11, 0, 0).getTime(), {
          sourceAutomationId: 'automation-1',
        }),
      ],
      now: NOW,
    })

    expect(result.map((session) => session.id)).toEqual(['automation', 'child', 'parent'])
  })

  test('Given Canvas/Design 内部执行会话 When 选择 Then 不进入今日活动', () => {
    const result = selectTodayAgentSessions({
      sessions: [
        makeSession('normal', new Date(2026, 8, 26, 9, 0, 0).getTime()),
        makeSession('canvas', new Date(2026, 8, 26, 10, 0, 0).getTime(), {
          workspaceId: 'project-1',
          sourceCanvasProjectId: 'project-1',
          sourceCanvasId: 'canvas-1',
        }),
        makeSession('design', new Date(2026, 8, 26, 11, 0, 0).getTime(), {
          sourceDesignProjectId: 'project-1',
          sourceDesignJobId: 'job-1',
        }),
      ],
      now: NOW,
    })

    expect(result.map((session) => session.id)).toEqual(['normal'])
  })

  test('Given 昨天与更早的会话 When 选择 Then 只保留今天且含零点边界', () => {
    const result = selectTodayAgentSessions({
      sessions: [
        makeSession('today-midnight', TODAY_START),
        makeSession('yesterday-last-second', YESTERDAY_END),
        makeSession('older', OLDER),
      ],
      now: NOW,
    })

    expect(result.map((session) => session.id)).toEqual(['today-midnight'])
  })
})
