import * as React from 'react'
import {
  Box,
  HardDrive,
  Image,
  LoaderCircle,
  Network,
  Play,
  RefreshCw,
  RotateCw,
  ScrollText,
  Square,
  TerminalSquare,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type {
  ServerOpsDockerAction,
  ServerOpsDockerActionCandidate,
  ServerOpsDockerActionCommitInput,
  ServerOpsDockerActionPrepareInput,
  ServerOpsDockerActionResult,
  ServerOpsDockerContainerDetailInput,
  ServerOpsDockerContainerDetailResult,
  ServerOpsDockerContainerSummary,
  ServerOpsDockerResourcesInput,
  ServerOpsDockerResourcesResult,
} from '@proma/shared'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'

/** Docker 面板的四个只读资源页签。 */
export type ServerOpsDockerTab = 'containers' | 'images' | 'networks' | 'volumes'

/** Docker 面板加载状态。 */
export type ServerOpsDockerStatus = 'idle' | 'loading' | 'ready' | 'error'

/** Docker 面板公开投影，不保存任何连接凭据或底层 inspect 原文。 */
export interface ServerOpsDockerProjection {
  hostId: string | null
  status: ServerOpsDockerStatus
  resources: ServerOpsDockerResourcesResult | null
  error: string | null
  selectedContainerId: string | null
  detailStatus: ServerOpsDockerStatus
  detail: ServerOpsDockerContainerDetailResult | null
  detailError: string | null
  candidate: ServerOpsDockerActionCandidate | null
  preparingContainerId: string | null
  committing: boolean
}

/** 当前 Docker 页面所属主机和可用性事实。 */
export interface ServerOpsDockerContext {
  hostId: string
  active: boolean
  connected: boolean
  onOpenContainerLogs?: (containerId: string) => void
}

/** Renderer 依赖的最小 Docker preload 合同。 */
export interface ServerOpsDockerPanelApi {
  listServerOpsDockerResources(input: ServerOpsDockerResourcesInput): Promise<ServerOpsDockerResourcesResult>
  getServerOpsDockerContainerDetail(input: ServerOpsDockerContainerDetailInput): Promise<ServerOpsDockerContainerDetailResult>
  prepareServerOpsDockerAction(input: ServerOpsDockerActionPrepareInput): Promise<ServerOpsDockerActionCandidate>
  commitServerOpsDockerAction(input: ServerOpsDockerActionCommitInput): Promise<ServerOpsDockerActionResult>
  cancelServerOpsDockerAction(input: { hostId: string; candidateId: string }): Promise<void>
}

/** Docker 控制器依赖，便于纯测试覆盖异步竞态。 */
interface ServerOpsDockerControllerOptions {
  listResources: ServerOpsDockerPanelApi['listServerOpsDockerResources']
  getContainerDetail: ServerOpsDockerPanelApi['getServerOpsDockerContainerDetail']
  prepareAction: ServerOpsDockerPanelApi['prepareServerOpsDockerAction']
  commitAction: ServerOpsDockerPanelApi['commitServerOpsDockerAction']
  cancelAction: ServerOpsDockerPanelApi['cancelServerOpsDockerAction']
  publish: (projection: ServerOpsDockerProjection) => void
  notify: (kind: 'success' | 'warning' | 'error', message: string) => void
}

/** Docker 控制器公开操作。 */
export interface ServerOpsDockerController {
  activate(): void
  select(context: ServerOpsDockerContext): Promise<void>
  refresh(): Promise<void>
  selectContainer(containerId: string): Promise<void>
  requestAction(containerId: string, action: ServerOpsDockerAction): Promise<void>
  cancelAction(): Promise<void>
  confirmAction(): Promise<void>
  dispose(): void
}

/** Docker 面板 React 包装层属性。 */
export interface ServerOpsDockerPanelProps {
  api: ServerOpsDockerPanelApi
  hostId: string
  hostLabel: string
  hostDescription?: string
  active: boolean
  connected: boolean
  onOpenContainerLogs?: (containerId: string) => void
  onOpenContainerConsole?: (containerId: string) => void
}

/** Docker 面板纯展示层属性。 */
export interface ServerOpsDockerPanelViewProps {
  projection: ServerOpsDockerProjection
  hostLabel: string
  hostDescription?: string
  connected: boolean
  activeTab: ServerOpsDockerTab
  onTabChange(tab: ServerOpsDockerTab): void
  onRefresh(): void
  onSelectContainer(containerId: string): void
  onRequestAction(containerId: string, action: ServerOpsDockerAction): void
  onOpenContainerLogs?: (containerId: string) => void
  onOpenContainerConsole?: (containerId: string) => void
  onCancelAction(): void
  onConfirmAction(): void
}

/** Docker 动作显示信息。 */
interface ServerOpsDockerActionMeta {
  label: string
  icon: LucideIcon
  destructive: boolean
}

/** 三种动作的固定中文标签、图标和风险样式。 */
const DOCKER_ACTION_META: Record<ServerOpsDockerAction, ServerOpsDockerActionMeta> = {
  start: { label: '启动', icon: Play, destructive: false },
  stop: { label: '停止', icon: Square, destructive: true },
  restart: { label: '重启', icon: RotateCw, destructive: true },
}

/** 动作按钮顺序固定，避免状态更新引发按钮位移。 */
const DOCKER_ACTION_ORDER: readonly ServerOpsDockerAction[] = ['start', 'stop', 'restart']

/** 主进程稳定错误码对应的公开恢复文案。 */
const DOCKER_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  SERVER_OPS_CONNECTION_CHANGED: '服务器连接已变化，请重新连接后重试',
  SERVER_OPS_DOCKER_UNAVAILABLE: '当前服务器无法使用 Docker，请刷新后重试',
  SERVER_OPS_DOCKER_OUTPUT_INVALID: 'Docker 返回的数据无效，请刷新后重试',
  SERVER_OPS_DOCKER_CLI_MISSING: '当前服务器未安装 Docker CLI',
  SERVER_OPS_DOCKER_DAEMON_UNAVAILABLE: 'Docker daemon 不可用，请检查服务状态',
  SERVER_OPS_DOCKER_PERMISSION_DENIED: '当前账号无权访问 Docker daemon',
  SERVER_OPS_DOCKER_CONTAINER_NOT_FOUND: '容器已不存在，请刷新资源列表',
  SERVER_OPS_DOCKER_ACTION_EXPIRED: '本次确认已过期，请重新准备',
  SERVER_OPS_DOCKER_ACTION_CONFLICT: '容器或连接状态已变化，请重新准备',
  SERVER_OPS_DOCKER_ACTION_BUSY: '该容器已有操作正在执行，请等待完成',
  SERVER_OPS_DOCKER_ACTION_CANDIDATE_INVALID: 'Docker 操作确认已失效，请重新准备',
  SERVER_OPS_DOCKER_ACTION_FAILED: '容器操作失败，状态已重新读取',
  SERVER_OPS_DOCKER_ACTION_UNKNOWN: '容器操作结果不确定，状态已重新读取',
  SERVER_OPS_AUDIT_WRITE_FAILED: '操作审计写入失败，容器动作未执行',
}

