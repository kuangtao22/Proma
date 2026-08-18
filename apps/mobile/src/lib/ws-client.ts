import type { LanBridgeErrorCode } from '@proma/shared'

export interface WSRequest {
  type: string
  id?: string
  data?: Record<string, unknown>
}

export interface WSResponse {
  type: string
  id?: string
  ok: boolean
  data?: unknown
  error?: string
  errorCode?: WsClientErrorCode
}

export interface WebSocketLike {
  readyState: number
  onopen: (() => void) | null
  onmessage: ((event: { data: string }) => void) | null
  onclose: (() => void) | null
  onerror: (() => void) | null
  send(data: string): void
  close(): void
}

export interface WsClientDependencies {
  createWebSocket(url: string): WebSocketLike
  schedule(callback: () => void, delay: number): unknown
  clear(timeoutId: unknown): void
  random(): number
  authExpired(code: WsClientErrorCode): void
}

export interface WsClient {
  connect(host: string, port: string, protocol?: WebSocketSourceProtocol): WebSocketLike
  close(): void
  onOpen(handler: OpenHandler): () => void
  onPush(handler: PushHandler): () => void
  wsReq(type: string, data?: Record<string, unknown>, timeout?: number): Promise<unknown>
  pendingCount(): number
}

/** 决定 WebSocket 安全性的原始页面协议。 */
export type WebSocketSourceProtocol = 'http:' | 'https:'

interface PendingRequest {
  resolve(value: unknown): void
  reject(error: Error): void
  timeoutId: unknown
}

type PushHandler = (msg: WSResponse) => void
type OpenHandler = (ws: WebSocketLike, isReconnect: boolean) => void

export type WsClientErrorCode = LanBridgeErrorCode
  | 'NOT_CONNECTED'
  | 'TIMEOUT'
  | 'REQUEST_FAILED'
  | 'SEND_FAILED'

/** 带稳定错误码的客户端错误，供界面区分断线、超时和认证失败。 */
export class WsClientError extends Error {
  constructor(readonly code: WsClientErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'WsClientError'
  }
}

/** 创建类型安全的 WebSocket 客户端错误。 */
export function createWsClientError(code: WsClientErrorCode, message: string, cause?: unknown): WsClientError {
  return new WsClientError(code, message, cause === undefined ? undefined : { cause })
}

