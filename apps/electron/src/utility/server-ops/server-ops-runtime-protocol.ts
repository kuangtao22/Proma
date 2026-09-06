import { Buffer } from 'node:buffer'
import type { ServerOpsHostKey, ServerOpsTerminalExitEvent, ServerOpsTerminalOutputAck, ServerOpsTerminalOutputEvent } from '@proma/shared'

/** utility process 接收的 SSH 认证材料。 */
export type ServerOpsRuntimeAuthentication =
  | { kind: 'password'; password: string }
  | { kind: 'private-key'; privateKey: Uint8Array; passphrase?: string }
  | { kind: 'ssh-agent'; agent: string }

/** 主进程发往 runtime 的真实连接请求。 */
export interface ServerOpsRuntimeConnectRequest {
  requestId: string
  hostId: string
  connectionId: string
  address: string
  port: number
  username: string
  expectedHostKey?: ServerOpsHostKey
  authentication: ServerOpsRuntimeAuthentication
  cols: number
  rows: number
}
export interface ServerOpsRuntimeExecRequest {
  requestId: string
  hostId: string
  connectionId: string
  command: string
  timeoutMs: number
}
export interface ServerOpsRuntimeExecResult {
  stdout: string
  stderr: string
  exitCode?: number
  signal?: string
  truncated: boolean
}
/** utility process 内部启动独立日志 channel 的请求。 */
export interface ServerOpsRuntimeLogStartRequest {
  streamId: string
  hostId: string
  connectionId: string
  command: string
}
/** 日志流结束时由 utility process 返回的稳定原因。 */
export type ServerOpsRuntimeLogExitReason = 'stopped' | 'connection-closed' | 'remote-exit' | 'error'

/** runtime 在认证前拒绝或成功打开 PTY 的结果。 */
export type ServerOpsRuntimeConnectResult =
  | { status: 'host-key-rejected'; observedHostKey: ServerOpsHostKey }
  | { status: 'connected'; hostKey: ServerOpsHostKey }

/** 主进程发往 SSH runtime 的内部消息。 */
export type ServerOpsRuntimeRequest =
  | { type: 'server-ops.connect'; input: ServerOpsRuntimeConnectRequest }
  | { type: 'server-ops.exec'; input: ServerOpsRuntimeExecRequest }
  | { type: 'server-ops.disconnect'; hostId: string; connectionId: string }
  | { type: 'server-ops.terminal-input'; hostId: string; connectionId: string; data: string }
  | { type: 'server-ops.terminal-resize'; hostId: string; connectionId: string; cols: number; rows: number }
  | { type: 'server-ops.terminal-ack'; input: ServerOpsTerminalOutputAck }
  | { type: 'server-ops.log-start'; input: ServerOpsRuntimeLogStartRequest }
  | { type: 'server-ops.log-stop'; streamId: string; hostId: string; connectionId: string }
  | { type: 'server-ops.log-ack'; streamId: string; hostId: string; connectionId: string; sequence: number }
  | { type: 'server-ops.shutdown' }

/** SSH runtime 发回主进程的内部消息。 */
export type ServerOpsRuntimeMessage =
  | { type: 'server-ops.ready'; pid: number }
  | { type: 'server-ops.connect-result'; requestId: string; hostId: string; connectionId: string; result: ServerOpsRuntimeConnectResult }
  | { type: 'server-ops.exec-result'; requestId: string; hostId: string; connectionId: string; result: ServerOpsRuntimeExecResult }
  | { type: 'server-ops.error'; requestId?: string; hostId: string; connectionId: string; code: string; message: string }
  | { type: 'server-ops.terminal-output'; event: ServerOpsTerminalOutputEvent }
  | { type: 'server-ops.terminal-exit'; event: ServerOpsTerminalExitEvent }
  | { type: 'server-ops.log-started'; streamId: string; hostId: string; connectionId: string }
  | { type: 'server-ops.log-chunk'; streamId: string; hostId: string; connectionId: string; sequence: number; data: string }
  | { type: 'server-ops.log-exit'; streamId: string; hostId: string; connectionId: string; reason: ServerOpsRuntimeLogExitReason; errorCode?: string }
  | { type: 'server-ops.stopped' }

