import * as React from 'react'
import { ArrowDown, Download, LoaderCircle, Pause, Play, Search, Trash2 } from 'lucide-react'
import type {
  ServerOpsLogExitEvent,
  ServerOpsLogExportInput,
  ServerOpsLogExportResult,
  ServerOpsLogIdentity,
  ServerOpsLogOutputAck,
  ServerOpsLogOutputEvent,
  ServerOpsLogPriority,
  ServerOpsLogSince,
  ServerOpsLogSource,
  ServerOpsLogStartInput,
  ServerOpsLogStartResult,
} from '@proma/shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'

/** 日志面板由当前主机、可见性和 SSH 连接事实共同驱动。 */
export interface ServerOpsLogsPanelProps {
  hostId: string
  connectionId: string | null
  active: boolean
  connected: boolean
}

/** 本地日志缓冲的固定限制。 */
export interface ServerOpsLogBufferLimits {
  maxLines: number
  maxBytes: number
}

/** 本地日志缓冲对外发布的不可变快照。 */
export interface ServerOpsLogBufferProjection {
  text: string
  lines: string[]
  lineCount: number
  byteLength: number
  truncated: boolean
}

/** 不物化日志字符串即可读取的轻量缓冲统计。 */
export interface ServerOpsLogBufferStats {
  lineCount: number
  byteLength: number
  truncated: boolean
}

/** 可测试的有界日志缓冲。 */
export interface ServerOpsLogBuffer {
  append: (data: string) => void
  clear: () => void
  inspect: () => ServerOpsLogBufferStats
  project: () => ServerOpsLogBufferProjection
}

/** 一行日志使用分段存储，跨 chunk 追加时不会复制其它日志。 */
interface ServerOpsLogLine {
  segments: string[]
  byteLength: number
  complete: boolean
}

/** 创建按 UTF-8 字节与换行边界淘汰的日志 deque。 */
export function createServerOpsLogBuffer(limits: ServerOpsLogBufferLimits): ServerOpsLogBuffer {
  /** UTF-8 字节计算器，避免按 UTF-16 code unit 误判中文。 */
  const encoder = new TextEncoder()
  /** 当前保留的日志行；只从头部淘汰。 */
  const lines: Array<ServerOpsLogLine | undefined> = []
  /** deque 当前头部索引，避免每次淘汰都移动全部行。 */
  let head = 0
  /** 当前缓冲实际 UTF-8 字节数。 */
  let byteLength = 0
  /** 当前缓冲是否曾因任一上限淘汰。 */
  let truncated = false
  /** 超长未结束物理行被淘汰后，持续丢弃其余分段直至换行。 */
  let droppingUntilNewline = false

  /** 超过任一上限时整行淘汰最早日志，保持内存严格有界。 */
  const enforceLimits = (): void => {
    while (lines.length - head > limits.maxLines || byteLength > limits.maxBytes) {
      /** 首行是唯一允许淘汰的元素，避免破坏后续行边界。 */
      const removed = lines[head]
      if (!removed) break
      /** 只有当前唯一未结束物理行自身超限时才进入续块丢弃状态。 */
      const removedCurrentIncompleteLine = head === lines.length - 1 && !removed.complete
      byteLength -= removed.byteLength
      /** 立即释放已淘汰行持有的字符串，再推进逻辑头部。 */
      lines[head] = undefined
      head += 1
      truncated = true
      if (removedCurrentIncompleteLine) droppingUntilNewline = true
    }
    /** 只在已释放槽位占比过半且达到阈值时压缩，保持摊销 O(1) 与有界数组。 */
    if (head >= 1_024 && head * 2 >= lines.length) {
      lines.splice(0, head)
      head = 0
    }
  }

  return {
    append: (data) => {
      if (!data) return
      /** 按换行结束符切片并保留原始 CRLF 内容。 */
      const pieces = data.match(/[^\n]*\n|[^\n]+/g) ?? []
      for (const piece of pieces) {
        if (droppingUntilNewline) {
          /** 包含换行的分段仍属于已淘汰物理行；只恢复接收其后的新行。 */
          if (piece.endsWith('\n')) droppingUntilNewline = false
          continue
        }
        /** 只有上一行未结束时才向同一逻辑行追加分段。 */
        let target = lines.length > head ? lines.at(-1) : undefined
        if (!target || target.complete) {
          target = { segments: [], byteLength: 0, complete: false }
          lines.push(target)
        }
        /** 单个 piece 的字节长度只计算一次。 */
        const pieceBytes = encoder.encode(piece).byteLength
        target.segments.push(piece)
        target.byteLength += pieceBytes
        target.complete = piece.endsWith('\n')
        byteLength += pieceBytes
        enforceLimits()
      }
    },
    clear: () => {
      lines.length = 0
      head = 0
      byteLength = 0
      truncated = false
      droppingUntilNewline = false
    },
    inspect: () => ({ lineCount: lines.length - head, byteLength, truncated }),
    project: () => {
      /** 只在发布 UI 或导出快照时合并分段，接收时不复制完整缓冲。 */
      const visibleLines: string[] = []
      for (let index = head; index < lines.length; index += 1) {
        /** head 之前的槽位已经释放，活跃区间内始终是完整 entry。 */
        const line = lines[index]
        if (line) visibleLines.push(line.segments.join(''))
      }
      return {
        text: visibleLines.join(''),
        lines: visibleLines,
        lineCount: visibleLines.length,
        byteLength,
        truncated,
      }
    },
  }
}

