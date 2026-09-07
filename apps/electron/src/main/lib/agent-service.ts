/**
 * Agent 服务层（IPC 薄层）
 *
 * 职责：
 * - 创建 AgentOrchestrator / EventBus / Adapter 实例
 * - 注册 EventBus IPC 转发中间件（webContents.send）
 * - 导出 IPC handler 调用的薄包装函数
 * - 文件操作（saveFilesToAgentSession）
 *
 * 所有业务逻辑已委托给 AgentOrchestrator。
 */

import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { mkdir as mkdirAsync, writeFile as writeFileAsync } from 'node:fs/promises'
import { BrowserWindow } from 'electron'
import type { WebContents } from 'electron'
import { AGENT_IPC_CHANNELS, MAX_ATTACHMENT_SIZE } from '@proma/shared'
import type {
  AgentSendInput,
  AgentGenerateTitleInput,
  AgentSaveFilesInput,
  AgentSaveWorkspaceFilesInput,
  AgentSavedFile,
  AgentStreamEvent,
  AgentStreamPayload,
  AgentQueueMessageInput,
  AgentDeferredQueueMessageInput,
  AgentSubmitOrEnqueueInput,
  AgentSubmitOrEnqueueResult,
  AgentQueuedMessageControlInput,
  AgentMoveQueuedMessageInput,
  PromaPermissionMode,
  AgentExternalRunSource,
  AgentActiveSessionSnapshot,
  AgentQueuedMessageSnapshot,
  AgentMessage,
  CanvasAgentActiveRunSnapshot,
} from '@proma/shared'

/** Agent service 内部运行输入，允许主进程携带不对外暴露的运行代际。 */
type AgentRunInput = AgentSendInput & { runGeneration?: number }

/** 主进程内部消费者使用的 Renderer Agent 精确终态，不进入公开 IPC。 */
export interface AgentRunTerminalObservation {
  status: 'completed' | 'errored' | 'cancelled'
  sessionId: string
  startedAt?: number
  runGeneration?: number
}

/** 内部终态观察器；异常由 Agent service 副作用边界隔离。 */
export type AgentRunTerminalObserver = (observation: AgentRunTerminalObservation) => void
import { PiAgentAdapter } from './adapters/pi-agent-adapter'
import { PiUtilityAdapter } from './adapters/pi-utility-adapter'
import { AgentEventBus } from './agent-event-bus'
import { AgentOrchestrator } from './agent-orchestrator'
import { getAgentSessionWorkspacePath } from './config-paths'
import {
  getAgentWorkspace,
  getAgentWorkspaceBySlug,
  getLocalProjectRootStatus,
  getProjectFilesPath,
  getWorkspaceAttachedDirectories,
  getWorkspaceAttachedFiles,
} from './agent-workspace-manager'
import { getAgentSessionMeta, listAgentSessions, updateAgentSessionMeta } from './agent-session-manager'
import { buildCanvasAgentActiveRunSnapshot, isEligibleProjectAgent } from './agent-session-visibility'
import {
  resolveHeadlessAgentRunTerminalStatus,
  setAgentStopper,
  setHeadlessAgentRunner,
} from './agent-headless-runner-registry'
import type { HeadlessAgentRunCallbacks, HeadlessAgentRunTerminalOptions } from './agent-headless-runner-registry'
import { getHeadlessAgentRunTarget } from './agent-headless-run-target'
import { normalizeHeadlessAgentRunInput } from './agent-headless-run-source'
import {
  buildAuthoritativeAgentRunStartedEvent,
  buildAuthoritativeAgentStreamErrorPayload,
  sendAuthoritativeAgentStreamComplete,
} from './agent-completion-payload'
import { AgentStreamForwarder } from './agent-stream-forwarder'
import { AgentStreamRouteRegistry } from './agent-stream-route-registry'
import type { AgentStreamRoute } from './agent-stream-route-registry'
import { AgentQueueCoordinator } from './agent-queue-coordinator'
import { getWorkspaceOperationBlockReason } from './workspace-operation-lock'
import { createWorkspaceOperationGuard } from './workspace-operation-guard'
import { runAgentServiceTerminalEffects } from './agent-run-lifecycle'
import type { AgentRunExtensions } from './agent-run-extensions'
import { routeAgentSubmitOrEnqueue } from './agent-queue-routing'
import { shouldStopBeforeAgentRun } from './agent-stop-policy'
import {
  createAgentQueueNowInput,
  prepareAgentCanvasMessageForSend,
  type PreparedAgentCanvasMessage,
} from './agent-canvas-message-preparation'
import {
  CanvasReferenceInvalidError,
  type CanvasNodeReferenceResolver,
} from './design/canvas-node-reference-resolver'
import { getCanvasToolProviderRuntime } from './design/canvas-document-ipc'
import { openAuthorizedAgentMediaSource } from './design/design-session-bridge'
import {
  prepareAgentMediaAttachmentsForSend,
  type AgentMediaAttachmentInput,
} from './agent-media-attachment-preparation'

/** 保持现有主进程调用方从 agent-service 导入运行扩展类型的兼容性。 */
export type { AgentRunExtensions } from './agent-run-extensions'

/** 使用主进程权威会话和项目根固化显式图片、音频和视频附件。 */
function prepareAgentMediaInput<T extends AgentMediaAttachmentInput>(input: T): T {
  if (!Object.prototype.hasOwnProperty.call(input, 'mediaAttachments')) return input
  return workspaceOperationGuard.runSessionWrite(input.sessionId, () => prepareAgentMediaAttachmentsForSend(input, {
    getSession: getAgentSessionMeta,
    getWorkspace: getAgentWorkspace,
    getAllowedRoots: (session, workspace) => [
      getAgentSessionWorkspacePath(workspace.slug, session.id),
      getProjectFilesPath(workspace.slug),
      ...(session.activeWorktree?.path ? [session.activeWorktree.path] : []),
      ...(session.attachedDirectories ?? []),
      ...(session.attachedFiles ?? []),
      ...getWorkspaceAttachedDirectories(workspace.slug),
      ...getWorkspaceAttachedFiles(workspace.slug),
    ],
    getSessionAttachmentsDirectory: (session, workspace) => (
      join(getAgentSessionWorkspacePath(workspace.slug, session.id), 'attachments')
    ),
    openSource: ({ inputPath, allowedRoots, maxBytes }) => openAuthorizedAgentMediaSource({
      inputPath,
      baseDir: process.cwd(),
      allowedRoots,
      maxBytes,
      label: '媒体',
    }),
  }))
}

