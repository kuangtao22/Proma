import { isServerOpsId } from './server-ops'
import type { ServerOpsDataEngine } from './server-ops-data'

/**
 * 数据连接"表浏览"领域的 IPC 通道。
 *
 * 与只读诊断分开：诊断回答"这台库健康吗"，表浏览回答"库里有什么、长什么样"。
 * 三个通道都是只读，且标识符一律先经 information_schema 白名单校验后才允许拼进语句。
 */
export const SERVER_OPS_DATA_SCHEMA_CHANNELS = {
  LIST_TABLES: 'server-ops:list-data-schema-tables',
  DESCRIBE_TABLE: 'server-ops:describe-data-schema-table',
  READ_ROWS: 'server-ops:read-data-schema-rows',
} as const

/** 单个库下表清单的展示行。 */
export interface ServerOpsDataSchemaTableSummary {
  name: string
  type?: 'table' | 'view'
  engine?: string
  /** information_schema 给出的行数估算，不保证精确。 */
  rows?: number
  sizeBytes?: number
  /** 最近更新时间；数据库未提供时缺省。 */
  updatedAt?: number
  comment?: string
}

/** 表结构里的一列。 */
export interface ServerOpsDataSchemaColumn {
  name: string
  /** 完整列类型，例如 `varchar(64)`、`int unsigned`。 */
  type: string
  nullable: boolean
  /** 是否属于主键。 */
  primaryKey: boolean
  /** 默认值文本；无默认值时为 undefined。 */
  defaultText?: string
  extra?: string
  comment?: string
}

/** 表上的一个索引。 */
export interface ServerOpsDataSchemaIndex {
  name: string
  unique: boolean
  /** 索引覆盖的列，按索引内顺序排列。 */
  columns: string[]
}

/** 列出库与表清单。 */
export interface ServerOpsDataSourceTablesInput {
  sourceId: string
  /** 目标库；省略时使用数据源自身配置的库。 */
  database?: string
}

/** 库与表清单结果；`databases` 供界面上的库选择器使用。 */
export interface ServerOpsDataSourceTablesResult {
  /** 当前容器的库清单（有权限看到的）。 */
  databases: string[]
  /** 目标库下的表清单；目标库为空时为空数组。 */
  tables: ServerOpsDataSchemaTableSummary[]
  /** 目标库名，便于界面回填选择器。 */
  database?: string
  databasesTruncated?: boolean
  tablesTruncated?: boolean
}

/** 读取单张表的结构。 */
export interface ServerOpsDataSourceTableInput {
  sourceId: string
  database: string
  table: string
}

/** 表结构结果。 */
export interface ServerOpsDataSourceTableResult {
  columns: ServerOpsDataSchemaColumn[]
  indexes: ServerOpsDataSchemaIndex[]
}

/** 分页读取表数据预览。 */
export interface ServerOpsDataSourceRowsInput {
  sourceId: string
  database: string
  table: string
  offset: number
  /** 每页行数；共享合同限制为 1–200。 */
  limit: number
}

/** 表数据预览单元格；二进制只暴露字节数，文本截断显式携带状态。 */
export type ServerOpsDataSchemaCell = string | null
  | { kind: 'binary'; bytes: number }
  | { kind: 'text'; text: string; truncated: true }

/** 表数据预览结果；单元格已由 runtime 归一化为有界公开值。 */
export interface ServerOpsDataSourceRowsResult {
  columns: string[]
  rows: ServerOpsDataSchemaCell[][]
  offset: number
  limit: number
  /** information_schema 的行数估算，用于分页提示。 */
  totalEstimate?: number
  /** 是否因为行数或字节上限被截断。 */
  truncated: boolean
  hasMore?: boolean
  orderedByPrimaryKey?: boolean
}

/** 判断未知值是否为普通可枚举对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 判断对象字段是否与给定集合完全一致。 */
function hasOnlyKeys(value: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => keys.has(key)) && Object.keys(value).length === keys.size
}

/** 有界展示文本：允许空串，但不允许控制字符。 */
function isSchemaText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length <= maximum && !/[\u0000-\u001f\u007f]/u.test(value)
}

