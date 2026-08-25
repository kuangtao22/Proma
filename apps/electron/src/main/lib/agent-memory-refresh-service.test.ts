import { describe, expect, mock, test } from 'bun:test'
import type { AgentSessionMeta } from '@proma/shared'
import { agentSessionManagerTestMock } from './agent-session-manager.test-mock'

/** 项目记忆测试使用的会话数据。 */
const memorySessions: AgentSessionMeta[] = [{
    id: 'visible-1', title: '用户会话', workspaceId: 'project-1', createdAt: 1, updatedAt: 20,
  }, {
    id: 'design-1', title: '设计任务', workspaceId: 'project-1', createdAt: 1, updatedAt: 30,
    sourceDesignProjectId: 'project-1', sourceDesignJobId: 'job-1',
  }, {
    id: 'canvas-partial', title: 'Canvas 半归属', workspaceId: 'project-1', createdAt: 1, updatedAt: 40,
    sourceCanvasId: 'canvas-1',
  }]

mock.module('./agent-workspace-manager', () => ({
  listAgentWorkspacesByUpdatedAt: () => [{ id: 'project-1', name: '项目一', slug: 'project-1' }],
  getAgentWorkspace: (workspaceId: string) => workspaceId === 'project-1'
    ? { id: 'project-1', name: '项目一', slug: 'project-1' }
    : undefined,
  getProjectFilesPath: () => '/tmp/project-1',
  getWorkspaceCapabilities: () => ({ mcpServers: [], skills: [] }),
  getWorkspaceMemoryReviewLastPromptAt: () => undefined,
  getWorkspaceMemorySummary: () => ({ autoMemory: { updatedAt: undefined } }),
  recordWorkspaceMemoryReviewInvitation: () => undefined,
}))

describe('项目记忆刷新机会', () => {
  test('Given 项目含内部 Design 与半归属 Canvas 会话 When 统计新会话 Then 只计算用户可见会话', async () => {
    agentSessionManagerTestMock.reset()
    for (const session of memorySessions) agentSessionManagerTestMock.sessions.set(session.id, session)
    const { claimWorkspaceMemoryRefreshOpportunity } = await import('./agent-memory-refresh-service')

    expect(claimWorkspaceMemoryRefreshOpportunity('project-1', 10 * 24 * 60 * 60 * 1000)).toEqual({
      memoryUpdatedAt: undefined,
      newestSessionAt: 20,
      newerSessionCount: 1,
    })
  })
})
