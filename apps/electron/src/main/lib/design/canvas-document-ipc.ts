import { CANVAS_IPC_CHANNELS } from '@proma/shared'
import type {
  CanvasAgentNodeCreationResult,
  CanvasChangeEvent,
  CanvasMutation,
  CanvasWorkspaceSnapshot,
  CreateCanvasAgentNodeInput,
  LoadCanvasInput,
  SaveCanvasMutationsInput,
} from '@proma/shared'
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import type { WorkspaceOperationGuard } from '../workspace-operation-guard'
import type { CanvasDocumentStore } from './canvas-document-store'
import type { CanvasAgentNodeCreationService } from './canvas-agent-node-creation'
import { assertCreateCanvasAgentNodeInput } from './canvas-agent-node-creation'
import { isSafeDesignStableId } from './design-paths'

/** Canvas 文档 IPC handler 的最小签名。 */
type CanvasDocumentIpcHandler = (event: IpcMainInvokeEvent, input?: unknown) => unknown

/** 可注入、可清理的 IPC registrar。 */
export interface CanvasDocumentIpcRegistrar {
  handle: (channel: string, handler: CanvasDocumentIpcHandler) => void
  removeHandler: (channel: string) => void
}

/** 注册原生 Canvas 文档 IPC 的可信依赖。 */
export interface CanvasDocumentIpcOptions {
  ipc: CanvasDocumentIpcRegistrar
  listAuthorizedWebContents: () => WebContents[]
  guard: Pick<WorkspaceOperationGuard, 'runWorkspaceWrite'>
  store: Pick<CanvasDocumentStore, 'load' | 'mutate'>
  /** 已持有 lease 时执行目标 Canvas 创建事务对账。 */
  creation: Pick<CanvasAgentNodeCreationService, 'reconcile' | 'create'>
  getProjectReadOnlyReason: (projectId: string) => string | undefined
}

/** 注册结果用于退出和测试清理。 */
export interface CanvasDocumentIpcRegistration {
  /** 仅包含本注册器拥有的 invoke handler 通道。 */
  channels: string[]
  dispose: () => void
}

/** 每个 registrar 当前拥有 handler 的注册代次，防止旧 dispose 删除新 handler。 */
const currentRegistrationTokens = new WeakMap<CanvasDocumentIpcRegistrar, symbol>()

/**
 * 判断未知值是否为标准或 null prototype 的普通对象。
 * @param value Renderer 通过 IPC 提交的未知值。
 * @returns 可安全读取自有数据字段的普通对象返回 true。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  /** 自定义 prototype 可能携带继承 getter，不能进入业务层。 */
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * 校验对象只包含指定自有数据字段，拒绝 getter 和未知字段。
 * @param value 已确认 prototype 安全的普通对象。
 * @param keys 必填且唯一允许的字段名。
 * @returns 字段集合精确匹配且全部为数据属性时返回 true。
 */
function hasExactDataKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  /** 外层对象必须精确匹配合同，不能把路径或内部字段带入 Store。 */
  const actualKeys = Object.keys(value)
  if (actualKeys.length !== keys.length || !keys.every((key) => actualKeys.includes(key))) {
    return false
  }
  return keys.every((key) => {
    /** 访问值前先排除 getter/setter，避免解析触发调用方行为。 */
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor !== undefined && Object.hasOwn(descriptor, 'value')
  })
}

/**
 * 解析并重建原生 Canvas 加载输入。
 * @param value Renderer 提交的未知输入。
 * @returns 只包含双重稳定身份的新对象。
 */
function parseLoadInput(value: unknown): LoadCanvasInput {
  if (!isRecord(value) || !hasExactDataKeys(value, ['projectId', 'canvasId'])) {
    throw new Error('Canvas 加载参数无效')
  }
  if (!isSafeDesignStableId(value.projectId) || !isSafeDesignStableId(value.canvasId)) {
    throw new Error('Canvas 项目或会话 ID 非法')
  }
  return { projectId: value.projectId, canvasId: value.canvasId }
}

/**
 * 解析并重建原生 Canvas 保存输入，mutation 元素仍由 Store 权威校验。
 * @param value Renderer 提交的未知输入。
 * @returns 只包含公开合同字段的新对象。
 */
