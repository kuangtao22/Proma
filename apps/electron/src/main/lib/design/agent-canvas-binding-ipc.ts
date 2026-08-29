import {
  CANVAS_IPC_CHANNELS,
  parseAgentCanvasBindingChangeEvent,
  parseClearAgentCanvasBindingsInput,
  parseClearAgentCanvasBindingsResult,
  parseLinkAgentCanvasInput,
  parseLinkAgentCanvasResult,
  parseListAgentCanvasBindingsInput,
  parseListAgentCanvasBindingsResult,
  parseSetDefaultAgentCanvasInput,
  parseSetDefaultAgentCanvasResult,
  parseUnlinkAgentCanvasInput,
  parseUnlinkAgentCanvasResult,
} from '@proma/shared'
import type {
  AgentCanvasBinding,
  AgentCanvasBindingChangeEvent,
  AgentSessionMeta,
  CanvasInvokeResult,
  CanvasPublicError,
  CanvasSessionMeta,
} from '@proma/shared'
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { isAgentSessionUserVisible, requireUserVisibleAgentSession } from '../agent-session-visibility'
import type { AgentCanvasBindingStore } from './agent-canvas-binding-store'

/** Agent-Canvas 关联 IPC handler 的最小签名。 */
type AgentCanvasBindingIpcHandler = (event: IpcMainInvokeEvent, input?: unknown) => unknown

/** 可替换、可清理的主进程 IPC 注册边界。 */
export interface AgentCanvasBindingIpcRegistrar {
  handle: (channel: string, handler: AgentCanvasBindingIpcHandler) => void
  removeHandler: (channel: string) => void
}

/** 注册 Agent-Canvas 关联 IPC 所需的窄依赖。 */
export interface RegisterAgentCanvasBindingIpcOptions {
  ipcMain: AgentCanvasBindingIpcRegistrar
  store: Pick<AgentCanvasBindingStore,
    | 'listByProject'
    | 'linkWithChange'
    | 'unlinkWithChange'
    | 'setDefaultWithChange'
    | 'clearSessionWithChanges'
    | 'clearCanvasWithChanges'
    | 'reconcileProject'>
  getAgentSession: (sessionId: string) => AgentSessionMeta | null | undefined
  /** 纯读列出已有 Canvas 索引，不得隐式投影 legacy 会话。 */
  listCanvasSessions: (projectId: string) => CanvasSessionMeta[]
  /** 只在项目写守卫内幂等投影 legacy 会话。 */
  ensureLegacyCanvasSession: (projectId: string) => void
  /** 返回项目当前只读原因；存在时禁止关联持久化 mutation。 */
  getProjectReadOnlyReason: (projectId: string) => string | undefined
  /** 在项目迁移写守卫与 lease 内执行完整 mutation。 */
  runProjectMutation: <T>(projectId: string, effect: () => T) => T
  assertSenderProjectAccess: (
    sender: WebContents,
    projectId: string,
  ) => void | Promise<void>
  broadcast: (event: AgentCanvasBindingChangeEvent) => void
}

/** Agent-Canvas IPC 注册结果，供热重载和测试幂等释放。 */
export interface AgentCanvasBindingIpcRegistration {
  channels: string[]
  dispose: () => void
}

/** 关联列表读取失败时的固定公开错误。 */
const LIST_FAILURE: CanvasPublicError = {
  code: 'CANVAS_BINDING_LIST_FAILED',
  message: '画布关联列表暂时无法加载。',
}

/** 关联写入失败时的固定公开错误。 */
const MUTATION_FAILURE: CanvasPublicError = {
  code: 'CANVAS_BINDING_FAILED',
  message: '画布关联失败，请重试。',
}

/** 捕获内部错误并只返回固定公开信封。 */
async function invokeSafely<T>(
  fallback: CanvasPublicError,
  run: () => Promise<T>,
): Promise<CanvasInvokeResult<T>> {
  try {
    return { ok: true, value: await run() }
  } catch (error) {
    console.error('[Agent-Canvas 关联] IPC 操作失败')
    return { ok: false, error: { ...fallback } }
  }
}

