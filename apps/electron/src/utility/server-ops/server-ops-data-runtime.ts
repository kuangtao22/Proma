import type { Duplex } from 'node:stream'
import { createHash } from 'node:crypto'
import { checkServerIdentity, connect as connectTls } from 'node:tls'
import { isIP } from 'node:net'
import type { PeerCertificate, TLSSocket } from 'node:tls'
import { createConnection as createMysqlConnection } from 'mysql2'
import type { Connection as MySqlConnection } from 'mysql2'
import { AbstractConnector, Redis } from 'ioredis'
import { isServerOpsMySqlTlsServerName, isServerOpsSqlSensitiveColumn, MAX_SERVER_OPS_CELL_BYTES } from '@proma/shared'
import type {
  ServerOpsDataCapability,
  ServerOpsDataEngine,
  ServerOpsDataMetric,
  ServerOpsDataTable,
  ServerOpsDataTlsMode,
  ServerOpsDataTlsStatus,
  ServerOpsDataSchemaColumn,
  ServerOpsDataSchemaCell,
  ServerOpsDataSchemaIndex,
  ServerOpsDataSchemaTableSummary,
  ServerOpsDataParameter,
  ServerOpsDataQueryResult,
  ServerOpsDataRowFilters,
} from '@proma/shared'
import type { ServerOpsRuntimeDataReadResult } from './server-ops-runtime-protocol'
import {
  bindServerOpsSqlQueryAbort,
  configureServerOpsMySqlReadLimits,
  executeServerOpsSqlQuery,
  getServerOpsSqlQueryPublicError,
  normalizeServerOpsSqlQueryError,
} from './server-ops-query-runtime'
import { buildServerOpsRowFilterSql, getServerOpsRowFilterPublicError } from './server-ops-row-filter-sql'

/** 数据服务在 utility process 内执行的一次数据读取输入；含秘密，禁止回传主进程之外。 */
/** 所有数据读取模式共享的真实连接字段。 */
interface ServerOpsDataRuntimeInputBase {
  /** 本适配器仅处理网络协议；SQLite 由独立 SSH 文件适配器读取。 */
  engine: Exclude<ServerOpsDataEngine, 'sqlite'>
  address: string
  port: number
  database?: string
  username?: string
  password?: string
  tlsMode: ServerOpsDataTlsMode
  tlsServerName?: string
  /** 表浏览目标库；必须已在 information_schema 内校验过。 */
  schemaDatabase?: string
  /** 只在指定库的 schema-tables 模式按需过滤表名。 */
  schemaTableSearch?: string
  /** 表浏览目标表；`schema-table` 与 `schema-rows` 使用。 */
  schemaTable?: string
  /** Agent 表浏览只读取基础表；UI 默认不附加此限制。 */
  baseTablesOnly?: boolean
  /** 行预览偏移与页大小；`schema-rows` 使用。 */
  rowOffset?: number
  rowLimit?: number
  /** 行预览的受控字段条件；仅 schema-rows 使用。 */
  rowFilters?: ServerOpsDataRowFilters
  /** 全文读取的目标列、绝对行偏移与预览摘要。 */
  cellColumnIndex?: number
  cellExpectedColumn?: string
  cellSha256?: string
  /** MySQL 诊断分区；省略时保持旧版全量诊断。 */
  diagnosticSection?: import('@proma/shared').ServerOpsDataDiagnosticSection
  /** MySQL 会话或慢语句的库级筛选；不参与握手默认库。 */
  diagnosticDatabase?: string
}

/** 诊断与表浏览输入；禁止夹带 SQL 查询字段。 */
export interface ServerOpsDataRuntimeNonQueryInput extends ServerOpsDataRuntimeInputBase {
  mode: 'probe' | 'diagnostics' | 'schema-tables' | 'schema-table' | 'schema-rows' | 'schema-cell'
  queryId?: never
  sql?: never
  maxRows?: never
}

/** SQL 查询输入；database 和查询三字段均为必填。 */
export interface ServerOpsDataRuntimeQueryInput extends ServerOpsDataRuntimeInputBase {
  mode: 'sql-query'
  database: string
  queryId: string
  sql: string
  maxRows: number
}

/** utility 支持的完整数据读取输入判别 union。 */
export type ServerOpsDataRuntimeInput = ServerOpsDataRuntimeNonQueryInput | ServerOpsDataRuntimeQueryInput

/**
 * 数据服务 runtime 返回的结构化结果。
 *
 * **直接使用协议层的结果类型**而不是自造字段名：运行时会把这份结果原样 post 给主进程，
 * 只有形状与协议一致，主进程的严格解析才会接受（否则会被判为无效消息静默丢弃）。
 */
export type ServerOpsDataRuntimeOutput = ServerOpsRuntimeDataReadResult
/** 旧诊断与表浏览的结果，排除没有 capability/mode 的 SQL 查询结果。 */
type ServerOpsDataRuntimeNonQueryOutput = Exclude<ServerOpsRuntimeDataReadResult, ServerOpsDataQueryResult>

/** MySQL 读取接口；绑定值只接收已校验的标识文本、筛选文本或分页整数。 */
interface MySqlReadConnection {
  query: (sql: string, values?: (string | number)[]) => Promise<unknown>
  execute?: (sql: string, values?: (string | number)[]) => Promise<unknown>
}

/** 建立到目标数据库的单条 SSH 转发通道；由调用方保证生命周期。 */
export type ServerOpsDataChannelFactory = () => Promise<Duplex>

/** ioredis 自定义连接器构造签名；ioredis 只在内部按此形态实例化。 */
type RedisConnectorConstructor = new (options: unknown) => AbstractConnector

/** 单个数据源允许保留的最大诊断表格数，与共享合同一致。 */
const MAX_DATA_TABLES = 4
/** 单个数据源允许保留的最大指标卡数，与共享合同一致。 */
const MAX_DATA_METRICS = 24
/** 单个表格允许保留的最大行数，与共享合同一致。 */
const MAX_TABLE_ROWS = 200
/** 单个表格允许保留的最大列数，与共享合同一致。 */
const MAX_TABLE_COLUMNS = 12
/** 单元格允许保留的最大字符数，与共享合同一致。 */
const MAX_CELL_LENGTH = 512
/** 单条 warning 允许保留的最大字符数，与共享合同一致。 */
const MAX_WARNING_LENGTH = 512
/** 参数诊断的公开条数与总字节预算。 */
const MAX_PARAMETER_ROWS = 1_000
const MAX_PARAMETER_VALUE_LENGTH = 1_024
const MAX_PARAMETER_RESULT_BYTES = 262_144
/** 行预览公开结果的总字节预算；不通过丢行满足预算，避免分页跳行。 */
const MAX_SCHEMA_ROWS_RESULT_BYTES = 1_048_576
/** 摘要元数据单独计入总预算；正文仍受上方 1 MiB 限制。 */
const MAX_SCHEMA_ROWS_WITH_DIGESTS_BYTES = 2_097_152

/** MySQL 只读诊断固定语句；不含任何用户插值。 */
const MYSQL_VERSION_QUERY = 'SELECT VERSION() AS version'
/** MySQL 全局状态；只读取固定变量名，不展示完整原文。 */
const MYSQL_STATUS_QUERY = 'SHOW GLOBAL STATUS'
/** MySQL 最大连接数配置。 */
const MYSQL_MAX_CONNECTIONS_QUERY = "SHOW GLOBAL VARIABLES LIKE 'max_connections'"
/** MySQL 库级容量，只读取 information_schema 元数据。 */
const MYSQL_DATABASES_QUERY = 'SELECT table_schema AS schema_name, COUNT(*) AS table_count,'
  + ' COALESCE(SUM(data_length + index_length), 0) AS size_bytes'
  + ' FROM information_schema.tables GROUP BY table_schema ORDER BY size_bytes DESC LIMIT 50'
/** MySQL 会话列表；字段限制在固定白名单，不返回 SQL 正文。 */
const MYSQL_PROCESSLIST_QUERY = 'SELECT ID AS id, USER AS user, HOST AS host, DB AS db,'
  + ' COMMAND AS command, TIME AS time, STATE AS state'
  + ' FROM information_schema.PROCESSLIST'
/** MySQL 慢语句摘要；DIGEST_TEXT 已由服务器按占位符归一化，不含参数值。 */
const MYSQL_STATEMENTS_QUERY = 'SELECT SCHEMA_NAME AS schema_name, DIGEST_TEXT AS digest_text, COUNT_STAR AS exec_count,'
  + ' ROUND(AVG_TIMER_WAIT / 1000000, 2) AS avg_ms, ROUND(SUM_ROWS_EXAMINED / COUNT_STAR, 0) AS avg_rows'
  + ' FROM performance_schema.events_statements_summary_by_digest'
  + ' WHERE DIGEST_TEXT IS NOT NULL'
/** MySQL 复制状态在 8.0.22 起改名，先试新名再回退旧名。 */
const MYSQL_REPLICA_STATUS_QUERY = 'SHOW REPLICA STATUS'
/** MySQL 复制状态旧称，覆盖 5.7 与 8.0.22 之前的 8.x。 */
const MYSQL_SLAVE_STATUS_QUERY = 'SHOW SLAVE STATUS'
/** MySQL 5.7/8.x 都支持的全局参数读取。 */
const MYSQL_PARAMETERS_QUERY = 'SHOW GLOBAL VARIABLES'
/** Redis 慢日志读取条数上限。 */
const REDIS_SLOWLOG_LIMIT = 20
/** Redis 慢日志单条命令保留的最大字符数。 */
const REDIS_SLOWLOG_COMMAND_LENGTH = 160

/** 把任意值安全转为去掉控制字符的有界展示文本。 */
function toDisplayText(value: unknown, maximum = MAX_CELL_LENGTH): string {
  /** 数字与布尔保留可读形式，其余统一走字符串。 */
  const raw = value === null || value === undefined
    ? ''
    : typeof value === 'number' || typeof value === 'boolean' ? String(value) : String(value)
  /** 控制字符替换为空格，避免破坏 Pane 布局或注入终端序列。 */
  const sanitized = raw.replace(/[\u0000-\u001f\u007f]/gu, ' ')
  return sanitized.length > maximum ? `${sanitized.slice(0, Math.max(0, maximum - 1))}…` : sanitized
}

/** 把未知数值安全转为有限数字，非数字返回 undefined。 */
function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    /** 字符串数字同样接受，驱动会按列类型返回字符串。 */
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

/** 千分位整数展示。 */
function formatInteger(value: number): string {
  return Math.round(value).toLocaleString('en-US')
}

/** 字节容量展示，固定 1024 进制并保留一位小数。 */
function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '—'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB']
  let size = value
  let unitIndex = 0
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024
    unitIndex += 1
  }
  return `${unitIndex === 0 ? Math.round(size) : size.toFixed(1)} ${units[unitIndex]}`
}

/** 秒级时长展示为「N 天 N 小时」形式。 */
function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—'
  const days = Math.floor(seconds / 86_400)
  const hours = Math.floor((seconds % 86_400) / 3_600)
  const minutes = Math.floor((seconds % 3_600) / 60)
  if (days > 0) return `${days} 天 ${hours} 小时`
  if (hours > 0) return `${hours} 小时 ${minutes} 分`
  return `${minutes} 分 ${Math.floor(seconds % 60)} 秒`
}

/** 构造指标卡并统一裁剪到共享合同允许的范围。 */
function createMetric(
  id: string,
  label: string,
  value: string,
  options: { hint?: string; ratio?: number } = {},
): ServerOpsDataMetric {
  /** 进度条占比只接受 0..1 的有限数字。 */
  const ratio = options.ratio !== undefined && Number.isFinite(options.ratio)
    ? Math.min(1, Math.max(0, options.ratio))
    : undefined
  return {
    id,
    label,
    value: toDisplayText(value, 128),
    ...(options.hint === undefined ? {} : { hint: toDisplayText(options.hint, 200) }),
    ...(ratio === undefined ? {} : { ratio }),
  }
}

