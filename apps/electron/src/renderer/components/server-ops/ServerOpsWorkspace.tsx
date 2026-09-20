import * as React from 'react'
import { isServerOpsAuditActorOperation } from '@proma/shared'
import { atom, useAtom, useStore } from 'jotai'
import {
  Box,
  ClipboardList,
  FileText,
  Fingerprint,
  FolderOpen,
  Gauge,
  LoaderCircle,
  LogIn,
  MoreHorizontal,
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
  AgentSessionMeta,
  ServerOpsAgentAccess,
  ServerOpsAgentAccessChanged,
  ServerOpsAgentAccessTarget,
  ServerOpsConnectionState,
  ServerOpsCredentialInput,
  ServerOpsDataEngine,
  ServerOpsDataSourceUpsertInput,
  ServerOpsHost,
  ServerOpsSaveHostInput,
  ServerOpsAuditActor,
  ServerOpsAuditOperation,
  ServerOpsAuditListInput,
  ServerOpsAuditListResult,
  ServerOpsAuditRecord,
} from '@proma/shared'
import { isOrdinaryTopLevelAgentSession } from '@proma/shared'
import { agentSessionsAtom, currentAgentSessionIdAtom } from '@/atoms/agent-atoms'
import {
  serverOpsAgentAccessProjectionAtom,
  serverOpsConnectionStatesAtom,
  serverOpsDataSourcesAtom,
  serverOpsDataSourcesErrorAtom,
  serverOpsDataSourcesStatusAtom,
  serverOpsHostsAtom,
  serverOpsHostsErrorAtom,
  serverOpsHostsStatusAtom,
  serverOpsProjectsAtom,
  serverOpsProjectsErrorAtom,
  serverOpsProjectsStatusAtom,
  selectedServerOpsConnectionIdAtom,
  selectedServerOpsProjectIdAtom,
} from '@/atoms/server-ops-atoms'
import type { ServerOpsAgentAccessProjection, ServerOpsAgentAccessStatus, ServerOpsHostsStatus } from '@/atoms/server-ops-atoms'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import { ServerOpsHostDialog } from './ServerOpsHostDialog'
import { ServerOpsDataSourceDialog } from './ServerOpsDataSourceDialog'
import { ServerOpsConnectDialog } from './ServerOpsConnectDialog'
import { ServerOpsRemoteTerminal } from './ServerOpsRemoteTerminal'
import { ServerOpsOverviewPanel } from './ServerOpsOverviewPanel'
import { ServerOpsServicesPanel } from './ServerOpsServicesPanel'
import { ServerOpsLogsPanel } from './ServerOpsLogsPanel'
import { ServerOpsTrustDialog } from './ServerOpsTrustDialog'
import { ServerOpsDockerPanel } from './ServerOpsDockerPanel'
import type { ServerOpsDockerPanelApi } from './ServerOpsDockerPanel'
import type { ServerOpsDataPanelApi } from './ServerOpsDataServicesPanel'
import { ServerOpsDataConnectionView } from './ServerOpsDataConnectionView'
import { ServerOpsProjectDrawer } from './ServerOpsProjectDrawer'
import { ServerOpsProjectDialog } from './ServerOpsProjectDialog'
import { ServerOpsConnectionMoveDialog } from './ServerOpsConnectionMoveDialog'
import { createServerOpsConnectionMoveController, createServerOpsConnectionMoveIdleProjection, mergeServerOpsMovedAsset } from './server-ops-connection-move-controller'
import { ServerOpsProjectView } from './ServerOpsProjectView'
import { ServerOpsAgentReadAccess } from './ServerOpsAgentReadAccess'
import {
  buildServerOpsConnections,
  createServerOpsDataConnectionId,
  createServerOpsSshConnectionId,
  listServerOpsProjectConnections,
  resolveServerOpsWorkspaceTarget,
  summarizeServerOpsConnections,
} from './server-ops-connections'
import type { ServerOpsConnection, ServerOpsConnectionKind, ServerOpsConnectionSource } from './server-ops-connections'
import {
  SERVER_OPS_SEGMENTED_CLASS,
  SERVER_OPS_TAB_CLASS,
  SERVER_OPS_TABS_LIST_CLASS,
  SERVER_OPS_TOOLBAR_CLASS,
} from './server-ops-ui'
import { createServerOpsProjectController, createServerOpsProjectsIdleProjection } from './server-ops-project-controller'
import type { ServerOpsProjectControllerOptions } from './server-ops-project-controller'
import { resolveServerOpsCurrentProjectId } from './server-ops-project-controller'
import { createServerOpsDataSourceListController } from './server-ops-data-source-list-controller'
import { getServerOpsDataErrorMessage } from './server-ops-data-display'
import { ServerOpsFilesWorkspace } from './ServerOpsFilesWorkspace'
import { ServerOpsDockerConsole } from './ServerOpsDockerConsole'
import { useServerOpsTransferLeave } from './useServerOpsTransferLeave'
import type { ServerOpsFilesPreload } from '../../../preload/server-ops-files-preload'
import type { ServerOpsConsolePreloadApi } from '../../../preload/server-ops-console-preload'
import type { ServerOpsTransferPreload } from '../../../preload/server-ops-transfer-preload'

/** 延迟读取实际 preload，允许无 Electron 的静态视图测试。 */
const serverOpsDockerApi: ServerOpsDockerPanelApi = {
  listServerOpsDockerResources: (input) => window.electronAPI.listServerOpsDockerResources(input),
  getServerOpsDockerContainerDetail: (input) => window.electronAPI.getServerOpsDockerContainerDetail(input),
  prepareServerOpsDockerAction: (input) => window.electronAPI.prepareServerOpsDockerAction(input),
  commitServerOpsDockerAction: (input) => window.electronAPI.commitServerOpsDockerAction(input),
  cancelServerOpsDockerAction: (input) => window.electronAPI.cancelServerOpsDockerAction(input),
}

/** 文件面板使用稳定 bridge；每次调用才取得实际 Electron API。 */
const serverOpsFilesApi: ServerOpsFilesPreload = {
  listServerOpsFiles: (input) => window.electronAPI.listServerOpsFiles(input),
  previewServerOpsFile: (input) => window.electronAPI.previewServerOpsFile(input),
  prepareServerOpsFileMutation: (input) => window.electronAPI.prepareServerOpsFileMutation(input),
  commitServerOpsFileMutation: (input) => window.electronAPI.commitServerOpsFileMutation(input),
  cancelServerOpsFileMutation: (input) => window.electronAPI.cancelServerOpsFileMutation(input),
  closeServerOpsFilesOwner: (input) => window.electronAPI.closeServerOpsFilesOwner(input),
}

/** 文件选择、传输进度和取消均经由所属窗口的类型安全 bridge。 */
const serverOpsTransferApi: ServerOpsTransferPreload = {
  selectServerOpsUploadFile: (input) => window.electronAPI.selectServerOpsUploadFile(input),
  selectServerOpsDownloadFile: (input) => window.electronAPI.selectServerOpsDownloadFile(input),
  releaseServerOpsFileSelection: (input) => window.electronAPI.releaseServerOpsFileSelection(input),
  startServerOpsTransfer: (input) => window.electronAPI.startServerOpsTransfer(input),
  listServerOpsTransfers: (input) => window.electronAPI.listServerOpsTransfers(input),
  cancelServerOpsTransfer: (input) => window.electronAPI.cancelServerOpsTransfer(input),
  closeServerOpsTransferOwner: (input) => window.electronAPI.closeServerOpsTransferOwner(input),
  onServerOpsTransferProgress: (listener) => window.electronAPI.onServerOpsTransferProgress(listener),
}

