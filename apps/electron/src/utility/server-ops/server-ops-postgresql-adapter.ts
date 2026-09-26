import { Buffer } from 'node:buffer'
import { Duplex } from 'node:stream'
import { Client, Query, TypeOverrides } from 'pg'
import type { ClientConfig, QueryArrayConfig } from 'pg'
import {
  analyzeServerOpsSqlQuery,
  formatServerOpsPostgresTable,
  isServerOpsSqlSensitiveColumn,
  limitServerOpsSqlQuery,
  MAX_SERVER_OPS_CELL_BYTES,
  parseServerOpsDataQueryResult,
  parseServerOpsPostgresTable,
  SERVER_OPS_DATA_QUERY_TIMEOUT_MS,
} from '@proma/shared'
import type {
  ServerOpsDataMetric,
  ServerOpsDataParameter,
  ServerOpsDataQueryResult,
  ServerOpsDataSchemaCell,
  ServerOpsDataSchemaColumn,
  ServerOpsDataSchemaIndex,
  ServerOpsDataSchemaTableSummary,
  ServerOpsDataTlsStatus,
} from '@proma/shared'
import type { ServerOpsDataRuntimeInput, ServerOpsDataRuntimeOutput } from './server-ops-data-runtime'
import { buildServerOpsRowFilterSql, getServerOpsRowFilterPublicError } from './server-ops-row-filter-sql'
import { getServerOpsSqlQueryPublicError } from './server-ops-query-runtime'

export { formatServerOpsPostgresTable, parseServerOpsPostgresTable }

/** PostgreSQL 连接配置；密码只在 utility 进程内短暂存在。 */
export interface ServerOpsPostgresqlConnectionOptions {
  address: string
  port: number
  database?: string
  username?: string
  password?: string
  tlsMode: 'disabled' | 'required' | 'verify'
  tlsServerName?: string
  stream?: Duplex
  connectTimeoutMs: number
}

/** 查询字段只保留公开列名；生产驱动额外携带 OID 用于来源核验。 */
interface ServerOpsPostgresqlField {
  name: string
  tableID?: number
  columnID?: number
  dataTypeID?: number
}

/** PostgreSQL 客户端的最小运行接口，测试可注入内存替身。 */
export interface ServerOpsPostgresqlClient {
  query(text: string, values?: readonly unknown[]): Promise<{
    rows: Record<string, unknown>[]
    fields?: readonly ServerOpsPostgresqlField[]
  }>
  connect?(): Promise<void>
  end(): Promise<void>
  streamQuery?(
    text: string,
    onFields: (fields: readonly ServerOpsPostgresqlField[]) => void,
    onRow: (row: readonly unknown[]) => boolean,
  ): Promise<void>
  destroy?(): void
  isDestroyed?(): boolean
  cancel?(createChannel: () => Promise<Duplex>): Promise<void>
  tlsStatus?: ServerOpsDataTlsStatus
  on?(event: 'error', listener: (error: unknown) => void): void
}

/** PostgreSQL 驱动工厂；测试可替换，生产默认创建单个 pg.Client。 */
export type ServerOpsPostgresqlClientFactory = (options: Record<string, unknown>) => ServerOpsPostgresqlClient

/** 固定 PostgreSQL 会话安全参数；全部限定在本次只读事务内。 */
export const SERVER_OPS_POSTGRESQL_STARTUP_STATEMENTS = [
  'BEGIN READ ONLY',
  'SET LOCAL statement_timeout = 10000',
  'SET LOCAL lock_timeout = 10000',
  'SET LOCAL idle_in_transaction_session_timeout = 10000',
  'SET LOCAL standard_conforming_strings = on',
  'SET LOCAL search_path = pg_catalog',
] as const

const MAX_QUERY_RESULT_BYTES = 32 * 1_024
const MAX_SCHEMA_ROWS_RESULT_BYTES = 1_048_576
const MAX_SCHEMA_ROWS_WITH_DIGESTS_BYTES = 2_097_152
const MAX_PARAMETER_RESULT_BYTES = 262_144
const MAX_PARAMETER_VALUE_LENGTH = 1_024
const MAX_QUERY_CELL_LENGTH = 256
const MAX_QUERY_CELL_SOURCE_BYTES = MAX_QUERY_CELL_LENGTH * 4
const SERVER_OPS_POSTGRESQL_CANCEL_SEND_TIMEOUT_MS = 2_000

/** 参数诊断只读取不含路径、连接串和认证材料的固定白名单。 */
const POSTGRES_PARAMETER_NAMES = [
  'autovacuum', 'checkpoint_timeout', 'effective_cache_size', 'listen_addresses', 'log_min_duration_statement',
  'maintenance_work_mem', 'max_connections', 'max_wal_size', 'shared_buffers', 'statement_timeout',
  'timezone', 'track_activities', 'track_counts', 'wal_level', 'work_mem',
] as const

/** 仅允许用户可见 schema，拒绝系统对象避免越权暴露。 */
export function isPostgresqlSystemSchema(schema: string): boolean {
  const normalized = schema.toLowerCase()
  return normalized === 'information_schema' || normalized.startsWith('pg_')
}

/** pg 会对自定义 stream 再调用 connect；包装器只确认已连接，不发起第二条 TCP。 */
class ConnectedPostgresqlStream extends Duplex {
  private connected = false

  constructor(private readonly source: Duplex) {
    super()
    source.on('data', (chunk: Buffer | string) => { this.push(chunk) })
    source.once('end', () => { this.push(null) })
    source.once('error', (error) => { this.destroy(error) })
    source.once('close', () => {
      // TLS 校验失败时 TLSSocket 会在原始 socket close 后补发证书 error；延后一拍避免通用 close 抢先覆盖原因。
      setImmediate(() => { if (!this.destroyed) this.destroy() })
    })
  }

  override _read(): void {}

  override _write(chunk: Buffer, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.source.write(chunk, encoding, callback)
  }

  override _final(callback: (error?: Error | null) => void): void { this.source.end(callback) }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    if (!this.source.destroyed) this.source.destroy(error ?? undefined)
    callback(error)
  }

  /** 物理通道已经连接，下一微任务只补发 pg 等待的 connect 事件。 */
  connect(_port?: number, _host?: string): this {
    if (!this.connected) {
      this.connected = true
      queueMicrotask(() => { if (!this.destroyed) this.emit('connect') })
    }
    return this
  }

  setNoDelay(_enabled?: boolean): this { return this }
  setKeepAlive(_enabled?: boolean, _initialDelay?: number): this { return this }
  ref(): this { (this.source as Duplex & { ref?: () => void }).ref?.(); return this }
  unref(): this { (this.source as Duplex & { unref?: () => void }).unref?.(); return this }
}