/** 构造表格并把行、列裁剪到共享合同允许的范围。 */
function createTable(
  id: string,
  title: string,
  columns: readonly { id: string; label: string; align?: 'left' | 'right' }[],
  rows: readonly (readonly unknown[])[],
  options: { truncated?: boolean; emptyText?: string } = {},
): ServerOpsDataTable {
  /** 列定义先裁剪到上限，避免调用方随意扩张协议。 */
  const limitedColumns = columns.slice(0, MAX_TABLE_COLUMNS)
  /** 行数据按列数补齐或截断；多余行丢弃并标记截断。 */
  const limitedRows = rows.slice(0, MAX_TABLE_ROWS).map((row) => limitedColumns.map((_, index) => toDisplayText(row[index])))
  return {
    id,
    title,
    columns: limitedColumns.map((column) => ({
      id: column.id,
      label: column.label,
      ...(column.align === undefined ? {} : { align: column.align }),
    })),
    rows: limitedRows,
    truncated: options.truncated === true || rows.length > MAX_TABLE_ROWS,
    ...(options.emptyText === undefined ? {} : { emptyText: options.emptyText }),
  }
}

/** 归一化 warning 文本并去重，保证不越过共享合同的长度上限。 */
function createWarnings(values: readonly string[]): string[] {
  /** 去重后的稳定顺序警告列表。 */
  const unique: string[] = []
  for (const value of values) {
    /** 归一化后的单条说明。 */
    const normalized = toDisplayText(value, MAX_WARNING_LENGTH)
    if (normalized && !unique.includes(normalized)) unique.push(normalized)
  }
  return unique.slice(0, 20)
}

/** 读取驱动错误的稳定错误码。 */
function readErrorCode(error: unknown): string {
  if (error && typeof error === 'object') {
    /** 驱动错误对象中的 code/errno 字段。 */
    const record = error as { code?: unknown; errno?: unknown }
    if (typeof record.code === 'string' && record.code.length > 0) return record.code
    if (typeof record.errno === 'number') return `ERRNO_${record.errno}`
  }
  return 'UNKNOWN'
}

/** 读取驱动错误的安全消息；不返回堆栈或连接串。 */
function readErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim() !== '') return toDisplayText(error.message, 200)
  return fallback
}

/** 需要判定为 TLS 校验失败的 Node 与驱动错误码集合。 */
const TLS_ERROR_CODES = new Set([
  'HANDSHAKE_NO_SSL_SUPPORT',
  'HANDSHAKE_SSL_ERROR',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'ERR_SSL_WRONG_VERSION_NUMBER',
  'ERR_SSL_PACKET_LENGTH_TOO_LONG',
])

/** 需要判定为认证失败的驱动错误码集合。 */
const AUTH_ERROR_CODES = new Set([
  'ER_ACCESS_DENIED_ERROR',
  'ER_ACCESS_DENIED_NO_PASSWORD_ERROR',
  'ER_PASSWORD_NO_MATCH',
  'NOAUTH',
  'WRONGPASS',
])

/** 需要判定为权限不足的驱动错误码集合。 */
const PERMISSION_ERROR_CODES = new Set([
  'ER_DBACCESS_DENIED_ERROR',
  'ER_TABLEACCESS_DENIED_ERROR',
  'ER_COLUMNACCESS_DENIED_ERROR',
  'ER_SPECIFIC_ACCESS_DENIED_ERROR',
  'ER_HOST_NOT_PRIVILEGED',
  'NOPERM',
])

/** 需要判定为超时的驱动错误码集合。 */
const TIMEOUT_ERROR_CODES = new Set(['ETIMEDOUT', 'ETIMEOUT', 'PROTOCOL_SEQUENCE_TIMEOUT', 'CONNECT_TIMEOUT', 'ER_QUERY_TIMEOUT', 'ER_STATEMENT_TIMEOUT', 'ER_LOCK_WAIT_TIMEOUT'])

/** 把驱动错误映射为稳定的能力状态与中文说明。 */
export function classifyServerOpsDataError(error: unknown, engine: ServerOpsDataEngine): { capability: ServerOpsDataCapability; message: string } {
  if (error instanceof Error && error.message === 'SERVER_OPS_DATA_QUERY_ENGINE_UNSUPPORTED') {
    return { capability: 'unsupported', message: '当前数据库版本不支持受控查询超时，已停止读取' }
  }
  /** 驱动错误的稳定错误码。 */
  const code = readErrorCode(error)
  if (TLS_ERROR_CODES.has(code)) return { capability: 'tls-failed', message: `TLS 连接失败（${code}）` }
  if (AUTH_ERROR_CODES.has(code)) return { capability: 'auth-failed', message: `认证失败（${code}）` }
  if (PERMISSION_ERROR_CODES.has(code)) return { capability: 'permission-denied', message: `权限不足（${code}）` }
  if (TIMEOUT_ERROR_CODES.has(code)) return { capability: 'timeout', message: `数据库读取或锁等待超时（${code}）` }
  if (code === 'ECONNREFUSED') return { capability: 'unreachable', message: '目标端口拒绝连接' }
  if (code === 'ENOTFOUND' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH') {
    return { capability: 'unreachable', message: `目标地址不可达（${code}）` }
  }
  if (code === 'ER_NOT_SUPPORTED_AUTH_MODE' || code === 'ERR_UNKNOWN_COMMAND' || code === 'ERR unknown command') {
    return { capability: 'unsupported', message: `服务端不支持所需能力（${code}）` }
  }
  return { capability: 'unreachable', message: readErrorMessage(error, `${engine === 'mysql' ? 'MySQL' : 'Redis'} 连接失败（${code}）`) }
}

/** MySQL 状态查询返回的变量名到值的只读映射。 */
export type MySqlStatusMap = Record<string, string>

/** 把 `SHOW GLOBAL STATUS` 行集归一化为变量映射。 */
export function buildMySqlStatusMap(rows: readonly unknown[]): MySqlStatusMap {
  /** 变量名到值的映射，同名重复时保留第一次出现的值。 */
  const map: MySqlStatusMap = {}
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    /** 单行 status 记录；列名由 MySQL 固定返回。 */
    const record = row as Record<string, unknown>
    /** 变量名同时兼容大小写两种列名写法。 */
    const name = typeof record.Variable_name === 'string' ? record.Variable_name
      : typeof record.variable_name === 'string' ? record.variable_name : undefined
    if (!name) continue
    map[name] = record.Value === undefined ? String(record.value ?? '') : String(record.Value)
  }
  return map
}

/** 依据 MySQL 全局状态构造只读指标卡。 */
export function buildMySqlMetrics(status: MySqlStatusMap, maxConnections?: number): ServerOpsDataMetric[] {
  /** Uptime 缺失时无法计算速率与运行时长。 */
  const uptime = toFiniteNumber(status.Uptime)
  /** 已建立连接数。 */
  const threadsConnected = toFiniteNumber(status.Threads_connected)
  /** 正在执行的线程数。 */
  const threadsRunning = toFiniteNumber(status.Threads_running)
  /** 累计查询数。 */
  const questions = toFiniteNumber(status.Questions)
  /** 累计慢查询数。 */
  const slowQueries = toFiniteNumber(status.Slow_queries)
  /** 累计接收字节数。 */
  const bytesReceived = toFiniteNumber(status.Bytes_received)
  /** 累计发送字节数。 */
  const bytesSent = toFiniteNumber(status.Bytes_sent)
  /** 失败连接次数。 */
  const abortedConnects = toFiniteNumber(status.Aborted_connects)
  /** 指标列表按排障优先级排列，缺失项直接跳过而不是显示假值。 */
  const metrics: ServerOpsDataMetric[] = []
  if (threadsConnected !== undefined) {
    metrics.push(createMetric(
      'threads-connected',
      '活跃连接',
      maxConnections === undefined ? formatInteger(threadsConnected) : `${formatInteger(threadsConnected)} / ${formatInteger(maxConnections)}`,
      {
        hint: threadsRunning === undefined ? undefined : `运行中 ${formatInteger(threadsRunning)}`,
        ratio: maxConnections === undefined || maxConnections <= 0 ? undefined : threadsConnected / maxConnections,
      },
    ))
  }
  if (questions !== undefined && uptime !== undefined && uptime > 0) {
    metrics.push(createMetric('query-rate', '查询速率', `${(questions / uptime).toFixed(1)} / 秒`, { hint: '按启动至今累计平均' }))
  }
  if (slowQueries !== undefined) metrics.push(createMetric('slow-queries', '慢查询累计', formatInteger(slowQueries)))
  if (bytesReceived !== undefined && bytesSent !== undefined) {
    metrics.push(createMetric('network-traffic', '网络流量', formatBytes(bytesReceived + bytesSent), {
      hint: `接收 ${formatBytes(bytesReceived)} · 发送 ${formatBytes(bytesSent)}`,
    }))
  }
  if (uptime !== undefined) metrics.push(createMetric('uptime', '运行时长', formatDuration(uptime)))
  if (abortedConnects !== undefined) metrics.push(createMetric('aborted-connects', '失败连接', formatInteger(abortedConnects)))
  return metrics.slice(0, MAX_DATA_METRICS)
}

/** 依据 MySQL 复制状态行构造复制指标卡。 */
export function buildMySqlReplicationMetric(row: Record<string, unknown> | undefined): ServerOpsDataMetric | undefined {
  if (!row) return undefined
  /** 复制 I/O 线程状态在 8.0.22 前后字段名不同。 */
  const ioRunning = row.Replica_IO_Running ?? row.Slave_IO_Running
  /** 复制 SQL 线程状态在 8.0.22 前后字段名不同。 */
  const sqlRunning = row.Replica_SQL_Running ?? row.Slave_SQL_Running
  /** 复制延迟秒数在 8.0.22 前后字段名不同。 */
  const delay = toFiniteNumber(row.Seconds_Behind_Source ?? row.Seconds_Behind_Master)
  /** 只有确实读到复制状态时才展示该指标。 */
  const healthy = ioRunning === 'Yes' && sqlRunning === 'Yes'
  return createMetric('replication', '复制状态', healthy ? '正常' : '异常', {
    hint: delay === undefined ? `IO ${toDisplayText(ioRunning ?? '未知')} · SQL ${toDisplayText(sqlRunning ?? '未知')}` : `延迟 ${delay} 秒`,
  })
}

/** 把库容量行集转为表格。 */
export function buildMySqlDatabaseTable(rows: readonly unknown[]): ServerOpsDataTable {
  return createTable(
    'databases',
    '数据库',
    [
      { id: 'name', label: '名称' },
      { id: 'tables', label: '表', align: 'right' },
      { id: 'size', label: '容量', align: 'right' },
    ],
    rows.map((row) => {
      /** 单行库容量记录。 */
      const record = (row ?? {}) as Record<string, unknown>
      /** 库容量字节数。 */
      const sizeBytes = toFiniteNumber(record.size_bytes)
      return [record.schema_name, record.table_count, sizeBytes === undefined ? '—' : formatBytes(sizeBytes)]
    }),
    { truncated: rows.length > 50, emptyText: '没有可见的数据库' },
  )
}

/** 把会话行集转为表格。 */
export function buildMySqlProcessTable(rows: readonly unknown[]): ServerOpsDataTable {
  return createTable(
    'processes',
    '会话',
    [
      { id: 'id', label: 'ID', align: 'right' },
      { id: 'user', label: '用户' },
      { id: 'host', label: '来源' },
      { id: 'db', label: '库' },
      { id: 'command', label: '命令' },
      { id: 'time', label: '秒', align: 'right' },
      { id: 'state', label: '状态' },
    ],
    rows.map((row) => {
      /** 单行会话记录。 */
      const record = (row ?? {}) as Record<string, unknown>
      return [record.id, record.user, record.host, record.db, record.command, record.time, record.state]
    }),
    { truncated: rows.length > 50, emptyText: '当前没有可见会话' },
  )
}

