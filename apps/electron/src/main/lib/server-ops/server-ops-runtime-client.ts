import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { MessagePortMain } from 'electron'
import type { ServerOpsTerminalExitEvent, ServerOpsTerminalOutputAck, ServerOpsTerminalOutputEvent } from '@proma/shared'
import {
  parseServerOpsRuntimeMessage,
  type ServerOpsRuntimeConnectRequest,
  type ServerOpsRuntimeConnectResult,
  type ServerOpsRuntimeExecResult,
  type ServerOpsRuntimeLogExitReason,
  type ServerOpsRuntimeMessage,
  type ServerOpsRuntimeRequest,
} from '../../../utility/server-ops/server-ops-runtime-protocol'

/** 主进程 MessagePort 使用的最小接口。 */
export interface ServerOpsRuntimePort {
  close(): void
  start(): void
  postMessage(message: ServerOpsRuntimeRequest): void
  on(event: 'message', listener: (event: { data: unknown }) => void): void
}

/** utility process 暴露给客户端的最小可测试生命周期边界。 */
export interface ServerOpsRuntimeProcess {
  kill(): boolean
  postMessage(message: unknown, transfer?: readonly unknown[]): void
  on(event: 'error' | 'exit', listener: () => void): void
}

/** runtime MessageChannel 的两个端点。 */
export interface ServerOpsRuntimeChannel {
  port1: unknown
  port2: ServerOpsRuntimePort
}

/** runtime client 的进程、端口和 ID 依赖。 */
export interface ServerOpsRuntimeClientDependencies {
  createProcess: (entryPath: string) => ServerOpsRuntimeProcess
  createChannel: () => ServerOpsRuntimeChannel
  uuid: () => string
  /** 日志启动确认的等待上限，仅测试或特殊运行环境覆盖。 */
  logStartTimeoutMs?: number
  /** 单个 runtime 代次允许保留的日志流墓碑数量。 */
  maxUsedLogStreamIds?: number
}

/** Facade 提交的连接输入，requestId 由 client 内部生成。 */
export type ServerOpsRuntimeConnectionInput = Omit<ServerOpsRuntimeConnectRequest, 'requestId'>

/** 单个待完成连接请求。 */
interface PendingConnect {
  hostId: string
  connectionId: string
  resolve: (result: ServerOpsRuntimeConnectResult) => void
  reject: (error: ServerOpsRuntimeError) => void
  timeout: ReturnType<typeof setTimeout>
}
interface PendingExec {
  hostId: string
  connectionId: string
  resolve: (result: ServerOpsRuntimeExecResult) => void
  reject: (error: ServerOpsRuntimeError) => void
  timeout: ReturnType<typeof setTimeout>
}

/** 尚未收到 utility started 确认的日志启动。 */
interface PendingLogStart {
  hostId: string
  connectionId: string
  streamId: string
  resolve: () => void
  reject: (error: ServerOpsRuntimeError) => void
  timeout: ReturnType<typeof setTimeout>
}

/** 已由 utility 确认启动的日志流身份。 */
export interface ServerOpsRuntimeLogIdentity {
  hostId: string
  connectionId: string
  streamId: string
}

/** runtime 日志输出事件，连接 ID 只在 main 内部流转。 */
export interface ServerOpsRuntimeLogOutputEvent extends ServerOpsRuntimeLogIdentity {
  sequence: number
  data: string
}

/** runtime 日志退出事件，连接 ID 不进入公开 DTO。 */
export interface ServerOpsRuntimeLogExitEvent extends ServerOpsRuntimeLogIdentity {
  reason: ServerOpsRuntimeLogExitReason
  errorCode?: string
}

/** 带稳定公开错误码的 runtime 异常。 */
export class ServerOpsRuntimeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'ServerOpsRuntimeError'
  }
}

