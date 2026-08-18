import { describe, expect, test } from 'bun:test'
import { createPairingStartupCoordinator } from './pairing-startup-coordinator'

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
})
