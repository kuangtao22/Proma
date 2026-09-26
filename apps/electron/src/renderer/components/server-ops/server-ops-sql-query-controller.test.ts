import { describe, expect, test } from 'bun:test'
import type { ServerOpsDataQueryInput, ServerOpsDataQueryResult } from '@proma/shared'
import { createServerOpsSqlQueryController, getServerOpsSqlQueryErrorMessage, getServerOpsSqlQueryWarningMessage } from './server-ops-sql-query-controller'

/** 手动控制查询与取消回执，验证切库和用户取消竞态。 */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail })
  return { promise, resolve, reject }
}

/** 构造带真实列头的查询结果；空行也不能丢失字段。 */
function result(queryId: string, database = 'app'): ServerOpsDataQueryResult {
  return { queryId, database, columns: ['id'], rows: [], rowCount: 0, durationMs: 12, truncated: false, warnings: [] }
}

describe('SQL 查询控制器', () => {
  test('Given PostgreSQL 双引号 SQL When 执行 Then 使用当前方言调用 API且拒绝旧方言上下文', async () => {
    /** 捕获真正到达后端的请求，避免仅验证编辑器高亮。 */
    const calls: ServerOpsDataQueryInput[] = []
    /** 方言是查询上下文的一部分，切换后旧事件不能执行。 */
    const postgresContext = { sourceId: 'pg', database: 'app', configurationKey: 'v1', available: true, dialect: 'postgresql' as const }
    const controller = createServerOpsSqlQueryController({
      api: { query: async (input) => { calls.push(input); return result(input.queryId, input.database) }, cancel: async () => undefined },
      publish: () => undefined,
    })
    controller.activate(); controller.setContext(postgresContext); controller.setDraft('SELECT "UserName" FROM "Users"')
    await controller.execute(postgresContext)
    expect(calls).toHaveLength(1)
    expect(controller.snapshot().status).toBe('success')
    controller.setContext({ ...postgresContext, dialect: 'mysql' })
    expect(controller.snapshot().execution).toBeNull()
    await controller.execute(postgresContext)
    expect(calls).toHaveLength(1)
    controller.dispose()
  })
  test('Given 选库器已切换但控制器 effect 尚未同步 When 按新上下文执行 Then 不会查询旧库', async () => {
    /** 模拟 React 新 props 已渲染、passive effect 尚未调用 setContext 的窗口。 */
    const current = { sourceId: 'source-1', database: 'app', configurationKey: 'v1', available: true }
    const calls: ServerOpsDataQueryInput[] = []
    const controller = createServerOpsSqlQueryController({
      api: { query: async (input) => { calls.push(input); return result(input.queryId, input.database) }, cancel: async () => undefined }, publish: () => undefined,
    })
    controller.activate(); controller.setContext(current); controller.setDraft('SELECT id FROM users')
    for (const expected of [{ ...current, database: 'archive' }, { ...current, sourceId: 'source-2' }, { ...current, configurationKey: 'v2' }, { ...current, available: false }]) {
      await controller.execute(expected)
    }
    expect(calls).toEqual([])
    controller.setContext({ ...current, database: 'archive' })
    await controller.execute({ ...current, database: 'archive' })
    expect(calls.map((call) => call.database)).toEqual(['archive'])
  })
  test('Given 防抖尚未校验的最新错误草稿 When 立即执行 Then 本地拒绝且不调用查询和历史', async () => {
    /** 两项计数验证本地拒绝不产生外部行为。 */
    let queries = 0
    let histories = 0
    const controller = createServerOpsSqlQueryController({
      api: { query: async (input) => { queries += 1; return result(input.queryId) }, cancel: async () => undefined },
      publish: () => undefined, onExecuted: () => { histories += 1 },
    })
    controller.activate()
    controller.setContext({ sourceId: 'source-1', database: 'app', configurationKey: 'v1', available: true })
    controller.setDraft('SELECT id FROM users')
    controller.setDraft('SELECT * WHERE users')
    await controller.execute()
    expect(queries).toBe(0)
    expect(histories).toBe(0)
    expect(controller.snapshot().error).toContain('FROM')
    expect(controller.snapshot().activeQueryId).toBeNull()
  })
  test('Given 查询在途仍继续编辑并切库 When 原查询结束 Then 历史通知保留原执行快照且只发一次', async () => {
    /** 受控回执用于在查询完成前改变编辑器与当前数据库。 */
    const query = deferred<ServerOpsDataQueryResult>()
    /** 历史只接收真正发起过的执行参数，不读取可变草稿。 */
    const completed: ServerOpsDataQueryInput[] = []
    const controller = createServerOpsSqlQueryController({
      api: { query: () => query.promise, cancel: async () => undefined },
      publish: () => undefined,
      createQueryId: () => 'query-history',
      onExecuted: (input) => { completed.push(input) },
    })
    controller.activate()
    controller.setContext({ sourceId: 'source-1', database: 'app', configurationKey: 'v1', available: true })
    controller.setDraft('  SELECT id FROM users  ')
    const pending = controller.execute()
    expect(completed).toEqual([])
    controller.setDraft('SELECT name FROM orders')
    controller.setMaxRows(100)
    controller.setContext({ sourceId: 'source-1', database: 'archive', configurationKey: 'v1', available: true })
    controller.dispose()
    query.resolve(result('query-history'))
    await pending
    expect(completed).toEqual([{ sourceId: 'source-1', database: 'app', queryId: 'query-history', sql: 'SELECT id FROM users', maxRows: 50 }])
  })

  test('Given 查询失败 When 结束 Then 仍保存执行语句且历史通知失败不改变查询终态', async () => {
    /** 计数只验证一次真正执行对应一次历史通知。 */
    let completed = 0
    const controller = createServerOpsSqlQueryController({
      api: { query: async () => { throw new Error('QUERY_FAILED') }, cancel: async () => undefined },
      publish: () => undefined,
      onExecuted: () => { completed += 1; throw new Error('HISTORY_FAILED') },
    })
    controller.activate()
    controller.setDraft('SELECT id FROM users')
    await controller.execute()
    expect(completed).toBe(0)
    controller.setContext({ sourceId: 'source-1', database: 'app', configurationKey: 'v1', available: true })
    await controller.execute()
    expect(completed).toBe(1)
    expect(controller.snapshot()).toMatchObject({ status: 'error', error: 'SQL 查询失败，请稍后重试' })
  })

  test('Given 查询前审计失败 When IPC 包裹错误 Then 明确尚未执行和对应处理方式', () => {
    /** Electron 会为稳定错误码添加通道上下文，提示仍须准确分类。 */
    const cases = [
      ['SERVER_OPS_OTHER_INSTANCE_ACTIVE', '审计记录需要初始化或升级，请先退出其他 DutyDeck 实例后重试；SQL 尚未执行'],
      ['SERVER_OPS_TRUST_BUSY', '运维配置正在准备，请稍后重试；SQL 尚未执行'],
      ['SERVER_OPS_CONFIG_BUSY', '运维配置正在写入，请稍后重试；SQL 尚未执行'],
      ['SERVER_OPS_CONFIG_LOCK_UNAVAILABLE', '运维配置写锁不可用，请重启或更新 DutyDeck 后重试；SQL 尚未执行'],
      ['SERVER_OPS_CONFIG_OUTCOME_UNKNOWN', '审计写入状态无法确认，请稍后重试，若持续失败再重启 DutyDeck；SQL 尚未执行'],
      ['SERVER_OPS_AUDIT_READ_FAILED', '本地审计记录无法读取，需要检查审计文件；SQL 尚未执行'],
      ['SERVER_OPS_AUDIT_SCHEMA_NOT_PREPARED', '本地审计记录尚未准备完成，请重启 DutyDeck 后重试；SQL 尚未执行'],
      ['SERVER_OPS_AUDIT_WRITE_FAILED', '本地审计记录写入失败，请检查磁盘空间和配置目录权限后重启 DutyDeck；SQL 尚未执行'],
      ['SERVER_OPS_AUDIT_START_WRITE_FAILED', '无法记录查询审计，请检查本地运维配置后重试；SQL 尚未执行'],
    ] as const
    for (const [code, message] of cases) {
      expect(getServerOpsSqlQueryErrorMessage(new Error(`Error invoking remote method: Error: ${code}`))).toBe(message)
    }
  })
  test('Given 稳定错误码或驱动正文 When 映射 Then 只显示可操作中文且未知信息不透传', () => {
    expect(getServerOpsSqlQueryErrorMessage(new Error('SERVER_OPS_DATA_QUERY_SQL_INVALID'))).toBe('数据库未通过 SQL 语法检查，请检查语句和数据库版本')
    expect(getServerOpsSqlQueryErrorMessage(new Error('SERVER_OPS_DATA_QUERY_PERMISSION_DENIED'))).toBe('数据库认证失败或账号权限不足')
    expect(getServerOpsSqlQueryErrorMessage(new Error('SERVER_OPS_DATA_QUERY_TIMEOUT'))).toBe('查询达到执行或锁等待上限，已结束本次请求；请缩小范围或优化条件后重试')
    expect(getServerOpsSqlQueryErrorMessage(new Error('SERVER_OPS_DATA_QUERY_SENSITIVE_COLUMN'))).toBe('查询包含敏感字段，无法执行')
    expect(getServerOpsSqlQueryErrorMessage(new Error('SERVER_OPS_SQL_SENSITIVE_COLUMN'))).toBe('查询包含敏感字段，无法执行')
    expect(getServerOpsSqlQueryErrorMessage(new Error('SERVER_OPS_DATA_QUERY_TABLE_UNAVAILABLE'))).toBe('查询中的表不存在、不可见或不是基础表')
    expect(getServerOpsSqlQueryErrorMessage(new Error('SERVER_OPS_DATA_QUERY_COLUMN_TOO_LARGE'))).toBe('字段内容过大，请明确选择字段，或使用 SUBSTRING(字段, 1, 256) 缩小文本后查询')
    expect(getServerOpsSqlQueryErrorMessage(new Error('SERVER_OPS_DATA_TIMEOUT'))).toBe('查询超时，请缩小扫描范围后重试')
    expect(getServerOpsSqlQueryErrorMessage(new Error('ER_ACCESS_DENIED_ERROR password=secret'))).toBe('数据库认证失败或账号权限不足')
    expect(getServerOpsSqlQueryErrorMessage(new Error('SERVER_OPS_SQL_CROSS_DATABASE'))).toBe('只允许查询当前已授权数据库中的基础表')
    expect(getServerOpsSqlQueryErrorMessage(new Error('SERVER_OPS_SQL_BUSY'))).toBe('该数据源已有 SQL 查询正在进行，请等待完成或取消后重试')
    expect(getServerOpsSqlQueryErrorMessage(new Error('SERVER_OPS_AUDIT_RESULT_WRITE_FAILED'))).toBe('查询已完成，但审计结果写入失败')
    expect(getServerOpsSqlQueryErrorMessage(new Error('driver leaked secret'))).toBe('SQL 查询失败，请稍后重试')
    expect(getServerOpsSqlQueryWarningMessage('SERVER_OPS_AUDIT_RESULT_WRITE_FAILED')).toBe('查询已完成，但审计结果写入失败')
    expect(getServerOpsSqlQueryWarningMessage('driver leaked secret')).toBe('查询已完成，但服务返回了附加警告')
  })
  test('Given 可用当前库 When 执行后继续编辑 Then 结果仍标明执行时 SQL 与数据库', async () => {
    const calls: Array<{ sourceId: string; database: string; queryId: string; sql: string; maxRows: number }> = []
    const controller = createServerOpsSqlQueryController({
      api: { query: async (input) => { calls.push(input); return result(input.queryId, input.database) }, cancel: async () => undefined },
      publish: () => undefined,
      createQueryId: () => 'query-1',
    })
    controller.activate()
    controller.setContext({ sourceId: 'source-1', database: 'app', configurationKey: 'v1', available: true })
    controller.setDraft('SELECT id FROM users')
    await controller.execute()
    controller.setDraft('SELECT id FROM orders')

    expect(calls).toEqual([{ sourceId: 'source-1', database: 'app', queryId: 'query-1', sql: 'SELECT id FROM users', maxRows: 50 }])
    expect(controller.snapshot()).toMatchObject({
      status: 'success',
      draft: 'SELECT id FROM orders',
      execution: { sql: 'SELECT id FROM users', database: 'app', result: { columns: ['id'], rows: [] } },
    })
  })

  test('Given 查询在途 When 切库 Then 请求真实取消且迟到结果不能进入新库', async () => {
    const query = deferred<ServerOpsDataQueryResult>()
    const cancels: Array<{ sourceId: string; queryId: string }> = []
    const controller = createServerOpsSqlQueryController({
      api: { query: () => query.promise, cancel: async (input) => { cancels.push(input) } },
      publish: () => undefined,
      createQueryId: () => 'query-1',
    })
    controller.activate()
    controller.setContext({ sourceId: 'source-1', database: 'app', configurationKey: 'v1', available: true })
    controller.setDraft('SELECT id FROM users')
    const pending = controller.execute()
    controller.setContext({ sourceId: 'source-1', database: 'archive', configurationKey: 'v1', available: true })
    query.resolve(result('query-1'))
    await pending

    expect(cancels).toEqual([{ sourceId: 'source-1', queryId: 'query-1' }])
    expect(controller.snapshot()).toMatchObject({ status: 'idle', context: { database: 'archive' }, execution: null })
  })

  test('Given 用户取消 When 服务尚未确认 Then 保持取消中且确认后允许重试', async () => {
    const first = deferred<ServerOpsDataQueryResult>()
    const cancellation = deferred<void>()
    let queryCount = 0
    const controller = createServerOpsSqlQueryController({
      api: {
        query: async (input) => { queryCount += 1; return queryCount === 1 ? first.promise : result(input.queryId, input.database) },
        cancel: () => cancellation.promise,
      },
      publish: () => undefined,
      createQueryId: () => `query-${queryCount + 1}`,
    })
    controller.activate()
    controller.setContext({ sourceId: 'source-1', database: 'app', configurationKey: 'v1', available: true })
    controller.setDraft('SELECT id FROM users')
    void controller.execute()
    const cancelling = controller.cancel()
    expect(controller.snapshot().status).toBe('cancelling')
    cancellation.resolve()
    await cancelling
    expect(controller.snapshot().status).toBe('idle')
    await controller.execute()
    expect(controller.snapshot().status).toBe('success')
  })

  test('Given 取消失败 When 原查询仍在运行 Then 保留查询身份并允许再次取消', async () => {
    const query = deferred<ServerOpsDataQueryResult>()
    let cancelAttempts = 0
    const controller = createServerOpsSqlQueryController({
      api: { query: () => query.promise, cancel: async () => { cancelAttempts += 1; if (cancelAttempts === 1) throw new Error('CANCEL_FAILED') } },
      publish: () => undefined,
      createQueryId: () => 'query-1',
    })
    controller.activate(); controller.setContext({ sourceId: 'source-1', database: 'app', configurationKey: 'v1', available: true }); controller.setDraft('SELECT id FROM users')
    void controller.execute(); await controller.cancel()
    expect(controller.snapshot()).toMatchObject({ status: 'running', activeQueryId: 'query-1', error: '取消查询失败，请稍后重试', canExecute: false })
    await controller.cancel()
    expect(controller.snapshot()).toMatchObject({ status: 'idle', activeQueryId: null, error: null })
    query.resolve(result('query-1'))
  })

  test('Given 取消等待中 When 查询先完成 Then 查询终态解锁且迟到取消ACK不覆盖结果', async () => {
    const query = deferred<ServerOpsDataQueryResult>()
    const cancellation = deferred<void>()
    const controller = createServerOpsSqlQueryController({ api: { query: () => query.promise, cancel: () => cancellation.promise }, publish: () => undefined, createQueryId: () => 'query-1' })
    controller.activate(); controller.setContext({ sourceId: 'source-1', database: 'app', configurationKey: 'v1', available: true }); controller.setDraft('SELECT id FROM users')
    const querying = controller.execute(); const cancelling = controller.cancel()
    query.resolve(result('query-1')); await querying
    expect(controller.snapshot()).toMatchObject({ status: 'success', activeQueryId: null, execution: { sql: 'SELECT id FROM users' } })
    cancellation.resolve(); await cancelling
    expect(controller.snapshot()).toMatchObject({ status: 'success', execution: { result: { queryId: 'query-1' } } })
  })

  test('Given 用户取消 When 查询先返回取消码且ACK后到 Then 正常回到空闲且不显示错误', async () => {
    for (const cancellationCode of ['SERVER_OPS_SQL_CANCELLED', 'SERVER_OPS_DATA_CANCELLED']) {
      const query = deferred<ServerOpsDataQueryResult>()
      const cancellation = deferred<void>()
      const controller = createServerOpsSqlQueryController({ api: { query: () => query.promise, cancel: () => cancellation.promise }, publish: () => undefined, createQueryId: () => 'query-1' })
      controller.activate(); controller.setContext({ sourceId: 'source-1', database: 'app', configurationKey: 'v1', available: true }); controller.setDraft('SELECT id FROM users')
      const querying = controller.execute(); const cancelling = controller.cancel()
      query.reject(new Error(cancellationCode)); await querying
      expect(controller.snapshot()).toMatchObject({ status: 'idle', activeQueryId: null, error: null, canExecute: true })
      cancellation.resolve(); await cancelling
      expect(controller.snapshot()).toMatchObject({ status: 'idle', activeQueryId: null, error: null, canExecute: true })
    }
  })

  test('Given 用户取消 When 查询先返回普通失败 Then 保留错误而不误判为取消成功', async () => {
    const query = deferred<ServerOpsDataQueryResult>()
    const cancellation = deferred<void>()
    const controller = createServerOpsSqlQueryController({ api: { query: () => query.promise, cancel: () => cancellation.promise }, publish: () => undefined, createQueryId: () => 'query-1' })
    controller.activate(); controller.setContext({ sourceId: 'source-1', database: 'app', configurationKey: 'v1', available: true }); controller.setDraft('SELECT id FROM users')
    const querying = controller.execute(); const cancelling = controller.cancel()
    query.reject(new Error('QUERY_FAILED')); await querying
    expect(controller.snapshot()).toMatchObject({ status: 'error', activeQueryId: null, error: 'SQL 查询失败，请稍后重试', canExecute: true })
    cancellation.resolve(); await cancelling
    expect(controller.snapshot()).toMatchObject({ status: 'error', error: 'SQL 查询失败，请稍后重试' })
  })

  test('Given 切库取消未确认 When 尝试执行新库 Then 保持新上下文但不启动第二个查询', async () => {
    const first = deferred<ServerOpsDataQueryResult>()
    const cancellation = deferred<void>()
    let queries = 0
    const controller = createServerOpsSqlQueryController({ api: { query: () => { queries += 1; return first.promise }, cancel: () => cancellation.promise }, publish: () => undefined, createQueryId: () => 'query-1' })
    controller.activate(); controller.setContext({ sourceId: 'source-1', database: 'app', configurationKey: 'v1', available: true }); controller.setDraft('SELECT id FROM users')
    void controller.execute()
    controller.setContext({ sourceId: 'source-1', database: 'archive', configurationKey: 'v1', available: true })
    expect(controller.snapshot()).toMatchObject({ status: 'cancelling', context: { database: 'archive' }, activeQueryId: 'query-1', canExecute: false })
    await controller.execute()
    expect(queries).toBe(1)
    cancellation.resolve(); await Promise.resolve(); await Promise.resolve()
    expect(controller.snapshot()).toMatchObject({ status: 'idle', context: { database: 'archive' }, activeQueryId: null })
    first.resolve(result('query-1'))
  })

  test('Given 查询失败 When 重试 Then 保留草稿并用新查询 ID 重新执行', async () => {
    let attempt = 0
    const controller = createServerOpsSqlQueryController({
      api: {
        query: async (input) => { attempt += 1; if (attempt === 1) throw new Error('QUERY_FAILED'); return result(input.queryId, input.database) },
        cancel: async () => undefined,
      },
      publish: () => undefined,
      createQueryId: () => `query-${attempt + 1}`,
    })
    controller.activate()
    controller.setContext({ sourceId: 'source-1', database: 'app', configurationKey: 'v1', available: true })
    controller.setDraft('SELECT id FROM users')
    await controller.execute()
    expect(controller.snapshot()).toMatchObject({ status: 'error', error: 'SQL 查询失败，请稍后重试', draft: 'SELECT id FROM users' })
    await controller.execute()
    expect(controller.snapshot()).toMatchObject({ status: 'success', error: null })
  })

  test('Given 无库、不可达或接口缺失 When 执行 Then 不分派查询', async () => {
    let calls = 0
    const controller = createServerOpsSqlQueryController({ api: { query: async () => { calls += 1; return result('x') } }, publish: () => undefined })
    controller.activate()
    controller.setDraft('SELECT id FROM users')
    await controller.execute()
    controller.setContext({ sourceId: 'source-1', database: 'app', configurationKey: 'v1', available: false })
    await controller.execute()
    expect(calls).toBe(0)
    expect(controller.snapshot().canExecute).toBe(false)
  })
})