/** 容器终端的输入、快照和事件使用独立 bridge。 */
const serverOpsConsoleApi: ServerOpsConsolePreloadApi = {
  startServerOpsConsole: (input) => window.electronAPI.startServerOpsConsole(input),
  closeServerOpsConsole: (input) => window.electronAPI.closeServerOpsConsole(input),
  writeServerOpsConsole: (input) => window.electronAPI.writeServerOpsConsole(input),
  resizeServerOpsConsole: (input) => window.electronAPI.resizeServerOpsConsole(input),
  acknowledgeServerOpsConsoleOutput: (input) => window.electronAPI.acknowledgeServerOpsConsoleOutput(input),
  getServerOpsConsoleSnapshot: (input) => window.electronAPI.getServerOpsConsoleSnapshot(input),
  onServerOpsConsoleOutput: (listener) => window.electronAPI.onServerOpsConsoleOutput(listener),
  onServerOpsConsoleExit: (listener) => window.electronAPI.onServerOpsConsoleExit(listener),
}

/** 数据服务只读查询与数据源管理使用独立 bridge。 */
export const serverOpsDataApi: ServerOpsDataPanelApi = {
  listServerOpsDataSources: (input) => window.electronAPI.listServerOpsDataSources(input),
  upsertServerOpsDataSource: (input) => window.electronAPI.upsertServerOpsDataSource(input),
  deleteServerOpsDataSource: (input) => window.electronAPI.deleteServerOpsDataSource(input),
  probeServerOpsDataSource: (input) => window.electronAPI.probeServerOpsDataSource(input),
  diagnoseServerOpsDataSource: (input) => window.electronAPI.diagnoseServerOpsDataSource(input),
  revealServerOpsDataSourcePassword: (input) => window.electronAPI.revealServerOpsDataSourcePassword(input),
  listServerOpsDataSchemaTables: (input) => window.electronAPI.listServerOpsDataSchemaTables(input),
  describeServerOpsDataSchemaTable: (input) => window.electronAPI.describeServerOpsDataSchemaTable(input),
  readServerOpsDataSchemaRows: (input) => window.electronAPI.readServerOpsDataSchemaRows(input),
  /** 延迟读取真实可选接口；热更新遇到旧 preload 时保留 undefined，让查询门禁生效。 */
  get queryServerOpsDatabase() { return window.electronAPI.queryServerOpsDatabase },
  get cancelServerOpsDatabaseQuery() { return window.electronAPI.cancelServerOpsDatabaseQuery },
  /** 历史同样保留桥接能力缺失，避免包装函数掩盖版本不一致。 */
  get listServerOpsDatabaseQueryHistory() { return window.electronAPI.listServerOpsDatabaseQueryHistory },
  get saveServerOpsDatabaseQueryHistory() { return window.electronAPI.saveServerOpsDatabaseQueryHistory },
}

/**
 * SSH 连接的能力页签。
 *
 * 数据服务不再是页签：数据库 / Redis 是项目内的独立连接，
 * 从项目视图点进去就是数据服务详情，页签里不需要第二个指向同一批数据的入口。
 */
export type ServerOpsSection = 'overview' | 'terminal' | 'services' | 'logs' | 'files' | 'docker' | 'audit'

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
  containerLog?: { hostId: string; containerId: string } | null
  containerConsole?: { hostId: string; containerId: string } | null
  onContainerLogChange?: (target: { hostId: string; containerId: string } | null) => void
  onContainerConsoleChange?: (target: { hostId: string; containerId: string } | null) => void
  onOpenDrawer: () => void
  /** 当前项目名；作为连接视图面包屑的第一段（同时也是返回项目视图的入口）。 */
  projectLabel?: string
  /**
   * 返回项目视图。
   *
   * 能力页签挂在"选中的 SSH 连接"下面，项目分组列表在中间区域展示，
   * 因此连接视图必须能回到自己所属项目的分组视图。
   */
  onBackToProject?: () => void
  onCreateHost: () => void
  onEditHost: (host: ServerOpsHost) => void
  onDeleteHost: (host: ServerOpsHost) => void
  onSectionChange: (section: ServerOpsSection) => void
  onConnect?: () => void
  onDisconnect?: () => void
  onToggleAgentAccess?: () => void
  onManageTrust?: () => void
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
  'data-query': 'SQL 查询',
  'agent-read': 'Agent 只读访问',
  connect: '连接',
  exec: '执行命令',
  disconnect: '断开',
  'service-start': '启动',
  'service-stop': '停止',
  'service-restart': '重启',
  'service-enable': '启用',
  'service-disable': '禁用',
  'trust-replace': '替换服务器信任',
  'trust-revoke': '撤销服务器信任',
  'docker-start': '启动容器',
  'docker-stop': '停止容器',
  'docker-restart': '重启容器',
  'file-mkdir': '新建目录',
  'file-rename': '重命名文件',
  'file-delete': '删除文件',
  'file-save': '保存文件',
  'file-save-as': '另存文件',
  'file-upload': '上传文件',
  'file-download': '下载文件',
}

/** 审计记录主体的中文标签。 */
const SERVER_OPS_AUDIT_ACTOR_LABELS: Record<ServerOpsAuditActor, string> = {
  agent: 'Agent',
  user: '用户',
}

