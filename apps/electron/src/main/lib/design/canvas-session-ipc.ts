import { DESIGN_IPC_CHANNELS } from '@proma/shared'
import type {
  CanvasSessionChangeEvent,
  CanvasSessionMeta,
  CreateCanvasSessionInput,
  DeleteCanvasSessionInput,
  ListCanvasSessionsInput,
  UpdateCanvasSessionInput,
} from '@proma/shared'
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import type { WorkspaceOperationGuard } from '../workspace-operation-guard'
import type { CanvasSessionStore } from './canvas-session-store'
import { isSafeDesignStableId } from './design-paths'

/** Canvas 会话 IPC handler 的最小签名。 */
type CanvasSessionIpcHandler = (event: IpcMainInvokeEvent, input?: unknown) => unknown

/** 可注入、可清理的 IPC registrar。 */
export interface CanvasSessionIpcRegistrar {
  handle: (channel: string, handler: CanvasSessionIpcHandler) => void
  removeHandler: (channel: string) => void
}

/** IPC 实际依赖的 Canvas 会话 store 窄接口。 */
type CanvasSessionStoreContract = Pick<
  CanvasSessionStore,
  'ensureLegacySession' | 'list' | 'create' | 'update' | 'delete'
>

/** 注册 Canvas 会话 IPC 的可信依赖。 */
export interface CanvasSessionIpcOptions {
  ipc: CanvasSessionIpcRegistrar
  listAuthorizedWebContents: () => WebContents[]
  guard: Pick<WorkspaceOperationGuard, 'runWorkspaceWrite'>
  sessions: CanvasSessionStoreContract
  getProjectReadOnlyReason: (projectId: string) => string | undefined
  /** 删除前阻止仍有运行任务的 Canvas 进入不可恢复清理。 */
  assertCanvasIdle?: (projectId: string, canvasId: string) => void
  /** 索引删除成功后先清理全部普通 Agent 关联并广播精确变化。 */
  cleanupBindings?: (projectId: string, canvasId: string) => void
  /** 索引删除成功后回收该 Canvas 独占的内部 Agent 会话。 */
  cleanupInternalSessions?: (projectId: string, canvasId: string) => Promise<void>
}

/** 注册结果用于退出和测试清理。 */
export interface CanvasSessionIpcRegistration {
  channels: string[]
  dispose: () => void
}

/**
 * 判断未知值是否为普通对象。
 * @param value Renderer 通过 IPC 提交的未知值。
 * @returns 非空且非数组对象返回 true。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 校验必填字段和允许字段。
 * @param value 待校验 IPC 对象。
 * @param required 必须存在的字段。
 * @param allowed 允许出现的完整字段集合。
 * @returns 字段边界完整且无额外字段时返回 true。
 */
function hasKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  allowed: readonly string[],
): boolean {
  /** 额外字段必须在进入业务层前被拒绝。 */
  const allowedKeys = new Set(allowed)
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowedKeys.has(key))
}

/**
 * 解析查询请求，拒绝路径和未知字段。
 * @param value Renderer 提交的未知查询参数。
 * @returns 重新构造的类型安全查询输入。
 */
function parseListInput(value: unknown): ListCanvasSessionsInput {
  if (!isRecord(value) || !hasKeys(value, ['projectId'], ['projectId', 'archived'])) {
    throw new Error('Canvas 会话列表参数无效')
  }
  if (!isSafeDesignStableId(value.projectId)) throw new Error('Canvas 项目 ID 非法')
  if (value.archived !== undefined && typeof value.archived !== 'boolean') {
    throw new Error('Canvas archived 参数无效')
  }
  return {
    projectId: value.projectId,
    ...(value.archived === undefined ? {} : { archived: value.archived }),
  }
}

/**
 * 解析新建请求，标题的内容上限由 store 统一执行。
 * @param value Renderer 提交的未知新建参数。
 * @returns 重新构造的类型安全新建输入。
 */