// ===== 实例创建 =====

const eventBus = new AgentEventBus()
const useUtilityAgentRuntime = process.env.PROMA_AGENT_RUNTIME !== 'in-process'
  && process.env.PROMA_AGENT_RUNTIME !== 'off'
const adapter = useUtilityAgentRuntime ? new PiUtilityAdapter() : new PiAgentAdapter()
const orchestrator = new AgentOrchestrator(adapter, eventBus)
/** IPC runtime 尚未注册时，非空 Canvas 引用必须 fail closed，禁止临时重建 Store。 */
const unavailableCanvasReferenceResolver: CanvasNodeReferenceResolver = {
  resolveForSend: () => { throw new CanvasReferenceInvalidError(new Error('CANVAS_RUNTIME_UNAVAILABLE')) },
}

/** 单次发送前解析引用，并把轻量摘要固化进准备结果。 */
export function prepareAgentRun<T extends AgentSendInput | AgentQueueMessageInput>(
  input: T,
  extensions: AgentRunExtensions = {},
  dialogOwnerWebContentsId?: number,
): PreparedAgentCanvasMessage<T> {
  /** 媒体授权先于 Canvas 与运行准备完成，后续阶段只使用会话内固化路径。 */
  const mediaPreparedInput = prepareAgentMediaInput(input)
  /** runtime 同时提供唯一引用解析器和工具 facade；缺失时仅允许无引用消息继续。 */
  const runtime = getCanvasToolProviderRuntime()
  /** 显式分支便于审计生产 resolver 来源，禁止隐藏回退 Store。 */
  const referenceResolver = runtime
    ? runtime.referenceResolver
    : unavailableCanvasReferenceResolver
  /** 引用先完成权威解析，工具上下文只能使用解析后的快照。 */
  const prepared = prepareAgentCanvasMessageForSend(
    mediaPreparedInput,
    extensions,
    referenceResolver,
  )
  const sessionMeta = getAgentSessionMeta(input.sessionId)
  const isInteractiveUserRun = !('triggeredBy' in input)
    || input.triggeredBy === undefined
    || input.triggeredBy === 'user'
  if (!runtime
    || !sessionMeta?.workspaceId
    || !isEligibleProjectAgent(sessionMeta, sessionMeta.workspaceId)
    || !isInteractiveUserRun) return prepared
  const canvasRun = runtime.createRun({
    projectId: sessionMeta.workspaceId,
    sessionId: input.sessionId,
    runStartedAt: 'startedAt' in input && input.startedAt != null ? input.startedAt : Date.now(),
    explicitReferences: prepared.references ?? [],
    permissionCeiling:
      ((prepared.input as AgentSendInput).permissionModeOverride ?? sessionMeta.permissionMode) === 'plan'
        ? 'plan'
        : 'execute',
    ...(dialogOwnerWebContentsId !== undefined ? { dialogOwnerWebContentsId } : {}),
  })
  return {
    ...prepared,
    extensions: {
      ...prepared.extensions,
      systemPromptAppend: [prepared.extensions.systemPromptAppend, canvasRun.systemPromptAppend]
        .filter((section): section is string => Boolean(section?.trim()))
        .join('\n\n'),
      piCustomTools: [...(prepared.extensions.piCustomTools ?? []), ...canvasRun.piCustomTools],
      allowedToolNames: [...(prepared.extensions.allowedToolNames ?? []), ...canvasRun.allowedToolNames],
      singleApprovalToolNames: [
        ...(prepared.extensions.singleApprovalToolNames ?? []),
        ...canvasRun.singleApprovalToolNames,
      ],
      allowedToolNamesMode: canvasRun.allowedToolNamesMode,
    },
  }
}
/** Agent service 与队列写入口共享的工作区迁移守卫。 */
const workspaceOperationGuard = createWorkspaceOperationGuard({
  getWorkspaceIdBySessionId: (sessionId) => {
    const sessionMeta = getAgentSessionMeta(sessionId)
    return sessionMeta ? sessionMeta.workspaceId ?? null : undefined
  },
  getWorkspaceIdBySlug: () => undefined,
  getWorkspaceOperationBlockReason,
})

/** 导出 EventBus 供飞书 Bridge 等外部服务订阅事件 */
export { eventBus as agentEventBus }

// 注册协作子会话 EventBus 阻塞事件监听
import('./agent-collaboration-tools').then(({ registerCollaborationEventBus }) => {
  registerCollaborationEventBus(eventBus)
}).catch(() => { /* collaboration 模块可能未加载 */ })

/**
 * 会话 → renderer 的流事件投递路由。
 *
 * 每次 run 注册独立 owner；旧 run 只能清理自己仍拥有的 route，不能删除
 * 队列接力或 renderer 重载后被新 run 接管的投递目标。
 */
const streamRoutes = new AgentStreamRouteRegistry<WebContents>()
/** 每个 renderer 当前可见的 Agent 会话；仅该会话维持 20fps partial。 */
const visibleAgentSessionByWebContents = new WeakMap<WebContents, string | null>()
const streamForwarder = new AgentStreamForwarder()

/**
 * 已挂载 destroyed 回收钩子的 webContents 集合。
 *
 * 同一个主窗口 webContents 可能被多次注册（飞书 Bridge 每条消息触发一次 runAgentHeadless），
 * 用 WeakSet 去重避免 once listener 在同一 wc 上累积，触发 MaxListenersExceededWarning。
 */
const wcWithCleanupHook = new WeakSet<WebContents>()

/**
 * 注册新的 stream route，并在 webContents 销毁时保留 owner 以等待 renderer 重绑或 run 收束。
 */
function attachWebContentsCleanup(wc: WebContents): void {
  if (wcWithCleanupHook.has(wc)) return
  wcWithCleanupHook.add(wc)
  wc.once('destroyed', () => {
    // 保留 route owner 到活跃 run 收束，允许新 renderer 重绑；取消旧 wc 捕获的 partial。
    for (const sessionIdToClear of streamRoutes.markTargetDestroyed(wc)) {
      streamForwarder.clear(sessionIdToClear)
    }
    visibleAgentSessionByWebContents.delete(wc)
  })
}

