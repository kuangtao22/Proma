import { Buffer } from 'node:buffer'
import { parseServerOpsSftpRequest, parseServerOpsSftpResult } from './server-ops-sftp-runtime'
import type { ServerOpsSftpRequest, ServerOpsSftpResult } from './server-ops-sftp-runtime'
import type { ServerOpsHostKey, ServerOpsTerminalExitEvent, ServerOpsTerminalOutputAck, ServerOpsTerminalOutputEvent } from '@proma/shared'
import { parseServerOpsConsoleAck, parseServerOpsConsoleExitEvent, parseServerOpsConsoleIdentity,
  parseServerOpsConsoleInput, parseServerOpsConsoleOutputEvent, parseServerOpsConsoleResizeInput } from '@proma/shared'
import { isServerOpsDataCapability, isServerOpsDataEngine, isServerOpsDataTlsMode, isServerOpsDataTlsStatus, isServerOpsMySqlTlsServerName, isServerOpsSqliteFilePath, isServerOpsLocalSqliteFilePath, isServerOpsSqliteFileId, parseServerOpsDataMetricList,
  parseServerOpsDataTableList, parseServerOpsDataWarnings, parseServerOpsDataDiagnosticsResult, parseServerOpsDataSourceRowsResult,
  parseServerOpsDataSourceTableResult, parseServerOpsDataSourceTablesResult, parseServerOpsDataQueryResult, parseServerOpsDataRowFilters,
  parseServerOpsDataSourceCellResult, parseServerOpsPostgresTable } from '@proma/shared'
import type { ServerOpsConsoleIdentity, ServerOpsDataCapability, ServerOpsDataEngine, ServerOpsDataMetric, ServerOpsDataTable, ServerOpsDataTlsMode, ServerOpsDataTlsStatus } from '@proma/shared'
import type { ServerOpsDataDiagnosticSection, ServerOpsDataParameter, ServerOpsDataQueryResult, ServerOpsDataSchemaCell, ServerOpsDataRowFilters } from '@proma/shared'
import type { ServerOpsConsoleRuntimeStart } from './server-ops-console-runtime'

/** utility process 接收的 SSH 认证材料。 */
export type ServerOpsRuntimeAuthentication =
  | { kind: 'password'; password: string }
  | { kind: 'private-key'; privateKey: Uint8Array; passphrase?: string }
  | { kind: 'ssh-agent'; agent: string }

/** 主进程发往 runtime 的真实连接请求。 */
export interface ServerOpsRuntimeConnectRequest {
  requestId: string
  hostId: string
  connectionId: string
  address: string
  port: number
  username: string
  expectedHostKey?: ServerOpsHostKey
  authentication: ServerOpsRuntimeAuthentication
  cols: number
  rows: number
}
export interface ServerOpsRuntimeExecRequest {
  requestId: string
  hostId: string
  connectionId: string
  command: string
  timeoutMs: number
}
export interface ServerOpsRuntimeExecResult {
  stdout: string
  stderr: string
  exitCode?: number
  signal?: string
  truncated: boolean
}
/**
 * 数据服务读取模式。
 *
 * - `probe` / `diagnostics`：连接测试与只读诊断（回答"这台库健康吗"）。
 * - `schema-tables` / `schema-table` / `schema-rows`：表浏览（回答"库里有什么、长什么样"）。
 */
export type ServerOpsRuntimeDataReadMode = 'probe' | 'diagnostics' | 'schema-tables' | 'schema-table' | 'schema-rows' | 'schema-cell' | 'sql-query'
/** 主进程发往 runtime 的数据服务读取请求；密码只在进程内传递。 */
export interface ServerOpsRuntimeDataReadRequest {
  requestId: string
  hostId: string
  connectionId: string
  /** 连接方式：`ssh` 走转发通道，`direct` 在 utility 内直接发起 TCP/TLS。 */
  transport: 'ssh' | 'direct'
  mode: ServerOpsRuntimeDataReadMode
  engine: ServerOpsDataEngine
  /** 仅网络数据库携带 TCP 端点。 */
  address?: string
  port?: number
  /** SQLite 使用 SSH 服务器上的绝对文件路径。 */
  filePath?: string
  /** 主进程绑定的本地 SQLite 文件身份；只允许 direct SQLite 携带。 */
  localFileId?: string
  database?: string
  username?: string
  password?: string
  tlsMode: ServerOpsDataTlsMode
  tlsServerName?: string
  timeoutMs: number
  /** MySQL 诊断分区；省略保持旧版全量诊断，Redis 忽略分区能力。 */
  diagnosticSection?: ServerOpsDataDiagnosticSection
  /** MySQL 会话或慢语句的库级筛选；与连接配置默认库相互独立。 */
  diagnosticDatabase?: string
  /** 表浏览目标库；`schema-*` 模式使用，必须已在 information_schema 内校验过。 */
  schemaDatabase?: string
  /** 按需搜索当前库的表目录；其他读取模式不可携带。 */
  schemaTableSearch?: string
  /** 表浏览目标表；`schema-table` 与 `schema-rows` 使用。 */
  schemaTable?: string
  /** 仅主进程可注入：Agent 结构与行预览必须读取基础表，禁止视图间接读取禁用表。 */
  baseTablesOnly?: boolean
  /** 行预览偏移与页大小；`schema-rows` 使用。 */
  rowOffset?: number
  rowLimit?: number
  /** 仅关系表分页读取可携带的有界筛选条件。 */
  rowFilters?: ServerOpsDataRowFilters
  /** 全文读取目标列的公开序号与名称；`schema-cell` 使用。 */
  cellColumnIndex?: number
  cellExpectedColumn?: string
  /** 预览时对完整原文计算的摘要，用于拒绝换序或并发修改后的不同正文。 */
  cellSha256?: string
  /** SQL 查询公开身份与受控正文；只允许 `sql-query` 模式携带。 */
  queryId?: string
  sql?: string
  maxRows?: number
}
/** runtime 返回的数据服务读取结果，指标与表格已按共享合同裁剪。 */
export type ServerOpsRuntimeDataReadResult =
  | ServerOpsRuntimeDataDiagnosticsResult
  | ServerOpsRuntimeDataSchemaTablesResult
  | ServerOpsRuntimeDataSchemaTableResult
  | ServerOpsRuntimeDataSchemaRowsResult
  | ServerOpsRuntimeDataSchemaCellResult
  | ServerOpsDataQueryResult

/** 连接测试与只读诊断结果。 */
export interface ServerOpsRuntimeDataDiagnosticsResult {
  capability: ServerOpsDataCapability
  serverVersion?: string
  /** 实际连通后的 TLS 状态，由数据库驱动报告。 */
  tlsStatus?: ServerOpsDataTlsStatus
  metrics: ServerOpsDataMetric[]
  tables: ServerOpsDataTable[]
  warnings: string[]
  parameters?: ServerOpsDataParameter[]
  parametersTruncated?: boolean
}

/** 表浏览：库与表清单结果。 */
export interface ServerOpsRuntimeDataSchemaTablesResult {
  mode: 'schema-tables'
  capability: ServerOpsDataCapability
  /** runtime 已通过参数化查询精确验证的目标库。 */
  database?: string
  databases: string[]
  tables: import('@proma/shared').ServerOpsDataSchemaTableSummary[]
  databasesTruncated?: boolean
  tablesTruncated?: boolean
  warnings: string[]
}

/** 表浏览：单表结构结果。 */
export interface ServerOpsRuntimeDataSchemaTableResult {
  mode: 'schema-table'
  capability: ServerOpsDataCapability
  columns: import('@proma/shared').ServerOpsDataSchemaColumn[]
  indexes: import('@proma/shared').ServerOpsDataSchemaIndex[]
  warnings: string[]
}