/** 有界展示文本且必须非空。 */
function isNonEmptySchemaText(value: unknown, maximum: number): value is string {
  return isSchemaText(value, maximum) && value.length > 0
}

/** 有界非负整数。 */
function isBoundedInteger(value: unknown, maximum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum
}

/** 解析表清单输入。 */
export function parseServerOpsDataSourceTablesInput(value: unknown): ServerOpsDataSourceTablesInput {
  const errorCode = 'SERVER_OPS_DATA_SCHEMA_TABLES_INPUT_INVALID'
  if (!isRecord(value)) throw new Error(errorCode)
  const keys = new Set(value.database === undefined ? ['sourceId'] : ['sourceId', 'database'])
  if (!hasOnlyKeys(value, keys) || !isServerOpsId(value.sourceId)) throw new Error(errorCode)
  if (value.database !== undefined && !isNonEmptySchemaText(value.database, 64)) throw new Error(errorCode)
  return {
    sourceId: value.sourceId,
    ...(value.database === undefined ? {} : { database: value.database }),
  }
}

/** 解析单张表的标识输入（库 + 表）。 */
export function parseServerOpsDataSourceTableInput(value: unknown): ServerOpsDataSourceTableInput {
  const errorCode = 'SERVER_OPS_DATA_SCHEMA_TABLE_INPUT_INVALID'
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(['sourceId', 'database', 'table']))
    || !isServerOpsId(value.sourceId)
    || !isNonEmptySchemaText(value.database, 64)
    || !isNonEmptySchemaText(value.table, 128)) throw new Error(errorCode)
  return { sourceId: value.sourceId, database: value.database, table: value.table }
}

/** 解析表数据预览输入；分页偏移必须是页大小的整数倍。 */
export function parseServerOpsDataSourceRowsInput(value: unknown): ServerOpsDataSourceRowsInput {
  const errorCode = 'SERVER_OPS_DATA_SCHEMA_ROWS_INPUT_INVALID'
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(['sourceId', 'database', 'table', 'offset', 'limit']))
    || !isServerOpsId(value.sourceId)
    || !isNonEmptySchemaText(value.database, 64)
    || !isNonEmptySchemaText(value.table, 128)
    || !isBoundedInteger(value.offset, 1_000_000)
    || typeof value.limit !== 'number' || !Number.isSafeInteger(value.limit) || value.limit < 1 || value.limit > 200) {
    throw new Error(errorCode)
  }
  if (value.offset % value.limit !== 0) throw new Error(errorCode)
  return { sourceId: value.sourceId, database: value.database, table: value.table, offset: value.offset, limit: value.limit }
}

