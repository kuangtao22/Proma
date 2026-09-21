import { describe, expect, test } from 'bun:test'
import type { ServerOpsAgentReadAccess } from '@proma/shared'
import { createServerOpsAgentReadController } from './server-ops-agent-read-controller'

/** 手动控制 IPC 回执先后次序，复现撤权与保存竞争。 */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail })
  return { promise, resolve, reject }
}

/** 不含连接秘密的授权样例。 */
const access: ServerOpsAgentReadAccess = { sessionId: 's1', revision: 1, grantedAt: 1, expiresAt: 1_800_001, resources: [{ kind: 'redis', sourceId: 'cache' }] }

describe('只读授权实际页面控制器', () => {
  test('Given get未完成 When 外部撤销广播 Then 迟到get不能复活权限', async () => {
    const read = deferred<ServerOpsAgentReadAccess | null>()
    const controller = createServerOpsAgentReadController({ api: { get: () => read.promise, set: async () => null }, publish: () => undefined })
    const selecting = controller.select('s1', 'p1')
    controller.changed({ previous: access, current: null })
    read.resolve(access)
    await selecting
    expect(controller.snapshot().access).toBeNull()
    expect(controller.snapshot().loading).toBe(false)
  })
  test('Given 草稿 When 取消/跨项目/跨会话 Then 数量只来自保存事实且不串草稿', async () => {
    const controller = createServerOpsAgentReadController({ api: { get: async (id) => id === 's1' ? access : null, set: async () => null }, publish: () => undefined })
    await controller.select('s1', 'p1')
    controller.open(); controller.edit([])
    expect(controller.snapshot().access?.resources).toHaveLength(1)
    controller.close(); controller.open()
    expect(controller.snapshot().resources).toEqual(access.resources)
    await controller.select('s1', 'p2')
    expect(controller.snapshot().open).toBe(false)
    expect(controller.snapshot().access?.resources).toEqual(access.resources)
    controller.open()
    await controller.select('s2', 'p2')
    expect(controller.snapshot()).toMatchObject({ open: false, access: null, resources: [] })
  })
  test('Given 保存先广播后回执 When 随后别会话收到授权 Then 旧回执不覆盖本会话事实', async () => {
    const save = deferred<ServerOpsAgentReadAccess | null>()
    const controller = createServerOpsAgentReadController({ api: { get: async () => access, set: () => save.promise }, publish: () => undefined })
    await controller.select('s1', 'p1'); controller.open()
    const pending = controller.save()
    controller.changed({ previous: access, current: { ...access, revision: 2 } })
    expect(controller.snapshot()).toMatchObject({ saving: false, open: false })
    controller.changed({ previous: null, current: { ...access, sessionId: 's2', revision: 3 } })
    save.resolve({ ...access, revision: 2 })
    await pending
    expect(controller.snapshot().access?.revision).toBe(2)
  })
  test('Given 旧会话保存未完成 When 切换会话 Then 成功与失败回执均不污染新会话', async () => {
    for (const fail of [false, true]) {
      const save = deferred<ServerOpsAgentReadAccess | null>()
      const controller = createServerOpsAgentReadController({ api: { get: async (id) => id === 's1' ? access : null, set: () => save.promise }, publish: () => undefined })
      await controller.select('s1', 'p1'); controller.open()
      const pending = controller.save()
      await controller.select('s2', 'p2')
      if (fail) save.reject(new Error('OLD_ERROR'))
      else save.resolve(access)
      await pending
      expect(controller.snapshot()).toMatchObject({ sessionId: 's2', access: null, error: null, saving: false })
    }
  })
  test('Given 保存失败 Then 保留草稿重试；非法库表不分派IPC；撤销提交空集合', async () => {
    const calls: unknown[] = []
    let fail = true
    const controller = createServerOpsAgentReadController({ api: { get: async () => access, set: async (input) => { calls.push(input); if (fail) throw new Error('SAVE_FAILED'); return null } }, publish: () => undefined })
    await controller.select('s1', 'p1'); controller.open()
    controller.edit([{ kind: 'mysql', sourceId: 'db', instance: false, databases: [] }])
    await controller.save()
    expect(calls).toHaveLength(0)
    controller.edit(access.resources); await controller.save()
    expect(controller.snapshot()).toMatchObject({ open: true, resources: access.resources, error: 'SAVE_FAILED' })
    fail = false; await controller.save([])
    expect(calls.at(-1)).toEqual({ sessionId: 's1', resources: [] })
    expect(controller.snapshot()).toMatchObject({ open: false, access: null })
  })
  test('Given 旧行权限 When 保存 Then 不自动升级SQL；只有显式query=true才提交查询权限', async () => {
    const grants: unknown[] = []
    const rowOnly: ServerOpsAgentReadAccess = {
      sessionId: 's1', revision: 2, grantedAt: 2, expiresAt: 1_800_002,
      resources: [{ kind: 'mysql', sourceId: 'db', instance: false, databases: [{ database: 'app', tables: ['users'], readRows: true }] }],
    }
    const controller = createServerOpsAgentReadController({ api: { get: async () => rowOnly, set: async (grant) => { grants.push(grant); return null } }, publish: () => undefined })
    await controller.select('s1', 'p1'); controller.open(); await controller.save()
    expect(grants.at(-1)).toEqual({ sessionId: 's1', resources: rowOnly.resources })
    controller.open()
    controller.edit([{ kind: 'mysql', sourceId: 'db', instance: false, databases: [{ database: 'app', tables: ['users'], readRows: true, query: true }] }])
    await controller.save()
    expect(grants.at(-1)).toEqual({ sessionId: 's1', resources: [{ kind: 'mysql', sourceId: 'db', instance: false, databases: [{ database: 'app', tables: ['users'], readRows: true, query: true }] }] })
  })
  test('Given 别的会话高代次广播 When 当前会话仍在编辑 Then 草稿与已知代次不被串扰', async () => {
    const controller = createServerOpsAgentReadController({ api: { get: async () => access, set: async () => null }, publish: () => undefined })
    await controller.select('s1', 'p1'); controller.open(); controller.edit([])
    controller.changed({ previous: null, current: { ...access, sessionId: 's2', revision: 100 } })
    controller.changed({ previous: access, current: { ...access, revision: 2 } })
    expect(controller.snapshot()).toMatchObject({ sessionId: 's1', access: { revision: 2 }, resources: access.resources })
  })
  test('Given 旧SSH授权 When 只读保存 Then 先展示影响并使用原token；冲突保留草稿', async () => {
    const calls: Array<{ token?: string; resources: unknown[] }> = []
    const api = {
      get: async () => access,
      impact: async () => ({ token: 'old-token', legacy: { sessionId: 'legacy', hostId: 'host-1', granted: true }, reads: [access] }),
      set: async (grant: { resources: unknown[] }, token?: string) => { calls.push({ resources: grant.resources, token }); throw new Error('SERVER_OPS_ACCESS_IMPACT_CHANGED') },
    }
    const controller = createServerOpsAgentReadController({ api, publish: () => undefined })
    await controller.select('s1', 'p1'); controller.open()
    await controller.loadImpact()
    await controller.save()
    expect(controller.snapshot().confirming).toBe(true)
    expect(calls).toHaveLength(0)
    await controller.confirmSave()
    expect(calls).toEqual([{ resources: access.resources, token: 'old-token' }])
    expect(controller.snapshot()).toMatchObject({ open: true, error: '授权范围已变化，请检查新的影响范围后重试', resources: access.resources })
  })
  test('Given 冲突影响刷新未返回 When 切换会话 Then 迟到影响不污染新会话', async () => {
    const refresh = deferred<{ token: string; legacy: null; reads: ServerOpsAgentReadAccess[] }>()
    const refreshStarted = deferred<void>()
    let calls = 0
    const controller = createServerOpsAgentReadController({ api: {
      get: async (id) => id === 's1' ? access : null,
      impact: () => ++calls === 1 ? Promise.resolve({ token: 'old', legacy: null, reads: [access] }) : (refreshStarted.resolve(), refresh.promise),
      set: async () => { throw new Error('SERVER_OPS_ACCESS_IMPACT_CHANGED') },
    }, publish: () => undefined })
    await controller.select('s1', 'p1'); controller.open(); await controller.loadImpact()
    const pending = controller.save()
    await refreshStarted.promise
    await controller.select('s2', 'p2')
    refresh.resolve({ token: 'late', legacy: null, reads: [] })
    await pending
    expect(controller.snapshot()).toMatchObject({ sessionId: 's2', impact: null, open: false })
  })
  test('Given 正在确认旧SSH撤权 When 本会话广播权限变化 Then 清除待确认提交', async () => {
    const calls: unknown[] = []
    const controller = createServerOpsAgentReadController({ api: {
      get: async () => access,
      impact: async () => ({ token: 'old', legacy: { sessionId: 'legacy', hostId: 'h1', granted: true }, reads: [access] }),
      set: async (grant) => { calls.push(grant); return null },
    }, publish: () => undefined })
    await controller.select('s1', 'p1'); controller.open(); await controller.loadImpact(); await controller.save()
    expect(controller.snapshot().confirming).toBe(true)
    controller.changed({ previous: access, current: { ...access, revision: 2 } })
    await controller.confirmSave()
    expect(controller.snapshot().confirming).toBe(false)
    expect(calls).toEqual([])
  })
})