/** 日志面板公开状态，覆盖连接、能力与流终态。 */
export type ServerOpsLogsStatus = 'idle' | 'loading' | 'streaming' | 'stopped' | 'unsupported' | 'permission-denied' | 'error'

/** 远程 journalctl 的受控筛选。 */
export interface ServerOpsLogRemoteFilters {
  source: ServerOpsLogSource
  since: ServerOpsLogSince
  priority: ServerOpsLogPriority
  tailLines: number
}

/** 日志控制器发布给 React 的完整投影。 */
export interface ServerOpsLogsProjection extends ServerOpsLogBufferProjection, ServerOpsLogRemoteFilters {
  hostId: string | null
  streamId: string | null
  requestRevision: number
  status: ServerOpsLogsStatus
  paused: boolean
  query: string
  error: string | null
  warning: string | null
  hasNewLogs: boolean
  atBottom: boolean
  bufferRevision: number
  materializedRevision: number
}

/** 日志控制器当前选择的完整上下文。 */
export interface ServerOpsLogsContext {
  hostId: string
  connectionId?: string | null
  active: boolean
  connected: boolean
}

/** 日志控制器依赖，便于纯测试覆盖所有 IPC 竞态。 */
interface ServerOpsLogsControllerOptions {
  start: (input: ServerOpsLogStartInput) => Promise<ServerOpsLogStartResult>
  stop: (input: ServerOpsLogIdentity) => Promise<void>
  acknowledge: (input: ServerOpsLogOutputAck) => Promise<void>
  exportLogs: (input: ServerOpsLogExportInput) => Promise<ServerOpsLogExportResult>
  publish: (projection: ServerOpsLogsProjection) => void
  notify: (kind: 'success' | 'warning' | 'error' | 'info', message: string) => void
  buffer?: ServerOpsLogBuffer
  scheduleMaterialize?: (callback: () => void) => () => void
}

/** 日志控制器公开操作。 */
export interface ServerOpsLogsController {
  activate: () => void
  select: (context: ServerOpsLogsContext) => Promise<void>
  updateRemoteFilters: (filters: Partial<ServerOpsLogRemoteFilters>) => Promise<void>
  setQuery: (query: string) => void
  setPaused: (paused: boolean) => void
  setAtBottom: (atBottom: boolean) => void
  markAtBottom: () => void
  clear: () => void
  exportCurrent: () => Promise<void>
  handleOutput: (event: ServerOpsLogOutputEvent) => Promise<void>
  handleExit: (event: ServerOpsLogExitEvent) => void
  dispose: () => void
}

/** 在日志正文版本变化后把仍处于跟随状态的视口滚动到底部。 */
export function useServerOpsLogsAutoScroll(
  paused: boolean,
  contentRevision: number,
  viewportRef: React.RefObject<HTMLDivElement | null>,
): void {
  React.useEffect(() => {
    if (paused) return
    const viewport = viewportRef.current
    if (viewport) viewport.scrollTop = viewport.scrollHeight
  }, [contentRevision, paused, viewportRef])
}

/** 派生当前 query 对应的本地可见日志正文。 */
export function useServerOpsVisibleLogText(lines: string[], text: string, query: string): string {
  return React.useMemo(() => {
    /** 本地搜索只过滤已物化行，不改变远程查询。 */
    const normalizedQuery = query.toLocaleLowerCase()
    if (!normalizedQuery) return text
    return lines
      .filter((line) => line.toLocaleLowerCase().includes(normalizedQuery))
      .join('')
  }, [lines, query, text])
}

/** 默认远程筛选只读取最近少量日志，避免首次连接产生无界突发。 */
const DEFAULT_REMOTE_FILTERS: ServerOpsLogRemoteFilters = {
  source: { kind: 'system' },
  since: '15m',
  priority: 'info',
  tailLines: 200,
}

/** 为指定主机构造不携带任何历史日志或筛选的空闲投影。 */
function createIdleServerOpsLogsProjection(hostId: string): ServerOpsLogsProjection {
  return {
    hostId,
    streamId: null,
    requestRevision: 0,
    status: 'idle',
    paused: false,
    query: '',
    error: null,
    warning: null,
    hasNewLogs: false,
    atBottom: true,
    bufferRevision: 0,
    materializedRevision: 0,
    ...DEFAULT_REMOTE_FILTERS,
    text: '',
    lines: [],
    lineCount: 0,
    byteLength: 0,
    truncated: false,
  }
}

/** 按当前主机隔离展示投影，避免 React effect 前短暂泄漏上一主机日志。 */
export function projectServerOpsLogsForHost(
  projection: ServerOpsLogsProjection,
  hostId: string,
): ServerOpsLogsProjection {
  return projection.hostId === hostId ? projection : createIdleServerOpsLogsProjection(hostId)
}

/** Electron 对日志启动 invoke rejection 添加的唯一固定前缀。 */
const SERVER_OPS_LOG_START_ERROR_PREFIX = "Error invoking remote method 'server-ops:start-log-stream': Error: "

/** stop IPC 失败时公开的稳定诊断，不包含底层异常文本。 */
const SERVER_OPS_LOG_STOP_WARNING = '日志流停止失败，请检查 SSH 连接状态'

