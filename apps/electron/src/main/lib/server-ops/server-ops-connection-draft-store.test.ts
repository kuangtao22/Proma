import { describe, expect, test } from 'bun:test'
import { ServerOpsConnectionDraftStore } from './server-ops-connection-draft-store'

describe('Agent 连接草稿内存队列', () => {
  test('Given 普通会话提出草稿 When 面板重复读取 Then 内容可恢复且未保存', () => {
    const store = new ServerOpsConnectionDraftStore(() => 100)
    const changes: string[] = []
    const unsubscribe = store.subscribe((event) => changes.push(event.id))
    const draft = store.prepare('session-a', { kind: 'ssh', name: '测试', address: '10.0.0.8', port: 22, username: 'ops' })
    expect(store.list('session-a')).toEqual([draft])
    if (draft.input.kind === 'ssh') draft.input.name = '被调用方篡改'
    expect(store.list('session-a')[0]?.input).toMatchObject({ name: '测试' })
    const returned = store.list('session-a')[0]
    if (returned?.input.kind === 'ssh') returned.input.address = '被篡改'
    expect(store.list('session-a')[0]?.input).toMatchObject({ address: '10.0.0.8' })
    expect(store.list('session-a')).toHaveLength(1)
    expect(store.list('session-b')).toEqual([])
    expect(store.dismiss('session-b', draft.id)).toBe(false)
    expect(store.dismiss('session-a', draft.id)).toBe(true)
    expect(store.list('session-a')).toEqual([])
    expect(changes).toEqual([draft.id, draft.id])
    unsubscribe()
  })

  test('Given Renderer 事件订阅者抛错 When Agent 建议连接 Then 草稿仍只创建一次且可领取', () => {
    const store = new ServerOpsConnectionDraftStore()
    store.subscribe(() => { throw new Error('window destroyed') })
    const draft = store.prepare('session-a', { kind: 'ssh', name: '测试', address: '10.0.0.8', port: 22, username: 'ops' })
    expect(store.list('session-a')).toEqual([draft])
  })

  test('Given 短时内存容量 When 草稿到期或队列满 Then 限制资源占用', () => {
    let now = 100
    const store = new ServerOpsConnectionDraftStore(() => now)
    const input = { kind: 'redis', label: '缓存', address: '10.0.0.9', port: 6379, transport: 'direct' }
    for (let index = 0; index < 8; index++) store.prepare('session-a', input)
    expect(() => store.prepare('session-a', input)).toThrow('SERVER_OPS_CONNECTION_DRAFT_LIMIT')
    now += 30 * 60 * 1000
    expect(store.list('session-a')).toEqual([])
    expect(store.prepare('session-a', input).createdAt).toBe(now)
  })
})
