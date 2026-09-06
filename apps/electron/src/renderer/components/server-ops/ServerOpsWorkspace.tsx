import * as React from 'react'
import { useAtom } from 'jotai'
import {
  Box,
  ClipboardList,
  Database,
  FileText,
  FolderOpen,
  Gauge,
  LoaderCircle,
  LogIn,
  PanelLeft,
  Pencil,
  Plus,
  RefreshCw,
  Server,
  Settings2,
  Shield,
  ShieldCheck,
  SquareTerminal,
  Trash2,
  Unplug,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type {
  ServerOpsAgentAccess,
  ServerOpsAgentAccessChanged,
  ServerOpsAgentAccessTarget,
  ServerOpsConnectionState,
  ServerOpsCredentialInput,
  ServerOpsHost,
  ServerOpsSaveHostInput,
  ServerOpsAuditActor,
  ServerOpsAuditOperation,
  ServerOpsAuditListInput,
  ServerOpsAuditListResult,
  ServerOpsAuditRecord,
} from '@proma/shared'
import { currentAgentSessionIdAtom } from '@/atoms/agent-atoms'
import {
  selectedServerOpsHostIdAtom,
  serverOpsAgentAccessProjectionAtom,
  serverOpsConnectionStatesAtom,
  serverOpsHostsAtom,
  serverOpsHostsErrorAtom,
  serverOpsHostsStatusAtom,
} from '@/atoms/server-ops-atoms'
import type { ServerOpsAgentAccessProjection, ServerOpsAgentAccessStatus, ServerOpsHostsStatus } from '@/atoms/server-ops-atoms'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import { ServerOpsHostDialog } from './ServerOpsHostDialog'
import { ServerOpsHostDrawer } from './ServerOpsHostDrawer'
import { ServerOpsConnectDialog } from './ServerOpsConnectDialog'
import { ServerOpsRemoteTerminal } from './ServerOpsRemoteTerminal'
import { ServerOpsOverviewPanel } from './ServerOpsOverviewPanel'
import { ServerOpsServicesPanel } from './ServerOpsServicesPanel'
import { ServerOpsLogsPanel } from './ServerOpsLogsPanel'

/** 运维控制台首批固定页签。 */
export type ServerOpsSection = 'overview' | 'terminal' | 'services' | 'logs' | 'files' | 'docker' | 'data-services' | 'audit'

/** 运维页签的显示元数据。 */
interface ServerOpsSectionMeta {
  id: ServerOpsSection
  label: string
  icon: LucideIcon
}

/** 概览页签也是异常输入时的稳定回退。 */
const SERVER_OPS_OVERVIEW_SECTION: ServerOpsSectionMeta = { id: 'overview', label: '概览', icon: Gauge }

/** 工作区固定页签，后续真实连接能力仍复用同一信息架构。 */
const SERVER_OPS_SECTIONS: readonly ServerOpsSectionMeta[] = [
  SERVER_OPS_OVERVIEW_SECTION,
  { id: 'terminal', label: '终端', icon: SquareTerminal },
  { id: 'services', label: '服务', icon: Settings2 },
  { id: 'logs', label: '日志', icon: FileText },
  { id: 'files', label: '文件', icon: FolderOpen },
  { id: 'docker', label: 'Docker', icon: Box },
  { id: 'data-services', label: '数据服务', icon: Database },
  { id: 'audit', label: '审计', icon: ClipboardList },
]

/** 可独立静态验证的运维工作区视图属性。 */
export interface ServerOpsWorkspaceViewProps {
  status: ServerOpsHostsStatus
  error?: string | null
  hosts: readonly ServerOpsHost[]
  selectedHost: ServerOpsHost | null
  activeSection: ServerOpsSection
  connectionState?: ServerOpsConnectionState
  agentAccessAvailable?: boolean
  agentAccessGranted?: boolean
  agentAccessStatus?: ServerOpsAgentAccessStatus
  agentAccessError?: string | null
  agentAccessDisabledReason?: string
  terminalContent?: React.ReactNode
  auditStatus?: 'idle' | 'loading' | 'ready' | 'error'
  auditError?: string | null
  auditRecords?: readonly ServerOpsAuditRecord[]
  auditHostFilter?: 'current' | 'all'
  auditActorFilter?: ServerOpsAuditActor | 'all'
  auditOperationFilter?: ServerOpsAuditOperation | 'all'
  agentSessionId?: string | null
  onOpenDrawer: () => void
  onCreateHost: () => void
  onEditHost: (host: ServerOpsHost) => void
  onDeleteHost: (host: ServerOpsHost) => void
  onSectionChange: (section: ServerOpsSection) => void
  onConnect?: () => void
  onDisconnect?: () => void
  onToggleAgentAccess?: () => void
  onRefresh?: () => void
  onAuditHostFilterChange?: (filter: 'current' | 'all') => void
  onAuditActorFilterChange?: (filter: ServerOpsAuditActor | 'all') => void
  onAuditOperationFilterChange?: (filter: ServerOpsAuditOperation | 'all') => void
  onRefreshAudit?: () => void
}

/** 生成概览 React 实例身份，使主机或 SSH 连接代次变化时清空内存快照。 */
export function getServerOpsOverviewInstanceKey(
  hostId: string,
  connectionState?: ServerOpsConnectionState,
): string {
  /** 只有精确属于当前主机的已连接状态可以贡献连接代次。 */
  const connectionId = connectionState?.hostId === hostId && connectionState.phase === 'connected'
    ? connectionState.connectionId
    : null
  return JSON.stringify([hostId, connectionId])
}

/** 审计记录中的操作显示名。 */
const SERVER_OPS_AUDIT_OPERATION_LABELS: Record<ServerOpsAuditOperation, string> = {
  connect: '连接',
  exec: '执行命令',
  disconnect: '断开',
  'service-start': '启动',
  'service-stop': '停止',
  'service-restart': '重启',
  'service-enable': '启用',
  'service-disable': '禁用',
}

/** 审计记录主体的中文标签。 */
const SERVER_OPS_AUDIT_ACTOR_LABELS: Record<ServerOpsAuditActor, string> = {
  agent: 'Agent',
  user: '用户',
}

/** 审计操作筛选的固定顺序。 */
const SERVER_OPS_AUDIT_OPERATIONS: readonly ServerOpsAuditOperation[] = [
  'connect', 'exec', 'disconnect',
  'service-start', 'service-stop', 'service-restart', 'service-enable', 'service-disable',
]

/** 展示真实、有界且只读的 Agent 运维审计。 */
export function ServerOpsAudit({
  status,
  error,
  records,
  hostFilter,
  actorFilter,
  operationFilter,
  onHostFilterChange,
  onActorFilterChange,
  onOperationFilterChange,
  onRefresh,
}: {
  status: 'idle' | 'loading' | 'ready' | 'error'
  error?: string | null
  records: readonly ServerOpsAuditRecord[]
  hostFilter: 'current' | 'all'
  actorFilter: ServerOpsAuditActor | 'all'
  operationFilter: ServerOpsAuditOperation | 'all'
  onHostFilterChange?: (filter: 'current' | 'all') => void
  onActorFilterChange?: (filter: ServerOpsAuditActor | 'all') => void
  onOperationFilterChange?: (filter: ServerOpsAuditOperation | 'all') => void
  onRefresh?: () => void
}): React.ReactElement {
  /** 操作选项遵守 Shared 的 actor/operation 权限矩阵，避免生成无效 IPC 查询。 */
  const availableOperations = SERVER_OPS_AUDIT_OPERATIONS.filter((operation) => (
    actorFilter === 'all'
    || (actorFilter === 'user') === operation.startsWith('service-')
  ))
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <div className="flex h-7 items-center rounded-sm border border-border p-0.5" aria-label="筛选审计服务器">
          {(['current', 'all'] as const).map((filter) => (
            <button
              key={filter}
              type="button"
              className={cn('h-6 px-2 text-[11px]', hostFilter === filter ? 'bg-accent text-foreground' : 'text-muted-foreground')}
              aria-pressed={hostFilter === filter}
              onClick={() => onHostFilterChange?.(filter)}
            >
              {filter === 'current' ? '当前服务器' : '全部服务器'}
            </button>
          ))}
        </div>
        <select
          className="h-7 min-w-24 rounded-sm border border-input bg-background px-2 text-[11px] text-foreground"
          aria-label="筛选审计主体"
          value={actorFilter}
          onChange={(event) => onActorFilterChange?.(event.target.value as ServerOpsAuditActor | 'all')}
        >
          <option value="all">全部主体</option>
          <option value="agent">Agent</option>
          <option value="user">用户</option>
        </select>
        <select
          className="h-7 min-w-28 rounded-sm border border-input bg-background px-2 text-[11px] text-foreground"
          aria-label="筛选审计操作"
          value={operationFilter}
          onChange={(event) => onOperationFilterChange?.(event.target.value as ServerOpsAuditOperation | 'all')}
        >
          <option value="all">全部操作</option>
          {availableOperations.map((operation) => (
            <option key={operation} value={operation}>{SERVER_OPS_AUDIT_OPERATION_LABELS[operation]}</option>
          ))}
        </select>
        <Button type="button" variant="ghost" size="icon-sm" className="ml-auto" aria-label="刷新审计记录" onClick={onRefresh}>
          <RefreshCw className={cn('size-3.5', status === 'loading' && 'animate-spin')} aria-hidden="true" />
        </Button>
      </div>
      {status === 'loading' || status === 'idle' ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-xs text-muted-foreground" role="status">
          <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />正在读取审计记录...
        </div>
      ) : status === 'error' ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
          <p className="text-sm">审计记录读取失败</p>
          <p className="max-w-sm break-all text-xs text-muted-foreground">{error ?? 'SERVER_OPS_AUDIT_READ_FAILED'}</p>
          <Button type="button" size="sm" variant="outline" onClick={onRefresh}><RefreshCw className="size-3.5" />重试</Button>
        </div>
      ) : records.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-6 text-sm text-muted-foreground">暂无审计记录</div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="divide-y divide-border">
            {[...records].reverse().map((record) => (
              <div key={record.id} className="grid min-w-0 grid-cols-[minmax(7rem,auto)_minmax(0,1fr)] gap-x-3 gap-y-1 px-3 py-2 text-xs sm:grid-cols-[9rem_4rem_5.5rem_4rem_minmax(0,1fr)]">
                <time className="whitespace-nowrap text-muted-foreground" dateTime={new Date(record.timestamp).toISOString()}>
                  {new Date(record.timestamp).toLocaleString()}
                </time>
                <span className="text-muted-foreground">{SERVER_OPS_AUDIT_ACTOR_LABELS[record.actor]}</span>
                <span className="font-medium">{SERVER_OPS_AUDIT_OPERATION_LABELS[record.operation]}{record.phase === 'start' ? ' · 开始' : ''}</span>
                <span className={record.outcome === 'error' ? 'text-destructive' : 'text-emerald-600 dark:text-emerald-400'}>
                  {record.outcome === 'error' ? '失败' : '成功'}
                </span>
                <div className="min-w-0 break-words font-mono text-[11px] text-muted-foreground">
                  {record.operation === 'exec' ? record.command : record.unitId}
                  {record.exitCode !== undefined ? <span className="ml-2 text-foreground">退出码 {record.exitCode}</span> : null}
                  {record.signal ? <span className="ml-2 text-foreground">Signal {record.signal}</span> : null}
                  {record.errorCode ? <span className="ml-2 text-foreground">错误码 {record.errorCode}</span> : null}
                  {record.commandTruncated ? <span className="ml-2 text-foreground">命令摘要已截断</span> : null}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/** 展示未连接阶段的单个控制台页。 */
function ServerOpsDisconnectedSection({ section, connected }: { section: ServerOpsSectionMeta; connected: boolean }): React.ReactElement {
  /** 当前页签对应的图标。 */
  const Icon = section.icon
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <div className="flex size-10 items-center justify-center rounded-md border border-border bg-muted/35 text-muted-foreground">
        <Icon className="size-5" aria-hidden="true" />
      </div>
      <div>
        <h3 className="text-sm font-medium">{section.label}</h3>
        <p className="mt-1 text-xs text-muted-foreground">{connected ? '连接已建立，此控制台将在后续阶段接入真实数据' : '尚未建立 SSH 连接'}</p>
      </div>
    </div>
  )
}

/** 展示 PostgreSQL、MySQL 与 Redis 的连接入口和安全基线。 */
function ServerOpsDataServices({ connected }: { connected: boolean }): React.ReactElement {
  /** 首批支持的数据服务。 */
  const services = [
    { name: 'PostgreSQL', detail: '连接、容量、慢查询与复制状态' },
    { name: 'MySQL', detail: '连接、容量、慢查询与复制状态' },
    { name: 'Redis', detail: 'Keyspace、内存、复制与 Slowlog' },
  ] as const
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      <div className="mx-auto w-full max-w-3xl">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-medium">数据服务</h3>
            <p className="mt-1 text-xs text-muted-foreground">通过当前服务器的 SSH 隧道访问</p>
          </div>
          <Badge variant="outline" className="font-normal">默认只读</Badge>
        </div>
        <div className="divide-y divide-border border-y border-border">
          {services.map((service) => (
            <div key={service.name} className="flex min-h-16 items-center gap-3 py-3">
              <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted/55 text-muted-foreground">
                <Database className="size-4" aria-hidden="true" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{service.name}</div>
                <div className="truncate text-xs text-muted-foreground">{service.detail}</div>
              </div>
              <span className="shrink-0 text-[11px] text-muted-foreground">{connected ? '等待能力探测' : '等待 SSH 连接'}</span>
            </div>
          ))}
        </div>
        <p className="mt-4 text-xs leading-5 text-muted-foreground">
          写入、结构变更、终止连接和 Redis 高风险命令需要逐次审批，审批结果不会自动重放。
        </p>
      </div>
    </div>
  )
}

/** 纯展示的运维右侧工作区。 */
export function ServerOpsWorkspaceView({
  status,
  error,
  hosts,
  selectedHost,
  activeSection,
  connectionState,
  agentAccessAvailable = false,
  agentAccessGranted = false,
  agentAccessStatus = 'idle',
  agentAccessError,
  agentAccessDisabledReason,
  terminalContent,
  auditStatus = 'idle',
  auditError,
  auditRecords = [],
  auditHostFilter = 'current',
  auditActorFilter = 'all',
  auditOperationFilter = 'all',
  agentSessionId = null,
  onOpenDrawer,
  onCreateHost,
  onEditHost,
  onDeleteHost,
  onSectionChange,
  onConnect,
  onDisconnect,
  onToggleAgentAccess,
  onRefresh,
  onAuditHostFilterChange,
  onAuditActorFilterChange,
  onAuditOperationFilterChange,
  onRefreshAudit,
}: ServerOpsWorkspaceViewProps): React.ReactElement {
  /** 当前页签的显示元数据。 */
  const currentSection = SERVER_OPS_SECTIONS.find((section) => section.id === activeSection) ?? SERVER_OPS_OVERVIEW_SECTION
  /** 当前主机连接阶段。 */
  const connectionPhase = connectionState?.phase ?? 'disconnected'
  /** 当前主机是否已建立真实 SSH 连接。 */
  const connected = connectionPhase === 'connected'
  /** 授权按钮当前描述的下一步动作。 */
  const agentAccessActionLabel = agentAccessDisabledReason ?? (agentAccessGranted
    ? '撤销当前 Agent 的服务器权限'
    : '允许当前 Agent 使用此服务器')
  /** 同步阶段仍保留动作语义，并明确当前正在等待主进程事实。 */
  const agentAccessTooltip = agentAccessStatus === 'loading'
    ? `${agentAccessActionLabel}（正在同步当前 Agent 的服务器权限）`
    : agentAccessError
      ? `${agentAccessActionLabel}（上次同步失败：${agentAccessError}）`
      : agentAccessActionLabel
  /** 原生 disabled 按钮无法触发 Tooltip，禁用时由外层承担聚焦。 */
  const agentAccessDisabled = !agentAccessAvailable || agentAccessStatus === 'loading'
  /** 标题栏显示的连接状态。 */
  const connectionLabel = connectionPhase === 'connecting' ? '正在连接'
    : connectionPhase === 'disconnecting' ? '正在断开'
      : connectionPhase === 'connected' ? '已连接'
        : connectionPhase === 'blocked' ? '连接已阻断'
          : connectionPhase === 'host-key-required' ? '等待确认指纹'
            : connectionPhase === 'error' ? '连接失败'
              : '尚未连接'

  return (
    <div className="server-ops-workspace-container flex min-h-0 flex-1 flex-col bg-content-area" data-server-ops-workspace>
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-2" data-server-ops-toolbar>
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button type="button" variant="ghost" size="icon-sm" aria-label="打开服务器列表" onClick={onOpenDrawer}>
                <PanelLeft className="size-3.5" aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">服务器列表</TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <Server className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium">{selectedHost?.name ?? '服务器运维'}</div>
          {selectedHost && <div className="truncate font-mono text-[10px] text-muted-foreground">{selectedHost.username}@{selectedHost.address}:{selectedHost.port}</div>}
        </div>
        {selectedHost && <Badge variant="outline" className={cn('shrink-0 px-2 py-0 text-[10px] font-normal', connected ? 'border-emerald-500/40 text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground')} data-server-ops-connection-badge>{connectionLabel}</Badge>}
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                className="inline-flex"
                data-server-ops-agent-access-tooltip-trigger
                tabIndex={agentAccessDisabled ? 0 : undefined}
                aria-label={agentAccessDisabled ? agentAccessTooltip : undefined}
              >
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  data-server-ops-agent-access
                  disabled={agentAccessDisabled}
                  aria-label={agentAccessActionLabel}
                  aria-pressed={agentAccessGranted}
                  aria-busy={agentAccessStatus === 'loading' ? true : undefined}
                  onClick={onToggleAgentAccess}
                >
                  {agentAccessStatus === 'loading'
                    ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
                    : agentAccessGranted
                      ? <ShieldCheck className="size-3.5 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
                      : <Shield className="size-3.5" aria-hidden="true" />}
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom">{agentAccessTooltip}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
        {agentAccessStatus === 'loading' && (
          <span className="sr-only" role="status">正在同步当前 Agent 的服务器权限</span>
        )}
        {agentAccessStatus === 'error' && agentAccessError && (
          <span className="sr-only" role="status">当前 Agent 的服务器权限同步失败：{agentAccessError}</span>
        )}
        {selectedHost && (
          <>
            {connected ? (
              <Button type="button" variant="outline" size="sm" className="h-7 gap-1.5 px-2 text-[11px]" aria-label="断开 SSH" data-server-ops-connection-action onClick={onDisconnect}>
                <Unplug className="size-3.5" aria-hidden="true" /><span data-server-ops-connection-label>断开</span>
              </Button>
            ) : (
              <Button type="button" size="sm" className="h-7 gap-1.5 px-2 text-[11px]" aria-label="连接 SSH" data-server-ops-connection-action disabled={connectionPhase === 'connecting' || connectionPhase === 'disconnecting'} onClick={onConnect}>
                {connectionPhase === 'connecting' ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" /> : <LogIn className="size-3.5" aria-hidden="true" />}
                <span data-server-ops-connection-label>连接</span>
              </Button>
            )}
            <Button type="button" variant="ghost" size="icon-sm" aria-label="编辑当前服务器" onClick={() => onEditHost(selectedHost)}>
              <Pencil className="size-3.5" aria-hidden="true" />
            </Button>
            <Button type="button" variant="ghost" size="icon-sm" aria-label="删除当前服务器" onClick={() => onDeleteHost(selectedHost)}>
              <Trash2 className="size-3.5" aria-hidden="true" />
            </Button>
          </>
        )}
      </div>

      {status === 'loading' ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-xs text-muted-foreground">
          <RefreshCw className="size-3.5 animate-spin" aria-hidden="true" />
          正在读取服务器...
        </div>
      ) : status === 'error' ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <p className="text-sm">服务器列表读取失败</p>
          <p className="max-w-sm text-xs text-muted-foreground">{error ?? '未知错误'}</p>
          {onRefresh && <Button type="button" size="sm" variant="outline" onClick={onRefresh}><RefreshCw className="size-3.5" />重试</Button>}
        </div>
      ) : hosts.length === 0 || !selectedHost ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <div className="flex size-10 items-center justify-center rounded-md border border-border bg-muted/35 text-muted-foreground">
            <Server className="size-5" aria-hidden="true" />
          </div>
          <div>
            <h3 className="text-sm font-medium">还没有服务器</h3>
            <p className="mt-1 text-xs text-muted-foreground">添加一台 Linux 主机以建立运维身份。</p>
          </div>
          <Button type="button" size="sm" onClick={onCreateHost}><Plus className="size-3.5" />添加服务器</Button>
        </div>
      ) : (
        <>
          <nav className="flex h-9 shrink-0 items-stretch overflow-x-auto border-b border-border px-2" aria-label="服务器控制台">
            {SERVER_OPS_SECTIONS.map((section) => {
              /** 当前页签是否处于选中状态。 */
              const active = section.id === activeSection
              /** 当前页签图标。 */
              const Icon = section.icon
              return (
                <button
                  key={section.id}
                  type="button"
                  className={cn(
                    'relative flex h-9 shrink-0 items-center gap-1.5 px-2.5 text-[11px] transition-colors',
                    active ? 'text-foreground after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:bg-primary' : 'text-muted-foreground hover:text-foreground',
                  )}
                  aria-current={active ? 'page' : undefined}
                  onClick={() => onSectionChange(section.id)}
                >
                  <Icon className="size-3.5" aria-hidden="true" />
                  {section.label}
                </button>
              )
            })}
          </nav>
          <div
            className={activeSection === 'services' ? 'flex min-h-0 flex-1' : 'hidden'}
            aria-hidden={activeSection !== 'services'}
          >
            <ServerOpsServicesPanel
              key={getServerOpsOverviewInstanceKey(selectedHost.id, connectionState)}
              sessionId={agentSessionId}
              hostId={selectedHost.id}
              hostLabel={selectedHost.name}
              hostDescription={`${selectedHost.username}@${selectedHost.address}:${selectedHost.port}`}
              active={activeSection === 'services'}
              connected={connected}
            />
          </div>
          <div
            className={activeSection === 'logs' ? 'flex min-h-0 flex-1' : 'hidden'}
            aria-hidden={activeSection !== 'logs'}
            data-server-ops-logs-container
          >
            <ServerOpsLogsPanel
              hostId={selectedHost.id}
              connectionId={connectionState?.hostId === selectedHost.id && connectionState.phase === 'connected'
                ? connectionState.connectionId ?? null
                : null}
              active={activeSection === 'logs'}
              connected={connected}
            />
          </div>
          {activeSection === 'overview'
            ? <ServerOpsOverviewPanel
                key={getServerOpsOverviewInstanceKey(selectedHost.id, connectionState)}
                hostId={selectedHost.id}
                connected={connected}
                active={activeSection === 'overview'}
              />
            : activeSection === 'terminal' && connected && terminalContent
              ? terminalContent
            : activeSection === 'services'
              ? null
            : activeSection === 'logs'
              ? null
            : activeSection === 'data-services'
              ? <ServerOpsDataServices connected={connected} />
            : activeSection === 'audit'
              ? <ServerOpsAudit
                  status={auditStatus}
                  error={auditError}
                  records={auditRecords}
                  hostFilter={auditHostFilter}
                  actorFilter={auditActorFilter}
                  operationFilter={auditOperationFilter}
                  onHostFilterChange={onAuditHostFilterChange}
                  onActorFilterChange={onAuditActorFilterChange}
                  onOperationFilterChange={onAuditOperationFilterChange}
                  onRefresh={onRefreshAudit}
                />
              : <ServerOpsDisconnectedSection section={currentSection} connected={connected} />}
        </>
      )}
    </div>
  )
}

