import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { MessageChannelMain, utilityProcess, type MessagePortMain, type UtilityProcess } from 'electron'
import type { ServerOpsTerminalExitEvent, ServerOpsTerminalOutputAck, ServerOpsTerminalOutputEvent } from '@proma/shared'
import type {
  ServerOpsRuntimeConnectRequest,
  ServerOpsRuntimeConnectResult,
  ServerOpsRuntimeMessage,
  ServerOpsRuntimeRequest,
} from '../../../utility/server-ops/server-ops-runtime-protocol'

/** 主进程 MessagePort 使用的最小接口。 */
type RuntimePort = Pick<MessagePortMain, 'close' | 'start'> & {
  postMessage(message: ServerOpsRuntimeRequest): void
  on(event: 'message', listener: (event: { data: unknown }) => void): void
}

/** Facade 提交的连接输入，requestId 由 client 内部生成。 */
export type ServerOpsRuntimeConnectionInput = Omit<ServerOpsRuntimeConnectRequest, 'requestId'>

/** 单个待完成连接请求。 */
interface PendingConnect {
  resolve: (result: ServerOpsRuntimeConnectResult) => void
  reject: (error: ServerOpsRuntimeError) => void
  timeout: ReturnType<typeof setTimeout>
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

/** 管理独立 SSH utility process、连接请求与远程 PTY 事件。 */
export class ServerOpsRuntimeClient {
  /** 当前 SSH utility process。 */
  private runtimeProcess: UtilityProcess | undefined
  /** 当前专用 MessagePort。 */
  private port: RuntimePort | undefined
  /** 并发启动时复用的单飞 Promise。 */
  private starting: Promise<void> | undefined
  /** runtime 正常停止期间忽略预期 exit。 */
  private stopping = false
  /** requestId 对应的连接请求。 */
  private readonly pendingConnects = new Map<string, PendingConnect>()
  /** 当前已连接的 connectionId 到 hostId。 */
  private readonly activeConnections = new Map<string, string>()
  /** 远程输出订阅者。 */
  private readonly outputListeners = new Set<(event: ServerOpsTerminalOutputEvent) => void>()
  /** 远程退出订阅者。 */
  private readonly exitListeners = new Set<(event: ServerOpsTerminalExitEvent) => void>()

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

  /** 发起一条真实 SSH 连接并等待 Host Key 或 PTY 结果。 */
  async connect(input: ServerOpsRuntimeConnectionInput): Promise<ServerOpsRuntimeConnectResult> {
    await this.start()
    /** 本次请求的内部唯一 ID。 */
    const requestId = randomUUID()
    return new Promise<ServerOpsRuntimeConnectResult>((resolve, reject) => {
      /** 防止底层 socket 永久悬挂的总超时。 */
      const timeout = setTimeout(() => {
        this.pendingConnects.delete(requestId)
        this.port?.postMessage({ type: 'server-ops.disconnect', hostId: input.hostId, connectionId: input.connectionId })
        reject(new ServerOpsRuntimeError('SERVER_OPS_CONNECTION_TIMEOUT', 'SSH 连接超时'))
      }, CONNECT_TIMEOUT_MS)
      this.pendingConnects.set(requestId, { resolve, reject, timeout })
      this.port?.postMessage({ type: 'server-ops.connect', input: { ...input, requestId } })
    })
  }

  /** 主动断开精确连接。 */
  disconnect(hostId: string, connectionId: string): void {
    this.activeConnections.delete(connectionId)
    this.port?.postMessage({ type: 'server-ops.disconnect', hostId, connectionId })
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
    const port = this.port
    this.port = undefined
    if (port) {
      port.postMessage({ type: 'server-ops.shutdown' })
      port.close()
    }
    this.runtimeProcess?.kill()
    this.runtimeProcess = undefined
    this.starting = undefined
    this.rejectPending(new ServerOpsRuntimeError('SERVER_OPS_RUNTIME_STOPPED', 'SSH 运行时已停止'))
    this.emitRuntimeExit('SSH 运行时已停止')
    this.stopping = false
  }

