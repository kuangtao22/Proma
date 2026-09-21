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
    const first = store.getReadAccess('session-1')!
    first.resources.splice(0)
    expect(store.getReadAccess('session-1')?.resources).toHaveLength(2)
    expect(store.revokeHost('jump-1')).toBe(true)
    expect(store.getReadAccess('session-1')?.resources).toEqual([{ kind: 'ssh', hostId: 'host-1' }])
    expect(store.getReadAccess('session-1')!.revision).toBeGreaterThan(first.revision)
    store.grant({ sessionId: 'session-2', hostId: 'host-2', granted: true })
    expect(store.getReadAccess('session-1')).toBeUndefined()
    store.grantRead(input, bindings)
    expect(store.getReadAccess('session-1')!.revision).toBeGreaterThan(first.revision)
    expect(store.revokeSession('session-2')).toBe(false)
    expect(store.revokeSession('session-1')).toBe(true)
    expect(store.getReadAccess('session-1')).toBeUndefined()
  })

  test('Given 不匹配绑定 When 授权 Then 原权限不变；变更广播为深复制', () => {
    const store = new ServerOpsAgentAccessStore()
    const input = { sessionId: 'session-1', resources: [{ kind: 'redis' as const, sourceId: 'redis-1' }] }
    const events: unknown[] = []
    const unsubscribe = store.onReadChanged((event) => { events.push(event); if (event.current) event.current.resources.length = 0 })
    expect(() => store.grantRead(input, [])).toThrow('SERVER_OPS_READ_BINDING_INVALID')
    store.grantRead(input, [{ key: 'data:redis-1', fingerprint: 'redis' }])
    expect(store.getReadAccess('session-1')?.resources).toHaveLength(1)
    expect(events).toHaveLength(1)
    store.grantRead({ sessionId: 'other', resources: [] }, [])
    expect(store.getReadAccess('session-1')?.sessionId).toBe('session-1')
    expect(store.revokeSource('redis-1')).toBe(true)
    expect(store.getReadAccess('session-1')).toBeUndefined()
    expect(store.getReadBinding('session-1', 'data:redis-1')).toBeUndefined()
    unsubscribe()
    store.clear()
    expect(events).toHaveLength(2)
  })

  test('Given 两个会话授权同一资源 When 更新和撤销其中之一 Then 绑定与事件保持会话隔离', () => {
    const store = new ServerOpsAgentAccessStore()
    const events: Array<{ previous: string | null; current: string | null }> = []
    store.onReadChanged(({ previous, current }) => events.push({ previous: previous?.sessionId ?? null, current: current?.sessionId ?? null }))
    const input = (sessionId: string) => ({ sessionId, resources: [{ kind: 'ssh' as const, hostId: 'host-1' }] })
    store.grantRead(input('session-1'), [{ key: 'ssh:host-1', fingerprint: 'first', hostId: 'host-1' }])
    store.grantRead(input('session-2'), [{ key: 'ssh:host-1', fingerprint: 'second', hostId: 'host-1' }])
    const other = store.getReadAccess('session-2')!
    expect(store.getReadBinding('session-1', 'ssh:host-1')?.fingerprint).toBe('first')
    expect(store.getReadBinding('session-2', 'ssh:host-1')?.fingerprint).toBe('second')
    store.grantRead(input('session-1'), [{ key: 'ssh:host-1', fingerprint: 'third', hostId: 'host-1' }])
    expect(store.getReadAccess('session-1')!.revision).toBeGreaterThan(other.revision)
    expect(store.getReadAccess('session-2')).toEqual(other)
    store.grantRead({ sessionId: 'session-1', resources: [] }, [])
    expect(store.getReadAccess('session-2')).toEqual(other)
    expect(events).toEqual([
      { previous: null, current: 'session-1' }, { previous: null, current: 'session-2' },
      { previous: 'session-1', current: 'session-1' }, { previous: 'session-1', current: null },
    ])
    store.clear()
  })

  test('Given 八个活跃会话 When 新会话申请 Then 拒绝但续期现有会话允许', () => {
    const store = new ServerOpsAgentAccessStore()
    for (let index = 0; index < 8; index += 1) store.grantRead({ sessionId: `session-${index}`, resources: [{ kind: 'ssh', hostId: 'host-1' }] }, [{ key: 'ssh:host-1', fingerprint: 'host' }])
    expect(() => store.grantRead({ sessionId: 'session-8', resources: [{ kind: 'ssh', hostId: 'host-1' }] }, [{ key: 'ssh:host-1', fingerprint: 'host' }])).toThrow('SERVER_OPS_READ_SESSION_LIMIT')
    expect(store.listReadAccesses()).toHaveLength(8)
    expect(store.grantRead({ sessionId: 'session-0', resources: [{ kind: 'ssh', hostId: 'host-1' }] }, [{ key: 'ssh:host-1', fingerprint: 'host' }])).toBeDefined()
    store.clear()
  })

  test('Given 固定租期 When 墙钟回拨、缩权和定时器触发 Then 不延长权限', () => {
    let wall = 1_000_000
    let monotonic = 0
    const timers = new Map<number, () => void>()
    let nextTimer = 0
    const clock = {
      now: () => wall,
      monotonicNow: () => monotonic,
      setTimeout: (callback: () => void, _delay: number) => { const id = ++nextTimer; timers.set(id, () => { timers.delete(id); callback() }); return id },
      clearTimeout: (id: unknown) => { timers.delete(id as number) },
    }
    const store = new ServerOpsAgentAccessStore(clock)
    store.grantRead({ sessionId: 'session-1', resources: [{ kind: 'ssh', hostId: 'host-1' }, { kind: 'redis', sourceId: 'redis-1' }] }, [
      { key: 'ssh:host-1', fingerprint: 'ssh', hostId: 'host-1' }, { key: 'data:redis-1', fingerprint: 'redis' },
    ])
    const initial = store.getReadAccess('session-1')!
    expect(initial.expiresAt).toBe(wall + 30 * 60_000)
    wall -= 100_000
    monotonic += 10_000
    expect(store.getReadAccess('session-1')).toBeDefined()
    expect(store.revokeSource('redis-1')).toBe(true)
    expect(store.getReadAccess('session-1')?.expiresAt).toBe(initial.expiresAt)
    expect(store.getReadAccess('session-1')?.grantedAt).toBe(initial.grantedAt)
    monotonic = 30 * 60_000
    expect(store.getReadAccess('session-1')).toBeUndefined()
    expect(store.getReadBinding('session-1', 'ssh:host-1')).toBeUndefined()
    store.grantRead({ sessionId: 'session-1', resources: [{ kind: 'ssh', hostId: 'host-1' }] }, [{ key: 'ssh:host-1', fingerprint: 'ssh' }])
    wall += 30 * 60_000
    for (const callback of [...timers.values()]) callback()
    expect(store.listReadAccesses()).toHaveLength(0)
    store.clear()
    expect(timers.size).toBe(0)
  })

  test('Given 旧操作权限和多个只读会话 When 权限切换 Then 全局互斥但会话撤销精确', () => {
    const store = new ServerOpsAgentAccessStore()
    const read = (sessionId: string) => store.grantRead({ sessionId, resources: [{ kind: 'ssh', hostId: 'host-1' }] }, [{ key: 'ssh:host-1', fingerprint: sessionId, hostId: 'host-1' }])
    read('session-1'); read('session-2')
    expect(store.revokeLegacySession('session-1')).toBe(false)
    store.grant({ sessionId: 'legacy', hostId: 'host-1', granted: true })
    expect(store.listReadAccesses()).toHaveLength(0)
    read('session-1'); read('session-2')
    expect(store.getCurrent()).toBeUndefined()
    expect(store.revokeSession('session-1')).toBe(true)
    expect(store.getReadAccess('session-2')).toBeDefined()
    expect(store.revokeHost('host-1')).toBe(true)
    expect(store.listReadAccesses()).toHaveLength(0)
    store.clear()
  })

  test('Given 撤权监听器同步再授权 When 旧操作授权替换只读 Then 不会出现两类权限并存', () => {
    const store = new ServerOpsAgentAccessStore()
    store.grantRead({ sessionId: 'session-1', resources: [{ kind: 'ssh', hostId: 'host-1' }] }, [{ key: 'ssh:host-1', fingerprint: 'host' }])
    store.grantRead({ sessionId: 'session-3', resources: [{ kind: 'ssh', hostId: 'host-3' }] }, [{ key: 'ssh:host-3', fingerprint: 'host' }])
    const overlaps: boolean[] = []
    store.onReadChanged(({ current }) => {
      overlaps.push(Boolean(store.getCurrent() && store.listReadAccesses().length > 0))
      if (current === null) store.grantRead({ sessionId: 'session-2', resources: [{ kind: 'ssh', hostId: 'host-2' }] }, [{ key: 'ssh:host-2', fingerprint: 'host' }])
    })
    store.grant({ sessionId: 'legacy', hostId: 'host-3', granted: true })
    expect(store.getCurrent() && store.listReadAccesses().length > 0).toBeFalsy()
    expect(overlaps).not.toContain(true)
    store.clear()
  })
})