function registerWebContents(sessionId: string, wc: WebContents) {
  const previousWebContents = streamRoutes.get(sessionId)?.target
  if (previousWebContents && previousWebContents !== wc) streamForwarder.clear(sessionId)
  const route = streamRoutes.bind(sessionId, wc)
  attachWebContentsCleanup(wc)
  return route
}

/**
 * 更新已有 run 的 renderer 目标，但绝不能取得新的 owner。
 *
 * 排队或中断消息不创建新 run；若它们调用 bind()，旧 run 的终态将因 owner
 * 不匹配而无法投递，renderer 会永久保留 running 状态。
 */
function rebindWebContents(sessionId: string, wc: WebContents) {
  const previousWebContents = streamRoutes.get(sessionId)?.target
  if (previousWebContents && previousWebContents !== wc) streamForwarder.clear(sessionId)
  const route = streamRoutes.rebind(sessionId, wc)
  attachWebContentsCleanup(wc)
  agentQueueCoordinator.onTargetAvailable(sessionId)
  return route
}

function getStreamRouteTargets(): Map<string, WebContents> {
  const targets = new Map<string, WebContents>()
  for (const snapshot of orchestrator.listActiveSessionSnapshots()) {
    const target = streamRoutes.get(snapshot.sessionId)?.target
    if (target) targets.set(snapshot.sessionId, target)
  }
  return targets
}

export function rebindActiveAgentStreams(webContents: WebContents): AgentActiveSessionSnapshot[] {
  const snapshots = orchestrator.listActiveSessionSnapshots()
  for (const snapshot of snapshots) {
    streamForwarder.clear(snapshot.sessionId)
    streamRoutes.rebind(snapshot.sessionId, webContents)
  }
  attachWebContentsCleanup(webContents)
  return snapshots
}

function isMainRendererWindow(win: BrowserWindow): boolean {
  if (win.isDestroyed()) return false
  const url = win.webContents.getURL()
  if (!url) return false
  if (url.startsWith('data:')) return false
  return !url.includes('window=quick-task')
    && !url.includes('window=voice-dictation')
    && !url.includes('window=detached-preview')
}

function getMainRendererWebContents(): WebContents | null {
  const win = BrowserWindow.getAllWindows().find(isMainRendererWindow)
  return win && !win.webContents.isDestroyed() ? win.webContents : null
}

const agentQueueCoordinator = new AgentQueueCoordinator({
  isActive: (sessionId) => orchestrator.isActive(sessionId),
  getWebContents: (sessionId) => streamRoutes.get(sessionId)?.target ?? getMainRendererWebContents(),
  prepareRun: (input) => prepareAgentRun(input),
  startRun: (prepared, webContents) => runPreparedAgent(prepared, webContents),
  sendStatus: (webContents, status) => {
    if (!webContents.isDestroyed()) webContents.send(AGENT_IPC_CHANNELS.QUEUED_MESSAGE_STATUS, status)
  },
  onPrepareError: (input, error) => {
    console.error(`[Agent Canvas 引用] deferred 消息解析失败: sessionId=${input.sessionId}`, error instanceof Error ? error.cause ?? error : error)
    return { code: 'CANVAS_REFERENCE_INVALID', message: '画布节点引用已失效，请重新选择后发送。' }
  },
})

/**
 * Renderer run 在创建飞书镜像卡片时尚未进入 orchestrator.activeSessions。
 * 在此期间保留启动槽位，避免会话迁移改变已接受请求的项目归属。
 */
const startingAgentSessions = new Map<string, number | undefined>()

/** 主进程内部稳定 busy 错误码，仅用于可信 IPC 边界分类。 */
const AGENT_SESSION_BUSY_ERROR_CODE = 'AGENT_SESSION_BUSY'

export function reserveAgentSessionStart(sessionId: string, startedAt?: number): () => void {
  if (startingAgentSessions.has(sessionId) || orchestrator.isActive(sessionId)) {
    /** 附加稳定内部码，避免 IPC 依赖可能变化的中文错误文案。 */
    const busyError = Object.assign(
      new Error('会话正在启动或运行中，请等待当前请求结束后再发送。'),
      { code: AGENT_SESSION_BUSY_ERROR_CODE },
    )
    throw busyError
  }
  startingAgentSessions.set(sessionId, startedAt)
  return () => startingAgentSessions.delete(sessionId)
}

export function isAgentSessionBusy(sessionId: string): boolean {
  return startingAgentSessions.has(sessionId)
    || orchestrator.isActive(sessionId)
    || agentQueueCoordinator.hasPending(sessionId)
}

/**
 * 一次性列出 Renderer reload 后仍需恢复归属的运行中 Canvas Agent。
 * @returns 不暴露路径、JSONL 或普通内部字段的安全快照。
 */
export function listActiveCanvasAgentRuns(): CanvasAgentActiveRunSnapshot {
  return buildCanvasAgentActiveRunSnapshot(
    listAgentSessions(),
    isAgentSessionBusy,
    (sessionId) => startingAgentSessions.get(sessionId),
  )
}

function publishRunStopped(
  sessionId: string,
  stoppedByUser: boolean | undefined,
  startedAt: number | undefined,
  runGeneration: number | undefined,
): void {
  if (!stoppedByUser) return
  eventBus.emit(sessionId, {
    kind: 'proma_event',
    event: {
      type: 'run_stopped',
      ...(startedAt != null ? { startedAt } : {}),
      ...(runGeneration != null ? { runGeneration } : {}),
    },
  })
}

/**
 * 发布供外部通知通道消费的运行完成事件。
 * @param sessionId 已完成运行所属的 Agent 会话 ID。
 * @param source 运行来源；普通桌面运行使用 desktop。
 * @param options 由 Orchestrator 提供的停止状态、启动时间与运行代次。
 * @returns 无返回值；事件通过进程内 AgentEventBus 分发。
 */
function publishRunCompleted(
  sessionId: string,
  source: AgentExternalRunSource | 'desktop',
  options: { stoppedByUser?: boolean; startedAt?: number; runGeneration?: number },
): void {
  eventBus.emit(sessionId, {
    kind: 'proma_event',
    event: {
      type: 'run_completed',
      source,
      stoppedByUser: options.stoppedByUser ?? false,
      ...(options.startedAt != null ? { startedAt: options.startedAt } : {}),
      ...(options.runGeneration != null ? { runGeneration: options.runGeneration } : {}),
    },
  })
}