/** 审计操作筛选的固定顺序。 */
const SERVER_OPS_AUDIT_OPERATIONS: readonly ServerOpsAuditOperation[] = [
  'agent-read',
  'data-query',
  'connect', 'exec', 'disconnect',
  'service-start', 'service-stop', 'service-restart', 'service-enable', 'service-disable',
  'trust-replace', 'trust-revoke',
  'docker-start', 'docker-stop', 'docker-restart',
  'file-mkdir', 'file-rename', 'file-delete', 'file-save', 'file-save-as', 'file-upload', 'file-download',
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
    || isServerOpsAuditActorOperation(actorFilter, operation)
  ))
  return (
    <div className="flex min-h-0 flex-1 flex-col" style={{ containerType: 'inline-size' }} data-server-ops-audit>
      <style>{'@container (min-width: 620px) { [data-server-ops-audit-filters="true"] { grid-template-columns: auto minmax(7rem, 10rem) minmax(8rem, 12rem) 1fr; } [data-server-ops-audit-row="true"] { grid-template-columns: 9rem 4rem 5.5rem 4rem minmax(0, 1fr); } }'}</style>
      <div className="grid shrink-0 grid-cols-2 items-center gap-2 border-b border-border/40 px-4 py-2" data-server-ops-audit-filters>
        <div className={SERVER_OPS_SEGMENTED_CLASS} aria-label="筛选审计服务器">
          {(['current', 'all'] as const).map((filter) => (
            <button
              key={filter}
              type="button"
              className={cn('h-7 shrink-0 rounded-md px-2 text-[11px] transition-colors', hostFilter === filter ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}
              aria-pressed={hostFilter === filter}
              onClick={() => onHostFilterChange?.(filter)}
            >
              {filter === 'current' ? '当前服务器' : '全部服务器'}
            </button>
          ))}
        </div>
        <select
          className="h-8 min-w-0 rounded-md border border-input bg-background px-2 text-[11px] text-foreground"
          aria-label="筛选审计主体"
          value={actorFilter}
          onChange={(event) => onActorFilterChange?.(event.target.value as ServerOpsAuditActor | 'all')}
        >
          <option value="all">全部主体</option>
          <option value="agent">Agent</option>
          <option value="user">用户</option>
        </select>
        <select
          className="h-8 min-w-0 rounded-md border border-input bg-background px-2 text-[11px] text-foreground"
          aria-label="筛选审计操作"
          value={operationFilter}
          onChange={(event) => onOperationFilterChange?.(event.target.value as ServerOpsAuditOperation | 'all')}
        >
          <option value="all">全部操作</option>
          {availableOperations.map((operation) => (
            <option key={operation} value={operation}>{SERVER_OPS_AUDIT_OPERATION_LABELS[operation]}</option>
          ))}
        </select>
        <Button type="button" variant="ghost" size="icon-sm" className="ml-auto justify-self-end" aria-label="刷新审计记录" onClick={onRefresh}>
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
          <div className="divide-y divide-border/30">
            {[...records].reverse().map((record) => (
              <div key={record.id} className="grid min-w-0 grid-cols-[minmax(7rem,auto)_minmax(0,1fr)] gap-x-3 gap-y-1 px-4 py-2 text-xs" data-server-ops-audit-row>
                <time className="whitespace-nowrap text-muted-foreground" dateTime={new Date(record.timestamp).toISOString()}>
                  {new Date(record.timestamp).toLocaleString()}
                </time>
                <span className="text-muted-foreground">{SERVER_OPS_AUDIT_ACTOR_LABELS[record.actor]}</span>
                <span className="font-medium">{SERVER_OPS_AUDIT_OPERATION_LABELS[record.operation]}</span>
                <span className={record.phase === 'start' || record.outcome === 'unknown'
                  ? 'text-muted-foreground'
                  : record.outcome === 'error' ? 'text-destructive' : 'text-emerald-600 dark:text-emerald-400'}>
                  {record.phase === 'start' ? '进行中' : record.outcome === 'unknown' ? '结果未知' : record.outcome === 'error' ? '失败' : '成功'}
                </span>
                <div className="min-w-0 break-words font-mono text-[11px] text-muted-foreground">
                  {record.operation === 'exec' ? record.command : record.unitId}
                  {record.operation === 'agent-read' ? <span>{record.readAction} · {record.sourceId ?? record.hostId}{record.database ? ` · ${record.database}` : ''}{record.table ? ` / ${record.table}` : ''}</span> : null}
                  {record.operation === 'data-query' ? <span>SQL 查询 · {record.sourceId} · {record.database}{record.tables?.length ? ` / ${record.tables.join('、')}` : ''}</span> : null}
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
  containerLog = null,
  containerConsole = null,
  onContainerLogChange,
  onContainerConsoleChange,
  onOpenDrawer,
  onBackToProject,
  projectLabel,
  onCreateHost,
  onEditHost,
  onDeleteHost,
  onSectionChange,
  onConnect,
  onDisconnect,
  onToggleAgentAccess,
  onManageTrust,
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
      <div className={cn(SERVER_OPS_TOOLBAR_CLASS, 'min-h-14 px-4')} data-server-ops-toolbar>
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button type="button" variant="ghost" size="icon-sm" aria-label="打开项目列表" onClick={onOpenDrawer}>
                <PanelLeft className="size-3.5" aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">项目列表</TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <div className="min-w-0 flex-1">
          {/*
            身份只写一遍：第一行是"项目 › 服务器"面包屑（项目段可点，代替独立的返回按钮），
            第二行是这条连接的登录身份。
          */}
          <div className="flex min-w-0 items-center gap-1 text-xs font-medium">
            {onBackToProject && projectLabel ? (
              <button
                type="button"
                className="truncate rounded-sm px-0.5 text-muted-foreground transition-colors hover:text-foreground"
                aria-label="返回项目视图"
                data-server-ops-connection-project
                onClick={onBackToProject}
              >
                {projectLabel}
              </button>
            ) : null}
            {onBackToProject && projectLabel ? <span className="shrink-0 text-muted-foreground" aria-hidden="true">›</span> : null}
            <span className="flex min-w-0 items-center gap-1.5 truncate" data-server-ops-connection-module>
              <Server className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              {selectedHost?.name ?? '服务器运维'}
            </span>
          </div>
          {selectedHost && <div className="truncate font-mono text-[11px] text-muted-foreground">{selectedHost.username}@{selectedHost.address}:{selectedHost.port}</div>}
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
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="ghost" size="icon-sm" aria-label="更多服务器操作">
                  <MoreHorizontal className="size-3.5" aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="z-[9999] min-w-40">
                <DropdownMenuItem aria-label="管理服务器信任" onSelect={onManageTrust}>
                  <Fingerprint className="size-3.5" aria-hidden="true" />管理服务器信任
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onEditHost(selectedHost)}>
                  <Pencil className="size-3.5" aria-hidden="true" />编辑服务器
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => onDeleteHost(selectedHost)}>
                  <Trash2 className="size-3.5" aria-hidden="true" />删除服务器
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
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
          <nav className={SERVER_OPS_TABS_LIST_CLASS} aria-label="服务器控制台">
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
                    SERVER_OPS_TAB_CLASS,
                    active && 'bg-muted text-foreground',
                  )}
                  aria-current={active ? 'page' : undefined}
                  onClick={() => { if (section.id !== 'docker') onContainerConsoleChange?.(null); onSectionChange(section.id) }}
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
            className={activeSection === 'logs' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}
            aria-hidden={activeSection !== 'logs'}
            data-server-ops-logs-container
          >
            {containerLog?.hostId === selectedHost.id && (
              <Button variant="ghost" size="sm" onClick={() => onContainerLogChange?.(null)} aria-label="返回系统日志">
                <Server className="size-3.5" aria-hidden="true" />系统日志
              </Button>
            )}
            <ServerOpsLogsPanel
              hostId={selectedHost.id}
              connectionId={connectionState?.hostId === selectedHost.id && connectionState.phase === 'connected'
                ? connectionState.connectionId ?? null
                : null}
              active={activeSection === 'logs'}
              connected={connected}
              fixedSource={containerLog?.hostId === selectedHost.id ? { kind: 'container', containerId: containerLog.containerId } : undefined}
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
            : activeSection === 'files'
              ? <ServerOpsFilesWorkspace
                  key={getServerOpsOverviewInstanceKey(selectedHost.id, connectionState)}
                  api={serverOpsFilesApi}
                  transferApi={serverOpsTransferApi}
                  hostId={selectedHost.id}
                  hostLabel={selectedHost.name}
                  hostDescription={`${selectedHost.username}@${selectedHost.address}:${selectedHost.port}`}
                  active
                  connected={connected}
                />
            : activeSection === 'docker' && connected && containerConsole?.hostId === selectedHost.id
              ? <div className="flex min-h-0 flex-1 flex-col">
                  <div className="flex h-9 shrink-0 items-center border-b border-border px-2">
                    <Button variant="ghost" size="sm" onClick={() => onContainerConsoleChange?.(null)}><Box className="size-3.5" />返回容器列表</Button>
                    <span className="truncate px-2 font-mono text-xs text-muted-foreground">{containerConsole.containerId.slice(0, 12)}</span>
                  </div>
                  <ServerOpsDockerConsole key={getServerOpsOverviewInstanceKey(selectedHost.id, connectionState)} api={serverOpsConsoleApi} hostId={selectedHost.id} containerId={containerConsole.containerId} active />
                </div>
            : activeSection === 'docker'
              ? <ServerOpsDockerPanel
                  key={getServerOpsOverviewInstanceKey(selectedHost.id, connectionState)}
                  api={serverOpsDockerApi}
                  hostId={selectedHost.id}
                  hostLabel={selectedHost.name}
                  hostDescription={`${selectedHost.username}@${selectedHost.address}:${selectedHost.port}`}
                  active
                  connected={connected}
                  onOpenContainerConsole={(containerId) => onContainerConsoleChange?.({ hostId: selectedHost.id, containerId })}
                  onOpenContainerLogs={(containerId) => {
                    onContainerLogChange?.({ hostId: selectedHost.id, containerId })
                    onSectionChange('logs')
                  }}
                />
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
  /** 会话存在但不可用于授权时的稳定原因；缺省表示确实没有会话。 */
  sessionUnavailableReason?: string
}

/** 授权目标解析结果；`sessionId` 为 null 时不会发起任何主进程请求。 */
export interface ServerOpsAgentAccessSessionResolution {
  sessionId: string | null
  unavailableReason?: string
}

