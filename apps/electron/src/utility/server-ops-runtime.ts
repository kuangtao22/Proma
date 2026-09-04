import { Client, type ClientChannel, type ConnectConfig } from 'ssh2'
import type { ServerOpsTerminalExitEvent } from '@proma/shared'
import {
  acknowledgeRuntimeOutput,
  createHostKeyFingerprint,
  createRuntimeOutputState,
  enqueueRuntimeOutput,
  takeRuntimeOutput,
} from './server-ops/server-ops-runtime-core'
import type {
  ServerOpsRuntimeConnectRequest,
  ServerOpsRuntimeMessage,
  ServerOpsRuntimeRequest,
} from './server-ops/server-ops-runtime-protocol'

/** Electron utility process MessagePort 的最小接口。 */
interface RuntimePort {
  on(event: 'message', listener: (event: { data: unknown }) => void): void
  postMessage(message: ServerOpsRuntimeMessage): void
  start(): void
  close(): void
}

/** Electron utility process parentPort 的最小接口。 */
interface RuntimeParentPort {
  on(event: 'message', listener: (event: { data: unknown; ports?: RuntimePort[] }) => void): void
  start?: () => void
}

/** 单条活跃 SSH 连接及其唯一 PTY channel。 */
interface ManagedSshConnection {
  hostId: string
  connectionId: string
  client: Client
  channel: ClientChannel
  output: ReturnType<typeof createRuntimeOutputState>
  flushTimer?: ReturnType<typeof setTimeout>
  exitEvent?: ServerOpsTerminalExitEvent
}

/** 单连接输出合批延迟。 */
const OUTPUT_FLUSH_DELAY_MS = 16
/** 当前 runtime 管理的全部 SSH 连接。 */
const connections = new Map<string, ManagedSshConnection>()
/** 尚在握手或认证阶段、还未创建 PTY 的 SSH client。 */
const pendingClients = new Map<string, Client>()
/** Electron 注入的父进程消息端口。 */
const parentPort = (process as typeof process & { parentPort?: RuntimeParentPort }).parentPort
/** 主进程传入的专用 MessagePort。 */
let runtimePort: RuntimePort | undefined

if (!parentPort) {
  console.error('[ServerOpsRuntime] Electron parentPort 不可用')
  process.exit(1)
}

parentPort.on('message', (event) => {
  /** Electron 不同版本下 bootstrap payload 的兼容形态。 */
  const value = event?.data as Record<string, unknown> | undefined
  /** utilityProcess.postMessage 可能把实际 data 再包一层。 */
  const transfer = value?.data && typeof value.data === 'object' ? value.data as Record<string, unknown> : value
  if (!transfer || transfer.type !== 'proma-server-ops-runtime-port') return
  /** bootstrap 消息附带的专用端口。 */
  const port = event.ports?.[0] ?? value?.port as RuntimePort | undefined
  if (!port) {
    console.error('[ServerOpsRuntime] MessagePort bootstrap 消息无效')
    process.exit(1)
  }
  runtimePort?.close()
  runtimePort = port
  port.on('message', (message) => handleRequest(message.data))
  port.start()
  post({ type: 'server-ops.ready', pid: process.pid })
})
parentPort.start?.()

/** 处理已经过主进程严格解析的内部 runtime 请求。 */
function handleRequest(raw: unknown): void {
  if (!isRuntimeRequest(raw)) return
  switch (raw.type) {
    case 'server-ops.connect':
      connect(raw.input)
      return
    case 'server-ops.disconnect':
      disconnect(raw.connectionId, '用户已断开连接')
      return
    case 'server-ops.terminal-input': {
      /** 精确匹配 hostId 与 connectionId 的目标连接。 */
      const connection = connections.get(raw.connectionId)
      if (connection?.hostId === raw.hostId) connection.channel.write(raw.data)
      return
    }
    case 'server-ops.terminal-resize': {
      /** 精确匹配 hostId 与 connectionId 的目标连接。 */
      const connection = connections.get(raw.connectionId)
      if (connection?.hostId === raw.hostId) connection.channel.setWindow(raw.rows, raw.cols, 0, 0)
      return
    }
    case 'server-ops.terminal-ack': {
      /** ACK 只允许释放自身连接的在途输出。 */
      const connection = connections.get(raw.input.connectionId)
      if (!connection || connection.hostId !== raw.input.hostId) return
      if (acknowledgeRuntimeOutput(connection.output, raw.input.sequence)) flushOutput(connection)
      emitExitWhenDrained(connection)
      return
    }
    case 'server-ops.shutdown':
      for (const connectionId of [...connections.keys()]) disconnect(connectionId, '应用正在退出')
      for (const connectionId of [...pendingClients.keys()]) disconnect(connectionId, '应用正在退出', false)
      post({ type: 'server-ops.stopped' })
  }
}

