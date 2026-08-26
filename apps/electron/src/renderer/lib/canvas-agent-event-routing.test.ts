import { describe, expect, test } from 'bun:test'
import type { AgentSessionMeta } from '@proma/shared'
import { routeCanvasAgentEvent } from './canvas-agent-event-routing'

/** 创建用于事件路由的完整 Canvas owner 元数据。 */
function createCanvasSession(overrides: Partial<AgentSessionMeta> = {}): AgentSessionMeta {
  return {
    id: 'session-1',
    title: 'Canvas Agent',
    workspaceId: 'project-1',
    sourceCanvasProjectId: 'project-1',
    sourceCanvasId: 'canvas-1',
    sourceCanvasNodeId: 'node-1',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

describe('Canvas Agent 全局事件路由', () => {
  test('Given 完整 Canvas owner When 路由 Then 保留 O(1) owner 且禁止普通会话副作用', () => {
    expect(routeCanvasAgentEvent(createCanvasSession())).toEqual({
      kind: 'canvas',
      owner: {
        sessionId: 'session-1',
        projectId: 'project-1',
        canvasId: 'canvas-1',
        nodeId: 'node-1',
        title: 'Canvas Agent',
      },
    })
  })

  test('Given 普通会话 When 路由 Then 保持普通 Agent 路径', () => {
    expect(routeCanvasAgentEvent(createCanvasSession({
      sourceCanvasProjectId: undefined, sourceCanvasId: undefined, sourceCanvasNodeId: undefined,
    })).kind).toBe('agent')
  })

  test.each([
    ['半归属会话', createCanvasSession({ sourceCanvasNodeId: undefined })],
    ['空项目归属', createCanvasSession({ sourceCanvasProjectId: '' })],
    ['项目归属带空格', createCanvasSession({ sourceCanvasProjectId: ' project-1 ' })],
    ['工作区不匹配', createCanvasSession({ workspaceId: 'project-2' })],
    ['混入委派归属', createCanvasSession({ sourceDelegationId: 'delegation-1' })],
  ])('Given %s When 路由 Then fail closed 为损坏内部会话', (_name, session) => {
    expect(routeCanvasAgentEvent(session).kind).toBe('internal-invalid')
  })
})