/** 从未知异常中提取适合界面展示的简短消息。 */
function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '未知错误'
}

/** 审计请求的完整 Renderer 身份，避免任一筛选维度漂移后接纳旧响应。 */
export interface ServerOpsAuditQuery {
  hostFilter: 'current' | 'all'
  actorFilter: ServerOpsAuditActor | 'all'
  operationFilter: ServerOpsAuditOperation | 'all'
  selectedHostId: string | null
}

/** 审计控制器向 React 发布的完整投影。 */
export interface ServerOpsAuditProjection {
  query: ServerOpsAuditQuery | null
  status: 'idle' | 'loading' | 'ready' | 'error'
  records: ServerOpsAuditRecord[]
  error: string | null
}

/** 审计加载控制器依赖。 */
interface ServerOpsAuditControllerOptions {
  listAudit: (input: ServerOpsAuditListInput) => Promise<ServerOpsAuditListResult>
  publish: (projection: ServerOpsAuditProjection) => void
}

/** 审计加载控制器公开操作。 */
export interface ServerOpsAuditController {
  activate: () => void
  dispose: () => void
  select: (query: ServerOpsAuditQuery) => Promise<void>
  refresh: () => Promise<void>
}

/** 判断两个审计查询是否包含完全相同的筛选目标。 */
function isSameServerOpsAuditQuery(left: ServerOpsAuditQuery | null, right: ServerOpsAuditQuery): boolean {
  return left?.hostFilter === right.hostFilter
    && left.actorFilter === right.actorFilter
    && left.operationFilter === right.operationFilter
    && left.selectedHostId === right.selectedHostId
}

