import { randomUUID } from 'node:crypto'
import { parseServerOpsSftpRequest, ServerOpsSftpRuntimeError } from '../../../utility/server-ops/server-ops-sftp-runtime'
import type { ServerOpsSftpRequest, ServerOpsSftpResult } from '../../../utility/server-ops/server-ops-sftp-runtime'

/** 保留每种 SFTP input 与 type 的对应关系，requestId 仅由 Main 生成。 */
export type ServerOpsSftpCall = ServerOpsSftpRequest extends infer Request
  ? Request extends ServerOpsSftpRequest ? Omit<Request, 'requestId'> : never : never

/** 待回复的有界 SFTP 请求及其提交语义。 */
interface PendingSftp {
  request: ServerOpsSftpRequest
  resolve: (result: ServerOpsSftpResult) => void
  reject: (error: ServerOpsSftpRuntimeError) => void
  timeout: ReturnType<typeof setTimeout>
}
import { join } from 'node:path'
import type { MessagePortMain } from 'electron'
import type { ServerOpsConsoleAck, ServerOpsConsoleExitEvent, ServerOpsConsoleIdentity, ServerOpsConsoleInput,
  ServerOpsConsoleOutputEvent, ServerOpsConsoleResizeInput, ServerOpsTerminalExitEvent, ServerOpsTerminalOutputAck,
  ServerOpsTerminalOutputEvent } from '@proma/shared'
import type { ServerOpsConsoleRuntimeStart } from '../../../utility/server-ops/server-ops-console-runtime'
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

interface PendingConsoleStart {
  session: ServerOpsConsoleIdentity
  resolve: () => void
  reject: (error: ServerOpsRuntimeError) => void
  timeout: ReturnType<typeof setTimeout>
}