/** runtime 启动超时。 */
const STARTUP_TIMEOUT_MS = 10_000
/** SSH 握手与 PTY 创建的总请求超时。 */
const CONNECT_TIMEOUT_MS = 25_000
/** utility 确认日志流启动的默认等待上限。 */
const LOG_START_TIMEOUT_MS = 10_000
/** 单个 runtime 代次保留的日志流墓碑上限。 */
const MAX_USED_LOG_STREAM_IDS = 65_536
/** 可配置日志启动超时的安全上限。 */
const MAX_LOG_START_TIMEOUT_MS = 120_000
/** 可配置墓碑容量的安全上限。 */
const MAX_LOG_STREAM_TOMBSTONES = 1_000_000

/** 生产环境按需加载 Electron，避免纯 Bun 单元测试导入原生运行时。 */
const DEFAULT_RUNTIME_CLIENT_DEPENDENCIES: ServerOpsRuntimeClientDependencies = {
  createProcess: (entryPath) => {
    /** Electron 仅在真正启动 SSH runtime 时加载。 */
    const { utilityProcess } = require('electron') as typeof import('electron')
    /** 将 Electron 事件签名收窄为客户端实际使用的两个事件。 */
    const child = utilityProcess.fork(entryPath, [], { serviceName: 'Proma Server Ops Runtime' })
    return {
      kill: () => child.kill(),
      postMessage: (message, transfer) => {
        child.postMessage(message, transfer as MessagePortMain[] | undefined)
      },
      on: (event, listener) => {
        if (event === 'error') child.on('error', listener)
        else child.on('exit', listener)
      },
    }
  },
  createChannel: () => {
    /** MessageChannel 与 utility process 保持一对一。 */
    const { MessageChannelMain } = require('electron') as typeof import('electron')
    const channel = new MessageChannelMain()
    return {
      port1: channel.port1,
      port2: channel.port2 as unknown as ServerOpsRuntimePort,
    }
  },
  uuid: randomUUID,
}

/** 管理独立 SSH utility process、连接请求与远程 PTY 事件。 */
export class ServerOpsRuntimeClient {
  /** 可替换的 runtime 基础设施，仅测试使用内存实现。 */
  private readonly dependencies: ServerOpsRuntimeClientDependencies
  /** utility 日志启动确认超时。 */
  private readonly logStartTimeoutMs: number
  /** 当前 runtime 代次允许使用的日志流 ID 数量。 */
  private readonly maxUsedLogStreamIds: number
  /** 当前 SSH utility process。 */
  private runtimeProcess: ServerOpsRuntimeProcess | undefined
  /** 当前专用 MessagePort。 */
  private port: ServerOpsRuntimePort | undefined
  /** 并发启动时复用的单飞 Promise。 */
  private starting: Promise<void> | undefined
  /** runtime 正常停止期间忽略预期 exit。 */
  private stopping = false
  /** 每次启动或失效都会递增，用于隔离旧进程和旧端口回调。 */
  private runtimeEpoch = 0
  /** requestId 对应的连接请求。 */
  private readonly pendingConnects = new Map<string, PendingConnect>()
  private readonly pendingExecs = new Map<string, PendingExec>()
  /** streamId 全局唯一，避免迟到 started 接管同 ID 新代流。 */
  private readonly pendingLogStarts = new Map<string, PendingLogStart>()
  /** 已确认启动的日志流。 */
  private readonly activeLogStreams = new Map<string, ServerOpsRuntimeLogIdentity>()
  /** 本 client 生命周期内已使用的 ID，阻止迟到 started 接管同 ID 新请求。 */
  private readonly usedLogStreamIds = new Set<string>()
  /** 当前已连接的 connectionId 到 hostId。 */
  private readonly activeConnections = new Map<string, string>()
  /** 远程输出订阅者。 */
  private readonly outputListeners = new Set<(event: ServerOpsTerminalOutputEvent) => void>()
  /** 远程退出订阅者。 */
  private readonly exitListeners = new Set<(event: ServerOpsTerminalExitEvent) => void>()
  /** 日志输出订阅者。 */
  private readonly logOutputListeners = new Set<(event: ServerOpsRuntimeLogOutputEvent) => void>()
  /** 日志退出订阅者。 */
  private readonly logExitListeners = new Set<(event: ServerOpsRuntimeLogExitEvent) => void>()

