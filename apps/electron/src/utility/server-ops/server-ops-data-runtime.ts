import type { Duplex } from 'node:stream'
import { connect as connectTls } from 'node:tls'
import type { TLSSocket } from 'node:tls'
import { createConnection as createMysqlConnection } from 'mysql2/promise'
import { AbstractConnector, Redis } from 'ioredis'
import type {
  ServerOpsDataCapability,
  ServerOpsDataEngine,
  ServerOpsDataMetric,
  ServerOpsDataTable,
  ServerOpsDataTlsMode,
  ServerOpsDataSchemaColumn,
  ServerOpsDataSchemaCell,
  ServerOpsDataSchemaIndex,
  ServerOpsDataSchemaTableSummary,
  ServerOpsDataParameter,
  ServerOpsDataQueryResult,
} from '@proma/shared'
import type { ServerOpsRuntimeDataReadResult } from './server-ops-runtime-protocol'
import {
  bindServerOpsSqlQueryAbort,
  executeServerOpsSqlQuery,
  getServerOpsSqlQueryPublicError,
  normalizeServerOpsSqlQueryError,
} from './server-ops-query-runtime'

/** 数据服务在 utility process 内执行的一次数据读取输入；含秘密，禁止回传主进程之外。 */
/** 所有数据读取模式共享的真实连接字段。 */
interface ServerOpsDataRuntimeInputBase {
  engine: ServerOpsDataEngine
  address: string
  port: number
  database?: string
  username?: string
  password?: string
  tlsMode: ServerOpsDataTlsMode
  tlsServerName?: string
  /** 表浏览目标库；必须已在 information_schema 内校验过。 */
  schemaDatabase?: string
  /** 表浏览目标表；`schema-table` 与 `schema-rows` 使用。 */
  schemaTable?: string
  /** 行预览偏移与页大小；`schema-rows` 使用。 */
  rowOffset?: number
  rowLimit?: number
  /** MySQL 诊断分区；省略时保持旧版全量诊断。 */
  diagnosticSection?: import('@proma/shared').ServerOpsDataDiagnosticSection
  /** MySQL 会话或慢语句的库级筛选；不参与握手默认库。 */
  diagnosticDatabase?: string
}

