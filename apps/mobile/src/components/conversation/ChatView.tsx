import { useCallback, useEffect, useRef, useState } from 'react'
import { useAtom, useAtomValue } from 'jotai'
import { Bot, LoaderCircle, MessageSquareText, RefreshCw } from 'lucide-react'
import {
  activeConvAtom, messagesAtom, tokenAtom,
  streamingAtom, streamContentAtom,
  type Message,
} from '../../atoms'
import { wsReq, onPush } from '../../lib/ws-client'
import {
  createGenerationTracker,
  shouldClearMessagesBeforeLoad,
  type MessageLoadReason,
} from '../../lib/recovery-guards'
import { InputBar } from './InputBar'
import { MessageList } from './MessageBubble'
import { renderMd } from '../../utils/markdown'

interface MessagesResponse { messages: Message[] }
interface StreamChunk { sessionId?: string; conversationId?: string; text?: string }
interface StreamEnd { sessionId?: string; conversationId?: string }
type HistoryLoadStatus = 'loading' | 'ready' | 'error'

interface HistoryState {
  conversationKey: string | null
  status: HistoryLoadStatus
}

interface ConversationHistoryStateProps {
  status: HistoryLoadStatus
  messageCount: number
  onRetry: () => void
}

function fetchMessages(type: string, token: string, id: string): Promise<MessagesResponse> {
  const cmd = type === 'agent' ? 'agent.sessions.messages' : 'conversations.messages'
  const idKey = type === 'agent' ? 'sessionId' : 'conversationId'
  return wsReq(cmd, { token, [idKey]: id }) as Promise<MessagesResponse>
}

/** 仅在历史状态属于当前会话时返回消息，避免切换瞬间显示旧会话内容。 */
export function selectVisibleMessages(
  messages: Message[],
  historyConversationKey: string | null,
  activeConversationKey: string | null,
): Message[] {
  return historyConversationKey === activeConversationKey ? messages : []
}

