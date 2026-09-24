import { expect, test } from 'bun:test'
import { API_WORKBENCH_CHANNELS } from '@proma/shared'
import { createApiWorkbenchPreload } from './api-workbench-preload'

test('Given 合法会话 When 读取目录 Then 通过唯一IPC通道并校验回执', async () => {
  const calls: unknown[] = []
  const api = createApiWorkbenchPreload(async (channel, command) => { calls.push([channel, command]); return { version: 1, revision: 0, collections: [], environments: [], requests: [] } }, () => () => {})
  expect((await api.getCatalog({ sessionId: 'session-1' })).revision).toBe(0)
  expect(calls).toEqual([[API_WORKBENCH_CHANNELS.INVOKE, { method: 'getCatalog', input: { sessionId: 'session-1' } }]])
})
test('Given 损坏run回执 When 读取 Then 明确失败', async () => {
  const api = createApiWorkbenchPreload(async () => ({ runId: 'wrong' }), () => () => {})
  await expect(api.getRun({ sessionId: 'a', runId: 'b' })).rejects.toThrow()
})
test('Given UI跨界参数 When 调用 Then 网络IPC不发生', async () => {
  let called = false
  const api = createApiWorkbenchPreload(async () => { called = true }, () => () => {})
  await expect(api.getCatalog({ sessionId: '../wrong' })).rejects.toThrow()
  expect(called).toBe(false)
})

test('Given 流式事件广播 When 订阅 Then 只把合法事件交给界面并丢弃损坏消息', () => {
  /** 记录订阅通道，并允许测试直接推送原始事件。 */
  let listener: ((value: unknown) => void) | undefined
  let channel = ''
  const api = createApiWorkbenchPreload(async () => undefined, (subscribed, next) => {
    channel = subscribed
    listener = next
    return () => { listener = undefined }
  })
  const received: string[] = []
  const unsubscribe = api.onStream((event) => { received.push(event.events.map((item) => item.data).join(',')) })

  listener?.({ sessionId: 'session', runId: 'run_1', events: [{ index: 0, receivedMs: 1, event: '', id: '', comment: '', data: '甲', raw: 'data: 甲\n', truncated: false }] })
  listener?.({ sessionId: 'session', runId: 'run_1', events: [{ index: 0 }] })

  expect(channel).toBe(API_WORKBENCH_CHANNELS.STREAM)
  expect(received).toEqual(['甲'])
  unsubscribe()
  expect(listener).toBeUndefined()
})

test('Given Cookie Jar 查询与清空 When 调用 Then 只走会话身份并校验回执', async () => {
  const calls: unknown[] = []
  const api = createApiWorkbenchPreload(async (channel, command) => {
    calls.push([channel, command])
    const method = (command as { method: string }).method
    if (method === 'getCookieJar') return { cookies: [{ name: 'sid', domain: '127.0.0.1', path: '/', secure: false, httpOnly: true, expiresAt: null, updatedAt: 3 }] }
    return { cleared: 1 }
  }, () => () => {})

  expect((await api.getCookieJar({ sessionId: 'session-1' })).cookies[0]?.domain).toBe('127.0.0.1')
  expect((await api.clearCookieJar({ sessionId: 'session-1' })).cleared).toBe(1)
  /** 取值不在回执合同里：出现即判损坏协议并拒绝。 */
  const leaking = createApiWorkbenchPreload(async () => ({ cookies: [{ name: 'sid', domain: '127.0.0.1', path: '/', secure: false, httpOnly: true, expiresAt: null, updatedAt: 3, value: 'leak' }] }), () => () => {})
  await expect(leaking.getCookieJar({ sessionId: 'session-1' })).rejects.toThrow()
  expect(calls).toEqual([
    [API_WORKBENCH_CHANNELS.INVOKE, { method: 'getCookieJar', input: { sessionId: 'session-1' } }],
    [API_WORKBENCH_CHANNELS.INVOKE, { method: 'clearCookieJar', input: { sessionId: 'session-1' } }],
  ])
})
