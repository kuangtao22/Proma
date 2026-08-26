import * as React from 'react'
import type {
  CanvasAgentMessagesResult,
  CanvasAgentTarget,
  GetCanvasAgentMessagesInput,
  SendCanvasAgentMessageInput,
  StopCanvasAgentInput,
} from '@proma/shared'
import { useAtomValue, useSetAtom } from 'jotai'
import { LoaderCircle, Send, Square, X } from 'lucide-react'
import {
  agentSessionStreamingStateAtomFamily,
  agentStreamErrorsAtom,
} from '@/atoms/agent-atoms'
import {
  canvasAgentOwnersAtom,
  canvasAgentPersistedMessagesAtom,
} from '@/atoms/native-canvas-atoms'
import { AgentMessages } from '@/components/agent/AgentMessages'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import type { CanvasAgentOwner } from '@/lib/canvas-agent-event-routing'

/** 对话组件使用的 Canvas adapter 最小合同。 */
export interface CanvasAgentConversationAdapter {
  getCanvasAgentMessages: (input: GetCanvasAgentMessagesInput) => Promise<CanvasAgentMessagesResult>
  sendCanvasAgentMessage: (input: SendCanvasAgentMessageInput) => Promise<void>
  stopCanvasAgent: (input: StopCanvasAgentInput) => Promise<void>
}

/** 无 React 请求控制器的依赖。 */
export interface CanvasAgentConversationControllerDependencies {
  load: () => Promise<CanvasAgentMessagesResult>
  send: (message: string, userMessageUuid: string, startedAt: number) => Promise<void>
  stop: () => Promise<void>
  onLoaded: (result: CanvasAgentMessagesResult) => void
  onComposerChange: (value: string) => void
  onSendingChange: (sending: boolean) => void
  onError: (error: string | null) => void
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
      composerRestore = message
      dependencies.onComposerChange('')
      dependencies.onSendingChange(true)
      dependencies.onError(null)
      const request = dependencies.send(message, userMessageUuid, startedAt).catch((error: unknown) => {
        if (!disposed) dependencies.onError(error instanceof Error ? error.message : '发送失败')
        throw error
      }).finally(() => {
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
  const setOwners = useSetAtom(canvasAgentOwnersAtom)
  const setPersistedMessages = useSetAtom(canvasAgentPersistedMessagesAtom)
  const persistedMessagesMap = useAtomValue(canvasAgentPersistedMessagesAtom)
  const streamErrors = useAtomValue(agentStreamErrorsAtom)
  const streamState = useAtomValue(agentSessionStreamingStateAtomFamily(sessionId ?? ''))
  const controllerRef = React.useRef<CanvasAgentConversationController | null>(null)

  React.useEffect(() => {
    let active = true
    setSessionId(null)
    setMessagesLoaded(false)
    setLoadingError(null)
    setLocalError(null)
    /** effect 内按稳定身份重建 target，避免父组件对象重建导致重复读取 JSONL。 */
    const currentTarget = { projectId, canvasId, nodeId }
    const controller = createCanvasAgentConversationController({
      load: () => getCanvasAgentMessages(currentTarget),
      send: (message, userMessageUuid, startedAt) => sendCanvasAgentMessage({
        ...currentTarget, message, userMessageUuid, startedAt,
      }),
      stop: () => stopCanvasAgent(currentTarget),
      onLoaded: (result) => {
        /** GET 返回的主进程 owner 成为未打开 Canvas 事件路由的 O(1) 本地索引。 */
        const owner: CanvasAgentOwner = {
          sessionId: result.sessionId,
          ...result.owner,
        }
        setSessionId(result.sessionId)
        setOwners((current) => new Map(current).set(result.sessionId, owner))
        setPersistedMessages((current) => new Map(current).set(result.sessionId, result.messages))
        setMessagesLoaded(true)
      },
      onComposerChange: setComposer,
      onSendingChange: setSending,
      onError: setLocalError,
    })
    controllerRef.current = controller
    void controller.load().catch((error: unknown) => {
      if (active) setLoadingError(error instanceof Error ? error.message : '消息加载失败')
    })
    return () => {
      active = false
      controller.dispose()
      if (controllerRef.current === controller) controllerRef.current = null
    }
  }, [canvasId, getCanvasAgentMessages, nodeId, projectId, sendCanvasAgentMessage, setOwners, setPersistedMessages, stopCanvasAgent])

  /** 提交当前纯文本；失败时恢复原文，避免用户输入丢失。 */
  const submit = React.useCallback((): void => {
    const message = composer.trim()
    if (!message || sending || !messagesLoaded || !sessionId) return
    const controller = controllerRef.current
    if (!controller) return
    void controller.send(message, window.crypto.randomUUID(), Date.now()).catch(() => {
      setComposer(controller.getComposerRestore())
    })
  }, [composer, messagesLoaded, sending, sessionId])

  const persistedMessages = sessionId ? persistedMessagesMap.get(sessionId) ?? [] : []
  const visibleError = localError ?? (sessionId ? streamErrors.get(sessionId) ?? null : null)
  const running = streamState?.running === true

  return (
    <aside className="absolute inset-y-0 right-0 z-20 flex w-full max-w-[min(28rem,100%)] flex-col border-l border-border bg-background shadow-lg">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{title}</h2>
        <TooltipProvider delayDuration={200} disableHoverableContent>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button type="button" size="icon" variant="ghost" aria-label="停止 Agent" disabled={!running} onClick={() => {
                void controllerRef.current?.stop().catch((error: unknown) => {
                  setLocalError(error instanceof Error ? error.message : '停止失败')
                })
              }}>
                <Square className="size-4" aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>停止 Agent</TooltipContent>
          </Tooltip>
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
      <div className="min-h-0 flex-1">
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
      <div className="shrink-0 border-t border-border p-3">
        {visibleError ? <p className="mb-2 text-xs text-destructive" role="alert">{visibleError}</p> : null}
        <div className="flex items-end gap-2">
          <textarea
            aria-label="Canvas Agent 消息输入"
            value={composer}
            rows={2}
            disabled={sending || !messagesLoaded || !sessionId}
            className="min-h-16 min-w-0 flex-1 resize-none rounded-[6px] border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onChange={(event) => setComposer(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                submit()
              }
            }}
          />
          <TooltipProvider delayDuration={200} disableHoverableContent>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button type="button" size="icon" aria-label="发送消息" disabled={sending || !messagesLoaded || !sessionId || composer.trim().length === 0} onClick={submit}>
                  {sending ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : <Send className="size-4" aria-hidden="true" />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>发送消息</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      </div>
    </aside>
  )
}
