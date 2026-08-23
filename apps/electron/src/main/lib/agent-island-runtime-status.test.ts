import { describe, expect, test } from 'bun:test'
import {
  markAgentIslandRuntimeViewed,
  projectAgentIslandRuntimeStatus,
} from './agent-island-runtime-status'

describe('Agent Island 会话四态投影', () => {
  test('Given 主进程阶段 When 投影手机端状态 Then 保持桌面语义优先级', () => {
    expect(projectAgentIslandRuntimeStatus(undefined)).toBe('idle')
    expect(projectAgentIslandRuntimeStatus({ phase: 'idle', unread: false })).toBe('idle')
    expect(projectAgentIslandRuntimeStatus({ phase: 'running', unread: false })).toBe('running')
    expect(projectAgentIslandRuntimeStatus({ phase: 'needs-interaction', unread: false })).toBe('blocked')
    expect(projectAgentIslandRuntimeStatus({ phase: 'completed', unread: true })).toBe('completed')
    expect(projectAgentIslandRuntimeStatus({ phase: 'error', unread: true })).toBe('completed')
    expect(projectAgentIslandRuntimeStatus({ phase: 'completed', unread: false })).toBe('idle')
    expect(projectAgentIslandRuntimeStatus({ phase: 'error', unread: false })).toBe('idle')
  })

  test('Given 完成未读会话 When 标记已查看 Then 清除注意状态且重复调用幂等', () => {
    /** 可变快照模拟 Agent Island 内部 Map 中的真实记录。 */
    const session = { phase: 'completed' as const, unread: true, attention: true }

    expect(markAgentIslandRuntimeViewed(session)).toBe(true)
    expect(session).toEqual({ phase: 'completed', unread: false, attention: false })
    expect(markAgentIslandRuntimeViewed(session)).toBe(false)
  })

  test('Given 运行或阻塞会话 When 标记已查看 Then 不改变实时状态', () => {
    /** 运行快照不能因手机读取历史而被误清。 */
    const running = { phase: 'running' as const, unread: false, attention: false }
    /** 阻塞快照仍需等待用户处理。 */
    const blocked = { phase: 'needs-interaction' as const, unread: false, attention: true }

    expect(markAgentIslandRuntimeViewed(running)).toBe(false)
    expect(markAgentIslandRuntimeViewed(blocked)).toBe(false)
    expect(running.phase).toBe('running')
    expect(blocked.phase).toBe('needs-interaction')
  })
})
