import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { bindServerOpsSqlQueryAbort, executeServerOpsSqlQuery } from './server-ops-query-runtime'

/** 构造记录所有查询的内存 MySQL 连接。 */
function createConnection(
  respond: (sql: string, values: readonly unknown[]) => unknown,
  options: { version?: string } = {},
) {
  /** 已执行的 SQL 与参数，用于验证校验顺序和只读事务。 */
  const calls: Array<{ sql: string; values: readonly unknown[] }> = []
  let destroyed = false
  let streamedRows = 0
  return {
    calls,
    get destroyed() { return destroyed },
    get streamedRows() { return streamedRows },
    async query(statement: unknown, values: readonly unknown[] = []): Promise<unknown> {
      /** mysql2 查询选项在真实查询阶段携带 rowsAsArray。 */
      const sql = typeof statement === 'string' ? statement : (statement as { sql: string }).sql
      calls.push({ sql, values })
      if (sql === 'SELECT VERSION() AS version') return [[{ version: options.version ?? '8.0.36' }], []]
      return respond(sql, values)
    },
    /** 模拟 mysql2 core Query：fields 先于逐行 result 到达。 */
    streamQuery(statement: unknown) {
      const sql = typeof statement === 'string' ? statement : (statement as { sql: string }).sql
      calls.push({ sql, values: [] })
      const command = new EventEmitter()
      queueMicrotask(() => {
        const response = respond(sql, [])
        const rows = Array.isArray(response) && Array.isArray(response[0]) ? response[0] : []
        const fields = Array.isArray(response) && Array.isArray(response[1]) ? response[1] : []
        command.emit('fields', fields)
        for (const row of rows) {
          if (destroyed) break
          streamedRows += 1
          command.emit('result', row)
        }
        if (!destroyed) command.emit('end')
      })
      return command
    },
    destroy() { destroyed = true },
  }
}

/** 构造合法查询输入。 */
function createInput(sql = 'SELECT id, name FROM users') {
  return { queryId: 'query-1', database: 'app', sql, maxRows: 2 }
}

