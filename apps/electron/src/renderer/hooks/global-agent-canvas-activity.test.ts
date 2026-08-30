import { describe, expect, test } from 'bun:test'
import type {
  AgentCanvasBinding,
  AgentCanvasBindingChangeEvent,
  CanvasChangeEvent,
} from '@proma/shared'
import { createStore } from 'jotai'
import { activeTabIdAtom } from '@/atoms/tab-atoms'
import {
  agentCanvasActivityStatesAtom,
  createAgentCanvasViewKey,
} from '@/atoms/agent-canvas-atoms'
import { startGlobalAgentCanvasActivityConsumer } from './useGlobalAgentListeners'

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
})
