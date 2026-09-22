import * as React from 'react'
import { FolderOpen, MoreHorizontal, PanelLeftClose, Pencil, Plus, Trash2 } from 'lucide-react'
import type { ServerOpsProject } from '@proma/shared'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { ServerOpsConnectionSummary } from './server-ops-connections'
import type { ServerOpsProjectsStatus } from './server-ops-project-controller'

/** 项目抽屉属性。 */
export interface ServerOpsProjectDrawerProps {
  open: boolean
  projects: readonly ServerOpsProject[]
  /** 当前项目；选择失效（已删除）时抽屉内部回落到第一项。 */
  selectedProjectId: string | null
  /** 各项目的连接统计；缺失按"暂无连接"处理。 */
  summaries: Readonly<Record<string, ServerOpsConnectionSummary>>
  /** 项目列表加载阶段；失败时在抽屉里给出原因与重试。 */
  status: ServerOpsProjectsStatus
  error?: string | null
  onSelectProject: (projectId: string) => void
  onOpenChange: (open: boolean) => void
  onRetry?: () => void
  /** 项目级管理入口；连接操作仍在项目内部。 */
  onCreateProject?: () => void
  onRenameProject?: (project: ServerOpsProject) => void
  onDeleteProject?: (project: ServerOpsProject) => void
  /** 子弹窗打开时暂停抽屉的键盘处理，交给 Radix 管理焦点。 */
  managementOpen?: boolean
}

/**
 * 把项目连接统计格式化为一行摘要。
 *
 * 抽屉一级不再展开连接，用户只能靠这行摘要判断项目里有什么，
 * 因此计数必须来自与项目视图同一份连接模型（`summarizeServerOpsConnections`）。
 *
 * @param summary 项目连接统计；缺省表示该项目没有任何连接
 * @returns 例如 `3 服务器 · 1 数据库 · 1 Redis`；空项目返回"暂无连接"
 */
export function formatServerOpsProjectSummary(summary?: ServerOpsConnectionSummary): string {
  if (!summary || summary.total === 0) return '暂无连接'
  return [
    summary.ssh === 0 ? undefined : `${summary.ssh} 服务器`,
    summary.database === 0 ? undefined : `${summary.database} 数据库`,
    summary.redis === 0 ? undefined : `${summary.redis} Redis`,
  ].filter((part): part is string => part !== undefined).join(' · ')
}

/** 选择项目并关闭当前 Pane 抽屉；进入项目视图由调用方负责。 */
export function selectServerOpsProjectFromDrawer(
  projectId: string,
  onSelect: (projectId: string) => void,
  onOpenChange: (open: boolean) => void,
): void {
  onSelect(projectId)
  onOpenChange(false)
}

/** 抽屉在项目尚未就绪时展示的说明文案。 */
function getProjectDrawerEmptyText(status: ServerOpsProjectsStatus, error: string | null): string {
  if (status === 'error') return error ?? '项目读取失败'
  if (status === 'loading' || status === 'idle') return '正在读取项目...'
  return '还没有项目，点击上方「添加项目」开始使用'
}