/** 表浏览：分页行预览结果。 */
export interface ServerOpsRuntimeDataSchemaRowsResult {
  mode: 'schema-rows'
  capability: ServerOpsDataCapability
  columns: string[]
  rows: ServerOpsDataSchemaCell[][]
  offset: number
  limit: number
  totalEstimate?: number
  truncated: boolean
  hasMore?: boolean
  orderedByPrimaryKey?: boolean
  warnings: string[]
}
/** 表浏览：单个有损文本单元格的完整原文。 */
export interface ServerOpsRuntimeDataSchemaCellResult {
  mode: 'schema-cell'
  capability: 'available'
  value: string | null | { kind: 'binary'; bytes: number }
  warnings: string[]
}
/** utility process 内部启动独立日志 channel 的请求。 */
export interface ServerOpsRuntimeLogStartRequest {
  streamId: string
  hostId: string
  connectionId: string
  command: string
}
/** 日志流结束时由 utility process 返回的稳定原因。 */
export type ServerOpsRuntimeLogExitReason = 'stopped' | 'connection-closed' | 'remote-exit' | 'error'

/** runtime 在认证前拒绝或成功打开 PTY 的结果。 */
export type ServerOpsRuntimeConnectResult =
  | { status: 'host-key-rejected'; observedHostKey: ServerOpsHostKey }
  | { status: 'connected'; hostKey: ServerOpsHostKey }

/** 主进程发往 SSH runtime 的内部消息。 */
export type ServerOpsRuntimeRequest =
  | { type: 'server-ops.sftp'; input: ServerOpsSftpRequest }
  | { type: 'server-ops.connect'; input: ServerOpsRuntimeConnectRequest }
  | { type: 'server-ops.exec'; input: ServerOpsRuntimeExecRequest }
  | { type: 'server-ops.exec-cancel'; requestId: string; hostId: string; connectionId: string }
  | { type: 'server-ops.data-read'; input: ServerOpsRuntimeDataReadRequest }
  | { type: 'server-ops.data-cancel'; requestId: string; hostId: string; connectionId: string }
  | { type: 'server-ops.disconnect'; hostId: string; connectionId: string }
  | { type: 'server-ops.terminal-input'; hostId: string; connectionId: string; data: string }
  | { type: 'server-ops.terminal-resize'; hostId: string; connectionId: string; cols: number; rows: number }
  | { type: 'server-ops.terminal-ack'; input: ServerOpsTerminalOutputAck }
  | { type: 'server-ops.console-start'; input: ServerOpsConsoleRuntimeStart }
  | { type: 'server-ops.console-stop'; input: ServerOpsConsoleIdentity }
  | { type: 'server-ops.console-input'; input: import('@proma/shared').ServerOpsConsoleInput }
  | { type: 'server-ops.console-resize'; input: import('@proma/shared').ServerOpsConsoleResizeInput }
  | { type: 'server-ops.console-ack'; input: import('@proma/shared').ServerOpsConsoleAck }
  | { type: 'server-ops.log-start'; input: ServerOpsRuntimeLogStartRequest }
  | { type: 'server-ops.log-stop'; streamId: string; hostId: string; connectionId: string }
  | { type: 'server-ops.log-ack'; streamId: string; hostId: string; connectionId: string; sequence: number }
  | { type: 'server-ops.shutdown' }

/** SSH runtime 发回主进程的内部消息。 */
export type ServerOpsRuntimeMessage =
  | { type: 'server-ops.sftp-result'; hostId: string; connectionId: string; result: ServerOpsSftpResult }
  | { type: 'server-ops.ready'; pid: number }
  | { type: 'server-ops.connect-result'; requestId: string; hostId: string; connectionId: string; result: ServerOpsRuntimeConnectResult }
  | { type: 'server-ops.exec-result'; requestId: string; hostId: string; connectionId: string; result: ServerOpsRuntimeExecResult }
  | { type: 'server-ops.exec-cancelled'; requestId: string; hostId: string; connectionId: string }
  | { type: 'server-ops.data-read-result'; requestId: string; hostId: string; connectionId: string; result: ServerOpsRuntimeDataReadResult }
  | { type: 'server-ops.data-read-cancelled'; requestId: string; hostId: string; connectionId: string }
  | { type: 'server-ops.error'; requestId?: string; hostId: string; connectionId: string; code: string; message: string }
  | { type: 'server-ops.terminal-output'; event: ServerOpsTerminalOutputEvent }
  | { type: 'server-ops.terminal-exit'; event: ServerOpsTerminalExitEvent }
  | { type: 'server-ops.console-started'; session: ServerOpsConsoleIdentity }
  | { type: 'server-ops.console-output'; event: import('@proma/shared').ServerOpsConsoleOutputEvent }
  | { type: 'server-ops.console-exit'; event: import('@proma/shared').ServerOpsConsoleExitEvent }
  | { type: 'server-ops.log-started'; streamId: string; hostId: string; connectionId: string }
  | { type: 'server-ops.log-chunk'; streamId: string; hostId: string; connectionId: string; sequence: number; data: string }
  | { type: 'server-ops.log-exit'; streamId: string; hostId: string; connectionId: string; reason: ServerOpsRuntimeLogExitReason; errorCode?: string }
  | { type: 'server-ops.stopped' }

/** 单条终端输入允许跨进程传输的最大字符数。 */
const MAX_TERMINAL_INPUT_LENGTH = 65_536
/** 单条终端输出包含截断提示时允许跨进程传输的最大字符数。 */
const MAX_TERMINAL_OUTPUT_LENGTH = 1_048_832
/** exec stdout 与 stderr 合计允许跨进程传输的最大字符数。 */
const MAX_EXEC_OUTPUT_LENGTH = 1_048_576
/** 单批日志跨进程传输的 UTF-8 字节硬上限。 */
const MAX_LOG_CHUNK_BYTES = 32 * 1_024

/** 判断未知值是否为可按 exact-key 合同读取的对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 判断对象字段是否与当前 union 分支完全一致。 */
function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isRecord(value)) return false
  /** 排序后的实际字段用于同时拒绝缺失字段与未知字段。 */
  const actualKeys = Object.keys(value).sort()
  /** 排序后的合同字段不依赖调用方声明顺序。 */
  const expectedKeys = [...keys].sort()
  return actualKeys.length === expectedKeys.length && actualKeys.every((key, index) => key === expectedKeys[index])
}

/** 判断跨进程 ID 是否为可安全用于 Map key 的规范字符串。 */
function isRuntimeId(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 128 && /^[A-Za-z0-9_-]+$/u.test(value)
}

/**
 * 解析表浏览使用的标识符。
 *
 * 只做"有界文本"校验，真正的安全边界是运行时先查 information_schema 白名单，
 * 只有命中白名单的名字才允许拼进语句（见 server-ops-data-runtime）。
 *
 * @param value 未知输入
 * @param maximum 允许的最大长度
 * @returns 通过校验的标识符
 */
function parseSchemaIdentifier(value: unknown, maximum: number): string {
  if (!isConnectionText(value, maximum)) throw new Error('SERVER_OPS_RUNTIME_PROTOCOL_INVALID')
  return value
}

/** 判断远程端口是否位于 TCP 有效范围。 */
function isPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65_535
}

/** 判断终端行列是否为 ssh2 可接受的有界正整数。 */
function isTerminalDimension(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 1_000
}

/** 判断 SSH 地址或用户名是否为不含空白与 NUL 的有界文本。 */
function isConnectionText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= maxLength && !/[\s\0]/u.test(value)
}

