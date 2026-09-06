import { describe, expect, test } from 'bun:test'
import { AGENT_RUNTIME_METHODS, createAgentRuntimeRequest } from '@proma/shared'
import {
  createCapabilityCancelRequest,
  ParentRequestRegistry,
} from './agent-runtime-parent-request-registry'

describe('Agent utility 主进程请求生命周期', () => {
  test('Given 无时限权限请求已发送 When 主进程正常批准 Then 只结算一次且后续取消无副作用', async () => {
    /** 模拟工具运行拥有的取消信号。 */
    const controller = new AbortController()
    /** 记录跨进程请求与取消动作。 */
    const sent: string[] = []
    /** 被测请求注册器。 */
    const registry = new ParentRequestRegistry()
    /** 标记请求 Promise 是否已经结算。 */
    let settled = false
    /** 等待主进程正常批准的无时限权限请求。 */
    const pending = registry.wait<{ behavior: 'allow' }>({
      requestId: 'permission-allow',
      method: 'agent.capability.canUseTool',
      signal: controller.signal,
      sendRequest: () => { sent.push('request') },
      sendCancel: () => { sent.push('cancel') },
    }).then((result) => {
      settled = true
      return result
    })

    await Promise.resolve()
    expect(sent).toEqual(['request'])
    expect(settled).toBe(false)
    expect(registry.size).toBe(1)

    expect(registry.resolve('permission-allow', { behavior: 'allow' })).toBe(true)
    await expect(pending).resolves.toEqual({ behavior: 'allow' })
    expect(registry.size).toBe(0)
    expect(registry.resolve('permission-allow', { behavior: 'allow' })).toBe(false)
    expect(registry.reject('permission-allow', new Error('late error'))).toBe(false)

    controller.abort()
    expect(sent).toEqual(['request'])
  })

  test('Given 旧代次能力请求仍待取消 When 当前运行已切到新代次 Then 取消消息保留原请求身份', () => {
    /** 旧代次创建时固化的能力请求。 */
    const original = createAgentRuntimeRequest(
      AGENT_RUNTIME_METHODS.CAPABILITY_CAN_USE_TOOL,
      { toolName: 'Write' },
      { sessionId: 'session-1', queryId: 'query-old' },
      'boot-1',
    )

    /** 取消消息只能引用原请求，不能读取此时可能变化的 activeQuery。 */
    const cancel = createCapabilityCancelRequest(original)

    expect(cancel).toMatchObject({
      method: AGENT_RUNTIME_METHODS.CAPABILITY_CANCEL,
      sessionId: 'session-1',
      queryId: 'query-old',
      payload: { requestId: original.requestId },
    })
  })

  test('Given 权限请求等待用户审批 When 运行被中止 Then 取消主进程能力并释放 pending', async () => {
    /** 模拟工具运行拥有的取消信号。 */
    const controller = new AbortController()
    /** 记录跨进程请求与取消动作。 */
    const sent: string[] = []
    /** 被测请求注册器。 */
    const registry = new ParentRequestRegistry()
    /** 不设墙钟时限的待审批请求。 */
    const pending = registry.wait({
      requestId: 'permission-1',
      method: 'agent.capability.canUseTool',
      signal: controller.signal,
      sendRequest: () => { sent.push('request') },
      sendCancel: () => { sent.push('cancel') },
    })

    controller.abort()

    await expect(pending).rejects.toThrow('Main runtime request aborted: agent.capability.canUseTool')
    expect(sent).toEqual(['request', 'cancel'])
    expect(registry.size).toBe(0)
  })

  test('Given signal 在请求前已中止 When 创建主进程请求 Then 不发送请求或取消消息', async () => {
    /** 已经结束的工具运行信号。 */
    const controller = new AbortController()
    controller.abort()
    /** 记录不应发生的跨进程发送。 */
    const sent: string[] = []
    /** 被测请求注册器。 */
    const registry = new ParentRequestRegistry()

    const pending = registry.wait({
      requestId: 'permission-stale',
      method: 'agent.capability.canUseTool',
      signal: controller.signal,
      sendRequest: () => { sent.push('request') },
      sendCancel: () => { sent.push('cancel') },
    })

    await expect(pending).rejects.toThrow('Main runtime request aborted: agent.capability.canUseTool')
    expect(sent).toEqual([])
    expect(registry.size).toBe(0)
  })

  test('Given utility 退出时仍有无时限审批 When 统一关闭 Then 拒绝请求并移除取消监听', async () => {
    /** 模拟工具运行拥有的取消信号。 */
    const controller = new AbortController()
    /** 记录退出前后的跨进程动作。 */
    const sent: string[] = []
    /** 被测请求注册器。 */
    const registry = new ParentRequestRegistry()
    /** utility 退出前仍在等待的权限请求。 */
    const pending = registry.wait({
      requestId: 'permission-shutdown',
      method: 'agent.capability.canUseTool',
      signal: controller.signal,
      sendRequest: () => { sent.push('request') },
      sendCancel: () => { sent.push('cancel') },
    })

    registry.rejectAll(new Error('Agent runtime is shutting down'))
    controller.abort()

    await expect(pending).rejects.toThrow('Agent runtime is shutting down')
    expect(sent).toEqual(['request'])
    expect(registry.size).toBe(0)
  })

  test('Given 普通能力请求有基础设施时限 When 主进程未响应 Then 取消并返回超时', async () => {
    /** 记录超时触发的跨进程动作。 */
    const sent: string[] = []
    /** 被测请求注册器。 */
    const registry = new ParentRequestRegistry()
    /** 使用极短测试时限的普通能力请求。 */
    const pending = registry.wait({
      requestId: 'ordinary-timeout',
      method: 'agent.capability.customTool',
      timeoutMs: 1,
      sendRequest: () => { sent.push('request') },
      sendCancel: () => { sent.push('cancel') },
    })

    await expect(pending).rejects.toThrow('Main runtime request timed out: agent.capability.customTool')
    expect(sent).toEqual(['request', 'cancel'])
    expect(registry.size).toBe(0)
  })

  test('Given MessagePort 已关闭 When 工具运行取消 Then 即使取消通知发送失败也必须拒绝本地等待', async () => {
    /** 模拟工具运行拥有的取消信号。 */
    const controller = new AbortController()
    /** 被测请求注册器。 */
    const registry = new ParentRequestRegistry()
    /** 等待主进程响应的权限请求。 */
    const pending = registry.wait({
      requestId: 'permission-port-closed',
      method: 'agent.capability.canUseTool',
      signal: controller.signal,
      sendRequest: () => undefined,
      sendCancel: () => { throw new Error('port closed') },
    })

    controller.abort()

    await expect(pending).rejects.toThrow('Main runtime request aborted: agent.capability.canUseTool')
    expect(registry.size).toBe(0)
  })
})
