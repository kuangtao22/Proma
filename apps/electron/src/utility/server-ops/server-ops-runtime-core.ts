import { createHash } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import type { ServerOpsHostKey, ServerOpsTerminalOutputEvent } from '@proma/shared'
import type {
  ServerOpsRuntimeLogExitReason,
  ServerOpsRuntimeLogStartRequest,
  ServerOpsRuntimeMessage,
} from './server-ops-runtime-protocol'

/** SSH runtime 单连接的有界输出状态。 */
export interface ServerOpsRuntimeOutputState {
  maxPendingChars: number
  pending: string
  droppedChars: number
  nextSequence: number
  inFlight?: ServerOpsTerminalOutputEvent
}

/** 创建带硬上限的远程 PTY 输出状态。 */
export function createRuntimeOutputState(maxPendingChars = 1_000_000): ServerOpsRuntimeOutputState {
  if (!Number.isSafeInteger(maxPendingChars) || maxPendingChars < 1) throw new Error('SERVER_OPS_OUTPUT_LIMIT_INVALID')
  return { maxPendingChars, pending: '', droppedChars: 0, nextSequence: 1 }
}

/** 将远程输出追加到有界缓冲，超出部分只累计丢弃计数。 */
export function enqueueRuntimeOutput(state: ServerOpsRuntimeOutputState, data: string): void {
  /** 当前缓冲仍可接收的字符数。 */
  const remaining = state.maxPendingChars - state.pending.length
  if (remaining <= 0) {
    state.droppedChars += data.length
    return
  }
  state.pending += data.length > remaining ? data.slice(0, remaining) : data
  if (data.length > remaining) state.droppedChars += data.length - remaining
}

/** 在没有未确认批次时取出下一批有序输出。 */
export function takeRuntimeOutput(
  state: ServerOpsRuntimeOutputState,
  hostId: string,
  connectionId: string,
): ServerOpsTerminalOutputEvent | undefined {
  if (state.inFlight || (!state.pending && state.droppedChars === 0)) return undefined
  /** 明示输出截断且不包含远程秘密的终端提示。 */
  const lossMarker = state.droppedChars > 0
    ? `\r\n\x1b[33m[Proma：远程终端输出过快，已丢弃 ${state.droppedChars} 个字符]\x1b[0m\r\n`
    : ''
  /** 当前可发送的完整批次。 */
  const event: ServerOpsTerminalOutputEvent = {
    hostId,
    connectionId,
    sequence: state.nextSequence,
    data: state.pending + lossMarker,
  }
  state.nextSequence += 1
  state.pending = ''
  state.droppedChars = 0
  state.inFlight = event
  return event
}

/** 仅精确 ACK 当前在途序号，旧 ACK 不改变状态。 */
export function acknowledgeRuntimeOutput(state: ServerOpsRuntimeOutputState, sequence: number): boolean {
  if (state.inFlight?.sequence !== sequence) return false
  state.inFlight = undefined
  return true
}

/** utility 日志流的单个在途批次。 */
export interface ServerOpsRuntimeLogOutputBatch {
  sequence: number
  data: string
}

/** 独立于 PTY 的 UTF-8 日志输出与 ACK 背压状态。 */
export interface ServerOpsRuntimeLogOutputState {
  maxBatchBytes: number
  stdoutDecoder: StringDecoder
  stderrDecoder: StringDecoder
  pending: string
  pendingBytes: number
  droppedBytes: number
  nextSequence: number
  sequenceExhausted: boolean
  closed: boolean
  inFlight?: ServerOpsRuntimeLogOutputBatch
}

/** 创建每批默认 32 KiB 的日志输出状态。 */
export function createRuntimeLogOutputState(maxBatchBytes = 32 * 1_024): ServerOpsRuntimeLogOutputState {
  if (!Number.isSafeInteger(maxBatchBytes) || maxBatchBytes < 128) throw new Error('SERVER_OPS_LOG_OUTPUT_LIMIT_INVALID')
  return {
    maxBatchBytes,
    stdoutDecoder: new StringDecoder('utf8'),
    stderrDecoder: new StringDecoder('utf8'),
    pending: '',
    pendingBytes: 0,
    droppedBytes: 0,
    nextSequence: 0,
    sequenceExhausted: false,
    closed: false,
  }
}

