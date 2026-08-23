import { describe, expect, test } from 'bun:test'
import type { ConvItem } from '../atoms'
import {
  isAgentRuntimeBusy,
  normalizeAgentSessionSnapshot,
  normalizeAgentRuntimeStatus,
  readAgentStarUpdate,
  readAgentRuntimeUpdate,
  updateActiveAgentRuntimeStatus,
  updateActiveAgentStarred,
  updateAgentRuntimeStatus,
  updateAgentStarred,
} from './session-runtime-state'

/** 创建两个不同类型会话，验证更新不会越过 Agent 边界。 */
function createConversations(): ConvItem[] {
  return [
    { id: 'agent-1', title: 'Agent', type: 'agent', updatedAt: 2, runtimeStatus: 'idle', starred: false },
    { id: 'chat-1', title: 'Chat', type: 'chat', updatedAt: 1 },
  ]
}

describe('移动端 Agent 会话运行状态', () => {
  test('Given 服务端状态 When 规范化 Then 未知值安全回落为空闲', () => {
    expect(normalizeAgentRuntimeStatus('running')).toBe('running')
    expect(normalizeAgentRuntimeStatus('blocked')).toBe('blocked')
    expect(normalizeAgentRuntimeStatus('completed')).toBe('completed')
    expect(normalizeAgentRuntimeStatus('idle')).toBe('idle')
    expect(normalizeAgentRuntimeStatus('future-status')).toBe('idle')
    expect(normalizeAgentRuntimeStatus(undefined)).toBe('idle')
  })

  test('Given 运行或阻塞状态 When 判断输入栏忙碌 Then 两者均允许停止', () => {
    expect(isAgentRuntimeBusy('running')).toBe(true)
    expect(isAgentRuntimeBusy('blocked')).toBe(true)
    expect(isAgentRuntimeBusy('completed')).toBe(false)
    expect(isAgentRuntimeBusy('idle')).toBe(false)
  })

  test('Given 会话列表 When 收到目标状态事件 Then 只替换目标 Agent', () => {
    /** 原始列表用于验证结构共享。 */
    const conversations = createConversations()
    /** 状态事件合并后的新列表。 */
    const updated = updateAgentRuntimeStatus(conversations, 'agent-1', 'running')

    expect(updated).not.toBe(conversations)
    expect(updated[0]).toEqual({ ...conversations[0], runtimeStatus: 'running' })
    expect(updated[1]).toBe(conversations[1])
    expect(updateAgentRuntimeStatus(updated, 'agent-1', 'running')).toBe(updated)
    expect(updateAgentRuntimeStatus(updated, 'missing', 'blocked')).toBe(updated)
  })

  test('Given 星标响应 When 合并列表 Then 不修改同 ID 的 Chat 会话', () => {
    /** 增加同 ID Chat，锁定类型边界。 */
    const conversations = [
      ...createConversations(),
      { id: 'agent-1', title: '同 ID Chat', type: 'chat' as const, updatedAt: 3 },
    ]
    /** 星标更新后的列表。 */
    const updated = updateAgentStarred(conversations, 'agent-1', true)

    expect(updated[0]?.starred).toBe(true)
    expect(updated[1]).toBe(conversations[1])
    expect(updated[2]).toBe(conversations[2])
    expect(updateAgentStarred(updated, 'agent-1', true)).toBe(updated)
  })

  test('Given Agent 列表快照 When 状态未知 Then 恢复为可渲染的空闲状态', () => {
    /** 模拟未来服务端返回当前客户端不认识的状态。 */
    const session = {
      id: 'agent-1',
      title: 'Agent',
      type: 'agent' as const,
      updatedAt: 1,
      runtimeStatus: 'future-status',
      starred: 1,
    } as unknown as ConvItem

    expect(normalizeAgentSessionSnapshot(session)).toEqual({
      ...session,
      runtimeStatus: 'idle',
      starred: true,
    })
  })

  test('Given 运行状态推送 When 解析并合并 Then 当前 Agent 与列表保持一致', () => {
    /** 推送解析结果用于隔离未知 WebSocket 数据。 */
    const update = readAgentRuntimeUpdate({ sessionId: 'agent-1', runtimeStatus: 'blocked' })
    expect(update).toEqual({ sessionId: 'agent-1', runtimeStatus: 'blocked' })
    expect(readAgentRuntimeUpdate({ sessionId: 1, runtimeStatus: 'running' })).toBeNull()

    /** 当前会话必须随全局列表同时更新，避免输入栏状态分裂。 */
    const active = createConversations()[0] ?? null
    expect(updateActiveAgentRuntimeStatus(active, 'agent-1', 'blocked')).toEqual({
      ...active,
      runtimeStatus: 'blocked',
    })
    expect(updateActiveAgentRuntimeStatus(active, 'missing', 'running')).toBe(active)
    expect(updateActiveAgentStarred(active, 'agent-1', true)).toEqual({ ...active, starred: true })
  })

  test('Given 星标命令响应 When 解析 Then 只接受有效会话结果', () => {
    expect(readAgentStarUpdate({ session: { id: 'agent-1', starred: true } })).toEqual({
      sessionId: 'agent-1',
      starred: true,
    })
    expect(readAgentStarUpdate({ session: { id: 1, starred: true } })).toBeNull()
    expect(readAgentStarUpdate({ session: { id: 'agent-1', starred: 'yes' } })).toBeNull()
  })
})
