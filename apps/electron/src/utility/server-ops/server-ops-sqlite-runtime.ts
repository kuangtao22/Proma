import { Buffer } from 'node:buffer'
import {
  analyzeServerOpsSqlQuery,
  isServerOpsSqlParserError,
  isServerOpsSqlSensitiveColumn,
  isServerOpsSqliteFilePath,
  limitServerOpsSqlQuery,
  parseServerOpsDataMetricList,
  parseServerOpsDataQueryResult,
  parseServerOpsDataSourceRowsResult,
  parseServerOpsDataSourceTableResult,
  parseServerOpsDataSourceTablesResult,
  parseServerOpsDataRowFilters,
  parseServerOpsDataTableList,
  parseServerOpsDataWarnings,
  SERVER_OPS_DATA_QUERY_TIMEOUT_MS,
} from '@proma/shared'
import type { ServerOpsDataQueryResult } from '@proma/shared'
import type { ServerOpsRuntimeDataReadRequest, ServerOpsRuntimeDataReadResult } from './server-ops-runtime-protocol'
import { getServerOpsSqlQueryPublicError } from './server-ops-query-runtime'
import { SERVER_OPS_SQLITE_REMOTE_SCRIPT } from './server-ops-sqlite-script'

/** 远端 stdout 的硬上限；略高于 schema 行结果合同，用于容纳 envelope。 */
const MAX_REMOTE_STDOUT_BYTES = 1_200_000
/** stderr 只用于判断进程是否异常，不向上透传，仍限制内存占用。 */
const MAX_REMOTE_STDERR_BYTES = 16_384
/** stdin JSON 上限，覆盖 16 KiB SQL 与请求元数据。 */
const MAX_REMOTE_REQUEST_BYTES = 65_536
/** 查询最终 pretty JSON 的共享合同预算。 */
const MAX_QUERY_RESULT_BYTES = 32 * 1_024

/** 可安全公开的 SQLite 稳定错误说明。 */
const SQLITE_PUBLIC_ERROR_MESSAGES = new Map<string, string>([
  ['SERVER_OPS_SQLITE_PYTHON_MISSING', '服务器未安装 Python 3'],
  ['SERVER_OPS_SQLITE_PYTHON_VERSION_UNSUPPORTED', '服务器 Python 版本过低，需要 Python 3.11 或更高版本'],
  ['SERVER_OPS_SQLITE_MODULE_UNAVAILABLE', '服务器 Python 缺少 sqlite3 模块'],
  ['SERVER_OPS_SQLITE_FILE_NOT_FOUND', 'SQLite 文件不存在'],
  ['SERVER_OPS_SQLITE_FILE_NOT_REGULAR', 'SQLite 路径不是普通文件'],
  ['SERVER_OPS_SQLITE_FILE_PERMISSION_DENIED', '当前 SSH 用户没有读取 SQLite 文件的权限'],
  ['SERVER_OPS_SQLITE_FILE_UNAVAILABLE', 'SQLite 文件暂时不可用'],
  ['SERVER_OPS_SQLITE_DATABASE_INVALID', '文件不是有效的 SQLite 数据库或数据库已损坏'],
  ['SERVER_OPS_SQLITE_DATABASE_LOCKED', 'SQLite 数据库正被锁定，请稍后重试'],
  ['SERVER_OPS_SQLITE_TIMEOUT', 'SQLite 读取超时'],
  ['SERVER_OPS_SQLITE_PATH_INVALID', 'SQLite 文件路径无效'],
  ['SERVER_OPS_SQLITE_TABLE_REQUIRED', '缺少要读取的 SQLite 表'],
  ['SERVER_OPS_SQLITE_MODE_UNSUPPORTED', '当前 SQLite 读取模式不受支持'],
  ['SERVER_OPS_SQLITE_RESULT_TOO_LARGE', 'SQLite 返回结果超过安全上限'],
  ['SERVER_OPS_SQLITE_REQUEST_INVALID', 'SQLite 读取请求无效'],
  ['SERVER_OPS_SQLITE_READ_FAILED', 'SQLite 读取失败，请检查文件状态与读取权限'],
  ['SERVER_OPS_DATA_SCHEMA_FILTERS_INVALID', '筛选条件无效或字段不可用于筛选'],
])

