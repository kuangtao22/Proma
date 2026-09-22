import * as React from 'react'
import { ChevronDown, FolderOpen, Settings2 } from 'lucide-react'
import type { ServerOpsProject } from '@proma/shared'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'

/** 项目选择只使用工作区已加载的清单，切换交给既有离开检查处理。 */
interface ServerOpsProjectSelectorProps {
  projects: readonly ServerOpsProject[]
  projectId: string | null
  onSelectProject: (projectId: string) => void
  /** 项目列表页把管理动作收进同一个菜单；连接页保留既有抽屉入口。 */
  onManageProjects?: () => void
}

/** 根据当前项目显示下拉入口；返回可键盘操作且长名称可省略的选择器。 */
export function ServerOpsProjectSelector({ projects, projectId, onSelectProject, onManageProjects }: ServerOpsProjectSelectorProps): React.ReactElement {
  /** 失效身份不显示旧项目名，等待工作区完成回落。 */
  const project = projects.find((entry) => entry.id === projectId)
  /** 菜单关闭后先恢复入口焦点，再打开抽屉，避免两层自动聚焦相互覆盖。 */
  const manageRequestedRef = React.useRef(false)
  /** 抽屉关闭时可返回的稳定项目入口。 */
  const triggerRef = React.useRef<HTMLButtonElement>(null)
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button ref={triggerRef} type="button" variant="outline" disabled={projects.length === 0 && !onManageProjects} className="h-8 w-full min-w-0 gap-2 rounded-md border-border/60 bg-background/40 px-2.5 py-0 text-xs font-normal [&>svg]:shrink-0" aria-label="切换运维项目" title={project?.name}>
          <FolderOpen className="size-3.5 text-muted-foreground" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate text-left">{project?.name ?? '选择项目'}</span>
          <ChevronDown className="size-4 text-muted-foreground" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="z-[240] min-w-[var(--radix-dropdown-menu-trigger-width)] max-w-[calc(100vw-2rem)]" onCloseAutoFocus={(event) => {
        if (!manageRequestedRef.current) return
        event.preventDefault()
        manageRequestedRef.current = false
        triggerRef.current?.focus()
        onManageProjects?.()
      }}>
        <div className="max-h-72 overflow-y-auto">
          <DropdownMenuRadioGroup value={project?.id ?? ''} onValueChange={(id) => { if (id !== project?.id) onSelectProject(id) }}>
            {projects.map((entry) => <DropdownMenuRadioItem key={entry.id} value={entry.id} title={entry.name} className="text-xs"><span className="truncate">{entry.name}</span></DropdownMenuRadioItem>)}
          </DropdownMenuRadioGroup>
          {projects.length === 0 ? <DropdownMenuItem disabled className="text-xs">暂无项目</DropdownMenuItem> : null}
        </div>
        {onManageProjects ? <><DropdownMenuSeparator /><DropdownMenuItem className="text-xs" onSelect={() => { manageRequestedRef.current = true }}><Settings2 className="size-3.5" aria-hidden="true" />管理项目</DropdownMenuItem></> : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** 连接身份与操作由详情提供，项目和授权仍由工作区统一管理。 */
export interface ServerOpsWorkspaceToolbarContent {
  connection?: React.ReactNode
  connectionActions?: React.ReactNode
  /** 展开视图打开项目管理时，先还原所属 Pane。 */
  onManageProjects?: () => void
}

/** 顶部集中呈现项目与连接身份，数据库范围由下一层工作台导航承载。 */
interface ServerOpsWorkspaceToolbarProps extends ServerOpsProjectSelectorProps, ServerOpsWorkspaceToolbarContent {
  actions?: React.ReactNode
}

/** 返回工作区顶部导航；宽 Pane 合为一行，窄 Pane 将连接身份排在项目下方。 */
export function ServerOpsWorkspaceToolbar({ projects, projectId, onSelectProject, onManageProjects, connection, connectionActions, actions }: ServerOpsWorkspaceToolbarProps): React.ReactElement {
  return (
    <div className={cn('titlebar-no-drag shrink-0 gap-x-3 gap-y-2 border-b border-border/40 px-3 py-2', connection ? 'server-ops-connection-header' : 'flex items-center')} data-server-ops-workspace-toolbar data-server-ops-toolbar={connection ? '' : undefined}>
      <div className="min-w-0 max-w-48 flex-1" style={{ gridArea: 'project' }}><ServerOpsProjectSelector projects={projects} projectId={projectId} onSelectProject={onSelectProject} onManageProjects={onManageProjects} /></div>
      {connection ? <div className="min-w-0" style={{ gridArea: 'identity' }}>{connection}</div> : null}
      {actions ? <div className="ml-auto flex h-8 shrink-0 items-center" style={{ gridArea: 'access' }}>{actions}</div> : null}
      {connectionActions ? <div className="flex shrink-0 items-center justify-end gap-1" style={{ gridArea: 'controls' }}>{connectionActions}</div> : null}
    </div>
  )
}
