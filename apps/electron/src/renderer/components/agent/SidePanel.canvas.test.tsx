import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'bun:test'
import type { AgentCanvasBinding, CanvasSessionMeta } from '@proma/shared'
import { buildCanvasWorkspaceTabs } from '@/components/design/CanvasWorkspaceAdapter'

describe('Agent 右侧画布动态标签', () => {
  test('Given 多个关联 Canvas When 组装标签 Then 保持 linked 顺序并显示标题', () => {
    const binding: AgentCanvasBinding = {
      projectId: 'project-1',
      sessionId: 'session-1',
      defaultCanvasId: 'canvas-2',
      lastActiveCanvasId: 'canvas-1',
      linkedCanvasIds: ['canvas-2', 'canvas-1'],
      updatedAt: 1,
    }
    const sessions: CanvasSessionMeta[] = [
      { id: 'canvas-1', projectId: 'project-1', title: '首页方案', archived: false, createdAt: 1, updatedAt: 1 },
      { id: 'canvas-2', projectId: 'project-1', title: '品牌方案', archived: false, createdAt: 1, updatedAt: 1 },
    ]

    expect(buildCanvasWorkspaceTabs(binding, sessions)).toEqual([
      expect.objectContaining({ id: 'canvas:canvas-2', title: '品牌方案', isDefault: true }),
      expect.objectContaining({ id: 'canvas:canvas-1', title: '首页方案', isRecent: true }),
    ])
  })

  test('Given 用户关闭 Canvas 标签 When 执行关闭 Then 只解除当前 Agent 关联', () => {
    const source = readFileSync(new URL('./SidePanel.tsx', import.meta.url), 'utf8')

    expect(source).toContain('canvasRegistry.unlink(canvasId)')
    expect(source).not.toContain("deleteCanvasSession({ projectId: currentWorkspaceId")
  })

  test('Given Canvas 在后台变化 When 更新活动 Then 不切换 activeTab', () => {
    const source = readFileSync(new URL('./SidePanel.tsx', import.meta.url), 'utf8')

    expect(source).toContain('canvasActivityRevision')
    expect(source).not.toContain("onTabChange(getCanvasWorkspaceTab(event.canvasId))")
  })

  test('Given 失效关联已异步清理 When 当前标签仍指向该 Canvas Then 只回退右侧标签', () => {
    const source = readFileSync(new URL('./SidePanel.tsx', import.meta.url), 'utf8')

    expect(source).toContain('activeCanvasId')
    expect(source).toContain('returnToPreviousTabAfterClose(activeTab)')
  })

  test('Given 用户打开已关联 Canvas When 最近画布不同 Then 只更新 binding 最近语义', () => {
    const source = readFileSync(new URL('./SidePanel.tsx', import.meta.url), 'utf8')

    expect(source).toContain('lastActiveCanvasId !== activeCanvasId')
    expect(source).toContain('canvasRegistry.markActive(activeCanvasId)')
  })
})