/** 创建可抵御 owner、筛选和刷新竞态的审计加载控制器。 */
export function createServerOpsAuditController(options: ServerOpsAuditControllerOptions): ServerOpsAuditController {
  /** 当前完整查询身份。 */
  let query: ServerOpsAuditQuery | null = null
  /** 每次 owner、选择或刷新推进的请求代次。 */
  let revision = 0
  /** 当前组件 owner 是否仍可接收异步结果。 */
  let active = false

  /** 仅当前 owner 发布不可变投影。 */
  const publish = (projection: ServerOpsAuditProjection): void => {
    if (active) options.publish(projection)
  }
  /** 判断异步返回是否仍属于当前完整查询和请求代次。 */
  const isCurrent = (expectedRevision: number, expectedQuery: ServerOpsAuditQuery): boolean => (
    active && revision === expectedRevision && isSameServerOpsAuditQuery(query, expectedQuery)
  )
  /** 对当前查询执行一次 fresh 读取，刷新也必须进入同一代次门禁。 */
  const load = async (expectedQuery: ServerOpsAuditQuery): Promise<void> => {
    const operationRevision = ++revision
    if (expectedQuery.hostFilter === 'current' && !expectedQuery.selectedHostId) {
      publish({ query: expectedQuery, status: 'ready', records: [], error: null })
      return
    }
    publish({ query: expectedQuery, status: 'loading', records: [], error: null })
    try {
      /** 从完整 UI 查询映射出的有界 IPC 筛选。 */
      const input: ServerOpsAuditListInput = {
        ...(expectedQuery.hostFilter === 'current' && expectedQuery.selectedHostId ? { hostId: expectedQuery.selectedHostId } : {}),
        ...(expectedQuery.actorFilter === 'all' ? {} : { actor: expectedQuery.actorFilter }),
        ...(expectedQuery.operationFilter === 'all' ? {} : { operation: expectedQuery.operationFilter }),
        limit: 500,
      }
      const result = await options.listAudit(input)
      if (!isCurrent(operationRevision, expectedQuery)) return
      publish({ query: expectedQuery, status: 'ready', records: result.records, error: null })
    } catch (error) {
      if (!isCurrent(operationRevision, expectedQuery)) return
      publish({ query: expectedQuery, status: 'error', records: [], error: getErrorMessage(error) })
    }
  }

  return {
    activate: () => {
      if (active) return
      active = true
      revision += 1
    },
    dispose: () => {
      active = false
      revision += 1
      query = null
    },
    select: async (nextQuery) => {
      if (!active) return
      query = nextQuery
      await load(nextQuery)
    },
    refresh: async () => {
      if (!active || !query) return
      await load(query)
    },
  }
}

