import * as React from 'react'
import {
  CirclePause,
  CirclePlay,
  LoaderCircle,
  Power,
  PowerOff,
  RefreshCw,
  RotateCw,
  Search,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type {
  ServerOpsServiceAction,
  ServerOpsServiceActionInput,
  ServerOpsServiceActionResult,
  ServerOpsServiceDetailInput,
  ServerOpsServiceDetailResult,
  ServerOpsServiceFilter,
  ServerOpsServiceListInput,
  ServerOpsServiceListResult,
  ServerOpsServiceSummary,
  ServerOpsSystemdCapability,
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
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'

/** 服务面板由当前普通 Agent、主机、可见性和连接事实共同驱动。 */
export interface ServerOpsServicesPanelProps {
  sessionId: string | null
  hostId: string
  hostLabel: string
  hostDescription?: string
  active: boolean
  connected: boolean
}

/** 服务列表与详情的稳定加载状态。 */
export type ServerOpsServicesStatus = 'idle' | 'loading' | 'ready' | 'error'

/** 一次等待用户逐次确认的固定服务动作。 */
export interface ServerOpsPendingServiceAction {
  unitId: string
  action: ServerOpsServiceAction
}

/** 服务控制器发布给 React 的完整投影。 */
export interface ServerOpsServicesProjection {
  hostId: string | null
  status: ServerOpsServicesStatus
  capability: ServerOpsSystemdCapability | null
  services: ServerOpsServiceSummary[]
  error: string | null
  selectedUnitId: string | null
  detailStatus: ServerOpsServicesStatus
  detail: ServerOpsServiceDetailResult | null
  detailError: string | null
  pendingAction: ServerOpsPendingServiceAction | null
  executingUnitId: string | null
}

/** 服务面板纯展示层属性。 */
export interface ServerOpsServicesPanelViewProps extends Omit<ServerOpsServicesProjection, 'hostId'> {
  connected?: boolean
  hostLabel?: string
  hostDescription?: string
  query: string
  filter: ServerOpsServiceFilter
  actionAvailable: boolean
  onQueryChange: (query: string) => void
  onFilterChange: (filter: ServerOpsServiceFilter) => void
  onRefresh: () => void
  onSelectService: (unitId: string) => void
  onRequestAction: (unitId: string, action: ServerOpsServiceAction) => void
  onCancelAction: () => void
  onConfirmAction: () => void
}

/** 服务控制器当前选择的完整上下文。 */
export interface ServerOpsServicesContext {
  sessionId: string | null
  hostId: string
  active: boolean
  connected: boolean
}

/** 服务控制器依赖。 */
interface ServerOpsServicesControllerOptions {
  listServices: (input: ServerOpsServiceListInput) => Promise<ServerOpsServiceListResult>
  getDetail: (input: ServerOpsServiceDetailInput) => Promise<ServerOpsServiceDetailResult>
  runAction: (input: ServerOpsServiceActionInput) => Promise<ServerOpsServiceActionResult>
  publish: (projection: ServerOpsServicesProjection) => void
  notify: (kind: 'success' | 'warning' | 'error', message: string) => void
}

/** 服务控制器公开操作。 */
export interface ServerOpsServicesController {
  activate: () => void
  select: (context: ServerOpsServicesContext) => Promise<void>
  refresh: () => Promise<void>
  selectService: (unitId: string) => Promise<void>
  requestAction: (unitId: string, action: ServerOpsServiceAction) => void
  cancelAction: () => void
  confirmAction: () => Promise<void>
  dispose: () => void
}

/** 服务动作显示配置。 */
interface ServerOpsServiceActionMeta {
  label: string
  icon: LucideIcon
  destructive: boolean
}

/** 五种固定动作的中文标签与图标。 */
const SERVER_OPS_SERVICE_ACTIONS: Record<ServerOpsServiceAction, ServerOpsServiceActionMeta> = {
  start: { label: '启动', icon: CirclePlay, destructive: false },
  stop: { label: '停止', icon: CirclePause, destructive: true },
  restart: { label: '重启', icon: RotateCw, destructive: true },
  enable: { label: '启用', icon: Power, destructive: false },
  disable: { label: '禁用', icon: PowerOff, destructive: true },
}

/** 固定服务动作顺序，保证按钮位置不会随状态变化。 */
const SERVER_OPS_SERVICE_ACTION_ORDER: readonly ServerOpsServiceAction[] = [
  'start', 'stop', 'restart', 'enable', 'disable',
]

/** 服务 UI 可公开的稳定错误码映射。 */
const SERVER_OPS_SERVICE_ERROR_MESSAGES = {
  SERVER_OPS_CONNECTION_CHANGED: '服务器连接已变化，请重新连接后重试',
  SERVER_OPS_SERVICE_LIST_FAILED: '服务列表读取失败，请重试',
  SERVER_OPS_SERVICE_LIST_RESULT_INVALID: '服务器返回的服务列表无效，请重试',
  SERVER_OPS_SERVICE_DETAIL_FAILED: '服务详情读取失败，请重试',
  SERVER_OPS_SERVICE_DETAIL_RESULT_INVALID: '服务器返回的服务详情无效，请重试',
  SERVER_OPS_SERVICE_ACTION_FAILED: '服务操作失败，状态已重新读取',
  SERVER_OPS_SERVICE_ACTION_IN_PROGRESS: '该服务已有操作正在执行，请等待完成后重试',
  SERVER_OPS_SERVICE_ACTION_UNKNOWN: '服务操作结果不确定，正在重新读取状态',
  SERVER_OPS_SYSTEMD_OUTPUT_INVALID: '服务器返回的 systemd 状态无效，请刷新后重试',
  SERVER_OPS_SYSTEMD_UNSUPPORTED: '当前服务器不支持 systemd',
  SERVER_OPS_SYSTEMD_PERMISSION_DENIED: '当前账号无权执行此服务操作',
  SERVER_OPS_AUDIT_WRITE_FAILED: '操作审计记录写入失败，服务动作未执行',
} as const

/** 主进程服务 warning 到用户恢复建议的固定映射。 */
const SERVER_OPS_SERVICE_WARNING_MESSAGES = {
  SERVER_OPS_SYSTEMD_OUTPUT_INVALID: '服务状态回读不完整，请刷新后确认',
  SERVER_OPS_AUDIT_RESULT_WRITE_FAILED: '服务操作已完成，但审计结果保存失败，请检查本地存储',
  SERVICE_ACTION_STATUS_UNKNOWN: '服务操作状态仍需确认，请刷新后查看',
} as const

/** 未识别 warning 不允许把原始码或底层文本带入界面。 */
const SERVER_OPS_SERVICE_FALLBACK_WARNING = '服务返回了未识别的警告，请刷新后确认'

/** 服务 UI 明确认可的稳定错误码。 */
type ServerOpsServiceErrorCode = keyof typeof SERVER_OPS_SERVICE_ERROR_MESSAGES

/** Electron 对服务动作 invoke rejection 添加的唯一固定前缀。 */
const SERVER_OPS_SERVICE_ACTION_ERROR_PREFIX = "Error invoking remote method 'server-ops:run-service-action': Error: "

/** 未知底层异常的固定降级文案。 */
const SERVER_OPS_SERVICE_FALLBACK_ERROR = '服务器服务暂时不可用，请稍后重试'

/** 已经收敛的安全文案集合。 */
const SERVER_OPS_SERVICE_SAFE_MESSAGES = new Set<string>(Object.values(SERVER_OPS_SERVICE_ERROR_MESSAGES))

/** 创建初始或上下文失效后的空投影。 */
function createIdleServicesProjection(hostId: string | null): ServerOpsServicesProjection {
  return {
    hostId,
    status: 'idle',
    capability: null,
    services: [],
    error: null,
    selectedUnitId: null,
    detailStatus: 'idle',
    detail: null,
    detailError: null,
    pendingAction: null,
    executingUnitId: null,
  }
}

/** 只从裸码或固定 Electron 包装中提取完整稳定码。 */
function getServiceErrorCode(error: unknown): ServerOpsServiceErrorCode | null {
  /** 原始错误文本不得 trim，任何额外字符都必须使解析失败。 */
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : null
  if (!message) return null
  if (Object.hasOwn(SERVER_OPS_SERVICE_ERROR_MESSAGES, message)) return message as ServerOpsServiceErrorCode
  if (!message.startsWith(SERVER_OPS_SERVICE_ACTION_ERROR_PREFIX)) return null
  /** 固定前缀之后必须只剩一个完整 allowlist code。 */
  const wrappedCode = message.slice(SERVER_OPS_SERVICE_ACTION_ERROR_PREFIX.length)
  return Object.hasOwn(SERVER_OPS_SERVICE_ERROR_MESSAGES, wrappedCode)
    ? wrappedCode as ServerOpsServiceErrorCode
    : null
}

/** 将未知异常收敛为稳定公开文案。 */
function getServiceErrorMessage(error: unknown): string {
  /** 分类必须基于解析后的稳定码，禁止从任意文本猜测。 */
  const errorCode = getServiceErrorCode(error)
  if (errorCode) return SERVER_OPS_SERVICE_ERROR_MESSAGES[errorCode]
  /** 已经由本控制器生成的中文安全文案允许原样复用。 */
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : null
  if (message && SERVER_OPS_SERVICE_SAFE_MESSAGES.has(message)) return message
  return SERVER_OPS_SERVICE_FALLBACK_ERROR
}

/** 判断两个服务上下文是否完全相同。 */
function isSameServicesContext(left: ServerOpsServicesContext | null, right: ServerOpsServicesContext): boolean {
  return left?.sessionId === right.sessionId
    && left.hostId === right.hostId
    && left.active === right.active
    && left.connected === right.connected
}

/** 判断当前上下文是否允许读取远程 systemd 状态。 */
function canReadServices(context: ServerOpsServicesContext | null): context is ServerOpsServicesContext {
  return Boolean(context?.active && context.connected)
}

/** 列表在途时记录一次最新补读及其等待者。 */
interface ServerOpsListFlight {
  queuedContextRevision: number | null
  queuedCompletion: Promise<void> | null
  resolveQueuedCompletion: (() => void) | null
}

/** 详情在途时只保留最后一次选择及其等待者。 */
interface ServerOpsDetailFlight {
  queuedContextRevision: number | null
  queuedUnitId: string | null
  queuedCompletion: Promise<void> | null
  resolveQueuedCompletion: (() => void) | null
}

/** Renderer 动作单飞不依赖当前页面投影，避免生命周期重放清除门禁。 */
interface ServerOpsActionFlight {
  hostId: string
  unitId: string
  action: ServerOpsServiceAction
}

/** 创建列表与详情使用独立代次、动作严格单飞的服务控制器。 */
export function createServerOpsServicesController(
  options: ServerOpsServicesControllerOptions,
): ServerOpsServicesController {
  /** 当前 React owner 是否仍有效。 */
  let ownerActive = false
  /** 当前服务页完整上下文。 */
  let context: ServerOpsServicesContext | null = null
  /** 主机、连接或可见性变化时推进的上下文代次。 */
  let contextRevision = 0
  /** 每次列表请求独立推进的代次。 */
  let listRevision = 0
  /** 每次详情请求或选择清理独立推进的代次。 */
  let detailRevision = 0
  /** 当前投影事实。 */
  let projection = createIdleServicesProjection(null)
  /** 每台主机至多一个真实列表读取。 */
  const listFlights = new Map<string, ServerOpsListFlight>()
  /** 每台主机至多一个真实详情读取。 */
  const detailFlights = new Map<string, ServerOpsDetailFlight>()
  /** 整个控制器至多一个已确认动作，跨页面与 StrictMode 重放保持。 */
  let actionFlight: ServerOpsActionFlight | null = null

  /** 仅当前 owner 发布投影副本。 */
  const publish = (next: ServerOpsServicesProjection): void => {
    projection = next
    if (ownerActive) options.publish(next)
  }

  /** 合并局部字段并发布新的不可变投影。 */
  const patch = (next: Partial<ServerOpsServicesProjection>): void => {
    publish({ ...projection, ...next })
  }

  /** 判断请求是否仍属于当前可读上下文。 */
  const isCurrentContext = (hostId: string, expectedContextRevision: number): boolean => (
    ownerActive
    && contextRevision === expectedContextRevision
    && context?.hostId === hostId
    && canReadServices(context)
  )

  /** 判断当前可读页面是否仍指向动作所属主机，不要求沿用动作开始时的页面代次。 */
  const isCurrentReadableHost = (hostId: string): boolean => (
    ownerActive && context?.hostId === hostId && canReadServices(context)
  )

  /** 向用户展示经过 Preload 严格解析的公开 warning。 */
  const reportWarnings = (warnings: readonly string[]): void => {
    for (const warning of warnings) {
      /** 只允许精确命中的稳定 warning 选择公开中文文案。 */
      const message = Object.hasOwn(SERVER_OPS_SERVICE_WARNING_MESSAGES, warning)
        ? SERVER_OPS_SERVICE_WARNING_MESSAGES[warning as keyof typeof SERVER_OPS_SERVICE_WARNING_MESSAGES]
        : SERVER_OPS_SERVICE_FALLBACK_WARNING
      options.notify('warning', message)
    }
  }

  /** 读取当前主机服务列表，搜索与状态筛选不进入 IPC。 */
  const loadList = async (): Promise<void> => {
    if (!canReadServices(context) || !ownerActive) return
    /** 本次列表请求绑定的身份。 */
    const hostId = context.hostId
    /** 本次列表请求绑定的上下文代次。 */
    const operationContextRevision = contextRevision
    /** 已有读取时只登记一次最新补读，并让调用者等待该补读结束。 */
    const existingFlight = listFlights.get(hostId)
    if (existingFlight) {
      existingFlight.queuedContextRevision = operationContextRevision
      if (!existingFlight.queuedCompletion) {
        existingFlight.queuedCompletion = new Promise<void>((resolve) => {
          existingFlight.resolveQueuedCompletion = resolve
        })
      }
      return existingFlight.queuedCompletion
    }
    /** 当前真实列表请求的单飞记录。 */
    const flight: ServerOpsListFlight = {
      queuedContextRevision: null,
      queuedCompletion: null,
      resolveQueuedCompletion: null,
    }
    listFlights.set(hostId, flight)
    /** 本次列表读取代次。 */
    const operationListRevision = ++listRevision
    patch({ status: 'loading', error: null })
    try {
      /** 主进程返回的权威服务列表。 */
      const result = await options.listServices({ hostId })
      if (!isCurrentContext(hostId, operationContextRevision) || listRevision !== operationListRevision) return
      if (result.hostId !== hostId) throw new Error('SERVER_OPS_SERVICE_LIST_HOST_MISMATCH')
      reportWarnings(result.warnings)
      /** 当前选择必须仍存在于权威列表中。 */
      const selectionExists = projection.selectedUnitId !== null
        && result.services.some((service) => service.unitId === projection.selectedUnitId)
      if (!selectionExists && projection.selectedUnitId !== null) detailRevision += 1
      publish({
        ...projection,
        hostId,
        status: 'ready',
        capability: result.capability,
        services: result.services,
        error: null,
        ...(selectionExists ? {} : {
          selectedUnitId: null,
          detailStatus: 'idle' as const,
          detail: null,
          detailError: null,
          pendingAction: null,
        }),
      })
    } catch (error) {
      if (!isCurrentContext(hostId, operationContextRevision) || listRevision !== operationListRevision) return
      patch({ status: 'error', capability: null, services: [], error: getServiceErrorMessage(error) })
    } finally {
      if (listFlights.get(hostId) === flight) {
        listFlights.delete(hostId)
        /** 连续刷新只触发一次属于最新可读上下文的补读。 */
        const shouldReadAgain = flight.queuedContextRevision !== null
          && flight.queuedContextRevision === contextRevision
          && isCurrentReadableHost(hostId)
        if (shouldReadAgain) {
          void loadList().finally(() => flight.resolveQueuedCompletion?.())
        } else {
          flight.resolveQueuedCompletion?.()
        }
      }
    }
  }

  /** 读取当前选中服务详情，并通过独立代次拒绝旧 unit 结果。 */
  const loadDetail = async (unitId: string): Promise<void> => {
    if (!canReadServices(context) || !ownerActive || projection.selectedUnitId !== unitId) return
    /** 本次详情请求绑定的主机。 */
    const hostId = context.hostId
    /** 本次详情请求绑定的上下文代次。 */
    const operationContextRevision = contextRevision
    /** 本次详情读取的独立代次。 */
    const operationDetailRevision = detailRevision
    /** 当前主机已有详情读取时，只覆盖为最后一次选择。 */
    const existingFlight = detailFlights.get(hostId)
    if (existingFlight) {
      existingFlight.queuedContextRevision = operationContextRevision
      existingFlight.queuedUnitId = unitId
      if (!existingFlight.queuedCompletion) {
        existingFlight.queuedCompletion = new Promise<void>((resolve) => {
          existingFlight.resolveQueuedCompletion = resolve
        })
      }
      return existingFlight.queuedCompletion
    }
    /** 当前真实详情请求的单飞记录。 */
    const flight: ServerOpsDetailFlight = {
      queuedContextRevision: null,
      queuedUnitId: null,
      queuedCompletion: null,
      resolveQueuedCompletion: null,
    }
    detailFlights.set(hostId, flight)
    patch({ detailStatus: 'loading', detailError: null })
    try {
      /** 主进程返回的权威服务详情。 */
      const result = await options.getDetail({ hostId, unitId })
      if (!isCurrentContext(hostId, operationContextRevision)
        || detailRevision !== operationDetailRevision
        || projection.selectedUnitId !== unitId) return
      if (result.hostId !== hostId || (result.service && result.service.unitId !== unitId)) {
        throw new Error('SERVER_OPS_SERVICE_DETAIL_IDENTITY_MISMATCH')
      }
      reportWarnings(result.warnings)
      patch({ detailStatus: 'ready', detail: result, detailError: null })
    } catch (error) {
      if (!isCurrentContext(hostId, operationContextRevision)
        || detailRevision !== operationDetailRevision
        || projection.selectedUnitId !== unitId) return
      patch({ detailStatus: 'error', detail: null, detailError: getServiceErrorMessage(error) })
    } finally {
      if (detailFlights.get(hostId) === flight) {
        detailFlights.delete(hostId)
        /** 旧详情结束后只补读当前仍选中的最后一个 unit。 */
        const queuedUnitId = flight.queuedUnitId
        const shouldReadAgain = queuedUnitId !== null
          && flight.queuedContextRevision === contextRevision
          && projection.selectedUnitId === queuedUnitId
          && isCurrentReadableHost(hostId)
        if (shouldReadAgain) {
          void loadDetail(queuedUnitId).finally(() => flight.resolveQueuedCompletion?.())
        } else {
          flight.resolveQueuedCompletion?.()
        }
      }
    }
  }

  return {
    activate: () => {
      if (ownerActive) return
      ownerActive = true
      contextRevision += 1
    },
    select: async (nextContext) => {
      if (!ownerActive || isSameServicesContext(context, nextContext)) return
      context = nextContext
      contextRevision += 1
      listRevision += 1
      detailRevision += 1
      publish({
        ...createIdleServicesProjection(nextContext.hostId),
        executingUnitId: actionFlight?.unitId ?? null,
      })
      if (canReadServices(context)) await loadList()
    },
    refresh: async () => {
      await loadList()
    },
    selectService: async (unitId) => {
      if (!canReadServices(context)
        || !projection.services.some((service) => service.unitId === unitId)) return
      detailRevision += 1
      patch({
        selectedUnitId: unitId,
        detailStatus: 'loading',
        detail: null,
        detailError: null,
        pendingAction: null,
      })
      await loadDetail(unitId)
    },
    requestAction: (unitId, action) => {
      if (!canReadServices(context)
        || !context.sessionId
        || actionFlight
        || projection.capability !== 'available'
        || projection.detailStatus !== 'ready'
        || projection.detail?.capability !== 'available'
        || projection.selectedUnitId !== unitId) return
      patch({ pendingAction: { unitId, action } })
    },
    cancelAction: () => {
      if (actionFlight) return
      patch({ pendingAction: null })
    },
    confirmAction: async () => {
      /** 重复确认必须在任何 await 前被同步拒绝。 */
      if (!ownerActive || actionFlight || !projection.pendingAction || !canReadServices(context) || !context.sessionId) return
      /** 本次动作绑定的稳定上下文。 */
      const operationContext = context
      /** 门禁已确认非空的普通 Agent 会话身份。 */
      const operationSessionId = context.sessionId
      /** 本次动作绑定的逐次确认。 */
      const pendingAction = projection.pendingAction
      actionFlight = { hostId: operationContext.hostId, unitId: pendingAction.unitId, action: pendingAction.action }
      patch({ pendingAction: null, executingUnitId: pendingAction.unitId })
      try {
        /** 用户确认后只允许调用一次固定动作 IPC。 */
        const result = await options.runAction({
          sessionId: operationSessionId,
          hostId: operationContext.hostId,
          unitId: pendingAction.unitId,
          action: pendingAction.action,
        })
        if (!isCurrentReadableHost(operationContext.hostId)) return
        if (result.hostId !== operationContext.hostId
          || result.unitId !== pendingAction.unitId
          || result.action !== pendingAction.action) {
          throw new Error('SERVER_OPS_SERVICE_ACTION_IDENTITY_MISMATCH')
        }
        reportWarnings(result.warnings)
        /** 动作响应没有服务快照时明确标记未知，实际状态仍由后续回读决定。 */
        options.notify(
          result.service ? 'success' : 'warning',
          result.service
            ? `服务${SERVER_OPS_SERVICE_ACTIONS[pendingAction.action].label}操作已完成，状态已重新读取`
            : '服务操作结果未知，正在重新读取状态',
        )
      } catch (error) {
        if (isCurrentReadableHost(operationContext.hostId)) {
          /** unknown 表示远端可能已经执行，必须以 warning 表达不确定而非确定失败。 */
          const errorCode = getServiceErrorCode(error)
          const message = getServiceErrorMessage(error)
          options.notify(errorCode === 'SERVER_OPS_SERVICE_ACTION_UNKNOWN' ? 'warning' : 'error',
            message === SERVER_OPS_SERVICE_FALLBACK_ERROR ? '服务操作失败，状态已重新读取' : message)
        }
      } finally {
        if (isCurrentReadableHost(operationContext.hostId)) {
          /** 无论动作成功、失败或未知，都先刷新整个服务列表。 */
          await loadList()
          /** 列表回读后只刷新当前仍有效的选择，避免旧动作覆盖用户新查看的服务。 */
          const currentSelectedUnitId = projection.selectedUnitId
          if (currentSelectedUnitId && isCurrentReadableHost(operationContext.hostId)) {
            await loadDetail(currentSelectedUnitId)
          }
        }
        actionFlight = null
        if (isCurrentReadableHost(operationContext.hostId)
          && projection.executingUnitId === pendingAction.unitId) {
          patch({ executingUnitId: null })
        }
      }
    },
    dispose: () => {
      ownerActive = false
      context = null
      contextRevision += 1
      listRevision += 1
      detailRevision += 1
      projection = {
        ...createIdleServicesProjection(null),
        executingUnitId: actionFlight?.unitId ?? null,
      }
    },
  }
}

/** 将远程 activeState 归入前端固定筛选。 */
function matchesServiceFilter(service: ServerOpsServiceSummary, filter: ServerOpsServiceFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'running') return service.activeState === 'active'
  if (filter === 'failed') return service.activeState === 'failed' || service.subState === 'failed'
  return service.activeState !== 'active' && service.activeState !== 'failed' && service.subState !== 'failed'
}

/** 生成 activeState 的紧凑中文状态。 */
function getServiceStateLabel(service: ServerOpsServiceSummary): string {
  if (service.activeState === 'active') return '运行中'
  if (service.activeState === 'failed' || service.subState === 'failed') return '失败'
  return '已停止'
}

/** 生成 enable 状态的稳定显示。 */
function getEnabledLabel(enabled: boolean | null): string {
  return enabled === true ? '已启用' : enabled === false ? '已禁用' : '未知'
}

/** 纯展示的 systemd 服务列表、详情与逐次确认。 */
export function ServerOpsServicesPanelView({
  status,
  connected = true,
  hostLabel = '当前服务器',
  hostDescription,
  capability,
  services,
  error,
  query,
  filter,
  selectedUnitId,
  detailStatus,
  detail,
  detailError,
  pendingAction,
  executingUnitId,
  actionAvailable,
  onQueryChange,
  onFilterChange,
  onRefresh,
  onSelectService,
  onRequestAction,
  onCancelAction,
  onConfirmAction,
}: ServerOpsServicesPanelViewProps): React.ReactElement {
  /** 搜索和状态筛选只作用于当前内存快照。 */
  const normalizedQuery = query.trim().toLocaleLowerCase()
  /** 当前筛选后的服务列表。 */
  const filteredServices = services.filter((service) => (
    matchesServiceFilter(service, filter)
    && (normalizedQuery.length === 0
      || service.unitId.toLocaleLowerCase().includes(normalizedQuery)
      || service.description.toLocaleLowerCase().includes(normalizedQuery))
  ))
  /** 当前选中服务的摘要。 */
  const selectedService = services.find((service) => service.unitId === selectedUnitId) ?? null
  /** 待确认动作的显示元数据。 */
  const pendingActionMeta = pendingAction ? SERVER_OPS_SERVICE_ACTIONS[pendingAction.action] : null

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-server-ops-services-panel>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <div className="relative min-w-40 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input
            className="h-8 pl-8 text-xs"
            aria-label="搜索 systemd 服务"
            placeholder="搜索 unit 或描述"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
          />
        </div>
        <Select value={filter} onValueChange={(value) => onFilterChange(value as ServerOpsServiceFilter)}>
          <SelectTrigger className="h-8 w-28 text-xs" aria-label="筛选服务状态">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部状态</SelectItem>
            <SelectItem value="running">运行中</SelectItem>
            <SelectItem value="failed">失败</SelectItem>
            <SelectItem value="stopped">已停止</SelectItem>
          </SelectContent>
        </Select>
        <Button type="button" variant="ghost" size="icon-sm" aria-label="刷新服务列表" onClick={onRefresh}>
          <RefreshCw className={cn('size-3.5', status === 'loading' && 'animate-spin')} aria-hidden="true" />
        </Button>
      </div>

      {!connected ? (
        <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">尚未建立 SSH 连接</div>
      ) : status === 'idle' || status === 'loading' ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-xs text-muted-foreground" role="status">
          <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />正在读取服务列表...
        </div>
      ) : status === 'error' ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
          <p className="text-sm">服务列表读取失败</p>
          <p className="text-xs text-muted-foreground">{error ?? SERVER_OPS_SERVICE_FALLBACK_ERROR}</p>
          <Button type="button" size="sm" variant="outline" onClick={onRefresh}><RefreshCw className="size-3.5" />重试</Button>
        </div>
      ) : capability === 'unsupported' ? (
        <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">当前服务器不支持 systemd</div>
      ) : capability === 'permission-denied' ? (
        <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">当前账号无权读取 systemd 服务</div>
      ) : services.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">没有可显示的服务</div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <div className="shrink-0 overflow-x-auto">
            <table className="w-full min-w-[620px] table-fixed text-left text-xs">
              <colgroup><col className="w-[30%]" /><col className="w-[38%]" /><col className="w-[16%]" /><col className="w-[16%]" /></colgroup>
              <thead className="sticky top-0 z-10 border-b border-border bg-content-area text-[11px] text-muted-foreground">
                <tr><th className="px-3 py-2 font-medium">Unit</th><th className="px-3 py-2 font-medium">描述</th><th className="px-3 py-2 font-medium">状态</th><th className="px-3 py-2 font-medium">开机启动</th></tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filteredServices.map((service) => (
                  <tr key={service.unitId} className={cn('hover:bg-muted/35', selectedUnitId === service.unitId && 'bg-accent/55')}>
                    <td className="truncate px-1 py-1 font-mono text-[11px] font-medium">
                      <Button
                        type="button"
                        variant="ghost"
                        className="h-7 max-w-full justify-start px-2 font-mono text-[11px]"
                        aria-label={`查看 ${service.unitId} 服务详情`}
                        aria-pressed={selectedUnitId === service.unitId}
                        onClick={() => onSelectService(service.unitId)}
                      >
                        <span className="truncate">{service.unitId}</span>
                      </Button>
                    </td>
                    <td className="truncate px-3 py-2 text-muted-foreground">{service.description || '无描述'}</td>
                    <td className="px-3 py-2"><Badge variant="outline" className="font-normal">{getServiceStateLabel(service)}</Badge></td>
                    <td className="px-3 py-2 text-muted-foreground">{getEnabledLabel(service.enabled)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {filteredServices.length === 0 && (
            <div className="flex min-h-24 items-center justify-center border-b border-border px-6 text-xs text-muted-foreground">没有匹配当前筛选的服务</div>
          )}

          {selectedService && (
            <section className="border-t border-border px-3 py-3" aria-label={`${selectedService.unitId} 服务详情`}>
              <div className="flex flex-wrap items-start gap-2">
                <div className="min-w-0 flex-1">
                  <h3 className="truncate font-mono text-xs font-medium">{selectedService.unitId}</h3>
                  <p className="mt-1 truncate text-[11px] text-muted-foreground">{selectedService.description || '无描述'}</p>
                </div>
                <TooltipProvider delayDuration={200}>
                  <div className="flex flex-wrap items-center gap-1">
                    {SERVER_OPS_SERVICE_ACTION_ORDER.map((action) => {
                      /** 当前动作按钮显示配置。 */
                      const meta = SERVER_OPS_SERVICE_ACTIONS[action]
                      /** 当前动作图标。 */
                      const Icon = meta.icon
                      /** 执行期间当前服务全部动作都不可再次提交。 */
                      const disabled = !actionAvailable
                        || executingUnitId !== null
                        || detailStatus !== 'ready'
                        || detail?.capability !== 'available'
                      return (
                        <Tooltip key={action}>
                          <TooltipTrigger asChild>
                            <span className="inline-flex" tabIndex={disabled ? 0 : undefined}>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon-sm"
                                disabled={disabled}
                                aria-label={`${meta.label} ${selectedService.unitId}`}
                                onClick={() => onRequestAction(selectedService.unitId, action)}
                              >
                                {executingUnitId === selectedService.unitId
                                  ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
                                  : <Icon className="size-3.5" aria-hidden="true" />}
                              </Button>
                            </span>
                          </TooltipTrigger>
                          <TooltipContent side="bottom">{meta.label} {selectedService.unitId}</TooltipContent>
                        </Tooltip>
                      )
                    })}
                  </div>
                </TooltipProvider>
              </div>

              {detailStatus === 'loading' ? (
                <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground" role="status"><LoaderCircle className="size-3.5 animate-spin" />正在读取服务详情...</div>
              ) : detailStatus === 'error' ? (
                <div className="mt-3 text-xs text-destructive">{detailError ?? SERVER_OPS_SERVICE_FALLBACK_ERROR}</div>
              ) : detail?.capability === 'unsupported' ? (
                <div className="mt-3 text-xs text-muted-foreground">当前服务不支持 systemd 操作</div>
              ) : detail?.capability === 'permission-denied' ? (
                <div className="mt-3 text-xs text-muted-foreground">当前账号无权读取此服务详情</div>
              ) : detail ? (
                <div className="mt-3 grid gap-3" data-server-ops-service-detail-grid>
                  <div className="min-w-0">
                    <h4 className="mb-1 text-[11px] font-medium text-muted-foreground">systemctl status</h4>
                    <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words bg-muted/30 p-2 font-mono text-[11px] leading-5">{detail.statusLines.join('\n') || '没有状态输出'}</pre>
                  </div>
                  <div className="min-w-0">
                    <h4 className="mb-1 text-[11px] font-medium text-muted-foreground">近期日志</h4>
                    <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words bg-muted/30 p-2 font-mono text-[11px] leading-5">{detail.recentLogLines.join('\n') || '没有近期日志'}</pre>
                  </div>
                </div>
              ) : null}
            </section>
          )}
        </div>
      )}

      {pendingAction && pendingActionMeta && (
        <span className="sr-only" role="status">
          待确认：服务器：{hostLabel}；{hostDescription ? `连接：${hostDescription}；` : ''}服务：{pendingAction.unitId}；动作：{pendingActionMeta.label}
        </span>
      )}
      <AlertDialog open={Boolean(pendingAction)} onOpenChange={(open) => { if (!open) onCancelAction() }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认{pendingActionMeta?.label} {pendingAction?.unitId}</AlertDialogTitle>
            <AlertDialogDescription>
              <span className="grid gap-1 break-words [overflow-wrap:anywhere]">
                <span>服务器：{hostLabel}</span>
                {hostDescription && <span>连接：{hostDescription}</span>}
                <span>服务：{pendingAction?.unitId}</span>
                <span>动作：{pendingActionMeta?.label}</span>
                <span className="pt-1">该操作会修改远程服务状态。Proma 不会自动使用 sudo，也不会处理远程密码提示。</span>
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className={pendingActionMeta?.destructive ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90' : undefined}
              onClick={onConfirmAction}
            >
              确认{pendingActionMeta?.label}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/** 绑定 React 生命周期与现有 Electron 服务 IPC。 */
export function ServerOpsServicesPanel({
  sessionId,
  hostId,
  hostLabel,
  hostDescription,
  active,
  connected,
}: ServerOpsServicesPanelProps): React.ReactElement {
  /** 当前服务控制器投影。 */
  const [projection, setProjection] = React.useState<ServerOpsServicesProjection>(() => createIdleServicesProjection(hostId))
  /** 内存搜索条件。 */
  const [query, setQuery] = React.useState('')
  /** 内存状态筛选。 */
  const [filter, setFilter] = React.useState<ServerOpsServiceFilter>('all')
  /** StrictMode 重放期间复用同一个控制器实例。 */
  const [controller] = React.useState(() => createServerOpsServicesController({
    listServices: (input) => window.electronAPI.listServerOpsServices(input),
    getDetail: (input) => window.electronAPI.getServerOpsServiceDetail(input),
    runAction: (input) => window.electronAPI.runServerOpsServiceAction(input),
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
    void controller.select({ sessionId, hostId, active, connected })
  }, [active, connected, controller, hostId, sessionId])

  return (
    <ServerOpsServicesPanelView
      {...projection}
      connected={connected}
      hostLabel={hostLabel}
      hostDescription={hostDescription}
      query={query}
      filter={filter}
      actionAvailable={Boolean(sessionId && active && connected)}
      onQueryChange={setQuery}
      onFilterChange={setFilter}
      onRefresh={() => { void controller.refresh() }}
      onSelectService={(unitId) => { void controller.selectService(unitId) }}
      onRequestAction={(unitId, action) => controller.requestAction(unitId, action)}
      onCancelAction={() => controller.cancelAction()}
      onConfirmAction={() => { void controller.confirmAction() }}
    />
  )
}
