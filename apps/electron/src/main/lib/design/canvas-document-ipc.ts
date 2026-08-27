import {
  CANVAS_IPC_CHANNELS,
  parseCreateCanvasContentNodeInput,
  parseDeleteCanvasNodeInput,
  parseRestoreCanvasNodeInput,
} from '@proma/shared'
import type {
  CanvasAgentNode,
  CanvasDocument,
  CanvasAgentNodeCreationResult,
  CanvasAgentMessagesResult,
  CanvasAgentActiveRunSnapshot,
  CanvasChangeEvent,
  CanvasInvokeResult,
  CanvasMutation,
  CanvasPublicError,
  CanvasPublicErrorCode,
  CanvasWorkspaceSnapshot,
  CanvasNodeLifecycleResult,
  CanvasTrashEntry,
  CreateCanvasAgentNodeInput,
  CreateCanvasContentNodeInput,
  DeleteCanvasNodeInput,
  GetCanvasAgentMessagesInput,
  LoadCanvasInput,
  RebuildCanvasAgentNodeInput,
  RebuildCanvasAgentNodeResult,
  RestoreCanvasNodeInput,
  SendCanvasAgentMessageInput,
  SendCanvasAgentMessageResult,
  SaveCanvasMutationsInput,
  StopCanvasAgentInput,
  AgentSendInput,
  AgentSessionMeta,
  SDKMessage,
} from '@proma/shared'
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import type { WorkspaceOperationGuard } from '../workspace-operation-guard'
import type { CanvasDocumentStore } from './canvas-document-store'
import type { CanvasAgentNodeCreationService } from './canvas-agent-node-creation'
import type {
  CanvasContentNodeLifecycle,
  CanvasContentNodeReconciledResult,
  CanvasContentNodeReconciliationResult,
} from './canvas-content-node-lifecycle'
import type { AgentRunExtensions } from '../agent-run-extensions'
import {
  CANVAS_AGENT_ALLOWED_TOOL_NAMES,
  requireCanvasAgentRunOwner,
} from './canvas-agent-run-policy'
import {
  assertCreateCanvasAgentNodeInput,
  assertRebuildCanvasAgentNodeInput,
} from './canvas-agent-node-creation'
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
  /** 已持有 lease 时执行目标 Canvas 对账或联合创建事务。 */
  creation: Pick<CanvasAgentNodeCreationService, 'reconcile' | 'createReconciled' | 'rebuildReconciled'>
  /** 非 Agent 内容节点的可恢复生命周期，只开放 IPC 所需窄接口。 */
  contentLifecycle: Pick<CanvasContentNodeLifecycle, 'load' | 'createReconciled' | 'deleteReconciled' | 'listTrashReconciled' | 'restoreReconciled'>
  /** Canvas 专用 Agent 能力；运行仍复用全局 Pi runtime。 */
  agent: {
    listActiveRuns: () => CanvasAgentActiveRunSnapshot
    getSession: (sessionId: string) => AgentSessionMeta | undefined
    getMessages: (sessionId: string) => SDKMessage[]
    reserveStart: (sessionId: string, startedAt?: number) => () => void
    run: (input: AgentSendInput, sender: WebContents, extensions: AgentRunExtensions) => Promise<void>
    stop: (sessionId: string) => void
  }
  getProjectReadOnlyReason: (projectId: string) => string | undefined
}

/** Canvas Agent target 的 exact-key 解析结果。 */
function parseAgentTarget(value: unknown): GetCanvasAgentMessagesInput {
  if (!isRecord(value) || !hasExactDataKeys(value, ['projectId', 'canvasId', 'nodeId'])) {
    throw new Error('Canvas Agent 参数无效')
  }
  if (!isSafeDesignStableId(value.projectId)
    || !isSafeDesignStableId(value.canvasId)
    || !isSafeDesignStableId(value.nodeId)) {
    throw new Error('Canvas Agent 参数无效')
  }
  return { projectId: value.projectId, canvasId: value.canvasId, nodeId: value.nodeId }
}

/** Canvas Agent 发送输入只接受有限纯文本与 Renderer 生成的本轮身份。 */
function parseSendAgentInput(value: unknown): SendCanvasAgentMessageInput {
  if (!isRecord(value) || !hasExactDataKeys(
    value,
    ['projectId', 'canvasId', 'nodeId', 'message', 'userMessageUuid', 'startedAt'],
  )) throw new Error('Canvas Agent 参数无效')
  const target = parseAgentTarget({
    projectId: value.projectId,
    canvasId: value.canvasId,
    nodeId: value.nodeId,
  })
  if (typeof value.message !== 'string'
    || value.message.trim().length === 0
    || value.message.length > 100_000
    || typeof value.userMessageUuid !== 'string'
    || value.userMessageUuid.length === 0
    || value.userMessageUuid.length > 120
    || typeof value.startedAt !== 'number'
    || !Number.isSafeInteger(value.startedAt)
    || value.startedAt < 0) {
    throw new Error('Canvas Agent 参数无效')
  }
  return {
    ...target,
    message: value.message,
    userMessageUuid: value.userMessageUuid,
    startedAt: value.startedAt,
  }
}

