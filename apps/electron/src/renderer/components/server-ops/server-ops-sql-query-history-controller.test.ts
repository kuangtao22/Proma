import { describe, expect, test } from 'bun:test'
import type {
  ServerOpsDataQueryHistoryRecordInput,
  ServerOpsDataQueryHistoryResult,
} from '@proma/shared'
import {
  createServerOpsSqlQueryHistoryController,
  createServerOpsSqlQueryHistoryIdleProjection,
} from './server-ops-sql-query-history-controller'

/** 手动控制历史读写回执，用于覆盖切库、卸载和乱序返回。 */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail })
  return { promise, resolve, reject }
}

/** 构造指定库的历史结果。 */
function result(sourceId: string, database: string, sql: string, createdAt = 1): ServerOpsDataQueryHistoryResult {
  return { entries: [{ id: `${database}-${createdAt}`, sourceId, database, sql, createdAt }] }
}

const appContext = { sourceId: 'source-1', database: 'app', configurationKey: 'v1' }
const archiveContext = { sourceId: 'source-1', database: 'archive', configurationKey: 'v1' }

describe('SQL 查询历史控制器', () => {
  test('Given 尚未绑定上下文 When 创建控制器 Then 返回无业务数据的空闲投影', () => {
    expect(createServerOpsSqlQueryHistoryIdleProjection()).toEqual({
      context: null,
      entries: [],
      status: 'idle',
      error: null,
      saving: false,
      failedCount: 0,
    })
  })

  test('Given 旧 preload 缺少历史桥接 When 读取或保存 Then 显示明确中文兼容错误', async () => {
    const controller = createServerOpsSqlQueryHistoryController({ api: {}, publish: () => undefined })
    controller.activate()
    controller.setContext(appContext)
    expect(controller.snapshot()).toMatchObject({ status: 'error', error: 'SQL 查询历史接口尚未就绪，请重启应用后重试' })

    await controller.record({ sourceId: 'source-1', database: 'app', sql: 'SELECT 1' })
    expect(controller.snapshot()).toMatchObject({
      status: 'error',
      error: 'SQL 查询历史接口尚未就绪，请重启应用后重试',
      saving: false,
      failedCount: 1,
    })
  })

  test.each([
    "Error invoking remote method 'server-ops:data-query-history-list': Error: No handler registered for 'server-ops:data-query-history-list'",
    'SERVER_OPS_DATA_QUERY_HISTORY_UNAVAILABLE',
  ])('Given 新 preload 对接旧后台 When 历史接口拒绝 %s Then 指出重启且保留待保存语句', async (message) => {
    /** 模拟 Electron 真实 IPC 缺失错误，不访问数据库。 */
    const controller = createServerOpsSqlQueryHistoryController({
      api: { list: async () => { throw new Error(message) }, save: async () => { throw new Error(message) } },
      publish: () => undefined,
    })
    controller.activate()
    controller.setContext(appContext)
    await Promise.resolve()
    expect(controller.snapshot().error).toBe('SQL 查询历史接口尚未就绪，请重启应用后重试')
    await controller.record({ sourceId: 'source-1', database: 'app', sql: 'SELECT 1' })
    expect(controller.snapshot()).toMatchObject({ error: 'SQL 查询历史接口尚未就绪，请重启应用后重试', failedCount: 1, saving: false })
  })

  test('Given 未知历史错误含内部正文 When 读取失败 Then 保持通用提示且不泄漏正文', async () => {
    /** 未知正文不应直接拼接到错误提示。 */
    const controller = createServerOpsSqlQueryHistoryController({
      api: { list: async () => { throw new Error('private SQL and path') } }, publish: () => undefined,
    })
    controller.activate()
    controller.setContext(appContext)
    await Promise.resolve()
    expect(controller.snapshot().error).toBe('读取 SQL 查询历史失败，请稍后重试')
  })

  test('Given 已选择数据库 When 切换上下文 Then 只读取新 scope 并忽略旧读取回执', async () => {
    const appRead = deferred<ServerOpsDataQueryHistoryResult>()
    const calls: Array<{ sourceId: string; database: string }> = []
    const controller = createServerOpsSqlQueryHistoryController({
      api: {
        list: (input) => {
          calls.push(input)
          return input.database === 'app' ? appRead.promise : Promise.resolve(result(input.sourceId, input.database, 'SELECT archive'))
        },
      },
      publish: () => undefined,
    })
    controller.activate()
    controller.setContext(appContext)
    expect(controller.snapshot()).toMatchObject({ status: 'loading', entries: [] })
    controller.setContext(archiveContext)
    await Promise.resolve()
    expect(controller.snapshot()).toMatchObject({ context: archiveContext, status: 'ready', entries: [{ sql: 'SELECT archive' }] })

    appRead.resolve(result('source-1', 'app', 'SELECT app'))
    await Promise.resolve()
    expect(calls).toEqual([
      { sourceId: 'source-1', database: 'app' },
      { sourceId: 'source-1', database: 'archive' },
    ])
    expect(controller.snapshot()).toMatchObject({ context: archiveContext, entries: [{ sql: 'SELECT archive' }] })
  })

  test('Given 查询执行时已捕获原库 When 页面切库或卸载 Then 仍保存原 scope 且不发布迟到结果', async () => {
    const save = deferred<ServerOpsDataQueryHistoryResult>()
    const calls: ServerOpsDataQueryHistoryRecordInput[] = []
    let publishes = 0
    const controller = createServerOpsSqlQueryHistoryController({
      api: {
        list: async (input) => result(input.sourceId, input.database, `SELECT ${input.database}`),
        save: (input) => { calls.push(input); return save.promise },
      },
      publish: () => { publishes += 1 },
    })
    controller.activate()
    controller.setContext(appContext)
    await Promise.resolve()
    const pending = controller.record({ sourceId: 'source-1', database: 'app', sql: 'SELECT original' })
    expect(controller.snapshot().saving).toBe(true)
    controller.setContext(archiveContext)
    expect(controller.snapshot().saving).toBe(false)
    controller.dispose()
    const beforeReply = publishes

    save.resolve(result('source-1', 'app', 'SELECT original'))
    await pending
    expect(calls).toEqual([{ sourceId: 'source-1', database: 'app', sql: 'SELECT original' }])
    expect(publishes).toBe(beforeReply)
    expect(controller.snapshot()).toMatchObject({ context: archiveContext, saving: false })
  })

  test('Given 当前库保存成功 When 回执匹配 scope Then 更新历史且旧库保存不能覆盖当前库', async () => {
    const oldSave = deferred<ServerOpsDataQueryHistoryResult>()
    const currentSave = deferred<ServerOpsDataQueryHistoryResult>()
    const stored = new Map<string, ServerOpsDataQueryHistoryResult>()
    const controller = createServerOpsSqlQueryHistoryController({
      api: {
        list: async (input) => structuredClone(stored.get(input.database) ?? { entries: [] }),
        save: async (input) => {
          const reply = await (input.database === 'app' ? oldSave.promise : currentSave.promise)
          stored.set(input.database, structuredClone(reply))
          return reply
        },
      },
      publish: () => undefined,
    })
    controller.activate()
    controller.setContext(appContext)
    await Promise.resolve()
    const oldPending = controller.record({ sourceId: 'source-1', database: 'app', sql: 'SELECT old' })
    controller.setContext(archiveContext)
    await Promise.resolve()
    const currentPending = controller.record({ sourceId: 'source-1', database: 'archive', sql: 'SELECT current' })
    currentSave.resolve(result('source-1', 'archive', 'SELECT current', 2))
    await currentPending
    expect(controller.snapshot()).toMatchObject({ entries: [{ sql: 'SELECT current' }], saving: false, failedCount: 0 })

    oldSave.resolve(result('source-1', 'app', 'SELECT old', 1))
    await oldPending
    expect(controller.snapshot()).toMatchObject({ context: archiveContext, entries: [{ sql: 'SELECT current' }] })
  })

  test('Given 服务返回其他 scope 的记录 When 读取或保存 Then 拒绝污染并保留保存项供重试', async () => {
    let invalidSave = true
    let stored = result('source-2', 'app', 'SELECT leaked')
    const controller = createServerOpsSqlQueryHistoryController({
      api: {
        list: async () => structuredClone(stored),
        save: async () => {
          if (invalidSave) return result('source-1', 'archive', 'SELECT leaked')
          stored = result('source-1', 'app', 'SELECT safe')
          return structuredClone(stored)
        },
      },
      publish: () => undefined,
    })
    controller.activate()
    controller.setContext(appContext)
    await Promise.resolve()
    expect(controller.snapshot()).toMatchObject({ status: 'error', entries: [], error: 'SQL 查询历史与当前数据库不匹配' })

    await controller.record({ sourceId: 'source-1', database: 'app', sql: 'SELECT safe' })
    expect(controller.snapshot()).toMatchObject({ status: 'error', entries: [], failedCount: 1 })
    invalidSave = false
    await controller.retryFailed()
    expect(controller.snapshot()).toMatchObject({ status: 'ready', entries: [{ sql: 'SELECT safe' }], failedCount: 0 })
  })

  test('Given 多库存在多个保存失败 When 重试当前库 Then 仅重试当前 scope 并保留再次失败项', async () => {
    const calls: string[] = []
    const stored = new Map<string, ServerOpsDataQueryHistoryResult>()
    let mode: 'fail' | 'retry-app' | 'success' = 'fail'
    const controller = createServerOpsSqlQueryHistoryController({
      api: {
        list: async (input) => structuredClone(stored.get(input.database) ?? { entries: [] }),
        save: async (input) => {
          calls.push(`${mode}:${input.database}:${input.sql}`)
          if (mode === 'fail' || (mode === 'retry-app' && input.sql === 'SELECT 2')) throw new Error('SAVE_FAILED')
          const reply = result(input.sourceId, input.database, input.sql)
          stored.set(input.database, structuredClone(reply))
          return reply
        },
      },
      publish: () => undefined,
    })
    controller.activate()
    controller.setContext(appContext)
    await Promise.resolve()
    await controller.record({ sourceId: 'source-1', database: 'app', sql: 'SELECT 1' })
    await controller.record({ sourceId: 'source-1', database: 'app', sql: 'SELECT 2' })
    controller.setContext(archiveContext)
    await Promise.resolve()
    await controller.record({ sourceId: 'source-1', database: 'archive', sql: 'SELECT 3' })
    expect(controller.snapshot().failedCount).toBe(1)

    controller.setContext(appContext)
    await Promise.resolve()
    expect(controller.snapshot().failedCount).toBe(2)
    mode = 'retry-app'
    await controller.retryFailed()
    expect(controller.snapshot()).toMatchObject({ failedCount: 1, saving: false, status: 'ready', entries: [{ sql: 'SELECT 1' }] })
    expect(calls.filter((call) => call.startsWith('retry-app:'))).toEqual([
      'retry-app:app:SELECT 1',
      'retry-app:app:SELECT 2',
    ])

    mode = 'success'
    await controller.retryFailed()
    expect(controller.snapshot()).toMatchObject({ failedCount: 0, saving: false, status: 'ready', entries: [{ sql: 'SELECT 2' }] })
    expect(calls.some((call) => call === 'success:archive:SELECT 3')).toBe(false)
  })

  test('Given 同 scope 的读取与保存并发 When 旧读取最后返回 Then 不回退已保存的新历史', async () => {
    const staleRead = deferred<ServerOpsDataQueryHistoryResult>()
    let reads = 0
    const controller = createServerOpsSqlQueryHistoryController({
      api: {
        list: () => ++reads === 1 ? staleRead.promise : Promise.resolve(result('source-1', 'app', 'SELECT new', 2)),
        save: async (input) => result(input.sourceId, input.database, input.sql, 2),
      },
      publish: () => undefined,
    })
    controller.activate()
    controller.setContext(appContext)
    await controller.record({ sourceId: 'source-1', database: 'app', sql: 'SELECT new' })
    expect(controller.snapshot()).toMatchObject({ status: 'ready', entries: [{ sql: 'SELECT new' }] })
    staleRead.resolve({ entries: [] })
    await Promise.resolve()
    expect(controller.snapshot()).toMatchObject({ status: 'ready', entries: [{ sql: 'SELECT new' }] })
  })

  test('Given 保存在刷新启动后完成 When 旧刷新最后返回 Then 作废旧读取并采用保存后的新快照', async () => {
    const save = deferred<ServerOpsDataQueryHistoryResult>()
    const staleRead = deferred<ServerOpsDataQueryHistoryResult>()
    let reads = 0
    const controller = createServerOpsSqlQueryHistoryController({
      api: {
        list: async () => {
          reads += 1
          if (reads === 1) return result('source-1', 'app', 'SELECT initial', 1)
          if (reads === 2) return staleRead.promise
          return result('source-1', 'app', 'SELECT new', 2)
        },
        save: () => save.promise,
      },
      publish: () => undefined,
    })
    controller.activate()
    controller.setContext(appContext)
    await Promise.resolve()
    const saving = controller.record({ sourceId: 'source-1', database: 'app', sql: 'SELECT new' })
    const refreshing = controller.refresh()
    save.resolve(result('source-1', 'app', 'SELECT new', 2))
    await saving
    await Promise.resolve()
    expect(reads).toBe(3)
    expect(controller.snapshot()).toMatchObject({ status: 'ready', entries: [{ sql: 'SELECT new' }] })

    staleRead.resolve(result('source-1', 'app', 'SELECT stale', 1))
    await refreshing
    expect(controller.snapshot()).toMatchObject({ status: 'ready', entries: [{ sql: 'SELECT new' }] })
  })

  test('Given 同 scope 同时请求两次保存 When 首条失败 Then 第二条按序提交且最终列表不漏成功记录', async () => {
    const first = deferred<ServerOpsDataQueryHistoryResult>()
    const second = deferred<ServerOpsDataQueryHistoryResult>()
    let stored = { entries: [] } as ServerOpsDataQueryHistoryResult
    const saveCalls: string[] = []
    const controller = createServerOpsSqlQueryHistoryController({
      api: {
        list: async () => structuredClone(stored),
        save: async (input) => {
          saveCalls.push(input.sql)
          const reply = await (input.sql === 'SELECT first' ? first.promise : second.promise)
          stored = structuredClone(reply)
          return reply
        },
      },
      publish: () => undefined,
    })
    controller.activate()
    controller.setContext(appContext)
    await Promise.resolve()
    const firstSaving = controller.record({ sourceId: 'source-1', database: 'app', sql: 'SELECT first' })
    const secondSaving = controller.record({ sourceId: 'source-1', database: 'app', sql: 'SELECT second' })
    await Promise.resolve()
    expect(saveCalls).toEqual(['SELECT first'])
    first.reject(new Error('SAVE_FAILED'))
    await firstSaving
    expect(saveCalls).toEqual(['SELECT first', 'SELECT second'])
    second.resolve(result('source-1', 'app', 'SELECT second', 2))
    await secondSaving
    expect(controller.snapshot()).toMatchObject({ entries: [{ sql: 'SELECT second' }], failedCount: 1 })
  })

  test('Given 同 scope 首条保存成功而队尾失败 When 队列清空 Then fresh list 仍显示已成功记录', async () => {
    let stored = { entries: [] } as ServerOpsDataQueryHistoryResult
    const controller = createServerOpsSqlQueryHistoryController({
      api: {
        list: async () => structuredClone(stored),
        save: async (input) => {
          if (input.sql === 'SELECT second') throw new Error('SAVE_FAILED')
          stored = result(input.sourceId, input.database, input.sql, 2)
          return structuredClone(stored)
        },
      },
      publish: () => undefined,
    })
    controller.activate()
    controller.setContext(appContext)
    await Promise.resolve()
    const firstSaving = controller.record({ sourceId: 'source-1', database: 'app', sql: 'SELECT first' })
    const secondSaving = controller.record({ sourceId: 'source-1', database: 'app', sql: 'SELECT second' })
    await Promise.all([firstSaving, secondSaving])
    expect(controller.snapshot()).toMatchObject({ status: 'ready', entries: [{ sql: 'SELECT first' }], failedCount: 1 })
  })

  test('Given 同 SQL 并发保存 When 首条失败而后条成功 Then 成功提交清除等价失败项', async () => {
    const first = deferred<ServerOpsDataQueryHistoryResult>()
    const second = deferred<ServerOpsDataQueryHistoryResult>()
    let stored = { entries: [] } as ServerOpsDataQueryHistoryResult
    let calls = 0
    const controller = createServerOpsSqlQueryHistoryController({
      api: {
        list: async () => structuredClone(stored),
        save: async () => {
          calls += 1
          const reply = await (calls === 1 ? first.promise : second.promise)
          stored = structuredClone(reply)
          return reply
        },
      },
      publish: () => undefined,
    })
    controller.activate()
    controller.setContext(appContext)
    await Promise.resolve()
    const firstSaving = controller.record({ sourceId: 'source-1', database: 'app', sql: ' SELECT 1 ' })
    const secondSaving = controller.record({ sourceId: 'source-1', database: 'app', sql: 'SELECT 1' })
    first.reject(new Error('SAVE_FAILED'))
    await firstSaving
    second.resolve(result('source-1', 'app', 'SELECT 1', 2))
    await secondSaving
    expect(controller.snapshot()).toMatchObject({ status: 'ready', entries: [{ sql: 'SELECT 1' }], failedCount: 0 })
  })

  test('Given 已有历史 When 刷新在途或失败 Then 保留原记录供用户查看', async () => {
    const nextRead = deferred<ServerOpsDataQueryHistoryResult>()
    let reads = 0
    const controller = createServerOpsSqlQueryHistoryController({
      api: { list: async () => ++reads === 1 ? result('source-1', 'app', 'SELECT existing') : nextRead.promise },
      publish: () => undefined,
    })
    controller.activate()
    controller.setContext(appContext)
    await Promise.resolve()
    const refreshing = controller.refresh()
    expect(controller.snapshot()).toMatchObject({ status: 'loading', entries: [{ sql: 'SELECT existing' }] })
    nextRead.reject(new Error('READ_FAILED'))
    await refreshing
    expect(controller.snapshot()).toMatchObject({ status: 'error', entries: [{ sql: 'SELECT existing' }] })
  })

  test('Given 旧库保存期间切到新库读取 When 旧库保存完成 Then 不作废新库读取', async () => {
    const appSave = deferred<ServerOpsDataQueryHistoryResult>()
    const archiveRead = deferred<ServerOpsDataQueryHistoryResult>()
    const controller = createServerOpsSqlQueryHistoryController({
      api: {
        list: (input) => input.database === 'archive' ? archiveRead.promise : Promise.resolve({ entries: [] }),
        save: () => appSave.promise,
      },
      publish: () => undefined,
    })
    controller.activate()
    controller.setContext(appContext)
    await Promise.resolve()
    const saving = controller.record({ sourceId: 'source-1', database: 'app', sql: 'SELECT app' })
    controller.setContext(archiveContext)
    appSave.resolve(result('source-1', 'app', 'SELECT app', 2))
    await saving
    archiveRead.resolve(result('source-1', 'archive', 'SELECT archive', 3))
    await Promise.resolve()
    expect(controller.snapshot()).toMatchObject({ context: archiveContext, status: 'ready', entries: [{ sql: 'SELECT archive' }] })
  })

  test('Given 同 scope 的等价 SQL 多次保存失败 When 后续一次保存成功 Then 失败项去重并全部清除', async () => {
    let failing = true
    let stored = { entries: [] } as ServerOpsDataQueryHistoryResult
    const controller = createServerOpsSqlQueryHistoryController({
      api: {
        list: async () => structuredClone(stored),
        save: async (input) => {
          if (failing) throw new Error('SAVE_FAILED')
          stored = result(input.sourceId, input.database, input.sql, 2)
          return structuredClone(stored)
        },
      },
      publish: () => undefined,
    })
    controller.activate()
    controller.setContext(appContext)
    await Promise.resolve()
    await controller.record({ sourceId: 'source-1', database: 'app', sql: ' SELECT 1 ' })
    await controller.record({ sourceId: 'source-1', database: 'app', sql: 'SELECT 1' })
    expect(controller.snapshot().failedCount).toBe(1)

    failing = false
    await controller.record({ sourceId: 'source-1', database: 'app', sql: 'SELECT 1' })
    await Promise.resolve()
    expect(controller.snapshot()).toMatchObject({ failedCount: 0, entries: [{ sql: 'SELECT 1' }] })
  })

  test('Given 保存已更新当前历史 When 更早的读取随后失败 Then 不用旧错误覆盖新结果', async () => {
    const staleRead = deferred<ServerOpsDataQueryHistoryResult>()
    let reads = 0
    const controller = createServerOpsSqlQueryHistoryController({
      api: {
        list: () => ++reads === 1 ? staleRead.promise : Promise.resolve(result('source-1', 'app', 'SELECT new', 2)),
        save: async (input) => result(input.sourceId, input.database, input.sql, 2),
      },
      publish: () => undefined,
    })
    controller.activate()
    controller.setContext(appContext)
    await controller.record({ sourceId: 'source-1', database: 'app', sql: 'SELECT new' })
    staleRead.reject(new Error('READ_FAILED'))
    await Promise.resolve()
    expect(controller.snapshot()).toMatchObject({ status: 'ready', error: null, entries: [{ sql: 'SELECT new' }] })
  })

  test('Given StrictMode 清理后重新激活 When 旧 owner 回执迟到 Then 新 owner 刷新结果保持有效', async () => {
    const oldRead = deferred<ServerOpsDataQueryHistoryResult>()
    let reads = 0
    const controller = createServerOpsSqlQueryHistoryController({
      api: {
        list: async () => {
          reads += 1
          return reads === 1 ? oldRead.promise : result('source-1', 'app', 'SELECT fresh', 2)
        },
      },
      publish: () => undefined,
    })
    controller.activate()
    controller.setContext(appContext)
    controller.dispose()
    controller.activate()
    await Promise.resolve()
    expect(controller.snapshot()).toMatchObject({ status: 'ready', entries: [{ sql: 'SELECT fresh' }] })

    oldRead.resolve(result('source-1', 'app', 'SELECT stale', 1))
    await Promise.resolve()
    expect(controller.snapshot()).toMatchObject({ status: 'ready', entries: [{ sql: 'SELECT fresh' }] })
    expect(reads).toBe(2)
  })

  test('Given 旧 owner 保存尚未完成 When StrictMode 重新激活 Then 保存完成后新 owner 会取得最终快照', async () => {
    const save = deferred<ServerOpsDataQueryHistoryResult>()
    const remountRead = deferred<ServerOpsDataQueryHistoryResult>()
    let reads = 0
    const controller = createServerOpsSqlQueryHistoryController({
      api: {
        list: async () => {
          reads += 1
          if (reads === 1) return { entries: [] }
          if (reads === 2) return remountRead.promise
          return result('source-1', 'app', 'SELECT saved', 2)
        },
        save: () => save.promise,
      },
      publish: () => undefined,
    })
    controller.activate()
    controller.setContext(appContext)
    await Promise.resolve()
    const saving = controller.record({ sourceId: 'source-1', database: 'app', sql: 'SELECT saved' })
    controller.dispose()
    controller.activate()
    save.resolve(result('source-1', 'app', 'SELECT saved', 2))
    await saving
    remountRead.resolve({ entries: [] })
    await Promise.resolve()
    expect(reads).toBe(3)
    expect(controller.snapshot()).toMatchObject({ status: 'ready', entries: [{ sql: 'SELECT saved' }] })
  })
})
