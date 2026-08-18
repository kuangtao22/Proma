import { describe, expect, test } from 'bun:test'
import { createWsClient, WsClientError, type WebSocketLike } from './ws-client'

interface ScheduledTask {
  id: number
  callback: () => void
  delay: number
  cleared: boolean
}

/** 提供可控时间推进，验证请求超时与重连调度不会泄漏。 */
class FakeScheduler {
  private nextId = 0
  readonly tasks: ScheduledTask[] = []

  /** 记录定时任务并返回可清理的数字句柄。 */
  schedule = (callback: () => void, delay: number): number => {
    const task = { id: ++this.nextId, callback, delay, cleared: false }
    this.tasks.push(task)
    return task.id
  }

  /** 标记指定定时任务已清理。 */
  clear = (id: unknown): void => {
    const task = this.tasks.find(candidate => candidate.id === id)
    if (task) task.cleared = true
  }

  /** 执行下一个仍有效的定时任务。 */
  runNext(): void {
    const task = this.tasks.find(candidate => !candidate.cleared)
    if (!task) throw new Error('没有可执行的定时任务')
    task.cleared = true
    task.callback()
  }

  /** 返回当前仍有效的定时任务。 */
  activeTasks(): ScheduledTask[] {
    return this.tasks.filter(task => !task.cleared)
  }
}

/** 模拟浏览器 WebSocket 的最小生命周期与事件入口。 */
class FakeWebSocket implements WebSocketLike {
  readyState = 0
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  readonly sent: string[] = []

  /** 记录发送的协议帧。 */
  send(data: string): void {
    this.sent.push(data)
  }

  /** 模拟主动关闭；保留事件触发以覆盖真实浏览器行为。 */
  close(): void {
    this.readyState = 3
    this.onclose?.()
  }

  /** 模拟握手成功。 */
  open(): void {
    this.readyState = 1
    this.onopen?.()
  }

  /** 模拟网络中断。 */
  networkClose(): void {
    this.readyState = 3
    this.onclose?.()
  }

  /** 注入服务端响应或推送。 */
  receive(message: object): void {
    this.onmessage?.({ data: JSON.stringify(message) })
  }
}

/** 创建隔离的客户端测试环境，避免依赖 window 与 localStorage。 */
function createHarness(random = 0) {
  const scheduler = new FakeScheduler()
  const sockets: FakeWebSocket[] = []
  /** 记录 WebSocket 构造时收到的完整 URL。 */
  const createdUrls: string[] = []
  const authExpiredCodes: string[] = []
  const client = createWsClient({
    createWebSocket: (url) => {
      createdUrls.push(url)
      const socket = new FakeWebSocket()
      sockets.push(socket)
      return socket
    },
    schedule: scheduler.schedule,
    clear: scheduler.clear,
    random: () => random,
    authExpired: code => authExpiredCodes.push(code),
  })
  return { client, scheduler, sockets, createdUrls, authExpiredCodes }
}

/** 读取最后一个请求帧，供响应测试复用请求 id。 */
function lastRequest(socket: FakeWebSocket): { id: string; type: string } {
  return JSON.parse(socket.sent.at(-1) ?? '{}') as { id: string; type: string }
}

/** 捕获并校验请求拒绝类型，避免测试把非预期异常当成业务错误。 */
async function captureWsClientError(request: Promise<unknown>): Promise<WsClientError> {
  try {
    await request
  } catch (error) {
    if (error instanceof WsClientError) return error
    throw error
  }
  throw new Error('预期请求被拒绝，但请求已成功')
}

