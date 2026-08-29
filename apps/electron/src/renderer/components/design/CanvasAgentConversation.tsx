import * as React from 'react'
import type {
  CanvasAgentMessagesResult,
  CanvasAgentTarget,
  GetCanvasAgentMessagesInput,
  SendCanvasAgentMessageInput,
  SendCanvasAgentMessageResult,
  StopCanvasAgentInput,
} from '@proma/shared'
import { useAtomValue, useSetAtom } from 'jotai'
import { CornerDownLeft, LoaderCircle, Square, X } from 'lucide-react'
import {
  agentSessionStreamingStateAtomFamily,
  agentStreamErrorsAtom,
  clearAgentStreamError,
} from '@/atoms/agent-atoms'
import {
  canvasAgentLifecycleAtom,
  canvasAgentPersistedMessagesAtom,
  canvasAgentRunningSessionIdsAtom,
} from '@/atoms/native-canvas-atoms'
import { AgentMessages } from '@/components/agent/AgentMessages'
import { AgentComposerFrame } from '@/components/agent/AgentComposerFrame'
import { RichTextInput, type RichTextInputHandle } from '@/components/ai-elements/rich-text-input'
import {
  inputToolbarDangerButtonClass,
  inputToolbarDisabledButtonClass,
  inputToolbarSendButtonClass,
} from '@/components/ai-elements/input-toolbar-styles'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import type { CanvasAgentOwner } from '@/lib/canvas-agent-event-routing'
import { CanvasPublicOperationError } from '@/lib/design-adapter'
import { cn } from '@/lib/utils'

/** Canvas Agent 对话三类用户操作。 */
export type CanvasAgentConversationOperation = 'load' | 'send' | 'stop'

/** 未知异常不得进入界面的固定操作文案。 */
const CANVAS_AGENT_ERROR_MESSAGES: Record<CanvasAgentConversationOperation, string> = {
  load: '对话暂时无法加载。',
  send: '发送失败，请重试。',
  stop: '停止失败，请重试。',
}

/**
 * 将 Canvas Agent 操作异常转换为可公开显示的文案。
 * @param operation 当前失败的对话操作。
 * @param error Adapter 或意外运行时抛出的未知异常。
 * @returns 共享公开错误文案，或不含内部正文的固定回退文案。
 */
export function getCanvasAgentConversationErrorMessage(
  operation: CanvasAgentConversationOperation,
  error: unknown,
): string {
  return error instanceof CanvasPublicOperationError
    ? error.message
    : CANVAS_AGENT_ERROR_MESSAGES[operation]
}

/** 对话组件使用的 Canvas adapter 最小合同。 */
export interface CanvasAgentConversationAdapter {
  getCanvasAgentMessages: (input: GetCanvasAgentMessagesInput) => Promise<CanvasAgentMessagesResult>
  sendCanvasAgentMessage: (input: SendCanvasAgentMessageInput) => Promise<SendCanvasAgentMessageResult>
  stopCanvasAgent: (input: StopCanvasAgentInput) => Promise<void>
}

/** 无 React 请求控制器的依赖。 */
export interface CanvasAgentConversationControllerDependencies {
  load: () => Promise<CanvasAgentMessagesResult>
  send: (message: string, userMessageUuid: string, startedAt: number) => Promise<SendCanvasAgentMessageResult>
  stop: () => Promise<void>
  onLoaded: (result: CanvasAgentMessagesResult) => void
  onComposerChange: (value: string) => void
  onSendingChange: (sending: boolean) => void
  onError: (error: string | null) => void
  /** 返回主进程快照和流事件合成后的权威忙碌状态。 */
  isBusy: () => boolean
  /** SEND 准入失败时按本轮 token 收口乐观态，并可保留主进程确认的真实运行。 */
  onSendRejected?: (input: { token: string; preserveRunning: boolean }) => void
}

/** 按需加载、单次发送和停止的命令边界。 */
export interface CanvasAgentConversationController {
  load: () => Promise<void>
  send: (message: string, userMessageUuid: string, startedAt: number) => Promise<void>
  stop: () => Promise<void>
  getComposerRestore: () => string
  dispose: () => void
}

/**
 * 创建不随面板卸载停止 Agent 的对话请求控制器。
 * @param dependencies Canvas IPC 与局部 UI 回调。
 * @returns 去重加载/发送、保留失败 composer 的控制器。
 */