  constructor(dependencies: ServerOpsRuntimeClientDependencies = DEFAULT_RUNTIME_CLIENT_DEPENDENCIES) {
    this.dependencies = dependencies
    this.logStartTimeoutMs = this.validatePositiveInteger(
      dependencies.logStartTimeoutMs ?? LOG_START_TIMEOUT_MS,
      MAX_LOG_START_TIMEOUT_MS,
      'SERVER_OPS_LOG_START_TIMEOUT_INVALID',
    )
    this.maxUsedLogStreamIds = this.validatePositiveInteger(
      dependencies.maxUsedLogStreamIds ?? MAX_USED_LOG_STREAM_IDS,
      MAX_LOG_STREAM_TOMBSTONES,
      'SERVER_OPS_LOG_STREAM_CAPACITY_INVALID',
    )
  }

  /** 订阅远程 PTY 输出。 */
  onOutput(listener: (event: ServerOpsTerminalOutputEvent) => void): () => void {
    this.outputListeners.add(listener)
    return () => this.outputListeners.delete(listener)
  }

  /** 订阅远程连接或 PTY 退出。 */
  onExit(listener: (event: ServerOpsTerminalExitEvent) => void): () => void {
    this.exitListeners.add(listener)
    return () => this.exitListeners.delete(listener)
  }

  /** 订阅通过三重身份校验的日志输出。 */
  onLogOutput(listener: (event: ServerOpsRuntimeLogOutputEvent) => void): () => void {
    this.logOutputListeners.add(listener)
    return () => this.logOutputListeners.delete(listener)
  }

  /** 订阅通过三重身份校验的日志终态。 */
  onLogExit(listener: (event: ServerOpsRuntimeLogExitEvent) => void): () => void {
    this.logExitListeners.add(listener)
    return () => this.logExitListeners.delete(listener)
  }

  /** 发起一条真实 SSH 连接并等待 Host Key 或 PTY 结果。 */
  async connect(input: ServerOpsRuntimeConnectionInput): Promise<ServerOpsRuntimeConnectResult> {
    if (!this.port) await this.start()
    /** 本次请求的内部唯一 ID。 */
    const requestId = this.dependencies.uuid()
    return new Promise<ServerOpsRuntimeConnectResult>((resolve, reject) => {
      /** 防止底层 socket 永久悬挂的总超时。 */
      const timeout = setTimeout(() => {
        this.pendingConnects.delete(requestId)
        this.port?.postMessage({ type: 'server-ops.disconnect', hostId: input.hostId, connectionId: input.connectionId })
        reject(new ServerOpsRuntimeError('SERVER_OPS_CONNECTION_TIMEOUT', 'SSH 连接超时'))
      }, CONNECT_TIMEOUT_MS)
      this.pendingConnects.set(requestId, { hostId: input.hostId, connectionId: input.connectionId, resolve, reject, timeout })
      this.port?.postMessage({ type: 'server-ops.connect', input: { ...input, requestId } })
    })
  }

  /** 主动断开精确连接。 */
  disconnect(hostId: string, connectionId: string): void {
    if (this.hasConflictingConnectionOwner(hostId, connectionId)) return
    this.rejectPendingLogStartsForConnection(hostId, connectionId, new ServerOpsRuntimeError('SERVER_OPS_CONNECTION_CLOSED', 'SSH 连接已断开'))
    this.finishLogStreamsForConnection(hostId, connectionId, 'connection-closed')
    if (this.activeConnections.get(connectionId) === hostId) this.activeConnections.delete(connectionId)
    for (const [requestId, pending] of this.pendingExecs) {
      if (pending.hostId !== hostId || pending.connectionId !== connectionId) continue
      clearTimeout(pending.timeout)
      pending.reject(new ServerOpsRuntimeError('SERVER_OPS_CONNECTION_CLOSED', 'SSH 连接已断开'))
      this.pendingExecs.delete(requestId)
    }
    this.port?.postMessage({ type: 'server-ops.disconnect', hostId, connectionId })
  }