/** 每个 client 独立保留需要精确展示的 PostgreSQL 类型原文。 */
function createPostgresqlTypeOverrides(): TypeOverrides {
  const overrides = new TypeOverrides()
  const preserveText = (value: string): string => value
  for (const oid of [20, 114, 1082, 1114, 1184, 1700, 3802]) overrides.setTypeParser(oid, 'text', preserveText)
  return overrides
}

/** 用真实 pg.Client 构造窄接口，任意 SQL 通过 row 事件逐行消费。 */
function defaultPostgresqlClientFactory(options: Record<string, unknown>): ServerOpsPostgresqlClient {
  const client = new Client(options as ClientConfig)
  let destroyed = false
  client.connection.stream.once('close', () => { destroyed = true })
  const adapter: ServerOpsPostgresqlClient = {
    query: async (text: string, values: readonly unknown[] = []) => {
      const result = await client.query<Record<string, unknown>>(text, [...values])
      return { rows: result.rows, fields: result.fields }
    },
    connect: async () => {
      await client.connect()
      const encrypted = (client.connection.stream as Duplex & { encrypted?: boolean }).encrypted === true
      const ssl = options.ssl
      adapter.tlsStatus = encrypted
        ? typeof ssl === 'object' && ssl !== null && (ssl as { rejectUnauthorized?: unknown }).rejectUnauthorized === true ? 'verified' : 'encrypted'
        : 'plaintext'
    },
    end: async () => { await client.end() },
    destroy: () => { destroyed = true; client.connection.stream.destroy() },
    isDestroyed: () => destroyed,
    cancel: async (createChannel) => {
      const identity = client as Client & { processID?: number; secretKey?: number }
      if (!Number.isInteger(identity.processID) || !Number.isInteger(identity.secretKey)) return
      await sendServerOpsPostgresqlCancelRequest(createChannel, identity.processID!, identity.secretKey!)
    },
    on: (event, listener) => { client.on(event, listener) },
    streamQuery: (text, onFields, onRow) => new Promise<void>((resolve, reject) => {
      let stopped = false
      let settled = false
      let emittedFields = false
      const queryConfig: QueryArrayConfig<unknown[]> = { text, rowMode: 'array' }
      const query = new Query(queryConfig)
      /** Query 对象在 transport close 的少数路径不发 error/end，必须由连接事件兜底结算。 */
      const cleanup = (): void => {
        client.removeListener('error', onClientError)
        client.connection.stream.removeListener('close', onStreamClose)
      }
      const finish = (error?: unknown): void => {
        if (settled) return
        settled = true
        cleanup()
        if (error === undefined) resolve()
        else reject(error)
      }
      const onClientError = (error: unknown): void => { finish(error) }
      const onStreamClose = (): void => {
        setImmediate(() => { finish(new Error('SERVER_OPS_DATA_QUERY_FAILED')) })
      }
      client.once('error', onClientError)
      client.connection.stream.once('close', onStreamClose)
      query.on('row', (row: unknown[], result?: { fields: readonly ServerOpsPostgresqlField[] }) => {
        if (stopped) return
        try {
          if (!emittedFields && result) { emittedFields = true; onFields(result.fields) }
          if (!onRow(row)) {
            stopped = true
            destroyed = true
            finish()
            client.connection.stream.destroy()
          }
        } catch (error) {
          stopped = true
          finish(error)
          destroyed = true
          client.connection.stream.destroy()
        }
      })
      query.once('error', (error) => {
        if (stopped) finish()
        else finish(error)
      })
      query.once('end', (result: { fields: readonly ServerOpsPostgresqlField[] }) => {
        if (settled) return
        if (!emittedFields) onFields(result.fields)
        finish()
      })
      client.query(query)
    }),
  }
  return adapter
}

/** 通过独立物理通道发送 PostgreSQL CancelRequest，并在写完后关闭该通道。 */
export async function sendServerOpsPostgresqlCancelRequest(
  createChannel: () => Promise<Duplex>,
  processId: number,
  secretKey: number,
  timeoutMs = SERVER_OPS_POSTGRESQL_CANCEL_SEND_TIMEOUT_MS,
): Promise<void> {
  const cancelChannel = await createChannel()
  /** CancelRequest 无响应正文；消费可读侧 EOF，避免 ssh2 延迟 close 事件。 */
  cancelChannel.resume()
  const packet = Buffer.allocUnsafe(16)
  packet.writeInt32BE(16, 0)
  packet.writeInt32BE(80_877_102, 4)
  packet.writeInt32BE(processId, 8)
  packet.writeInt32BE(secretKey, 12)
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (error?: Error | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      cancelChannel.removeListener('error', onError)
      if (error) reject(error)
      else resolve()
    }
    const onError = (error: Error): void => { finish(error) }
    const timer = setTimeout(() => {
      finish(new Error('SERVER_OPS_DATA_CANCEL_CHANNEL_TIMEOUT'))
    }, timeoutMs)
    cancelChannel.once('error', onError)
    cancelChannel.write(packet, (error) => {
      if (error) { finish(error); return }
      cancelChannel.end(() => { finish() })
    })
  }).finally(() => {
    /** ssh2 Channel 的 destroyed 不代表已发送 CHANNEL_CLOSE；独占取消通道始终显式关闭。 */
    cancelChannel.destroy()
  })
}