interface PendingConsoleClose {
  session: ServerOpsConsoleIdentity
  promise: Promise<void>
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
/** Console channel 启停确认的固定上限。 */
const CONSOLE_LIFECYCLE_TIMEOUT_MS = 10_000
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
  /** SFTP 在途请求最多 64 个，窗口资源归属单独保留至显式关闭。 */
  private readonly pendingSftp = new Map<string, PendingSftp>()
  private readonly sftpOwners = new Map<string, Map<string, string>>()
  /** 连接或 runtime 先失联时保留 owner 清理不可确认事实。 */
  private readonly unconfirmedSftpOwners = new Set<string>()
  /** owner 关闭按 ownerKey 单飞并等待 utility 精确 ACK。 */
  private readonly closingSftpOwners = new Map<string, Promise<void>>()
  /** streamId 全局唯一，避免迟到 started 接管同 ID 新代流。 */
  private readonly pendingLogStarts = new Map<string, PendingLogStart>()
  /** 已确认启动的日志流。 */
  private readonly activeLogStreams = new Map<string, ServerOpsRuntimeLogIdentity>()
  /** 本 client 生命周期内已使用的 ID，阻止迟到 started 接管同 ID 新请求。 */
  private readonly usedLogStreamIds = new Set<string>()
  /** Console 启动与关闭都等待 utility 明确确认并设置 deadline。 */
  private readonly pendingConsoleStarts = new Map<string, PendingConsoleStart>()
  private readonly pendingConsoleCloses = new Map<string, PendingConsoleClose>()
  private readonly activeConsoles = new Map<string, ServerOpsConsoleIdentity>()
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
  private readonly consoleOutputListeners = new Set<(event: ServerOpsConsoleOutputEvent) => void>()
  private readonly consoleExitListeners = new Set<(event: ServerOpsConsoleExitEvent) => void>()

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
    this.rejectSftp('SERVER_OPS_CONNECTION_CLOSED', (request) => request.hostId === hostId && request.connectionId === connectionId)
    this.forgetSftpConnection(connectionId)
    this.rejectPendingLogStartsForConnection(hostId, connectionId, new ServerOpsRuntimeError('SERVER_OPS_CONNECTION_CLOSED', 'SSH 连接已断开'))
    this.finishLogStreamsForConnection(hostId, connectionId, 'connection-closed')
    this.finishConsolesForConnection(hostId, connectionId, new ServerOpsRuntimeError('SERVER_OPS_CONNECTION_CLOSED', 'SSH 连接已断开'))
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
  async sftp(input: ServerOpsSftpCall): Promise<ServerOpsSftpResult> {
    if (!this.port || this.activeConnections.get(input.connectionId) !== input.hostId) throw new ServerOpsSftpRuntimeError('SERVER_OPS_CONNECTION_NOT_ACTIVE')
    if (this.closingSftpOwners.has(input.input.ownerKey)) throw new ServerOpsSftpRuntimeError('SERVER_OPS_SFTP_OWNER_CLOSED')
    if (this.pendingSftp.size >= 64 || (!this.sftpOwners.has(input.input.ownerKey) && this.sftpOwners.size >= 256)) throw new ServerOpsSftpRuntimeError('SERVER_OPS_SFTP_CAPACITY_EXCEEDED')
    /** 在注册定时器前验证完整合同，避免无效请求留下资源。 */
    const request = parseServerOpsSftpRequest({ ...input, requestId: this.dependencies.uuid() })
    const remaining = request.input.deadlineAt - Date.now()
    if (remaining <= 0 || remaining > 120_000) throw new ServerOpsSftpRuntimeError('SERVER_OPS_SFTP_DEADLINE_INVALID')
    if (this.pendingSftp.has(request.requestId)) throw new ServerOpsSftpRuntimeError('SERVER_OPS_SFTP_REQUEST_CONFLICT')
    const owners = this.sftpOwners.get(request.input.ownerKey) ?? new Map<string, string>()
    owners.set(request.connectionId, request.hostId)
    this.sftpOwners.set(request.input.ownerKey, owners)
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { void this.closeSftpOwner(request.input.ownerKey, 'SERVER_OPS_SFTP_TIMEOUT').catch(() => undefined) }, remaining)
      this.pendingSftp.set(request.requestId, { request, resolve, reject, timeout })
      try { this.port!.postMessage({ type: 'server-ops.sftp', input: request }) }
      catch {
        clearTimeout(timeout)
        this.pendingSftp.delete(request.requestId)
        reject(new ServerOpsSftpRuntimeError('SERVER_OPS_SFTP_DISPATCH_FAILED'))
        void this.closeSftpOwner(request.input.ownerKey).catch(() => undefined)
      }
    })
  }

  /** 关闭窗口拥有的全部远程 cursor/handle，并使迟到结果失效。 */
  closeSftpOwner(ownerKey: string, code = 'SERVER_OPS_SFTP_OWNER_CLOSED'): Promise<void> {
    const existing = this.closingSftpOwners.get(ownerKey)
    if (existing) return existing
    this.rejectSftp(code, (request) => request.input.ownerKey === ownerKey)
    const owned = this.sftpOwners.get(ownerKey)
    this.sftpOwners.delete(ownerKey)
    const cleanupWasUnconfirmed = this.unconfirmedSftpOwners.delete(ownerKey)
    const closing = Promise.all([...(owned ?? [])].map(async ([connectionId, hostId]) => {
      if (!this.port || this.activeConnections.get(connectionId) !== hostId) {
        throw new ServerOpsSftpRuntimeError('SERVER_OPS_SFTP_CLEANUP_UNCONFIRMED')
      }
      const request = parseServerOpsSftpRequest({ type: 'close-owner', requestId: this.dependencies.uuid(), hostId, connectionId, input: { ownerKey, deadlineAt: Date.now() + 10_000 } })
      if (this.pendingSftp.has(request.requestId)) throw new ServerOpsSftpRuntimeError('SERVER_OPS_SFTP_REQUEST_CONFLICT')
      await new Promise<void>((resolve, reject) => {
        const pending: PendingSftp = {
          request,
          resolve: (result) => result.type === 'close-owner' ? resolve() : reject(new ServerOpsSftpRuntimeError('SERVER_OPS_SFTP_RESULT_INVALID')),
          reject,
          timeout: setTimeout(() => {
            if (this.pendingSftp.get(request.requestId) !== pending) return
            this.pendingSftp.delete(request.requestId)
            reject(new ServerOpsSftpRuntimeError('SERVER_OPS_SFTP_CLOSE_OWNER_TIMEOUT'))
          }, 10_000),
        }
        this.pendingSftp.set(request.requestId, pending)
        try { this.port!.postMessage({ type: 'server-ops.sftp', input: request }) } catch {
          clearTimeout(pending.timeout)
          this.pendingSftp.delete(request.requestId)
          reject(new ServerOpsSftpRuntimeError('SERVER_OPS_SFTP_DISPATCH_FAILED'))
        }
      })
    })).then(() => {
      if (cleanupWasUnconfirmed) throw new ServerOpsSftpRuntimeError('SERVER_OPS_SFTP_CLEANUP_UNCONFIRMED')
    })
    this.closingSftpOwners.set(ownerKey, closing)
    void closing.finally(() => { if (this.closingSftpOwners.get(ownerKey) === closing) this.closingSftpOwners.delete(ownerKey) }).catch(() => undefined)
    return closing
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

  /** 启动绑定完整身份的独立 Docker Console channel。 */
  async startConsole(input: ServerOpsConsoleRuntimeStart): Promise<void> {
    if (this.activeConnections.get(input.connectionId) !== input.hostId || this.activeConsoles.has(input.consoleId)
      || this.pendingConsoleStarts.has(input.consoleId)) throw new ServerOpsRuntimeError('SERVER_OPS_CONSOLE_START_FAILED', '容器终端无法启动')
    await this.start()
    return await new Promise<void>((resolve, reject) => {
      const session = this.consoleIdentity(input)
      const timeout = setTimeout(() => {
        this.pendingConsoleStarts.delete(input.consoleId)
        this.port?.postMessage({ type: 'server-ops.console-stop', input: session })
        reject(new ServerOpsRuntimeError('SERVER_OPS_CONSOLE_START_TIMEOUT', '容器终端启动超时'))
      }, CONSOLE_LIFECYCLE_TIMEOUT_MS)
      this.pendingConsoleStarts.set(input.consoleId, { session, resolve, reject, timeout })
      this.port?.postMessage({ type: 'server-ops.console-start', input })
    })
  }

  /** 关闭 Console 并等待 utility 的精确 exit 确认。 */
  async stopConsole(input: ServerOpsConsoleIdentity): Promise<void> {
    const active = this.activeConsoles.get(input.consoleId)
    if (!active || !this.sameConsole(active, input)) return
    const existing = this.pendingConsoleCloses.get(input.consoleId)
    if (existing) return await existing.promise
    /** 当前关闭单飞 Promise 供重复关闭调用复用。 */
    let resolveClose!: () => void
    let rejectClose!: (error: ServerOpsRuntimeError) => void
    const promise = new Promise<void>((resolve, reject) => { resolveClose = resolve; rejectClose = reject })
    const timeout = setTimeout(() => {
      this.pendingConsoleCloses.delete(input.consoleId)
      this.activeConsoles.delete(input.consoleId)
      rejectClose(new ServerOpsRuntimeError('SERVER_OPS_CONSOLE_CLOSE_TIMEOUT', '容器终端关闭超时'))
    }, CONSOLE_LIFECYCLE_TIMEOUT_MS)
    this.pendingConsoleCloses.set(input.consoleId, {
      session: { ...input }, promise, resolve: resolveClose, reject: rejectClose, timeout,
    })
    this.port?.postMessage({ type: 'server-ops.console-stop', input })
    return await promise
  }

  inputConsole(input: ServerOpsConsoleInput): void { if (this.matchesActiveConsole(input)) this.port?.postMessage({ type: 'server-ops.console-input', input }) }
  resizeConsole(input: ServerOpsConsoleResizeInput): void { if (this.matchesActiveConsole(input)) this.port?.postMessage({ type: 'server-ops.console-resize', input }) }
  acknowledgeConsole(input: ServerOpsConsoleAck): void { if (this.matchesActiveConsole(input)) this.port?.postMessage({ type: 'server-ops.console-ack', input }) }
  onConsoleOutput(listener: (event: ServerOpsConsoleOutputEvent) => void): () => void { this.consoleOutputListeners.add(listener); return () => this.consoleOutputListeners.delete(listener) }
  onConsoleExit(listener: (event: ServerOpsConsoleExitEvent) => void): () => void { this.consoleExitListeners.add(listener); return () => this.consoleExitListeners.delete(listener) }

  /** 同步失效端口和本地状态，并请求 runtime 释放全部 SSH 资源。 */
  stop(): void {
    this.markAllSftpOwnersUnconfirmed()
    this.rejectSftp('SERVER_OPS_RUNTIME_STOPPED')
    this.sftpOwners.clear()
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
    this.finishAllConsoles(new ServerOpsRuntimeError('SERVER_OPS_RUNTIME_STOPPED', 'SSH 运行时已停止'))
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
    if (message.type === 'server-ops.sftp-result') {
      const pending = this.pendingSftp.get(message.result.requestId)
      if (!pending || pending.request.hostId !== message.hostId || pending.request.connectionId !== message.connectionId) return
      if (message.result.type !== 'error' && message.result.type !== pending.request.type) return
      clearTimeout(pending.timeout)
      this.pendingSftp.delete(message.result.requestId)
      if (message.result.type === 'error') pending.reject(new ServerOpsSftpRuntimeError(message.result.code, message.result.outcome))
      else pending.resolve(message.result)
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
    if (message.type === 'server-ops.console-started') {
      const pending = this.pendingConsoleStarts.get(message.session.consoleId)
      if (!pending || !this.sameConsole(pending.session, message.session)
        || this.activeConnections.get(message.session.connectionId) !== message.session.hostId) return
      clearTimeout(pending.timeout)
      this.pendingConsoleStarts.delete(message.session.consoleId)
      this.activeConsoles.set(message.session.consoleId, { ...message.session })
      pending.resolve()
      return
    }
    if (message.type === 'server-ops.console-output') {
      if (!this.matchesActiveConsole(message.event)) return
      this.notifyConsoleOutput(message.event)
      return
    }
    if (message.type === 'server-ops.console-exit') {
      const pendingStart = this.pendingConsoleStarts.get(message.event.consoleId)
      if (pendingStart && this.sameConsole(pendingStart.session, message.event)) {
        clearTimeout(pendingStart.timeout); this.pendingConsoleStarts.delete(message.event.consoleId)
        pendingStart.reject(new ServerOpsRuntimeError('SERVER_OPS_CONSOLE_START_FAILED', '容器终端无法启动'))
        return
      }
      const active = this.activeConsoles.get(message.event.consoleId)
      if (!active || !this.sameConsole(active, message.event)) return
      this.activeConsoles.delete(message.event.consoleId)
      const pendingClose = this.pendingConsoleCloses.get(message.event.consoleId)
      if (pendingClose) { clearTimeout(pendingClose.timeout); this.pendingConsoleCloses.delete(message.event.consoleId); pendingClose.resolve() }
      this.notifyConsoleExit(message.event)
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
      this.rejectSftp('SERVER_OPS_CONNECTION_CLOSED', (request) => request.connectionId === message.event.connectionId)
      this.forgetSftpConnection(message.event.connectionId)
      this.rejectPendingLogStartsForConnection(message.event.hostId, message.event.connectionId, new ServerOpsRuntimeError('SERVER_OPS_CONNECTION_CLOSED', 'SSH 连接已断开'))
      this.finishLogStreamsForConnection(message.event.hostId, message.event.connectionId, 'connection-closed')
      this.finishConsolesForConnection(message.event.hostId, message.event.connectionId,
        new ServerOpsRuntimeError('SERVER_OPS_CONNECTION_CLOSED', 'SSH 连接已断开'))
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
    this.markAllSftpOwnersUnconfirmed()
    this.rejectSftp(error.code)
    this.sftpOwners.clear()
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
    this.finishAllConsoles(error)
    this.emitRuntimeExit(error.message)
  }

  /** 拒绝并清理所有待处理连接请求。 */
  private rejectSftp(code: string, matches: (request: ServerOpsSftpRequest) => boolean = () => true): void {
    for (const [requestId, pending] of this.pendingSftp) {
      if (!matches(pending.request)) continue
      clearTimeout(pending.timeout)
      this.pendingSftp.delete(requestId)
      /** 已分派的变更在失联时不能证明未提交，读取类操作没有提交副作用。 */
      const readOnly = ['list', 'preview', 'stat', 'open-read', 'read', 'close', 'cancel', 'close-owner'].includes(pending.request.type)
      pending.reject(new ServerOpsSftpRuntimeError(code, readOnly ? 'not-committed' : 'unknown'))
    }
  }

  /** 连接终结后清除所有 owner 的该连接资源索引。 */
  private forgetSftpConnection(connectionId: string): void {
    for (const [ownerKey, owned] of this.sftpOwners) {
      if (owned.has(connectionId)) this.unconfirmedSftpOwners.add(ownerKey)
      owned.delete(connectionId)
      if (owned.size === 0) this.sftpOwners.delete(ownerKey)
    }
  }

  /** runtime 整体失联前将所有仍有远端资源的 owner 标记为不可确认。 */
  private markAllSftpOwnersUnconfirmed(): void {
    for (const ownerKey of this.sftpOwners.keys()) this.unconfirmedSftpOwners.add(ownerKey)
  }

  private consoleIdentity(input: ServerOpsConsoleIdentity): ServerOpsConsoleIdentity {
    return { consoleId: input.consoleId, hostId: input.hostId, connectionId: input.connectionId, containerId: input.containerId }
  }

  private sameConsole(left: ServerOpsConsoleIdentity, right: ServerOpsConsoleIdentity): boolean {
    return left.consoleId === right.consoleId && left.hostId === right.hostId && left.connectionId === right.connectionId
      && left.containerId === right.containerId
  }

  private matchesActiveConsole(input: ServerOpsConsoleIdentity): boolean {
    const active = this.activeConsoles.get(input.consoleId)
    return Boolean(active && this.sameConsole(active, input) && this.activeConnections.get(input.connectionId) === input.hostId)
  }

  private finishConsolesForConnection(hostId: string, connectionId: string, error: ServerOpsRuntimeError): void {
    for (const [consoleId, pending] of this.pendingConsoleStarts) {
      if (pending.session.hostId !== hostId || pending.session.connectionId !== connectionId) continue
      clearTimeout(pending.timeout); this.pendingConsoleStarts.delete(consoleId); pending.reject(error)
    }
    for (const [consoleId, active] of this.activeConsoles) {
      if (active.hostId !== hostId || active.connectionId !== connectionId) continue
      this.activeConsoles.delete(consoleId)
      const closing = this.pendingConsoleCloses.get(consoleId)
      if (closing) { clearTimeout(closing.timeout); this.pendingConsoleCloses.delete(consoleId); closing.resolve() }
      const event = { ...active, message: error.message }
      this.notifyConsoleExit(event)
    }
  }

  private finishAllConsoles(error: ServerOpsRuntimeError): void {
    const connections = new Set([...this.pendingConsoleStarts.values(), ...this.activeConsoles.values()]
      .map((entry) => 'session' in entry ? `${entry.session.hostId}\0${entry.session.connectionId}` : `${entry.hostId}\0${entry.connectionId}`))
    for (const connection of connections) {
      const [hostId, connectionId] = connection.split('\0')
      if (hostId && connectionId) this.finishConsolesForConnection(hostId, connectionId, error)
    }
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

  /** 隔离 Console 输出订阅者异常。 */
  private notifyConsoleOutput(event: ServerOpsConsoleOutputEvent): void {
    for (const listener of this.consoleOutputListeners) {
      try { listener({ ...event }) } catch { /* 单个订阅者无权阻断其它消费者。 */ }
    }
  }

  /** 隔离 Console 终态订阅者异常。 */
  private notifyConsoleExit(event: ServerOpsConsoleExitEvent): void {
    for (const listener of this.consoleExitListeners) {
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
