import * as React from 'react'
import {
  Activity,
  AlertTriangle,
  Cpu,
  HardDrive,
  MemoryStick,
  Network,
  RefreshCw,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { ServerOpsOverviewResult } from '@proma/shared'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/** 概览面板由当前主机身份、可见性和连接事实驱动。 */
export interface ServerOpsOverviewPanelProps {
  hostId: string
  active: boolean
  connected: boolean
}

/** 概览视图支持的稳定加载状态。 */
export type ServerOpsOverviewStatus = 'idle' | 'loading' | 'ready' | 'error'

/** 概览控制器发布给 React 的完整投影。 */
export interface ServerOpsOverviewProjection {
  hostId: string | null
  status: ServerOpsOverviewStatus
  snapshot: ServerOpsOverviewResult | null
  stale: boolean
  error: string | null
  requestRevision: number
}

/** 可独立静态验证的概览视图属性。 */
export interface ServerOpsOverviewPanelViewProps {
  status: ServerOpsOverviewStatus
  snapshot: ServerOpsOverviewResult | null
  stale: boolean
  error: string | null
  onRefresh: () => void
}

/** 概览控制器当前选择的运行上下文。 */
export interface ServerOpsOverviewContext {
  hostId: string
  active: boolean
  connected: boolean
}

/** 概览控制器依赖，定时器可替换以便确定性验证。 */
interface ServerOpsOverviewControllerOptions {
  getOverview: (input: { hostId: string }) => Promise<ServerOpsOverviewResult>
  publish: (projection: ServerOpsOverviewProjection) => void
  setInterval?: (callback: () => void, delayMs: number) => number
  clearInterval?: (timerId: number) => void
}

/** 概览控制器公开操作。 */
export interface ServerOpsOverviewController {
  activate: () => void
  select: (context: ServerOpsOverviewContext) => void
  refresh: () => void
  dispose: () => void
}

/** 单个主机在途请求的身份与合并刷新状态。 */
interface ServerOpsOverviewFlight {
  refreshQueued: boolean
  queuedContextRevision: number | null
}

/** 四个首要指标的扁平展示定义。 */
interface ServerOpsMetric {
  id: 'cpu' | 'memory' | 'root-disk' | 'load'
  label: string
  value: string
  detail: string
  icon: LucideIcon
  warning: string | null
}

/** 当前可见且已连接的概览固定每 10 秒刷新。 */
const SERVER_OPS_OVERVIEW_INTERVAL_MS = 10_000

/** 概览服务允许 Renderer 识别的稳定错误码与固定恢复文案。 */
const SERVER_OPS_OVERVIEW_ERROR_MESSAGES = {
  SERVER_OPS_CONNECTION_CHANGED: '服务器连接已变化，请重新连接后重试',
  SERVER_OPS_OVERVIEW_OUTPUT_INVALID: '服务器返回的概览数据无效，请重试',
  SERVER_OPS_OVERVIEW_FAILED: '服务器概览读取失败，请重试',
} as const

/** 未知错误统一降级，禁止底层路径、连接标识或 IPC 包装文本进入 Renderer。 */
const SERVER_OPS_OVERVIEW_FALLBACK_ERROR = '服务器概览暂时不可用，请稍后重试'

/** 已经通过映射的固定中文文案集合，供纯 View 再次防御性收敛。 */
const SERVER_OPS_OVERVIEW_SAFE_MESSAGES = new Set<string>(Object.values(SERVER_OPS_OVERVIEW_ERROR_MESSAGES))

/** 创建空闲概览投影，供初始渲染和身份失效使用。 */
function createIdleProjection(hostId: string | null, requestRevision = 0): ServerOpsOverviewProjection {
  return { hostId, status: 'idle', snapshot: null, stale: false, error: null, requestRevision }
}

/** 将未知异常收敛为可恢复的用户可见信息。 */
function getOverviewErrorMessage(error: unknown): string {
  /** 仅精确接受 Error.message 或已收敛字符串，不从包装文本中提取错误码。 */
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : null
  if (message && SERVER_OPS_OVERVIEW_SAFE_MESSAGES.has(message)) return message
  if (message && Object.hasOwn(SERVER_OPS_OVERVIEW_ERROR_MESSAGES, message)) {
    return SERVER_OPS_OVERVIEW_ERROR_MESSAGES[message as keyof typeof SERVER_OPS_OVERVIEW_ERROR_MESSAGES]
  }
  return SERVER_OPS_OVERVIEW_FALLBACK_ERROR
}

/** 判断两个控制器上下文是否完全相同。 */
function isSameOverviewContext(left: ServerOpsOverviewContext | null, right: ServerOpsOverviewContext): boolean {
  return left?.hostId === right.hostId && left.active === right.active && left.connected === right.connected
}

/** 判断上下文当前是否允许远程概览读取。 */
function canReadOverview(context: ServerOpsOverviewContext | null): context is ServerOpsOverviewContext {
  return Boolean(context?.active && context.connected)
}

/** 创建按主机单飞、按上下文代次接纳结果的概览控制器。 */
export function createServerOpsOverviewController(
  options: ServerOpsOverviewControllerOptions,
): ServerOpsOverviewController {
  /** 浏览器定时器实现，测试可注入内存调度器。 */
  const scheduleInterval = options.setInterval ?? ((callback, delayMs) => window.setInterval(callback, delayMs))
  /** 浏览器定时器清理实现，测试可注入内存调度器。 */
  const cancelInterval = options.clearInterval ?? ((timerId) => window.clearInterval(timerId))
  /** 每个主机最多一个真实在途请求。 */
  const flights = new Map<string, ServerOpsOverviewFlight>()
  /** 每个主机最近一次成功快照，用于失败降级。 */
  const successfulSnapshots = new Map<string, ServerOpsOverviewResult>()
  /** 当前 React owner 是否仍有效。 */
  let ownerActive = false
  /** 当前面板选择与连接上下文。 */
  let context: ServerOpsOverviewContext | null = null
  /** 上下文身份代次，切主机、停用、断线和 dispose 都会推进。 */
  let contextRevision = 0
  /** 公开请求代次，用于观察每次刷新与失效。 */
  let requestRevision = 0
  /** 当前可见面板唯一的轮询定时器。 */
  let timerId: number | null = null

  /** 仅当前 React owner 可以发布投影。 */
  const publish = (projection: ServerOpsOverviewProjection): void => {
    if (ownerActive) options.publish(projection)
  }

  /** 清除当前轮询，不影响已在途但已由代次隔离的请求。 */
  const stopTimer = (): void => {
    if (timerId === null) return
    cancelInterval(timerId)
    timerId = null
  }

  /** 判断异步结果是否仍属于当前可读主机和上下文代次。 */
  const isCurrent = (hostId: string, expectedContextRevision: number): boolean => (
    ownerActive
    && contextRevision === expectedContextRevision
    && context?.hostId === hostId
    && canReadOverview(context)
  )

  /** 为当前主机发起或合并一次读取。 */
  const requestCurrent = (): void => {
    if (!ownerActive || !canReadOverview(context)) return
    /** 本次读取绑定的稳定主机身份。 */
    const hostId = context.hostId
    /** 本次读取绑定的上下文代次。 */
    const operationContextRevision = contextRevision
    /** 同主机已有读取时只记录一次最新上下文的补刷新意图。 */
    const existingFlight = flights.get(hostId)
    if (existingFlight) {
      existingFlight.refreshQueued = true
      existingFlight.queuedContextRevision = operationContextRevision
      /** 切回旧在途主机时立即隔离上一主机的投影，同时继续保持单飞。 */
      publish({
        hostId,
        status: 'loading',
        snapshot: successfulSnapshots.get(hostId) ?? null,
        stale: false,
        error: null,
        requestRevision,
      })
      return
    }

    /** 每次真实 IPC 都取得唯一公开请求代次。 */
    const operationRequestRevision = ++requestRevision
    /** 刷新时保留该主机最近成功内容，避免布局和信息闪烁。 */
    const previousSnapshot = successfulSnapshots.get(hostId) ?? null
    /** 当前主机新建的唯一在途记录。 */
    const flight: ServerOpsOverviewFlight = {
      refreshQueued: false,
      queuedContextRevision: null,
    }
    flights.set(hostId, flight)
    publish({
      hostId,
      status: 'loading',
      snapshot: previousSnapshot,
      stale: false,
      error: null,
      requestRevision: operationRequestRevision,
    })

    void options.getOverview({ hostId }).then((snapshot) => {
      if (!isCurrent(hostId, operationContextRevision)) return
      if (snapshot.hostId !== hostId) throw new Error('SERVER_OPS_OVERVIEW_HOST_MISMATCH')
      successfulSnapshots.set(hostId, snapshot)
      publish({
        hostId,
        status: 'ready',
        snapshot,
        stale: false,
        error: null,
        requestRevision: operationRequestRevision,
      })
    }).catch((error: unknown) => {
      if (!isCurrent(hostId, operationContextRevision)) return
      /** 失败时只允许沿用同一主机的最近成功快照。 */
      const snapshot = successfulSnapshots.get(hostId) ?? null
      publish({
        hostId,
        status: snapshot ? 'ready' : 'error',
        snapshot,
        stale: Boolean(snapshot),
        error: getOverviewErrorMessage(error),
        requestRevision: operationRequestRevision,
      })
    }).finally(() => {
      if (flights.get(hostId) !== flight) return
      flights.delete(hostId)
      /** 仅当前上下文在该轮期间请求过刷新时补读一次。 */
      if (flight.refreshQueued
        && flight.queuedContextRevision !== null
        && isCurrent(hostId, flight.queuedContextRevision)) {
        requestCurrent()
      }
    })
  }

  /** 为当前有效上下文创建唯一轮询定时器。 */
  const startTimer = (): void => {
    stopTimer()
    if (!ownerActive || !canReadOverview(context)) return
    /** 定时器创建时捕获的主机，clear 后迟到 callback 不得跟随新选择。 */
    const scheduledHostId = context.hostId
    /** 定时器创建时捕获的上下文代次。 */
    const scheduledContextRevision = contextRevision
    timerId = scheduleInterval(() => {
      if (!isCurrent(scheduledHostId, scheduledContextRevision)) return
      requestCurrent()
    }, SERVER_OPS_OVERVIEW_INTERVAL_MS)
  }

  return {
    activate: () => {
      if (ownerActive) return
      ownerActive = true
      contextRevision += 1
    },
    select: (nextContext) => {
      if (!ownerActive || isSameOverviewContext(context, nextContext)) return
      /** 断线表示 SSH 连接代次终结，同 host 的成功快照必须立即失效。 */
      const disconnectedHostId = context?.hostId === nextContext.hostId
        && context.connected
        && !nextContext.connected
        ? nextContext.hostId
        : null
      stopTimer()
      if (disconnectedHostId) successfulSnapshots.delete(disconnectedHostId)
      context = nextContext
      contextRevision += 1
      requestRevision += 1
      /** 不可读上下文绝不触发 IPC，也不把断线误报成刷新失败。 */
      if (!canReadOverview(context)) {
        publish(createIdleProjection(nextContext.hostId, requestRevision))
        return
      }
      startTimer()
      requestCurrent()
    },
    refresh: () => {
      requestCurrent()
    },
    dispose: () => {
      stopTimer()
      ownerActive = false
      context = null
      contextRevision += 1
      requestRevision += 1
      /** dispose 后的旧请求不再排队刷新。 */
      for (const flight of flights.values()) {
        flight.refreshQueued = false
        flight.queuedContextRevision = null
      }
    },
  }
}

/** 将字节数转换为紧凑、稳定的二进制单位。 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  /** 二进制单位按从小到大排列。 */
  const units = ['KB', 'MB', 'GB', 'TB'] as const
  /** 当前已缩放的数值。 */
  let value = bytes / 1024
  /** 当前数值对应的单位索引。 */
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${units[unitIndex]}`
}

/** 将百分比保持为最多一位小数，避免伪造采集精度。 */
function formatPercent(value: number): string {
  return `${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)}%`
}

/** 将运行秒数转换为适合概览扫读的天时分。 */
function formatUptime(seconds: number): string {
  /** 完整运行天数。 */
  const days = Math.floor(seconds / 86_400)
  /** 去除天数后的完整小时数。 */
  const hours = Math.floor((seconds % 86_400) / 3_600)
  /** 去除小时后的完整分钟数。 */
  const minutes = Math.floor((seconds % 3_600) / 60)
  return `${days > 0 ? `${days} 天 ` : ''}${hours} 小时 ${minutes} 分钟`
}

/** 从快照生成四个只支持首要判断的紧凑指标。 */
function createMetrics(snapshot: ServerOpsOverviewResult): ServerOpsMetric[] {
  /** 内存使用率只在总量有效时计算。 */
  const memoryPercent = snapshot.memory && snapshot.memory.totalBytes > 0
    ? (snapshot.memory.usedBytes / snapshot.memory.totalBytes) * 100
    : null
  /** 顶部磁盘摘要严格选择 Linux 根挂载点，避免数据盘覆盖系统盘判断。 */
  const rootFilesystem = snapshot.filesystems.find((filesystem) => filesystem.mountPoint === '/') ?? null
  return [
    {
      id: 'cpu',
      label: 'CPU',
      value: snapshot.cpu ? formatPercent(snapshot.cpu.usagePercent) : '不可用',
      detail: snapshot.cpu ? `${snapshot.cpu.cores} 核 · Load ${snapshot.cpu.load1.toFixed(2)}` : '未采集到 CPU 指标',
      icon: Cpu,
      warning: snapshot.warnings.includes('CPU_PARTIAL') ? 'CPU 数据可能不完整' : null,
    },
    {
      id: 'memory',
      label: '内存',
      value: memoryPercent === null ? '不可用' : formatPercent(memoryPercent),
      detail: snapshot.memory ? `${formatBytes(snapshot.memory.usedBytes)} / ${formatBytes(snapshot.memory.totalBytes)}` : '未采集到内存指标',
      icon: MemoryStick,
      warning: snapshot.warnings.includes('MEMORY_PARTIAL') ? '内存数据可能不完整' : null,
    },
    {
      id: 'root-disk',
      label: '根磁盘',
      value: rootFilesystem ? formatPercent(rootFilesystem.usagePercent) : '不可用',
      detail: rootFilesystem ? `${rootFilesystem.mountPoint} · ${formatBytes(rootFilesystem.availableBytes)} 可用` : '未采集到根挂载点',
      icon: HardDrive,
      warning: null,
    },
    {
      id: 'load',
      label: '负载',
      value: snapshot.cpu ? snapshot.cpu.load1.toFixed(2) : '不可用',
      detail: snapshot.cpu
        ? `1 分钟 ${snapshot.cpu.load1.toFixed(2)} · 5 分钟 ${snapshot.cpu.load5.toFixed(2)} · 15 分钟 ${snapshot.cpu.load15.toFixed(2)}`
        : '未采集到系统负载',
      icon: Activity,
      warning: null,
    },
  ]
}

/** 在所属数据区内展示克制的局部不完整提示。 */
function ServerOpsLocalWarning({ message }: { message: string }): React.ReactElement {
  return (
    <p className="mt-2 flex items-start gap-1 text-[10px] leading-4 text-amber-700 dark:text-amber-300" role="status">
      <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
      <span>{message}</span>
    </p>
  )
}

/** 展示稳定尺寸的概览加载骨架。 */
function ServerOpsOverviewSkeleton(): React.ReactElement {
  /** 四个稳定指标占位。 */
  const metricSkeletons = Array.from({ length: 4 }, (_, index) => index)
  return (
    <div className="space-y-5" data-server-ops-overview-skeleton>
      <div className="grid grid-cols-2 overflow-hidden rounded-md border border-border" data-server-ops-overview-grid>
        {metricSkeletons.map((index) => (
          <div
            key={index}
            className={cn(
              'min-h-24 animate-pulse border-border p-3 odd:border-r',
              index < 2 && 'border-b',
            )}
          >
            <div className="h-3 w-12 rounded-sm bg-muted" />
            <div className="mt-4 h-6 w-20 rounded-sm bg-muted" />
            <div className="mt-2 h-3 w-28 max-w-full rounded-sm bg-muted" />
          </div>
        ))}
      </div>
      <div className="h-28 animate-pulse rounded-md border border-border bg-muted/25" />
      <div className="h-40 animate-pulse rounded-md border border-border bg-muted/25" />
    </div>
  )
}

/** 概览没有可展示快照时提供明确恢复入口。 */
function ServerOpsOverviewEmpty({ onRefresh }: { onRefresh: () => void }): React.ReactElement {
  return (
    <div className="flex min-h-52 flex-col items-center justify-center gap-3 rounded-md border border-dashed border-border px-6 text-center">
      <HardDrive className="size-5 text-muted-foreground" aria-hidden="true" />
      <div>
        <p className="text-sm font-medium">暂无可用的服务器概览</p>
        <p className="mt-1 text-xs text-muted-foreground">连接服务器并刷新后显示实时运行数据。</p>
      </div>
      <Button type="button" variant="outline" size="sm" onClick={onRefresh} aria-label="刷新服务器概览">
        <RefreshCw className="size-3.5" aria-hidden="true" />刷新
      </Button>
    </div>
  )
}

/** 可静态测试的真实概览展示层。 */
export function ServerOpsOverviewPanelView({
  status,
  snapshot,
  stale,
  error,
  onRefresh,
}: ServerOpsOverviewPanelViewProps): React.ReactElement {
  if (status === 'loading' && !snapshot) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto p-3" data-server-ops-overview-panel aria-busy="true">
        <ServerOpsOverviewSkeleton />
      </div>
    )
  }
  if (status === 'error' && !snapshot) {
    /** 即使 View 被误传原始文本，也只允许展示固定恢复文案。 */
    const safeError = getOverviewErrorMessage(error)
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center" data-server-ops-overview-panel>
        <AlertTriangle className="size-5 text-destructive" aria-hidden="true" />
        <div>
          <p className="text-sm font-medium">服务器概览读取失败</p>
          <p className="mt-1 max-w-sm break-all text-xs text-muted-foreground">{safeError}</p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={onRefresh} aria-label="刷新服务器概览">
          <RefreshCw className="size-3.5" aria-hidden="true" />重试
        </Button>
      </div>
    )
  }
  if (!snapshot) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto p-3" data-server-ops-overview-panel>
        <ServerOpsOverviewEmpty onRefresh={onRefresh} />
      </div>
    )
  }

  /** 当前快照的四个首要指标。 */
  const metrics = createMetrics(snapshot)
  /** 输出截断影响多个采集区，因此保留为全局提示。 */
  const outputTruncated = snapshot.warnings.includes('OUTPUT_TRUNCATED')
  /** stale 错误在 View 边界再次收敛，阻止调用方绕过 Controller。 */
  const safeError = error ? getOverviewErrorMessage(error) : SERVER_OPS_OVERVIEW_FALLBACK_ERROR
  return (
    <div className="min-h-0 flex-1 overflow-y-auto" data-server-ops-overview-panel aria-busy={status === 'loading' ? true : undefined}>
      <div className="mx-auto w-full max-w-5xl space-y-5 p-3">
        <div className="flex min-h-7 items-center justify-between gap-3">
          <div className="min-w-0 text-[11px] text-muted-foreground">
            采集于 <time dateTime={new Date(snapshot.capturedAt).toISOString()}>{new Date(snapshot.capturedAt).toLocaleString()}</time>
            {status === 'loading' ? <span role="status"> · 正在更新</span> : null}
          </div>
          <Button type="button" variant="ghost" size="icon-sm" onClick={onRefresh} aria-label="刷新服务器概览">
            <RefreshCw className={cn('size-3.5', status === 'loading' && 'animate-spin')} aria-hidden="true" />
          </Button>
        </div>

        {stale ? (
          <div className="flex items-start gap-2 rounded-md border border-amber-500/35 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300" role="status">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            <span>当前显示最近一次成功数据，刷新失败：{safeError}</span>
          </div>
        ) : null}
        {outputTruncated ? (
          <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300" role="status" data-server-ops-overview-global-warning>
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            <span>远程输出已截断，部分数据可能不完整</span>
          </div>
        ) : null}

        <section aria-labelledby="server-overview-metrics-heading" data-server-ops-overview-section="metrics">
          <h3 id="server-overview-metrics-heading" className="sr-only">关键指标</h3>
          <div className="grid grid-cols-2 overflow-hidden rounded-md border border-border" data-server-ops-overview-grid>
            {metrics.map((metric, index) => {
              /** 当前指标的语义图标。 */
              const Icon = metric.icon
              return (
                <div
                  key={metric.label}
                  data-server-ops-overview-metric={metric.id}
                  className={cn(
                    'min-h-24 border-border p-3 odd:border-r',
                    index < 2 && 'border-b',
                  )}
                >
                  <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <Icon className="size-3.5" aria-hidden="true" />{metric.label}
                  </div>
                  <div className="mt-2 text-xl font-semibold tracking-normal">{metric.value}</div>
                  <div className="mt-1 truncate text-[11px] text-muted-foreground" title={metric.detail}>{metric.detail}</div>
                  {metric.warning ? <ServerOpsLocalWarning message={`部分指标暂不可用：${metric.warning}`} /> : null}
                </div>
              )
            })}
          </div>
        </section>

        <section aria-labelledby="server-overview-system-heading" data-server-ops-overview-section="system">
          <h3 id="server-overview-system-heading" className="mb-2 text-xs font-medium">系统信息</h3>
          {snapshot.warnings.includes('SYSTEM_PARTIAL') ? <ServerOpsLocalWarning message="系统信息可能不完整" /> : null}
          {snapshot.system ? (
            <dl
              className={cn('grid grid-cols-2 gap-x-6 gap-y-3 rounded-md border border-border px-3 py-3 text-xs', snapshot.warnings.includes('SYSTEM_PARTIAL') && 'mt-2')}
              data-server-ops-overview-system-grid
            >
              <div><dt className="text-[11px] text-muted-foreground">主机名</dt><dd className="mt-1 break-all font-mono">{snapshot.system.hostname}</dd></div>
              <div><dt className="text-[11px] text-muted-foreground">操作系统</dt><dd className="mt-1">{snapshot.system.osName} {snapshot.system.osVersion}</dd></div>
              <div><dt className="text-[11px] text-muted-foreground">内核</dt><dd className="mt-1 break-all font-mono">{snapshot.system.kernel}</dd></div>
              <div><dt className="text-[11px] text-muted-foreground">架构</dt><dd className="mt-1 font-mono">{snapshot.system.arch}</dd></div>
              <div><dt className="text-[11px] text-muted-foreground">运行时间</dt><dd className="mt-1">{formatUptime(snapshot.system.uptimeSeconds)}</dd></div>
              <div><dt className="text-[11px] text-muted-foreground">采样窗口</dt><dd className="mt-1">{snapshot.sampleWindowMs} ms</dd></div>
            </dl>
          ) : <p className="rounded-md border border-dashed border-border px-3 py-5 text-center text-xs text-muted-foreground">系统信息不可用</p>}
        </section>

        <section aria-labelledby="server-overview-resources-heading" data-server-ops-overview-section="resources">
          <h3 id="server-overview-resources-heading" className="mb-2 text-xs font-medium">资源详情</h3>
          <div className="grid grid-cols-1 overflow-hidden rounded-md border border-border" data-server-ops-overview-resource-grid>
            <div className="border-b border-border p-3 text-xs" data-server-ops-overview-resource="memory">
              <div className="mb-2 flex items-center gap-1.5 font-medium"><MemoryStick className="size-3.5 text-muted-foreground" aria-hidden="true" />内存</div>
              {snapshot.warnings.includes('MEMORY_PARTIAL') ? <ServerOpsLocalWarning message="内存数据可能不完整" /> : null}
              {snapshot.memory ? (
                <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-2">
                  <div><dt className="text-[10px] text-muted-foreground">总内存</dt><dd className="mt-0.5 tabular-nums">{formatBytes(snapshot.memory.totalBytes)}</dd></div>
                  <div><dt className="text-[10px] text-muted-foreground">已用内存</dt><dd className="mt-0.5 tabular-nums">{formatBytes(snapshot.memory.usedBytes)}</dd></div>
                  <div><dt className="text-[10px] text-muted-foreground">可用内存</dt><dd className="mt-0.5 tabular-nums">{formatBytes(snapshot.memory.availableBytes)}</dd></div>
                  <div><dt className="text-[10px] text-muted-foreground">缓存</dt><dd className="mt-0.5 tabular-nums">{formatBytes(snapshot.memory.cacheBytes)}</dd></div>
                </dl>
              ) : <p className="mt-2 text-[11px] text-muted-foreground">内存详情不可用</p>}
            </div>
            <div className="border-b border-border p-3 text-xs" data-server-ops-overview-resource="swap">
              <div className="mb-2 flex items-center gap-1.5 font-medium"><HardDrive className="size-3.5 text-muted-foreground" aria-hidden="true" />Swap</div>
              {snapshot.swap ? (
                <dl className="grid grid-cols-2 gap-x-3 gap-y-2">
                  <div><dt className="text-[10px] text-muted-foreground">Swap 总量</dt><dd className="mt-0.5 tabular-nums">{formatBytes(snapshot.swap.totalBytes)}</dd></div>
                  <div><dt className="text-[10px] text-muted-foreground">Swap 已用</dt><dd className="mt-0.5 tabular-nums">{formatBytes(snapshot.swap.usedBytes)}</dd></div>
                </dl>
              ) : <p className="text-[11px] text-muted-foreground">Swap 数据不可用</p>}
            </div>
            <div className="p-3 text-xs" data-server-ops-overview-resource="network">
              <div className="mb-2 flex items-center gap-1.5 font-medium"><Network className="size-3.5 text-muted-foreground" aria-hidden="true" />网络</div>
              {snapshot.warnings.includes('NETWORK_PARTIAL') ? <ServerOpsLocalWarning message="网络数据可能不完整" /> : null}
              {snapshot.network ? (
                <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-2">
                  <div><dt className="text-[10px] text-muted-foreground">接收速率</dt><dd className="mt-0.5 tabular-nums">{formatBytes(snapshot.network.receiveBytesPerSecond)}/s</dd></div>
                  <div><dt className="text-[10px] text-muted-foreground">发送速率</dt><dd className="mt-0.5 tabular-nums">{formatBytes(snapshot.network.transmitBytesPerSecond)}/s</dd></div>
                </dl>
              ) : <p className="mt-2 text-[11px] text-muted-foreground">网络速率不可用</p>}
            </div>
          </div>
        </section>

        <section aria-labelledby="server-overview-filesystem-heading" data-server-ops-overview-section="filesystems">
          <h3 id="server-overview-filesystem-heading" className="mb-2 text-xs font-medium">文件系统</h3>
          {snapshot.warnings.includes('FILESYSTEM_PARTIAL') ? <ServerOpsLocalWarning message="文件系统数据可能不完整" /> : null}
          <div className={cn('overflow-x-auto rounded-md border border-border', snapshot.warnings.includes('FILESYSTEM_PARTIAL') && 'mt-2')}>
            <table className="w-full min-w-[640px] border-collapse text-left text-xs">
              <thead className="bg-muted/35 text-[11px] text-muted-foreground">
                <tr><th className="px-3 py-2 font-medium">设备</th><th className="px-3 py-2 font-medium">挂载点</th><th className="px-3 py-2 font-medium">类型</th><th className="px-3 py-2 text-right font-medium">总容量</th><th className="px-3 py-2 text-right font-medium">已用</th><th className="px-3 py-2 text-right font-medium">可用</th><th className="px-3 py-2 text-right font-medium">占用</th></tr>
              </thead>
              <tbody className="divide-y divide-border">
                {snapshot.filesystems.length > 0 ? snapshot.filesystems.map((filesystem) => (
                  <tr key={`${filesystem.device}:${filesystem.mountPoint}`}>
                    <td className="whitespace-nowrap px-3 py-2 font-mono">{filesystem.device}</td>
                    <td className="whitespace-nowrap px-3 py-2 font-mono">{filesystem.mountPoint}</td>
                    <td className="px-3 py-2 text-muted-foreground">{filesystem.filesystem}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatBytes(filesystem.totalBytes)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatBytes(filesystem.usedBytes)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatBytes(filesystem.availableBytes)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatPercent(filesystem.usagePercent)}</td>
                  </tr>
                )) : <tr><td colSpan={7} className="px-3 py-5 text-center text-muted-foreground">文件系统数据不可用</td></tr>}
              </tbody>
            </table>
          </div>
        </section>

        <section aria-labelledby="server-overview-process-heading" data-server-ops-overview-section="processes">
          <h3 id="server-overview-process-heading" className="mb-2 text-xs font-medium">高资源进程</h3>
          {snapshot.warnings.includes('PROCESS_PARTIAL') ? <ServerOpsLocalWarning message="进程数据可能不完整" /> : null}
          <div className={cn('overflow-x-auto rounded-md border border-border', snapshot.warnings.includes('PROCESS_PARTIAL') && 'mt-2')}>
            <table className="w-full min-w-[460px] border-collapse text-left text-xs">
              <thead className="bg-muted/35 text-[11px] text-muted-foreground">
                <tr><th className="px-3 py-2 font-medium">PID</th><th className="px-3 py-2 font-medium">进程</th><th className="px-3 py-2 text-right font-medium">CPU</th><th className="px-3 py-2 text-right font-medium">内存</th></tr>
              </thead>
              <tbody className="divide-y divide-border">
                {snapshot.processes.length > 0 ? snapshot.processes.map((process) => (
                  <tr key={process.pid}>
                    <td className="px-3 py-2 font-mono tabular-nums">{process.pid}</td>
                    <td className="px-3 py-2 font-mono">{process.name}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatPercent(process.cpuPercent)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatPercent(process.memoryPercent)}</td>
                  </tr>
                )) : <tr><td colSpan={4} className="px-3 py-5 text-center text-muted-foreground">进程数据不可用</td></tr>}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  )
}

/** 自行拥有请求投影与轮询生命周期的服务器概览面板。 */
export function ServerOpsOverviewPanel({ hostId, active, connected }: ServerOpsOverviewPanelProps): React.ReactElement {
  /** 当前面板投影，初始不包含任何伪造数据。 */
  const [projection, setProjection] = React.useState<ServerOpsOverviewProjection>(() => createIdleProjection(hostId))
  /** 单组件生命周期稳定的概览控制器。 */
  const [controller] = React.useState(() => createServerOpsOverviewController({
    getOverview: (input) => window.electronAPI.getServerOpsOverview(input),
    publish: setProjection,
  }))

  React.useEffect(() => {
    controller.activate()
    return () => controller.dispose()
  }, [controller])

  React.useEffect(() => {
    controller.select({ hostId, active, connected })
  }, [active, connected, controller, hostId])

  /** 身份切换后的首个 effect 前不得短暂展示上一主机状态。 */
  const currentProjection = projection.hostId === hostId ? projection : createIdleProjection(hostId, projection.requestRevision)
  return (
    <ServerOpsOverviewPanelView
      status={currentProjection.status}
      snapshot={currentProjection.snapshot}
      stale={currentProjection.stale}
      error={currentProjection.error}
      onRefresh={controller.refresh}
    />
  )
}