/** SSH exec channel 的 stderr 最小接口。 */
export interface ServerOpsSqliteStderr {
  on(event: 'data', listener: (data: Uint8Array | string) => void): this
}

/** SQLite 适配器使用的 SSH ClientChannel 窄接口。 */
export interface ServerOpsSqliteChannel {
  stderr: ServerOpsSqliteStderr
  on(event: 'data', listener: (data: Uint8Array | string) => void): this
  once(event: 'close', listener: (code?: number, signal?: string) => void): this
  once(event: 'error', listener: (error: unknown) => void): this
  write(data: string | Uint8Array): boolean
  destroy(error?: Error): void
  signal?(name: 'TERM', callback?: (error?: Error) => void): void
}

/** 通过当前已认证 SSH client 启动固定远端命令。 */
export type ServerOpsSqliteChannelFactory = (command: string) => Promise<ServerOpsSqliteChannel>

/** 携带稳定码与固定中文说明的 SQLite 公开错误。 */
export class ServerOpsSqlitePublicError extends Error {
  /** 稳定机器码，供 utility/main 白名单透传。 */
  readonly code: string
  /** 固定中文说明，不包含路径、SQL 或业务值。 */
  readonly publicMessage: string

  /** 创建一个已在白名单中的公开错误。 */
  constructor(code: string, publicMessage: string) {
    super(code)
    this.name = 'ServerOpsSqlitePublicError'
    this.code = code
    this.publicMessage = publicMessage
  }
}

/** 远端 Python 成功或失败 envelope。 */
type ServerOpsSqliteRemoteEnvelope =
  | { ok: true; result: unknown }
  | { ok: false; code: string }

/** 判断未知值是否为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 把固定程序安全包进 POSIX shell 单引号，命令中永远不含用户数据。 */
function quoteShellLiteral(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

/** 固定 Python 命令；所有动态值只能通过 stdin 传递。 */
export const SERVER_OPS_SQLITE_COMMAND = `python3 -I -S -c ${quoteShellLiteral(SERVER_OPS_SQLITE_REMOTE_SCRIPT)}`

/** 从稳定码创建不携带原始异常内容的公开错误。 */
function createPublicError(code: string): ServerOpsSqlitePublicError {
  /** 未知远端码统一降级，禁止伪造任意 message。 */
  const normalizedCode = SQLITE_PUBLIC_ERROR_MESSAGES.has(code) || getServerOpsSqlQueryPublicError(new Error(code)) !== undefined
    ? code
    : 'SERVER_OPS_SQLITE_READ_FAILED'
  /** SQL 公共错误沿用既有说明，SQLite 专属错误从本地白名单读取。 */
  const queryError = getServerOpsSqlQueryPublicError(new Error(normalizedCode))
  const publicMessage = SQLITE_PUBLIC_ERROR_MESSAGES.get(normalizedCode) ?? queryError?.message ?? 'SQLite 读取失败，请检查文件状态与读取权限'
  return new ServerOpsSqlitePublicError(normalizedCode, publicMessage)
}

/**
 * 读取 SQLite 异常的公开稳定码与固定说明。
 *
 * @param error SQLite adapter 或共享 SQL parser 抛出的异常
 * @returns 白名单命中时返回公开信息，否则返回 null
 */
export function getServerOpsSqlitePublicError(error: unknown): { code: string; message: string } | null {
  if (error instanceof ServerOpsSqlitePublicError) return { code: error.code, message: error.publicMessage }
  const queryError = getServerOpsSqlQueryPublicError(error)
  return queryError === undefined ? null : queryError
}

/** 检查请求文本字段是否有界且不含控制字符。 */
function isBoundedText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/u.test(value)
}

