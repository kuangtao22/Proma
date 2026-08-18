import { describe, expect, test } from 'bun:test'
import type { WebSocket } from 'ws'
import { LanBridgeSessionManager } from './lan-bridge-session'

/** 测试用 WebSocket，仅记录心跳发送与关闭行为。 */
class FakeWebSocket {
  readyState = 1
  readonly sentMessages: string[] = []
  readonly closeCalls: Array<{ code: number; reason: string }> = []
  terminateCount = 0

  send(message: string): void {
    this.sentMessages.push(message)
  }

  close(code: number, reason: string): void {
    this.closeCalls.push({ code, reason })
  }

  terminate(): void {
    this.terminateCount++
  }
}

/** 可手动触发的 interval 调度器，避免测试依赖真实等待。 */
class ManualIntervalScheduler {
  private callback: (() => void) | null = null
  scheduledIntervalMs: number | null = null
  clearedHandles: Array<ReturnType<typeof setInterval>> = []
  scheduledHandles: Array<ReturnType<typeof setInterval>> = []

  schedule = (callback: () => void, intervalMs: number): ReturnType<typeof setInterval> => {
    const handle = Symbol('heartbeat-interval') as unknown as ReturnType<typeof setInterval>
    this.callback = callback
    this.scheduledIntervalMs = intervalMs
    this.scheduledHandles.push(handle)
    return handle
  }

  clear = (handle: ReturnType<typeof setInterval>): void => {
    this.clearedHandles.push(handle)
    if (handle === this.scheduledHandles.at(-1)) this.callback = null
  }

  /** 触发一次已注册的心跳 tick。 */
  tick(): void {
    this.callback?.()
  }
}

/** 创建使用可控时间与调度器的会话管理器。 */
function createHarness(initialNow = 0): {
  manager: LanBridgeSessionManager
  scheduler: ManualIntervalScheduler
  socket: FakeWebSocket
  setNow: (value: number) => void
} {
  let now = initialNow
  const scheduler = new ManualIntervalScheduler()
  const socket = new FakeWebSocket()
  const manager = new LanBridgeSessionManager(20, {
    now: () => now,
    scheduleInterval: scheduler.schedule,
    clearScheduledInterval: scheduler.clear,
    uuid: () => 'client-1',
  })

  return {
    manager,
    scheduler,
    socket,
    setNow: value => { now = value },
  }
}

describe('LanBridgeSessionManager 设备认证与撤销', () => {
  test('设备 Token 认证成功后记录 deviceId', () => {
    /** 当前用例的会话管理器。 */
    const manager = new LanBridgeSessionManager(20, {
      verifyToken: () => ({ valid: true, deviceId: 'device-1' }),
      uuid: () => 'client-1',
    })
    /** 当前用例的测试连接。 */
    const socket = new FakeWebSocket()
    /** 等待认证的客户端。 */
    const client = manager.addClient(socket as unknown as WebSocket, '192.168.1.2')!

    expect(manager.authenticateFromData(client, { token: 'valid-token' })).toBe(true)
    expect(client.authenticated).toBe(true)
    expect(client.deviceId).toBe('device-1')
    expect(client.authToken).toBe('valid-token')
  })

  test('撤销设备时使用合法策略违规关闭码断开其全部连接', () => {
    /** 用于生成不同连接 ID 的序号。 */
    let nextId = 0
    /** 当前用例的会话管理器。 */
    const manager = new LanBridgeSessionManager(20, {
      verifyToken: token => ({ valid: true, deviceId: token }),
      uuid: () => `client-${++nextId}`,
    })
    /** 属于被撤销设备的首个连接。 */
    const firstSocket = new FakeWebSocket()
    /** 属于被撤销设备的第二个连接。 */
    const secondSocket = new FakeWebSocket()
    /** 属于其他设备的连接。 */
    const otherSocket = new FakeWebSocket()
    /** 三个已建立的客户端。 */
    const clients = [firstSocket, secondSocket, otherSocket].map((socket, index) => (
      manager.addClient(socket as unknown as WebSocket, `192.168.1.${index + 2}`)!
    ))
    manager.authenticateFromData(clients[0]!, { token: 'device-1' })
    manager.authenticateFromData(clients[1]!, { token: 'device-1' })
    manager.authenticateFromData(clients[2]!, { token: 'device-2' })

    manager.disconnectDevice('device-1')

    expect(firstSocket.closeCalls).toEqual([{ code: 1008, reason: 'Device revoked' }])
    expect(secondSocket.closeCalls).toEqual([{ code: 1008, reason: 'Device revoked' }])
    expect(otherSocket.closeCalls).toEqual([])
    expect(manager.getClient(clients[0]!.id)).toBeUndefined()
    expect(manager.getClient(clients[1]!.id)).toBeUndefined()
    expect(manager.getClient(clients[2]!.id)).toBe(clients[2])
  })
})

