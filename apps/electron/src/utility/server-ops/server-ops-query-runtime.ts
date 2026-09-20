import { Buffer } from 'node:buffer'
import {
  analyzeServerOpsSqlQuery,
  isServerOpsSqlSensitiveColumn,
  limitServerOpsSqlQuery,
  parseServerOpsDataQueryResult,
} from '@proma/shared'
import type { ServerOpsDataQueryResult, ServerOpsDataSchemaCell } from '@proma/shared'

/** SQL 查询 pretty JSON 的公开返回预算。 */
const MAX_QUERY_RESULT_BYTES = 32 * 1_024
/** 单元格沿用表预览的最大文本长度。 */
const MAX_QUERY_CELL_LENGTH = 256
/** 单字段声明宽度上限；更宽字段须在 SQL 中用 LEFT/SUBSTRING 显式缩小。 */
const MAX_QUERY_FIELD_BYTES = MAX_QUERY_CELL_LENGTH * 4
/** 单次查询最多公开的字段数。 */
const MAX_QUERY_COLUMNS = 64

/** mysql2 core Query 的事件窄接口；查询模式不能使用会缓存完整结果的 Promise query。 */
export interface ServerOpsSqlQueryCommand {
  on(event: 'fields', listener: (fields: unknown, index?: number) => void): this
  on(event: 'result', listener: (row: unknown, index?: number) => void): this
  on(event: 'error', listener: (error: unknown) => void): this
  on(event: 'end', listener: () => void): this
}

/** 查询执行器所需的 mysql2 窄接口。 */
export interface ServerOpsSqlQueryConnection {
  query(statement: unknown, values?: readonly unknown[]): Promise<unknown>
  streamQuery(statement: unknown): ServerOpsSqlQueryCommand
  destroy(): void
}

/** 查询执行器内部输入；外层共享 parser 已验证 sourceId。 */
export interface ServerOpsSqlQueryExecutionInput {
  queryId: string
  database: string
  sql: string
  maxRows: number
}

/**
 * 把取消信号绑定到独占数据库连接的销毁动作。
 *
 * @param signal 当前查询的取消信号
 * @param destroy 销毁 mysql2 连接或底层 transport 的幂等动作
 * @returns 查询结束时移除监听的清理函数
 */
export function bindServerOpsSqlQueryAbort(signal: AbortSignal | undefined, destroy: () => void): () => void {
  if (signal === undefined) return () => undefined
  if (signal.aborted) {
    destroy()
    return () => undefined
  }
  const onAbort = (): void => { destroy() }
  signal.addEventListener('abort', onAbort, { once: true })
  return () => { signal.removeEventListener('abort', onAbort) }
}

/** mysql2 字段元数据的安全投影。 */
interface MySqlQueryField {
  name: string
  sourceName: string
  sourceTable: string
  columnLength: number
}

/** 在每个异步边界检查取消，避免继续发出下一条 SQL。 */
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('SERVER_OPS_DATA_CANCELLED')
}

/**
 * 执行 mysql2 Promise 查询并让取消独立于驱动回调收口。
 * mysql2 core `destroy()` 只关闭 transport，部分阶段不会通知当前 command，因此不能只 await 驱动 Promise。
 */
function queryWithAbort(
  connection: ServerOpsSqlQueryConnection,
  statement: unknown,
  values: readonly unknown[] | undefined,
  signal?: AbortSignal,
): Promise<unknown> {
  throwIfAborted(signal)
  const pending = connection.query(statement, values)
  if (signal === undefined) return pending
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error: unknown, result?: unknown): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      if (error !== undefined) reject(error)
      else resolve(result)
    }
    const onAbort = (): void => {
      connection.destroy()
      finish(new Error('SERVER_OPS_DATA_CANCELLED'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) {
      onAbort()
      return
    }
    void pending.then(
      (result) => { finish(undefined, result) },
      (error: unknown) => { finish(error) },
    )
  })
}