describe('移动端 WebSocket 请求生命周期', () => {
  test('Given 服务端当前主版本为 3 且范围包含 v2 When hello 协商到 v2 Then 配对能力仅在协商后推送', async () => {
    const { client, sockets } = createHarness()
    /** 记录交给业务层的可信协商结果。 */
    const connectedPayloads: unknown[] = []
    client.onPush((message) => {
      if (message.type !== 'connected') return
      connectedPayloads.push(message.data)
      /** 模拟配对协调器在收到能力后提交一次性凭据。 */
      void client.wsReq('auth.pairTicket', { ticket: 'ticket-secret' })
    })
    client.connect('127.0.0.1', '7788')
    sockets[0].open()

    sockets[0].receive({
      type: 'connected',
      data: {
        message: 'Proma LAN Bridge',
        protocolVersion: 3,
        minProtocolVersion: 2,
        maxProtocolVersion: 3,
        serverVersion: 'future',
        capabilities: ['pairing-ticket'],
      },
    })
    const hello = JSON.parse(sockets[0].sent[0] ?? '{}') as { id: string; type: string }
    expect(hello.type).toBe('protocol.hello')
    expect(connectedPayloads).toEqual([])
    expect(sockets[0].sent.some(frame => frame.includes('ticket-secret'))).toBe(false)

    sockets[0].receive({
      type: 'protocol.hello', id: hello.id, ok: true,
      data: { protocolVersion: 2, capabilities: ['pairing-ticket'] },
    })
    await Promise.resolve()

    expect(connectedPayloads).toEqual([
      { protocolVersion: 2, capabilities: ['pairing-ticket'] },
    ])
    expect(sockets[0].sent.some(frame => frame.includes('ticket-secret'))).toBe(true)
    /** 结算测试中的票据请求，确保不遗留 pending 或 timeout。 */
    const pairingRequest = JSON.parse(sockets[0].sent[1] ?? '{}') as { id: string; type: string }
    sockets[0].receive({
      type: 'auth.pairTicket', id: pairingRequest.id, ok: true,
      data: { token: 'issued-token' },
    })
    expect(client.pendingCount()).toBe(0)
  })

  test('Given 已保存 Token When 收到兼容 connected Then hello 成功后才发送认证请求', async () => {
    const { client, sockets } = createHarness()
    client.connect('127.0.0.1', '7788')
    sockets[0].open()

    const verification = client.wsReq('auth.verify', { token: 'saved-secret' })
    expect(sockets[0].sent).toEqual([])

    sockets[0].receive({
      type: 'connected',
      data: {
        message: 'Proma LAN Bridge',
        protocolVersion: 2,
        minProtocolVersion: 2,
        maxProtocolVersion: 2,
        serverVersion: '0.17.42',
        capabilities: ['pairing-ticket'],
      },
    })
    const hello = JSON.parse(sockets[0].sent[0] ?? '{}') as { id: string; type: string; data: object }
    expect(hello).toMatchObject({
      type: 'protocol.hello',
      data: { minProtocolVersion: 2, maxProtocolVersion: 2 },
    })
    expect(sockets[0].sent.some(frame => frame.includes('saved-secret'))).toBe(false)

    sockets[0].receive({
      type: 'protocol.hello', id: hello.id, ok: true,
      data: { protocolVersion: 2, capabilities: ['pairing-ticket'] },
    })
    await Promise.resolve()
    const auth = JSON.parse(sockets[0].sent[1] ?? '{}') as { id: string; type: string }
    expect(auth.type).toBe('auth.verify')
    sockets[0].receive({ type: 'auth.verify', id: auth.id, ok: true, data: { valid: true } })
    expect(await verification).toEqual({ valid: true })
  })

  test('Given connected 主版本不兼容 When 已排队认证 Then 不发送 hello 或 Token 并稳定拒绝', async () => {
    const { client, sockets } = createHarness()
    client.connect('127.0.0.1', '7788')
    sockets[0].open()
    const verification = client.wsReq('auth.verify', { token: 'saved-secret' })

    sockets[0].receive({
      type: 'connected',
      data: {
        message: 'Proma LAN Bridge', protocolVersion: 3,
        minProtocolVersion: 3, maxProtocolVersion: 3,
        serverVersion: 'future', capabilities: ['pairing-ticket'],
      },
    })

    await expect(verification).rejects.toMatchObject({ code: 'PROTOCOL_UNSUPPORTED' })
    expect(sockets[0].sent).toEqual([])
  })

  test('Given 请求挂起 When 网络断开 Then 立即以 CONNECTION_LOST 拒绝并清理 timeout', async () => {
    const { client, scheduler, sockets } = createHarness()
    client.connect('127.0.0.1', '7788')
    sockets[0].open()

    const request = client.wsReq('conversations.list')
    expect(client.pendingCount()).toBe(1)
    sockets[0].networkClose()

    const error = await captureWsClientError(request)
    expect(error.code).toBe('CONNECTION_LOST')
    expect(error.message).toBe('WebSocket connection lost')
    expect(client.pendingCount()).toBe(0)
    expect(scheduler.tasks[0]?.cleared).toBe(true)
  })

  test('Given 正常响应 When 响应到达 Then 清理 timeout 并 resolve', async () => {
    const { client, scheduler, sockets } = createHarness()
    client.connect('127.0.0.1', '7788')
    sockets[0].open()
    const request = client.wsReq('ping')
    const frame = lastRequest(sockets[0])

    sockets[0].receive({ type: 'ping', id: frame.id, ok: true, data: { pong: true } })

    expect(await request).toEqual({ pong: true })
    expect(scheduler.tasks[0]?.cleared).toBe(true)
    expect(client.pendingCount()).toBe(0)
  })

  test('Given 错误响应 When Token 失效或缺失 Then 清理 timeout、拒绝请求并通知认证过期', async () => {
    for (const code of ['TOKEN_EXPIRED', 'AUTH_REQUIRED'] as const) {
      const { client, scheduler, sockets, authExpiredCodes } = createHarness()
      client.connect('127.0.0.1', '7788')
      sockets[0].open()
      const request = client.wsReq('settings.get')
      const frame = lastRequest(sockets[0])

      sockets[0].receive({
        type: 'settings.get', id: frame.id, ok: false,
        error: 'Authentication failed', errorCode: code,
      })

      const error = await captureWsClientError(request)
      expect(error.code).toBe(code)
      expect(error.message).toBe('Authentication failed')
      expect(authExpiredCodes).toEqual([code])
      expect(scheduler.tasks[0]?.cleared).toBe(true)
    }
  })

  test('Given 请求超时 When 迟到响应到达 Then pending 已删除且不会再次结算', async () => {
    const { client, scheduler, sockets } = createHarness()
    const pushedTypes: string[] = []
    client.onPush(message => pushedTypes.push(message.type))
    client.connect('127.0.0.1', '7788')
    sockets[0].open()
    let resolveCount = 0
    const request = client.wsReq('ping', undefined, 50).then(() => { resolveCount += 1 })
    const frame = lastRequest(sockets[0])

    scheduler.runNext()
    await expect(request).rejects.toMatchObject({ code: 'TIMEOUT', message: 'Request timeout' })
    sockets[0].receive({ type: 'ping', id: frame.id, ok: true, data: { pong: true } })
    await Promise.resolve()

    expect(client.pendingCount()).toBe(0)
    expect(resolveCount).toBe(0)
    expect(pushedTypes).toEqual([])
  })

  test('Given WebSocket send 同步抛错 When 发送请求 Then 以 SEND_FAILED 拒绝并只清理一次', async () => {
    const { client, scheduler, sockets } = createHarness()
    client.connect('127.0.0.1', '7788')
    sockets[0].open()
    sockets[0].send = () => { throw new Error('socket write failed') }
    /** 统计 rejection handler 次数，验证迟到事件不会二次处理。 */
    let rejectionCount = 0
    const request = client.wsReq('ping').catch(error => {
      rejectionCount += 1
      throw error
    })

    const error = await captureWsClientError(request)
    expect(error).toMatchObject({ code: 'SEND_FAILED', message: 'socket write failed' })
    expect(error.cause).toBeInstanceOf(Error)
    expect(client.pendingCount()).toBe(0)
    expect(scheduler.activeTasks()).toHaveLength(0)

    sockets[0].receive({ type: 'ping', id: '1', ok: true, data: { pong: true } })
    client.close()
    sockets[0].networkClose()
    await Promise.resolve()
    expect(rejectionCount).toBe(1)
    expect(client.pendingCount()).toBe(0)
    expect(scheduler.activeTasks()).toHaveLength(0)
  })

  test('Given 请求数据循环引用 When 序列化请求 Then 以 SEND_FAILED 拒绝并只清理一次', async () => {
    const { client, scheduler, sockets } = createHarness()
    client.connect('127.0.0.1', '7788')
    sockets[0].open()
    /** 构造 JSON.stringify 无法处理的循环请求数据。 */
    const circularData: Record<string, unknown> = {}
    circularData.self = circularData
    /** 统计 rejection handler 次数，验证后续 close 不会二次处理。 */
    let rejectionCount = 0
    const request = client.wsReq('ping', circularData).catch(error => {
      rejectionCount += 1
      throw error
    })

    const error = await captureWsClientError(request)
    expect(error.code).toBe('SEND_FAILED')
    expect(error.message.length).toBeGreaterThan(0)
    expect(client.pendingCount()).toBe(0)
    expect(scheduler.activeTasks()).toHaveLength(0)

    sockets[0].receive({ type: 'ping', id: '1', ok: true, data: { pong: true } })
    client.close()
    sockets[0].networkClose()
    await Promise.resolve()
    expect(rejectionCount).toBe(1)
    expect(client.pendingCount()).toBe(0)
    expect(scheduler.activeTasks()).toHaveLength(0)
  })
})

