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
} = {}) {
  /** 当前注册的 invoke handler。 */
  const handlers = new Map<string, TestHandler>()
  /** handler 移除记录，用于锁定热注册与幂等 dispose。 */
  const removed: string[] = []
  /** 默认授权主窗口。 */
  const sender = createSender(1)
  /** 按执行顺序记录只读、guard 和 store 边界。 */
  const calls: string[] = []
  /** Store 收到的重建参数。 */
  const storeInputs: unknown[] = []
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
        return effect()
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
    getProjectReadOnlyReason: (projectId) => {
      calls.push(`readonly:${projectId}`)
      return options.readOnlyReason
    },
  })
  return { handlers, removed, sender, calls, storeInputs, registration }
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
      'readonly:project-1', 'guard:project-1', 'store:load',
      'readonly:project-1', 'guard:project-1', 'store:mutate',
    ])
    expect(context.storeInputs[0]).toEqual({ projectId: 'project-1', canvasId: 'canvas-1' })
    expect(context.storeInputs[0]).not.toBe(loadInput)
    expect(context.storeInputs[1]).toEqual({
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

  test('Given 已注册处理器 When 重复 dispose Then 仅移除两个固定 invoke 通道一次', () => {
    const context = createContext()
    expect(context.registration.channels).toEqual([
      CANVAS_IPC_CHANNELS.LOAD,
      CANVAS_IPC_CHANNELS.SAVE_MUTATIONS,
    ])
    context.removed.length = 0

    context.registration.dispose()
    context.registration.dispose()

    expect(context.removed).toEqual([
      CANVAS_IPC_CHANNELS.LOAD,
      CANVAS_IPC_CHANNELS.SAVE_MUTATIONS,
    ])
  })
})
