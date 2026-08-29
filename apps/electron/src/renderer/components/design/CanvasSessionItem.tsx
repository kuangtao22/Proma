import * as React from 'react'
import {
  CANVAS_SESSION_TITLE_MAX_LENGTH,
  LEGACY_DESIGN_CANVAS_ID,
  type CanvasSessionMeta,
} from '@proma/shared'
import { Archive, ArchiveRestore, MoreHorizontal, Pencil, Trash2, Workflow } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

export interface CanvasSessionItemProps {
  /** 当前项目中的 Canvas 会话元数据。 */
  session: CanvasSessionMeta
  /** 当前主视图是否正在展示该 Canvas。 */
  active: boolean
  /** 是否禁用主打开区域；归档列表用它阻止建立非法当前选择。 */
  selectDisabled?: boolean
  /** 打开当前 Canvas。 */
  onSelect: (session: CanvasSessionMeta) => void
  /** 提交规范化后的新标题。 */
  onRename: (session: CanvasSessionMeta, title: string) => Promise<void>
  /** 切换当前 Canvas 的归档状态。 */
  onToggleArchive: (session: CanvasSessionMeta) => Promise<void>
  /** 请求在上层展示不可恢复删除确认。 */
  onRequestDelete: (session: CanvasSessionMeta) => void
}

/** 项目侧栏中的紧凑 Canvas 会话行。 */
export function CanvasSessionItem({
  session,
  active,
  selectDisabled = false,
  onSelect,
  onRename,
  onToggleArchive,
  onRequestDelete,
}: CanvasSessionItemProps): React.ReactElement {
  const [editing, setEditing] = React.useState(false)
  const [titleDraft, setTitleDraft] = React.useState(session.title)
  const inputRef = React.useRef<HTMLInputElement>(null)
  /** 旧版默认画布仍引用项目级共享存储，不能按原生 Canvas 目录删除。 */
  const deleteDisabled = session.id === LEGACY_DESIGN_CANVAS_ID

  /** 进入行内标题编辑并在布局完成后选中文本。 */
  const startRenaming = (): void => {
    setTitleDraft(session.title)
    setEditing(true)
    setTimeout(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 0)
  }

  /** 只在标题真实变化时调用主进程更新。 */
  const commitRename = async (): Promise<void> => {
    const title = titleDraft.trim()
    if (!title || title === session.title) {
      setEditing(false)
      return
    }
    await onRename(session, title)
    setEditing(false)
  }

  /** 处理行内编辑的提交与取消。 */
  const handleRenameKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      if (event.nativeEvent.isComposing) return
      event.preventDefault()
      void commitRename()
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      setEditing(false)
    }
  }

  /** 当前归档动作的稳定中文标签。 */
  const archiveLabel = session.archived ? '取消归档 Canvas' : '归档 Canvas'

  return (
    <div
      className={cn(
        'group relative flex w-full items-center rounded-md text-left transition-colors duration-100 titlebar-no-drag',
        active
          ? 'canvas-session-item-active bg-foreground/[0.08] text-foreground'
          : 'text-foreground/80 hover:bg-foreground/[0.03]',
      )}
    >
      {editing ? (
        <div className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 pl-2.5 pr-1">
          <Workflow
            size={13}
            className={cn('shrink-0', active ? 'text-primary' : 'text-foreground/40')}
            aria-hidden="true"
          />
          <input
            ref={inputRef}
            value={titleDraft}
            maxLength={CANVAS_SESSION_TITLE_MAX_LENGTH}
            onChange={(event) => setTitleDraft(event.target.value)}
            onKeyDown={handleRenameKeyDown}
            onBlur={() => { void commitRename() }}
            aria-label="Canvas 标题"
            className="min-w-0 flex-1 border-b border-primary/50 bg-transparent px-0 py-0 text-[13px] leading-5 text-foreground outline-none"
          />
        </div>
      ) : (
        <button
          type="button"
          role="button"
          tabIndex={0}
          aria-current={active ? 'page' : undefined}
          disabled={selectDisabled}
          onClick={() => onSelect(session)}
          onDoubleClick={selectDisabled ? undefined : startRenaming}
          className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 pl-2.5 pr-1 text-left outline-none focus-visible:ring-1 focus-visible:ring-primary/45 disabled:cursor-default"
        >
          <Workflow
            size={13}
            className={cn('shrink-0', active ? 'text-primary' : 'text-foreground/40')}
            aria-hidden="true"
          />
          <span className="block min-w-0 flex-1 truncate text-[13px] leading-[18px]">
            {session.title}
          </span>
        </button>
      )}

      {!editing && (
        <div
          className="flex shrink-0 items-center pr-1.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={archiveLabel}
                onClick={() => { void onToggleArchive(session) }}
                className="flex size-[22px] items-center justify-center rounded-md text-foreground/45 transition-colors hover:bg-foreground/[0.055] hover:text-foreground/70"
              >
                {session.archived ? <ArchiveRestore size={12} /> : <Archive size={12} />}
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">{archiveLabel}</TooltipContent>
          </Tooltip>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="Canvas 会话菜单"
                className="flex size-[22px] items-center justify-center rounded-md text-foreground/45 transition-colors hover:bg-foreground/[0.055] hover:text-foreground/70"
              >
                <MoreHorizontal size={13} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="z-[9999] w-40 min-w-0 p-0.5">
              <DropdownMenuItem
                className="py-1 text-xs [&>svg]:size-3.5"
                onSelect={startRenaming}
              >
                <Pencil size={14} />
                重命名
              </DropdownMenuItem>
              <DropdownMenuItem
                className="py-1 text-xs [&>svg]:size-3.5"
                onSelect={() => { void onToggleArchive(session) }}
              >
                {session.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
                {session.archived ? '取消归档' : '归档'}
              </DropdownMenuItem>
              <DropdownMenuItem
                className="py-1 text-xs text-destructive focus:text-destructive [&>svg]:size-3.5"
                disabled={deleteDisabled}
                title={deleteDisabled ? '旧版默认设计画布不能删除' : undefined}
                onSelect={() => onRequestDelete(session)}
              >
                <Trash2 size={14} />
                删除 Canvas
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
    </div>
  )
}
