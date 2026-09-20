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
const access: ServerOpsAgentReadAccess = { sessionId: 's1', revision: 1, grantedAt: 1, resources: [{ kind: 'redis', sourceId: 'cache' }] }

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
  test('Given 保存先广播后回执 When 随后别会话取代授权 Then 旧回执不覆盖权威事件', async () => {
    const save = deferred<ServerOpsAgentReadAccess | null>()
    const controller = createServerOpsAgentReadController({ api: { get: async () => access, set: () => save.promise }, publish: () => undefined })
    await controller.select('s1', 'p1'); controller.open()
    const pending = controller.save()
    controller.changed({ previous: access, current: { ...access, revision: 2 } })
    expect(controller.snapshot()).toMatchObject({ saving: false, open: false })
    controller.changed({ previous: { ...access, revision: 2 }, current: { ...access, sessionId: 's2', revision: 3 } })
    save.resolve({ ...access, revision: 2 })
    await pending
    expect(controller.snapshot().access).toBeNull()
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
      sessionId: 's1', revision: 2, grantedAt: 2,
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
})