/** 把慢语句摘要行集转为表格。 */
export function buildMySqlStatementTable(rows: readonly unknown[]): ServerOpsDataTable {
  return createTable(
    'statements',
    '慢语句',
    [
      { id: 'database', label: '数据库' },
      { id: 'digest', label: '语句模板' },
      { id: 'count', label: '执行次数', align: 'right' },
      { id: 'avg', label: '平均耗时', align: 'right' },
      { id: 'rows', label: '平均扫描行', align: 'right' },
    ],
    rows.map((row) => {
      /** 单行语句摘要记录。 */
      const record = (row ?? {}) as Record<string, unknown>
      /** 平均耗时毫秒数。 */
      const averageMs = toFiniteNumber(record.avg_ms)
      return [record.schema_name === null || record.schema_name === undefined ? '未归属' : record.schema_name,
        record.digest_text, record.exec_count, averageMs === undefined ? '—' : `${averageMs} ms`, record.avg_rows]
    }),
    { truncated: rows.length > 20, emptyText: 'performance_schema 没有可用的语句摘要' },
  )
}

/** 解析 Redis INFO 文本为「键 → 值」映射；忽略注释与空行。 */
export function parseRedisInfo(text: string): Record<string, string> {
  /** 归一化后的 INFO 键值映射。 */
  const map: Record<string, string> = {}
  for (const rawLine of text.split('\n')) {
    /** 去掉行尾回车后跳过分区标题与空行。 */
    const line = rawLine.replace(/\r$/u, '')
    if (line === '' || line.startsWith('#')) continue
    /** 冒号分隔的键值对。 */
    const separator = line.indexOf(':')
    if (separator <= 0) continue
    map[line.slice(0, separator)] = line.slice(separator + 1)
  }
  return map
}

/** 依据 Redis INFO 构造只读指标卡。 */
export function buildRedisMetrics(info: Record<string, string>): ServerOpsDataMetric[] {
  /** 已用内存字节数。 */
  const usedMemory = toFiniteNumber(info.used_memory)
  /** 配置的最大内存字节数；0 表示未限制。 */
  const maxMemory = toFiniteNumber(info.maxmemory)
  /** 已连接客户端数。 */
  const connectedClients = toFiniteNumber(info.connected_clients)
  /** 每秒操作数。 */
  const opsPerSecond = toFiniteNumber(info.instantaneous_ops_per_sec)
  /** 命中次数。 */
  const hits = toFiniteNumber(info.keyspace_hits)
  /** 未命中次数。 */
  const misses = toFiniteNumber(info.keyspace_misses)
  /** 运行秒数。 */
  const uptime = toFiniteNumber(info.uptime_in_seconds)
  /** 内存碎片率。 */
  const fragmentation = toFiniteNumber(info.mem_fragmentation_ratio)
  /** 已淘汰键数量。 */
  const evictedKeys = toFiniteNumber(info.evicted_keys)
  /** 指标列表按排障优先级排列。 */
  const metrics: ServerOpsDataMetric[] = []
  if (usedMemory !== undefined) {
    metrics.push(createMetric(
      'used-memory',
      '已用内存',
      maxMemory !== undefined && maxMemory > 0 ? `${formatBytes(usedMemory)} / ${formatBytes(maxMemory)}` : formatBytes(usedMemory),
      {
        hint: maxMemory !== undefined && maxMemory > 0 ? `上限使用率 ${((usedMemory / maxMemory) * 100).toFixed(1)}%` : '未配置 maxmemory',
        ratio: maxMemory !== undefined && maxMemory > 0 ? usedMemory / maxMemory : undefined,
      },
    ))
  }
  if (connectedClients !== undefined) metrics.push(createMetric('connected-clients', '客户端连接', formatInteger(connectedClients)))
  if (opsPerSecond !== undefined) metrics.push(createMetric('ops-rate', '每秒操作', formatInteger(opsPerSecond)))
  if (hits !== undefined && misses !== undefined && hits + misses > 0) {
    metrics.push(createMetric('hit-rate', '命中率', `${((hits / (hits + misses)) * 100).toFixed(1)}%`, {
      hint: `命中 ${formatInteger(hits)} · 未命中 ${formatInteger(misses)}`,
      ratio: hits / (hits + misses),
    }))
  }
  if (uptime !== undefined) metrics.push(createMetric('uptime', '运行时长', formatDuration(uptime)))
  if (fragmentation !== undefined) metrics.push(createMetric('fragmentation', '内存碎片率', fragmentation.toFixed(2)))
  if (evictedKeys !== undefined) metrics.push(createMetric('evicted-keys', '已淘汰键', formatInteger(evictedKeys)))
  /** 复制角色与延迟来自同一分区。 */
  const replicationMetric = buildRedisReplicationMetric(info)
  if (replicationMetric) metrics.push(replicationMetric)
  return metrics.slice(0, MAX_DATA_METRICS)
}

/** 依据复制分区构造角色与延迟指标。 */
export function buildRedisReplicationMetric(info: Record<string, string>): ServerOpsDataMetric | undefined {
  /** 当前实例的复制角色。 */
  const role = info.role
  if (role === undefined) return undefined
  if (role === 'master') {
    /** 已连接从库数量。 */
    const slaves = toFiniteNumber(info.connected_slaves)
    return createMetric('replication', '复制角色', '主节点', { hint: slaves === undefined ? undefined : `从库 ${slaves} 个` })
  }
  /** 主从链路状态。 */
  const linkStatus = info.master_link_status
  /** 距离主节点最后交互秒数，仅 Redis 7 提供。 */
  const lastIoSeconds = toFiniteNumber(info.master_last_io_seconds_ago)
  /** 主节点当前复制偏移，用于判断主从进度差异。 */
  const offset = toFiniteNumber(info.master_repl_offset)
  return createMetric('replication', '复制角色', '从节点', {
    hint: [
      linkStatus === undefined ? undefined : `链路 ${linkStatus === 'up' ? '正常' : '断开'}`,
      lastIoSeconds === undefined ? undefined : `${lastIoSeconds} 秒未同步`,
      offset === undefined ? undefined : `主节点偏移 ${formatInteger(offset)}`,
    ].filter((entry): entry is string => entry !== undefined).join(' · '),
  })
}

/** 把 INFO 的 keyspace 分区转为表格。 */
export function buildRedisKeyspaceTable(info: Record<string, string>): ServerOpsDataTable {
  /** 以 db 开头的键即为逻辑库。 */
  const entries = Object.keys(info).filter((key) => /^db\d+$/u.test(key)).sort()
  return createTable(
    'keyspaces',
    'Keyspace',
    [
      { id: 'database', label: '逻辑库' },
      { id: 'keys', label: '键数', align: 'right' },
      { id: 'expires', label: '含过期', align: 'right' },
      { id: 'ttl', label: '平均 TTL', align: 'right' },
    ],
    entries.map((key) => {
      /** 单个逻辑库的 `keys=..,expires=..,avg_ttl=..` 描述。 */
      const fields: Record<string, string> = {}
      for (const part of (info[key] ?? '').split(',')) {
        /** 单个 `name=value` 片段。 */
        const [name, value] = part.split('=')
        if (name && value !== undefined) fields[name.trim()] = value.trim()
      }
      /** 平均 TTL 毫秒数。 */
      const averageTtl = toFiniteNumber(fields.avg_ttl)
      return [key, fields.keys, fields.expires, averageTtl === undefined ? undefined : formatDuration(averageTtl / 1000)]
    }),
    { emptyText: '当前没有非空逻辑库' },
  )
}

/** 把 SLOWLOG GET 结果转为表格；命令参数按有界前缀展示。 */
export function buildRedisSlowlogTable(entries: readonly unknown[]): ServerOpsDataTable {
  return createTable(
    'slowlog',
    '慢日志',
    [
      { id: 'id', label: 'ID', align: 'right' },
      { id: 'time', label: '时间' },
      { id: 'duration', label: '耗时', align: 'right' },
      { id: 'command', label: '命令' },
      { id: 'client', label: '来源' },
    ],
    entries.map((entry) => {
      if (!Array.isArray(entry)) return ['', '', '', '', '']
      /** 慢日志条目固定以 id、时间戳、耗时微秒、命令数组开头。 */
      const [id, timestamp, durationMicros, command] = entry
      /** 时间戳秒数。 */
      const timestampSeconds = toFiniteNumber(timestamp)
      /** 耗时微秒数。 */
      const durationValue = toFiniteNumber(durationMicros)
      /** 命令数组中的命令名与参数。 */
      const commandParts = Array.isArray(command) ? command.map((part) => toDisplayText(part, 64)) : []
      return [
        id,
        timestampSeconds === undefined ? '—' : new Date(timestampSeconds * 1_000).toISOString().slice(0, 19).replace('T', ' '),
        durationValue === undefined ? '—' : `${(durationValue / 1_000).toFixed(2)} ms`,
        commandParts.join(' ').slice(0, REDIS_SLOWLOG_COMMAND_LENGTH),
        entry[4] === undefined ? '' : toDisplayText(entry[4], 64),
      ]
    }),
    { truncated: entries.length > REDIS_SLOWLOG_LIMIT, emptyText: '最近没有慢命令' },
  )
}

/** MySQL 适配器依赖，便于单测替换驱动。 */
export interface ServerOpsMySqlAdapterDependencies {
  /** 建立隧道通道。 */
  createChannel: ServerOpsDataChannelFactory
  /** 单次查询超时毫秒数。 */
  timeoutMs: number
  /** 查询取消信号；触发后驱动连接与 transport 同步释放。 */
  signal?: AbortSignal
}

/**
 * 解析 MySQL 握手默认库：探测验证完整配置，SQL 查询绑定已授权库，其余实例级读取不绑定。
 *
 * @param input 数据读取模式与可选数据库
 * @returns 应传给 mysql2 的握手默认库；实例级读取返回 undefined
 */
export function resolveServerOpsMySqlHandshakeDatabase(
  input: Pick<ServerOpsDataRuntimeInputBase, 'database'> & { mode: ServerOpsDataRuntimeInput['mode'] },
): string | undefined {
  return (input.mode === 'probe' || input.mode === 'sql-query') ? input.database : undefined
}

/** MySQL 单次只读诊断的查询结果集合。 */
interface MySqlReadResults {
  version: string
  status: MySqlStatusMap
  maxConnections?: number
  databases?: readonly unknown[]
  processes?: readonly unknown[]
  statements?: readonly unknown[]
  replicationRow?: Record<string, unknown>
  warnings: string[]
}

/** 执行一条可失败的只读读取；失败时返回 undefined 并追加 warning。 */
async function runOptionalRead<T>(
  query: () => Promise<T>,
  warnings: string[],
  warningText: string,
): Promise<T | undefined> {
  try {
    return await query()
  } catch {
    warnings.push(warningText)
    return undefined
  }
}

/**
 * 等待 MySQL 完成认证；取消会立即结算，避免 destroy 后驱动不再发 connect/error 导致悬挂。
 * @param connection 本次尝试独占的底层连接
 * @param signal 共享总时限与用户撤销信号
 * @returns 认证完成；失败或取消时拒绝
 */
async function waitForMySqlConnection(connection: MySqlConnection, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    /** 移除握手阶段监听，后续查询由 promise 驱动处理错误。 */
    const cleanup = (): void => {
      signal?.removeEventListener('abort', onAbort)
      connection.removeListener('connect', onConnect)
      connection.removeListener('error', onError)
    }
    /** 连接成功时解除仅用于握手的监听。 */
    const onConnect = (): void => { cleanup(); resolve() }
    /** 握手失败保留原始驱动错误码，用于判定是否允许 preferred 回退。 */
    const onError = (error: Error): void => { cleanup(); reject(error) }
    /** 先结算再销毁，防止同步 close/error 竞争改变取消原因。 */
    const onAbort = (): void => {
      cleanup()
      reject(new Error('SERVER_OPS_DATA_CANCELLED'))
      connection.destroy()
    }
    connection.once('connect', onConnect)
    connection.once('error', onError)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
  })
}