/** 抽屉内可参与键盘循环的原生交互元素选择器。 */
const SERVER_OPS_PROJECT_DRAWER_FOCUSABLE_SELECTOR = [
  'button:not([disabled]):not([tabindex="-1"])',
  'a[href]:not([tabindex="-1"])',
  'input:not([disabled]):not([tabindex="-1"])',
  'select:not([disabled]):not([tabindex="-1"])',
  'textarea:not([disabled]):not([tabindex="-1"])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

/**
 * 解析 Tab 到达首尾边界时应该回到的元素下标；中间位置交给浏览器原生顺序。
 *
 * @param currentIndex 当前焦点在抽屉可聚焦元素中的下标；不在列表中时为 -1
 * @param count 抽屉内可聚焦元素数量
 * @param backwards 是否为 Shift+Tab
 * @returns 需要主动聚焦的下标；无需干预时为 null
 */
export function resolveServerOpsProjectDrawerWrapIndex(
  currentIndex: number,
  count: number,
  backwards: boolean,
): number | null {
  if (count <= 0) return null
  if (backwards) return currentIndex <= 0 ? count - 1 : null
  return currentIndex < 0 || currentIndex >= count - 1 ? 0 : null
}

/**
 * 关闭抽屉后优先返回原触发器；项目切换使其卸载时回退同一 Pane 的新触发器。
 *
 * @param previousFocus 打开抽屉前的焦点
 * @param paneRoot 抽屉所属 Pane 根节点
 * @returns 可恢复的焦点目标
 */
export function resolveServerOpsProjectDrawerReturnFocus(
  previousFocus: HTMLElement | null,
  paneRoot: HTMLElement | null,
): HTMLElement | null {
  if (previousFocus?.isConnected) return previousFocus
  return paneRoot?.querySelector<HTMLElement>('button[aria-label="打开项目列表"]')
    ?? paneRoot?.querySelector<HTMLElement>('button[aria-label="切换运维项目"]')
    ?? null
}

/**
 * Canvas 风格的项目选择抽屉。
 *
 * 一级只有项目：服务器、数据库、Redis 都是项目内的连接，属于进入项目之后的事，
 * 因此这里只管理项目，连接的编辑与删除保留在项目内。
 *
 * @param props 项目列表、统计与回调
 * @returns 项目抽屉；关闭时返回 null
 */
export function ServerOpsProjectDrawer({
  open,
  projects,
  selectedProjectId,
  summaries,
  status,
  error = null,
  onSelectProject,
  onOpenChange,
  onRetry,
  onCreateProject,
  onRenameProject,
  onDeleteProject,
  managementOpen = false,
}: ServerOpsProjectDrawerProps): React.ReactElement | null {
  /** 抽屉打开后接收键盘焦点的收起按钮。 */
  const closeButtonRef = React.useRef<HTMLButtonElement>(null)
  /** 抽屉遮罩根，用于判断关闭瞬间焦点是否仍属于当前抽屉。 */
  const drawerRootRef = React.useRef<HTMLDivElement>(null)
  /** 抽屉可见面板，用于局部 Tab 首尾循环。 */
  const drawerPanelRef = React.useRef<HTMLElement>(null)
  /** 打开前的焦点；关闭时优先回到这里。 */
  const previousFocusRef = React.useRef<HTMLElement | null>(null)
  /** 抽屉所属 Pane；原触发器卸载时只在这个 Pane 内寻找替代入口。 */
  const paneRootRef = React.useRef<HTMLElement | null>(null)
  /** 只有从抽屉内部发起关闭时才恢复焦点，避免抢走另一 Pane 的主动焦点。 */
  const restoreFocusRef = React.useRef(false)

  /** 关闭抽屉，并记录当前焦点是否仍属于它。 */
  const closeDrawer = React.useCallback((): void => {
    restoreFocusRef.current = drawerRootRef.current?.contains(document.activeElement) === true
    onOpenChange(false)
  }, [onOpenChange])

  React.useEffect(() => {
    if (open) {
      /** 打开后记录原触发器和 Pane，随后把焦点放到抽屉首个命令。 */
      previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      paneRootRef.current = drawerRootRef.current?.parentElement ?? null
      closeButtonRef.current?.focus()
      return
    }
    if (!restoreFocusRef.current) return
    restoreFocusRef.current = false
    /** 若关闭提交后用户已主动聚焦其它 Pane，则不再覆盖其选择。 */
    if (document.activeElement !== document.body && document.activeElement !== document.documentElement) return
    resolveServerOpsProjectDrawerReturnFocus(previousFocusRef.current, paneRootRef.current)?.focus()
  }, [open])

  React.useEffect(() => {
    if (!open) return
    /** 处理当前 Pane 抽屉的 Escape 关闭语义。 */
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented || managementOpen) return
      /** Portal 内的菜单/弹窗拥有自己的 Escape，不得联动关闭抽屉。 */
      if (!(event.target instanceof Node) || !drawerPanelRef.current?.contains(event.target)) return
      closeDrawer()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [closeDrawer, managementOpen, open])

  /** 仅在抽屉面板内部循环 Tab，不监听全局 focusin，也不影响其它 Pane。 */
  const handlePanelKeyDown = (event: React.KeyboardEvent<HTMLElement>): void => {
    if (event.key !== 'Tab' || managementOpen || !event.currentTarget.contains(event.target as Node)) return
    /** 当前可见且可用的抽屉控件。 */
    const focusable = [...(drawerPanelRef.current?.querySelectorAll<HTMLElement>(SERVER_OPS_PROJECT_DRAWER_FOCUSABLE_SELECTOR) ?? [])]
      .filter((element) => !element.closest('[hidden],[aria-hidden="true"]'))
    /** 浏览器原生处理列表中间位置；这里只接管首尾边界。 */
    const wrapIndex = resolveServerOpsProjectDrawerWrapIndex(
      focusable.indexOf(document.activeElement as HTMLElement),
      focusable.length,
      event.shiftKey,
    )
    if (wrapIndex === null) return
    event.preventDefault()
    focusable[wrapIndex]?.focus()
  }

  if (!open) return null

  /** 当前生效的项目 ID；选择失效时回落第一项，界面不停留在已删除项目上。 */
  const currentProjectId = projects.some((project) => project.id === selectedProjectId)
    ? selectedProjectId
    : projects[0]?.id ?? null

  return (
    <TooltipProvider delayDuration={200} disableHoverableContent>
      <div ref={drawerRootRef} className="absolute inset-0 z-30" data-server-ops-project-drawer>
        <button
          type="button"
          tabIndex={-1}
          className="absolute inset-0 cursor-default bg-background/35"
          aria-label="关闭项目列表"
          onClick={closeDrawer}
        />
        <aside
          ref={drawerPanelRef}
          role="dialog"
          aria-modal="false"
          aria-label="项目列表"
          className="absolute inset-y-0 left-0 flex w-72 max-w-[88%] flex-col border-r border-border/40 bg-content-area text-foreground shadow-xl"
          onKeyDown={handlePanelKeyDown}
        >
          <div className="flex min-h-14 shrink-0 items-center gap-2 border-b border-border/40 px-4 py-2">
            <div className="min-w-0 flex-1">
              <span className="block truncate text-xs font-medium">项目</span>
              <span className="block text-[11px] text-muted-foreground">选择运维工作范围</span>
            </div>
            {onCreateProject ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button type="button" variant="ghost" size="icon-sm" aria-label="添加项目" disabled={status !== 'ready'} onClick={onCreateProject}>
                    <Plus className="size-3.5" aria-hidden="true" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="right">添加项目</TooltipContent>
              </Tooltip>
            ) : null}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  ref={closeButtonRef}
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="收起项目列表"
                  onClick={closeDrawer}
                >
                  <PanelLeftClose className="size-3.5" aria-hidden="true" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">收起项目列表</TooltipContent>
            </Tooltip>
          </div>
          <ScrollArea className="min-h-0 flex-1">
            <div className="divide-y divide-border/30" data-server-ops-project-list>
              {projects.length === 0 ? (
                /*
                 * 项目读取中、失败或为空时如实说明原因：
                 * 这里不再回退成"全部服务器"，否则一级列表会给用户两套互相矛盾的层级。
                 */
                <div className="px-4 py-6 text-center">
                  <p className="text-[11px] text-muted-foreground" data-server-ops-project-empty>
                    {getProjectDrawerEmptyText(status, error)}
                  </p>
                  {status === 'error' && onRetry ? (
                    <Button type="button" variant="outline" size="sm" className="mt-2" onClick={onRetry}>
                      重试
                    </Button>
                  ) : null}
                </div>
              ) : projects.map((project) => {
                /** 当前项目是否为正在展示的项目。 */
                const current = project.id === currentProjectId
                return (
                  <div
                    key={project.id}
                    className={cn(
                      'flex min-h-14 w-full items-center pr-3 transition-colors',
                      current ? 'bg-muted/70 text-foreground' : 'hover:bg-muted/35',
                    )}
                  >
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-center gap-3 px-4 py-2.5 text-left outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
                      aria-current={current ? 'page' : undefined}
                      data-server-ops-project={project.id}
                      onClick={() => selectServerOpsProjectFromDrawer(project.id, onSelectProject, () => closeDrawer())}
                    >
                      <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-medium">{project.name}</span>
                        {/* 抽屉一级只有项目，连接清单在项目视图里，因此这里给出与之一致的统计。 */}
                        <span
                          className="mt-0.5 block truncate text-[11px] text-muted-foreground tabular-nums"
                          data-server-ops-project-summary={project.id}
                        >
                          {formatServerOpsProjectSummary(summaries[project.id])}
                        </span>
                      </span>
                    </button>
                    {onRenameProject || onDeleteProject ? (
                      <DropdownMenu modal={false}>
                        <DropdownMenuTrigger asChild>
                          <Button type="button" variant="ghost" size="icon-sm" className="shrink-0 text-muted-foreground" aria-label={`管理项目：${project.name}`}>
                            <MoreHorizontal className="size-3.5" aria-hidden="true" />
                          </Button>
                        </DropdownMenuTrigger>
                        {/* Portal 挂在 body：沿用侧栏菜单层级，避免被 AppShell 的 z-[60] 内容层遮挡。 */}
                        <DropdownMenuContent className="z-[9999]" align="start" side="right" onEscapeKeyDown={(event) => event.stopPropagation()}>
                          {onRenameProject ? <DropdownMenuItem onSelect={() => onRenameProject(project)}><Pencil aria-hidden="true" />修改名称</DropdownMenuItem> : null}
                          {onRenameProject && onDeleteProject ? <DropdownMenuSeparator /> : null}
                          {onDeleteProject ? <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => onDeleteProject(project)}><Trash2 aria-hidden="true" />删除项目</DropdownMenuItem> : null}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : null}
                  </div>
                )
              })}
            </div>
          </ScrollArea>
        </aside>
      </div>
    </TooltipProvider>
  )
}
