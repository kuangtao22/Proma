import { describe, expect, mock, test } from 'bun:test'

mock.module('./agent-session-manager', () => ({
  listAgentSessions: () => [{
    id: 'visible-1', title: '用户会话', workspaceId: 'project-1', createdAt: 1, updatedAt: 20,
  }, {
    id: 'design-1', title: '设计任务', workspaceId: 'project-1', createdAt: 1, updatedAt: 30,
    sourceDesignProjectId: 'project-1', sourceDesignJobId: 'job-1',
  }],
}))

mock.module('./agent-workspace-manager', () => ({
  getWorkspaceMemoryReviewLastPromptAt: () => undefined,
  getWorkspaceMemorySummary: () => ({ autoMemory: { updatedAt: undefined } }),
  recordWorkspaceMemoryReviewInvitation: () => undefined,
}))

describe('项目记忆刷新机会', () => {
  test('Given 项目含内部 Design 会话 When 统计新会话 Then 只计算用户可见会话', async () => {
    const { claimWorkspaceMemoryRefreshOpportunity } = await import('./agent-memory-refresh-service')

    expect(claimWorkspaceMemoryRefreshOpportunity('project-1', 10 * 24 * 60 * 60 * 1000)).toEqual({
      memoryUpdatedAt: undefined,
      newestSessionAt: 20,
      newerSessionCount: 1,
    })
  })
})
