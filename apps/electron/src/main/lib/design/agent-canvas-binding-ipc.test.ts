import { describe, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CANVAS_IPC_CHANNELS } from '@proma/shared'
import type {
  AgentCanvasBinding,
  AgentCanvasBindingChangeEvent,
  AgentSessionMeta,
  CanvasInvokeResult,
  CanvasSessionMeta,
} from '@proma/shared'
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { writeJsonFileAtomicSecure } from '../safe-file'
import { AgentCanvasBindingStore } from './agent-canvas-binding-store'
import {
  cleanupDeletedAgentSessionCanvasBindings,
  cleanupDeletedCanvasBindings,
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
  const store = {
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
      if (!existing.linkedCanvasIds.includes(input.canvasId)) return copy(existing)
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
      if (existing.defaultCanvasId === input.canvasId && existing.lastActiveCanvasId === input.canvasId) return copy(existing)
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
    reconcileProject: (
      projectId: string,
      isSessionValid: (sessionId: string) => boolean,
      isCanvasValid: (canvasId: string) => boolean,
    ) => {
      const changes: Array<{
        sessionId: string
        cause: 'session-cleared' | 'canvas-cleared'
        binding: AgentCanvasBinding | null
      }> = []
      bindings = bindings.flatMap((binding) => {
        if (binding.projectId !== projectId) return [binding]
        if (!isSessionValid(binding.sessionId)) {
          changes.push({ sessionId: binding.sessionId, cause: 'session-cleared', binding: null })
          return []
        }
        const linkedCanvasIds = binding.linkedCanvasIds.filter(isCanvasValid)
        if (linkedCanvasIds.length === binding.linkedCanvasIds.length) return [binding]
        if (linkedCanvasIds.length === 0) {
          changes.push({ sessionId: binding.sessionId, cause: 'canvas-cleared', binding: null })
          return []
        }
        const updated = {
          ...binding,
          linkedCanvasIds,
          defaultCanvasId: linkedCanvasIds.includes(binding.defaultCanvasId ?? '')
            ? binding.defaultCanvasId
            : linkedCanvasIds[0],
          lastActiveCanvasId: linkedCanvasIds.includes(binding.lastActiveCanvasId ?? '')
            ? binding.lastActiveCanvasId
            : linkedCanvasIds[0],
          updatedAt: 13,
        }
        changes.push({ sessionId: binding.sessionId, cause: 'canvas-cleared', binding: copy(updated) })
        return [updated]
      })
      return { bindings: bindings.filter((binding) => binding.projectId === projectId).map(copy), changes }
    },
  }
  return {
    ...store,
    linkWithChange: (input: Parameters<typeof store.link>[0]) => {
      const before = store.listByProject(input.projectId).find((binding) => binding.sessionId === input.sessionId) ?? null
      const after = store.link(input)
      return { before, after, changed: JSON.stringify(before) !== JSON.stringify(after) }
    },
    unlinkWithChange: (input: Parameters<typeof store.unlink>[0]) => {
      const before = store.listByProject(input.projectId).find((binding) => binding.sessionId === input.sessionId) ?? null
      const after = store.unlink(input)
      return { before, after, changed: JSON.stringify(before) !== JSON.stringify(after) }
    },
    setDefaultWithChange: (input: Parameters<typeof store.setDefault>[0]) => {
      const before = store.listByProject(input.projectId).find((binding) => binding.sessionId === input.sessionId) ?? null
      const after = store.setDefault(input)
      return { before, after, changed: JSON.stringify(before) !== JSON.stringify(after) }
    },
    clearSessionWithChanges: (projectId: string, sessionId: string) => {
      const before = store.listByProject(projectId).find((binding) => binding.sessionId === sessionId) ?? null
      store.clearSession(projectId, sessionId)
      return before ? [{ sessionId, cause: 'session-cleared' as const, binding: null }] : []
    },
    clearCanvasWithChanges: (projectId: string, canvasId: string) => {
      const before = store.listByProject(projectId)
      store.clearCanvas(projectId, canvasId)
      const after = new Map(store.listByProject(projectId).map((binding) => [binding.sessionId, binding]))
      return before.flatMap((binding) => {
        const current = after.get(binding.sessionId) ?? null
        return JSON.stringify(binding) === JSON.stringify(current)
          ? []
          : [{ sessionId: binding.sessionId, cause: 'canvas-cleared' as const, binding: current }]
      })
    },
  }
}