/** 返回不超过指定 UTF-8 字节数且不拆开 Unicode 字符的前缀。 */
function takeUtf8Prefix(value: string, maxBytes: number): { value: string; bytes: number } {
  if (maxBytes <= 0 || value.length === 0) return { value: '', bytes: 0 }
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return { value, bytes: Buffer.byteLength(value, 'utf8') }
  /** 已保留且一定落在完整 code point 边界的字符。 */
  let prefix = ''
  /** 当前前缀占用的 UTF-8 字节数。 */
  let bytes = 0
  for (const character of value) {
    /** 当前 Unicode 字符的 UTF-8 字节数。 */
    const characterBytes = Buffer.byteLength(character, 'utf8')
    if (bytes + characterBytes > maxBytes) break
    prefix += character
    bytes += characterBytes
  }
  return { value: prefix, bytes }
}

/** 将已经完整解码的文本追加到 32 KiB pending，多余内容只累计字节数。 */
function appendDecodedLogOutput(state: ServerOpsRuntimeLogOutputState, decoded: string): void {
  if (decoded.length === 0) return
  /** 本批 pending 尚可保留的 UTF-8 字节数。 */
  const remaining = state.maxBatchBytes - state.pendingBytes
  /** 输入完整文本的 UTF-8 字节数用于精确累计丢弃量。 */
  const totalBytes = Buffer.byteLength(decoded, 'utf8')
  /** 当前可完整保留且不拆分 Unicode 字符的前缀。 */
  const kept = takeUtf8Prefix(decoded, remaining)
  state.pending += kept.value
  state.pendingBytes += kept.bytes
  state.droppedBytes += totalBytes - kept.bytes
}

/** 增量解码并追加 ssh2 日志数据，支持多字节字符跨 Buffer。 */
export function appendRuntimeLogOutput(
  state: ServerOpsRuntimeLogOutputState,
  data: Buffer | string,
  source: 'stdout' | 'stderr' = 'stdout',
): void {
  if (state.closed) return
  /** 字符串输入同样转换为字节，保证所有入口经过同一增量解码边界。 */
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8')
  /** stdout 与 stderr 必须各自保存未完成的 UTF-8 尾字节。 */
  const decoder = source === 'stdout' ? state.stdoutDecoder : state.stderrDecoder
  appendDecodedLogOutput(state, decoder.write(bytes))
}

/** 结束两路 decoder；自然终态保留完整尾部，强制终态直接丢弃。 */
function closeRuntimeLogOutput(state: ServerOpsRuntimeLogOutputState, retainDecodedTail: boolean): void {
  if (state.closed) return
  /** stdout decoder 收束出的最后文本。 */
  const stdoutTail = state.stdoutDecoder.end()
  /** stderr decoder 收束出的最后文本。 */
  const stderrTail = state.stderrDecoder.end()
  if (retainDecodedTail) {
    appendDecodedLogOutput(state, stdoutTail)
    appendDecodedLogOutput(state, stderrTail)
  }
  state.closed = true
}