/** 建立 SSH、验证 Host Key，并在认证成功后创建交互 PTY。 */
function connect(input: ServerOpsRuntimeConnectRequest): void {
  disconnect(input.connectionId, '连接已替换', false)
  /** 本次连接的 ssh2 client。 */
  const client = new Client()
  pendingClients.set(input.connectionId, client)
  /** Host verifier 观测到的公开 Host Key。 */
  let observedHostKey: ReturnType<typeof createHostKeyFingerprint> | undefined
  /** 防止 error、close 和 shell callback 重复完成连接请求。 */
  let settled = false

  /** 只发送一次连接结果或公开错误。 */
  const finish = (message: ServerOpsRuntimeMessage): void => {
    if (settled) return
    settled = true
    if (message.type !== 'server-ops.connect-result' || message.result.status !== 'connected') {
      pendingClients.delete(input.connectionId)
    }
    post(message)
  }

  client.once('ready', () => {
    if (!observedHostKey) {
      finish(createErrorMessage(input, 'SERVER_OPS_HOST_KEY_INVALID', '服务器身份校验失败'))
      client.destroy()
      return
    }
    /** 在异步 shell callback 前固化已校验的 Host Key。 */
    const verifiedHostKey = observedHostKey
    client.shell({ term: 'xterm-256color', cols: input.cols, rows: input.rows }, (error, channel) => {
      if (error) {
        finish(createErrorMessage(input, 'SERVER_OPS_PTY_FAILED', '远程终端创建失败'))
        client.end()
        return
      }
      /** 已完成认证且成功打开 PTY 的连接。 */
      const managed: ManagedSshConnection = {
        hostId: input.hostId,
        connectionId: input.connectionId,
        client,
        channel,
        output: createRuntimeOutputState(),
      }
      connections.set(input.connectionId, managed)
      pendingClients.delete(input.connectionId)
      channel.on('data', (data: Buffer | string) => enqueueOutput(managed, data.toString()))
      channel.stderr.on('data', (data: Buffer | string) => enqueueOutput(managed, data.toString()))
      channel.on('exit', (code: number | null, signal?: string) => {
        managed.exitEvent = {
          hostId: input.hostId,
          connectionId: input.connectionId,
          ...(typeof code === 'number' ? { exitCode: code } : {}),
          ...(signal ? { signal } : {}),
          message: '远程终端已退出',
        }
      })
      channel.once('close', () => closeManagedConnection(managed, managed.exitEvent?.message ?? '远程终端已关闭'))
      finish({
        type: 'server-ops.connect-result',
        requestId: input.requestId,
        hostId: input.hostId,
        connectionId: input.connectionId,
        result: { status: 'connected', hostKey: verifiedHostKey },
      })
    })
  })

  client.once('error', (error: Error & { level?: string; code?: string }) => {
    if (!settled && observedHostKey && !matchesExpectedHostKey(observedHostKey, input.expectedHostKey)) {
      finish({
        type: 'server-ops.connect-result',
        requestId: input.requestId,
        hostId: input.hostId,
        connectionId: input.connectionId,
        result: { status: 'host-key-rejected', observedHostKey },
      })
      return
    }
    if (!settled) {
      /** 对外只暴露稳定错误码和中文消息，避免泄露路径与底层堆栈。 */
      const mapped = mapSshError(error)
      finish(createErrorMessage(input, mapped.code, mapped.message))
    }
  })
  client.once('close', () => {
    pendingClients.delete(input.connectionId)
    if (!settled && observedHostKey && !matchesExpectedHostKey(observedHostKey, input.expectedHostKey)) {
      finish({
        type: 'server-ops.connect-result',
        requestId: input.requestId,
        hostId: input.hostId,
        connectionId: input.connectionId,
        result: { status: 'host-key-rejected', observedHostKey },
      })
    } else if (!settled) {
      finish(createErrorMessage(input, 'SERVER_OPS_CONNECTION_CLOSED', 'SSH 连接在登录前关闭'))
    }
  })

  try {
    client.connect(createConnectConfig(input, (key) => {
      observedHostKey = createHostKeyFingerprint(key)
      return matchesExpectedHostKey(observedHostKey, input.expectedHostKey)
    }))
  } catch (error) {
    /** 同步配置错误同样只映射为公开错误。 */
    const mapped = mapSshError(error)
    finish(createErrorMessage(input, mapped.code, mapped.message))
  }
}

/** 构造 ssh2 配置，秘密不进入 argv、环境变量或日志。 */
function createConnectConfig(input: ServerOpsRuntimeConnectRequest, hostVerifier: (key: Buffer) => boolean): ConnectConfig {
  /** 所有认证方式共享的连接安全选项。 */
  const base: ConnectConfig = {
    host: input.address,
    port: input.port,
    username: input.username,
    hostVerifier,
    readyTimeout: 15_000,
    keepaliveInterval: 15_000,
    keepaliveCountMax: 3,
  }
  if (input.authentication.kind === 'password') return { ...base, password: input.authentication.password }
  if (input.authentication.kind === 'private-key') {
    return {
      ...base,
      privateKey: Buffer.from(input.authentication.privateKey),
      ...(input.authentication.passphrase === undefined ? {} : { passphrase: input.authentication.passphrase }),
    }
  }
  return { ...base, agent: input.authentication.agent }
}