/** 判断 Agent 启动槽是否因同会话已有任务而拒绝。 */
function isAgentSessionBusyError(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && error.code === 'AGENT_SESSION_BUSY'
}

/** 需要安全结果信封的 Canvas 操作类别。 */
type CanvasInvokeOperation = 'load' | 'save' | 'create' | 'delete' | 'listTrash' | 'restore' | 'rebuild' | 'messages' | 'send' | 'stop'

/** 主进程内部携带公开错误码的可预期业务失败。 */
class CanvasPublicFailure extends Error {
  /**
   * 创建仅含稳定公开信息的业务失败。
   * @param code Renderer 可判别的公开错误码。
   * @param message 可以直接展示给用户的中文文案。
   */
  constructor(
    readonly code: CanvasPublicErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'CanvasPublicFailure'
  }
}

/** 各操作发生未知异常时使用的固定公开失败。 */
const CANVAS_OPERATION_FALLBACKS: Record<CanvasInvokeOperation, CanvasPublicError> = {
  load: { code: 'CANVAS_LOAD_FAILED', message: '画布暂时无法加载。' },
  save: { code: 'CANVAS_SAVE_FAILED', message: '画布暂时无法保存。' },
  create: { code: 'CANVAS_CREATE_FAILED', message: '节点创建失败，请重试。' },
  delete: { code: 'CANVAS_DELETE_FAILED', message: '节点删除失败，请重试。' },
  listTrash: { code: 'CANVAS_CONTENT_INVALID', message: '回收区暂时无法加载。' },
  restore: { code: 'CANVAS_RESTORE_FAILED', message: '节点恢复失败，请重试。' },
  rebuild: { code: 'AGENT_SESSION_REBUILD_FAILED', message: '重建失败，请重试。' },
  messages: { code: 'CANVAS_AGENT_MESSAGES_FAILED', message: '会话消息暂时无法加载。' },
  send: { code: 'CANVAS_AGENT_SEND_FAILED', message: '消息发送失败，请重试。' },
  stop: { code: 'CANVAS_AGENT_STOP_FAILED', message: '停止 Agent 失败，请重试。' },
}

/**
 * 判断 Store 异常是否表示乐观 revision 已过期。
 * @param error Store 或对账层抛出的未知异常。
 * @returns 错误具有稳定 revision 冲突前缀时返回 true。
 */
function isCanvasRevisionConflict(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('CANVAS_REVISION_CONFLICT')
}

/**
 * 将内部异常映射为不含路径、身份和堆栈的公开错误。
 * @param operation 当前 Canvas 操作类别。
 * @param error 主进程内部捕获的未知异常。
 * @returns 可以跨 IPC 返回的稳定公开错误。
 */
function toCanvasPublicError(
  operation: CanvasInvokeOperation,
  error: unknown,
): CanvasPublicError {
  if (error instanceof CanvasPublicFailure) {
    return { code: error.code, message: error.message }
  }
  if ((operation === 'save' || operation === 'create' || operation === 'delete' || operation === 'restore')
    && isCanvasRevisionConflict(error)) {
    return {
      code: 'CANVAS_REVISION_CONFLICT',
      message: '画布已更新，请重新加载后重试。',
    }
  }
  if (isAgentSessionBusyError(error)) {
    return { code: 'AGENT_SESSION_BUSY', message: '请先停止 Agent，再继续节点操作。' }
  }
  /** 返回新对象，避免调用方意外修改模块级默认值。 */
  const fallback = CANVAS_OPERATION_FALLBACKS[operation]
  return { ...fallback }
}

/**
 * 将 Canvas handler 的成功或失败统一收敛为安全结果信封。
 * @param operation 当前操作类别，用于选择固定公开错误。
 * @param run 实际业务操作，允许同步校验和异步事务一起执行。
 * @returns 成功值或不含内部异常正文的公开失败。
 */
async function invokeCanvasOperation<T>(
  operation: CanvasInvokeOperation,
  run: () => Promise<T>,
): Promise<CanvasInvokeResult<T>> {
  try {
    return { ok: true, value: await run() }
  } catch (error) {
    if (!(error instanceof CanvasPublicFailure)) {
      console.error(`[CanvasDocumentIPC] ${operation} 操作失败:`, error)
    }
    return { ok: false, error: toCanvasPublicError(operation, error) }
  }
}

/**
 * 判断目标 Agent 节点或其 session 是否仍有权威运行事实。
 * @param activeRuns 主进程当前活动运行快照。
 * @param nodeId 目标 Canvas 节点 ID。
 * @param sessionId 节点当前绑定的 session ID。
 * @returns 正常 owner 或内部损坏运行命中目标时返回 true。
 */