/** 判断秘密材料是否为保留原始空白的有界字符串。 */
function isSecretText(value: unknown, allowEmpty = false): value is string {
  return typeof value === 'string'
    && (allowEmpty || value.length >= 1)
    && value.length <= 8_192
    && !value.includes('\0')
}

/** 计算跨进程字符串的 UTF-8 字节数，与 exec collector 的容量合同保持一致。 */
function getUtf8ByteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

/** 严格解析 SSH Host Key，避免未知字段跨越进程边界。 */
function parseHostKey(value: unknown): ServerOpsHostKey {
  if (!hasExactKeys(value, ['algorithm', 'fingerprint'])
    || typeof value.algorithm !== 'string' || value.algorithm.length < 1 || value.algorithm.length > 128
    || !/^[A-Za-z0-9@._+-]+$/u.test(value.algorithm)
    || typeof value.fingerprint !== 'string' || value.fingerprint.length < 8 || value.fingerprint.length > 192
    || !/^SHA256:[A-Za-z0-9+/]+$/u.test(value.fingerprint)) {
    throw new Error('SERVER_OPS_RUNTIME_PROTOCOL_INVALID')
  }
  return { algorithm: value.algorithm, fingerprint: value.fingerprint }
}

/** 严格解析 runtime 内部认证材料并复制二进制私钥。 */
function parseAuthentication(value: unknown): ServerOpsRuntimeAuthentication {
  if (hasExactKeys(value, ['kind', 'password']) && value.kind === 'password' && isSecretText(value.password)) {
    return { kind: 'password', password: value.password }
  }
  if ((hasExactKeys(value, ['kind', 'privateKey']) || hasExactKeys(value, ['kind', 'privateKey', 'passphrase']))
    && value.kind === 'private-key'
    && value.privateKey instanceof Uint8Array
    && value.privateKey.byteLength >= 1
    && value.privateKey.byteLength <= 1_048_576
    && (value.passphrase === undefined || isSecretText(value.passphrase, true))) {
    return {
      kind: 'private-key',
      privateKey: new Uint8Array(value.privateKey),
      ...(typeof value.passphrase === 'string' ? { passphrase: value.passphrase } : {}),
    }
  }
  if (hasExactKeys(value, ['kind', 'agent']) && value.kind === 'ssh-agent'
    && typeof value.agent === 'string' && value.agent.length >= 1 && value.agent.length <= 1_024
    && !value.agent.includes('\0')) {
    return { kind: 'ssh-agent', agent: value.agent }
  }
  throw new Error('SERVER_OPS_RUNTIME_PROTOCOL_INVALID')
}

/** 严格解析主进程发往 utility process 的连接请求。 */
function parseConnectRequest(value: unknown): ServerOpsRuntimeConnectRequest {
  const keys = ['requestId', 'hostId', 'connectionId', 'address', 'port', 'username', 'authentication', 'cols', 'rows']
  if (!hasExactKeys(value, isRecord(value) && value.expectedHostKey !== undefined ? [...keys, 'expectedHostKey'] : keys)
    || !isRuntimeId(value.requestId) || !isRuntimeId(value.hostId) || !isRuntimeId(value.connectionId)
    || !isConnectionText(value.address, 255) || !isPort(value.port) || !isConnectionText(value.username, 64)
    || !isTerminalDimension(value.cols) || !isTerminalDimension(value.rows)) {
    throw new Error('SERVER_OPS_RUNTIME_PROTOCOL_INVALID')
  }
  /** 可选 Host Key 必须按自身 exact-key 合同重建。 */
  const expectedHostKey = value.expectedHostKey === undefined ? undefined : parseHostKey(value.expectedHostKey)
  return {
    requestId: value.requestId,
    hostId: value.hostId,
    connectionId: value.connectionId,
    address: value.address,
    port: value.port,
    username: value.username,
    ...(expectedHostKey ? { expectedHostKey } : {}),
    authentication: parseAuthentication(value.authentication),
    cols: value.cols,
    rows: value.rows,
  }
}

/** 严格解析主进程发往 utility process 的 exec 请求。 */
function parseExecRequest(value: unknown): ServerOpsRuntimeExecRequest {
  if (!hasExactKeys(value, ['requestId', 'hostId', 'connectionId', 'command', 'timeoutMs'])
    || !isRuntimeId(value.requestId) || !isRuntimeId(value.hostId) || !isRuntimeId(value.connectionId)
    || typeof value.command !== 'string' || value.command.length < 1 || value.command.length > 8_192 || value.command.includes('\0')
    || typeof value.timeoutMs !== 'number' || !Number.isSafeInteger(value.timeoutMs)
    || value.timeoutMs < 1_000 || value.timeoutMs > 120_000) {
    throw new Error('SERVER_OPS_RUNTIME_PROTOCOL_INVALID')
  }
  return { requestId: value.requestId, hostId: value.hostId, connectionId: value.connectionId, command: value.command, timeoutMs: value.timeoutMs }
}