/** 判断观测 Host Key 是否与已固定值逐字段相同。 */
function matchesExpectedHostKey(
  observed: ReturnType<typeof createHostKeyFingerprint>,
  expected: ServerOpsRuntimeConnectRequest['expectedHostKey'],
): boolean {
  return expected !== undefined && observed.algorithm === expected.algorithm && observed.fingerprint === expected.fingerprint
}

/** 追加并在 16ms 后批量发送远程终端输出。 */
function enqueueOutput(connection: ManagedSshConnection, data: string): void {
  enqueueRuntimeOutput(connection.output, data)
  if (!connection.flushTimer) connection.flushTimer = setTimeout(() => flushOutput(connection), OUTPUT_FLUSH_DELAY_MS)
}

/** 尝试发送下一批输出；已有在途批次时由 ACK 再触发。 */
function flushOutput(connection: ManagedSshConnection): void {
  if (connection.flushTimer) clearTimeout(connection.flushTimer)
  connection.flushTimer = undefined
  /** 当前可发送的下一批远程输出。 */
  const event = takeRuntimeOutput(connection.output, connection.hostId, connection.connectionId)
  if (event) post({ type: 'server-ops.terminal-output', event })
}

/** 仅在输出全部被 Renderer ACK 后发布最终退出事件。 */
function emitExitWhenDrained(connection: ManagedSshConnection): void {
  if (!connection.exitEvent || connection.output.inFlight || connection.output.pending || connection.output.droppedChars > 0) return
  connections.delete(connection.connectionId)
  post({ type: 'server-ops.terminal-exit', event: connection.exitEvent })
}

/** 收束已关闭 channel 的输出、连接和退出事件。 */
function closeManagedConnection(connection: ManagedSshConnection, message: string): void {
  if (connections.get(connection.connectionId) !== connection) return
  flushOutput(connection)
  connection.exitEvent ??= { hostId: connection.hostId, connectionId: connection.connectionId, message }
  connection.client.end()
  emitExitWhenDrained(connection)
}

/** 主动断开指定连接并释放 channel、socket 与 timer。 */
function disconnect(connectionId: string, message: string, notify = true): void {
  /** 待断开的活跃连接。 */
  const connection = connections.get(connectionId)
  if (!connection) {
    /** 握手中的连接也必须能被取消和退出清理。 */
    const pending = pendingClients.get(connectionId)
    if (pending) {
      pendingClients.delete(connectionId)
      pending.destroy()
    }
    return
  }
  connections.delete(connectionId)
  if (connection.flushTimer) clearTimeout(connection.flushTimer)
  try { connection.channel.close() } catch { /* channel 已关闭时可幂等收束。 */ }
  connection.client.end()
  if (notify) post({ type: 'server-ops.terminal-exit', event: { hostId: connection.hostId, connectionId, message } })
}

/** 将底层 SSH 异常收敛为不含秘密的稳定公开错误。 */
function mapSshError(error: unknown): { code: string; message: string } {
  /** ssh2 常见错误只读取分类字段，不返回原始 message。 */
  const classified = error as { level?: unknown; code?: unknown }
  if (classified.level === 'client-authentication') return { code: 'SERVER_OPS_AUTH_FAILED', message: 'SSH 认证失败，请检查登录信息' }
  if (classified.code === 'ETIMEDOUT' || classified.level === 'client-timeout') return { code: 'SERVER_OPS_CONNECTION_TIMEOUT', message: 'SSH 连接超时' }
  if (classified.code === 'ENOTFOUND' || classified.code === 'ECONNREFUSED' || classified.code === 'EHOSTUNREACH') {
    return { code: 'SERVER_OPS_NETWORK_UNREACHABLE', message: '无法连接服务器，请检查地址、端口和网络' }
  }
  return { code: 'SERVER_OPS_CONNECTION_FAILED', message: 'SSH 连接失败' }
}

/** 构造绑定请求和连接归属的 runtime 错误消息。 */
function createErrorMessage(input: ServerOpsRuntimeConnectRequest, code: string, message: string): ServerOpsRuntimeMessage {
  return { type: 'server-ops.error', requestId: input.requestId, hostId: input.hostId, connectionId: input.connectionId, code, message }
}

/** 通过专用 MessagePort 向主进程发送结构化消息。 */
function post(message: ServerOpsRuntimeMessage): void {
  runtimePort?.postMessage(message)
}

/** runtime 只接受已知类型与基本结构完整的消息。 */
function isRuntimeRequest(value: unknown): value is ServerOpsRuntimeRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  /** 待判定消息的类型字段。 */
  const type = (value as { type?: unknown }).type
  return type === 'server-ops.connect'
    || type === 'server-ops.disconnect'
    || type === 'server-ops.terminal-input'
    || type === 'server-ops.terminal-resize'
    || type === 'server-ops.terminal-ack'
    || type === 'server-ops.shutdown'
}