/** 从 mysql2 `[rows, fields]` 中读取对象行。 */
function readObjectRows(result: unknown): Record<string, unknown>[] {
  if (!Array.isArray(result) || !Array.isArray(result[0])) return []
  return result[0].filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null && !Array.isArray(row))
}

/** 严格解析 mysql2 字段元数据，不能把坏结果静默降级为空查询。 */
function parseQueryFields(value: unknown, requiresSource: boolean): MySqlQueryField[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('SERVER_OPS_DATA_UNEXPECTED_RESULT')
  return value.map((field) => {
    if (typeof field !== 'object' || field === null) throw new Error('SERVER_OPS_DATA_UNEXPECTED_RESULT')
    const record = field as {
      name?: unknown
      orgName?: unknown
      origName?: unknown
      orgTable?: unknown
      table?: unknown
      columnLength?: unknown
    }
    const sourceName = typeof record.orgName === 'string'
      ? record.orgName
      : typeof record.origName === 'string' ? record.origName : ''
    const sourceTable = typeof record.orgTable === 'string'
      ? record.orgTable
      : typeof record.table === 'string' ? record.table : ''
    if (typeof record.name !== 'string'
      || record.name.length > 128
      || !Number.isSafeInteger(record.columnLength)
      || (record.columnLength as number) < 0
      || (requiresSource && (sourceName.length === 0) !== (sourceTable.length === 0))) {
      throw new Error('SERVER_OPS_DATA_UNEXPECTED_RESULT')
    }
    return { name: record.name, sourceName, sourceTable, columnLength: record.columnLength as number }
  })
}

/** 把任意驱动值转换成公开的有界单元格。 */
function formatQueryCell(value: unknown): { cell: ServerOpsDataSchemaCell; truncated: boolean } {
  if (value === null || value === undefined) return { cell: null, truncated: false }
  if (Buffer.isBuffer(value)) return { cell: { kind: 'binary', bytes: value.byteLength }, truncated: false }
  const text = value instanceof Date
    ? value.toISOString()
    : typeof value === 'object' ? safeJson(value) : String(value)
  if (text.length <= MAX_QUERY_CELL_LENGTH) return { cell: text, truncated: false }
  return { cell: { kind: 'text', text: text.slice(0, MAX_QUERY_CELL_LENGTH), truncated: true }, truncated: true }
}

/** 对对象值做稳定 JSON 降级，不能让循环引用泄漏驱动异常。 */
function safeJson(value: object): string {
  try {
    return JSON.stringify(value)
  } catch {
    return '[无法序列化的对象]'
  }
}

/** 检查表属于当前库且确实是 BASE TABLE，拒绝 VIEW 的 definer/函数边界。 */
async function validateBaseTables(
  connection: ServerOpsSqlQueryConnection,
  database: string,
  tables: readonly string[],
  loadColumns: boolean,
  signal?: AbortSignal,
): Promise<Map<string, Set<string>>> {
  /** 每张基础表对应的真实列名，用于确认显式列来源。 */
  const columnsByTable = new Map<string, Set<string>>()
  for (const table of tables) {
    throwIfAborted(signal)
    const tableResult = await queryWithAbort(connection,
      'SELECT TABLE_NAME AS name, TABLE_TYPE AS type FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? LIMIT 1',
      [database, table],
      signal,
    )
    throwIfAborted(signal)
    const tableRow = readObjectRows(tableResult)[0]
    if (tableRow?.name !== table || String(tableRow.type ?? '').toUpperCase() !== 'BASE TABLE') {
      throw new Error('SERVER_OPS_DATA_QUERY_TABLE_UNAVAILABLE')
    }
    const columns = new Set<string>()
    if (loadColumns) {
      const columnResult = await queryWithAbort(connection,
        'SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION LIMIT 257',
        [database, table],
        signal,
      )
      throwIfAborted(signal)
      for (const row of readObjectRows(columnResult)) {
        if (typeof row.name === 'string' && row.name.length > 0) columns.add(row.name.toLowerCase())
      }
    }
    columnsByTable.set(table, columns)
  }
  return columnsByTable
}

