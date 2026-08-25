import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CanvasSessionMeta } from '@proma/shared'
import { createStore, Provider } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  activeCanvasSelectionAtom,
  canvasSessionsByProjectAtom,
} from '@/atoms/canvas-session-atoms'
import {
  CanvasWorkspaceEntry,
  CanvasWorkspaceEntryStateView,
  getCanvasWorkspaceMode,
} from './CanvasWorkspaceEntry'

/** 创建指定身份的稳定 Canvas 会话。 */
function createSession(id: string): CanvasSessionMeta {
  return {
    id,
    projectId: 'project-1',
    title: id === 'legacy-design' ? '默认设计画布' : '首页视觉探索',
    archived: false,
    createdAt: 1,
    updatedAt: 2,
  }
}

describe('Canvas 工作区分派', () => {
  test('Given legacy-design When 分派 Then 渲染现有 Design 工作区槽位', () => {
    const session = createSession('legacy-design')
    const html = renderToStaticMarkup(
      <CanvasWorkspaceEntryStateView
        mode={getCanvasWorkspaceMode(session)}
        session={session}
        legacyWorkspace={<div data-legacy-design-workspace>旧设计工作区</div>}
      />,
    )

    expect(html).toContain('data-legacy-design-workspace')
    expect(html).toContain('旧设计工作区')
  })

  test('Given 原生 Canvas When 分派 Then 只显示独立空状态', () => {
    const session = createSession('canvas-1')
    const html = renderToStaticMarkup(
      <CanvasWorkspaceEntryStateView
        mode={getCanvasWorkspaceMode(session)}
        session={session}
        legacyWorkspace={<div data-legacy-design-workspace>旧设计工作区</div>}
      />,
    )

    expect(html).toContain('首页视觉探索')
    expect(html).toContain('尚无节点')
    expect(html).not.toContain('data-legacy-design-workspace')
  })

  test('Given registry 选中原生 Canvas When 渲染完整入口 Then 不挂载 legacy 工作区', () => {
    const session = createSession('canvas-1')
    const store = createStore()
    store.set(canvasSessionsByProjectAtom, new Map([[session.projectId, [session]]]))
    store.set(activeCanvasSelectionAtom, { projectId: session.projectId, canvasId: session.id })

    const html = renderToStaticMarkup(
      <Provider store={store}>
        <CanvasWorkspaceEntry />
      </Provider>,
    )

    expect(html).toContain('首页视觉探索')
    expect(html).toContain('尚无节点')
    expect(html).not.toContain('正在加载设计工作区')
  })

  test('Given 工作区分派入口 When 检查源码 Then 不直接加载旧 Design 文档', () => {
    const source = readFileSync(join(import.meta.dir, 'CanvasWorkspaceEntry.tsx'), 'utf8')

    expect(source).not.toContain('loadDesignWorkspace')
  })
})
