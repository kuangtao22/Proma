import { describe, expect, spyOn, test } from 'bun:test'
import { CANVAS_IPC_CHANNELS } from '@proma/shared'
import type {
  AgentCanvasBinding,
  AgentCanvasBindingChangeEvent,
  AgentSessionMeta,
  CanvasInvokeResult,
  CanvasSessionMeta,
} from '@proma/shared'
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import {
  clearDeletedAgentSessionCanvasBindings,
  registerAgentCanvasBindingIpcHandlers,
} from './agent-canvas-binding-ipc'

/** 测试 IPC handler 的最小异步签名。 */
type TestHandler = (event: IpcMainInvokeEvent, input?: unknown) => unknown

/** 创建可切换销毁状态的测试发送方。 */
function createSender(id: number, destroyed = false): WebContents {
  return { id, isDestroyed: () => destroyed } as unknown as WebContents
}

/** 创建普通项目 Agent 会话。 */
function createAgentSession(
  id = 'session-1',
  overrides: Partial<AgentSessionMeta> = {},
): AgentSessionMeta {
  return {
    id,
    title: '普通 Agent',
    workspaceId: 'project-1',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

/** 创建同项目 Canvas 元数据，legacy ID 也属于公开画布。 */
function createCanvasSession(id = 'canvas-1'): CanvasSessionMeta {
  return {
    id,
    projectId: 'project-1',
    title: '画布',
    archived: false,
    createdAt: 1,
    updatedAt: 1,
  }
}

/** 创建隔离副本语义的内存关联 Store。 */
function createStore() {
  /** 当前项目关联事实。 */
  let bindings: AgentCanvasBinding[] = []
  /** 复制关联，避免测试替身泄漏内部引用。 */
  const copy = (binding: AgentCanvasBinding): AgentCanvasBinding => ({
    ...binding,
    linkedCanvasIds: [...binding.linkedCanvasIds],
  })
  return {
    listByProject: (projectId: string) => bindings
      .filter((binding) => binding.projectId === projectId)
      .map(copy),
    link: (input: { projectId: string; sessionId: string; canvasId: string; makeDefault: boolean }) => {
      const existing = bindings.find((binding) => binding.projectId === input.projectId && binding.sessionId === input.sessionId)
      const linkedCanvasIds = existing?.linkedCanvasIds.includes(input.canvasId)
        ? [...existing.linkedCanvasIds]
        : [...(existing?.linkedCanvasIds ?? []), input.canvasId]
      const binding: AgentCanvasBinding = {
        projectId: input.projectId,
        sessionId: input.sessionId,
        defaultCanvasId: input.makeDefault ? input.canvasId : existing?.defaultCanvasId ?? input.canvasId,
        linkedCanvasIds,
        lastActiveCanvasId: input.makeDefault ? input.canvasId : existing?.lastActiveCanvasId ?? input.canvasId,
        updatedAt: 10,
      }
      bindings = [...bindings.filter((candidate) => candidate.projectId !== input.projectId || candidate.sessionId !== input.sessionId), binding]
      return copy(binding)
    },
    unlink: (input: { projectId: string; sessionId: string; canvasId: string }) => {
      const existing = bindings.find((binding) => binding.projectId === input.projectId && binding.sessionId === input.sessionId)
      if (!existing) return null
      const linkedCanvasIds = existing.linkedCanvasIds.filter((canvasId) => canvasId !== input.canvasId)
      bindings = bindings.filter((candidate) => candidate !== existing)
      if (linkedCanvasIds.length === 0) return null
      const binding = { ...existing, defaultCanvasId: linkedCanvasIds[0], lastActiveCanvasId: linkedCanvasIds[0], linkedCanvasIds, updatedAt: 11 }
      bindings.push(binding)
      return copy(binding)
    },
    setDefault: (input: { projectId: string; sessionId: string; canvasId: string }) => {
      const existing = bindings.find((binding) => binding.projectId === input.projectId && binding.sessionId === input.sessionId)
      if (!existing?.linkedCanvasIds.includes(input.canvasId)) throw new Error('not found')
      existing.defaultCanvasId = input.canvasId
      existing.lastActiveCanvasId = input.canvasId
      existing.updatedAt = 12
      return copy(existing)
    },
    clearSession: (projectId: string, sessionId: string) => {
      bindings = bindings.filter((binding) => binding.projectId !== projectId || binding.sessionId !== sessionId)
    },
    clearCanvas: (projectId: string, canvasId: string) => {
      bindings = bindings.flatMap((binding) => {
        if (binding.projectId !== projectId || !binding.linkedCanvasIds.includes(canvasId)) return [binding]
        const linkedCanvasIds = binding.linkedCanvasIds.filter((candidate) => candidate !== canvasId)
        return linkedCanvasIds.length === 0
          ? []
          : [{ ...binding, linkedCanvasIds, defaultCanvasId: linkedCanvasIds[0], lastActiveCanvasId: linkedCanvasIds[0], updatedAt: 13 }]
      })
    },
  }
}

/** 调用已注册 handler 并返回主进程安全信封。 */
async function invoke<T>(
  handlers: Map<string, TestHandler>,
  channel: string,
  sender: WebContents,
  input: unknown,
): Promise<CanvasInvokeResult<T>> {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`handler 未注册: ${channel}`)
  return await handler({ sender } as IpcMainInvokeEvent, input) as CanvasInvokeResult<T>
}

describe('Agent-画布关联 IPC', () => {
  test('Given 会话删除成功 When 清理关联 Then 只处理普通顶层 Agent 并排除内部身份', () => {
    const cleared: Array<{ projectId: string; sessionId: string }> = []
    const store = {
      clearSession: (projectId: string, sessionId: string) => { cleared.push({ projectId, sessionId }) },
    }

    expect(clearDeletedAgentSessionCanvasBindings(store, createAgentSession())).toBe(true)
    expect(clearDeletedAgentSessionCanvasBindings(store, createAgentSession('canvas-agent', {
      sourceCanvasProjectId: 'project-1', sourceCanvasId: 'canvas-1', sourceCanvasNodeId: 'node-1',
    }))).toBe(false)
    expect(clearDeletedAgentSessionCanvasBindings(store, createAgentSession('automation-agent', {
      sourceAutomationId: 'automation-1',
    }))).toBe(false)
    expect(clearDeletedAgentSessionCanvasBindings(store, createAgentSession('delegated-agent', {
      parentSessionId: 'parent-1', sourceDelegationId: 'delegation-1',
    }))).toBe(false)
    expect(cleared).toEqual([{ projectId: 'project-1', sessionId: 'session-1' }])
  })

  test('Given 授权普通 Agent 与同项目 Canvas When 五类 invoke Then 严格返回并广播变化，dispose 幂等解除', async () => {
    const handlers = new Map<string, TestHandler>()
    const removed: string[] = []
    const events: AgentCanvasBindingChangeEvent[] = []
    const sender = createSender(1)
    const store = createStore()
    const registration = registerAgentCanvasBindingIpcHandlers({
      ipcMain: {
        handle: (channel, handler) => { handlers.set(channel, handler) },
        removeHandler: (channel) => { handlers.delete(channel); removed.push(channel) },
      },
      store,
      getAgentSession: (sessionId) => createAgentSession(sessionId),
      listCanvasSessions: () => [createCanvasSession(), createCanvasSession('legacy-design'), createCanvasSession('canvas-2')],
      assertSenderProjectAccess: (candidate, projectId) => {
        if (candidate.isDestroyed() || candidate.id !== sender.id || projectId !== 'project-1') throw new Error('unauthorized')
      },
      broadcast: (event) => events.push(event),
    })

    expect(registration.channels).toEqual([
      CANVAS_IPC_CHANNELS.LIST_AGENT_BINDINGS,
      CANVAS_IPC_CHANNELS.LINK_AGENT_CANVAS,
      CANVAS_IPC_CHANNELS.UNLINK_AGENT_CANVAS,
      CANVAS_IPC_CHANNELS.SET_DEFAULT_AGENT_CANVAS,
      CANVAS_IPC_CHANNELS.CLEAR_AGENT_BINDINGS,
    ])
    expect((await invoke<AgentCanvasBinding[]>(handlers, CANVAS_IPC_CHANNELS.LIST_AGENT_BINDINGS, sender, { projectId: 'project-1' }))).toEqual({ ok: true, value: [] })
    expect((await invoke<AgentCanvasBinding>(handlers, CANVAS_IPC_CHANNELS.LINK_AGENT_CANVAS, sender, { projectId: 'project-1', sessionId: 'session-1', canvasId: 'legacy-design', makeDefault: false })).ok).toBe(true)
    await invoke(handlers, CANVAS_IPC_CHANNELS.LINK_AGENT_CANVAS, sender, { projectId: 'project-1', sessionId: 'session-1', canvasId: 'canvas-2', makeDefault: false })
    expect((await invoke<AgentCanvasBinding>(handlers, CANVAS_IPC_CHANNELS.SET_DEFAULT_AGENT_CANVAS, sender, { projectId: 'project-1', sessionId: 'session-1', canvasId: 'canvas-2' }))).toMatchObject({ ok: true, value: { defaultCanvasId: 'canvas-2' } })
    expect((await invoke<AgentCanvasBinding | null>(handlers, CANVAS_IPC_CHANNELS.UNLINK_AGENT_CANVAS, sender, { projectId: 'project-1', sessionId: 'session-1', canvasId: 'legacy-design' }))).toMatchObject({ ok: true, value: { linkedCanvasIds: ['canvas-2'] } })
    expect(await invoke<void>(handlers, CANVAS_IPC_CHANNELS.CLEAR_AGENT_BINDINGS, sender, { projectId: 'project-1', target: 'session', sessionId: 'session-1' })).toEqual({ ok: true, value: undefined })
    expect(events.map((event) => event.cause)).toEqual(['linked', 'linked', 'default-changed', 'unlinked', 'session-cleared'])
    expect(events.at(-1)).toEqual({ projectId: 'project-1', sessionId: 'session-1', cause: 'session-cleared', binding: null })

    registration.dispose()
    registration.dispose()
    expect(handlers.size).toBe(0)
    expect(removed.slice(-5)).toEqual(registration.channels)
  })

  test('Given canvas clear 影响多个身份 When 清理 Then 按写前写后差异广播每个受影响 Agent', async () => {
    const handlers = new Map<string, TestHandler>()
    const store = createStore()
    const events: AgentCanvasBindingChangeEvent[] = []
    const sender = createSender(1)
    registerAgentCanvasBindingIpcHandlers({
      ipcMain: { handle: (channel, handler) => { handlers.set(channel, handler) }, removeHandler: (channel) => handlers.delete(channel) },
      store,
      getAgentSession: (sessionId) => createAgentSession(sessionId),
      listCanvasSessions: () => [createCanvasSession(), createCanvasSession('canvas-2')],
      assertSenderProjectAccess: () => undefined,
      broadcast: (event) => events.push(event),
    })
    await invoke(handlers, CANVAS_IPC_CHANNELS.LINK_AGENT_CANVAS, sender, { projectId: 'project-1', sessionId: 'session-1', canvasId: 'canvas-1', makeDefault: false })
    await invoke(handlers, CANVAS_IPC_CHANNELS.LINK_AGENT_CANVAS, sender, { projectId: 'project-1', sessionId: 'session-2', canvasId: 'canvas-1', makeDefault: false })
    await invoke(handlers, CANVAS_IPC_CHANNELS.LINK_AGENT_CANVAS, sender, { projectId: 'project-1', sessionId: 'session-2', canvasId: 'canvas-2', makeDefault: false })
    events.length = 0

    await invoke<void>(handlers, CANVAS_IPC_CHANNELS.CLEAR_AGENT_BINDINGS, sender, { projectId: 'project-1', target: 'canvas', canvasId: 'canvas-1' })

    expect(events).toEqual([{
      projectId: 'project-1', sessionId: 'session-1', cause: 'canvas-cleared', binding: null,
    }, {
      projectId: 'project-1', sessionId: 'session-2', cause: 'canvas-cleared',
      binding: expect.objectContaining({ linkedCanvasIds: ['canvas-2'] }),
    }])
  })

  test('Given 未授权、销毁窗口、内部或跨项目身份 When 调用 Then fail closed 且 Store 无变化', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => undefined)
    const handlers = new Map<string, TestHandler>()
    const store = createStore()
    const sender = createSender(1)
    let session = createAgentSession()
    const access = { allowed: true }
    registerAgentCanvasBindingIpcHandlers({
      ipcMain: { handle: (channel, handler) => { handlers.set(channel, handler) }, removeHandler: (channel) => handlers.delete(channel) },
      store,
      getAgentSession: () => session,
      listCanvasSessions: () => [createCanvasSession()],
      assertSenderProjectAccess: (candidate) => {
        if (!access.allowed || candidate.isDestroyed()) throw new Error('/private/project-path')
      },
      broadcast: () => undefined,
    })
    const input = { projectId: 'project-1', sessionId: 'session-1', canvasId: 'canvas-1', makeDefault: false }
    access.allowed = false
    expect(await invoke(handlers, CANVAS_IPC_CHANNELS.LINK_AGENT_CANVAS, sender, input)).toEqual({ ok: false, error: { code: 'CANVAS_BINDING_FAILED', message: '画布关联失败，请重试。' } })
    access.allowed = true
    for (const overrides of [
      { sourceCanvasProjectId: 'project-1' },
      { sourceDesignProjectId: 'project-1' },
      { sourceAutomationId: 'automation-1' },
      { parentSessionId: 'parent-1' },
      { workspaceId: undefined },
      { workspaceId: 'project-2' },
    ] satisfies Array<Partial<AgentSessionMeta>>) {
      session = createAgentSession('session-1', overrides)
      expect((await invoke(handlers, CANVAS_IPC_CHANNELS.LINK_AGENT_CANVAS, sender, input)).ok).toBe(false)
    }
    session = null as unknown as AgentSessionMeta
    expect((await invoke(handlers, CANVAS_IPC_CHANNELS.LINK_AGENT_CANVAS, sender, input)).ok).toBe(false)
    expect(store.listByProject('project-1')).toEqual([])
    expect((await invoke(handlers, CANVAS_IPC_CHANNELS.LINK_AGENT_CANVAS, createSender(2, true), input)).ok).toBe(false)
    errorSpy.mockRestore()
  })
})
