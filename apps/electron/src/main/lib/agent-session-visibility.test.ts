import { describe, expect, test } from 'bun:test'
import {
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
