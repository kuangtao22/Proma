import { describe, expect, test } from 'bun:test'
import { LEGACY_DESIGN_CANVAS_ID } from '@proma/shared'
import type { AgentCanvasBinding, CanvasChangeEvent, CanvasSessionMeta } from '@proma/shared'
import { createStore, Provider } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  agentCanvasViewStatesAtom,
  createAgentCanvasViewKey,
  createInitialAgentCanvasViewState,
} from '@/atoms/agent-canvas-atoms'
import type { DesignAdapter } from '@/lib/design-adapter'
import {
  CanvasWorkspaceAdapter,
  reconcileMissingCanvas,
  subscribeAgentCanvasActivity,
} from './CanvasWorkspaceAdapter'

/** 创建稳定的公开 Canvas 元数据。 */
function createSession(id: string, archived = false): CanvasSessionMeta {
  return {
    id,
    projectId: 'project-1',
    title: id === LEGACY_DESIGN_CANVAS_ID ? '默认设计画布' : '首页方案',
    archived,
    createdAt: 1,
    updatedAt: 2,
  }
}

describe('Agent 右侧 Canvas 适配器', () => {
  test('Given legacy Canvas When 渲染真实适配器 Then 只挂旧内容且 native LOAD 为零', () => {
    let legacyRenderCount = 0
    let nativeLoadCount = 0
    const store = createStore()

    const html = renderToStaticMarkup(
      <Provider store={store}>
        <CanvasWorkspaceAdapter
          sessionId="agent-1"
          projectId="project-1"
          canvasId={LEGACY_DESIGN_CANVAS_ID}
          session={createSession(LEGACY_DESIGN_CANVAS_ID)}
          metadataReady
          onUnlink={async () => undefined}
          renderLegacyWorkspace={() => {
            legacyRenderCount += 1
            return <div data-legacy-design-workspace>旧设计内容</div>
          }}
          renderNativeWorkspace={() => {
            nativeLoadCount += 1
            return <div data-native-canvas-workspace>原生画布</div>
          }}
        />
      </Provider>,
    )

    expect(html).toContain('data-legacy-design-workspace')
    expect(html).toContain('旧设计内容')
    expect(html).not.toContain('data-native-canvas-workspace')
    expect(legacyRenderCount).toBe(1)
    expect(nativeLoadCount).toBe(0)
  })

  test('Given native Canvas When 渲染真实适配器 Then 传递普通 Agent 身份和 side-panel 语义', () => {
    const store = createStore()
    const key = createAgentCanvasViewKey('agent-1', 'project-1', 'canvas-1')
    store.set(agentCanvasViewStatesAtom, new Map([[key, createInitialAgentCanvasViewState({ x: 0, y: 0, zoom: 1 })]]))

    const html = renderToStaticMarkup(
      <Provider store={store}>
        <CanvasWorkspaceAdapter
          sessionId="agent-1"
          projectId="project-1"
          canvasId="canvas-1"
          session={createSession('canvas-1')}
          metadataReady
          onUnlink={async () => undefined}
          renderNativeWorkspace={(props) => (
            <div
              data-native-canvas-workspace
              data-session-id={props.sessionId}
              data-project-id={props.target.projectId}
              data-canvas-id={props.target.canvasId}
              data-presentation={props.presentation}
            />
          )}
        />
      </Provider>,
    )

    expect(html).toContain('data-native-canvas-workspace')
    expect(html).toContain('data-session-id="agent-1"')
    expect(html).toContain('data-presentation="side-panel"')
    expect(html).toContain('aria-label="展开画布"')
  })

  test('Given 关联 Canvas 已删除 When metadata 就绪 Then 只解除当前关联并吞掉 IPC reject', async () => {
    const unlinked: string[] = []
    const errors: unknown[] = []

    expect(await reconcileMissingCanvas({
      canvasId: 'canvas-missing',
      metadataReady: true,
      session: null,
      onUnlink: async (canvasId) => { unlinked.push(canvasId) },
      onError: (error) => { errors.push(error) },
    })).toBe('unlinked')
    expect(unlinked).toEqual(['canvas-missing'])

    expect(await reconcileMissingCanvas({
      canvasId: 'canvas-rejected',
      metadataReady: true,
      session: null,
      onUnlink: async () => { throw new Error('IPC_SECRET') },
      onError: (error) => { errors.push(error) },
    })).toBe('failed')
    expect(errors).toHaveLength(1)
  })

  test('Given 后台 Canvas 变化 When 订阅触发 Then 只更新对应 Agent 活动状态', () => {
    const listeners = new Map<string, (event: CanvasChangeEvent) => void>()
    const adapter: Pick<DesignAdapter, 'onCanvasChanged'> = {
      onCanvasChanged: (target, listener) => {
        listeners.set(target.canvasId, listener)
        return () => { listeners.delete(target.canvasId) }
      },
    }
    const binding: AgentCanvasBinding = {
      projectId: 'project-1',
      sessionId: 'agent-1',
      linkedCanvasIds: ['canvas-1', 'canvas-2'],
      defaultCanvasId: 'canvas-1',
      lastActiveCanvasId: 'canvas-1',
      updatedAt: 1,
    }
    const revisions: string[] = []
    const activeTab = 'files'

    const release = subscribeAgentCanvasActivity({
      adapter,
      projectId: 'project-1',
      sessionId: 'agent-1',
      binding,
      onActivity: (canvasId, viewKey) => { revisions.push(`${canvasId}:${viewKey}`) },
    })
    listeners.get('canvas-2')?.({
      projectId: 'project-1',
      canvasId: 'canvas-2',
      revision: 2,
      cause: 'graph',
    })

    expect(activeTab).toBe('files')
    expect(revisions).toEqual([
      `canvas-2:${createAgentCanvasViewKey('agent-1', 'project-1', 'canvas-2')}`,
    ])
    release()
    expect(listeners.size).toBe(0)
  })

  test('Given 展开态切换 When 重渲染 Then session/project/canvas 身份保持不变', () => {
    const store = createStore()
    const key = createAgentCanvasViewKey('agent-1', 'project-1', 'canvas-1')
    const initial = createInitialAgentCanvasViewState({ x: 0, y: 0, zoom: 1 })
    store.set(agentCanvasViewStatesAtom, new Map([[key, initial]]))
    const render = () => renderToStaticMarkup(
      <Provider store={store}>
        <CanvasWorkspaceAdapter
          sessionId="agent-1"
          projectId="project-1"
          canvasId="canvas-1"
          session={createSession('canvas-1')}
          metadataReady
          onUnlink={async () => undefined}
          renderNativeWorkspace={(props) => <div data-target={JSON.stringify(props)} />}
        />
      </Provider>,
    )

    expect(render()).toContain('aria-label="展开画布"')
    store.set(agentCanvasViewStatesAtom, new Map([[key, { ...initial, isExpanded: true }]]))
    const expanded = render()
    expect(expanded).toContain('aria-label="还原画布"')
    expect(expanded).toContain('agent-1')
    expect(expanded).toContain('canvas-1')
  })
})
