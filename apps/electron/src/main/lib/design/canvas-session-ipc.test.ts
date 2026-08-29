import { describe, expect, spyOn, test } from 'bun:test'
import { DESIGN_IPC_CHANNELS } from '@proma/shared'
import type {
  CanvasSessionMeta,
  CreateCanvasSessionInput,
  DeleteCanvasSessionInput,
  ListCanvasSessionsInput,
  UpdateCanvasSessionInput,
} from '@proma/shared'
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { registerCanvasSessionIpcHandlers } from './canvas-session-ipc'

/** 测试 IPC handler 的最小异步兼容签名。 */
type TestHandler = (event: IpcMainInvokeEvent, input?: unknown) => unknown

/** 带公开发送记录的测试窗口。 */
interface TestWebContents extends WebContents {
  sent: Array<{ channel: string; value: unknown }>
}

/** 创建固定 ID 且可记录广播的授权窗口。 */
function createSender(id: number): TestWebContents {
  /** 当前窗口收到的全部 IPC 事件。 */
  const sent: Array<{ channel: string; value: unknown }> = []
  return {
    id,
    sent,
    isDestroyed: () => false,
    send: (channel: string, value: unknown) => { sent.push({ channel, value }) },
  } as unknown as TestWebContents
}

/** 调用已注册 handler 并统一转为 Promise。 */
function invoke(
  handlers: Map<string, TestHandler>,
  channel: string,
  sender: WebContents,
  input?: unknown,
): Promise<unknown> {
  /** 指定通道必须已完成注册。 */
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`handler 未注册: ${channel}`)
  return Promise.resolve().then(() => handler({ sender } as IpcMainInvokeEvent, input))
}

/** 创建公开 Canvas 会话测试值。 */
function createSession(id: string, title = '页面设计'): CanvasSessionMeta {
  return {
    id,
    projectId: 'project-1',
    title,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
  }
}

