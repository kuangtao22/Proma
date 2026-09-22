import * as React from 'react'
import { atom, useAtom } from 'jotai'
import { ArrowLeft, Database, DatabaseZap, Maximize2, Minimize2 } from 'lucide-react'
import type { ServerOpsDataSource } from '@proma/shared'
import { isServerOpsPlaintextDirectAddress } from '@proma/shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { ServerOpsDataServicesPanel } from './ServerOpsDataServicesPanel'
import type { ServerOpsDataPanelApi, ServerOpsDataSourceMutation } from './ServerOpsDataServicesPanel'
import { ServerOpsDatabaseWorkbench } from './ServerOpsDatabaseWorkbench'
import type { ServerOpsWorkspaceToolbarContent } from './ServerOpsWorkspaceToolbar'
import { cn } from '@/lib/utils'
import { detectIsMac, detectIsWindows } from '@/lib/platform'
import { getCanvasExpandedTitlebarHeight } from '@/lib/window-titlebar-layout'

/** 数据连接经由的跳板主机身份；直连连接没有跳板。 */
export interface ServerOpsDataConnectionJumpHost {
  id: string
  label: string
  description: string
  /** 跳板主机当前是否已建立 SSH 连接；只影响"经由"方式的读取。 */
  connected: boolean
}

/** 数据连接详情视图属性。 */
export interface ServerOpsDataConnectionViewProps {
  api: ServerOpsDataPanelApi
  /** 当前打开的数据库 / Redis 连接。 */
  source: ServerOpsDataSource
  /** 所属项目名，用于工具栏标注连接归属。 */
  projectLabel: string
  /** 经跳板时用于只读诊断与编辑的跳板主机；本机直连为 null。 */
  jumpHost: ServerOpsDataConnectionJumpHost | null
  /** 会话与 Pane 组成的轻量导航作用域。 */
  viewScope?: string
  /** 非聚焦 Pane 不消费 Escape，也不展开遮挡正在使用的 Pane。 */
  paneActive?: boolean
  /** 顶层统一项目、连接身份与授权导航，展开后仍保留在同一容器中。 */
  renderWorkspaceToolbar: (content?: ServerOpsWorkspaceToolbarContent) => React.ReactNode
  onOpenDrawer: () => void
  /** 返回项目视图的分组列表。 */
  onBackToProject: () => void
  /** 该连接被编辑或删除后由工作区重新读取连接列表。 */
  onSourceMutated?: (change: ServerOpsDataSourceMutation) => void
}

/** 引擎展示名。 */
function getEngineLabel(engine: ServerOpsDataSource['engine']): string {
  return engine === 'redis' ? 'Redis' : engine === 'sqlite' ? 'SQLite' : 'MySQL'
}

/**
 * 数据连接详情视图。
 *
 * 数据库与 Redis 是项目内的一等连接（各自独立登录）；MySQL 默认浏览数据，
 * Redis 使用自身诊断。连接内不提供 SSH 能力页签。
 *
 * @param props 连接、跳板主机与回调
 * @returns 数据连接详情视图
 */
