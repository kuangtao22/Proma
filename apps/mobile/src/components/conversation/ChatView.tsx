import { useCallback, useEffect, useRef } from 'react'
import { useAtom, useAtomValue } from 'jotai'
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

function fetchMessages(type: string, token: string, id: string): Promise<MessagesResponse> {
  const cmd = type === 'agent' ? 'agent.sessions.messages' : 'conversations.messages'
  const idKey = type === 'agent' ? 'sessionId' : 'conversationId'
  return wsReq(cmd, { token, [idKey]: id }) as Promise<MessagesResponse>
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

  /** 按触发原因加载当前历史，后台刷新不提前清空现有消息。 */
  const loadMessages = useCallback((reason: MessageLoadReason) => {
    const generation = historyGenerations.current.begin()
    if (!activeId || !activeType || !token) return
    if (shouldClearMessagesBeforeLoad(reason)) setMessages([])
    fetchMessages(activeType, token, activeId)
      .then(d => {
        if (historyGenerations.current.isCurrent(generation)) setMessages(d.messages ?? [])
      })
      .catch(() => {
        if (historyGenerations.current.isCurrent(generation) && shouldClearMessagesBeforeLoad(reason)) {
          setMessages([])
        }
      })
  }, [activeId, activeType, setMessages, token])

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

  return (
    <div className="flex flex-col h-full">
      <div ref={listRef} className="flex-1 overflow-y-auto overflow-x-hidden min-w-0 px-4 py-3 space-y-4">
        <MessageList messages={messages} />
        {streaming && streamContent && (
          <div className="flex gap-2 min-w-0">
            <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-indigo-500 to-purple-500 flex items-center justify-center text-white text-[10px] font-bold flex-shrink-0">AI</div>
            <div className="flex-1 min-w-0 bg-muted rounded-xl rounded-tl-sm px-3 py-2 text-sm text-foreground">
              <div className="prose prose-sm prose-invert max-w-none break-words" dangerouslySetInnerHTML={{ __html: renderMd(streamContent) }} />
              <span className="inline-block w-1.5 h-4 bg-foreground/40 animate-pulse ml-0.5 align-middle" />
            </div>
          </div>
        )}
      </div>

      <InputBar disabled={streaming} />
    </div>
  )
}
