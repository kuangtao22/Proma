import * as React from 'react'
import { ArrowUpRight, Blocks, ChevronDown, Database, DatabaseZap, FolderInput, FolderOpen, LoaderCircle, MoreHorizontal, Plus, Search, Server } from 'lucide-react'
import type { ServerOpsProject } from '@proma/shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { AgentActionHint } from '@/components/agent/AgentActionHint'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import type { ServerOpsConnection, ServerOpsConnectionKind } from './server-ops-connections'
import { filterServerOpsConnections } from './server-ops-connections'
import type { ServerOpsProjectsStatus } from './server-ops-project-controller'

/** 类型筛选与添加菜单共用元数据，防止两处类别不一致。 */
const SERVER_OPS_PROJECT_KINDS: readonly { kind: ServerOpsConnectionKind; label: string; caption: string }[] = [
  { kind: 'ssh', label: '服务器', caption: '服务器 · SSH' },
  { kind: 'database', label: '数据库', caption: '数据库 · MySQL' },
  { kind: 'redis', label: 'Redis', caption: 'Redis' },
]

/** 项目视图属性。 */
export interface ServerOpsProjectViewProps {
  /** 工具栏右侧附加操作，例如 Agent 只读授权。 */
  toolbarActions?: React.ReactNode
  /** 当前项目；为空表示项目列表尚未就绪。 */
  project: ServerOpsProject | null
  /** 项目列表加载阶段；项目为空时用于区分"读取中/失败/确实没有项目"。 */
  status?: ServerOpsProjectsStatus
  /** 项目列表读取失败的公开错误。 */
  error?: string | null
  /** 该项目的连接（已由调用方按项目过滤）。 */
  connections: readonly ServerOpsConnection[]
  /** 当前选中的连接 ID。 */
  selectedConnectionId: string | null
  /** 选择一条连接；服务器进入能力页签，数据库/Redis 进入只读诊断。 */
  onSelectConnection: (connection: ServerOpsConnection) => void
  /** 打开连接移动弹窗；不传时隐藏管理菜单。 */
  onMoveConnection?: (connection: ServerOpsConnection) => void
  /** 打开项目列表抽屉；项目列表是抽屉里的唯一内容，也是切换项目的入口。 */
  onOpenDrawer: () => void
  /** 重新读取项目列表；仅在失败态提供。 */
  onRetry?: () => void
  /** 新增连接；按类别分别入口，避免一个对话框里混三类字段。 */
  onAddConnection: (kind: ServerOpsConnectionKind) => void
  /** 分类与搜索只改变当前项目的展示，不改变连接选择或发起网络请求。 */
  filterKind?: ServerOpsConnectionKind | 'all'
  searchQuery?: string
  onFilterKindChange?: (kind: ServerOpsConnectionKind | 'all') => void
  onSearchQueryChange?: (query: string) => void
}

/** 根据连接类别返回同一套图标，卡片可通过样式覆盖大小与颜色。 */
function GroupIcon({ kind, className }: { kind: ServerOpsConnectionKind; className?: string }): React.ReactElement {
  /** 固定的协议图标，不依赖连接状态或网络读取。 */
  const Icon = kind === 'ssh' ? Server : kind === 'redis' ? DatabaseZap : Database
  return <Icon className={cn('size-3.5 shrink-0', className)} aria-hidden="true" />
}

/**
 * 运维页标题与项目切换；采用 Skills 页标题层级，抽屉仍是项目管理入口。
 *
 * @param props 当前项目名与抽屉入口
 * @returns 页标题及项目切换按钮
 */
function ProjectViewToolbar({
  title,
  onOpenDrawer,
}: {
  title: string
  onOpenDrawer: () => void
}): React.ReactElement {
  return (
    <div className="titlebar-no-drag flex min-w-0 flex-wrap items-center justify-between gap-3 py-3" data-server-ops-project-toolbar>
      <div className="flex shrink-0 items-center gap-2.5">
        <Blocks className="size-6 text-foreground/70" aria-hidden="true" />
        <h1 className="text-lg font-semibold text-foreground">服务器运维</h1>
      </div>
      <Button type="button" variant="outline" size="sm" className="max-w-full gap-2 rounded-lg bg-content-area text-[13px] text-foreground/80" aria-label="打开项目列表" title={title} onClick={onOpenDrawer}>
        <FolderOpen className="size-3.5 text-muted-foreground" aria-hidden="true" />
        <span className="max-w-44 truncate">{title}</span>
        <ChevronDown className="size-3.5 text-muted-foreground" aria-hidden="true" />
      </Button>
    </div>
  )
}