/** 未识别异常统一降级，避免泄漏远程命令或 daemon 原文。 */
const DOCKER_FALLBACK_ERROR = 'Docker 资源暂时不可用，请稍后重试'

/** 将底层异常收敛为稳定公开文案。 */
export function getServerOpsDockerErrorMessage(error: unknown): string {
  /** 异常文本只用于匹配稳定码，绝不直接展示。 */
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  /** Electron invoke 会包装错误，因此允许在固定白名单中查找完整码。 */
  const code = Object.keys(DOCKER_ERROR_MESSAGES).find((candidate) => message.includes(candidate))
  return code ? DOCKER_ERROR_MESSAGES[code]! : DOCKER_FALLBACK_ERROR
}

/** 创建指定主机的空 Docker 投影。 */
function createIdleProjection(hostId: string | null, committing = false): ServerOpsDockerProjection {
  return {
    hostId,
    status: 'idle',
    resources: null,
    error: null,
    selectedContainerId: null,
    detailStatus: 'idle',
    detail: null,
    detailError: null,
    candidate: null,
    preparingContainerId: null,
    committing,
  }
}

/** 判断两个 Docker 页面上下文是否完全一致。 */
function isSameContext(left: ServerOpsDockerContext | null, right: ServerOpsDockerContext): boolean {
  return left?.hostId === right.hostId && left.active === right.active && left.connected === right.connected
}

/** 只有当前页可见且 SSH 已连接时才允许远程读取。 */
function canRead(context: ServerOpsDockerContext | null): context is ServerOpsDockerContext {
  return Boolean(context?.active && context.connected)
}