/** 直接连接或 SSH 转发均使用单个 pg.Client，TLS 不做 preferred 明文回退。 */
export function createServerOpsPostgresqlClient(
  input: ServerOpsPostgresqlConnectionOptions,
  factory: ServerOpsPostgresqlClientFactory = defaultPostgresqlClientFactory,
): ServerOpsPostgresqlClient {
  if (input.tlsMode === 'verify' && !input.tlsServerName) throw new Error('SERVER_OPS_DATA_TLS_SERVER_NAME_REQUIRED')
  const stream = input.stream === undefined ? undefined : new ConnectedPostgresqlStream(input.stream)
  const options: Record<string, unknown> = {
    /** 显式填写认证与 TLS 字段，禁止继承 PGUSER/PGPASSWORD/PGSSLMODE。 */
    host: input.tlsMode === 'verify' ? input.tlsServerName : input.address,
    port: input.port,
    user: input.username ?? 'postgres',
    password: () => input.password ?? '',
    database: input.database ?? 'postgres',
    connectionTimeoutMillis: input.connectTimeoutMs,
    query_timeout: input.connectTimeoutMs,
    application_name: 'DutyDeck Server Ops',
    client_encoding: 'UTF8',
    replication: 'false',
    sslnegotiation: 'postgres',
    options: '-c default_transaction_read_only=on -c statement_timeout=10000 -c lock_timeout=10000 -c idle_in_transaction_session_timeout=10000 -c standard_conforming_strings=on -c search_path=pg_catalog',
    types: createPostgresqlTypeOverrides(),
    ssl: input.tlsMode === 'disabled' ? false : {
      rejectUnauthorized: input.tlsMode === 'verify',
      ...(input.tlsServerName === undefined ? {} : { servername: input.tlsServerName }),
    },
    ...(stream === undefined ? {} : { stream: () => stream }),
  }
  const client = factory(options)
  return client
}

/** 开启只读事务并固定查询、锁等待与 schema 解析范围。 */
export async function configureServerOpsPostgresqlSession(client: ServerOpsPostgresqlClient): Promise<void> {
  for (const statement of SERVER_OPS_POSTGRESQL_STARTUP_STATEMENTS) await client.query(statement)
}

/** 结束读取事务并关闭连接；回滚失败不得阻止 end。 */
export async function closeServerOpsPostgresqlClient(client: ServerOpsPostgresqlClient): Promise<void> {
  if (client.isDestroyed?.()) return
  try { await client.query('ROLLBACK') } catch { /* 连接随后关闭。 */ }
  await client.end()
}

/** 把数据库值转换成有限展示文本，控制字符替换为空格。 */
function displayText(value: unknown, maximum = 512): string {
  const text = value === null || value === undefined ? '' : String(value)
  const sanitized = text.replace(/[\u0000-\u001f\u007f]/gu, ' ')
  return sanitized.length > maximum ? `${sanitized.slice(0, Math.max(0, maximum - 1))}…` : sanitized
}

/** 从字符串或数字读取安全非负整数。 */
function nonNegativeInteger(value: unknown): number | undefined {
  const numeric = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN
  if (!Number.isFinite(numeric) || numeric < 0) return undefined
  return Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(numeric))
}

/** 标识符只由已验证目录元数据进入此函数。 */
function quoteIdentifier(value: string): string { return `"${value.replaceAll('"', '""')}"` }

/** 读取查询行并在异步边界检查取消。 */
async function queryRows(
  client: ServerOpsPostgresqlClient,
  text: string,
  values: readonly unknown[] = [],
  signal?: AbortSignal,
): Promise<Record<string, unknown>[]> {
  if (signal?.aborted) throw new Error('SERVER_OPS_DATA_CANCELLED')
  const result = await client.query(text, values)
  if (signal?.aborted) throw new Error('SERVER_OPS_DATA_CANCELLED')
  return result.rows
}

/** schemaDatabase 是实际数据库，不能误当 PostgreSQL schema。 */
async function validateCurrentDatabase(client: ServerOpsPostgresqlClient, database: string, signal?: AbortSignal): Promise<void> {
  const rows = await queryRows(client, 'SELECT current_database() AS name', [], signal)
  if (rows.length > 0 && rows[0]?.name !== database) throw new Error('SERVER_OPS_DATA_QUERY_TABLE_UNAVAILABLE')
}

/** 表白名单与列元数据统一从 pg_catalog 实时读取。 */
async function loadTableColumns(
  client: ServerOpsPostgresqlClient,
  tableIdentity: string,
  baseTablesOnly: boolean,
  signal?: AbortSignal,
): Promise<{ schema: string; table: string; columns: ServerOpsDataSchemaColumn[] }> {
  const { schema, table } = parseServerOpsPostgresTable(tableIdentity)
  if (isPostgresqlSystemSchema(schema)) throw new Error('SERVER_OPS_DATA_QUERY_TABLE_UNAVAILABLE')
  const rows = await queryRows(client,
    `SELECT a.attname AS name, pg_catalog.format_type(a.atttypid, a.atttypmod) AS column_type,
      NOT a.attnotnull AS nullable,
      EXISTS (SELECT 1 FROM pg_catalog.pg_index i WHERE i.indrelid = c.oid AND i.indisprimary AND a.attnum = ANY(i.indkey)) AS primary_key,
      LEFT(pg_catalog.pg_get_expr(ad.adbin, ad.adrelid), 256) AS default_text,
      CASE WHEN a.attidentity <> '' THEN 'identity' WHEN a.attgenerated <> '' THEN 'generated' ELSE '' END AS extra,
      LEFT(pg_catalog.col_description(c.oid, a.attnum), 256) AS comment, c.relkind AS relation_kind
    FROM pg_catalog.pg_namespace n
    JOIN pg_catalog.pg_class c ON c.relnamespace = n.oid
    JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid
    LEFT JOIN pg_catalog.pg_attrdef ad ON ad.adrelid = c.oid AND ad.adnum = a.attnum
    WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r', 'p', 'v', 'm')
      AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY a.attnum LIMIT 257`, [schema, table], signal)
  if (rows.length === 0) throw new Error('SERVER_OPS_DATA_QUERY_TABLE_UNAVAILABLE')
  const relationKind = String(rows[0]?.relation_kind ?? '')
  if (baseTablesOnly && relationKind !== 'r' && relationKind !== 'p') throw new Error('SERVER_OPS_DATA_QUERY_TABLE_UNAVAILABLE')
  return { schema, table, columns: rows.slice(0, 256).map((row): ServerOpsDataSchemaColumn => ({
    name: displayText(row.name, 128), type: displayText(row.column_type, 128), nullable: row.nullable === true,
    primaryKey: row.primary_key === true,
    ...(row.default_text === null || row.default_text === undefined ? {} : { defaultText: displayText(row.default_text, 256) }),
    ...(displayText(row.extra, 64) === '' ? {} : { extra: displayText(row.extra, 64) }),
    ...(displayText(row.comment, 256) === '' ? {} : { comment: displayText(row.comment, 256) }),
  })) }
}

