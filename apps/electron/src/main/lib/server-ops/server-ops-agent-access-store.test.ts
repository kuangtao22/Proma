import { describe, expect, test } from 'bun:test'
import { ServerOpsAgentAccessStore } from './server-ops-agent-access-store'

describe('服务器运维 Agent 授权 Store', () => {
  test('只有一个活动槽并支持精确撤销与范围撤销', () => {
    const store = new ServerOpsAgentAccessStore()
    expect(store.getCurrent()).toBeUndefined()
    store.grant({ sessionId: 'session-1', hostId: 'host-1', granted: true })
    expect(store.get('session-1', 'host-1')).toEqual({ sessionId: 'session-1', hostId: 'host-1', granted: true })
    store.grant({ sessionId: 'session-2', hostId: 'host-2', granted: true })
    expect(store.get('session-1', 'host-1')).toBeUndefined()
    expect(store.getCurrent()).toEqual({ sessionId: 'session-2', hostId: 'host-2', granted: true })
    expect(store.revoke('session-1', 'host-1')).toBe(false)
    expect(store.revoke('session-2', 'host-1')).toBe(false)
    expect(store.revoke('session-2', 'host-2')).toBe(true)
    store.grant({ sessionId: 'session-1', hostId: 'host-1', granted: true })
    expect(store.revokeSession('session-1')).toBe(true)
    store.grant({ sessionId: 'session-1', hostId: 'host-1', granted: true })
    expect(store.revokeHost('host-1')).toBe(true)
    store.grant({ sessionId: 'session-1', hostId: 'host-1', granted: true })
    store.clear()
    expect(store.getCurrent()).toBeUndefined()
  })
})
