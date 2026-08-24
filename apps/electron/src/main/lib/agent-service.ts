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
import { accessSync, constants, existsSync, mkdirSync, writeFileSync } from 'node:fs'
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
  AgentMessage,
} from '@proma/shared'
import { PiAgentAdapter } from './adapters/pi-agent-adapter'
import { PiUtilityAdapter } from './adapters/pi-utility-adapter'
import { AgentEventBus } from './agent-event-bus'
import { AgentOrchestrator } from './agent-orchestrator'
import { getAgentSessionWorkspacePath } from './config-paths'
import { getAgentWorkspaceBySlug, getLocalProjectRootStatus, getProjectFilesPath } from './agent-workspace-manager'
import { getAgentSessionMeta, updateAgentSessionMeta } from './agent-session-manager'
import { setAgentStopper, setHeadlessAgentRunner } from './agent-headless-runner-registry'
import { getHeadlessAgentRunTarget } from './agent-headless-run-target'
import { sendAgentStreamComplete } from './agent-completion-payload'
import { AgentStreamForwarder } from './agent-stream-forwarder'
import { AgentQueueCoordinator } from './agent-queue-coordinator'
import { getWorkspaceOperationBlockReason } from './workspace-operation-lock'
import { createWorkspaceOperationGuard } from './workspace-operation-guard'
import { runAgentServiceTerminalEffects } from './agent-run-lifecycle'
import type { AgentRunExtensions } from './agent-run-extensions'
import { isStaleActiveQueueError } from './agent-queue-routing'
import { shouldStopBeforeAgentRun } from './agent-stop-policy'

/** 保持现有主进程调用方从 agent-service 导入运行扩展类型的兼容性。 */
export type { AgentRunExtensions } from './agent-run-extensions'

// ===== 实例创建 =====

const eventBus = new AgentEventBus()
const useUtilityAgentRuntime = process.env.PROMA_AGENT_RUNTIME !== 'in-process'
  && process.env.PROMA_AGENT_RUNTIME !== 'off'
const adapter = useUtilityAgentRuntime ? new PiUtilityAdapter() : new PiAgentAdapter()
const orchestrator = new AgentOrchestrator(adapter, eventBus)
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
 * 会话 → webContents 映射
 *
 * EventBus IPC 转发中间件通过此映射找到目标 webContents。
 * runAgent 开始时注册，结束时清理。
 */
const sessionWebContents = new Map<string, WebContents>()
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
 * 注册 sessionId → webContents 映射，并在 webContents 销毁时自动清理所有相关条目。
 *
 * 仅依赖 finally 块清理无法覆盖窗口关闭、渲染进程崩溃、headless 路径主窗口被替换等
 * webContents 提前销毁的场景——destroyed 事件兜底。
 */
function registerWebContents(sessionId: string, wc: WebContents): void {
  // 同一 sessionId 切换 renderer 时，先丢弃捕获旧 wc.send 的等待 partial，避免投递到旧窗口。
  const previousWebContents = sessionWebContents.get(sessionId)
  if (previousWebContents && previousWebContents !== wc) streamForwarder.clear(sessionId)
  // 旧 wc 的 destroyed 钩子仍由 WeakSet 持有，触发时会扫描 sessionWebContents 清理所有指向它的条目。
  sessionWebContents.set(sessionId, wc)
  if (wcWithCleanupHook.has(wc)) return
  wcWithCleanupHook.add(wc)
  wc.once('destroyed', () => {
    // 单个 wc 可能映射到多个 sessionId（同窗口多 tab），需要清理所有指向它的条目
    for (const [sid, mappedWc] of sessionWebContents) {
      if (mappedWc === wc) {
        sessionWebContents.delete(sid)
        streamForwarder.clear(sid)
      }
    }
    visibleAgentSessionByWebContents.delete(wc)
  })
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
  getWebContents: (sessionId) => sessionWebContents.get(sessionId) ?? getMainRendererWebContents(),
  startRun: (input, webContents) => runAgent(input, webContents),
  sendStarted: (webContents, status) => {
    if (!webContents.isDestroyed()) webContents.send(AGENT_IPC_CHANNELS.QUEUED_MESSAGE_STATUS, status)
  },
})

/**
 * Renderer run 在创建飞书镜像卡片时尚未进入 orchestrator.activeSessions。
 * 在此期间保留启动槽位，避免会话迁移改变已接受请求的项目归属。
 */
const startingAgentSessions = new Set<string>()

export function reserveAgentSessionStart(sessionId: string): () => void {
  if (startingAgentSessions.has(sessionId) || orchestrator.isActive(sessionId)) {
    throw new Error('会话正在启动或运行中，请等待当前请求结束后再发送。')
  }
  startingAgentSessions.add(sessionId)
  return () => startingAgentSessions.delete(sessionId)
}

