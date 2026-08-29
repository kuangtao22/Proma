import { describe, expect, test } from 'bun:test'
import type { AgentCanvasBinding, CanvasSessionMeta } from '@proma/shared'
import { createAgentCanvasViewKey } from '@/atoms/agent-canvas-atoms'
import type { DesignAdapter } from '@/lib/design-adapter'
import {
  buildCanvasWorkspaceTabs,
  markAgentCanvasActive,
  unlinkAgentCanvasForSession,
} from '@/components/design/CanvasWorkspaceAdapter'
import {
  getCanvasDeleteFailureMessage,
  runCanvasDeleteAction,
  runCanvasWorkspaceAction,
} from './canvas-workspace-actions'

/** 创建指定 Agent 的稳定 binding。 */
function createBinding(sessionId: string, canvasId = 'canvas-1'): AgentCanvasBinding {
  return {
    projectId: 'project-1',
    sessionId,
    defaultCanvasId: canvasId,
    lastActiveCanvasId: canvasId,
    linkedCanvasIds: [canvasId],
    updatedAt: 1,
  }
}

describe('Agent 右侧画布动态标签', () => {
  test('Given 多个关联 Canvas When 组装标签 Then 保持 linked 顺序和默认最近语义', () => {
    const binding: AgentCanvasBinding = {
      ...createBinding('agent-1'),
      defaultCanvasId: 'canvas-2',
      lastActiveCanvasId: 'canvas-1',
      linkedCanvasIds: ['canvas-2', 'canvas-1'],
    }
    const sessions: CanvasSessionMeta[] = [
      { id: 'canvas-1', projectId: 'project-1', title: '首页方案', archived: false, createdAt: 1, updatedAt: 1 },
      { id: 'canvas-2', projectId: 'project-1', title: '品牌方案', archived: false, createdAt: 1, updatedAt: 1 },
    ]

    expect(buildCanvasWorkspaceTabs(binding, sessions)).toEqual([
      expect.objectContaining({ id: 'canvas:canvas-2', title: '品牌方案', isDefault: true, isRecent: false }),
      expect.objectContaining({ id: 'canvas:canvas-1', title: '首页方案', isDefault: false, isRecent: true }),
    ])
  })

  test('Given 用户关闭 Canvas 标签 When 执行关闭 Then 只调用 unlink 且保留 Canvas', async () => {
    const calls: string[] = []
    const adapter: Pick<DesignAdapter, 'unlinkAgentCanvas'> = {
      unlinkAgentCanvas: async (input) => {
        calls.push(`${input.sessionId}:${input.canvasId}`)
        return null
      },
    }

    await unlinkAgentCanvasForSession(adapter, 'project-1', 'agent-1', 'canvas-1')

    expect(calls).toEqual(['agent-1:canvas-1'])
  })

  test('Given 两个 Agent 共享同一 Canvas When 更新最近语义 Then binding 与视图身份互不串线', async () => {
    const inputs: string[] = []
    const adapter: Pick<DesignAdapter, 'linkAgentCanvas'> = {
      linkAgentCanvas: async (input) => {
        inputs.push(`${input.sessionId}:${input.canvasId}:${String(input.makeDefault)}`)
        return createBinding(input.sessionId, input.canvasId)
      },
    }

    await Promise.all([
      markAgentCanvasActive(adapter, 'project-1', 'agent-1', 'canvas-1'),
      markAgentCanvasActive(adapter, 'project-1', 'agent-2', 'canvas-1'),
    ])

    expect(inputs).toEqual([
      'agent-1:canvas-1:false',
      'agent-2:canvas-1:false',
    ])
    expect(createAgentCanvasViewKey('agent-1', 'project-1', 'canvas-1'))
      .not.toBe(createAgentCanvasViewKey('agent-2', 'project-1', 'canvas-1'))
  })

  test('Given 只读或 IPC reject When 执行菜单宿主动作 Then 固定中文提示且不抛出内部错误', async () => {
    const errors: string[] = []
    const logs: unknown[] = []

    const result = await runCanvasWorkspaceAction({
      action: async () => { throw new Error('READ_ONLY_INTERNAL_PATH=/secret/project') },
      failureMessage: '重命名画布失败',
      logContext: '重命名画布',
      onErrorMessage: (message) => { errors.push(message) },
      onLogError: (_context, error) => { logs.push(error) },
    })

    expect(result).toBeNull()
    expect(errors).toEqual(['重命名画布失败'])
    expect(errors.join('')).not.toContain('secret')
    expect(logs).toHaveLength(1)
  })

  test('Given 删除被运行任务阻断 When 确认删除 Then 保持确认态并返回固定可操作提示', async () => {
    expect(getCanvasDeleteFailureMessage(new Error('画布仍有任务运行')))
      .toBe('画布仍有任务运行，请先停止后再删除')
    expect(getCanvasDeleteFailureMessage(new Error('IPC_SECRET=/private/path')))
      .toBe('删除画布失败')

    let confirmationOpen = true
    const errors: string[] = []
    const deleted = await runCanvasDeleteAction({
      action: async () => { throw new Error('画布仍有任务运行') },
      onErrorMessage: (message) => { errors.push(message) },
      onLogError: () => undefined,
    })
    if (deleted) confirmationOpen = false

    expect(deleted).toBe(false)
    expect(confirmationOpen).toBe(true)
    expect(errors).toEqual(['画布仍有任务运行，请先停止后再删除'])
  })
})