/** 对预览结果应用最终 JSON 预算，不丢中间行导致分页错位。 */
function fitSchemaRows(rows: ServerOpsDataSchemaCell[][]): { rows: ServerOpsDataSchemaCell[][]; truncated: boolean } {
  const accepted: ServerOpsDataSchemaCell[][] = []
  for (const row of rows) {
    const candidate = [...accepted, row]
    const withDigests = candidate.some((cells) => cells.some((cell) => typeof cell === 'object' && cell !== null && cell.kind === 'text' && cell.sha256))
    const budget = withDigests ? MAX_SCHEMA_ROWS_WITH_DIGESTS_BYTES : MAX_SCHEMA_ROWS_RESULT_BYTES
    if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') > budget) return { rows: accepted, truncated: true }
    accepted.push(row)
  }
  return { rows: accepted, truncated: false }
}

/** 预览 bytea 只返回大小，敏感列固定遮罩，长文本保留摘要。 */
function formatPreviewCell(row: Record<string, unknown>, column: ServerOpsDataSchemaColumn,
  digestAlias?: string, lengthAlias?: string): ServerOpsDataSchemaCell {
  if (isServerOpsSqlSensitiveColumn(column.name)) return { kind: 'text', text: '[已遮罩]', truncated: true }
  const value = row[column.name]
  if (value === null || value === undefined) return null
  if (/^bytea\b/iu.test(column.type)) return { kind: 'binary', bytes: nonNegativeInteger(value) ?? 0 }
  const text = String(value)
  const digest = digestAlias === undefined ? undefined : row[digestAlias]
  const characterLength = lengthAlias === undefined ? undefined : nonNegativeInteger(row[lengthAlias])
  const truncated = text.length > 256 || (characterLength !== undefined && characterLength > 256)
  return truncated && typeof digest === 'string' && /^[a-f0-9]{64}$/u.test(digest)
    ? { kind: 'text', text: text.slice(0, 256), truncated: true, sha256: digest } : text.slice(0, 256)
}

