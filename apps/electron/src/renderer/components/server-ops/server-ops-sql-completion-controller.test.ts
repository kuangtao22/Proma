import { describe, expect, test } from 'bun:test'
import { createServerOpsSqlCompletionController } from './server-ops-sql-completion-controller'
import type { ServerOpsDataSourceTableResult, ServerOpsDataSourceTablesInput } from '@proma/shared'

/** 同步等待队列中已就绪的异步回执。 */
const settle = async (): Promise<void> => { for (let index = 0; index < 12; index += 1) await Promise.resolve() }
/** 可控响应用于验证切库和卸载后的迟到结果。 */
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done }); return { promise, resolve } }
/** 通用字段 fixture 不含业务行。 */
const structure: ServerOpsDataSourceTableResult = { columns: [{ name: 'id', type: 'int', nullable: false, primaryKey: true }], indexes: [] }

describe('SQL 结构加载控制器', () => {
  test('Given 选库 When 进入编辑器 Then 只加载表目录，字段按需且去重', async () => {
    const calls: string[] = []
    const controller = createServerOpsSqlCompletionController({ publish: () => undefined, api: {
      listServerOpsDataSchemaTables: async (input) => { expect(input.cacheMode).toBe('prefer-cache'); return { database: input.database, databases: ['app'], tables: [{ name: 'users' }] } },
      describeServerOpsDataSchemaTable: async (input) => { calls.push(input.table); expect(input.cacheMode).toBe('prefer-cache'); return structure },
    } })
    controller.activate(); controller.setContext({ sourceId: 's', database: 'app', configurationKey: 'v1', available: true })
    await settle()
    expect(calls).toEqual([])
    await Promise.all([controller.ensureColumns(['users']), controller.ensureColumns(['users'])])
    expect(calls).toEqual(['users'])
    expect(controller.snapshot().columns.users).toEqual(structure.columns)
    await controller.ensureColumns(['unknown', 'users'])
    expect(calls).toEqual(['users'])
  })
  test('Given 切库前在途字段 When 回执到达 Then 不得污染新库', async () => {
    const response = deferred<ServerOpsDataSourceTableResult>()
    const controller = createServerOpsSqlCompletionController({ publish: () => undefined, api: {
      listServerOpsDataSchemaTables: async (input) => ({ database: input.database, databases: ['app', 'other'], tables: [{ name: 'users' }] }),
      describeServerOpsDataSchemaTable: () => response.promise,
    } })
    controller.activate(); controller.setContext({ sourceId: 's', database: 'app', configurationKey: 'v1', available: true }); await settle()
    const pending = controller.ensureColumns(['users']); await settle()
    controller.setContext({ sourceId: 's', database: 'other', configurationKey: 'v1', available: true }); await settle()
    response.resolve(structure); await pending
    expect(controller.snapshot().database).toBe('other')
    expect(controller.snapshot().columns).toEqual({})
    expect(controller.snapshot().pendingTables).toBe(0)
  })
  test('Given 刷新或TTL到期 When 再次补全 Then 重新请求元数据', async () => {
    let now = 0
    let reads = 0
    const modes: ServerOpsDataSourceTablesInput['cacheMode'][] = []
    const controller = createServerOpsSqlCompletionController({ now: () => now, publish: () => undefined, api: {
      listServerOpsDataSchemaTables: async (input) => { modes.push(input.cacheMode); return { database: input.database, databases: ['app'], tables: [{ name: 'users' }] } },
      describeServerOpsDataSchemaTable: async () => { reads += 1; return structure },
    } })
    controller.activate(); controller.setContext({ sourceId: 's', database: 'app', configurationKey: 'v1', available: true }); await settle()
    await controller.ensureColumns(['users']); await controller.refresh(); await controller.ensureColumns(['users'])
    expect(modes).toEqual(['prefer-cache', 'refresh']); expect(reads).toBe(2)
    now = 600_001; await controller.ensureColumns(['users']); expect(reads).toBe(3)
  })
  test('Given 接口读取失败 When 补全 Then 安全降级且显式刷新可重试', async () => {
    let fails = true
    const controller = createServerOpsSqlCompletionController({ publish: () => undefined, api: {
      listServerOpsDataSchemaTables: async (input) => { if (fails) throw new Error('private hostname'); return { database: input.database, databases: ['app'], tables: [{ name: 'users' }] } },
    } })
    controller.activate(); controller.setContext({ sourceId: 's', database: 'app', configurationKey: 'v1', available: true }); await settle()
    expect(controller.snapshot().error).not.toContain('private hostname')
    expect(controller.snapshot().status).toBe('error')
    fails = false; await controller.refresh(); expect(controller.snapshot().status).toBe('ready')
  })
  test('Given 字段过期 When 重新读取失败 Then 不得继续使用过期字段', async () => {
    let now = 0
    const controller = createServerOpsSqlCompletionController({ now: () => now, publish: () => undefined, api: {
      listServerOpsDataSchemaTables: async (input) => ({ database: input.database, databases: ['app'], tables: [{ name: 'users' }] }),
      describeServerOpsDataSchemaTable: async () => { if (now) throw new Error('revoked'); return structure },
    } })
    controller.activate(); controller.setContext({ sourceId: 's', database: 'app', configurationKey: 'v1', available: true }); await settle()
    await controller.ensureColumns(['users']); now = 600_001; await controller.ensureColumns(['users'])
    expect(controller.snapshot().columns.users).toBeUndefined()
  })
  test('Given 连续切换大量 SQL 引用 When 旧读取仍在途 Then 字段排队数始终有界', async () => {
    const response = deferred<ServerOpsDataSourceTableResult>()
    const tables = Array.from({ length: 32 }, (_, index) => ({ name: `table_${index}` }))
    const controller = createServerOpsSqlCompletionController({ publish: () => undefined, api: {
      listServerOpsDataSchemaTables: async (input) => ({ database: input.database, databases: ['app'], tables }),
      describeServerOpsDataSchemaTable: () => response.promise,
    } })
    controller.activate(); controller.setContext({ sourceId: 's', database: 'app', configurationKey: 'v1', available: true }); await settle()
    const first = controller.ensureColumns(tables.slice(0, 16).map((table) => table.name))
    const second = controller.ensureColumns(tables.slice(16).map((table) => table.name)); await settle()
    const count = controller.snapshot().pendingTables
    controller.dispose(); response.resolve(structure); await Promise.all([first, second])
    expect(count).toBeLessThanOrEqual(16)
  })
})
