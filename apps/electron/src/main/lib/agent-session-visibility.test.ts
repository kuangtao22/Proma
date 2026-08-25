import { describe, expect, test } from 'bun:test'
import {
  hasValidCanvasAgentOwnership,
  hasValidDesignSessionOwnership,
  isAgentSessionUserVisible,
  isInternalDesignSession,
  requireUserVisibleAgentSession,
} from './agent-session-visibility'

describe('Agent 内部 Design 会话可见性', () => {
  test('Given Design 元数据只有一半 When 判断用户可见性 Then fail closed', () => {
    expect(isInternalDesignSession({ sourceDesignProjectId: 'project-1' })).toBe(true)
    expect(isInternalDesignSession({ sourceDesignJobId: 'job-1' })).toBe(true)
    expect(isAgentSessionUserVisible({ sourceDesignProjectId: 'project-1' })).toBe(false)
    expect(isAgentSessionUserVisible({ sourceDesignJobId: 'job-1' })).toBe(false)
    expect(hasValidDesignSessionOwnership({ sourceDesignProjectId: 'project-1' })).toBe(false)
  })

  test('Given 两个非空来源字段 When 判断归属 Then 只认成对的有效 Design 会话', () => {
    /** 拥有完整项目与任务来源的内部会话。 */
    const internal = {
      sourceDesignProjectId: 'project-1',
      sourceDesignJobId: 'job-1',
    }

    expect(hasValidDesignSessionOwnership(internal)).toBe(true)
    expect(isAgentSessionUserVisible(internal)).toBe(false)
  })

  test('Given 普通入口直接读取内部或不存在会话 When 校验 Then 统一返回会话不存在', () => {
    expect(() => requireUserVisibleAgentSession(undefined)).toThrow('Agent 会话不存在')
    expect(() => requireUserVisibleAgentSession({
      id: 'design-1',
      title: '内部任务',
      sourceDesignProjectId: 'project-1',
      sourceDesignJobId: 'job-1',
      createdAt: 1,
      updatedAt: 1,
    })).toThrow('Agent 会话不存在')
  })
})

describe('Agent 内部 Canvas 会话归属与可见性', () => {
  test('Given Canvas 三字段完整且工作区匹配 When 判断归属 Then 认定为合法内部会话', () => {
    /** 完整且归属同一项目的 Canvas Agent 元数据。 */
    const internal = {
      workspaceId: 'project-1',
      sourceCanvasProjectId: 'project-1',
      sourceCanvasId: 'canvas-1',
      sourceCanvasNodeId: 'node-1',
    }

    expect(hasValidCanvasAgentOwnership(internal)).toBe(true)
    expect(isAgentSessionUserVisible(internal)).toBe(false)
  })

  test('Given Canvas 项目原值不同但 trim 后相等 When 判断归属 Then 非法且 fail closed', () => {
    /** 来源项目带空格时不得通过严格项目身份比较。 */
    const malformed = {
      workspaceId: 'project-1',
      sourceCanvasProjectId: ' project-1 ',
      sourceCanvasId: 'canvas-1',
      sourceCanvasNodeId: 'node-1',
    }

    expect(hasValidCanvasAgentOwnership(malformed)).toBe(false)
    expect(isAgentSessionUserVisible(malformed)).toBe(false)
  })

  test.each([
    ['缺少项目字段', { workspaceId: 'project-1', sourceCanvasId: 'canvas-1', sourceCanvasNodeId: 'node-1' }],
    ['缺少画布字段', { workspaceId: 'project-1', sourceCanvasProjectId: 'project-1', sourceCanvasNodeId: 'node-1' }],
    ['缺少节点字段', { workspaceId: 'project-1', sourceCanvasProjectId: 'project-1', sourceCanvasId: 'canvas-1' }],
    ['只提供项目字段', { workspaceId: 'project-1', sourceCanvasProjectId: 'project-1' }],
    ['项目字段为空', { workspaceId: 'project-1', sourceCanvasProjectId: '', sourceCanvasId: 'canvas-1', sourceCanvasNodeId: 'node-1' }],
    ['画布字段为空白', { workspaceId: 'project-1', sourceCanvasProjectId: 'project-1', sourceCanvasId: ' ', sourceCanvasNodeId: 'node-1' }],
    ['节点字段为空', { workspaceId: 'project-1', sourceCanvasProjectId: 'project-1', sourceCanvasId: 'canvas-1', sourceCanvasNodeId: '' }],
    ['工作区不匹配', { workspaceId: 'project-2', sourceCanvasProjectId: 'project-1', sourceCanvasId: 'canvas-1', sourceCanvasNodeId: 'node-1' }],
  ])('Given Canvas %s When 判断归属与可见性 Then 非法且 fail closed', (_label, session) => {
    expect(hasValidCanvasAgentOwnership(session)).toBe(false)
    expect(isAgentSessionUserVisible(session)).toBe(false)
  })

  test('Given Design 与 Canvas 来源同时存在 When 判断 Canvas 归属 Then 拒绝混合所有权', () => {
    /** 同时声明两种内部执行来源的冲突元数据。 */
    const mixed = {
      workspaceId: 'project-1',
      sourceDesignProjectId: 'project-1',
      sourceDesignJobId: 'job-1',
      sourceCanvasProjectId: 'project-1',
      sourceCanvasId: 'canvas-1',
      sourceCanvasNodeId: 'node-1',
    }

    expect(hasValidCanvasAgentOwnership(mixed)).toBe(false)
    expect(isAgentSessionUserVisible(mixed)).toBe(false)
  })

  test('Given 普通会话 When 判断 Canvas 归属与可见性 Then 保持普通会话行为', () => {
    expect(hasValidCanvasAgentOwnership({ workspaceId: 'project-1' })).toBe(false)
    expect(isAgentSessionUserVisible({ workspaceId: 'project-1' })).toBe(true)
  })
})
