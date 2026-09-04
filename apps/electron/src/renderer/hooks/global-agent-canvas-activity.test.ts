import { describe, expect, test } from 'bun:test'
import type {
  AgentCanvasBinding,
  AgentCanvasBindingChangeEvent,
  CanvasChangeEvent,
} from '@proma/shared'
import { createStore } from 'jotai'
import {
  agentDiffPanelTabAtom,
  agentSessionsAtom,
  agentSidePanelOpenAtomFamily,
  currentAgentSessionIdAtom,
  getCanvasWorkspaceTab,
} from '@/atoms/agent-atoms'
import { activeTabIdAtom } from '@/atoms/tab-atoms'
import {
  agentCanvasActivityStatesAtom,
  agentCanvasViewStatesAtom,
  createAgentCanvasViewKey,
  initializeAgentCanvasViewStateAtom,
} from '@/atoms/agent-canvas-atoms'
import {
  startGlobalAgentCanvasActivityConsumer,
  startGlobalAgentCanvasArtifactConsumer,
} from './useGlobalAgentListeners'

/** 等待异步 bindings 权威读取和 atom 提交完成。 */
async function flushActivity(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('全局普通 Agent Canvas activity consumer', () => {
  test('Given 只挂全局 listener 且后台 Agent 未挂载 When Canvas 变化 Then 所有关联 view key 增量且不抢 Files 焦点', async () => {
    const store = createStore()
    store.set(activeTabIdAtom, 'files')
    const bindings: AgentCanvasBinding[] = ['agent-current', 'agent-background'].map((sessionId) => ({
      projectId: 'project-1', sessionId, linkedCanvasIds: ['canvas-1'], updatedAt: 1,
    }))
    /** 用对象属性承接异步订阅回调，避免 TypeScript 把闭包赋值前的局部变量收窄为 never。 */
    const listeners: {
      canvas?: (event: CanvasChangeEvent) => void
      binding?: (event: AgentCanvasBindingChangeEvent) => void
    } = {}
    let canvasSubscriptions = 0
    const consumer = startGlobalAgentCanvasActivityConsumer(store, {
      listBindings: async () => structuredClone(bindings),
      onCanvasChanged: (listener) => { canvasSubscriptions += 1; listeners.canvas = listener; return () => undefined },
      onBindingChanged: (listener) => { listeners.binding = listener; return () => undefined },
    })

    listeners.canvas?.({
      projectId: 'project-1', canvasId: 'canvas-1', revision: 2, cause: 'graph',
      source: { sessionId: 'agent-current', runStartedAt: 10, toolCallId: 'tool-1' },
    })
    await flushActivity()

    const currentKey = createAgentCanvasViewKey('agent-current', 'project-1', 'canvas-1')
    const backgroundKey = createAgentCanvasViewKey('agent-background', 'project-1', 'canvas-1')
    expect(store.get(agentCanvasActivityStatesAtom).get(currentKey)?.activityRevision).toBe(1)
    /** 后台 Agent 没有挂载 SidePanel 或 Native controller，仍能看到全局未读事实。 */
    expect(store.get(agentCanvasActivityStatesAtom).get(backgroundKey)).toEqual({
      activityRevision: 1, seenActivityRevision: 0,
    })
    expect(store.get(activeTabIdAtom)).toBe('files')
    expect(canvasSubscriptions).toBe(1)

    bindings.splice(1, 1)
    listeners.binding?.({
      projectId: 'project-1', sessionId: 'agent-background', binding: null, cause: 'session-cleared',
    })
    listeners.canvas?.({ projectId: 'project-1', canvasId: 'canvas-1', revision: 3, cause: 'graph' })
    await flushActivity()

    expect(store.get(agentCanvasActivityStatesAtom).get(currentKey)?.activityRevision).toBe(2)
    expect(store.get(agentCanvasActivityStatesAtom).has(backgroundKey)).toBe(false)
    consumer.dispose()
  })

  test('Given 后台 Agent 创建画布产物 When 成功工具结果到达 Then 仅记录待定位节点且不自动打开画布', () => {
    const store = createStore()
    store.set(activeTabIdAtom, 'foreground-tab')
    store.set(currentAgentSessionIdAtom, 'agent-foreground')
    store.set(agentSessionsAtom, [
      { id: 'agent-foreground', title: '前台', workspaceId: 'project-1', createdAt: 1, updatedAt: 1 },
      { id: 'agent-background', title: '后台', workspaceId: 'project-1', createdAt: 1, updatedAt: 1 },
    ])
    store.set(agentSidePanelOpenAtomFamily('agent-background'), false)
    const consumer = startGlobalAgentCanvasArtifactConsumer(store)
    const viewKey = createAgentCanvasViewKey('agent-background', 'project-1', 'canvas-1')
    store.set(initializeAgentCanvasViewStateAtom, {
      key: viewKey,
      viewport: { x: 0, y: 0, zoom: 1 },
    })

    consumer.handle('agent-background', {
      type: 'tool_start',
      toolName: 'canvas_create_artifact',
      toolUseId: 'tool-artifact-1',
      input: {},
    })
    consumer.handle('agent-background', {
      type: 'tool_result',
      toolUseId: 'tool-artifact-1',
      result: JSON.stringify({
        canvasId: 'canvas-1', nodeId: 'node-1', revision: 4, artifactType: 'webview',
      }),
      isError: false,
    })

    expect(store.get(agentSidePanelOpenAtomFamily('agent-background'))).toBe(false)
    expect(store.get(agentDiffPanelTabAtom).has('agent-background')).toBe(false)
    expect(store.get(agentCanvasViewStatesAtom).get(viewKey)).toMatchObject({
      selectedNodeId: 'node-1',
      selectedNodeIds: ['node-1'],
      expandedNodeId: 'node-1',
    })
    expect(store.get(activeTabIdAtom)).toBe('foreground-tab')
    expect(store.get(currentAgentSessionIdAtom)).toBe('agent-foreground')
    consumer.dispose()
  })

  test('Given 失败、损坏、其它工具或跨会话结果 When 到达 Then 不导航', () => {
    const store = createStore()
    store.set(agentSessionsAtom, [
      { id: 'agent-1', title: 'Agent 1', workspaceId: 'project-1', createdAt: 1, updatedAt: 1 },
    ])
    store.set(agentSidePanelOpenAtomFamily('agent-1'), false)
    const consumer = startGlobalAgentCanvasArtifactConsumer(store)
    const validResult = JSON.stringify({
      canvasId: 'canvas-1', nodeId: 'node-1', revision: 4, artifactType: 'image',
    })

    consumer.handle('agent-1', {
      type: 'tool_start', toolName: 'Read', toolUseId: 'tool-read', input: {},
    })
    consumer.handle('agent-1', {
      type: 'tool_result', toolUseId: 'tool-read', result: validResult, isError: false,
    })
    consumer.handle('agent-1', {
      type: 'tool_start', toolName: 'canvas_create_artifact', toolUseId: 'tool-error', input: {},
    })
    consumer.handle('agent-1', {
      type: 'tool_result', toolUseId: 'tool-error', result: validResult, isError: true,
    })
    consumer.handle('agent-1', {
      type: 'tool_start', toolName: 'canvas_create_artifact', toolUseId: 'tool-broken', input: {},
    })
    consumer.handle('agent-1', {
      type: 'tool_result', toolUseId: 'tool-broken', result: '{', isError: false,
    })
    consumer.handle('agent-1', {
      type: 'tool_start', toolName: 'canvas_create_artifact', toolUseId: 'tool-other-session', input: {},
    })
    consumer.handle('agent-2', {
      type: 'tool_result', toolUseId: 'tool-other-session', result: validResult, isError: false,
    })

    expect(store.get(agentSidePanelOpenAtomFamily('agent-1'))).toBe(false)
    expect(store.get(agentDiffPanelTabAtom).has('agent-1')).toBe(false)
    expect(store.get(agentCanvasViewStatesAtom).size).toBe(0)
    consumer.dispose()
  })
})
