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

  test('Given 多连接只读授权 When 与操作授权切换 Then 互斥且代次不复用', () => {
    /** 内存 store 与不含真实配置的测试绑定。 */
    const store = new ServerOpsAgentAccessStore()
    const input = { sessionId: 'session-1', resources: [{ kind: 'ssh' as const, hostId: 'host-1' }, { kind: 'redis' as const, sourceId: 'redis-1' }] }
    const bindings = [{ key: 'ssh:host-1', fingerprint: 'host', hostId: 'host-1' }, { key: 'data:redis-1', fingerprint: 'redis', hostId: 'jump-1' }]
    store.grant({ sessionId: 'session-1', hostId: 'host-1', granted: true })
    store.grantRead(input, bindings)
    expect(store.getCurrent()).toBeUndefined()
    const first = store.getReadCurrent()!
    first.resources.splice(0)
    expect(store.getReadCurrent()?.resources).toHaveLength(2)
    expect(store.revokeHost('jump-1')).toBe(true)
    expect(store.getReadCurrent()?.resources).toEqual([{ kind: 'ssh', hostId: 'host-1' }])
    expect(store.getReadCurrent()!.revision).toBeGreaterThan(first.revision)
    store.grant({ sessionId: 'session-2', hostId: 'host-2', granted: true })
    expect(store.getReadCurrent()).toBeUndefined()
    store.grantRead(input, bindings)
    expect(store.getReadCurrent()!.revision).toBeGreaterThan(first.revision)
    expect(store.revokeSession('session-2')).toBe(false)
    expect(store.revokeSession('session-1')).toBe(true)
    expect(store.getReadCurrent()).toBeUndefined()
  })

  test('Given 不匹配绑定 When 授权 Then 原权限不变；变更广播为深复制', () => {
    const store = new ServerOpsAgentAccessStore()
    const input = { sessionId: 'session-1', resources: [{ kind: 'redis' as const, sourceId: 'redis-1' }] }
    const events: unknown[] = []
    const unsubscribe = store.onReadChanged((event) => { events.push(event); if (event.current) event.current.resources.length = 0 })
    expect(() => store.grantRead(input, [])).toThrow('SERVER_OPS_READ_BINDING_INVALID')
    store.grantRead(input, [{ key: 'data:redis-1', fingerprint: 'redis' }])
    expect(store.getReadCurrent()?.resources).toHaveLength(1)
    expect(events).toHaveLength(1)
    store.grantRead({ sessionId: 'other', resources: [] }, [])
    expect(store.getReadCurrent()?.sessionId).toBe('session-1')
    expect(store.revokeSource('redis-1')).toBe(true)
    expect(store.getReadCurrent()).toBeUndefined()
    expect(store.getReadBinding('data:redis-1')).toBeUndefined()
    unsubscribe()
    store.clear()
    expect(events).toHaveLength(2)
  })
})