/** 在独占通道上执行 MySQL 读取；preferred 仅在认证前明确无 TLS 时允许一次新通道回退。 */
async function readMySql(
  input: ServerOpsDataRuntimeInput,
  dependencies: ServerOpsMySqlAdapterDependencies,
): Promise<ServerOpsDataRuntimeOutput> {
  /** 当前尝试的底层通道与驱动连接，失败回退前必须同时释放。 */
  let channel: Duplex | undefined
  let connection: MySqlConnection | undefined
  /** 初次连接按配置请求 TLS；只有明确无 TLS 才能把下一次尝试设为明文。 */
  let useTls = input.tlsMode !== 'disabled'
  try {
    for (;;) {
      channel = await dependencies.createChannel()
      if (dependencies.signal?.aborted) throw new Error('SERVER_OPS_DATA_CANCELLED')
      connection = createMysqlConnection({
        host: input.tlsMode === 'verify' ? input.tlsServerName : input.address,
        port: input.port,
        user: input.username,
        password: input.password,
        /** probe 验证完整配置；SQL 绑定已授权库，其余读取不受默认库失效影响。 */
        ...(resolveServerOpsMySqlHandshakeDatabase(input) === undefined
          ? {} : { database: resolveServerOpsMySqlHandshakeDatabase(input) }),
        stream: channel,
        connectTimeout: dependencies.timeoutMs,
        ...(useTls ? { ssl: {
          rejectUnauthorized: input.tlsMode === 'verify',
          verifyIdentity: input.tlsMode === 'verify',
        } } : {}),
      })
      // 取消/销毁后迟到的驱动错误也必须被消费，不能使 utility 进程崩溃。
      connection.on('error', () => undefined)
      try {
        await waitForMySqlConnection(connection, dependencies.signal)
        break
      } catch (error) {
        connection.destroy()
        connection = undefined
        channel.destroy()
        channel = undefined
        if (dependencies.signal?.aborted) throw new Error('SERVER_OPS_DATA_CANCELLED')
        if (input.tlsMode !== 'preferred' || !useTls || readErrorCode(error) !== 'HANDSHAKE_NO_SSL_SUPPORT') throw error
        // 此错误只在 mysql2 检查服务端 capability 且尚未发送认证材料时产生。
        useTls = false
      }
    }
    /** mysql2 在升级 TLS 后把 stream 替换成 TLSSocket，以实际流识别加密状态。 */
    const stream = (connection as unknown as { stream: Duplex & { encrypted?: boolean } }).stream
    if (useTls && stream.encrypted !== true) throw Object.assign(new Error('TLS 未建立'), { code: 'HANDSHAKE_SSL_ERROR' })
    /** verified 只在真实 TLS 流且驱动已完成证书与主机名验证后报告。 */
    const tlsStatus: ServerOpsDataTlsStatus = stream.encrypted === true
      ? input.tlsMode === 'verify' ? 'verified' : 'encrypted'
      : 'plaintext'
    /** 在查询阶段继续响应撤销；循环外执行保证不会因 SQL 错误回退或重放。 */
    const releaseAbortBinding = bindServerOpsSqlQueryAbort(dependencies.signal, () => { connection?.destroy() })
    try {
      /** 仅 probe/diagnostics 合同包含实际 TLS 状态，表浏览与 SQL 维持既有严格合同。 */
      const result = await readMySqlWithConnection(connection.promise(), input, dependencies.signal)
      if ((input.mode === 'probe' || input.mode === 'diagnostics') && 'capability' in result && result.capability === 'available') {
        return { ...result, tlsStatus }
      }
      return result
    } finally {
      releaseAbortBinding()
    }
  } catch (error) {
    if (dependencies.signal?.aborted) throw new Error('SERVER_OPS_DATA_CANCELLED')
    /** 筛选字段无效属于用户输入错误，不能被诊断连接失败分类器吞掉。 */
    if ((input.mode === 'schema-rows' || input.mode === 'schema-cell') && getServerOpsRowFilterPublicError(error) !== null) throw error
    if (input.mode === 'schema-cell') {
      if (getServerOpsSqlQueryPublicError(error) !== undefined) throw error
      const normalized = normalizeServerOpsSqlQueryError(error)
      if (normalized.message === 'SERVER_OPS_DATA_QUERY_TIMEOUT') throw new Error('SERVER_OPS_DATA_CELL_TIMEOUT')
      if (getServerOpsSqlQueryPublicError(normalized) !== undefined) throw normalized
    }
    if (input.baseTablesOnly && getServerOpsSqlQueryPublicError(error)?.code === 'SERVER_OPS_DATA_QUERY_TABLE_UNAVAILABLE') throw error
    if (input.mode === 'sql-query') {
      /** 建连与执行共用公开错误白名单，不向主进程泄露驱动原始详情。 */
      const normalized = normalizeServerOpsSqlQueryError(error)
      if (getServerOpsSqlQueryPublicError(normalized) !== undefined
        || normalized.message === 'SERVER_OPS_DATA_CANCELLED') throw normalized
      throw new Error('SERVER_OPS_DATA_QUERY_FAILED')
    }
    /** 连接失败统一映射为稳定能力状态，不泄露连接串与堆栈。 */
    const classified = classifyServerOpsDataError(error, 'mysql')
    return { capability: classified.capability, metrics: [], tables: [], warnings: createWarnings([classified.message]) }
  } finally {
    connection?.destroy()
    if (channel && !channel.destroyed) channel.destroy()
  }
}

/** 在已连接的 mysql2 连接上执行一次受控读取，便于按协议独立验证查询边界。 */
export function readMySqlWithConnection(
  connection: MySqlReadConnection,
  input: ServerOpsDataRuntimeNonQueryInput,
  signal?: AbortSignal,
): Promise<ServerOpsDataRuntimeNonQueryOutput>
export function readMySqlWithConnection(
  connection: MySqlReadConnection,
  input: ServerOpsDataRuntimeQueryInput,
  signal?: AbortSignal,
): Promise<ServerOpsDataQueryResult>
export function readMySqlWithConnection(
  connection: MySqlReadConnection,
  input: ServerOpsDataRuntimeInput,
  signal?: AbortSignal,
): Promise<ServerOpsDataRuntimeOutput>
export async function readMySqlWithConnection(
  connection: MySqlReadConnection,
  input: ServerOpsDataRuntimeInput,
  signal?: AbortSignal,
): Promise<ServerOpsDataRuntimeOutput> {
  if (input.mode === 'sql-query') {
    if (input.queryId === undefined || input.sql === undefined || input.maxRows === undefined || input.database === undefined) {
      throw new Error('SERVER_OPS_DATA_QUERY_INPUT_INVALID')
    }
    /** mysql2 promise wrapper 内部公开 core connection；仅 core Query 提供不缓存全量结果的逐行事件。 */
    const queryConnection = connection as unknown as {
      query: (statement: unknown, values?: readonly unknown[]) => Promise<unknown>
      destroy?: () => void
      connection?: { query: (statement: unknown) => import('./server-ops-query-runtime').ServerOpsSqlQueryCommand }
    }
    if (typeof queryConnection.destroy !== 'function' || typeof queryConnection.connection?.query !== 'function') {
      throw new Error('SERVER_OPS_DATA_UNEXPECTED_RESULT')
    }
    return executeServerOpsSqlQuery({
      query: (statement, values) => queryConnection.query(statement, values),
      streamQuery: (statement) => queryConnection.connection!.query(statement),
      destroy: () => { queryConnection.destroy!() },
    }, {
      queryId: input.queryId,
      database: input.database,
      sql: input.sql,
      maxRows: input.maxRows,
    }, signal)
  }
  /** 结构目录保持按需读取；行预览先安装与 SQL 相同的服务端保护。 */
  if (input.mode === 'schema-tables' || input.mode === 'schema-table' || input.mode === 'schema-rows' || input.mode === 'schema-cell') {
    if (input.mode === 'schema-rows' || input.mode === 'schema-cell') {
      if (typeof connection.execute !== 'function') throw new Error('SERVER_OPS_DATA_SCHEMA_FILTERS_UNAVAILABLE')
      await configureServerOpsMySqlReadLimits((statement) => connection.query(statement), signal)
      /** 表预览元数据同样含用户标识符，所有行读取统一使用服务端绑定。 */
      const preparedConnection: MySqlReadConnection = {
        query: (sql, values) => connection.execute!(sql, values),
        execute: (sql, values) => connection.execute!(sql, values),
      }
      return readMySqlSchema(preparedConnection, input)
    }
    return readMySqlSchema(connection, input)
  }

  /** 探测与诊断仍读取版本，用于原有连接状态和服务版本展示。 */
  const versionRows = await readRows(connection, MYSQL_VERSION_QUERY, [])
  const version = toDisplayText(versionRows[0]?.version ?? '', 128)
  if (input.mode === 'probe') return { capability: 'available', serverVersion: version, metrics: [], tables: [], warnings: [] }

  /** 省略 section 时保留旧版全量诊断；指定后只执行当前页所需语句。 */
  const section = input.diagnosticSection
  const readsOverview = section === undefined || section === 'overview'
  const readsSessions = section === undefined || section === 'sessions'
  const readsStatements = section === undefined || section === 'statements'
  const readsParameters = section === 'parameters'
  const warnings: string[] = []
  const statusRows = readsOverview ? await runOptionalRead(() => readRows(connection, MYSQL_STATUS_QUERY, []), warnings,
    '无法读取全局状态变量（需要 PROCESS 或等价权限）') : undefined
  const maxConnectionsRows = readsOverview ? await runOptionalRead(() => readRows(connection, MYSQL_MAX_CONNECTIONS_QUERY, []), warnings,
    '无法读取 max_connections') : undefined
  const databaseRows = readsOverview ? await runOptionalRead(() => readRows(connection, MYSQL_DATABASES_QUERY, []), warnings,
    '无法读取 information_schema 库容量') : undefined
  /** 库筛选始终参数绑定，并在 ORDER/LIMIT 之前生效。 */
  const processQuery = `${MYSQL_PROCESSLIST_QUERY}${input.diagnosticDatabase === undefined ? '' : ' WHERE DB = ?'} ORDER BY TIME DESC LIMIT 50`
  const processValues = input.diagnosticDatabase === undefined ? [] : [input.diagnosticDatabase]
  const statementQuery = `${MYSQL_STATEMENTS_QUERY}${input.diagnosticDatabase === undefined ? '' : ' AND SCHEMA_NAME = ?'} ORDER BY AVG_TIMER_WAIT DESC LIMIT 20`
  const statementValues = input.diagnosticDatabase === undefined ? [] : [input.diagnosticDatabase]
  const processRows = readsSessions ? await runOptionalRead(() => readRows(connection, processQuery, processValues), warnings,
    '无法读取连接列表（可能需要 PROCESS 权限）') : undefined
  const statementRows = readsStatements ? await runOptionalRead(() => readRows(connection, statementQuery, statementValues), warnings,
    'performance_schema 未启用或没有读取权限') : undefined
  const replicationRow = readsOverview ? await runOptionalRead(async () => {
    const rows = await readRows(connection, MYSQL_REPLICA_STATUS_QUERY, []).catch(() => readRows(connection, MYSQL_SLAVE_STATUS_QUERY, []))
    return rows[0]
  }, warnings, '当前实例没有可读取的复制状态') : undefined
  const parameterRows = readsParameters ? await runOptionalRead(() => readRows(connection, MYSQL_PARAMETERS_QUERY, []), warnings,
    '无法读取全局参数') : undefined
  const status = buildMySqlStatusMap(statusRows ?? [])
  const maxConnections = toFiniteNumber(maxConnectionsRows?.[0]?.Value ?? maxConnectionsRows?.[0]?.value)
  const results: MySqlReadResults = {
    version, status,
    ...(maxConnections === undefined ? {} : { maxConnections }),
    ...(databaseRows === undefined ? {} : { databases: databaseRows }),
    ...(processRows === undefined ? {} : { processes: processRows }),
    ...(statementRows === undefined ? {} : { statements: statementRows }),
    ...(replicationRow === undefined ? {} : { replicationRow }),
    warnings,
  }
  const metrics = buildMySqlMetrics(results.status, results.maxConnections)
  const replicationMetric = buildMySqlReplicationMetric(results.replicationRow)
  if (replicationMetric) metrics.push(replicationMetric)
  const tables: ServerOpsDataTable[] = []
  if (results.databases) tables.push(buildMySqlDatabaseTable(results.databases))
  if (results.processes) tables.push(buildMySqlProcessTable(results.processes))
  if (results.statements) tables.push(buildMySqlStatementTable(results.statements))
  const parameterResult = buildMySqlParameters(parameterRows ?? [])
  return {
    capability: 'available', serverVersion: version,
    metrics: metrics.slice(0, MAX_DATA_METRICS), tables: tables.slice(0, MAX_DATA_TABLES),
    ...(readsParameters ? { parameters: parameterResult.parameters, parametersTruncated: parameterResult.truncated } : {}),
    warnings: createWarnings(results.warnings),
  }
}