/** 渲染历史消息的加载、失败或真实空状态。 */
export function ConversationHistoryState({ status, messageCount, onRetry }: ConversationHistoryStateProps) {
  if (messageCount > 0) return null

  if (status === 'loading') {
    return (
      <div role="status" className="flex h-full min-h-48 flex-col items-center justify-center px-6 text-center text-muted-foreground">
        <LoaderCircle aria-hidden="true" className="mb-3 h-5 w-5 animate-spin" strokeWidth={1.7} />
        <p className="text-sm font-medium text-foreground/80">正在加载对话</p>
      </div>
    )
  }

  if (status === 'error') {
    return (
      <div role="alert" className="flex h-full min-h-48 flex-col items-center justify-center px-6 text-center text-muted-foreground">
        <p className="text-sm font-medium text-foreground/80">对话加载失败</p>
        <p className="mt-1 text-xs">请检查连接后重试</p>
        <button
          type="button"
          aria-label="重新加载对话"
          onClick={onRetry}
          className="mt-3 flex min-h-9 items-center gap-1.5 rounded-md border border-border px-3 text-xs font-medium text-foreground transition-colors hover:bg-accent"
        >
          <RefreshCw aria-hidden="true" className="h-3.5 w-3.5" />
          重试
        </button>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-48 flex-col items-center justify-center px-6 text-center text-muted-foreground">
      <MessageSquareText aria-hidden="true" className="mb-3 h-5 w-5" strokeWidth={1.7} />
      <p className="text-sm font-medium text-foreground/80">开始一段新对话</p>
      <p className="mt-1 text-xs">输入消息后，回复会显示在这里</p>
    </div>
  )
}

export function ChatView() {
  const [active] = useAtom(activeConvAtom)
  const [messages, setMessages] = useAtom(messagesAtom)
  const token = useAtomValue(tokenAtom)
  const [streaming, setStreaming] = useAtom(streamingAtom)
  const [streamContent, setStreamContent] = useAtom(streamContentAtom)
  const listRef = useRef<HTMLDivElement>(null)
  const streamTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** 历史加载与订阅各自使用 generation，避免互相误伤。 */
  const historyGenerations = useRef(createGenerationTracker())
  const subscriptionGenerations = useRef(createGenerationTracker())
  /** 使用原始字段作为依赖，避免同一会话对象刷新导致重复订阅。 */
  const activeId = active?.id
  const activeType = active?.type
  /** 会话键用于在 effect 执行前识别刚发生的会话切换。 */
  const activeKey = activeId && activeType ? `${activeType}:${activeId}` : null
  const [historyState, setHistoryState] = useState<HistoryState>(() => ({
    conversationKey: activeKey,
    status: 'loading',
  }))

  /** 按触发原因加载当前历史，后台刷新不提前清空现有消息。 */
  const loadMessages = useCallback((reason: MessageLoadReason) => {
    if (!activeId || !activeType || !token) return
    const generation = historyGenerations.current.begin()
    /** 请求捕获自己的会话键，防止晚到响应覆盖新会话状态。 */
    const conversationKey = `${activeType}:${activeId}`
    const clearsMessages = shouldClearMessagesBeforeLoad(reason)
    if (clearsMessages) {
      setMessages([])
      setHistoryState({ conversationKey, status: 'loading' })
    }
    fetchMessages(activeType, token, activeId)
      .then(d => {
        if (!historyGenerations.current.isCurrent(generation)) return
        setMessages(d.messages ?? [])
        setHistoryState({ conversationKey, status: 'ready' })
      })
      .catch(() => {
        if (historyGenerations.current.isCurrent(generation) && clearsMessages) {
          setMessages([])
          setHistoryState({ conversationKey, status: 'error' })
        }
      })
  }, [activeId, activeType, setMessages, token])

  /** 用户主动重试时重新进入前台加载态。 */
  const retryLoadMessages = useCallback(() => {
    loadMessages('active-change')
  }, [loadMessages])

  useEffect(() => {
    if (!activeId || !activeType || !token) {
      historyGenerations.current.invalidate()
      subscriptionGenerations.current.invalidate()
      return
    }
    loadMessages('active-change')
    const subKey = activeType === 'agent' ? 'sessionId' : 'conversationId'
    subscriptionGenerations.current.begin()
    void wsReq('subscribe', { token, [subKey]: activeId }).catch(() => {})
    return () => {
      historyGenerations.current.invalidate()
      subscriptionGenerations.current.invalidate()
      void wsReq('unsubscribe', { token, [subKey]: activeId }).catch(() => {})
    }
  }, [activeId, activeType, loadMessages, token])

  // WS 重连后重新加载
  useEffect(() => {
    const handler = () => {
      if (!activeId || !activeType || !token) return
      loadMessages('reconnect')
      const subKey = activeType === 'agent' ? 'sessionId' : 'conversationId'
      const generation = subscriptionGenerations.current.begin()
      void wsReq('unsubscribe', { token, [subKey]: activeId })
        .catch(() => {})
        .then(() => {
          if (!subscriptionGenerations.current.isCurrent(generation)) return
          return wsReq('subscribe', { token, [subKey]: activeId }).catch(() => {})
        })
    }
    window.addEventListener('proma:ws-reconnected', handler)
    return () => window.removeEventListener('proma:ws-reconnected', handler)
  }, [activeId, activeType, loadMessages, token])

  // 流式推送
  useEffect(() => {
    const unsub = onPush((msg) => {
      if (!active) return
      const d = msg.data as StreamChunk | StreamEnd
      const id = d.sessionId ?? d.conversationId
      if (id && id !== active.id) return

      switch (msg.type) {
        case 'stream.chunk':
        case 'stream.reasoning':
          if (streamTimeoutRef.current) { clearTimeout(streamTimeoutRef.current); streamTimeoutRef.current = null }
          if (!streaming) { setStreaming(true); setStreamContent('') }
          setStreamContent(prev => prev + ((d as StreamChunk).text ?? ''))
          break
        case 'stream.complete':
          if (streamTimeoutRef.current) { clearTimeout(streamTimeoutRef.current); streamTimeoutRef.current = null }
          setStreaming(false)
          loadMessages('stream-complete')
          break
        case 'stream.error':
          if (streamTimeoutRef.current) { clearTimeout(streamTimeoutRef.current); streamTimeoutRef.current = null }
          setStreaming(false)
          break
      }
    })
    return unsub
  }, [active, loadMessages, setStreamContent, setStreaming, streaming])

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight
  }, [messages, streamContent])

  if (!active) return null

  /** 会话刚切换但 effect 尚未执行时立即显示加载态，避免闪现错误空状态。 */
  const visibleHistoryStatus = historyState.conversationKey === activeKey
    ? historyState.status
    : 'loading'
  /** 消息列表与状态占位共用同一会话隔离结果。 */
  const visibleMessages = selectVisibleMessages(messages, historyState.conversationKey, activeKey)

  return (
    <div className="flex h-full flex-col bg-content">
      <div ref={listRef} className="min-w-0 flex-1 space-y-5 overflow-x-hidden overflow-y-auto px-3 py-4 sm:px-4">
        {!streaming && (
          <ConversationHistoryState
            status={visibleHistoryStatus}
            messageCount={visibleMessages.length}
            onRetry={retryLoadMessages}
          />
        )}
        <MessageList messages={visibleMessages} />
        {streaming && streamContent && (
          <article data-message-role="assistant" className="flex min-w-0 gap-2.5">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border bg-card text-card-foreground">
              <Bot aria-hidden="true" className="h-3.5 w-3.5 text-muted-foreground" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="mb-1 text-[11px] font-medium text-foreground/70">Proma</p>
              <div
                className="prose prose-sm max-w-none break-words text-sm leading-6 text-foreground [overflow-wrap:anywhere]"
                dangerouslySetInnerHTML={{ __html: renderMd(streamContent) }}
              />
              <span className="ml-0.5 inline-block h-3.5 w-1 animate-pulse bg-foreground/35 align-middle" />
            </div>
          </article>
        )}
      </div>

      <InputBar disabled={streaming} />
    </div>
  )
}
