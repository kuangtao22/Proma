import { describe, expect, test } from 'bun:test'
import { AgentExitPlanService } from './agent-exit-plan-service'

describe('ExitPlan 请求 owner 查询', () => {
  test('Given 待处理请求 When 只读查询 owner Then 返回会话且不消费请求', async () => {
    const service = new AgentExitPlanService()
    const controller = new AbortController()
    let requestId = ''
    const result = service.handleExitPlanMode(
      'session-visible',
      { allowedPrompts: [{ tool: 'Bash', prompt: 'run tests' }] },
      controller.signal,
      (request) => { requestId = request.requestId },
    )

    expect(service.getPendingRequestOwner(requestId)).toBe('session-visible')
    expect(service.getPendingRequestOwner('missing-request')).toBeNull()
    expect(service.respondToExitPlanMode({ requestId, action: 'deny' })).toEqual({
      sessionId: 'session-visible',
      targetMode: null,
    })
    expect((await result).behavior).toBe('deny')
  })
})