function parseCreateInput(value: unknown): CreateCanvasSessionInput {
  if (!isRecord(value) || !hasKeys(value, ['projectId'], ['projectId', 'title'])) {
    throw new Error('Canvas 会话新建参数无效')
  }
  if (!isSafeDesignStableId(value.projectId)) throw new Error('Canvas 项目 ID 非法')
  if (value.title !== undefined && typeof value.title !== 'string') {
    throw new Error('Canvas title 参数无效')
  }
  return {
    projectId: value.projectId,
    ...(value.title === undefined ? {} : { title: value.title }),
  }
}

/**
 * 解析更新请求，只允许标题和归档状态。
 * @param value Renderer 提交的未知更新参数。
 * @returns 重新构造的类型安全更新输入。
 */
function parseUpdateInput(value: unknown): UpdateCanvasSessionInput {
  if (!isRecord(value)
    || !hasKeys(value, ['projectId', 'canvasId'], ['projectId', 'canvasId', 'title', 'archived'])) {
    throw new Error('Canvas 会话更新参数无效')
  }
  if (!isSafeDesignStableId(value.projectId) || !isSafeDesignStableId(value.canvasId)) {
    throw new Error('Canvas 项目或会话 ID 非法')
  }
  if (value.title === undefined && value.archived === undefined) {
    throw new Error('Canvas 会话更新至少需要一个字段')
  }
  if (value.title !== undefined && typeof value.title !== 'string') {
    throw new Error('Canvas title 参数无效')
  }
  if (value.archived !== undefined && typeof value.archived !== 'boolean') {
    throw new Error('Canvas archived 参数无效')
  }
  return {
    projectId: value.projectId,
    canvasId: value.canvasId,
    ...(value.title === undefined ? {} : { title: value.title }),
    ...(value.archived === undefined ? {} : { archived: value.archived }),
  }
}

/** 解析删除请求，只接受项目与 Canvas 双重稳定身份。 */
function parseDeleteInput(value: unknown): DeleteCanvasSessionInput {
  if (!isRecord(value)
    || !hasKeys(value, ['projectId', 'canvasId'], ['projectId', 'canvasId'])
    || !isSafeDesignStableId(value.projectId)
    || !isSafeDesignStableId(value.canvasId)) {
    throw new Error('Canvas 项目或会话 ID 非法')
  }
  return { projectId: value.projectId, canvasId: value.canvasId }
}

/**
 * 确认调用来自当前授权主窗口。
 * @param event Electron invoke 事件。
 * @param options 当前注册器可信依赖。
 */
function assertAuthorizedSender(event: IpcMainInvokeEvent, options: CanvasSessionIpcOptions): void {
  /** 只有仍存活且 ID 精确匹配的主窗口可以访问 Canvas 会话。 */
  const authorized = options.listAuthorizedWebContents().some((contents) => (
    !contents.isDestroyed() && contents.id === event.sender.id
  ))
  if (!authorized) throw new Error('无权访问 Canvas 会话')
}

/**
 * 写入口在进入项目 guard 前拒绝离线或迁移项目。
 * @param projectId 已通过稳定 ID 校验的项目。
 * @param options 当前注册器可信依赖。
 */
function requireWritableProject(projectId: string, options: CanvasSessionIpcOptions): void {
  /** 只读原因由主进程项目状态统一计算。 */
  const reason = options.getProjectReadOnlyReason(projectId)
  if (reason) throw new Error(reason)
}

/**
 * 只在成功提交后向当前授权窗口广播公开业务事件。
 * @param options 当前注册器可信依赖。
 * @param event 不包含路径和内部存储形态的变化事件。
 */
function broadcastChange(options: CanvasSessionIpcOptions, event: CanvasSessionChangeEvent): void {
  for (const contents of options.listAuthorizedWebContents()) {
    if (contents.isDestroyed()) continue
    try {
      contents.send(DESIGN_IPC_CHANNELS.CANVAS_SESSION_CHANGED, event)
    } catch (error) {
      console.error('[CanvasSessionIPC] 会话变化广播失败:', error)
    }
  }
}

/**
 * 注册 Canvas 会话 IPC，并返回可重复调用的清理函数。
 * @param options 授权窗口、项目守卫与 Canvas Store。
 * @returns 本注册器拥有的通道和幂等清理函数。
 */