  /** 启动日志流，只有 utility 明确返回 started 才完成。 */
  async startLog(hostId: string, connectionId: string, streamId: string, command: string): Promise<void> {
    if (this.activeConnections.get(connectionId) !== hostId) {
      throw new ServerOpsRuntimeError('SERVER_OPS_CONNECTION_NOT_ACTIVE', 'SSH 连接未激活')
    }
    if (this.usedLogStreamIds.has(streamId)) {
      throw new ServerOpsRuntimeError('SERVER_OPS_LOG_STREAM_CONFLICT', '日志流标识已被使用')
    }
    if (this.usedLogStreamIds.size >= this.maxUsedLogStreamIds) {
      throw new ServerOpsRuntimeError('SERVER_OPS_LOG_STREAM_CAPACITY_EXHAUSTED', '日志流标识容量已耗尽')
    }
    if (!this.port) await this.start()
    return new Promise<void>((resolve, reject) => {
      this.usedLogStreamIds.add(streamId)
      /** 仅当 Map 仍持有同一 pending 时，超时回调才有权结算。 */
      const pending: PendingLogStart = {
        hostId,
        connectionId,
        streamId,
        resolve,
        reject,
        timeout: setTimeout(() => {
          if (this.pendingLogStarts.get(streamId) !== pending) return
          this.pendingLogStarts.delete(streamId)
          clearTimeout(pending.timeout)
          this.port?.postMessage({ type: 'server-ops.log-stop', hostId, connectionId, streamId })
          pending.reject(new ServerOpsRuntimeError('SERVER_OPS_LOG_START_TIMEOUT', '日志流启动超时'))
        }, this.logStartTimeoutMs),
      }
      this.pendingLogStarts.set(streamId, pending)
      this.port?.postMessage({ type: 'server-ops.log-start', input: { hostId, connectionId, streamId, command } })
    })
  }

  /** 按完整身份停止 pending 或 active 日志流。 */
  stopLog(hostId: string, connectionId: string, streamId: string): void {
    const pending = this.pendingLogStarts.get(streamId)
    if (pending) {
      if (!this.matchesLogIdentity(pending, hostId, connectionId, streamId)) return
      this.pendingLogStarts.delete(streamId)
      clearTimeout(pending.timeout)
      pending.reject(new ServerOpsRuntimeError('SERVER_OPS_LOG_STOPPED', '日志流已停止'))
      this.port?.postMessage({ type: 'server-ops.log-stop', hostId, connectionId, streamId })
      return
    }
    const active = this.activeLogStreams.get(streamId)
    if (!active) return
    if (active && !this.matchesLogIdentity(active, hostId, connectionId, streamId)) return
    this.port?.postMessage({ type: 'server-ops.log-stop', hostId, connectionId, streamId })
  }

  /** 只向当前 active 且三重身份精确匹配的日志流发送 ACK。 */
  acknowledgeLog(hostId: string, connectionId: string, streamId: string, sequence: number): void {
    const active = this.activeLogStreams.get(streamId)
    if (!active || !this.matchesLogIdentity(active, hostId, connectionId, streamId)) return
    if (this.activeConnections.get(connectionId) !== hostId) return
    this.port?.postMessage({ type: 'server-ops.log-ack', hostId, connectionId, streamId, sequence })
  }

