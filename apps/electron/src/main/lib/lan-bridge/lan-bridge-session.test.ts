import { describe, expect, test } from 'bun:test'
import type { WebSocket } from 'ws'
import {
  MAX_UNAUTHENTICATED_CONNECTIONS_PER_IP,
  UNAUTHENTICATED_CONNECTION_TIMEOUT_MS,
  LanBridgeSessionManager,
} from './lan-bridge-session'

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

/** 可手动触发的单次任务调度器，用于验证未认证连接的绝对截止时间。 */
class ManualTimeoutScheduler {
  private readonly callbacks = new Map<ReturnType<typeof setTimeout>, () => void>()
  readonly delays: number[] = []
  readonly clearedHandles: Array<ReturnType<typeof setTimeout>> = []

  schedule = (callback: () => void, delayMs: number): ReturnType<typeof setTimeout> => {
    /** 当前单次任务的测试句柄。 */
    const handle = Symbol('authentication-deadline') as unknown as ReturnType<typeof setTimeout>
    this.callbacks.set(handle, callback)
    this.delays.push(delayMs)
    return handle
  }

  clear = (handle: ReturnType<typeof setTimeout>): void => {
    this.clearedHandles.push(handle)
    this.callbacks.delete(handle)
  }

  /** 触发仍未被清理的全部单次任务。 */
  fireAll(): void {
    for (const [handle, callback] of [...this.callbacks]) {
      this.callbacks.delete(handle)
      callback()
    }
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

/** 将测试客户端标记为长时间有效的已认证连接，隔离应用层心跳语义。 */
function authenticateHeartbeatClient(client: NonNullable<ReturnType<LanBridgeSessionManager['addClient']>>): void {
  client.authenticated = true
  client.authExpiresAt = 120_000
}

describe('LanBridgeSessionManager 设备认证与撤销', () => {
  test('设备 Token 认证成功后记录 deviceId', () => {
    /** 当前用例的会话管理器。 */
    const manager = new LanBridgeSessionManager(20, {
      verifyToken: () => ({ valid: true, deviceId: 'device-1', expiresAt: 10_000 }),
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
    expect(client.authExpiresAt).toBe(10_000)
  })

  test('撤销设备时使用合法策略违规关闭码断开其全部连接', () => {
    /** 用于生成不同连接 ID 的序号。 */
    let nextId = 0
    /** 当前用例的会话管理器。 */
    const manager = new LanBridgeSessionManager(20, {
      verifyToken: token => ({ valid: true, deviceId: token, expiresAt: 10_000 }),
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

  test('有效期前订阅可收消息，恰好到期时先淘汰且不接收当前推送', () => {
    /** 当前可控时间。 */
    let now = 99
    /** 当前用例的会话管理器。 */
    const manager = new LanBridgeSessionManager(20, {
      now: () => now,
      verifyToken: () => ({ valid: true, deviceId: 'device-1', expiresAt: 100 }),
      uuid: () => 'client-1',
    })
    /** 当前用例的测试连接。 */
    const socket = new FakeWebSocket()
    /** 已认证且已订阅的客户端。 */
    const client = manager.addClient(socket as unknown as WebSocket, '192.168.1.2')!
    manager.authenticateFromData(client, { token: 'valid-token' })
    client.subscriptions.add('session-1')

    for (const subscriber of manager.getSubscribers('session-1')) subscriber.ws.send('before-expiry')
    now = 100
    for (const subscriber of manager.getSubscribers('session-1')) subscriber.ws.send('at-expiry')

    expect(socket.sentMessages).toEqual(['before-expiry'])
    expect(socket.closeCalls).toEqual([{ code: 1008, reason: 'Authentication expired' }])
    expect(client.subscriptions.size).toBe(0)
    expect(manager.getClient(client.id)).toBeUndefined()
    expect(manager.getSubscribers('session-1')).toEqual([])
    expect(socket.closeCalls).toHaveLength(1)
  })

  test('broadcast 和认证客户端列表不会返回或推送给到期连接', () => {
    /** 当前可控时间。 */
    let now = 99
    /** 当前用例的会话管理器。 */
    const manager = new LanBridgeSessionManager(20, {
      now: () => now,
      verifyToken: () => ({ valid: true, deviceId: 'device-1', expiresAt: 100 }),
      uuid: () => 'client-1',
    })
    /** 当前用例的测试连接。 */
    const socket = new FakeWebSocket()
    /** 已认证客户端。 */
    const client = manager.addClient(socket as unknown as WebSocket, '192.168.1.2')!
    manager.authenticateFromData(client, { token: 'valid-token' })

    expect(manager.getAuthenticatedClients()).toEqual([client])
    manager.broadcast({ phase: 'before' })
    now = 100
    manager.broadcast({ phase: 'expired' })

    expect(socket.sentMessages).toEqual([JSON.stringify({ phase: 'before' })])
    expect(manager.getAuthenticatedClients()).toEqual([])
    expect(socket.closeCalls).toEqual([{ code: 1008, reason: 'Authentication expired' }])
  })

  test('认证客户端列表入口会直接淘汰到期连接', () => {
    /** 当前可控时间。 */
    let now = 99
    /** 当前用例的会话管理器。 */
    const manager = new LanBridgeSessionManager(20, {
      now: () => now,
      verifyToken: () => ({ valid: true, deviceId: 'device-1', expiresAt: 100 }),
      uuid: () => 'client-1',
    })
    /** 当前用例的测试连接。 */
    const socket = new FakeWebSocket()
    /** 已认证客户端。 */
    const client = manager.addClient(socket as unknown as WebSocket, '192.168.1.2')!
    manager.authenticateFromData(client, { token: 'valid-token' })

    now = 100

    expect(manager.getAuthenticatedClients()).toEqual([])
    expect(manager.getClient(client.id)).toBeUndefined()
    expect(socket.closeCalls).toEqual([{ code: 1008, reason: 'Authentication expired' }])
  })

  test('只回复 pong 不能延长认证期限，心跳在到期时按 1008 淘汰', () => {
    /** 当前可控时间。 */
    let now = 0
    /** 当前用例的手动调度器。 */
    const scheduler = new ManualIntervalScheduler()
    /** 当前用例的会话管理器。 */
    const manager = new LanBridgeSessionManager(20, {
      now: () => now,
      scheduleInterval: scheduler.schedule,
      clearScheduledInterval: scheduler.clear,
      verifyToken: () => ({ valid: true, deviceId: 'device-1', expiresAt: 100 }),
      uuid: () => 'client-1',
    })
    /** 当前用例的测试连接。 */
    const socket = new FakeWebSocket()
    /** 已认证客户端。 */
    const client = manager.addClient(socket as unknown as WebSocket, '192.168.1.2')!
    manager.authenticateFromData(client, { token: 'valid-token' })
    manager.startHeartbeat()

    now = 99
    manager.markPong(client)
    now = 100
    scheduler.tick()

    expect(client.lastPongAt).toBe(99)
    expect(manager.getClient(client.id)).toBeUndefined()
    expect(socket.closeCalls).toEqual([{ code: 1008, reason: 'Authentication expired' }])
    expect(socket.terminateCount).toBe(0)
    expect(socket.sentMessages).toEqual([])
  })
})

describe('LanBridgeSessionManager 应用层心跳', () => {
  test('同一 IP 最多保留 3 个未认证连接，认证后立即释放待认证名额', () => {
    /** 用于生成不同连接 ID 的序号。 */
    let nextId = 0
    /** 当前用例的会话管理器。 */
    const manager = new LanBridgeSessionManager(20, {
      verifyToken: () => ({ valid: true, deviceId: 'device-1', expiresAt: 60_000 }),
      uuid: () => `client-${++nextId}`,
    })
    /** 同一来源 IP 的测试连接。 */
    const sockets = Array.from(
      { length: MAX_UNAUTHENTICATED_CONNECTIONS_PER_IP + 2 },
      () => new FakeWebSocket(),
    )
    /** 达到单 IP 上限的待认证客户端。 */
    const pendingClients = sockets
      .slice(0, MAX_UNAUTHENTICATED_CONNECTIONS_PER_IP)
      .map(socket => manager.addClient(socket as unknown as WebSocket, '192.168.1.2'))

    expect(MAX_UNAUTHENTICATED_CONNECTIONS_PER_IP).toBe(3)
    expect(pendingClients.every(Boolean)).toBeTrue()
    expect(manager.addClient(
      sockets[MAX_UNAUTHENTICATED_CONNECTIONS_PER_IP]! as unknown as WebSocket,
      '192.168.1.2',
    )).toBeNull()
    expect(sockets[MAX_UNAUTHENTICATED_CONNECTIONS_PER_IP]!.terminateCount).toBe(1)
    expect(sockets[MAX_UNAUTHENTICATED_CONNECTIONS_PER_IP]!.closeCalls).toEqual([])

    manager.authenticateFromData(pendingClients[0]!, { token: 'valid-token' })

    expect(manager.addClient(
      sockets[MAX_UNAUTHENTICATED_CONNECTIONS_PER_IP + 1]! as unknown as WebSocket,
      '192.168.1.2',
    )).not.toBeNull()
  })

  test('达到总连接上限时立即终止未纳管的已升级 WebSocket', () => {
    /** 总连接上限为一的会话管理器。 */
    const manager = new LanBridgeSessionManager(1, { uuid: () => 'client-1' })
    /** 已占用总连接名额的 socket。 */
    const acceptedSocket = new FakeWebSocket()
    /** 因总连接数超限而被拒绝的 socket。 */
    const rejectedSocket = new FakeWebSocket()

    expect(manager.addClient(acceptedSocket as unknown as WebSocket, '192.168.1.2')).not.toBeNull()
    expect(manager.addClient(rejectedSocket as unknown as WebSocket, '192.168.1.3')).toBeNull()

    expect(rejectedSocket.terminateCount).toBe(1)
    expect(rejectedSocket.closeCalls).toEqual([])
    expect(manager.connectionCount).toBe(1)
  })

  test('心跳 tick 后建立的未认证连接仍在 connectedAt 起 15 秒准时终止', () => {
    /** 当前可控时间，模拟连接恰好建立在心跳 tick 之后。 */
    let now = 15_001
    /** 当前用例的单次 deadline 调度器。 */
    const timeoutScheduler = new ManualTimeoutScheduler()
    /** 使用独立 deadline 的会话管理器。 */
    const manager = new LanBridgeSessionManager(20, {
      now: () => now,
      scheduleTimeout: timeoutScheduler.schedule,
      clearScheduledTimeout: timeoutScheduler.clear,
      uuid: () => 'phase-offset-client',
    })
    /** 心跳相位偏移下建立的待认证 socket。 */
    const socket = new FakeWebSocket()
    /** 心跳相位偏移下建立的待认证客户端。 */
    const client = manager.addClient(socket as unknown as WebSocket, '192.168.1.2')!

    expect(timeoutScheduler.delays).toEqual([UNAUTHENTICATED_CONNECTION_TIMEOUT_MS])

    now = client.connectedAt + UNAUTHENTICATED_CONNECTION_TIMEOUT_MS
    timeoutScheduler.fireAll()

    expect(manager.getClient(client.id)).toBeUndefined()
    expect(socket.closeCalls).toEqual([{
      code: 1008,
      reason: 'Authentication timeout',
    }])
  })

  test('deadline 回调延迟时也不允许在 15 秒截止点抢先认证', () => {
    /** 当前可控时间，用于模拟事件循环阻塞导致 timer 尚未回调。 */
    let now = 0
    /** 当前用例的单次 deadline 调度器。 */
    const timeoutScheduler = new ManualTimeoutScheduler()
    /** 能验证 Token 但必须执行绝对期限检查的会话管理器。 */
    const manager = new LanBridgeSessionManager(20, {
      now: () => now,
      scheduleTimeout: timeoutScheduler.schedule,
      clearScheduledTimeout: timeoutScheduler.clear,
      verifyToken: () => ({ valid: true, deviceId: 'device-1', expiresAt: 60_000 }),
      uuid: () => 'delayed-deadline-client',
    })
    /** 尚未执行 deadline 回调的待认证 socket。 */
    const socket = new FakeWebSocket()
    /** 尚未执行 deadline 回调的待认证客户端。 */
    const client = manager.addClient(socket as unknown as WebSocket, '192.168.1.2')!

    now = client.connectedAt + UNAUTHENTICATED_CONNECTION_TIMEOUT_MS

    expect(manager.authenticateFromData(client, { token: 'valid-token' })).toBeFalse()
    expect(manager.getClient(client.id)).toBeUndefined()
    expect(socket.closeCalls).toEqual([{
      code: 1008,
      reason: 'Authentication timeout',
    }])
  })

  test('认证、显式移除与整体关闭都会清理未认证 deadline timer', () => {
    /** 用于生成不同连接 ID 的序号。 */
    let nextId = 0
    /** 当前用例的单次 deadline 调度器。 */
    const timeoutScheduler = new ManualTimeoutScheduler()
    /** 可认证且使用受控 deadline 的会话管理器。 */
    const manager = new LanBridgeSessionManager(20, {
      scheduleTimeout: timeoutScheduler.schedule,
      clearScheduledTimeout: timeoutScheduler.clear,
      verifyToken: () => ({ valid: true, deviceId: 'device-1', expiresAt: 60_000 }),
      uuid: () => `client-${++nextId}`,
    })
    /** 将通过认证释放 timer 的客户端。 */
    const authenticatedClient = manager.addClient(
      new FakeWebSocket() as unknown as WebSocket,
      '192.168.1.2',
    )!
    /** 将通过显式移除释放 timer 的客户端。 */
    const removedClient = manager.addClient(
      new FakeWebSocket() as unknown as WebSocket,
      '192.168.1.3',
    )!
    /** 将由 closeAll 释放 timer 的客户端。 */
    manager.addClient(new FakeWebSocket() as unknown as WebSocket, '192.168.1.4')

    authenticatedClient.authenticated = true
    expect(manager.synchronizeAuthenticationState(authenticatedClient)).toBeTrue()
    manager.removeClient(removedClient.id)
    manager.closeAll()

    expect(timeoutScheduler.clearedHandles).toHaveLength(3)
    timeoutScheduler.fireAll()
    expect(manager.connectionCount).toBe(0)
  })

  test('未认证连接到达 15 秒截止时间后关闭，pong 不能延长占槽时间', () => {
    /** 使用可控时间的会话测试环境。 */
    const harness = createHarness()
    /** 尚未认证的客户端。 */
    const client = harness.manager.addClient(
      harness.socket as unknown as WebSocket,
      '192.168.1.2',
    )!
    harness.manager.startHeartbeat()

    harness.setNow(UNAUTHENTICATED_CONNECTION_TIMEOUT_MS - 1)
    harness.manager.markPong(client)
    harness.setNow(UNAUTHENTICATED_CONNECTION_TIMEOUT_MS)
    harness.scheduler.tick()

    expect(UNAUTHENTICATED_CONNECTION_TIMEOUT_MS).toBe(15_000)
    expect(client.lastPongAt).toBe(UNAUTHENTICATED_CONNECTION_TIMEOUT_MS - 1)
    expect(harness.manager.getClient(client.id)).toBeUndefined()
    expect(harness.socket.closeCalls).toEqual([{
      code: 1008,
      reason: 'Authentication timeout',
    }])
    expect(harness.socket.terminateCount).toBe(0)
    expect(harness.socket.sentMessages).toEqual([])
  })

  test('已认证新连接在 15 秒收到心跳且不会先断开', () => {
    const harness = createHarness()
    const client = harness.manager.addClient(harness.socket as unknown as WebSocket, '192.168.1.2')
    expect(client).not.toBeNull()
    authenticateHeartbeatClient(client!)

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
    authenticateHeartbeatClient(client)
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
    authenticateHeartbeatClient(client)
    harness.manager.startHeartbeat()

    harness.manager.markPong(client, 15_000)
    harness.setNow(60_000)
    harness.scheduler.tick()

    expect(harness.socket.terminateCount).toBe(1)
    expect(harness.manager.getClient(client.id)).toBeUndefined()
    expect(harness.socket.sentMessages).toEqual([])
  })

  test('已认证且未回复的新连接拥有完整 45 秒窗口', () => {
    const harness = createHarness()
    const client = harness.manager.addClient(harness.socket as unknown as WebSocket, '192.168.1.2')!
    authenticateHeartbeatClient(client)
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
    const client = harness.manager.addClient(harness.socket as unknown as WebSocket, '192.168.1.2')!
    authenticateHeartbeatClient(client)

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
    authenticateHeartbeatClient(throwingClient)
    authenticateHeartbeatClient(healthyClient)
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