/** 旧流停止结果不确定时禁止启动替代流，避免形成两个远端日志进程。 */
const SERVER_OPS_LOG_REPLACE_STOP_ERROR = '无法确认旧日志流已停止，已取消启动新日志流'

/** 从裸码或固定 Electron 包装中提取完整稳定错误码。 */
function getLogErrorCode(error: unknown): string {
  /** 任意附加字符都会使精确识别失败，避免从底层文本猜测。 */
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return message.startsWith(SERVER_OPS_LOG_START_ERROR_PREFIX)
    ? message.slice(SERVER_OPS_LOG_START_ERROR_PREFIX.length)
    : message
}

/** 已公开认可的日志启动失败状态。 */
function classifyLogError(error: unknown): Pick<ServerOpsLogsProjection, 'status' | 'error'> {
  /** 只精确识别稳定错误码；未知底层文本一律降级。 */
  const errorCode = getLogErrorCode(error)
  if (errorCode === 'SERVER_OPS_LOG_UNAVAILABLE') return { status: 'unsupported', error: '当前版本不支持实时日志' }
  if (errorCode === 'SERVER_OPS_LOG_PERMISSION_DENIED' || errorCode === 'SERVER_OPS_SYSTEMD_PERMISSION_DENIED') {
    return { status: 'permission-denied', error: '当前 SSH 用户没有读取系统日志的权限' }
  }
  return { status: 'error', error: '实时日志启动失败，请稍后重试' }
}

/** 比较两个日志来源是否精确相同。 */
function isSameLogSource(left: ServerOpsLogSource, right: ServerOpsLogSource): boolean {
  return left.kind === right.kind && (left.kind === 'system' || (right.kind === 'unit' && left.unitId === right.unitId))
}