/** 在开始远端命令前完成 SQLite 专属请求校验。 */
function validateInput(input: ServerOpsRuntimeDataReadRequest): void {
  if (input.transport !== 'ssh' || input.engine !== 'sqlite') throw createPublicError('SERVER_OPS_SQLITE_REQUEST_INVALID')
  if (!isServerOpsSqliteFilePath(input.filePath)) throw createPublicError('SERVER_OPS_SQLITE_PATH_INVALID')
  if (input.address !== undefined || input.port !== undefined || input.username !== undefined || input.password !== undefined
    || input.tlsMode !== 'disabled' || input.tlsServerName !== undefined) throw createPublicError('SERVER_OPS_SQLITE_REQUEST_INVALID')
  if (input.database !== undefined && input.database !== 'main') throw createPublicError('SERVER_OPS_SQLITE_REQUEST_INVALID')
  if (input.schemaDatabase !== undefined && input.schemaDatabase !== 'main') throw createPublicError('SERVER_OPS_SQLITE_REQUEST_INVALID')
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 600_000) {
    throw createPublicError('SERVER_OPS_SQLITE_REQUEST_INVALID')
  }
  if (input.mode === 'schema-table' || input.mode === 'schema-rows') {
    if (!isBoundedText(input.schemaTable, 128)) throw createPublicError('SERVER_OPS_SQLITE_TABLE_REQUIRED')
  }
  if (input.mode === 'schema-rows') {
    if (!Number.isSafeInteger(input.rowOffset) || (input.rowOffset ?? -1) < 0 || (input.rowOffset ?? 0) > 1_000_000
      || !Number.isSafeInteger(input.rowLimit) || (input.rowLimit ?? 0) < 1 || (input.rowLimit ?? 0) > 200
      || (input.rowOffset ?? 0) % (input.rowLimit ?? 1) !== 0) {
      throw createPublicError('SERVER_OPS_SQLITE_REQUEST_INVALID')
    }
    if (input.rowFilters !== undefined) {
      try { parseServerOpsDataRowFilters(input.rowFilters) } catch { throw createPublicError('SERVER_OPS_DATA_SCHEMA_FILTERS_INVALID') }
    }
  }
}

/** 把共享 parser 异常归一为 SQL 查询稳定码。 */
function normalizeQueryParserError(error: unknown): never {
  if (isServerOpsSqlParserError(error) && error.code === 'SERVER_OPS_SQL_SENSITIVE_COLUMN') {
    throw createPublicError('SERVER_OPS_DATA_QUERY_SENSITIVE_COLUMN')
  }
  if (isServerOpsSqlParserError(error)) throw error
  throw createPublicError('SERVER_OPS_DATA_QUERY_SQL_INVALID')
}

/** 构造只含安全、已校验字段的远端 stdin JSON。 */
function createRemotePayload(input: ServerOpsRuntimeDataReadRequest): Record<string, unknown> {
  /** 所有请求共享且由本地校验过的固定字段。 */
  const base: Record<string, unknown> = {
    mode: input.mode,
    filePath: input.filePath,
    timeoutMs: Math.min(
      input.mode === 'sql-query' || input.mode === 'schema-rows' ? SERVER_OPS_DATA_QUERY_TIMEOUT_MS : 15_000,
      Math.max(250, input.timeoutMs),
    ),
  }
  if (input.mode === 'schema-tables' || input.mode === 'diagnostics' || input.mode === 'probe') return base
  if (input.mode === 'schema-table') return { ...base, schemaTable: input.schemaTable }
  if (input.mode === 'schema-rows') {
    return {
      ...base, schemaTable: input.schemaTable, rowOffset: input.rowOffset, rowLimit: input.rowLimit,
      ...(input.rowFilters === undefined ? {} : { rowFilters: input.rowFilters }),
    }
  }
  /** 查询行数上限先保存到局部值，使 TypeScript 与运行时使用同一窄化结果。 */
  const maxRows = input.maxRows
  if (input.mode !== 'sql-query' || !isBoundedText(input.queryId, 128)
    || typeof input.sql !== 'string' || typeof maxRows !== 'number' || !Number.isSafeInteger(maxRows)
    || maxRows < 1 || maxRows > 200) {
    throw createPublicError('SERVER_OPS_SQLITE_REQUEST_INVALID')
  }
  try {
    /** 共享 AST parser 负责拒绝写入、多语句、跨库、危险函数和显式敏感列。 */
    const plan = analyzeServerOpsSqlQuery(input.sql, 'main', 'sqlite')
    for (const column of plan.columns) {
      if (isServerOpsSqlSensitiveColumn(column.column)) throw createPublicError('SERVER_OPS_DATA_QUERY_SENSITIVE_COLUMN')
    }
    return {
      ...base,
      queryId: input.queryId,
      sql: limitServerOpsSqlQuery(plan, maxRows),
      maxRows,
      allowedTables: plan.tables,
      hasWildcard: plan.hasWildcard,
    }
  } catch (error) {
    if (error instanceof ServerOpsSqlitePublicError) throw error
    return normalizeQueryParserError(error)
  }
}

