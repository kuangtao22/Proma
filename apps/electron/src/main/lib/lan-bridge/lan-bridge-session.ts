/**
 * LAN Bridge 客户端连接管理
 *
 * 管理所有 WS 客户端的连接、认证、心跳、速率限制。
 */

import { randomUUID } from 'node:crypto'
import type { WebSocket } from 'ws'
import type { ClientConnection } from './lan-bridge-types'
import { verifyTokenDetails } from './lan-bridge-auth'
import type { TokenVerificationResult } from './lan-bridge-auth'

const RATE_LIMIT_WINDOW_MS = 60_000 // 1 minute
const RATE_LIMIT_MAX_MESSAGES = 60
const HEARTBEAT_INTERVAL_MS = 15_000
const HEARTBEAT_TIMEOUT_MS = 45_000

/** 会话管理器的时间、调度与 ID 依赖，便于确定性测试。 */
export interface LanBridgeSessionManagerDependencies {
  /** 返回当前毫秒时间戳。 */
  now: () => number
  /** 注册固定间隔任务，返回可清理的调度句柄。 */
  scheduleInterval: (callback: () => void, intervalMs: number) => ReturnType<typeof setInterval>
  /** 清理固定间隔任务。 */
  clearScheduledInterval: (handle: ReturnType<typeof setInterval>) => void
  /** 生成客户端唯一 ID。 */
  uuid: () => string
  /** 验证 Token 并返回对应设备。 */
  verifyToken: (token: string, ip: string) => TokenVerificationResult
}

const DEFAULT_DEPENDENCIES: LanBridgeSessionManagerDependencies = {
  now: Date.now,
  scheduleInterval: setInterval,
  clearScheduledInterval: clearInterval,
  uuid: randomUUID,
  verifyToken: verifyTokenDetails,
}

export class LanBridgeSessionManager {
  private clients = new Map<string, ClientConnection>()
  private maxConnections: number
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private readonly dependencies: LanBridgeSessionManagerDependencies

