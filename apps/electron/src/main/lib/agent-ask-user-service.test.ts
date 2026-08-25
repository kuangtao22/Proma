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
})
