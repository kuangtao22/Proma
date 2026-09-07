import { Client, type ClientChannel, type ConnectConfig } from 'ssh2'
import { ServerOpsSftpRuntime, ServerOpsSftpRuntimeError } from './server-ops/server-ops-sftp-runtime'
import type { ServerOpsSftpRequest } from './server-ops/server-ops-sftp-runtime'
import type { ServerOpsTerminalExitEvent } from '@proma/shared'
import { ServerOpsConsoleRuntimeController } from './server-ops/server-ops-console-runtime'
import type { ServerOpsConsoleRuntimeChannel } from './server-ops/server-ops-console-runtime'
import {
  acknowledgeRuntimeOutput,
  createHostKeyFingerprint,
  createRuntimeLogStreamController,
  createRuntimeOutputState,
  enqueueRuntimeOutput,
  takeRuntimeOutput,
  appendExecOutput,
  createExecOutputCollector,
  formatExecOutput,
  type RuntimeLogChannel,
  type RuntimeLogStreamController,
  type ServerOpsRuntimeManagedLogStream,
} from './server-ops/server-ops-runtime-core'
import {
  parseServerOpsRuntimeRequest,
  type ServerOpsRuntimeConnectRequest,
  type ServerOpsRuntimeMessage,
  type ServerOpsRuntimeRequest,
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
  execChannels: Set<ClientChannel>
  logStreams: Map<string, ManagedLogStream>
  logController: RuntimeLogStreamController
  /** Docker Console 使用独立 exec PTY，不与主机终端 channel 混用。 */
  consoleController: ServerOpsConsoleRuntimeController<ReturnType<typeof setTimeout>>
  /** 懒建立 SFTP channel，随 SSH 连接统一释放。 */
  sftp: ServerOpsSftpRuntime
}

/** runtime 使用 Node timer 的单条日志流状态。 */
type ManagedLogStream = ServerOpsRuntimeManagedLogStream<ReturnType<typeof setTimeout>>

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

/** 严格解析后处理主进程发来的内部 runtime 请求。 */
function handleRequest(raw: unknown): void {
  /** 未通过 exact-key 与字段边界校验的消息不产生任何 SSH 副作用。 */
  let request: ServerOpsRuntimeRequest
  try {
    request = parseServerOpsRuntimeRequest(raw)
  } catch {
    return
  }
  switch (request.type) {
    case 'server-ops.connect':
      connect(request.input)
      return
    case 'server-ops.exec':
      exec(request.input)
      return
    case 'server-ops.sftp':
      void dispatchSftp(request.input)
      return
    case 'server-ops.disconnect':
      disconnect(request.connectionId, '用户已断开连接')
      return
    case 'server-ops.terminal-input': {
      /** 精确匹配 hostId 与 connectionId 的目标连接。 */
      const connection = connections.get(request.connectionId)
      if (connection?.hostId === request.hostId) connection.channel.write(request.data)
      return
    }
    case 'server-ops.terminal-resize': {
      /** 精确匹配 hostId 与 connectionId 的目标连接。 */
      const connection = connections.get(request.connectionId)
      if (connection?.hostId === request.hostId) connection.channel.setWindow(request.rows, request.cols, 0, 0)
      return
    }
    case 'server-ops.terminal-ack': {
      /** ACK 只允许释放自身连接的在途输出。 */
      const connection = connections.get(request.input.connectionId)
      if (!connection || connection.hostId !== request.input.hostId) return
      if (acknowledgeRuntimeOutput(connection.output, request.input.sequence)) flushOutput(connection)
      emitExitWhenDrained(connection)
      return
    }
    case 'server-ops.console-start': {
      const connection = connections.get(request.input.connectionId)
      if (!connection || connection.hostId !== request.input.hostId) {
        post({ type: 'server-ops.console-exit', event: { ...request.input, message: 'SSH 连接未激活' } })
        return
      }
      connection.consoleController.start(request.input)
      return
    }
    case 'server-ops.console-stop':
      connections.get(request.input.connectionId)?.consoleController.stop(request.input)
      return
    case 'server-ops.console-input':
      connections.get(request.input.connectionId)?.consoleController.write(request.input)
      return
    case 'server-ops.console-resize':
      connections.get(request.input.connectionId)?.consoleController.resize(request.input)
      return
    case 'server-ops.console-ack':
      connections.get(request.input.connectionId)?.consoleController.acknowledge(request.input)
      return
    case 'server-ops.log-start':
      {
        /** 日志启动必须匹配当前连接的完整身份。 */
        const connection = connections.get(request.input.connectionId)
        if (!connection || connection.hostId !== request.input.hostId) {
          post({ type: 'server-ops.log-exit', streamId: request.input.streamId, hostId: request.input.hostId, connectionId: request.input.connectionId, reason: 'error', errorCode: 'SERVER_OPS_CONNECTION_NOT_ACTIVE' })
          return
        }
        connection.logController.start(request.input)
      }
      return
    case 'server-ops.log-stop': {
      /** stop 只允许命中完整日志流身份。 */
      const connection = connections.get(request.connectionId)
      connection?.logController.stop(request)
      return
    }
    case 'server-ops.log-ack': {
      /** ACK 只释放同一 host、connection 与 stream 的当前序号。 */
      const connection = connections.get(request.connectionId)
      connection?.logController.ack(request)
      return
    }
    case 'server-ops.shutdown':
      for (const connectionId of [...connections.keys()]) disconnect(connectionId, '应用正在退出')
      for (const connectionId of [...pendingClients.keys()]) disconnect(connectionId, '应用正在退出', false)
      post({ type: 'server-ops.stopped' })
  }
}