describe('LanBridgeSessionManager 应用层心跳', () => {
  test('新连接在 15 秒收到心跳且不会先断开', () => {
    const harness = createHarness()
    const client = harness.manager.addClient(harness.socket as unknown as WebSocket, '192.168.1.2')
    expect(client).not.toBeNull()

    harness.manager.startHeartbeat()
    harness.setNow(15_000)
    harness.scheduler.tick()

    expect(harness.scheduler.scheduledIntervalMs).toBe(15_000)
    expect(harness.socket.terminateCount).toBe(0)
    expect(harness.socket.sentMessages).toEqual([JSON.stringify({ type: '_heartbeat' })])
  })

  test('15,001 毫秒收到 pong 后，到 60,000 毫秒仍保留连接', () => {
    const harness = createHarness()
    const client = harness.manager.addClient(harness.socket as unknown as WebSocket, '192.168.1.2')!
    harness.manager.startHeartbeat()

    harness.setNow(15_001)
    harness.manager.markPong(client)
    harness.setNow(60_000)
    harness.scheduler.tick()

    expect(harness.socket.terminateCount).toBe(0)
    expect(harness.manager.getClient(client.id)).toBe(client)
  })

  test('从最后 pong 起达到 45 秒时终止并删除连接', () => {
    const harness = createHarness()
    const client = harness.manager.addClient(harness.socket as unknown as WebSocket, '192.168.1.2')!
    harness.manager.startHeartbeat()

    harness.manager.markPong(client, 15_000)
    harness.setNow(60_000)
    harness.scheduler.tick()

    expect(harness.socket.terminateCount).toBe(1)
    expect(harness.manager.getClient(client.id)).toBeUndefined()
    expect(harness.socket.sentMessages).toEqual([])
  })

  test('未回复的新连接拥有完整 45 秒窗口', () => {
    const harness = createHarness()
    const client = harness.manager.addClient(harness.socket as unknown as WebSocket, '192.168.1.2')!
    harness.manager.startHeartbeat()

    for (const now of [15_000, 30_000]) {
      harness.setNow(now)
      harness.scheduler.tick()
      expect(harness.socket.terminateCount).toBe(0)
      expect(harness.manager.getClient(client.id)).toBe(client)
    }

    harness.setNow(45_000)
    harness.scheduler.tick()

    expect(harness.socket.terminateCount).toBe(1)
    expect(harness.manager.getClient(client.id)).toBeUndefined()
    expect(harness.socket.sentMessages).toHaveLength(2)
  })

  test('非 OPEN socket 不发送心跳', () => {
    const harness = createHarness()
    harness.socket.readyState = 0
    harness.manager.addClient(harness.socket as unknown as WebSocket, '192.168.1.2')
    harness.manager.startHeartbeat()

    harness.setNow(15_000)
    harness.scheduler.tick()

    expect(harness.socket.sentMessages).toEqual([])
    expect(harness.socket.terminateCount).toBe(0)
  })

  test('stopHeartbeat 清理已注册的 scheduler', () => {
    const harness = createHarness()
    harness.manager.startHeartbeat()

    harness.manager.stopHeartbeat()

    expect(harness.scheduler.clearedHandles).toHaveLength(1)
    harness.scheduler.tick()
    expect(harness.socket.sentMessages).toEqual([])
  })

  test('连续启动心跳时清理首个 timer 并仅保留第二个有效', () => {
    const harness = createHarness()
    harness.manager.addClient(harness.socket as unknown as WebSocket, '192.168.1.2')

    harness.manager.startHeartbeat()
    const firstHandle = harness.scheduler.scheduledHandles[0]
    harness.manager.startHeartbeat()
    const secondHandle = harness.scheduler.scheduledHandles[1]

    expect(firstHandle).toBeDefined()
    expect(secondHandle).toBeDefined()
    expect(secondHandle).not.toBe(firstHandle)
    expect(harness.scheduler.clearedHandles).toEqual([firstHandle!])

    harness.setNow(15_000)
    harness.scheduler.tick()
    expect(harness.socket.sentMessages).toHaveLength(1)

    harness.manager.stopHeartbeat()
    expect(harness.scheduler.clearedHandles).toEqual([firstHandle!, secondHandle!])
  })

  test('客户端 terminate 抛错时仍删除该连接并继续处理其余客户端', () => {
    let now = 0
    let nextId = 0
    const scheduler = new ManualIntervalScheduler()
    const manager = new LanBridgeSessionManager(20, {
      now: () => now,
      scheduleInterval: scheduler.schedule,
      clearScheduledInterval: scheduler.clear,
      uuid: () => `client-${++nextId}`,
    })
    const throwingSocket = new FakeWebSocket()
    throwingSocket.terminate = () => { throw new Error('terminate failed') }
    throwingSocket.close = (code, reason) => {
      throwingSocket.closeCalls.push({ code, reason })
      throw new Error('close failed')
    }
    const healthySocket = new FakeWebSocket()
    const throwingClient = manager.addClient(throwingSocket as unknown as WebSocket, '192.168.1.2')!
    const healthyClient = manager.addClient(healthySocket as unknown as WebSocket, '192.168.1.3')!
    manager.markPong(healthyClient, 15_000)
    manager.startHeartbeat()

    now = 45_000
    expect(() => scheduler.tick()).not.toThrow()

    expect(manager.getClient(throwingClient.id)).toBeUndefined()
    expect(throwingSocket.closeCalls).toEqual([{
      code: 1011,
      reason: 'Heartbeat timeout cleanup',
    }])
    expect(manager.getClient(healthyClient.id)).toBe(healthyClient)
    expect(healthySocket.sentMessages).toEqual([JSON.stringify({ type: '_heartbeat' })])
  })

  test('markPong 只更新仍注册且对象匹配的目标客户端', () => {
    let now = 0
    let nextId = 0
    const scheduler = new ManualIntervalScheduler()
    const manager = new LanBridgeSessionManager(20, {
      now: () => now,
      scheduleInterval: scheduler.schedule,
      clearScheduledInterval: scheduler.clear,
      uuid: () => `client-${++nextId}`,
    })
    const firstSocket = new FakeWebSocket()
    const secondSocket = new FakeWebSocket()
    const firstClient = manager.addClient(firstSocket as unknown as WebSocket, '192.168.1.2')!
    const secondClient = manager.addClient(secondSocket as unknown as WebSocket, '192.168.1.3')!

    now = 12_345
    manager.markPong(firstClient)

    expect(firstClient.lastPongAt).toBe(12_345)
    expect(secondClient.lastPongAt).toBe(0)

    manager.removeClient(firstClient.id)
    now = 23_456
    manager.markPong(firstClient)
    expect(firstClient.lastPongAt).toBe(12_345)
  })
})