/** 把 SHOW GLOBAL VARIABLES 行集裁剪为有界参数列表。 */
function buildMySqlParameters(rows: readonly Record<string, unknown>[]): { parameters: ServerOpsDataParameter[]; truncated: boolean } {
  const parameters: ServerOpsDataParameter[] = []
  let bytes = 2
  let truncated = rows.length > MAX_PARAMETER_ROWS
  for (const row of rows.slice(0, MAX_PARAMETER_ROWS)) {
    const name = toDisplayText(row.Variable_name ?? row.variable_name, 128)
    if (name.length === 0) continue
    const rawValue = toDisplayText(row.Value ?? row.value ?? '', MAX_PARAMETER_VALUE_LENGTH)
    const entry: ServerOpsDataParameter = { name, value: rawValue, scope: 'global' }
    const entryBytes = Buffer.byteLength(JSON.stringify(entry), 'utf8') + (parameters.length === 0 ? 0 : 1)
    if (bytes + entryBytes > MAX_PARAMETER_RESULT_BYTES) {
      truncated = true
      break
    }
    parameters.push(entry)
    bytes += entryBytes
    const original = String(row.Value ?? row.value ?? '')
    if (original.length > MAX_PARAMETER_VALUE_LENGTH) truncated = true
  }
  return { parameters, truncated }
}

/** 表浏览：库清单（只列库名，供界面选择器使用）。 */
const MYSQL_SCHEMA_DATABASES_QUERY = 'SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME LIMIT 201'
/** 表浏览：独立验证目标库是否真实可见，不能用已截断目录推断权限。 */
const MYSQL_SCHEMA_DATABASE_EXISTS_QUERY = 'SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ? LIMIT 1'
/** 表浏览：单库表清单；行数与容量来自 information_schema 的估算。 */
const MYSQL_SCHEMA_TABLES_QUERY = 'SELECT TABLE_NAME AS name, TABLE_TYPE AS table_type, ENGINE AS engine, TABLE_ROWS AS rows_estimate, '
  + '(DATA_LENGTH + INDEX_LENGTH) AS size_bytes, COALESCE(UPDATE_TIME, CREATE_TIME) AS updated_at, TABLE_COMMENT AS comment '
  + 'FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME LIMIT 501'
/** LIKE 使用固定 ! 转义符；所有搜索文本作为绑定参数，百分号与下划线按字面匹配。 */
const MYSQL_SCHEMA_TABLE_SEARCH_QUERY = MYSQL_SCHEMA_TABLES_QUERY.replace(' ORDER BY TABLE_NAME', " AND TABLE_NAME LIKE ? ESCAPE '!' ORDER BY TABLE_NAME")
/** 表浏览：表结构列定义。 */
const MYSQL_SCHEMA_COLUMNS_QUERY = 'SELECT COLUMN_NAME AS name, COLUMN_TYPE AS column_type, IS_NULLABLE AS nullable, '
  + 'COLUMN_KEY AS column_key, COLUMN_DEFAULT AS default_text, EXTRA AS extra, COLUMN_COMMENT AS comment '
  + 'FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION LIMIT 256'
/** 表浏览：索引定义；按索引名与序号聚合。 */
const MYSQL_SCHEMA_INDEXES_QUERY = 'SELECT INDEX_NAME AS name, NON_UNIQUE AS non_unique, SEQ_IN_INDEX AS seq, '
  + 'COLUMN_NAME AS column_name FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? '
  + 'ORDER BY INDEX_NAME, SEQ_IN_INDEX LIMIT 1024'
/** 表浏览：白名单校验。只有命中这里返回的表名才允许拼进后续语句。 */
const MYSQL_SCHEMA_TABLE_EXISTS_QUERY = 'SELECT TABLE_NAME AS name, TABLE_TYPE AS table_type FROM information_schema.TABLES '
  + 'WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? LIMIT 1'
/** 行预览一次取得实时表身份、列类型和估算；覆盖 MySQL 4096 列上限，避免隐藏列占满预览窗口。 */
const MYSQL_SCHEMA_PREVIEW_COLUMNS_QUERY = 'SELECT t.TABLE_NAME AS table_name, t.TABLE_TYPE AS table_type, t.TABLE_ROWS AS rows_estimate, '
  + 'c.COLUMN_NAME AS name, c.DATA_TYPE AS data_type, c.EXTRA AS extra, s.SEQ_IN_INDEX AS primary_seq '
  + 'FROM information_schema.TABLES AS t LEFT JOIN information_schema.COLUMNS AS c '
  + 'ON c.TABLE_SCHEMA = t.TABLE_SCHEMA AND c.TABLE_NAME = t.TABLE_NAME '
  + 'LEFT JOIN information_schema.STATISTICS AS s ON s.TABLE_SCHEMA = c.TABLE_SCHEMA AND s.TABLE_NAME = c.TABLE_NAME '
  + "AND s.COLUMN_NAME = c.COLUMN_NAME AND s.INDEX_NAME = 'PRIMARY' "
  + 'WHERE t.TABLE_SCHEMA = ? AND t.TABLE_NAME = ? ORDER BY c.ORDINAL_POSITION LIMIT 4097'

/** 单列预览表达式以及二进制大小的解码方式；名称只来自本次实时元数据。 */
interface MySqlPreviewColumn {
  name: string
  expression: string
  binarySize: boolean
  digestAlias?: string
  normalizedTextExpression?: string
}

/** 可在数据库端安全截取前缀的文本类型；复杂 JSON、空间类型和数值保留驱动原有语义。 */
const MYSQL_PREVIEW_TEXT_TYPES = new Set(['char', 'varchar', 'tinytext', 'text', 'mediumtext', 'longtext', 'enum', 'set', 'json'])
/** 这些类型在 mysql2 中原本返回 Buffer；预览只需要大小，不传输完整内容。 */
const MYSQL_PREVIEW_BINARY_TYPES = new Set(['binary', 'varbinary', 'tinyblob', 'blob', 'mediumblob', 'longblob'])

/** 根据实时列类型生成有界预览；入参为列元数据，返回前 64 个可见列的安全表达式。 */
function buildMySqlPreviewColumns(rows: readonly Record<string, unknown>[]): MySqlPreviewColumn[] {
  const visibleRows = rows.filter((row) => typeof row.name === 'string' && !/\bINVISIBLE\b/iu.test(String(row.extra ?? ''))).slice(0, 64)
  const occupiedNames = new Set(visibleRows.map((row) => row.name as string))
  return visibleRows.map((row, index) => {
    /** 标识符保持原名，只做 MySQL 反引号转义，不把元数据内容当 SQL。 */
    const name = row.name as string
    const identifier = quoteMySqlIdentifier(name)
    const dataType = String(row.data_type ?? '').toLowerCase()
    const binarySize = MYSQL_PREVIEW_BINARY_TYPES.has(dataType)
    const sensitive = isServerOpsSqlSensitiveColumn(name)
    /** 所有摘要与全文统一转成 utf8mb4，保证数据库摘要与 main 对 JS 字符串计算的 UTF-8 摘要一致。 */
    const normalizedTextExpression = MYSQL_PREVIEW_TEXT_TYPES.has(dataType)
      ? `CONVERT(${identifier} USING utf8mb4)` : undefined
    /** 摘要别名不能碰撞真实列名，否则 mysql2 的对象行会覆盖其中一个值。 */
    let digestAlias = `__proma_cell_sha256_${index}`
    while (occupiedNames.has(digestAlias)) digestAlias = `_${digestAlias}`
    occupiedNames.add(digestAlias)
    /** 257 个数据库字符足以判断 256 UTF-16 单元是否截断；最终仍沿用客户端文本归一化。 */
    const expression = sensitive ? "'***'"
      : binarySize ? `OCTET_LENGTH(${identifier})`
      : normalizedTextExpression === undefined ? identifier : `LEFT(${normalizedTextExpression}, 257)`
    const digestExpression = !sensitive && normalizedTextExpression !== undefined
      ? `, CASE WHEN ${identifier} IS NOT NULL AND (OCTET_LENGTH(${normalizedTextExpression}) > 256 OR ${normalizedTextExpression} REGEXP '[[:cntrl:]]')`
        + ` THEN LOWER(SHA2(CAST(${normalizedTextExpression} AS BINARY), 256)) END AS ${quoteMySqlIdentifier(digestAlias)}`
      : ''
    return { name, expression: `${expression} AS ${identifier}${digestExpression}`, binarySize: binarySize && !sensitive,
      ...(digestExpression === '' ? {} : { digestAlias }), ...(normalizedTextExpression === undefined ? {} : { normalizedTextExpression }) }
  })
}

/** 还原预览字段的公开类型；二进制仅接收大小，NULL 与零字节严格区分。 */
function formatMySqlPreviewCell(value: unknown, column: MySqlPreviewColumn, digest: unknown): ServerOpsDataSchemaCell {
  if (column.digestAlias !== undefined && typeof value === 'string') {
    const sanitized = value.replace(/[\u0000-\u001f\u007f]/gu, ' ')
    if ((sanitized !== value || sanitized.length > 256)
      && (typeof digest !== 'string' || !/^[a-f0-9]{64}$/u.test(digest))) {
      throw new Error('SERVER_OPS_DATA_UNEXPECTED_RESULT')
    }
  }
  if (!column.binarySize || value === null || value === undefined) return formatMySqlCell(value, digest)
  /** MySQL OCTET_LENGTH 返回可安全表示的非负整数，拒绝异常驱动结果。 */
  const bytes = toFiniteNumber(value)
  if (bytes === undefined || !Number.isSafeInteger(bytes) || bytes < 0) throw new Error('SERVER_OPS_DATA_UNEXPECTED_RESULT')
  return { kind: 'binary', bytes }
}

/**
 * 执行表浏览读取。
 *
 * 安全边界：库名与表名**先经 information_schema 白名单命中**，命中后仍按 MySQL 规则
 * 转义反引号再拼进语句；没有命中就返回 `unsupported` 而不是把任意标识符送进 SQL。
 *
 * @param connection 已完成认证的 MySQL 连接
 * @param input 表浏览请求
 * @returns 结构化的表浏览结果
 */
