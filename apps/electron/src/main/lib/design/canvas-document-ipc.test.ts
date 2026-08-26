import { describe, expect, spyOn, test } from 'bun:test'
import { CANVAS_IPC_CHANNELS, createEmptyCanvasDocument } from '@proma/shared'
import type { CanvasDocument, CanvasMutation } from '@proma/shared'
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { registerCanvasDocumentIpcHandlers } from './canvas-document-ipc'

/** 测试 IPC handler 的最小签名。 */
type TestHandler = (event: IpcMainInvokeEvent, input?: unknown) => unknown

/** 可记录公开广播的测试窗口。 */
interface TestWebContents extends WebContents {
  sent: Array<{ channel: string; value: unknown }>
}

/** 创建固定 ID 且可记录广播的窗口。 */
function createSender(id: number): TestWebContents {
  /** 当前窗口收到的全部公开事件。 */
  const sent: Array<{ channel: string; value: unknown }> = []
  return {
    id,
    sent,
    isDestroyed: () => false,
    send: (channel: string, value: unknown) => { sent.push({ channel, value }) },
  } as unknown as TestWebContents
}

/** 调用指定 invoke handler。 */
function invoke(
  handlers: Map<string, TestHandler>,
  channel: string,
  sender: WebContents,
  input: unknown,
): Promise<unknown> {
  /** 测试目标通道必须已注册。 */
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`handler 未注册: ${channel}`)
  return Promise.resolve().then(() => handler({ sender } as IpcMainInvokeEvent, input))
}

/** 创建指定 revision 的原生 Canvas 文档。 */
function createDocument(revision: number): CanvasDocument {
  return { ...createEmptyCanvasDocument('project-1', 'canvas-1', 1), revision }
}

