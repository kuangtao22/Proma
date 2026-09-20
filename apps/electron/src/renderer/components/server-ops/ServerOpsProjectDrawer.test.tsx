import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ServerOpsProject } from '@proma/shared'
import {
  ServerOpsProjectDrawer,
  formatServerOpsProjectSummary,
  resolveServerOpsProjectDrawerReturnFocus,
  resolveServerOpsProjectDrawerWrapIndex,
  selectServerOpsProjectFromDrawer,
} from './ServerOpsProjectDrawer'
import type { ServerOpsConnectionSummary } from './server-ops-connections'

/** 两个项目：一个三类连接齐全，一个只有一台服务器。 */
const projects: ServerOpsProject[] = [
  { id: 'project-1', name: '生产环境', createdAt: 1, updatedAt: 1 },
  { id: 'project-2', name: '本地开发', createdAt: 2, updatedAt: 2 },
]

/** 与项目对应的连接统计。 */
const summaries: Record<string, ServerOpsConnectionSummary> = {
  'project-1': { ssh: 3, database: 1, redis: 1, total: 5 },
  'project-2': { ssh: 1, database: 0, redis: 0, total: 1 },
}

/** 渲染项目抽屉。 */
function renderDrawer(overrides: Partial<React.ComponentProps<typeof ServerOpsProjectDrawer>> = {}): string {
  return renderToStaticMarkup(
    <ServerOpsProjectDrawer
      open
      projects={projects}
      selectedProjectId="project-1"
      summaries={summaries}
      status="ready"
      onSelectProject={() => undefined}
      onOpenChange={() => undefined}
      onCreateProject={() => undefined}
      onRenameProject={() => undefined}
      onDeleteProject={() => undefined}
      {...overrides}
    />,
  )
}

