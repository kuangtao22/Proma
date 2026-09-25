import { describe, expect, test } from 'bun:test'
import { apiWorkbenchAgentDenialReason, apiWorkbenchManualDenialReason, isAgentSessionUserVisible, isOrdinaryTopLevelAgentSession, requireOrdinaryTopLevelAgentSession }
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

  test('Given 普通会话且有项目 When 判定 Agent 出网 Then 允许', () => {
    const session = createSession({ workspaceId: 'workspace-1' })

    expect(apiWorkbenchAgentDenialReason(session, true)).toBeNull()
    expect(apiWorkbenchManualDenialReason(session, true)).toBeNull()
  })

  test('Given 探索或委派子会话 When 判定 Then Agent 出网拒绝、界面手发放行', () => {
    /** 现场案例：用户在被委派/探索出来的子会话里点开接口标签。 */
    const exploration = createSession({ workspaceId: 'workspace-1', explorationParentSessionId: 'parent-1' })
    const delegated = createSession({ workspaceId: 'workspace-1', parentSessionId: 'parent-1' })

    expect(apiWorkbenchAgentDenialReason(exploration, true)).toBe('这是探索子会话；Agent 出网能力只在主会话开放')
    expect(apiWorkbenchAgentDenialReason(delegated, true)).toBe('接口工作台只在普通交互会话可用（后台任务、委派与画布会话不开放）')
    /** 界面手发只要「会话可见 + 未归档 + 有项目」：人在界面点发送，意图明确。 */
    expect(apiWorkbenchManualDenialReason(exploration, true)).toBeNull()
    expect(apiWorkbenchManualDenialReason(delegated, true)).toBeNull()
  })

  test('Given 归档、无项目或项目已删 When 判定 Then 两条路径都给出可行动原因', () => {
    const archived = createSession({ workspaceId: 'workspace-1', archived: true })
    const noProject = createSession()
    const missingProject = createSession({ workspaceId: 'workspace-1' })

    expect(apiWorkbenchAgentDenialReason(archived, true)).toBe('当前会话已归档；请在未归档的会话里打开接口工作台')
    expect(apiWorkbenchManualDenialReason(archived, true)).toBe('当前会话已归档；请在未归档的会话里打开接口工作台')
    expect(apiWorkbenchManualDenialReason(noProject, true)).toBe('当前会话没有归属项目；请先在项目里打开会话')
    expect(apiWorkbenchManualDenialReason(missingProject, false)).toBe('会话归属的项目已不存在；请重新选择项目')
    expect(apiWorkbenchManualDenialReason(undefined, true)).toBe('当前会话已不可见或已被删除（画布或设计内部会话不开放）')
  })

  test('Given 后台会话 When 判定 Then Agent 出网拒绝，但人在界面手发仍可用', () => {
    for (const override of [...ineligibleOverrides, { sourceAutomationId: 'automation-1' }]) {
      const session = createSession({ workspaceId: 'workspace-1', ...override })
      expect(apiWorkbenchAgentDenialReason(session, true)).toBe('接口工作台只在普通交互会话可用（后台任务、委派与画布会话不开放）')
      expect(apiWorkbenchManualDenialReason(session, true)).toBeNull()
    }
  })

  test('Given 画布或设计内部会话 When 判定 Then 两条路径都拒绝', () => {
    /** 这些会话对用户不可见，人的界面手发也无从谈起。 */
    for (const override of [{ sourceCanvasId: 'canvas-1' }, { sourceDesignProjectId: 'project-1' }]) {
      const session = createSession({ workspaceId: 'workspace-1', ...override })
      expect(apiWorkbenchAgentDenialReason(session, true)).toBe('接口工作台只在普通交互会话可用（后台任务、委派与画布会话不开放）')
      expect(apiWorkbenchManualDenialReason(session, true)).toBe('当前会话已不可见或已被删除（画布或设计内部会话不开放）')
    }
  })
})