export function ServerOpsDataConnectionView({
  api,
  source,
  projectLabel,
  jumpHost,
  viewScope = 'default',
  paneActive = true,
  renderWorkspaceToolbar,
  onOpenDrawer,
  onBackToProject,
  onSourceMutated,
}: ServerOpsDataConnectionViewProps): React.ReactElement {
  /** 展开只属于当前挂载 Pane；关闭连接时自然释放，不影响另一个工作台。 */
  const [expandedAtom] = React.useState(() => atom(false))
  const [expanded, setExpanded] = useAtom(expandedAtom)
  /** 复用应用既有标题栏安全区，避免挡住 macOS/Windows 系统控件。 */
  const titlebarHeight = getCanvasExpandedTitlebarHeight(expanded, detectIsMac(), detectIsWindows())
  React.useEffect(() => {
    if (!paneActive) setExpanded(false)
  }, [paneActive, setExpanded])
  React.useEffect(() => {
    if (!expanded || !paneActive) return
    /** Portal 弹层先处理 Escape；仅当焦点仍在工作台正文时还原。 */
    const handleEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      if (document.querySelector('[role="dialog"][data-state="open"], [role="menu"][data-state="open"], [role="listbox"][data-state="open"]')) return
      event.preventDefault()
      setExpanded(false)
    }
    window.addEventListener('keydown', handleEscape)
    return () => window.removeEventListener('keydown', handleEscape)
  }, [expanded, paneActive, setExpanded])
  /** 数据库与 Redis 使用不同图标，列表与详情保持一致。 */
  const EngineIcon = source.engine === 'redis' ? DatabaseZap : Database
  /** 连接方式说明；跳板主机缺失时如实说明，而不是假装直连。 */
  const transportLabel = source.transport === 'direct'
    ? '本机直连'
    : `经跳板 ${jumpHost?.label ?? '（跳板服务器已删除）'}`
  /**
   * 是否处于"允许但明文"的形态。
   *
   * 判据与主进程完全一致（共享 `isServerOpsPlaintextDirectAddress`），
   * 避免界面声称安全、主进程却拒绝发起连接。
   */
  const plaintextDirect = source.transport === 'direct'
    && source.engine !== 'sqlite'
    && source.tlsMode === 'disabled'
    && source.address !== undefined
    && isServerOpsPlaintextDirectAddress(source.address)
  /** SQLite 的连接身份是远端文件；网络引擎仍使用地址和端口。 */
  const connectionDetail = source.engine === 'sqlite' ? source.filePath : `${source.address}:${source.port}`

  /** 连接身份合入项目导航，不再单独重复项目名；MySQL 菜单仍由原控制器提供。 */
  const renderHeader = (actions?: React.ReactNode): React.ReactNode => renderWorkspaceToolbar({
    onManageProjects: () => { setExpanded(false); onOpenDrawer() },
    connection: (
      <div className="flex min-w-0 items-center gap-2">
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button type="button" variant="ghost" size="icon-sm" className="shrink-0" aria-label="返回项目连接" onClick={onBackToProject}>
                <ArrowLeft className="size-3.5" aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">返回{projectLabel}的连接列表</TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2 text-xs font-medium">
            <span className="flex min-w-0 items-center gap-1.5" data-server-ops-connection-module>
              <EngineIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="truncate" title={source.label}>{source.label}</span>
            </span>
            <span className="shrink-0 text-[10px] font-normal text-muted-foreground" data-server-ops-engine-badge>{getEngineLabel(source.engine)}</span>
          </div>
          <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground" title={`${connectionDetail} · ${transportLabel}`} data-server-ops-connection-detail>
            {connectionDetail}
            {` · ${transportLabel}`}
          </div>
        </div>
      </div>
    ),
    connectionActions: <>
        {plaintextDirect ? (
          <TooltipProvider delayDuration={200}>
            <Tooltip>
              {/*
                Badge 是没有 forwardRef 的普通函数组件，直接放进 TooltipTrigger asChild 会触发
                React 的"Function components cannot be given refs"告警（DevTools 里会看到组件栈）。
                这里用原生 span 承接 ref，与仓库里禁用态 Tooltip 的既有写法一致。
              */}
              <TooltipTrigger asChild>
                <span className="inline-flex shrink-0">
                  <Badge
                    variant="outline"
                    className="shrink-0 border-amber-600/40 px-2 py-0 text-[10px] font-normal text-amber-600 dark:text-amber-400"
                    data-server-ops-plaintext-direct={source.id}
                  >
                    内网明文
                  </Badge>
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                该地址属于私有网段，允许关闭 TLS 直连：密码与查询结果会以内网明文传输。
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : null}
        {source.engine !== 'redis' ? <Button type="button" size="icon-sm" variant="ghost" aria-label={expanded ? '还原工作台' : '展开工作台'} onClick={() => setExpanded((previous) => !previous)}>{expanded ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}</Button> : null}
        {actions}
    </>,
  })
  return (
    <div className={cn('server-ops-workspace-container relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-content-area', expanded && 'fixed inset-0 z-[200]')} style={{ paddingTop: titlebarHeight }} data-server-ops-data-connection-view={source.id} data-server-ops-workbench-expanded={expanded}>
      {expanded ? <div className="titlebar-drag-region absolute inset-x-0 top-0" style={{ height: titlebarHeight }} aria-hidden="true" /> : null}
      {source.engine !== 'redis' ? <ServerOpsDatabaseWorkbench key={`${viewScope}:${source.id}`} api={api} source={source} jumpHost={jumpHost} viewScope={viewScope} renderHeader={renderHeader} onSourceMutated={onSourceMutated} /> : <>
      {renderHeader()}
      <ServerOpsDataServicesPanel
        api={api}
        focusSource={source}
        hostId={jumpHost?.id ?? ''}
        hostLabel={jumpHost?.label ?? ''}
        hostDescription={jumpHost?.description ?? transportLabel}
        active
        connected={jumpHost?.connected ?? false}
        {...(onSourceMutated === undefined ? {} : { onSourceMutated })}
      />
      </>}
    </div>
  )
}