/** 单条终端输入允许跨进程传输的最大字符数。 */
const MAX_TERMINAL_INPUT_LENGTH = 65_536
/** 单条终端输出包含截断提示时允许跨进程传输的最大字符数。 */
const MAX_TERMINAL_OUTPUT_LENGTH = 1_048_832
/** exec stdout 与 stderr 合计允许跨进程传输的最大字符数。 */
const MAX_EXEC_OUTPUT_LENGTH = 1_048_576
/** 单批日志跨进程传输的 UTF-8 字节硬上限。 */
const MAX_LOG_CHUNK_BYTES = 32 * 1_024

/** 判断未知值是否为可按 exact-key 合同读取的对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 判断对象字段是否与当前 union 分支完全一致。 */
function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isRecord(value)) return false
  /** 排序后的实际字段用于同时拒绝缺失字段与未知字段。 */
  const actualKeys = Object.keys(value).sort()
  /** 排序后的合同字段不依赖调用方声明顺序。 */
  const expectedKeys = [...keys].sort()
  return actualKeys.length === expectedKeys.length && actualKeys.every((key, index) => key === expectedKeys[index])
}

/** 判断跨进程 ID 是否为可安全用于 Map key 的规范字符串。 */
function isRuntimeId(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 128 && /^[A-Za-z0-9_-]+$/u.test(value)
}

/** 判断远程端口是否位于 TCP 有效范围。 */
function isPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65_535
}

/** 判断终端行列是否为 ssh2 可接受的有界正整数。 */
function isTerminalDimension(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 1_000
}

/** 判断 SSH 地址或用户名是否为不含空白与 NUL 的有界文本。 */
function isConnectionText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= maxLength && !/[\s\0]/u.test(value)
}

/** 判断秘密材料是否为保留原始空白的有界字符串。 */
function isSecretText(value: unknown, allowEmpty = false): value is string {
  return typeof value === 'string'
    && (allowEmpty || value.length >= 1)
    && value.length <= 8_192
    && !value.includes('\0')
}

/** 计算跨进程字符串的 UTF-8 字节数，与 exec collector 的容量合同保持一致。 */
function getUtf8ByteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

/** 严格解析 SSH Host Key，避免未知字段跨越进程边界。 */
function parseHostKey(value: unknown): ServerOpsHostKey {
  if (!hasExactKeys(value, ['algorithm', 'fingerprint'])
    || typeof value.algorithm !== 'string' || value.algorithm.length < 1 || value.algorithm.length > 128
    || !/^[A-Za-z0-9@._+-]+$/u.test(value.algorithm)
    || typeof value.fingerprint !== 'string' || value.fingerprint.length < 8 || value.fingerprint.length > 192
    || !/^SHA256:[A-Za-z0-9+/]+$/u.test(value.fingerprint)) {
    throw new Error('SERVER_OPS_RUNTIME_PROTOCOL_INVALID')
  }
  return { algorithm: value.algorithm, fingerprint: value.fingerprint }
}

/** 严格解析 runtime 内部认证材料并复制二进制私钥。 */
function parseAuthentication(value: unknown): ServerOpsRuntimeAuthentication {
  if (hasExactKeys(value, ['kind', 'password']) && value.kind === 'password' && isSecretText(value.password)) {
    return { kind: 'password', password: value.password }
  }
  if ((hasExactKeys(value, ['kind', 'privateKey']) || hasExactKeys(value, ['kind', 'privateKey', 'passphrase']))
    && value.kind === 'private-key'
    && value.privateKey instanceof Uint8Array
    && value.privateKey.byteLength >= 1
    && value.privateKey.byteLength <= 1_048_576
    && (value.passphrase === undefined || isSecretText(value.passphrase, true))) {
    return {
      kind: 'private-key',
      privateKey: new Uint8Array(value.privateKey),
      ...(typeof value.passphrase === 'string' ? { passphrase: value.passphrase } : {}),
    }
  }
  if (hasExactKeys(value, ['kind', 'agent']) && value.kind === 'ssh-agent'
    && typeof value.agent === 'string' && value.agent.length >= 1 && value.agent.length <= 1_024
    && !value.agent.includes('\0')) {
    return { kind: 'ssh-agent', agent: value.agent }
  }
  throw new Error('SERVER_OPS_RUNTIME_PROTOCOL_INVALID')
}

