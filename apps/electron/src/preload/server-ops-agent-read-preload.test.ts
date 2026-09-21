import { describe, expect, test } from 'bun:test'
import { SERVER_OPS_AGENT_READ_CHANNELS } from '@proma/shared'
import { createServerOpsAgentReadPreload } from './server-ops-agent-read-preload'

describe('只读授权 preload', () => {
  test('Given 正常会话 When 保存/读取/订阅 Then 使用严格公开合同', async () => {
    const calls: unknown[] = []
    const input = { sessionId: 'session-1', resources: [{ kind: 'ssh' as const, hostId: 'host-1' }] }
    const snapshot = { ...input, revision: 1, grantedAt: 1, expiresAt: 1_800_001 }
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
  test('Given 用户确认影响 When 保存授权或切换会话 Then token 与旧 SSH 撤权使用独立桥接', async () => {
    const calls: unknown[] = []
    const grant = { sessionId: 'session-1', resources: [] }
    const api = createServerOpsAgentReadPreload(async (channel, input) => { calls.push([channel, input]); return null }, () => () => {})
    await api.setServerOpsAgentReadAccess(grant, 'preview-token')
    await api.revokeServerOpsLegacyAgentAccessSession('session-1')
    expect(calls).toEqual([
      [SERVER_OPS_AGENT_READ_CHANNELS.SET, { grant, impactToken: 'preview-token' }],
      ['server-ops:revoke-legacy-agent-access-session', 'session-1'],
    ])
    const polluted = createServerOpsAgentReadPreload(async () => ({ token: 'x', legacy: null, reads: [], password: 'secret' }), () => () => {})
    await expect(polluted.getServerOpsAgentAccessImpact()).rejects.toThrow('SERVER_OPS_ACCESS_IMPACT_INVALID')
  })
  test('Given 非法请求或污染响应 Then 不传递跨边界数据', async () => {
    let calls = 0
    const api = createServerOpsAgentReadPreload(async () => { calls += 1; return { secret: 'forbidden' } }, () => () => undefined)
    await expect(api.getServerOpsAgentReadAccess('../other')).rejects.toThrow()
    expect(calls).toBe(0)
    await expect(api.getServerOpsAgentReadAccess('session-1')).rejects.toThrow('SERVER_OPS_READ_ACCESS_INVALID')
  })
})
