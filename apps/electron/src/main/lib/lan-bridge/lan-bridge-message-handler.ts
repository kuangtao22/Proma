import type { ClientConnection } from './lan-bridge-types'

/** 允许提前识别 pong 的最大消息体字节数，限制额外 JSON 解析开销。 */
export const EARLY_PONG_MAX_BYTES = 256

/** 消息处理器使用的最小会话管理能力。 */
export interface LanBridgeMessageSessionManager {
  /** 按 ID 返回当前仍注册的客户端对象。 */
  getClient: (id: string) => ClientConnection | undefined
  /** 检查业务消息是否仍在速率限制内。 */
  checkRateLimit: (client: ClientConnection) => boolean
  /** 向客户端发送协议消息。 */
  send: (client: ClientConnection, message: object) => void
  /** 记录有效 pong 的接收时间。 */
  markPong: (client: ClientConnection, receivedAt?: number) => void
}

/** 纯消息处理器依赖，由 LAN Bridge 主入口注入。 */
export interface LanBridgeMessageHandlerDependencies {
  /** 当前 LAN Bridge 的会话管理器。 */
  sessionManager: LanBridgeMessageSessionManager
  /** 返回当前毫秒时间戳。 */
  now: () => number
  /** 分发通过验证和限速的业务请求。 */
  dispatch: (
    client: ClientConnection,
    type: string,
    data: Record<string, unknown>,
    id?: string,
  ) => unknown
}

interface ParsedRequest {
  type?: unknown
  data?: unknown
  id?: unknown
}

/** 创建单个 LAN Bridge 实例使用的消息处理器。 */
export function createLanBridgeMessageHandler(
  dependencies: LanBridgeMessageHandlerDependencies,
): (client: ClientConnection, raw: Buffer) => void {
  return (client, raw) => {
    // WebSocket 回调可能晚于 remove/reconnect，任何副作用前先验证对象身份。
    if (dependencies.sessionManager.getClient(client.id) !== client) return

    const receivedAt = dependencies.now()
    client.lastActivity = receivedAt

    // pong 属于连接保活协议，不消耗业务配额；仅对严格小尺寸 JSON 做提前识别。
    if (isValidEarlyPong(raw)) {
      dependencies.sessionManager.markPong(client, receivedAt)
      return
    }

    if (!dependencies.sessionManager.checkRateLimit(client)) {
      dependencies.sessionManager.send(client, {
        type: 'error',
        ok: false,
        error: 'Rate limited',
        errorCode: 'RATE_LIMITED',
      })
      return
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw.toString('utf-8'))
    } catch {
      dependencies.sessionManager.send(client, {
        type: 'error',
        ok: false,
        error: 'Invalid JSON',
        errorCode: 'VALIDATION_ERROR',
      })
      return
    }

    if (!isRecord(parsed) || typeof parsed.type !== 'string' || !parsed.type) return

    const request = parsed as ParsedRequest
    const data = isRecord(request.data) ? request.data : {}
    const id = typeof request.id === 'string' ? request.id : undefined
    dependencies.dispatch(client, parsed.type, data, id)
  }
}

/** 仅用结构化 JSON 识别小尺寸应用层 pong。 */
function isValidEarlyPong(raw: Buffer): boolean {
  if (raw.byteLength > EARLY_PONG_MAX_BYTES) return false

  try {
    const parsed: unknown = JSON.parse(raw.toString('utf-8'))
    return isRecord(parsed) && parsed.type === 'pong'
  } catch {
    return false
  }
}

/** 判断输入是否为非数组对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