/** 幂等发送 TERM 并销毁 SSH channel。 */
function terminateChannel(channel: ServerOpsSqliteChannel): void {
  try { channel.signal?.('TERM', () => undefined) } catch { /* SSH 服务端不支持 signal 时仍继续销毁。 */ }
  try { channel.destroy() } catch { /* 已关闭 channel 无需重复处理。 */ }
}

/** 在固定命令上执行一次 stdin/stdout JSON 交换。 */
async function executeRemote(
  payload: Record<string, unknown>,
  createChannel: ServerOpsSqliteChannelFactory,
  signal?: AbortSignal,
): Promise<unknown> {
  /** 请求序列化后执行最终字节预算，避免 stdin 无界。 */
  const requestJson = JSON.stringify(payload)
  if (Buffer.byteLength(requestJson, 'utf8') > MAX_REMOTE_REQUEST_BYTES) throw createPublicError('SERVER_OPS_SQLITE_REQUEST_INVALID')
  if (signal?.aborted) throw new Error('SERVER_OPS_DATA_CANCELLED')

  /** channel 创建失败必须收口，不能透传 ssh2 原始错误。 */
  let channel: ServerOpsSqliteChannel
  try {
    channel = await createChannel(SERVER_OPS_SQLITE_COMMAND)
  } catch {
    if (signal?.aborted) throw new Error('SERVER_OPS_DATA_CANCELLED')
    throw createPublicError('SERVER_OPS_SQLITE_READ_FAILED')
  }
  if (signal?.aborted) {
    terminateChannel(channel)
    throw new Error('SERVER_OPS_DATA_CANCELLED')
  }

  return await new Promise<unknown>((resolve, reject) => {
    /** stdout 分块，受总字节数约束。 */
    const stdoutChunks: Buffer[] = []
    /** stderr 只累计长度，不向错误或日志回显内容。 */
    let stderrBytes = 0
    /** stdout 当前累计字节数。 */
    let stdoutBytes = 0
    /** Promise 是否已经进入唯一终态。 */
    let settled = false
    /** 本地兜底超时略晚于远端硬墙钟，处理远端退出通知丢失或 SSH channel 卡住。 */
    const localTimeout = setTimeout(() => {
      terminateChannel(channel)
      finish(createPublicError(payload.mode === 'sql-query' ? 'SERVER_OPS_DATA_QUERY_TIMEOUT' : 'SERVER_OPS_SQLITE_TIMEOUT'))
    }, Number(payload.timeoutMs) + 1_000)

    /** 统一完成并释放取消监听。 */
    const finish = (error?: Error, result?: unknown): void => {
      if (settled) return
      settled = true
      clearTimeout(localTimeout)
      signal?.removeEventListener('abort', onAbort)
      if (error !== undefined) reject(error)
      else resolve(result)
    }
    /** 取消不等待远端回调，立即终止独占进程与通道。 */
    const onAbort = (): void => {
      terminateChannel(channel)
      finish(new Error('SERVER_OPS_DATA_CANCELLED'))
    }

    channel.on('data', (chunk) => {
      if (settled) return
      /** Buffer.from 同时接受 SSH Buffer 与字符串测试替身。 */
      const buffer = Buffer.from(chunk)
      stdoutBytes += buffer.byteLength
      if (stdoutBytes > MAX_REMOTE_STDOUT_BYTES) {
        terminateChannel(channel)
        finish(createPublicError('SERVER_OPS_SQLITE_RESULT_TOO_LARGE'))
        return
      }
      stdoutChunks.push(buffer)
    })
    channel.stderr.on('data', (chunk) => {
      if (settled) return
      stderrBytes += Buffer.byteLength(Buffer.from(chunk))
      if (stderrBytes > MAX_REMOTE_STDERR_BYTES) {
        terminateChannel(channel)
        finish(createPublicError('SERVER_OPS_SQLITE_READ_FAILED'))
      }
    })
    channel.once('error', () => {
      if (signal?.aborted) finish(new Error('SERVER_OPS_DATA_CANCELLED'))
      else finish(createPublicError('SERVER_OPS_SQLITE_READ_FAILED'))
    })
    channel.once('close', (exitCode) => {
      if (settled) return
      if (signal?.aborted) {
        finish(new Error('SERVER_OPS_DATA_CANCELLED'))
        return
      }
      /** shell 的 127 表示固定 python3 命令不存在。 */
      if (exitCode === 127) {
        finish(createPublicError('SERVER_OPS_SQLITE_PYTHON_MISSING'))
        return
      }
      if (exitCode === 124) {
        finish(createPublicError(payload.mode === 'sql-query' ? 'SERVER_OPS_DATA_QUERY_TIMEOUT' : 'SERVER_OPS_SQLITE_TIMEOUT'))
        return
      }
      if (exitCode !== undefined && exitCode !== 0) {
        finish(createPublicError('SERVER_OPS_SQLITE_READ_FAILED'))
        return
      }
      try {
        /** 远端 stdout 只能是唯一 JSON envelope。 */
        const parsed: unknown = JSON.parse(Buffer.concat(stdoutChunks).toString('utf8'))
        if (!isRecord(parsed) || typeof parsed.ok !== 'boolean') throw createPublicError('SERVER_OPS_SQLITE_READ_FAILED')
        const keys = Object.keys(parsed).sort().join(',')
        if (parsed.ok === false) {
          if (keys !== 'code,ok' || typeof parsed.code !== 'string') throw createPublicError('SERVER_OPS_SQLITE_READ_FAILED')
          finish(createPublicError(parsed.code))
          return
        }
        if (keys !== 'ok,result') throw createPublicError('SERVER_OPS_SQLITE_READ_FAILED')
        finish(undefined, parsed.result)
      } catch (error) {
        finish(error instanceof ServerOpsSqlitePublicError ? error : createPublicError('SERVER_OPS_SQLITE_READ_FAILED'))
      }
    })
    if (signal !== undefined) signal.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) {
      onAbort()
      return
    }
    try {
      /** 单行 JSON 足以让远端 readline 开始执行；保持写端打开才能在取消时发送 SSH signal。 */
      channel.write(`${requestJson}\n`)
    } catch {
      terminateChannel(channel)
      finish(createPublicError('SERVER_OPS_SQLITE_READ_FAILED'))
    }
  })
}

