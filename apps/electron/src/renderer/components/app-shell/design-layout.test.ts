import { describe, expect, test } from 'bun:test'
import { getRightPanelMode, shouldShowDesignTab } from './design-layout'

describe('项目级设计布局', () => {
  test('Given 未选项目 When 渲染顶部 Then 不显示 Design Tab', () => {
    expect(shouldShowDesignTab(null)).toBe(false)
  })

  test('Given 已选项目 When 渲染顶部 Then 显示 Design Tab', () => {
    expect(shouldShowDesignTab('project-1')).toBe(true)
  })

  test('Given 设计视图和项目 When 计算右栏 Then 显示设计面板且不要求会话', () => {
    expect(getRightPanelMode({
      activeView: 'design',
      appMode: 'agent',
      projectId: 'project-1',
      sessionId: null,
      automationOpen: false,
    })).toBe('design')
  })

  test('Given 会话视图 When 计算右栏 Then 保持原文件面板规则', () => {
    expect(getRightPanelMode({
      activeView: 'conversations',
      appMode: 'agent',
      projectId: 'project-1',
      sessionId: 'session-1',
      automationOpen: false,
    })).toBe('agent')
  })

  test('Given 设计视图无项目或全屏视图 When 计算右栏 Then 隐藏右栏', () => {
    expect(getRightPanelMode({
      activeView: 'design',
      appMode: 'agent',
      projectId: null,
      sessionId: 'session-1',
      automationOpen: false,
    })).toBe('hidden')
    expect(getRightPanelMode({
      activeView: 'planning',
      appMode: 'agent',
      projectId: 'project-1',
      sessionId: 'session-1',
      automationOpen: false,
    })).toBe('hidden')
  })
})
