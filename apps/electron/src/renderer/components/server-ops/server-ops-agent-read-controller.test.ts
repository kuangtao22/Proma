import { describe, expect, test } from 'bun:test'
import type { ServerOpsAgentDatabaseScope, ServerOpsAgentReadAccess, ServerOpsDatabaseAgentPolicy } from '@proma/shared'
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
const databasePolicy: ServerOpsDatabaseAgentPolicy = { revision: 1, exclusions: [{ sourceId: 'db', database: 'app', excludedTables: ['secret'] }] }
/** 等待打开后的策略读取与 finally 发布，避免测试依赖某个 Promise 微任务次序。 */
async function flushPolicy(): Promise<void> {
  for (let tick = 0; tick < 4; tick += 1) await Promise.resolve()
}

describe('只读授权实际页面控制器', () => {
  test('Given 数据库卡片未修改禁用项 When 保存 Then 不续期其他服务器或 Redis 授权', async () => {
    /** 记录任何服务器授权写入，数据库卡片不能借保存影响其它连接。 */
    const writes: unknown[] = []
    const controller = createServerOpsAgentReadController({
      api: { get: async () => access, set: async (input) => { writes.push(input); return access } },
      policyApi: { get: async () => databasePolicy, set: async () => databasePolicy }, publish: () => {},
    })
    await controller.select('s1', 'p1'); controller.open(); await flushPolicy()
    await controller.save(undefined, true, false)
    expect(writes).toEqual([])
    expect(controller.snapshot().open).toBe(false)
  })
  test('Given 没有会话 When 编辑数据库后统一保存 Then 持久禁用且不创建空服务器租约', async () => {
    const policyWrites: unknown[] = []
    const grants: unknown[] = []
    const controller = createServerOpsAgentReadController({
      api: { get: async () => null, set: async (grant) => { grants.push(grant); return null } },
      policyApi: { get: async () => databasePolicy, set: async (input) => { policyWrites.push(input); return { revision: 2, exclusions: input.exclusions } } },
      publish: () => {},
    })
    await controller.select(null, 'p1')
    controller.open()
    await flushPolicy()
    controller.editDatabase([{ sourceId: 'db', database: 'app', excludedTables: ['secret', 'audit'] }])
    await controller.save()
    expect(policyWrites).toEqual([{ expectedRevision: 1, exclusions: [{ sourceId: 'db', database: 'app', excludedTables: ['secret', 'audit'] }] }])
    expect(grants).toEqual([])
    expect(controller.snapshot()).toMatchObject({ open: false, databasePolicy: { revision: 2 }, saving: false })
  })

  test('Given 已有其他连接和库禁用项 When 只编辑当前库 Then 完整保留其余规则并按旧版本 CAS', async () => {
    const original: ServerOpsDatabaseAgentPolicy = { revision: 7, exclusions: [
      { sourceId: 'db', database: 'app', excludedTables: ['secret'] },
      { sourceId: 'db', database: 'audit', excludedTables: ['internal'] },
      { sourceId: 'db-2', database: 'main', excludedTables: ['backup'] },
    ] }
    const writes: unknown[] = []
    const controller = createServerOpsAgentReadController({ api: { get: async () => null, set: async () => null },
      policyApi: { get: async () => original, set: async (input) => { writes.push(input); return { revision: 8, exclusions: input.exclusions } } }, publish: () => {} })
    await controller.select(null, 'p1'); controller.open(); await flushPolicy()
    controller.editDatabase([{ ...original.exclusions[0]!, excludedTables: ['secret', 'audit_log'] }, ...original.exclusions.slice(1)])
    await controller.save()
    expect(writes).toEqual([{ expectedRevision: 7, exclusions: [
      { sourceId: 'db', database: 'app', excludedTables: ['secret', 'audit_log'] },
      ...original.exclusions.slice(1),
    ] }])
  })

  test('Given 另一窗口已提交新策略 When CAS 返回冲突 Then 保留草稿但不改服务器授权', async () => {
    const serverWrites: unknown[] = []
    const controller = createServerOpsAgentReadController({ api: { get: async () => access, set: async (input) => { serverWrites.push(input); return null } },
      policyApi: { get: async () => databasePolicy, set: async () => { throw new Error('SERVER_OPS_DATABASE_AGENT_POLICY_CONFLICT') } }, publish: () => {} })
    await controller.select('s1', 'p1'); controller.open(); await flushPolicy()
    controller.editDatabase([{ sourceId: 'db', database: 'app', excludedTables: ['secret', 'audit'] }]); controller.edit([])
    await controller.save()
    expect(serverWrites).toEqual([])
    expect(controller.snapshot()).toMatchObject({ open: true, databasePolicy, databaseExclusions: [{ sourceId: 'db', database: 'app', excludedTables: ['secret', 'audit'] }],
      databaseError: null, error: '禁用表已在其他窗口更新，请关闭后重新打开检查' })
  })

  test('Given 持久策略写入临时失败 When 原样重试 Then 保留草稿与CAS版本并成功保存', async () => {
    const writes: unknown[] = []
    const controller = createServerOpsAgentReadController({ api: { get: async () => null, set: async () => null },
      policyApi: { get: async () => databasePolicy, set: async (input) => {
        writes.push(input)
        if (writes.length === 1) throw new Error('TEMPORARY_WRITE_FAILURE')
        return { revision: 2, exclusions: input.exclusions }
      } }, publish: () => {} })
    await controller.select(null, 'p1'); controller.open(); await flushPolicy()
    const draft = [{ sourceId: 'db', database: 'app', excludedTables: ['secret', 'audit'] }]
    controller.editDatabase(draft)
    await controller.save()
    expect(controller.snapshot()).toMatchObject({ open: true, databasePolicy, databaseExclusions: draft,
      databaseError: null, error: 'TEMPORARY_WRITE_FAILURE' })
    await controller.save()
    expect(writes).toEqual([
      { expectedRevision: 1, exclusions: draft },
      { expectedRevision: 1, exclusions: draft },
    ])
    expect(controller.snapshot()).toMatchObject({ open: false, databasePolicy: { revision: 2, exclusions: draft }, error: null })
  })

  test('Given 禁用表草稿 When 取消或项目切换 Then 草稿不落盘且旧回执不回填', async () => {
    const read = deferred<ServerOpsDatabaseAgentPolicy>()
    const writes: unknown[] = []
    const controller = createServerOpsAgentReadController({ api: { get: async () => null, set: async () => null },
      policyApi: { get: () => read.promise, set: async (input) => { writes.push(input); return databasePolicy } }, publish: () => {} })
    await controller.select(null, 'p1'); controller.open(); controller.close()
    read.resolve(databasePolicy); await flushPolicy()
    expect(controller.snapshot()).toMatchObject({ open: false, databasePolicy: null, databaseExclusions: [] })
    controller.open(); await flushPolicy()
    controller.editDatabase([])
    await controller.select(null, 'p2')
    expect(controller.snapshot()).toMatchObject({ open: false, databaseExclusions: [] })
    expect(writes).toEqual([])
  })

  test('Given 外部禁用策略更新 When 旧草稿保存 Then 保留新名单并拒绝旧revision', async () => {
    const writes: unknown[] = []
    const next = { revision: 2, exclusions: [{ sourceId: 'db', database: 'app', excludedTables: ['new_secret'] }] }
    const controller = createServerOpsAgentReadController({ api: { get: async () => null, set: async () => null },
      policyApi: { get: async () => databasePolicy, set: async (input) => { writes.push(input); throw new Error('SERVER_OPS_DATABASE_AGENT_POLICY_CONFLICT') } }, publish: () => {} })
    await controller.select(null, 'p1'); controller.open(); await flushPolicy()
    controller.editDatabase([])
    controller.databaseChanged(next)
    await controller.save()
    expect(writes).toEqual([])
    expect(controller.snapshot()).toMatchObject({ databasePolicy: next, databaseExclusions: next.exclusions })
  })

  test('Given 旧SSH授权影响确认 When 同时编辑禁用表 Then 确认前零写、确认后双保存', async () => {
    const events: string[] = []
    const controller = createServerOpsAgentReadController({ api: {
      get: async () => access,
      impact: async () => ({ token: 'token', legacy: { sessionId: 'legacy', hostId: 'host', granted: true }, reads: [access] }),
      set: async () => { events.push('server'); return null },
    }, policyApi: { get: async () => databasePolicy, set: async (input) => { events.push('policy'); return { revision: 2, exclusions: input.exclusions } } }, publish: () => {} })
    await controller.select('s1', 'p1'); controller.open(); await flushPolicy(); await controller.loadImpact()
    controller.edit([...access.resources, { kind: 'ssh', hostId: 'host' }])
    controller.editDatabase([])
    await controller.save()
    expect(controller.snapshot().confirming).toBe(true)
    expect(events).toEqual([])
    await controller.confirmSave()
    expect(events).toEqual(['policy', 'server'])
  })

  test('Given 仅数据库变更且存在旧SSH影响 When 保存 Then 无需确认也不更新服务器租约', async () => {
    const events: string[] = []
    const controller = createServerOpsAgentReadController({ api: {
      get: async () => access,
      impact: async () => ({ token: 'token', legacy: { sessionId: 'legacy', hostId: 'host', granted: true }, reads: [access] }),
      set: async () => { events.push('server'); return null },
    }, policyApi: { get: async () => databasePolicy, set: async (input) => { events.push('policy'); return { revision: 2, exclusions: input.exclusions } } }, publish: () => {} })
    await controller.select('s1', 'p1'); controller.open(); await flushPolicy(); await controller.loadImpact()
    controller.editDatabase([])
    await controller.save()
    expect(events).toEqual(['policy'])
    expect(controller.snapshot()).toMatchObject({ confirming: false, open: false })
  })

  test('Given 同时有两个草稿 When 用户取消旧SSH影响确认 Then 两份配置均未写入', async () => {
    const events: string[] = []
    const controller = createServerOpsAgentReadController({ api: {
      get: async () => access,
      impact: async () => ({ token: 'token', legacy: { sessionId: 'legacy', hostId: 'host', granted: true }, reads: [access] }),
      set: async () => { events.push('server'); return null },
    }, policyApi: { get: async () => databasePolicy, set: async () => { events.push('policy'); return databasePolicy } }, publish: () => {} })
    await controller.select('s1', 'p1'); controller.open(); await flushPolicy(); await controller.loadImpact()
    controller.edit([...access.resources, { kind: 'ssh', hostId: 'host' }]); controller.editDatabase([])
    await controller.save()
    controller.cancelConfirmation()
    await controller.confirmSave()
    expect(events).toEqual([])
    expect(controller.snapshot()).toMatchObject({ confirming: false, open: true })
  })

  test('Given 持久策略提交失败 When 同时编辑服务器 Then 服务器租约绝不先写入', async () => {
    const events: string[] = []
    const controller = createServerOpsAgentReadController({ api: { get: async () => access, set: async () => { events.push('server'); return null } },
      policyApi: { get: async () => databasePolicy, set: async () => { events.push('policy'); throw new Error('POLICY_FAILED') } }, publish: () => {} })
    await controller.select('s1', 'p1'); controller.open(); await flushPolicy()
    controller.edit([]); controller.editDatabase([])
    await controller.save()
    expect(events).toEqual(['policy'])
    expect(controller.snapshot()).toMatchObject({ open: true, error: 'POLICY_FAILED' })
  })

  test('Given 策略加载在途 When SSH 授权广播 Then 策略照常落地且不会永久加载', async () => {
    const policyRead = deferred<ServerOpsDatabaseAgentPolicy>()
    const controller = createServerOpsAgentReadController({ api: { get: async () => access, set: async () => null },
      policyApi: { get: () => policyRead.promise, set: async () => databasePolicy }, publish: () => {} })
    await controller.select('s1', 'p1'); controller.open()
    controller.changed({ previous: access, current: { ...access, revision: 2 } })
    policyRead.resolve(databasePolicy)
    await flushPolicy()
    expect(controller.snapshot()).toMatchObject({ open: true, databaseLoading: false, databasePolicy })
  })

  test('Given 首次服务器授权读取在途 When 全局数据库策略广播 Then SSH读取仍完成且加载态清除', async () => {
    const serverRead = deferred<ServerOpsAgentReadAccess | null>()
    const controller = createServerOpsAgentReadController({ api: { get: () => serverRead.promise, set: async () => null },
      policyApi: { get: async () => databasePolicy, set: async () => databasePolicy }, publish: () => {} })
    const selecting = controller.select('s1', 'p1')
    expect(controller.snapshot().loading).toBe(true)
    controller.databaseChanged(databasePolicy)
    serverRead.resolve(access)
    await selecting
    expect(controller.snapshot()).toMatchObject({ access, databasePolicy, loading: false })
  })

  test('Given SSH 影响加载在途 When 持久策略广播 Then SSH 影响照常落地且不会永久加载', async () => {
    const impactRead = deferred<{ token: string; legacy: null; reads: ServerOpsAgentReadAccess[] }>()
    const controller = createServerOpsAgentReadController({ api: { get: async () => access, set: async () => null,
      impact: () => impactRead.promise }, policyApi: { get: async () => databasePolicy, set: async () => databasePolicy }, publish: () => {} })
    await controller.select('s1', 'p1'); controller.open(); await flushPolicy()
    const pending = controller.loadImpact()
    controller.databaseChanged({ revision: 2, exclusions: databasePolicy.exclusions })
    impactRead.resolve({ token: 'fresh', legacy: null, reads: [access] })
    await pending
    expect(controller.snapshot()).toMatchObject({ impactLoading: false, impact: { token: 'fresh' }, databasePolicy: { revision: 2 } })
  })

  test('Given 关闭时两份读取仍在途 When 结果迟到 Then 不回填旧弹窗的加载态或影响', async () => {
    const policyRead = deferred<ServerOpsDatabaseAgentPolicy>()
    const impactRead = deferred<{ token: string; legacy: null; reads: ServerOpsAgentReadAccess[] }>()
    const controller = createServerOpsAgentReadController({ api: { get: async () => access, set: async () => null,
      impact: () => impactRead.promise }, policyApi: { get: () => policyRead.promise, set: async () => databasePolicy }, publish: () => {} })
    await controller.select('s1', 'p1'); controller.open()
    const pending = controller.loadImpact()
    controller.close()
    expect(controller.snapshot()).toMatchObject({ open: false, databaseLoading: false, impactLoading: false, impact: null })
    policyRead.resolve(databasePolicy)
    impactRead.resolve({ token: 'late', legacy: null, reads: [access] })
    await pending; await flushPolicy()
    expect(controller.snapshot()).toMatchObject({ open: false, databasePolicy: null, impactLoading: false, impact: null })
  })

  test('Given 策略读取失败 When 打开面板 Then 明确告知旧禁用规则不变且禁止空名单保存', async () => {
    const writes: unknown[] = []
    const controller = createServerOpsAgentReadController({ api: { get: async () => null, set: async () => null },
      policyApi: { get: async () => { throw new Error('PRIVATE_PATH_OR_RAW_IPC_ERROR') }, set: async (input) => { writes.push(input); return databasePolicy } }, publish: () => {} })
    await controller.select(null, 'p1'); controller.open(); await flushPolicy()
    expect(controller.snapshot()).toMatchObject({ open: true, databaseLoading: false,
      databasePolicy: null, databaseError: '读取禁用表失败，请重试；已有禁用规则不会改变' })
    await controller.save()
    expect(writes).toEqual([])
  })

  test('Given 已授权服务器且数据库无变更 When 显式保存 Then 续期会话租约；数据库单独变更不续租', async () => {
    const grants: unknown[] = []
    const controller = createServerOpsAgentReadController({ api: { get: async () => access,
      set: async (grant) => { grants.push(grant); return { ...access, revision: 2, expiresAt: 2_000_000 } } },
      policyApi: { get: async () => databasePolicy, set: async (input) => ({ revision: 2, exclusions: input.exclusions }) }, publish: () => {} })
    await controller.select('s1', 'p1'); controller.open(); await flushPolicy(); await controller.save()
    expect(grants).toEqual([{ sessionId: 's1', resources: access.resources }])
    controller.open(); await flushPolicy(); controller.editDatabase([]); await controller.save()
    expect(grants).toHaveLength(1)
  })

  test('Given 数据库写入时自身广播 When 回执较晚 Then 服务器保存仍执行且面板不会提前关闭', async () => {
    const policyWrite = deferred<ServerOpsDatabaseAgentPolicy>()
    const events: string[] = []
    const controller = createServerOpsAgentReadController({ api: { get: async () => access, set: async () => { events.push('server'); return null } },
      policyApi: { get: async () => databasePolicy, set: () => policyWrite.promise }, publish: () => {} })
    await controller.select('s1', 'p1'); controller.open(); await flushPolicy(); controller.editDatabase([]); controller.edit([])
    const pending = controller.save()
    const saved: ServerOpsDatabaseAgentPolicy = { revision: 2, exclusions: [] }
    controller.databaseChanged(saved)
    expect(controller.snapshot()).toMatchObject({ open: true, saving: true })
    policyWrite.resolve(saved)
    await pending
    expect(events).toEqual(['server'])
    expect(controller.snapshot()).toMatchObject({ open: false, saving: false })
  })

  test('Given 数据库提交在途 When 外部SSH变更 Then 等策略结果、阻断旧token的服务器写入并提示部分成功', async () => {
    const policyWrite = deferred<ServerOpsDatabaseAgentPolicy>()
    const serverWrites: unknown[] = []
    const controller = createServerOpsAgentReadController({ api: { get: async () => access,
      set: async (grant) => { serverWrites.push(grant); return null } },
      policyApi: { get: async () => databasePolicy, set: () => policyWrite.promise }, publish: () => {} })
    await controller.select('s1', 'p1'); controller.open(); await flushPolicy()
    controller.editDatabase([]); controller.edit([])
    const pending = controller.save()
    const external: ServerOpsAgentReadAccess = { ...access, revision: 2, resources: [{ kind: 'ssh', hostId: 'other' }] }
    controller.changed({ previous: access, current: external })
    expect(controller.snapshot()).toMatchObject({ open: true, saving: true, databasePolicy })
    policyWrite.resolve({ revision: 2, exclusions: [] })
    await pending
    expect(serverWrites).toEqual([])
    expect(controller.snapshot()).toMatchObject({ open: true, saving: false, databasePolicy: { revision: 2, exclusions: [] }, access: external,
      error: '禁用表已保存；服务器授权已变化，请关闭后重新打开检查' })
  })

  test('Given 外部SSH变更且禁用策略提交失败 When 回执返回 Then 不误报禁用表已保存且草稿可重试', async () => {
    const policyWrite = deferred<ServerOpsDatabaseAgentPolicy>()
    const serverWrites: unknown[] = []
    const controller = createServerOpsAgentReadController({ api: { get: async () => access,
      set: async (grant) => { serverWrites.push(grant); return null } },
      policyApi: { get: async () => databasePolicy, set: () => policyWrite.promise }, publish: () => {} })
    await controller.select('s1', 'p1'); controller.open(); await flushPolicy()
    controller.editDatabase([]); controller.edit([])
    const pending = controller.save()
    controller.changed({ previous: access, current: { ...access, revision: 2, resources: [{ kind: 'ssh', hostId: 'other' }] } })
    policyWrite.reject(new Error('POLICY_FAILED'))
    await pending
    expect(serverWrites).toEqual([])
    expect(controller.snapshot()).toMatchObject({ open: true, saving: false, databasePolicy, databaseExclusions: [], error: '禁用表保存失败：POLICY_FAILED；服务器授权已变化，请关闭后重新打开检查' })
  })

  test('Given 仅禁用表提交在途 When SSH授权广播 Then 策略回执仍成功且不误报冲突', async () => {
    const policyWrite = deferred<ServerOpsDatabaseAgentPolicy>()
    const controller = createServerOpsAgentReadController({ api: { get: async () => access, set: async () => null },
      policyApi: { get: async () => databasePolicy, set: () => policyWrite.promise }, publish: () => {} })
    await controller.select('s1', 'p1'); controller.open(); await flushPolicy(); controller.editDatabase([])
    const pending = controller.save()
    controller.changed({ previous: access, current: { ...access, revision: 2 } })
    policyWrite.resolve({ revision: 2, exclusions: [] })
    await pending
    expect(controller.snapshot()).toMatchObject({ open: false, saving: false, error: null, databasePolicy: { revision: 2, exclusions: [] } })
  })

  test('Given 双配置保存时自身SSH广播 When 服务器回执随后返回 Then 正常完成保存', async () => {
    const serverWrite = deferred<ServerOpsAgentReadAccess | null>()
    const controller = createServerOpsAgentReadController({ api: { get: async () => access, set: () => serverWrite.promise },
      policyApi: { get: async () => databasePolicy, set: async (input) => ({ revision: 2, exclusions: input.exclusions }) }, publish: () => {} })
    await controller.select('s1', 'p1'); controller.open(); await flushPolicy()
    controller.editDatabase([]); controller.edit([])
    const pending = controller.save()
    await flushPolicy()
    controller.changed({ previous: access, current: { ...access, revision: 2, resources: [] } })
    serverWrite.resolve({ ...access, revision: 2, resources: [] })
    await pending
    expect(controller.snapshot()).toMatchObject({ open: false, saving: false, error: null, databasePolicy: { revision: 2, exclusions: [] } })
  })

  test('Given 服务器提交在途 When 外部SSH变更 Then 不静默闭窗并刷新最终权威授权', async () => {
    const serverWrite = deferred<ServerOpsAgentReadAccess | null>()
    const external: ServerOpsAgentReadAccess = { ...access, revision: 2, resources: [{ kind: 'ssh', hostId: 'other' }] }
    let current = access
    const controller = createServerOpsAgentReadController({ api: { get: async () => current, set: () => serverWrite.promise },
      policyApi: { get: async () => databasePolicy, set: async (input) => ({ revision: 2, exclusions: input.exclusions }) }, publish: () => {} })
    await controller.select('s1', 'p1'); controller.open(); await flushPolicy()
    controller.editDatabase([]); controller.edit([])
    const pending = controller.save()
    await flushPolicy()
    current = external
    controller.changed({ previous: access, current: external })
    expect(controller.snapshot()).toMatchObject({ open: true, saving: true })
    serverWrite.reject(new Error('SERVER_OPS_ACCESS_IMPACT_CHANGED'))
    await pending
    expect(controller.snapshot()).toMatchObject({ open: true, saving: false, access: external, databasePolicy: { revision: 2, exclusions: [] },
      error: '禁用表已保存；服务器授权已变化，请关闭后重新打开检查' })
  })

  test('Given 策略成功但租约失败 When 重试 Then 不重复写策略并明确报告部分成功', async () => {
    let policyWrites = 0
    let serverWrites = 0
    const controller = createServerOpsAgentReadController({ api: { get: async () => access, set: async () => { serverWrites++; if (serverWrites === 1) throw new Error('SERVER_FAILED'); return null } },
      policyApi: { get: async () => databasePolicy, set: async (input) => { policyWrites++; return { revision: 2, exclusions: input.exclusions } } }, publish: () => {} })
    await controller.select('s1', 'p1'); controller.open(); await flushPolicy(); controller.editDatabase([]); controller.edit([])
    await controller.save()
    expect(controller.snapshot()).toMatchObject({ open: true, error: '禁用表已保存；服务器授权失败：SERVER_FAILED' })
    await controller.save()
    expect(policyWrites).toBe(1)
    expect(serverWrites).toBe(2)
  })

  test('Given 禁用草稿未保存 When 仅撤销服务器授权 Then 禁用表保持权威快照', async () => {
    const policies: unknown[] = []
    const grants: unknown[] = []
    const controller = createServerOpsAgentReadController({ api: { get: async () => access, set: async (grant) => { grants.push(grant); return null } },
      policyApi: { get: async () => databasePolicy, set: async (input) => { policies.push(input); return databasePolicy } }, publish: () => {} })
    await controller.select('s1', 'p1'); controller.open(); await flushPolicy(); controller.editDatabase([])
    await controller.save([], false)
    expect(policies).toEqual([])
    expect(grants).toEqual([{ sessionId: 's1', resources: [] }])
    expect(controller.snapshot().databasePolicy).toEqual(databasePolicy)
  })
  test('Given 旧租约含数据库 When 打开并保存 Then 数据库范围不再发送会话授权', async () => {
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
    controller.edit([...controller.snapshot().resources, { kind: 'redis', sourceId: 'cache' }])
    await controller.save()
    expect(grants).toEqual([{ sessionId: 's1', resources: [{ kind: 'redis', sourceId: 'cache' }] }])
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
    controller.edit([])
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
      controller.edit([])
      const pending = controller.save()
      await controller.select('s2', 'p2')
      if (fail) save.reject(new Error('OLD_ERROR'))
      else save.resolve(access)
      await pending
      expect(controller.snapshot()).toMatchObject({ sessionId: 's2', access: null, error: null, saving: false })
    }
  })
  test('Given 服务器授权保存失败 Then 保留草稿重试；撤销提交空集合', async () => {
    const calls: unknown[] = []
    let fail = true
    const controller = createServerOpsAgentReadController({ api: { get: async () => access, set: async (input) => { calls.push(input); if (fail) throw new Error('SAVE_FAILED'); return null } }, publish: () => undefined })
    await controller.select('s1', 'p1'); controller.open()
    controller.edit([...access.resources, { kind: 'ssh', hostId: 'host' }]); await controller.save()
    expect(controller.snapshot()).toMatchObject({ open: true, error: 'SAVE_FAILED' })
    fail = false; await controller.save([])
    expect(calls.at(-1)).toEqual({ sessionId: 's1', resources: [] })
    expect(controller.snapshot()).toMatchObject({ open: false, access: null })
  })
  test('Given 旧数据库会话范围 When 不编辑服务器授权 Then 不写临时租约', async () => {
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
    expect(grants).toEqual([])
  })
  test('Given 别的会话高代次广播 When 当前会话仍在编辑 Then 草稿与已知代次不被串扰', async () => {
    const controller = createServerOpsAgentReadController({ api: { get: async () => access, set: async () => null }, publish: () => undefined })
    await controller.select('s1', 'p1'); controller.open(); controller.edit([])
    controller.changed({ previous: null, current: { ...access, sessionId: 's2', revision: 100 } })
    controller.changed({ previous: access, current: { ...access, revision: 2 } })
    expect(controller.snapshot()).toMatchObject({ sessionId: 's1', access: { revision: 2 }, resources: access.resources })
  })
  test('Given MySQL与SQLite旧租约 When 授权广播后保存 Then 不把旧数据库范围再写入租约', async () => {
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
      { kind: 'mysql', sourceId: 'db', instance: false, databases: [{ database: 'app', tables: null, excludedTables: ['private'], readRows: false }] },
      { kind: 'sqlite', sourceId: 'file', instance: false, databases: [{ database: 'main', tables: null, excludedTables: ['secret'], readRows: false }] },
    ])
    expect(controller.snapshot()).toMatchObject({ open: false, saving: false })
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
    controller.edit([...access.resources, { kind: 'ssh', hostId: 'host-1' }])
    await controller.loadImpact()
    await controller.save()
    expect(controller.snapshot().confirming).toBe(true)
    expect(calls).toHaveLength(0)
    await controller.confirmSave()
    expect(calls).toEqual([{ resources: [...access.resources, { kind: 'ssh', hostId: 'host-1' }], token: 'old-token' }])
    expect(controller.snapshot()).toMatchObject({ open: true, error: '授权范围已变化，请检查新的影响范围后重试' })
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
    await controller.select('s1', 'p1'); controller.open(); controller.edit([]); await controller.loadImpact()
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
    await controller.select('s1', 'p1'); controller.open(); controller.edit([...access.resources, { kind: 'ssh', hostId: 'h1' }]); await controller.loadImpact(); await controller.save()
    expect(controller.snapshot().confirming).toBe(true)
    controller.changed({ previous: access, current: { ...access, revision: 2 } })
    await controller.confirmSave()
    expect(controller.snapshot().confirming).toBe(false)
    expect(calls).toEqual([])
  })
})
