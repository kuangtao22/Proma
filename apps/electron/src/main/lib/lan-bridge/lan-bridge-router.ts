/**
 * LAN Bridge 命令路由
 *
 * 将 WS 消息的 type 字段路由到对应的 handler。
 */

import type { ClientConnection, RouteHandler } from './lan-bridge-types'
import type { LanBridgeResponse, LanBridgeErrorCode } from '@proma/shared'

const routes = new Map<string, RouteHandler>()

/** 注册路由 */
export function registerRoute(type: string, handler: RouteHandler): void {
  routes.set(type, handler)
}

/** 分发请求到对应 handler */
export async function dispatch(
  client: ClientConnection,
  type: string,
  data: Record<string, unknown>,
  id?: string,
): Promise<void> {
  const handler = routes.get(type)
  if (!handler) {
    sendError(client, type, id, `Unknown command: ${type}`, 'NOT_FOUND')
    return
  }

  try {
    const result = await handler(client, data, id)
    const response: LanBridgeResponse = {
      type,
      id,
      ok: true,
      data: result,
    }
    try {
      client.ws.send(JSON.stringify(response))
    } catch (e) {
      console.error(`[LAN Bridge] dispatch send error: type=${type} id=${id}`, e)
    }
  } catch (err: any) {
    const message = err instanceof Error ? err.message : 'Internal error'
    const errorCode = ((err as any)?.errorCode ?? 'INTERNAL_ERROR') as LanBridgeErrorCode
    console.error(`[LAN Bridge] dispatch error: type=${type} id=${id}`, message, errorCode)
    sendError(client, type, id, message, errorCode)
  }
}

/** 发送错误响应 */
export function sendError(
  client: ClientConnection,
  type: string,
  id: string | undefined,
  error: string,
  errorCode: LanBridgeErrorCode,
): void {
  const response: LanBridgeResponse = { type, id, ok: false, error, errorCode }
  try {
    client.ws.send(JSON.stringify(response))
  } catch (e) {
    console.error(`[LAN Bridge] sendError send fail: type=${type} id=${id}`, e)
  }
}

/** 获取已注册的路由数量（调试用） */
export function getRouteCount(): number {
  return routes.size
}