function isCanvasAgentNodeBusy(
  activeRuns: CanvasAgentActiveRunSnapshot,
  nodeId: string,
  sessionId: string,
): boolean {
  return activeRuns.owners.some((owner) => (
    owner.nodeId === nodeId || owner.sessionId === sessionId
  )) || activeRuns.internalInvalidRuns.some((run) => run.sessionId === sessionId)
}

/**
 * 拒绝删除仍在运行的 Agent 节点，保证后台任务在 Canvas 中保持可见。
 * @param document 对账完成后的权威 Canvas 文档。
 * @param mutations 本次待原子提交的全部 mutation。
 * @param activeRuns 主进程当前活动运行快照。
 */
function assertRemovedAgentNodesAreIdle(
  document: CanvasDocument,
  mutations: CanvasMutation[],
  activeRuns: CanvasAgentActiveRunSnapshot,
): void {
  /** 汇总整个 batch 中所有待删除节点，任一忙碌即拒绝整批。 */
  const removedNodeIds = new Set<string>()
  for (const mutation of mutations) {
    if (mutation.type !== 'remove-nodes') continue
    for (const nodeId of mutation.nodeIds) removedNodeIds.add(nodeId)
  }
  /** 只检查文档中真实存在的 Agent 节点，普通节点不参与运行态判断。 */
  const removedAgentNodes = document.nodes.filter((node): node is CanvasAgentNode => (
    node.kind === 'agent' && removedNodeIds.has(node.id)
  ))
  /** 节点 ID 和 session ID 任一命中都说明后台任务仍依赖该节点。 */
  const busy = removedAgentNodes.some((node) => isCanvasAgentNodeBusy(
    activeRuns,
    node.id,
    node.agentSessionId,
  ))
  if (busy) {
    throw new CanvasPublicFailure('AGENT_SESSION_BUSY', '请先停止 Agent，再删除节点。')
  }
}

/** 拒绝旧 SAVE mutation 绕过内容生命周期而留下孤儿目录。 */
function assertRemovedContentNodesUseLifecycle(
  document: CanvasDocument,
  mutations: CanvasMutation[],
): void {
  /** 整批删除 ID 用集合收敛，保持检查复杂度为 O(nodes + ids)。 */
  const removedNodeIds = new Set<string>()
  for (const mutation of mutations) {
    if (mutation.type !== 'remove-nodes') continue
    for (const nodeId of mutation.nodeIds) removedNodeIds.add(nodeId)
  }
  if (document.nodes.some((node) => node.kind !== 'agent' && removedNodeIds.has(node.id))) {
    throw new CanvasPublicFailure('CANVAS_CONTENT_INVALID', '请使用节点删除操作。')
  }
}

/** 注册结果用于退出和测试清理。 */
export interface CanvasDocumentIpcRegistration {
  /** 仅包含本注册器拥有的 invoke handler 通道。 */
  channels: string[]
  dispose: () => void
}

/** 同一 lease 内的对账与后续操作结果，错误必须延迟到发布对账事件后再抛出。 */
type ReconciledOperationOutcome<T> = {
  reconciliation: Awaited<ReturnType<CanvasAgentNodeCreationService['reconcile']>>
} & (
  | { ok: true; value: T }
  | { ok: false; error: unknown }
)

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

/** 解析并重建内容节点创建输入，嵌套对象同样拒绝 getter。 */
function parseCreateContentNodeInput(value: unknown): CreateCanvasContentNodeInput {
  const baseKeys = ['projectId', 'canvasId', 'operationId', 'nodeId', 'kind', 'contentId', 'title', 'position', 'expectedRevision'] as const
  if (!isRecord(value)) throw new Error('Canvas 内容节点创建参数无效')
  /** 可选 relationship 是否存在只读取字段名，避免提前触发 getter。 */
  const hasRelationship = Object.keys(value).includes('relationship')
  if (!hasExactDataKeys(value, hasRelationship ? [...baseKeys, 'relationship'] : baseKeys)
    || !isRecord(value.position)
    || !hasExactDataKeys(value.position, ['x', 'y'])) {
    throw new Error('Canvas 内容节点创建参数无效')
  }
  if (hasRelationship && (!isRecord(value.relationship)
    || !hasExactDataKeys(value.relationship, ['sourceNodeId', 'edgeId']))) {
    throw new Error('Canvas 内容节点扩展关系参数无效')
  }
  return parseCreateCanvasContentNodeInput({
    projectId: value.projectId,
    canvasId: value.canvasId,
    operationId: value.operationId,
    nodeId: value.nodeId,
    kind: value.kind,
    contentId: value.contentId,
    title: value.title,
    position: { x: value.position.x, y: value.position.y },
    expectedRevision: value.expectedRevision,
    ...(hasRelationship && isRecord(value.relationship)
      ? { relationship: { sourceNodeId: value.relationship.sourceNodeId, edgeId: value.relationship.edgeId } }
      : {}),
  })
}

