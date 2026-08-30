import { afterEach, describe, expect, test } from 'bun:test'
import * as React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { LEGACY_DESIGN_CANVAS_ID } from '@proma/shared'
import type { AgentCanvasBinding, CanvasSessionMeta } from '@proma/shared'
import { createStore, Provider } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  agentCanvasViewStatesAtom,
  agentCanvasActivityStatesAtom,
  createAgentCanvasViewKey,
  createInitialAgentCanvasViewState,
} from '@/atoms/agent-canvas-atoms'
import { createInitialNativeCanvasState, nativeCanvasStatesAtom } from '@/atoms/native-canvas-atoms'
import { designAdapter } from '@/lib/design-adapter'
import {
  CanvasWorkspaceAdapter,
  isAgentCanvasActivityUnread,
  reconcileMissingCanvas,
  useAgentCanvasLegacyViewInitialization,
  useAgentCanvasWorkspaceRegistry,
} from './CanvasWorkspaceAdapter'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
}

/** 创建可控 Promise，验证异步结果乱序时的宿主代次。 */
function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })
  return { promise, resolve, reject }
}

interface MinimalEventTarget {
  addEventListener: () => void
  removeEventListener: () => void
}

/** 创建只承载返回 null 的 Hook Probe 的最小 DOM 宿主。 */
function createHookRoot(): {
  render: (node: React.ReactElement) => void
  unmount: () => void
  restore: () => void
} {
  const eventTarget: MinimalEventTarget = { addEventListener: () => undefined, removeEventListener: () => undefined }
  class FakeHtmlIFrameElement {}
  const fakeWindow = { ...eventTarget, event: undefined, HTMLIFrameElement: FakeHtmlIFrameElement }
  const fakeDocument = {
    ...eventTarget,
    nodeType: 9,
    defaultView: fakeWindow,
    activeElement: null,
    body: null,
    documentElement: { namespaceURI: 'http://www.w3.org/1999/xhtml' },
  }
  const container = {
    ...eventTarget,
    nodeType: 1,
    tagName: 'DIV',
    namespaceURI: 'http://www.w3.org/1999/xhtml',
    ownerDocument: fakeDocument,
  }
  const globals = globalThis as unknown as { window?: unknown; document?: unknown; IS_REACT_ACT_ENVIRONMENT?: boolean }
  const previousWindow = globals.window
  const previousDocument = globals.document
  const previousActEnvironment = globals.IS_REACT_ACT_ENVIRONMENT
  globals.window = fakeWindow
  globals.document = fakeDocument
  globals.IS_REACT_ACT_ENVIRONMENT = true
  const root = createRoot(container as unknown as Element)
  return {
    render: (node) => { root.render(node) },
    unmount: () => { root.unmount() },
    restore: () => {
      globals.window = previousWindow
      globals.document = previousDocument
      globals.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
    },
  }
}

const originalDesignAdapter = { ...designAdapter }

