import * as React from 'react'
import { useAtom } from 'jotai'
import {
  Activity,
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
  SquareTerminal,
  Trash2,
  Unplug,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { ServerOpsConnectionState, ServerOpsCredentialInput, ServerOpsHost, ServerOpsUpsertHostInput } from '@proma/shared'
import {
  selectedServerOpsHostIdAtom,
  serverOpsConnectionStatesAtom,
  serverOpsHostsAtom,
  serverOpsHostsErrorAtom,
  serverOpsHostsStatusAtom,
} from '@/atoms/server-ops-atoms'
import type { ServerOpsHostsStatus } from '@/atoms/server-ops-atoms'
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
  terminalContent?: React.ReactNode
  onOpenDrawer: () => void
  onCreateHost: () => void
  onEditHost: (host: ServerOpsHost) => void
  onDeleteHost: (host: ServerOpsHost) => void
  onSectionChange: (section: ServerOpsSection) => void
  onConnect?: () => void
  onDisconnect?: () => void
  onRefresh?: () => void
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

/** 展示当前服务器静态身份，不伪造远程运行指标。 */
function ServerOpsOverview({ host, connectionState }: { host: ServerOpsHost; connectionState?: ServerOpsConnectionState }): React.ReactElement {
  /** 当前认证方式的用户可见名称。 */
  const authenticationLabel = host.authMethod === 'ssh-agent' ? 'SSH Agent' : host.authMethod === 'password' ? '密码' : '私钥文件'
  /** 当前主机是否已有真实 SSH 连接。 */
  const connected = connectionState?.phase === 'connected'
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      <div className="mx-auto w-full max-w-3xl space-y-6">
        <section aria-labelledby="server-identity-heading">
          <h3 id="server-identity-heading" className="mb-3 text-xs font-medium text-muted-foreground">连接身份</h3>
          <dl className="grid grid-cols-1 gap-x-8 gap-y-3 border-y border-border py-4 text-sm sm:grid-cols-2">
            <div><dt className="text-xs text-muted-foreground">地址</dt><dd className="mt-1 font-mono text-xs">{host.address}:{host.port}</dd></div>
            <div><dt className="text-xs text-muted-foreground">用户名</dt><dd className="mt-1 text-xs">{host.username}</dd></div>
            <div><dt className="text-xs text-muted-foreground">认证</dt><dd className="mt-1 text-xs">{authenticationLabel}</dd></div>
            <div><dt className="text-xs text-muted-foreground">标签</dt><dd className="mt-1 text-xs">{host.tags.length > 0 ? host.tags.join(' · ') : '未设置'}</dd></div>
          </dl>
        </section>
        <section aria-labelledby="server-runtime-heading">
          <h3 id="server-runtime-heading" className="mb-3 text-xs font-medium text-muted-foreground">运行状态</h3>
          <div className="flex min-h-28 flex-col items-center justify-center border-y border-dashed border-border text-center">
            <Activity className="mb-2 size-5 text-muted-foreground" aria-hidden="true" />
            <p className="text-sm">{connected ? 'SSH 已连接' : '尚未连接'}</p>
            <p className="mt-1 text-xs text-muted-foreground">{connected ? '主机指标将在下一阶段通过当前连接按需采集' : '建立 SSH 会话后显示 CPU、内存、磁盘和网络状态'}</p>
          </div>
        </section>
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
  terminalContent,
  onOpenDrawer,
  onCreateHost,
  onEditHost,
  onDeleteHost,
  onSectionChange,
  onConnect,
  onDisconnect,
  onRefresh,
}: ServerOpsWorkspaceViewProps): React.ReactElement {
  /** 当前页签的显示元数据。 */
  const currentSection = SERVER_OPS_SECTIONS.find((section) => section.id === activeSection) ?? SERVER_OPS_OVERVIEW_SECTION
  /** 当前主机连接阶段。 */
  const connectionPhase = connectionState?.phase ?? 'disconnected'
  /** 当前主机是否已建立真实 SSH 连接。 */
  const connected = connectionPhase === 'connected'
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
          {activeSection === 'overview'
            ? <ServerOpsOverview host={selectedHost} connectionState={connectionState} />
            : activeSection === 'terminal' && connected && terminalContent
              ? terminalContent
            : activeSection === 'data-services'
              ? <ServerOpsDataServices connected={connected} />
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

  /** 根据持久选择和实际列表解析当前服务器。 */
  const selectedHost = hosts.find((host) => host.id === selectedHostId) ?? hosts[0] ?? null
  /** 当前选中主机的公开连接状态。 */
  const selectedConnectionState = selectedHost ? connectionStates[selectedHost.id] : undefined

  React.useEffect(() => {
    /** 主进程广播的连接状态是 Renderer 唯一实时事实。 */
    const disposeState = window.electronAPI.onServerOpsConnectionState((state) => {
      setConnectionStates((current) => ({ ...current, [state.hostId]: state }))
    })
    return disposeState
  }, [setConnectionStates])

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

  /** 打开当前服务器登录表单。 */
  const handleOpenConnect = (): void => {
    setConnectError(undefined)
    setConnectDialogOpen(true)
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
        setConnectError(state.message ?? 'SSH 连接失败')
      }
    } catch (connectFailure) {
      setConnectError(getErrorMessage(connectFailure))
    }
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
    /** 主进程确认资源释放后的公开状态。 */
    const state = await window.electronAPI.disconnectServerOpsHost(selectedHost.id)
    setConnectionStates((current) => ({ ...current, [state.hostId]: state }))
  }

  /** 原子保存主机，并在成功后更新全局选择。 */
  const handleSaveHost = async (input: ServerOpsUpsertHostInput): Promise<void> => {
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
      toast.success(input.id ? '服务器已更新' : '服务器已添加')
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
        terminalContent={selectedHost && selectedConnectionState?.phase === 'connected' && selectedConnectionState.connectionId
          ? <ServerOpsRemoteTerminal hostId={selectedHost.id} connectionId={selectedConnectionState.connectionId} />
          : undefined}
        onOpenDrawer={() => setDrawerOpen(true)}
        onCreateHost={handleCreateHost}
        onEditHost={handleEditHost}
        onDeleteHost={setPendingDeleteHost}
        onSectionChange={setActiveSection}
        onConnect={handleOpenConnect}
        onDisconnect={() => { void handleDisconnect() }}
        onRefresh={() => void loadHosts()}
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