/** 创建具备精确流身份、ACK 与完整释放语义的日志控制器。 */
export function createServerOpsLogsController(options: ServerOpsLogsControllerOptions): ServerOpsLogsController {
  /** 每个控制器持有独立的有界缓冲。 */
  const buffer = options.buffer ?? createServerOpsLogBuffer({ maxLines: 5_000, maxBytes: 2_097_152 })
  /** React owner 是否处于有效生命周期。 */
  let ownerActive = false
  /** 当前页面上下文。 */
  let context: ServerOpsLogsContext | null = null
  /** 单个流生命周期内绑定连接代次与共享 stop 结果。 */
  interface StreamRecord {
    identity: ServerOpsLogIdentity
    connectionId: string | null
    stopPromise: Promise<boolean> | null
    stopConfirmed: boolean
    stopConfirmation: Promise<void>
    resolveStopConfirmation: () => void
  }
  /** 当前已确认启动的流记录。 */
  let stream: StreamRecord | null = null
  /** 尚未确认停止的旧流；跨请求代次与 StrictMode 重放持续阻断新流。 */
  let unconfirmedStop: StreamRecord | null = null
  /** 最新接纳的 sequence，用于拒绝重复和乱序事件。 */
  let lastSequence = -1
  /** 用户当前是否仍允许自动跟随到底部。 */
  let atBottom = true
  /** 每次启动、失效或筛选变化推进的请求代次。 */
  let requestRevision = 0
  /** 每次缓冲内容变化推进的轻量版本号。 */
  let bufferRevision = 0
  /** 远程受控筛选。 */
  let remoteFilters: ServerOpsLogRemoteFilters = { ...DEFAULT_REMOTE_FILTERS }
  /** 所有 stop/start 共用的串行屏障。 */
  let transitionBarrier = Promise.resolve()
  /** 是否已有一次待执行的 UI 文本物化。 */
  let materializeScheduled = false
  /** 当前待执行物化任务的取消器。 */
  let cancelScheduledMaterialize: (() => void) | null = null
  /** 默认按一帧合并日志文本更新，避免每 chunk 重建 2 MiB 字符串。 */
  const scheduleMaterialize = options.scheduleMaterialize ?? ((callback: () => void) => {
    /** 16ms 帧批次既保持实时感，也为突发 chunk 提供合并窗口。 */
    const timeout = setTimeout(callback, 16)
    return () => clearTimeout(timeout)
  })
  /** 当前投影事实。 */
  let projection: ServerOpsLogsProjection = {
    hostId: null,
    streamId: null,
    requestRevision,
    status: 'idle',
    paused: false,
    query: '',
    error: null,
    warning: null,
    hasNewLogs: false,
    atBottom,
    bufferRevision,
    materializedRevision: bufferRevision,
    ...remoteFilters,
    ...buffer.project(),
  }

  /** 发布轻量状态；仅显式要求时物化完整文本与行数组。 */
  const publish = (patch: Partial<ServerOpsLogsProjection> = {}, materialize = true): void => {
    /** 高频 chunk 只读取 O(1) 统计，保留上一帧已物化文本。 */
    const bufferState = materialize ? buffer.project() : buffer.inspect()
    /** 只有完整正文真正进入投影时才推进物化身份，普通状态发布不得触发重滚。 */
    const materializedRevision = materialize ? bufferRevision : projection.materializedRevision
    projection = {
      ...projection,
      ...remoteFilters,
      ...bufferState,
      ...patch,
      requestRevision,
      atBottom,
      bufferRevision,
      materializedRevision,
    }
    if (ownerActive) options.publish(projection)
  }

  /** 取消尚未执行的 UI 文本批次。 */
  const cancelMaterialize = (): void => {
    if (materializeScheduled) cancelScheduledMaterialize?.()
    materializeScheduled = false
    cancelScheduledMaterialize = null
  }

  /** 把一批轻量 chunk 合并成至多一次完整文本投影。 */
  const queueMaterialize = (): void => {
    if (materializeScheduled) return
    materializeScheduled = true
    cancelScheduledMaterialize = scheduleMaterialize(() => {
      materializeScheduled = false
      cancelScheduledMaterialize = null
      publish({}, true)
    })
  }

  /** 将一个转移操作排到所有既有 stop/start 之后。 */
  const enqueueTransition = (operation: () => Promise<void>): Promise<void> => {
    /** 前序 best-effort 失败不能阻断后续最新目标。 */
    const queued = transitionBarrier.then(operation, operation)
    transitionBarrier = queued.catch(() => undefined)
    return queued
  }

  /** 标记一个旧流已经退出，并唤醒仍在等待 stop IPC 的串行转移。 */
  const confirmRecordStopped = (record: StreamRecord): void => {
    if (record.stopConfirmed) return
    record.stopConfirmed = true
    record.resolveStopConfirmation()
    if (unconfirmedStop === record) unconfirmedStop = null
  }

  /** 单个流记录内共享一次 stop，并返回旧流是否已确认退出。 */
  const stopRecord = async (record: StreamRecord | null): Promise<boolean> => {
    if (!record) return true
    if (record.stopPromise) return record.stopConfirmed ? true : record.stopPromise
    /** 非 detach 路径的迟到 start 结果也必须进入同一停止门禁。 */
    if (!record.stopConfirmed && !unconfirmedStop) unconfirmedStop = record
    record.stopPromise = (async () => {
      try {
        /** exit 或连接换代能够先于无响应的 stop IPC，直接证明旧流已经结束。 */
        const completion = await Promise.race([
          options.stop(record.identity).then(() => 'stopped' as const),
          record.stopConfirmation.then(() => 'confirmed' as const),
        ])
        if (completion === 'stopped') confirmRecordStopped(record)
        return true
      } catch {
        /** 底层消息不可进入 Renderer；诊断保留在投影中供当前或重放 owner 展示。 */
        publish({ warning: SERVER_OPS_LOG_STOP_WARNING }, false)
        return record.stopConfirmed
      }
    })()
    return record.stopPromise
  }

  /** 同步摘除当前流，使迟到事件在异步 stop 前立即 fail closed。 */
  const detachStream = (): StreamRecord | null => {
    /** 在任何异步释放前先摘除身份，使迟到事件立即 fail closed。 */
    const previous = stream
    stream = null
    lastSequence = -1
    if (previous && !previous.stopConfirmed) unconfirmedStop = previous
    return previous
  }

  /** 同主机明确进入新连接代次时，确认旧代次已经销毁并解除门禁。 */
  const confirmStoppedByConnectionChange = (nextContext: ServerOpsLogsContext): void => {
    const blocked = unconfirmedStop
    const nextConnectionId = nextContext.connectionId ?? null
    if (!blocked
      || blocked.identity.hostId !== nextContext.hostId
      || !blocked.connectionId
      || !nextConnectionId
      || blocked.connectionId === nextConnectionId) return
    confirmRecordStopped(blocked)
  }

  /** 当前页面是否仍允许启动或接收远程日志。 */
  const canStream = (): boolean => Boolean(ownerActive && context?.active && context.connected)

  /** 判断转移完成时仍属于同一 host、连接代次和请求代次。 */
  const isCurrentTarget = (target: ServerOpsLogsContext, revision: number): boolean => (
    ownerActive
    && requestRevision === revision
    && context?.hostId === target.hostId
    && (context.connectionId ?? null) === (target.connectionId ?? null)
    && context.active === target.active
    && context.connected === target.connected
  )

  /** 在串行屏障内为一个稳定目标启动日志流。 */
  const startTarget = async (
    target: ServerOpsLogsContext,
    filters: ServerOpsLogRemoteFilters,
    revision: number,
  ): Promise<void> => {
    if (!isCurrentTarget(target, revision) || !target.active || !target.connected) return
    /** 调用 start IPC 前再次检查跨 revision 门禁，避免旧 stop reject 后误启替代流。 */
    if (unconfirmedStop) {
      publish({ streamId: null, status: 'error', error: SERVER_OPS_LOG_REPLACE_STOP_ERROR }, false)
      return
    }
    let result: ServerOpsLogStartResult
    try {
      result = await options.start({ hostId: target.hostId, ...filters })
    } catch (error) {
      if (isCurrentTarget(target, revision)) {
        publish({ ...classifyLogError(error), streamId: null })
      }
      return
    }
    /** start 成功后建立带确认信号的局部记录，使迟到结果与外部终态都能精确收口。 */
    let resolveStopConfirmation: () => void = () => undefined
    /** stop IPC 与精确退出事件共享的确认 Promise。 */
    const stopConfirmation = new Promise<void>((resolve) => { resolveStopConfirmation = resolve })
    const started: StreamRecord = {
      identity: { hostId: result.hostId, streamId: result.streamId },
      connectionId: target.connectionId ?? null,
      stopPromise: null,
      stopConfirmed: false,
      stopConfirmation,
      resolveStopConfirmation,
    }
    /** 任一上下文漂移都必须精确停止迟到结果，禁止短暂发布。 */
    if (!isCurrentTarget(target, revision) || result.hostId !== target.hostId) {
      await stopRecord(started)
      return
    }
    stream = started
    lastSequence = -1
    publish({ hostId: target.hostId, streamId: result.streamId, status: 'streaming', error: null, hasNewLogs: false })
  }

  return {
    activate: () => {
      ownerActive = true
      publish()
    },
    select: async (nextContext) => {
      /** 保存旧上下文，用于区分用户重新进入与同页自动重连。 */
      const previous = context
      const hostChanged = Boolean(previous && previous.hostId !== nextContext.hostId)
      const connectionChanged = Boolean(previous
        && (previous.connectionId ?? null) !== (nextContext.connectionId ?? null))
      const leftPage = Boolean(previous?.active && !nextContext.active)
      const disconnected = Boolean(previous?.connected && !nextContext.connected)
      const enteredPage = Boolean(nextContext.active && (!previous || !previous.active))
      const contextChanged = !previous
        || hostChanged
        || connectionChanged
        || previous.active !== nextContext.active
        || previous.connected !== nextContext.connected
      if (!contextChanged) return
      /** 切换主机时恢复旧 remount 的默认筛选，避免把 host-specific unit 带到新主机。 */
      if (hostChanged) remoteFilters = { ...DEFAULT_REMOTE_FILTERS }
      context = { ...nextContext, connectionId: nextContext.connectionId ?? null }
      const revision = ++requestRevision
      /** 任一远程身份或可见性变化都先同步摘除旧流。 */
      const previousStream = hostChanged || connectionChanged || leftPage || disconnected || !nextContext.active || !nextContext.connected
        ? detachStream()
        : null
      /** 直接对比门禁保存的代次，兼容 dispose 已清空 previous context 的 StrictMode 重放。 */
      confirmStoppedByConnectionChange(nextContext)
      if (hostChanged || connectionChanged || leftPage || disconnected || !nextContext.active || !nextContext.connected) {
        cancelMaterialize()
        buffer.clear()
        bufferRevision += 1
        atBottom = true
        publish({
          hostId: nextContext.hostId,
          streamId: null,
          status: 'idle',
          error: null,
          ...(hostChanged ? { paused: false, query: '', warning: null } : {}),
          hasNewLogs: false,
        })
      }
      /** 连接代次自身变化只失效，不自动重连；初次进入、重进或切 host 才能启动。 */
      const shouldStart = ownerActive && nextContext.active && nextContext.connected && (enteredPage || hostChanged)
      if (shouldStart) publish({ hostId: nextContext.hostId, streamId: null, status: 'loading', error: null })
      /** 没有流需要停止且目标不允许启动时，无需等待前序尚未返回的 start。 */
      if (!previousStream && !shouldStart) return
      await enqueueTransition(async () => {
        /** 旧流停止失败时禁止启动替代流，确保每个 owner 最多一个远端流。 */
        const stopped = await stopRecord(previousStream)
        if (!stopped) {
          if (shouldStart && isCurrentTarget(nextContext, revision)) {
            publish({ streamId: null, status: 'error', error: SERVER_OPS_LOG_REPLACE_STOP_ERROR }, false)
          }
          return
        }
        if (!shouldStart || !isCurrentTarget(nextContext, revision)) return
        await startTarget(nextContext, { ...remoteFilters }, revision)
      })
    },
    updateRemoteFilters: async (filters) => {
      /** 构造下一份完整远程筛选并跳过无变化更新。 */
      const nextFilters = { ...remoteFilters, ...filters }
      const changed = !isSameLogSource(remoteFilters.source, nextFilters.source)
        || remoteFilters.since !== nextFilters.since
        || remoteFilters.priority !== nextFilters.priority
        || remoteFilters.tailLines !== nextFilters.tailLines
      if (!changed) return
      remoteFilters = nextFilters
      const revision = ++requestRevision
      const target = context ? { ...context } : null
      const previousStream = detachStream()
      cancelMaterialize()
      buffer.clear()
      bufferRevision += 1
      atBottom = true
      publish({ streamId: null, status: canStream() ? 'loading' : 'idle', error: null, hasNewLogs: false })
      await enqueueTransition(async () => {
        /** 筛选替换同样以旧流已确认停止为启动前提。 */
        const stopped = await stopRecord(previousStream)
        if (!stopped) {
          if (target && isCurrentTarget(target, revision)) {
            publish({ streamId: null, status: 'error', error: SERVER_OPS_LOG_REPLACE_STOP_ERROR }, false)
          }
          return
        }
        if (!target || !isCurrentTarget(target, revision) || !target.active || !target.connected) return
        await startTarget(target, { ...nextFilters }, revision)
      })
    },
    setQuery: (query) => {
      publish({ query }, false)
    },
    setPaused: (paused) => {
      publish({ paused, hasNewLogs: !paused && atBottom ? false : projection.hasNewLogs }, false)
    },
    setAtBottom: (nextAtBottom) => {
      /** 相同滚动事实且没有待清理提示时跳过高频 scroll 重复发布。 */
      if (atBottom === nextAtBottom && (!nextAtBottom || !projection.hasNewLogs)) return
      atBottom = nextAtBottom
      publish({ hasNewLogs: nextAtBottom ? false : projection.hasNewLogs }, false)
    },
    markAtBottom: () => {
      /** 返回底部统一更新控制器事实，并清理新日志提示。 */
      if (atBottom && !projection.hasNewLogs) return
      atBottom = true
      publish({ hasNewLogs: false }, false)
    },
    clear: () => {
      buffer.clear()
      bufferRevision += 1
      atBottom = true
      cancelMaterialize()
      publish({ hasNewLogs: false })
    },
    exportCurrent: async () => {
      /** 导出固定取当前有界缓冲，不受本地搜索影响。 */
      const hostId = context?.hostId
      if (!hostId) {
        options.notify('error', '当前没有可导出的服务器日志')
        return
      }
      /** 调用前生成一次不可变导出快照。 */
      const content = buffer.project().text
      try {
        const result = await options.exportLogs({ hostId, content })
        options.notify(result.saved ? 'success' : 'info', result.saved ? '日志已导出' : '已取消导出')
      } catch {
        options.notify('error', '日志导出失败，请稍后重试')
      }
    },
    handleOutput: async (event) => {
      /** host、stream 和严格递增 sequence 任一不匹配都拒绝写入与 ACK。 */
      const current = stream
      if (!ownerActive || !canStream() || !current || event.hostId !== current.identity.hostId || event.streamId !== current.identity.streamId) return
      /** 首包必须为 0，后续只能严格加一；gap 立即停止以免展示缺失历史。 */
      if (event.sequence !== lastSequence + 1) {
        detachStream()
        requestRevision += 1
        cancelMaterialize()
        publish({ streamId: null, status: 'error', error: '日志序列不连续，实时流已停止' })
        await enqueueTransition(async () => { await stopRecord(current) })
        return
      }
      lastSequence = event.sequence
      buffer.append(event.data)
      bufferRevision += 1
      publish({ status: 'streaming', hasNewLogs: projection.paused || !atBottom || projection.hasNewLogs }, false)
      queueMaterialize()
      /** ACK 必须发生在缓冲写入和 UI 发布之后。 */
      try {
        await options.acknowledge({ ...current.identity, sequence: event.sequence })
      } catch {
        /** 迟到 ACK 失败无权污染已经切换的新流。 */
        if (stream !== current) return
        detachStream()
        requestRevision += 1
        cancelMaterialize()
        publish({ streamId: null, status: 'error', error: '日志确认失败，实时流已停止' })
        await enqueueTransition(async () => { await stopRecord(current) })
      }
    },
    handleExit: (event) => {
      /** 被门禁阻断的旧流若发出精确终态，即可确认释放但不污染当前投影。 */
      const blocked = unconfirmedStop
      if (blocked && event.hostId === blocked.identity.hostId && event.streamId === blocked.identity.streamId) {
        confirmRecordStopped(blocked)
      }
      /** 只接受当前精确身份的终态。 */
      if (!stream || event.hostId !== stream.identity.hostId || event.streamId !== stream.identity.streamId) return
      stream = null
      lastSequence = -1
      requestRevision += 1
      cancelMaterialize()
      if (event.reason === 'error') {
        const classified = classifyLogError(event.errorCode ?? '')
        publish({ streamId: null, ...classified })
        return
      }
      publish({
        streamId: null,
        status: event.reason === 'connection-closed' ? 'error' : 'stopped',
        error: event.reason === 'connection-closed' ? 'SSH 连接已断开' : null,
      })
    },
    dispose: () => {
      ownerActive = false
      requestRevision += 1
      const previousStream = detachStream()
      context = null
      cancelMaterialize()
      buffer.clear()
      bufferRevision += 1
      atBottom = true
      /** 即使不再向 React 发布，也要清理 StrictMode 复用实例的内部投影。 */
      publish({ hostId: null, streamId: null, status: 'idle', error: null, hasNewLogs: false })
      void enqueueTransition(async () => { await stopRecord(previousStream) })
    },
  }
}

