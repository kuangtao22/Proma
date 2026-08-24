import { describe, expect, test } from 'bun:test'
import type { AgentSessionMeta } from '@proma/shared'
import { createTrayMenuModel } from './tray-menu-model'

/** 创建托盘测试使用的最小 Agent 会话。 */
function createSession(input: Partial<AgentSessionMeta> & Pick<AgentSessionMeta, 'id' | 'title'>): AgentSessionMeta {
  return {
    createdAt: 1,
    updatedAt: 1,
    ...input,
  }
}

describe('托盘会话投影', () => {
  test('Given 普通与内部 Design 会话 When 构建托盘 Then 运行中和最近列表都排除内部会话', () => {
    /** 普通用户会话。 */
    const visible = createSession({ id: 'visible-1', title: '用户会话', updatedAt: 2 })
    /** Design 内部执行会话。 */
    const internal = createSession({
      id: 'design-1',
      title: '设计任务',
      sourceDesignProjectId: 'project-1',
      sourceDesignJobId: 'job-1',
      updatedAt: 3,
    })

    expect(createTrayMenuModel([visible, internal], [], new Set(['design-1']))).toEqual({
      runningSessions: [],
      recentSessions: [{ id: 'visible-1', title: '用户会话', subtitle: '未选择项目' }],
      moreSessions: [],
    })
  })
})