/** 创建按主机代次隔离、候选可取消且提交单飞的 Docker 控制器。 */
export function createServerOpsDockerController(options: ServerOpsDockerControllerOptions): ServerOpsDockerController {
  /** 当前 React owner 是否仍有效。 */
  let ownerActive = false
  /** 当前页面上下文。 */
  let context: ServerOpsDockerContext | null = null
  /** 主机、连接或可见性变化时推进的代次。 */
  let contextRevision = 0
  /** 资源请求独立代次。 */
  let resourcesRevision = 0
  /** 详情请求独立代次。 */
  let detailRevision = 0
  /** 候选准备独立代次。 */
  let prepareRevision = 0
  /** 当前公开投影。 */
  let projection = createIdleProjection(null)
  /** 已提交动作跨页面保持单飞，避免 StrictMode 或重复点击重放。 */
  let actionFlight: Promise<void> | null = null

  /** 仅向仍活跃的 React owner 发布不可变投影。 */
  const publish = (next: ServerOpsDockerProjection): void => {
    projection = next
    if (ownerActive) options.publish(next)
  }

  /** 合并投影字段并发布。 */
  const patch = (next: Partial<ServerOpsDockerProjection>): void => {
    publish({ ...projection, ...next })
  }

  /** 判断异步操作是否仍属于当前可读主机。 */
  const isCurrent = (hostId: string, revision: number): boolean => (
    ownerActive && canRead(context) && context.hostId === hostId && contextRevision === revision
  )

  /** best-effort 取消精确候选，取消故障不阻断切换和销毁。 */
  const cancelExact = (candidate: ServerOpsDockerActionCandidate | null): void => {
    if (!candidate) return
    void options.cancelAction({ hostId: candidate.hostId, candidateId: candidate.candidateId }).catch(() => undefined)
  }

  /** 读取当前主机的四类资源，并拒绝迟到结果。 */
  const loadResources = async (): Promise<void> => {
    if (!canRead(context)) return
    /** 本次读取绑定的主机、上下文和资源代次。 */
    const hostId = context.hostId
    const operationContextRevision = contextRevision
    const operationRevision = ++resourcesRevision
    patch({ status: 'loading', resources: projection.resources?.hostId === hostId ? projection.resources : null, error: null })
    try {
      /** preload 已严格解析的公开资源快照。 */
      const resources = await options.listResources({ hostId })
      if (resources.hostId !== hostId) throw new Error('SERVER_OPS_DOCKER_OUTPUT_INVALID')
      if (!isCurrent(hostId, operationContextRevision) || operationRevision !== resourcesRevision) return
      publish({
        ...projection,
        hostId,
        status: 'ready',
        resources,
        error: null,
      })
    } catch (error) {
      if (!isCurrent(hostId, operationContextRevision) || operationRevision !== resourcesRevision) return
      patch({ status: 'error', error: getServerOpsDockerErrorMessage(error) })
    }
  }

  /** 读取单容器 inspect 白名单投影，并拒绝旧选择结果。 */
  const loadDetail = async (containerId: string): Promise<void> => {
    if (!canRead(context)) return
    /** 本次详情读取绑定的主机和代次。 */
    const hostId = context.hostId
    const operationContextRevision = contextRevision
    const operationRevision = ++detailRevision
    patch({ selectedContainerId: containerId, detailStatus: 'loading', detail: null, detailError: null })
    try {
      /** preload 已严格解析的详情结果。 */
      const detail = await options.getContainerDetail({ hostId, containerId })
      if (detail.hostId !== hostId || (detail.container && detail.container.containerId !== containerId)) {
        throw new Error('SERVER_OPS_DOCKER_OUTPUT_INVALID')
      }
      if (!isCurrent(hostId, operationContextRevision) || operationRevision !== detailRevision
        || projection.selectedContainerId !== containerId) return
      patch({ detailStatus: 'ready', detail, detailError: null })
    } catch (error) {
      if (!isCurrent(hostId, operationContextRevision) || operationRevision !== detailRevision
        || projection.selectedContainerId !== containerId) return
      patch({ detailStatus: 'error', detail: null, detailError: getServerOpsDockerErrorMessage(error) })
    }
  }

  /** 提交完成后刷新当前主机资源和仍选中的容器详情。 */
  const refreshAfterAction = async (hostId: string): Promise<void> => {
    if (!canRead(context) || context.hostId !== hostId) return
    await loadResources()
    /** 列表完成后只读取当前仍然有效的选择。 */
    const selectedContainerId = projection.selectedContainerId
    if (selectedContainerId && canRead(context) && context.hostId === hostId) await loadDetail(selectedContainerId)
  }

  return {
    activate: () => {
      ownerActive = true
    },
    select: async (nextContext) => {
      if (isSameContext(context, nextContext)) return
      if (!projection.committing) cancelExact(projection.candidate)
      context = nextContext
      contextRevision += 1
      resourcesRevision += 1
      detailRevision += 1
      prepareRevision += 1
      publish(createIdleProjection(nextContext.hostId, actionFlight !== null))
      if (canRead(context)) await loadResources()
    },
    refresh: async () => {
      if (!canRead(context) || projection.committing) return
      cancelExact(projection.candidate)
      prepareRevision += 1
      patch({ candidate: null, preparingContainerId: null })
      await loadResources()
      /** 手动刷新保留选择时同步回读详情。 */
      const selectedContainerId = projection.selectedContainerId
      if (selectedContainerId) await loadDetail(selectedContainerId)
    },
    selectContainer: async (containerId) => {
      if (!canRead(context) || projection.status !== 'ready'
        || !projection.resources?.containers.some((container) => container.containerId === containerId)) return
      await loadDetail(containerId)
    },
    requestAction: async (containerId, action) => {
      if (!canRead(context) || actionFlight || projection.preparingContainerId
        || !projection.resources?.containers.some((container) => container.containerId === containerId)) return
      cancelExact(projection.candidate)
      /** 本次 prepare 绑定的上下文与候选代次。 */
      const hostId = context.hostId
      const operationContextRevision = contextRevision
      const operationRevision = ++prepareRevision
      patch({ candidate: null, preparingContainerId: containerId, error: null })
      try {
        /** Main 依据 fresh inspect 签发的短期候选。 */
        const candidate = await options.prepareAction({ hostId, containerId, action })
        if (!isCurrent(hostId, operationContextRevision) || operationRevision !== prepareRevision) {
          cancelExact(candidate)
          return
        }
        if (candidate.hostId !== hostId || candidate.container.containerId !== containerId || candidate.action !== action) {
          cancelExact(candidate)
          throw new Error('SERVER_OPS_DOCKER_ACTION_CANDIDATE_INVALID')
        }
        patch({ candidate, preparingContainerId: null })
      } catch (error) {
        if (!isCurrent(hostId, operationContextRevision) || operationRevision !== prepareRevision) return
        patch({ candidate: null, preparingContainerId: null })
        options.notify('error', getServerOpsDockerErrorMessage(error))
      }
    },
    cancelAction: async () => {
      if (!ownerActive || projection.committing || !projection.candidate) return
      /** 先清除提交入口，防止 cancel IPC 在途时重复确认。 */
      const candidate = projection.candidate
      prepareRevision += 1
      patch({ candidate: null, preparingContainerId: null })
      try {
        await options.cancelAction({ hostId: candidate.hostId, candidateId: candidate.candidateId })
      } catch {
        options.notify('warning', 'Docker 操作确认取消失败，候选将在短时间后自动失效')
      }
    },
    confirmAction: async () => {
      if (!canRead(context) || actionFlight || !projection.candidate) return actionFlight ?? Promise.resolve()
      /** 本次提交只使用 Main 已签发的候选身份。 */
      const candidate = projection.candidate
      const hostId = context.hostId
      const operationContextRevision = contextRevision
      /** 动作名用于成功提示，不能从后续页面状态反推。 */
      const actionLabel = DOCKER_ACTION_META[candidate.action].label
      patch({ committing: true, preparingContainerId: null })
      actionFlight = (async () => {
        try {
          /** commit 不携带容器 ID 或动作，防止 Renderer 在确认后篡改事实。 */
          const result = await options.commitAction({ hostId, candidateId: candidate.candidateId })
          if (result.hostId !== hostId || result.containerId !== candidate.container.containerId
            || result.action !== candidate.action) throw new Error('SERVER_OPS_DOCKER_OUTPUT_INVALID')
          if (isCurrent(hostId, operationContextRevision)) {
            patch({ candidate: null })
            if (result.warnings.length > 0) options.notify('warning', '容器操作已完成，但状态回读包含警告，请刷新确认')
            else options.notify('success', `容器${actionLabel}操作已完成，状态已重新读取`)
          }
        } catch (error) {
          if (isCurrent(hostId, operationContextRevision)) {
            patch({ candidate: null })
            /** unknown 与普通失败都使用稳定文案并在 finally 权威回读。 */
            const message = getServerOpsDockerErrorMessage(error)
            options.notify(message.includes('不确定') ? 'warning' : 'error', message)
          }
        } finally {
          await refreshAfterAction(hostId)
          actionFlight = null
          if (isCurrent(hostId, operationContextRevision)) patch({ committing: false, candidate: null })
          else if (ownerActive) patch({ committing: false })
        }
      })()
      await actionFlight
    },
    dispose: () => {
      ownerActive = false
      context = null
      contextRevision += 1
      resourcesRevision += 1
      detailRevision += 1
      prepareRevision += 1
      if (!projection.committing) cancelExact(projection.candidate)
      projection = createIdleProjection(null, actionFlight !== null)
    },
  }
}