/** 在没有未确认批次时取出下一批日志，并把丢弃标记计入 32 KiB 上限。 */
export function takeRuntimeLogOutput(state: ServerOpsRuntimeLogOutputState): ServerOpsRuntimeLogOutputBatch | undefined {
  if (state.inFlight || (state.pendingBytes === 0 && state.droppedBytes === 0)) return undefined
  if (state.sequenceExhausted) throw new Error('SERVER_OPS_LOG_SEQUENCE_EXHAUSTED')
  /** 发送数据会在丢弃计数变化后重新裁切，直至标记长度稳定。 */
  let kept = { value: state.pending, bytes: state.pendingBytes }
  /** 本批最终报告的丢弃字节数。 */
  let reportedDroppedBytes = state.droppedBytes
  /** 固定中文丢弃标记放在真实数据前，确保用户先看到缺口。 */
  let lossMarker = ''
  if (reportedDroppedBytes > 0) {
    for (;;) {
      lossMarker = `[Proma：日志输出过快，已丢弃 ${reportedDroppedBytes} 字节]\n`
      /** 丢弃标记后可保留的真实日志字节数。 */
      const availableBytes = Math.max(0, state.maxBatchBytes - Buffer.byteLength(lossMarker, 'utf8'))
      /** 按最新标记长度重新计算的安全日志前缀。 */
      const nextKept = takeUtf8Prefix(state.pending, availableBytes)
      /** 因标记占用空间而从 pending 尾部丢弃的字节数。 */
      const trimmedBytes = state.pendingBytes - nextKept.bytes
      kept = nextKept
      if (state.droppedBytes + trimmedBytes === reportedDroppedBytes) break
      reportedDroppedBytes = state.droppedBytes + trimmedBytes
    }
  }
  /** 当前可发送且等待精确 ACK 的日志批次。 */
  const batch: ServerOpsRuntimeLogOutputBatch = {
    sequence: state.nextSequence,
    data: lossMarker + kept.value,
  }
  if (state.nextSequence === Number.MAX_SAFE_INTEGER) state.sequenceExhausted = true
  else state.nextSequence += 1
  state.pending = ''
  state.pendingBytes = 0
  state.droppedBytes = 0
  state.inFlight = batch
  return batch
}

/** 仅精确 ACK 当前日志批次，旧序号与未来序号均无副作用。 */
export function acknowledgeRuntimeLogOutput(state: ServerOpsRuntimeLogOutputState, sequence: number): boolean {
  if (state.inFlight?.sequence !== sequence) return false
  state.inFlight = undefined
  return true
}

/** 与 ssh2 解耦的最小日志 channel 接口。 */
export interface RuntimeLogChannel {
  /** 订阅 stdout 数据。 */
  onData(listener: (data: Buffer | string) => void): void
  /** 订阅 stderr 数据。 */
  onStderrData(listener: (data: Buffer | string) => void): void
  /** 订阅单次 channel 错误。 */
  onceError(listener: () => void): void
  /** 订阅单次 channel 关闭。 */
  onceClose(listener: () => void): void
  /** 主动关闭 channel。 */
  close(): void
}

/** 异步 exec 创建日志 channel 时使用的回调。 */
export type RuntimeLogStreamExecCallback = (error?: Error, channel?: RuntimeLogChannel) => void

/** 单条日志流的完整生产状态。 */
export interface ServerOpsRuntimeManagedLogStream<TTimer> {
  streamId: string
  hostId: string
  connectionId: string
  output: ServerOpsRuntimeLogOutputState
  channel?: RuntimeLogChannel
  flushTimer?: TTimer
  terminalState?: RuntimeLogStreamTerminalState
  exited: boolean
}

/** 自然关闭后等待输出按 ACK 排空的日志终态。 */
export interface RuntimeLogStreamTerminalState {
  reason: 'remote-exit' | 'error'
  errorCode?: string
}

/** 日志控制器依赖，只暴露 exec、消息与 timer 三类副作用。 */
export interface RuntimeLogStreamControllerOptions<TTimer> {
  hostId: string
  connectionId: string
  streams: Map<string, ServerOpsRuntimeManagedLogStream<TTimer>>
  /** 请求 SSH client 创建独立无 PTY channel。 */
  execute(command: string, callback: RuntimeLogStreamExecCallback): void
  /** 发布严格类型化的 runtime 消息。 */
  post(message: ServerOpsRuntimeMessage): void
  /** 注册可取消的日志 flush timer。 */
  setTimer(callback: () => void, delayMs: number): TTimer
  /** 取消尚未执行的日志 flush timer。 */
  clearTimer(timer: TTimer): void
}

/** 日志 stop 与 ACK 使用的完整内部身份。 */
export interface RuntimeLogStreamIdentity {
  streamId: string
  hostId: string
  connectionId: string
}