/** 解析库与表清单结果。 */
export function parseServerOpsDataSourceTablesResult(value: unknown): ServerOpsDataSourceTablesResult {
  const errorCode = 'SERVER_OPS_DATA_SCHEMA_TABLES_RESULT_INVALID'
  if (!isRecord(value)) throw new Error(errorCode)
  const keys = new Set(['databases', 'tables']
    .concat(value.database === undefined ? [] : ['database'])
    .concat(value.databasesTruncated === undefined ? [] : ['databasesTruncated'])
    .concat(value.tablesTruncated === undefined ? [] : ['tablesTruncated']))
  if (!hasOnlyKeys(value, keys) || !Array.isArray(value.databases) || value.databases.length > 200
    || !Array.isArray(value.tables) || value.tables.length > 500
    || (value.databasesTruncated !== undefined && typeof value.databasesTruncated !== 'boolean')
    || (value.tablesTruncated !== undefined && typeof value.tablesTruncated !== 'boolean')) throw new Error(errorCode)
  /** 每个库名都必须是有界文本且唯一，避免选择器出现重复项。 */
  const databases = value.databases.map((entry) => {
    if (!isNonEmptySchemaText(entry, 64)) throw new Error(errorCode)
    return entry
  })
  if (new Set(databases).size !== databases.length) throw new Error(errorCode)
  const tables = value.tables.map((entry) => {
    if (!isRecord(entry)) throw new Error(errorCode)
    const tableKeys = new Set(['name', 'type', 'engine', 'rows', 'sizeBytes', 'updatedAt', 'comment'])
    if (!Object.keys(entry).every((key) => tableKeys.has(key)) || !isNonEmptySchemaText(entry.name, 128)) throw new Error(errorCode)
    if (entry.engine !== undefined && !isSchemaText(entry.engine, 32)) throw new Error(errorCode)
    if (entry.type !== undefined && entry.type !== 'table' && entry.type !== 'view') throw new Error(errorCode)
    if (entry.rows !== undefined && !isBoundedInteger(entry.rows, Number.MAX_SAFE_INTEGER)) throw new Error(errorCode)
    if (entry.sizeBytes !== undefined && !isBoundedInteger(entry.sizeBytes, Number.MAX_SAFE_INTEGER)) throw new Error(errorCode)
    if (entry.updatedAt !== undefined && !isBoundedInteger(entry.updatedAt, Number.MAX_SAFE_INTEGER)) throw new Error(errorCode)
    if (entry.comment !== undefined && !isSchemaText(entry.comment, 256)) throw new Error(errorCode)
    /** 校验后保留表/视图字面量类型，避免宽化成普通 string。 */
    const type: ServerOpsDataSchemaTableSummary['type'] = entry.type === 'table' || entry.type === 'view' ? entry.type : undefined
    return {
      name: entry.name,
      ...(type === undefined ? {} : { type }),
      ...(entry.engine === undefined ? {} : { engine: entry.engine }),
      ...(entry.rows === undefined ? {} : { rows: entry.rows }),
      ...(entry.sizeBytes === undefined ? {} : { sizeBytes: entry.sizeBytes }),
      ...(entry.updatedAt === undefined ? {} : { updatedAt: entry.updatedAt }),
      ...(entry.comment === undefined ? {} : { comment: entry.comment }),
    }
  })
  if (value.database !== undefined && !isNonEmptySchemaText(value.database, 64)) throw new Error(errorCode)
  return {
    databases,
    tables,
    ...(value.database === undefined ? {} : { database: value.database }),
    ...(value.databasesTruncated === undefined ? {} : { databasesTruncated: value.databasesTruncated }),
    ...(value.tablesTruncated === undefined ? {} : { tablesTruncated: value.tablesTruncated }),
  }
}

/** 解析表结构结果。 */
export function parseServerOpsDataSourceTableResult(value: unknown): ServerOpsDataSourceTableResult {
  const errorCode = 'SERVER_OPS_DATA_SCHEMA_TABLE_RESULT_INVALID'
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(['columns', 'indexes']))
    || !Array.isArray(value.columns) || value.columns.length > 256
    || !Array.isArray(value.indexes) || value.indexes.length > 128) throw new Error(errorCode)
  const columns = value.columns.map((entry) => {
    if (!isRecord(entry)) throw new Error(errorCode)
    const columnKeys = new Set(['name', 'type', 'nullable', 'primaryKey', 'defaultText', 'extra', 'comment'])
    if (!Object.keys(entry).every((key) => columnKeys.has(key))
      || !isNonEmptySchemaText(entry.name, 128)
      || !isNonEmptySchemaText(entry.type, 128)
      || typeof entry.nullable !== 'boolean'
      || typeof entry.primaryKey !== 'boolean') throw new Error(errorCode)
    if (entry.defaultText !== undefined && !isSchemaText(entry.defaultText, 256)) throw new Error(errorCode)
    if (entry.extra !== undefined && !isSchemaText(entry.extra, 64)) throw new Error(errorCode)
    if (entry.comment !== undefined && !isSchemaText(entry.comment, 256)) throw new Error(errorCode)
    return {
      name: entry.name,
      type: entry.type,
      nullable: entry.nullable,
      primaryKey: entry.primaryKey,
      ...(entry.defaultText === undefined ? {} : { defaultText: entry.defaultText }),
      ...(entry.extra === undefined ? {} : { extra: entry.extra }),
      ...(entry.comment === undefined ? {} : { comment: entry.comment }),
    }
  })
  const indexes = value.indexes.map((entry) => {
    if (!isRecord(entry) || !hasOnlyKeys(entry, new Set(['name', 'unique', 'columns']))
      || !isNonEmptySchemaText(entry.name, 128)
      || typeof entry.unique !== 'boolean'
      || !Array.isArray(entry.columns) || entry.columns.length === 0 || entry.columns.length > 16) throw new Error(errorCode)
    return {
      name: entry.name,
      unique: entry.unique,
      columns: entry.columns.map((column) => {
        if (!isNonEmptySchemaText(column, 128)) throw new Error(errorCode)
        return column
      }),
    }
  })
  return { columns, indexes }
}