/** 创建主进程 IPC 测试上下文。 */
function createContext(options: {
  authorized?: TestWebContents[]
  readOnlyReason?: string
  loadResult?: { document: CanvasDocument; writable: true; recoveredFrom?: 'tmp' | 'backup' }
  mutateResult?: CanvasDocument
  guardError?: Error
  loadError?: Error
  mutateError?: Error
  reconcileError?: Error
  createError?: Error
  createPublication?: CanvasDocument
  reconcileResult?: {
    snapshot: { document: CanvasDocument; writable: true; recoveredFrom?: 'tmp' | 'backup' }
    documentChanged: boolean
    error?: Error
  }
  retryReconcileResult?: {
    snapshot: { document: CanvasDocument; writable: true; recoveredFrom?: 'tmp' | 'backup' }
    documentChanged: boolean
    error?: Error
  }
  beforeCreate?: (input: { projectId: string; canvasId: string }) => Promise<void>
  createErrorOnce?: Error
  createDocumentChanged?: boolean
} = {}) {
  /** 当前注册的 invoke handler。 */
  const handlers = new Map<string, TestHandler>()
  /** handler 移除记录，用于锁定热注册与幂等 dispose。 */
  const removed: string[] = []
  /** 默认授权主窗口。 */
  const sender = createSender(1)
  /** 记录广播发生时 workspace lease 是否仍被持有。 */
  const broadcastLeaseStates: boolean[] = []
  /** 当前测试调用是否位于 workspace write lease 内。 */
  let leaseHeld = false
  /** 包装所有测试授权窗口，观察多窗口广播是否位于 lease 释放后。 */
  for (const contents of new Set([sender, ...(options.authorized ?? [])])) {
    const send = contents.send
    contents.send = (channel, value) => {
      broadcastLeaseStates.push(leaseHeld)
      send(channel, value)
    }
  }
  /** 按执行顺序记录只读、guard 和 store 边界。 */
  const calls: string[] = []
  /** Store 收到的重建参数。 */
  const storeInputs: unknown[] = []
  /** 创建调用次数用于模拟首次 committed 写失败后的同 operation 重试。 */
  let createAttempts = 0
  const registration = registerCanvasDocumentIpcHandlers({
    ipc: {
      handle: (channel, handler) => { handlers.set(channel, handler) },
      removeHandler: (channel) => { removed.push(channel); handlers.delete(channel) },
    },
    listAuthorizedWebContents: () => options.authorized ?? [sender],
    guard: {
      runWorkspaceWrite: (projectId, effect) => {
        calls.push(`guard:${projectId}`)
        if (options.guardError) throw options.guardError
        leaseHeld = true
        try {
          const result = effect()
          if (result instanceof Promise) {
            return result.finally(() => { leaseHeld = false }) as ReturnType<typeof effect>
          }
          leaseHeld = false
          return result
        } catch (error) {
          leaseHeld = false
          throw error
        }
      },
    },
    store: {
      load: (target) => {
        calls.push('store:load')
        storeInputs.push(target)
        if (options.loadError) throw options.loadError
        return options.loadResult ?? { document: createDocument(4), writable: true }
      },
      mutate: (target, expectedRevision, mutations) => {
        calls.push('store:mutate')
        storeInputs.push({ target, expectedRevision, mutations })
        if (options.mutateError) throw options.mutateError
        return options.mutateResult ?? createDocument(expectedRevision + (mutations.length > 0 ? 1 : 0))
      },
    },
    creation: {
      reconcile: async (target) => {
        calls.push('creation:reconcile')
        storeInputs.push(target)
        if (options.reconcileError ?? options.loadError) throw options.reconcileError ?? options.loadError
        return options.reconcileResult ?? {
          snapshot: options.loadResult ?? { document: createDocument(4), writable: true },
          documentChanged: false,
        }
      },
      createReconciled: async (input) => {
        calls.push('creation:create')
        storeInputs.push(input)
        createAttempts += 1
        await options.beforeCreate?.(input)
        const reconciliation = (createAttempts > 1 ? options.retryReconcileResult : undefined)
          ?? options.reconcileResult ?? {
          snapshot: options.loadResult ?? { document: createDocument(4), writable: true },
          documentChanged: false,
        }
        const createError = options.createError
          ?? (createAttempts === 1 ? options.createErrorOnce : undefined)
        if (createError) {
          return {
            reconciliation,
            operationOutcome: {
              ok: false as const,
              error: createError,
              ...(options.createPublication ? { publication: options.createPublication } : {}),
            },
          }
        }
        const document = createDocument(5)
        document.nodes = [{
          id: input.nodeId,
          kind: 'agent',
          title: input.title,
          position: input.position,
          agentSessionId: '22222222-2222-4222-8222-222222222222',
        }]
        return {
          reconciliation,
          operationOutcome: {
            ok: true as const,
            value: {
              document,
              session: {
                id: '22222222-2222-4222-8222-222222222222',
                title: input.title,
                createdAt: 1,
                updatedAt: 1,
              },
              documentChanged: options.createDocumentChanged ?? true,
            },
          },
        }
      },
    },
    getProjectReadOnlyReason: (projectId) => {
      calls.push(`readonly:${projectId}`)
      return options.readOnlyReason
    },
  })
  return { handlers, removed, sender, calls, storeInputs, broadcastLeaseStates, registration }
}