/** 创建隔离且依赖可注入的 WebSocket 客户端实例。 */
export function createWsClient(dependencies: WsClientDependencies): WsClient {
  let messageId = 0
  let socket: WebSocketLike | null = null
  let host = ''
  let port = ''
  let sourceProtocol: WebSocketSourceProtocol = 'http:'
  let reconnectTimer: unknown = null
  let reconnectBaseDelay = 1000
  let openHandler: OpenHandler | null = null
  const pendingRequests = new Map<string, PendingRequest>()
  const pushHandlers = new Set<PushHandler>()

  /** 先释放 timer 和映射，再执行 Promise 回调，保证所有结算路径一致。 */
  function takePending(id: string): PendingRequest | null {
    const pending = pendingRequests.get(id)
    if (!pending) return null
    dependencies.clear(pending.timeoutId)
    pendingRequests.delete(id)
    return pending
  }

  /** 立即拒绝并清空全部挂起请求，避免断线后等待超时。 */
  function rejectPendingRequests(code: WsClientErrorCode, message: string): void {
    for (const id of [...pendingRequests.keys()]) {
      takePending(id)?.reject(createWsClientError(code, message))
    }
  }

  /** 清理唯一重连任务，供手动关闭和显式连接复用。 */
  function clearReconnectTimer(): void {
    if (reconnectTimer === null) return
    dependencies.clear(reconnectTimer)
    reconnectTimer = null
  }

  /** 按 2 倍退避并添加最多 10% 正抖动，降低多客户端同时冲击。 */
  function scheduleReconnect(): void {
    if (reconnectTimer !== null || !host || !port) return
    const jitteredDelay = reconnectBaseDelay * (1 + dependencies.random() * 0.1)
    const delay = Math.min(Math.round(jitteredDelay), 15000)
    reconnectBaseDelay = Math.min(reconnectBaseDelay * 2, 15000 / 1.1)
    reconnectTimer = dependencies.schedule(() => {
      reconnectTimer = null
      openConnection(true)
    }, delay)
  }

  /** 建立一次连接；事件只允许当前 socket 修改客户端状态。 */
  function openConnection(isReconnect: boolean): WebSocketLike {
    /** WebSocket scheme 必须跟随配对页面协议，不能从端口猜测。 */
    const socketProtocol = sourceProtocol === 'https:' ? 'wss' : 'ws'
    const currentSocket = dependencies.createWebSocket(`${socketProtocol}://${host}:${port}/ws`)
    socket = currentSocket

    currentSocket.onopen = () => {
      if (socket !== currentSocket) return
      reconnectBaseDelay = 1000
      try { openHandler?.(currentSocket, isReconnect) } catch { /* 调用方异常不破坏连接 */ }
    }

    currentSocket.onmessage = event => {
      if (socket !== currentSocket) return
      try {
        const message = JSON.parse(event.data) as WSResponse
        if (message.type === '_heartbeat') {
          currentSocket.send(JSON.stringify({ type: 'pong' }))
          return
        }
        if (message.id) {
          const pending = takePending(message.id)
          if (pending) {
            if (message.ok) {
              pending.resolve(message.data ?? {})
            } else {
              const code = message.errorCode ?? 'REQUEST_FAILED'
              pending.reject(createWsClientError(code, message.error ?? 'Unknown error'))
              if (code === 'TOKEN_EXPIRED' || code === 'AUTH_REQUIRED'
                || code === 'TOKEN_INVALID' || code === 'DEVICE_REVOKED') {
                dependencies.authExpired(code)
              }
            }
          }
          /** 带请求 id 的迟到响应不能降级为业务推送。 */
          return
        }
        for (const handler of pushHandlers) {
          try { handler(message) } catch { /* 单个处理器异常不影响其他订阅者 */ }
        }
      } catch { /* 忽略无法解析的服务端消息 */ }
    }

    currentSocket.onclose = () => {
      if (socket !== currentSocket) return
      socket = null
      rejectPendingRequests('CONNECTION_LOST', 'WebSocket connection lost')
      scheduleReconnect()
    }

    currentSocket.onerror = () => { /* close 事件统一处理连接失败 */ }
    return currentSocket
  }

  /** 显式连接会替换旧 socket，并从首次连接状态开始。 */
  function connect(
    nextHost: string,
    nextPort: string,
    nextProtocol: WebSocketSourceProtocol = 'http:',
  ): WebSocketLike {
    clearReconnectTimer()
    const previousSocket = socket
    socket = null
    rejectPendingRequests('CONNECTION_LOST', 'WebSocket connection lost')
    if (previousSocket) {
      try { previousSocket.close() } catch { /* 已关闭 socket 无需额外处理 */ }
    }
    host = nextHost
    port = nextPort
    sourceProtocol = nextProtocol
    reconnectBaseDelay = 1000
    return openConnection(false)
  }

  /** 手动关闭当前实例，不安排自动重连。 */
  function close(): void {
    clearReconnectTimer()
    const currentSocket = socket
    socket = null
    rejectPendingRequests('CONNECTION_LOST', 'WebSocket connection lost')
    if (currentSocket) {
      try { currentSocket.close() } catch { /* 已关闭 socket 无需额外处理 */ }
    }
  }

  /** 注册连接成功回调，回调参数说明是否由自动重连产生。 */
  function onOpen(handler: OpenHandler): () => void {
    openHandler = handler
    return () => {
      if (openHandler === handler) openHandler = null
    }
  }

  /** 注册服务端推送处理器，并返回取消函数。 */
  function onPush(handler: PushHandler): () => void {
    pushHandlers.add(handler)
    return () => { pushHandlers.delete(handler) }
  }

  /** 发送带超时控制的请求，所有响应路径都会释放 timeout。 */
  function wsReq(type: string, data?: Record<string, unknown>, timeout = 15000): Promise<unknown> {
    const currentSocket = socket
    if (!currentSocket || currentSocket.readyState !== 1) {
      return Promise.reject(createWsClientError('NOT_CONNECTED', 'WebSocket is not connected'))
    }
    return new Promise((resolve, reject) => {
      const id = String(++messageId)
      const timeoutId = dependencies.schedule(() => {
        const pending = takePending(id)
        pending?.reject(createWsClientError('TIMEOUT', 'Request timeout'))
      }, timeout)
      pendingRequests.set(id, { resolve, reject, timeoutId })
      try {
        const payload = JSON.stringify({ type, id, data: data ?? {} })
        currentSocket.send(payload)
      } catch (error) {
        /** 同步发送失败复用统一结算路径，避免遗留 pending 与 timer。 */
        const message = error instanceof Error ? error.message : 'Failed to send WebSocket request'
        takePending(id)?.reject(createWsClientError('SEND_FAILED', message, error))
      }
    })
  }

  /** 暴露挂起数量用于诊断和无泄漏回归测试。 */
  function pendingCount(): number {
    return pendingRequests.size
  }

  return { connect, close, onOpen, onPush, wsReq, pendingCount }
}

/** 浏览器默认依赖只负责环境接线，业务逻辑由实例实现。 */
const defaultClient = createWsClient({
  createWebSocket: url => new WebSocket(url) as unknown as WebSocketLike,
  schedule: (callback, delay) => setTimeout(callback, delay),
  clear: timeoutId => clearTimeout(timeoutId as ReturnType<typeof setTimeout>),
  random: () => Math.random(),
  authExpired: () => {
    localStorage.removeItem('proma_mobile_token')
    window.dispatchEvent(new CustomEvent('proma:auth-expired'))
  },
})

/** 使用浏览器默认实例建立连接。 */
export function connect(
  host: string,
  port: string,
  protocol: WebSocketSourceProtocol = 'http:',
): WebSocketLike {
  return defaultClient.connect(host, port, protocol)
}

/** 使用浏览器默认实例手动关闭连接。 */
export function close(): void {
  defaultClient.close()
}

/** 注册浏览器默认实例的连接成功回调。 */
export function onOpen(handler: OpenHandler): () => void {
  return defaultClient.onOpen(handler)
}

/** 注册浏览器默认实例的推送处理器。 */
export function onPush(handler: PushHandler): () => void {
  return defaultClient.onPush(handler)
}

/** 通过浏览器默认实例发送请求。 */
export function wsReq(type: string, data?: Record<string, unknown>, timeout = 15000): Promise<unknown> {
  return defaultClient.wsReq(type, data, timeout)
}