/** 记录被隔离的 Agent service 终态副作用异常。 */
function reportAgentServiceTerminalEffectError(name: string, error: unknown): void {
  console.error(`[Agent 服务] 终态副作用执行失败: ${name}`, error)
}

// ===== EventBus IPC 转发中间件 =====

eventBus.use((sessionId, payload, next) => {
  const wc = streamRoutes.get(sessionId)?.target
  if (wc && !wc.isDestroyed()) {
    try {
      streamForwarder.forward(
        { sessionId, payload } as AgentStreamEvent,
        (event) => wc.send(AGENT_IPC_CHANNELS.STREAM_EVENT, event),
        visibleAgentSessionByWebContents.get(wc) === sessionId,
      )
    } catch (err) {
      console.error(`[EventBus] wc.send 失败: sessionId=${sessionId}, payload.kind=${(payload as Record<string, unknown>)?.kind}`, err)
    }
  }
  if (payload.kind === 'sdk_message' && payload.message.type === 'system' && payload.message.subtype === 'task_notification') {
    agentQueueCoordinator.onBackgroundTaskComplete(sessionId)
  }
  next()
})

/** renderer 切换标签时更新流式优先级；切入会话立即 flush 等待中的后台快照。 */
export function setVisibleAgentSession(webContents: WebContents, sessionId: string | null): void {
  rebindActiveAgentStreams(webContents)
  const previousSessionId = visibleAgentSessionByWebContents.get(webContents)
  if (previousSessionId && previousSessionId !== sessionId) {
    // 切出后将已排队的前台帧按后台频率重排，避免继续以 20fps 发送。
    streamForwarder.reprioritize(previousSessionId, false)
  }
  visibleAgentSessionByWebContents.set(webContents, sessionId)
  if (sessionId) streamForwarder.promote(sessionId)
}

// ===== IPC 薄包装函数 =====

/**
 * 运行 Agent 并流式推送事件到渲染进程
 *
 * 注册 webContents 到 EventBus 映射，委托给 Orchestrator。
 */
export async function runAgent(
  input: AgentRunInput,
  webContents: WebContents,
  extensions: AgentRunExtensions = {},
  terminalObserver?: AgentRunTerminalObserver,
): Promise<void> {
  /** 引用解析位于 IPC 接管完成前，失败必须直接拒绝调用方。 */
  const prepared = prepareAgentRun(input, extensions, webContents.id)
  return runPreparedAgent(prepared, webContents, terminalObserver)
}

/** 运行已经完成权威 Canvas 引用解析的消息，禁止二次读取文档。 */
export async function runPreparedAgent(
  prepared: PreparedAgentCanvasMessage<AgentSendInput>,
  webContents: WebContents,
  terminalObserver?: AgentRunTerminalObserver,
): Promise<void> {
  const { input, extensions } = prepared
  // deferred queue runs carry their queue id as an internal extension.
  const queueMessageId = (input as Partial<AgentDeferredQueueMessageInput>).queueMessageId
  /** 仅在 Orchestrator 准入后取得 owner，避免被拒绝的重复请求覆盖活跃路由。 */
  let route: AgentStreamRoute<WebContents> | undefined
  /** observer 最多接收一次终态；先锁定再调用，避免异常后被 completion 重复通知。 */
  let terminalObserved = false
  let activeStartedAt = input.startedAt
  let activeRunGeneration: number | undefined
  const notifyTerminal = (observation: AgentRunTerminalObservation): void => {
    if (terminalObserved || !terminalObserver) return
    terminalObserved = true
    terminalObserver(observation)
  }
  /** 只有 Pi 明确返回 success 时，Canvas 才能把本轮视为可提交完成。 */
  const getCompletionStatus = (options?: {
    stoppedByUser?: boolean
    resultSubtype?: string
  }): AgentRunTerminalObservation['status'] => resolveHeadlessAgentRunTerminalStatus({
    runErrored: false,
    stoppedByUser: options?.stoppedByUser,
    resultSubtype: options?.resultSubtype,
  })
  /** 获取当前运行仍拥有的 renderer；准入前错误只返回本次调用方。 */
  const getRunTarget = (): WebContents | undefined => route
    ? streamRoutes.getTargetIfOwner(input.sessionId, route.ownerId)
    : (webContents.isDestroyed() ? undefined : webContents)
  try {
    await orchestrator.sendMessage(input, {
      onError: (error) => {
        runAgentServiceTerminalEffects([
          {
            name: 'internal-terminal-observer',
            run: () => { notifyTerminal({
              status: 'errored', sessionId: input.sessionId,
              startedAt: activeStartedAt, runGeneration: activeRunGeneration,
            }) },
          },
          {
            name: 'renderer-error',
            run: () => {
            const target = getRunTarget()
            if (target) {
              target.send(
                AGENT_IPC_CHANNELS.STREAM_ERROR,
                buildAuthoritativeAgentStreamErrorPayload(input.sessionId, error, getAgentSessionMeta, input.startedAt),
              )
            }
            },
          },
        ], reportAgentServiceTerminalEffectError)
      },
      onComplete: (messages, opts) => {
        runAgentServiceTerminalEffects([
          {
            name: 'internal-terminal-observer',
            run: () => { notifyTerminal({
              status: getCompletionStatus(opts), sessionId: input.sessionId,
              startedAt: opts?.startedAt ?? activeStartedAt,
              runGeneration: opts?.runGeneration ?? activeRunGeneration,
            }) },
          },
          {
            name: 'publish-run-stopped',
            run: () => { publishRunStopped(input.sessionId, opts?.stoppedByUser, opts?.startedAt, opts?.runGeneration) },
          },
          {
            name: 'publish-run-completed',
            run: () => {
              publishRunCompleted(input.sessionId, 'desktop', {
                stoppedByUser: opts?.stoppedByUser,
                startedAt: opts?.startedAt ?? activeStartedAt,
                runGeneration: opts?.runGeneration ?? activeRunGeneration,
              })
            },
          },
          {
            name: 'renderer-complete',
            run: () => {
              const target = getRunTarget()
              if (target) {
                sendAuthoritativeAgentStreamComplete(target, input, getAgentSessionMeta, {
                  messages,
                  stoppedByUser: opts?.stoppedByUser ?? false,
                  startedAt: opts?.startedAt,
                  resultSubtype: opts?.resultSubtype,
                  resultErrors: opts?.resultErrors,
                  backgroundTasksPending: opts?.backgroundTasksPending,
                })
              }
            },
          },
          {
            name: 'queue-cleanup',
            run: () => {
              agentQueueCoordinator.onRunComplete(
                input.sessionId,
                queueMessageId,
                opts?.backgroundTasksPending === true,
                opts?.stoppedByUser === true,
              )
            },
          },
        ], reportAgentServiceTerminalEffectError)
      },
      onRunStarted: ({ startedAt, runGeneration }) => {
        activeStartedAt = startedAt
        activeRunGeneration = runGeneration
        const sessionMeta = getAgentSessionMeta(input.sessionId)
        workspaceOperationGuard.runAgentServiceEffects({
          sessionWorkspaceId: sessionMeta?.workspaceId,
          requestedWorkspaceId: input.workspaceId,
        }, () => {
          // 只有 Orchestrator 真正准入后才绑定 renderer 并修改会话状态。
          route = registerWebContents(input.sessionId, webContents)
          try {
            updateAgentSessionMeta(input.sessionId, { completedButUnconfirmed: false })
          } catch { /* 新会话可能尚未写入索引 */ }
          // 用户手动接管自动任务会话后，调度器不再复用它注入新运行。
          if (input.triggeredBy !== 'automation') {
            try {
              const meta = getAgentSessionMeta(input.sessionId)
              if (meta?.sourceAutomationId && !meta.automationGraduated) {
                updateAgentSessionMeta(input.sessionId, { automationGraduated: true })
                eventBus.emit(input.sessionId, {
                  kind: 'proma_event',
                  event: { type: 'automation_graduated' },
                })
              }
            } catch { /* 新会话可能尚未写入索引 */ }
          }
          eventBus.emit(input.sessionId, {
            kind: 'proma_event',
            event: buildAuthoritativeAgentRunStartedEvent(input.sessionId, startedAt, getAgentSessionMeta),
          })
        })
      },
      onTitleUpdated: (title) => {
        eventBus.emit(input.sessionId, {
          kind: 'proma_event',
          event: { type: 'title_updated', title },
        })
        const target = getRunTarget()
        if (target) {
          target.send(AGENT_IPC_CHANNELS.TITLE_UPDATED, {
            sessionId: input.sessionId,
            title,
          })
        }
      },
    }, extensions)
  } catch (err) {
    console.error('[Agent 服务] runAgent 未处理异常:', err)
    const errorMessage = err instanceof Error ? err.message : '未知错误'
    runAgentServiceTerminalEffects([
      {
        name: 'internal-terminal-observer',
        run: () => { notifyTerminal({
          status: 'errored', sessionId: input.sessionId,
          startedAt: activeStartedAt, runGeneration: activeRunGeneration,
        }) },
      },
      {
        name: 'renderer-error',
        run: () => {
          const target = getRunTarget()
          if (target) {
            target.send(
              AGENT_IPC_CHANNELS.STREAM_ERROR,
              buildAuthoritativeAgentStreamErrorPayload(input.sessionId, errorMessage, getAgentSessionMeta, input.startedAt),
            )
          }
        },
      },
      {
        name: 'renderer-complete',
        run: () => {
          if (!webContents.isDestroyed()) {
            sendAuthoritativeAgentStreamComplete(webContents, input, getAgentSessionMeta, {
              messages: [],
              stoppedByUser: false,
              startedAt: input.startedAt,
            })
          }
        },
      },
      {
        name: 'queue-cleanup',
        run: () => { agentQueueCoordinator.onRunComplete(input.sessionId, queueMessageId, false, false) },
      },
    ], reportAgentServiceTerminalEffectError)
  } finally {
    if (route && streamRoutes.removeIfOwner(input.sessionId, route.ownerId)) {
      streamForwarder.clear(input.sessionId)
    }
  }
}