/** 读取 PostgreSQL 目录、结构、预览与全文。 */
async function readPostgresqlSchema(
  client: ServerOpsPostgresqlClient,
  input: ServerOpsDataRuntimeInput,
  signal?: AbortSignal,
): Promise<ServerOpsDataRuntimeOutput> {
  const database = input.schemaDatabase ?? input.database
  if (!database) throw new Error('SERVER_OPS_DATA_QUERY_TABLE_UNAVAILABLE')
  await validateCurrentDatabase(client, database, signal)
  if (input.mode === 'schema-tables') {
    const databaseRows = await queryRows(client, 'SELECT datname AS name FROM pg_database WHERE datallowconn AND NOT datistemplate ORDER BY datname LIMIT 201', [], signal)
    const search = input.schemaTableSearch
    const tableRows = await queryRows(client,
      `SELECT n.nspname AS schema_name, c.relname AS table_name, c.relkind AS relation_kind,
        GREATEST(c.reltuples, 0)::bigint::text AS rows_estimate, pg_catalog.pg_total_relation_size(c.oid)::text AS size_bytes,
        LEFT(pg_catalog.obj_description(c.oid, 'pg_class'), 256) AS comment
      FROM pg_catalog.pg_namespace n JOIN pg_catalog.pg_class c ON c.relnamespace = n.oid
      WHERE c.relkind IN ('r', 'p', 'v', 'm') AND n.nspname <> 'information_schema' AND n.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
        ${search === undefined ? '' : "AND c.relname ILIKE $1 ESCAPE '!'"}
      ORDER BY n.nspname, c.relname LIMIT 501`, search === undefined ? [] : [`%${search.replace(/[!%_]/gu, (value) => `!${value}`)}%`], signal)
    const tables = tableRows.slice(0, 500).map((row): ServerOpsDataSchemaTableSummary => ({
      name: formatServerOpsPostgresTable(String(row.schema_name), String(row.table_name)),
      type: row.relation_kind === 'v' || row.relation_kind === 'm' ? 'view' : 'table', engine: 'PostgreSQL',
      ...(nonNegativeInteger(row.rows_estimate) === undefined ? {} : { rows: nonNegativeInteger(row.rows_estimate) }),
      ...(nonNegativeInteger(row.size_bytes) === undefined ? {} : { sizeBytes: nonNegativeInteger(row.size_bytes) }),
      ...(displayText(row.comment, 256) === '' ? {} : { comment: displayText(row.comment, 256) }),
    }))
    return { mode: 'schema-tables', capability: 'available', database,
      databases: databaseRows.slice(0, 200).map((row) => displayText(row.name, 64)).filter(Boolean), tables,
      databasesTruncated: databaseRows.length > 200, tablesTruncated: tableRows.length > 500, warnings: [] }
  }
  if (!input.schemaTable) throw new Error('SERVER_OPS_DATA_QUERY_TABLE_UNAVAILABLE')
  const metadata = await loadTableColumns(client, input.schemaTable, input.baseTablesOnly === true, signal)
  if (input.mode === 'schema-table') {
    const indexRows = await queryRows(client,
      `SELECT ic.relname AS name, i.indisunique AS unique, keys.ordinality::int AS sequence, a.attname AS column_name
      FROM pg_catalog.pg_namespace n JOIN pg_catalog.pg_class c ON c.relnamespace = n.oid
      JOIN pg_catalog.pg_index i ON i.indrelid = c.oid JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
      JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS keys(attnum, ordinality) ON true
      LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum = keys.attnum
      WHERE n.nspname = $1 AND c.relname = $2 ORDER BY ic.relname, keys.ordinality LIMIT 2049`,
      [metadata.schema, metadata.table], signal)
    const indexMap = new Map<string, ServerOpsDataSchemaIndex>()
    for (const row of indexRows) {
      const name = displayText(row.name, 128)
      const column = displayText(row.column_name, 128)
      if (!name || !column) continue
      const existing = indexMap.get(name)
      if (existing && existing.columns.length < 16) existing.columns.push(column)
      else if (!existing && indexMap.size < 128) indexMap.set(name, { name, unique: row.unique === true, columns: [column] })
    }
    const indexes = [...indexMap.values()]
    return { mode: 'schema-table', capability: 'available', columns: metadata.columns, indexes, warnings: [] }
  }
  const offset = input.rowOffset ?? 0
  const limit = input.rowLimit ?? 50
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000
    || !Number.isSafeInteger(limit) || limit < 1 || limit > 200 || (input.mode === 'schema-rows' && offset % limit !== 0)) {
    throw new Error('SERVER_OPS_DATA_SCHEMA_FILTERS_INVALID')
  }
  const filter = input.rowFilters === undefined ? { clause: '', values: [] as string[] }
    : buildServerOpsRowFilterSql(input.rowFilters, metadata.columns.map((column) => column.name), 'postgresql')
  const primaryColumns = metadata.columns.filter((column) => column.primaryKey).map((column) => column.name)
  const orderClause = primaryColumns.length === 0 ? '' : ` ORDER BY ${primaryColumns.map(quoteIdentifier).join(', ')}`
  const tableSql = `${quoteIdentifier(metadata.schema)}.${quoteIdentifier(metadata.table)}`
  if (input.mode === 'schema-cell') {
    const column = metadata.columns[input.cellColumnIndex ?? -1]
    if (!column || column.name !== input.cellExpectedColumn || !input.cellSha256) throw new Error('SERVER_OPS_DATA_CELL_CHANGED')
    if (isServerOpsSqlSensitiveColumn(column.name)) throw new Error('SERVER_OPS_DATA_CELL_REDACTED')
    const identifier = quoteIdentifier(column.name)
    if (/^bytea\b/iu.test(column.type)) {
      const rows = await queryRows(client, `SELECT octet_length(${identifier})::text AS value_bytes FROM ${tableSql}${filter.clause}${orderClause} LIMIT 1 OFFSET ${offset}`, filter.values, signal)
      if (rows.length !== 1) throw new Error('SERVER_OPS_DATA_CELL_CHANGED')
      return { mode: 'schema-cell', capability: 'available', value: { kind: 'binary', bytes: nonNegativeInteger(rows[0]?.value_bytes) ?? 0 }, warnings: [] }
    }
    const rows = await queryRows(client,
      `SELECT CASE WHEN octet_length(convert_to(${identifier}::text, 'UTF8')) <= ${MAX_SERVER_OPS_CELL_BYTES} THEN ${identifier}::text END AS value,
        octet_length(convert_to(${identifier}::text, 'UTF8'))::text AS value_bytes,
        encode(sha256(convert_to(${identifier}::text, 'UTF8')), 'hex') AS value_sha256
      FROM ${tableSql}${filter.clause}${orderClause} LIMIT 1 OFFSET ${offset}`, filter.values, signal)
    if (rows.length !== 1) throw new Error('SERVER_OPS_DATA_CELL_CHANGED')
    if ((nonNegativeInteger(rows[0]?.value_bytes) ?? MAX_SERVER_OPS_CELL_BYTES + 1) > MAX_SERVER_OPS_CELL_BYTES) throw new Error('SERVER_OPS_DATA_CELL_TOO_LARGE')
    if (rows[0]?.value_sha256 !== input.cellSha256 || typeof rows[0]?.value !== 'string') throw new Error('SERVER_OPS_DATA_CELL_CHANGED')
    return { mode: 'schema-cell', capability: 'available', value: rows[0].value, warnings: [] }
  }
  const visibleColumns = metadata.columns.slice(0, 64)
  const reservedNames = new Set(metadata.columns.map((column) => column.name))
  let aliasSequence = 0
  /** 内部别名不得与任意真实列重名，否则对象行会覆盖用户值。 */
  const createInternalAlias = (kind: 'digest' | 'length'): string => {
    for (;;) {
      const alias = `__proma_${kind}_${aliasSequence++}`
      if (!reservedNames.has(alias)) { reservedNames.add(alias); return alias }
    }
  }
  const previewColumns = visibleColumns.map((column) => ({
    column,
    ...(isServerOpsSqlSensitiveColumn(column.name) || /^bytea\b/iu.test(column.type) ? {} : {
      digestAlias: createInternalAlias('digest'), lengthAlias: createInternalAlias('length'),
    }),
  }))
  const projections = previewColumns.flatMap(({ column, digestAlias, lengthAlias }) => {
    const identifier = quoteIdentifier(column.name)
    if (isServerOpsSqlSensitiveColumn(column.name)) return [`'[已遮罩]'::text AS ${identifier}`]
    if (/^bytea\b/iu.test(column.type)) return [`octet_length(${identifier})::text AS ${identifier}`]
    return [`LEFT(${identifier}::text, 256) AS ${identifier}`,
      `char_length(${identifier}::text)::text AS ${quoteIdentifier(lengthAlias!)}`,
      `encode(sha256(convert_to(${identifier}::text, 'UTF8')), 'hex') AS ${quoteIdentifier(digestAlias!)}`]
  })
  const rowResult = await client.query(`SELECT ${projections.join(', ')} FROM ${tableSql}${filter.clause}${orderClause} LIMIT ${limit + 1} OFFSET ${offset}`, filter.values)
  const hasMore = rowResult.rows.length > limit
  const normalized = rowResult.rows.slice(0, limit).map((row) => previewColumns.map(({ column, digestAlias, lengthAlias }) =>
    formatPreviewCell(row, column, digestAlias, lengthAlias)))
  const fitted = fitSchemaRows(normalized)
  const truncatedCells = normalized.some((row) => row.some((cell) => typeof cell === 'object' && cell !== null && cell.kind === 'text'))
  return { mode: 'schema-rows', capability: 'available', columns: visibleColumns.map((column) => column.name), rows: fitted.rows,
    offset, limit, truncated: metadata.columns.length > 64 || truncatedCells || fitted.truncated, hasMore,
    orderedByPrimaryKey: primaryColumns.length > 0,
    warnings: metadata.columns.length > 64 ? ['表列数超过 64，当前预览只显示前 64 列'] : [] }
}

/** 最终结果按 pretty JSON 预算逐行接受。 */
function fitQueryResult(base: Omit<ServerOpsDataQueryResult, 'rows' | 'rowCount' | 'truncated'>,
  rows: ServerOpsDataSchemaCell[][], truncated: boolean): ServerOpsDataQueryResult {
  const accepted: ServerOpsDataSchemaCell[][] = []
  let resultTruncated = truncated
  for (const row of rows) {
    const candidate = { ...base, rows: [...accepted, row], rowCount: accepted.length + 1, truncated: resultTruncated }
    if (Buffer.byteLength(JSON.stringify(candidate, null, 2), 'utf8') > MAX_QUERY_RESULT_BYTES) { resultTruncated = true; break }
    accepted.push(row)
  }
  return parseServerOpsDataQueryResult({ ...base, rows: accepted, rowCount: accepted.length, truncated: resultTruncated || accepted.length < rows.length })
}

