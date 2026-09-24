import { describe, expect, test } from 'bun:test'
import { AgentAskUserService } from './agent-ask-user-service'

describe('AskUser 请求 owner 查询', () => {
  test('Given 待处理请求 When 只读查询 owner Then 返回会话且不消费请求', async () => {
    const service = new AgentAskUserService()
    const controller = new AbortController()
    let requestId = ''
    const result = service.handleAskUserQuestion(
      'session-visible',
      { questions: [{ question: '继续吗？', options: [] }] },
      controller.signal,
      (request) => { requestId = request.requestId },
    )

    expect(service.getPendingRequestOwner(requestId)).toBe('session-visible')
    expect(service.getPendingRequestOwner('missing-request')).toBeNull()
    expect(service.respondToAskUser(requestId, { '继续吗？': '继续' })).toBe('session-visible')
    expect(await result).toEqual({
      behavior: 'allow',
      updatedInput: {
        questions: [{ question: '继续吗？', options: [] }],
        answers: { '继续吗？': '继续' },
      },
    })
  })

  test('Given signal 已取消 When 注册问题 Then 不通知 renderer 且立即拒绝', async () => {
    const service = new AgentAskUserService()
    const controller = new AbortController()
    controller.abort()
    let notified = false
    const result = service.handleAskUserQuestion('session-aborted', { questions: [] }, controller.signal, () => { notified = true })
    expect(await result).toEqual({ behavior: 'deny', message: '操作已中止' })
    expect(notified).toBe(false)
    expect(service.getPendingRequests()).toEqual([])
  })

  test('Given 注册监听瞬间 signal 被取消 When 发起问题 Then 不发送已取消问题', async () => {
    const service = new AgentAskUserService()
    const controller = new AbortController()
    const signal = controller.signal
    const originalAddEventListener = signal.addEventListener.bind(signal)
    signal.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: AddEventListenerOptions | boolean) => {
      const result = originalAddEventListener(type, listener, options)
      if (type === 'abort') controller.abort()
      return result
    }) as typeof signal.addEventListener
    let notified = false
    const result = service.handleAskUserQuestion('session-register-abort', { questions: [] }, signal, () => { notified = true })
    expect(await result).toEqual({ behavior: 'deny', message: '操作已中止' })
    expect(notified).toBe(false)
    expect(service.getPendingRequests()).toEqual([])
  })

  test('Given 在途问题 When signal abort Then 清理 pending 并拒绝', async () => {
    const service = new AgentAskUserService()
    const controller = new AbortController()
    const result = service.handleAskUserQuestion('session-abort', { questions: [] }, controller.signal, () => {})
    controller.abort()
    expect(await result).toEqual({ behavior: 'deny', message: '操作已中止' })
    expect(service.getPendingRequests()).toEqual([])
  })

  test('Given 已回答问题 When signal abort Then 不影响已完成结果且 listener 已清理', async () => {
    const service = new AgentAskUserService()
    const controller = new AbortController()
    let requestId = ''
    const result = service.handleAskUserQuestion('session-answer', { questions: [] }, controller.signal, (request) => { requestId = request.requestId })
    service.respondToAskUser(requestId, {})
    controller.abort()
    expect(await result).toEqual({ behavior: 'allow', updatedInput: { questions: [], answers: {} } })
    expect(service.getPendingRequests()).toEqual([])
  })

  test('Given renderer 通知同步抛错 When 发起问题 Then 不遗留 pending', async () => {
    const service = new AgentAskUserService()
    const result = service.handleAskUserQuestion('session-notify-error', { questions: [] }, new AbortController().signal, () => { throw new Error('renderer unavailable') })
    expect(await result).toEqual({ behavior: 'deny', message: '无法显示问题' })
    expect(service.getPendingRequests()).toEqual([])
  })

  test('Given 两个会话各有问题 When 清理一个会话 Then 另一个仍可回答', async () => {
    const service = new AgentAskUserService()
    const first = service.handleAskUserQuestion('session-one', { questions: [] }, new AbortController().signal, () => {})
    let secondId = ''
    const second = service.handleAskUserQuestion('session-two', { questions: [] }, new AbortController().signal, (request) => { secondId = request.requestId })
    service.clearSessionPending('session-one')
    expect(await first).toEqual({ behavior: 'deny', message: '会话已结束' })
    expect(service.respondToAskUser(secondId, {}) ).toBe('session-two')
    expect(await second).toEqual({ behavior: 'allow', updatedInput: { questions: [], answers: {} } })
  })
})