  /** 按需启动单个 SSH utility process。 */
  private async start(): Promise<void> {
    if (this.port) return
    if (this.starting) return this.starting
    this.starting = new Promise<void>((resolve, reject) => {
      /** 构建后 SSH runtime 的固定入口。 */
      const entryPath = join(__dirname, 'server-ops-runtime.cjs')
      /** 承载全部 SSH I/O 的独立 utility process。 */
      const runtimeProcess = utilityProcess.fork(entryPath, [], { serviceName: 'Proma Server Ops Runtime' })
      this.runtimeProcess = runtimeProcess
      /** 与 utility process 独占通信的 MessageChannel。 */
      const channel = new MessageChannelMain()
      /** 主进程持有的 MessagePort。 */
      const port = channel.port2 as unknown as RuntimePort
      /** 启动只允许成功或失败一次。 */
      let settled = false
      /** utility process 必须在限定时间内发送 ready。 */
      const timeout = setTimeout(() => fail(new ServerOpsRuntimeError('SERVER_OPS_RUNTIME_START_TIMEOUT', 'SSH 运行时启动超时')), STARTUP_TIMEOUT_MS)
      /** 收束启动失败并清理 runtime。 */
      const fail = (error: ServerOpsRuntimeError): void => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        this.handleRuntimeFailure(error)
        reject(error)
      }
      this.port = port
      port.on('message', ({ data }) => {
        /** 只处理 runtime 定义的结构化消息。 */
        const message = data as ServerOpsRuntimeMessage
        if (message?.type === 'server-ops.ready' && !settled) {
          settled = true
          clearTimeout(timeout)
          resolve()
        }
        this.handleMessage(message)
      })
      port.start()
      runtimeProcess.on('error', () => fail(new ServerOpsRuntimeError('SERVER_OPS_RUNTIME_FAILED', 'SSH 运行时发生错误')))
      /** Electron UtilityProcess exit 的兼容事件签名。 */
      const processEvents = runtimeProcess as unknown as { on(event: 'exit', listener: (code: number) => void): void }
      processEvents.on('exit', () => {
        if (this.stopping) return
        if (!settled) fail(new ServerOpsRuntimeError('SERVER_OPS_RUNTIME_FAILED', 'SSH 运行时启动失败'))
        else this.handleRuntimeFailure(new ServerOpsRuntimeError('SERVER_OPS_RUNTIME_FAILED', 'SSH 运行时意外退出'))
      })
      runtimeProcess.postMessage({ type: 'proma-server-ops-runtime-port' }, [channel.port1])
    }).finally(() => { this.starting = undefined })
    return this.starting
  }

  /** 分派连接结果、公开错误和流事件。 */
  private handleMessage(message: ServerOpsRuntimeMessage): void {
    if (message.type === 'server-ops.connect-result') {
      /** 对应 requestId 的待处理连接。 */
      const pending = this.pendingConnects.get(message.requestId)
      if (!pending) return
      clearTimeout(pending.timeout)
      this.pendingConnects.delete(message.requestId)
      if (message.result.status === 'connected') this.activeConnections.set(message.connectionId, message.hostId)
      pending.resolve(message.result)
      return
    }
    if (message.type === 'server-ops.error' && message.requestId) {
      /** 对应 requestId 的待处理连接。 */
      const pending = this.pendingConnects.get(message.requestId)
      if (!pending) return
      clearTimeout(pending.timeout)
      this.pendingConnects.delete(message.requestId)
      pending.reject(new ServerOpsRuntimeError(message.code, message.message))
      return
    }
    if (message.type === 'server-ops.terminal-output') {
      for (const listener of this.outputListeners) listener(message.event)
      return
    }
    if (message.type === 'server-ops.terminal-exit') {
      this.activeConnections.delete(message.event.connectionId)
      for (const listener of this.exitListeners) listener(message.event)
    }
  }

  /** runtime 失效后拒绝所有请求并发布公开退出状态。 */
  private handleRuntimeFailure(error: ServerOpsRuntimeError): void {
    this.port?.close()
    this.port = undefined
    this.runtimeProcess = undefined
    this.rejectPending(error)
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
