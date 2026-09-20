import { describe, expect, test } from 'bun:test'
import { SERVER_OPS_AGENT_READ_CHANNELS } from '@proma/shared'
import { createServerOpsAgentReadPreload } from './server-ops-agent-read-preload'

describe('只读授权 preload', () => {
  test('Given 正常会话 When 保存/读取/订阅 Then 使用严格公开合同', async () => {
    const calls: unknown[] = []
    const input = { sessionId: 'session-1', resources: [{ kind: 'ssh' as const, hostId: 'host-1' }] }
    const snapshot = { ...input, revision: 1, grantedAt: 1 }
    let listener: ((value: unknown) => void) | undefined
    let subscribed = true
    const api = createServerOpsAgentReadPreload(async (channel, value) => { calls.push([channel, value]); return snapshot }, (_channel, callback) => { listener = callback; return () => { subscribed = false } })
    expect(await api.getServerOpsAgentReadAccess('session-1')).toEqual(snapshot)
    expect(await api.setServerOpsAgentReadAccess(input)).toEqual(snapshot)
    const events: unknown[] = []
    const unsubscribe = api.onServerOpsAgentReadAccessChanged((event) => events.push(event))
    listener?.({ previous: null, current: { ...snapshot, password: 'forbidden' } })
    expect(events).toHaveLength(0)
    listener?.({ previous: null, current: snapshot })
    expect(events).toHaveLength(1)
    unsubscribe()
    expect(subscribed).toBe(false)
    expect(calls[0]).toEqual([SERVER_OPS_AGENT_READ_CHANNELS.GET, 'session-1'])
  })
  test('Given 非法请求或污染响应 Then 不传递跨边界数据', async () => {
    let calls = 0
    const api = createServerOpsAgentReadPreload(async () => { calls += 1; return { secret: 'forbidden' } }, () => () => undefined)
    await expect(api.getServerOpsAgentReadAccess('../other')).rejects.toThrow()
    expect(calls).toBe(0)
    await expect(api.getServerOpsAgentReadAccess('session-1')).rejects.toThrow('SERVER_OPS_READ_ACCESS_INVALID')
  })
})