async function readMySqlSchema(
  connection: MySqlReadConnection,
  input: ServerOpsDataRuntimeInput,
): Promise<ServerOpsDataRuntimeOutput> {
  const schemaDatabase = input.schemaDatabase
  if (input.mode === 'schema-tables') {
    const databaseRows = await readRows(connection, MYSQL_SCHEMA_DATABASES_QUERY, [])
    const databasesTruncated = databaseRows.length > 200
    let databases = databaseRows.slice(0, 200)
      .map((row) => toDisplayText(row.name, 64))
      .filter((name) => name.length > 0)
    /** 没有目标库时只返回目录，绝不擅自选择第一个库。 */
    if (schemaDatabase === undefined) {
      return {
        mode: 'schema-tables', capability: 'available', databases, tables: [],
        ...(databasesTruncated ? { databasesTruncated: true } : {}),
        warnings: [],
      }
    }
    /** 精确查询与截断目录独立，返回行也必须与请求库同名，避免污染夹具或驱动结果伪装可见。 */
    const visibleRows = await readRows(connection, MYSQL_SCHEMA_DATABASE_EXISTS_QUERY, [schemaDatabase])
    const databaseVisible = visibleRows.some((row) => toDisplayText(row.name, 64) === schemaDatabase)
    if (!databaseVisible) {
      return {
        mode: 'schema-tables', capability: 'available', databases, tables: [],
        ...(databasesTruncated ? { databasesTruncated: true } : {}),
        warnings: createWarnings([`库 ${schemaDatabase} 不存在或当前账号不可见`]),
      }
    }
    /** 被验证目标在目录窗口之外时，为 Select 保留 199 个目录项并把目标放入公开结果。 */
    if (!databases.includes(schemaDatabase)) {
      databases = databases.length >= 200
        ? [...databases.slice(0, 199), schemaDatabase]
        : [...databases, schemaDatabase]
    }
    const search = input.schemaTableSearch
    const tableRows = await readRows(connection, search === undefined ? MYSQL_SCHEMA_TABLES_QUERY : MYSQL_SCHEMA_TABLE_SEARCH_QUERY,
      search === undefined ? [schemaDatabase] : [schemaDatabase, `%${search.replace(/[!%_]/gu, (character) => `!${character}`)}%`])
    const tablesTruncated = tableRows.length > 500
    const tables: ServerOpsDataSchemaTableSummary[] = tableRows.slice(0, 500).map((row) => {
      /** 行数估算可能是字符串（大表），统一转成有界数字。 */
      const rows = toFiniteNumber(row.rows_estimate)
      const sizeBytes = toFiniteNumber(row.size_bytes)
      /** 更新时间来自 DATETIME，转成毫秒时间戳供界面排序/展示。 */
      const updatedAt = toTimestampMs(row.updated_at)
      const engine = toDisplayText(row.engine ?? '', 32)
      const comment = toDisplayText(row.comment ?? '', 256)
      const tableType = toDisplayText(row.table_type, 32).toUpperCase() === 'VIEW' ? 'view' as const : 'table' as const
      return {
        name: toDisplayText(row.name, 128),
        type: tableType,
        ...(engine.length === 0 ? {} : { engine }),
        ...(rows === undefined ? {} : { rows: Math.min(Math.max(0, Math.trunc(rows)), Number.MAX_SAFE_INTEGER) }),
        ...(sizeBytes === undefined ? {} : { sizeBytes: Math.min(Math.max(0, Math.trunc(sizeBytes)), Number.MAX_SAFE_INTEGER) }),
        ...(updatedAt === undefined ? {} : { updatedAt }),
        ...(comment.length === 0 ? {} : { comment }),
      }
    }).filter((table) => table.name.length > 0)
    return {
      mode: 'schema-tables',
      capability: 'available',
      database: schemaDatabase,
      databases,
      tables,
      ...(databasesTruncated ? { databasesTruncated: true } : {}),
      ...(tablesTruncated ? { tablesTruncated: true } : {}),
      warnings: [],
    }
  }

  if (schemaDatabase === undefined) {
    if (input.mode === 'schema-cell') throw new Error('SERVER_OPS_DATA_CELL_CHANGED')
    return input.mode === 'schema-rows'
      ? { mode: 'schema-rows', capability: 'unsupported', columns: [], rows: [], offset: input.rowOffset ?? 0,
          limit: input.rowLimit ?? 50, truncated: false, warnings: createWarnings(['缺少目标库']) }
      : { mode: 'schema-table', capability: 'unsupported', columns: [], indexes: [], warnings: createWarnings(['缺少目标库']) }
  }

  /** 表名同样先经白名单校验，未命中直接返回可读原因。 */
  const schemaTable = input.schemaTable
  if (schemaTable === undefined) {
    if (input.mode === 'schema-cell') throw new Error('SERVER_OPS_DATA_CELL_CHANGED')
    return { mode: 'schema-table', capability: 'unsupported', columns: [], indexes: [], warnings: createWarnings(['缺少目标表']) }
  }
  /** 行读取复用本次元数据里的表白名单、列类型与估算，不缓存授权事实。 */
  const readsRows = input.mode === 'schema-rows' || input.mode === 'schema-cell'
  const existsRows = await readRows(connection, readsRows ? MYSQL_SCHEMA_PREVIEW_COLUMNS_QUERY : MYSQL_SCHEMA_TABLE_EXISTS_QUERY, [schemaDatabase, schemaTable])
  if (existsRows.length === 0 || readsRows && !existsRows.every((row) => row.table_name === schemaTable)) {
    if (input.mode === 'schema-cell') throw new Error('SERVER_OPS_DATA_CELL_CHANGED')
    /** 白名单未命中：按当前模式返回对应的空结果，界面据此提示"表不存在或不可见"。 */
    const warnings = createWarnings([`表 ${schemaDatabase}.${schemaTable} 不存在或当前账号不可见`])
    if (input.mode === 'schema-rows') {
      return {
        mode: 'schema-rows',
        capability: 'unsupported',
        columns: [],
        rows: [],
        offset: input.rowOffset ?? 0,
        limit: input.rowLimit ?? 50,
        truncated: false,
        warnings,
      }
    }
    return { mode: 'schema-table', capability: 'unsupported', columns: [], indexes: [], warnings }
  }
  /** 视图可能引用禁用表；Agent 的结构和预览仅在实时元数据确认物理表后继续。 */
  if (input.baseTablesOnly && !existsRows.every((row) => row.table_type === 'BASE TABLE')) {
    throw new Error('SERVER_OPS_DATA_QUERY_TABLE_UNAVAILABLE')
  }

  if (input.mode === 'schema-table') {
    const columnRows = await readRows(connection, MYSQL_SCHEMA_COLUMNS_QUERY, [schemaDatabase, schemaTable])
    const indexRows = await readRows(connection, MYSQL_SCHEMA_INDEXES_QUERY, [schemaDatabase, schemaTable])
    const columns: ServerOpsDataSchemaColumn[] = columnRows.map((row) => {
      const hasDefaultText = row.default_text !== null && row.default_text !== undefined
      const defaultText = hasDefaultText ? toDisplayText(row.default_text, 256) : undefined
      const extra = toDisplayText(row.extra ?? '', 64)
      const comment = toDisplayText(row.comment ?? '', 256)
      return {
        name: toDisplayText(row.name, 128),
        type: toDisplayText(row.column_type, 128),
        nullable: toDisplayText(row.nullable, 8).toUpperCase() === 'YES',
        primaryKey: toDisplayText(row.column_key, 8).toUpperCase() === 'PRI',
        ...(defaultText === undefined ? {} : { defaultText }),
        ...(extra.length === 0 ? {} : { extra }),
        ...(comment.length === 0 ? {} : { comment }),
      }
    }).filter((column) => column.name.length > 0)
    const indexes = buildMySqlIndexes(indexRows)
    return {
      mode: 'schema-table',
      capability: 'available',
      columns,
      indexes,
      warnings: [],
    }
  }

  /** 显式选择可见列，保持 SELECT * 的隐藏列语义；无法取得列元数据时不得退回无界读取。 */
  const previewColumns = buildMySqlPreviewColumns(existsRows)
  if (previewColumns.length === 0 || existsRows.length > 4096) throw new Error('SERVER_OPS_DATA_UNEXPECTED_RESULT')
  /** 元数据未截断，主键可安全复用同一次查询；排序顺序不能用列的物理位置替代。 */
  const primaryColumns = existsRows.filter((row) => toFiniteNumber(row.primary_seq) !== undefined)
    .sort((left, right) => Number(left.primary_seq) - Number(right.primary_seq))
  const orderedByPrimaryKey = primaryColumns.length > 0 && primaryColumns.length <= 16
    && primaryColumns.every((row, index) => typeof row.name === 'string' && Number(row.primary_seq) === index + 1)
  const offset = input.rowOffset ?? 0
  const limit = input.rowLimit ?? 50
  const orderClause = orderedByPrimaryKey
    ? ` ORDER BY ${primaryColumns.map((column) => quoteMySqlIdentifier(column.name as string)).join(', ')}` : ''
  /** 筛选复用同次实时列元数据；字段范围与结构面板的前 256 列一致。 */
  const filterSql = input.rowFilters === undefined ? { clause: '', values: [] }
    : buildServerOpsRowFilterSql(
      input.rowFilters,
      existsRows.slice(0, 256)
        .map((row) => row.name).filter((name): name is string => typeof name === 'string'),
      'mysql',
    )
  if (input.mode === 'schema-cell') {
    const columnIndex = input.cellColumnIndex
    const expectedColumn = input.cellExpectedColumn
    const expectedSha256 = input.cellSha256
    const column = columnIndex === undefined ? undefined : previewColumns[columnIndex]
    if (!column || column.name !== expectedColumn || expectedSha256 === undefined) throw new Error('SERVER_OPS_DATA_CELL_CHANGED')
    if (isServerOpsSqlSensitiveColumn(column.name)) throw new Error('SERVER_OPS_DATA_CELL_REDACTED')
    if (column.binarySize) throw new Error('SERVER_OPS_DATA_CELL_CHANGED')
    const rowOffset = input.rowOffset
    if (!Number.isSafeInteger(rowOffset) || rowOffset === undefined || rowOffset < 0 || rowOffset > 1_000_199) {
      throw new Error('SERVER_OPS_DATA_CELL_CHANGED')
    }
    if (typeof connection.execute !== 'function') throw new Error('SERVER_OPS_DATA_SCHEMA_FILTERS_UNAVAILABLE')
    const identifier = quoteMySqlIdentifier(column.name)
    const valueExpression = column.normalizedTextExpression ?? identifier
    /** 值本身在服务器端按字节上限裁决，超限时只返回长度与摘要，不把大字段传进 utility。 */
    const cellSql = `SELECT CASE WHEN OCTET_LENGTH(${valueExpression}) <= ${MAX_SERVER_OPS_CELL_BYTES} THEN ${valueExpression} END AS value, `
      + `OCTET_LENGTH(${valueExpression}) AS value_bytes, `
      + `${column.normalizedTextExpression === undefined ? 'NULL' : `LOWER(SHA2(CAST(${valueExpression} AS BINARY), 256))`} AS value_sha256 `
      + `FROM ${quoteMySqlIdentifier(schemaDatabase)}.${quoteMySqlIdentifier(schemaTable)}` + filterSql.clause + orderClause
      + ` LIMIT 1 OFFSET ${rowOffset}`
    const cellRows = await readRows(connection, cellSql, filterSql.values)
    if (cellRows.length !== 1) throw new Error('SERVER_OPS_DATA_CELL_CHANGED')
    const valueBytes = toFiniteNumber(cellRows[0]?.value_bytes)
    if (valueBytes !== undefined && valueBytes > MAX_SERVER_OPS_CELL_BYTES) throw new Error('SERVER_OPS_DATA_CELL_TOO_LARGE')
    const value = cellRows[0]?.value
    if (value === null || value === undefined) throw new Error('SERVER_OPS_DATA_CELL_CHANGED')
    const formatted = column.normalizedTextExpression === undefined ? formatMySqlCell(value) : value
    if (typeof formatted !== 'string') throw new Error('SERVER_OPS_DATA_CELL_CHANGED')
    if (Buffer.byteLength(formatted, 'utf8') > MAX_SERVER_OPS_CELL_BYTES) throw new Error('SERVER_OPS_DATA_CELL_TOO_LARGE')
    const actualSha256 = column.normalizedTextExpression === undefined
      ? createHash('sha256').update(formatted, 'utf8').digest('hex') : cellRows[0]?.value_sha256
    if (actualSha256 !== expectedSha256) throw new Error('SERVER_OPS_DATA_CELL_CHANGED')
    return { mode: 'schema-cell', capability: 'available', value: formatted, warnings: [] }
  }
  /** 所有行读取通过服务端 prepared execute；分页数字先独立校验再写入固定 SQL。 */
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000
    || !Number.isSafeInteger(limit) || limit < 1 || limit > 200 || offset % limit !== 0) {
    throw new Error('SERVER_OPS_DATA_SCHEMA_FILTERS_INVALID')
  }
  if (typeof connection.execute !== 'function') {
    throw new Error('SERVER_OPS_DATA_SCHEMA_FILTERS_UNAVAILABLE')
  }
  /** mysql2 execute 绑定所有用户值；LIMIT/OFFSET 只采用上方已校验的安全整数。 */
  const rowSql = `SELECT ${previewColumns.map((column) => column.expression).join(', ')} FROM ${quoteMySqlIdentifier(schemaDatabase)}.${quoteMySqlIdentifier(schemaTable)}`
    + filterSql.clause + orderClause
    + ` LIMIT ${limit + 1} OFFSET ${offset}`
  const rowsQuery = await readQueryResult(
    connection,
    rowSql,
    filterSql.values,
    'execute',
  )
  /** 空表也保留列头；核对字段顺序，避免异常结果与本次列类型错配。 */
  const columnNames = previewColumns.map((column) => toDisplayText(column.name, 128))
  const returnedFieldNames = new Set(rowsQuery.fields.map((field) => field.name))
  if (columnNames.some((name) => !returnedFieldNames.has(name))) {
    throw new Error('SERVER_OPS_DATA_UNEXPECTED_RESULT')
  }
  const columnTruncated = existsRows.filter((row) => typeof row.name === 'string' && !/\bINVISIBLE\b/iu.test(String(row.extra ?? ''))).length > columnNames.length
  const hasMore = rowsQuery.rows.length > limit
  const normalizedRows = rowsQuery.rows.slice(0, limit)
    .map((row) => previewColumns.map((column) => formatMySqlPreviewCell(row[column.name], column,
      column.digestAlias === undefined ? undefined : row[column.digestAlias])))
  const budgetedRows = fitSchemaRowsToBudget(normalizedRows)
  const cellTruncated = normalizedRows.some((row) => row.some((cell) => typeof cell === 'object' && cell !== null && cell.kind === 'text'))
  /** 同次表元数据已携带估算，避免数据返回后再多发一次查询。 */
  const rawEstimate = input.rowFilters === undefined ? toFiniteNumber(existsRows[0]?.rows_estimate) : undefined
  const totalEstimate = rawEstimate === undefined ? undefined : Math.min(Math.max(0, Math.trunc(rawEstimate)), Number.MAX_SAFE_INTEGER)
  return {
    mode: 'schema-rows',
    capability: 'available',
    columns: columnNames,
    rows: budgetedRows.rows,
    offset,
    limit,
    truncated: columnTruncated || cellTruncated || budgetedRows.truncated,
    hasMore,
    orderedByPrimaryKey,
    ...(totalEstimate === undefined ? {} : { totalEstimate }),
    warnings: columnTruncated ? createWarnings(['表列数超过 64，当前预览只显示前 64 列']) : [],
  }
}