export function createCanvasAgentConversationController(
  dependencies: CanvasAgentConversationControllerDependencies,
): CanvasAgentConversationController {
  let loadPromise: Promise<void> | null = null
  let sendPromise: Promise<void> | null = null
  let composerRestore = ''
  let disposed = false

  return {
    load: () => {
      if (loadPromise) return loadPromise
      const request = dependencies.load().then((result) => {
        if (!disposed) dependencies.onLoaded(result)
      })
      loadPromise = request
      return request
    },
    send: (message, userMessageUuid, startedAt) => {
      if (sendPromise) return sendPromise
      if (dependencies.isBusy()) return Promise.resolve()
      composerRestore = message
      dependencies.onComposerChange('')
      dependencies.onSendingChange(true)
      dependencies.onError(null)
      /** 统一恢复本地输入；全局 lifecycle 即使面板已卸载也必须按 token 收口。 */
      const rejectSend = (
        error: unknown,
        preserveRunning: boolean,
        publicMessage?: string,
      ): never => {
        dependencies.onSendRejected?.({ token: userMessageUuid, preserveRunning })
        if (!disposed) {
          dependencies.onComposerChange(composerRestore)
          dependencies.onError(publicMessage ?? getCanvasAgentConversationErrorMessage('send', error))
        }
        throw error
      }
      const request = dependencies.send(message, userMessageUuid, startedAt).then(
        (result) => {
          if (result.ok) return
          rejectSend(
            new Error(result.error.message),
            result.error.code === 'SESSION_BUSY',
            result.error.message,
          )
        },
        (error: unknown) => rejectSend(error, false),
      ).finally(() => {
        if (!disposed) dependencies.onSendingChange(false)
        if (sendPromise === request) sendPromise = null
      })
      sendPromise = request
      return request
    },
    stop: () => dependencies.stop(),
    getComposerRestore: () => composerRestore,
    dispose: () => {
      /** 卸载只隔离迟到 UI 回调，绝不调用 stop 或清理全局运行 atom。 */
      disposed = true
    },
  }
}

/** Canvas Agent 对话面板输入。 */
export interface CanvasAgentConversationProps {
  target: CanvasAgentTarget
  title: string
  adapter: CanvasAgentConversationAdapter
  onClose: () => void
}

