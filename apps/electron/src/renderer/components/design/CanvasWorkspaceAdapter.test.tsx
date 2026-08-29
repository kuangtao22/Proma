import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'bun:test'

describe('Agent 右侧 Canvas 适配器', () => {
  test('Given Canvas 仍有效 When 渲染 Then 使用普通 Agent 身份和 side-panel presentation', () => {
    const source = readFileSync(new URL('./CanvasWorkspaceAdapter.tsx', import.meta.url), 'utf8')

    expect(source).toContain('sessionId={sessionId}')
    expect(source).toContain('presentation="side-panel"')
    expect(source).not.toContain('activeCanvasSelectionAtom')
  })

  test('Given 关联 Canvas 已删除 When 适配器对账 Then 先显示失效状态并只清理当前关联', () => {
    const source = readFileSync(new URL('./CanvasWorkspaceAdapter.tsx', import.meta.url), 'utf8')

    expect(source).toContain('画布已删除')
    expect(source).toContain('unlinkAgentCanvas')
    expect(source).not.toContain('deleteCanvasSession')
  })

  test('Given 后台 Canvas 变化 When 收到事件 Then 只推进 activity revision', () => {
    const source = readFileSync(new URL('./CanvasWorkspaceAdapter.tsx', import.meta.url), 'utf8')

    expect(source).toContain('onCanvasChanged')
    expect(source).toContain('activityRevision')
    expect(source).not.toContain('setActiveCanvasSelection')
  })

  test('Given 右侧画布 When 展开后还原 Then 复用会话级 isExpanded 且不改变 tab identity', () => {
    const source = readFileSync(new URL('./CanvasWorkspaceAdapter.tsx', import.meta.url), 'utf8')

    expect(source).toContain('isExpanded')
    expect(source).toContain('展开画布')
    expect(source).toContain('还原画布')
    expect(source).toContain("'fixed inset-0")
    expect(source).not.toContain('agentSidePanelSplitMapAtom')
  })
})
