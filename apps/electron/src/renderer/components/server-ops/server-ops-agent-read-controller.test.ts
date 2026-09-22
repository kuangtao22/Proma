import { describe, expect, test } from 'bun:test'
import type { ServerOpsAgentDatabaseScope, ServerOpsAgentReadAccess } from '@proma/shared'
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
  test('Given 工作台选中当前库 When 打开后多选禁用表并保存 Then 无需重新选库且保存前不授予权限', async () => {
    /** 保存请求仅在用户显式确认时记录。 */
    const grants: unknown[] = []
    /** 原有另一个库的禁用名单需要完整保留。 */
    const auditScope: ServerOpsAgentDatabaseScope = { database: 'audit', tables: null, excludedTables: ['private'], readRows: true, query: true }
    /** 权威快照使用同一明确范围，避免测试用条件分支掩盖错误资源类型。 */
    const saved: ServerOpsAgentReadAccess = { ...access, resources: [{ kind: 'mysql', sourceId: 'db', instance: false, databases: [auditScope] }] }
    /** 使用真实页面控制器验证打开、取消和提交边界。 */
    const controller = createServerOpsAgentReadController({ api: { get: async () => saved, set: async (grant) => { grants.push(grant); return null } }, publish: () => undefined })
    await controller.select('s1', 'p1')
    controller.open(new Map([['db', 'app']]))
    expect(controller.snapshot().resources[0]).toMatchObject({ databases: [{ database: 'app', tables: null, excludedTables: [], readRows: true, query: true }, auditScope] })
    expect(controller.snapshot().access).toEqual(saved)
    expect(grants).toEqual([])
    controller.close()
    expect(controller.snapshot().resources).toEqual(saved.resources)
    controller.open(new Map([['db', 'app']]))
    /** 连续勾选两个表，其余表通过 tables:null 保持可查询。 */
    const draft = controller.snapshot().resources
    if (draft[0]?.kind === 'mysql') draft[0].databases[0]!.excludedTables = ['users', 'tokens']
    controller.edit(draft)
    await controller.save()
    expect(grants).toEqual([{ sessionId: 's1', resources: draft }])
  })
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
  test('Given 旧范围 When 打开并保存新表禁用设置 Then 仅保存时将所选库改为默认可查询', async () => {
    const grants: unknown[] = []
    const rowOnly: ServerOpsAgentReadAccess = {
      sessionId: 's1', revision: 2, grantedAt: 2, expiresAt: 1_800_002,
      resources: [{ kind: 'mysql', sourceId: 'db', instance: false, databases: [{ database: 'app', tables: ['users'], readRows: true }] }],
    }
    const controller = createServerOpsAgentReadController({ api: { get: async () => rowOnly, set: async (grant) => { grants.push(grant); return null } }, publish: () => undefined })
    await controller.select('s1', 'p1'); controller.open()
    expect(grants).toHaveLength(0)
    expect(controller.snapshot().access).toEqual(rowOnly)
    expect(controller.snapshot().resources).toEqual([{ kind: 'mysql', sourceId: 'db', instance: false, databases: [{ database: 'app', tables: null, excludedTables: [], readRows: true, query: true }] }])
    controller.close()
    expect(controller.snapshot().access).toEqual(rowOnly)
    expect(grants).toHaveLength(0)
    controller.open()
    await controller.save()
    expect(grants.at(-1)).toEqual({ sessionId: 's1', resources: [{ kind: 'mysql', sourceId: 'db', instance: false, databases: [{ database: 'app', tables: null, excludedTables: [], readRows: true, query: true }] }] })
  })
  test('Given 别的会话高代次广播 When 当前会话仍在编辑 Then 草稿与已知代次不被串扰', async () => {
    const controller = createServerOpsAgentReadController({ api: { get: async () => access, set: async () => null }, publish: () => undefined })
    await controller.select('s1', 'p1'); controller.open(); controller.edit([])
    controller.changed({ previous: null, current: { ...access, sessionId: 's2', revision: 100 } })
    controller.changed({ previous: access, current: { ...access, revision: 2 } })
    expect(controller.snapshot()).toMatchObject({ sessionId: 's1', access: { revision: 2 }, resources: access.resources })
  })
  test('Given MySQL与SQLite已有禁用项 When 打开、广播更新并保存 Then 保留禁用项且只开放所选库的查询', async () => {
    /** 模拟旧结构授权，真实后端事实只在保存时更新。 */
    let saved: ServerOpsAgentReadAccess = { ...access, resources: [
      { kind: 'mysql', sourceId: 'db', instance: false, databases: [{ database: 'app', tables: null, excludedTables: ['private'], readRows: false }] },
      { kind: 'sqlite', sourceId: 'file', instance: false, databases: [{ database: 'main', tables: null, excludedTables: ['secret'], readRows: false }] },
    ] }
    /** 记录界面实际提交结果，不访问真实连接。 */
    const controller = createServerOpsAgentReadController({ api: {
      get: async () => saved,
      set: async (grant) => { saved = { ...saved, ...grant, revision: saved.revision + 1 }; return saved },
    }, publish: () => undefined })
    await controller.select('s1', 'p1'); controller.open()
    controller.changed({ previous: saved, current: { ...saved, revision: 2 } })
    expect(controller.snapshot().access?.resources).toEqual(saved.resources)
    await controller.save()
    expect(saved.resources).toEqual([
      { kind: 'mysql', sourceId: 'db', instance: false, databases: [{ database: 'app', tables: null, excludedTables: ['private'], readRows: true, query: true }] },
      { kind: 'sqlite', sourceId: 'file', instance: false, databases: [{ database: 'main', tables: null, excludedTables: ['secret'], readRows: true, query: true }] },
    ])
    expect(controller.snapshot()).toMatchObject({ open: false, saving: false, access: saved, resources: saved.resources })
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
