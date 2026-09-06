import {
  SERVER_OPS_IPC_CHANNELS,
  parseServerOpsLogExitEvent,
  parseServerOpsLogExportInput,
  parseServerOpsLogExportResult,
  parseServerOpsLogIdentity,
  parseServerOpsLogOutputAck,
  parseServerOpsLogOutputEvent,
  parseServerOpsLogStartInput,
  parseServerOpsLogStartResult,
  parseServerOpsOverviewInput,
  parseServerOpsOverviewResult,
  parseServerOpsServiceActionInput,
  parseServerOpsServiceActionResult,
  parseServerOpsServiceDetailInput,
  parseServerOpsServiceDetailResult,
  parseServerOpsServiceListInput,
  parseServerOpsServiceListResult,
} from '@proma/shared'
import type {
  ServerOpsLogExitEvent,
  ServerOpsLogExportInput,
  ServerOpsLogExportResult,
  ServerOpsLogIdentity,
  ServerOpsLogOutputAck,
  ServerOpsLogOutputEvent,
  ServerOpsLogStartInput,
  ServerOpsLogStartResult,
  ServerOpsOverviewInput,
  ServerOpsOverviewResult,
  ServerOpsServiceActionInput,
  ServerOpsServiceActionResult,
  ServerOpsServiceDetailInput,
  ServerOpsServiceDetailResult,
  ServerOpsServiceListInput,
  ServerOpsServiceListResult,
} from '@proma/shared'

/** 观测 preload 调用主进程所需的最小接口。 */
export type ServerOpsObservabilityInvoke = (channel: string, input: unknown) => Promise<unknown>

/** 观测 preload 订阅 Electron 事件所需的最小接口。 */
export interface ServerOpsObservabilityEvents {
  on(channel: string, listener: (event: unknown, payload: unknown) => void): void
  removeListener(channel: string, listener: (event: unknown, payload: unknown) => void): void
}

/** 严格调用服务器概览。 */
export async function invokeServerOpsOverview(invoke: ServerOpsObservabilityInvoke, input: ServerOpsOverviewInput): Promise<ServerOpsOverviewResult> {
  return parseServerOpsOverviewResult(await invoke(SERVER_OPS_IPC_CHANNELS.GET_OVERVIEW, parseServerOpsOverviewInput(input)))
}

/** 严格调用 systemd 服务列表。 */
export async function invokeServerOpsServiceList(invoke: ServerOpsObservabilityInvoke, input: ServerOpsServiceListInput): Promise<ServerOpsServiceListResult> {
  return parseServerOpsServiceListResult(await invoke(SERVER_OPS_IPC_CHANNELS.LIST_SERVICES, parseServerOpsServiceListInput(input)))
}

/** 严格调用 systemd 服务详情。 */
export async function invokeServerOpsServiceDetail(invoke: ServerOpsObservabilityInvoke, input: ServerOpsServiceDetailInput): Promise<ServerOpsServiceDetailResult> {
  return parseServerOpsServiceDetailResult(await invoke(SERVER_OPS_IPC_CHANNELS.GET_SERVICE_DETAIL, parseServerOpsServiceDetailInput(input)))
}

/** 严格调用一次用户确认的 systemd 动作。 */
export async function invokeServerOpsServiceAction(invoke: ServerOpsObservabilityInvoke, input: ServerOpsServiceActionInput): Promise<ServerOpsServiceActionResult> {
  return parseServerOpsServiceActionResult(await invoke(SERVER_OPS_IPC_CHANNELS.RUN_SERVICE_ACTION, parseServerOpsServiceActionInput(input)))
}

/** 严格启动当前窗口的日志流。 */
export async function invokeServerOpsLogStart(invoke: ServerOpsObservabilityInvoke, input: ServerOpsLogStartInput): Promise<ServerOpsLogStartResult> {
  return parseServerOpsLogStartResult(await invoke(SERVER_OPS_IPC_CHANNELS.START_LOG_STREAM, parseServerOpsLogStartInput(input)))
}

/** 严格停止当前窗口拥有的日志流。 */
export async function invokeServerOpsLogStop(invoke: ServerOpsObservabilityInvoke, input: ServerOpsLogIdentity): Promise<void> {
  const result = await invoke(SERVER_OPS_IPC_CHANNELS.STOP_LOG_STREAM, parseServerOpsLogIdentity(input))
  if (result !== undefined) throw new Error('SERVER_OPS_LOG_STOP_RESULT_INVALID')
}

/** 严格确认当前窗口已消费的日志批次。 */
export async function invokeServerOpsLogAck(invoke: ServerOpsObservabilityInvoke, input: ServerOpsLogOutputAck): Promise<void> {
  const result = await invoke(SERVER_OPS_IPC_CHANNELS.ACK_LOG_OUTPUT, parseServerOpsLogOutputAck(input))
  if (result !== undefined) throw new Error('SERVER_OPS_LOG_ACK_RESULT_INVALID')
}

/** 严格调用用户选择路径的日志导出。 */
export async function invokeServerOpsLogExport(invoke: ServerOpsObservabilityInvoke, input: ServerOpsLogExportInput): Promise<ServerOpsLogExportResult> {
  return parseServerOpsLogExportResult(await invoke(SERVER_OPS_IPC_CHANNELS.EXPORT_LOG, parseServerOpsLogExportInput(input)))
}

/** 订阅并严格重建日志输出事件。 */
export function subscribeServerOpsLogOutput(events: ServerOpsObservabilityEvents, callback: (event: ServerOpsLogOutputEvent) => void): () => void {
  return subscribe(events, SERVER_OPS_IPC_CHANNELS.LOG_OUTPUT, parseServerOpsLogOutputEvent, callback)
}

/** 订阅并严格重建日志终态事件。 */
export function subscribeServerOpsLogExit(events: ServerOpsObservabilityEvents, callback: (event: ServerOpsLogExitEvent) => void): () => void {
  return subscribe(events, SERVER_OPS_IPC_CHANNELS.LOG_EXIT, parseServerOpsLogExitEvent, callback)
}

/** 使用同一包装 listener 注册和精确清理，并隔离污染事件与 Renderer 回调异常。 */
function subscribe<T>(
  events: ServerOpsObservabilityEvents,
  channel: string,
  parse: (payload: unknown) => T,
  callback: (event: T) => void,
): () => void {
  /** Electron 事件包装器只在本次订阅内创建一次。 */
  const listener = (_event: unknown, payload: unknown): void => {
    /** parser 与 callback 任一失败都只丢弃本次事件，不能击穿 Electron EventEmitter。 */
    try { callback(parse(payload)) } catch { /* 一个异常 listener 不能阻断同通道其它订阅。 */ }
  }
  events.on(channel, listener)
  /** 防止重复 disposer 对后续同引用注册造成误清理。 */
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    events.removeListener(channel, listener)
  }
}