/** 严格解析主进程发往 utility process 的连接请求。 */
function parseConnectRequest(value: unknown): ServerOpsRuntimeConnectRequest {
  const keys = ['requestId', 'hostId', 'connectionId', 'address', 'port', 'username', 'authentication', 'cols', 'rows']
  if (!hasExactKeys(value, isRecord(value) && value.expectedHostKey !== undefined ? [...keys, 'expectedHostKey'] : keys)
    || !isRuntimeId(value.requestId) || !isRuntimeId(value.hostId) || !isRuntimeId(value.connectionId)
    || !isConnectionText(value.address, 255) || !isPort(value.port) || !isConnectionText(value.username, 64)
    || !isTerminalDimension(value.cols) || !isTerminalDimension(value.rows)) {
    throw new Error('SERVER_OPS_RUNTIME_PROTOCOL_INVALID')
  }
  /** 可选 Host Key 必须按自身 exact-key 合同重建。 */
  const expectedHostKey = value.expectedHostKey === undefined ? undefined : parseHostKey(value.expectedHostKey)
  return {
    requestId: value.requestId,
    hostId: value.hostId,
    connectionId: value.connectionId,
    address: value.address,
    port: value.port,
    username: value.username,
    ...(expectedHostKey ? { expectedHostKey } : {}),
    authentication: parseAuthentication(value.authentication),
    cols: value.cols,
    rows: value.rows,
  }
}

/** 严格解析主进程发往 utility process 的 exec 请求。 */
function parseExecRequest(value: unknown): ServerOpsRuntimeExecRequest {
  if (!hasExactKeys(value, ['requestId', 'hostId', 'connectionId', 'command', 'timeoutMs'])
    || !isRuntimeId(value.requestId) || !isRuntimeId(value.hostId) || !isRuntimeId(value.connectionId)
    || typeof value.command !== 'string' || value.command.length < 1 || value.command.length > 8_192 || value.command.includes('\0')
    || typeof value.timeoutMs !== 'number' || !Number.isSafeInteger(value.timeoutMs)
    || value.timeoutMs < 1_000 || value.timeoutMs > 120_000) {
    throw new Error('SERVER_OPS_RUNTIME_PROTOCOL_INVALID')
  }
  return { requestId: value.requestId, hostId: value.hostId, connectionId: value.connectionId, command: value.command, timeoutMs: value.timeoutMs }
}

/** 严格解析只在 main 与 utility 间传输的日志命令。 */
function parseLogStartRequest(value: unknown): ServerOpsRuntimeLogStartRequest {
  if (!hasExactKeys(value, ['streamId', 'hostId', 'connectionId', 'command'])
    || !isRuntimeId(value.streamId) || !isRuntimeId(value.hostId) || !isRuntimeId(value.connectionId)
    || typeof value.command !== 'string' || value.command.length < 1 || value.command.length > 8_192
    || value.command.includes('\0')) {
    throw new Error('SERVER_OPS_RUNTIME_PROTOCOL_INVALID')
  }
  return { streamId: value.streamId, hostId: value.hostId, connectionId: value.connectionId, command: value.command }
}