/** 要求普通可见顶层 Agent 精确属于目标项目。 */
function requireProjectAgent(
  sessionId: string,
  projectId: string,
  options: RegisterAgentCanvasBindingIpcOptions,
): AgentSessionMeta {
  const session = requireUserVisibleAgentSession(options.getAgentSession(sessionId) ?? undefined)
  if (!isEligibleProjectAgent(session, projectId)) throw new Error('Agent 会话不是目标项目普通顶层会话')
  return session
}

/** 判断会话是否为目标项目可持有关联的普通顶层 Agent。 */
function isEligibleProjectAgent(session: AgentSessionMeta, projectId: string): boolean {
  return isAgentSessionUserVisible(session)
    && session.workspaceId === projectId
    && session.sourceAutomationId === undefined
    && session.parentSessionId === undefined
    && session.rootSessionId === undefined
    && session.sourceDelegationId === undefined
    && session.delegationRole === undefined
    && session.delegationStatus === undefined
    && session.delegationDepth === undefined
    && session.delegationGoal === undefined
}

/** 清理关联及广播所需的最小生命周期依赖。 */
export interface AgentCanvasBindingCleanupOptions {
  store: Pick<AgentCanvasBindingStore, 'clearSessionWithChanges' | 'clearCanvasWithChanges'>
  broadcast: (event: AgentCanvasBindingChangeEvent) => void
  /** 删除后清理同样必须进入项目写守卫。 */
  runProjectMutation: <T>(projectId: string, effect: () => T) => T
}

/** 广播失败只记录固定类别，已提交关联事实不得回滚或报错。 */
function broadcastChangeSafely(
  options: Pick<AgentCanvasBindingCleanupOptions, 'broadcast'>,
  event: AgentCanvasBindingChangeEvent,
): void {
  try {
    options.broadcast(parseAgentCanvasBindingChangeEvent(event))
  } catch {
    console.error('[Agent-Canvas 关联] 变化广播失败')
  }
}

/** 对单个 session 或 canvas 广播 Store 同快照返回的已提交变化。 */
export function clearAgentCanvasBindingsWithEvents(
  options: AgentCanvasBindingCleanupOptions,
  input: { projectId: string; target: 'session'; sessionId: string }
    | { projectId: string; target: 'canvas'; canvasId: string },
): void {
  const changes = input.target === 'session'
    ? options.store.clearSessionWithChanges(input.projectId, input.sessionId)
    : options.store.clearCanvasWithChanges(input.projectId, input.canvasId)
  for (const change of changes) {
    broadcastChangeSafely(options, {
      projectId: input.projectId,
      ...change,
    })
  }
}

/** 普通 Agent 删除成功后的 best-effort 关联清理，内部会话保持不变。 */
export function cleanupDeletedAgentSessionCanvasBindings(
  options: AgentCanvasBindingCleanupOptions,
  session: AgentSessionMeta,
): void {
  if (!session.workspaceId || !isEligibleProjectAgent(session, session.workspaceId)) return
  try {
    const clear = (): void => clearAgentCanvasBindingsWithEvents(options, {
      projectId: session.workspaceId!, target: 'session', sessionId: session.id,
    })
    options.runProjectMutation(session.workspaceId, clear)
  } catch {
    console.error('[Agent-Canvas 关联] Agent 删除后的关联清理失败')
  }
}

/** Canvas 删除成功后的 best-effort 关联清理，不影响主删除结果与事件。 */
export function cleanupDeletedCanvasBindings(
  options: AgentCanvasBindingCleanupOptions,
  projectId: string,
  canvasId: string,
): void {
  try {
    const clear = (): void => clearAgentCanvasBindingsWithEvents(
      options, { projectId, target: 'canvas', canvasId },
    )
    options.runProjectMutation(projectId, clear)
  } catch {
    console.error('[Agent-Canvas 关联] Canvas 删除后的关联清理失败')
  }
}

/** 在任何持久化 mutation 前统一拒绝只读项目。 */
function requireWritableProject(
  projectId: string,
  options: RegisterAgentCanvasBindingIpcOptions,
): void {
  const reason = options.getProjectReadOnlyReason(projectId)
  if (reason) throw new Error(reason)
}