describe('服务器运维项目抽屉', () => {
  test('Given 项目管理权限 When 展开抽屉 Then 添加与每行更多入口独立于项目选择', () => {
    /** 两个项目都应有独立命令入口，不能嵌套进选择按钮。 */
    const html = renderDrawer()
    expect(html).toContain('aria-label="添加项目"')
    expect(html).toContain('aria-label="管理项目：生产环境"')
    expect(html).toContain('aria-label="管理项目：本地开发"')
    expect(html).not.toMatch(/<button\b[^>]*>(?:(?!<\/button>)[\s\S])*<button\b/)
  })

  test('Given 已读取空列表 When 展示 Then 引导添加项目而不是重启客户端', () => {
    /** 无项目时用户可以直接创建，不应依赖重新启动。 */
    const html = renderDrawer({ projects: [], status: 'ready' })
    expect(html).toContain('添加项目')
    expect(html).not.toContain('请重启客户端')
  })

  test('Given 项目列表未读取成功 When 展示添加入口 Then 等待列表就绪以保留已有项目', () => {
    /** 首次列表未到时不允许创建，否则保存回执会取代尚未知晓的完整列表。 */
    for (const status of ['idle', 'loading', 'error'] as const) {
      expect(renderDrawer({ projects: [], status })).toMatch(/<button[^>]*aria-label="添加项目"[^>]*disabled=""/)
    }
    expect(renderDrawer({ projects: [], status: 'ready' })).not.toMatch(/<button[^>]*aria-label="添加项目"[^>]*disabled=""/)
  })
  test('Given 项目与统计 When 渲染 Then 只展示项目行与其连接统计', () => {
    const html = renderDrawer()
    expect(html).toContain('data-server-ops-project-drawer="true"')
    expect(html).toContain('aria-label="项目列表"')
    expect(html).toContain('data-server-ops-project="project-1"')
    expect(html).toContain('data-server-ops-project="project-2"')
    /** 抽屉一级只有项目：统计必须与项目视图里的连接数一致。 */
    expect(html).toContain('3 服务器 · 1 数据库 · 1 Redis')
    expect(html).toContain('1 服务器')
    expect(html).toContain('aria-current="page"')
  })

  test('Given 空项目 When 渲染 Then 说明该项目暂无连接而不是省略统计', () => {
    const html = renderDrawer({ summaries: { 'project-1': { ssh: 0, database: 0, redis: 0, total: 0 } } })
    expect(html).toContain('暂无连接')
    expect(html).toContain('data-server-ops-project-summary="project-1"')
  })

  test('Given 项目尚未就绪 When 渲染 Then 按读取中或失败原因给出说明', () => {
    const loadingHtml = renderDrawer({ projects: [], status: 'loading' })
    expect(loadingHtml).toContain('data-server-ops-project-empty')
    expect(loadingHtml).toContain('正在读取项目...')

    const errorHtml = renderDrawer({
      projects: [],
      status: 'error',
      error: '项目文件损坏或不可读，请检查数据根',
      onRetry: () => undefined,
    })
    expect(errorHtml).toContain('项目文件损坏或不可读，请检查数据根')
    expect(errorHtml).toContain('重试')
  })

  test('关闭时不渲染，打开时使用 Pane 内遮罩', () => {
    expect(renderToStaticMarkup(
      <ServerOpsProjectDrawer
        open={false}
        projects={projects}
        selectedProjectId={null}
        summaries={summaries}
        status="ready"
        onSelectProject={() => undefined}
        onOpenChange={() => undefined}
      />,
    )).toBe('')
    const html = renderDrawer()
    expect(html).toContain('aria-label="关闭项目列表"')
    expect(html).toContain('tabindex="-1"')
    expect(html).toContain('收起项目列表')
  })

  test('Given 抽屉内焦点到达首尾 When Tab 或 Shift+Tab Then 只在可见抽屉控件间循环', () => {
    expect(resolveServerOpsProjectDrawerWrapIndex(2, 3, false)).toBe(0)
    expect(resolveServerOpsProjectDrawerWrapIndex(0, 3, true)).toBe(2)
    expect(resolveServerOpsProjectDrawerWrapIndex(1, 3, false)).toBeNull()
    expect(resolveServerOpsProjectDrawerWrapIndex(1, 3, true)).toBeNull()
    /** 焦点意外不在面板列表时，Tab 回到首个命令，避免进入遮挡内容。 */
    expect(resolveServerOpsProjectDrawerWrapIndex(-1, 3, false)).toBe(0)
  })

  test('Given 原触发器因项目切换卸载 When 关闭抽屉 Then 回退同一 Pane 的新项目列表入口', () => {
    /** 已卸载的旧触发器。 */
    const previousFocus = { isConnected: false } as HTMLElement
    /** 同一 Pane 内新渲染的项目列表入口。 */
    const fallback = { isConnected: true } as HTMLElement
    /** 仅记录本 Pane 查询，不依赖浏览器 DOM。 */
    const paneRoot = {
      querySelector: (selector: string) => selector === 'button[aria-label="打开项目列表"]' ? fallback : null,
    } as unknown as HTMLElement

    expect(resolveServerOpsProjectDrawerReturnFocus(previousFocus, paneRoot)).toBe(fallback)
    expect(resolveServerOpsProjectDrawerReturnFocus({ isConnected: true } as HTMLElement, paneRoot)).not.toBe(fallback)
  })

  test('选择项目后更新身份并自动关闭抽屉', () => {
    /** 记录选择结果。 */
    const selected: string[] = []
    /** 记录抽屉开关结果。 */
    const openStates: boolean[] = []

    selectServerOpsProjectFromDrawer(
      'project-2',
      (projectId) => { selected.push(projectId) },
      (open) => { openStates.push(open) },
    )

    expect(selected).toEqual(['project-2'])
    expect(openStates).toEqual([false])
  })

  test('Given 连接统计 When 格式化 Then 只列出存在的类别', () => {
    expect(formatServerOpsProjectSummary(undefined)).toBe('暂无连接')
    expect(formatServerOpsProjectSummary({ ssh: 0, database: 0, redis: 2, total: 2 })).toBe('2 Redis')
    expect(formatServerOpsProjectSummary({ ssh: 1, database: 1, redis: 1, total: 3 })).toBe('1 服务器 · 1 数据库 · 1 Redis')
  })
})