/** 截短长身份并保留首尾，完整 ID 只在确认框中展示。 */
function compactIdentity(value: string): string {
  return value.length <= 20 ? value : `${value.slice(0, 12)}...${value.slice(-6)}`
}

/** 将 Docker 容器状态映射为紧凑中文标签。 */
function getContainerStateLabel(container: ServerOpsDockerContainerSummary): string {
  if (container.state === 'running') return '运行中'
  if (container.state === 'paused') return '已暂停'
  if (container.state === 'exited') return '已退出'
  if (container.state === 'dead') return '异常终止'
  return container.state
}

/** 按 capability 返回可操作的用户恢复提示。 */
function getCapabilityMessage(capability: ServerOpsDockerResourcesResult['capability']): string | null {
  if (capability === 'cli-missing') return '当前服务器未安装 Docker CLI'
  if (capability === 'daemon-unavailable') return 'Docker daemon 不可用，请检查 Docker 服务状态'
  if (capability === 'permission-denied') return '当前账号无权访问 Docker daemon'
  return null
}

/** 容器动作图标组，统一 tooltip、禁用态和执行态。 */
function DockerActionButtons({
  container,
  disabled,
  busy,
  onRequestAction,
}: {
  container: ServerOpsDockerContainerSummary
  disabled: boolean
  busy: boolean
  onRequestAction(containerId: string, action: ServerOpsDockerAction): void
}): React.ReactElement {
  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex shrink-0 items-center gap-1">
        {DOCKER_ACTION_ORDER.map((action) => {
          /** 当前动作的图标和标签。 */
          const meta = DOCKER_ACTION_META[action]
          /** 当前动作图标组件。 */
          const Icon = meta.icon
          return (
            <Tooltip key={action}>
              <TooltipTrigger asChild>
                <span className="inline-flex" tabIndex={disabled ? 0 : undefined}>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    disabled={disabled}
                    aria-label={`${meta.label}容器 ${container.names[0]}`}
                    onClick={() => onRequestAction(container.containerId, action)}
                  >
                    {busy ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" /> : <Icon className="size-3.5" aria-hidden="true" />}
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom">{meta.label}容器 {container.names[0]}</TooltipContent>
            </Tooltip>
          )
        })}
      </div>
    </TooltipProvider>
  )
}