  /** 在已连接 SSH 上执行无 PTY 命令，并返回结构化结果。 */
  async exec(hostId: string, connectionId: string, command: string, timeoutMs: number): Promise<ServerOpsRuntimeExecResult> {
    if (this.activeConnections.get(connectionId) !== hostId) {
      throw new ServerOpsRuntimeError('SERVER_OPS_CONNECTION_NOT_ACTIVE', 'SSH 连接未激活')
    }
    await this.start()
    const requestId = this.dependencies.uuid()
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingExecs.delete(requestId)
        reject(new ServerOpsRuntimeError('SERVER_OPS_EXEC_TIMEOUT', '远程命令执行超时'))
      }, timeoutMs + 1000)
      this.pendingExecs.set(requestId, { hostId, connectionId, resolve, reject, timeout })
      this.port?.postMessage({ type: 'server-ops.exec', input: { requestId, hostId, connectionId, command, timeoutMs } })
    })
  }

  /** 向精确远程 PTY 写入用户输入。 */
  input(hostId: string, connectionId: string, data: string): void {
    this.port?.postMessage({ type: 'server-ops.terminal-input', hostId, connectionId, data })
  }

  /** 调整精确远程 PTY 行列。 */
  resize(hostId: string, connectionId: string, cols: number, rows: number): void {
    this.port?.postMessage({ type: 'server-ops.terminal-resize', hostId, connectionId, cols, rows })
  }

  /** 确认 Renderer 已完成一批输出渲染。 */
  acknowledgeOutput(input: ServerOpsTerminalOutputAck): void {
    this.port?.postMessage({ type: 'server-ops.terminal-ack', input })
  }

  /** 同步失效端口和本地状态，并请求 runtime 释放全部 SSH 资源。 */
  stop(): void {
    this.stopping = true
    this.runtimeEpoch += 1
    const port = this.port
    this.port = undefined
    if (port) {
      port.postMessage({ type: 'server-ops.shutdown' })
      port.close()
    }
    this.runtimeProcess?.kill()
    this.runtimeProcess = undefined
    this.starting = undefined
    this.usedLogStreamIds.clear()
    this.rejectPending(new ServerOpsRuntimeError('SERVER_OPS_RUNTIME_STOPPED', 'SSH 运行时已停止'))
    this.rejectPendingExec(new ServerOpsRuntimeError('SERVER_OPS_RUNTIME_STOPPED', 'SSH 运行时已停止'))
    this.rejectPendingLogStarts(new ServerOpsRuntimeError('SERVER_OPS_RUNTIME_STOPPED', 'SSH 运行时已停止'))
    this.finishAllLogStreams('error', 'SERVER_OPS_RUNTIME_STOPPED')
    this.emitRuntimeExit('SSH 运行时已停止')
    this.stopping = false
  }

  /** 按需启动单个 SSH utility process。 */
  private async start(): Promise<void> {
    if (this.port) return
    if (this.starting) return this.starting
    /** 当前启动代次，所有异步回调必须同时匹配代次、进程和端口。 */
    const epoch = ++this.runtimeEpoch
    /** 原始启动 Promise，后续用身份安全的 finally 包装。 */
    const startingPromise = new Promise<void>((resolve, reject) => {
      /** 构建后 SSH runtime 的固定入口。 */
      const entryPath = join(__dirname, 'server-ops-runtime.cjs')
      /** 承载全部 SSH I/O 的独立 utility process。 */
      const runtimeProcess = this.dependencies.createProcess(entryPath)
      this.runtimeProcess = runtimeProcess
      /** 与 utility process 独占通信的 MessageChannel。 */
      const channel = this.dependencies.createChannel()
      /** 主进程持有的 MessagePort。 */
      const port = channel.port2
      /** 启动只允许成功或失败一次。 */
      let settled = false
      /** utility process 必须在限定时间内发送 ready。 */
      const timeout = setTimeout(() => fail(new ServerOpsRuntimeError('SERVER_OPS_RUNTIME_START_TIMEOUT', 'SSH 运行时启动超时')), STARTUP_TIMEOUT_MS)
      /** 收束启动失败并清理 runtime。 */
      const fail = (error: ServerOpsRuntimeError): void => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        this.handleRuntimeFailure(error, epoch, runtimeProcess, port)
        reject(error)
      }
      this.port = port
      port.on('message', ({ data }) => {
        if (!this.isCurrentRuntime(epoch, runtimeProcess, port)) return
        /** 未通过 exact-key 与字段边界校验的 runtime 消息没有任何状态副作用。 */
        let message: ServerOpsRuntimeMessage
        try {
          message = parseServerOpsRuntimeMessage(data)
        } catch {
          return
        }
        if (message?.type === 'server-ops.ready' && !settled) {
          settled = true
          clearTimeout(timeout)
          resolve()
        }
        this.handleMessage(message)
      })
      port.start()
      runtimeProcess.on('error', () => {
        if (!this.isCurrentRuntime(epoch, runtimeProcess, port)) return
        /** ready 前拒绝启动；ready 后按当前 runtime 崩溃完整收口。 */
        const error = new ServerOpsRuntimeError('SERVER_OPS_RUNTIME_FAILED', 'SSH 运行时发生错误')
        if (!settled) fail(error)
        else this.handleRuntimeFailure(error, epoch, runtimeProcess, port)
      })
      runtimeProcess.on('exit', () => {
        if (!this.isCurrentRuntime(epoch, runtimeProcess, port) || this.stopping) return
        if (!settled) fail(new ServerOpsRuntimeError('SERVER_OPS_RUNTIME_FAILED', 'SSH 运行时启动失败'))
        else this.handleRuntimeFailure(new ServerOpsRuntimeError('SERVER_OPS_RUNTIME_FAILED', 'SSH 运行时意外退出'), epoch, runtimeProcess, port)
      })
      runtimeProcess.postMessage({ type: 'proma-server-ops-runtime-port' }, [channel.port1])
    })
    /** 只有本次启动仍是当前单飞任务时，才允许清空 starting。 */
    let trackedStarting: Promise<void>
    trackedStarting = startingPromise.finally(() => {
      if (this.starting === trackedStarting) this.starting = undefined
    })
    this.starting = trackedStarting
    return trackedStarting
  }

  /** 分派连接结果、公开错误和流事件。 */
  private handleMessage(message: ServerOpsRuntimeMessage): void {
    if (message.type === 'server-ops.connect-result') {
      /** 对应 requestId 的待处理连接。 */
      const pending = this.pendingConnects.get(message.requestId)
      if (!pending || pending.hostId !== message.hostId || pending.connectionId !== message.connectionId) return
      clearTimeout(pending.timeout)
      this.pendingConnects.delete(message.requestId)
      if (message.result.status === 'connected') this.activeConnections.set(message.connectionId, message.hostId)
      pending.resolve(message.result)
      return
    }
    if (message.type === 'server-ops.exec-result') {
      const pending = this.pendingExecs.get(message.requestId)
      if (!pending || pending.hostId !== message.hostId || pending.connectionId !== message.connectionId) return
      clearTimeout(pending.timeout)
      this.pendingExecs.delete(message.requestId)
      pending.resolve(message.result)
      return
    }
    if (message.type === 'server-ops.error' && message.requestId) {
      /** 对应 requestId 的待处理连接。 */
      const pending = this.pendingConnects.get(message.requestId)
      if (pending && pending.hostId === message.hostId && pending.connectionId === message.connectionId) { clearTimeout(pending.timeout); this.pendingConnects.delete(message.requestId); pending.reject(new ServerOpsRuntimeError(message.code, message.message)) }
      const exec = this.pendingExecs.get(message.requestId)
      if (exec && exec.hostId === message.hostId && exec.connectionId === message.connectionId) { clearTimeout(exec.timeout); this.pendingExecs.delete(message.requestId); exec.reject(new ServerOpsRuntimeError(message.code, message.message)) }
      return
    }
    if (message.type === 'server-ops.error') {
      this.rejectPendingLogStartsForConnection(
        message.hostId,
        message.connectionId,
        new ServerOpsRuntimeError(message.code, message.message),
      )
      return
    }
    if (message.type === 'server-ops.log-started') {
      const pending = this.pendingLogStarts.get(message.streamId)
      if (!pending || !this.matchesLogIdentity(pending, message.hostId, message.connectionId, message.streamId)) return
      if (this.activeConnections.get(message.connectionId) !== message.hostId) return
      this.pendingLogStarts.delete(message.streamId)
      clearTimeout(pending.timeout)
      this.activeLogStreams.set(message.streamId, { hostId: message.hostId, connectionId: message.connectionId, streamId: message.streamId })
      pending.resolve()
      return
    }
    if (message.type === 'server-ops.log-chunk') {
      const active = this.activeLogStreams.get(message.streamId)
      if (!active || !this.matchesLogIdentity(active, message.hostId, message.connectionId, message.streamId)) return
      if (this.activeConnections.get(message.connectionId) !== message.hostId) return
      this.notifyLogOutput({ hostId: message.hostId, connectionId: message.connectionId, streamId: message.streamId, sequence: message.sequence, data: message.data })
      return
    }
    if (message.type === 'server-ops.log-exit') {
      const pending = this.pendingLogStarts.get(message.streamId)
      if (pending && this.matchesLogIdentity(pending, message.hostId, message.connectionId, message.streamId)) {
        this.pendingLogStarts.delete(message.streamId)
        clearTimeout(pending.timeout)
        pending.reject(new ServerOpsRuntimeError(message.errorCode ?? 'SERVER_OPS_LOG_START_FAILED', '日志流启动失败'))
        return
      }
      const active = this.activeLogStreams.get(message.streamId)
      if (!active || !this.matchesLogIdentity(active, message.hostId, message.connectionId, message.streamId)) return
      if (this.activeConnections.get(message.connectionId) !== message.hostId) return
      this.activeLogStreams.delete(message.streamId)
      this.notifyLogExit({ hostId: message.hostId, connectionId: message.connectionId, streamId: message.streamId, reason: message.reason, ...(message.errorCode ? { errorCode: message.errorCode } : {}) })
      return
    }
    if (message.type === 'server-ops.terminal-output') {
      if (this.activeConnections.get(message.event.connectionId) !== message.event.hostId) return
      for (const listener of this.outputListeners) listener(message.event)
      return
    }
    if (message.type === 'server-ops.terminal-exit') {
      if (this.activeConnections.get(message.event.connectionId) !== message.event.hostId) return
      this.rejectPendingLogStartsForConnection(message.event.hostId, message.event.connectionId, new ServerOpsRuntimeError('SERVER_OPS_CONNECTION_CLOSED', 'SSH 连接已断开'))
      this.finishLogStreamsForConnection(message.event.hostId, message.event.connectionId, 'connection-closed')
      this.activeConnections.delete(message.event.connectionId)
      for (const [requestId, pending] of this.pendingExecs) {
        if (pending.connectionId !== message.event.connectionId) continue
        clearTimeout(pending.timeout)
        this.pendingExecs.delete(requestId)
        pending.reject(new ServerOpsRuntimeError('SERVER_OPS_CONNECTION_CLOSED', 'SSH 连接已断开'))
      }
      for (const listener of this.exitListeners) listener(message.event)
    }
  }

  /** runtime 失效后拒绝所有请求并发布公开退出状态。 */
  private handleRuntimeFailure(
    error: ServerOpsRuntimeError,
    epoch: number,
    runtimeProcess: ServerOpsRuntimeProcess,
    port: ServerOpsRuntimePort,
  ): void {
    if (!this.isCurrentRuntime(epoch, runtimeProcess, port)) return
    this.runtimeEpoch += 1
    try {
      runtimeProcess.kill()
    } catch {
      // kill 失败不能阻断端口、pending 请求和连接状态的本地收口。
    }
    port.close()
    this.port = undefined
    this.runtimeProcess = undefined
    this.usedLogStreamIds.clear()
    this.rejectPending(error)
    this.rejectPendingExec(error)
    this.rejectPendingLogStarts(error)
    this.finishAllLogStreams('error', error.code)
    this.emitRuntimeExit(error.message)
  }

  /** 拒绝并清理所有待处理连接请求。 */
  private rejectPending(error: ServerOpsRuntimeError): void {
    for (const pending of this.pendingConnects.values()) {
      clearTimeout(pending.timeout)
      pending.reject(error)
    }
    this.pendingConnects.clear()
  }
  private rejectPendingExec(error: ServerOpsRuntimeError): void {
    for (const pending of this.pendingExecs.values()) {
      clearTimeout(pending.timeout)
      pending.reject(error)
    }
    this.pendingExecs.clear()
  }

  /** 拒绝并清理全部待启动日志流。 */
  private rejectPendingLogStarts(error: ServerOpsRuntimeError): void {
    for (const pending of this.pendingLogStarts.values()) {
      clearTimeout(pending.timeout)
      pending.reject(error)
    }
    this.pendingLogStarts.clear()
  }

  /** 拒绝指定连接上的全部待启动日志流。 */
  private rejectPendingLogStartsForConnection(hostId: string, connectionId: string, error: ServerOpsRuntimeError): void {
    for (const [streamId, pending] of this.pendingLogStarts) {
      if (pending.hostId !== hostId || pending.connectionId !== connectionId) continue
      this.pendingLogStarts.delete(streamId)
      clearTimeout(pending.timeout)
      pending.reject(error)
    }
  }

  /** 判断 connectionId 是否已被另一 host 的 active/pending 工作占用。 */
  private hasConflictingConnectionOwner(hostId: string, connectionId: string): boolean {
    const activeHostId = this.activeConnections.get(connectionId)
    if (activeHostId !== undefined && activeHostId !== hostId) return true
    for (const pending of this.pendingConnects.values()) {
      if (pending.connectionId === connectionId && pending.hostId !== hostId) return true
    }
    for (const pending of this.pendingExecs.values()) {
      if (pending.connectionId === connectionId && pending.hostId !== hostId) return true
    }
    for (const pending of this.pendingLogStarts.values()) {
      if (pending.connectionId === connectionId && pending.hostId !== hostId) return true
    }
    for (const active of this.activeLogStreams.values()) {
      if (active.connectionId === connectionId && active.hostId !== hostId) return true
    }
    return false
  }

  /** 指定连接失效时为每条 active 日志流发布一次终态。 */
  private finishLogStreamsForConnection(hostId: string, connectionId: string, reason: ServerOpsRuntimeLogExitReason): void {
    for (const [streamId, active] of this.activeLogStreams) {
      if (active.hostId !== hostId || active.connectionId !== connectionId) continue
      this.activeLogStreams.delete(streamId)
      this.notifyLogExit({ ...active, reason })
    }
  }

  /** runtime 全局失效时同步释放所有 active 日志流。 */
  private finishAllLogStreams(reason: ServerOpsRuntimeLogExitReason, errorCode?: string): void {
    for (const active of this.activeLogStreams.values()) {
      this.notifyLogExit({ ...active, reason, ...(errorCode ? { errorCode } : {}) })
    }
    this.activeLogStreams.clear()
  }

  /** 比较日志流的 host、connection 与 stream 三重身份。 */
  private matchesLogIdentity(identity: ServerOpsRuntimeLogIdentity, hostId: string, connectionId: string, streamId: string): boolean {
    return identity.hostId === hostId && identity.connectionId === connectionId && identity.streamId === streamId
  }

  /** 校验异步回调仍属于当前 runtime 代次。 */
  private isCurrentRuntime(epoch: number, runtimeProcess: ServerOpsRuntimeProcess, port: ServerOpsRuntimePort): boolean {
    return this.runtimeEpoch === epoch && this.runtimeProcess === runtimeProcess && this.port === port
  }

  /** 校验可注入的正整数配置，避免无界资源占用或无效定时器。 */
  private validatePositiveInteger(value: number, maximum: number, code: string): number {
    if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
      throw new ServerOpsRuntimeError(code, 'Server Ops runtime 配置无效')
    }
    return value
  }

  /** 隔离日志输出订阅者异常。 */
  private notifyLogOutput(event: ServerOpsRuntimeLogOutputEvent): void {
    for (const listener of this.logOutputListeners) {
      try { listener({ ...event }) } catch { /* 单个订阅者无权阻断其它消费者。 */ }
    }
  }

  /** 隔离日志终态订阅者异常。 */
  private notifyLogExit(event: ServerOpsRuntimeLogExitEvent): void {
    for (const listener of this.logExitListeners) {
      try { listener({ ...event }) } catch { /* 单个订阅者无权阻断资源收口。 */ }
    }
  }

  /** 为每条活跃连接发出一次 runtime 退出事件。 */
  private emitRuntimeExit(message: string): void {
    for (const [connectionId, hostId] of this.activeConnections) {
      /** 当前连接对应的公开退出事件。 */
      const event: ServerOpsTerminalExitEvent = { hostId, connectionId, message }
      for (const listener of this.exitListeners) listener(event)
    }
    this.activeConnections.clear()
  }
}

/** 全局运维模块复用的单一 SSH runtime client。 */
export const serverOpsRuntimeClient = new ServerOpsRuntimeClient()