/**
 * 解析可用于服务器授权的会话身份。
 *
 * 主进程只允许普通顶层交互式 Agent 获得服务器授权，定时任务、子会话与画布派生会话都会被拒绝。
 * 这里提前用同一份 `@proma/shared` 规则判断，把按钮置灰并给出原因，避免点下去才报错；
 * 真正的主进程守卫保持不变，渲染层判断只影响交互提示。
 *
 * @param sessions Renderer 已加载的会话元数据
 * @param sessionId 当前会话 ID
 * @returns 可授权时返回原 ID，不可授权时返回 null 与稳定原因
 */
export function resolveServerOpsAgentAccessSession(
  sessions: readonly AgentSessionMeta[],
  sessionId: string | null,
): ServerOpsAgentAccessSessionResolution {
  if (!sessionId) return { sessionId: null }
  /** 当前会话元数据；尚未加载时保持原行为，由主进程兜底。 */
  const session = sessions.find((entry) => entry.id === sessionId)
  if (!session) return { sessionId }
  if (isOrdinaryTopLevelAgentSession(session)) return { sessionId }
  return {
    sessionId: null,
    unavailableReason: '当前会话不是普通 Agent 会话（定时任务或子会话），请切换会话后再授权',
  }
}

/** 授权身份依据全局连接选择解析，项目只控制连接列表的展示归属。 */
interface ServerOpsAgentAccessTargetInput {
  sessionId: string | null
  projectViewActive: boolean
  selectedConnectionId: string | null
  connections: readonly ServerOpsConnection[]
}

/**
 * 移动主机时保留精确授权身份；显式进入项目、选择数据连接或删除主机仍解除绑定。
 * @param input 普通会话、显式导航状态、选中 ID 与全局连接事实
 * @returns 精确 sessionId + hostId 组合；没有有效 SSH 选择时返回 null
 */
