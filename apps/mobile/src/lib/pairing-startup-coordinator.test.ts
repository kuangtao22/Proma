import { describe, expect, test } from 'bun:test'
import {
  createPairingStartupCoordinator,
  startPairingConnection,
} from './pairing-startup-coordinator'

/** 可由测试控制结算时机的 Promise。 */
interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
}

/** 创建用于模拟迟到服务端响应的可控 Promise。 */
function createDeferred<T>(): Deferred<T> {
  /** 暂存 Promise 的成功结算函数。 */
  let resolvePromise: ((value: T) => void) | undefined
  /** 暂存 Promise 的失败结算函数。 */
  let rejectPromise: ((reason: unknown) => void) | undefined
  /** 由测试在地址切换后再结算的请求。 */
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  return {
    promise,
    resolve: value => resolvePromise?.(value),
    reject: reason => rejectPromise?.(reason),
  }
}

describe('移动端启动配对协调器', () => {
  test('Given 服务声明 pairing-ticket When connected 重复到达 Then 票据只提交一次且成功进入认证状态', async () => {
    /** 记录真实协调器发出的认证请求。 */
    const submittedTickets: string[] = []
    /** 记录成功保存的 Token。 */
    const savedTokens: string[] = []
    const coordinator = createPairingStartupCoordinator({
      ticket: 'ticket-1',
      cleanUrl: 'http://192.168.1.2:29888/',
    })
    const callbacks = {
      requestPairTicket: async (ticket: string) => {
        submittedTickets.push(ticket)
        return { token: 'token-1' }
      },
      onAuthenticated: (token: string) => savedTokens.push(token),
      onFallback: () => undefined,
    }

    await Promise.all([
      coordinator.handleConnected({ capabilities: ['pairing-ticket'] }, callbacks),
      coordinator.handleConnected({ capabilities: ['pairing-ticket'] }, callbacks),
    ])

    expect(submittedTickets).toEqual(['ticket-1'])
    expect(savedTokens).toEqual(['token-1'])
    expect(coordinator.hasPendingTicket()).toBe(false)
  })

  test('Given 旧服务或未知 capability When connected Then 清票据并回退 PIN 且不发送请求', async () => {
    /** 记录是否错误提交了票据。 */
    let requestCount = 0
    /** 记录回退提示。 */
    const fallbacks: string[] = []
    const coordinator = createPairingStartupCoordinator({
      ticket: 'ticket-old',
      cleanUrl: 'http://192.168.1.2:29888/',
    })

    await coordinator.handleConnected({ message: 'old server' }, {
      requestPairTicket: async () => {
        requestCount += 1
        return { token: 'unexpected' }
      },
      onAuthenticated: () => undefined,
      onFallback: message => fallbacks.push(message),
    })

    expect(requestCount).toBe(0)
    expect(fallbacks).toEqual(['当前电脑端不支持扫码配对，请使用 PIN 码连接'])
    expect(coordinator.hasPendingTicket()).toBe(false)
  })

  test('Given 已提交票据后连接失败并重连 When connected 再次到达 Then 不会重复消费票据', async () => {
    /** 记录认证请求次数。 */
    let requestCount = 0
    /** 记录失败回退提示。 */
    const fallbacks: string[] = []
    const coordinator = createPairingStartupCoordinator({
      ticket: 'ticket-once',
      cleanUrl: 'http://192.168.1.2:29888/',
    })
    const callbacks = {
      requestPairTicket: async () => {
        requestCount += 1
        throw Object.assign(new Error('disconnected'), { code: 'CONNECTION_LOST' })
      },
      onAuthenticated: () => undefined,
      onFallback: (message: string) => fallbacks.push(message),
    }

    await coordinator.handleConnected({ capabilities: ['pairing-ticket'] }, callbacks)
    await coordinator.handleConnected({ capabilities: ['pairing-ticket'] }, callbacks)

    expect(requestCount).toBe(1)
    expect(fallbacks).toEqual(['连接中断，请检查网络后使用 PIN 码重试'])
  })

  test('Given 扫码目标已同步 When 用户改为手工地址 Then 初始 target 不再覆盖新连接目标', () => {
    const coordinator = createPairingStartupCoordinator({
      ticket: 'ticket-target',
      cleanUrl: 'http://192.168.1.2:29888/',
    })

    expect(coordinator.hasInitialTarget()).toBe(true)
    expect(coordinator.takeInitialTarget()).toEqual({ host: '192.168.1.2', port: '29888' })
    expect(coordinator.hasInitialTarget()).toBe(false)
    expect(coordinator.takeInitialTarget()).toBeNull()
  })

  test('Given 自动配对请求仍 pending When 用户切换地址 Then 解除 pending 并连接手工新地址且忽略迟到成功', async () => {
    /** 模拟仍未返回的 pairTicket 请求。 */
    const deferred = createDeferred<{ token: string }>()
    /** 记录 effect 实际连接过的地址。 */
    const connections: string[] = []
    /** 记录迟到成功是否错误触发认证。 */
    const savedTokens: string[] = []
    /** 模拟控制 PIN 按钮可用性的 React 状态。 */
    let pairingPending = true
    const coordinator = createPairingStartupCoordinator({
      ticket: 'ticket-switch',
      cleanUrl: 'http://192.168.1.2:29888/',
    })
    /** 首次扫码连接尚无前一目标。 */
    let previousTarget = startPairingConnection(coordinator, null, {
      host: '192.168.1.2',
      port: '29888',
    }, {
      connect: (host, port) => connections.push(`${host}:${port}`),
      onPairingCancelled: () => { pairingPending = false },
    })
    /** 保持请求 pending，模拟用户在响应前修改地址。 */
    const pairingRequest = coordinator.handleConnected({ capabilities: ['pairing-ticket'] }, {
      requestPairTicket: () => deferred.promise,
      onAuthenticated: token => savedTokens.push(token),
      onFallback: () => undefined,
    })

    previousTarget = startPairingConnection(coordinator, previousTarget, {
      host: '192.168.1.9',
      port: '31000',
    }, {
      connect: (host, port) => connections.push(`${host}:${port}`),
      onPairingCancelled: () => { pairingPending = false },
    })

    expect(pairingPending).toBe(false)
    expect(connections).toEqual(['192.168.1.2:29888', '192.168.1.9:31000'])
    expect(previousTarget).toEqual({ host: '192.168.1.9', port: '31000' })
    deferred.resolve({ token: 'late-token' })
    await pairingRequest
    expect(savedTokens).toEqual([])
  })

  test('Given 自动配对请求已取消 When 旧请求迟到失败 Then 不显示旧失败且票据不重放', async () => {
    /** 模拟会在取消后失败的 pairTicket 请求。 */
    const deferred = createDeferred<{ token: string }>()
    /** 记录迟到失败是否错误覆盖新连接界面。 */
    const fallbacks: string[] = []
    const coordinator = createPairingStartupCoordinator({
      ticket: 'ticket-failure',
      cleanUrl: 'http://192.168.1.2:29888/',
    })
    /** 启动后保持 pending 的自动配对请求。 */
    const pairingRequest = coordinator.handleConnected({ capabilities: ['pairing-ticket'] }, {
      requestPairTicket: () => deferred.promise,
      onAuthenticated: () => undefined,
      onFallback: message => fallbacks.push(message),
    })

    expect(coordinator.cancel()).toBe(true)
    deferred.reject(Object.assign(new Error('disconnected'), { code: 'CONNECTION_LOST' }))
    await pairingRequest

    expect(fallbacks).toEqual([])
    expect(coordinator.hasPendingTicket()).toBe(false)
  })
})
