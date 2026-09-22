import { isServerOpsId } from './server-ops'
import type { ServerOpsDataSchemaCell } from './server-ops-data-schema'

/** 单表、联表与行预览共用的数据库执行上限；调用方不能自行延长。 */
export const SERVER_OPS_DATA_QUERY_TIMEOUT_MS = 10_000

/** 数据源 SQL 查询 IPC 通道。 */
export const SERVER_OPS_DATA_QUERY_CHANNELS = {
  EXECUTE: 'server-ops:data-query',
  CANCEL: 'server-ops:data-query-cancel',
} as const

/** 执行单条有界只读 SQL 查询。 */
export interface ServerOpsDataQueryInput {
  sourceId: string
  database: string
  queryId: string
  sql: string
  maxRows: number
}

/** 取消属于指定数据源的在途查询。 */
export interface ServerOpsDataQueryCancelInput {
  sourceId: string
  queryId: string
}

/** SQL 查询公开结果；所有单元格已由 runtime 归一化为有界值。 */
export interface ServerOpsDataQueryResult {
  queryId: string
  database: string
  columns: string[]
  rows: ServerOpsDataSchemaCell[][]
  rowCount: number
  durationMs: number
  truncated: boolean
  warnings: string[]
}

/** 判断未知值是否为普通可枚举对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 判断对象字段是否与给定集合完全一致。 */
function hasExactKeys(value: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
  const actualKeys = Object.keys(value)
  return actualKeys.length === keys.size && actualKeys.every((key) => keys.has(key))
}

/** 判断文本是否有界且不含公开合同禁止的控制字符。 */
function isBoundedText(value: unknown, maximum: number, allowEmpty = true): value is string {
  return typeof value === 'string'
    && (allowEmpty || value.length > 0)
    && value.length <= maximum
    && !/[\u0000-\u001f\u007f]/u.test(value)
}

/** 判断值是否为有界非负安全整数。 */
function isBoundedInteger(value: unknown, maximum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum
}

/** 按表浏览合同独立校验单元格，避免其它 parser 的宽松变化污染查询结果。 */
function parseQueryCell(value: unknown, errorCode: string): ServerOpsDataSchemaCell {
  if (value === null || isBoundedText(value, 256)) return value
  if (!isRecord(value)) throw new Error(errorCode)
  if (value.kind === 'binary'
    && hasExactKeys(value, new Set(['kind', 'bytes']))
    && isBoundedInteger(value.bytes, Number.MAX_SAFE_INTEGER)) {
    return { kind: 'binary', bytes: value.bytes }
  }
  if (value.kind === 'text'
    && hasExactKeys(value, new Set(['kind', 'text', 'truncated']))
    && isBoundedText(value.text, 256)
    && value.truncated === true) {
    return { kind: 'text', text: value.text, truncated: true }
  }
  throw new Error(errorCode)
}

/** 解析 SQL 查询执行输入。 */
export function parseServerOpsDataQueryInput(value: unknown): ServerOpsDataQueryInput {
  const errorCode = 'SERVER_OPS_DATA_QUERY_INPUT_INVALID'
  if (!isRecord(value)
    || !hasExactKeys(value, new Set(['sourceId', 'database', 'queryId', 'sql', 'maxRows']))
    || !isServerOpsId(value.sourceId)
    || !isBoundedText(value.database, 64, false)
    || !isServerOpsId(value.queryId)
    || typeof value.sql !== 'string'
    || value.sql.trim().length === 0
    || value.sql.includes('\u0000')
    || new TextEncoder().encode(value.sql).byteLength > 16_384
    || typeof value.maxRows !== 'number'
    || !Number.isSafeInteger(value.maxRows)
    || value.maxRows < 1
    || value.maxRows > 200) {
    throw new Error(errorCode)
  }
  return {
    sourceId: value.sourceId,
    database: value.database,
    queryId: value.queryId,
    sql: value.sql,
    maxRows: value.maxRows,
  }
}

/** 解析 SQL 查询取消输入。 */
export function parseServerOpsDataQueryCancelInput(value: unknown): ServerOpsDataQueryCancelInput {
  const errorCode = 'SERVER_OPS_DATA_QUERY_CANCEL_INPUT_INVALID'
  if (!isRecord(value)
    || !hasExactKeys(value, new Set(['sourceId', 'queryId']))
    || !isServerOpsId(value.sourceId)
    || !isServerOpsId(value.queryId)) {
    throw new Error(errorCode)
  }
  return { sourceId: value.sourceId, queryId: value.queryId }
}

/** 解析 SQL 查询结果并按最终 pretty JSON 校验 32 KiB 预算。 */
export function parseServerOpsDataQueryResult(value: unknown): ServerOpsDataQueryResult {
  const errorCode = 'SERVER_OPS_DATA_QUERY_RESULT_INVALID'
  if (!isRecord(value)
    || !hasExactKeys(value, new Set(['queryId', 'database', 'columns', 'rows', 'rowCount', 'durationMs', 'truncated', 'warnings']))
    || !isServerOpsId(value.queryId)
    || !isBoundedText(value.database, 64, false)
    || !Array.isArray(value.columns) || value.columns.length > 64
    || !Array.isArray(value.rows) || value.rows.length > 200
    || !isBoundedInteger(value.rowCount, 200)
    || value.rowCount !== value.rows.length
    || !isBoundedInteger(value.durationMs, Number.MAX_SAFE_INTEGER)
    || typeof value.truncated !== 'boolean'
    || !Array.isArray(value.warnings) || value.warnings.length > 32) {
    throw new Error(errorCode)
  }

  /** 列名允许重复，因 JOIN 与表达式投影可能合法产生同名展示列。 */
  const columns = value.columns.map((column) => {
    if (!isBoundedText(column, 128)) throw new Error(errorCode)
    return column
  })
  /** 每行宽度必须与 columns 完全一致。 */
  const rows = value.rows.map((row) => {
    if (!Array.isArray(row) || row.length !== columns.length) throw new Error(errorCode)
    return row.map((cell) => parseQueryCell(cell, errorCode))
  })
  /** 警告只承载短提示，不允许控制字符或无界数组。 */
  const warnings = value.warnings.map((warning) => {
    if (!isBoundedText(warning, 256, false)) throw new Error(errorCode)
    return warning
  })
  const result: ServerOpsDataQueryResult = {
    queryId: value.queryId,
    database: value.database,
    columns,
    rows,
    rowCount: value.rowCount,
    durationMs: value.durationMs,
    truncated: value.truncated,
    warnings,
  }
  if (new TextEncoder().encode(JSON.stringify(result, null, 2)).byteLength > 32_768) throw new Error(errorCode)
  return result
}