/** mysql2 查询结果中公开读取所需的行与字段名。 */
interface MySqlQueryResult {
  rows: Record<string, unknown>[]
  fields: Array<{ name: string }>
}

/** 读取查询行集与 fields；空表也必须保留列头。 */
async function readQueryResult(
  connection: MySqlReadConnection,
  sql: string,
  values: (string | number)[],
  method: 'query' | 'execute' = 'query',
): Promise<MySqlQueryResult> {
  /** 表预览统一使用服务端参数绑定；调用方须确认 execute 可用，不能降级为客户端插值。 */
  const result = method === 'execute'
    ? await connection.execute!(sql, values)
    : await connection.query(sql, values)
  if (!Array.isArray(result)) return { rows: [], fields: [] }
  const rawRows = Array.isArray(result[0]) ? result[0] as unknown[] : []
  const rawFields = Array.isArray(result[1]) ? result[1] as unknown[] : []
  return {
    rows: rawRows.filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null),
    fields: rawFields.flatMap((field) => {
      if (!field || typeof field !== 'object' || typeof (field as { name?: unknown }).name !== 'string') return []
      return [{ name: toDisplayText((field as { name: string }).name, 128) }]
    }),
  }
}

/** 读取查询行集；mysql2 的 SELECT 返回 `[rows, fields]`。 */
async function readRows(
  connection: { query: (sql: string, values?: (string | number)[]) => Promise<unknown> },
  sql: string,
  values: (string | number)[],
): Promise<Record<string, unknown>[]> {
  return (await readQueryResult(connection, sql, values)).rows
}

/** 把索引行聚合成索引定义。 */
function buildMySqlIndexes(rows: readonly Record<string, unknown>[]): ServerOpsDataSchemaIndex[] {
  /** 索引名到定义的有序映射；保持查询返回的索引顺序。 */
  const byName = new Map<string, ServerOpsDataSchemaIndex>()
  for (const row of rows) {
    const name = toDisplayText(row.name, 128)
    const column = toDisplayText(row.column_name, 128)
    if (name.length === 0 || column.length === 0) continue
    /** NON_UNIQUE=0 表示唯一索引。 */
    const unique = toFiniteNumber(row.non_unique) === 0
    const existing = byName.get(name)
    if (existing === undefined) {
      byName.set(name, { name, unique, columns: [column] })
      continue
    }
    if (existing.columns.length < 16) existing.columns.push(column)
  }
  return [...byName.values()]
}

/** 按 MySQL 规则转义标识符；调用方必须已确认它来自 information_schema。 */
function quoteMySqlIdentifier(identifier: string): string {
  return `\`${identifier.replace(/`/gu, '``')}\``
}

/** 把单格数据库值归一化为可区分 NULL、空串、二进制与截断文本的公开值。 */
function formatMySqlCell(value: unknown, digest?: unknown): ServerOpsDataSchemaCell {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return formatSchemaText(value, digest)
  if (typeof value === 'number' || typeof value === 'bigint') return String(value).slice(0, 256)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (value instanceof Date) return value.toISOString()
  if (Buffer.isBuffer(value)) return { kind: 'binary', bytes: value.length }
  if (typeof value === 'object') {
    /** JSON 列等复杂值统一序列化后再截断，避免把对象直接抛给界面。 */
    try {
      return formatSchemaText(JSON.stringify(value))
    } catch {
      return '<unserializable>'
    }
  }
  return toDisplayText(String(value), 256)
}

/** 文本超过 256 字符时用结构化单元格保留截断事实。 */
function formatSchemaText(value: string, digest?: unknown): ServerOpsDataSchemaCell {
  const sanitized = value.replace(/[\u0000-\u001f\u007f]/gu, ' ')
  const lossy = sanitized !== value || sanitized.length > 256
  if (!lossy) return sanitized
  const sha256 = typeof digest === 'string' && /^[a-f0-9]{64}$/u.test(digest)
    ? digest
    : createHash('sha256').update(value, 'utf8').digest('hex')
  let text = sanitized.slice(0, 256)
  if (/[\uD800-\uDBFF]$/u.test(text)) text = text.slice(0, -1)
  return { kind: 'text', text, truncated: true, sha256 }
}

/** 在不丢行的前提下压缩单元格，保证翻页不会跳过被字节预算裁掉的行。 */
function fitSchemaRowsToBudget(rows: ServerOpsDataSchemaCell[][]): { rows: ServerOpsDataSchemaCell[][]; truncated: boolean } {
  /** 最终 JSON 已在预算内时不做任何分配和复制。 */
  if (schemaRowsContentJsonBytes(rows) <= MAX_SCHEMA_ROWS_RESULT_BYTES
    && schemaRowsJsonBytes(rows) <= MAX_SCHEMA_ROWS_WITH_DIGESTS_BYTES) return { rows, truncated: false }
  /** 单元格公开文本最多 256 个 UTF-16 code unit，统一二分字符上限即可覆盖所有文本。 */
  let lower = 0
  let upper = 256
  /** 当前已证明满足总预算的最大结果；最低上限仍保留每一行和每一列。 */
  let best = fitSchemaRowsToTextLength(rows, lower)
  while (lower <= upper) {
    /** 文本字符上限；每轮都按最终 rows JSON 重新计量转义与 UTF-8 字节。 */
    const middle = Math.floor((lower + upper) / 2)
    const candidate = fitSchemaRowsToTextLength(rows, middle)
    if (schemaRowsContentJsonBytes(candidate) <= MAX_SCHEMA_ROWS_RESULT_BYTES
      && schemaRowsJsonBytes(candidate) <= MAX_SCHEMA_ROWS_WITH_DIGESTS_BYTES) {
      best = candidate
      lower = middle + 1
    } else {
      upper = middle - 1
    }
  }
  if (schemaRowsContentJsonBytes(best) > MAX_SCHEMA_ROWS_RESULT_BYTES
    || schemaRowsJsonBytes(best) > MAX_SCHEMA_ROWS_WITH_DIGESTS_BYTES) throw new Error('SERVER_OPS_DATA_RESULT_TOO_LARGE')
  return { rows: best, truncated: true }
}

/** 计算公开行集最终 JSON 的真实 UTF-8 字节数，包含引号、反斜杠与数组分隔符。 */
function schemaRowsJsonBytes(rows: ServerOpsDataSchemaCell[][]): number {
  return Buffer.byteLength(JSON.stringify(rows), 'utf8')
}

/** 计算移除摘要后的正文预算，避免校验元数据挤占原有 1 MiB 预览正文。 */
function schemaRowsContentJsonBytes(rows: ServerOpsDataSchemaCell[][]): number {
  return Buffer.byteLength(JSON.stringify(rows, (key, value: unknown) => key === 'sha256' ? undefined : value), 'utf8')
}

/** 按统一字符上限裁剪文本；NULL 与二进制元数据不改变。 */
function fitSchemaRowsToTextLength(rows: ServerOpsDataSchemaCell[][], maximumTextLength: number): ServerOpsDataSchemaCell[][] {
  return rows.map((row) => row.map((cell): ServerOpsDataSchemaCell => {
    if (cell === null || typeof cell !== 'string' && cell.kind === 'binary') return cell
    const originalBytes = Buffer.byteLength(JSON.stringify(cell), 'utf8')
    const text = typeof cell === 'string' ? cell : cell.text
    /** 避免在高代理项后截断，防止产生无效 Unicode；共享合同按同一 UTF-16 长度计数。 */
    let limited = text.slice(0, maximumTextLength)
    if (/[\uD800-\uDBFF]$/u.test(limited)) limited = limited.slice(0, -1)
    /** 聚合预算产生的新截断同样属于有损展示，必须携带完整原文摘要。 */
    const sha256 = typeof cell === 'string'
      ? createHash('sha256').update(cell, 'utf8').digest('hex')
      : cell.sha256
    if (sha256 === undefined) throw new Error('SERVER_OPS_DATA_UNEXPECTED_RESULT')
    const replacement = { kind: 'text' as const, text: limited, truncated: true as const, sha256 }
    /** 对很短文本，结构化截断对象可能反而更大，此时保留更小的原值。 */
    return Buffer.byteLength(JSON.stringify(replacement), 'utf8') < originalBytes ? replacement : cell
  }))
}