/** 将 SFTP 分派到精确的已认证连接；迟到结果不回流到新连接。 */
async function dispatchSftp(request: ServerOpsSftpRequest): Promise<void> {
  const connection = connections.get(request.connectionId)
  if (!connection || connection.hostId !== request.hostId || connection.exitEvent) {
    post({ type: 'server-ops.sftp-result', hostId: request.hostId, connectionId: request.connectionId, result: { type: 'error', requestId: request.requestId, code: 'SERVER_OPS_CONNECTION_NOT_ACTIVE', outcome: 'not-committed' } })
    return
  }
  try {
    const result = await connection.sftp.dispatch(request)
    if (connections.get(request.connectionId) === connection && !connection.exitEvent) post({ type: 'server-ops.sftp-result', hostId: request.hostId, connectionId: request.connectionId, result })
  } catch (error) {
    if (connections.get(request.connectionId) !== connection || connection.exitEvent) return
    const readOnly = ['list', 'preview', 'stat', 'open-read', 'read', 'close', 'cancel', 'close-owner'].includes(request.type)
    post({ type: 'server-ops.sftp-result', hostId: request.hostId, connectionId: request.connectionId, result: {
      type: 'error', requestId: request.requestId,
      code: error instanceof ServerOpsSftpRuntimeError ? error.code : 'SERVER_OPS_SFTP_FAILED',
      outcome: error instanceof ServerOpsSftpRuntimeError ? error.outcome : readOnly ? 'not-committed' : 'unknown',
    } })
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
      /** 当前连接拥有且由生产控制器直接维护的日志流 Map。 */
      const logStreams = new Map<string, ManagedLogStream>()
      /** 通过窄 adapter 把 ssh2 channel、timer 与消息端口注入可测试控制器。 */
      const logController = createRuntimeLogStreamController<ReturnType<typeof setTimeout>>({
        hostId: input.hostId,
        connectionId: input.connectionId,
        streams: logStreams,
        execute: (command, callback) => {
          client.exec(command, (execError, logChannel) => {
            if (execError) { callback(execError); return }
            callback(undefined, createRuntimeLogChannel(logChannel))
          })
        },
        post,
        setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
        clearTimer: (timer) => clearTimeout(timer),
      })
      /** 每个 SSH 连接拥有独立 Console 控制器与 channel 集合。 */
      const consoleController = new ServerOpsConsoleRuntimeController<ReturnType<typeof setTimeout>>({
        execute: (command, options, callback) => {
          client.exec(command, { pty: options.pty }, (execError, consoleChannel) => {
            if (execError) { callback(execError); return }
            callback(undefined, createRuntimeConsoleChannel(consoleChannel))
          })
        },
        post,
        setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
        clearTimer: (timer) => clearTimeout(timer),
      })
      /** 已完成认证且成功打开 PTY 的连接。 */
      const managed: ManagedSshConnection = {
        hostId: input.hostId,
        connectionId: input.connectionId,
        client,
        channel,
        output: createRuntimeOutputState(),
        execChannels: new Set(),
        logStreams,
        logController,
        consoleController,
        sftp: new ServerOpsSftpRuntime({ hostId: input.hostId, connectionId: input.connectionId, client }),
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
    /** 活跃连接的底层 SSH close 必须同步释放日志、exec 与 PTY。 */
    const activeConnection = connections.get(input.connectionId)
    if (activeConnection?.client === client) closeManagedConnection(activeConnection, 'SSH 连接已关闭')
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

/** 在已认证 SSH 连接上执行无 PTY 命令，限制总输出并返回退出信息。 */
function exec(input: import('./server-ops/server-ops-runtime-protocol').ServerOpsRuntimeExecRequest): void {
  const connection = connections.get(input.connectionId)
  if (!connection || connection.hostId !== input.hostId) {
    post({ type: 'server-ops.error', requestId: input.requestId, hostId: input.hostId, connectionId: input.connectionId, code: 'SERVER_OPS_CONNECTION_NOT_ACTIVE', message: 'SSH 连接未激活' })
    return
  }
  const output = createExecOutputCollector()
  let settled = false
  let channelRef: ClientChannel | undefined
  const finishError = (code: string, message: string): void => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    channelRef?.close()
    post({ type: 'server-ops.error', requestId: input.requestId, hostId: input.hostId, connectionId: input.connectionId, code, message })
  }
  const timer = setTimeout(() => {
    finishError('SERVER_OPS_EXEC_TIMEOUT', '远程命令执行超时')
  }, input.timeoutMs)
  try {
    connection.client.exec(input.command, (error, channel) => {
      if (connections.get(input.connectionId) !== connection) {
        channel?.close()
        return
      }
      if (settled) {
        channel?.close()
        return
      }
      if (error) { finishError('SERVER_OPS_EXEC_FAILED', '远程命令执行失败'); return }
      channelRef = channel
      connection.execChannels.add(channel)
      channel.on('data', (data: Buffer | string) => { appendExecOutput(output, 'stdout', data); if (output.truncated) channel.close() })
      channel.stderr.on('data', (data: Buffer | string) => { appendExecOutput(output, 'stderr', data); if (output.truncated) channel.close() })
      channel.once('close', (code?: number, signal?: string) => {
        connection.execChannels.delete(channel)
        if (settled) return
        settled = true; clearTimeout(timer)
        post({ type: 'server-ops.exec-result', requestId: input.requestId, hostId: input.hostId, connectionId: input.connectionId, result: { ...formatExecOutput(output), ...(typeof code === 'number' ? { exitCode: code } : {}), ...(signal ? { signal } : {}) } })
      })
    })
  } catch {
    finishError('SERVER_OPS_EXEC_FAILED', '远程命令执行失败')
  }
}

/** 把 ssh2 ClientChannel 适配为不泄漏依赖的 core 日志 channel。 */
function createRuntimeLogChannel(channel: ClientChannel): RuntimeLogChannel {
  return {
    onData: (listener) => { channel.on('data', listener) },
    onStderrData: (listener) => { channel.stderr.on('data', listener) },
    onceError: (listener) => { channel.once('error', listener) },
    onceClose: (listener) => { channel.once('close', listener) },
    close: () => { channel.close() },
  }
}

/** 把 ssh2 exec PTY channel 适配为 Docker Console 的窄接口。 */
function createRuntimeConsoleChannel(channel: ClientChannel): ServerOpsConsoleRuntimeChannel {
  return {
    write: (data) => { channel.write(data) },
    setWindow: (rows, cols, height, width) => { channel.setWindow(rows, cols, height, width) },
    onData: (listener) => { channel.on('data', listener) },
    onStderrData: (listener) => { channel.stderr.on('data', listener) },
    onceExit: (listener) => { channel.once('exit', listener) },
    onceClose: (listener) => { channel.once('close', listener) },
    close: () => { channel.close() },
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
  connection.sftp.dispose()
  connection.logController.finishAll('connection-closed')
  connection.consoleController.dispose(message)
  for (const execChannel of connection.execChannels) { try { execChannel.close() } catch { /* exec channel 已关闭时可幂等收束。 */ } }
  connection.execChannels.clear()
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
  connection.sftp.dispose()
  if (connection.flushTimer) clearTimeout(connection.flushTimer)
  connection.logController.finishAll('connection-closed')
  connection.consoleController.dispose(message)
  try { connection.channel.close() } catch { /* channel 已关闭时可幂等收束。 */ }
  for (const execChannel of connection.execChannels) { try { execChannel.close() } catch { /* exec channel 已关闭时可幂等收束。 */ } }
  connection.execChannels.clear()
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
