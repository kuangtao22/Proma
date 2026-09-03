import * as React from 'react'
import { LEGACY_DESIGN_CANVAS_ID } from '@proma/shared'
import type { CanvasSessionMeta } from '@proma/shared'
import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  MoreHorizontal,
  PanelLeftClose,
  Plus,
  Star,
  Trash2,
  Workflow,
} from 'lucide-react'
import type { AgentCanvasActivityState } from '@/atoms/agent-canvas-atoms'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

/** 画布抽屉内互斥异步动作的稳定身份。 */
export type CanvasSidebarPendingAction =
  | 'create:new'
  | `${'open' | 'default' | 'archive' | 'restore'}:${string}`

export interface RunCanvasSidebarNavigationActionOptions {
  /** 当前导航动作的稳定身份。 */
  pendingAction: CanvasSidebarPendingAction
  /** 执行宿主动作，并用布尔值表示是否真正成功。 */
  action: () => Promise<boolean>
  /** 同步抽屉内的互斥 pending 状态。 */
  onPendingChange: (pending: CanvasSidebarPendingAction | null) => void
  /** 成功后关闭当前 Pane 内的抽屉。 */
  onOpenChange: (open: boolean) => void
}

export interface CanvasWorkspaceSidebarProps {
  /** 抽屉是否在当前 Canvas Pane 内打开。 */
  open: boolean
  /** 当前 Pane 正在展示的画布 ID。 */
  currentCanvasId: string | null
  /** 当前项目的完整画布索引。 */
  sessions: readonly CanvasSessionMeta[]
  /** 当前 Agent 绑定的默认画布 ID。 */
  defaultCanvasId?: string
  /** 当前 Agent 按画布隔离的活动代次。 */
  activityStates: ReadonlyMap<string, AgentCanvasActivityState>
  /** 控制当前 Pane 内的抽屉开关。 */
  onOpenChange: (open: boolean) => void
  /** 新建并打开画布，返回是否成功。 */
  onCreateCanvas: () => Promise<boolean>
  /** 打开未归档画布，或恢复并打开归档画布。 */
  onOpenCanvas: (session: CanvasSessionMeta) => Promise<boolean>
  /** 把指定未归档画布设为默认。 */
  onSetDefaultCanvas: (session: CanvasSessionMeta) => Promise<boolean>
  /** 归档或恢复指定画布。 */
  onToggleArchiveCanvas: (session: CanvasSessionMeta) => Promise<boolean>
  /** 交给宿主打开共用的永久删除确认。 */
  onRequestDeleteCanvas: (session: CanvasSessionMeta) => void
  /** 记录理论上已被宿主收口的非预期异常。 */
  onUnexpectedError?: (context: string, error: unknown) => void
}

interface CanvasSidebarSessionRowProps {
  /** 当前列表行对应的画布元数据。 */
  session: CanvasSessionMeta
  /** 当前 Pane 是否正在展示该画布。 */
  current: boolean
  /** 该画布是否为当前 Agent 默认画布。 */
  isDefault: boolean
  /** 该画布是否存在未读活动。 */
  unread: boolean
  /** 抽屉当前互斥动作。 */
  pendingAction: CanvasSidebarPendingAction | null
  /** 点击画布主体时打开或恢复。 */
  onOpen: (session: CanvasSessionMeta) => void
  /** 把当前行设为默认。 */
  onSetDefault: (session: CanvasSessionMeta) => void
  /** 归档或恢复当前行。 */
  onToggleArchive: (session: CanvasSessionMeta) => void
  /** 请求永久删除当前行。 */
  onRequestDelete: (session: CanvasSessionMeta) => void
}

/** 按公开归档事实分组，保留 registry 原始顺序。 */
export function groupCanvasWorkspaceSessions(sessions: readonly CanvasSessionMeta[]): {
  active: CanvasSessionMeta[]
  archived: CanvasSessionMeta[]
} {
  return sessions.reduce((groups, session) => {
    groups[session.archived ? 'archived' : 'active'].push(session)
    return groups
  }, { active: [], archived: [] } as { active: CanvasSessionMeta[]; archived: CanvasSessionMeta[] })
}

/** legacy Design 只允许归档，不进入永久删除流程。 */
export function canDeleteCanvasFromWorkspaceSidebar(session: CanvasSessionMeta): boolean {
  return session.id !== LEGACY_DESIGN_CANVAS_ID
}

/** 执行抽屉导航动作；只有宿主明确成功时才关闭抽屉。 */
export async function runCanvasSidebarNavigationAction({
  pendingAction,
  action,
  onPendingChange,
  onOpenChange,
}: RunCanvasSidebarNavigationActionOptions): Promise<boolean> {
  onPendingChange(pendingAction)
  try {
    const succeeded = await action()
    if (succeeded) onOpenChange(false)
    return succeeded
  } finally {
    onPendingChange(null)
  }
}