/** 测试默认让全部关联 mutation 通过项目写守卫。 */
function createProjectMutationDependencies() {
  return {
    ensureLegacyCanvasSession: (_projectId: string): void => undefined,
    getProjectReadOnlyReason: (_projectId: string): string | undefined => undefined,
    runProjectMutation: <T>(_projectId: string, effect: () => T): T => effect(),
  }
}

/** 删除生命周期测试显式注入同步项目写守卫。 */
function createCleanupMutationDependency() {
  return {
    runProjectMutation: <T>(_projectId: string, effect: () => T): T => effect(),
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
  test('Given 单会话、Canvas 与工作区删除入口 When 检查主进程接缝 Then 均在主删除成功后使用 best-effort helper', () => {
    const source = readFileSync(join(import.meta.dir, '../../ipc.ts'), 'utf8')
    expect(source).toContain('cleanupDeletedCanvasBindings(agentCanvasBindingCleanup, projectId, canvasId)')
    expect(source).toContain('cleanupDeletedAgentSessionCanvasBindings(agentCanvasBindingCleanup, deletingSession)')
    const workspaceDelete = source.indexOf('for (const sessionId of affectedSessionIds)')
    const sessionDelete = source.indexOf('deleteAgentSession(sessionId)', workspaceDelete)
    const bindingCleanup = source.indexOf('cleanupDeletedAgentSessionCanvasBindings(agentCanvasBindingCleanup, deletedSession)', sessionDelete)
    expect(workspaceDelete).toBeGreaterThan(-1)
    expect(sessionDelete).toBeGreaterThan(workspaceDelete)
    expect(bindingCleanup).toBeGreaterThan(sessionDelete)
    expect(source).toContain('getProjectReadOnlyReason: getDesignProjectReadOnlyReason')
    expect(source).toContain('runProjectMutation: (projectId, effect) => workspaceOperationGuard.runWorkspaceWrite(projectId, effect)')
    expect(source).toContain('ensureLegacyCanvasSession: (projectId) => canvasSessionStore.ensureLegacySession(projectId)')
    expect(source).toContain('listCanvasSessions: (projectId) => canvasSessionStore.list({ projectId })')
  })

  test('Given 会话删除成功 When 清理关联 Then 只处理普通顶层 Agent 并排除内部身份', () => {
    const cleared: Array<{ projectId: string; sessionId: string }> = []
    let binding: AgentCanvasBinding | null = {
      projectId: 'project-1', sessionId: 'session-1', defaultCanvasId: 'canvas-1',
      linkedCanvasIds: ['canvas-1'], lastActiveCanvasId: 'canvas-1', updatedAt: 1,
    }
    const store = {
      clearSessionWithChanges: (projectId: string, sessionId: string) => {
        cleared.push({ projectId, sessionId })
        binding = null
        return [{ sessionId, cause: 'session-cleared' as const, binding: null }]
      },
      clearCanvasWithChanges: () => [],
    }

    expect(cleanupDeletedAgentSessionCanvasBindings({ ...createCleanupMutationDependency(), store, broadcast: () => undefined }, createAgentSession())).toBeUndefined()
    expect(cleanupDeletedAgentSessionCanvasBindings({ ...createCleanupMutationDependency(), store, broadcast: () => undefined }, createAgentSession('canvas-agent', {
      sourceCanvasProjectId: 'project-1', sourceCanvasId: 'canvas-1', sourceCanvasNodeId: 'node-1',
    }))).toBeUndefined()
    expect(cleanupDeletedAgentSessionCanvasBindings({ ...createCleanupMutationDependency(), store, broadcast: () => undefined }, createAgentSession('automation-agent', {
      sourceAutomationId: 'automation-1',
    }))).toBeUndefined()
    expect(cleanupDeletedAgentSessionCanvasBindings({ ...createCleanupMutationDependency(), store, broadcast: () => undefined }, createAgentSession('delegated-agent', {
      parentSessionId: 'parent-1', sourceDelegationId: 'delegation-1',
    }))).toBeUndefined()
    expect(cleared).toEqual([{ projectId: 'project-1', sessionId: 'session-1' }])
  })

  test('Given 关联清理 Store 或广播失败 When 主实体已删除 Then 固定日志且不反向抛错', () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => undefined)
    const bindingValue: AgentCanvasBinding = {
      projectId: 'project-1', sessionId: 'session-1', defaultCanvasId: 'canvas-1',
      linkedCanvasIds: ['canvas-1'], lastActiveCanvasId: 'canvas-1', updatedAt: 1,
    }
    const preCommitFailure = {
      clearSessionWithChanges: () => { throw new Error('/private/precommit-path') },
      clearCanvasWithChanges: () => { throw new Error('/private/store-path') },
    }
    expect(() => cleanupDeletedAgentSessionCanvasBindings(
      { ...createCleanupMutationDependency(), store: preCommitFailure, broadcast: () => undefined },
      createAgentSession(),
    )).not.toThrow()
    let committed = true
    const postCommitFailure = {
      clearSessionWithChanges: () => { committed = false; throw new Error('/private/postcommit-path') },
      clearCanvasWithChanges: () => [],
    }
    expect(() => cleanupDeletedAgentSessionCanvasBindings(
      { ...createCleanupMutationDependency(), store: postCommitFailure, broadcast: () => undefined },
      createAgentSession(),
    )).not.toThrow()
    expect(committed).toBe(false)
    expect(() => cleanupDeletedCanvasBindings(
      { ...createCleanupMutationDependency(), store: preCommitFailure, broadcast: () => undefined },
      'project-1',
      'canvas-1',
    )).not.toThrow()

    const store = createStore()
    store.link({ projectId: 'project-1', sessionId: 'session-1', canvasId: 'canvas-1', makeDefault: false })
    expect(() => cleanupDeletedCanvasBindings(
      { ...createCleanupMutationDependency(), store, broadcast: () => { throw new Error('/private/broadcast-path') } },
      'project-1',
      'canvas-1',
    )).not.toThrow()
    expect(store.listByProject('project-1')).toEqual([])
    expect(errorSpy.mock.calls.flat()).toEqual(expect.not.arrayContaining([
      expect.stringContaining('/private'),
    ]))
    errorSpy.mockRestore()
  })

  test('Given 重复 link、未知 unlink 与重复 default When 调用 Then 事实未变化不广播', async () => {
    const handlers = new Map<string, TestHandler>()
    const store = createStore()
    const events: AgentCanvasBindingChangeEvent[] = []
    registerAgentCanvasBindingIpcHandlers({
      ...createProjectMutationDependencies(),
      ipcMain: { handle: (channel, handler) => { handlers.set(channel, handler) }, removeHandler: (channel) => handlers.delete(channel) },
      store,
      getAgentSession: (sessionId) => createAgentSession(sessionId),
      listCanvasSessions: () => [createCanvasSession(), createCanvasSession('canvas-2')],
      assertSenderProjectAccess: () => undefined,
      broadcast: (event) => events.push(event),
    })
    const sender = createSender(1)
    const linkInput = { projectId: 'project-1', sessionId: 'session-1', canvasId: 'canvas-1', makeDefault: false }
    await invoke(handlers, CANVAS_IPC_CHANNELS.LINK_AGENT_CANVAS, sender, linkInput)
    events.length = 0

    await invoke(handlers, CANVAS_IPC_CHANNELS.LINK_AGENT_CANVAS, sender, linkInput)
    await invoke(handlers, CANVAS_IPC_CHANNELS.UNLINK_AGENT_CANVAS, sender, { projectId: 'project-1', sessionId: 'session-1', canvasId: 'canvas-2' })
    await invoke(handlers, CANVAS_IPC_CHANNELS.SET_DEFAULT_AGENT_CANVAS, sender, { projectId: 'project-1', sessionId: 'session-1', canvasId: 'canvas-1' })

    expect(events).toEqual([])
  })

  test('Given LIST 包含失效 session 与 canvas When 实时对账 Then 清理并只返回当前有效关联', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => undefined)
    const handlers = new Map<string, TestHandler>()
    const store = createStore()
    const events: AgentCanvasBindingChangeEvent[] = []
    store.link({ projectId: 'project-1', sessionId: 'session-valid', canvasId: 'canvas-1', makeDefault: false })
    store.link({ projectId: 'project-1', sessionId: 'session-valid', canvasId: 'canvas-stale', makeDefault: false })
    store.link({ projectId: 'project-1', sessionId: 'session-missing', canvasId: 'canvas-1', makeDefault: false })
    registerAgentCanvasBindingIpcHandlers({
      ...createProjectMutationDependencies(),
      ipcMain: { handle: (channel, handler) => { handlers.set(channel, handler) }, removeHandler: (channel) => handlers.delete(channel) },
      store,
      getAgentSession: (sessionId) => sessionId === 'session-valid' ? createAgentSession(sessionId) : null,
      listCanvasSessions: () => [createCanvasSession()],
      assertSenderProjectAccess: () => undefined,
      broadcast: (event) => { events.push(event); throw new Error('/private/broadcast-path') },
    })

    const result = await invoke<AgentCanvasBinding[]>(handlers, CANVAS_IPC_CHANNELS.LIST_AGENT_BINDINGS, createSender(1), { projectId: 'project-1' })

    expect(result).toMatchObject({ ok: true, value: [{ sessionId: 'session-valid', linkedCanvasIds: ['canvas-1'] }] })
    expect(events.map((event) => `${event.sessionId}:${event.cause}`).sort()).toEqual([
      'session-missing:session-cleared',
      'session-valid:canvas-cleared',
    ])
    expect(errorSpy.mock.calls.flat().join(' ')).not.toContain('/private')
    errorSpy.mockRestore()
  })

  test('Given Store 已提交对账 When 会话事实随后变化 Then LIST 仍返回并广播本轮已提交 changes', async () => {
    const handlers = new Map<string, TestHandler>()
    const events: AgentCanvasBindingChangeEvent[] = []
    const binding: AgentCanvasBinding = {
      projectId: 'project-1', sessionId: 'session-1', defaultCanvasId: 'canvas-1',
      linkedCanvasIds: ['canvas-1'], lastActiveCanvasId: 'canvas-1', updatedAt: 2,
    }
    let sessionReads = 0
    registerAgentCanvasBindingIpcHandlers({
      ...createProjectMutationDependencies(),
      ipcMain: { handle: (channel, handler) => { handlers.set(channel, handler) }, removeHandler: (channel) => handlers.delete(channel) },
      store: {
        ...createStore(),
        reconcileProject: (_projectId, isSessionValid) => {
          expect(isSessionValid('session-1')).toBe(true)
          return {
            bindings: [binding],
            changes: [{ sessionId: 'session-1', cause: 'canvas-cleared', binding }],
          }
        },
      },
      getAgentSession: () => {
        sessionReads += 1
        return sessionReads === 1 ? createAgentSession() : null
      },
      listCanvasSessions: () => [createCanvasSession()],
      assertSenderProjectAccess: () => undefined,
      broadcast: (event) => events.push(event),
    })

    expect(await invoke(handlers, CANVAS_IPC_CHANNELS.LIST_AGENT_BINDINGS, createSender(1), { projectId: 'project-1' })).toEqual({
      ok: true,
      value: [binding],
    })
    expect(sessionReads).toBe(1)
    expect(events).toEqual([{
      projectId: 'project-1', sessionId: 'session-1', cause: 'canvas-cleared', binding,
    }])
  })

  test('Given LIST 对账清理失败 When 调用 Then 返回固定失败而不返回陈旧关联', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => undefined)
    const handlers = new Map<string, TestHandler>()
    const stale = {
      projectId: 'project-1', sessionId: 'session-missing', defaultCanvasId: 'canvas-1',
      linkedCanvasIds: ['canvas-1'], lastActiveCanvasId: 'canvas-1', updatedAt: 1,
    }
    registerAgentCanvasBindingIpcHandlers({
      ...createProjectMutationDependencies(),
      ipcMain: { handle: (channel, handler) => { handlers.set(channel, handler) }, removeHandler: (channel) => handlers.delete(channel) },
      store: {
        listByProject: () => [stale],
        linkWithChange: () => ({ before: null, after: stale, changed: true }),
        unlinkWithChange: () => ({ before: stale, after: stale, changed: false }),
        setDefaultWithChange: () => ({ before: stale, after: stale, changed: false }),
        clearSessionWithChanges: () => { throw new Error('/private/store-path') },
        clearCanvasWithChanges: () => [],
        reconcileProject: () => { throw new Error('/private/store-path') },
      },
      getAgentSession: () => null,
      listCanvasSessions: () => [createCanvasSession()],
      assertSenderProjectAccess: () => undefined,
      broadcast: () => undefined,
    })

    expect(await invoke(handlers, CANVAS_IPC_CHANNELS.LIST_AGENT_BINDINGS, createSender(1), { projectId: 'project-1' })).toEqual({
      ok: false,
      error: { code: 'CANVAS_BINDING_LIST_FAILED', message: '画布关联列表暂时无法加载。' },
    })
    expect(errorSpy.mock.calls.flat().join(' ')).not.toContain('/private')
    errorSpy.mockRestore()
  })

  test('Given 真实 Store 批量对账发生 CAS 冲突 When LIST 重试 Then 冲突轮零事件且重试只广播已提交变化', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'proma-agent-canvas-ipc-reconcile-'))
    const configPath = join(directory, 'agent-canvas-bindings.json')
    const staleFile = {
      version: 1,
      bindings: [{
        projectId: 'project-1', sessionId: 'session-missing', defaultCanvasId: 'canvas-1',
        linkedCanvasIds: ['canvas-1'], lastActiveCanvasId: 'canvas-1', updatedAt: 1,
      }],
    }
    writeFileSync(configPath, JSON.stringify(staleFile), 'utf8')
    let shouldConflict = true
    const store = new AgentCanvasBindingStore({
      configPath,
      writeJson: (filePath, value, options) => writeJsonFileAtomicSecure(filePath, value, {
        ...options,
        beforeRename: () => {
          if (!shouldConflict) return
          shouldConflict = false
          writeFileSync(filePath, JSON.stringify({
            ...staleFile,
            bindings: staleFile.bindings.map((binding) => ({ ...binding, updatedAt: 2 })),
          }), 'utf8')
        },
      }),
    })
    const handlers = new Map<string, TestHandler>()
    const events: AgentCanvasBindingChangeEvent[] = []
    registerAgentCanvasBindingIpcHandlers({
      ...createProjectMutationDependencies(),
      ipcMain: { handle: (channel, handler) => { handlers.set(channel, handler) }, removeHandler: (channel) => handlers.delete(channel) },
      store,
      getAgentSession: () => null,
      listCanvasSessions: () => [createCanvasSession()],
      assertSenderProjectAccess: () => undefined,
      broadcast: (event) => events.push(event),
    })
    try {
      expect((await invoke(handlers, CANVAS_IPC_CHANNELS.LIST_AGENT_BINDINGS, createSender(1), { projectId: 'project-1' })).ok).toBe(false)
      expect(events).toEqual([])

      expect(await invoke(handlers, CANVAS_IPC_CHANNELS.LIST_AGENT_BINDINGS, createSender(1), { projectId: 'project-1' })).toEqual({ ok: true, value: [] })
      expect(events).toEqual([{
        projectId: 'project-1', sessionId: 'session-missing', cause: 'session-cleared', binding: null,
      }])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('Given 授权普通 Agent 与同项目 Canvas When 五类 invoke Then 严格返回并广播变化，dispose 幂等解除', async () => {
    const handlers = new Map<string, TestHandler>()
    const removed: string[] = []
    const events: AgentCanvasBindingChangeEvent[] = []
    const sender = createSender(1)
    const store = createStore()
    const registration = registerAgentCanvasBindingIpcHandlers({
      ...createProjectMutationDependencies(),
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
      ...createProjectMutationDependencies(),
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

  test('Given 双 Store 缓存错位 When link、unlink、default 与删除清理 Then 只按 fresh 提交事实精确广播', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'proma-agent-canvas-ipc-multi-store-'))
    const configPath = join(directory, 'agent-canvas-bindings.json')
    const storeA = new AgentCanvasBindingStore({ configPath, now: () => 20 })
    const storeB = new AgentCanvasBindingStore({ configPath, now: () => 30 })
    expect(storeA.listByProject('project-1')).toEqual([])
    const handlers = new Map<string, TestHandler>()
    const events: AgentCanvasBindingChangeEvent[] = []
    registerAgentCanvasBindingIpcHandlers({
      ...createProjectMutationDependencies(),
      ipcMain: { handle: (channel, handler) => { handlers.set(channel, handler) }, removeHandler: (channel) => handlers.delete(channel) },
      store: storeA,
      getAgentSession: (sessionId) => createAgentSession(sessionId),
      listCanvasSessions: () => [createCanvasSession(), createCanvasSession('canvas-2')],
      assertSenderProjectAccess: () => undefined,
      broadcast: (event) => events.push(event),
    })
    const sender = createSender(1)
    try {
      storeB.link({ projectId: 'project-1', sessionId: 'session-clear', canvasId: 'canvas-1', makeDefault: false })
      cleanupDeletedAgentSessionCanvasBindings({
        store: storeA,
        broadcast: (event) => events.push(event),
        runProjectMutation: (_projectId, effect) => effect(),
      }, createAgentSession('session-clear'))
      expect(events.splice(0)).toEqual([{
        projectId: 'project-1', sessionId: 'session-clear', cause: 'session-cleared', binding: null,
      }])
      expect(new AgentCanvasBindingStore({ configPath }).listByProject('project-1')).toEqual([])

      storeB.link({ projectId: 'project-1', sessionId: 'session-1', canvasId: 'canvas-1', makeDefault: false })
      await invoke(handlers, CANVAS_IPC_CHANNELS.LINK_AGENT_CANVAS, sender, {
        projectId: 'project-1', sessionId: 'session-1', canvasId: 'canvas-1', makeDefault: false,
      })
      expect(events.splice(0)).toEqual([])

      storeB.link({ projectId: 'project-1', sessionId: 'session-1', canvasId: 'canvas-2', makeDefault: false })
      await invoke(handlers, CANVAS_IPC_CHANNELS.UNLINK_AGENT_CANVAS, sender, {
        projectId: 'project-1', sessionId: 'session-1', canvasId: 'canvas-2',
      })
      expect(events.splice(0).map((event) => event.cause)).toEqual(['unlinked'])

      storeB.link({ projectId: 'project-1', sessionId: 'session-1', canvasId: 'canvas-2', makeDefault: true })
      await invoke(handlers, CANVAS_IPC_CHANNELS.SET_DEFAULT_AGENT_CANVAS, sender, {
        projectId: 'project-1', sessionId: 'session-1', canvasId: 'canvas-1',
      })
      expect(events.splice(0)).toEqual([expect.objectContaining({
        sessionId: 'session-1', cause: 'default-changed',
        binding: expect.objectContaining({ defaultCanvasId: 'canvas-1' }),
      })])

      storeB.link({ projectId: 'project-1', sessionId: 'session-2', canvasId: 'canvas-1', makeDefault: false })
      cleanupDeletedCanvasBindings({
        store: storeA,
        broadcast: (event) => events.push(event),
        runProjectMutation: (_projectId, effect) => effect(),
      }, 'project-1', 'canvas-1')
      expect(events.splice(0)).toEqual([expect.objectContaining({
        sessionId: 'session-1', cause: 'canvas-cleared',
        binding: expect.objectContaining({ linkedCanvasIds: ['canvas-2'] }),
      }), {
        projectId: 'project-1', sessionId: 'session-2', cause: 'canvas-cleared', binding: null,
      }])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('Given 项目写守卫拒绝 When 调用五个 handler Then legacy、Store 与广播均零副作用', async () => {
    const handlers = new Map<string, TestHandler>()
    const effects: string[] = []
    const store = createStore()
    registerAgentCanvasBindingIpcHandlers({
      ipcMain: { handle: (channel, handler) => { handlers.set(channel, handler) }, removeHandler: (channel) => handlers.delete(channel) },
      store: new Proxy(store, {
        get: (target, property, receiver) => {
          const value = Reflect.get(target, property, receiver)
          if (typeof value !== 'function') return value
          return (...args: unknown[]) => {
            effects.push(`store:${String(property)}`)
            return value(...args)
          }
        },
      }),
      getAgentSession: () => createAgentSession(),
      listCanvasSessions: () => { effects.push('canvas-list'); return [createCanvasSession()] },
      ensureLegacyCanvasSession: () => { effects.push('legacy') },
      getProjectReadOnlyReason: () => undefined,
      runProjectMutation: () => { effects.push('guard'); throw new Error('项目迁移中') },
      assertSenderProjectAccess: () => undefined,
      broadcast: () => { effects.push('broadcast') },
    })
    const sender = createSender(1)
    const calls: Array<[string, unknown]> = [
      [CANVAS_IPC_CHANNELS.LIST_AGENT_BINDINGS, { projectId: 'project-1' }],
      [CANVAS_IPC_CHANNELS.LINK_AGENT_CANVAS, { projectId: 'project-1', sessionId: 'session-1', canvasId: 'canvas-1', makeDefault: false }],
      [CANVAS_IPC_CHANNELS.UNLINK_AGENT_CANVAS, { projectId: 'project-1', sessionId: 'session-1', canvasId: 'canvas-1' }],
      [CANVAS_IPC_CHANNELS.SET_DEFAULT_AGENT_CANVAS, { projectId: 'project-1', sessionId: 'session-1', canvasId: 'canvas-1' }],
      [CANVAS_IPC_CHANNELS.CLEAR_AGENT_BINDINGS, { projectId: 'project-1', target: 'session', sessionId: 'session-1' }],
    ]
    for (const [channel, input] of calls) {
      expect((await invoke(handlers, channel, sender, input)).ok).toBe(false)
    }
    expect(effects).toEqual(['guard', 'guard', 'guard', 'guard', 'guard'])
  })

  test('Given 删除 helper 的项目守卫拒绝 When 清理 Then best-effort 返回且 Store 与广播零调用', () => {
    const effects: string[] = []
    const options = {
      store: {
        clearSessionWithChanges: () => { effects.push('store-session'); return [] },
        clearCanvasWithChanges: () => { effects.push('store-canvas'); return [] },
      },
      broadcast: () => { effects.push('broadcast') },
      runProjectMutation: () => { effects.push('guard'); throw new Error('项目迁移中') },
    }
    expect(() => cleanupDeletedAgentSessionCanvasBindings(options, createAgentSession())).not.toThrow()
    expect(() => cleanupDeletedCanvasBindings(options, 'project-1', 'canvas-1')).not.toThrow()
    expect(effects).toEqual(['guard', 'guard'])
  })

  test('Given 项目只读 When LIST Then 不投影 legacy、不进入 guard、不写盘且返回实时过滤视图', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'proma-agent-canvas-ipc-readonly-'))
    const configPath = join(directory, 'agent-canvas-bindings.json')
    const store = new AgentCanvasBindingStore({ configPath, now: () => 10 })
    store.link({ projectId: 'project-1', sessionId: 'session-1', canvasId: 'canvas-1', makeDefault: false })
    store.link({ projectId: 'project-1', sessionId: 'session-1', canvasId: 'canvas-stale', makeDefault: false })
    const before = readFileSync(configPath, 'utf8')
    const handlers = new Map<string, TestHandler>()
    const effects: string[] = []
    registerAgentCanvasBindingIpcHandlers({
      ipcMain: { handle: (channel, handler) => { handlers.set(channel, handler) }, removeHandler: (channel) => handlers.delete(channel) },
      store,
      getAgentSession: () => createAgentSession(),
      listCanvasSessions: () => [createCanvasSession()],
      ensureLegacyCanvasSession: () => { effects.push('legacy') },
      getProjectReadOnlyReason: () => '项目只读',
      runProjectMutation: () => { effects.push('guard'); throw new Error('不应进入') },
      assertSenderProjectAccess: () => undefined,
      broadcast: () => { effects.push('broadcast') },
    })
    try {
      expect(await invoke(handlers, CANVAS_IPC_CHANNELS.LIST_AGENT_BINDINGS, createSender(1), { projectId: 'project-1' })).toEqual({
        ok: true,
        value: [expect.objectContaining({ linkedCanvasIds: ['canvas-1'] })],
      })
      expect(effects).toEqual([])
      expect(readFileSync(configPath, 'utf8')).toBe(before)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('Given 未授权、销毁窗口、内部或跨项目身份 When 调用 Then fail closed 且 Store 无变化', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => undefined)
    const handlers = new Map<string, TestHandler>()
    const store = createStore()
    const sender = createSender(1)
    let session = createAgentSession()
    const access = { allowed: true }
    registerAgentCanvasBindingIpcHandlers({
      ...createProjectMutationDependencies(),
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
      { delegationRole: 'explore' },
      { delegationStatus: 'running' },
      { delegationDepth: 1 },
      { delegationGoal: '检查代码' },
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