/**
 * 无渲染进程的 Agent 运行（供飞书 Bridge 等外部调用方使用）
 *
 * 如果桌面窗口存在，同时注册 webContents 以便事件同步到桌面端 UI。
 * 事件同时通过 EventBus listeners 分发给飞书 Bridge。
 */
export async function runAgentHeadless(
  input: AgentSendInput,
  callbacks: HeadlessAgentRunCallbacks,
  extensions?: AgentRunExtensions,
): Promise<void> {
  // 委派子会话优先回到父会话所在 renderer，外部无界面运行才回退任意主窗口。
  const wc = getHeadlessAgentRunTarget(
    getStreamRouteTargets(),
    callbacks.originSessionId,
    getMainRendererWebContents,
  )
  // Headless 调用方不能声明交互式用户来源；只信任主进程 callback 绑定的外部来源。
  const runInput: AgentRunInput = normalizeHeadlessAgentRunInput(input, callbacks.source)
  const startedAt = runInput.startedAt!
  /** 记录 Orchestrator 真正启动后的权威时间，供所有终态共用。 */
  let activeStartedAt = startedAt
  let runGeneration: number | undefined
  let runErrored = false
  /** Orchestrator 完成参数归一为 headless 调用方可直接信任的明确终态。 */
  const buildHeadlessTerminalOptions = (options?: {
    stoppedByUser?: boolean
    startedAt?: number
    runGeneration?: number
    resultSubtype?: string
  }): HeadlessAgentRunTerminalOptions => {
    /** 优先使用 completion 自带的权威代次，早期异常回退已捕获的启动代次。 */
    const terminalRunGeneration = options?.runGeneration ?? runGeneration
    return {
      status: resolveHeadlessAgentRunTerminalStatus({
        runErrored,
        stoppedByUser: options?.stoppedByUser,
        resultSubtype: options?.resultSubtype,
      }),
      stoppedByUser: options?.stoppedByUser === true,
      startedAt: options?.startedAt ?? activeStartedAt,
      ...(terminalRunGeneration !== undefined ? { runGeneration: terminalRunGeneration } : {}),
      ...(options?.resultSubtype !== undefined ? { resultSubtype: options.resultSubtype } : {}),
    }
  }
  /** 仅在 headless 运行准入后绑定 renderer route。 */
  let route: AgentStreamRoute<WebContents> | undefined
  /** 获取本轮 headless 运行仍拥有的 renderer；准入前允许向初始窗口返回错误。 */
  const getRunTarget = (): WebContents | undefined => route
    ? streamRoutes.getTargetIfOwner(runInput.sessionId, route.ownerId)
    : (wc && !wc.isDestroyed() ? wc : undefined)

  try {
    /** 外部入口携带引用时同样执行普通宿主与项目归属复核。 */
    const resolved = prepareAgentRun(runInput, extensions)
    await orchestrator.sendMessage(resolved.input, {
      onError: (error) => {
        runErrored = true
        runAgentServiceTerminalEffects([
          { name: 'external-on-error', run: () => { callbacks.onError(error) } },
          {
            name: 'renderer-error',
            run: () => {
              const target = getRunTarget()
              if (target) {
                target.send(
                  AGENT_IPC_CHANNELS.STREAM_ERROR,
                  buildAuthoritativeAgentStreamErrorPayload(runInput.sessionId, error, getAgentSessionMeta, runInput.startedAt),
                )
              }
            },
          },
        ], reportAgentServiceTerminalEffectError)
      },
      onComplete: (messages, opts) => {
        /** 外部回调与运行事件必须共用同一份权威终态身份。 */
        const terminalOptions = buildHeadlessTerminalOptions(opts)
        runAgentServiceTerminalEffects([
          {
            name: 'external-on-complete',
            run: () => { callbacks.onComplete(messages, terminalOptions) },
          },
          {
            name: 'publish-run-stopped',
            run: () => { publishRunStopped(runInput.sessionId, opts?.stoppedByUser, opts?.startedAt, opts?.runGeneration) },
          },
          {
            name: 'publish-run-completed',
            run: () => { publishRunCompleted(runInput.sessionId, callbacks.source ?? 'bridge', terminalOptions) },
          },
          {
            name: 'renderer-complete',
            run: () => {
              const target = getRunTarget()
              if (target) {
                sendAuthoritativeAgentStreamComplete(target, runInput, getAgentSessionMeta, {
                  messages,
                  stoppedByUser: opts?.stoppedByUser ?? false,
                  startedAt: opts?.startedAt,
                  resultSubtype: opts?.resultSubtype,
                  resultErrors: opts?.resultErrors,
                  backgroundTasksPending: opts?.backgroundTasksPending,
                })
              }
            },
          },
          {
            name: 'queue-cleanup',
            run: () => {
              agentQueueCoordinator.onRunComplete(
                runInput.sessionId,
                undefined,
                opts?.backgroundTasksPending === true,
                opts?.stoppedByUser === true,
              )
            },
          },
        ], reportAgentServiceTerminalEffectError)
      },
      onTitleUpdated: (title) => {
        callbacks.onTitleUpdated(title)
        eventBus.emit(runInput.sessionId, {
          kind: 'proma_event',
          event: { type: 'title_updated', title },
        })
        const target = getRunTarget()
        if (target) {
          target.send(AGENT_IPC_CHANNELS.TITLE_UPDATED, {
            sessionId: runInput.sessionId,
            title,
          })
        }
      },
      onRunStarted: ({ startedAt: persistedStartedAt, runGeneration: persistedRunGeneration }) => {
        activeStartedAt = persistedStartedAt
        runGeneration = persistedRunGeneration
        const session = getAgentSessionMeta(runInput.sessionId)
        workspaceOperationGuard.runAgentServiceEffects({
          sessionWorkspaceId: session?.workspaceId,
          requestedWorkspaceId: runInput.workspaceId,
        }, () => {
          if (wc) route = registerWebContents(runInput.sessionId, wc)
          eventBus.emit(runInput.sessionId, {
            kind: 'proma_event',
            event: {
              type: 'external_run_started',
              source: callbacks.source ?? 'bridge',
              sessionId: runInput.sessionId,
              title: session?.title,
              workspaceId: session?.workspaceId ?? runInput.workspaceId,
              modelId: runInput.modelId,
              startedAt: persistedStartedAt,
              runGeneration: persistedRunGeneration,
              ...(session ? { session } : {}),
            },
          })
        })
      },
    }, resolved.extensions)
  } catch (err) {
    console.error('[Agent 服务] runAgentHeadless 未处理异常:', err)
    const errorMessage = err instanceof Error ? err.message : '未知错误'
    runErrored = true
    runAgentServiceTerminalEffects([
      { name: 'external-on-error', run: () => { callbacks.onError(errorMessage) } },
      {
        name: 'external-on-complete',
        run: () => { callbacks.onComplete(undefined, {
          status: 'errored', stoppedByUser: false, startedAt,
          ...(runGeneration !== undefined ? { runGeneration } : {}),
        }) },
      },
      {
        name: 'publish-run-completed',
        run: () => {
          publishRunCompleted(runInput.sessionId, callbacks.source ?? 'bridge', {
            stoppedByUser: false,
            startedAt,
            ...(runGeneration !== undefined ? { runGeneration } : {}),
          })
        },
      },
      {
        name: 'renderer-error',
        run: () => {
          const target = getRunTarget()
          if (target) {
            target.send(
              AGENT_IPC_CHANNELS.STREAM_ERROR,
              buildAuthoritativeAgentStreamErrorPayload(
                runInput.sessionId,
                errorMessage,
                getAgentSessionMeta,
                runInput.startedAt,
              ),
            )
          }
        },
      },
      {
        name: 'renderer-complete',
        run: () => {
          const target = getRunTarget()
          if (target) {
            sendAuthoritativeAgentStreamComplete(
              target,
              runInput,
              getAgentSessionMeta,
              { messages: [], stoppedByUser: false, startedAt },
            )
          }
        },
      },
      {
        name: 'queue-cleanup',
        run: () => { agentQueueCoordinator.onRunComplete(runInput.sessionId, undefined, false, false) },
      },
    ], reportAgentServiceTerminalEffectError)
  } finally {
    if (route && streamRoutes.removeIfOwner(runInput.sessionId, route.ownerId)) {
      streamForwarder.clear(runInput.sessionId)
    }
  }
}