/** 日志 ACK 在完整身份上增加 Shared 兼容序号。 */
export interface RuntimeLogStreamAck extends RuntimeLogStreamIdentity {
  sequence: number
}

/** runtime 实际委托的日志流生产状态机。 */
export interface RuntimeLogStreamController {
  /** 启动一条绑定当前连接身份的日志流。 */
  start(input: ServerOpsRuntimeLogStartRequest): void
  /** 按完整身份幂等停止一条日志流。 */
  stop(identity: RuntimeLogStreamIdentity): void
  /** 精确确认当前在途批次并尝试发送下一批。 */
  ack(input: RuntimeLogStreamAck): boolean
  /** 同步结束当前连接上的全部日志流。 */
  finishAll(reason: ServerOpsRuntimeLogExitReason): void
}

/** 创建绑定单个 SSH connection generation 的日志流控制器。 */
export function createRuntimeLogStreamController<TTimer>(
  options: RuntimeLogStreamControllerOptions<TTimer>,
): RuntimeLogStreamController {
  /** 判断请求是否精确属于当前控制器连接。 */
  const matchesConnection = (identity: RuntimeLogStreamIdentity): boolean => (
    identity.hostId === options.hostId && identity.connectionId === options.connectionId
  )

  /** 清理输出状态，保证未 ACK 数据不阻塞连接释放。 */
  const clearOutput = (stream: ServerOpsRuntimeManagedLogStream<TTimer>): void => {
    closeRuntimeLogOutput(stream.output, false)
    stream.output.pending = ''
    stream.output.pendingBytes = 0
    stream.output.droppedBytes = 0
    stream.output.inFlight = undefined
    stream.output.closed = true
  }

  /** 输出完全排空后发布等待中的自然终态。 */
  const finishWhenDrained = (stream: ServerOpsRuntimeManagedLogStream<TTimer>): void => {
    if (!stream.terminalState || stream.output.inFlight || stream.output.pendingBytes > 0 || stream.output.droppedBytes > 0) return
    finish(stream, stream.terminalState.reason, stream.terminalState.errorCode, false)
  }

  /** 幂等结束一条流并只发布一次稳定终态。 */
  const finish = (
    stream: ServerOpsRuntimeManagedLogStream<TTimer>,
    reason: ServerOpsRuntimeLogExitReason,
    errorCode?: string,
    closeChannel = false,
  ): void => {
    if (stream.exited || options.streams.get(stream.streamId) !== stream) return
    stream.exited = true
    options.streams.delete(stream.streamId)
    if (stream.flushTimer !== undefined) options.clearTimer(stream.flushTimer)
    stream.flushTimer = undefined
    clearOutput(stream)
    if (closeChannel) {
      try { stream.channel?.close() } catch { /* 已关闭 channel 由幂等终态吸收。 */ }
    }
    options.post({
      type: 'server-ops.log-exit',
      streamId: stream.streamId,
      hostId: stream.hostId,
      connectionId: stream.connectionId,
      reason,
      ...(errorCode ? { errorCode } : {}),
    })
  }

  /** 尝试发送当前日志流的下一批，序号耗尽时稳定终止。 */
  const flush = (stream: ServerOpsRuntimeManagedLogStream<TTimer>): void => {
    if (stream.flushTimer !== undefined) options.clearTimer(stream.flushTimer)
    stream.flushTimer = undefined
    if (stream.exited) return
    try {
      /** 当前可发送并等待精确 ACK 的日志批次。 */
      const batch = takeRuntimeLogOutput(stream.output)
      if (batch) {
        options.post({
          type: 'server-ops.log-chunk',
          streamId: stream.streamId,
          hostId: stream.hostId,
          connectionId: stream.connectionId,
          sequence: batch.sequence,
          data: batch.data,
        })
        return
      }
    } catch (error) {
      if (error instanceof Error && error.message === 'SERVER_OPS_LOG_SEQUENCE_EXHAUSTED') {
        finish(stream, 'error', 'SERVER_OPS_LOG_SEQUENCE_EXHAUSTED', true)
        return
      }
      throw error
    }
    finishWhenDrained(stream)
  }

  /** 将自然 close/error 转为等待 ACK 排空的终态。 */
  const beginDraining = (
    stream: ServerOpsRuntimeManagedLogStream<TTimer>,
    reason: RuntimeLogStreamTerminalState['reason'],
    errorCode?: string,
    closeChannel = false,
  ): void => {
    if (stream.exited || stream.terminalState || options.streams.get(stream.streamId) !== stream) return
    stream.terminalState = { reason, ...(errorCode ? { errorCode } : {}) }
    if (stream.flushTimer !== undefined) options.clearTimer(stream.flushTimer)
    stream.flushTimer = undefined
    closeRuntimeLogOutput(stream.output, true)
    if (closeChannel) {
      try { stream.channel?.close() } catch { /* error 后关闭失败仍继续排空已接收输出。 */ }
    }
    flush(stream)
  }

  /** 追加 channel 数据并应用 50ms 或 32 KiB flush 规则。 */
  const enqueue = (stream: ServerOpsRuntimeManagedLogStream<TTimer>, data: Buffer | string, source: 'stdout' | 'stderr'): void => {
    if (stream.exited || stream.terminalState) return
    appendRuntimeLogOutput(stream.output, data, source)
    if (stream.output.pendingBytes >= stream.output.maxBatchBytes) {
      flush(stream)
      return
    }
    if (stream.flushTimer === undefined) {
      stream.flushTimer = options.setTimer(() => flush(stream), 50)
    }
  }

  return {
    /** 启动并登记日志流，callback 成功绑定监听器后才发布 started。 */
    start(input): void {
      if (!matchesConnection(input)) {
        options.post({ type: 'server-ops.log-exit', streamId: input.streamId, hostId: input.hostId, connectionId: input.connectionId, reason: 'error', errorCode: 'SERVER_OPS_CONNECTION_NOT_ACTIVE' })
        return
      }
      if (options.streams.has(input.streamId)) return
      /** callback 完成前登记的 pending stream，使 stop 与 finishAll 可取消启动。 */
      const stream: ServerOpsRuntimeManagedLogStream<TTimer> = {
        streamId: input.streamId,
        hostId: input.hostId,
        connectionId: input.connectionId,
        output: createRuntimeLogOutputState(),
        exited: false,
      }
      options.streams.set(input.streamId, stream)
      try {
        options.execute(input.command, (error, channel) => {
          if (options.streams.get(input.streamId) !== stream || stream.exited) {
            try { channel?.close() } catch { /* 迟到 channel 只需 best-effort 释放。 */ }
            return
          }
          if (error || !channel) {
            finish(stream, 'error', 'SERVER_OPS_LOG_START_FAILED', false)
            return
          }
          stream.channel = channel
          channel.onData((data) => enqueue(stream, data, 'stdout'))
          channel.onStderrData((data) => enqueue(stream, data, 'stderr'))
          channel.onceError(() => beginDraining(stream, 'error', 'SERVER_OPS_LOG_STREAM_FAILED', true))
          channel.onceClose(() => beginDraining(stream, 'remote-exit', undefined, false))
          options.post({ type: 'server-ops.log-started', streamId: stream.streamId, hostId: stream.hostId, connectionId: stream.connectionId })
        })
      } catch {
        finish(stream, 'error', 'SERVER_OPS_LOG_START_FAILED', false)
      }
    },
    /** 按完整身份幂等停止一条日志流。 */
    stop(identity): void {
      if (!matchesConnection(identity)) return
      /** stop 只能命中完整 stream identity。 */
      const stream = options.streams.get(identity.streamId)
      if (stream) finish(stream, 'stopped', undefined, true)
    },
    /** 仅精确 ACK 当前在途序号并触发下一批。 */
    ack(input): boolean {
      if (!matchesConnection(input)) return false
      /** ACK 只能命中完整 stream identity。 */
      const stream = options.streams.get(input.streamId)
      if (!stream || !acknowledgeRuntimeLogOutput(stream.output, input.sequence)) return false
      flush(stream)
      return true
    },
    /** 同步清理 Map 内所有日志流，未 ACK 输出不会阻塞返回。 */
    finishAll(reason): void {
      /** 快照避免 finish 删除 Map 时影响迭代。 */
      const streams = [...options.streams.values()]
      for (const stream of streams) finish(stream, reason, undefined, true)
    },
  }
}