/** 把 information_schema 的时间值转成毫秒时间戳；无法解析时返回 undefined。 */
function toTimestampMs(value: unknown): number | undefined {
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'string' && value.length > 0) {
    const parsed = Date.parse(value.includes('T') ? value : value.replace(' ', 'T'))
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

/** 构造只在当前读取期间存活的 ioredis 连接器类。 */
function createRedisTunnelConnector(
  createChannel: ServerOpsDataChannelFactory,
  input: Pick<ServerOpsDataRuntimeInput, 'tlsMode' | 'tlsServerName' | 'address'>,
  onStream: (stream: Duplex & { encrypted?: boolean }) => void,
): RedisConnectorConstructor {
  /** 自定义连接器不读取 ioredis 选项，隧道参数由闭包捕获。 */
  class ServerOpsRedisTunnelConnector extends AbstractConnector {
    /** ioredis 会传入自身选项；隧道参数已在闭包中，无需读取。 */
    constructor(_options?: unknown) {
      super(1_000)
    }

    /** 建立到目标数据库的隧道通道，需要时在同一通道上完成 TLS 握手。 */
    async connect(): Promise<TLSSocket> {
      /** 本次连接持有的 SSH 转发通道。 */
      const tunnel = await createChannel()
      if (input.tlsMode === 'disabled') {
        /**
         * ioredis 只使用 Duplex 的读写与事件语义，不会访问 net.Socket 专有字段，
         * 因此这里把 ssh2 转发通道按 ioredis 的流类型标注。
         */
        this.stream = tunnel as unknown as TLSSocket
        onStream(tunnel)
        return tunnel as unknown as TLSSocket
      }
      /** TLS 校验使用数据库真实主机名，不使用跳板地址。 */
      const tlsServerName = input.tlsServerName ?? input.address
      /** IP 仅参与证书身份校验，不能被误用为 TLS SNI。 */
      const secureSocket = connectTls({
        socket: tunnel,
        ...(isIP(tlsServerName) === 0 ? { servername: tlsServerName } : {}),
        rejectUnauthorized: input.tlsMode === 'verify',
        checkServerIdentity: (_hostname: string, certificate: PeerCertificate) => checkServerIdentity(tlsServerName, certificate),
      })
      this.stream = secureSocket
      onStream(secureSocket)
      return secureSocket
    }
  }
  return ServerOpsRedisTunnelConnector
}

/** 在单条 SSH 隧道通道上执行 Redis 只读读取。 */
async function readRedis(
  input: ServerOpsDataRuntimeInput,
  dependencies: ServerOpsMySqlAdapterDependencies,
): Promise<ServerOpsDataRuntimeOutput> {
  /** 连接器记录真实流，成功读取后才能报告协商结果。 */
  let stream: (Duplex & { encrypted?: boolean }) | undefined
  /** ioredis 可能用 Connection is closed 覆盖 TLS 原因，保留首个底层错误用于准确分类。 */
  let streamError: Error | undefined
  /** 每条读取独占一条隧道通道，结束后由连接器 destroy 释放。 */
  const redis = new Redis({
    Connector: createRedisTunnelConnector(dependencies.createChannel, input, (connectedStream) => {
      stream = connectedStream
      connectedStream.once('error', (error: Error) => { streamError ??= error })
    }),
    ...(input.tlsMode !== 'disabled' ? { tls: {} } : {}),
    ...(input.username === undefined ? {} : { username: input.username }),
    ...(input.password === undefined ? {} : { password: input.password }),
    ...(input.database === undefined ? {} : { db: Number(input.database) }),
    connectTimeout: dependencies.timeoutMs,
    commandTimeout: dependencies.timeoutMs,
    enableOfflineQueue: false,
    enableReadyCheck: false,
    lazyConnect: true,
    protocol: 2,
    disableClientInfo: true,
    retryStrategy: () => null,
    maxRetriesPerRequest: 1,
  })
  /** 建连和命令读取期间都响应撤销，并保持禁止自动重连。 */
  const releaseAbortBinding = bindServerOpsSqlQueryAbort(dependencies.signal, () => { redis.disconnect() })
  try {
    /** ioredis 在连接失败时会发出 error 事件；必须显式消费，否则会升级为未捕获异常并终止 utility 进程。 */
    redis.on('error', () => undefined)
    await redis.connect()
    if (dependencies.signal?.aborted) throw new Error('SERVER_OPS_DATA_CANCELLED')
    /** INFO 是 Redis 版本与运行指标的唯一来源；无参数调用保证兼容旧版本。 */
    const infoText = await redis.call('INFO')
    /** 归一化后的 INFO 键值映射。 */
    const info = parseRedisInfo(typeof infoText === 'string' ? infoText : '')
    /** 服务端版本；缺失说明对端不是标准 Redis。 */
    const version = toDisplayText(info.redis_version ?? '', 128)
    if (version === '') {
      return { capability: 'unsupported', metrics: [], tables: [], warnings: createWarnings(['无法从 INFO 读取 redis_version']) }
    }
    if (input.tlsMode !== 'disabled' && stream?.encrypted !== true) {
      throw Object.assign(new Error('TLS 未建立'), { code: 'HANDSHAKE_SSL_ERROR' })
    }
    /** 实际加密的连接才可显示 encrypted；verify 已通过 TLS 证书校验。 */
    const tlsStatus: ServerOpsDataTlsStatus = stream?.encrypted === true
      ? input.tlsMode === 'verify' ? 'verified' : 'encrypted'
      : 'plaintext'
    if (input.mode === 'probe') {
      return { capability: 'available', serverVersion: version, tlsStatus, metrics: [], tables: [], warnings: [] }
    }
    /** 诊断阶段允许单项失败。 */
    const warnings: string[] = []
    /** 慢日志长度；未开启慢日志时返回 0。 */
    const slowlogLength = await runOptionalRead(async () => toFiniteNumber(await redis.call('SLOWLOG', 'LEN')), warnings, '无法读取 SLOWLOG LEN')
    /** 最近慢日志条目。 */
    const slowlogEntries = await runOptionalRead(async () => {
      const entries = await redis.call('SLOWLOG', 'GET', String(REDIS_SLOWLOG_LIMIT))
      return Array.isArray(entries) ? entries as readonly unknown[] : []
    }, warnings, '无法读取 SLOWLOG GET')
    /** 诊断指标。 */
    const metrics = buildRedisMetrics(info)
    if (slowlogLength !== undefined) metrics.push(createMetric('slowlog-length', '慢日志累计', formatInteger(slowlogLength)))
    /** 诊断表格。 */
    const tables: ServerOpsDataTable[] = [buildRedisKeyspaceTable(info)]
    if (slowlogEntries) tables.push(buildRedisSlowlogTable(slowlogEntries))
    return {
      capability: 'available',
      serverVersion: version,
      tlsStatus,
      metrics: metrics.slice(0, MAX_DATA_METRICS),
      tables: tables.slice(0, MAX_DATA_TABLES),
      warnings: createWarnings(warnings),
    }
  } catch (error) {
    /** Redis 失败同样只暴露稳定能力状态。 */
    if (dependencies.signal?.aborted) throw new Error('SERVER_OPS_DATA_CANCELLED')
    const classified = classifyServerOpsDataError(streamError ?? error, 'redis')
    return { capability: classified.capability, metrics: [], tables: [], warnings: createWarnings([classified.message]) }
  } finally {
    releaseAbortBinding()
    try {
      redis.disconnect()
    } catch {
      // 断开失败不影响已经得到的结果，通道由连接器自身释放。
    }
  }
}

/**
 * 通过 SSH 隧道执行一次只读数据读取。
 *
 * @param input 数据源连接参数与读取模式（含秘密，只在 utility 进程内使用）
 * @param createChannel 建立到目标数据库的 SSH 转发通道
 * @returns 结构化能力状态与只读诊断结果
 */
export function runServerOpsDataRead(
  input: ServerOpsDataRuntimeNonQueryInput,
  createChannel: ServerOpsDataChannelFactory,
  signal?: AbortSignal,
): Promise<ServerOpsDataRuntimeNonQueryOutput>
export function runServerOpsDataRead(
  input: ServerOpsDataRuntimeQueryInput,
  createChannel: ServerOpsDataChannelFactory,
  signal?: AbortSignal,
): Promise<ServerOpsDataQueryResult>
export function runServerOpsDataRead(
  input: ServerOpsDataRuntimeInput,
  createChannel: ServerOpsDataChannelFactory,
  signal?: AbortSignal,
): Promise<ServerOpsDataRuntimeOutput>
export async function runServerOpsDataRead(
  input: ServerOpsDataRuntimeInput,
  createChannel: ServerOpsDataChannelFactory,
  signal?: AbortSignal,
): Promise<ServerOpsDataRuntimeOutput> {
  if (input.engine !== 'mysql' && input.engine !== 'redis') throw new Error('SERVER_OPS_DATA_QUERY_ENGINE_UNSUPPORTED')
  if (signal?.aborted) throw new Error('SERVER_OPS_DATA_CANCELLED')
  if (input.engine === 'redis' && input.tlsMode === 'preferred') throw new Error('SERVER_OPS_DATA_TLS_MODE_UNSUPPORTED')
  if (input.tlsMode === 'verify' && !input.tlsServerName) throw new Error('SERVER_OPS_DATA_TLS_SERVER_NAME_REQUIRED')
  // mysql2 会省略 IP 的 SNI，必须在认证前拒绝，不能把 localhost 校验误报为目标 IP 已验证。
  if (input.engine === 'mysql' && input.tlsMode === 'verify' && !isServerOpsMySqlTlsServerName(input.tlsServerName)) {
    throw new Error('SERVER_OPS_DATA_TLS_SERVER_NAME_REQUIRED')
  }
  /** 全部连接尝试和查询共用一个时限；preferred 回退不能获得额外的 15 秒。 */
  const controller = new AbortController()
  /** 记录主动超时与外部撤销的区别，避免向用户误报取消。 */
  let timedOut = false
  /** 保存当前通道，撤销时立即销毁，迟到通道在工厂回调中兜底释放。 */
  let activeChannel: Duplex | undefined
  /** 外部撤销同时覆盖通道建立、握手和查询。 */
  const releaseAbortBinding = bindServerOpsSqlQueryAbort(signal, () => { controller.abort() })
  /** 总时限从首次开通道前开始，贯穿 preferred 的第二次握手。 */
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, 15_000)
  /** 在驱动缺少终态事件时也保证读取按时结束。 */
  let rejectCancelled: (reason: Error) => void = () => undefined
  /** 提前绑定拒绝处理，避免等待通道时撤销产生未消费的 rejection。 */
  const cancelled = new Promise<never>((_resolve, reject) => { rejectCancelled = reject })
  /** 先发出取消再销毁底层通道，不依赖驱动是否触发 close/error。 */
  const onAbort = (): void => {
    rejectCancelled(new Error('SERVER_OPS_DATA_CANCELLED'))
    activeChannel?.destroy()
  }
  controller.signal.addEventListener('abort', onAbort, { once: true })
  /** 驱动共享同一撤销信号；通道工厂检查异步返回后的状态。 */
  const dependencies: ServerOpsMySqlAdapterDependencies = {
    createChannel: async () => {
      if (controller.signal.aborted) throw new Error('SERVER_OPS_DATA_CANCELLED')
      /** 迟到通道不再交给驱动，避免撤销后发送认证。 */
      const channel = await createChannel()
      if (controller.signal.aborted) {
        channel.destroy()
        throw new Error('SERVER_OPS_DATA_CANCELLED')
      }
      activeChannel = channel
      return channel
    },
    timeoutMs: 15_000,
    signal: controller.signal,
  }
  try {
    return await Promise.race([
      cancelled,
      input.engine === 'mysql' ? readMySql(input, dependencies) : readRedis(input, dependencies),
    ])
  } catch (error) {
    if (!timedOut) throw error
    if (input.mode === 'sql-query') throw new Error('SERVER_OPS_DATA_QUERY_TIMEOUT')
    if (input.mode === 'schema-cell') throw new Error('SERVER_OPS_DATA_CELL_TIMEOUT')
    return { capability: 'timeout', metrics: [], tables: [], warnings: ['数据库读取超时'] }
  } finally {
    clearTimeout(timer)
    releaseAbortBinding()
    controller.signal.removeEventListener('abort', onAbort)
    activeChannel?.destroy()
  }
}