/** 要求 Canvas 存在于目标项目公开索引；legacy-design 同样有效。 */
function requireProjectCanvas(
  canvasId: string,
  projectId: string,
  options: RegisterAgentCanvasBindingIpcOptions,
): CanvasSessionMeta {
  const canvas = options.listCanvasSessions(projectId).find((candidate) => (
    candidate.id === canvasId && candidate.projectId === projectId
  ))
  if (!canvas) throw new Error('Canvas 会话不存在')
  return canvas
}

/** 解析并广播一条严格公开关联变化事件。 */
function broadcastChange(
  options: RegisterAgentCanvasBindingIpcOptions,
  event: AgentCanvasBindingChangeEvent,
): void {
  broadcastChangeSafely(options, event)
}

/** LIST 前按实时 Agent/Canvas 权威事实移除陈旧关联。 */
export function reconcileAgentCanvasBindings(
  projectId: string,
  options: RegisterAgentCanvasBindingIpcOptions,
): AgentCanvasBinding[] {
  const canvasIds = new Set(
    options.listCanvasSessions(projectId)
      .filter((canvas) => canvas.projectId === projectId)
      .map((canvas) => canvas.id),
  )
  const result = options.store.reconcileProject(
    projectId,
    (sessionId) => {
      const session = options.getAgentSession(sessionId)
      return Boolean(session && isEligibleProjectAgent(session, projectId))
    },
    (canvasId) => canvasIds.has(canvasId),
  )
  const reconciled = parseListAgentCanvasBindingsResult(result.bindings)
  /** Store 已使用本轮会话与画布有效性快照完成 CAS，提交后不得再次读取并阻断事件。 */
  for (const change of result.changes) {
    broadcastChangeSafely(options, { projectId, ...change })
  }
  return reconciled
}

/** 只读项目返回实时过滤视图，但不修改磁盘或投影 legacy 索引。 */
function listValidAgentCanvasBindingsReadOnly(
  projectId: string,
  options: RegisterAgentCanvasBindingIpcOptions,
): AgentCanvasBinding[] {
  const canvasIds = new Set(options.listCanvasSessions(projectId).map((canvas) => canvas.id))
  return parseListAgentCanvasBindingsResult(options.store.listByProject(projectId)).flatMap((binding) => {
    const session = options.getAgentSession(binding.sessionId)
    if (!session || !isEligibleProjectAgent(session, projectId)) return []
    const linkedCanvasIds = binding.linkedCanvasIds.filter((canvasId) => canvasIds.has(canvasId))
    if (linkedCanvasIds.length === 0) return []
    const defaultCanvasId = linkedCanvasIds.includes(binding.defaultCanvasId ?? '')
      ? binding.defaultCanvasId
      : linkedCanvasIds[0]
    const lastActiveCanvasId = linkedCanvasIds.includes(binding.lastActiveCanvasId ?? '')
      ? binding.lastActiveCanvasId
      : defaultCanvasId
    return [{ ...binding, defaultCanvasId, linkedCanvasIds, lastActiveCanvasId }]
  })
}