/** 从 SSH wire-format public key 提取算法并生成 OpenSSH SHA-256 指纹。 */
export function createHostKeyFingerprint(key: Buffer): ServerOpsHostKey {
  if (key.length < 5) throw new Error('SERVER_OPS_HOST_KEY_INVALID')
  /** wire-format 第一个 SSH string 的算法字节数。 */
  const algorithmLength = key.readUInt32BE(0)
  if (algorithmLength < 1 || algorithmLength > 128 || key.length < 4 + algorithmLength) {
    throw new Error('SERVER_OPS_HOST_KEY_INVALID')
  }
  /** SSH 协议声明的 Host Key 算法名。 */
  const algorithm = key.subarray(4, 4 + algorithmLength).toString('utf8')
  if (!/^[A-Za-z0-9@._+-]+$/.test(algorithm)) throw new Error('SERVER_OPS_HOST_KEY_INVALID')
  /** OpenSSH 显示格式不保留 base64 padding。 */
  const digest = createHash('sha256').update(key).digest('base64').replace(/=+$/u, '')
  return { algorithm, fingerprint: `SHA256:${digest}` }
}

/** 按平台选择 ssh2 支持的 SSH Agent endpoint。 */
export function resolveSshAgent(platform: NodeJS.Platform, environment: NodeJS.ProcessEnv): string {
  /** OpenSSH Agent 的 Unix socket 或 Windows named pipe。 */
  const socket = environment.SSH_AUTH_SOCK?.trim()
  if (socket) return socket
  if (platform === 'win32') return 'pageant'
  throw new Error('SERVER_OPS_SSH_AGENT_UNAVAILABLE')
}