export function isAgentSessionBusy(sessionId: string): boolean {
  return startingAgentSessions.has(sessionId)
    || orchestrator.isActive(sessionId)
    || agentQueueCoordinator.hasPending(sessionId)
}

function publishRunStopped(
  sessionId: string,
  stoppedByUser: boolean | undefined,
  startedAt: number | undefined,
): void {
  if (!stoppedByUser) return
  eventBus.emit(sessionId, {
    kind: 'proma_event',
    event: {
      type: 'run_stopped',
      ...(startedAt != null ? { startedAt } : {}),
    },
  })
}

/** 记录被隔离的 Agent service 终态副作用异常。 */
function reportAgentServiceTerminalEffectError(name: string, error: unknown): void {
  console.error(`[Agent 服务] 终态副作用执行失败: ${name}`, error)
}

// ===== EventBus IPC 转发中间件 =====

/**
 * 完成事件只需要侧栏/导航使用的轻量 meta。Pi 的 entry bindings 仅用于主进程
 * session fork/rewind，传到 renderer 会在长会话完成时徒增 IPC 序列化成本。
 */
function getSessionMetaForRenderer(sessionId: string) {
  const session = getAgentSessionMeta(sessionId)
  if (!session) return undefined
  const { piEntryBindings: _piEntryBindings, ...meta } = session
  return meta
}