/**
 * 生成 Agent 会话标题
 */
export async function generateAgentTitle(input: AgentGenerateTitleInput): Promise<string | null> {
  return orchestrator.generateTitle(input)
}

/**
 * 中止指定会话的 Agent 执行
 */
export function stopAgent(sessionId: string): void {
  // SEND_MESSAGE reserves this slot before the async bridge setup reaches the
  // orchestrator. Remember a stop in that window so the later run is never
  // allowed to create an uncancellable adapter query.
  orchestrator.stop(
    sessionId,
    shouldStopBeforeAgentRun(
      startingAgentSessions.has(sessionId),
      agentQueueCoordinator.isDispatching(sessionId),
    ),
  )
}

setHeadlessAgentRunner(runAgentHeadless)
setAgentStopper(stopAgent)

/**
 * 快照回退：回退到指定消息点，恢复文件 + 截断对话
 */
export async function rewindAgentSession(
  sessionId: string,
  assistantMessageUuid: string,
): Promise<import('@proma/shared').RewindSessionResult> {
  return orchestrator.rewindSession(sessionId, assistantMessageUuid)
}

/**
 * 检查指定会话是否正在运行
 */
export function isAgentSessionActive(sessionId: string): boolean {
  return orchestrator.isInFlight(sessionId)
}

