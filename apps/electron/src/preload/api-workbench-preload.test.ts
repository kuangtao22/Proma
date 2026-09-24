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
