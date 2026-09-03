import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { LEGACY_DESIGN_CANVAS_ID } from '@proma/shared'
import type { CanvasSessionMeta } from '@proma/shared'
import {
  CanvasWorkspaceSidebar,
  canDeleteCanvasFromWorkspaceSidebar,
  groupCanvasWorkspaceSessions,
  runCanvasSidebarNavigationAction,
  type CanvasSidebarPendingAction,
} from './CanvasWorkspaceSidebar'

/** 创建画布抽屉测试使用的稳定公开元数据。 */
function createSession(id: string, archived = false): CanvasSessionMeta {
  return {
    id,
    projectId: 'project-1',
    title: id,
    archived,
    createdAt: 1,
    updatedAt: 2,
  }
}

describe('Canvas 工作区画布抽屉', () => {
  test('Given 活动画布、归档画布和 legacy When 组装抽屉列表 Then 分组保序且 legacy 不可永久删除', () => {
    const active = createSession('canvas-active')
    const legacy = createSession(LEGACY_DESIGN_CANVAS_ID)
    const archived = createSession('canvas-archived', true)

    expect(groupCanvasWorkspaceSessions([active, legacy, archived])).toEqual({
      active: [active, legacy],
      archived: [archived],
    })
    expect(canDeleteCanvasFromWorkspaceSidebar(legacy)).toBe(false)
    expect(canDeleteCanvasFromWorkspaceSidebar(active)).toBe(true)
  })

  test('Given 抽屉导航动作 When 成功或失败 Then 仅成功关闭且 pending 必定释放', async () => {
    const pending: Array<CanvasSidebarPendingAction | null> = []
    const openStates: boolean[] = []
    const onPendingChange = (value: CanvasSidebarPendingAction | null): void => { pending.push(value) }
    const onOpenChange = (value: boolean): void => { openStates.push(value) }

    expect(await runCanvasSidebarNavigationAction({
      pendingAction: 'open:canvas-1',
      action: async () => true,
      onPendingChange,
      onOpenChange,
    })).toBe(true)
    expect(pending).toEqual(['open:canvas-1', null])
    expect(openStates).toEqual([false])

    expect(await runCanvasSidebarNavigationAction({
      pendingAction: 'open:canvas-2',
      action: async () => false,
      onPendingChange,
      onOpenChange,
    })).toBe(false)
    expect(pending.at(-1)).toBeNull()
    expect(openStates).toEqual([false])

    await expect(runCanvasSidebarNavigationAction({
      pendingAction: 'open:canvas-3',
      action: async () => { throw new Error('IPC_INTERNAL') },
      onPendingChange,
      onOpenChange,
    })).rejects.toThrow('IPC_INTERNAL')
    expect(pending.at(-1)).toBeNull()
    expect(openStates).toEqual([false])
  })

  test('Given 抽屉关闭或打开 When 渲染 Then 只在打开时展示 Pane 遮罩和项目画布状态', () => {
    const current = createSession('canvas-current')
    const secondary = createSession('canvas-secondary')
    const archived = createSession('canvas-archived', true)
    const props = {
      currentCanvasId: current.id,
      sessions: [current, secondary, archived],
      defaultCanvasId: secondary.id,
      activityStates: new Map([[secondary.id, { activityRevision: 2, seenActivityRevision: 1 }]]),
      onOpenChange: () => undefined,
      onCreateCanvas: async () => true,
      onOpenCanvas: async () => true,
      onSetDefaultCanvas: async () => true,
      onToggleArchiveCanvas: async () => true,
      onRequestDeleteCanvas: () => undefined,
    }

    expect(renderToStaticMarkup(<CanvasWorkspaceSidebar {...props} open={false} />)).toBe('')

    const html = renderToStaticMarkup(<CanvasWorkspaceSidebar {...props} open />)
    expect(html).toContain('data-canvas-sidebar-layer="true"')
    expect(html).toContain('aria-label="关闭画布列表"')
    expect(html).toContain('aria-label="项目画布"')
    expect(html).toContain('新建画布')
    expect(html).toContain('canvas-current')
    expect(html).toContain('aria-current="page"')
    expect(html).toContain('aria-label="默认画布"')
    expect(html).toContain('aria-label="有新版本"')
    expect(html).toContain('已归档 1')
    expect(html).not.toContain('canvas-archived</span>')
  })
})
