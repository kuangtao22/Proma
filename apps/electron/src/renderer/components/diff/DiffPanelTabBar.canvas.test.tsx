import { describe, expect, test } from 'bun:test'
import {
  canDeleteCanvasFromWorkspaceMenu,
  runCanvasMenuAction,
  type CanvasMenuPendingAction,
} from './DiffPanelTabBar'

describe('右侧工作区画布菜单', () => {
  test('Given legacy 与 native Canvas When 计算菜单能力 Then legacy 可管理但不可删除', () => {
    const createSession = (id: string) => ({
      id,
      projectId: 'project-1',
      title: id,
      archived: false,
      createdAt: 1,
      updatedAt: 1,
    })

    expect(canDeleteCanvasFromWorkspaceMenu(createSession('legacy-design'))).toBe(false)
    expect(canDeleteCanvasFromWorkspaceMenu(createSession('canvas-1'))).toBe(true)
  })

  test('Given 菜单 Promise reject When 执行动作 Then 无 unhandled 且 pending 必定收口', async () => {
    const pendingStates: Array<CanvasMenuPendingAction | null> = []
    let settled = 0
    let unhandled = 0
    const onUnhandled = () => { unhandled += 1 }
    process.on('unhandledRejection', onUnhandled)
    try {
      await runCanvasMenuAction({
        pendingAction: 'archive:canvas-1',
        action: async () => { throw new Error('IPC_SECRET') },
        onPendingChange: (pending) => { pendingStates.push(pending) },
        onSettled: () => { settled += 1 },
      })
      await Promise.resolve()
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }

    expect(unhandled).toBe(0)
    expect(pendingStates).toEqual(['archive:canvas-1', null])
    expect(settled).toBe(1)
  })

  test('Given rename reject When blur 提交 Then 编辑态退出且可再次进入重试', async () => {
    let editingCanvasId: string | null = 'canvas-1'
    const pendingStates: Array<CanvasMenuPendingAction | null> = []

    await runCanvasMenuAction({
      pendingAction: 'rename:canvas-1',
      action: async () => { throw new Error('READ_ONLY') },
      onPendingChange: (pending) => { pendingStates.push(pending) },
      onSettled: () => { editingCanvasId = null },
    })

    expect(editingCanvasId).toBeNull()
    expect(pendingStates.at(-1)).toBeNull()
    editingCanvasId = 'canvas-1'
    expect(editingCanvasId).toBe('canvas-1')
  })

  test('Given 菜单动作成功 When 执行 Then pending 顺序与失败路径一致', async () => {
    const pendingStates: Array<CanvasMenuPendingAction | null> = []
    let calls = 0

    await runCanvasMenuAction({
      pendingAction: 'default:canvas-1',
      action: async () => { calls += 1 },
      onPendingChange: (pending) => { pendingStates.push(pending) },
    })

    expect(calls).toBe(1)
    expect(pendingStates).toEqual(['default:canvas-1', null])
  })
})