/** 解析表数据预览结果。 */
export function parseServerOpsDataSourceRowsResult(value: unknown): ServerOpsDataSourceRowsResult {
  const errorCode = 'SERVER_OPS_DATA_SCHEMA_ROWS_RESULT_INVALID'
  if (!isRecord(value)) throw new Error(errorCode)
  const keys = new Set(['columns', 'rows', 'offset', 'limit', 'truncated']
    .concat(value.totalEstimate === undefined ? [] : ['totalEstimate'])
    .concat(value.hasMore === undefined ? [] : ['hasMore'])
    .concat(value.orderedByPrimaryKey === undefined ? [] : ['orderedByPrimaryKey']))
  if (!hasOnlyKeys(value, keys)
    || !Array.isArray(value.columns) || value.columns.length > 64
    || !Array.isArray(value.rows) || value.rows.length > 200
    || !isBoundedInteger(value.offset, 1_000_000)
    || typeof value.limit !== 'number' || !Number.isSafeInteger(value.limit) || value.limit < 1 || value.limit > 200
    || value.offset % value.limit !== 0 || value.rows.length > value.limit
    || typeof value.truncated !== 'boolean'
    || (value.hasMore !== undefined && typeof value.hasMore !== 'boolean')
    || (value.orderedByPrimaryKey !== undefined && typeof value.orderedByPrimaryKey !== 'boolean')) throw new Error(errorCode)
  if (value.totalEstimate !== undefined && !isBoundedInteger(value.totalEstimate, Number.MAX_SAFE_INTEGER)) throw new Error(errorCode)
  /** 列名与单元格都必须是"有界字符串或不带控制字符的文本"；单元格允许空串。 */
  const columns = value.columns.map((column) => {
    if (!isNonEmptySchemaText(column, 128)) throw new Error(errorCode)
    return column
  })
  const rows = value.rows.map((row) => {
    if (!Array.isArray(row) || row.length !== columns.length) throw new Error(errorCode)
    return row.map((cell): ServerOpsDataSchemaCell => {
      if (cell === null || isSchemaText(cell, 256)) return cell
      if (!isRecord(cell)) throw new Error(errorCode)
      if (cell.kind === 'binary' && hasOnlyKeys(cell, new Set(['kind', 'bytes']))
        && isBoundedInteger(cell.bytes, Number.MAX_SAFE_INTEGER)) return { kind: 'binary', bytes: cell.bytes }
      if (cell.kind === 'text' && hasOnlyKeys(cell, new Set(['kind', 'text', 'truncated']))
        && isSchemaText(cell.text, 256) && cell.truncated === true) return { kind: 'text', text: cell.text, truncated: true }
      throw new Error(errorCode)
    })
  })
  if (new TextEncoder().encode(JSON.stringify(rows)).byteLength > 1_048_576) throw new Error(errorCode)
  return {
    columns,
    rows,
    offset: value.offset,
    limit: value.limit,
    truncated: value.truncated,
    ...(value.totalEstimate === undefined ? {} : { totalEstimate: value.totalEstimate }),
    ...(value.hasMore === undefined ? {} : { hasMore: value.hasMore }),
    ...(value.orderedByPrimaryKey === undefined ? {} : { orderedByPrimaryKey: value.orderedByPrimaryKey }),
  }
}

/** 表浏览只支持关系型引擎；Redis 等键值引擎走各自的后续能力。 */
export function isServerOpsSchemaBrowsableEngine(engine: ServerOpsDataEngine): boolean {
  return engine === 'mysql'
}