/** 只包含消息、纯文本输入、发送、停止和关闭的 Canvas 对话面板。 */
export function CanvasAgentConversation({
  target,
  title,
  adapter,
  onClose,
}: CanvasAgentConversationProps): React.ReactElement {
  const { projectId, canvasId, nodeId } = target
  const { getCanvasAgentMessages, sendCanvasAgentMessage, stopCanvasAgent } = adapter
  const [sessionId, setSessionId] = React.useState<string | null>(null)
  const [messagesLoaded, setMessagesLoaded] = React.useState(false)
  const [loadingError, setLoadingError] = React.useState<string | null>(null)
  const [localError, setLocalError] = React.useState<string | null>(null)
  const [composer, setComposer] = React.useState('')
  const [sending, setSending] = React.useState(false)
  const updateLifecycle = useSetAtom(canvasAgentLifecycleAtom)
  const persistedMessagesMap = useAtomValue(canvasAgentPersistedMessagesAtom)
  const streamErrors = useAtomValue(agentStreamErrorsAtom)
  /** 新 SEND 前清除该会话上一轮错误。 */
  const setStreamErrors = useSetAtom(agentStreamErrorsAtom)
  /** reload 快照恢复的 Canvas 权威运行集合。 */
  const runningSessionIds = useAtomValue(canvasAgentRunningSessionIdsAtom)
  const streamState = useAtomValue(agentSessionStreamingStateAtomFamily(sessionId ?? ''))
  /** controller 通过 ref 读取最新权威 busy，避免只依赖按钮 disabled。 */
  const busyRef = React.useRef(false)
  const controllerRef = React.useRef<CanvasAgentConversationController | null>(null)
  const richTextInputRef = React.useRef<RichTextInputHandle>(null)

  React.useEffect(() => {
    let active = true
    setSessionId(null)
    setMessagesLoaded(false)
    setLoadingError(null)
    setLocalError(null)
    setComposer('')
    setSending(false)
    /** 当前 effect 成功打开的 session，cleanup 据此关闭生命周期。 */
    let openedSessionId: string | null = null
    /** effect 内按稳定身份重建 target，避免父组件对象重建导致重复读取 JSONL。 */
    const currentTarget = { projectId, canvasId, nodeId }
    const controller = createCanvasAgentConversationController({
      load: () => getCanvasAgentMessages(currentTarget),
      send: (message, userMessageUuid, startedAt) => sendCanvasAgentMessage({
        ...currentTarget, message, userMessageUuid, startedAt,
      }),
      stop: () => stopCanvasAgent(currentTarget),
      isBusy: () => busyRef.current,
      onLoaded: (result) => {
        /** GET 返回的主进程 owner 成为未打开 Canvas 事件路由的 O(1) 本地索引。 */
        const owner: CanvasAgentOwner = {
          sessionId: result.sessionId,
          ...result.owner,
        }
        openedSessionId = result.sessionId
        setSessionId(result.sessionId)
        updateLifecycle({ type: 'opened', owner, messages: result.messages })
        setMessagesLoaded(true)
      },
      onComposerChange: setComposer,
      onSendingChange: setSending,
      onError: setLocalError,
      onSendRejected: ({ token, preserveRunning }) => {
        /** 准入失败尚未进入会吞掉异常并发布 completion 的 runAgent 边界。 */
        if (openedSessionId) updateLifecycle({
          type: 'send-rejected', sessionId: openedSessionId, token, preserveRunning,
        })
      },
    })
    controllerRef.current = controller
    void controller.load().catch((error: unknown) => {
      if (active) setLoadingError(getCanvasAgentConversationErrorMessage('load', error))
    })
    return () => {
      active = false
      controller.dispose()
      if (openedSessionId) updateLifecycle({ type: 'closed', sessionId: openedSessionId })
      if (controllerRef.current === controller) controllerRef.current = null
    }
  }, [canvasId, getCanvasAgentMessages, nodeId, projectId, sendCanvasAgentMessage, stopCanvasAgent, updateLifecycle])

  /** 提交当前纯文本；失败时恢复原文，避免用户输入丢失。 */
  const submit = React.useCallback((content?: string): void => {
    const message = (content ?? composer).trim()
    if (!message || busyRef.current || !messagesLoaded || !sessionId) return
    const controller = controllerRef.current
    if (!controller) return
    setStreamErrors((prev) => clearAgentStreamError(prev, sessionId))
    /** userMessageUuid 同时作为 IPC 幂等身份与 Renderer 乐观运行 token。 */
    const operationToken = window.crypto.randomUUID()
    /** 与主进程 completion.startedAt 共用的本轮代次。 */
    const startedAt = Date.now()
    updateLifecycle({
      type: 'optimistic-started',
      owner: { sessionId, projectId, canvasId, nodeId, title },
      token: operationToken,
      startedAt,
    })
    void controller.send(message, operationToken, startedAt).catch(() => undefined)
  }, [canvasId, composer, messagesLoaded, nodeId, projectId, sessionId, setStreamErrors, title, updateLifecycle])

  const persistedMessages = sessionId ? persistedMessagesMap.get(sessionId) ?? [] : []
  const visibleError = localError ?? (sessionId ? streamErrors.get(sessionId) ?? null : null)
  /** stream 与 bootstrap 任一仍忙时均保持 STOP 可用、SEND 禁用。 */
  const running = sessionId !== null && (
    runningSessionIds.has(sessionId) || streamState?.running === true || streamState?.backgroundWaiting === true
  )
  /** 本地 IPC 发送期与权威运行态的统一忙碌值。 */
  const busy = sending || running
  busyRef.current = busy

  return (
    <aside className="absolute inset-y-0 right-0 z-20 flex w-full max-w-[min(28rem,100%)] flex-col border-l border-border bg-background shadow-lg">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{title}</h2>
        <TooltipProvider delayDuration={200} disableHoverableContent>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button type="button" size="icon" variant="ghost" aria-label="关闭对话" onClick={onClose}>
                <X className="size-4" aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>关闭对话</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </header>
      <div
        className="flex min-h-0 flex-1 flex-col overflow-hidden"
        data-canvas-agent-messages-region="true"
      >
        {!messagesLoaded ? (
          <div className="flex h-full items-center justify-center px-4 text-sm text-muted-foreground">
            {loadingError ?? <LoaderCircle className="size-5 animate-spin" aria-label="正在加载消息" />}
          </div>
        ) : sessionId ? (
          <AgentMessages
            sessionId={sessionId}
            messagesLoaded
            persistedSDKMessages={persistedMessages}
          />
        ) : null}
      </div>
      <div className="shrink-0 px-2.5 pb-2.5 md:px-[18px] md:pb-[18px]" data-input-mode="agent">
        <TooltipProvider delayDuration={200} disableHoverableContent>
          <AgentComposerFrame
            data-canvas-agent-composer="true"
            trailing={running ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className={inputToolbarDangerButtonClass}
                    aria-label="停止 Agent"
                    onClick={() => {
                      void controllerRef.current?.stop().catch((error: unknown) => {
                        setLocalError(getCanvasAgentConversationErrorMessage('stop', error))
                      })
                    }}
                  >
                    <Square className="size-[16px]" fill="currentColor" strokeWidth={0} aria-hidden="true" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top">停止 Agent</TooltipContent>
              </Tooltip>
            ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className={cn(
                    composer.trim().length > 0 && !busy && messagesLoaded && sessionId
                      ? inputToolbarSendButtonClass
                      : inputToolbarDisabledButtonClass,
                  )}
                  aria-label="发送消息"
                  disabled={busy || !messagesLoaded || !sessionId || composer.trim().length === 0}
                  onClick={() => submit(richTextInputRef.current?.getMarkdown())}
                >
                  {sending
                    ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
                    : <CornerDownLeft className="size-[22px]" aria-hidden="true" />}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">发送消息</TooltipContent>
            </Tooltip>
            )}
          >
            {visibleError ? (
              <p className="px-3 pt-2.5 text-xs text-destructive" role="alert">{visibleError}</p>
            ) : null}
            <RichTextInput
              ref={richTextInputRef}
              value={composer}
              onChange={setComposer}
              onSubmit={submit}
              placeholder="输入消息...（Enter 发送）"
              ariaLabel="Canvas Agent 消息输入"
              disabled={busy || !messagesLoaded || !sessionId}
              autoFocusTrigger={sessionId}
              collapsible
            />
          </AgentComposerFrame>
        </TooltipProvider>
      </div>
    </aside>
  )
}
