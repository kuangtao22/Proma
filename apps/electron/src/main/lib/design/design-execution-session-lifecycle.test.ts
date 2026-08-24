import { describe, expect, test } from 'bun:test'
import type { AgentSessionMeta } from '@proma/shared'
import { DesignExecutionSessionLifecycle } from './design-execution-session-lifecycle'

/** 构造拥有完整 Design 归属的内部会话。 */
function createInternalSession(): AgentSessionMeta {
  return {
    id: 'design-session-1', title: '设计任务：首页', workspaceId: 'project-1',
    sourceDesignProjectId: 'project-1', sourceDesignJobId: 'job-1',
    createdAt: 1, updatedAt: 1,
  }
}

/** 创建可观察清理顺序的生命周期测试环境。 */
function createHarness(session: AgentSessionMeta | null = createInternalSession()) {
  /** 按实际调用顺序记录的清理步骤。 */
  const calls: string[] = []
  const lifecycle = new DesignExecutionSessionLifecycle({
    getSession: () => session ?? undefined,
    clearPermission: () => { calls.push('permission') },
    clearAskUser: () => { calls.push('ask-user') },
    clearExitPlan: () => { calls.push('exit-plan') },
    clearQueue: () => { calls.push('queue') },
    closeBrowser: async () => { calls.push('browser') },
    deleteSession: () => { calls.push('session') },
  })
  return { lifecycle, calls }
}

describe('DesignExecutionSessionLifecycle', () => {
  test('Given trace 尚未 ready When 请求回收内部会话 Then 不删除唯一日志', async () => {
    const { lifecycle, calls } = createHarness()

    await expect(lifecycle.cleanup({ sessionId: 'design-session-1', traceState: 'pending' }))
      .rejects.toThrow('Design trace 尚未就绪')
    expect(calls).toEqual([])
  })

  test('Given trace ready 且归属完整 When 回收 Then 先清交互资源再删除会话', async () => {
    const { lifecycle, calls } = createHarness()

    await lifecycle.cleanup({ sessionId: 'design-session-1', traceState: 'ready' })

    expect(calls).toEqual(['permission', 'ask-user', 'exit-plan', 'queue', 'browser', 'session'])
  })

  test('Given 内部会话已删除 When 恢复再次回收 Then 幂等成功', async () => {
    const { lifecycle, calls } = createHarness(null)

    await expect(lifecycle.cleanup({ sessionId: 'design-session-1', traceState: 'ready' }))
      .resolves.toBeUndefined()
    expect(calls).toEqual([])
  })

  test('Given Design 元数据半损坏 When 回收 Then fail closed 且不触碰资源', async () => {
    const session = { ...createInternalSession(), sourceDesignJobId: undefined }
    const { lifecycle, calls } = createHarness(session)

    await expect(lifecycle.cleanup({ sessionId: 'design-session-1', traceState: 'ready' }))
      .rejects.toThrow('Design 内部会话归属无效')
    expect(calls).toEqual([])
  })

  test('Given 浏览器清理失败 When 回收 Then 保留会话供恢复重试', async () => {
    /** 删除调用次数用于确认浏览器失败后不会越过边界。 */
    let deleted = 0
    const lifecycle = new DesignExecutionSessionLifecycle({
      getSession: createInternalSession,
      clearPermission: () => {}, clearAskUser: () => {}, clearExitPlan: () => {}, clearQueue: () => {},
      closeBrowser: async () => { throw new Error('browser cleanup failed') },
      deleteSession: () => { deleted += 1 },
    })

    await expect(lifecycle.cleanup({ sessionId: 'design-session-1', traceState: 'ready' }))
      .rejects.toThrow('browser cleanup failed')
    expect(deleted).toBe(0)
  })
})