/** 校验 SQL 计划引用的基础表与显式列。 */
async function validateSqlPlan(client: ServerOpsPostgresqlClient, tables: readonly string[],
  columns: ReadonlyArray<{ column: string; outputAlias?: boolean; sourceTable?: string }>, hasWildcard: boolean,
  signal?: AbortSignal): Promise<void> {
  const columnsByTable = new Map<string, Set<string>>()
  for (const identity of tables) {
    const metadata = await loadTableColumns(client, identity, true, signal)
    columnsByTable.set(identity, new Set(metadata.columns.map((column) => column.name)))
  }
  if (hasWildcard) return
  for (const column of columns) {
    if (column.outputAlias === true) continue
    if (isServerOpsSqlSensitiveColumn(column.column)) throw new Error('SERVER_OPS_DATA_QUERY_SENSITIVE_COLUMN')
    const candidates = column.sourceTable ? [columnsByTable.get(column.sourceTable)] : [...columnsByTable.values()]
    if (!candidates.some((values) => values?.has(column.column) === true)) throw new Error('SERVER_OPS_DATA_QUERY_COLUMN_UNAVAILABLE')
  }
}

/** 执行 parser 重建后的 PostgreSQL 单 SELECT，生产使用逐行 Query 事件。 */
async function readPostgresqlSql(client: ServerOpsPostgresqlClient,
  input: Extract<ServerOpsDataRuntimeInput, { mode: 'sql-query' }>, signal?: AbortSignal): Promise<ServerOpsDataQueryResult> {
  const startedAt = Date.now()
  const plan = analyzeServerOpsSqlQuery(input.sql, input.database, 'postgresql')
  await validateSqlPlan(client, plan.tables, plan.columns, plan.hasWildcard, signal)
  const limitedSql = limitServerOpsSqlQuery(plan, input.maxRows)
  /** LIMIT 0 只取得字段元数据，先于任何可能包含大值的 DataRow。 */
  const metadataResult = await client.query(`SELECT * FROM (${limitedSql}) AS "__proma_metadata" LIMIT 0`)
  const fields = metadataResult.fields ?? []
  if (fields.length === 0 || fields.length > 64) throw new Error(fields.length > 64 ? 'SERVER_OPS_DATA_QUERY_TOO_MANY_COLUMNS' : 'SERVER_OPS_DATA_UNEXPECTED_RESULT')
  /** 子查询按序重命名，兼容用户 SELECT 产生重复列名。 */
  const sourceAliases = fields.map((_, index) => `__proma_source_${index}`)
  interface QueryProjection {
    kind: 'binary' | 'sensitive' | 'text'
    valueAlias: string
    sizeAlias?: string
  }
  const projections: QueryProjection[] = fields.map((field, index) => ({
    kind: isServerOpsSqlSensitiveColumn(field.name) ? 'sensitive' : field.dataTypeID === 17 ? 'binary' : 'text',
    valueAlias: `__proma_value_${index}`,
    ...(isServerOpsSqlSensitiveColumn(field.name) || field.dataTypeID === 17 ? {} : { sizeAlias: `__proma_size_${index}` }),
  }))
  const projectionSql = projections.map((projection, index) => {
    const source = quoteIdentifier(sourceAliases[index]!)
    const valueAlias = quoteIdentifier(projection.valueAlias)
    if (projection.kind === 'sensitive') return `'[已遮罩]'::text AS ${valueAlias}`
    if (projection.kind === 'binary') return `octet_length(${source})::text AS ${valueAlias}`
    const size = `octet_length(convert_to(${source}::text, 'UTF8'))`
    return `CASE WHEN ${size} <= ${MAX_QUERY_CELL_SOURCE_BYTES} THEN ${source}::text END AS ${valueAlias}, ${size}::text AS ${quoteIdentifier(projection.sizeAlias!)}`
  })
  const sql = `SELECT ${projectionSql.join(', ')} FROM (${limitedSql}) AS "__proma_result"(${sourceAliases.map(quoteIdentifier).join(', ')})`
  const rows: ServerOpsDataSchemaCell[][] = []
  let truncated = false
  /** 服务端投影后立即归一化单行，utility 永远不会收到超限正文。 */
  const acceptRow = (raw: readonly unknown[]): boolean => {
    if (rows.length >= input.maxRows) { truncated = true; return false }
    let valueIndex = 0
    const row = projections.map((projection): ServerOpsDataSchemaCell => {
      const value = raw[valueIndex++]
      if (projection.kind === 'sensitive') return { kind: 'text', text: '[已遮罩]', truncated: true }
      if (projection.kind === 'binary') return value === null || value === undefined ? null : { kind: 'binary', bytes: nonNegativeInteger(value) ?? 0 }
      const size = raw[valueIndex++]
      if (size === null || size === undefined) return null
      const sourceBytes = nonNegativeInteger(size)
      if (sourceBytes === undefined || sourceBytes > MAX_QUERY_CELL_SOURCE_BYTES || typeof value !== 'string') {
        throw new Error('SERVER_OPS_DATA_QUERY_COLUMN_TOO_LARGE')
      }
      if (value.length <= MAX_QUERY_CELL_LENGTH) return value
      truncated = true
      return { kind: 'text', text: value.slice(0, MAX_QUERY_CELL_LENGTH), truncated: true }
    })
    if (Buffer.byteLength(JSON.stringify({ columns: fields.map((field) => field.name), rows: [...rows, row] }), 'utf8') > MAX_QUERY_RESULT_BYTES) {
      truncated = true
      return false
    }
    rows.push(row)
    return true
  }
  if (client.streamQuery) {
    /** 服务端 statement_timeout 是主保护；额外宽限 500ms 后硬关连接，覆盖 pg 丢失 ErrorResponse 的自定义 stream 边界。 */
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        client.destroy?.()
        reject(new Error('SERVER_OPS_DATA_QUERY_TIMEOUT'))
      }, SERVER_OPS_DATA_QUERY_TIMEOUT_MS + 500)
      void client.streamQuery!(sql, () => undefined, acceptRow).then(
        () => { clearTimeout(timer); resolve() },
        (error: unknown) => { clearTimeout(timer); reject(error) },
      )
    })
  } else {
    const result = await client.query(sql)
    const resultFields = result.fields ?? projections.flatMap((projection) => [projection.valueAlias, projection.sizeAlias].filter((value): value is string => value !== undefined).map((name) => ({ name })))
    for (const row of result.rows) if (!acceptRow(resultFields.map((field) => row[field.name]))) break
  }
  if (signal?.aborted) throw new Error('SERVER_OPS_DATA_CANCELLED')
  return fitQueryResult({ queryId: input.queryId, database: input.database, columns: fields.map((field) => displayText(field.name, 128)),
    durationMs: Math.max(0, Date.now() - startedAt), warnings: [] }, rows, truncated)
}