/** 结构化 exec 输出收集器，按 UTF-8 字节限制总大小并在边界截断。 */
export interface ServerOpsExecOutputCollector {
  stdout: Buffer[]
  stderr: Buffer[]
  bytes: number
  truncated: boolean
}

/** 创建空的 exec 输出收集器。 */
export function createExecOutputCollector(): ServerOpsExecOutputCollector {
  return { stdout: [], stderr: [], bytes: 0, truncated: false }
}

/** 追加一段输出，避免在多字节 UTF-8 中间切片。 */
export function appendExecOutput(collector: ServerOpsExecOutputCollector, stream: 'stdout' | 'stderr', data: Buffer | string): void {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data)
  const remaining = 1_048_576 - collector.bytes
  if (remaining <= 0) { collector.truncated = true; return }
  let chunk = bytes.length <= remaining ? bytes : bytes.subarray(0, remaining)
  if (chunk.length < bytes.length) {
    let start = chunk.length - 1
    while (start > 0 && (chunk[start]! & 0xc0) === 0x80) start -= 1
    const lead = chunk[start]!
    const width = lead < 0x80 ? 1 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : 4
    if (chunk.length - start < width) chunk = chunk.subarray(0, start)
  }
  const target = stream === 'stdout' ? collector.stdout : collector.stderr
  target.push(Buffer.from(chunk))
  collector.bytes += chunk.length
  if (chunk.length < bytes.length) collector.truncated = true
}

/** 将 exec 输出收集器转换为公开字符串结果。 */
export function formatExecOutput(collector: ServerOpsExecOutputCollector): { stdout: string; stderr: string; truncated: boolean } {
  return {
    stdout: Buffer.concat(collector.stdout).toString('utf8'),
    stderr: Buffer.concat(collector.stderr).toString('utf8'),
    truncated: collector.truncated,
  }
}