describe('移动端 WebSocket 重连状态机', () => {
  test('Given HTTP 与 HTTPS 使用非典型端口 When 建立连接 Then scheme 决定 ws 或 wss 而非端口', () => {
    /** 分别记录 HTTP 443 与 HTTPS 8443 的连接 URL。 */
    const httpHarness = createHarness()
    const httpsHarness = createHarness()

    httpHarness.client.connect('192.168.1.2', '443', 'http:')
    httpsHarness.client.connect('192.168.1.2', '8443', 'https:')

    expect(httpHarness.createdUrls).toEqual(['ws://192.168.1.2:443/ws'])
    expect(httpsHarness.createdUrls).toEqual(['wss://192.168.1.2:8443/ws'])
  })

  test('Given 请求挂起 When 手动关闭 Then 拒绝 pending 但不安排重连', async () => {
    const { client, scheduler, sockets } = createHarness()
    client.connect('127.0.0.1', '7788')
    sockets[0].open()
    const request = client.wsReq('ping')

    client.close()

    await expect(request).rejects.toMatchObject({ code: 'CONNECTION_LOST' })
    expect(scheduler.activeTasks()).toHaveLength(0)
    expect(sockets[0].readyState).toBe(3)
  })

  test('Given 网络断开重复通知 When close 多次触发 Then 只安排一个重连', () => {
    const { client, scheduler, sockets } = createHarness()
    client.connect('127.0.0.1', '7788')
    sockets[0].open()

    sockets[0].networkClose()
    sockets[0].networkClose()

    expect(scheduler.activeTasks()).toHaveLength(1)
    expect(scheduler.activeTasks()[0]?.delay).toBe(1000)
  })

  test('Given 连续断线 When 执行重连 Then 2 倍退避封顶 15 秒且抖动由 random 控制', () => {
    const { client, scheduler, sockets } = createHarness(0.5)
    client.connect('127.0.0.1', '7788')
    sockets[0].open()

    const delays: number[] = []
    for (let index = 0; index < 6; index += 1) {
      sockets.at(-1)?.networkClose()
      delays.push(scheduler.activeTasks()[0]?.delay ?? -1)
      scheduler.runNext()
    }

    expect(delays).toEqual([1050, 2100, 4200, 8400, 14318, 14318])
  })

  test('Given 已到退避封顶 When random 不同 Then 仍保留抖动且延迟不超过 15 秒', () => {
    /** 收集指定 random 下持续故障的重连延迟。 */
    const collectDelays = (random: number): number[] => {
      const { client, scheduler, sockets } = createHarness(random)
      client.connect('127.0.0.1', '7788')
      sockets[0].open()
      const delays: number[] = []
      for (let index = 0; index < 6; index += 1) {
        sockets.at(-1)?.networkClose()
        delays.push(scheduler.activeTasks()[0]?.delay ?? -1)
        scheduler.runNext()
      }
      return delays
    }

    const withoutJitter = collectDelays(0)
    const withMaxJitter = collectDelays(1)
    expect(withoutJitter.at(-1)).toBeLessThan(withMaxJitter.at(-1) ?? 0)
    expect(Math.max(...withMaxJitter)).toBeLessThanOrEqual(15000)
  })

  test('Given 已发生重连 When 新连接 open 后再次断开 Then 基础延迟重置为 1 秒', () => {
    const { client, scheduler, sockets } = createHarness(0.5)
    const reconnectFlags: boolean[] = []
    client.onOpen((_socket, isReconnect) => reconnectFlags.push(isReconnect))
    client.connect('127.0.0.1', '7788')
    sockets[0].open()
    sockets[0].networkClose()
    scheduler.runNext()

    sockets[1].open()
    sockets[1].networkClose()

    expect(reconnectFlags).toEqual([false, true])
    expect(scheduler.activeTasks()[0]?.delay).toBe(1050)
  })

  test('Given 新连接已建立 When 旧 socket 迟到 close 或 message Then 不影响新请求且不重复重连', async () => {
    const { client, scheduler, sockets } = createHarness()
    client.connect('127.0.0.1', '7788')
    sockets[0].open()
    const oldSocket = sockets[0]
    client.connect('127.0.0.1', '7788')
    sockets[1].open()
    const request = client.wsReq('ping')
    const frame = lastRequest(sockets[1])

    oldSocket.networkClose()
    oldSocket.receive({ type: 'ping', id: frame.id, ok: true, data: { stale: true } })
    expect(scheduler.activeTasks().filter(task => task.delay !== 15000)).toHaveLength(0)
    expect(client.pendingCount()).toBe(1)

    sockets[1].receive({ type: 'ping', id: frame.id, ok: true, data: { pong: true } })
    expect(await request).toEqual({ pong: true })
  })

  test('Given 心跳帧 When 服务端发送 _heartbeat Then 自动 pong 且不进入 push handler', () => {
    const { client, sockets } = createHarness()
    const pushedTypes: string[] = []
    client.onPush(message => pushedTypes.push(message.type))
    client.connect('127.0.0.1', '7788')
    sockets[0].open()

    sockets[0].receive({ type: '_heartbeat', ok: true })

    expect(JSON.parse(sockets[0].sent[0] ?? '{}')).toEqual({ type: 'pong' })
    expect(pushedTypes).toEqual([])
  })

  test('Given onOpen handler 已取消 When socket 后续 open Then 不执行旧 effect 回调', () => {
    const { client, sockets } = createHarness()
    const reconnectFlags: boolean[] = []
    const unsubscribe = client.onOpen((_socket, isReconnect) => reconnectFlags.push(isReconnect))
    unsubscribe()

    client.connect('127.0.0.1', '7788')
    sockets[0].open()

    expect(reconnectFlags).toEqual([])
  })
})