/** PostgreSQL probe 与分区诊断；statements 明确不隐式启用扩展。 */
async function readPostgresqlDiagnostics(client: ServerOpsPostgresqlClient, input: ServerOpsDataRuntimeInput,
  signal?: AbortSignal): Promise<ServerOpsDataRuntimeOutput> {
  const versionRows = await queryRows(client, 'SELECT pg_catalog.version() AS version', [], signal)
  const version = displayText(versionRows[0]?.version, 128)
  if (input.mode === 'probe') return { capability: 'available', serverVersion: version, tlsStatus: client.tlsStatus, metrics: [], tables: [], warnings: [] }
  if (input.diagnosticSection === 'statements') return { capability: 'unsupported', serverVersion: version, tlsStatus: client.tlsStatus,
    metrics: [], tables: [], warnings: ['PostgreSQL 语句统计需要 pg_stat_statements，当前未自动启用'] }
  const section = input.diagnosticSection
  const warnings: string[] = []
  const metrics: ServerOpsDataMetric[] = []
  const tables: import('@proma/shared').ServerOpsDataTable[] = []
  let parameters: ServerOpsDataParameter[] | undefined
  let parametersTruncated: boolean | undefined
  if (section === undefined || section === 'overview') {
    try {
      const rows = await queryRows(client,
        `SELECT pg_catalog.pg_size_pretty(pg_catalog.pg_database_size(current_database())) AS database_size,
          (SELECT count(*)::text FROM pg_catalog.pg_stat_activity) AS total_connections,
          (SELECT count(*)::text FROM pg_catalog.pg_stat_activity WHERE state = 'active') AS active_connections,
          pg_catalog.date_trunc('second', clock_timestamp() - pg_catalog.pg_postmaster_start_time())::text AS uptime,
          CASE WHEN (blks_hit + blks_read) = 0 THEN '0.00' ELSE pg_catalog.round(100.0 * blks_hit / (blks_hit + blks_read), 2)::text END AS cache_hit_ratio
        FROM pg_catalog.pg_stat_database WHERE datname = current_database()`, [], signal)
      const row = rows[0]
      if (row?.database_size !== undefined) metrics.push({ id: 'database-size', label: '当前库大小', value: displayText(row.database_size, 128) })
      if (row?.total_connections !== undefined) metrics.push({ id: 'connections', label: '连接数', value: displayText(row.total_connections, 128), hint: `活跃 ${displayText(row.active_connections, 64)}` })
      if (row?.uptime !== undefined) metrics.push({ id: 'uptime', label: '运行时长', value: displayText(row.uptime, 128) })
      if (row?.cache_hit_ratio !== undefined) metrics.push({ id: 'cache-hit', label: '缓存命中率', value: `${displayText(row.cache_hit_ratio, 64)}%` })
      const databaseRows = await queryRows(client,
        `SELECT datname AS name, pg_catalog.pg_size_pretty(pg_catalog.pg_database_size(datname)) AS size
        FROM pg_database WHERE datallowconn AND NOT datistemplate ORDER BY pg_catalog.pg_database_size(datname) DESC LIMIT 50`, [], signal)
      tables.push({ id: 'databases', title: '数据库容量', columns: [{ id: 'name', label: '数据库' }, { id: 'size', label: '容量', align: 'right' }],
        rows: databaseRows.map((entry) => [displayText(entry.name, 128), displayText(entry.size, 128)]), truncated: false })
    } catch { warnings.push('无法读取 PostgreSQL 实例概览（可能缺少统计权限）') }
  }
  if (section === undefined || section === 'sessions') {
    try {
      const values = input.diagnosticDatabase === undefined ? [] : [input.diagnosticDatabase]
      const rows = await queryRows(client,
        `SELECT pid::text AS pid, usename AS username, datname AS database, client_addr::text AS client,
          state, wait_event_type, pg_catalog.date_trunc('second', clock_timestamp() - backend_start)::text AS age
        FROM pg_catalog.pg_stat_activity${input.diagnosticDatabase === undefined ? '' : ' WHERE datname = $1'} ORDER BY backend_start LIMIT 50`, values, signal)
      tables.push({ id: 'sessions', title: '连接会话', columns: [
        { id: 'pid', label: 'PID' }, { id: 'username', label: '用户' }, { id: 'database', label: '数据库' },
        { id: 'client', label: '客户端' }, { id: 'state', label: '状态' }, { id: 'wait', label: '等待' }, { id: 'age', label: '时长' },
      ], rows: rows.map((row) => [row.pid, row.username, row.database, row.client, row.state, row.wait_event_type, row.age].map((value) => displayText(value))), truncated: false })
    } catch { warnings.push('无法读取 PostgreSQL 连接会话（可能缺少统计权限）') }
  }
  if (section === 'parameters') {
    try {
      const rows = await queryRows(client, 'SELECT name, setting, unit FROM pg_catalog.pg_settings WHERE name = ANY($1::text[]) ORDER BY name', [POSTGRES_PARAMETER_NAMES], signal)
      parameters = []; parametersTruncated = false; let bytes = 2
      for (const row of rows) {
        const setting = displayText(row.setting, MAX_PARAMETER_VALUE_LENGTH)
        const unit = displayText(row.unit, 32)
        const entry: ServerOpsDataParameter = { name: displayText(row.name, 128), value: unit === '' ? setting : `${setting} × ${unit}`, scope: 'session' }
        const entryBytes = Buffer.byteLength(JSON.stringify(entry), 'utf8') + (parameters.length === 0 ? 0 : 1)
        if (bytes + entryBytes > MAX_PARAMETER_RESULT_BYTES) { parametersTruncated = true; break }
        parameters.push(entry); bytes += entryBytes
      }
    } catch { warnings.push('无法读取 PostgreSQL 参数白名单（可能缺少 pg_settings 权限）'); parameters = []; parametersTruncated = false }
  }
  return { capability: 'available', serverVersion: version, tlsStatus: client.tlsStatus, metrics: metrics.slice(0, 24),
    tables: tables.slice(0, 4), warnings, ...(parameters === undefined ? {} : { parameters, parametersTruncated }) }
}