/** 判断日志序号是否兼容 Shared 的 0..MAX_SAFE_INTEGER 合同。 */
function isLogSequence(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** 严格解析主进程发往 SSH utility process 的内部请求。 */
export function parseServerOpsRuntimeRequest(value: unknown): ServerOpsRuntimeRequest {
  try {
    if (!isRecord(value) || typeof value.type !== 'string') throw new Error('invalid')
    if (value.type === 'server-ops.connect' && hasExactKeys(value, ['type', 'input'])) {
      return { type: value.type, input: parseConnectRequest(value.input) }
    }
    if (value.type === 'server-ops.exec' && hasExactKeys(value, ['type', 'input'])) {
      return { type: value.type, input: parseExecRequest(value.input) }
    }
    if ((value.type === 'server-ops.disconnect' || value.type === 'server-ops.terminal-input')
      && hasExactKeys(value, value.type === 'server-ops.disconnect' ? ['type', 'hostId', 'connectionId'] : ['type', 'hostId', 'connectionId', 'data'])
      && isRuntimeId(value.hostId) && isRuntimeId(value.connectionId)) {
      if (value.type === 'server-ops.disconnect') return { type: value.type, hostId: value.hostId, connectionId: value.connectionId }
      if (typeof value.data === 'string' && value.data.length <= MAX_TERMINAL_INPUT_LENGTH) {
        return { type: value.type, hostId: value.hostId, connectionId: value.connectionId, data: value.data }
      }
    }
    if (value.type === 'server-ops.terminal-resize' && hasExactKeys(value, ['type', 'hostId', 'connectionId', 'cols', 'rows'])
      && isRuntimeId(value.hostId) && isRuntimeId(value.connectionId)
      && isTerminalDimension(value.cols) && isTerminalDimension(value.rows)) {
      return { type: value.type, hostId: value.hostId, connectionId: value.connectionId, cols: value.cols, rows: value.rows }
    }
    if (value.type === 'server-ops.terminal-ack' && hasExactKeys(value, ['type', 'input'])
      && hasExactKeys(value.input, ['hostId', 'connectionId', 'sequence'])
      && isRuntimeId(value.input.hostId) && isRuntimeId(value.input.connectionId)
      && typeof value.input.sequence === 'number' && Number.isSafeInteger(value.input.sequence) && value.input.sequence >= 1) {
      return { type: value.type, input: { hostId: value.input.hostId, connectionId: value.input.connectionId, sequence: value.input.sequence } }
    }
    if (value.type === 'server-ops.log-start' && hasExactKeys(value, ['type', 'input'])) {
      return { type: value.type, input: parseLogStartRequest(value.input) }
    }
    if ((value.type === 'server-ops.log-stop' || value.type === 'server-ops.log-ack')
      && hasExactKeys(value, value.type === 'server-ops.log-stop'
        ? ['type', 'streamId', 'hostId', 'connectionId']
        : ['type', 'streamId', 'hostId', 'connectionId', 'sequence'])
      && isRuntimeId(value.streamId) && isRuntimeId(value.hostId) && isRuntimeId(value.connectionId)) {
      if (value.type === 'server-ops.log-stop') {
        return { type: value.type, streamId: value.streamId, hostId: value.hostId, connectionId: value.connectionId }
      }
      if (isLogSequence(value.sequence)) {
        return { type: value.type, streamId: value.streamId, hostId: value.hostId, connectionId: value.connectionId, sequence: value.sequence }
      }
    }
    if (value.type === 'server-ops.shutdown' && hasExactKeys(value, ['type'])) return { type: value.type }
  } catch {
    // 下方统一使用稳定协议错误，避免泄露具体认证字段。
  }
  throw new Error('SERVER_OPS_RUNTIME_REQUEST_INVALID')
}

/** 严格解析 utility process 返回的连接结果 union。 */
function parseConnectResult(value: unknown): ServerOpsRuntimeConnectResult {
  if (hasExactKeys(value, ['status', 'hostKey']) && value.status === 'connected') {
    return { status: value.status, hostKey: parseHostKey(value.hostKey) }
  }
  if (hasExactKeys(value, ['status', 'observedHostKey']) && value.status === 'host-key-rejected') {
    return { status: value.status, observedHostKey: parseHostKey(value.observedHostKey) }
  }
  throw new Error('SERVER_OPS_RUNTIME_PROTOCOL_INVALID')
}

/** 严格解析 utility process 返回的 exec 结果。 */
function parseExecResult(value: unknown): ServerOpsRuntimeExecResult {
  const keys = ['stdout', 'stderr', 'truncated']
  if (!hasExactKeys(value, isRecord(value)
    ? [...keys, ...(value.exitCode !== undefined ? ['exitCode'] : []), ...(value.signal !== undefined ? ['signal'] : [])]
    : keys)
    || typeof value.stdout !== 'string' || typeof value.stderr !== 'string'
    || value.stdout.length + value.stderr.length > MAX_EXEC_OUTPUT_LENGTH
    || getUtf8ByteLength(value.stdout) + getUtf8ByteLength(value.stderr) > MAX_EXEC_OUTPUT_LENGTH
    || typeof value.truncated !== 'boolean'
    || (value.exitCode !== undefined && (typeof value.exitCode !== 'number' || !Number.isSafeInteger(value.exitCode) || value.exitCode < 0 || value.exitCode > 2_147_483_647))
    || (value.signal !== undefined && (typeof value.signal !== 'string' || value.signal.length < 1 || value.signal.length > 64 || !/^[A-Za-z0-9_.:+-]+$/u.test(value.signal)))) {
    throw new Error('SERVER_OPS_RUNTIME_PROTOCOL_INVALID')
  }
  return {
    stdout: value.stdout,
    stderr: value.stderr,
    ...(typeof value.exitCode === 'number' ? { exitCode: value.exitCode } : {}),
    ...(typeof value.signal === 'string' ? { signal: value.signal } : {}),
    truncated: value.truncated,
  }
}

/** 严格解析 utility process 返回的终端退出事件。 */
function parseTerminalExitEvent(value: unknown): ServerOpsTerminalExitEvent {
  const keys = ['hostId', 'connectionId', 'message']
  if (!hasExactKeys(value, isRecord(value)
    ? [...keys, ...(value.exitCode !== undefined ? ['exitCode'] : []), ...(value.signal !== undefined ? ['signal'] : [])]
    : keys)
    || !isRuntimeId(value.hostId) || !isRuntimeId(value.connectionId)
    || typeof value.message !== 'string' || value.message.length < 1 || value.message.length > 512 || value.message.includes('\0')
    || (value.exitCode !== undefined && (typeof value.exitCode !== 'number' || !Number.isSafeInteger(value.exitCode) || value.exitCode < 0 || value.exitCode > 2_147_483_647))
    || (value.signal !== undefined && (typeof value.signal !== 'string' || value.signal.length < 1 || value.signal.length > 64 || !/^[A-Za-z0-9_.:+-]+$/u.test(value.signal)))) {
    throw new Error('SERVER_OPS_RUNTIME_PROTOCOL_INVALID')
  }
  return {
    hostId: value.hostId,
    connectionId: value.connectionId,
    ...(typeof value.exitCode === 'number' ? { exitCode: value.exitCode } : {}),
    ...(typeof value.signal === 'string' ? { signal: value.signal } : {}),
    message: value.message,
  }
}

/** 严格解析 SSH utility process 发回主进程的内部消息。 */
export function parseServerOpsRuntimeMessage(value: unknown): ServerOpsRuntimeMessage {
  try {
    if (!isRecord(value) || typeof value.type !== 'string') throw new Error('invalid')
    if (value.type === 'server-ops.ready' && hasExactKeys(value, ['type', 'pid'])
      && typeof value.pid === 'number' && Number.isSafeInteger(value.pid) && value.pid >= 1 && value.pid <= 2_147_483_647) {
      return { type: value.type, pid: value.pid }
    }
    if ((value.type === 'server-ops.connect-result' || value.type === 'server-ops.exec-result')
      && hasExactKeys(value, ['type', 'requestId', 'hostId', 'connectionId', 'result'])
      && isRuntimeId(value.requestId) && isRuntimeId(value.hostId) && isRuntimeId(value.connectionId)) {
      if (value.type === 'server-ops.connect-result') return { type: value.type, requestId: value.requestId, hostId: value.hostId, connectionId: value.connectionId, result: parseConnectResult(value.result) }
      return { type: value.type, requestId: value.requestId, hostId: value.hostId, connectionId: value.connectionId, result: parseExecResult(value.result) }
    }
    if (value.type === 'server-ops.error'
      && hasExactKeys(value, value.requestId === undefined
        ? ['type', 'hostId', 'connectionId', 'code', 'message']
        : ['type', 'requestId', 'hostId', 'connectionId', 'code', 'message'])
      && (value.requestId === undefined || isRuntimeId(value.requestId))
      && isRuntimeId(value.hostId) && isRuntimeId(value.connectionId)
      && typeof value.code === 'string' && value.code.length >= 1 && value.code.length <= 128 && /^[A-Za-z0-9_.:-]+$/u.test(value.code)
      && typeof value.message === 'string' && value.message.length >= 1 && value.message.length <= 512 && !value.message.includes('\0')) {
      return { type: value.type, ...(typeof value.requestId === 'string' ? { requestId: value.requestId } : {}), hostId: value.hostId, connectionId: value.connectionId, code: value.code, message: value.message }
    }
    if (value.type === 'server-ops.terminal-output' && hasExactKeys(value, ['type', 'event'])
      && hasExactKeys(value.event, ['hostId', 'connectionId', 'sequence', 'data'])
      && isRuntimeId(value.event.hostId) && isRuntimeId(value.event.connectionId)
      && typeof value.event.sequence === 'number' && Number.isSafeInteger(value.event.sequence) && value.event.sequence >= 1
      && typeof value.event.data === 'string' && value.event.data.length <= MAX_TERMINAL_OUTPUT_LENGTH) {
      return { type: value.type, event: { hostId: value.event.hostId, connectionId: value.event.connectionId, sequence: value.event.sequence, data: value.event.data } }
    }
    if (value.type === 'server-ops.terminal-exit' && hasExactKeys(value, ['type', 'event'])) {
      return { type: value.type, event: parseTerminalExitEvent(value.event) }
    }
    if (value.type === 'server-ops.log-started'
      && hasExactKeys(value, ['type', 'streamId', 'hostId', 'connectionId'])
      && isRuntimeId(value.streamId) && isRuntimeId(value.hostId) && isRuntimeId(value.connectionId)) {
      return { type: value.type, streamId: value.streamId, hostId: value.hostId, connectionId: value.connectionId }
    }
    if (value.type === 'server-ops.log-chunk'
      && hasExactKeys(value, ['type', 'streamId', 'hostId', 'connectionId', 'sequence', 'data'])
      && isRuntimeId(value.streamId) && isRuntimeId(value.hostId) && isRuntimeId(value.connectionId)
      && isLogSequence(value.sequence) && typeof value.data === 'string'
      && getUtf8ByteLength(value.data) <= MAX_LOG_CHUNK_BYTES) {
      return { type: value.type, streamId: value.streamId, hostId: value.hostId, connectionId: value.connectionId, sequence: value.sequence, data: value.data }
    }
    if (value.type === 'server-ops.log-exit'
      && hasExactKeys(value, value.errorCode === undefined
        ? ['type', 'streamId', 'hostId', 'connectionId', 'reason']
        : ['type', 'streamId', 'hostId', 'connectionId', 'reason', 'errorCode'])
      && isRuntimeId(value.streamId) && isRuntimeId(value.hostId) && isRuntimeId(value.connectionId)
      && (value.reason === 'stopped' || value.reason === 'connection-closed' || value.reason === 'remote-exit' || value.reason === 'error')
      && (value.errorCode === undefined || (value.reason === 'error' && typeof value.errorCode === 'string'
        && value.errorCode.length >= 1 && value.errorCode.length <= 128 && /^[A-Za-z0-9_.:-]+$/u.test(value.errorCode)))) {
      return {
        type: value.type,
        streamId: value.streamId,
        hostId: value.hostId,
        connectionId: value.connectionId,
        reason: value.reason,
        ...(typeof value.errorCode === 'string' ? { errorCode: value.errorCode } : {}),
      }
    }
    if (value.type === 'server-ops.stopped' && hasExactKeys(value, ['type'])) return { type: value.type }
  } catch {
    // 下方统一使用稳定协议错误，避免让内部字段名跨越进程边界。
  }
  throw new Error('SERVER_OPS_RUNTIME_MESSAGE_INVALID')
}