/** 严格解析数据服务读取请求；密码等秘密字段只做边界校验，不进入日志。 */
function parseDataReadRequest(value: unknown): ServerOpsRuntimeDataReadRequest {
  if (!isRecord(value)) throw new Error('SERVER_OPS_RUNTIME_PROTOCOL_INVALID')
  /** 可选字段按实际存在情况参与 exact-key 校验。 */
  const keys = ['requestId', 'hostId', 'connectionId', 'mode', 'engine', 'tlsMode', 'timeoutMs']
    .concat(value.address === undefined ? [] : ['address'])
    .concat(value.port === undefined ? [] : ['port'])
    .concat(value.filePath === undefined ? [] : ['filePath'])
    .concat(value.localFileId === undefined ? [] : ['localFileId'])
    .concat(['transport'])
    .concat(value.database === undefined ? [] : ['database'])
    .concat(value.username === undefined ? [] : ['username'])
    .concat(value.password === undefined ? [] : ['password'])
    .concat(value.tlsServerName === undefined ? [] : ['tlsServerName'])
    .concat(value.schemaDatabase === undefined ? [] : ['schemaDatabase'])
    .concat(value.schemaTableSearch === undefined ? [] : ['schemaTableSearch'])
    .concat(value.schemaTable === undefined ? [] : ['schemaTable'])
    .concat(value.baseTablesOnly === undefined ? [] : ['baseTablesOnly'])
    .concat(value.rowOffset === undefined ? [] : ['rowOffset'])
    .concat(value.rowLimit === undefined ? [] : ['rowLimit'])
    .concat(value.rowFilters === undefined ? [] : ['rowFilters'])
    .concat(value.cellColumnIndex === undefined ? [] : ['cellColumnIndex'])
    .concat(value.cellExpectedColumn === undefined ? [] : ['cellExpectedColumn'])
    .concat(value.cellSha256 === undefined ? [] : ['cellSha256'])
    .concat(value.diagnosticSection === undefined ? [] : ['diagnosticSection'])
    .concat(value.diagnosticDatabase === undefined ? [] : ['diagnosticDatabase'])
    .concat(value.queryId === undefined ? [] : ['queryId'])
    .concat(value.sql === undefined ? [] : ['sql'])
    .concat(value.maxRows === undefined ? [] : ['maxRows'])
  if (!hasExactKeys(value, keys)
    || !isRuntimeId(value.requestId) || !isRuntimeId(value.hostId) || !isRuntimeId(value.connectionId)
    || (value.mode !== 'probe' && value.mode !== 'diagnostics'
      && value.mode !== 'schema-tables' && value.mode !== 'schema-table' && value.mode !== 'schema-rows'
      && value.mode !== 'schema-cell'
      && value.mode !== 'sql-query')
    || (value.transport !== 'ssh' && value.transport !== 'direct')
    || !isServerOpsDataEngine(value.engine)
    || (value.engine !== 'sqlite' && (!isConnectionText(value.address, 255) || !isPort(value.port) || value.filePath !== undefined))
    || (value.database !== undefined && (!isConnectionText(value.database, 64)
      || (value.engine === 'redis' && !/^\d{1,2}$/u.test(value.database))))
    || (value.username !== undefined && !isConnectionText(value.username, 128))
    || (value.password !== undefined && !isSecretText(value.password))
    || !isServerOpsDataTlsMode(value.tlsMode)
    || (value.tlsServerName !== undefined && !isConnectionText(value.tlsServerName, 255))
    || typeof value.timeoutMs !== 'number' || !Number.isSafeInteger(value.timeoutMs)
    || value.timeoutMs < 1_000 || value.timeoutMs > 120_000) {
    throw new Error('SERVER_OPS_RUNTIME_PROTOCOL_INVALID')
  }
  /** 本地文件必须绑定主进程验证的身份，其他来源不得携带本地身份。 */
  if (value.engine === 'sqlite' && value.transport === 'direct'
    ? !isServerOpsSqliteFileId(value.localFileId) : value.localFileId !== undefined) throw new Error('SERVER_OPS_RUNTIME_PROTOCOL_INVALID')
  /** SQLite 只读取单个主库文件，网络认证字段不得混入。 */
  if (value.engine === 'sqlite' && (!(value.transport === 'direct' ? isServerOpsLocalSqliteFilePath(value.filePath) : isServerOpsSqliteFilePath(value.filePath))
    || value.address !== undefined || value.port !== undefined || value.username !== undefined || value.password !== undefined
    || value.tlsMode !== 'disabled' || value.tlsServerName !== undefined
    || (value.database !== undefined && value.database !== 'main')
    || (value.schemaDatabase !== undefined && value.schemaDatabase !== 'main')
    || (value.diagnosticSection !== undefined && value.diagnosticSection !== 'overview'))) {
    throw new Error('SERVER_OPS_RUNTIME_PROTOCOL_INVALID')
  }
  /** TLS 校验必须绑定数据库真实主机名，否则拒绝该请求。 */
  if (value.tlsMode === 'verify' && (value.tlsServerName === undefined
    || (value.engine === 'mysql' && !isServerOpsMySqlTlsServerName(value.tlsServerName)))) {
    throw new Error('SERVER_OPS_RUNTIME_PROTOCOL_INVALID')
  }
  if ((value.engine === 'redis' || value.engine === 'postgresql') && value.tlsMode === 'preferred') {
    throw new Error('SERVER_OPS_RUNTIME_PROTOCOL_INVALID')
  }
  if (value.diagnosticSection !== undefined && (value.mode !== 'diagnostics'
    || (value.diagnosticSection !== 'overview' && value.diagnosticSection !== 'sessions'
      && value.diagnosticSection !== 'statements' && value.diagnosticSection !== 'parameters'))) {
    throw new Error('SERVER_OPS_RUNTIME_PROTOCOL_INVALID')
  }
  if (value.diagnosticDatabase !== undefined && (value.mode !== 'diagnostics'
    || (value.engine !== 'mysql' && value.engine !== 'postgresql')
    || (value.diagnosticSection !== 'sessions' && value.diagnosticSection !== 'statements')
    || typeof value.diagnosticDatabase !== 'string' || value.diagnosticDatabase.length > 64
    || value.diagnosticDatabase.trim().length === 0 || /\p{Cc}/u.test(value.diagnosticDatabase))) {
    throw new Error('SERVER_OPS_RUNTIME_PROTOCOL_INVALID')
  }
  /**
   * 表浏览与诊断是两条不同的意图，参数不得互相夹带：
   * 既防止"看起来在读诊断、实际在读表数据"的歧义请求，也防止缺参数时静默走错分支。
   */
  const isSchemaTables = value.mode === 'schema-tables'
  const isSchemaTable = value.mode === 'schema-table'
  const isSchemaRows = value.mode === 'schema-rows'
  const isSchemaCell = value.mode === 'schema-cell'
  if (value.schemaTableSearch !== undefined && (!isSchemaTables
    || (value.engine !== 'mysql' && value.engine !== 'postgresql' && value.engine !== 'sqlite')
    || value.schemaDatabase === undefined)) throw new Error('SERVER_OPS_RUNTIME_PROTOCOL_INVALID')
  if (value.baseTablesOnly !== undefined && (typeof value.baseTablesOnly !== 'boolean'
    || (!isSchemaTable && !isSchemaRows && !isSchemaCell)
    || (value.engine !== 'mysql' && value.engine !== 'postgresql' && value.engine !== 'sqlite'))) {
    throw new Error('SERVER_OPS_RUNTIME_PROTOCOL_INVALID')
  }
  const isSqlQuery = value.mode === 'sql-query'
  if (value.rowFilters !== undefined && ((!isSchemaRows && !isSchemaCell)
    || (value.engine !== 'mysql' && value.engine !== 'postgresql' && value.engine !== 'sqlite'))) {
    throw new Error('SERVER_OPS_RUNTIME_PROTOCOL_INVALID')
  }
  /** 严格重建筛选条件，禁止额外字段或原始 SQL 跨进程传入。 */
  const rowFilters = value.rowFilters === undefined ? undefined : parseServerOpsDataRowFilters(value.rowFilters)
  if (!isSchemaTables && !isSchemaTable && !isSchemaRows && !isSchemaCell
    && (value.schemaDatabase !== undefined || value.schemaTable !== undefined
      || value.rowOffset !== undefined || value.rowLimit !== undefined)) {
    throw new Error('SERVER_OPS_RUNTIME_PROTOCOL_INVALID')
  }
  /** 表浏览标识符：只有对应模式才解析，越界即拒绝。 */
  const schemaDatabase = isSchemaTable || isSchemaRows || isSchemaCell || (isSchemaTables && value.schemaDatabase !== undefined)
    ? parseSchemaIdentifier(value.schemaDatabase, 64)
    : undefined
  const schemaTable = isSchemaTable || isSchemaRows || isSchemaCell ? parseSchemaIdentifier(value.schemaTable, 260) : undefined
  if (value.engine === 'postgresql' && schemaTable !== undefined) {
    try { parseServerOpsPostgresTable(schemaTable) } catch { throw new Error('SERVER_OPS_RUNTIME_PROTOCOL_INVALID') }
  }
  const schemaTableSearch = value.schemaTableSearch === undefined ? undefined : parseSchemaIdentifier(value.schemaTableSearch, 128)
  if (isSchemaRows) {
    if (typeof value.rowOffset !== 'number' || !Number.isSafeInteger(value.rowOffset) || value.rowOffset < 0 || value.rowOffset > 1_000_000
      || typeof value.rowLimit !== 'number' || !Number.isSafeInteger(value.rowLimit) || value.rowLimit < 1 || value.rowLimit > 200
      || value.rowOffset % value.rowLimit !== 0) throw new Error('SERVER_OPS_RUNTIME_PROTOCOL_INVALID')
  } else if (isSchemaCell) {
    if (typeof value.rowOffset !== 'number' || !Number.isSafeInteger(value.rowOffset) || value.rowOffset < 0 || value.rowOffset > 1_000_199
      || value.rowLimit !== undefined
      || typeof value.cellColumnIndex !== 'number' || !Number.isSafeInteger(value.cellColumnIndex) || value.cellColumnIndex < 0 || value.cellColumnIndex > 63
      || !isConnectionText(value.cellExpectedColumn, 128)
      || typeof value.cellSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.cellSha256)) {
      throw new Error('SERVER_OPS_RUNTIME_PROTOCOL_INVALID')
    }
  } else if (value.rowOffset !== undefined || value.rowLimit !== undefined) {
    throw new Error('SERVER_OPS_RUNTIME_PROTOCOL_INVALID')
  }
  if (!isSchemaCell && (value.cellColumnIndex !== undefined || value.cellExpectedColumn !== undefined || value.cellSha256 !== undefined)) {
    throw new Error('SERVER_OPS_RUNTIME_PROTOCOL_INVALID')
  }
  if (isSqlQuery) {
    if ((value.engine !== 'mysql' && value.engine !== 'postgresql' && value.engine !== 'sqlite') || typeof value.database !== 'string'
      || !isRuntimeId(value.queryId) || typeof value.sql !== 'string' || value.sql.trim().length === 0
      || value.sql.includes('\0') || getUtf8ByteLength(value.sql) > 16_384
      || typeof value.maxRows !== 'number' || !Number.isSafeInteger(value.maxRows) || value.maxRows < 1 || value.maxRows > 200
      || value.diagnosticSection !== undefined || value.diagnosticDatabase !== undefined
      || value.schemaDatabase !== undefined || value.schemaTable !== undefined) {
      throw new Error('SERVER_OPS_RUNTIME_PROTOCOL_INVALID')
    }
  } else if (value.queryId !== undefined || value.sql !== undefined || value.maxRows !== undefined) {
    throw new Error('SERVER_OPS_RUNTIME_PROTOCOL_INVALID')
  }
  return {
    ...(rowFilters === undefined ? {} : { rowFilters }),
    requestId: value.requestId,
    hostId: value.hostId,
    connectionId: value.connectionId,
    transport: value.transport,
    mode: value.mode,
    engine: value.engine,
    ...(value.address === undefined ? {} : { address: value.address as string }),
    ...(value.port === undefined ? {} : { port: value.port as number }),
    ...(value.filePath === undefined ? {} : { filePath: value.filePath as string }),
    ...(value.localFileId === undefined ? {} : { localFileId: value.localFileId as string }),
    ...(value.database === undefined ? {} : { database: value.database }),
    ...(value.username === undefined ? {} : { username: value.username }),
    ...(value.password === undefined ? {} : { password: value.password }),
    tlsMode: value.tlsMode,
    ...(value.tlsServerName === undefined ? {} : { tlsServerName: value.tlsServerName }),
    timeoutMs: value.timeoutMs,
    ...(value.diagnosticSection === undefined ? {} : { diagnosticSection: value.diagnosticSection }),
    ...(value.diagnosticDatabase === undefined ? {} : { diagnosticDatabase: value.diagnosticDatabase }),
    ...(schemaDatabase === undefined ? {} : { schemaDatabase }),
    ...(schemaTableSearch === undefined ? {} : { schemaTableSearch }),
    ...(schemaTable === undefined ? {} : { schemaTable }),
    ...(value.baseTablesOnly === undefined ? {} : { baseTablesOnly: value.baseTablesOnly }),
    ...(value.rowOffset === undefined ? {} : { rowOffset: value.rowOffset }),
    ...(value.rowLimit === undefined ? {} : { rowLimit: value.rowLimit }),
    ...(value.cellColumnIndex === undefined ? {} : { cellColumnIndex: value.cellColumnIndex as number }),
    ...(value.cellExpectedColumn === undefined ? {} : { cellExpectedColumn: value.cellExpectedColumn as string }),
    ...(value.cellSha256 === undefined ? {} : { cellSha256: value.cellSha256 as string }),
    ...(value.queryId === undefined ? {} : { queryId: value.queryId }),
    ...(value.sql === undefined ? {} : { sql: value.sql }),
    ...(value.maxRows === undefined ? {} : { maxRows: value.maxRows }),
  }
}

