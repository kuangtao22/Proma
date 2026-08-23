import type { MouseEvent } from 'react'
import { Star } from 'lucide-react'
import type { ConvItem } from '../../atoms'
import { normalizeAgentRuntimeStatus } from '../../lib/session-runtime-state'
import { formatRelativeTime } from '../../utils/format'

interface AgentSessionRowProps {
  session: ConvItem
  active: boolean
  onOpen: () => void
  onToggleStar: () => void
}

/** Agent 四态对应的可访问名称与色块样式。 */
const RUNTIME_STATUS_PRESENTATION = {
  idle: { label: '空闲', className: 'bg-muted-foreground/45' },
  running: { label: '运行中', className: 'bg-blue-500' },
  blocked: { label: '等待处理', className: 'bg-orange-500' },
  completed: { label: '已完成未查看', className: 'bg-green-500' },
} as const

/**
 * 渲染固定为“状态、标题、星标、时间”的 Agent 会话行。
 *
 * @param session 需要展示的 Agent 会话
 * @param active 当前是否正在查看该会话
 * @param onOpen 打开会话的回调
 * @param onToggleStar 切换星标的回调
 * @returns 可复用于抽屉和会话下拉框的会话行
 */
export function AgentSessionRow({
  session,
  active,
  onOpen,
  onToggleStar,
}: AgentSessionRowProps) {
  /** 未知服务端状态回落为空闲，保证旧客户端稳定渲染。 */
  const runtimeStatus = normalizeAgentRuntimeStatus(session.runtimeStatus)
  /** 当前四态的颜色与读屏语义。 */
  const presentation = RUNTIME_STATUS_PRESENTATION[runtimeStatus]
  /** 星标按钮独立拦截冒泡，避免同时打开会话。 */
  const handleToggleStar = (event: MouseEvent<HTMLButtonElement>): void => {
    event.stopPropagation()
    onToggleStar()
  }

  return (
    <div
      data-agent-session-row="four-column"
      className={`relative grid min-h-11 w-full grid-cols-[8px_minmax(0,1fr)_44px_44px] items-center gap-x-2 px-3.5 text-left transition-colors ${active ? 'bg-sidebar-control text-foreground' : 'text-foreground hover:bg-sidebar-control/70'}`}
    >
      <button
        type="button"
        aria-label={`打开会话：${session.title || '新对话'}`}
        onClick={onOpen}
        className="absolute inset-0 z-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      />

      <span
        aria-label={presentation.label}
        role="status"
        className={`pointer-events-none relative z-10 h-2 w-2 rounded-[2px] ${presentation.className}`}
      />
      <span className="pointer-events-none relative z-10 min-w-0 truncate text-sm">
        {session.title || '新对话'}
      </span>
      <button
        type="button"
        aria-label={session.starred ? '取消星标' : '添加星标'}
        aria-pressed={Boolean(session.starred)}
        onClick={handleToggleStar}
        className={`relative z-10 flex h-11 w-11 items-center justify-center text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${session.starred ? 'text-amber-500' : ''}`}
      >
        <Star
          aria-hidden="true"
          className="h-3.5 w-3.5"
          fill={session.starred ? 'currentColor' : 'none'}
        />
      </button>
      <span
        data-session-time
        className="pointer-events-none relative z-10 whitespace-nowrap text-right text-[10px] text-muted-foreground"
      >
        {session.updatedAt ? formatRelativeTime(session.updatedAt) : ''}
      </span>
    </div>
  )
}