/** 按 32 KiB pretty JSON 预算逐行收口查询结果。 */
function parseBudgetedQueryResult(value: unknown): ServerOpsDataQueryResult {
  if (!isRecord(value) || !Array.isArray(value.rows)) throw createPublicError('SERVER_OPS_SQLITE_READ_FAILED')
  /** 先用空行结果严格验证全部元数据字段。 */
  const base = parseServerOpsDataQueryResult({ ...value, rows: [], rowCount: 0, truncated: Boolean(value.truncated) })
  /** 逐行独立校验，避免把畸形远端单元格误判成预算截断。 */
  const validatedRows = value.rows.map((row) => parseServerOpsDataQueryResult({
    ...base, rows: [row], rowCount: 1, truncated: base.truncated,
  }).rows[0]!)
  /** 已接受行始终保持数据库原顺序。 */
  const accepted: ServerOpsDataQueryResult['rows'] = []
  /** 是否因总字节预算丢弃了后续行。 */
  let budgetTruncated = false
  for (const row of validatedRows) {
    const candidate = { ...base, rows: [...accepted, row], rowCount: accepted.length + 1, truncated: base.truncated }
    if (Buffer.byteLength(JSON.stringify(candidate, null, 2), 'utf8') > MAX_QUERY_RESULT_BYTES) {
      budgetTruncated = true
      break
    }
    accepted.push(row)
  }
  return parseServerOpsDataQueryResult({
    ...base,
    rows: accepted,
    rowCount: accepted.length,
    truncated: base.truncated || budgetTruncated || accepted.length < validatedRows.length,
  })
}

