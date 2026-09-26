import { describe, expect, test } from 'bun:test'
import type { AgentWorkspace } from '@proma/shared'
import { resolveAutomationWorkspace, summarizeAutomationWorkspace } from './automation-workspace'

/** 构造测试用工作区，只填解析与摘要真正消费的字段。 */
function buildWorkspace(id: string, overrides: Partial<AgentWorkspace> = {}): AgentWorkspace {
  return {
    id,
    name: `项目 ${id}`,
    slug: `slug-${id}`,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  }
}

/** 仅按 id 命中的工作区索引，用不存在目标验证 fail closed。 */
function buildLookup(workspaces: readonly AgentWorkspace[]): (id: string) => AgentWorkspace | undefined {
  const byId = new Map(workspaces.map((workspace) => [workspace.id, workspace]))
  return (id) => byId.get(id)
}

describe('定时任务目标工作区解析', () => {
  test('Given 省略 workspaceId When 解析 Then 沿用当前会话工作区', () => {
    const current = buildWorkspace('ws-a')
    expect(resolveAutomationWorkspace(undefined, 'ws-a', buildLookup([current]))).toBe(current)
  })

  test('Given 显式传入其他工作区 ID When 解析 Then 返回该工作区而不是当前工作区', () => {
    const current = buildWorkspace('ws-a')
    const target = buildWorkspace('ws-b')
    expect(resolveAutomationWorkspace('ws-b', 'ws-a', buildLookup([current, target]))).toBe(target)
  })

  test('Given ID 带首尾空白 When 解析 Then 去除空白后命中同一工作区', () => {
    const target = buildWorkspace('ws-b')
    expect(resolveAutomationWorkspace('  ws-b  ', 'ws-a', buildLookup([target]))).toBe(target)
  })

  test('Given 空字符串或非字符串 When 解析 Then 抛错，不把非法目标当作省略', () => {
    const lookup = buildLookup([buildWorkspace('ws-a')])
    expect(() => resolveAutomationWorkspace('', 'ws-a', lookup)).toThrow('workspaceId 必须是非空工作区 ID')
    expect(() => resolveAutomationWorkspace('   ', 'ws-a', lookup)).toThrow('workspaceId 必须是非空工作区 ID')
    expect(() => resolveAutomationWorkspace(42, 'ws-a', lookup)).toThrow('workspaceId 必须是非空工作区 ID')
  })

  test('Given 目标工作区不存在 When 解析 Then 抛错且不回退当前工作区', () => {
    const lookup = buildLookup([buildWorkspace('ws-a')])
    expect(() => resolveAutomationWorkspace('ws-missing', 'ws-a', lookup)).toThrow('目标工作区不存在或已删除: ws-missing')
  })

  test('Given 没有当前工作区且省略目标 When 解析 Then 返回 undefined 保留草稿态语义', () => {
    expect(resolveAutomationWorkspace(undefined, undefined, buildLookup([]))).toBeUndefined()
  })
})

describe('定时任务目标工作区摘要', () => {
  test('Given 托管项目 When 摘要 Then 项目根状态为 managed 且能标识当前工作区', () => {
    const workspace = buildWorkspace('ws-a')
    expect(summarizeAutomationWorkspace(workspace, 'ws-a')).toEqual({
      id: 'ws-a',
      name: '项目 ws-a',
      slug: 'slug-ws-a',
      isCurrent: true,
      projectRootStatus: 'managed',
    })
    expect(summarizeAutomationWorkspace(workspace, 'ws-b').isCurrent).toBe(false)
  })

  test('Given 本地项目根缺少运行时状态 When 摘要 Then 回退 unavailable 而不是谎报可用', () => {
    const workspace = buildWorkspace('ws-c', { projectRootPath: '/tmp/project-c' })
    expect(summarizeAutomationWorkspace(workspace, undefined).projectRootStatus).toBe('unavailable')
    const available = buildWorkspace('ws-d', { projectRootPath: '/tmp/project-d', projectRootStatus: 'available' })
    expect(summarizeAutomationWorkspace(available, undefined).projectRootStatus).toBe('available')
  })

  test('Given 任意工作区 When 摘要 Then 只暴露选择所需字段，不泄漏项目根路径', () => {
    const workspace = buildWorkspace('ws-e', { projectRootPath: '/tmp/project-e', projectRootStatus: 'available' })
    expect(Object.keys(summarizeAutomationWorkspace(workspace, undefined)).sort()).toEqual(
      ['id', 'isCurrent', 'name', 'projectRootStatus', 'slug'],
    )
  })
})