/** 授权控制器依赖的最小 IPC 合同，便于独立验证异步竞态。 */
interface ServerOpsAgentAccessControllerOptions {
  getAccess: (target: ServerOpsAgentAccessTarget) => Promise<ServerOpsAgentAccess | null>
  setAccess: (access: ServerOpsAgentAccess) => Promise<ServerOpsAgentAccess | null>
  publish: (projection: ServerOpsAgentAccessProjection) => void
  reportError: (message: string) => void
}

/** Renderer 授权投影的身份切换与异步代次控制器。 */
export interface ServerOpsAgentAccessController {
  activate: () => void
  dispose: () => void
  select: (target: ServerOpsAgentAccessTarget | null) => Promise<void>
  toggle: () => Promise<void>
  handleChanged: (event: ServerOpsAgentAccessChanged) => void
  resetAfterDisconnect: (target: ServerOpsAgentAccessTarget) => void
}

/** 判断两个授权目标是否是同一个精确 sessionId + hostId 组合。 */
function isSameAgentAccessTarget(
  left: ServerOpsAgentAccessTarget | null,
  right: ServerOpsAgentAccessTarget | null,
): boolean {
  return left?.sessionId === right?.sessionId && left?.hostId === right?.hostId
}

/** 组件绑定层输入，身份缺失时用于生成明确禁用原因。 */
interface ServerOpsAgentAccessViewStateInput {
  projection: ServerOpsAgentAccessProjection
  sessionId: string | null
  hostId: string | null
}