/** Docker 容器列表与选中详情。 */
function ContainersView({
  projection,
  onSelectContainer,
  onRequestAction,
  onOpenContainerLogs,
  onOpenContainerConsole,
}: Pick<ServerOpsDockerPanelViewProps, 'projection' | 'onSelectContainer' | 'onRequestAction' | 'onOpenContainerLogs' | 'onOpenContainerConsole'>): React.ReactElement {
  /** 当前资源快照中的容器。 */
  const containers = projection.resources?.containers ?? []
  /** 当前选中容器摘要。 */
  const selected = containers.find((container) => container.containerId === projection.selectedContainerId) ?? null
  /** 当前详情只在身份相同时展示。 */
  const detail = projection.detail?.container?.containerId === projection.selectedContainerId
    ? projection.detail.container
    : null
  if (containers.length === 0) return <EmptyResource label="容器" />
  return (
    <div className="min-h-0 overflow-y-auto">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[620px] table-fixed text-left text-xs">
          <colgroup><col className="w-[24%]" /><col className="w-[31%]" /><col className="w-[16%]" /><col className="w-[29%]" /></colgroup>
          <thead className="sticky top-0 z-10 border-b border-border bg-content-area text-[11px] text-muted-foreground">
            <tr><th className="px-3 py-2 font-medium">容器</th><th className="px-3 py-2 font-medium">镜像</th><th className="px-3 py-2 font-medium">状态</th><th className="px-3 py-2 font-medium">端口</th></tr>
          </thead>
          <tbody className="divide-y divide-border">
            {containers.map((container) => (
              <tr key={container.containerId} className={cn('hover:bg-muted/35', selected?.containerId === container.containerId && 'bg-accent/55')}>
                <td className="px-1 py-1">
                  <Button type="button" variant="ghost" className="h-8 max-w-full justify-start px-2" aria-label={`查看容器 ${container.names[0]} 详情`}
                    aria-pressed={selected?.containerId === container.containerId} onClick={() => onSelectContainer(container.containerId)}>
                    <span className="min-w-0 text-left"><span className="block truncate text-xs font-medium">{container.names[0]}</span><span className="block font-mono text-[10px] text-muted-foreground">{compactIdentity(container.containerId)}</span></span>
                  </Button>
                </td>
                <td className="truncate px-3 py-2 font-mono text-[11px]">{container.image}</td>
                <td className="px-3 py-2"><Badge variant="outline" className="font-normal">{getContainerStateLabel(container)}</Badge></td>
                <td className="truncate px-3 py-2 font-mono text-[11px] text-muted-foreground">{container.publishedPorts.join(', ') || '未发布'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {selected && (
        <section className="border-t border-border px-3 py-3" aria-label={`${selected.names[0]} 容器详情`}>
          <div className="flex min-w-0 flex-wrap items-start gap-2">
            <div className="min-w-0 flex-1"><h3 className="truncate text-xs font-medium">{selected.names[0]}</h3><p className="mt-1 truncate font-mono text-[10px] text-muted-foreground">{selected.containerId}</p></div>
            {onOpenContainerLogs && (
              <TooltipProvider delayDuration={200}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button type="button" variant="ghost" size="icon-sm" aria-label={`查看容器 ${selected.names[0]} 日志`} onClick={() => onOpenContainerLogs(selected.containerId)}>
                      <ScrollText className="size-3.5" aria-hidden="true" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">查看容器 {selected.names[0]} 日志</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
            {onOpenContainerConsole && selected.state === 'running' && (
              <TooltipProvider delayDuration={200}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button type="button" variant="ghost" size="icon-sm" aria-label={`打开容器 ${selected.names[0]} 终端`} onClick={() => onOpenContainerConsole(selected.containerId)}>
                      <TerminalSquare className="size-3.5" aria-hidden="true" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">打开容器 {selected.names[0]} 终端</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
            <DockerActionButtons container={selected} busy={projection.preparingContainerId === selected.containerId || projection.committing}
              disabled={projection.detailStatus !== 'ready' || !detail || Boolean(projection.candidate) || projection.preparingContainerId !== null || projection.committing}
              onRequestAction={onRequestAction} />
          </div>
          {projection.detailStatus === 'loading' ? (
            <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground" role="status"><LoaderCircle className="size-3.5 animate-spin" />正在读取容器详情...</div>
          ) : projection.detailStatus === 'error' ? (
            <div className="mt-3 text-xs text-destructive">{projection.detailError ?? DOCKER_FALLBACK_ERROR}</div>
          ) : detail ? (
            <div className="mt-3 grid gap-3" data-server-ops-docker-detail-grid="true">
              <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
                <dt className="text-muted-foreground">平台</dt><dd className="truncate font-mono">{detail.platform}</dd>
                <dt className="text-muted-foreground">状态</dt><dd>{detail.state}</dd>
                <dt className="text-muted-foreground">退出码</dt><dd>{detail.exitCode}</dd>
                <dt className="text-muted-foreground">重启次数</dt><dd>{detail.restartCount}</dd>
                <dt className="text-muted-foreground">创建时间</dt><dd className="truncate">{detail.createdAt}</dd>
              </dl>
              <div className="grid min-w-0 gap-3">
                <div><h4 className="mb-1 text-[11px] text-muted-foreground">端口</h4><div className="font-mono text-[11px]">{detail.ports.map((port) => `${port.address ?? '*'}:${port.publicPort ?? '-'} -> ${port.privatePort}/${port.protocol}`).join('\n') || '无端口映射'}</div></div>
                <div><h4 className="mb-1 text-[11px] text-muted-foreground">挂载</h4><div className="whitespace-pre-wrap font-mono text-[11px]">{detail.mounts.map((mount) => `${mount.name ?? mount.type} -> ${mount.destination}${mount.readOnly ? ' (只读)' : ''}`).join('\n') || '无挂载'}</div></div>
              </div>
            </div>
          ) : null}
        </section>
      )}
    </div>
  )
}

/** 通用资源空状态。 */
function EmptyResource({ label }: { label: string }): React.ReactElement {
  return <div className="flex min-h-48 items-center justify-center px-6 text-center text-sm text-muted-foreground">没有可显示的{label}</div>
}

/** 镜像只读列表。 */
function ImagesView({ resources }: { resources: ServerOpsDockerResourcesResult }): React.ReactElement {
  if (resources.images.length === 0) return <EmptyResource label="镜像" />
  return <div className="min-h-0 overflow-auto"><table className="w-full min-w-[620px] text-left text-xs"><thead className="sticky top-0 border-b border-border bg-content-area text-[11px] text-muted-foreground"><tr><th className="px-3 py-2 font-medium">仓库</th><th className="px-3 py-2 font-medium">标签</th><th className="px-3 py-2 font-medium">大小</th><th className="px-3 py-2 font-medium">镜像 ID</th></tr></thead><tbody className="divide-y divide-border">{resources.images.map((image) => <tr key={image.imageId}><td className="px-3 py-2">{image.repository}</td><td className="px-3 py-2 font-mono">{image.tag}</td><td className="px-3 py-2">{image.size}</td><td className="px-3 py-2 font-mono text-[11px] text-muted-foreground">{compactIdentity(image.imageId)}</td></tr>)}</tbody></table></div>
}

/** 网络只读列表。 */
function NetworksView({ resources }: { resources: ServerOpsDockerResourcesResult }): React.ReactElement {
  if (resources.networks.length === 0) return <EmptyResource label="网络" />
  return <div className="min-h-0 overflow-auto"><table className="w-full min-w-[520px] text-left text-xs"><thead className="sticky top-0 border-b border-border bg-content-area text-[11px] text-muted-foreground"><tr><th className="px-3 py-2 font-medium">网络</th><th className="px-3 py-2 font-medium">驱动</th><th className="px-3 py-2 font-medium">范围</th><th className="px-3 py-2 font-medium">内部</th></tr></thead><tbody className="divide-y divide-border">{resources.networks.map((network) => <tr key={network.networkId}><td className="px-3 py-2 font-medium">{network.name}</td><td className="px-3 py-2 font-mono">{network.driver}</td><td className="px-3 py-2">{network.scope}</td><td className="px-3 py-2">{network.internal ? '是' : '否'}</td></tr>)}</tbody></table></div>
}

/** 卷只读列表。 */
function VolumesView({ resources }: { resources: ServerOpsDockerResourcesResult }): React.ReactElement {
  if (resources.volumes.length === 0) return <EmptyResource label="卷" />
  return <div className="min-h-0 overflow-auto"><table className="w-full min-w-[440px] text-left text-xs"><thead className="sticky top-0 border-b border-border bg-content-area text-[11px] text-muted-foreground"><tr><th className="px-3 py-2 font-medium">卷</th><th className="px-3 py-2 font-medium">驱动</th><th className="px-3 py-2 font-medium">范围</th></tr></thead><tbody className="divide-y divide-border">{resources.volumes.map((volume) => <tr key={volume.name}><td className="px-3 py-2 font-medium">{volume.name}</td><td className="px-3 py-2 font-mono">{volume.driver}</td><td className="px-3 py-2">{volume.scope}</td></tr>)}</tbody></table></div>
}

/** Docker 四类资源、白名单详情和逐次确认的纯展示层。 */
export function ServerOpsDockerPanelView({
  projection,
  hostLabel,
  hostDescription,
  connected,
  activeTab,
  onTabChange,
  onRefresh,
  onSelectContainer,
  onRequestAction,
  onOpenContainerLogs,
  onOpenContainerConsole,
  onCancelAction,
  onConfirmAction,
}: ServerOpsDockerPanelViewProps): React.ReactElement {
  /** 当前资源快照，所有 tab 只消费该公开 DTO。 */
  const resources = projection.resources
  /** 非 available capability 的恢复提示。 */
  const capabilityMessage = resources ? getCapabilityMessage(resources.capability) : null
  /** 当前候选动作的显示元数据。 */
  const candidateMeta = projection.candidate ? DOCKER_ACTION_META[projection.candidate.action] : null
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-server-ops-docker-panel>
      <style>{'@container (min-width: 700px) { [data-server-ops-docker-detail-grid="true"] { grid-template-columns: repeat(2, minmax(0, 1fr)); } }'}</style>
      <Tabs value={activeTab} onValueChange={(value) => onTabChange(value as ServerOpsDockerTab)} className="flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
          <TabsList className="h-8 min-w-0 flex-1 justify-start overflow-x-auto rounded-md p-0.5">
            <TabsTrigger className="h-7 gap-1.5 px-2 text-xs" value="containers"><Box className="size-3.5" />容器 {resources?.containers.length ?? 0}</TabsTrigger>
            <TabsTrigger className="h-7 gap-1.5 px-2 text-xs" value="images"><Image className="size-3.5" />镜像 {resources?.images.length ?? 0}</TabsTrigger>
            <TabsTrigger className="h-7 gap-1.5 px-2 text-xs" value="networks"><Network className="size-3.5" />网络 {resources?.networks.length ?? 0}</TabsTrigger>
            <TabsTrigger className="h-7 gap-1.5 px-2 text-xs" value="volumes"><HardDrive className="size-3.5" />卷 {resources?.volumes.length ?? 0}</TabsTrigger>
          </TabsList>
          <Button type="button" variant="ghost" size="icon-sm" aria-label="刷新 Docker 资源" disabled={!connected || projection.committing} onClick={onRefresh}>
            <RefreshCw className={cn('size-3.5', projection.status === 'loading' && 'animate-spin')} aria-hidden="true" />
          </Button>
        </div>
        {!connected ? (
          <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">尚未建立 SSH 连接</div>
        ) : projection.status === 'idle' || projection.status === 'loading' ? (
          <div className="flex flex-1 items-center justify-center gap-2 text-xs text-muted-foreground" role="status"><LoaderCircle className="size-3.5 animate-spin" />正在读取 Docker 资源...</div>
        ) : projection.status === 'error' ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center"><p className="text-sm">Docker 资源读取失败</p><p className="text-xs text-muted-foreground">{projection.error ?? DOCKER_FALLBACK_ERROR}</p><Button type="button" size="sm" variant="outline" onClick={onRefresh}><RefreshCw className="size-3.5" />重试</Button></div>
        ) : capabilityMessage ? (
          <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">{capabilityMessage}</div>
        ) : resources ? (
          <>
            <TabsContent value="containers" className="mt-0 min-h-0 flex-1"><ContainersView projection={projection} onSelectContainer={onSelectContainer} onRequestAction={onRequestAction} onOpenContainerLogs={onOpenContainerLogs} onOpenContainerConsole={onOpenContainerConsole} /></TabsContent>
            <TabsContent value="images" className="mt-0 min-h-0 flex-1"><ImagesView resources={resources} /></TabsContent>
            <TabsContent value="networks" className="mt-0 min-h-0 flex-1"><NetworksView resources={resources} /></TabsContent>
            <TabsContent value="volumes" className="mt-0 min-h-0 flex-1"><VolumesView resources={resources} /></TabsContent>
          </>
        ) : null}
      </Tabs>
      {projection.candidate && candidateMeta && (
        <span className="sr-only" role="status">
          待确认：服务器：{hostLabel}；{hostDescription ? `连接：${hostDescription}；` : ''}容器：{projection.candidate.container.name}；完整 ID：{projection.candidate.container.containerId}；动作：{candidateMeta.label}
        </span>
      )}
      <AlertDialog open={Boolean(projection.candidate)} onOpenChange={(open) => { if (!open && !projection.committing) onCancelAction() }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认{candidateMeta?.label}容器 {projection.candidate?.container.name}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="grid gap-1 break-words [overflow-wrap:anywhere]">
                <span>服务器：{hostLabel}</span>
                {hostDescription && <span>连接：{hostDescription}</span>}
                <span>容器：{projection.candidate?.container.name}</span>
                <span className="font-mono text-[11px]">完整 ID：{projection.candidate?.container.containerId}</span>
                <span>镜像：{projection.candidate?.container.image}</span>
                <span>当前状态：{projection.candidate?.container.state}</span>
                <span>动作：{candidateMeta?.label}</span>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={projection.committing}>取消</AlertDialogCancel>
            <AlertDialogAction
              className={candidateMeta?.destructive ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90' : undefined}
              disabled={projection.committing}
              onClick={(event) => { event.preventDefault(); onConfirmAction() }}
            >
              {projection.committing && <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />}
              确认{candidateMeta?.label}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/** 绑定 React 生命周期与注入的 Docker preload API。 */
export function ServerOpsDockerPanel({
  api,
  hostId,
  hostLabel,
  hostDescription,
  active,
  connected,
  onOpenContainerLogs,
  onOpenContainerConsole,
}: ServerOpsDockerPanelProps): React.ReactElement {
  /** 当前 Docker 控制器投影。 */
  const [projection, setProjection] = React.useState<ServerOpsDockerProjection>(() => createIdleProjection(hostId))
  /** 当前资源页签只保存在 Renderer 内存。 */
  const [activeTab, setActiveTab] = React.useState<ServerOpsDockerTab>('containers')
  /** StrictMode 重放期间复用同一控制器实例。 */
  const [controller] = React.useState(() => createServerOpsDockerController({
    listResources: (input) => api.listServerOpsDockerResources(input),
    getContainerDetail: (input) => api.getServerOpsDockerContainerDetail(input),
    prepareAction: (input) => api.prepareServerOpsDockerAction(input),
    commitAction: (input) => api.commitServerOpsDockerAction(input),
    cancelAction: (input) => api.cancelServerOpsDockerAction(input),
    publish: setProjection,
    notify: (kind, message) => {
      if (kind === 'success') toast.success(message)
      else if (kind === 'warning') toast.warning(message)
      else toast.error(message)
    },
  }))

  React.useEffect(() => {
    controller.activate()
    return () => controller.dispose()
  }, [controller])

  React.useEffect(() => {
    void controller.select({ hostId, active, connected })
  }, [active, connected, controller, hostId])

  return (
    <ServerOpsDockerPanelView
      projection={projection}
      hostLabel={hostLabel}
      hostDescription={hostDescription}
      connected={connected}
      activeTab={activeTab}
      onTabChange={setActiveTab}
      onRefresh={() => { void controller.refresh() }}
      onSelectContainer={(containerId) => { void controller.selectContainer(containerId) }}
      onRequestAction={(containerId, action) => { void controller.requestAction(containerId, action) }}
      onOpenContainerLogs={onOpenContainerLogs}
      onOpenContainerConsole={onOpenContainerConsole}
      onCancelAction={() => { void controller.cancelAction() }}
      onConfirmAction={() => { void controller.confirmAction() }}
    />
  )
}
