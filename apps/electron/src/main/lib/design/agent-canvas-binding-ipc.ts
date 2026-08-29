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
  store: Pick<AgentCanvasBindingStore, 'listByProject' | 'link' | 'unlink' | 'setDefault' | 'clearSession' | 'clearCanvas'>
  getAgentSession: (sessionId: string) => AgentSessionMeta | null | undefined
  listCanvasSessions: (projectId: string) => CanvasSessionMeta[]
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
  store: Pick<AgentCanvasBindingStore, 'listByProject' | 'clearSession' | 'clearCanvas'>
  broadcast: (event: AgentCanvasBindingChangeEvent) => void
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

/** 对单个 session 或 canvas 执行前后差异清理并广播精确受影响身份。 */
export function clearAgentCanvasBindingsWithEvents(
  options: AgentCanvasBindingCleanupOptions,
  input: { projectId: string; target: 'session'; sessionId: string }
    | { projectId: string; target: 'canvas'; canvasId: string },
): void {
  const before = parseListAgentCanvasBindingsResult(options.store.listByProject(input.projectId))
  if (input.target === 'session') options.store.clearSession(input.projectId, input.sessionId)
  else options.store.clearCanvas(input.projectId, input.canvasId)
  const afterBySession = new Map(
    parseListAgentCanvasBindingsResult(options.store.listByProject(input.projectId))
      .map((binding) => [binding.sessionId, binding]),
  )
  for (const previous of before) {
    const current = afterBySession.get(previous.sessionId) ?? null
    if (current && bindingsEqual(previous, current)) continue
    broadcastChangeSafely(options, {
      projectId: input.projectId,
      sessionId: previous.sessionId,
      cause: input.target === 'session' ? 'session-cleared' : 'canvas-cleared',
      binding: current,
    })
  }
}

/** 普通 Agent 删除成功后的 best-effort 关联清理，内部会话保持不变。 */
export function cleanupDeletedAgentSessionCanvasBindings(
  options: AgentCanvasBindingCleanupOptions,
  session: AgentSessionMeta,
): boolean {
  if (!session.workspaceId || !isEligibleProjectAgent(session, session.workspaceId)) return false
  try {
    clearAgentCanvasBindingsWithEvents(options, {
      projectId: session.workspaceId,
      target: 'session',
      sessionId: session.id,
    })
  } catch {
    console.error('[Agent-Canvas 关联] Agent 删除后的关联清理失败')
  }
  return true
}

/** Canvas 删除成功后的 best-effort 关联清理，不影响主删除结果与事件。 */
export function cleanupDeletedCanvasBindings(
  options: AgentCanvasBindingCleanupOptions,
  projectId: string,
  canvasId: string,
): void {
  try {
    clearAgentCanvasBindingsWithEvents(options, { projectId, target: 'canvas', canvasId })
  } catch {
    console.error('[Agent-Canvas 关联] Canvas 删除后的关联清理失败')
  }
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

/** 比较可空关联事实，供幂等写操作抑制伪变化事件。 */
function nullableBindingsEqual(
  left: AgentCanvasBinding | null,
  right: AgentCanvasBinding | null,
): boolean {
  if (left === null || right === null) return left === right
  return bindingsEqual(left, right)
}

/** 判断清理前后记录是否发生公开业务变化。 */
function bindingsEqual(left: AgentCanvasBinding, right: AgentCanvasBinding): boolean {
  return left.projectId === right.projectId
    && left.sessionId === right.sessionId
    && left.defaultCanvasId === right.defaultCanvasId
    && left.lastActiveCanvasId === right.lastActiveCanvasId
    && left.updatedAt === right.updatedAt
    && left.linkedCanvasIds.length === right.linkedCanvasIds.length
    && left.linkedCanvasIds.every((canvasId, index) => canvasId === right.linkedCanvasIds[index])
}

/** LIST 前按实时 Agent/Canvas 权威事实移除陈旧关联。 */
export function reconcileAgentCanvasBindings(
  projectId: string,
  options: RegisterAgentCanvasBindingIpcOptions,
): AgentCanvasBinding[] {
  const bindings = parseListAgentCanvasBindingsResult(options.store.listByProject(projectId))
  const canvasIds = new Set(
    options.listCanvasSessions(projectId)
      .filter((canvas) => canvas.projectId === projectId)
      .map((canvas) => canvas.id),
  )
  for (const binding of bindings) {
    const session = options.getAgentSession(binding.sessionId)
    if (session && isEligibleProjectAgent(session, projectId)) continue
    clearAgentCanvasBindingsWithEvents(options, {
      projectId,
      target: 'session',
      sessionId: binding.sessionId,
    })
  }
  const invalidCanvasIds = new Set<string>()
  for (const binding of parseListAgentCanvasBindingsResult(options.store.listByProject(projectId))) {
    for (const canvasId of binding.linkedCanvasIds) {
      if (!canvasIds.has(canvasId)) invalidCanvasIds.add(canvasId)
    }
  }
  for (const canvasId of invalidCanvasIds) {
    clearAgentCanvasBindingsWithEvents(options, { projectId, target: 'canvas', canvasId })
  }
  const reconciled = parseListAgentCanvasBindingsResult(options.store.listByProject(projectId))
  if (!reconciled.every((binding) => {
    const session = options.getAgentSession(binding.sessionId)
    return Boolean(session
      && isEligibleProjectAgent(session, projectId)
      && binding.linkedCanvasIds.every((canvasId) => canvasIds.has(canvasId)))
  })) throw new Error('AGENT_CANVAS_BINDINGS_RECONCILE_INCOMPLETE')
  return reconciled
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
      return reconcileAgentCanvasBindings(input.projectId, options)
    },
  ))

  options.ipcMain.handle(CANVAS_IPC_CHANNELS.LINK_AGENT_CANVAS, (event, value) => invokeSafely(
    MUTATION_FAILURE,
    async () => {
      const input = parseLinkAgentCanvasInput(value)
      await options.assertSenderProjectAccess(event.sender, input.projectId)
      requireProjectAgent(input.sessionId, input.projectId, options)
      requireProjectCanvas(input.canvasId, input.projectId, options)
      const before = options.store.listByProject(input.projectId).find(
        (binding) => binding.sessionId === input.sessionId,
      ) ?? null
      const binding = parseLinkAgentCanvasResult(options.store.link(input))
      if (!nullableBindingsEqual(before, binding)) {
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
      requireProjectAgent(input.sessionId, input.projectId, options)
      requireProjectCanvas(input.canvasId, input.projectId, options)
      const before = options.store.listByProject(input.projectId).find(
        (binding) => binding.sessionId === input.sessionId,
      ) ?? null
      const binding = parseUnlinkAgentCanvasResult(options.store.unlink(input))
      if (!nullableBindingsEqual(before, binding)) {
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
      requireProjectAgent(input.sessionId, input.projectId, options)
      requireProjectCanvas(input.canvasId, input.projectId, options)
      const before = options.store.listByProject(input.projectId).find(
        (binding) => binding.sessionId === input.sessionId,
      ) ?? null
      const binding = parseSetDefaultAgentCanvasResult(options.store.setDefault(input))
      if (!nullableBindingsEqual(before, binding)) {
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
      if (input.target === 'session') {
        requireProjectAgent(input.sessionId, input.projectId, options)
      } else {
        requireProjectCanvas(input.canvasId, input.projectId, options)
      }
      clearAgentCanvasBindingsWithEvents(options, input)
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