/** 校验显式列确实来自已验证基础表，并在执行前拒绝敏感列。 */
function validateExplicitColumns(
  columns: ReadonlyArray<{ table?: string; column: string; outputAlias?: boolean }>,
  columnsByTable: ReadonlyMap<string, ReadonlySet<string>>,
): void {
  for (const column of columns) {
    /** SELECT 输出别名由 parser 标记，底层投影列已单独进入 plan 并完成来源校验。 */
    if (column.outputAlias === true) continue
    if (isServerOpsSqlSensitiveColumn(column.column)) throw new Error('SERVER_OPS_DATA_QUERY_SENSITIVE_COLUMN')
    /** SQL 别名不在公开 plan 中映射到表；按所有已授权基础表确认至少一个真实来源。 */
    const exists = [...columnsByTable.values()].some((tableColumns) => tableColumns.has(column.column.toLowerCase()))
    if (!exists) throw new Error('SERVER_OPS_DATA_QUERY_COLUMN_UNAVAILABLE')
  }
}

/** 按最终 pretty JSON 字节数逐行收口，确保共享 parser 一定接受。 */
function fitRowsToBudget(base: Omit<ServerOpsDataQueryResult, 'rows' | 'rowCount' | 'truncated'>, rows: ServerOpsDataSchemaCell[][], truncated: boolean): ServerOpsDataQueryResult {
  /** 已接受的行按数据库顺序保留。 */
  const accepted: ServerOpsDataSchemaCell[][] = []
  let budgetTruncated = truncated
  for (const row of rows) {
    const candidate = { ...base, rows: [...accepted, row], rowCount: accepted.length + 1, truncated: budgetTruncated, warnings: base.warnings }
    if (Buffer.byteLength(JSON.stringify(candidate, null, 2), 'utf8') > MAX_QUERY_RESULT_BYTES) {
      budgetTruncated = true
      break
    }
    accepted.push(row)
  }
  const result = { ...base, rows: accepted, rowCount: accepted.length, truncated: budgetTruncated || accepted.length < rows.length }
  return parseServerOpsDataQueryResult(result)
}

/** 支持固定服务端执行上限的 MySQL 方言。 */
type QueryTimeoutDialect = 'mysql' | 'mariadb'

/** 从服务端版本判断可用的服务端查询超时语法；不支持时必须失败关闭。 */
function parseQueryTimeoutDialect(version: string): QueryTimeoutDialect {
  const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(version.trim())
  if (match === null) throw new Error('SERVER_OPS_DATA_QUERY_ENGINE_UNSUPPORTED')
  const major = Number(match[1])
  const minor = Number(match[2])
  const patch = Number(match[3])
  if (/mariadb/iu.test(version)) {
    if (major > 10 || (major === 10 && (minor > 1 || (minor === 1 && patch >= 1)))) return 'mariadb'
    throw new Error('SERVER_OPS_DATA_QUERY_ENGINE_UNSUPPORTED')
  }
  if (major > 5 || (major === 5 && (minor > 7 || (minor === 7 && patch >= 8)))) return 'mysql'
  throw new Error('SERVER_OPS_DATA_QUERY_ENGINE_UNSUPPORTED')
}

/** 读取 `SELECT VERSION()` 的唯一版本字符串。 */
async function readQueryTimeoutDialect(connection: ServerOpsSqlQueryConnection, signal?: AbortSignal): Promise<QueryTimeoutDialect> {
  throwIfAborted(signal)
  const rows = readObjectRows(await queryWithAbort(connection, 'SELECT VERSION() AS version', undefined, signal))
  throwIfAborted(signal)
  if (rows.length !== 1 || typeof rows[0]?.version !== 'string') throw new Error('SERVER_OPS_DATA_UNEXPECTED_RESULT')
  return parseQueryTimeoutDialect(rows[0].version)
}

/** 流式查询的已收口结果。 */
interface StreamedQueryResult {
  fields: MySqlQueryField[]
  rows: ServerOpsDataSchemaCell[][]
  truncated: boolean
  cellTruncated: boolean
}