/** 诊断与表浏览输入；禁止夹带 SQL 查询字段。 */
export interface ServerOpsDataRuntimeNonQueryInput extends ServerOpsDataRuntimeInputBase {
  mode: 'probe' | 'diagnostics' | 'schema-tables' | 'schema-table' | 'schema-rows'
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
const TIMEOUT_ERROR_CODES = new Set(['ETIMEDOUT', 'ETIMEOUT', 'PROTOCOL_SEQUENCE_TIMEOUT', 'CONNECT_TIMEOUT'])

/** 把驱动错误映射为稳定的能力状态与中文说明。 */
export function classifyServerOpsDataError(error: unknown, engine: ServerOpsDataEngine): { capability: ServerOpsDataCapability; message: string } {
  /** 驱动错误的稳定错误码。 */
  const code = readErrorCode(error)
  if (TLS_ERROR_CODES.has(code)) return { capability: 'tls-failed', message: `TLS 校验失败（${code}）` }
  if (AUTH_ERROR_CODES.has(code)) return { capability: 'auth-failed', message: `认证失败（${code}）` }
  if (PERMISSION_ERROR_CODES.has(code)) return { capability: 'permission-denied', message: `权限不足（${code}）` }
  if (TIMEOUT_ERROR_CODES.has(code)) return { capability: 'timeout', message: `连接超时（${code}）` }
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

/** 在单条 SSH 隧道通道上执行 MySQL 只读读取。 */
async function readMySql(
  input: ServerOpsDataRuntimeInput,
  dependencies: ServerOpsMySqlAdapterDependencies,
): Promise<ServerOpsDataRuntimeOutput> {
  /** SSH 转发通道由驱动全程持有，结束时统一销毁。 */
  let channel: Duplex | undefined
  try {
    channel = await dependencies.createChannel()
    /** TLS 校验使用数据库真实主机名，关闭 TLS 时该字段只用于错误信息。 */
    const tlsServerName = input.tlsMode === 'verify' ? input.tlsServerName : undefined
    /** mysql2 连接直接消费隧道通道，不在本机创建监听端口。 */
    const connection = await createMysqlConnection({
      host: tlsServerName ?? input.address,
      port: input.port,
      user: input.username,
      password: input.password,
      /** probe 验证完整配置；SQL 查询必须绑定已授权库，实例级 schema/diagnostics 则不绑定默认库。 */
      ...(resolveServerOpsMySqlHandshakeDatabase(input) !== undefined
        ? { database: resolveServerOpsMySqlHandshakeDatabase(input) }
        : {}),
      stream: channel,
      connectTimeout: dependencies.timeoutMs,
      ...(input.tlsMode === 'verify' ? { ssl: { rejectUnauthorized: true, verifyIdentity: true } } : {}),
    })
    /** 取消时立即销毁驱动连接，socket/隧道通道由外层 finally 再兜底。 */
    const releaseAbortBinding = bindServerOpsSqlQueryAbort(dependencies.signal, () => { connection.destroy() })
    try {
      return await readMySqlWithConnection(connection, input, dependencies.signal)
    } finally {
      releaseAbortBinding()
      connection.destroy()
    }
  } catch (error) {
    if (input.mode === 'sql-query') {
      /** 建连与执行共用同一分类器，再以公开白名单限制跨 utility 边界的错误。 */
      const normalized = normalizeServerOpsSqlQueryError(error)
      if (getServerOpsSqlQueryPublicError(normalized) !== undefined
        || normalized.message === 'SERVER_OPS_DATA_CANCELLED') throw normalized
      throw new Error('SERVER_OPS_DATA_QUERY_FAILED')
    }
    /** 连接失败统一映射为稳定能力状态，不泄露连接串与堆栈。 */
    const classified = classifyServerOpsDataError(error, 'mysql')
    return { capability: classified.capability, metrics: [], tables: [], warnings: createWarnings([classified.message]) }
  } finally {
    if (channel && !channel.destroyed) channel.destroy()
  }
}

/** 在已连接的 mysql2 连接上执行一次受控读取，便于按协议独立验证查询边界。 */
export function readMySqlWithConnection(
  connection: { query: (sql: string, values?: unknown[]) => Promise<unknown> },
  input: ServerOpsDataRuntimeNonQueryInput,
  signal?: AbortSignal,
): Promise<ServerOpsDataRuntimeNonQueryOutput>
export function readMySqlWithConnection(
  connection: { query: (sql: string, values?: unknown[]) => Promise<unknown> },
  input: ServerOpsDataRuntimeQueryInput,
  signal?: AbortSignal,
): Promise<ServerOpsDataQueryResult>
export function readMySqlWithConnection(
  connection: { query: (sql: string, values?: unknown[]) => Promise<unknown> },
  input: ServerOpsDataRuntimeInput,
  signal?: AbortSignal,
): Promise<ServerOpsDataRuntimeOutput>
export async function readMySqlWithConnection(
  connection: { query: (sql: string, values?: unknown[]) => Promise<unknown> },
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
  /** 版本查询是连接成功的唯一凭据。 */
  const versionRows = await readRows(connection, MYSQL_VERSION_QUERY, [])
  const version = toDisplayText(versionRows[0]?.version ?? '', 128)
  if (input.mode === 'probe') return { capability: 'available', serverVersion: version, metrics: [], tables: [], warnings: [] }
  if (input.mode === 'schema-tables' || input.mode === 'schema-table' || input.mode === 'schema-rows') {
    return readMySqlSchema(connection, input)
  }

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
/** 表浏览：表结构列定义。 */
const MYSQL_SCHEMA_COLUMNS_QUERY = 'SELECT COLUMN_NAME AS name, COLUMN_TYPE AS column_type, IS_NULLABLE AS nullable, '
  + 'COLUMN_KEY AS column_key, COLUMN_DEFAULT AS default_text, EXTRA AS extra, COLUMN_COMMENT AS comment '
  + 'FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION LIMIT 256'
/** 表浏览：索引定义；按索引名与序号聚合。 */
const MYSQL_SCHEMA_INDEXES_QUERY = 'SELECT INDEX_NAME AS name, NON_UNIQUE AS non_unique, SEQ_IN_INDEX AS seq, '
  + 'COLUMN_NAME AS column_name FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? '
  + 'ORDER BY INDEX_NAME, SEQ_IN_INDEX LIMIT 1024'
/** 表浏览：白名单校验。只有命中这里返回的表名才允许拼进后续语句。 */
const MYSQL_SCHEMA_TABLE_EXISTS_QUERY = 'SELECT TABLE_NAME AS name FROM information_schema.TABLES '
  + 'WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? LIMIT 1'

/**
 * 执行表浏览读取。
 *
 * 安全边界：库名与表名**先经 information_schema 白名单命中**，命中后仍按 MySQL 规则
 * 转义反引号再拼进语句；没有命中就返回 `unsupported` 而不是把任意标识符送进 SQL。
 *
 * @param connection 已完成版本校验的 MySQL 连接
 * @param input 表浏览请求
 * @returns 结构化的表浏览结果
 */
async function readMySqlSchema(
  connection: { query: (sql: string, values?: unknown[]) => Promise<unknown> },
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
    const tableRows = await readRows(connection, MYSQL_SCHEMA_TABLES_QUERY, [schemaDatabase])
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
    return input.mode === 'schema-rows'
      ? { mode: 'schema-rows', capability: 'unsupported', columns: [], rows: [], offset: input.rowOffset ?? 0,
          limit: input.rowLimit ?? 50, truncated: false, warnings: createWarnings(['缺少目标库']) }
      : { mode: 'schema-table', capability: 'unsupported', columns: [], indexes: [], warnings: createWarnings(['缺少目标库']) }
  }

  /** 表名同样先经白名单校验，未命中直接返回可读原因。 */
  const schemaTable = input.schemaTable
  if (schemaTable === undefined) {
    return { mode: 'schema-table', capability: 'unsupported', columns: [], indexes: [], warnings: createWarnings(['缺少目标表']) }
  }
  const existsRows = await readRows(connection, MYSQL_SCHEMA_TABLE_EXISTS_QUERY, [schemaDatabase, schemaTable])
  if (existsRows.length === 0) {
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

  /** 行预览：优先按主键排序，保证分页稳定；没有主键时按存储顺序返回。 */
  const primaryKey = await readMySqlPrimaryKeyColumns(connection, schemaDatabase, schemaTable)
  const offset = input.rowOffset ?? 0
  const limit = input.rowLimit ?? 50
  const orderClause = !primaryKey.complete || primaryKey.columns.length === 0
    ? ''
    : ` ORDER BY ${primaryKey.columns.map(quoteMySqlIdentifier).join(', ')}`
  const rowsQuery = await readQueryResult(
    connection,
    `SELECT * FROM ${quoteMySqlIdentifier(schemaDatabase)}.${quoteMySqlIdentifier(schemaTable)}${orderClause} LIMIT ? OFFSET ?`,
    [limit + 1, offset],
  )
  /** mysql2 fields 在空表上仍携带列名；最多公开 64 列并给出明确 warning。 */
  const allColumnNames = rowsQuery.fields.map((field) => field.name).filter((name) => name.length > 0)
  const columnNames = allColumnNames.slice(0, 64)
  const columnTruncated = allColumnNames.length > columnNames.length
  const hasMore = rowsQuery.rows.length > limit
  const normalizedRows = rowsQuery.rows.slice(0, limit)
    .map((row) => columnNames.map((column) => formatMySqlCell(row[column])))
  const budgetedRows = fitSchemaRowsToBudget(normalizedRows)
  const cellTruncated = normalizedRows.some((row) => row.some((cell) => typeof cell === 'object' && cell !== null && cell.kind === 'text'))
  const totalEstimate = await readMySqlTableRowEstimate(connection, schemaDatabase, schemaTable)
  return {
    mode: 'schema-rows',
    capability: 'available',
    columns: columnNames,
    rows: budgetedRows.rows,
    offset,
    limit,
    truncated: columnTruncated || cellTruncated || budgetedRows.truncated,
    hasMore,
    orderedByPrimaryKey: primaryKey.complete && primaryKey.columns.length > 0,
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
  connection: { query: (sql: string, values?: unknown[]) => Promise<unknown> },
  sql: string,
  values: unknown[],
): Promise<MySqlQueryResult> {
  const result = await connection.query(sql, values)
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
  connection: { query: (sql: string, values?: unknown[]) => Promise<unknown> },
  sql: string,
  values: unknown[],
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

/** 读取表的主键列；没有主键时返回空数组。 */
async function readMySqlPrimaryKeyColumns(
  connection: { query: (sql: string, values?: unknown[]) => Promise<unknown> },
  database: string,
  table: string,
): Promise<{ columns: string[]; complete: boolean }> {
  const rows = await readRows(connection, MYSQL_SCHEMA_INDEXES_QUERY, [database, table])
  /** 完整主键列按数据库序号排序；超过公开索引合同的 16 列时整体放弃排序。 */
  const columns = rows
    .filter((row) => toDisplayText(row.name, 128).toUpperCase() === 'PRIMARY')
    .sort((left, right) => (toFiniteNumber(left.seq) ?? 0) - (toFiniteNumber(right.seq) ?? 0))
    .map((row) => toDisplayText(row.column_name, 128))
    .filter((column) => column.length > 0)
  return columns.length <= 16 ? { columns, complete: true } : { columns: [], complete: false }
}

/** 读取表行数估算；缺失时返回 undefined。 */
async function readMySqlTableRowEstimate(
  connection: { query: (sql: string, values?: unknown[]) => Promise<unknown> },
  database: string,
  table: string,
): Promise<number | undefined> {
  const rows = await readRows(connection, 'SELECT TABLE_ROWS AS rows_estimate FROM information_schema.TABLES '
    + 'WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? LIMIT 1', [database, table])
  const estimate = rows.length === 0 ? undefined : toFiniteNumber(rows[0]!.rows_estimate)
  if (estimate === undefined) return undefined
  return Math.min(Math.max(0, Math.trunc(estimate)), Number.MAX_SAFE_INTEGER)
}

/** 按 MySQL 规则转义标识符；调用方必须已确认它来自 information_schema。 */
function quoteMySqlIdentifier(identifier: string): string {
  return `\`${identifier.replace(/`/gu, '``')}\``
}

/** 把单格数据库值归一化为可区分 NULL、空串、二进制与截断文本的公开值。 */
function formatMySqlCell(value: unknown): ServerOpsDataSchemaCell {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return formatSchemaText(value)
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
function formatSchemaText(value: string): ServerOpsDataSchemaCell {
  const sanitized = value.replace(/[\u0000-\u001f\u007f]/gu, ' ')
  return sanitized.length <= 256 ? sanitized : { kind: 'text', text: sanitized.slice(0, 256), truncated: true }
}

/** 在不丢行的前提下压缩单元格，保证翻页不会跳过被字节预算裁掉的行。 */
function fitSchemaRowsToBudget(rows: ServerOpsDataSchemaCell[][]): { rows: ServerOpsDataSchemaCell[][]; truncated: boolean } {
  /** 最终 JSON 已在预算内时不做任何分配和复制。 */
  if (schemaRowsJsonBytes(rows) <= MAX_SCHEMA_ROWS_RESULT_BYTES) return { rows, truncated: false }
  /** 单元格公开文本最多 256 个 UTF-16 code unit，统一二分字符上限即可覆盖所有文本。 */
  let lower = 0
  let upper = 256
  /** 当前已证明满足总预算的最大结果；最低上限仍保留每一行和每一列。 */
  let best = fitSchemaRowsToTextLength(rows, lower)
  while (lower <= upper) {
    /** 文本字符上限；每轮都按最终 rows JSON 重新计量转义与 UTF-8 字节。 */
    const middle = Math.floor((lower + upper) / 2)
    const candidate = fitSchemaRowsToTextLength(rows, middle)
    if (schemaRowsJsonBytes(candidate) <= MAX_SCHEMA_ROWS_RESULT_BYTES) {
      best = candidate
      lower = middle + 1
    } else {
      upper = middle - 1
    }
  }
  return { rows: best, truncated: true }
}

/** 计算公开行集最终 JSON 的真实 UTF-8 字节数，包含引号、反斜杠与数组分隔符。 */
function schemaRowsJsonBytes(rows: ServerOpsDataSchemaCell[][]): number {
  return Buffer.byteLength(JSON.stringify(rows), 'utf8')
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
    const replacement = { kind: 'text' as const, text: limited, truncated: true as const }
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
  tlsServerName: string | undefined,
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
      if (tlsServerName === undefined) {
        /**
         * ioredis 只使用 Duplex 的读写与事件语义，不会访问 net.Socket 专有字段，
         * 因此这里把 ssh2 转发通道按 ioredis 的流类型标注。
         */
        this.stream = tunnel as unknown as TLSSocket
        return tunnel as unknown as TLSSocket
      }
      /** TLS 校验使用数据库真实主机名，不使用跳板地址。 */
      const secureSocket = connectTls({ socket: tunnel, servername: tlsServerName, rejectUnauthorized: true })
      this.stream = secureSocket
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
  /** 每条读取独占一条隧道通道，结束后由连接器 destroy 释放。 */
  const redis = new Redis({
    Connector: createRedisTunnelConnector(dependencies.createChannel, input.tlsMode === 'verify' ? input.tlsServerName : undefined),
    ...(input.tlsMode === 'verify' ? { tls: {} } : {}),
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
  try {
    /** ioredis 在连接失败时会发出 error 事件；必须显式消费，否则会升级为未捕获异常并终止 utility 进程。 */
    redis.on('error', () => undefined)
    await redis.connect()
    /** INFO 是 Redis 版本与运行指标的唯一来源；无参数调用保证兼容旧版本。 */
    const infoText = await redis.call('INFO')
    /** 归一化后的 INFO 键值映射。 */
    const info = parseRedisInfo(typeof infoText === 'string' ? infoText : '')
    /** 服务端版本；缺失说明对端不是标准 Redis。 */
    const version = toDisplayText(info.redis_version ?? '', 128)
    if (version === '') {
      return { capability: 'unsupported', metrics: [], tables: [], warnings: createWarnings(['无法从 INFO 读取 redis_version']) }
    }
    if (input.mode === 'probe') {
      return { capability: 'available', serverVersion: version, metrics: [], tables: [], warnings: [] }
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
      metrics: metrics.slice(0, MAX_DATA_METRICS),
      tables: tables.slice(0, MAX_DATA_TABLES),
      warnings: createWarnings(warnings),
    }
  } catch (error) {
    /** Redis 失败同样只暴露稳定能力状态。 */
    const classified = classifyServerOpsDataError(error, 'redis')
    return { capability: classified.capability, metrics: [], tables: [], warnings: createWarnings([classified.message]) }
  } finally {
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
  /** 驱动层与整体调度使用同一份超时预算。 */
  const dependencies: ServerOpsMySqlAdapterDependencies = { createChannel, timeoutMs: 15_000, ...(signal === undefined ? {} : { signal }) }
  return input.engine === 'mysql' ? readMySql(input, dependencies) : readRedis(input, dependencies)
}