/** 是否存在任意运行中 Agent，供更新器等全局生命周期服务安全判断。 */
export function hasActiveAgentSessions(): boolean {
  return orchestrator.hasActiveSessions()
}

/** 是否仍有 Agent generation 可能写入数据根，供数据根迁移预检使用。 */
export function hasActiveAgentDataWrites(): boolean {
  return orchestrator.hasGenerationOwnedWrites()
}

/** 查询指定工作区是否仍有 Agent generation-owned 数据写。 */
export function hasActiveAgentDataWritesForWorkspace(workspaceId: string): boolean {
  return orchestrator.hasGenerationOwnedWritesForWorkspace(workspaceId)
}

/** 列出当前活跃 Agent 会话的安全快照，供 renderer 重载恢复。 */
export function listActiveAgentSessionSnapshots(): AgentActiveSessionSnapshot[] {
  return orchestrator.listActiveSessionSnapshots()
}

export function listQueuedAgentMessages(sessionId: string): AgentQueuedMessageSnapshot[] {
  return agentQueueCoordinator.snapshot(sessionId)
}

/** 中止所有活跃的 Agent 会话（应用退出时调用） */
export function stopAllAgents(): void {
  orchestrator.stopAll()
}


/**
 * 运行中动态切换会话的权限模式
 *
 * 同时更新 Proma 侧（canUseTool 动态读取）和 SDK 侧（query.setPermissionMode）。
 */
export async function updateAgentPermissionMode(sessionId: string, mode: PromaPermissionMode): Promise<void> {
  await orchestrator.updateSessionPermissionMode(sessionId, mode)
}

// ===== 流式追加消息 =====

/**
 * 在 Agent 流式中追加发送消息
 *
 * 使用 'now' 优先级立即注入 SDK 并持久化。
 */
export async function queueAgentMessage(
  input: AgentQueueMessageInput,
  _webContents: WebContents,
): Promise<string> {
  /** queue-now 在注入当前 Pi 通道前重新读取权威节点。 */
  const resolved = prepareAgentRun(input)
  return queuePreparedAgentMessage(resolved)
}

/** 把已经解析的 queue-now 消息注入活跃通道。 */
async function queuePreparedAgentMessage(
  resolved: PreparedAgentCanvasMessage<AgentQueueMessageInput>,
): Promise<string> {
  return orchestrator.queueMessage(
    resolved.input.sessionId,
    resolved.input.userMessage,
    resolved.input.rawUserMessage,
    undefined,
    resolved.input.uuid,
    { interrupt: resolved.input.interrupt },
    resolved.input.mentionedSkills,
    resolved.input.mentionedMcpServers,
    resolved.input.mentionedSessionIds,
    resolved.input.mentionedTodoIds,
    resolved.input.mentionedCalendarEventIds,
    resolved.references,
    resolved.input.mediaAttachments,
    resolved.canvasWorkspacePrompt,
  )
}

/**
 * 单一消息提交入口：主进程依据实时运行状态决定注入当前 Agent 或交给 deferred queue。
 * renderer 的 streaming 状态仅用于展示，不能作为发送路由依据。
 */
export async function submitOrEnqueueAgentMessage(
  input: AgentSubmitOrEnqueueInput,
  webContents: WebContents,
): Promise<AgentSubmitOrEnqueueResult> {
  /** deferred 消息入队前必须完成附件固化，不能等当前 run 结束后再信任旧路径。 */
  const mediaPreparedInput = prepareAgentMediaInput(input)
  return routeAgentSubmitOrEnqueue(mediaPreparedInput, {
    isActive: (sessionId) => orchestrator.isActive(sessionId),
    /** 立即注入仍属于当前可见 Renderer 交互，保存窗口必须绑定本次 IPC sender。 */
    prepareNow: (candidate) => prepareAgentRun(createAgentQueueNowInput(candidate), {}, webContents.id),
    injectPrepared: async (prepared) => {
      registerWebContents(input.sessionId, webContents)
      await queuePreparedAgentMessage(prepared)
    },
    enqueue: (candidate) => {
      workspaceOperationGuard.runSessionWrite(candidate.sessionId, () => {
        registerWebContents(candidate.sessionId, webContents)
        agentQueueCoordinator.enqueue(candidate)
      })
    },
    onStaleActive: (sessionId) => {
      console.warn(`[Agent 服务] 活跃通道已结束，转入 deferred queue: sessionId=${sessionId}`)
    },
  })
}

/** 兼容旧调用：仅将消息追加到主进程 deferred queue。 */
export function enqueueAgentQueuedMessage(input: AgentDeferredQueueMessageInput, webContents: WebContents): void {
  const mediaPreparedInput = prepareAgentMediaInput(input)
  workspaceOperationGuard.runSessionWrite(input.sessionId, () => {
    registerWebContents(input.sessionId, webContents)
    agentQueueCoordinator.enqueue(mediaPreparedInput)
  })
}

export function cancelAgentQueuedMessage(input: AgentQueuedMessageControlInput): boolean {
  return agentQueueCoordinator.cancel(input)
}

export function moveAgentQueuedMessage(input: AgentMoveQueuedMessageInput): boolean {
  return agentQueueCoordinator.move(input)
}

export function clearAgentQueuedMessages(sessionId: string): void {
  agentQueueCoordinator.clear(sessionId)
}

// ===== 文件操作 =====

/**
 * 保存文件到 Agent session 工作目录
 *
 * 将 base64 编码的文件写入当前会话的私有工作目录，供 Agent 通过授权的附加目录读取。
 */