afterEach(() => {
  Object.assign(designAdapter, originalDesignAdapter)
})

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

  test('Given legacy Canvas StrictMode 挂载 When session 切换并最终卸载 Then 只保留当前 view 且不清 graph', async () => {
    const store = createStore()
    const host = createHookRoot()
    const graphState = createInitialNativeCanvasState()
    store.set(nativeCanvasStatesAtom, new Map([['graph-sentinel', graphState]]))
    function Probe({ sessionId }: { sessionId: string }): null {
      useAgentCanvasLegacyViewInitialization(sessionId, 'project-1', LEGACY_DESIGN_CANVAS_ID)
      return null
    }
    const firstKey = createAgentCanvasViewKey('agent-1', 'project-1', LEGACY_DESIGN_CANVAS_ID)
    const secondKey = createAgentCanvasViewKey('agent-2', 'project-1', LEGACY_DESIGN_CANVAS_ID)

    try {
      await act(async () => {
        host.render(<React.StrictMode><Provider store={store}><Probe sessionId="agent-1" /></Provider></React.StrictMode>)
        await Promise.resolve()
      })
      expect(store.get(agentCanvasViewStatesAtom).get(firstKey)).toMatchObject({ isExpanded: false })

      await act(async () => {
        host.render(<React.StrictMode><Provider store={store}><Probe sessionId="agent-2" /></Provider></React.StrictMode>)
        await Promise.resolve()
      })
      expect(store.get(agentCanvasViewStatesAtom).has(firstKey)).toBe(false)
      expect(store.get(agentCanvasViewStatesAtom).has(secondKey)).toBe(true)
      expect(store.get(nativeCanvasStatesAtom).get('graph-sentinel')).toBe(graphState)
    } finally {
      await act(async () => {
        host.unmount()
        await Promise.resolve()
      })
      expect(store.get(agentCanvasViewStatesAtom).has(secondKey)).toBe(false)
      expect(store.get(nativeCanvasStatesAtom).get('graph-sentinel')).toBe(graphState)
      host.restore()
    }
  })

  test('Given A LIST 未完成 When rerender 到 B 且响应乱序 Then 只提交 B 并清理旧订阅', async () => {
    const host = createHookRoot()
    const store = createStore()
    const requests = new Map<string, Deferred<AgentCanvasBinding[]>>()
    let releaseCalls = 0
    let latest: ReturnType<typeof useAgentCanvasWorkspaceRegistry> | null = null
    designAdapter.listAgentCanvasBindings = ({ projectId }) => {
      const request = createDeferred<AgentCanvasBinding[]>()
      requests.set(projectId, request)
      return request.promise
    }
    designAdapter.onAgentCanvasBindingChanged = () => () => { releaseCalls += 1 }
    designAdapter.onCanvasChanges = () => () => undefined
    function Probe({ projectId, sessionId }: { projectId: string; sessionId: string }): null {
      latest = useAgentCanvasWorkspaceRegistry(projectId, sessionId, () => undefined)
      return null
    }
    const bindingA = { projectId: 'project-a', sessionId: 'agent-a', linkedCanvasIds: [], updatedAt: 1 } satisfies AgentCanvasBinding
    const bindingB = { projectId: 'project-b', sessionId: 'agent-b', linkedCanvasIds: [], updatedAt: 2 } satisfies AgentCanvasBinding

    try {
      act(() => { host.render(<Provider store={store}><Probe projectId="project-a" sessionId="agent-a" /></Provider>) })
      act(() => { host.render(<Provider store={store}><Probe projectId="project-b" sessionId="agent-b" /></Provider>) })
      await act(async () => { requests.get('project-b')?.resolve([bindingB]); await Promise.resolve() })
      await act(async () => { requests.get('project-a')?.resolve([bindingA]); await Promise.resolve() })

      const currentRegistry = latest as ReturnType<typeof useAgentCanvasWorkspaceRegistry> | null
      expect(currentRegistry?.binding).toEqual(bindingB)
      expect(currentRegistry?.bindingReady).toBe(true)
      expect(releaseCalls).toBe(1)
    } finally {
      act(() => { host.unmount() })
      host.restore()
    }
  })

  test('Given A 用户动作未完成 When rerender 到 B 后 A 迟到失败 Then 不打开标签也不向 B 冒泡错误', async () => {
    const host = createHookRoot()
    const store = createStore()
    const linkRequest = createDeferred<AgentCanvasBinding>()
    const openedTabs: string[] = []
    let latest: ReturnType<typeof useAgentCanvasWorkspaceRegistry> | null = null
    designAdapter.listAgentCanvasBindings = async () => []
    designAdapter.onAgentCanvasBindingChanged = () => () => undefined
    designAdapter.onCanvasChanges = () => () => undefined
    designAdapter.linkAgentCanvas = () => linkRequest.promise
    function Probe({ projectId, sessionId }: { projectId: string; sessionId: string }): null {
      latest = useAgentCanvasWorkspaceRegistry(projectId, sessionId, (tab) => { openedTabs.push(tab) })
      return null
    }

    try {
      await act(async () => { host.render(<Provider store={store}><Probe projectId="project-a" sessionId="agent-a" /></Provider>) })
      const action = latest!.linkAndOpen('canvas-a')
      act(() => { host.render(<Provider store={store}><Probe projectId="project-b" sessionId="agent-b" /></Provider>) })
      await act(async () => {
        linkRequest.reject(new Error('A 已失效'))
        await expect(action).resolves.toBeUndefined()
      })
      expect(openedTabs).toEqual([])
    } finally {
      act(() => { host.unmount() })
      host.restore()
    }
  })

  test('Given 后台 Canvas 尚未 LOAD When 收到活动事件 Then 记录完整 view key 且不伪造 viewport', async () => {
    const host = createHookRoot()
    const store = createStore()
    let latest: ReturnType<typeof useAgentCanvasWorkspaceRegistry> | null = null
    const binding = {
      projectId: 'project-1', sessionId: 'agent-1', linkedCanvasIds: ['canvas-1'], updatedAt: 1,
    } satisfies AgentCanvasBinding
    designAdapter.listAgentCanvasBindings = async () => [binding]
    designAdapter.onAgentCanvasBindingChanged = () => () => undefined
    const key = createAgentCanvasViewKey('agent-1', 'project-1', 'canvas-1')
    store.set(agentCanvasActivityStatesAtom, new Map([[
      key, { activityRevision: 1, seenActivityRevision: 0 },
    ]]))
    function Probe(): null {
      latest = useAgentCanvasWorkspaceRegistry('project-1', 'agent-1', () => undefined)
      return null
    }

    try {
      await act(async () => { host.render(<Provider store={store}><Probe /></Provider>) })
      const currentRegistry = latest as ReturnType<typeof useAgentCanvasWorkspaceRegistry> | null
      expect(store.get(agentCanvasViewStatesAtom).has(key)).toBe(false)
      expect(currentRegistry?.canvasActivityStates.get('canvas-1')).toEqual({
        activityRevision: 1,
        seenActivityRevision: 0,
      })
      act(() => { currentRegistry?.markActivitySeen('canvas-1') })
      const seenRegistry = latest as ReturnType<typeof useAgentCanvasWorkspaceRegistry> | null
      expect(seenRegistry?.canvasActivityStates.get('canvas-1')).toEqual({
        activityRevision: 1,
        seenActivityRevision: 1,
      })
      expect(store.get(agentCanvasViewStatesAtom).has(key)).toBe(false)
    } finally {
      act(() => { host.unmount() })
      host.restore()
    }
  })

  test('Given activity 已读 When 新事件到达 Then 只在 revision 超过 seenRevision 时显示提示', () => {
    const initial = createInitialAgentCanvasViewState({ x: 0, y: 0, zoom: 1 })
    expect(isAgentCanvasActivityUnread(initial)).toBe(false)
    expect(isAgentCanvasActivityUnread({ ...initial, activityRevision: 1 })).toBe(true)
    expect(isAgentCanvasActivityUnread({ ...initial, activityRevision: 1, seenActivityRevision: 1 })).toBe(false)
  })
})