/** 组件绑定层输出，属性名可直接传给纯展示组件。 */
export interface ServerOpsAgentAccessViewState {
  agentAccessAvailable: boolean
  agentAccessGranted: boolean
  agentAccessStatus: ServerOpsAgentAccessStatus
  agentAccessError: string | null
  agentAccessDisabledReason?: string
}

/** 在 effect 执行前同步隔离旧目标投影，避免按钮操作控制器旧身份。 */
export function resolveServerOpsAgentAccessViewState({
  projection,
  sessionId,
  hostId,
}: ServerOpsAgentAccessViewStateInput): ServerOpsAgentAccessViewState {
  if (!hostId) {
    return {
      agentAccessAvailable: false,
      agentAccessGranted: false,
      agentAccessStatus: 'idle',
      agentAccessError: null,
      agentAccessDisabledReason: '请先选择服务器',
    }
  }
  if (!sessionId) {
    return {
      agentAccessAvailable: false,
      agentAccessGranted: false,
      agentAccessStatus: 'idle',
      agentAccessError: null,
      agentAccessDisabledReason: '请先打开普通 Agent 会话',
    }
  }
  /** 当前 render 对应的精确授权目标。 */
  const target = { sessionId, hostId }
  /** 旧投影不得短暂影响新目标；effect 随后会读取主进程事实。 */
  if (!isSameAgentAccessTarget(projection.target, target)) {
    return {
      agentAccessAvailable: true,
      agentAccessGranted: false,
      agentAccessStatus: 'loading',
      agentAccessError: null,
    }
  }
  return {
    agentAccessAvailable: true,
    agentAccessGranted: isAgentAccessForTarget(projection.access, target) && projection.access.granted,
    agentAccessStatus: projection.status,
    agentAccessError: projection.error,
  }
}

/** 判断授权事实是否属于指定的精确组合。 */
function isAgentAccessForTarget(
  access: ServerOpsAgentAccess | null,
  target: ServerOpsAgentAccessTarget | null,
): access is ServerOpsAgentAccess {
  return Boolean(access && target && access.sessionId === target.sessionId && access.hostId === target.hostId)
}

/** 创建以主进程为权威、可抵御迟到 Promise 的授权投影控制器。 */
export function createServerOpsAgentAccessController(
  options: ServerOpsAgentAccessControllerOptions,
): ServerOpsAgentAccessController {
  /** 控制器当前负责的精确身份。 */
  let target: ServerOpsAgentAccessTarget | null = null
  /** 当前已发布投影，用于切换时保持既有权威事实。 */
  let projection: ServerOpsAgentAccessProjection = { target: null, access: null, status: 'idle', error: null }
  /** 每次身份、操作或相关事件变化都会递增，阻止旧 Promise 回写。 */
  let revision = 0
  /** 只有当前挂载 owner 可以发布投影或用户错误。 */
  let active = false

  /** 发布不可变投影，并同步控制器内部快照。 */
  const publish = (next: ServerOpsAgentAccessProjection): void => {
    if (!active) return
    projection = next
    options.publish(next)
  }
  /** 检查异步操作是否仍属于当前身份与代次。 */
  const isCurrent = (expectedRevision: number, expectedTarget: ServerOpsAgentAccessTarget): boolean => (
    active && revision === expectedRevision && isSameAgentAccessTarget(target, expectedTarget)
  )
  /** 把主进程返回的全局单槽事实投影到当前精确组合。 */
  const projectAccess = (
    current: ServerOpsAgentAccess | null,
    expectedTarget: ServerOpsAgentAccessTarget,
  ): ServerOpsAgentAccess | null => (
    isAgentAccessForTarget(current, expectedTarget) && current.granted ? current : null
  )

  return {
    activate: () => {
      if (active) return
      active = true
      ++revision
    },
    dispose: () => {
      active = false
      ++revision
      target = null
      projection = { target: null, access: null, status: 'idle', error: null }
    },
    select: async (nextTarget) => {
      if (!active) return
      if (isSameAgentAccessTarget(target, nextTarget)) return
      /** 身份切换前的组合必须先主动撤销。 */
      const previousTarget = target
      target = nextTarget
      const operationRevision = ++revision
      publish({
        target: nextTarget,
        access: null,
        status: nextTarget ? 'loading' : 'idle',
        error: null,
      })

      /** 旧组合撤销失败不阻断读取新组合，但会保留可见错误。 */
      let revokeError: string | null = null
      if (previousTarget) {
        try {
          await options.setAccess({ ...previousTarget, granted: false })
        } catch (error) {
          if (!active || revision !== operationRevision || !isSameAgentAccessTarget(target, nextTarget)) return
          revokeError = getErrorMessage(error)
          options.reportError(revokeError)
        }
      }
      if (!nextTarget || !isCurrent(operationRevision, nextTarget)) return

      try {
        /** 身份切换完成后读取该组合的主进程权威事实。 */
        const current = await options.getAccess(nextTarget)
        if (!isCurrent(operationRevision, nextTarget)) return
        publish({
          target: nextTarget,
          access: projectAccess(current, nextTarget),
          status: revokeError ? 'error' : 'ready',
          error: revokeError,
        })
      } catch (error) {
        if (!isCurrent(operationRevision, nextTarget)) return
        /** 查询失败不能沿用旧身份事实或伪造未授权成功。 */
        const message = getErrorMessage(error)
        publish({ target: nextTarget, access: null, status: 'error', error: message })
        options.reportError(message)
      }
    },
    toggle: async () => {
      if (!active || !target) return
      /** 捕获点击时的稳定身份，切换期间不得跟随外部选择漂移。 */
      const operationTarget = target
      const operationRevision = ++revision
      /** 仅精确匹配的权威投影可以决定下一步是授权还是撤销。 */
      const currentlyGranted = isAgentAccessForTarget(projection.access, operationTarget) && projection.access.granted
      publish({ ...projection, target: operationTarget, status: 'loading', error: null })
      try {
        const current = await options.setAccess({ ...operationTarget, granted: !currentlyGranted })
        if (!isCurrent(operationRevision, operationTarget)) return
        publish({
          target: operationTarget,
          access: projectAccess(current, operationTarget),
          status: 'ready',
          error: null,
        })
      } catch (error) {
        if (!isCurrent(operationRevision, operationTarget)) return
        /** 失败时保留操作前事实，绝不做乐观授权。 */
        const message = getErrorMessage(error)
        publish({ ...projection, target: operationTarget, status: 'error', error: message })
        options.reportError(message)
      }
    },
    handleChanged: (event) => {
      if (!active || !target) return
      /** 当前组合成为全局槽位时接管新事实。 */
      if (isAgentAccessForTarget(event.current, target)) {
        ++revision
        publish({ target, access: event.current.granted ? event.current : null, status: 'ready', error: null })
        return
      }
      /** 当前组合离开全局槽位时立即撤销本地投影。 */
      if (isAgentAccessForTarget(event.previous, target)) {
        ++revision
        publish({ target, access: null, status: 'ready', error: null })
      }
    },
    resetAfterDisconnect: (disconnectedTarget) => {
      if (!active || !isSameAgentAccessTarget(target, disconnectedTarget)) return
      ++revision
      publish({ target, access: null, status: 'ready', error: null })
    },
  }
}