function parseSaveInput(value: unknown): SaveCanvasMutationsInput {
  if (!isRecord(value) || !hasExactDataKeys(
    value,
    ['projectId', 'canvasId', 'expectedRevision', 'mutations'],
  )) {
    throw new Error('Canvas 保存参数无效')
  }
  if (!isSafeDesignStableId(value.projectId) || !isSafeDesignStableId(value.canvasId)) {
    throw new Error('Canvas 项目或会话 ID 非法')
  }
  if (!Number.isSafeInteger(value.expectedRevision) || (value.expectedRevision as number) < 0) {
    throw new Error('Canvas expectedRevision 参数无效')
  }
  if (!Array.isArray(value.mutations)) throw new Error('Canvas mutations 参数无效')
  return {
    projectId: value.projectId,
    canvasId: value.canvasId,
    expectedRevision: value.expectedRevision as number,
    mutations: value.mutations as CanvasMutation[],
  }
}

/**
 * 解析并重建 Agent 节点创建输入，不接受 Renderer 传 sessionId 或模型字段。
 * @param value Renderer 提交的未知输入。
 * @returns 仅包含公开创建合同字段的新对象。
 */
function parseCreateAgentNodeInput(value: unknown): CreateCanvasAgentNodeInput {
  if (!isRecord(value) || !hasExactDataKeys(value, [
    'projectId', 'canvasId', 'operationId', 'nodeId', 'title', 'position',
  ])) {
    throw new Error('Canvas Agent 创建参数无效')
  }
  if (!isRecord(value.position) || !hasExactDataKeys(value.position, ['x', 'y'])) {
    throw new Error('Canvas Agent 位置参数无效')
  }
  /** 重建对象后交给共享主进程 validator 进行 ID、长度和有限数值检查。 */
  const input = {
    projectId: value.projectId,
    canvasId: value.canvasId,
    operationId: value.operationId,
    nodeId: value.nodeId,
    title: value.title,
    position: { x: value.position.x, y: value.position.y },
  } as CreateCanvasAgentNodeInput
  assertCreateCanvasAgentNodeInput(input)
  return input
}

/**
 * 确认调用来自仍存活的授权主窗口。
 * @param event Electron invoke 事件。
 * @param options 当前注册器可信依赖。
 */
function assertAuthorizedSender(event: IpcMainInvokeEvent, options: CanvasDocumentIpcOptions): void {
  /** sender 只按 Electron WebContents 稳定 ID 匹配。 */
  const authorized = options.listAuthorizedWebContents().some((contents) => (
    !contents.isDestroyed() && contents.id === event.sender.id
  ))
  if (!authorized) throw new Error('无权访问 Canvas 文档')
}

/**
 * 在任何可能创建目录或提升恢复候选的操作前拒绝只读项目。
 * @param projectId 已通过稳定 ID 校验的项目。
 * @param options 当前注册器可信依赖。
 */
function requireWritableProject(projectId: string, options: CanvasDocumentIpcOptions): void {
  /** 只读原因由项目状态事实统一计算并原样传播。 */
  const reason = options.getProjectReadOnlyReason(projectId)
  if (reason) throw new Error(reason)
}

/**
 * 向仍存活的授权窗口广播公开 Canvas 变化。
 * @param options 当前注册器可信依赖。
 * @param event 不包含路径或存储形态的业务事件。
 */
function broadcastChange(options: CanvasDocumentIpcOptions, event: CanvasChangeEvent): void {
  for (const contents of options.listAuthorizedWebContents()) {
    if (contents.isDestroyed()) continue
    try {
      contents.send(CANVAS_IPC_CHANNELS.CHANGED, event)
    } catch (error) {
      console.error('[CanvasDocumentIPC] Canvas 变化广播失败:', error)
    }
  }
}

/**
 * 注册原生 Canvas 文档 LOAD/SAVE/Agent 节点创建 IPC。
 * @param options 授权窗口、项目守卫和原生 Store。
 * @returns 本注册器拥有的 invoke 通道和幂等清理函数。
 */
