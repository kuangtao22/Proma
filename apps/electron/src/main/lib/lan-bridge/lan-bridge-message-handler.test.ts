import { describe, expect, test } from 'bun:test'
import type { WebSocket } from 'ws'
import { LanBridgeSessionManager } from './lan-bridge-session'
import type { ClientConnection } from './lan-bridge-types'
import { createLanBridgeMessageHandler } from './lan-bridge-message-handler'

/** 记录消息与终止调用的测试 WebSocket。 */
class FakeWebSocket {
  readyState = 1
  readonly sentMessages: string[] = []
  terminateCount = 0

  send(message: string): void {
    this.sentMessages.push(message)
  }

  close(): void {}

  terminate(): void {
    this.terminateCount++
  }
}

/** 提供可手动触发心跳的测试调度器。 */
class ManualHeartbeatScheduler {
  private callback: (() => void) | null = null

  schedule = (callback: () => void): ReturnType<typeof setInterval> => {
    this.callback = callback
    return Symbol('heartbeat') as unknown as ReturnType<typeof setInterval>
  }

  clear = (): void => {
    this.callback = null
  }

  tick(): void {
    this.callback?.()
  }
}

/** 从 WebSocket 已发送内容中提取限速错误数量。 */
function countRateLimitedErrors(socket: FakeWebSocket): number {
  return socket.sentMessages.filter((message) => {
    const parsed = JSON.parse(message) as { errorCode?: string }
    return parsed.errorCode === 'RATE_LIMITED'
  }).length
}

describe('LAN Bridge 消息处理器', () => {
  test('业务配额耗尽后有效 pong 仍更新时间并维持 45 秒心跳窗口', () => {
    let now = 0
    const scheduler = new ManualHeartbeatScheduler()
    const socket = new FakeWebSocket()
    const manager = new LanBridgeSessionManager(20, {
      now: () => now,
      scheduleInterval: scheduler.schedule,
      clearScheduledInterval: scheduler.clear,
      uuid: () => 'client-1',
    })
    const client = manager.addClient(socket as unknown as WebSocket, '192.168.1.2')!
    let dispatchCount = 0
    const handleMessage = createLanBridgeMessageHandler({
      sessionManager: manager,
      now: () => now,
      dispatch: () => { dispatchCount++ },
    })

    now = 10_000
    for (let index = 0; index < 60; index++) {
      handleMessage(client, Buffer.from(JSON.stringify({ type: 'business' })))
    }
    expect(dispatchCount).toBe(60)

    now = 15_001
    handleMessage(client, Buffer.from(JSON.stringify({ type: 'pong' })))
    expect(client.lastPongAt).toBe(15_001)
    expect(client.lastActivity).toBe(15_001)

    manager.startHeartbeat()
    now = 60_000
    scheduler.tick()
    expect(socket.terminateCount).toBe(0)
    expect(manager.getClient(client.id)).toBe(client)

    handleMessage(client, Buffer.from(JSON.stringify({ type: 'business' })))
    expect(dispatchCount).toBe(60)
    expect(countRateLimitedErrors(socket)).toBe(1)
  })

  test('超长、非法和数组形式的 pong 均不能绕过业务限速', () => {
    let now = 0
    const socket = new FakeWebSocket()
    const manager = new LanBridgeSessionManager(20, {
      now: () => now,
      uuid: () => 'client-1',
    })
    const client = manager.addClient(socket as unknown as WebSocket, '192.168.1.2')!
    const handleMessage = createLanBridgeMessageHandler({
      sessionManager: manager,
      now: () => now,
      dispatch: () => undefined,
    })

    for (let index = 0; index < 60; index++) {
      handleMessage(client, Buffer.from(JSON.stringify({ type: 'business' })))
    }

    now = 20_000
    const oversizedPong = Buffer.from(JSON.stringify({ type: 'pong', padding: 'x'.repeat(300) }))
    handleMessage(client, oversizedPong)
    handleMessage(client, Buffer.from('{"type":"pong"'))
    handleMessage(client, Buffer.from(JSON.stringify([{ type: 'pong' }])))

    expect(client.lastPongAt).toBe(0)
    expect(client.lastActivity).toBe(20_000)
    expect(countRateLimitedErrors(socket)).toBe(3)
  })

  test('已移除的旧客户端发送业务消息或 pong 时不产生任何副作用', () => {
    let now = 0
    const socket = new FakeWebSocket()
    const manager = new LanBridgeSessionManager(20, {
      now: () => now,
      uuid: () => 'client-1',
    })
    const client = manager.addClient(socket as unknown as WebSocket, '192.168.1.2')!
    client.authenticated = true
    let dispatchCount = 0
    const handleMessage = createLanBridgeMessageHandler({
      sessionManager: manager,
      now: () => now,
      dispatch: () => { dispatchCount++ },
    })
    manager.removeClient(client.id)

    now = 30_000
    handleMessage(client, Buffer.from(JSON.stringify({ type: 'business' })))
    handleMessage(client, Buffer.from(JSON.stringify({ type: 'pong' })))

    expect(client.lastActivity).toBe(0)
    expect(client.lastPongAt).toBe(0)
    expect(client.messageCount).toBe(0)
    expect(dispatchCount).toBe(0)
    expect(socket.sentMessages).toEqual([])
  })

  test('同 ID 的不同客户端对象不能进入消息处理流程', () => {
    let now = 0
    const socket = new FakeWebSocket()
    const manager = new LanBridgeSessionManager(20, {
      now: () => now,
      uuid: () => 'shared-client-id',
    })
    const registeredClient = manager.addClient(socket as unknown as WebSocket, '192.168.1.2')!
    const staleClient: ClientConnection = {
      ...registeredClient,
      ws: new FakeWebSocket() as unknown as WebSocket,
    }
    let dispatchCount = 0
    const handleMessage = createLanBridgeMessageHandler({
      sessionManager: manager,
      now: () => now,
      dispatch: () => { dispatchCount++ },
    })

    now = 30_000
    handleMessage(staleClient, Buffer.from(JSON.stringify({ type: 'business' })))
    handleMessage(staleClient, Buffer.from(JSON.stringify({ type: 'pong' })))

    expect(staleClient.lastActivity).toBe(0)
    expect(staleClient.lastPongAt).toBe(0)
    expect(staleClient.messageCount).toBe(0)
    expect(dispatchCount).toBe(0)
    expect((staleClient.ws as unknown as FakeWebSocket).sentMessages).toEqual([])
  })
})