export function resolveServerOpsAgentAccessTarget(input: ServerOpsAgentAccessTargetInput): ServerOpsAgentAccessTarget | null {
  if (!input.sessionId || input.projectViewActive) return null
  /** 通过全局连接事实精确命中，不能从 ID 字符串推测已删除或不存在的主机。 */
  const connection = input.connections.find((entry) => entry.id === input.selectedConnectionId)
  return connection?.kind === 'ssh' && connection.hostId
    ? { sessionId: input.sessionId, hostId: connection.hostId }
    : null
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
  sessionUnavailableReason,
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
      agentAccessDisabledReason: sessionUnavailableReason ?? '请先打开普通 Agent 会话',
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
export function ServerOpsWorkspace({ viewScope = 'default', paneActive = true }: { viewScope?: string; paneActive?: boolean } = {}): React.ReactElement {
  /** 多个 Pane 的项目列表共用同一 Jotai Store，操作弹窗仍各自独立。 */
  const workspaceStore = useStore()
  /** 当前 Renderer 缓存的服务器列表。 */
  const [hosts, setHosts] = useAtom(serverOpsHostsAtom)
  /** 服务器列表加载阶段。 */
  const [status, setStatus] = useAtom(serverOpsHostsStatusAtom)
  /** 最近一次列表读取错误。 */
  const [error, setError] = useAtom(serverOpsHostsErrorAtom)
  /** 每台主机的公开 SSH 连接状态。 */
  const [connectionStates, setConnectionStates] = useAtom(serverOpsConnectionStatesAtom)
  /** 全部数据源；数据库与 Redis 连接由它构造。 */
  const [dataSources, setDataSources] = useAtom(serverOpsDataSourcesAtom)
  const [dataSourcesStatus, setDataSourcesStatus] = useAtom(serverOpsDataSourcesStatusAtom)
  const [dataSourcesError, setDataSourcesError] = useAtom(serverOpsDataSourcesErrorAtom)
  /** 跨会话保留的当前连接 ID（`ssh:<hostId>` 或 `data:<sourceId>`）。 */
  const [selectedConnectionId, setSelectedConnectionId] = useAtom(selectedServerOpsConnectionIdAtom)
  /** 当前普通 Agent 会话决定授权身份的一半。 */
  const [currentAgentSessionId] = useAtom(currentAgentSessionIdAtom)
  /** Renderer 已加载的会话元数据，用于提前判断会话是否支持服务器授权。 */
  const [agentSessions] = useAtom(agentSessionsAtom)
  /** 项目列表的公开投影。 */
  const [projects, setProjects] = useAtom(serverOpsProjectsAtom)
  const [projectsStatus, setProjectsStatus] = useAtom(serverOpsProjectsStatusAtom)
  const [projectsError, setProjectsError] = useAtom(serverOpsProjectsErrorAtom)
  /** 用户最后选择的项目与写入口。 */
  const [selectedProjectId, setSelectedProjectId] = useAtom(selectedServerOpsProjectIdAtom)
  /** 筛选属于当前 Pane；记录项目身份以同步隔离上一项目的搜索，不写入业务配置。 */
  const projectBrowseAtom = React.useMemo(() => atom<{ projectId: string | null; kind: ServerOpsConnectionKind | 'all'; query: string }>({ projectId: null, kind: 'all', query: '' }), [])
  const [projectBrowseState, setProjectBrowseState] = useAtom(projectBrowseAtom)
  /** 每个工作区独立的操作投影，避免不同 Pane 共享弹窗草稿或提交状态。 */
  const projectManagementAtom = React.useMemo(() => atom(createServerOpsProjectsIdleProjection()), [])
  /** 项目表单和错误随控制器投影一起更新。 */
  const [projectManagement, setProjectManagement] = useAtom(projectManagementAtom)
  /** 移动弹窗属于当前 Pane，资产回执仍写入全局共享 atoms。 */
  const connectionMoveAtom = React.useMemo(() => atom(createServerOpsConnectionMoveIdleProjection()), [])
  const [connectionMove, setConnectionMove] = useAtom(connectionMoveAtom)
  /** 持续存在的连接菜单按钮及项目视图，供弹窗关闭时恢复焦点。 */
  const connectionMoveFocusRef = React.useRef<{ trigger: HTMLElement | null; view: HTMLElement | null }>({ trigger: null, view: null })
  /** 移动成功后连接行会卸载，焦点回到原项目的列表入口。 */
  const restoreConnectionMoveFocus = (): void => {
    /** 本次操作的入口与所属项目视图。 */
    const { trigger, view } = connectionMoveFocusRef.current
    if (trigger?.isConnected) trigger.focus()
    else if (view?.isConnected) view.querySelector<HTMLElement>('[aria-label="打开项目列表"]')?.focus()
  }
  /** 移动仅提交项目元数据，不触发 SSH 连接、密码写入或诊断。 */
  const [connectionMoveController] = React.useState(() => createServerOpsConnectionMoveController({
    getProjects: () => workspaceStore.get(serverOpsProjectsAtom),
    getConnections: () => buildServerOpsConnections({
      projects: workspaceStore.get(serverOpsProjectsAtom),
      hosts: workspaceStore.get(serverOpsHostsAtom),
      dataSources: workspaceStore.get(serverOpsDataSourcesAtom),
      connectionStates: workspaceStore.get(serverOpsConnectionStatesAtom),
    }),
    move: (input) => window.electronAPI.moveServerOpsConnection(input),
    acceptMoved: (result, input) => {
      if (result.kind === 'ssh') {
        workspaceStore.set(serverOpsHostsAtom, (current) => mergeServerOpsMovedAsset(current, result.host, input.fromProjectId))
      } else {
        workspaceStore.set(serverOpsDataSourcesAtom, (current) => mergeServerOpsMovedAsset(current, result.source, input.fromProjectId))
      }
    },
    onSuccess: (name) => toast.success(`已移动到「${name}」`),
    publish: setConnectionMove,
  }))
  React.useEffect(() => {
    connectionMoveController.activate()
    return () => connectionMoveController.dispose()
  }, [connectionMoveController])
  /** 捕获当前菜单对应的稳定按钮，移动弹窗关闭后可继续键盘操作。 */
  const handleMoveConnection = (connection: ServerOpsConnection): void => {
    /** 菜单项本身即将卸载，通过菜单标签关系定位所属连接按钮。 */
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const triggerId = active?.closest('[role="menu"]')?.getAttribute('aria-labelledby')
    const trigger = triggerId ? document.getElementById(triggerId) : active
    connectionMoveFocusRef.current = { trigger, view: trigger?.closest<HTMLElement>('[data-server-ops-project-view]') ?? null }
    connectionMoveController.open(connection)
  }
  /** 保留本 Pane 的管理入口及抽屉；项目删除后入口卸载时仍可回到抽屉。 */
  const projectDialogFocusRef = React.useRef<{ trigger: HTMLElement | null; drawer: HTMLElement | null }>({ trigger: null, drawer: null })
  /** 打开弹窗前记录触发器；菜单项会卸载，需经 Radix 的标签关系找到持续存在的更多按钮。 */
  const rememberProjectDialogFocus = (): void => {
    /** 本次点击或键盘操作的焦点。 */
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null
    /** 菜单的 aria-labelledby 指向所属项目的更多按钮。 */
    const triggerId = active?.closest('[role="menu"]')?.getAttribute('aria-labelledby')
    /** 普通添加按钮直接保留，菜单入口换成所属按钮。 */
    const trigger = triggerId ? document.getElementById(triggerId) : active
    projectDialogFocusRef.current = { trigger, drawer: trigger?.closest<HTMLElement>('[data-server-ops-project-drawer]') ?? null }
  }
  /** 弹窗完成关闭后恢复键盘位置；只在所属抽屉内寻找替代入口。 */
  const restoreProjectDialogFocus = (): void => {
    /** 保留的入口及其抽屉可能因新建项目跳转而同时卸载。 */
    const { trigger, drawer } = projectDialogFocusRef.current
    if (trigger?.isConnected) trigger.focus()
    else if (drawer?.isConnected) drawer.querySelector<HTMLElement>('[aria-label="收起项目列表"]')?.focus()
  }
  /** 稳定控制器在异步成功时使用当前导航上下文，仍经过传输离开守卫。 */
  const projectNavigationRef = React.useRef<Pick<ServerOpsProjectControllerOptions, 'onCreated' | 'onDeleted'>>({})
  /**
   * 单组件生命周期内稳定的项目控制器。
   *
   * 项目是连接与 Agent 授权的顶层分组，因此它的加载与其它领域一样带 owner 代次；
   * 这里只负责把投影写进 atoms，选择器与侧栏在后续步骤消费这些 atoms。
   */
  const [projectController] = React.useState(() => createServerOpsProjectController({
    /**
     * 旧客户端（preload 未更新）没有这个方法；这里显式降级为一条可读错误，
     * 让运维面板仍然可用，而不是让整个页面因为一个同步 TypeError 崩掉。
     */
    listProjects: () => window.electronAPI.listServerOpsProjects?.({}) ?? Promise.reject(new Error('SERVER_OPS_PROJECT_API_UNAVAILABLE')),
    getProjects: () => workspaceStore.get(serverOpsProjectsAtom),
    createProject: (input) => window.electronAPI.createServerOpsProject(input),
    renameProject: (input) => window.electronAPI.renameServerOpsProject(input),
    deleteProject: (input) => window.electronAPI.deleteServerOpsProject(input),
    onCreated: (project) => projectNavigationRef.current.onCreated?.(project),
    onDeleted: (projectId, remainingProjects) => projectNavigationRef.current.onDeleted?.(projectId, remainingProjects),
    publish: (projection) => {
      setProjects(projection.projects)
      setProjectsStatus(projection.status)
      setProjectsError(projection.error)
      setProjectManagement(projection)
    },
  }))

  React.useEffect(() => {
    /** 每次真实挂载或 StrictMode setup 重放都建立新的 owner 代次。 */
    projectController.activate()
    return () => projectController.dispose()
  }, [projectController])
  /**
   * 单组件生命周期内稳定的数据源列表控制器。
   *
   * 数据源一次读全量、按项目在渲染层过滤：切项目只是重新分组，不会为每条连接发一次请求，
   * 也不会产生"切项目时迟到结果写回旧列表"的竞态。
   */
  const [dataSourceController] = React.useState(() => createServerOpsDataSourceListController({
    api: { listServerOpsDataSources: (input) => window.electronAPI.listServerOpsDataSources(input) },
    getSources: () => workspaceStore.get(serverOpsDataSourcesAtom),
    publish: (projection) => {
      setDataSources(projection.sources)
      setDataSourcesStatus(projection.status)
      setDataSourcesError(projection.error)
    },
  }))

  React.useEffect(() => {
    /** 每次真实挂载或 StrictMode setup 重放都建立新的 owner 代次。 */
    dataSourceController.activate()
    return () => dataSourceController.dispose()
  }, [dataSourceController])
  /** 当前精确组合的主进程授权事实投影。 */
  const [agentAccessProjection, setAgentAccessProjection] = useAtom(serverOpsAgentAccessProjectionAtom)
  /** 多资源只读授权桥接保持引用稳定，避免每次工作区渲染重新读取或重置弹窗。 */
  const agentReadApi = React.useMemo(() => typeof window.electronAPI.getServerOpsAgentReadAccess === 'function' && typeof window.electronAPI.setServerOpsAgentReadAccess === 'function' ? {
    get: window.electronAPI.getServerOpsAgentReadAccess,
    set: window.electronAPI.setServerOpsAgentReadAccess,
    onChanged: window.electronAPI.onServerOpsAgentReadAccessChanged,
  } : undefined, [])
  /** 当前控制台页签。 */
  const [activeSection, setActiveSection] = React.useState<ServerOpsSection>('overview')
  /**
   * 中间区域是否停留在项目视图。
   *
   * 项目视图是连接清单本身；只有用户显式点进某条连接后才切到连接视图，
   * 因此应用重启后的默认落点是项目分组，而不是上次那条连接。
   */
  const [projectViewActive, setProjectViewActive] = React.useState(true)
  /** 服务器列表抽屉是否展开。 */
  const [drawerOpen, setDrawerOpen] = React.useState(false)
  /** 当前正在编辑的服务器；null 表示新建。 */
  const [editingHost, setEditingHost] = React.useState<ServerOpsHost | null>(null)
  /** 主机表单是否打开。 */
  const [dialogOpen, setDialogOpen] = React.useState(false)
  /** 主机创建表单打开时的归属，保存期间不跟随工作区选择变化。 */
  const [creatingHostProjectId, setCreatingHostProjectId] = React.useState<string | null>(null)
  /** 主机写入是否正在进行。 */
  const [saving, setSaving] = React.useState(false)
  /** 项目视图里"添加数据库 / 添加 Redis"打开的初始引擎；null 表示表单关闭。 */
  const [creatingDataSourceEngine, setCreatingDataSourceEngine] = React.useState<ServerOpsDataEngine | null>(null)
  /** 数据服务创建时的项目身份；数据库与 Redis 共用此边界。 */
  const [creatingDataSourceProjectId, setCreatingDataSourceProjectId] = React.useState<string | null>(null)
  /** 数据源写入是否正在进行。 */
  const [savingDataSource, setSavingDataSource] = React.useState(false)
  /** 数据源表单的公开错误。 */
  const [dataSourceFormError, setDataSourceFormError] = React.useState<string | null>(null)
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
  /** 当前服务器的独立信任管理弹窗是否打开。 */
  const [trustDialogOpen, setTrustDialogOpen] = React.useState(false)
  /** 仅在用户显式选择的主机上显示容器日志。 */
  const [containerLog, setContainerLog] = React.useState<{ hostId: string; containerId: string } | null>(null)
  /** 当前用户显式打开的容器终端。 */
  const [containerConsole, setContainerConsole] = React.useState<{ hostId: string; containerId: string } | null>(null)
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

  /** 当前生效的项目；选择失效时回落到列表第一项，界面不停留在已删除项目上。 */
  const currentProjectId = resolveServerOpsCurrentProjectId(projects, selectedProjectId)
  /** 项目切换当帧就使用默认条件，effect 随后清理旧状态，不短暂显示旧搜索结果。 */
  const projectBrowse = projectBrowseState.projectId === currentProjectId
    ? projectBrowseState
    : { projectId: currentProjectId, kind: 'all' as const, query: '' }
  React.useEffect(() => {
    setProjectBrowseState((current) => current.projectId === currentProjectId
      ? current
      : { projectId: currentProjectId, kind: 'all', query: '' })
  }, [currentProjectId, setProjectBrowseState])
  /** 连接模型输入：项目、主机、数据源与公开连接状态。 */
  const connectionSource: ServerOpsConnectionSource = React.useMemo(
    () => ({ projects, hosts, dataSources, connectionStates }),
    [connectionStates, dataSources, hosts, projects],
  )
  /** 全部连接；抽屉统计与项目视图共用同一份模型，避免两处数字对不上。 */
  const connections = React.useMemo(() => buildServerOpsConnections(connectionSource), [connectionSource])
  /** 每个项目的连接统计。 */
  const connectionSummaries = React.useMemo(() => summarizeServerOpsConnections(connections), [connections])
  /** 当前项目下的连接；项目未知时为空。 */
  const projectConnections = React.useMemo(
    () => listServerOpsProjectConnections(connectionSource, currentProjectId),
    [connectionSource, currentProjectId],
  )
  /** 中间区域要渲染的目标：项目分组或某条连接。 */
  const workspaceTarget = resolveServerOpsWorkspaceTarget({ projectViewActive, connections: projectConnections, selectedConnectionId })
  /** 当前生效的连接；项目视图下为空。 */
  const selectedConnection: ServerOpsConnection | null = workspaceTarget.kind === 'connection' ? workspaceTarget.connection : null
  /** 当前 SSH 连接对应的主机；数据连接与项目视图下为空。 */
  const selectedHost = selectedConnection?.kind === 'ssh'
    ? hosts.find((host) => host.id === selectedConnection.hostId) ?? null
    : null
  /** 当前打开的数据连接对应的数据源。 */
  const selectedDataSource = selectedConnection !== null && selectedConnection.kind !== 'ssh'
    ? dataSources.find((dataSource) => dataSource.id === selectedConnection.sourceId) ?? null
    : null
  /** 当前项目；项目视图标题与数据连接归属都取自它。 */
  const currentProject = projects.find((project) => project.id === currentProjectId) ?? null
  /**
   * 数据连接编辑时的跳板主机。
   *
   * 数据源弹窗目前只支持一个跳板选项：优先用这条连接自己的跳板，
   * 其次用项目内第一台服务器（跨项目跳板选择是后续工作）。
   */
  const selectedDataSourceJumpHost = React.useMemo(() => {
    if (selectedDataSource === null) return null
    /** 该连接自己的跳板主机 ID。 */
    const jumpHostId = selectedDataSource.transport === 'ssh'
      ? selectedDataSource.hostId
      : projectConnections.find((connection) => connection.kind === 'ssh')?.hostId
    /** 跳板主机记录；已删除的跳板返回 null，界面如实说明而不是回退成直连。 */
    return hosts.find((host) => host.id === jumpHostId) ?? null
  }, [hosts, projectConnections, selectedDataSource])
  /**
   * 连接切换前等待所属窗口传输收口。
   *
   * 作用域是"当前正在查看的 SSH 主机"：进入项目视图或数据连接都会离开该主机，
   * 因此必须和切换主机一样先确认文件传输收口。
   */
  const transferLeave = useServerOpsTransferLeave(selectedHost?.id ?? null)

  /**
   * 切换项目（进入该项目视图）。
   *
   * 抽屉里的项目行代表"进入这个项目"，因此中间区域切回项目分组视图；同时把选中连接
   * 同步到该项目内的第一条，避免返回连接视图时串到上一个项目。离开正在查看的服务器
   * 同样要先让文件传输收口，因此所有状态都提交在收口回调里。
   *
   * @param projectId 目标项目 ID
   */
  const handleSelectProject = (projectId: string): void => {
    transferLeave.requestLeave(() => {
      setSelectedProjectId(projectId)
      setProjectViewActive(true)
      setContainerConsole(null)
      setContainerLog(null)
      /** 目标项目下的连接；未迁移条目归入第一个项目。 */
      const targetConnections = listServerOpsProjectConnections(connectionSource, projectId)
      setSelectedConnectionId((current) => targetConnections.some((connection) => connection.id === current)
        ? current
        : targetConnections[0]?.id ?? null)
    })
  }

  /** 项目 CRUD 成功只改变必要的选择，重命名不触碰当前连接和诊断。 */
  projectNavigationRef.current = {
    onCreated: (project) => {
      setDrawerOpen(false)
      handleSelectProject(project.id)
      toast.success('项目已添加')
    },
    onDeleted: (projectId, remainingProjects) => {
      if (projectId === currentProjectId && remainingProjects[0]) handleSelectProject(remainingProjects[0].id)
      toast.success('项目已删除')
    },
  }

  /**
   * 进入一条连接。
   *
   * 服务器进入能力页签，数据库 / Redis 进入只读诊断。
   *
   * **顺序是这里的全部要点**：必须先把选择与视图都放在传输收口回调里提交，
   * 不能在调用 `requestLeave()` 之前翻动任何会影响传输作用域的状态——否则中间那次渲染
   * 会按"旧选择"立刻画出上一条连接（通常是服务器），
   * 于是 `useServerOpsTransferLeave` 的作用域发生变化、挂起中的收口确认被作废，
   * 表现为"点数据库却进了服务器界面"（这是真实踩过的 bug）。
   *
   * @param connection 目标连接
   */
  const handleSelectConnection = (connection: ServerOpsConnection): void => {
    /** 已经在看这条连接时不需要再走一次收口。 */
    if (!projectViewActive && connection.id === selectedConnectionId) return
    transferLeave.requestLeave(() => {
      setContainerConsole(null)
      setContainerLog(null)
      /** 同一批次内先提交选择再切换视图，渲染不会出现"新模式 + 旧选择"的中间态。 */
      setSelectedConnectionId(connection.id)
      setProjectViewActive(false)
    })
  }

  /** 返回当前项目的分组视图；离开服务器前同样等待文件传输收口。 */
  const handleBackToProject = (): void => {
    transferLeave.requestLeave(() => {
      setContainerConsole(null)
      setContainerLog(null)
      setProjectViewActive(true)
    })
  }

  /**
   * 数据连接详情里的数据源变更。
   *
   * 编辑只需重读连接清单；删除会让这条连接消失，必须退回项目视图，
   * 否则用户会被动落到同项目的另一条连接上，与"删除服务器后退回项目"不一致。
   *
   * @param change 变更类别
   */
  const handleDataSourceMutated = React.useCallback((change: 'updated' | 'deleted'): void => {
    dataSourceController.refresh()
    if (change !== 'deleted') return
    setSelectedConnectionId(null)
    setProjectViewActive(true)
  }, [dataSourceController, setSelectedConnectionId])

  /**
   * 新建数据源并直接进入这条连接。
   *
   * 写入成功后合并主进程返回的新连接，再把选择切到它，
   * 让用户立刻看到只读诊断，而不是回到一个看不出变化的列表。
   *
   * @param input 已通过表单校验的写入输入
   */
  const handleCreateDataSource = async (input: ServerOpsDataSourceUpsertInput): Promise<void> => {
    if (!creatingDataSourceProjectId || savingDataSource) return
    setSavingDataSource(true)
    setDataSourceFormError(null)
    try {
      /** 主进程写盘后返回的连接记录。 */
      const result = await window.electronAPI.upsertServerOpsDataSource({ ...input, projectId: creatingDataSourceProjectId })
      dataSourceController.acceptSavedSource(result.source)
      setCreatingDataSourceEngine(null)
      /** 以写入回执为归属依据；创建使用打开表单时捕获的项目身份。 */
      const landedProjectId = result.source.projectId
      const switchedProject = landedProjectId !== undefined && landedProjectId !== currentProjectId
      if (switchedProject) setSelectedProjectId(landedProjectId)
      setSelectedConnectionId(createServerOpsDataConnectionId(result.source.id))
      setProjectViewActive(false)
      toast.success('数据连接已添加')
    } catch (createError) {
      /** 主进程错误统一收敛成中文说明，避免把 IPC 原文（含稳定错误码）直接暴露给用户。 */
      setDataSourceFormError(getServerOpsDataErrorMessage(createError))
    } finally {
      setSavingDataSource(false)
    }
  }
  /** 当前选中主机的公开连接状态。 */
  const selectedConnectionState = selectedHost ? connectionStates[selectedHost.id] : undefined
  /** 当前会话能否作为服务器授权目标；定时任务与子会话会被提前排除。 */
  const agentAccessSession = resolveServerOpsAgentAccessSession(agentSessions, currentAgentSessionId)
  /** 移动仅改变列表归属；按全局稳定身份保持授权，展示仍由当前项目 selectedHost 决定。 */
  const agentAccessTarget = resolveServerOpsAgentAccessTarget({
    sessionId: agentAccessSession.sessionId,
    projectViewActive,
    selectedConnectionId,
    connections,
  })
  /** render 同步门禁早于 effect，旧目标投影不会产生可点击窗口。 */
  const agentAccessViewState = resolveServerOpsAgentAccessViewState({
    projection: agentAccessProjection,
    sessionId: agentAccessSession.sessionId,
    hostId: selectedHost?.id ?? null,
    ...(agentAccessSession.unavailableReason === undefined ? {} : { sessionUnavailableReason: agentAccessSession.unavailableReason }),
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
    /** 在途读取不能覆盖其他 Pane 刚完成的移动或编辑回执。 */
    const hostsAtStart = workspaceStore.get(serverOpsHostsAtom)
    setStatus('loading')
    setError(null)
    try {
      /** 主进程返回的权威服务器列表。 */
      const loaded = await window.electronAPI.listServerOpsHosts()
      if (workspaceStore.get(serverOpsHostsAtom) !== hostsAtStart) { setStatus('ready'); return }
      setHosts(loaded)
      /** 已删除的服务器对应的连接选择必须一起失效，否则会停留在不存在的连接上。 */
      setSelectedConnectionId((current) => current === null || loaded.some((host) => createServerOpsSshConnectionId(host.id) === current)
        ? current
        : null)
      setStatus('ready')
    } catch (loadError) {
      if (workspaceStore.get(serverOpsHostsAtom) !== hostsAtStart) { setStatus('ready'); return }
      setError(getErrorMessage(loadError))
      setStatus('error')
    }
  }, [setError, setHosts, setSelectedConnectionId, setStatus, workspaceStore])

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
    if (!isServerOpsAuditActorOperation(nextActor, auditOperationFilter)) setAuditOperationFilter('all')
  }

  /** 打开空白主机表单。 */
  const handleCreateHost = (): void => {
    if (!currentProjectId) return
    setCreatingHostProjectId(currentProjectId)
    setEditingHost(null)
    setDialogOpen(true)
  }

  /** 打开指定主机的编辑表单。 */
  const handleEditHost = (host: ServerOpsHost): void => {
    setEditingHost(host)
    setDialogOpen(true)
  }

  /**
   * 项目视图里的"添加连接"入口。
   *
   * 服务器与数据库 / Redis 是不同类别的连接，字段完全不重叠，
   * 因此按类别各自打开对应的表单，而不是在一个弹窗里混三类字段。
   *
   * @param kind 连接类别
   */
  const handleAddConnection = (kind: ServerOpsConnectionKind): void => {
    if (!currentProjectId) return
    if (kind === 'ssh') {
      handleCreateHost()
      return
    }
    setDataSourceFormError(null)
    setCreatingDataSourceProjectId(currentProjectId)
    setCreatingDataSourceEngine(kind === 'redis' ? 'redis' : 'mysql')
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
    if (saving || (!input.host.id && !creatingHostProjectId)) return
    setSaving(true)
    try {
      /** 主进程确认写盘后的服务器记录。 */
      const saved = await window.electronAPI.upsertServerOpsHost(input.host.id ? input : {
        ...input,
        host: { ...input.host, projectId: creatingHostProjectId! },
      })
      setHosts((current) => {
        /** 编辑目标在当前 Renderer 快照中的位置。 */
        const index = current.findIndex((host) => host.id === saved.id)
        return index < 0
          ? [...current, saved]
          : current.map((host) => host.id === saved.id ? saved : host)
      })
      /** 回执确认最终归属；重命名或切换项目不改变已打开表单的目标。 */
      const landedProjectId = saved.projectId
      const switchedProject = landedProjectId !== undefined && landedProjectId !== currentProjectId
      if (switchedProject) setSelectedProjectId(landedProjectId)
      /** 保存后直接进入这条连接的视图：用户刚写完配置，下一步通常是连接或查看。 */
      setSelectedConnectionId(createServerOpsSshConnectionId(saved.id))
      setProjectViewActive(false)
      setDialogOpen(false)
      setDrawerOpen(false)
      toast.success(input.host.id ? '服务器已更新' : '服务器已添加')
    } catch (saveError) {
      toast.error('服务器保存失败', { description: getErrorMessage(saveError) })
    } finally {
      setSaving(false)
    }
  }

  /** 删除确认成功后更新列表；删除的正是当前连接时退回项目视图。 */
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
      /** 被删除主机对应的连接 ID。 */
      const removedConnectionId = createServerOpsSshConnectionId(deletedId)
      if (selectedConnectionId === removedConnectionId) {
        setSelectedConnectionId(null)
        setProjectViewActive(true)
      }
      setPendingDeleteHost(null)
      toast.success('服务器已删除')
    } catch (deleteError) {
      toast.error('服务器删除失败', { description: getErrorMessage(deleteError) })
    } finally {
      setDeleting(false)
    }
  }

  /**
   * 新增数据连接时表单里的唯一跳板选项。
   *
   * 数据源弹窗当前只支持一个跳板主机，项目视图里没有"当前服务器"，
   * 因此取本项目第一台服务器；本项目还没有服务器时留空，用户可以选"本机直连"。
   */
  const projectJumpHost = connections.find((connection) => connection.projectId === creatingDataSourceProjectId && connection.kind === 'ssh')
  /** 项目分组视图；连接不存在或身份失效时作为中间区域的稳定回退。 */
  const projectPane = (
    <ServerOpsProjectView
      project={currentProject}
      status={projectsStatus}
      error={projectsError}
      connections={projectConnections}
      selectedConnectionId={selectedConnectionId}
      onSelectConnection={handleSelectConnection}
      onOpenDrawer={() => setDrawerOpen(true)}
      onRetry={() => projectController.refresh()}
      onAddConnection={handleAddConnection}
      filterKind={projectBrowse.kind}
      searchQuery={projectBrowse.query}
      onFilterKindChange={(kind) => setProjectBrowseState({ ...projectBrowse, kind })}
      onSearchQueryChange={(query) => setProjectBrowseState({ ...projectBrowse, query })}
      onMoveConnection={projectsStatus === 'ready' ? handleMoveConnection : undefined}
      toolbarActions={currentProject ? <ServerOpsAgentReadAccess
        sessionId={agentAccessSession.sessionId}
        unavailableReason={agentAccessSession.unavailableReason}
        projectId={currentProject.id}
        projects={projects}
        connections={projectConnections}
        allConnections={connections}
        dataSources={dataSources}
        api={agentReadApi}
      /> : undefined}
    />
  )

  /**
   * 选中连接对应的面板。
   *
   * 服务器进入能力页签，数据库 / Redis 进入只读诊断；连接身份失效（主机或数据源刚被删除）
   * 时保持为空，由项目分组视图兜底，中间区域不会出现空白。
   */
  const connectionPane = workspaceTarget.kind !== 'connection'
    ? null
    : workspaceTarget.connection.kind === 'ssh'
      ? selectedHost === null ? null : (
        <ServerOpsWorkspaceView
          status={status}
          error={error}
          hosts={hosts}
          selectedHost={selectedHost}
          activeSection={activeSection}
          connectionState={selectedConnectionState}
          agentSessionId={currentAgentSessionId}
          containerLog={containerLog}
          containerConsole={containerConsole}
          onContainerLogChange={setContainerLog}
          onContainerConsoleChange={setContainerConsole}
          {...agentAccessViewState}
          terminalContent={selectedConnectionState?.phase === 'connected' && selectedConnectionState.connectionId
            ? <ServerOpsRemoteTerminal hostId={selectedHost.id} connectionId={selectedConnectionState.connectionId} />
            : undefined}
          auditStatus={auditStatus}
          auditError={auditError}
          auditRecords={auditRecords}
          auditHostFilter={auditHostFilter}
          auditActorFilter={auditActorFilter}
          auditOperationFilter={auditOperationFilter}
          onOpenDrawer={() => setDrawerOpen(true)}
          onBackToProject={handleBackToProject}
          projectLabel={currentProject?.name ?? '未命名项目'}
          onCreateHost={handleCreateHost}
          onEditHost={handleEditHost}
          onDeleteHost={setPendingDeleteHost}
          onSectionChange={setActiveSection}
          onConnect={handleOpenConnect}
          onDisconnect={() => { void handleDisconnect() }}
          onToggleAgentAccess={() => { void agentAccessController.toggle() }}
          onManageTrust={() => setTrustDialogOpen(true)}
          onRefresh={() => void loadHosts()}
          onAuditHostFilterChange={setAuditHostFilter}
          onAuditActorFilterChange={handleAuditActorFilterChange}
          onAuditOperationFilterChange={setAuditOperationFilter}
          onRefreshAudit={() => { void auditController.refresh() }}
        />
      )
      : selectedDataSource === null ? null : (
        <ServerOpsDataConnectionView
          api={serverOpsDataApi}
          viewScope={viewScope}
          paneActive={paneActive}
          source={selectedDataSource}
          projectLabel={currentProject?.name ?? '未归属项目'}
          jumpHost={selectedDataSourceJumpHost === null ? null : {
            id: selectedDataSourceJumpHost.id,
            label: selectedDataSourceJumpHost.name,
            description: `${selectedDataSourceJumpHost.username}@${selectedDataSourceJumpHost.address}:${selectedDataSourceJumpHost.port}`,
            /**
             * 直连连接不依赖 SSH：跳板连接状态只对"经由"方式有意义。
             * 这里不订阅无关状态，避免跳板服务器连接状态刷新带动数据面板上下文反复变化。
             */
            connected: selectedDataSource.transport === 'ssh'
              ? connectionStates[selectedDataSourceJumpHost.id]?.phase === 'connected'
              : true,
          }}
          onOpenDrawer={() => setDrawerOpen(true)}
          onBackToProject={handleBackToProject}
          onSourceMutated={handleDataSourceMutated}
        />
      )

  return (
    <div className="relative flex min-h-0 flex-1 overflow-hidden">
      {/* 中间区域三选一：项目分组列表、SSH 能力页签、数据连接详情。 */}
      {connectionPane ?? projectPane}
      <ServerOpsProjectDrawer
        open={drawerOpen}
        projects={projects}
        selectedProjectId={currentProjectId}
        summaries={connectionSummaries}
        status={projectsStatus}
        error={projectsError}
        onSelectProject={handleSelectProject}
        onOpenChange={setDrawerOpen}
        onRetry={() => projectController.refresh()}
        onCreateProject={() => { rememberProjectDialogFocus(); projectController.openCreate() }}
        onRenameProject={(project) => { rememberProjectDialogFocus(); projectController.openRename(project) }}
        onDeleteProject={(project) => { rememberProjectDialogFocus(); projectController.requestDelete(project) }}
        managementOpen={projectManagement.dialog !== null}
      />
      <ServerOpsProjectDialog
        dialog={projectManagement.dialog}
        onRestoreFocus={restoreProjectDialogFocus}
        submitting={projectManagement.submitting}
        error={projectManagement.dialogError}
        projectCount={projects.length}
        connectionCount={projectManagement.dialog?.kind === 'delete' ? connectionSummaries[projectManagement.dialog.project.id]?.total ?? 0 : 0}
        onSubmit={(name) => { void projectController.submit(name) }}
        onClose={() => projectController.closeDialog()}
      />
      <ServerOpsConnectionMoveDialog
        {...connectionMove}
        projects={projects}
        onTargetChange={(projectId) => connectionMoveController.selectTarget(projectId)}
        onSubmit={() => { void connectionMoveController.submit() }}
        onClose={() => connectionMoveController.close()}
        onRestoreFocus={restoreConnectionMoveFocus}
      />
      <ServerOpsHostDialog
        open={dialogOpen}
        host={editingHost}
        saving={saving}
        onOpenChange={setDialogOpen}
        onSubmit={handleSaveHost}
        onTest={(input) => window.electronAPI.testServerOpsConnection(input)}
      />
      {/*
        项目视图的"添加数据库 / 添加 Redis"入口。
        数据源弹窗当前只支持一个跳板选项，取打开表单时项目内的第一台服务器。
      */}
      <ServerOpsDataSourceDialog
        open={creatingDataSourceEngine !== null}
        mode="create"
        source={null}
        initialEngine={creatingDataSourceEngine ?? 'mysql'}
        hostId={projectJumpHost?.hostId ?? ''}
        hostLabel={projectJumpHost?.label ?? ''}
        submitting={savingDataSource}
        error={dataSourceFormError}
        onTest={(draft) => serverOpsDataApi.probeServerOpsDataSource({ draft })}
        onSubmit={(input) => { void handleCreateDataSource(input) }}
        onClose={() => { setCreatingDataSourceEngine(null); setDataSourceFormError(null) }}
      />
      {transferLeave.dialog}
      <ServerOpsConnectDialog
        open={connectDialogOpen}
        host={selectedHost}
        connecting={selectedConnectionState?.phase === 'connecting'}
        error={connectError}
        requireCredential={Boolean(connectError)}
        onOpenChange={setConnectDialogOpen}
        onSubmit={handleConnect}
      />
      <ServerOpsTrustDialog
        open={trustDialogOpen}
        hostId={selectedHost?.id ?? null}
        onOpenChange={setTrustDialogOpen}
        onCommitted={(result) => {
          toast.success(result.action === 'replace' ? '服务器信任已替换' : '服务器信任已撤销')
          if (activeSection === 'audit') void auditController.refresh()
        }}
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
      <AlertDialog open={selectedConnectionState?.phase === 'blocked' && !trustDialogOpen} onOpenChange={(open) => { if (!open && !trustDialogOpen) void handleDisconnect() }}>
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
          <AlertDialogFooter>
            <AlertDialogCancel>关闭</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault()
                setTrustDialogOpen(true)
              }}
            >
              <Fingerprint className="size-3.5" aria-hidden="true" />管理服务器信任
            </AlertDialogAction>
          </AlertDialogFooter>
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
