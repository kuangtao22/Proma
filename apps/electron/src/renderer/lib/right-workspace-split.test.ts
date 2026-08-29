import { describe, expect, test } from 'bun:test'
import type { AgentSidePanelTab } from '@/atoms/agent-atoms'
import {
  collapseRightWorkspaceSplit,
  createRightWorkspaceSplit,
  shouldRenderRightWorkspaceSplit,
  sanitizeRightWorkspaceSplit,
} from './right-workspace-split'

describe('Canvas 双 Pane', () => {
  test('Given Canvas 与 Files 并排 When 展开后还原 Then 保留两个标签身份', () => {
    const split = createRightWorkspaceSplit('files', 'canvas:canvas-1' as AgentSidePanelTab, 'right', 0.5)

    expect(split).not.toBeNull()
    expect(split?.leftTab).toBe('files')
    expect(split?.rightTab).toBe('canvas:canvas-1')
    expect(collapseRightWorkspaceSplit(split!)).toBe('canvas:canvas-1')
  })

  test('Given 窄宽降级后 Canvas 仍有关联 When 校验 split Then 不移除可用 Canvas 标签', () => {
    const split = createRightWorkspaceSplit('canvas:canvas-1' as AgentSidePanelTab, 'files', 'right', 0.5)!
    const available = new Set<AgentSidePanelTab>(['files', 'canvas:canvas-1' as AgentSidePanelTab])

    expect(sanitizeRightWorkspaceSplit(split, available).split).toEqual(split)
  })

  test('Given 宽度不足两个最小 Pane When 计算呈现 Then 只降级视图而不改 split identity', () => {
    const split = createRightWorkspaceSplit('files', 'canvas:canvas-1' as AgentSidePanelTab, 'right', 0.5)!

    expect(shouldRenderRightWorkspaceSplit(640)).toBe(false)
    expect(shouldRenderRightWorkspaceSplit(648)).toBe(true)
    expect(split).toEqual(expect.objectContaining({ leftTab: 'files', rightTab: 'canvas:canvas-1' }))
  })
})