/** 按请求 mode 严格解析 Python 返回并恢复 runtime 协议字段。 */
function parseRemoteResult(input: ServerOpsRuntimeDataReadRequest, value: unknown): ServerOpsRuntimeDataReadResult {
  if (!isRecord(value)) throw createPublicError('SERVER_OPS_SQLITE_READ_FAILED')
  if (input.mode === 'sql-query') {
    const parsed = parseBudgetedQueryResult(value)
    if (parsed.queryId !== input.queryId || parsed.database !== 'main') throw createPublicError('SERVER_OPS_SQLITE_READ_FAILED')
    return parsed
  }
  if (input.mode === 'schema-tables') {
    if (value.mode !== input.mode || value.capability !== 'available') throw createPublicError('SERVER_OPS_SQLITE_READ_FAILED')
    const parsed = parseServerOpsDataSourceTablesResult({
      databases: value.databases,
      tables: value.tables,
      ...(value.database === undefined ? {} : { database: value.database }),
      ...(value.databasesTruncated === undefined ? {} : { databasesTruncated: value.databasesTruncated }),
      ...(value.tablesTruncated === undefined ? {} : { tablesTruncated: value.tablesTruncated }),
    })
    return { mode: input.mode, capability: 'available', ...parsed, warnings: parseServerOpsDataWarnings(value.warnings) }
  }
  if (input.mode === 'schema-table') {
    if (value.mode !== input.mode || value.capability !== 'available') throw createPublicError('SERVER_OPS_SQLITE_READ_FAILED')
    const parsed = parseServerOpsDataSourceTableResult({ columns: value.columns, indexes: value.indexes })
    return { mode: input.mode, capability: 'available', ...parsed, warnings: parseServerOpsDataWarnings(value.warnings) }
  }
  if (input.mode === 'schema-rows') {
    if (value.mode !== input.mode || value.capability !== 'available') throw createPublicError('SERVER_OPS_SQLITE_READ_FAILED')
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
    return { mode: input.mode, capability: 'available', ...parsed, warnings: parseServerOpsDataWarnings(value.warnings) }
  }
  /** probe 与 diagnostics 使用同一无 mode 结果合同。 */
  if (value.capability !== 'available' || typeof value.serverVersion !== 'string'
    || value.serverVersion.length < 1 || value.serverVersion.length > 128) throw createPublicError('SERVER_OPS_SQLITE_READ_FAILED')
  return {
    capability: 'available',
    serverVersion: value.serverVersion,
    metrics: parseServerOpsDataMetricList(value.metrics),
    tables: parseServerOpsDataTableList(value.tables),
    warnings: parseServerOpsDataWarnings(value.warnings),
  }
}

/**
 * 通过当前 SSH 连接在远端以只读方式读取 SQLite 文件。
 *
 * @param input 已由 runtime protocol 解析的数据读取请求
 * @param createChannel 在已认证主机上执行固定命令的 channel factory
 * @param signal 用户取消信号；触发后发送 TERM 并关闭 channel
 * @returns 与既有 MySQL 表浏览/查询一致的 runtime 结果合同
 */
export async function runServerOpsSqliteRead(
  input: ServerOpsRuntimeDataReadRequest,
  createChannel: ServerOpsSqliteChannelFactory,
  signal?: AbortSignal,
): Promise<ServerOpsRuntimeDataReadResult> {
  validateInput(input)
  const payload = createRemotePayload(input)
  const remoteResult = await executeRemote(payload, createChannel, signal)
  try {
    return parseRemoteResult(input, remoteResult)
  } catch (error) {
    if (error instanceof ServerOpsSqlitePublicError) throw error
    throw createPublicError('SERVER_OPS_SQLITE_READ_FAILED')
  }
}
