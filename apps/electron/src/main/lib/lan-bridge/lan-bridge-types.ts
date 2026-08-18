/**
 * LAN Bridge 内部类型定义
 */

import type { WebSocket } from 'ws'

/** 已连接的客户端 */
export interface ClientConnection {
  /** 唯一 ID */
  id: string
  /** WebSocket 实例 */
  ws: WebSocket
  /** 客户端 IP */
  ip: string
  /** 是否已认证 */
  authenticated: boolean
  /** 已认证设备唯一标识；未认证或旧连接为空。 */
  deviceId?: string
  /** 已订阅的 sessionId 集合 */
  subscriptions: Set<string>
  /** 最后活跃时间 */
  lastActivity: number
  /** 最后收到应用层 pong 的时间 */
  lastPongAt: number
  /** 消息计数（速率限制用，滑动窗口起始时间戳） */
  windowStart: number
  /** 消息计数 */
  messageCount: number
}

/** 命令路由 handler 类型 */
export type RouteHandler = (
  client: ClientConnection,
  data: Record<string, unknown>,
  id?: string,
) => Promise<unknown> | unknown