describe('原生 Canvas 文档 IPC', () => {
  test('Given 未授权 sender When 提交带 getter 的请求 Then 在解析和 Store 前拒绝', async () => {
    /** 未授权窗口不能触发 payload getter。 */
    const unauthorized = createSender(9)
    /** getter 访问次数必须保持为零。 */
    let getterReads = 0
    const input = Object.defineProperty({}, 'projectId', {
      enumerable: true,
      get: () => { getterReads += 1; return 'project-1' },
    })
    Object.defineProperty(input, 'canvasId', { enumerable: true, value: 'canvas-1' })
    const context = createContext({ authorized: [] })

    await expect(invoke(context.handlers, CANVAS_IPC_CHANNELS.LOAD, unauthorized, input))
      .rejects.toThrow('无权访问 Canvas 文档')
    expect(getterReads).toBe(0)
    expect(context.calls).toEqual([])
  })

  test('Given 非精确外层对象或非法身份和 revision When 调用 Then 全部在 guard 前拒绝', async () => {
    const context = createContext()
    const invalidCases: Array<{ channel: string; input: unknown }> = [
      { channel: CANVAS_IPC_CHANNELS.LOAD, input: { projectId: 'project-1', canvasId: 'canvas-1', path: '/tmp/x' } },
      { channel: CANVAS_IPC_CHANNELS.LOAD, input: { projectId: '../project', canvasId: 'canvas-1' } },
      { channel: CANVAS_IPC_CHANNELS.LOAD, input: Object.assign(Object.create({ inherited: true }), { projectId: 'project-1', canvasId: 'canvas-1' }) },
      { channel: CANVAS_IPC_CHANNELS.SAVE_MUTATIONS, input: { projectId: 'project-1', canvasId: 'canvas-1', expectedRevision: -1, mutations: [] } },
      { channel: CANVAS_IPC_CHANNELS.SAVE_MUTATIONS, input: { projectId: 'project-1', canvasId: 'canvas-1', expectedRevision: 1.5, mutations: [] } },
      { channel: CANVAS_IPC_CHANNELS.SAVE_MUTATIONS, input: { projectId: 'project-1', canvasId: 'bad/id', expectedRevision: 0, mutations: [] } },
      { channel: CANVAS_IPC_CHANNELS.SAVE_MUTATIONS, input: { projectId: 'project-1', canvasId: 'canvas-1', expectedRevision: 0, mutations: {} } },
      { channel: CANVAS_IPC_CHANNELS.SAVE_MUTATIONS, input: { projectId: 'project-1', canvasId: 'canvas-1', expectedRevision: 0, mutations: {}, extra: true } },
      { channel: CANVAS_IPC_CHANNELS.CREATE_AGENT_NODE, input: {
        projectId: 'project-1', canvasId: 'canvas-1', operationId: 'not-uuid',
        nodeId: 'node-1', title: 'Agent', position: { x: 0, y: 0 },
      } },
      { channel: CANVAS_IPC_CHANNELS.CREATE_AGENT_NODE, input: {
        projectId: 'p'.repeat(121), canvasId: 'canvas-1',
        operationId: '11111111-1111-4111-8111-111111111111',
        nodeId: 'node-1', title: 'Agent', position: { x: 0, y: 0 },
      } },
      { channel: CANVAS_IPC_CHANNELS.CREATE_AGENT_NODE, input: {
        projectId: 'project-1', canvasId: 'canvas-1',
        operationId: '11111111-1111-4111-8111-111111111111',
        nodeId: 'bad/node', title: 'Agent', position: { x: 0, y: 0 },
      } },
      { channel: CANVAS_IPC_CHANNELS.CREATE_AGENT_NODE, input: {
        projectId: 'project-1', canvasId: 'canvas-1',
        operationId: '11111111-1111-4111-8111-111111111111',
        nodeId: 'node-1', title: '', position: { x: Number.NaN, y: 0 }, extra: true,
      } },
    ]

    for (const item of invalidCases) {
      await expect(invoke(context.handlers, item.channel, context.sender, item.input)).rejects.toThrow()
    }
    expect(context.calls).toEqual([])
    expect(context.storeInputs).toEqual([])
  })

  test('Given 只读项目 When LOAD 或 SAVE Then 在 guard 和 Store 前返回原只读原因', async () => {
    const context = createContext({ readOnlyReason: '项目路径不可访问' })

    await expect(invoke(context.handlers, CANVAS_IPC_CHANNELS.LOAD, context.sender, {
      projectId: 'project-1', canvasId: 'canvas-1',
    })).rejects.toThrow('项目路径不可访问')
    await expect(invoke(context.handlers, CANVAS_IPC_CHANNELS.SAVE_MUTATIONS, context.sender, {
      projectId: 'project-1', canvasId: 'canvas-1', expectedRevision: 4, mutations: [],
    })).rejects.toThrow('项目路径不可访问')
    expect(context.calls).toEqual(['readonly:project-1', 'readonly:project-1'])
    expect(context.storeInputs).toEqual([])
  })

  test('Given 可写项目 When LOAD 和 SAVE Then guard 包裹 Store 且参数由 IPC 重建', async () => {
    const context = createContext()
    const mutations: CanvasMutation[] = [{ type: 'set-viewport', viewport: { x: 1, y: 2, zoom: 1 } }]
    const loadInput = Object.assign(Object.create(null) as object, { projectId: 'project-1', canvasId: 'canvas-1' })
    const saveInput = { projectId: 'project-1', canvasId: 'canvas-1', expectedRevision: 4, mutations }

    await invoke(context.handlers, CANVAS_IPC_CHANNELS.LOAD, context.sender, loadInput)
    await invoke(context.handlers, CANVAS_IPC_CHANNELS.SAVE_MUTATIONS, context.sender, saveInput)

    expect(context.calls).toEqual([
      'readonly:project-1', 'guard:project-1', 'creation:reconcile',
      'readonly:project-1', 'guard:project-1', 'creation:reconcile', 'store:mutate',
    ])
    expect(context.storeInputs[0]).toEqual({ projectId: 'project-1', canvasId: 'canvas-1' })
    expect(context.storeInputs[0]).not.toBe(loadInput)
    expect(context.storeInputs[2]).toEqual({
      target: { projectId: 'project-1', canvasId: 'canvas-1' },
      expectedRevision: 4,
      mutations,
    })
  })

  test('Given 普通加载 When 成功 Then 返回公开快照且不广播', async () => {
    const snapshot = { document: createDocument(4), writable: true as const }
    const context = createContext({ loadResult: snapshot })

    expect(await invoke(context.handlers, CANVAS_IPC_CHANNELS.LOAD, context.sender, {
      projectId: 'project-1', canvasId: 'canvas-1',
    })).toBe(snapshot)
    expect(context.sender.sent).toEqual([])
  })

  test('Given tmp 或 backup 恢复可能得到低 revision When LOAD Then 广播双身份 recovery', async () => {
    for (const recoveredFrom of ['tmp', 'backup'] as const) {
      const context = createContext({
        loadResult: { document: createDocument(1), writable: true, recoveredFrom },
      })
      await invoke(context.handlers, CANVAS_IPC_CHANNELS.LOAD, context.sender, {
        projectId: 'project-1', canvasId: 'canvas-1',
      })
      expect(context.sender.sent).toEqual([{
        channel: CANVAS_IPC_CHANNELS.CHANGED,
        value: { projectId: 'project-1', canvasId: 'canvas-1', revision: 1, cause: 'recovery' },
      }])
    }
  })

  test('Given SAVE 对账恢复到更低 revision 且后续保存失败 When lease 释放 Then 所有窗口仍仅收到 recovery', async () => {
    const sender = createSender(2)
    const observer = createSender(3)
    const error = new Error('保存 revision 冲突')
    const context = createContext({
      authorized: [sender, observer],
      mutateError: error,
      reconcileResult: {
        snapshot: { document: createDocument(1), writable: true, recoveredFrom: 'backup' },
        documentChanged: false,
      },
    })

    await expect(invoke(context.handlers, CANVAS_IPC_CHANNELS.SAVE_MUTATIONS, sender, {
      projectId: 'project-1', canvasId: 'canvas-1', expectedRevision: 9, mutations: [],
    })).rejects.toBe(error)

    const expected = [{
      channel: CANVAS_IPC_CHANNELS.CHANGED,
      value: { projectId: 'project-1', canvasId: 'canvas-1', revision: 1, cause: 'recovery' },
    }]
    expect(sender.sent).toEqual(expected)
    expect(observer.sent).toEqual(expected)
    expect(context.broadcastLeaseStates).toEqual([false, false])
  })

  test('Given CREATE 对账发生 recovery When 当前创建成功或失败 Then recovery 均优先于 graph 且只广播一次', async () => {
    const createInput = {
      projectId: 'project-1', canvasId: 'canvas-1',
      operationId: '11111111-1111-4111-8111-111111111111',
      nodeId: 'node-1', title: '首页 Agent', position: { x: 10, y: 20 },
    }
    for (const createError of [undefined, new Error('当前创建失败')]) {
      const context = createContext({
        createError,
        reconcileResult: {
          snapshot: { document: createDocument(1), writable: true, recoveredFrom: 'tmp' },
          documentChanged: true,
        },
      })

      if (createError) {
        await expect(invoke(
          context.handlers, CANVAS_IPC_CHANNELS.CREATE_AGENT_NODE, context.sender, createInput,
        )).rejects.toBe(createError)
      } else {
        await invoke(context.handlers, CANVAS_IPC_CHANNELS.CREATE_AGENT_NODE, context.sender, createInput)
      }
      const expected = [{
        channel: CANVAS_IPC_CHANNELS.CHANGED,
        value: { projectId: 'project-1', canvasId: 'canvas-1', revision: 1, cause: 'recovery' },
      }]
      if (!createError) expected.push({
        channel: CANVAS_IPC_CHANNELS.CHANGED,
        value: { projectId: 'project-1', canvasId: 'canvas-1', revision: 5, cause: 'graph' },
      })
      expect(context.sender.sent).toEqual(expected)
      expect(context.broadcastLeaseStates).toEqual(expected.map(() => false))
    }
  })

  test('Given 有效保存或空保存 When Store 成功 Then 仅 revision 前进时广播 graph', async () => {
    const changed = createContext({ mutateResult: createDocument(5) })
    await invoke(changed.handlers, CANVAS_IPC_CHANNELS.SAVE_MUTATIONS, changed.sender, {
      projectId: 'project-1', canvasId: 'canvas-1', expectedRevision: 4,
      mutations: [{ type: 'set-viewport', viewport: { x: 1, y: 2, zoom: 1 } }],
    })
    expect(changed.sender.sent).toEqual([{
      channel: CANVAS_IPC_CHANNELS.CHANGED,
      value: { projectId: 'project-1', canvasId: 'canvas-1', revision: 5, cause: 'graph' },
    }])

    const unchanged = createContext({ mutateResult: createDocument(4) })
    await invoke(unchanged.handlers, CANVAS_IPC_CHANNELS.SAVE_MUTATIONS, unchanged.sender, {
      projectId: 'project-1', canvasId: 'canvas-1', expectedRevision: 4, mutations: [],
    })
    expect(unchanged.sender.sent).toEqual([])
  })

  test('Given 有效创建请求 When intent committed 后返回 Then 广播准确双身份并隐藏内部字段', async () => {
    const context = createContext()
    const input = {
      projectId: 'project-1', canvasId: 'canvas-1',
      operationId: '11111111-1111-4111-8111-111111111111',
      nodeId: 'node-1', title: '首页 Agent', position: { x: 10, y: 20 },
    }

    const result = await invoke(
      context.handlers, CANVAS_IPC_CHANNELS.CREATE_AGENT_NODE, context.sender, input,
    ) as Record<string, unknown>

    expect(context.calls).toEqual([
      'readonly:project-1', 'guard:project-1', 'creation:create',
    ])
    expect(context.storeInputs[0]).toEqual(input)
    expect(context.storeInputs[0]).not.toBe(input)
    expect(result).not.toHaveProperty('documentChanged')
    expect(result).toHaveProperty('session.id', '22222222-2222-4222-8222-222222222222')
    expect(context.sender.sent).toEqual([{
      channel: CANVAS_IPC_CHANNELS.CHANGED,
      value: { projectId: 'project-1', canvasId: 'canvas-1', revision: 5, cause: 'graph' },
    }])
    expect(context.broadcastLeaseStates).toEqual([false])
  })

  test('Given 同一 Canvas 两个异步 CREATE When 首个尚未完成 Then 第二个等待完整事务释放', async () => {
    let createEntrances = 0
    let releaseFirst = (): void => {}
    const firstGate = new Promise<void>((resolvePromise) => { releaseFirst = resolvePromise })
    const context = createContext({
      beforeCreate: async () => {
        createEntrances += 1
        if (createEntrances === 1) await firstGate
      },
    })
    const baseInput = {
      projectId: 'project-1',
      canvasId: 'canvas-1',
      title: '首页 Agent',
      position: { x: 10, y: 20 },
    }
    const first = invoke(context.handlers, CANVAS_IPC_CHANNELS.CREATE_AGENT_NODE, context.sender, {
      ...baseInput,
      operationId: '11111111-1111-4111-8111-111111111111',
      nodeId: 'node-1',
    })
    while (createEntrances === 0) await Promise.resolve()
    const second = invoke(context.handlers, CANVAS_IPC_CHANNELS.CREATE_AGENT_NODE, context.sender, {
      ...baseInput,
      operationId: '33333333-3333-4333-8333-333333333333',
      nodeId: 'node-2',
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(createEntrances).toBe(1)
    releaseFirst()
    await Promise.all([first, second])
    expect(createEntrances).toBe(2)
  })

  test('Given Canvas A CREATE 阻塞 When Canvas B CREATE 进入 Then B 独立完成且无需等待 A', async () => {
    /** 只阻塞 Canvas A，用于证明队列键包含 canvasId。 */
    let releaseCanvasA = (): void => {}
    const canvasAGate = new Promise<void>((resolvePromise) => { releaseCanvasA = resolvePromise })
    const entrances: string[] = []
    const context = createContext({
      beforeCreate: async (input) => {
        entrances.push(input.canvasId)
        if (input.canvasId === 'canvas-a') await canvasAGate
      },
    })
    const createFor = (canvasId: string, operationId: string, nodeId: string) => invoke(
      context.handlers,
      CANVAS_IPC_CHANNELS.CREATE_AGENT_NODE,
      context.sender,
      {
        projectId: 'project-1', canvasId, operationId, nodeId,
        title: '首页 Agent', position: { x: 10, y: 20 },
      },
    )
    const canvasA = createFor(
      'canvas-a', '11111111-1111-4111-8111-111111111111', 'node-a',
    )
    while (!entrances.includes('canvas-a')) await Promise.resolve()

    await expect(createFor(
      'canvas-b', '33333333-3333-4333-8333-333333333333', 'node-b',
    )).resolves.toBeDefined()
    expect(entrances).toEqual(['canvas-a', 'canvas-b'])

    releaseCanvasA()
    await canvasA
  })

  test('Given 文档已写但 committed intent 失败 When 创建返回错误 Then 不广播且不泄漏节点', async () => {
    const error = new Error('Canvas Agent 创建事务提交失败')
    const context = createContext({ createError: error })

    await expect(invoke(
      context.handlers,
      CANVAS_IPC_CHANNELS.CREATE_AGENT_NODE,
      context.sender,
      {
        projectId: 'project-1', canvasId: 'canvas-1',
        operationId: '11111111-1111-4111-8111-111111111111',
        nodeId: 'node-1', title: '首页 Agent', position: { x: 10, y: 20 },
      },
    )).rejects.toBe(error)
    expect(context.sender.sent).toEqual([])
  })

  test('Given committed intent 可见但持久性未确认 When CREATE 返回发布事实 Then lease 后广播再原样抛错', async () => {
    const error = new Error('CANVAS_INTENT_DURABILITY_UNCERTAIN: 目录持久性未确认')
    const context = createContext({
      createError: error,
      createPublication: createDocument(5),
    })

    await expect(invoke(
      context.handlers,
      CANVAS_IPC_CHANNELS.CREATE_AGENT_NODE,
      context.sender,
      {
        projectId: 'project-1', canvasId: 'canvas-1',
        operationId: '11111111-1111-4111-8111-111111111111',
        nodeId: 'node-1', title: '首页 Agent', position: { x: 10, y: 20 },
      },
    )).rejects.toBe(error)
    expect(context.sender.sent).toEqual([{
      channel: CANVAS_IPC_CHANNELS.CHANGED,
      value: { projectId: 'project-1', canvasId: 'canvas-1', revision: 5, cause: 'graph' },
    }])
    expect(context.broadcastLeaseStates).toEqual([false])
  })

  test('Given committed 首次写失败 When 同 operation 重试越过发布屏障 Then 既有 revision 恰好广播一次', async () => {
    const error = new Error('Canvas Agent 创建事务提交失败')
    const context = createContext({
      createErrorOnce: error,
      createDocumentChanged: false,
      retryReconcileResult: {
        snapshot: { document: createDocument(5), writable: true },
        documentChanged: true,
      },
    })
    const input = {
      projectId: 'project-1', canvasId: 'canvas-1',
      operationId: '11111111-1111-4111-8111-111111111111',
      nodeId: 'node-1', title: '首页 Agent', position: { x: 10, y: 20 },
    }

    await expect(invoke(
      context.handlers, CANVAS_IPC_CHANNELS.CREATE_AGENT_NODE, context.sender, input,
    )).rejects.toBe(error)
    expect(context.sender.sent).toEqual([])

    await expect(invoke(
      context.handlers, CANVAS_IPC_CHANNELS.CREATE_AGENT_NODE, context.sender, input,
    )).resolves.toBeDefined()
    expect(context.sender.sent).toEqual([{
      channel: CANVAS_IPC_CHANNELS.CHANGED,
      value: { projectId: 'project-1', canvasId: 'canvas-1', revision: 5, cause: 'graph' },
    }])
  })

  test('Given SAVE 对账已提交图变更 When 后续 revision conflict Then 广播对账 revision 并原样抛错', async () => {
    const error = new Error('CANVAS_REVISION_CONFLICT: expected=4, current=5')
    const context = createContext({
      reconcileResult: {
        snapshot: { document: createDocument(5), writable: true },
        documentChanged: true,
      },
      mutateError: error,
    })

    await expect(invoke(context.handlers, CANVAS_IPC_CHANNELS.SAVE_MUTATIONS, context.sender, {
      projectId: 'project-1', canvasId: 'canvas-1', expectedRevision: 4, mutations: [],
    })).rejects.toBe(error)
    expect(context.sender.sent).toEqual([{
      channel: CANVAS_IPC_CHANNELS.CHANGED,
      value: { projectId: 'project-1', canvasId: 'canvas-1', revision: 5, cause: 'graph' },
    }])
  })

  test('Given detached intent 已可见但目录持久性未确认 When LOAD 对账 Then 原样抛错且不广播 graph', async () => {
    /** detached 不改变画布 revision，因此耐久性错误不能伪造图发布事实。 */
    const error = new Error('CANVAS_INTENT_DURABILITY_UNCERTAIN: 目录持久性未确认')
    const context = createContext({
      reconcileResult: {
        snapshot: { document: createDocument(4), writable: true },
        documentChanged: false,
        error,
      },
    })

    await expect(invoke(context.handlers, CANVAS_IPC_CHANNELS.LOAD, context.sender, {
      projectId: 'project-1', canvasId: 'canvas-1',
    })).rejects.toBe(error)
    expect(context.sender.sent).toEqual([])
    expect(context.broadcastLeaseStates).toEqual([])
  })

  test('Given CREATE 对账已提交图变更 When 新请求默认模型失败 Then 广播对账 revision 并原样抛错', async () => {
    const error = new Error('Canvas Agent 需要先配置默认渠道')
    const context = createContext({
      reconcileResult: {
        snapshot: { document: createDocument(6), writable: true },
        documentChanged: true,
      },
      createError: error,
    })

    await expect(invoke(context.handlers, CANVAS_IPC_CHANNELS.CREATE_AGENT_NODE, context.sender, {
      projectId: 'project-1', canvasId: 'canvas-1',
      operationId: '11111111-1111-4111-8111-111111111111',
      nodeId: 'node-1', title: '首页 Agent', position: { x: 10, y: 20 },
    })).rejects.toBe(error)
    expect(context.sender.sent).toEqual([{
      channel: CANVAS_IPC_CHANNELS.CHANGED,
      value: { projectId: 'project-1', canvasId: 'canvas-1', revision: 6, cause: 'graph' },
    }])
    expect(context.calls).toEqual([
      'readonly:project-1', 'guard:project-1', 'creation:create',
    ])
    expect(context.broadcastLeaseStates).toEqual([false])
  })

  test('Given guard 或 Store 原样失败 When LOAD/SAVE Then 不广播', async () => {
    const guardError = new Error('工作区迁移中')
    const guarded = createContext({ guardError })
    await expect(invoke(guarded.handlers, CANVAS_IPC_CHANNELS.LOAD, guarded.sender, {
      projectId: 'project-1', canvasId: 'canvas-1',
    })).rejects.toBe(guardError)
    expect(guarded.sender.sent).toEqual([])

    /** 恢复对账错误必须保留 Store 原始对象和完整消息。 */
    const recoveryError = new Error('CANVAS_RECOVERY_REQUIRED: promotion commit durability uncertain')
    const recoveryFailed = createContext({ loadError: recoveryError })
    await expect(invoke(recoveryFailed.handlers, CANVAS_IPC_CHANNELS.LOAD, recoveryFailed.sender, {
      projectId: 'project-1', canvasId: 'canvas-1',
    })).rejects.toBe(recoveryError)
    expect(recoveryFailed.sender.sent).toEqual([])

    /** durability 不确定错误同样不能被 IPC 字符串重写。 */
    const storeError = new Error('CANVAS_COMMIT_UNCERTAIN: main durability requires reload')
    const failed = createContext({ mutateError: storeError })
    await expect(invoke(failed.handlers, CANVAS_IPC_CHANNELS.SAVE_MUTATIONS, failed.sender, {
      projectId: 'project-1', canvasId: 'canvas-1', expectedRevision: 4, mutations: [],
    })).rejects.toBe(storeError)
    expect(failed.sender.sent).toEqual([])
  })

  test('Given 单窗口发送失败 When Store 已提交 Then 请求仍成功且其它窗口收到事件', async () => {
    const failing = createSender(2)
    const receiving = createSender(3)
    failing.send = () => { throw new Error('窗口发送失败') }
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {})
    const context = createContext({ authorized: [failing, receiving], mutateResult: createDocument(5) })

    await expect(invoke(context.handlers, CANVAS_IPC_CHANNELS.SAVE_MUTATIONS, receiving, {
      projectId: 'project-1', canvasId: 'canvas-1', expectedRevision: 4,
      mutations: [{ type: 'set-viewport', viewport: { x: 1, y: 2, zoom: 1 } }],
    })).resolves.toEqual(createDocument(5))
    expect(receiving.sent).toHaveLength(1)
    expect(errorSpy).toHaveBeenCalledWith(
      '[CanvasDocumentIPC] Canvas 变化广播失败:',
      expect.objectContaining({ message: '窗口发送失败' }),
    )
    errorSpy.mockRestore()
  })

  test('Given 已注册处理器 When 重复 dispose Then 仅移除三个固定 invoke 通道一次', () => {
    const context = createContext()
    expect(context.registration.channels).toEqual([
      CANVAS_IPC_CHANNELS.LOAD,
      CANVAS_IPC_CHANNELS.SAVE_MUTATIONS,
      CANVAS_IPC_CHANNELS.CREATE_AGENT_NODE,
    ])
    context.removed.length = 0

    context.registration.dispose()
    context.registration.dispose()

    expect(context.removed).toEqual([
      CANVAS_IPC_CHANNELS.LOAD,
      CANVAS_IPC_CHANNELS.SAVE_MUTATIONS,
      CANVAS_IPC_CHANNELS.CREATE_AGENT_NODE,
    ])
  })

  test('Given 同一 registrar 连续注册 A 和 B When dispose A Then 不删除 B 的 handler', async () => {
    /** 两代注册共享的当前 handler 表。 */
    const handlers = new Map<string, TestHandler>()
    /** 记录每代注册和清理触发的通道移除。 */
    const removed: string[] = []
    /** 两代注册共享的授权主窗口。 */
    const sender = createSender(1)
    /** 模拟 Electron ipcMain 的稳定 registrar 对象。 */
    const ipc = {
      handle: (channel: string, handler: TestHandler): void => { handlers.set(channel, handler) },
      removeHandler: (channel: string): void => { removed.push(channel); handlers.delete(channel) },
    }
    /** 创建使用同一 registrar、但返回不同 revision 的注册依赖。 */
    const createOptions = (revision: number) => ({
      ipc,
      listAuthorizedWebContents: () => [sender],
      guard: {
        runWorkspaceWrite: <T>(_projectId: string, effect: () => T): T => effect(),
      },
      store: {
        load: () => ({ document: createDocument(revision), writable: true as const }),
        mutate: () => createDocument(revision),
      },
      creation: {
        reconcile: async () => ({
          snapshot: { document: createDocument(revision), writable: true as const },
          documentChanged: false,
        }),
        createReconciled: async () => ({
          reconciliation: {
            snapshot: { document: createDocument(revision), writable: true as const },
            documentChanged: false,
          },
          operationOutcome: {
            ok: true as const,
            value: {
              document: createDocument(revision),
              session: { id: 'session-1', title: 'Agent', createdAt: 1, updatedAt: 1 },
              documentChanged: false,
            },
          },
        }),
      },
      getProjectReadOnlyReason: () => undefined,
    })
    /** 被后续注册替代的旧 generation。 */
    const registrationA = registerCanvasDocumentIpcHandlers(createOptions(1))
    /** 当前拥有 handler 的新 generation。 */
    const registrationB = registerCanvasDocumentIpcHandlers(createOptions(2))
    removed.length = 0

    registrationA.dispose()

    await expect(invoke(handlers, CANVAS_IPC_CHANNELS.LOAD, sender, {
      projectId: 'project-1', canvasId: 'canvas-1',
    })).resolves.toEqual({ document: createDocument(2), writable: true })
    expect(removed).toEqual([])

    registrationB.dispose()
    expect(handlers.size).toBe(0)
    expect(removed).toEqual([
      CANVAS_IPC_CHANNELS.LOAD,
      CANVAS_IPC_CHANNELS.SAVE_MUTATIONS,
      CANVAS_IPC_CHANNELS.CREATE_AGENT_NODE,
    ])

    registrationA.dispose()
    expect(removed).toHaveLength(3)
  })
})
