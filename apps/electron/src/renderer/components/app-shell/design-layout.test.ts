import { describe, expect, test } from 'bun:test'
import { getRightPanelMode, shouldShowCanvasTab } from './design-layout'

describe('Canvas 会话布局', () => {
  test('Given 未选 Canvas When 渲染顶部 Then 不显示 Canvas Tab', () => {
    expect(shouldShowCanvasTab(null)).toBe(false)
  })

  test('Given 已选 Canvas When 渲染顶部 Then 显示 Canvas Tab', () => {
    expect(shouldShowCanvasTab('canvas-1')).toBe(true)
  })

  test('Given legacy Canvas When 计算右栏 Then 显示设计面板且不要求 Agent 会话', () => {
    expect(getRightPanelMode({
      activeView: 'design',
      appMode: 'agent',
      projectId: 'project-1',
      canvasId: 'legacy-design',
      sessionId: null,
      automationOpen: false,
    })).toBe('design')
  })

  test('Given 原生 Canvas When 计算右栏 Then 不挂载旧 Design Inspector', () => {
    expect(getRightPanelMode({
      activeView: 'design',
      appMode: 'agent',
      projectId: 'project-1',
      canvasId: 'canvas-1',
      sessionId: null,
      automationOpen: false,
    })).toBe('hidden')
  })

  test('Given 会话视图 When 计算右栏 Then 保持原文件面板规则', () => {
    expect(getRightPanelMode({
      activeView: 'conversations',
      appMode: 'agent',
      projectId: 'project-1',
      canvasId: null,
      sessionId: 'session-1',
      automationOpen: false,
    })).toBe('agent')
  })

  test('Given 设计视图无项目或全屏视图 When 计算右栏 Then 隐藏右栏', () => {
    expect(getRightPanelMode({
      activeView: 'design',
      appMode: 'agent',
      projectId: null,
      canvasId: 'legacy-design',
      sessionId: 'session-1',
      automationOpen: false,
    })).toBe('hidden')
    expect(getRightPanelMode({
      activeView: 'planning',
      appMode: 'agent',
      projectId: 'project-1',
      canvasId: 'legacy-design',
      sessionId: 'session-1',
      automationOpen: false,
    })).toBe('hidden')
  })
})