/** 解析并重建通用节点删除输入。 */
function parseDeleteNodeInput(value: unknown): DeleteCanvasNodeInput {
  if (!isRecord(value) || !hasExactDataKeys(value, ['projectId', 'canvasId', 'nodeId', 'operationId', 'expectedRevision'])) {
    throw new Error('Canvas 节点删除参数无效')
  }
  return parseDeleteCanvasNodeInput({
    projectId: value.projectId,
    canvasId: value.canvasId,
    nodeId: value.nodeId,
    operationId: value.operationId,
    expectedRevision: value.expectedRevision,
  })
}

/** 解析并重建回收区恢复输入。 */
function parseRestoreNodeInput(value: unknown): RestoreCanvasNodeInput {
  if (!isRecord(value)
    || !hasExactDataKeys(value, ['projectId', 'canvasId', 'operationId', 'trashId', 'expectedRevision', 'position'])
    || !isRecord(value.position)
    || !hasExactDataKeys(value.position, ['x', 'y'])) {
    throw new Error('Canvas 节点恢复参数无效')
  }
  return parseRestoreCanvasNodeInput({
    projectId: value.projectId,
    canvasId: value.canvasId,
    operationId: value.operationId,
    trashId: value.trashId,
    expectedRevision: value.expectedRevision,
    position: { x: value.position.x, y: value.position.y },
  })
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
  const baseKeys = ['projectId', 'canvasId', 'operationId', 'nodeId', 'title', 'position'] as const
  if (!isRecord(value) || !hasExactDataKeys(
    value,
    value.relationship === undefined ? baseKeys : [...baseKeys, 'relationship'],
  )) {
    throw new Error('Canvas Agent 创建参数无效')
  }
  if (!isRecord(value.position) || !hasExactDataKeys(value.position, ['x', 'y'])) {
    throw new Error('Canvas Agent 位置参数无效')
  }
  if (value.relationship !== undefined
    && (!isRecord(value.relationship)
      || !hasExactDataKeys(value.relationship, ['sourceNodeId', 'edgeId']))) {
    throw new Error('Canvas Agent 扩展关系参数无效')
  }
  /** 重建对象后交给共享主进程 validator 进行 ID、长度和有限数值检查。 */
  const input = {
    projectId: value.projectId,
    canvasId: value.canvasId,
    operationId: value.operationId,
    nodeId: value.nodeId,
    title: value.title,
    position: { x: value.position.x, y: value.position.y },
    ...(isRecord(value.relationship)
      ? {
          relationship: {
            sourceNodeId: value.relationship.sourceNodeId,
            edgeId: value.relationship.edgeId,
          },
        }
      : {}),
  } as CreateCanvasAgentNodeInput
  assertCreateCanvasAgentNodeInput(input)
  return input
}

/**
 * 解析并重建 Agent 节点会话重建输入，不接受旧、新 session 身份。
 * @param value Renderer 提交的未知输入。
 * @returns 仅包含公开重建合同字段的新对象。
 */