/** 渲染单个画布行，并把低频管理动作收入口尾菜单。 */
function CanvasSidebarSessionRow({
  session,
  current,
  isDefault,
  unread,
  pendingAction,
  onOpen,
  onSetDefault,
  onToggleArchive,
  onRequestDelete,
}: CanvasSidebarSessionRowProps): React.ReactElement {
  /** 任一异步管理动作期间阻止重复提交。 */
  const disabled = pendingAction !== null
  /** legacy 画布不能进入不可恢复删除。 */
  const canDelete = canDeleteCanvasFromWorkspaceSidebar(session)
  return (
    <div className={cn(
      'group flex min-h-9 items-center gap-1 px-1.5 text-xs',
      current ? 'bg-primary/10 text-primary' : 'text-foreground hover:bg-muted/70',
    )}>
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-2 rounded-sm px-1.5 py-2 text-left outline-none focus-visible:ring-1 focus-visible:ring-ring"
        aria-current={current ? 'page' : undefined}
        disabled={disabled}
        onClick={() => onOpen(session)}
      >
        <Workflow className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">{session.title}</span>
        {isDefault ? <Star className="size-3.5 shrink-0 fill-current" aria-label="默认画布" /> : null}
        {unread ? <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-label="有新版本" /> : null}
      </button>
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="size-7 shrink-0 opacity-70 group-hover:opacity-100"
                aria-label={`管理画布：${session.title}`}
                disabled={disabled}
              >
                <MoreHorizontal className="size-3.5" aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="right">管理画布</TooltipContent>
        </Tooltip>
        <DropdownMenuContent side="right" align="start" className="z-[220] min-w-40">
          {!session.archived && !isDefault ? (
            <DropdownMenuItem onSelect={() => onSetDefault(session)}>
              <Star className="size-3.5" aria-hidden="true" />
              设为默认
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem onSelect={() => onToggleArchive(session)}>
            {session.archived
              ? <ArchiveRestore className="size-3.5" aria-hidden="true" />
              : <Archive className="size-3.5" aria-hidden="true" />}
            {session.archived ? '恢复' : '归档'}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!canDelete}
            title={!canDelete ? '旧版默认设计画布不能删除' : undefined}
            className="text-destructive focus:text-destructive"
            onSelect={() => onRequestDelete(session)}
          >
            <Trash2 className="size-3.5" aria-hidden="true" />
            删除画布
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

/** 在当前 Canvas Pane 内渲染默认收起的项目画布管理抽屉。 */
export function CanvasWorkspaceSidebar({
  open,
  currentCanvasId,
  sessions,
  defaultCanvasId,
  activityStates,
  onOpenChange,
  onCreateCanvas,
  onOpenCanvas,
  onSetDefaultCanvas,
  onToggleArchiveCanvas,
  onRequestDeleteCanvas,
  onUnexpectedError = (context, error) => {
    console.error(`[CanvasWorkspaceSidebar] ${context}出现非预期异常:`, error)
  },
}: CanvasWorkspaceSidebarProps): React.ReactElement | null {
  /** 抽屉内按公开归档事实分组的稳定列表。 */
  const groups = React.useMemo(() => groupCanvasWorkspaceSessions(sessions), [sessions])
  /** 归档区域默认关闭，避免低频内容挤占当前画布列表。 */
  const [archivedOpen, setArchivedOpen] = React.useState(false)
  /** 同一时刻只允许一个异步画布管理动作。 */
  const [pendingAction, setPendingAction] = React.useState<CanvasSidebarPendingAction | null>(null)
  /** 抽屉打开后接收初始键盘焦点。 */
  const closeButtonRef = React.useRef<HTMLButtonElement>(null)

  React.useEffect(() => {
    if (open) closeButtonRef.current?.focus()
  }, [open])

  /** 执行创建，并只在宿主明确成功后关闭抽屉。 */
  const handleCreate = React.useCallback((): void => {
    void runCanvasSidebarNavigationAction({
      pendingAction: 'create:new',
      action: onCreateCanvas,
      onPendingChange: setPendingAction,
      onOpenChange,
    }).catch((error: unknown) => onUnexpectedError('新建画布', error))
  }, [onCreateCanvas, onOpenChange, onUnexpectedError])

  /** 打开画布；点击当前项只负责关闭，不产生重复绑定请求。 */
  const handleOpen = React.useCallback((session: CanvasSessionMeta): void => {
    if (session.id === currentCanvasId && !session.archived) {
      onOpenChange(false)
      return
    }
    void runCanvasSidebarNavigationAction({
      pendingAction: `${session.archived ? 'restore' : 'open'}:${session.id}`,
      action: () => onOpenCanvas(session),
      onPendingChange: setPendingAction,
      onOpenChange,
    }).catch((error: unknown) => onUnexpectedError('打开画布', error))
  }, [currentCanvasId, onOpenCanvas, onOpenChange, onUnexpectedError])

  /** 执行不主动关闭抽屉的行级管理动作。 */
  const runManagementAction = React.useCallback((
    actionId: CanvasSidebarPendingAction,
    context: string,
    action: () => Promise<boolean>,
  ): void => {
    setPendingAction(actionId)
    void action()
      .catch((error: unknown) => onUnexpectedError(context, error))
      .finally(() => setPendingAction(null))
  }, [onUnexpectedError])

  /** 把指定未归档画布设为默认。 */
  const handleSetDefault = React.useCallback((session: CanvasSessionMeta): void => {
    runManagementAction(`default:${session.id}`, '设置默认画布', () => onSetDefaultCanvas(session))
  }, [onSetDefaultCanvas, runManagementAction])

  /** 归档或恢复指定画布；当前项回退由 SidePanel 宿主处理。 */
  const handleToggleArchive = React.useCallback((session: CanvasSessionMeta): void => {
    runManagementAction(
      `${session.archived ? 'restore' : 'archive'}:${session.id}`,
      session.archived ? '恢复画布' : '归档画布',
      () => onToggleArchiveCanvas(session),
    )
  }, [onToggleArchiveCanvas, runManagementAction])

  if (!open) return null

  /** 渲染列表行并从活动代次推导未读状态。 */
  const renderSessionRow = (session: CanvasSessionMeta): React.ReactElement => {
    /** 当前画布活动代次；不存在表示从未收到后台更新。 */
    const activity = activityStates.get(session.id)
    /** 活动代次超过已读代次时显示新版本圆点。 */
    const unread = activity ? activity.activityRevision > activity.seenActivityRevision : false
    return (
      <CanvasSidebarSessionRow
        key={session.id}
        session={session}
        current={session.id === currentCanvasId}
        isDefault={session.id === defaultCanvasId}
        unread={unread}
        pendingAction={pendingAction}
        onOpen={handleOpen}
        onSetDefault={handleSetDefault}
        onToggleArchive={handleToggleArchive}
        onRequestDelete={onRequestDeleteCanvas}
      />
    )
  }

  return (
    <TooltipProvider delayDuration={200} disableHoverableContent>
      <div className="absolute inset-0 z-30" data-canvas-sidebar-layer>
      <button
        type="button"
        className="absolute inset-0 cursor-default bg-background/35"
        aria-label="关闭画布列表"
        onClick={() => onOpenChange(false)}
      />
      <aside
        role="dialog"
        aria-modal="false"
        aria-label="项目画布"
        className="absolute inset-y-0 left-0 flex w-60 max-w-[80%] flex-col border-r border-border bg-background text-foreground shadow-xl"
      >
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-2">
          <span className="min-w-0 flex-1 truncate px-2 text-sm font-medium">项目画布</span>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                ref={closeButtonRef}
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="收起画布列表"
                onClick={() => onOpenChange(false)}
              >
                <PanelLeftClose className="size-3.5" aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right">收起画布列表</TooltipContent>
          </Tooltip>
        </div>
        <div className="border-b border-border p-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="w-full justify-start"
            disabled={pendingAction !== null}
            onClick={handleCreate}
          >
            <Plus className="size-3.5" aria-hidden="true" />
            新建画布
          </Button>
        </div>
        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-0.5 p-2">
            {groups.active.length > 0
              ? groups.active.map(renderSessionRow)
              : <p className="px-2 py-4 text-center text-xs text-muted-foreground">暂无画布</p>}
          </div>
          {groups.archived.length > 0 ? (
            <Collapsible open={archivedOpen} onOpenChange={setArchivedOpen}>
              <CollapsibleTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="w-full justify-start rounded-none border-t border-border px-4 text-muted-foreground"
                >
                  <ChevronDown className={cn('size-3.5 transition-transform', archivedOpen && 'rotate-180')} aria-hidden="true" />
                  已归档 {groups.archived.length}
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="space-y-0.5 p-2">{groups.archived.map(renderSessionRow)}</div>
              </CollapsibleContent>
            </Collapsible>
          ) : null}
        </ScrollArea>
      </aside>
      </div>
    </TooltipProvider>
  )
}