export function registerCanvasDocumentIpcHandlers(
  options: CanvasDocumentIpcOptions,
): CanvasDocumentIpcRegistration {
  /** CHANGED 仅用于 send，不注册 handler。 */
  const channels = [
    CANVAS_IPC_CHANNELS.LOAD,
    CANVAS_IPC_CHANNELS.SAVE_MUTATIONS,
    CANVAS_IPC_CHANNELS.CREATE_AGENT_NODE,
  ]
  /** 当前调用独有的注册代次标识。 */
  const registrationToken = Symbol('canvas-document-ipc-registration')
  /** 热重载前先移除同名旧 handler。 */
  for (const channel of channels) options.ipc.removeHandler(channel)
  currentRegistrationTokens.set(options.ipc, registrationToken)

  options.ipc.handle(CANVAS_IPC_CHANNELS.LOAD, (event, value): CanvasWorkspaceSnapshot => {
    assertAuthorizedSender(event, options)
    /** 外层输入解析后只保留双重稳定身份。 */
    const input = parseLoadInput(value)
    requireWritableProject(input.projectId, options)
    /** LOAD 可能创建 Canvas 根或提升恢复候选，因此也必须持有写 lease。 */
    const reconciliation = options.guard.runWorkspaceWrite(
      input.projectId,
      () => options.creation.reconcile({ projectId: input.projectId, canvasId: input.canvasId }),
    )
    const snapshot = reconciliation.snapshot
    if (snapshot.recoveredFrom) {
      broadcastChange(options, {
        projectId: input.projectId,
        canvasId: input.canvasId,
        revision: snapshot.document.revision,
        cause: 'recovery',
      })
    } else if (reconciliation.documentChanged) {
      broadcastChange(options, {
        projectId: input.projectId,
        canvasId: input.canvasId,
        revision: snapshot.document.revision,
        cause: 'graph',
      })
    }
    return snapshot
  })

  options.ipc.handle(CANVAS_IPC_CHANNELS.SAVE_MUTATIONS, (event, value) => {
    assertAuthorizedSender(event, options)
    /** 保存输入在进入只读检查和 Store 前完成外层重建。 */
    const input = parseSaveInput(value)
    requireWritableProject(input.projectId, options)
    /** Store 在同一项目写 lease 内执行权威 schema、revision 和原子提交。 */
    const result = options.guard.runWorkspaceWrite(
      input.projectId,
      () => {
        /** SAVE 先在同一 lease 内完成创建事务发布屏障，禁止二次加锁。 */
        const reconciliation = options.creation.reconcile({
          projectId: input.projectId,
          canvasId: input.canvasId,
        })
        const document = options.store.mutate(
          { projectId: input.projectId, canvasId: input.canvasId },
          input.expectedRevision,
          input.mutations,
        )
        return { document, reconciliation }
      },
    )
    const document = result.document
    if (document.revision > input.expectedRevision) {
      broadcastChange(options, {
        projectId: input.projectId,
        canvasId: input.canvasId,
        revision: document.revision,
        cause: 'graph',
      })
    }
    return document
  })

  options.ipc.handle(CANVAS_IPC_CHANNELS.CREATE_AGENT_NODE, (event, value): CanvasAgentNodeCreationResult => {
    assertAuthorizedSender(event, options)
    const input = parseCreateAgentNodeInput(value)
    requireWritableProject(input.projectId, options)
    /** 创建服务内部不加锁，整个事务只持有这一份 workspace write lease。 */
    const result = options.guard.runWorkspaceWrite(
      input.projectId,
      () => options.creation.create(input),
    )
    if (result.documentChanged) {
      broadcastChange(options, {
        projectId: input.projectId,
        canvasId: input.canvasId,
        revision: result.document.revision,
        cause: 'graph',
      })
    }
    /** documentChanged 属于主进程发布策略，不暴露给 Renderer。 */
    return { document: result.document, session: result.session }
  })

  /** dispose 只移除本注册器的三个 invoke handler。 */
  let disposed = false
  return {
    channels: [...channels],
    dispose: () => {
      if (disposed) return
      disposed = true
      /** 被后续注册替代的 generation 已失去 handler 所有权。 */
      if (currentRegistrationTokens.get(options.ipc) !== registrationToken) return
      currentRegistrationTokens.delete(options.ipc)
      for (const channel of channels) options.ipc.removeHandler(channel)
    },
  }
}