export function saveFilesToAgentSession(input: AgentSaveFilesInput): AgentSavedFile[] {
  const sessionDir = getAgentSessionWorkspacePath(input.workspaceSlug, input.sessionId)
  const attachmentsDir = join(sessionDir, 'attachments')
  const results: AgentSavedFile[] = []
  const usedPaths = new Set<string>()

  const decodedFiles = input.files.map((file) => {
    const buffer = Buffer.from(file.data, 'base64')
    if (buffer.length > MAX_ATTACHMENT_SIZE) {
      throw new Error(`文件超过 100MB 限制: ${file.filename}`)
    }
    return { file, buffer }
  })

  for (const { file, buffer } of decodedFiles) {
    let targetPath = resolveSafeWorkspaceFilePath(attachmentsDir, file.filename)

    // 防止同名文件覆盖
    if (usedPaths.has(targetPath) || existsSync(targetPath)) {
      const dotIdx = file.filename.lastIndexOf('.')
      const baseName = dotIdx > 0 ? file.filename.slice(0, dotIdx) : file.filename
      const ext = dotIdx > 0 ? file.filename.slice(dotIdx) : ''
      let counter = 1
      let candidate = join(attachmentsDir, `${baseName}-${counter}${ext}`)
      while (usedPaths.has(candidate) || existsSync(candidate)) {
        counter++
        candidate = join(attachmentsDir, `${baseName}-${counter}${ext}`)
      }
      targetPath = candidate
    }
    usedPaths.add(targetPath)

    mkdirSync(dirname(targetPath), { recursive: true })
    writeFileSync(targetPath, buffer)

    const actualFilename = targetPath.slice(sessionDir.length + 1)
    results.push({ filename: actualFilename, targetPath })
    console.log(`[Agent 服务] 文件已保存: ${targetPath} (${buffer.length} bytes)`)
  }

  return results
}

const LOCAL_PROJECT_ROOT_UNAVAILABLE_CODE = 'local_project_root_unavailable'

function createLocalProjectRootUnavailableError(projectRootPath: string, status?: string): Error {
  const error = new Error(
    `本地项目根目录不可用: 本地项目根目录不存在或无法访问：${projectRootPath}。请在 Proma 中重新选择项目文件夹。`,
  ) as Error & { code?: string; details?: string[] }
  error.code = LOCAL_PROJECT_ROOT_UNAVAILABLE_CODE
  error.details = status ? [`目录状态: ${status}`] : undefined
  return error
}

function resolveSafeWorkspaceFilePath(workspaceRoot: string, filename: string): string {
  const hasParentTraversal = filename.split(/[\\/]+/).some((segment) => segment === '..')
  if (!filename || isAbsolute(filename) || win32.isAbsolute(filename) || hasParentTraversal) {
    throw new Error(`项目文件名不安全，拒绝保存: ${filename}`)
  }

  const resolvedRoot = resolve(workspaceRoot)
  const targetPath = resolve(resolvedRoot, filename)
  const pathWithinRoot = relative(resolvedRoot, targetPath)
  const escapesRoot = pathWithinRoot === '..'
    || pathWithinRoot.startsWith(`..${sep}`)
    || isAbsolute(pathWithinRoot)

  if (!pathWithinRoot || escapesRoot) {
    throw new Error(`项目文件名不安全，拒绝保存: ${filename}`)
  }

  return targetPath
}

/**
 * 保存文件到项目文件根目录
 *
 * 空白项目写入 Proma 托管的 workspace-files/；本地目录项目直接写入用户选择的原始目录。
 */
function isFileAlreadyExistsError(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST'
}

async function writeUniqueWorkspaceFile(
  workspaceFilesDir: string,
  initialTargetPath: string,
  buffer: Buffer,
  usedPaths: Set<string>,
): Promise<string> {
  const relativeFilename = relative(workspaceFilesDir, initialTargetPath)
  const dotIdx = relativeFilename.lastIndexOf('.')
  const baseName = dotIdx > 0 ? relativeFilename.slice(0, dotIdx) : relativeFilename
  const ext = dotIdx > 0 ? relativeFilename.slice(dotIdx) : ''

  for (let counter = 0; ; counter++) {
    const filename = counter === 0 ? relativeFilename : `${baseName}-${counter}${ext}`
    const targetPath = resolveSafeWorkspaceFilePath(workspaceFilesDir, filename)
    if (usedPaths.has(targetPath)) continue

    await mkdirAsync(dirname(targetPath), { recursive: true })
    try {
      // `wx` 确保另一条 IPC 请求不会在碰撞检查与写入之间覆盖文件；
      // 若目标已存在，则尝试下一个编号后缀。
      await writeFileAsync(targetPath, buffer, { flag: 'wx' })
      usedPaths.add(targetPath)
      return targetPath
    } catch (error) {
      if (isFileAlreadyExistsError(error)) continue
      throw error
    }
  }
}

export async function saveFilesToWorkspaceFiles(input: AgentSaveWorkspaceFilesInput): Promise<AgentSavedFile[]> {
  const workspace = getAgentWorkspaceBySlug(input.workspaceSlug)
  if (!workspace) {
    throw new Error(`指定的 Agent 项目不存在或已删除: ${input.workspaceSlug}`)
  }

  if (workspace.projectRootPath) {
    const status = await getLocalProjectRootStatus(workspace.projectRootPath)
    if (status !== 'available') {
      throw createLocalProjectRootUnavailableError(workspace.projectRootPath, status)
    }
  }

  const wsFilesDir = workspace.projectRootPath ?? getProjectFilesPath(input.workspaceSlug)
  const files = input.files.map((file) => ({
    file,
    initialTargetPath: resolveSafeWorkspaceFilePath(wsFilesDir, file.filename),
  }))
  const decodedFiles = files.map(({ file, initialTargetPath }) => {
    const buffer = Buffer.from(file.data, 'base64')
    if (buffer.length > MAX_ATTACHMENT_SIZE) {
      throw new Error(`文件超过 100MB 限制: ${file.filename}`)
    }
    return { file, initialTargetPath, buffer }
  })
  const results: AgentSavedFile[] = []
  const usedPaths = new Set<string>()

  for (const { initialTargetPath, buffer } of decodedFiles) {
    const targetPath = await writeUniqueWorkspaceFile(wsFilesDir, initialTargetPath, buffer, usedPaths)
    const actualFilename = relative(wsFilesDir, targetPath)
    results.push({ filename: actualFilename, targetPath })
    console.log(`[Agent 服务] 工作区文件已保存: ${targetPath} (${buffer.length} bytes)`)
  }

  return results
}