/** 注册五个 Agent-Canvas invoke handler。 */
export function registerAgentCanvasBindingIpcHandlers(
  options: RegisterAgentCanvasBindingIpcOptions,
): AgentCanvasBindingIpcRegistration {
  const channels = [
    CANVAS_IPC_CHANNELS.LIST_AGENT_BINDINGS,
    CANVAS_IPC_CHANNELS.LINK_AGENT_CANVAS,
    CANVAS_IPC_CHANNELS.UNLINK_AGENT_CANVAS,
    CANVAS_IPC_CHANNELS.SET_DEFAULT_AGENT_CANVAS,
    CANVAS_IPC_CHANNELS.CLEAR_AGENT_BINDINGS,
  ]
  for (const channel of channels) options.ipcMain.removeHandler(channel)

  options.ipcMain.handle(CANVAS_IPC_CHANNELS.LIST_AGENT_BINDINGS, (event, value) => invokeSafely(
    LIST_FAILURE,
    async () => {
      const input = parseListAgentCanvasBindingsInput(value)
      await options.assertSenderProjectAccess(event.sender, input.projectId)
      if (options.getProjectReadOnlyReason(input.projectId)) {
        return listValidAgentCanvasBindingsReadOnly(input.projectId, options)
      }
      return options.runProjectMutation(input.projectId, () => {
        options.ensureLegacyCanvasSession(input.projectId)
        return reconcileAgentCanvasBindings(input.projectId, options)
      })
    },
  ))

  options.ipcMain.handle(CANVAS_IPC_CHANNELS.LINK_AGENT_CANVAS, (event, value) => invokeSafely(
    MUTATION_FAILURE,
    async () => {
      const input = parseLinkAgentCanvasInput(value)
      await options.assertSenderProjectAccess(event.sender, input.projectId)
      requireWritableProject(input.projectId, options)
      const mutation = options.runProjectMutation(input.projectId, () => {
        options.ensureLegacyCanvasSession(input.projectId)
        requireProjectAgent(input.sessionId, input.projectId, options)
        requireProjectCanvas(input.canvasId, input.projectId, options)
        return options.store.linkWithChange(input)
      })
      const binding = parseLinkAgentCanvasResult(mutation.after)
      if (mutation.changed) {
        broadcastChange(options, { projectId: input.projectId, sessionId: input.sessionId, cause: 'linked', binding })
      }
      return binding
    },
  ))

  options.ipcMain.handle(CANVAS_IPC_CHANNELS.UNLINK_AGENT_CANVAS, (event, value) => invokeSafely(
    MUTATION_FAILURE,
    async () => {
      const input = parseUnlinkAgentCanvasInput(value)
      await options.assertSenderProjectAccess(event.sender, input.projectId)
      requireWritableProject(input.projectId, options)
      const mutation = options.runProjectMutation(input.projectId, () => {
        options.ensureLegacyCanvasSession(input.projectId)
        requireProjectAgent(input.sessionId, input.projectId, options)
        requireProjectCanvas(input.canvasId, input.projectId, options)
        return options.store.unlinkWithChange(input)
      })
      const binding = parseUnlinkAgentCanvasResult(mutation.after)
      if (mutation.changed) {
        broadcastChange(options, { projectId: input.projectId, sessionId: input.sessionId, cause: 'unlinked', binding })
      }
      return binding
    },
  ))

  options.ipcMain.handle(CANVAS_IPC_CHANNELS.SET_DEFAULT_AGENT_CANVAS, (event, value) => invokeSafely(
    MUTATION_FAILURE,
    async () => {
      const input = parseSetDefaultAgentCanvasInput(value)
      await options.assertSenderProjectAccess(event.sender, input.projectId)
      requireWritableProject(input.projectId, options)
      const mutation = options.runProjectMutation(input.projectId, () => {
        options.ensureLegacyCanvasSession(input.projectId)
        requireProjectAgent(input.sessionId, input.projectId, options)
        requireProjectCanvas(input.canvasId, input.projectId, options)
        return options.store.setDefaultWithChange(input)
      })
      const binding = parseSetDefaultAgentCanvasResult(mutation.after)
      if (mutation.changed) {
        broadcastChange(options, { projectId: input.projectId, sessionId: input.sessionId, cause: 'default-changed', binding })
      }
      return binding
    },
  ))

  options.ipcMain.handle(CANVAS_IPC_CHANNELS.CLEAR_AGENT_BINDINGS, (event, value) => invokeSafely(
    MUTATION_FAILURE,
    async () => {
      const input = parseClearAgentCanvasBindingsInput(value)
      await options.assertSenderProjectAccess(event.sender, input.projectId)
      requireWritableProject(input.projectId, options)
      options.runProjectMutation(input.projectId, () => {
        options.ensureLegacyCanvasSession(input.projectId)
        if (input.target === 'session') {
          requireProjectAgent(input.sessionId, input.projectId, options)
        } else {
          requireProjectCanvas(input.canvasId, input.projectId, options)
        }
        clearAgentCanvasBindingsWithEvents(options, input)
      })
      return parseClearAgentCanvasBindingsResult(undefined)
    },
  ))

  let disposed = false
  return {
    channels: [...channels],
    dispose: () => {
      if (disposed) return
      disposed = true
      for (const channel of channels) options.ipcMain.removeHandler(channel)
    },
  }
}
