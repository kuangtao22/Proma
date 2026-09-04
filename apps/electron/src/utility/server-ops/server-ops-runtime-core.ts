import { createHash } from 'node:crypto'
import type { ServerOpsHostKey, ServerOpsTerminalOutputEvent } from '@proma/shared'

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
