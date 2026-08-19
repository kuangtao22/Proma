import { useCallback, useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import {
  Bot,
  Check,
  ChevronDown,
  Compass,
  Cpu,
  Map,
  Search,
  Send,
  Square,
  X,
  Zap,
} from 'lucide-react'
import {
  activeConvAtom, tokenAtom, streamingAtom, streamContentAtom, messagesAtom,
  settingsModelIdAtom, settingsChannelBaseUrlAtom, settingsChannelIdAtom, channelsAtom,
  permissionModeAtom, PERMISSION_MODE_ORDER, PERMISSION_MODE_CONFIG,
  type ChannelInfo, type PermissionMode,
} from '../../atoms'
import { wsReq } from '../../lib/ws-client'
import { formatModel } from '../../utils/format'

export function InputBar({ disabled }: { disabled?: boolean }) {
  const [text, setText] = useState('')
  const active = useAtomValue(activeConvAtom)
  const token = useAtomValue(tokenAtom)
  const [streaming, setStreaming] = useAtom(streamingAtom)
  const setStreamContent = useSetAtom(streamContentAtom)
  const setMessages = useSetAtom(messagesAtom)
  const [modelId, setModelId] = useAtom(settingsModelIdAtom)
  const [, setChannelBaseUrl] = useAtom(settingsChannelBaseUrlAtom)
  const [channelId, setChannelId] = useAtom(settingsChannelIdAtom)
  const [permMode, setPermMode] = useAtom(permissionModeAtom)
  const channels = useAtomValue(channelsAtom)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const modelButtonRef = useRef<HTMLButtonElement>(null)
  const [modelPickerOpen, setModelPickerOpen] = useState(false)

  const handleSend = useCallback(async () => {
    const msg = text.trim()
    if (!msg || !active || !token) return
    setText('')
    if (taRef.current) { taRef.current.style.height = 'auto' }

    setMessages(prev => [...prev, { id: 'local-' + Date.now(), role: 'user', content: msg, createdAt: Date.now() }])

    setStreaming(true)
    setStreamContent('')
    try {
      if (active.type === 'agent') {
        await wsReq('agent.send', {
          token,
          sessionId: active.id,
          userMessage: msg,
          modelId: modelId || undefined,
          permissionMode: permMode,
        }, 15000)
      } else {
        await wsReq('conversations.send', {
          token,
          conversationId: active.id,
          userMessage: msg,
          channelId: channelId || undefined,
          modelId: modelId || undefined,
        }, 15000)
      }
    } catch {
      setStreaming(false)
    }
  }, [text, active, token, modelId, channelId, permMode])

  const handleStop = useCallback(async () => {
    if (!active || !token) return
    try {
      if (active.type === 'agent') {
        await wsReq('agent.stop', { token, sessionId: active.id })
      } else {
        await wsReq('conversations.stop', { token, conversationId: active.id })
      }
    } catch {}
    setStreaming(false)
  }, [active, token])

  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      handleSend()
    }
  }, [handleSend])

  useEffect(() => {
    if (taRef.current && text) {
      taRef.current.style.height = 'auto'
      taRef.current.style.height = Math.min(taRef.current.scrollHeight, 120) + 'px'
    }
  }, [text])

  const cyclePermMode = useCallback(() => {
    const idx = PERMISSION_MODE_ORDER.indexOf(permMode)
    setPermMode(PERMISSION_MODE_ORDER[(idx + 1) % PERMISSION_MODE_ORDER.length])
  }, [permMode, setPermMode])

  /** 关闭模型弹层，并把键盘焦点恢复到打开弹层的按钮。 */
  const closeModelPicker = useCallback(() => {
    setModelPickerOpen(false)
    /** 等弹层卸载后再恢复焦点，避免浏览器把焦点留在已移除的节点。 */
    const restoreFocus = () => modelButtonRef.current?.focus()
    if (typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(restoreFocus)
    } else {
      restoreFocus()
    }
  }, [])

  const handleSelectModel = useCallback((chId: string, mId: string) => {
    setChannelId(chId)
    setModelId(mId)
    const ch = channels.find(c => c.id === chId)
    setChannelBaseUrl(ch?.baseUrl ?? null)
    closeModelPicker()
  }, [channels, closeModelPicker, setChannelId, setModelId, setChannelBaseUrl])

  const modelName = formatModel(modelId)
  const permConfig = PERMISSION_MODE_CONFIG[permMode]

  return (
    <div className="relative flex-shrink-0 bg-content px-2.5 pt-1" style={{ paddingBottom: 'calc(var(--safe-b, 0px) + 10px)' }}>
      {/* 移动版桌面输入容器 */}
      <div className="rounded-lg border border-border bg-input-surface shadow-sm transition-colors focus-within:border-foreground/25 focus-within:ring-2 focus-within:ring-ring/10">
        {/* 文本输入 */}
        <textarea
          aria-label="消息输入"
          ref={taRef}
          value={text}
          onChange={e => { setText(e.target.value) }}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          placeholder={active?.type === 'agent' ? '发送消息给 Agent...' : '输入消息...'}
          rows={1}
          className="w-full resize-none bg-transparent px-3.5 pb-1 pt-3 text-sm leading-5 text-foreground outline-none placeholder:text-muted-foreground"
          style={{ minHeight: '44px', maxHeight: '120px' }}
        />

        {/* 底部工具栏 */}
        <div className="flex min-h-11 items-center justify-between gap-2 px-2 py-1.5">
          {/* 左侧工具 */}
          <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden">
            {/* 模型选择器按钮 */}
            <button
              ref={modelButtonRef}
              aria-label="选择模型"
              aria-expanded={modelPickerOpen}
              aria-haspopup="dialog"
              onClick={() => setModelPickerOpen(true)}
              className="flex min-h-8 min-w-0 items-center gap-1 rounded-md px-2 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <Cpu aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
              <span className="max-w-[88px] truncate">{modelName || '选择模型'}</span>
              <ChevronDown aria-hidden="true" className="h-3 w-3 shrink-0" />
            </button>

            {/* 权限模式切换 */}
            <button
              aria-label={`切换权限模式，当前${permConfig.label}`}
              onClick={cyclePermMode}
              className="flex min-h-8 min-w-0 items-center gap-1 rounded-md px-2 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              title={`${permConfig.label}：${permConfig.description}`}
            >
              <ModeIcon mode={permMode} />
              <span className="truncate">{permConfig.label}</span>
            </button>
          </div>

          {/* 右侧发送/停止 */}
          {streaming ? (
            <button
              aria-label="停止生成"
              onClick={handleStop}
              className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md bg-destructive/10 text-destructive transition-colors hover:bg-destructive/20"
            >
              <Square aria-hidden="true" className="h-3.5 w-3.5 fill-current" />
            </button>
          ) : (
            <button
              aria-label="发送消息"
              onClick={handleSend}
              disabled={!text.trim() || disabled}
              className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-25"
            >
              <Send aria-hidden="true" className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      {/* 模型选择弹窗 */}
      {modelPickerOpen && (
        <ModelPickerDialog
          channelId={channelId}
          modelId={modelId}
          channels={channels}
          onSelect={handleSelectModel}
          onClose={closeModelPicker}
        />
      )}
    </div>
  )
}

// ===== 模型选择面板 =====

interface ModelPickerProps {
  channelId: string | null
  modelId: string | null
  channels: ChannelInfo[]
  onSelect: (channelId: string, modelId: string) => void
}

interface ModelPickerDialogProps extends ModelPickerProps {
  onClose: () => void
}

/** 使用浏览器原生模态能力承载模型选择，自动限制焦点并支持 Escape。 */
export function ModelPickerDialog({
  channelId,
  modelId,
  channels,
  onSelect,
  onClose,
}: ModelPickerDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog || dialog.open) return
    dialog.showModal()
  }, [])

  return (
    <dialog
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="模型选择"
      onCancel={event => {
        event.preventDefault()
        onClose()
      }}
      onClick={event => {
        if (event.target === event.currentTarget) onClose()
      }}
      className="model-picker-dialog fixed inset-x-0 bottom-0 top-auto z-40 m-0 w-full max-w-none overflow-hidden rounded-t-lg border border-b-0 border-border bg-popover p-0 text-popover-foreground shadow-xl animate-dropdown-in"
      style={{ maxHeight: 'min(70dvh, 560px)', paddingBottom: 'var(--safe-b)' }}
    >
      <div className="flex h-11 items-center justify-between border-b border-border px-3.5">
        <h2 className="text-sm font-medium text-foreground">选择模型</h2>
        <button
          type="button"
          aria-label="关闭模型选择"
          onClick={onClose}
          className="flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <X aria-hidden="true" className="h-4 w-4" />
        </button>
      </div>
      <ModelPicker
        channelId={channelId}
        modelId={modelId}
        channels={channels}
        onSelect={onSelect}
      />
    </dialog>
  )
}