function parseRebuildAgentNodeInput(value: unknown): RebuildCanvasAgentNodeInput {
  if (!isRecord(value) || !hasExactDataKeys(
    value,
    ['projectId', 'canvasId', 'nodeId', 'operationId'],
  )) {
    throw new Error('Canvas Agent 重建参数无效')
  }
  /** 重建对象后交给共享主进程 validator 做稳定 ID 与 UUID 校验。 */
  const input = {
    projectId: value.projectId,
    canvasId: value.canvasId,
    nodeId: value.nodeId,
    operationId: value.operationId,
  } as RebuildCanvasAgentNodeInput
  assertRebuildCanvasAgentNodeInput(input)
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
 * 发布一次创建事务对账事实，恢复优先于普通图变化。
 * @param options 当前注册器可信依赖。
 * @param target 已校验的项目与 Canvas 身份。
 * @param reconciliation 同一 lease 内完成的权威对账结果。
 */
function publishReconciliation(
  options: CanvasDocumentIpcOptions,
  target: { projectId: string; canvasId: string },
  reconciliation: Awaited<ReturnType<CanvasAgentNodeCreationService['reconcile']>>,
): void {
  const snapshot = reconciliation.snapshot
  if (snapshot.recoveredFrom) {
    broadcastChange(options, {
      projectId: target.projectId,
      canvasId: target.canvasId,
      revision: snapshot.document.revision,
      cause: 'recovery',
    })
    return
  }
  if (reconciliation.documentChanged) {
    broadcastChange(options, {
      projectId: target.projectId,
      canvasId: target.canvasId,
      revision: snapshot.document.revision,
      cause: 'graph',
    })
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
    CANVAS_IPC_CHANNELS.CREATE_CONTENT_NODE,
    CANVAS_IPC_CHANNELS.DELETE_NODE,
    CANVAS_IPC_CHANNELS.LIST_TRASH,
    CANVAS_IPC_CHANNELS.RESTORE_NODE,
    CANVAS_IPC_CHANNELS.REBUILD_AGENT_NODE,
    CANVAS_IPC_CHANNELS.LIST_ACTIVE_AGENT_RUNS,
    CANVAS_IPC_CHANNELS.GET_AGENT_MESSAGES,
    CANVAS_IPC_CHANNELS.SEND_AGENT_MESSAGE,
    CANVAS_IPC_CHANNELS.STOP_AGENT,
  ]
  /** 当前调用独有的注册代次标识。 */
  const registrationToken = Symbol('canvas-document-ipc-registration')
  /** 热重载前先移除同名旧 handler。 */
  for (const channel of channels) options.ipc.removeHandler(channel)
  currentRegistrationTokens.set(options.ipc, registrationToken)
  /** 同一 Canvas 的完整异步写链串行，不同 Canvas 仍保持并行。 */
  const canvasOperationTails = new Map<string, Promise<void>>()
  /** 在指定项目与 Canvas 的键控队列中执行一次完整 IPC 写操作。 */
  const runCanvasExclusive = async <T>(
    projectId: string,
    canvasId: string,
    effect: () => Promise<T>,
  ): Promise<T> => {
    const key = `${projectId}\0${canvasId}`
    const previous = canvasOperationTails.get(key) ?? Promise.resolve()
    let release = (): void => {}
    const current = new Promise<void>((resolvePromise) => { release = resolvePromise })
    const tail = previous.catch(() => undefined).then(() => current)
    canvasOperationTails.set(key, tail)
    void tail.finally(() => {
      if (canvasOperationTails.get(key) === tail) canvasOperationTails.delete(key)
    })
    await previous.catch(() => undefined)
    try {
      return await effect()
    } finally {
      release()
    }
  }

  /** 按发生顺序发布历史或当前图事实，并去重同 cause + revision。 */
  const publishUniqueChange = (
    target: { projectId: string; canvasId: string },
    published: Set<string>,
    revision: number,
    cause: CanvasChangeEvent['cause'],
  ): void => {
    const key = `${cause}:${revision}`
    if (published.has(key)) return
    published.add(key)
    broadcastChange(options, {
      projectId: target.projectId,
      canvasId: target.canvasId,
      revision,
      cause,
    })
  }

  /** 发布单次 Agent 或内容对账事实，恢复来源优先于普通图变化。 */
  const publishUniqueReconciliation = (
    target: { projectId: string; canvasId: string },
    published: Set<string>,
    reconciliation: CanvasContentNodeReconciliationResult,
  ): void => {
    if (reconciliation.snapshot.recoveredFrom) {
      publishUniqueChange(target, published, reconciliation.snapshot.document.revision, 'recovery')
      return
    }
    if (reconciliation.documentChanged) {
      publishUniqueChange(
        target,
        published,
        reconciliation.publication?.revision ?? reconciliation.snapshot.document.revision,
        'graph',
      )
    }
  }

  /** 在同一 Canvas 队列与 workspace lease 内串接 Agent 对账和内容生命周期。 */
  const runContentLifecycle = async <T>(
    input: LoadCanvasInput,
    effect: () => Promise<CanvasContentNodeReconciledResult<T>>,
    getSuccessfulDocument?: (value: T) => CanvasDocument | undefined,
  ): Promise<T> => runCanvasExclusive(input.projectId, input.canvasId, async () => {
    const outcome = await options.guard.runWorkspaceWrite(input.projectId, async () => {
      /** Agent intent 先收敛，内容 wrapper 自身随后只扫描一次 content intent。 */
      const agentReconciliation = await options.creation.reconcile(input)
      if (agentReconciliation.error) return { agentReconciliation }
      return { agentReconciliation, content: await effect() }
    })
    /** 所有广播必须发生在 workspace lease 释放后。 */
    const published = new Set<string>()
    publishUniqueReconciliation(input, published, outcome.agentReconciliation)
    if (outcome.agentReconciliation.error) throw outcome.agentReconciliation.error
    if (!outcome.content) throw new Error('CANVAS_CONTENT_LIFECYCLE_MISSING')
    publishUniqueReconciliation(input, published, outcome.content.reconciliation)
    if (!outcome.content.operationOutcome.ok) {
      if (outcome.content.operationOutcome.publication) {
        publishUniqueChange(
          input,
          published,
          outcome.content.operationOutcome.publication.revision,
          'graph',
        )
      }
      throw outcome.content.operationOutcome.error
    }
    /** 成功操作仅在本轮 revision 前进时发布，幂等重放不重复广播。 */
    const successfulDocument = getSuccessfulDocument?.(outcome.content.operationOutcome.value)
    if (successfulDocument
      && successfulDocument.revision !== outcome.content.reconciliation.snapshot.document.revision) {
      publishUniqueChange(input, published, successfulDocument.revision, 'graph')
    }
    return outcome.content.operationOutcome.value
  })

  options.ipc.handle(
    CANVAS_IPC_CHANNELS.LIST_ACTIVE_AGENT_RUNS,
    (event): CanvasAgentActiveRunSnapshot => {
      assertAuthorizedSender(event, options)
      return options.agent.listActiveRuns()
    },
  )

  /** 在 Canvas 串行队列和 workspace lease 内完成 pending 对账与双向归属确认。 */
  const resolveAgentOwner = async (
    input: GetCanvasAgentMessagesInput,
    operation: 'messages' | 'send' | 'stop',
  ) => {
    requireWritableProject(input.projectId, options)
    return runCanvasExclusive(input.projectId, input.canvasId, async () => {
      /** 对账快照是节点可用性与 session 归属的唯一事实。 */
      const reconciliation = await options.guard.runWorkspaceWrite(
        input.projectId,
        () => options.creation.reconcile({ projectId: input.projectId, canvasId: input.canvasId }),
      )
      publishReconciliation(options, input, reconciliation)
      if (reconciliation.error) throw reconciliation.error
      /** 坏节点在读取 session JSONL 或触发 runtime 前必须短路。 */
      const unavailable = reconciliation.snapshot.nodeIssues.some((issue) => issue.nodeId === input.nodeId)
      if (unavailable) {
        throw new CanvasPublicFailure(
          CANVAS_OPERATION_FALLBACKS[operation].code,
          '会话不可用。',
        )
      }
      return requireCanvasAgentRunOwner({
        target: input,
        nodeId: input.nodeId,
        document: reconciliation.snapshot.document,
        getSession: options.agent.getSession,
      })
    })
  }

  options.ipc.handle(CANVAS_IPC_CHANNELS.GET_AGENT_MESSAGES, (event, value) => (
    invokeCanvasOperation<CanvasAgentMessagesResult>('messages', async () => {
      assertAuthorizedSender(event, options)
      /** 解析后的目标不携带 Renderer 提供的 session 身份。 */
      const input = parseAgentTarget(value)
      /** 归属解析先消费 nodeIssues，再允许读取消息 JSONL。 */
      const owner = await resolveAgentOwner(input, 'messages')
      return {
        sessionId: owner.session.id,
        owner: { ...input, title: owner.node.title },
        messages: options.agent.getMessages(owner.session.id),
      }
    })
  ))

  options.ipc.handle(CANVAS_IPC_CHANNELS.SEND_AGENT_MESSAGE, (event, value) => (
    invokeCanvasOperation<SendCanvasAgentMessageResult>('send', async () => {
      assertAuthorizedSender(event, options)
      /** 解析后的发送输入只包含纯文本和本轮公开身份。 */
      const input = parseSendAgentInput(value)
      /** 坏节点必须在预留 runtime 启动槽前被拒绝。 */
      const owner = await resolveAgentOwner(input, 'send')
      /** 只有同会话 busy 属于发送合同内可恢复的准入结果。 */
      let releaseStart: () => void
      try {
        releaseStart = options.agent.reserveStart(owner.session.id, input.startedAt)
      } catch (error) {
        if (isAgentSessionBusyError(error)) {
          return {
            ok: false,
            error: { code: 'SESSION_BUSY', message: '会话正在运行，请先停止当前任务。' },
          }
        }
        throw error
      }
      try {
        await options.agent.run({
          sessionId: owner.session.id,
          userMessage: input.message,
          rawUserMessage: input.message,
          userMessageUuid: input.userMessageUuid,
          startedAt: input.startedAt,
          channelId: owner.session.channelId ?? '',
          ...(owner.session.modelId ? { modelId: owner.session.modelId } : {}),
          workspaceId: input.projectId,
          triggeredBy: 'user',
        }, event.sender, { allowedToolNames: CANVAS_AGENT_ALLOWED_TOOL_NAMES })
      } finally {
        releaseStart()
      }
      return { ok: true }
    })
  ))

  options.ipc.handle(CANVAS_IPC_CHANNELS.STOP_AGENT, (event, value) => (
    invokeCanvasOperation<void>('stop', async () => {
      assertAuthorizedSender(event, options)
      /** 停止请求同样只按节点身份解析，禁止 Renderer 指定 session。 */
      const input = parseAgentTarget(value) as StopCanvasAgentInput
      /** 坏节点没有可安全解析的正常 owner，直接返回公开失败。 */
      const owner = await resolveAgentOwner(input, 'stop')
      options.agent.stop(owner.session.id)
    })
  ))

  options.ipc.handle(CANVAS_IPC_CHANNELS.LOAD, (event, value) => (
    invokeCanvasOperation<CanvasWorkspaceSnapshot>('load', async () => {
      assertAuthorizedSender(event, options)
      /** 外层输入解析后只保留双重稳定身份。 */
      const input = parseLoadInput(value)
      requireWritableProject(input.projectId, options)
      /** LOAD 可能创建 Canvas 根或提升恢复候选，因此也必须持有写 lease。 */
      return runCanvasExclusive(input.projectId, input.canvasId, async () => {
        /** v1 内容必须先物化并提交 schema v2，Agent 对账才可安全 mutate。 */
        const outcome = await options.guard.runWorkspaceWrite(input.projectId, async () => {
          const content = await options.contentLifecycle.load(input)
          if (content.error) return { content }
          return { content, agent: await options.creation.reconcile(input) }
        })
        const published = new Set<string>()
        publishUniqueReconciliation(input, published, outcome.content)
        if (outcome.content.error) throw outcome.content.error
        if (!outcome.agent) throw new Error('CANVAS_AGENT_RECONCILIATION_MISSING')
        publishUniqueReconciliation(input, published, outcome.agent)
        if (outcome.agent.error) throw outcome.agent.error
        return outcome.agent.snapshot
      })
    })
  ))

  options.ipc.handle(CANVAS_IPC_CHANNELS.SAVE_MUTATIONS, (event, value) => (
    invokeCanvasOperation<CanvasDocument>('save', async () => {
      assertAuthorizedSender(event, options)
      /** 保存输入在进入只读检查和 Store 前完成外层重建。 */
      const input = parseSaveInput(value)
      requireWritableProject(input.projectId, options)
      /** Store 在同一项目写 lease 内执行权威 schema、revision 和原子提交。 */
      return runCanvasExclusive(input.projectId, input.canvasId, async () => {
        /** 对账、运行态删除检查和 Store mutation 共用同一 workspace lease。 */
        const outcome = await options.guard.runWorkspaceWrite(
          input.projectId,
          async (): Promise<ReconciledOperationOutcome<CanvasDocument>> => {
            /** SAVE 先在同一 lease 内完成创建事务发布屏障，禁止二次加锁。 */
            const reconciliation = await options.creation.reconcile({
              projectId: input.projectId,
              canvasId: input.canvasId,
            })
            if (reconciliation.error) {
              return { ok: false, error: reconciliation.error, reconciliation }
            }
            try {
              assertRemovedContentNodesUseLifecycle(
                reconciliation.snapshot.document,
                input.mutations,
              )
              assertRemovedAgentNodesAreIdle(
                reconciliation.snapshot.document,
                input.mutations,
                options.agent.listActiveRuns(),
              )
              /** 只有整个删除 batch 均为空闲，才允许进入原子 Store 提交。 */
              const document = options.store.mutate(
                { projectId: input.projectId, canvasId: input.canvasId },
                input.expectedRevision,
                input.mutations,
              )
              return { ok: true, value: document, reconciliation }
            } catch (error) {
              /** 已提交的对账 revision 不能被后续 SAVE 错误吞掉。 */
              return { ok: false, error, reconciliation }
            }
          },
        )
        publishReconciliation(options, input, outcome.reconciliation)
        if (!outcome.ok) throw outcome.error
        /** 成功文档是广播 revision 与返回值的共同事实。 */
        const document = outcome.value
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
    })
  ))

  options.ipc.handle(CANVAS_IPC_CHANNELS.CREATE_CONTENT_NODE, (event, value) => (
    invokeCanvasOperation<CanvasNodeLifecycleResult>('create', async () => {
      assertAuthorizedSender(event, options)
      /** Renderer 只能提交公开内容身份，不能指定路径或内部 intent。 */
      const input = parseCreateContentNodeInput(value)
      requireWritableProject(input.projectId, options)
      return runContentLifecycle(
        input,
        () => options.contentLifecycle.createReconciled(input),
        (result) => result.snapshot.document,
      )
    })
  ))

  options.ipc.handle(CANVAS_IPC_CHANNELS.DELETE_NODE, (event, value) => (
    invokeCanvasOperation<CanvasNodeLifecycleResult>('delete', async () => {
      assertAuthorizedSender(event, options)
      /** 通用删除入口只接受节点身份和乐观 revision。 */
      const input = parseDeleteNodeInput(value)
      requireWritableProject(input.projectId, options)
      return runContentLifecycle(
        input,
        () => options.contentLifecycle.deleteReconciled(input),
        (result) => result.snapshot.document,
      )
    })
  ))

  options.ipc.handle(CANVAS_IPC_CHANNELS.LIST_TRASH, (event, value) => (
    invokeCanvasOperation<CanvasTrashEntry[]>('listTrash', async () => {
      assertAuthorizedSender(event, options)
      /** 回收区列表只按项目与 Canvas 身份读取，不接受路径或 trash 条目。 */
      const input = parseLoadInput(value)
      requireWritableProject(input.projectId, options)
      return runContentLifecycle(input, () => options.contentLifecycle.listTrashReconciled(input))
    })
  ))

  options.ipc.handle(CANVAS_IPC_CHANNELS.RESTORE_NODE, (event, value) => (
    invokeCanvasOperation<CanvasNodeLifecycleResult>('restore', async () => {
      assertAuthorizedSender(event, options)
      /** 恢复位置与回收身份均由严格共享 parser 重建。 */
      const input = parseRestoreNodeInput(value)
      requireWritableProject(input.projectId, options)
      return runContentLifecycle(
        input,
        () => options.contentLifecycle.restoreReconciled(input),
        (result) => result.snapshot.document,
      )
    })
  ))

  options.ipc.handle(CANVAS_IPC_CHANNELS.CREATE_AGENT_NODE, (event, value) => (
    invokeCanvasOperation<CanvasAgentNodeCreationResult>('create', async () => {
      assertAuthorizedSender(event, options)
      /** 创建请求只接受节点、位置和可选扩展关系公开字段。 */
      const input = parseCreateAgentNodeInput(value)
      requireWritableProject(input.projectId, options)
      /** 创建服务内部不加锁，整个事务只持有这一份 workspace write lease。 */
      return runCanvasExclusive(input.projectId, input.canvasId, async () => {
        /** 创建结果保留对账发布事实，内部 intent 不跨 IPC。 */
        const outcome = await options.guard.runWorkspaceWrite(
          input.projectId,
          () => options.creation.createReconciled(input),
        )
        publishReconciliation(options, input, outcome.reconciliation)
        if (!outcome.operationOutcome.ok) {
          if (outcome.operationOutcome.publication) {
            broadcastChange(options, {
              projectId: input.projectId,
              canvasId: input.canvasId,
              revision: outcome.operationOutcome.publication.revision,
              cause: 'graph',
            })
          }
          throw outcome.operationOutcome.error
        }
        /** 成功结果只公开文档与新会话最小元数据。 */
        const result = outcome.operationOutcome.value
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
    })
  ))

  options.ipc.handle(CANVAS_IPC_CHANNELS.REBUILD_AGENT_NODE, (event, value) => (
    invokeCanvasOperation<RebuildCanvasAgentNodeResult>('rebuild', async () => {
      assertAuthorizedSender(event, options)
      /** 重建请求不接受 Renderer 传入旧、新 session 身份。 */
      const input = parseRebuildAgentNodeInput(value)
      requireWritableProject(input.projectId, options)
      /** 重建与同 Canvas 的 LOAD/SAVE/CREATE 共用串行键，避免节点换绑竞态。 */
      return runCanvasExclusive(input.projectId, input.canvasId, async () => {
        /** 先对账并检查旧 session 运行态，再进入可恢复重建事务。 */
        const outcome = await options.guard.runWorkspaceWrite(
          input.projectId,
          async (): Promise<ReconciledOperationOutcome<Awaited<ReturnType<CanvasAgentNodeCreationService['rebuildReconciled']>>>> => {
            /** 首次对账提供当前节点和旧 session 的权威事实。 */
            const reconciliation = await options.creation.reconcile({
              projectId: input.projectId,
              canvasId: input.canvasId,
            })
            if (reconciliation.error) {
              return { ok: false, error: reconciliation.error, reconciliation }
            }
            try {
              /** 重建只允许目标仍是 Agent 节点，服务层还会再次做纵深校验。 */
              const node = reconciliation.snapshot.document.nodes.find((candidate): candidate is CanvasAgentNode => (
                candidate.kind === 'agent' && candidate.id === input.nodeId
              ))
              if (!node) throw new Error('Canvas Agent 重建目标不存在')
              if (isCanvasAgentNodeBusy(
                options.agent.listActiveRuns(),
                node.id,
                node.agentSessionId,
              )) {
                throw new CanvasPublicFailure(
                  'AGENT_SESSION_BUSY',
                  '请先停止 Agent，再重建会话。',
                )
              }
              /** 服务在同一 lease 内完成 prepared 到 committed 的可恢复事务。 */
              const result = await options.creation.rebuildReconciled(input)
              return { ok: true, value: result, reconciliation }
            } catch (error) {
              return { ok: false, error, reconciliation }
            }
          },
        )
        if (!outcome.ok) {
          publishReconciliation(options, input, outcome.reconciliation)
          throw outcome.error
        }
        /** 成功时按最终快照发布，recovery 仍优先于普通 graph 事件。 */
        publishReconciliation(options, input, {
          snapshot: outcome.value.snapshot,
          documentChanged: outcome.value.documentChanged,
        })
        return { snapshot: outcome.value.snapshot, session: outcome.value.session }
      })
    })
  ))

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