/** 需要用户补录或替换 SSH 凭据的稳定错误码。 */
const SERVER_OPS_CREDENTIAL_RECOVERY_CODES = new Set([
  'SERVER_OPS_CREDENTIAL_REQUIRED',
  'SERVER_OPS_CREDENTIAL_DECRYPT_FAILED',
  'SERVER_OPS_SECURE_STORAGE_UNAVAILABLE',
  'SERVER_OPS_PRIVATE_KEY_UNAVAILABLE',
  'SERVER_OPS_AUTH_FAILED',
])

/** 判断连接前是否缺少非 Agent 认证所需的安全凭据。 */
export function shouldPromptForServerOpsCredential(host: ServerOpsHost): boolean {
  return host.authMethod !== 'ssh-agent' && !host.credentialRef
}

/** 判断连接错误是否应该进入凭据补录流程。 */
export function isServerOpsCredentialRecoveryState(state: ServerOpsConnectionState): boolean {
  return state.phase === 'error'
    && typeof state.errorCode === 'string'
    && SERVER_OPS_CREDENTIAL_RECOVERY_CODES.has(state.errorCode)
}

/** 绑定 Jotai 与 Electron IPC 的运维工作区。 */
export function ServerOpsWorkspace(): React.ReactElement {
  /** 当前 Renderer 缓存的服务器列表。 */
  const [hosts, setHosts] = useAtom(serverOpsHostsAtom)
  /** 服务器列表加载阶段。 */
  const [status, setStatus] = useAtom(serverOpsHostsStatusAtom)
  /** 最近一次列表读取错误。 */
  const [error, setError] = useAtom(serverOpsHostsErrorAtom)
  /** 每台主机的公开 SSH 连接状态。 */
  const [connectionStates, setConnectionStates] = useAtom(serverOpsConnectionStatesAtom)
  /** 跨会话保留的当前服务器 ID。 */
  const [selectedHostId, setSelectedHostId] = useAtom(selectedServerOpsHostIdAtom)
  /** 当前普通 Agent 会话决定授权身份的一半。 */
  const [currentAgentSessionId] = useAtom(currentAgentSessionIdAtom)
  /** 当前精确组合的主进程授权事实投影。 */
  const [agentAccessProjection, setAgentAccessProjection] = useAtom(serverOpsAgentAccessProjectionAtom)
  /** 当前控制台页签。 */
  const [activeSection, setActiveSection] = React.useState<ServerOpsSection>('overview')
  /** 服务器列表抽屉是否展开。 */
  const [drawerOpen, setDrawerOpen] = React.useState(false)
  /** 当前正在编辑的服务器；null 表示新建。 */
  const [editingHost, setEditingHost] = React.useState<ServerOpsHost | null>(null)
  /** 主机表单是否打开。 */
  const [dialogOpen, setDialogOpen] = React.useState(false)
  /** 主机写入是否正在进行。 */
  const [saving, setSaving] = React.useState(false)
  /** 等待用户确认删除的服务器。 */
  const [pendingDeleteHost, setPendingDeleteHost] = React.useState<ServerOpsHost | null>(null)
  /** 删除写入是否正在进行。 */
  const [deleting, setDeleting] = React.useState(false)
  /** SSH 登录表单是否打开。 */
  const [connectDialogOpen, setConnectDialogOpen] = React.useState(false)
  /** 最近一次登录失败的公开说明。 */
  const [connectError, setConnectError] = React.useState<string>()
  /** 首次 Host Key 确认是否正在 fresh reconnect。 */
  const [confirmingHostKey, setConfirmingHostKey] = React.useState(false)
  /** 审计页当前服务器范围。 */
  const [auditHostFilter, setAuditHostFilter] = React.useState<'current' | 'all'>('current')
  /** 审计页当前操作主体范围。 */
  const [auditActorFilter, setAuditActorFilter] = React.useState<ServerOpsAuditActor | 'all'>('all')
  /** 审计页当前操作范围。 */
  const [auditOperationFilter, setAuditOperationFilter] = React.useState<ServerOpsAuditOperation | 'all'>('all')
  /** 主进程返回的公开审计记录。 */
  const [auditRecords, setAuditRecords] = React.useState<ServerOpsAuditRecord[]>([])
  /** 审计页独立加载状态，不影响服务器资产视图。 */
  const [auditStatus, setAuditStatus] = React.useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  /** 审计读取失败的稳定公开错误。 */
  const [auditError, setAuditError] = React.useState<string | null>(null)
  /** 单组件生命周期内稳定的审计请求代次控制器。 */
  const [auditController] = React.useState(() => createServerOpsAuditController({
    listAudit: (filter) => window.electronAPI.listServerOpsAudit(filter),
    publish: (projection) => {
      setAuditRecords(projection.records)
      setAuditStatus(projection.status)
      setAuditError(projection.error)
    },
  }))
  /** 单组件生命周期内稳定的授权代次控制器，StrictMode effect 演练不会重建。 */
  const [agentAccessController] = React.useState(() => createServerOpsAgentAccessController({
    getAccess: (target) => window.electronAPI.getServerOpsAgentAccess(target),
    setAccess: (access) => window.electronAPI.setServerOpsAgentAccess(access),
    publish: setAgentAccessProjection,
    reportError: (message) => toast.error('服务器授权同步失败', { description: message }),
  }))

  /** 根据持久选择和实际列表解析当前服务器。 */
  const selectedHost = hosts.find((host) => host.id === selectedHostId) ?? hosts[0] ?? null
  /** 当前选中主机的公开连接状态。 */
  const selectedConnectionState = selectedHost ? connectionStates[selectedHost.id] : undefined
  /** 当前可授权的精确普通 Agent + 服务器组合。 */
  const agentAccessTarget = currentAgentSessionId && selectedHost
    ? { sessionId: currentAgentSessionId, hostId: selectedHost.id }
    : null
  /** render 同步门禁早于 effect，旧目标投影不会产生可点击窗口。 */
  const agentAccessViewState = resolveServerOpsAgentAccessViewState({
    projection: agentAccessProjection,
    sessionId: currentAgentSessionId,
    hostId: selectedHost?.id ?? null,
  })

  React.useEffect(() => {
    /** 每次真实挂载或 StrictMode setup 重放都建立新的 Renderer owner 代次。 */
    agentAccessController.activate()
    return () => {
      /** 卸载只失效 Renderer 回调，绝不撤销主进程授权。 */
      agentAccessController.dispose()
    }
  }, [agentAccessController])

  React.useEffect(() => {
    /** 每次真实挂载或 StrictMode setup 重放都建立新的审计 owner 代次。 */
    auditController.activate()
    return () => auditController.dispose()
  }, [auditController])

  React.useEffect(() => {
    /** 主进程广播的连接状态是 Renderer 唯一实时事实。 */
    const disposeState = window.electronAPI.onServerOpsConnectionState((state) => {
      setConnectionStates((current) => ({ ...current, [state.hostId]: state }))
    })
    return disposeState
  }, [setConnectionStates])

  React.useEffect(() => {
    /** 主进程全局单槽变化时只同步当前精确组合。 */
    return window.electronAPI.onServerOpsAgentAccessChanged((event) => {
      agentAccessController.handleChanged(event)
    })
  }, [agentAccessController])

  React.useEffect(() => {
    /** 控制器自行比较身份，StrictMode 重复 effect 不会撤销同一组合。 */
    void agentAccessController.select(agentAccessTarget)
  }, [agentAccessController, agentAccessTarget?.hostId, agentAccessTarget?.sessionId])

  /** 从主进程重新读取服务器资产。 */
  const loadHosts = React.useCallback(async (): Promise<void> => {
    setStatus('loading')
    setError(null)
    try {
      /** 主进程返回的权威服务器列表。 */
      const loaded = await window.electronAPI.listServerOpsHosts()
      setHosts(loaded)
      setSelectedHostId((current) => loaded.some((host) => host.id === current) ? current : loaded[0]?.id ?? null)
      setStatus('ready')
    } catch (loadError) {
      setError(getErrorMessage(loadError))
      setStatus('error')
    }
  }, [setError, setHosts, setSelectedHostId, setStatus])

  React.useEffect(() => {
    void loadHosts()
  }, [loadHosts])

  React.useEffect(() => {
    if (activeSection !== 'audit') return
    void auditController.select({
      hostFilter: auditHostFilter,
      actorFilter: auditActorFilter,
      operationFilter: auditOperationFilter,
      selectedHostId: selectedHost?.id ?? null,
    })
  }, [activeSection, auditActorFilter, auditController, auditHostFilter, auditOperationFilter, selectedHost?.id])

  /** 切换审计主体时清理与主体不兼容的操作筛选。 */
  const handleAuditActorFilterChange = (nextActor: ServerOpsAuditActor | 'all'): void => {
    setAuditActorFilter(nextActor)
    if (auditOperationFilter === 'all' || nextActor === 'all') return
    /** 服务操作只属于 user，其它远程动作只属于 Agent。 */
    const operationIsService = auditOperationFilter.startsWith('service-')
    if ((nextActor === 'user') !== operationIsService) setAuditOperationFilter('all')
  }

  /** 打开空白主机表单。 */
  const handleCreateHost = (): void => {
    setEditingHost(null)
    setDialogOpen(true)
  }

  /** 打开指定主机的编辑表单。 */
  const handleEditHost = (host: ServerOpsHost): void => {
    setEditingHost(host)
    setDialogOpen(true)
  }

  /** 使用本次表单凭据发起真实 SSH 登录。 */
  const handleConnect = async (credential?: ServerOpsCredentialInput): Promise<void> => {
    if (!selectedHost) return
    setConnectError(undefined)
    try {
      /** 主进程返回的公开连接结果。 */
      const state = await window.electronAPI.connectServerOpsHost({ hostId: selectedHost.id, cols: 80, rows: 24, ...(credential ? { credential } : {}) })
      setConnectionStates((current) => ({ ...current, [state.hostId]: state }))
      if (state.phase === 'connected') {
        setConnectDialogOpen(false)
        setActiveSection('terminal')
        toast.success('SSH 已连接')
      } else if (state.phase === 'host-key-required' || state.phase === 'blocked') {
        setConnectDialogOpen(false)
      } else if (state.phase === 'error') {
        /** 不含秘密的公开连接错误说明。 */
        const message = state.message ?? 'SSH 连接失败'
        setConnectError(message)
        if (isServerOpsCredentialRecoveryState(state)) {
          setConnectDialogOpen(true)
        } else if (!connectDialogOpen) {
          toast.error('SSH 连接失败', { description: message })
        }
      }
    } catch (connectFailure) {
      /** IPC 异常只展示收敛后的错误文本。 */
      const message = getErrorMessage(connectFailure)
      setConnectError(message)
      if (!connectDialogOpen) toast.error('SSH 连接失败', { description: message })
    }
  }

  /** 有安全凭据时直接连接，缺失时才打开临时补录表单。 */
  const handleOpenConnect = (): void => {
    if (!selectedHost) return
    setConnectError(undefined)
    if (shouldPromptForServerOpsCredential(selectedHost)) {
      setConnectDialogOpen(true)
      return
    }
    void handleConnect()
  }

  /** 确认首次指纹并从主进程 fresh-read 后重新登录。 */
  const handleConfirmHostKey = async (): Promise<void> => {
    if (!selectedHost || !selectedConnectionState?.candidate) return
    setConfirmingHostKey(true)
    try {
      /** 确认后新建连接返回的公开状态。 */
      const state = await window.electronAPI.confirmServerOpsHostKey({
        hostId: selectedHost.id,
        candidateId: selectedConnectionState.candidate.candidateId,
        cols: 80,
        rows: 24,
      })
      setConnectionStates((current) => ({ ...current, [state.hostId]: state }))
      if (state.phase === 'connected') {
        setActiveSection('terminal')
        toast.success('服务器指纹已确认，SSH 已连接')
      } else if (state.phase === 'error') {
        toast.error('SSH 连接失败', { description: state.message })
      }
    } finally {
      setConfirmingHostKey(false)
    }
  }

  /** 断开当前主机并释放远程 PTY。 */
  const handleDisconnect = async (): Promise<void> => {
    if (!selectedHost) return
    /** 断开开始时捕获精确身份，避免返回时错误清理新选择。 */
    const disconnectedTarget = agentAccessTarget
    /** 主进程确认资源释放后的公开状态。 */
    const state = await window.electronAPI.disconnectServerOpsHost(selectedHost.id)
    setConnectionStates((current) => ({ ...current, [state.hostId]: state }))
    if (disconnectedTarget) agentAccessController.resetAfterDisconnect(disconnectedTarget)
  }

  /** 原子保存主机，并在成功后更新全局选择。 */
  const handleSaveHost = async (input: ServerOpsSaveHostInput): Promise<void> => {
    setSaving(true)
    try {
      /** 主进程确认写盘后的服务器记录。 */
      const saved = await window.electronAPI.upsertServerOpsHost(input)
      setHosts((current) => {
        /** 编辑目标在当前 Renderer 快照中的位置。 */
        const index = current.findIndex((host) => host.id === saved.id)
        return index < 0
          ? [...current, saved]
          : current.map((host) => host.id === saved.id ? saved : host)
      })
      setSelectedHostId(saved.id)
      setDialogOpen(false)
      setDrawerOpen(false)
      toast.success(input.host.id ? '服务器已更新' : '服务器已添加')
    } catch (saveError) {
      toast.error('服务器保存失败', { description: getErrorMessage(saveError) })
    } finally {
      setSaving(false)
    }
  }

  /** 删除确认成功后更新列表，并选择下一台可用服务器。 */
  const handleConfirmDelete = async (): Promise<void> => {
    if (!pendingDeleteHost) return
    setDeleting(true)
    try {
      /** 当前待删除主机的稳定 ID。 */
      const deletedId = pendingDeleteHost.id
      await window.electronAPI.deleteServerOpsHost(deletedId)
      /** 删除后的本地服务器列表。 */
      const nextHosts = hosts.filter((host) => host.id !== deletedId)
      setHosts(nextHosts)
      setSelectedHostId((selected) => selected === deletedId ? nextHosts[0]?.id ?? null : selected)
      setPendingDeleteHost(null)
      toast.success('服务器已删除')
    } catch (deleteError) {
      toast.error('服务器删除失败', { description: getErrorMessage(deleteError) })
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="relative flex min-h-0 flex-1 overflow-hidden">
      <ServerOpsWorkspaceView
        status={status}
        error={error}
        hosts={hosts}
        selectedHost={selectedHost}
        activeSection={activeSection}
        connectionState={selectedConnectionState}
        agentSessionId={currentAgentSessionId}
        {...agentAccessViewState}
        terminalContent={selectedHost && selectedConnectionState?.phase === 'connected' && selectedConnectionState.connectionId
          ? <ServerOpsRemoteTerminal hostId={selectedHost.id} connectionId={selectedConnectionState.connectionId} />
          : undefined}
        auditStatus={auditStatus}
        auditError={auditError}
        auditRecords={auditRecords}
        auditHostFilter={auditHostFilter}
        auditActorFilter={auditActorFilter}
        auditOperationFilter={auditOperationFilter}
        onOpenDrawer={() => setDrawerOpen(true)}
        onCreateHost={handleCreateHost}
        onEditHost={handleEditHost}
        onDeleteHost={setPendingDeleteHost}
        onSectionChange={setActiveSection}
        onConnect={handleOpenConnect}
        onDisconnect={() => { void handleDisconnect() }}
        onToggleAgentAccess={() => { void agentAccessController.toggle() }}
        onRefresh={() => void loadHosts()}
        onAuditHostFilterChange={setAuditHostFilter}
        onAuditActorFilterChange={handleAuditActorFilterChange}
        onAuditOperationFilterChange={setAuditOperationFilter}
        onRefreshAudit={() => { void auditController.refresh() }}
      />
      <ServerOpsHostDrawer
        open={drawerOpen}
        hosts={hosts}
        selectedHostId={selectedHost?.id ?? null}
        onOpenChange={setDrawerOpen}
        onSelect={setSelectedHostId}
        onCreate={handleCreateHost}
        onEdit={handleEditHost}
        onDelete={setPendingDeleteHost}
      />
      <ServerOpsHostDialog
        open={dialogOpen}
        host={editingHost}
        saving={saving}
        onOpenChange={setDialogOpen}
        onSubmit={handleSaveHost}
      />
      <ServerOpsConnectDialog
        open={connectDialogOpen}
        host={selectedHost}
        connecting={selectedConnectionState?.phase === 'connecting'}
        error={connectError}
        requireCredential={Boolean(connectError)}
        onOpenChange={setConnectDialogOpen}
        onSubmit={handleConnect}
      />
      <AlertDialog
        open={selectedConnectionState?.phase === 'host-key-required'}
        onOpenChange={(open) => { if (!open && !confirmingHostKey) void handleDisconnect() }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认服务器指纹</AlertDialogTitle>
            <AlertDialogDescription>
              这是 Proma 第一次连接“{selectedHost?.name ?? '该服务器'}”。请与服务器管理员提供的指纹核对，确认前不会发送登录凭据。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2 border-y border-border py-3 text-xs">
            <div className="text-muted-foreground">{selectedConnectionState?.candidate?.algorithm}</div>
            <div className="break-all font-mono">{selectedConnectionState?.candidate?.fingerprint}</div>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={confirmingHostKey}>取消</AlertDialogCancel>
            <AlertDialogAction disabled={confirmingHostKey} onClick={(event) => { event.preventDefault(); void handleConfirmHostKey() }}>
              {confirmingHostKey ? '正在连接...' : '信任并连接'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={selectedConnectionState?.phase === 'blocked'} onOpenChange={(open) => { if (!open) void handleDisconnect() }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>服务器指纹已变化</AlertDialogTitle>
            <AlertDialogDescription>
              连接已阻断。这可能表示服务器重装，也可能是中间人攻击；核实原因并在独立信任设置中替换指纹后才能连接。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-3 border-y border-border py-3 text-xs">
            <div><div className="mb-1 text-muted-foreground">原指纹</div><div className="break-all font-mono">{selectedConnectionState?.previousHostKey?.fingerprint}</div></div>
            <div><div className="mb-1 text-muted-foreground">新指纹</div><div className="break-all font-mono text-destructive">{selectedConnectionState?.hostKey?.fingerprint}</div></div>
          </div>
          <AlertDialogFooter><AlertDialogAction onClick={() => { void handleDisconnect() }}>关闭</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={pendingDeleteHost !== null} onOpenChange={(open) => { if (!open && !deleting) setPendingDeleteHost(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除服务器</AlertDialogTitle>
            <AlertDialogDescription>
              将删除“{pendingDeleteHost?.name ?? '该服务器'}”的本地主机配置。服务器本身不会受到影响。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(event) => { event.preventDefault(); void handleConfirmDelete() }}
            >
              {deleting ? '正在删除...' : '删除'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
