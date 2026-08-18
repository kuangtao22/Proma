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
/** 未认证连接必须在该时间内完成配对或 Token 验证。 */
export const UNAUTHENTICATED_CONNECTION_TIMEOUT_MS = 15_000
/** 单个来源 IP 可同时占用的未认证连接上限。 */
export const MAX_UNAUTHENTICATED_CONNECTIONS_PER_IP = 3

/** 会话管理器的时间、调度与 ID 依赖，便于确定性测试。 */
export interface LanBridgeSessionManagerDependencies {
  /** 返回当前毫秒时间戳。 */
  now: () => number
  /** 注册单次延迟任务，返回可清理的调度句柄。 */
  scheduleTimeout: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  /** 清理单次延迟任务。 */
  clearScheduledTimeout: (handle: ReturnType<typeof setTimeout>) => void
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
  scheduleTimeout: setTimeout,
  clearScheduledTimeout: clearTimeout,
  scheduleInterval: setInterval,
  clearScheduledInterval: clearInterval,
  uuid: randomUUID,
  verifyToken: verifyTokenDetails,
}

export class LanBridgeSessionManager {
  private clients = new Map<string, ClientConnection>()
  private maxConnections: number
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  /** 按客户端 ID 保存待认证绝对截止任务，认证或离线后立即释放。 */
  private readonly unauthenticatedDeadlineTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly dependencies: LanBridgeSessionManagerDependencies

  constructor(maxConnections: number, dependencies: Partial<LanBridgeSessionManagerDependencies> = {}) {
    this.maxConnections = maxConnections
    this.dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencies }
  }

  /** 添加新连接 */
  addClient(ws: WebSocket, ip: string): ClientConnection | null {
    /** 新连接接入时使用的统一时间戳。 */
    const now = this.dependencies.now()
    this.evictExpiredUnauthenticatedClients(now)
    if (this.clients.size >= this.maxConnections) {
      this.terminateRejectedSocket(ws, ip, 'Max connections reached')
      return null
    }
    /** 当前来源 IP 已占用的待认证连接数。 */
    const unauthenticatedConnectionCount = [...this.clients.values()].filter(client => (
      !client.authenticated && client.ip === ip
    )).length
    if (unauthenticatedConnectionCount >= MAX_UNAUTHENTICATED_CONNECTIONS_PER_IP) {
      this.terminateRejectedSocket(ws, ip, 'Too many unauthenticated connections')
      return null
    }

    const client: ClientConnection = {
      id: this.dependencies.uuid(),
      ws,
      ip,
      authenticated: false,
      subscriptions: new Set(),
      connectedAt: now,
      lastActivity: now,
      lastPongAt: now,
      windowStart: now,
      messageCount: 0,
    }

    this.clients.set(client.id, client)
    /** 当前待认证连接的绝对截止任务。 */
    const deadlineTimer = this.dependencies.scheduleTimeout(() => {
      this.unauthenticatedDeadlineTimers.delete(client.id)
      if (this.clients.get(client.id) !== client || client.authenticated) return
      this.expireUnauthenticatedClient(client)
    }, UNAUTHENTICATED_CONNECTION_TIMEOUT_MS)
    this.unauthenticatedDeadlineTimers.set(client.id, deadlineTimer)
    console.log(`[LAN Bridge] 客户端连接: ${ip} (${client.id}), 总连接数: ${this.clients.size}`)
    return client
  }

  /** 移除连接 */
  removeClient(id: string): void {
    const client = this.clients.get(id)
    if (!client) return
    this.clearUnauthenticatedDeadline(id)
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
    if (!this.synchronizeAuthenticationState(client)) return false
    const token = data.token as string | undefined
    if (!token) return false
    /** 包含设备标识的 Token 验证结果。 */
    const verification = this.dependencies.verifyToken(token, client.ip)
    if (verification.valid) {
      client.authenticated = true
      client.deviceId = verification.deviceId
      client.authToken = token
      client.authExpiresAt = verification.expiresAt
      this.synchronizeAuthenticationState(client)
      return true
    }
    return false
  }

  /**
   * 对齐 Handler 直接写入的认证状态与待认证 deadline，并拒绝逾期竞态。
   *
   * @param client 需要同步认证生命周期的客户端
   * @returns 客户端仍存在且允许继续处理请求时返回 true
   */
  synchronizeAuthenticationState(client: ClientConnection): boolean {
    if (this.clients.get(client.id) !== client) return false
    if (client.authenticated) {
      this.clearUnauthenticatedDeadline(client.id)
      return true
    }
    if (this.dependencies.now() - client.connectedAt < UNAUTHENTICATED_CONNECTION_TIMEOUT_MS) {
      return true
    }
    this.expireUnauthenticatedClient(client)
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
      this.evictExpiredUnauthenticatedClients(now)
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

  /** 淘汰超过认证截止时间的连接；pong 不参与待认证期限计算。 */
  private evictExpiredUnauthenticatedClients(now: number): void {
    for (const [clientId, client] of this.clients) {
      if (client.authenticated) continue
      if (now - client.connectedAt < UNAUTHENTICATED_CONNECTION_TIMEOUT_MS) continue
      this.expireUnauthenticatedClient(client)
    }
  }

  /**
   * 淘汰单个待认证连接并关闭 WebSocket。
   *
   * @param client 已达到认证截止时间的连接
   */
  private expireUnauthenticatedClient(client: ClientConnection): void {
    if (this.clients.get(client.id) !== client || client.authenticated) return
    this.clearUnauthenticatedDeadline(client.id)
    this.clients.delete(client.id)
    try {
      client.ws.close(1008, 'Authentication timeout')
    } catch {
      console.warn(`[LAN Bridge] 未认证连接关闭失败: ${client.ip} (${client.id})`)
    }
  }

  /**
   * 清理指定客户端的待认证截止任务。
   *
   * @param clientId 客户端唯一标识
   */
  private clearUnauthenticatedDeadline(clientId: string): void {
    /** 目标客户端当前注册的截止任务。 */
    const deadlineTimer = this.unauthenticatedDeadlineTimers.get(clientId)
    if (deadlineTimer === undefined) return
    this.unauthenticatedDeadlineTimers.delete(clientId)
    this.dependencies.clearScheduledTimeout(deadlineTimer)
  }

  /**
   * 立即释放因容量限制而未纳入管理的已升级 WebSocket。
   *
   * @param ws 被拒绝的 WebSocket
   * @param ip 客户端来源 IP
   * @param reason 拒绝原因，仅用于本地日志和终止失败后的关闭握手
   */
  private terminateRejectedSocket(ws: WebSocket, ip: string, reason: string): void {
    try {
      ws.terminate()
    } catch {
      console.warn(`[LAN Bridge] 拒绝连接终止失败，尝试关闭: ${ip} (${reason})`)
      try {
        ws.close(1013, reason)
      } catch {
        console.warn(`[LAN Bridge] 拒绝连接关闭失败: ${ip} (${reason})`)
      }
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
      this.clearUnauthenticatedDeadline(client.id)
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
      connectedAt: c.connectedAt,
      subscriptions: [...c.subscriptions],
    }))
  }

  get connectionCount(): number {
    return this.clients.size
  }
}