/**
 * 项目视图：与 Skills 一致的提示、搜索与可折叠连接卡片。
 *
 * 项目下只区分"服务器 / 数据库 / Redis"三类，能力页签属于选中服务器之后的事，
 * 因此这里只负责选择连接，不承载终端、文件等具体能力。
 *
 * @param props 项目、连接与回调
 * @returns 项目视图
 */
export function ServerOpsProjectView({
  project,
  status = 'ready',
  error = null,
  connections,
  selectedConnectionId,
  onSelectConnection,
  onMoveConnection,
  onOpenDrawer,
  onRetry,
  onAddConnection,
  filterKind = 'all',
  searchQuery = '',
  onFilterKindChange,
  onSearchQueryChange,
  toolbarActions,
}: ServerOpsProjectViewProps): React.ReactElement {
  if (!project) {
    /*
     * 项目尚未就绪时不再回退成旧的"单主机视图"：
     * 那一层的锚点是主机，与项目制的一级列表互相矛盾；这里如实说明原因并允许重试。
     */
    return (
      <div className="flex min-h-0 flex-1 flex-col bg-content-area px-4" data-server-ops-project-view="empty">
        <ProjectViewToolbar title="项目" onOpenDrawer={onOpenDrawer} />
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          {status === 'loading' || status === 'idle' ? (
            <>
              <LoaderCircle className="size-4 animate-spin text-muted-foreground" aria-hidden="true" />
              <p className="text-xs text-muted-foreground" role="status">正在读取项目...</p>
            </>
          ) : (
            <>
              <div className="flex size-10 items-center justify-center rounded-md border border-border bg-muted/35 text-muted-foreground">
                <Server className="size-5" aria-hidden="true" />
              </div>
              <div>
                <h3 className="text-sm font-medium">{status === 'error' ? '项目读取失败' : '还没有项目'}</h3>
                <p className="mt-1 max-w-sm text-xs text-muted-foreground">
                  {status === 'error'
                    ? error ?? '请检查数据根是否可用'
                    : '项目会在客户端启动时自动创建；若列表始终为空，请重启客户端或检查数据根。'}
                </p>
              </div>
              {onRetry ? <Button type="button" size="sm" variant="outline" onClick={onRetry}>重试</Button> : null}
            </>
          )}
        </div>
      </div>
    )
  }
  /** 分类统计基于当前项目完整列表，搜索时仍可看见各类别的真实数量。 */
  const counts = connections.reduce<Record<ServerOpsConnectionKind | 'all', number>>((result, connection) => {
    result.all += 1
    result[connection.kind] += 1
    return result
  }, { all: 0, ssh: 0, database: 0, redis: 0 })
  /** 仅筛选展示集合，保留每条连接的原始对象供既有动作回调使用。 */
  const visibleConnections = filterServerOpsConnections(connections, filterKind, searchQuery)
  /** 类别为空时可直接打开对应表单；无查询的全空项目引导使用统一添加入口。 */
  const filteredKind = SERVER_OPS_PROJECT_KINDS.find((entry) => entry.kind === filterKind)
  const searching = searchQuery.trim().length > 0
  return (
    <div className="server-ops-project-container flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto bg-content-area scrollbar-thin" data-server-ops-project-view={project.id}>
      <div className="mx-auto w-full max-w-6xl px-4 pb-5">
        <ProjectViewToolbar title={project.name} onOpenDrawer={onOpenDrawer} />
        <AgentActionHint action="查看已授权的服务器状态、分析数据库或查询数据" className="mb-3" />
        <div className="titlebar-no-drag mb-4 flex min-w-0 flex-wrap items-center gap-2" data-server-ops-project-actions>
          <label className="relative block min-w-0 flex-1 basis-52" data-server-ops-project-search>
            <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-foreground/40" aria-hidden="true" />
            <Input type="search" value={searchQuery} onChange={(event) => onSearchQueryChange?.(event.target.value)} aria-label="搜索连接名称或地址" placeholder="搜索连接名称或地址..." className="h-8 rounded-lg border-border/60 bg-content-area pl-9 pr-3 text-[13px]" />
          </label>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {toolbarActions}
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="outline" size="sm" className="gap-1.5 rounded-lg bg-content-area text-[13px] text-foreground/80" aria-label="添加连接"><Plus className="size-3.5" aria-hidden="true" />添加连接</Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="z-[9999] min-w-36">
                {SERVER_OPS_PROJECT_KINDS.map((entry) => (
                  <DropdownMenuItem key={entry.kind} aria-label={`添加${entry.label}`} data-server-ops-add-connection={entry.kind} onSelect={() => onAddConnection(entry.kind)}>
                    <GroupIcon kind={entry.kind} />添加{entry.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        <div className="mb-4 flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2" data-server-ops-project-filters>
          <h2 className="flex shrink-0 items-center gap-2 text-[13px] font-medium text-muted-foreground">项目连接<span className="font-normal tabular-nums" data-server-ops-project-total>{connections.length}</span></h2>
          <div className="flex min-w-0 flex-wrap items-center gap-0.5" role="group" aria-label="筛选连接类型">
            {[{ kind: 'all' as const, label: '全部' }, ...SERVER_OPS_PROJECT_KINDS].map((entry) => (
              <button key={entry.kind} type="button" className={cn('flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40', filterKind === entry.kind ? 'bg-muted/70 font-medium text-foreground' : 'text-muted-foreground hover:bg-muted/35 hover:text-foreground')}
                aria-pressed={filterKind === entry.kind} data-server-ops-project-filter={entry.kind} onClick={() => onFilterKindChange?.(entry.kind)}>
                {entry.label}<span className="text-[10px] font-normal tabular-nums text-muted-foreground" data-server-ops-filter-count={entry.kind}>{counts[entry.kind]}</span>
              </button>
            ))}
          </div>
        </div>
        {visibleConnections.length === 0 ? (
          <div className="flex min-h-48 flex-col items-center justify-center gap-2 px-4 py-8 text-center" data-server-ops-project-empty>
            <div className="mb-1 flex size-9 items-center justify-center rounded-lg bg-muted/40 text-muted-foreground">{searching ? <Search className="size-4" /> : <GroupIcon kind={filteredKind?.kind ?? 'ssh'} />}</div>
            <p className="text-xs font-medium">{searching ? '没有找到匹配的连接' : filteredKind ? `暂无 ${filteredKind.label} 连接` : '这个项目还没有连接'}</p>
            <p className="text-[11px] text-muted-foreground">{searching ? '换个名称或地址试试。' : '添加连接后，会显示在这里。'}</p>
            {searching ? <Button type="button" variant="outline" size="sm" className="mt-1 text-xs" onClick={() => onSearchQueryChange?.('')}>清除搜索</Button>
              : filteredKind ? <Button type="button" variant="outline" size="sm" className="mt-1 text-xs" onClick={() => onAddConnection(filteredKind.kind)}><Plus className="size-3.5" />添加 {filteredKind.label}</Button>
                : <p className="text-[11px] text-muted-foreground">从上方「添加连接」选择类型</p>}
          </div>
        ) : (
          <div className="space-y-5">
            {SERVER_OPS_PROJECT_KINDS.map((entry) => {
              /** 只渲染有结果的分组，避免少量连接被空类别占位拆散。 */
              const groupConnections = visibleConnections.filter((connection) => connection.kind === entry.kind)
              if (groupConnections.length === 0) return null
              return (
                <Collapsible key={`${project.id}:${entry.kind}:${filterKind}:${searchQuery.trim().toLowerCase()}`} defaultOpen data-server-ops-project-group={entry.kind}>
                  <h3 className="mb-2">
                    <CollapsibleTrigger className="group flex w-full items-center gap-2 rounded-md px-1 py-2 text-left text-[13px] font-medium text-muted-foreground transition-colors hover:bg-muted/30 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40" aria-label={`折叠或展开${entry.label}连接`}>
                      <ChevronDown className="size-3.5 shrink-0 text-foreground/40 transition-transform group-data-[state=closed]:-rotate-90 motion-reduce:transition-none" aria-hidden="true" />
                      {entry.label}<span className="font-normal tabular-nums text-foreground/40">{groupConnections.length}</span>
                    </CollapsibleTrigger>
                  </h3>
                  <CollapsibleContent>
                    <ul className="grid grid-cols-1 gap-3" data-server-ops-project-cards>
                      {groupConnections.map((connection) => {
                        /** 同名连接依靠类型和地址区分，显示文案与无障碍名称共用同一事实。 */
                        const caption = entry.caption
                        /** 补充说明保留连接状态与明文提示，键盘聚焦卡片时同样可感知。 */
                        const accessibleDescription = [connection.metadata, connection.kind === 'ssh' ? connection.connected === true ? '已连接' : '未连接' : undefined, connection.plaintextDirect === true ? '内网明文' : undefined].filter(Boolean).join('，')
                        return (
                          <li key={connection.id} className={cn('group/card relative flex min-w-0 flex-col gap-3 rounded-xl border border-border/60 bg-content-area p-4 transition-colors hover:border-border hover:bg-muted/20', connection.id === selectedConnectionId && 'border-border bg-muted/30')}>
                            <button type="button" className="absolute inset-0 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50" aria-label={`打开连接：${connection.label}，${caption}，${connection.endpoint ?? connection.detail}`} aria-description={accessibleDescription || undefined} title={`${connection.label} · ${connection.detail}`}
                              aria-current={connection.id === selectedConnectionId ? 'true' : undefined} data-server-ops-connection={connection.id} onClick={() => onSelectConnection(connection)} />
                            <div className="pointer-events-none flex min-w-0 items-start gap-3 pr-5">
                              <span className={cn('flex size-9 shrink-0 items-center justify-center rounded-xl shadow-sm', connection.kind === 'ssh' ? 'bg-blue-500/10 text-blue-500' : connection.kind === 'database' ? 'bg-amber-500/10 text-amber-500' : 'bg-rose-500/10 text-rose-500')}><GroupIcon kind={connection.kind} className="size-[18px]" /></span>
                              <div className="min-w-0 flex-1">
                                <h4 className="truncate text-sm font-medium">{connection.label}</h4>
                                <p className="mt-1 truncate font-mono text-xs text-muted-foreground">{connection.endpoint ?? connection.detail}</p>
                              </div>
                            </div>
                            <p className="pointer-events-none min-h-5 truncate text-xs leading-5 text-muted-foreground">{connection.metadata ?? caption}</p>
                            <div className="pointer-events-none mt-auto flex min-w-0 flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                              <span className="rounded-md bg-muted px-1.5 py-0.5">{connection.kind === 'ssh' ? 'SSH' : connection.kind === 'database' ? 'MySQL' : 'Redis'}</span>
                              {connection.kind === 'ssh' ? <span className={cn('flex items-center gap-1.5', connection.connected === true && 'text-emerald-600 dark:text-emerald-400')}><span className={cn('size-1.5 rounded-full', connection.connected === true ? 'bg-emerald-500' : 'bg-muted-foreground/40')} />{connection.connected === true ? '已连接' : '未连接'}</span> : null}
                              {connection.plaintextDirect === true ? <span className="rounded-md bg-amber-500/10 px-1.5 py-0.5 text-amber-700 dark:text-amber-400" data-server-ops-plaintext-direct={connection.id}>内网明文</span> : null}
                              <ArrowUpRight className="ml-auto size-3.5 text-foreground/30 transition-colors group-hover/card:text-foreground/60" aria-hidden="true" />
                            </div>
                            {onMoveConnection ? (
                              <DropdownMenu modal={false}>
                                <DropdownMenuTrigger asChild>
                                  <Button type="button" variant="ghost" size="icon-sm" className="absolute right-2 top-3 size-7 rounded-md text-muted-foreground focus-visible:ring-2" aria-label={`管理连接：${connection.label}`}><MoreHorizontal className="size-3.5" aria-hidden="true" /></Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end" className="z-[9999] min-w-36">
                                  <DropdownMenuItem data-server-ops-move-connection={connection.id} onSelect={() => onMoveConnection(connection)}><FolderInput className="size-3.5" aria-hidden="true" />移动到项目</DropdownMenuItem>
                                </DropdownMenuContent>
                              </DropdownMenu>
                            ) : null}
                          </li>
                        )
                      })}
                    </ul>
                  </CollapsibleContent>
                </Collapsible>
              )
            })}
          </div>
        )}
        <p className={visibleConnections.length === 0 ? 'sr-only' : 'mt-4 text-[10px] text-muted-foreground'} role="status">共 {visibleConnections.length} 个连接{filterKind !== 'all' || searching ? ` · 当前项目 ${connections.length} 个` : ''}</p>
      </div>
    </div>
  )
}