/** 渲染按渠道分组且可搜索的模型列表。 */
export function ModelPicker({ channelId, modelId, channels, onSelect }: ModelPickerProps) {
  const [search, setSearch] = useState('')
  /** 使用不区分大小写的查询匹配模型名称和 ID。 */
  const query = search.toLowerCase()

  /** 仅保留包含匹配模型的渠道，空结果不制造占位数据。 */
  const filtered = channels
    .map(ch => ({
      ...ch,
      models: ch.models.filter(m => !query || m.name.toLowerCase().includes(query) || m.id.toLowerCase().includes(query)),
    }))
    .filter(ch => ch.models.length > 0)

  return (
    <div className="flex flex-col" style={{ maxHeight: 'calc(min(70dvh, 560px) - 44px - var(--safe-b))' }}>
      {/* 搜索栏 */}
      <div className="flex flex-shrink-0 items-center gap-2 border-b border-border px-3.5 py-3">
        <Search aria-hidden="true" className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
        <input
          aria-label="搜索模型"
          type="text" value={search} onChange={e => setSearch(e.target.value)}
          placeholder="搜索模型..." autoFocus
          className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground/60"
        />
      </div>

      {/* 模型列表 */}
      <div className="overflow-y-auto overscroll-contain">
        {filtered.length === 0 ? (
          <p className="text-center text-muted-foreground text-xs py-6">未找到模型</p>
        ) : filtered.map(ch => (
          <div key={ch.id}>
            {/* 供应商标题 */}
            <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-4 py-2">
              <Bot aria-hidden="true" className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-xs font-medium text-muted-foreground truncate">{ch.name}</span>
            </div>
            {/* 模型列表 */}
            {ch.models.map(m => {
              const selected = ch.id === channelId && m.id === modelId
              return (
                <button key={m.id} onClick={() => onSelect(ch.id, m.id)}
                  className={`flex min-h-11 w-full items-center gap-2 px-4 py-2 text-left text-sm transition-colors ${selected ? 'bg-accent text-foreground' : 'text-foreground/80 hover:bg-accent/70'}`}>
                  <Cpu aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate flex-1">{m.name}</span>
                  {selected && (
                    <Check aria-label="已选择" className="h-4 w-4 flex-shrink-0 text-foreground" strokeWidth={2.2} />
                  )}
                </button>
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}

// ===== 权限模式图标 =====

function ModeIcon({ mode }: { mode: PermissionMode }) {
  if (mode === 'auto') {
    return <Compass aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
  }
  if (mode === 'bypassPermissions') {
    return <Zap aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
  }
  // plan
  return <Map aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
}
