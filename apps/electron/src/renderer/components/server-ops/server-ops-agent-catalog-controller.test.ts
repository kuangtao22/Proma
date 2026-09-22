import { describe, expect, test } from 'bun:test'
import type { ServerOpsDataSourceTablesResult } from '@proma/shared'
import { createServerOpsAgentCatalogController } from './server-ops-agent-catalog-controller'

/** 控制异步回执，用于验证目标切换与卸载后的发布边界。 */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

/** 生成不含真实连接信息的表目录回执。 */
function catalog(database = 'app', tables = ['users']): ServerOpsDataSourceTablesResult {
  return { databases: ['app', 'audit'], database, tables: tables.map((name) => ({ name })) }
}

describe('Agent 授权表目录按需读取', () => {
  test('首页没有目标库时展开只列可见库，选库后才读取目标表且旧目录不得覆盖', async () => {
    /** 无目标目录回执只供弹窗选库，具体表仍按选择的库读取。 */
    const inputs: Array<{ sourceId: string; database?: string; cacheMode?: string }> = []
    const api = { listServerOpsDataSchemaTables: async (input: typeof inputs[number]) => {
      inputs.push(input)
      return input.database ? catalog(input.database, ['users']) : { databases: ['app', 'audit'], tables: [] }
    } }
    const controller = createServerOpsAgentCatalogController({ api, publish: () => undefined })
    controller.activate(); controller.select('source-1', 'v1')
    expect(inputs).toEqual([])
    await controller.load()
    expect(inputs[0]).toEqual({ sourceId: 'source-1', cacheMode: 'prefer-cache' })
    expect(controller.snapshot().result?.databases).toEqual(['app', 'audit'])
    controller.select('source-1', 'v1', 'audit')
    expect(controller.snapshot().result).toBeNull()
    await controller.load()
    expect(inputs[1]?.database).toBe('audit')
    expect(controller.snapshot().result?.tables[0]?.name).toBe('users')
  })
  test('截断表目录按需搜索后可选择第501张表，清空搜索恢复初始目录', async () => {
    const inputs: Array<{ tableSearch?: string; database?: string; cacheMode?: string }> = []
    const api = { listServerOpsDataSchemaTables: async (input: typeof inputs[number]) => {
      inputs.push(input)
      return input.tableSearch ? catalog('app', ['table_501']) : { ...catalog('app', ['table_1']), tablesTruncated: true }
    } }
    const controller = createServerOpsAgentCatalogController({ api, publish: () => undefined })
    controller.activate(); controller.select('source-1', 'v1', 'app')
    await controller.load()
    expect(controller.snapshot().result?.tables[0]?.name).toBe('table_1')
    await controller.load(false, 'table_501')
    expect(inputs[1]).toMatchObject({ database: 'app', tableSearch: 'table_501' })
    expect(controller.snapshot().result?.tables[0]?.name).toBe('table_501')
    await controller.load()
    expect(controller.snapshot().result?.tables[0]?.name).toBe('table_1')
  })
  test('选择目标不读取，显式加载使用缓存策略并保留截断标志', async () => {
    const inputs: Array<{ sourceId: string; database?: string; cacheMode?: string }> = []
    const api = { listServerOpsDataSchemaTables: async (input: typeof inputs[number]) => {
      inputs.push(input)
      return { ...catalog('app'), tablesTruncated: true, databasesTruncated: true }
    } }
    const published: string[] = []
    const controller = createServerOpsAgentCatalogController({ api, publish: (state) => published.push(state.status) })
    controller.activate()
    controller.select('source-1', 'config-v1', 'app')
    expect(inputs).toEqual([])
    expect(controller.snapshot()).toEqual({ status: 'idle', result: null, error: null })
    await controller.load()
    expect(inputs).toEqual([{ sourceId: 'source-1', database: 'app', cacheMode: 'prefer-cache' }])
    expect(controller.snapshot().result?.tablesTruncated).toBe(true)
    expect(controller.snapshot().result?.databasesTruncated).toBe(true)
    await controller.load()
    expect(inputs).toHaveLength(1)
    await controller.load(true)
    expect(inputs[1]?.cacheMode).toBe('refresh')
    expect(published).toContain('ready')
  })

  test('同目标并发与两个控制器的读取合并，重放生命周期不重复 IPC', async () => {
    const pending = deferred<ServerOpsDataSourceTablesResult>()
    let calls = 0
    const api = { listServerOpsDataSchemaTables: () => { calls += 1; return pending.promise } }
    const first = createServerOpsAgentCatalogController({ api, publish: () => undefined })
    const second = createServerOpsAgentCatalogController({ api, publish: () => undefined })
    first.activate(); first.select('source-1', 'v1', 'app')
    second.activate(); second.select('source-1', 'v1', 'app')
    const one = first.load()
    const duplicate = first.load()
    const shared = second.load()
    first.dispose()
    first.activate()
    await Promise.resolve()
    expect(calls).toBe(1)
    pending.resolve(catalog())
    await Promise.all([one, duplicate, shared])
    await Promise.resolve()
    expect(first.snapshot().status).toBe('ready')
    expect(second.snapshot().status).toBe('ready')
  })

  test('切库、切连接、配置身份变化均清空旧结果，迟到回执不覆盖', async () => {
    const requests: Array<ReturnType<typeof deferred<ServerOpsDataSourceTablesResult>>> = []
    const api = { listServerOpsDataSchemaTables: () => {
      const pending = deferred<ServerOpsDataSourceTablesResult>()
      requests.push(pending)
      return pending.promise
    } }
    const controller = createServerOpsAgentCatalogController({ api, publish: () => undefined })
    controller.activate(); controller.select('source-1', 'v1', 'app')
    const first = controller.load()
    await Promise.resolve()
    controller.select('source-1', 'v1', 'audit')
    expect(controller.snapshot().result).toBeNull()
    const second = controller.load()
    requests[0]?.resolve(catalog('app'))
    await first
    await Promise.resolve()
    expect(controller.snapshot().status).toBe('loading')
    requests[1]?.resolve(catalog('audit', ['events']))
    await second
    expect(controller.snapshot().result?.tables[0]?.name).toBe('events')
    controller.select('source-2', 'v1', 'audit')
    expect(controller.snapshot().result).toBeNull()
    controller.select('source-2', 'v2', 'audit')
    expect(controller.snapshot().status).toBe('idle')
  })

  test('读取失败展示安全错误且允许重试；卸载后旧回执不发布', async () => {
    const pending = deferred<ServerOpsDataSourceTablesResult>()
    let calls = 0
    const api = { listServerOpsDataSchemaTables: () => {
      calls += 1
      return calls === 1 ? Promise.reject(new Error('internal secret')) : pending.promise
    } }
    const states: string[] = []
    const controller = createServerOpsAgentCatalogController({ api, publish: (state) => states.push(state.status) })
    controller.activate(); controller.select('source-1', 'v1')
    await controller.load()
    expect(controller.snapshot()).toEqual({ status: 'error', result: null, error: '操作失败，请稍后重试' })
    const retry = controller.load()
    await Promise.resolve()
    controller.dispose()
    pending.resolve(catalog())
    await retry
    expect(states.at(-1)).toBe('loading')
    controller.activate()
    expect(controller.snapshot().status).toBe('loading')
    await controller.load()
    expect(controller.snapshot().status).toBe('ready')
  })

  test('显式选库收到其他库或无库回执时拒绝发布目录', async () => {
    for (const database of ['audit', undefined]) {
      const api = { listServerOpsDataSchemaTables: async () => ({ ...catalog('app'), database }) }
      const controller = createServerOpsAgentCatalogController({ api, publish: () => undefined })
      controller.activate(); controller.select('source-1', 'v1', 'app')
      await controller.load()
      expect(controller.snapshot().status).toBe('error')
      expect(controller.snapshot().result).toBeNull()
      expect(controller.snapshot().error).toBeTruthy()
    }
  })
})
