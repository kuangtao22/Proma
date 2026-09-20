import { describe, expect, test } from 'bun:test'
import { isAgentSessionUserVisible, isOrdinaryTopLevelAgentSession, requireOrdinaryTopLevelAgentSession }
  from './agent-session-eligibility'
import type { AgentSessionMeta } from './agent'

/** 构造最小会话元数据；只填写当前用例关心的字段。 */
function createSession(overrides: Partial<AgentSessionMeta> = {}): AgentSessionMeta {
  return { id: 'session-1', title: '普通会话', createdAt: 1, updatedAt: 1, ...overrides }
}

/** 各类内部或派生会话字段：任一存在都不允许进入高权限入口。 */
const ineligibleOverrides: Array<Partial<AgentSessionMeta>> = [
  { parentSessionId: 'parent-1' },
  { rootSessionId: 'root-1' },
  { sourceDelegationId: 'delegation-1' },
  { delegationRole: 'custom' },
  { delegationStatus: 'running' },
  { delegationDepth: 1 },
  { delegationGoal: '收集情报' },
  { automationGraduated: true },
]

describe('Agent 会话归属与可见性判定', () => {
  test('Given 普通顶层会话 When 判定 Then 同时可见且可用于高权限入口', () => {
    /** 用户自己新建的普通 Agent 会话。 */
    const session = createSession({ workspaceId: 'workspace-1' })
    expect(isAgentSessionUserVisible(session)).toBe(true)
    expect(isOrdinaryTopLevelAgentSession(session)).toBe(true)
    expect(requireOrdinaryTopLevelAgentSession(session)).toBe(session)
  })

  test('Given 定时任务会话 When 判定 Then 可见但不允许高权限入口', () => {
    // 定时任务创建的会话仍出现在普通会话列表里，但不得获得服务器授权等高权限能力。
    const session = createSession({ sourceAutomationId: 'automation-1' })
    expect(isAgentSessionUserVisible(session)).toBe(true)
    expect(isOrdinaryTopLevelAgentSession(session)).toBe(false)
    expect(() => requireOrdinaryTopLevelAgentSession(session)).toThrow('Agent 会话不存在')
  })

  test('Given 子会话、协作或升级残留 When 判定 Then 全部排除', () => {
    for (const overrides of ineligibleOverrides) {
      expect(isOrdinaryTopLevelAgentSession(createSession(overrides))).toBe(false)
    }
  })

  test('Given 画布或设计内部会话 When 判定 Then 既不可见也不可授权', () => {
    /** 归属完整的画布内部会话。 */
    const canvasSession = createSession({
      workspaceId: 'project-1',
      sourceCanvasProjectId: 'project-1',
      sourceCanvasId: 'canvas-1',
      sourceCanvasNodeId: 'node-1',
    })
    expect(isAgentSessionUserVisible(canvasSession)).toBe(false)
    expect(isOrdinaryTopLevelAgentSession(canvasSession)).toBe(false)
    /** 半损元数据的画布会话同样 fail closed。 */
    expect(isAgentSessionUserVisible(createSession({ sourceCanvasId: '' }))).toBe(false)
    expect(isAgentSessionUserVisible(createSession({ sourceDesignProjectId: 'project-1' }))).toBe(false)
  })

  test('Given 会话缺失 When 判定 Then 拒绝授权入口', () => {
    expect(isOrdinaryTopLevelAgentSession(undefined)).toBe(false)
    expect(() => requireOrdinaryTopLevelAgentSession(undefined)).toThrow('Agent 会话不存在')
  })
})