describe('Canvas 会话 IPC', () => {
  test('Given 主窗口 When 列出、新建、更新和删除 Canvas Then 经过项目写守卫并广播', async () => {
    /** 记录每个通道注册的 handler。 */
    const handlers = new Map<string, TestHandler>()
    /** 记录项目写守卫收到的项目 ID。 */
    const guardedProjects: string[] = []
    /** 伪造唯一授权主窗口。 */
    const sender = createSender(7)
    /** store 调用记录。 */
    const calls: string[] = []
    const registration = registerCanvasSessionIpcHandlers({
      ipc: {
        handle: (channel, handler) => { handlers.set(channel, handler) },
        removeHandler: (channel) => { handlers.delete(channel) },
      },
      listAuthorizedWebContents: () => [sender],
      guard: {
        runWorkspaceWrite: (projectId, effect) => {
          guardedProjects.push(projectId)
          return effect()
        },
      },
      sessions: {
        ensureLegacySession: () => { calls.push('ensure'); return undefined },
        list: (input: ListCanvasSessionsInput) => { calls.push(`list:${String(input.archived)}`); return [] },
        create: (input: CreateCanvasSessionInput) => {
          calls.push('create')
          return createSession('canvas-1', input.title ?? '新 Canvas')
        },
        update: (input: UpdateCanvasSessionInput) => {
          calls.push('update')
          return { ...createSession(input.canvasId, input.title ?? '页面设计'), archived: input.archived ?? false }
        },
        delete: (input: DeleteCanvasSessionInput) => {
          calls.push('delete')
          return createSession(input.canvasId)
        },
      },
      getProjectReadOnlyReason: () => undefined,
    })

    expect(await invoke(
      handlers,
      DESIGN_IPC_CHANNELS.LIST_CANVAS_SESSIONS,
      sender,
      { projectId: 'project-1', archived: false },
    )).toEqual([])
    expect(await invoke(
      handlers,
      DESIGN_IPC_CHANNELS.CREATE_CANVAS_SESSION,
      sender,
      { projectId: 'project-1', title: '页面设计' },
    )).toMatchObject({ id: 'canvas-1' })
    expect(await invoke(
      handlers,
      DESIGN_IPC_CHANNELS.UPDATE_CANVAS_SESSION,
      sender,
      { projectId: 'project-1', canvasId: 'canvas-1', archived: true },
    )).toMatchObject({ id: 'canvas-1', archived: true })
    expect(await invoke(
      handlers,
      DESIGN_IPC_CHANNELS.DELETE_CANVAS_SESSION,
      sender,
      { projectId: 'project-1', canvasId: 'canvas-1' },
    )).toMatchObject({ id: 'canvas-1' })

    expect(guardedProjects).toEqual(['project-1', 'project-1', 'project-1', 'project-1'])
    expect(calls).toEqual(['ensure', 'list:false', 'create', 'update', 'delete'])
    expect(sender.sent).toEqual([{
      channel: DESIGN_IPC_CHANNELS.CANVAS_SESSION_CHANGED,
      value: { projectId: 'project-1', canvasId: 'canvas-1', cause: 'created' },
    }, {
      channel: DESIGN_IPC_CHANNELS.CANVAS_SESSION_CHANGED,
      value: { projectId: 'project-1', canvasId: 'canvas-1', cause: 'updated' },
    }, {
      channel: DESIGN_IPC_CHANNELS.CANVAS_SESSION_CHANGED,
      value: { projectId: 'project-1', canvasId: 'canvas-1', cause: 'deleted' },
    }])
    registration.dispose()
    expect(handlers.size).toBe(0)
  })

  test('Given 未授权窗口 When 调用 Then 在守卫和 Store 副作用前拒绝', async () => {
    /** 记录是否错误进入业务层。 */
    const calls: string[] = []
    /** 当前注册的三个 invoke handler。 */
    const handlers = new Map<string, TestHandler>()
    const authorized = createSender(1)
    const unauthorized = createSender(99)
    registerCanvasSessionIpcHandlers({
      ipc: {
        handle: (channel, handler) => { handlers.set(channel, handler) },
        removeHandler: (channel) => { handlers.delete(channel) },
      },
      listAuthorizedWebContents: () => [authorized],
      guard: { runWorkspaceWrite: (_projectId, effect) => { calls.push('guard'); return effect() } },
      sessions: {
        ensureLegacySession: () => { calls.push('ensure'); return undefined },
        list: () => { calls.push('list'); return [] },
        create: () => { calls.push('create'); return createSession('canvas-1') },
        update: () => { calls.push('update'); return createSession('canvas-1') },
        delete: () => { calls.push('delete'); return createSession('canvas-1') },
      },
      getProjectReadOnlyReason: () => undefined,
    })

    await expect(invoke(
      handlers,
      DESIGN_IPC_CHANNELS.LIST_CANVAS_SESSIONS,
      unauthorized,
      { projectId: 'project-1' },
    )).rejects.toThrow('无权访问 Canvas 会话')
    expect(calls).toEqual([])
  })

  test('Given 请求夹带字段或路径型 ID When 调用 Then 在项目守卫前拒绝', async () => {
    /** 当前注册的三个 invoke handler。 */
    const handlers = new Map<string, TestHandler>()
    /** 非法请求不得触达的写守卫记录。 */
    const guardedProjects: string[] = []
    const sender = createSender(1)
    registerCanvasSessionIpcHandlers({
      ipc: {
        handle: (channel, handler) => { handlers.set(channel, handler) },
        removeHandler: (channel) => { handlers.delete(channel) },
      },
      listAuthorizedWebContents: () => [sender],
      guard: {
        runWorkspaceWrite: (projectId, effect) => {
          guardedProjects.push(projectId)
          return effect()
        },
      },
      sessions: {
        ensureLegacySession: () => undefined,
        list: () => [],
        create: () => createSession('canvas-1'),
        update: () => createSession('canvas-1'),
        delete: () => createSession('canvas-1'),
      },
      getProjectReadOnlyReason: () => undefined,
    })

    await expect(invoke(
      handlers,
      DESIGN_IPC_CHANNELS.CREATE_CANVAS_SESSION,
      sender,
      { projectId: 'project-1', title: '页面', absolutePath: '/tmp/forged' },
    )).rejects.toThrow('新建参数无效')
    await expect(invoke(
      handlers,
      DESIGN_IPC_CHANNELS.UPDATE_CANVAS_SESSION,
      sender,
      { projectId: 'project-1', canvasId: '../escape', archived: true },
    )).rejects.toThrow('项目或会话 ID 非法')
    await expect(invoke(
      handlers,
      DESIGN_IPC_CHANNELS.DELETE_CANVAS_SESSION,
      sender,
      { projectId: 'project-1', canvasId: '../escape' },
    )).rejects.toThrow('项目或会话 ID 非法')
    expect(guardedProjects).toEqual([])
  })

  test('Given 项目只读 When 列出 Then 只读现有索引；When 写入 Then 拒绝且不广播', async () => {
    /** 当前注册的三个 invoke handler。 */
    const handlers = new Map<string, TestHandler>()
    /** 只读列表不能投影旧 Design 或进入写守卫。 */
    const calls: string[] = []
    const sender = createSender(1)
    registerCanvasSessionIpcHandlers({
      ipc: {
        handle: (channel, handler) => { handlers.set(channel, handler) },
        removeHandler: (channel) => { handlers.delete(channel) },
      },
      listAuthorizedWebContents: () => [sender],
      guard: { runWorkspaceWrite: (_projectId, effect) => { calls.push('guard'); return effect() } },
      sessions: {
        ensureLegacySession: () => { calls.push('ensure'); return undefined },
        list: () => { calls.push('list'); return [createSession('existing')] },
        create: () => { calls.push('create'); return createSession('canvas-1') },
        update: () => { calls.push('update'); return createSession('canvas-1') },
        delete: () => { calls.push('delete'); return createSession('canvas-1') },
      },
      getProjectReadOnlyReason: () => '项目路径不可访问，设计工作区已切换为只读',
    })

    expect(await invoke(
      handlers,
      DESIGN_IPC_CHANNELS.LIST_CANVAS_SESSIONS,
      sender,
      { projectId: 'project-1' },
    )).toEqual([createSession('existing')])
    await expect(invoke(
      handlers,
      DESIGN_IPC_CHANNELS.CREATE_CANVAS_SESSION,
      sender,
      { projectId: 'project-1' },
    )).rejects.toThrow('项目路径不可访问')
    await expect(invoke(
      handlers,
      DESIGN_IPC_CHANNELS.DELETE_CANVAS_SESSION,
      sender,
      { projectId: 'project-1', canvasId: 'existing' },
    )).rejects.toThrow('项目路径不可访问')
    await expect(invoke(
      handlers,
      DESIGN_IPC_CHANNELS.UPDATE_CANVAS_SESSION,
      sender,
      { projectId: 'project-1', canvasId: 'existing', archived: true },
    )).rejects.toThrow('项目路径不可访问')
    expect(calls).toEqual(['list'])
    expect(sender.sent).toEqual([])
  })

  test('Given 一个授权窗口广播失败 When 新建成功 Then 其它窗口仍收到事件且返回已提交会话', async () => {
    /** 当前注册的三个 invoke handler。 */
    const handlers = new Map<string, TestHandler>()
    const failingSender = createSender(1)
    const receivingSender = createSender(2)
    /** 捕获预期诊断，避免故障注入污染测试输出。 */
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {})
    failingSender.send = () => { throw new Error('窗口发送失败') }
    registerCanvasSessionIpcHandlers({
      ipc: {
        handle: (channel, handler) => { handlers.set(channel, handler) },
        removeHandler: (channel) => { handlers.delete(channel) },
      },
      listAuthorizedWebContents: () => [failingSender, receivingSender],
      guard: { runWorkspaceWrite: (_projectId, effect) => effect() },
      sessions: {
        ensureLegacySession: () => undefined,
        list: () => [],
        create: () => createSession('canvas-1'),
        update: () => createSession('canvas-1'),
        delete: () => createSession('canvas-1'),
      },
      getProjectReadOnlyReason: () => undefined,
    })

    expect(await invoke(
      handlers,
      DESIGN_IPC_CHANNELS.CREATE_CANVAS_SESSION,
      receivingSender,
      { projectId: 'project-1' },
    )).toEqual(createSession('canvas-1'))
    expect(receivingSender.sent).toEqual([{
      channel: DESIGN_IPC_CHANNELS.CANVAS_SESSION_CHANGED,
      value: { projectId: 'project-1', canvasId: 'canvas-1', cause: 'created' },
    }])
    expect(errorSpy).toHaveBeenCalledWith(
      '[CanvasSessionIPC] 会话变化广播失败:',
      expect.objectContaining({ message: '窗口发送失败' }),
    )
    errorSpy.mockRestore()
  })
})
