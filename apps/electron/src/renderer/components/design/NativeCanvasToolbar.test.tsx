import * as React from 'react'
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  NATIVE_CANVAS_NODE_TYPE_OPTIONS,
  NativeCanvasToolbar,
} from './NativeCanvasToolbar'

describe('原生 Canvas 顶部工具栏', () => {
  test('Given 可写 Canvas When 渲染工具栏 Then 选择、平移、添加和删除命令均可达', () => {
    const html = renderToStaticMarkup(
      <NativeCanvasToolbar
        activeTool="select"
        writable
        canDelete
        issueCount={0}
        onToolChange={() => undefined}
        onAddAgent={() => undefined}
        onDelete={() => undefined}
        onFocusFirstIssue={() => undefined}
      />,
    )

    expect(html).toContain('aria-label="选择工具"')
    expect(html).toContain('aria-pressed="true"')
    expect(html).toContain('aria-label="平移工具"')
    expect(html).toContain('aria-label="添加节点"')
    expect(html).toContain('aria-label="删除节点"')
  })

  test('Given 首版节点类型 When 读取添加菜单 Then 只启用 Agent 并说明未来类型即将支持', () => {
    expect(NATIVE_CANVAS_NODE_TYPE_OPTIONS).toEqual([
      { kind: 'agent', label: 'Agent', enabled: true },
      { kind: 'image', label: '生图', enabled: false },
      { kind: 'visual-document', label: '视觉文档', enabled: false },
      { kind: 'webview', label: '原型', enabled: false },
    ])
  })

  test('Given 两个问题节点 When 渲染工具栏 Then 显示可聚焦的问题入口', () => {
    const html = renderToStaticMarkup(
      <NativeCanvasToolbar
        activeTool="pan"
        writable
        canDelete={false}
        issueCount={2}
        onToolChange={() => undefined}
        onAddAgent={() => undefined}
        onDelete={() => undefined}
        onFocusFirstIssue={() => undefined}
      />,
    )

    expect(html).toContain('2 个节点需要处理')
    expect(html).toContain('aria-label="聚焦首个问题节点"')
  })

  test('Given Canvas 可写但创建暂不可用 When 渲染工具栏 Then 只禁用添加入口', () => {
    const html = renderToStaticMarkup(
      <NativeCanvasToolbar
        activeTool="select"
        writable
        canAdd={false}
        canDelete
        issueCount={0}
        onToolChange={() => undefined}
        onAddAgent={() => undefined}
        onDelete={() => undefined}
        onFocusFirstIssue={() => undefined}
      />,
    )

    expect(html).toMatch(/<button[^>]*aria-label="添加节点"[^>]*disabled=""/u)
    expect(html).not.toMatch(/<button[^>]*aria-label="删除节点"[^>]*disabled=""/u)
  })
})
