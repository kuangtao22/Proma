import { expect, test } from 'bun:test'
import { createServerOpsConnectionDraftPreload } from './server-ops-connection-draft-preload'

test('Given 跨进程草稿提示 When 不含公开身份或夹带秘密 Then 不传给 Renderer', async () => {
  let eventHandler: ((value: unknown) => void) | undefined
  const received: string[] = []
  const bridge = createServerOpsConnectionDraftPreload(async () => [], (_, handler) => { eventHandler = handler; return () => { eventHandler = undefined } })
  const unsubscribe = bridge.onServerOpsConnectionDraftChanged((event) => received.push(event.id))
  eventHandler?.({ sessionId: 'session-a', id: 'draft-a', password: 'secret' })
  eventHandler?.({ sessionId: 'session-a', id: 'draft-a' })
  expect(received).toEqual(['draft-a'])
  expect(await bridge.listServerOpsConnectionDrafts('session-a')).toEqual([])
  unsubscribe()
})

test('Given 主进程列表错投会话或重复草稿 When Renderer 读取 Then 不展示污染数据', async () => {
  const draft = { id: 'draft-a', sessionId: 'session-b', createdAt: 1, expiresAt: 1000, input: { kind: 'ssh', name: '测试', address: '10.0.0.8', port: 22, username: 'ops' } }
  const mismatched = createServerOpsConnectionDraftPreload(async () => [draft], () => () => undefined)
  await expect(mismatched.listServerOpsConnectionDrafts('session-a')).rejects.toThrow('SERVER_OPS_CONNECTION_DRAFT_INVALID')
  const duplicate = createServerOpsConnectionDraftPreload(async () => [{ ...draft, sessionId: 'session-a' }, { ...draft, sessionId: 'session-a' }], () => () => undefined)
  await expect(duplicate.listServerOpsConnectionDrafts('session-a')).rejects.toThrow('SERVER_OPS_CONNECTION_DRAFT_INVALID')
})
