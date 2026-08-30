import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'bun:test'

describe('独立 Canvas 入口移除', () => {
  test('Given 左侧 Agent 导航 When 渲染项目与归档列表 Then 不再创建或展示 Canvas 行', () => {
    const source = readFileSync(new URL('./LeftSidebar.tsx', import.meta.url), 'utf8')

    expect(source).not.toContain('CanvasSessionItem')
    expect(source).not.toContain('createCanvasSessionInWorkspace')
    expect(source).not.toContain('canvas-archived-heading')
    expect(source).not.toContain('onNewCanvas')
  })

  test('Given 应用主导航 When 读取顶层布局源码 Then Canvas 仅由普通 Agent 右侧 workspace 承载', () => {
    const mainArea = readFileSync(new URL('../tabs/MainArea.tsx', import.meta.url), 'utf8')
    const tabBar = readFileSync(new URL('../tabs/TabBar.tsx', import.meta.url), 'utf8')
    const appShell = readFileSync(new URL('./AppShell.tsx', import.meta.url), 'utf8')
    const rightSidePanel = readFileSync(new URL('./RightSidePanel.tsx', import.meta.url), 'utf8')

    expect(mainArea).not.toContain("activeView === 'design'")
    expect(mainArea).not.toContain('CanvasWorkspaceEntry')
    expect(tabBar).not.toContain('CanvasSessionTab')
    expect(tabBar).not.toContain('activeCanvasSelectionAtom')
    expect(appShell).not.toContain('activeCanvasSessionAtom')
    expect(appShell).not.toContain('getRightPanelMode')
    expect(rightSidePanel).not.toContain('DesignInspector')
  })
})