eventBus.use((sessionId, payload, next) => {
  const wc = sessionWebContents.get(sessionId)
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
  input: AgentSendInput,
  webContents: WebContents,
): Promise<void> {
  // deferred queue runs carry their queue id as an internal extension.
  const queueMessageId = (input as Partial<AgentDeferredQueueMessageInput>).queueMessageId
  /** 标记当前入口是否真正通过 Orchestrator 准入并注册 renderer。 */
  let runStarted = false
  try {
    await orchestrator.sendMessage(input, {
      onError: (error) => {
        runAgentServiceTerminalEffects([{
          name: 'renderer-error',
          run: () => {
            if (!webContents.isDestroyed()) {
              webContents.send(AGENT_IPC_CHANNELS.STREAM_ERROR, {
                sessionId: input.sessionId,
                error,
              })
            }
          },
        }], reportAgentServiceTerminalEffectError)
      },
      onComplete: (messages, opts) => {
        runAgentServiceTerminalEffects([
          {
            name: 'publish-run-stopped',
            run: () => { publishRunStopped(input.sessionId, opts?.stoppedByUser, opts?.startedAt) },
          },
          {
            name: 'renderer-complete',
            run: () => {
              if (!webContents.isDestroyed()) {
                sendAgentStreamComplete(webContents, input, {
                  messages,
                  stoppedByUser: opts?.stoppedByUser ?? false,
                  startedAt: opts?.startedAt,
                  resultSubtype: opts?.resultSubtype,
                  resultErrors: opts?.resultErrors,
                  backgroundTasksPending: opts?.backgroundTasksPending,
                  // 只读取刚完成的轻量 meta，renderer 可据此增量更新列表，避免再取 5,000+ 条全量会话。
                  session: getSessionMetaForRenderer(input.sessionId),
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
      onRunStarted: ({ startedAt }) => {
        const sessionMeta = getAgentSessionMeta(input.sessionId)
        workspaceOperationGuard.runAgentServiceEffects({
          sessionWorkspaceId: sessionMeta?.workspaceId,
          requestedWorkspaceId: input.workspaceId,
        }, () => {
          // 只有 Orchestrator 真正准入后才绑定 renderer 并修改会话状态。
          registerWebContents(input.sessionId, webContents)
          runStarted = true
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
            event: { type: 'run_started', startedAt },
          })
        })
      },
      onTitleUpdated: (title) => {
        eventBus.emit(input.sessionId, {
          kind: 'proma_event',
          event: { type: 'title_updated', title },
        })
        if (!webContents.isDestroyed()) {
          webContents.send(AGENT_IPC_CHANNELS.TITLE_UPDATED, {
            sessionId: input.sessionId,
            title,
          })
        }
      },
    })
  } catch (err) {
    console.error('[Agent 服务] runAgent 未处理异常:', err)
    const errorMessage = err instanceof Error ? err.message : '未知错误'
    runAgentServiceTerminalEffects([
      {
        name: 'renderer-error',
        run: () => {
          if (!webContents.isDestroyed()) {
            webContents.send(AGENT_IPC_CHANNELS.STREAM_ERROR, {
              sessionId: input.sessionId,
              error: errorMessage,
            })
          }
        },
      },
      {
        name: 'renderer-complete',
        run: () => {
          if (!webContents.isDestroyed()) {
            sendAgentStreamComplete(webContents, input, { messages: [], stoppedByUser: false })
          }
        },
      },
      {
        name: 'queue-cleanup',
        run: () => { agentQueueCoordinator.onRunComplete(input.sessionId, queueMessageId, false, false) },
      },
    ], reportAgentServiceTerminalEffectError)
  } finally {
    // 仅在 orchestrator 已完成此会话时清理映射
    // 避免被拒绝的请求误删仍在运行的会话映射
    if (runStarted && !orchestrator.isActive(input.sessionId)) {
      sessionWebContents.delete(input.sessionId)
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
  callbacks: {
    onError: (error: string) => void
    onComplete: (messages?: AgentMessage[]) => void
    onTitleUpdated: (title: string) => void
    source?: AgentExternalRunSource
    originSessionId?: string
  },
  extensions?: AgentRunExtensions,
): Promise<void> {
  // 委派子会话优先回到父会话所在 renderer，外部无界面运行才回退任意主窗口。
  const wc = getHeadlessAgentRunTarget(
    sessionWebContents,
    callbacks.originSessionId,
    getMainRendererWebContents,
  )
  const runInput: AgentSendInput = input.startedAt != null ? input : { ...input, startedAt: Date.now() }
  const startedAt = runInput.startedAt!
  /** 标记 headless 入口是否真正开始并注册 renderer。 */
  let runStarted = false

  try {
    await orchestrator.sendMessage(runInput, {
      onError: (error) => {
        runAgentServiceTerminalEffects([
          { name: 'external-on-error', run: () => { callbacks.onError(error) } },
          {
            name: 'renderer-error',
            run: () => {
              if (wc && !wc.isDestroyed()) {
                wc.send(AGENT_IPC_CHANNELS.STREAM_ERROR, {
                  sessionId: runInput.sessionId,
                  error,
                })
              }
            },
          },
        ], reportAgentServiceTerminalEffectError)
      },
      onComplete: (messages, opts) => {
        runAgentServiceTerminalEffects([
          { name: 'external-on-complete', run: () => { callbacks.onComplete(messages) } },
          {
            name: 'publish-run-stopped',
            run: () => { publishRunStopped(runInput.sessionId, opts?.stoppedByUser, opts?.startedAt) },
          },
          {
            name: 'renderer-complete',
            run: () => {
              if (wc && !wc.isDestroyed()) {
                sendAgentStreamComplete(wc, runInput, {
                  messages,
                  stoppedByUser: opts?.stoppedByUser ?? false,
                  startedAt: opts?.startedAt,
                  resultSubtype: opts?.resultSubtype,
                  resultErrors: opts?.resultErrors,
                  backgroundTasksPending: opts?.backgroundTasksPending,
                  // 只读取刚完成的轻量 meta，renderer 可据此增量更新列表，避免再取 5,000+ 条全量会话。
                  session: getSessionMetaForRenderer(runInput.sessionId),
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
        // 同步到渲染进程
        if (wc && !wc.isDestroyed()) {
          wc.send(AGENT_IPC_CHANNELS.TITLE_UPDATED, {
            sessionId: runInput.sessionId,
            title,
          })
        }
      },
      onRunStarted: ({ startedAt: persistedStartedAt }) => {
        const session = getAgentSessionMeta(runInput.sessionId)
        workspaceOperationGuard.runAgentServiceEffects({
          sessionWorkspaceId: session?.workspaceId,
          requestedWorkspaceId: runInput.workspaceId,
        }, () => {
          if (wc) registerWebContents(runInput.sessionId, wc)
          runStarted = true
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
              ...(session ? { session } : {}),
            },
          })
        })
      },
    }, extensions)
  } catch (err) {
    console.error('[Agent 服务] runAgentHeadless 未处理异常:', err)
    const errorMessage = err instanceof Error ? err.message : '未知错误'
    runAgentServiceTerminalEffects([
      { name: 'external-on-error', run: () => { callbacks.onError(errorMessage) } },
      { name: 'external-on-complete', run: () => { callbacks.onComplete() } },
      {
        name: 'renderer-error',
        run: () => {
          if (wc && !wc.isDestroyed()) {
            wc.send(AGENT_IPC_CHANNELS.STREAM_ERROR, { sessionId: runInput.sessionId, error: errorMessage })
          }
        },
      },
      {
        name: 'renderer-complete',
        run: () => {
          if (wc && !wc.isDestroyed()) {
            sendAgentStreamComplete(wc, runInput, { messages: [], stoppedByUser: false, startedAt })
          }
        },
      },
      {
        name: 'queue-cleanup',
        run: () => { agentQueueCoordinator.onRunComplete(runInput.sessionId, undefined, false, false) },
      },
    ], reportAgentServiceTerminalEffectError)
  } finally {
    if (runStarted && !orchestrator.isActive(runInput.sessionId)) {
      sessionWebContents.delete(runInput.sessionId)
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
  return orchestrator.queueMessage(
    input.sessionId,
    input.userMessage,
    input.rawUserMessage,
    undefined,
    input.uuid,
    { interrupt: input.interrupt },
    input.mentionedSkills,
    input.mentionedMcpServers,
    input.mentionedSessionIds,
    input.mentionedTodoIds,
    input.mentionedCalendarEventIds,
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
  registerWebContents(input.sessionId, webContents)

  if (input.dispatch === 'now' && orchestrator.isActive(input.sessionId)) {
    try {
      await queueAgentMessage({
        sessionId: input.sessionId,
        userMessage: input.userMessage,
        rawUserMessage: input.rawUserMessage,
        uuid: input.queueMessageId,
        interrupt: input.interrupt,
        mentionedSkills: input.mentionedSkills,
        mentionedMcpServers: input.mentionedMcpServers,
        mentionedSessionIds: input.mentionedSessionIds,
        mentionedTodoIds: input.mentionedTodoIds,
        mentionedCalendarEventIds: input.mentionedCalendarEventIds,
      }, webContents)
      return { disposition: 'injected' }
    } catch (error) {
      // Pi Utility 在 query 结束、renderer 尚未收到 STREAM_COMPLETE 的窗口会拒绝注入。
      // 该消息尚未被 SDK 接受，安全地降级到主进程队列，而非向用户暴露瞬态错误。
      if (!isStaleActiveQueueError(error)) throw error
      console.warn(`[Agent 服务] 活跃通道已结束，转入 deferred queue: sessionId=${input.sessionId}`)
    }
  }

  workspaceOperationGuard.runSessionWrite(input.sessionId, () => {
    agentQueueCoordinator.enqueue(input)
  })
  return { disposition: 'queued' }
}

/** 兼容旧调用：仅将消息追加到主进程 deferred queue。 */
export function enqueueAgentQueuedMessage(input: AgentDeferredQueueMessageInput, webContents: WebContents): void {
  workspaceOperationGuard.runSessionWrite(input.sessionId, () => {
    registerWebContents(input.sessionId, webContents)
    agentQueueCoordinator.enqueue(input)
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
export function saveFilesToWorkspaceFiles(input: AgentSaveWorkspaceFilesInput): AgentSavedFile[] {
  const workspace = getAgentWorkspaceBySlug(input.workspaceSlug)
  if (!workspace) {
    throw new Error(`指定的 Agent 项目不存在或已删除: ${input.workspaceSlug}`)
  }

  if (workspace.projectRootPath) {
    const status = getLocalProjectRootStatus(workspace.projectRootPath)
    if (status !== 'available') {
      throw createLocalProjectRootUnavailableError(workspace.projectRootPath, status)
    }
    try {
      accessSync(workspace.projectRootPath, constants.R_OK | constants.W_OK | constants.X_OK)
    } catch {
      throw createLocalProjectRootUnavailableError(workspace.projectRootPath, 'unavailable')
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

  for (const { file, initialTargetPath, buffer } of decodedFiles) {
    let targetPath = initialTargetPath

    // 防止同名文件覆盖
    if (usedPaths.has(targetPath) || existsSync(targetPath)) {
      const relativeFilename = relative(wsFilesDir, targetPath)
      const dotIdx = relativeFilename.lastIndexOf('.')
      const baseName = dotIdx > 0 ? relativeFilename.slice(0, dotIdx) : relativeFilename
      const ext = dotIdx > 0 ? relativeFilename.slice(dotIdx) : ''
      let counter = 1
      let candidate = resolveSafeWorkspaceFilePath(wsFilesDir, `${baseName}-${counter}${ext}`)
      while (usedPaths.has(candidate) || existsSync(candidate)) {
        counter++
        candidate = resolveSafeWorkspaceFilePath(wsFilesDir, `${baseName}-${counter}${ext}`)
      }
      targetPath = candidate
    }
    usedPaths.add(targetPath)

    mkdirSync(dirname(targetPath), { recursive: true })
    writeFileSync(targetPath, buffer)

    const actualFilename = relative(wsFilesDir, targetPath)
    results.push({ filename: actualFilename, targetPath })
    console.log(`[Agent 服务] 工作区文件已保存: ${targetPath} (${buffer.length} bytes)`)
  }

  return results
}