/** 严格解析只在 main 与 utility 间传输的日志命令。 */
function parseLogStartRequest(value: unknown): ServerOpsRuntimeLogStartRequest {
  if (!hasExactKeys(value, ['streamId', 'hostId', 'connectionId', 'command'])
    || !isRuntimeId(value.streamId) || !isRuntimeId(value.hostId) || !isRuntimeId(value.connectionId)
    || typeof value.command !== 'string' || value.command.length < 1 || value.command.length > 8_192
    || value.command.includes('\0')) {
    throw new Error('SERVER_OPS_RUNTIME_PROTOCOL_INVALID')
  }
  return { streamId: value.streamId, hostId: value.hostId, connectionId: value.connectionId, command: value.command }
}

/** 判断日志序号是否兼容 Shared 的 0..MAX_SAFE_INTEGER 合同。 */
function isLogSequence(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** 严格解析主进程发往 SSH utility process 的内部请求。 */
export function parseServerOpsRuntimeRequest(value: unknown): ServerOpsRuntimeRequest {
  try {
    if (!isRecord(value) || typeof value.type !== 'string') throw new Error('invalid')
    if (value.type === 'server-ops.sftp' && hasExactKeys(value, ['type', 'input'])) {
      return { type: value.type, input: parseServerOpsSftpRequest(value.input) }
    }
    if (value.type === 'server-ops.connect' && hasExactKeys(value, ['type', 'input'])) {
      return { type: value.type, input: parseConnectRequest(value.input) }
    }
    if (value.type === 'server-ops.exec' && hasExactKeys(value, ['type', 'input'])) {
      return { type: value.type, input: parseExecRequest(value.input) }
    }
    if (value.type === 'server-ops.data-read' && hasExactKeys(value, ['type', 'input'])) {
      return { type: value.type, input: parseDataReadRequest(value.input) }
    }
    if ((value.type === 'server-ops.data-cancel' || value.type === 'server-ops.exec-cancel')
      && hasExactKeys(value, ['type', 'requestId', 'hostId', 'connectionId'])
      && isRuntimeId(value.requestId) && isRuntimeId(value.hostId) && isRuntimeId(value.connectionId)) {
      return { type: value.type, requestId: value.requestId, hostId: value.hostId, connectionId: value.connectionId }
    }
    if ((value.type === 'server-ops.disconnect' || value.type === 'server-ops.terminal-input')
      && hasExactKeys(value, value.type === 'server-ops.disconnect' ? ['type', 'hostId', 'connectionId'] : ['type', 'hostId', 'connectionId', 'data'])
      && isRuntimeId(value.hostId) && isRuntimeId(value.connectionId)) {
      if (value.type === 'server-ops.disconnect') return { type: value.type, hostId: value.hostId, connectionId: value.connectionId }
      if (typeof value.data === 'string' && value.data.length <= MAX_TERMINAL_INPUT_LENGTH) {
        return { type: value.type, hostId: value.hostId, connectionId: value.connectionId, data: value.data }
      }
    }
    if (value.type === 'server-ops.terminal-resize' && hasExactKeys(value, ['type', 'hostId', 'connectionId', 'cols', 'rows'])
      && isRuntimeId(value.hostId) && isRuntimeId(value.connectionId)
      && isTerminalDimension(value.cols) && isTerminalDimension(value.rows)) {
      return { type: value.type, hostId: value.hostId, connectionId: value.connectionId, cols: value.cols, rows: value.rows }
    }
    if (value.type === 'server-ops.terminal-ack' && hasExactKeys(value, ['type', 'input'])
      && hasExactKeys(value.input, ['hostId', 'connectionId', 'sequence'])
      && isRuntimeId(value.input.hostId) && isRuntimeId(value.input.connectionId)
      && typeof value.input.sequence === 'number' && Number.isSafeInteger(value.input.sequence) && value.input.sequence >= 1) {
      return { type: value.type, input: { hostId: value.input.hostId, connectionId: value.input.connectionId, sequence: value.input.sequence } }
    }
    if (value.type === 'server-ops.console-start' && hasExactKeys(value, ['type', 'input'])
      && hasExactKeys(value.input, ['consoleId', 'hostId', 'connectionId', 'containerId', 'cols', 'rows'])
      && isTerminalDimension(value.input.cols) && isTerminalDimension(value.input.rows)) {
      return { type: value.type, input: { ...parseServerOpsConsoleIdentity({ consoleId: value.input.consoleId,
        hostId: value.input.hostId, connectionId: value.input.connectionId, containerId: value.input.containerId }),
        cols: value.input.cols, rows: value.input.rows } }
    }
    if (value.type === 'server-ops.console-stop' && hasExactKeys(value, ['type', 'input'])) {
      return { type: value.type, input: parseServerOpsConsoleIdentity(value.input) }
    }
    if (value.type === 'server-ops.console-input' && hasExactKeys(value, ['type', 'input'])) {
      return { type: value.type, input: parseServerOpsConsoleInput(value.input) }
    }
    if (value.type === 'server-ops.console-resize' && hasExactKeys(value, ['type', 'input'])) {
      return { type: value.type, input: parseServerOpsConsoleResizeInput(value.input) }
    }
    if (value.type === 'server-ops.console-ack' && hasExactKeys(value, ['type', 'input'])) {
      return { type: value.type, input: parseServerOpsConsoleAck(value.input) }
    }
    if (value.type === 'server-ops.log-start' && hasExactKeys(value, ['type', 'input'])) {
      return { type: value.type, input: parseLogStartRequest(value.input) }
    }
    if ((value.type === 'server-ops.log-stop' || value.type === 'server-ops.log-ack')
      && hasExactKeys(value, value.type === 'server-ops.log-stop'
        ? ['type', 'streamId', 'hostId', 'connectionId']
        : ['type', 'streamId', 'hostId', 'connectionId', 'sequence'])
      && isRuntimeId(value.streamId) && isRuntimeId(value.hostId) && isRuntimeId(value.connectionId)) {
      if (value.type === 'server-ops.log-stop') {
        return { type: value.type, streamId: value.streamId, hostId: value.hostId, connectionId: value.connectionId }
      }
      if (isLogSequence(value.sequence)) {
        return { type: value.type, streamId: value.streamId, hostId: value.hostId, connectionId: value.connectionId, sequence: value.sequence }
      }
    }
    if (value.type === 'server-ops.shutdown' && hasExactKeys(value, ['type'])) return { type: value.type }
  } catch {
    // 下方统一使用稳定协议错误，避免泄露具体认证字段。
  }
  throw new Error('SERVER_OPS_RUNTIME_REQUEST_INVALID')
}

/** 严格解析 utility process 返回的连接结果 union。 */
function parseConnectResult(value: unknown): ServerOpsRuntimeConnectResult {
  if (hasExactKeys(value, ['status', 'hostKey']) && value.status === 'connected') {
    return { status: value.status, hostKey: parseHostKey(value.hostKey) }
  }
  if (hasExactKeys(value, ['status', 'observedHostKey']) && value.status === 'host-key-rejected') {
    return { status: value.status, observedHostKey: parseHostKey(value.observedHostKey) }
  }
  throw new Error('SERVER_OPS_RUNTIME_PROTOCOL_INVALID')
}

/** 严格解析 utility process 返回的 exec 结果。 */
function parseExecResult(value: unknown): ServerOpsRuntimeExecResult {
  const keys = ['stdout', 'stderr', 'truncated']
  if (!hasExactKeys(value, isRecord(value)
    ? [...keys, ...(value.exitCode !== undefined ? ['exitCode'] : []), ...(value.signal !== undefined ? ['signal'] : [])]
    : keys)
    || typeof value.stdout !== 'string' || typeof value.stderr !== 'string'
    || value.stdout.length + value.stderr.length > MAX_EXEC_OUTPUT_LENGTH
    || getUtf8ByteLength(value.stdout) + getUtf8ByteLength(value.stderr) > MAX_EXEC_OUTPUT_LENGTH
    || typeof value.truncated !== 'boolean'
    || (value.exitCode !== undefined && (typeof value.exitCode !== 'number' || !Number.isSafeInteger(value.exitCode) || value.exitCode < 0 || value.exitCode > 2_147_483_647))
    || (value.signal !== undefined && (typeof value.signal !== 'string' || value.signal.length < 1 || value.signal.length > 64 || !/^[A-Za-z0-9_.:+-]+$/u.test(value.signal)))) {
    throw new Error('SERVER_OPS_RUNTIME_PROTOCOL_INVALID')
  }
  return {
    stdout: value.stdout,
    stderr: value.stderr,
    ...(typeof value.exitCode === 'number' ? { exitCode: value.exitCode } : {}),
    ...(typeof value.signal === 'string' ? { signal: value.signal } : {}),
    truncated: value.truncated,
  }
}

/** 严格解析 utility process 返回的数据服务读取结果。 */
function parseDataReadResult(value: unknown): ServerOpsRuntimeDataReadResult {
  if (!isRecord(value)) throw new Error('SERVER_OPS_RUNTIME_PROTOCOL_INVALID')
  if (value.queryId !== undefined) return parseServerOpsDataQueryResult(value)
  /** 表浏览结果按 mode 走各自的严格解析；没有 mode 字段的即为诊断/连接测试结果。 */
  if (value.mode === 'schema-tables') return parseSchemaTablesResult(value)
  if (value.mode === 'schema-table') return parseSchemaTableResult(value)
  if (value.mode === 'schema-rows') return parseSchemaRowsResult(value)
  if (value.mode === 'schema-cell') {
    if (!hasExactKeys(value, ['mode', 'capability', 'value', 'warnings']) || value.capability !== 'available') {
      throw new Error('SERVER_OPS_RUNTIME_PROTOCOL_INVALID')
    }
    return {
      mode: value.mode,
      capability: value.capability,
      value: parseServerOpsDataSourceCellResult({ value: value.value }).value,
      warnings: parseServerOpsDataWarnings(value.warnings),
    }
  }
  /** 版本字段可选，其余字段必须齐全。 */
  const keys = ['capability', 'metrics', 'tables', 'warnings']
    .concat(value.serverVersion === undefined ? [] : ['serverVersion'])
    .concat(value.tlsStatus === undefined ? [] : ['tlsStatus'])
    .concat(value.parameters === undefined ? [] : ['parameters'])
    .concat(value.parametersTruncated === undefined ? [] : ['parametersTruncated'])
  if (!hasExactKeys(value, keys)
    || !isServerOpsDataCapability(value.capability)
    || (value.tlsStatus !== undefined && !isServerOpsDataTlsStatus(value.tlsStatus))
    || (value.serverVersion !== undefined && (typeof value.serverVersion !== 'string'
      || value.serverVersion.length < 1 || value.serverVersion.length > 128 || /[\u0000-\u001f\u007f]/u.test(value.serverVersion)))) {
    throw new Error('SERVER_OPS_RUNTIME_PROTOCOL_INVALID')
  }
  /** 指标与表格复用共享合同的严格解析，避免两侧形状漂移。 */
  const metrics = parseServerOpsDataMetricList(value.metrics)
  const tables = parseServerOpsDataTableList(value.tables)
  /** 参数结果复用公开诊断 parser，集中保持数量与字段边界。 */
  const parsedDiagnostics = importDiagnosticsFields(value)
  /** 能力状态与结果内容必须自洽，未连通时不允许携带诊断数据。 */
  if (value.capability === 'available') {
    if (value.serverVersion === undefined) throw new Error('SERVER_OPS_RUNTIME_PROTOCOL_INVALID')
  } else if (value.serverVersion !== undefined || value.tlsStatus !== undefined || metrics.length > 0 || tables.length > 0) {
    throw new Error('SERVER_OPS_RUNTIME_PROTOCOL_INVALID')
  }
  return {
    capability: value.capability,
    ...(value.serverVersion === undefined ? {} : { serverVersion: value.serverVersion }),
    ...(value.tlsStatus === undefined ? {} : { tlsStatus: value.tlsStatus }),
    metrics,
    tables,
    ...(parsedDiagnostics.parameters === undefined ? {} : { parameters: parsedDiagnostics.parameters }),
    ...(parsedDiagnostics.parametersTruncated === undefined ? {} : { parametersTruncated: parsedDiagnostics.parametersTruncated }),
    warnings: parseServerOpsDataWarnings(value.warnings),
  }
}

/** 解析 runtime 诊断中的可选参数字段。 */
function importDiagnosticsFields(value: Record<string, unknown>): Pick<import('@proma/shared').ServerOpsDataDiagnosticsResult, 'parameters' | 'parametersTruncated'> {
  const parsed = parseServerOpsDataDiagnosticsResult({
    sourceId: 'runtime-result',
    engine: 'mysql',
    capability: value.capability,
    collectedAt: 0,
    metrics: value.metrics,
    tables: value.tables,
    ...(value.parameters === undefined ? {} : { parameters: value.parameters }),
    ...(value.parametersTruncated === undefined ? {} : { parametersTruncated: value.parametersTruncated }),
    warnings: value.warnings,
  })
  return {
    ...(parsed.parameters === undefined ? {} : { parameters: parsed.parameters }),
    ...(parsed.parametersTruncated === undefined ? {} : { parametersTruncated: parsed.parametersTruncated }),
  }
}

/** 解析表浏览的库/表清单结果。 */
function parseSchemaTablesResult(value: Record<string, unknown>): ServerOpsRuntimeDataSchemaTablesResult {
  const keys = ['mode', 'capability', 'databases', 'tables', 'warnings']
    .concat(value.database === undefined ? [] : ['database'])
    .concat(value.databasesTruncated === undefined ? [] : ['databasesTruncated'])
    .concat(value.tablesTruncated === undefined ? [] : ['tablesTruncated'])
  if (!hasExactKeys(value, keys)
    || !isServerOpsDataCapability(value.capability)) throw new Error('SERVER_OPS_RUNTIME_PROTOCOL_INVALID')
  /** 清单字段复用共享合同的表摘要校验，避免两侧字段漂移。 */
  const parsed = parseServerOpsDataSourceTablesResult({
    databases: value.databases,
    tables: value.tables,
    ...(value.database === undefined ? {} : { database: value.database }),
    ...(value.databasesTruncated === undefined ? {} : { databasesTruncated: value.databasesTruncated }),
    ...(value.tablesTruncated === undefined ? {} : { tablesTruncated: value.tablesTruncated }),
  })
  /** 能力状态与内容必须自洽：未连通时不允许携带清单。 */
  if (parsed.database !== undefined && !parsed.databases.includes(parsed.database)) {
    throw new Error('SERVER_OPS_RUNTIME_PROTOCOL_INVALID')
  }
  if (value.capability !== 'available' && (parsed.database !== undefined || parsed.databases.length > 0 || parsed.tables.length > 0)) {
    throw new Error('SERVER_OPS_RUNTIME_PROTOCOL_INVALID')
  }
  return {
    mode: 'schema-tables',
    capability: value.capability,
    ...(parsed.database === undefined ? {} : { database: parsed.database }),
    databases: parsed.databases,
    tables: parsed.tables,
    ...(parsed.databasesTruncated === undefined ? {} : { databasesTruncated: parsed.databasesTruncated }),
    ...(parsed.tablesTruncated === undefined ? {} : { tablesTruncated: parsed.tablesTruncated }),
    warnings: parseServerOpsDataWarnings(value.warnings),
  }
}

/** 解析单表结构结果。 */
function parseSchemaTableResult(value: Record<string, unknown>): ServerOpsRuntimeDataSchemaTableResult {
  if (!hasExactKeys(value, ['mode', 'capability', 'columns', 'indexes', 'warnings'])
    || !isServerOpsDataCapability(value.capability)) throw new Error('SERVER_OPS_RUNTIME_PROTOCOL_INVALID')
  const parsed = parseServerOpsDataSourceTableResult({ columns: value.columns, indexes: value.indexes })
  if (value.capability === 'available') {
    if (parsed.columns.length === 0) throw new Error('SERVER_OPS_RUNTIME_PROTOCOL_INVALID')
  } else if (parsed.columns.length > 0 || parsed.indexes.length > 0) {
    throw new Error('SERVER_OPS_RUNTIME_PROTOCOL_INVALID')
  }
  return {
    mode: 'schema-table',
    capability: value.capability,
    columns: parsed.columns,
    indexes: parsed.indexes,
    warnings: parseServerOpsDataWarnings(value.warnings),
  }
}

/** 解析分页行预览结果。 */
function parseSchemaRowsResult(value: Record<string, unknown>): ServerOpsRuntimeDataSchemaRowsResult {
  const keys = ['mode', 'capability', 'columns', 'rows', 'offset', 'limit', 'truncated', 'warnings']
    .concat(value.totalEstimate === undefined ? [] : ['totalEstimate'])
    .concat(value.hasMore === undefined ? [] : ['hasMore'])
    .concat(value.orderedByPrimaryKey === undefined ? [] : ['orderedByPrimaryKey'])
  if (!hasExactKeys(value, keys) || !isServerOpsDataCapability(value.capability)) throw new Error('SERVER_OPS_RUNTIME_PROTOCOL_INVALID')
  const parsed = parseServerOpsDataSourceRowsResult({
    columns: value.columns,
    rows: value.rows,
    offset: value.offset,
    limit: value.limit,
    truncated: value.truncated,
    ...(value.totalEstimate === undefined ? {} : { totalEstimate: value.totalEstimate }),
    ...(value.hasMore === undefined ? {} : { hasMore: value.hasMore }),
    ...(value.orderedByPrimaryKey === undefined ? {} : { orderedByPrimaryKey: value.orderedByPrimaryKey }),
  })
  /** 未连通时只允许回空网格，不允许携带任何行。 */
  if (value.capability !== 'available' && parsed.rows.length > 0) throw new Error('SERVER_OPS_RUNTIME_PROTOCOL_INVALID')
  return {
    mode: 'schema-rows',
    capability: value.capability,
    columns: parsed.columns,
    rows: parsed.rows,
    offset: parsed.offset,
    limit: parsed.limit,
    truncated: parsed.truncated,
    ...(parsed.totalEstimate === undefined ? {} : { totalEstimate: parsed.totalEstimate }),
    ...(parsed.hasMore === undefined ? {} : { hasMore: parsed.hasMore }),
    ...(parsed.orderedByPrimaryKey === undefined ? {} : { orderedByPrimaryKey: parsed.orderedByPrimaryKey }),
    warnings: parseServerOpsDataWarnings(value.warnings),
  }
}

/** 严格解析 utility process 返回的终端退出事件。 */
function parseTerminalExitEvent(value: unknown): ServerOpsTerminalExitEvent {
  const keys = ['hostId', 'connectionId', 'message']
  if (!hasExactKeys(value, isRecord(value)
    ? [...keys, ...(value.exitCode !== undefined ? ['exitCode'] : []), ...(value.signal !== undefined ? ['signal'] : [])]
    : keys)
    || !isRuntimeId(value.hostId) || !isRuntimeId(value.connectionId)
    || typeof value.message !== 'string' || value.message.length < 1 || value.message.length > 512 || value.message.includes('\0')
    || (value.exitCode !== undefined && (typeof value.exitCode !== 'number' || !Number.isSafeInteger(value.exitCode) || value.exitCode < 0 || value.exitCode > 2_147_483_647))
    || (value.signal !== undefined && (typeof value.signal !== 'string' || value.signal.length < 1 || value.signal.length > 64 || !/^[A-Za-z0-9_.:+-]+$/u.test(value.signal)))) {
    throw new Error('SERVER_OPS_RUNTIME_PROTOCOL_INVALID')
  }
  return {
    hostId: value.hostId,
    connectionId: value.connectionId,
    ...(typeof value.exitCode === 'number' ? { exitCode: value.exitCode } : {}),
    ...(typeof value.signal === 'string' ? { signal: value.signal } : {}),
    message: value.message,
  }
}

/** 严格解析 SSH utility process 发回主进程的内部消息。 */
export function parseServerOpsRuntimeMessage(value: unknown): ServerOpsRuntimeMessage {
  try {
    if (!isRecord(value) || typeof value.type !== 'string') throw new Error('invalid')
    if (value.type === 'server-ops.sftp-result' && hasExactKeys(value, ['type', 'hostId', 'connectionId', 'result'])
      && isRuntimeId(value.hostId) && isRuntimeId(value.connectionId)) {
      return { type: value.type, hostId: value.hostId, connectionId: value.connectionId, result: parseServerOpsSftpResult(value.result) }
    }
    if (value.type === 'server-ops.ready' && hasExactKeys(value, ['type', 'pid'])
      && typeof value.pid === 'number' && Number.isSafeInteger(value.pid) && value.pid >= 1 && value.pid <= 2_147_483_647) {
      return { type: value.type, pid: value.pid }
    }
    if ((value.type === 'server-ops.connect-result' || value.type === 'server-ops.exec-result' || value.type === 'server-ops.data-read-result')
      && hasExactKeys(value, ['type', 'requestId', 'hostId', 'connectionId', 'result'])
      && isRuntimeId(value.requestId) && isRuntimeId(value.hostId) && isRuntimeId(value.connectionId)) {
      if (value.type === 'server-ops.connect-result') return { type: value.type, requestId: value.requestId, hostId: value.hostId, connectionId: value.connectionId, result: parseConnectResult(value.result) }
      if (value.type === 'server-ops.exec-result') return { type: value.type, requestId: value.requestId, hostId: value.hostId, connectionId: value.connectionId, result: parseExecResult(value.result) }
      return { type: value.type, requestId: value.requestId, hostId: value.hostId, connectionId: value.connectionId, result: parseDataReadResult(value.result) }
    }
    if ((value.type === 'server-ops.data-read-cancelled' || value.type === 'server-ops.exec-cancelled')
      && hasExactKeys(value, ['type', 'requestId', 'hostId', 'connectionId'])
      && isRuntimeId(value.requestId) && isRuntimeId(value.hostId) && isRuntimeId(value.connectionId)) {
      return { type: value.type, requestId: value.requestId, hostId: value.hostId, connectionId: value.connectionId }
    }
    if (value.type === 'server-ops.error'
      && hasExactKeys(value, value.requestId === undefined
        ? ['type', 'hostId', 'connectionId', 'code', 'message']
        : ['type', 'requestId', 'hostId', 'connectionId', 'code', 'message'])
      && (value.requestId === undefined || isRuntimeId(value.requestId))
      && isRuntimeId(value.hostId) && isRuntimeId(value.connectionId)
      && typeof value.code === 'string' && value.code.length >= 1 && value.code.length <= 128 && /^[A-Za-z0-9_.:-]+$/u.test(value.code)
      && typeof value.message === 'string' && value.message.length >= 1 && value.message.length <= 512 && !value.message.includes('\0')) {
      return { type: value.type, ...(typeof value.requestId === 'string' ? { requestId: value.requestId } : {}), hostId: value.hostId, connectionId: value.connectionId, code: value.code, message: value.message }
    }
    if (value.type === 'server-ops.terminal-output' && hasExactKeys(value, ['type', 'event'])
      && hasExactKeys(value.event, ['hostId', 'connectionId', 'sequence', 'data'])
      && isRuntimeId(value.event.hostId) && isRuntimeId(value.event.connectionId)
      && typeof value.event.sequence === 'number' && Number.isSafeInteger(value.event.sequence) && value.event.sequence >= 1
      && typeof value.event.data === 'string' && value.event.data.length <= MAX_TERMINAL_OUTPUT_LENGTH) {
      return { type: value.type, event: { hostId: value.event.hostId, connectionId: value.event.connectionId, sequence: value.event.sequence, data: value.event.data } }
    }
    if (value.type === 'server-ops.terminal-exit' && hasExactKeys(value, ['type', 'event'])) {
      return { type: value.type, event: parseTerminalExitEvent(value.event) }
    }
    if (value.type === 'server-ops.console-started' && hasExactKeys(value, ['type', 'session'])) {
      return { type: value.type, session: parseServerOpsConsoleIdentity(value.session) }
    }
    if (value.type === 'server-ops.console-output' && hasExactKeys(value, ['type', 'event'])) {
      return { type: value.type, event: parseServerOpsConsoleOutputEvent(value.event) }
    }
    if (value.type === 'server-ops.console-exit' && hasExactKeys(value, ['type', 'event'])) {
      return { type: value.type, event: parseServerOpsConsoleExitEvent(value.event) }
    }
    if (value.type === 'server-ops.log-started'
      && hasExactKeys(value, ['type', 'streamId', 'hostId', 'connectionId'])
      && isRuntimeId(value.streamId) && isRuntimeId(value.hostId) && isRuntimeId(value.connectionId)) {
      return { type: value.type, streamId: value.streamId, hostId: value.hostId, connectionId: value.connectionId }
    }
    if (value.type === 'server-ops.log-chunk'
      && hasExactKeys(value, ['type', 'streamId', 'hostId', 'connectionId', 'sequence', 'data'])
      && isRuntimeId(value.streamId) && isRuntimeId(value.hostId) && isRuntimeId(value.connectionId)
      && isLogSequence(value.sequence) && typeof value.data === 'string'
      && getUtf8ByteLength(value.data) <= MAX_LOG_CHUNK_BYTES) {
      return { type: value.type, streamId: value.streamId, hostId: value.hostId, connectionId: value.connectionId, sequence: value.sequence, data: value.data }
    }
    if (value.type === 'server-ops.log-exit'
      && hasExactKeys(value, value.errorCode === undefined
        ? ['type', 'streamId', 'hostId', 'connectionId', 'reason']
        : ['type', 'streamId', 'hostId', 'connectionId', 'reason', 'errorCode'])
      && isRuntimeId(value.streamId) && isRuntimeId(value.hostId) && isRuntimeId(value.connectionId)
      && (value.reason === 'stopped' || value.reason === 'connection-closed' || value.reason === 'remote-exit' || value.reason === 'error')
      && (value.errorCode === undefined || (value.reason === 'error' && typeof value.errorCode === 'string'
        && value.errorCode.length >= 1 && value.errorCode.length <= 128 && /^[A-Za-z0-9_.:-]+$/u.test(value.errorCode)))) {
      return {
        type: value.type,
        streamId: value.streamId,
        hostId: value.hostId,
        connectionId: value.connectionId,
        reason: value.reason,
        ...(typeof value.errorCode === 'string' ? { errorCode: value.errorCode } : {}),
      }
    }
    if (value.type === 'server-ops.stopped' && hasExactKeys(value, ['type'])) return { type: value.type }
  } catch {
    // 下方统一使用稳定协议错误，避免让内部字段名跨越进程边界。
  }
  throw new Error('SERVER_OPS_RUNTIME_MESSAGE_INVALID')
}