/** 日志面板纯展示层属性。 */
export interface ServerOpsLogsPanelViewProps extends Omit<ServerOpsLogsProjection, 'hostId' | 'streamId' | 'requestRevision'> {
  connected?: boolean
  onSourceChange: (source: ServerOpsLogSource) => void
  onUnitIdChange: (unitId: string) => void
  onSinceChange: (since: ServerOpsLogSince) => void
  onPriorityChange: (priority: ServerOpsLogPriority) => void
  onQueryChange: (query: string) => void
  onTogglePaused: () => void
  onClear: () => void
  onExport: () => void
  onReturnToBottom: () => void
  onScroll?: React.UIEventHandler<HTMLDivElement>
  viewportRef?: React.Ref<HTMLDivElement>
}

/** 渲染紧凑、可搜索且文本可选的实时日志工作台。 */
export function ServerOpsLogsPanelView({
  status,
  connected = false,
  text,
  lines,
  lineCount,
  byteLength,
  truncated,
  paused,
  query,
  source,
  since,
  priority,
  tailLines,
  error,
  warning,
  hasNewLogs,
  onSourceChange,
  onUnitIdChange,
  onSinceChange,
  onPriorityChange,
  onQueryChange,
  onTogglePaused,
  onClear,
  onExport,
  onReturnToBottom,
  onScroll,
  viewportRef,
}: ServerOpsLogsPanelViewProps): React.ReactElement {
  /** 搜索派生由独立 Hook 管理，避免展示组件混入正文计算细节。 */
  const visibleText = useServerOpsVisibleLogText(lines, text, query)
  /** 低频流状态单独进入 polite live region，避免高频统计持续播报。 */
  const statusLabel = status === 'loading' ? '正在启动日志流'
    : status === 'streaming' ? (paused ? '实时接收 · 已暂停自动滚动' : '实时接收')
      : status === 'stopped' ? '日志流已结束'
        : status === 'unsupported' ? '当前环境不支持 journalctl'
          : status === 'permission-denied' ? '无日志读取权限'
            : status === 'error' ? '日志流异常'
              : connected ? '日志流未启动' : '等待 SSH 连接'
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-content-area">
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border px-2 py-2">
        <Select value={source.kind} onValueChange={(value) => onSourceChange(value === 'unit' ? { kind: 'unit', unitId: source.kind === 'unit' ? source.unitId : 'ssh.service' } : { kind: 'system' })}>
          <SelectTrigger className="h-8 w-28 text-xs" aria-label="日志来源"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="system">系统日志</SelectItem><SelectItem value="unit">指定服务</SelectItem></SelectContent>
        </Select>
        {source.kind === 'unit' && (
          <Input
            defaultValue={source.unitId}
            className="h-8 min-w-32 flex-1 text-xs"
            aria-label="systemd 服务单元"
            onBlur={(event) => onUnitIdChange(event.target.value)}
          />
        )}
        <Select value={since} onValueChange={(value) => onSinceChange(value as ServerOpsLogSince)}>
          <SelectTrigger className="h-8 w-24 text-xs" aria-label="日志时间范围"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="15m">15 分钟</SelectItem><SelectItem value="1h">1 小时</SelectItem><SelectItem value="6h">6 小时</SelectItem>
            <SelectItem value="24h">24 小时</SelectItem><SelectItem value="boot">本次启动</SelectItem>
          </SelectContent>
        </Select>
        <Select value={priority} onValueChange={(value) => onPriorityChange(value as ServerOpsLogPriority)}>
          <SelectTrigger className="h-8 w-24 text-xs" aria-label="日志优先级"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="emerg">系统不可用</SelectItem><SelectItem value="alert">立即处理</SelectItem>
            <SelectItem value="crit">严重</SelectItem><SelectItem value="err">错误</SelectItem>
            <SelectItem value="warning">警告</SelectItem><SelectItem value="notice">通知</SelectItem>
            <SelectItem value="info">信息</SelectItem><SelectItem value="debug">调试</SelectItem>
          </SelectContent>
        </Select>
        <div className="relative min-w-36 flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input value={query} onChange={(event) => onQueryChange(event.target.value)} className="h-8 pl-7 text-xs" aria-label="搜索已接收日志" placeholder="搜索日志" />
        </div>
        <TooltipProvider delayDuration={200}>
          <div className="flex shrink-0 items-center gap-0.5">
            <Tooltip><TooltipTrigger asChild><Button type="button" variant="ghost" size="icon-sm" className="size-8" aria-label={paused ? '继续自动滚动' : '暂停自动滚动'} onClick={onTogglePaused}>{paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}</Button></TooltipTrigger><TooltipContent>{paused ? '继续自动滚动' : '暂停自动滚动'}</TooltipContent></Tooltip>
            <Tooltip><TooltipTrigger asChild><Button type="button" variant="ghost" size="icon-sm" className="size-8" aria-label="清空本地日志" onClick={onClear}><Trash2 className="size-3.5" /></Button></TooltipTrigger><TooltipContent>清空本地日志</TooltipContent></Tooltip>
            <Tooltip><TooltipTrigger asChild><Button type="button" variant="ghost" size="icon-sm" className="size-8" aria-label="导出当前日志" onClick={onExport}><Download className="size-3.5" /></Button></TooltipTrigger><TooltipContent>导出当前日志</TooltipContent></Tooltip>
          </div>
        </TooltipProvider>
      </div>
      <div className="flex h-7 shrink-0 items-center gap-2 border-b border-border px-3 text-[10px] text-muted-foreground">
        <span role="status" aria-live="polite" aria-atomic="true">{statusLabel}</span>
        <span className="ml-auto tabular-nums">{lineCount} 行 · {Math.ceil(byteLength / 1024)} KiB · tail {tailLines}</span>
      </div>
      {truncated && <div className="shrink-0 border-b border-border bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-700 dark:text-amber-300">日志已达到本地缓冲上限，较早内容已淘汰</div>}
      {warning && <div className="shrink-0 border-b border-border bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-700 dark:text-amber-300">{warning}</div>}
      {error && <div className="shrink-0 border-b border-border bg-destructive/10 px-3 py-1.5 text-[11px] text-destructive">{error}</div>}
      <div className="relative min-h-0 flex-1">
        <div ref={viewportRef} onScroll={onScroll} className="absolute inset-0 overflow-auto bg-muted/15 p-3 font-mono text-[11px] leading-5 text-foreground select-text" tabIndex={0} aria-label="实时日志正文">
          {status === 'loading' && lineCount === 0 ? <div className="flex h-full items-center justify-center gap-2 text-muted-foreground"><LoaderCircle className="size-3.5 animate-spin" />正在建立日志流...</div>
            : visibleText ? <pre className="min-w-max whitespace-pre-wrap break-words font-inherit">{visibleText}</pre>
              : <div className="flex h-full items-center justify-center text-xs text-muted-foreground">{query && lineCount > 0 ? '没有匹配的日志' : '暂无日志'}</div>}
        </div>
        {hasNewLogs && (
          <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button type="button" size="sm" className="absolute bottom-3 left-1/2 h-7 -translate-x-1/2 gap-1.5 px-2.5 text-[11px] shadow-sm" aria-label="有新日志，返回底部" onClick={onReturnToBottom}>
                  <ArrowDown className="size-3.5" />有新日志
                </Button>
              </TooltipTrigger>
              <TooltipContent>返回日志底部</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
      </div>
    </div>
  )
}

/** 绑定 React 生命周期、滚动意图与现有 Electron 日志 IPC。 */
export function ServerOpsLogsPanel({ hostId, connectionId, active, connected }: ServerOpsLogsPanelProps): React.ReactElement {
  /** 当前日志控制器投影。 */
  const [projection, setProjection] = React.useState<ServerOpsLogsProjection>(() => createIdleServerOpsLogsProjection(hostId))
  /** Renderer 提交阶段先校验主机身份，passive effect 尚未清空时也不显示旧日志。 */
  const visibleProjection = projectServerOpsLogsForHost(projection, hostId)
  /** 在当前主机的系统日志与服务日志间保留最近一次有效 unit。 */
  const [unitId, setUnitId] = React.useState('ssh.service')
  React.useEffect(() => {
    /** 主机切换显式恢复旧 remount 的 unit 草稿，禁止复用上一台主机的服务名。 */
    setUnitId('ssh.service')
  }, [hostId])
  /** 日志滚动视口。 */
  const viewportRef = React.useRef<HTMLDivElement>(null)
  /** StrictMode 重放期间复用同一个控制器实例。 */
  const [controller] = React.useState(() => createServerOpsLogsController({
    start: (input) => window.electronAPI.startServerOpsLogStream(input),
    stop: (input) => window.electronAPI.stopServerOpsLogStream(input),
    acknowledge: (input) => window.electronAPI.acknowledgeServerOpsLogOutput(input),
    exportLogs: (input) => window.electronAPI.exportServerOpsLogs(input),
    publish: setProjection,
    notify: (kind, message) => {
      if (kind === 'success') toast.success(message)
      else if (kind === 'warning') toast.warning(message)
      else if (kind === 'info') toast.info(message)
      else toast.error(message)
    },
  }))

  React.useEffect(() => {
    controller.activate()
    /** 两个全局事件订阅只绑定当前组件生命周期一次。 */
    const disposeOutput = window.electronAPI.onServerOpsLogOutput((event) => { void controller.handleOutput(event) })
    const disposeExit = window.electronAPI.onServerOpsLogExit((event) => controller.handleExit(event))
    return () => {
      disposeOutput()
      disposeExit()
      controller.dispose()
    }
  }, [controller])

  React.useEffect(() => {
    void controller.select({ hostId, connectionId, active, connected })
  }, [active, connected, connectionId, controller, hostId])

  /** 暂停或主动离开底部时不得抢夺用户滚动位置。 */
  useServerOpsLogsAutoScroll(
    visibleProjection.paused || !visibleProjection.atBottom,
    visibleProjection.materializedRevision,
    viewportRef,
  )

  /** 返回底部并恢复当前一轮自动跟随意图。 */
  const handleReturnToBottom = (): void => {
    const viewport = viewportRef.current
    if (viewport) viewport.scrollTop = viewport.scrollHeight
    controller.markAtBottom()
  }

  return (
    <ServerOpsLogsPanelView
      {...visibleProjection}
      connected={connected}
      viewportRef={viewportRef}
      onScroll={(event) => {
        /** 4px 容差避免亚像素滚动导致底部状态抖动。 */
        const atBottom = event.currentTarget.scrollHeight - event.currentTarget.scrollTop - event.currentTarget.clientHeight <= 4
        controller.setAtBottom(atBottom)
      }}
      onSourceChange={(source) => {
        /** 从系统日志切回服务日志时恢复本组件最近一次有效 unit。 */
        void controller.updateRemoteFilters({ source: source.kind === 'unit' ? { kind: 'unit', unitId } : source })
      }}
      onUnitIdChange={(nextUnitId) => {
        /** 空 unit 不发送无效远程请求，保留当前有效来源。 */
        const normalized = nextUnitId.trim()
        if (!normalized) return
        setUnitId(normalized)
        void controller.updateRemoteFilters({ source: { kind: 'unit', unitId: normalized } })
      }}
      onSinceChange={(since) => { void controller.updateRemoteFilters({ since }) }}
      onPriorityChange={(priority) => { void controller.updateRemoteFilters({ priority }) }}
      onQueryChange={(query) => controller.setQuery(query)}
      onTogglePaused={() => controller.setPaused(!visibleProjection.paused)}
      onClear={() => controller.clear()}
      onExport={() => { void controller.exportCurrent() }}
      onReturnToBottom={handleReturnToBottom}
    />
  )
}