/** 在已连接 client 上执行一次 PostgreSQL 只读读取。 */
export async function readServerOpsPostgresqlWithClient(client: ServerOpsPostgresqlClient,
  input: ServerOpsDataRuntimeInput, signal?: AbortSignal): Promise<ServerOpsDataRuntimeOutput> {
  if (input.mode === 'sql-query') return readPostgresqlSql(client, input, signal)
  if (input.mode === 'schema-tables' || input.mode === 'schema-table' || input.mode === 'schema-rows' || input.mode === 'schema-cell') return readPostgresqlSchema(client, input, signal)
  return readPostgresqlDiagnostics(client, input, signal)
}

/** 将 PostgreSQL 错误收口为现有公开稳定错误码。 */
function normalizePostgresqlError(error: unknown): Error {
  if (getServerOpsSqlQueryPublicError(error) !== undefined || getServerOpsRowFilterPublicError(error) !== null) return error as Error
  if (error instanceof Error && ['SERVER_OPS_DATA_CANCELLED', 'SERVER_OPS_DATA_CELL_CHANGED', 'SERVER_OPS_DATA_CELL_REDACTED',
    'SERVER_OPS_DATA_CELL_TOO_LARGE', 'SERVER_OPS_DATA_CELL_TIMEOUT'].includes(error.message)) return error
  const code = typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : ''
  if (code === '42P01') return new Error('SERVER_OPS_DATA_QUERY_TABLE_UNAVAILABLE')
  if (code === '42703') return new Error('SERVER_OPS_DATA_QUERY_COLUMN_UNAVAILABLE')
  if (code === '42601') return new Error('SERVER_OPS_DATA_QUERY_SQL_INVALID')
  if (code === '42501') return new Error('SERVER_OPS_DATA_QUERY_PERMISSION_DENIED')
  if (code === '57014' || code === '55P03') return new Error('SERVER_OPS_DATA_QUERY_TIMEOUT')
  return new Error('SERVER_OPS_DATA_QUERY_FAILED')
}

/** 建连、只读事务、实际读取、取消与清理的完整 PostgreSQL 生命周期。 */
export async function runServerOpsPostgresqlRead(input: ServerOpsDataRuntimeInput, createChannel: () => Promise<Duplex>,
  signal?: AbortSignal, createCancelChannel: () => Promise<Duplex> = createChannel): Promise<ServerOpsDataRuntimeOutput> {
  const tlsMode = input.tlsMode
  if (tlsMode === 'preferred') throw new Error('SERVER_OPS_DATA_TLS_MODE_UNSUPPORTED')
  if (signal?.aborted) throw new Error('SERVER_OPS_DATA_CANCELLED')
  let channel: Duplex | undefined
  let client: ServerOpsPostgresqlClient | undefined
  /** 撤销 Promise 覆盖建连阶段，并在已连接时等待 CancelRequest 尝试完成。 */
  let rejectCancelled: (reason: Error) => void = () => undefined
  const cancelled = new Promise<never>((_resolve, reject) => { rejectCancelled = reject })
  const onAbort = (): void => {
    const activeClient = client
    if (!activeClient) {
      channel?.destroy()
      rejectCancelled(new Error('SERVER_OPS_DATA_CANCELLED'))
      return
    }
    /** PostgreSQL CancelRequest 必须走第二条连接；发送完成后再销毁主连接，避免后端继续计算。 */
    if (activeClient.cancel) {
      void activeClient.cancel(createCancelChannel).catch(() => undefined).finally(() => {
        activeClient.destroy?.()
        channel?.destroy()
        rejectCancelled(new Error('SERVER_OPS_DATA_CANCELLED'))
      })
      return
    }
    activeClient.destroy?.()
    channel?.destroy()
    rejectCancelled(new Error('SERVER_OPS_DATA_CANCELLED'))
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const reading = (async (): Promise<ServerOpsDataRuntimeOutput> => {
      channel = await createChannel()
      if (signal?.aborted) { channel.destroy(); throw new Error('SERVER_OPS_DATA_CANCELLED') }
      client = createServerOpsPostgresqlClient({ address: input.address, port: input.port,
        database: input.schemaDatabase ?? input.database ?? 'postgres', username: input.username, password: input.password,
        tlsMode, tlsServerName: input.tlsServerName, stream: channel, connectTimeoutMs: 15_000 })
      client.on?.('error', () => undefined)
      await client.connect?.()
      if (signal?.aborted) throw new Error('SERVER_OPS_DATA_CANCELLED')
      await configureServerOpsPostgresqlSession(client)
      return await readServerOpsPostgresqlWithClient(client, input, signal)
    })()
    return await Promise.race([reading, cancelled])
  } catch (error) {
    if (signal?.aborted) throw new Error('SERVER_OPS_DATA_CANCELLED')
    if (input.mode === 'sql-query' || input.mode.startsWith('schema-') || getServerOpsRowFilterPublicError(error) !== null) throw normalizePostgresqlError(error)
    const code = typeof error === 'object' && error !== null ? String((error as { code?: unknown }).code ?? '') : ''
    const errorMessage = error instanceof Error ? error.message.toLowerCase() : ''
    const tlsFailure = input.tlsMode !== 'disabled' && (
      ['DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
        'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED'].includes(code)
      || /certificate|self[- ]signed|tls|ssl/iu.test(errorMessage)
      || (input.tlsMode === 'verify' && errorMessage === 'connection terminated unexpectedly')
    )
    const capability = code === '28P01' ? 'auth-failed' : code === '42501' ? 'permission-denied'
      : code === '3D000' || code === '0A000' ? 'unsupported' : code === '57014' || code === '55P03' ? 'timeout'
        : tlsFailure ? 'tls-failed' : 'unreachable'
    return { capability, metrics: [], tables: [], warnings: [capability === 'auth-failed' ? 'PostgreSQL 认证失败'
      : capability === 'permission-denied' ? 'PostgreSQL 账号权限不足' : capability === 'tls-failed' ? 'PostgreSQL TLS 握手或证书校验失败'
        : capability === 'timeout' ? 'PostgreSQL 读取超时' : capability === 'unsupported' ? 'PostgreSQL 数据库不可用或版本不支持' : '无法连接 PostgreSQL'] }
  } finally {
    signal?.removeEventListener('abort', onAbort)
    if (client) { try { await closeServerOpsPostgresqlClient(client) } catch { client.destroy?.() } }
    if (channel && !channel.destroyed) channel.destroy()
  }
}