describe('Server Ops 受控 SQL 查询执行器', () => {
  test('Given 运行中的连接 When 取消 Then 驱动 destroy 只触发一次且可清理监听', () => {
    const controller = new AbortController()
    let destroyCalls = 0
    const cleanup = bindServerOpsSqlQueryAbort(controller.signal, () => { destroyCalls += 1 })

    controller.abort()
    controller.abort()
    cleanup()

    expect(destroyCalls).toBe(1)
  })

  test('Given metadata Promise 在 destroy 后不结算 When 取消 Then 查询仍立即以取消收口', async () => {
    const controller = new AbortController()
    let destroyCalls = 0
    const connection = {
      query: async (): Promise<unknown> => await new Promise(() => undefined),
      streamQuery: () => new EventEmitter(),
      destroy: () => { destroyCalls += 1 },
    }
    const execution = executeServerOpsSqlQuery(connection, createInput(), controller.signal)
    queueMicrotask(() => { controller.abort() })

    await expect(Promise.race([
      execution,
      new Promise((_, reject) => setTimeout(() => { reject(new Error('TEST_METADATA_CANCEL_TIMEOUT')) }, 100)),
    ])).rejects.toThrow('SERVER_OPS_DATA_CANCELLED')
    expect(destroyCalls).toBeGreaterThan(0)
  })

  test('Given 非只读 SQL When 执行 Then 在任何数据库调用前拒绝', async () => {
    const connection = createConnection(() => [[], []])

    await expect(executeServerOpsSqlQuery(connection, createInput('DELETE FROM users'))).rejects.toThrow('SERVER_OPS_DATA_QUERY_SQL_INVALID')
    expect(connection.calls).toHaveLength(0)
  })

  test('Given 显式 authorization 敏感列 When 执行 Then 在任何数据库调用前拒绝', async () => {
    const connection = createConnection(() => [[], []])

    await expect(executeServerOpsSqlQuery(connection, createInput('SELECT `authorization` FROM users')))
      .rejects.toThrow('SERVER_OPS_DATA_QUERY_SENSITIVE_COLUMN')
    expect(connection.calls).toHaveLength(0)
  })

  test('Given 引用视图 When 校验来源 Then 拒绝且不执行用户 SQL', async () => {
    const connection = createConnection((sql) => {
      if (sql.includes('information_schema.TABLES')) return [[{ name: 'users_view', type: 'VIEW' }], []]
      throw new Error(`不应执行：${sql}`)
    })

    await expect(executeServerOpsSqlQuery(connection, createInput('SELECT id FROM users_view'))).rejects.toThrow('SERVER_OPS_DATA_QUERY_TABLE_UNAVAILABLE')
    expect(connection.calls.some((call) => call.sql.includes('SELECT id FROM users_view'))).toBe(false)
  })

  test('Given 合法查询 When 执行 Then 设置只读事务与服务端超时并回滚', async () => {
    const connection = createConnection((sql) => {
      if (sql.includes('information_schema.TABLES')) return [[{ name: 'users', type: 'BASE TABLE' }], []]
      if (sql.includes('information_schema.COLUMNS')) return [[{ name: 'id' }, { name: 'name' }], []]
      if (sql.includes('FROM `users`') && !sql.includes('information_schema')) {
        return [[[1, 'Alice'], [2, 'Bob'], [3, 'Carol']], [
          { name: 'id', orgName: 'id', orgTable: 'users', columnLength: 11 },
          { name: 'name', orgName: 'name', orgTable: 'users', columnLength: 256 },
        ]]
      }
      return [[], []]
    })

    const result = await executeServerOpsSqlQuery(connection, createInput())

    expect(connection.calls.map((call) => call.sql)).toContain('SET SESSION TRANSACTION READ ONLY')
    expect(connection.calls.map((call) => call.sql)).toContain('SET SESSION MAX_EXECUTION_TIME = 10000')
    expect(connection.calls.map((call) => call.sql)).toContain('START TRANSACTION READ ONLY')
    expect(connection.calls.at(-1)?.sql).toBe('ROLLBACK')
    expect(result).toMatchObject({ queryId: 'query-1', database: 'app', columns: ['id', 'name'], rowCount: 2, truncated: true })
  })

  test('Given MySQL 5.6 When 查询 Then 明确拒绝没有服务端十秒上限的引擎版本', async () => {
    const connection = createConnection((sql) => {
      if (sql.includes('information_schema.TABLES')) return [[{ name: 'users', type: 'BASE TABLE' }], []]
      if (sql.includes('information_schema.COLUMNS')) return [[{ name: 'id' }, { name: 'name' }], []]
      return [[], []]
    }, { version: '5.6.51-log' })

    await expect(executeServerOpsSqlQuery(connection, createInput())).rejects.toThrow('SERVER_OPS_DATA_QUERY_ENGINE_UNSUPPORTED')
    expect(connection.calls.some((call) => call.sql === 'START TRANSACTION READ ONLY')).toBe(false)
  })

  test('Given MariaDB When 查询 Then 使用 max_statement_time 提供服务端十秒上限', async () => {
    const connection = createConnection((sql) => {
      if (sql.includes('information_schema.TABLES')) return [[{ name: 'users', type: 'BASE TABLE' }], []]
      if (sql.includes('information_schema.COLUMNS')) return [[{ name: 'id' }, { name: 'name' }], []]
      if (sql.includes('FROM `users`') && !sql.includes('information_schema')) {
        return [[[1, 'Alice']], [
          { name: 'id', orgName: 'id', orgTable: 'users', columnLength: 11 },
          { name: 'name', orgName: 'name', orgTable: 'users', columnLength: 256 },
        ]]
      }
      return [[], []]
    }, { version: '10.11.8-MariaDB' })

    await executeServerOpsSqlQuery(connection, createInput())

    expect(connection.calls.map((call) => call.sql)).toContain('SET SESSION max_statement_time = 10')
    expect(connection.calls.map((call) => call.sql)).not.toContain('SET SESSION MAX_EXECUTION_TIME = 10000')
  })

  test('Given 通配符包含敏感来源列 When 返回 Then 保留列头并遮罩真实来源值', async () => {
    const connection = createConnection((sql) => {
      if (sql.includes('information_schema.TABLES')) return [[{ name: 'users', type: 'BASE TABLE' }], []]
      if (sql.includes('SELECT * FROM `users`')) {
        return [[['alice@example.com', 'Alice']], [
          { name: 'contact', orgName: 'password_hash', orgTable: 'users', columnLength: 256 },
          { name: 'display_name', orgName: 'name', orgTable: 'users', columnLength: 256 },
        ]]
      }
      return [[], []]
    })

    const result = await executeServerOpsSqlQuery(connection, createInput('SELECT * FROM users'))

    expect(result.columns).toEqual(['contact', 'display_name'])
    expect(result.rows[0]).toEqual(['***', 'Alice'])
  })

  test('Given 通配符返回 authorization 真实来源 When 返回 Then 即使别名无敏感字样也必须遮罩', async () => {
    const connection = createConnection((sql) => {
      if (sql.includes('information_schema.TABLES')) return [[{ name: 'users', type: 'BASE TABLE' }], []]
      if (sql.includes('SELECT * FROM `users`')) {
        return [[['Bearer secret']], [
          { name: 'header_value', orgName: 'authorization', orgTable: 'users', columnLength: 512 },
        ]]
      }
      return [[], []]
    })

    const result = await executeServerOpsSqlQuery(connection, createInput('SELECT * FROM users'))

    expect(result.rows[0]).toEqual(['***'])
  })

  test('Given 通配符与计算列混合 When 计算列没有来源元数据 Then 保留通配来源校验并允许计算列', async () => {
    const connection = createConnection((sql) => {
      if (sql.includes('information_schema.TABLES')) return [[{ name: 'users', type: 'BASE TABLE' }], []]
      if (sql.includes('SELECT *, 1 AS `marker` FROM `users`')) {
        return [[[1, 1]], [
          { name: 'id', orgName: 'id', orgTable: 'users', columnLength: 11 },
          { name: 'marker', orgName: '', orgTable: '', columnLength: 1 },
        ]]
      }
      return [[], []]
    })

    const result = await executeServerOpsSqlQuery(connection, createInput('SELECT *, 1 AS marker FROM users'))

    expect(result).toMatchObject({ columns: ['id', 'marker'], rows: [['1', '1']] })
  })

  test('Given 聚合输出别名用于排序 When 校验显式列 Then 只校验底层真实列并允许执行', async () => {
    const connection = createConnection((sql) => {
      if (sql.includes('information_schema.TABLES')) return [[{ name: 'users', type: 'BASE TABLE' }], []]
      if (sql.includes('information_schema.COLUMNS')) return [[{ name: 'id' }], []]
      if (sql.includes('SUM(`id`) AS `total`')) {
        return [[[3]], [{ name: 'total', orgName: '', orgTable: '', columnLength: 24 }]]
      }
      return [[], []]
    })

    const result = await executeServerOpsSqlQuery(connection, createInput('SELECT SUM(id) AS total FROM users ORDER BY total'))

    expect(result).toMatchObject({ columns: ['total'], rows: [['3']], rowCount: 1 })
  })

  test('Given SQL 列名大小写与元数据不同 When 校验来源 Then 按 MySQL 列名规则允许执行', async () => {
    const connection = createConnection((sql) => {
      if (sql.includes('information_schema.TABLES')) return [[{ name: 'users', type: 'BASE TABLE' }], []]
      if (sql.includes('information_schema.COLUMNS')) return [[{ name: 'id' }], []]
      if (sql.includes('SELECT `ID` FROM `users`')) {
        return [[[1]], [{ name: 'ID', orgName: 'id', orgTable: 'users', columnLength: 11 }]]
      }
      return [[], []]
    })

    const result = await executeServerOpsSqlQuery(connection, createInput('SELECT ID FROM users'))

    expect(result.rows).toEqual([['1']])
  })

  test('Given 返回内容超过预算 When 收口 Then JSON 不超过 32KiB 且明确截断', async () => {
    const connection = createConnection((sql) => {
      if (sql.includes('information_schema.TABLES')) return [[{ name: 'users', type: 'BASE TABLE' }], []]
      if (sql.includes('information_schema.COLUMNS')) return [[{ name: 'name' }], []]
      if (sql.includes('FROM `users`') && !sql.includes('information_schema')) {
        return [Array.from({ length: 200 }, () => ['界'.repeat(256)]), [{ name: 'name', orgName: 'name', orgTable: 'users', columnLength: 1_024 }]]
      }
      return [[], []]
    })

    const result = await executeServerOpsSqlQuery(connection, { ...createInput('SELECT name FROM users'), maxRows: 200 })

    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(32 * 1_024)
    expect(result.truncated).toBe(true)
  })

  test('Given 查询返回超过 maxRows When 读取 Then 在探测行到达后立即销毁连接', async () => {
    const connection = createConnection((sql) => {
      if (sql.includes('information_schema.TABLES')) return [[{ name: 'users', type: 'BASE TABLE' }], []]
      if (sql.includes('information_schema.COLUMNS')) return [[{ name: 'id' }, { name: 'name' }], []]
      if (sql.includes('FROM `users`') && !sql.includes('information_schema')) {
        return [[[1, 'A'], [2, 'B'], [3, 'C'], [4, 'D']], [
          { name: 'id', orgName: 'id', orgTable: 'users', columnLength: 11 },
          { name: 'name', orgName: 'name', orgTable: 'users', columnLength: 256 },
        ]]
      }
      return [[], []]
    })

    const result = await executeServerOpsSqlQuery(connection, createInput())

    expect(result.rowCount).toBe(2)
    expect(result.truncated).toBe(true)
    expect(connection.streamedRows).toBe(3)
    expect(connection.destroyed).toBe(true)
  })

  test('Given 查询字段超过 64 列 When 收到字段元数据 Then 在首行前销毁连接', async () => {
    const fields = Array.from({ length: 65 }, (_, index) => ({
      name: `c${index}`,
      orgName: `c${index}`,
      orgTable: 'users',
      columnLength: 32,
    }))
    const connection = createConnection((sql) => {
      if (sql.includes('information_schema.TABLES')) return [[{ name: 'users', type: 'BASE TABLE' }], []]
      if (sql.includes('SELECT * FROM `users`')) return [[Array.from({ length: 65 }, () => 'x')], fields]
      return [[], []]
    })

    await expect(executeServerOpsSqlQuery(connection, createInput('SELECT * FROM users')))
      .rejects.toThrow('SERVER_OPS_DATA_QUERY_TOO_MANY_COLUMNS')
    expect(connection.streamedRows).toBe(0)
    expect(connection.destroyed).toBe(true)
  })

  test('Given 字段声明宽度超过传输预算 When 收到字段元数据 Then 提示先显式截断且不读取首行', async () => {
    const connection = createConnection((sql) => {
      if (sql.includes('information_schema.TABLES')) return [[{ name: 'users', type: 'BASE TABLE' }], []]
      if (sql.includes('information_schema.COLUMNS')) return [[{ name: 'name' }], []]
      if (sql.includes('FROM `users`') && !sql.includes('information_schema')) {
        return [[['x'.repeat(100_000)]], [{ name: 'name', orgName: 'name', orgTable: 'users', columnLength: 100_000 }]]
      }
      return [[], []]
    })

    await expect(executeServerOpsSqlQuery(connection, createInput('SELECT name FROM users')))
      .rejects.toThrow('SERVER_OPS_DATA_QUERY_COLUMN_TOO_LARGE')
    expect(connection.streamedRows).toBe(0)
    expect(connection.destroyed).toBe(true)
  })

  test('Given 驱动行宽与字段不一致 When 流式读取 Then 稳定拒绝而不是返回部分结果', async () => {
    const connection = createConnection((sql) => {
      if (sql.includes('information_schema.TABLES')) return [[{ name: 'users', type: 'BASE TABLE' }], []]
      if (sql.includes('information_schema.COLUMNS')) return [[{ name: 'id' }, { name: 'name' }], []]
      if (sql.includes('FROM `users`') && !sql.includes('information_schema')) {
        return [[[1]], [
          { name: 'id', orgName: 'id', orgTable: 'users', columnLength: 11 },
          { name: 'name', orgName: 'name', orgTable: 'users', columnLength: 256 },
        ]]
      }
      return [[], []]
    })

    await expect(executeServerOpsSqlQuery(connection, createInput()))
      .rejects.toThrow('SERVER_OPS_DATA_UNEXPECTED_RESULT')
    expect(connection.destroyed).toBe(true)
  })

  test('Given 通配符字段缺少真实来源 When 流式读取 Then 失败关闭避免绕过敏感遮罩', async () => {
    const connection = createConnection((sql) => {
      if (sql.includes('information_schema.TABLES')) return [[{ name: 'users', type: 'BASE TABLE' }], []]
      if (sql.includes('SELECT * FROM `users`')) {
        return [[['secret']], [{ name: 'authorization', orgName: '', orgTable: 'users', columnLength: 256 }]]
      }
      return [[], []]
    })

    await expect(executeServerOpsSqlQuery(connection, createInput('SELECT * FROM users')))
      .rejects.toThrow('SERVER_OPS_DATA_UNEXPECTED_RESULT')
    expect(connection.streamedRows).toBe(0)
    expect(connection.destroyed).toBe(true)
  })
})