  constructor(maxConnections: number, dependencies: Partial<LanBridgeSessionManagerDependencies> = {}) {
    this.maxConnections = maxConnections
    this.dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencies }
  }

  /** 添加新连接 */
  addClient(ws: WebSocket, ip: string): ClientConnection | null {
    if (this.clients.size >= this.maxConnections) {
      ws.close(1013, 'Max connections reached')
      return null
    }

    const now = this.dependencies.now()
    const client: ClientConnection = {
      id: this.dependencies.uuid(),
      ws,
      ip,
      authenticated: false,
      subscriptions: new Set(),
      lastActivity: now,
      lastPongAt: now,
      windowStart: now,
      messageCount: 0,
    }

    this.clients.set(client.id, client)
    console.log(`[LAN Bridge] 客户端连接: ${ip} (${client.id}), 总连接数: ${this.clients.size}`)
    return client
  }

  /** 移除连接 */
  removeClient(id: string): void {
    const client = this.clients.get(id)
    if (!client) return
    this.clients.delete(id)
    console.log(`[LAN Bridge] 客户端断开: ${client.ip} (${id}), 总连接数: ${this.clients.size}`)
  }

  /** 获取客户端 */
  getClient(id: string): ClientConnection | undefined {
    return this.clients.get(id)
  }

  /** 记录目标连接的 pong；已移除或被同 ID 新连接替换的对象不会被更新。 */
  markPong(client: ClientConnection, receivedAt = this.dependencies.now()): void {
    if (this.clients.get(client.id) !== client) return
    client.lastPongAt = receivedAt
  }

  /** 检查速率限制，返回 true 表示允许 */
  checkRateLimit(client: ClientConnection): boolean {
    const now = this.dependencies.now()
    if (now - client.windowStart > RATE_LIMIT_WINDOW_MS) {
      client.windowStart = now
      client.messageCount = 0
    }
    client.messageCount++
    return client.messageCount <= RATE_LIMIT_MAX_MESSAGES
  }

  /** 从请求 data 中提取并验证 token */
  authenticateFromData(client: ClientConnection, data: Record<string, unknown>): boolean {
    const token = data.token as string | undefined
    if (!token) return false
    /** 包含设备标识的 Token 验证结果。 */
    const verification = this.dependencies.verifyToken(token, client.ip)
    if (verification.valid) {
      client.authenticated = true
      client.deviceId = verification.deviceId
      client.authToken = token
      client.authExpiresAt = verification.expiresAt
      return true
    }
    return false
  }

  /**
   * 断开指定设备的所有现有连接。
   *
   * @param deviceId 被撤销设备唯一标识
   */
  disconnectDevice(deviceId: string): void {
    for (const [clientId, client] of this.clients) {
      if (client.deviceId !== deviceId) continue
      this.clients.delete(clientId)
      try {
        client.ws.close(1008, 'Device revoked')
      } catch {
        console.warn(`[LAN Bridge] 撤销设备连接关闭失败: ${client.ip} (${clientId})`)
      }
    }
  }

  /** 获取订阅了指定 sessionId 的所有客户端 */
  getSubscribers(sessionId: string): ClientConnection[] {
    this.evictExpiredAuthenticatedClients(this.dependencies.now())
    const subscribers: ClientConnection[] = []
    for (const client of this.clients.values()) {
      if (client.authenticated && client.subscriptions.has(sessionId)) {
        subscribers.push(client)
      }
    }
    return subscribers
  }

  /** 获取所有已认证客户端 */
  getAuthenticatedClients(): ClientConnection[] {
    this.evictExpiredAuthenticatedClients(this.dependencies.now())
    return [...this.clients.values()].filter(c => c.authenticated)
  }

  /** 向所有已认证客户端广播 */
  broadcast(message: object): void {
    this.evictExpiredAuthenticatedClients(this.dependencies.now())
    const data = JSON.stringify(message)
    for (const client of this.clients.values()) {
      if (client.authenticated && client.ws.readyState === 1) {
        try { client.ws.send(data) } catch { /* ignore send errors */ }
      }
    }
  }

  /** 向指定客户端发送 */
  send(client: ClientConnection, message: object): void {
    if (client.ws.readyState === 1) {
      try { client.ws.send(JSON.stringify(message)) } catch { /* ignore send errors */ }
    }
  }

  /** 启动心跳检测 */
  startHeartbeat(): void {
    this.stopHeartbeat()
    this.heartbeatTimer = this.dependencies.scheduleInterval(() => {
      const now = this.dependencies.now()
      this.evictExpiredAuthenticatedClients(now)
      for (const [id, client] of this.clients) {
        // 先清理达到完整超时窗口的连接，避免超时后继续发送心跳。
        if (now - client.lastPongAt >= HEARTBEAT_TIMEOUT_MS) {
          console.log(`[LAN Bridge] 心跳超时，断开: ${client.ip} (${id})`)
          this.clients.delete(id)
          try {
            client.ws.terminate()
          } catch {
            console.warn(`[LAN Bridge] 心跳终止失败，尝试关闭: ${client.ip} (${id})`)
            try {
              client.ws.close(1011, 'Heartbeat timeout cleanup')
            } catch {
              console.warn(`[LAN Bridge] 心跳关闭失败，连接已移除: ${client.ip} (${id})`)
            }
          }
          continue
        }
        // 仅向可写连接发送应用层心跳，发送结果不改变 pong 时间。
        if (client.ws.readyState === 1) {
          try { client.ws.send(JSON.stringify({ type: '_heartbeat' })) } catch { /* ignore */ }
        }
      }
    }, HEARTBEAT_INTERVAL_MS)
  }

  /** 停止心跳检测 */
  stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      this.dependencies.clearScheduledInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  /** 淘汰认证已到期的连接，并确保同一连接最多关闭一次。 */
  private evictExpiredAuthenticatedClients(now: number): void {
    for (const [clientId, client] of this.clients) {
      if (!client.authenticated) continue
      if (client.authExpiresAt !== undefined && now < client.authExpiresAt) continue

      // 先移出所有可推送集合，再执行可能失败的网络关闭。
      this.clients.delete(clientId)
      client.subscriptions.clear()
      client.authenticated = false
      client.deviceId = undefined
      client.authToken = undefined
      client.authExpiresAt = undefined
      try {
        client.ws.close(1008, 'Authentication expired')
      } catch {
        console.warn(`[LAN Bridge] 到期认证连接关闭失败: ${client.ip} (${clientId})`)
      }
    }
  }

  /** 关闭所有连接 */
  closeAll(): void {
    this.stopHeartbeat()
    for (const client of this.clients.values()) {
      client.ws.close(1001, 'Server shutting down')
    }
    this.clients.clear()
  }

  /** 获取所有客户端信息（用于 IPC 状态查询） */
  getClientInfos(): Array<{ id: string; ip: string; authenticated: boolean; connectedAt: number; subscriptions: string[] }> {
    return [...this.clients.values()].map(c => ({
      id: c.id,
      ip: c.ip,
      authenticated: c.authenticated,
      connectedAt: c.lastActivity,
      subscriptions: [...c.subscriptions],
    }))
  }

  get connectionCount(): number {
    return this.clients.size
  }
}