export function registerCanvasSessionIpcHandlers(
  options: CanvasSessionIpcOptions,
): CanvasSessionIpcRegistration {
  /** 本注册器拥有的固定 invoke 通道。 */
  const channels = [
    DESIGN_IPC_CHANNELS.LIST_CANVAS_SESSIONS,
    DESIGN_IPC_CHANNELS.CREATE_CANVAS_SESSION,
    DESIGN_IPC_CHANNELS.UPDATE_CANVAS_SESSION,
    DESIGN_IPC_CHANNELS.DELETE_CANVAS_SESSION,
  ]
  /** 热重载前先移除同名旧 handler。 */
  for (const channel of channels) options.ipc.removeHandler(channel)

  options.ipc.handle(DESIGN_IPC_CHANNELS.LIST_CANVAS_SESSIONS, (event, value): CanvasSessionMeta[] => {
    assertAuthorizedSender(event, options)
    /** 查询输入必须在项目状态和 Store 访问前完成解析。 */
    const input = parseListInput(value)
    /** 只读项目不允许兼容投影写入，但仍可读取已有索引。 */
    if (options.getProjectReadOnlyReason(input.projectId)) return options.sessions.list(input)
    return options.guard.runWorkspaceWrite(input.projectId, () => {
      options.sessions.ensureLegacySession(input.projectId)
      return options.sessions.list(input)
    })
  })

  options.ipc.handle(DESIGN_IPC_CHANNELS.CREATE_CANVAS_SESSION, (event, value): CanvasSessionMeta => {
    assertAuthorizedSender(event, options)
    /** 新建输入必须在只读和项目守卫前完成解析。 */
    const input = parseCreateInput(value)
    requireWritableProject(input.projectId, options)
    /** 会话只有在项目写 lease 内成功原子提交后才可广播。 */
    const session = options.guard.runWorkspaceWrite(input.projectId, () => options.sessions.create(input))
    broadcastChange(options, { projectId: input.projectId, canvasId: session.id, cause: 'created' })
    return session
  })

  options.ipc.handle(DESIGN_IPC_CHANNELS.UPDATE_CANVAS_SESSION, (event, value): CanvasSessionMeta => {
    assertAuthorizedSender(event, options)
    /** 更新输入必须在只读和项目守卫前完成解析。 */
    const input = parseUpdateInput(value)
    requireWritableProject(input.projectId, options)
    /** 更新只有在项目写 lease 内成功原子提交后才可广播。 */
    const session = options.guard.runWorkspaceWrite(input.projectId, () => options.sessions.update(input))
    broadcastChange(options, { projectId: input.projectId, canvasId: session.id, cause: 'updated' })
    return session
  })

  options.ipc.handle(DESIGN_IPC_CHANNELS.DELETE_CANVAS_SESSION, async (event, value): Promise<CanvasSessionMeta> => {
    assertAuthorizedSender(event, options)
    /** 删除输入必须在只读、运行态和持久化访问前完成解析。 */
    const input = parseDeleteInput(value)
    requireWritableProject(input.projectId, options)
    return options.guard.runWorkspaceWrite(input.projectId, async () => {
      options.assertCanvasIdle?.(input.projectId, input.canvasId)
      const session = options.sessions.delete(input)
      try {
        options.cleanupBindings?.(input.projectId, input.canvasId)
      } catch {
        /** 索引已删除，关联清理失败不得击穿主删除或泄露内部路径。 */
        console.error('[CanvasSessionIPC] Canvas 关联清理失败')
      }
      await options.cleanupInternalSessions?.(input.projectId, input.canvasId)
      broadcastChange(options, { projectId: input.projectId, canvasId: session.id, cause: 'deleted' })
      return session
    })
  })

  /** 清理函数只移除本注册器声明的通道。 */
  let disposed = false
  return {
    channels: [...channels],
    dispose: () => {
      if (disposed) return
      disposed = true
      for (const channel of channels) options.ipc.removeHandler(channel)
    },
  }
}