/**
 * 用 mysql2 core Query 逐行消费；触达任一预算即销毁本次独占连接。
 * 字段声明宽度先于首行检查，避免 LONGTEXT/BLOB 大包进入驱动解码路径。
 */
function readStreamedQuery(
  connection: ServerOpsSqlQueryConnection,
  statement: string,
  input: ServerOpsSqlQueryExecutionInput,
  requiresSource: boolean,
  startedAt: number,
  signal?: AbortSignal,
): Promise<StreamedQueryResult> {
  return new Promise((resolve, reject) => {
    let fields: MySqlQueryField[] | undefined
    const rows: ServerOpsDataSchemaCell[][] = []
    let cellTruncated = false
    let settled = false
    let releaseAbortListener = (): void => undefined

    /** 统一终态；提前收口时同步断开独占连接，阻止继续接收行包。 */
    const finish = (result: StreamedQueryResult | Error, destroy: boolean): void => {
      if (settled) return
      settled = true
      releaseAbortListener()
      if (destroy) connection.destroy()
      if (result instanceof Error) reject(result)
      else resolve(result)
    }

    if (signal !== undefined) {
      const onAbort = (): void => { finish(new Error('SERVER_OPS_DATA_CANCELLED'), true) }
      if (signal.aborted) {
        onAbort()
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
      releaseAbortListener = () => { signal.removeEventListener('abort', onAbort) }
    }

    const command = connection.streamQuery({ sql: statement, rowsAsArray: true })
    command.on('fields', (value, index = 0) => {
      if (settled) return
      try {
        if (index !== 0 || fields !== undefined) throw new Error('SERVER_OPS_DATA_UNEXPECTED_RESULT')
        fields = parseQueryFields(value, requiresSource)
        if (fields.length > MAX_QUERY_COLUMNS) throw new Error('SERVER_OPS_DATA_QUERY_TOO_MANY_COLUMNS')
        if (fields.some((field) => field.columnLength > MAX_QUERY_FIELD_BYTES)) {
          throw new Error('SERVER_OPS_DATA_QUERY_COLUMN_TOO_LARGE')
        }
      } catch (error) {
        finish(error instanceof Error ? error : new Error('SERVER_OPS_DATA_UNEXPECTED_RESULT'), true)
      }
    })
    command.on('result', (value, index = 0) => {
      if (settled) return
      try {
        throwIfAborted(signal)
        if (index !== 0 || fields === undefined || !Array.isArray(value) || value.length !== fields.length) {
          throw new Error('SERVER_OPS_DATA_UNEXPECTED_RESULT')
        }
        if (rows.length >= input.maxRows) {
          finish({ fields, rows, truncated: true, cellTruncated }, true)
          return
        }
        const row = fields.map((field, fieldIndex) => {
          if (isServerOpsSqlSensitiveColumn(field.sourceName || field.name)) return '***'
          const formatted = formatQueryCell(value[fieldIndex])
          if (formatted.truncated) cellTruncated = true
          return formatted.cell
        })
        /** 用最坏的元数据长度预留空间，保证最终 duration/warning 不会把结果推过 32 KiB。 */
        const budgetProbe = {
          queryId: input.queryId,
          database: input.database,
          columns: fields.map((field) => field.name),
          rows: [...rows, row],
          rowCount: rows.length + 1,
          durationMs: Number.MAX_SAFE_INTEGER,
          truncated: false,
          warnings: ['部分单元格内容过长，已截断'],
        }
        if (Buffer.byteLength(JSON.stringify(budgetProbe, null, 2), 'utf8') > MAX_QUERY_RESULT_BYTES) {
          finish({ fields, rows, truncated: true, cellTruncated }, true)
          return
        }
        rows.push(row)
      } catch (error) {
        finish(error instanceof Error ? error : new Error('SERVER_OPS_DATA_UNEXPECTED_RESULT'), true)
      }
    })
    command.on('error', (error) => {
      if (signal?.aborted) finish(new Error('SERVER_OPS_DATA_CANCELLED'), false)
      else finish(error instanceof Error ? error : new Error('SERVER_OPS_DATA_QUERY_FAILED'), false)
    })
    command.on('end', () => {
      if (fields === undefined) finish(new Error('SERVER_OPS_DATA_UNEXPECTED_RESULT'), true)
      else finish({ fields, rows, truncated: false, cellTruncated }, false)
    })
  })
}

/**
 * 在已连接 MySQL 会话上执行单条受控只读查询。
 *
 * @param connection 独占的 mysql2 连接
 * @param input 已过共享字段 parser 的查询输入
 * @param signal 取消后由外层同步 destroy 连接，本函数在每个异步边界停止后续 SQL
 * @returns 已完成遮罩和双预算裁剪的公开结果
 */
export async function executeServerOpsSqlQuery(
  connection: ServerOpsSqlQueryConnection,
  input: ServerOpsSqlQueryExecutionInput,
  signal?: AbortSignal,
): Promise<ServerOpsDataQueryResult> {
  throwIfAborted(signal)
  let plan: ReturnType<typeof analyzeServerOpsSqlQuery>
  try {
    plan = analyzeServerOpsSqlQuery(input.sql, input.database)
  } catch (error) {
    if (error instanceof Error && error.message === 'SERVER_OPS_SQL_SENSITIVE_COLUMN') {
      throw new Error('SERVER_OPS_DATA_QUERY_SENSITIVE_COLUMN')
    }
    throw new Error('SERVER_OPS_DATA_QUERY_SQL_INVALID')
  }
  /** 语法与显式敏感列判定必须早于第一次数据库调用。 */
  for (const column of plan.columns) {
    if (isServerOpsSqlSensitiveColumn(column.column)) throw new Error('SERVER_OPS_DATA_QUERY_SENSITIVE_COLUMN')
  }
  const timeoutDialect = await readQueryTimeoutDialect(connection, signal)
  const columnsByTable = await validateBaseTables(connection, input.database, plan.tables, !plan.hasWildcard, signal)
  if (!plan.hasWildcard) validateExplicitColumns(plan.columns, columnsByTable)
  throwIfAborted(signal)

  /** 事务开始后无论查询成功、失败或取消都尝试回滚。 */
  let transactionStarted = false
  const startedAt = Date.now()
  try {
    await queryWithAbort(connection, 'SET SESSION TRANSACTION READ ONLY', undefined, signal)
    throwIfAborted(signal)
    await queryWithAbort(connection, timeoutDialect === 'mysql'
      ? 'SET SESSION MAX_EXECUTION_TIME = 10000'
      : 'SET SESSION max_statement_time = 10', undefined, signal)
    throwIfAborted(signal)
    await queryWithAbort(connection, 'START TRANSACTION READ ONLY', undefined, signal)
    transactionStarted = true
    throwIfAborted(signal)
    const limitedSql = limitServerOpsSqlQuery(plan, input.maxRows)
    const queryResult = await readStreamedQuery(connection, limitedSql, input, plan.hasWildcard, startedAt, signal)
    throwIfAborted(signal)
    const columns = queryResult.fields.map((field) => field.name)
    const warnings = queryResult.cellTruncated ? ['部分单元格内容过长，已截断'] : []
    return fitRowsToBudget({
      queryId: input.queryId,
      database: input.database,
      columns,
      durationMs: Math.max(0, Date.now() - startedAt),
      warnings,
    }, queryResult.rows, queryResult.truncated || queryResult.cellTruncated)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('SERVER_OPS_DATA_QUERY_')) throw error
    if (error instanceof Error && error.message === 'SERVER_OPS_DATA_CANCELLED') throw error
    if (error instanceof Error && error.message === 'SERVER_OPS_DATA_UNEXPECTED_RESULT') throw error
    throw new Error('SERVER_OPS_DATA_QUERY_FAILED')
  } finally {
    if (transactionStarted && !signal?.aborted) {
      try { await queryWithAbort(connection, 'ROLLBACK', undefined, signal) } catch { /* 独占连接随后销毁，回滚失败不覆盖原错误。 */ }
    }
  }
}
