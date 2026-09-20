import { describe, expect, test } from 'bun:test'
import type { ServerOpsDataDiagnoseInput, ServerOpsDataDiagnosticsResult } from '@proma/shared'
import { createServerOpsDiagnosticsController } from './server-ops-diagnostics-controller'

/** 可控诊断结果，不访问真实数据库。 */
function result(label: string): ServerOpsDataDiagnosticsResult {
  return { sourceId: 'source', engine: 'mysql', capability: 'available', collectedAt: 1, metrics: [{ id: 'version', label: '版本', value: label }], tables: [], warnings: [] }
}

/** 推进队列和 Promise 回执。 */
async function flush(): Promise<void> { for (let tick = 0; tick < 30; tick += 1) await Promise.resolve() }

describe('数据库按页诊断', () => {
  test('Given 实例与库两个控制器 When 往返同名页面并切库 Then 范围和缓存分别保留', async () => {
    /** 同一 API 与队列验证真实请求的范围，不把两个调用域隔离成假成功。 */
    const calls: ServerOpsDataDiagnoseInput[] = []
    const api = { diagnoseServerOpsDataSource: async (input: ServerOpsDataDiagnoseInput) => { calls.push(input); return result(input.database ?? 'instance') } }
    const instance = createServerOpsDiagnosticsController({ api, publish: () => undefined })
    const database = createServerOpsDiagnosticsController({ api, publish: () => undefined })
    for (const controller of [instance, database]) { controller.activate(); controller.setSource('source', 'config', true) }
    database.setDatabase('app')
    database.selectPage('sessions')
    await flush()
    database.selectPage(null)
    instance.selectPage('sessions')
    await flush()
    instance.selectPage(null)
    database.selectPage('sessions')
    await flush()
    expect(calls).toEqual([{ sourceId: 'source', section: 'sessions', database: 'app' }, { sourceId: 'source', section: 'sessions' }])
    expect(database.getProjection().pages.sessions?.result?.metrics[0]?.value).toBe('app')
    database.setDatabase('archive')
    await flush()
    database.selectPage(null)
    instance.selectPage('sessions')
    await flush()
    expect(calls).toHaveLength(3)
    expect(instance.getProjection().pages.sessions?.result?.metrics[0]?.value).toBe('instance')
    expect(database.getProjection().pages.sessions?.result?.metrics[0]?.value).toBe('archive')
    instance.dispose()
    database.dispose()
  })

  test('Given 库语句读取尚未完成 When 进入实例并返回 Then 晚到结果仅缓存到原范围', async () => {
    /** 两个控制器共用同一来源诊断队列，模拟库请求延迟。 */
    let finish!: (value: ServerOpsDataDiagnosticsResult) => void
    const pending = new Promise<ServerOpsDataDiagnosticsResult>((resolve) => { finish = resolve })
    const calls: ServerOpsDataDiagnoseInput[] = []
    const api = { diagnoseServerOpsDataSource: (input: ServerOpsDataDiagnoseInput) => { calls.push(input); return input.database ? pending : Promise.resolve(result('instance')) } }
    const instance = createServerOpsDiagnosticsController({ api, publish: () => undefined })
    const database = createServerOpsDiagnosticsController({ api, publish: () => undefined })
    for (const controller of [instance, database]) { controller.activate(); controller.setSource('source', 'config', true) }
    database.setDatabase('app')
    database.selectPage('statements')
    await flush()
    database.selectPage(null)
    instance.selectPage('statements')
    expect(instance.getProjection().pages.statements?.result).toBeUndefined()
    finish(result('app'))
    await flush()
    expect(instance.getProjection().pages.statements?.result?.metrics[0]?.value).toBe('instance')
    instance.selectPage(null)
    database.selectPage('statements')
    await flush()
    expect(database.getProjection().pages.statements?.result?.metrics[0]?.value).toBe('app')
    expect(calls).toHaveLength(2)
    instance.dispose()
    database.dispose()
  })

  test('Given 已选库 When 查看会话或慢语句 Then 请求携带库名且切库不复用旧快照', async () => {
    /** 记录实际发送的范围，而不是仅断言界面文字。 */
    const calls: ServerOpsDataDiagnoseInput[] = []
    const controller = createServerOpsDiagnosticsController({ api: { diagnoseServerOpsDataSource: async (input) => { calls.push(input); return result(input.database ?? 'instance') } }, publish: () => undefined })
    controller.activate()
    controller.setSource('source', 'config', true)
    controller.setDatabase('app')
    controller.selectPage('sessions')
    await flush()
    controller.selectPage('statements')
    await flush()
    expect(calls).toEqual([{ sourceId: 'source', section: 'sessions', database: 'app' }, { sourceId: 'source', section: 'statements', database: 'app' }])
    controller.setDatabase('archive')
    expect(controller.getProjection().pages.sessions).toBeUndefined()
    expect(controller.getProjection().pages.statements?.result).toBeUndefined()
    await flush()
    expect(calls.at(-1)).toEqual({ sourceId: 'source', section: 'statements', database: 'archive' })
    expect(controller.getProjection().pages.statements?.result?.metrics[0]?.value).toBe('archive')
  })

  test('Given 实例参数在途 When 切库 Then 不作废全局请求也不重复读取', async () => {
    /** 保持参数请求在途，覆盖全局与库级请求的不同生命周期。 */
    let finish!: (value: ServerOpsDataDiagnosticsResult) => void
    const pending = new Promise<ServerOpsDataDiagnosticsResult>((resolve) => { finish = resolve })
    const calls: ServerOpsDataDiagnoseInput[] = []
    const controller = createServerOpsDiagnosticsController({ api: { diagnoseServerOpsDataSource: (input) => { calls.push(input); return pending } }, publish: () => undefined })
    controller.activate()
    controller.setSource('source', 'config', true)
    controller.setDatabase('app')
    controller.selectPage('parameters')
    await flush()
    controller.setDatabase('archive')
    finish(result('global'))
    await flush()
    expect(calls).toEqual([{ sourceId: 'source', section: 'parameters' }])
    expect(controller.getProjection().pages.parameters?.result?.metrics[0]?.value).toBe('global')
    controller.setDatabase('another')
    await flush()
    expect(calls).toHaveLength(1)
  })

  test('Given 旧库会话未返回 When 连续切库 Then 迟到结果不出现在新库且跳过失效排队', async () => {
    /** 旧库的慢回执用于暴露跨库覆盖。 */
    let finish!: (value: ServerOpsDataDiagnosticsResult) => void
    const pending = new Promise<ServerOpsDataDiagnosticsResult>((resolve) => { finish = resolve })
    const calls: ServerOpsDataDiagnoseInput[] = []
    const controller = createServerOpsDiagnosticsController({ api: { diagnoseServerOpsDataSource: (input) => { calls.push(input); return input.database === 'app' ? pending : Promise.resolve(result(input.database ?? 'instance')) } }, publish: () => undefined })
    controller.activate()
    controller.setSource('source', 'config', true)
    controller.setDatabase('app')
    controller.selectPage('sessions')
    await flush()
    controller.setDatabase('archive')
    controller.setDatabase('latest')
    expect(controller.getProjection().pages.sessions?.result).toBeUndefined()
    finish(result('old-app'))
    await flush()
    expect(calls.map((input) => input.database)).toEqual(['app', 'latest'])
    expect(controller.getProjection().pages.sessions?.result?.metrics[0]?.value).toBe('latest')
  })

  test('Given 数据浏览页 When 绑定连接 Then 不请求诊断；切页只读取对应类别', async () => {
    /** 记录真实类别，发现全量请求回归。 */
    const calls: string[] = []
    /** 测试实际控制器而非渲染 mock 状态。 */
    const controller = createServerOpsDiagnosticsController({ api: { diagnoseServerOpsDataSource: async (input) => { calls.push(input.section ?? 'all'); return result(input.section ?? 'all') } }, publish: () => undefined })
    controller.activate()
    controller.setSource('source', 'config-1', true)
    await flush()
    expect(calls).toEqual([])
    controller.selectPage('sessions')
    await flush()
    expect(calls).toEqual(['sessions'])
    controller.selectPage('logs')
    await flush()
    expect(calls).toEqual(['sessions'])
    controller.selectPage('parameters')
    await flush()
    expect(calls).toEqual(['sessions', 'parameters'])
    controller.selectPage('sessions')
    await flush()
    expect(calls).toEqual(['sessions', 'parameters'])
  })

  test('Given 同 ID 配置更新 When 旧结果晚到 Then 不覆盖当前配置；失败后可刷新', async () => {
    /** 固定旧配置回执。 */
    let finish!: (value: ServerOpsDataDiagnosticsResult) => void
    const old = new Promise<ServerOpsDataDiagnosticsResult>((resolve) => { finish = resolve })
    /** 模拟首次慢请求与后续成功。 */
    let calls = 0
    const controller = createServerOpsDiagnosticsController({ api: { diagnoseServerOpsDataSource: async () => { calls += 1; return calls === 1 ? old : result('new') } }, publish: () => undefined })
    controller.activate()
    controller.setSource('source', 'old-config', true)
    controller.selectPage('overview')
    await flush()
    controller.setSource('source', 'new-config', true)
    /** 配置更新暂停旧页面，由工作台完成范围验证后再显式激活。 */
    expect(controller.getProjection().page).toBeNull()
    controller.selectPage('overview')
    finish(result('old'))
    await flush()
    expect(controller.getProjection().pages.overview?.result?.metrics[0]?.value).toBe('new')
    controller.dispose()
  })

  test('Given StrictMode 重放 When 首读未结束 Then 恢复订阅且不重复诊断', async () => {
    /** 控制首次诊断结算。 */
    let finish!: (value: ServerOpsDataDiagnosticsResult) => void
    const pending = new Promise<ServerOpsDataDiagnosticsResult>((resolve) => { finish = resolve })
    let calls = 0
    const controller = createServerOpsDiagnosticsController({ api: { diagnoseServerOpsDataSource: () => { calls += 1; return pending } }, publish: () => undefined })
    controller.activate()
    controller.setSource('source', 'config', true)
    controller.selectPage('overview')
    await flush()
    controller.dispose()
    controller.activate()
    finish(result('ready'))
    await flush()
    expect(calls).toBe(1)
    expect(controller.getProjection().pages.overview?.status).toBe('ready')
  })

  test('Given 首读 BUSY When 刷新 Then loading 收口且可恢复', async () => {
    /** 第一次请求返回外部单飞冲突。 */
    let fail = true
    const controller = createServerOpsDiagnosticsController({ api: { diagnoseServerOpsDataSource: async () => { if (fail) throw new Error('SERVER_OPS_DATA_SOURCE_BUSY'); return result('ready') } }, publish: () => undefined })
    controller.activate()
    controller.setSource('source', 'config', true)
    controller.selectPage('overview')
    await flush()
    expect(controller.getProjection().pages.overview?.status).toBe('error')
    fail = false
    controller.refresh()
    await flush()
    expect(controller.getProjection().pages.overview?.status).toBe('ready')
  })
})
