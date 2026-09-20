import { isServerOpsId } from './server-ops'

/** 单个数据源数据库最多保留的 SQL 查询历史条数。 */
export const SERVER_OPS_DATA_QUERY_HISTORY_LIMIT = 100

/** SQL 查询历史 IPC 通道；历史只在本地持久化，不触发远端请求。 */
export const SERVER_OPS_DATA_QUERY_HISTORY_CHANNELS = {
  LIST: 'server-ops:data-query-history-list',
  SAVE: 'server-ops:data-query-history-save',
} as const

/** SQL 查询历史按数据源与数据库严格隔离。 */
export interface ServerOpsDataQueryHistoryScope {
  sourceId: string
  database: string
}

/** 待保存的 SQL 查询历史。 */
export interface ServerOpsDataQueryHistoryRecordInput extends ServerOpsDataQueryHistoryScope {
  sql: string
}

/** 已持久化的 SQL 查询历史条目。 */
export interface ServerOpsDataQueryHistoryEntry extends ServerOpsDataQueryHistoryRecordInput {
  id: string
  createdAt: number
}

/** 单个 scope 的完整有界 SQL 查询历史。 */
export interface ServerOpsDataQueryHistoryResult {
  entries: ServerOpsDataQueryHistoryEntry[]
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

/** 校验数据库名，边界与 SQL 查询执行合同保持一致。 */
function isDatabaseName(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 64
    && !/[\u0000-\u001f\u007f]/u.test(value)
}

/** 校验 SQL 文本，允许换行但拒绝空文本、NUL 与超过 16 KiB 的输入。 */
function isQuerySql(value: unknown): value is string {
  return typeof value === 'string'
    && value.trim().length > 0
    && !value.includes('\u0000')
    && new TextEncoder().encode(value).byteLength <= 16_384
}

/** 校验可持久化时间戳。 */
function isTimestamp(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= 8_640_000_000_000_000
}

/** 解析 SQL 查询历史 scope。 */
export function parseServerOpsDataQueryHistoryScope(value: unknown): ServerOpsDataQueryHistoryScope {
  if (!isRecord(value)
    || !hasExactKeys(value, new Set(['sourceId', 'database']))
    || !isServerOpsId(value.sourceId)
    || !isDatabaseName(value.database)) {
    throw new Error('SERVER_OPS_DATA_QUERY_HISTORY_SCOPE_INVALID')
  }
  return { sourceId: value.sourceId, database: value.database }
}

/** 解析待保存的 SQL 查询历史；原始 SQL 不做格式化或大小写改写。 */
export function parseServerOpsDataQueryHistoryRecordInput(value: unknown): ServerOpsDataQueryHistoryRecordInput {
  if (!isRecord(value)
    || !hasExactKeys(value, new Set(['sourceId', 'database', 'sql']))
    || !isServerOpsId(value.sourceId)
    || !isDatabaseName(value.database)
    || !isQuerySql(value.sql)) {
    throw new Error('SERVER_OPS_DATA_QUERY_HISTORY_RECORD_INVALID')
  }
  return { sourceId: value.sourceId, database: value.database, sql: value.sql }
}

/** 解析单条已持久化历史。 */
function parseHistoryEntry(value: unknown): ServerOpsDataQueryHistoryEntry {
  if (!isRecord(value)
    || !hasExactKeys(value, new Set(['id', 'sourceId', 'database', 'sql', 'createdAt']))
    || !isServerOpsId(value.id)
    || !isServerOpsId(value.sourceId)
    || !isDatabaseName(value.database)
    || !isQuerySql(value.sql)
    || !isTimestamp(value.createdAt)) {
    throw new Error('SERVER_OPS_DATA_QUERY_HISTORY_RESULT_INVALID')
  }
  return {
    id: value.id,
    sourceId: value.sourceId,
    database: value.database,
    sql: value.sql,
    createdAt: value.createdAt,
  }
}

/** 解析单个 scope 的完整有界 SQL 查询历史结果。 */
export function parseServerOpsDataQueryHistoryResult(value: unknown): ServerOpsDataQueryHistoryResult {
  if (!isRecord(value)
    || !hasExactKeys(value, new Set(['entries']))
    || !Array.isArray(value.entries)
    || value.entries.length > SERVER_OPS_DATA_QUERY_HISTORY_LIMIT) {
    throw new Error('SERVER_OPS_DATA_QUERY_HISTORY_RESULT_INVALID')
  }
  const entries = value.entries.map(parseHistoryEntry)
  const seen = new Set<string>()
  for (const entry of entries) {
    if (seen.has(entry.id)) throw new Error('SERVER_OPS_DATA_QUERY_HISTORY_RESULT_INVALID')
    seen.add(entry.id)
  }
  return { entries }
}

/** 解析并确认结果中的每条记录都属于调用方请求的同一 scope。 */
export function parseServerOpsDataQueryHistoryResultForScope(
  value: unknown,
  scopeValue: unknown,
): ServerOpsDataQueryHistoryResult {
  const scope = parseServerOpsDataQueryHistoryScope(scopeValue)
  const result = parseServerOpsDataQueryHistoryResult(value)
  if (result.entries.some((entry) => entry.sourceId !== scope.sourceId || entry.database !== scope.database)) {
    throw new Error('SERVER_OPS_DATA_QUERY_HISTORY_RESULT_INVALID')
  }
  return result
}
