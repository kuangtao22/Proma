import { isServerOpsId } from './server-ops'

/** 数据服务领域 IPC 通道，集中定义以保持 Main、Preload 与 Renderer 一致。 */
export const SERVER_OPS_DATA_CHANNELS = {
  LIST_SOURCES: 'server-ops:list-data-sources',
  UPSERT_SOURCE: 'server-ops:upsert-data-source',
  DELETE_SOURCE: 'server-ops:delete-data-source',
  PROBE_SOURCE: 'server-ops:probe-data-source',
  DIAGNOSE_SOURCE: 'server-ops:diagnose-data-source',
  REVEAL_SOURCE_PASSWORD: 'server-ops:reveal-data-source-password',
} as const

/** 首批支持的数据服务引擎；新增引擎必须同时补齐 runtime adapter 与页面文案。 */
export type ServerOpsDataEngine = 'mysql' | 'redis' | 'sqlite'

/**
 * 数据源连接方式。
 *
 * - `direct`：从本机直接连接数据库，不需要任何主机与 SSH 连接。
 * - `ssh`：经由一台已配置主机建立隧道，适用于只有跳板能访问的数据库。
 */
export type ServerOpsDataTransport = 'ssh' | 'direct'

/** TLS 策略：MySQL preferred 仅在服务端明确不支持 TLS 时回退；Redis 不支持该策略。 */
export type ServerOpsDataTlsMode = 'disabled' | 'preferred' | 'required' | 'verify'

/** 本次连接实际协商状态，与保存的 TLS 策略分开显示。 */
export type ServerOpsDataTlsStatus = 'plaintext' | 'encrypted' | 'verified'

/** 数据源公开能力状态；不可用原因必须可区分，不能用统一失败掩盖真实语义。 */
export type ServerOpsDataCapability =
  | 'available'
  | 'auth-failed'
  | 'permission-denied'
  | 'unreachable'
  | 'tls-failed'
  | 'timeout'
  | 'unsupported'

/** 页面直接展示的指标卡；value 由引擎适配器格式化，UI 不解析业务语义。 */
export interface ServerOpsDataMetric {
  /** 稳定标识，用于排序与测试断言，例如 `threads-connected`。 */
  id: string
  /** 中文标题。 */
  label: string
  /** 已格式化的展示值。 */
  value: string
  /** 可选次要说明。 */
  hint?: string
  /** 可选进度条占比，范围 0..1。 */
  ratio?: number
}

/** 结果表格列定义。 */
export interface ServerOpsDataTableColumn {
  /** 稳定列标识。 */
  id: string
  /** 中文列标题。 */
  label: string
  /** 数字列建议右对齐。 */
  align?: 'left' | 'right'
}

/** 结果表格；行内容全部为有界展示字符串。 */
export interface ServerOpsDataTable {
  /** 稳定表标识，例如 `databases`、`slowlog`。 */
  id: string
  /** 中文表标题。 */
  title: string
  columns: ServerOpsDataTableColumn[]
  rows: string[][]
  /** 是否命中行数或字节上限被截断。 */
  truncated: boolean
  /** 空结果时的说明文案。 */
  emptyText?: string
}

/** 单条数据源公开投影；永不包含密码明文或凭据引用。 */
export interface ServerOpsDataSource {
  id: string
  /** 归属的运维项目；缺失表示尚未迁移，由主进程归入默认项目。 */
  projectId?: string
  /** 连接方式；决定是否依赖跳板主机与活跃 SSH 连接。 */
  transport: ServerOpsDataTransport
  /** 经由的跳板主机；仅 `ssh` 方式存在。 */
  hostId?: string
  engine: ServerOpsDataEngine
  /** 用户可读名称。 */
  label: string
  /** 服务器视角地址，例如 `127.0.0.1`。 */
  address?: string
  port?: number
  /** SQLite 在 SSH 服务器上的 POSIX 绝对文件路径。 */
  filePath?: string
  /** MySQL 库名；Redis 为逻辑库序号文本。 */
  database?: string
  username?: string
  tlsMode: ServerOpsDataTlsMode
  /** TLS 校验使用的数据库真实主机名。 */
  tlsServerName?: string
  /** 是否已保存密码密文，仅暴露布尔状态。 */
  hasPassword: boolean
  createdAt: number
  updatedAt: number
}

/** 按主机列出数据源。 */
export interface ServerOpsDataSourceListInput {
  /** 只返回该项目下的数据源；省略表示返回全部。 */
  projectId?: string
}

/** 数据源列表结果；数据源是全局条目，不隶属于某一台主机。 */
export interface ServerOpsDataSourceListResult {
  sources: ServerOpsDataSource[]
}

/** 新建或编辑数据源；`sourceId` 省略表示新建。 */
export interface ServerOpsDataSourceUpsertInput {
  /** 新建时指定归属项目；编辑时仅允许与现有归属一致。 */
  projectId?: string
  /** 连接方式；新建时必填，编辑时以现有记录为准。 */
  transport: ServerOpsDataTransport
  /** 跳板主机；`ssh` 方式必填。 */
  hostId?: string
  sourceId?: string
  engine: ServerOpsDataEngine
  label: string
  address?: string
  port?: number
  /** SQLite 在 SSH 服务器上的 POSIX 绝对文件路径。 */
  filePath?: string
  database?: string
  username?: string
  /** 仅写入路径使用；不提供表示保留已保存密码。 */
  password?: string
  /** 显式清除已保存密码。 */
  clearPassword?: boolean
  tlsMode: ServerOpsDataTlsMode
  tlsServerName?: string
}

/** 数据源结果，用于新建与编辑回执。 */
export interface ServerOpsDataSourceUpsertResult {
  source: ServerOpsDataSource
}

/** 删除数据源。 */
export interface ServerOpsDataSourceDeleteInput { sourceId: string }

/** 读取已保存的数据源密码；仅在用户显式点"显示密码"时调用。 */
export interface ServerOpsDataSourcePasswordInput { sourceId: string }

/**
 * 已保存密码的读取结果。

 * 明文只在这一次调用中返回给渲染层用于展示，主进程不记录、不落盘第二份；
 * 该数据源没有保存密码时 `password` 为 `null`。
 */
export interface ServerOpsDataSourcePasswordResult { password: string | null }

/**
 * 未保存的数据连接草稿。
 *
 * 新建/编辑弹窗里的"测试"必须能在不落盘任何字段（尤其是不落盘密码）的前提下真实连一次，
 * 因此这里只描述一次性的连接参数，主进程不会把它写进 `data-sources.json`。
 */
export interface ServerOpsDataSourceProbeDraft {
  transport: ServerOpsDataTransport
  /** 经由的跳板主机；`ssh` 方式必填。 */
  hostId?: string
  engine: ServerOpsDataEngine
  address?: string
  port?: number
  /** SQLite 在 SSH 服务器上的 POSIX 绝对文件路径。 */
  filePath?: string
  database?: string
  username?: string
  /** 本次表单里新填的密码；只在这一次测试中使用。 */
  password?: string
  /** 复用已保存密码时的数据源 ID；与 `password` 互斥。 */
  savedSourceId?: string
  tlsMode: ServerOpsDataTlsMode
  tlsServerName?: string
}

/** 连接测试输入：已保存的数据源，或一份未保存草稿。 */
export type ServerOpsDataSourceProbeInput =
  | { sourceId: string }
  | { draft: ServerOpsDataSourceProbeDraft }

/** 连接测试结果；`sourceId` 只在测试已保存的数据源时存在。 */
export interface ServerOpsDataProbeResult {
  sourceId?: string
  engine: ServerOpsDataEngine
  capability: ServerOpsDataCapability
  /** 数据库真实版本，仅在连接成功时有值。 */
  serverVersion?: string
  /** 建立连接与读取版本的往返耗时。 */
  latencyMs?: number
  /** 成功连接后由驱动报告的实际状态；SQLite 不使用网络 TLS。 */
  tlsStatus?: ServerOpsDataTlsStatus
  warnings: string[]
}

/** MySQL 诊断页分区；省略时保持旧版一次读取全部诊断的行为。 */
export type ServerOpsDataDiagnosticSection = 'overview' | 'sessions' | 'statements' | 'parameters'

/** 只读诊断输入。 */
export interface ServerOpsDataDiagnoseInput {
  sourceId: string
  section?: ServerOpsDataDiagnosticSection
  /** 仅 MySQL 会话与慢语句使用的库级筛选；省略表示实例范围。 */
  database?: string
}

/** MySQL 全局参数的有界公开投影。 */
export interface ServerOpsDataParameter {
  name: string
  value: string
  scope: 'global'
}

/** 只读诊断结果；指标与表格均已在 runtime 侧完成有界裁剪。 */
export interface ServerOpsDataDiagnosticsResult {
  sourceId: string
  engine: ServerOpsDataEngine
  capability: ServerOpsDataCapability
  collectedAt: number
  /** 本次只读诊断连接的实际状态。 */
  tlsStatus?: ServerOpsDataTlsStatus
  metrics: ServerOpsDataMetric[]
  tables: ServerOpsDataTable[]
  parameters?: ServerOpsDataParameter[]
  parametersTruncated?: boolean
  warnings: string[]
}

/** 判断未知值是否为普通可枚举对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 拒绝公开 DTO 中的未知字段。 */
function hasOnlyKeys(value: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => keys.has(key))
}

/** 判断字符串是否有界且不含终端控制字符。 */
function isDisplayString(value: unknown, maximum: number, allowEmpty = false): value is string {
  return typeof value === 'string' && value.length <= maximum && (allowEmpty || value.length > 0)
    && !/[\u0000-\u001f\u007f]/u.test(value)
}

/** 判断稳定标识是否使用小写短横线命名。 */
function isDataSlug(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/u.test(value)
}

/** 判断主机名或地址是否为不含空白与 NUL 的有界文本。 */
function isAddressText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= maximum && !/[\s\u0000]/u.test(value)
}

/** 判断数据源可选文本字段，允许少见字符但保持有界且不含控制字符。 */
function isOptionalDataText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= maximum && !/[\u0000\u007f]/u.test(value)
}

/** 判断密码等秘密材料，保留原始空白且拒绝 NUL。 */
function isSecretText(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 8_192 && !value.includes('\u0000')
}

/** 判断时间戳是否位于可安全持久化范围。 */
function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000
}

/** 判断端口是否位于 TCP 有效范围。 */
function isPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65_535
}

/** 判断引擎枚举。 */
export function isServerOpsDataEngine(value: unknown): value is ServerOpsDataEngine {
  return value === 'mysql' || value === 'redis' || value === 'sqlite'
}

/** 判断 SQLite 文件身份是否为有界 POSIX 绝对路径，允许普通空格与引号。 */
export function isServerOpsSqliteFilePath(value: unknown): value is string {
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= 4_096
    && value.startsWith('/')
    && !/^file:/iu.test(value)
    && value !== ':memory:'
    && !/[\u0000-\u001f\u007f-\u009f]/u.test(value)
}

/** 判断 SQLite 合同中的数据库是否省略或固定为 main。 */
function isSqliteMainDatabase(value: unknown): boolean {
  return value === undefined || value === 'main'
}

/** 判断 TLS 模式枚举。 */
export function isServerOpsDataTlsMode(value: unknown): value is ServerOpsDataTlsMode {
  return value === 'disabled' || value === 'preferred' || value === 'required' || value === 'verify'
}

/** 判断 MySQL 证书校验主机名是否为 DNS 名称；mysql2 对 IP 关闭 SNI，不能将其当作校验目标。 */
export function isServerOpsMySqlTlsServerName(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 253
    || /^\d+(?:\.\d+){3}$/u.test(value) || /^\d+$/u.test(value)) return false
  return value.split('.').every((label) => label.length <= 63
    && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/iu.test(label))
}

/** 校验 runtime 报告的实际 TLS 连接状态。 */
export function isServerOpsDataTlsStatus(value: unknown): value is ServerOpsDataTlsStatus {
  return value === 'plaintext' || value === 'encrypted' || value === 'verified'
}

/** 判断连接方式枚举。 */
export function isServerOpsDataTransport(value: unknown): value is ServerOpsDataTransport {
  return value === 'ssh' || value === 'direct'
}

/** 判断能力状态枚举。 */
export function isServerOpsDataCapability(value: unknown): value is ServerOpsDataCapability {
  return value === 'available' || value === 'auth-failed' || value === 'permission-denied'
    || value === 'unreachable' || value === 'tls-failed' || value === 'timeout' || value === 'unsupported'
}

/** 解析有界展示字符串数组并复制结果。 */
function parseStringArray(value: unknown, maximumItems: number, maximumLength: number, errorCode: string): string[] {
  if (!Array.isArray(value) || value.length > maximumItems
    || value.some((entry) => !isDisplayString(entry, maximumLength))) throw new Error(errorCode)
  return [...value]
}

/** 严格解析公开 warnings。 */
function parseWarnings(value: unknown, errorCode: string): string[] {
  return parseStringArray(value, 20, 512, errorCode)
}

/** 供 utility process 复用的稳定指标错误码。 */
const SERVER_OPS_DATA_METRIC_ERROR = 'SERVER_OPS_DATA_METRIC_INVALID'

/** 供 utility process 复用的稳定表格错误码。 */
const SERVER_OPS_DATA_TABLE_ERROR = 'SERVER_OPS_DATA_TABLE_INVALID'

/** 严格解析单条指标卡。 */
export function parseServerOpsDataMetric(value: unknown, errorCode = SERVER_OPS_DATA_METRIC_ERROR): ServerOpsDataMetric {
  const keys = new Set(['id', 'label', 'value', 'hint', 'ratio'])
  if (!isRecord(value) || !hasOnlyKeys(value, keys) || !isDataSlug(value.id)
    || !isDisplayString(value.label, 64) || !isDisplayString(value.value, 128)
    || (value.hint !== undefined && !isDisplayString(value.hint, 200))
    || (value.ratio !== undefined && (typeof value.ratio !== 'number' || !Number.isFinite(value.ratio)
      || value.ratio < 0 || value.ratio > 1))) throw new Error(errorCode)
  return {
    id: value.id,
    label: value.label,
    value: value.value,
    ...(value.hint === undefined ? {} : { hint: value.hint }),
    ...(value.ratio === undefined ? {} : { ratio: value.ratio }),
  }
}

/** 严格解析单个表格列。 */
function parseTableColumn(value: unknown, errorCode: string): ServerOpsDataTableColumn {
  const keys = new Set(['id', 'label', 'align'])
  if (!isRecord(value) || !hasOnlyKeys(value, keys) || !isDataSlug(value.id)
    || !isDisplayString(value.label, 64)
    || (value.align !== undefined && value.align !== 'left' && value.align !== 'right')) throw new Error(errorCode)
  return { id: value.id, label: value.label, ...(value.align === undefined ? {} : { align: value.align }) }
}

/** 严格解析单个结果表格，并强制行宽与列定义一致。 */
export function parseServerOpsDataTable(value: unknown, errorCode = SERVER_OPS_DATA_TABLE_ERROR): ServerOpsDataTable {
  const keys = new Set(['id', 'title', 'columns', 'rows', 'truncated', 'emptyText'])
  if (!isRecord(value) || !hasOnlyKeys(value, keys) || !isDataSlug(value.id)
    || !isDisplayString(value.title, 64) || typeof value.truncated !== 'boolean'
    || (value.emptyText !== undefined && !isDisplayString(value.emptyText, 64))
    || !Array.isArray(value.columns) || value.columns.length < 1 || value.columns.length > 12
    || !Array.isArray(value.rows) || value.rows.length > 200) throw new Error(errorCode)
  /** 解析后的列定义同时用于校验每行宽度。 */
  const columns = value.columns.map((entry) => parseTableColumn(entry, errorCode))
  /** 解析后的行数据，单元格必须是可展示字符串。 */
  const rows = value.rows.map((entry) => {
    if (!Array.isArray(entry) || entry.length !== columns.length
      || entry.some((cell) => !isDisplayString(cell, 512, true))) throw new Error(errorCode)
    return [...entry] as string[]
  })
  return {
    id: value.id,
    title: value.title,
    columns,
    rows,
    truncated: value.truncated,
    ...(value.emptyText === undefined ? {} : { emptyText: value.emptyText }),
  }
}

/** 严格解析有界指标列表，供 utility process 结果校验复用。 */
export function parseServerOpsDataMetricList(value: unknown): ServerOpsDataMetric[] {
  if (!Array.isArray(value) || value.length > 24) throw new Error(SERVER_OPS_DATA_METRIC_ERROR)
  return value.map((entry) => parseServerOpsDataMetric(entry))
}

/** 严格解析有界表格列表，供 utility process 结果校验复用。 */
export function parseServerOpsDataTableList(value: unknown): ServerOpsDataTable[] {
  if (!Array.isArray(value) || value.length > 4) throw new Error(SERVER_OPS_DATA_TABLE_ERROR)
  return value.map((entry) => parseServerOpsDataTable(entry))
}

/** 严格解析有界 warnings 列表，供 utility process 结果校验复用。 */
export function parseServerOpsDataWarnings(value: unknown): string[] {
  return parseWarnings(value, 'SERVER_OPS_DATA_WARNINGS_INVALID')
}

/** 判断地址是否为回环写法；回环永远允许明文直连。 */
function isLoopbackAddress(address: string): boolean {
  return address === 'localhost' || address === '::1' || address.startsWith('127.')
}

/** 判断地址是否为 RFC1918 / 链路本地 IPv4 字面量。 */
function isPrivateIpv4Address(address: string): boolean {
  /** 点分四段；任何一段不是 0-255 的整数都不算 IP 字面量。 */
  const parts = address.split('.')
  if (parts.length !== 4) return false
  /** 逐段解析出的十进制数值。 */
  const octets = parts.map((part) => (/^\d{1,3}$/u.test(part) ? Number(part) : Number.NaN))
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false
  /** 首段与次段足以判定私网范围。 */
  const first = octets[0]!
  const second = octets[1]!
  if (first === 10) return true
  if (first === 172 && second >= 16 && second <= 31) return true
  if (first === 192 && second === 168) return true
  /** 169.254/16 是链路本地，同样不会路由到公网。 */
  return first === 169 && second === 254
}

/** 判断地址是否为 IPv6 唯一本地地址（fc00::/7）或链路本地（fe80::/10）。 */
function isPrivateIpv6Address(address: string): boolean {
  /** 去掉方括号并统一大小写，便于按段比较。 */
  const normalized = address.toLowerCase().replace(/^\[/u, '').replace(/\]$/u, '')
  if (normalized === '::1') return true
  /** 首段十六进制值决定 ULA 与链路本地范围。 */
  const firstGroup = normalized.split(':')[0] ?? ''
  if (!/^[0-9a-f]{1,4}$/u.test(firstGroup)) return false
  const value = Number.parseInt(firstGroup, 16)
  return (value >= 0xfc00 && value <= 0xfdff) || (value >= 0xfe80 && value <= 0xfebf)
}

/**
 * 判断直连（关闭 TLS）的目标地址是否在可信边界内。
 *
 * 边界是**回环 + 私有网段**：本机回环、RFC1918（10/8、172.16/12、192.168/16）、
 * 链路本地（169.254/16、fe80::/10）与 IPv6 唯一本地地址（fc00::/7）。
 * 这些地址不会直接暴露在公网上，企业内网数据库普遍不开 TLS，一刀切会让最常见的路径不可用；
 * 公网地址仍然必须开启 TLS 校验。
 *
 * 主机名一律**不**在此列：`db.example.com` 无法离线判定归属（DNS 可以指向任何地方，也存在重绑定），
 * 界面应提示改用私有网段地址或开启 TLS。
 *
 * @param address 数据源里用户填写的"服务器视角地址"
 * @returns 是否允许在关闭 TLS 的情况下直连
 */
export function isServerOpsPlaintextDirectAddress(address: string): boolean {
  /** 去掉用户可能带上的空白。 */
  const trimmed = address.trim()
  if (isLoopbackAddress(trimmed)) return true
  if (isPrivateIpv4Address(trimmed)) return true
  return trimmed.includes(':') && isPrivateIpv6Address(trimmed)
}

/** 严格解析数据源公开投影。 */
export function parseServerOpsDataSource(value: unknown): ServerOpsDataSource {
  const errorCode = 'SERVER_OPS_DATA_SOURCE_INVALID'
  const keys = new Set(['id', 'projectId', 'transport', 'hostId', 'engine', 'label', 'address', 'port', 'filePath', 'database', 'username',
    'tlsMode', 'tlsServerName', 'hasPassword', 'createdAt', 'updatedAt'])
  if (!isRecord(value) || !hasOnlyKeys(value, keys) || !isServerOpsId(value.id)
    || (value.projectId !== undefined && !isServerOpsId(value.projectId))
    || !isServerOpsDataTransport(value.transport)
    || (value.hostId !== undefined && !isServerOpsId(value.hostId))
    || !isServerOpsDataEngine(value.engine) || !isDisplayString(value.label, 64)
    || (value.address !== undefined && !isAddressText(value.address, 255))
    || (value.port !== undefined && !isPort(value.port))
    || (value.filePath !== undefined && !isServerOpsSqliteFilePath(value.filePath))
    || (value.database !== undefined && !isOptionalDataText(value.database, 64))
    || (value.username !== undefined && !isOptionalDataText(value.username, 128))
    || !isServerOpsDataTlsMode(value.tlsMode)
    || (value.tlsServerName !== undefined && !isAddressText(value.tlsServerName, 255))
    || typeof value.hasPassword !== 'boolean'
    || !isTimestamp(value.createdAt) || !isTimestamp(value.updatedAt)) throw new Error(errorCode)
  if ((value.tlsMode === 'verify' && value.tlsServerName === undefined)
    || (value.engine === 'redis' && value.tlsMode === 'preferred')) throw new Error(errorCode)
  /** 连接方式与跳板主机的组合必须自洽。 */
  if ((value.transport === 'ssh') !== (value.hostId !== undefined)) throw new Error(errorCode)
  /** SQLite 只绑定 SSH 远端文件；网络引擎继续严格要求地址和端口。 */
  if (value.engine === 'sqlite') {
    if (value.transport !== 'ssh' || Object.hasOwn(value, 'address') || Object.hasOwn(value, 'port')
      || Object.hasOwn(value, 'username') || value.tlsMode !== 'disabled' || Object.hasOwn(value, 'tlsServerName')
      || !isServerOpsSqliteFilePath(value.filePath) || !isSqliteMainDatabase(value.database)
      || value.hasPassword !== false) throw new Error(errorCode)
  } else if (value.address === undefined || value.port === undefined || Object.hasOwn(value, 'filePath')) throw new Error(errorCode)
  return {
    id: value.id,
    ...(value.projectId === undefined ? {} : { projectId: value.projectId }),
    transport: value.transport,
    ...(value.hostId === undefined ? {} : { hostId: value.hostId }),
    engine: value.engine,
    label: value.label,
    ...(value.address === undefined ? {} : { address: value.address }),
    ...(value.port === undefined ? {} : { port: value.port }),
    ...(value.filePath === undefined ? {} : { filePath: value.filePath }),
    ...(value.engine === 'sqlite' ? { database: 'main' } : value.database === undefined ? {} : { database: value.database }),
    ...(value.username === undefined ? {} : { username: value.username }),
    tlsMode: value.tlsMode,
    ...(value.tlsServerName === undefined ? {} : { tlsServerName: value.tlsServerName }),
    hasPassword: value.hasPassword,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  }
}

/** 严格解析数据源列表输入。 */
export function parseServerOpsDataSourceListInput(value: unknown): ServerOpsDataSourceListInput {
  const errorCode = 'SERVER_OPS_DATA_SOURCE_LIST_INPUT_INVALID'
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(['projectId']))
    || (value.projectId !== undefined && !isServerOpsId(value.projectId))) throw new Error(errorCode)
  return value.projectId === undefined ? {} : { projectId: value.projectId }
}

/** 严格解析数据源列表结果。 */
export function parseServerOpsDataSourceListResult(value: unknown): ServerOpsDataSourceListResult {
  const errorCode = 'SERVER_OPS_DATA_SOURCE_LIST_RESULT_INVALID'
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(['sources']))
    || !Array.isArray(value.sources) || value.sources.length > 200) throw new Error(errorCode)
  return { sources: value.sources.map((entry) => parseServerOpsDataSource(entry)) }
}

/** 严格解析数据源新建或编辑输入。 */
export function parseServerOpsDataSourceUpsertInput(value: unknown): ServerOpsDataSourceUpsertInput {
  const errorCode = 'SERVER_OPS_DATA_SOURCE_UPSERT_INPUT_INVALID'
  const keys = new Set(['projectId', 'transport', 'hostId', 'sourceId', 'engine', 'label', 'address', 'port', 'filePath', 'database', 'username',
    'password', 'clearPassword', 'tlsMode', 'tlsServerName'])
  if (!isRecord(value) || !hasOnlyKeys(value, keys) || !isServerOpsDataTransport(value.transport)
    || (value.projectId !== undefined && !isServerOpsId(value.projectId))
    || (value.hostId !== undefined && !isServerOpsId(value.hostId))
    || (value.sourceId !== undefined && !isServerOpsId(value.sourceId))
    || !isServerOpsDataEngine(value.engine) || !isDisplayString(value.label, 64)
    || (value.address !== undefined && !isAddressText(value.address, 255))
    || (value.port !== undefined && !isPort(value.port))
    || (value.filePath !== undefined && !isServerOpsSqliteFilePath(value.filePath))
    || (value.database !== undefined && !isOptionalDataText(value.database, 64))
    || (value.username !== undefined && !isOptionalDataText(value.username, 128))
    || (value.password !== undefined && !isSecretText(value.password))
    || (value.clearPassword !== undefined && typeof value.clearPassword !== 'boolean')
    || !isServerOpsDataTlsMode(value.tlsMode)
    || (value.tlsServerName !== undefined && !isAddressText(value.tlsServerName, 255))) throw new Error(errorCode)
  if ((value.tlsMode === 'verify' && value.tlsServerName === undefined)
    || (value.engine === 'redis' && value.tlsMode === 'preferred')
    || (value.engine === 'mysql' && value.tlsMode === 'verify'
      && !isServerOpsMySqlTlsServerName(value.tlsServerName))) throw new Error(errorCode)
  if (value.password !== undefined && value.clearPassword === true) throw new Error(errorCode)
  /** `ssh` 必须绑定跳板主机，`direct` 不允许携带主机。 */
  if ((value.transport === 'ssh') !== (value.hostId !== undefined)) throw new Error(errorCode)
  /** SQLite 不接受任何网络、凭据或 TLS 参数。 */
  if (value.engine === 'sqlite') {
    if (value.transport !== 'ssh' || Object.hasOwn(value, 'address') || Object.hasOwn(value, 'port')
      || Object.hasOwn(value, 'username') || Object.hasOwn(value, 'password') || Object.hasOwn(value, 'clearPassword')
      || value.tlsMode !== 'disabled' || Object.hasOwn(value, 'tlsServerName')
      || !isServerOpsSqliteFilePath(value.filePath) || !isSqliteMainDatabase(value.database)) throw new Error(errorCode)
  } else if (value.address === undefined || value.port === undefined || Object.hasOwn(value, 'filePath')) throw new Error(errorCode)
  if (value.engine === 'redis' && value.database !== undefined && !/^(?:1[0-5]|[0-9])$/u.test(value.database)) throw new Error(errorCode)
  return {
    ...(value.projectId === undefined ? {} : { projectId: value.projectId }),
    transport: value.transport,
    ...(value.hostId === undefined ? {} : { hostId: value.hostId }),
    ...(value.sourceId === undefined ? {} : { sourceId: value.sourceId }),
    engine: value.engine,
    label: value.label,
    ...(value.address === undefined ? {} : { address: value.address }),
    ...(value.port === undefined ? {} : { port: value.port }),
    ...(value.filePath === undefined ? {} : { filePath: value.filePath }),
    ...(value.engine === 'sqlite' ? { database: 'main' } : value.database === undefined ? {} : { database: value.database }),
    ...(value.username === undefined ? {} : { username: value.username }),
    ...(value.password === undefined ? {} : { password: value.password }),
    ...(value.clearPassword === undefined ? {} : { clearPassword: value.clearPassword }),
    tlsMode: value.tlsMode,
    ...(value.tlsServerName === undefined ? {} : { tlsServerName: value.tlsServerName }),
  }
}

/** 严格解析数据源新建或编辑回执。 */
export function parseServerOpsDataSourceUpsertResult(value: unknown): ServerOpsDataSourceUpsertResult {
  const errorCode = 'SERVER_OPS_DATA_SOURCE_UPSERT_RESULT_INVALID'
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(['source']))) throw new Error(errorCode)
  return { source: parseServerOpsDataSource(value.source) }
}

/** 严格解析数据源删除输入。 */
export function parseServerOpsDataSourceDeleteInput(value: unknown): ServerOpsDataSourceDeleteInput {
  const errorCode = 'SERVER_OPS_DATA_SOURCE_DELETE_INPUT_INVALID'
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(['sourceId'])) || !isServerOpsId(value.sourceId)) throw new Error(errorCode)
  return { sourceId: value.sourceId }
}

/** 严格解析"读取已保存密码"输入。 */
export function parseServerOpsDataSourcePasswordInput(value: unknown): ServerOpsDataSourcePasswordInput {
  const errorCode = 'SERVER_OPS_DATA_SOURCE_PASSWORD_INPUT_INVALID'
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(['sourceId'])) || !isServerOpsId(value.sourceId)) throw new Error(errorCode)
  return { sourceId: value.sourceId }
}

/** 严格解析"读取已保存密码"结果；明文同样有长度上限，避免把异常大字符串带进界面。 */
export function parseServerOpsDataSourcePasswordResult(value: unknown): ServerOpsDataSourcePasswordResult {
  const errorCode = 'SERVER_OPS_DATA_SOURCE_PASSWORD_RESULT_INVALID'
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(['password']))) throw new Error(errorCode)
  if (value.password === null) return { password: null }
  if (!isSecretText(value.password)) throw new Error(errorCode)
  return { password: value.password }
}

/**
 * 严格解析未保存的数据连接草稿。
 *
 * 字段规则与写入合同保持一致（连接方式与跳板主机自洽、校验模式必须给真实主机名、
 * Redis 逻辑库 0-15），否则"测试通过、保存被拒"会成为一类稳定的假信号。
 *
 * @param value 未知输入
 * @returns 通过校验的草稿
 */
export function parseServerOpsDataSourceProbeDraft(value: unknown): ServerOpsDataSourceProbeDraft {
  const errorCode = 'SERVER_OPS_DATA_SOURCE_PROBE_INPUT_INVALID'
  const keys = new Set(['transport', 'hostId', 'engine', 'address', 'port', 'filePath', 'database', 'username',
    'password', 'savedSourceId', 'tlsMode', 'tlsServerName'])
  if (!isRecord(value) || !hasOnlyKeys(value, keys) || !isServerOpsDataTransport(value.transport)
    || (value.hostId !== undefined && !isServerOpsId(value.hostId))
    || !isServerOpsDataEngine(value.engine)
    || (value.address !== undefined && !isAddressText(value.address, 255))
    || (value.port !== undefined && !isPort(value.port))
    || (value.filePath !== undefined && !isServerOpsSqliteFilePath(value.filePath))
    || (value.database !== undefined && !isOptionalDataText(value.database, 64))
    || (value.username !== undefined && !isOptionalDataText(value.username, 128))
    || (value.password !== undefined && !isSecretText(value.password))
    || (value.savedSourceId !== undefined && !isServerOpsId(value.savedSourceId))
    || !isServerOpsDataTlsMode(value.tlsMode)
    || (value.tlsServerName !== undefined && !isAddressText(value.tlsServerName, 255))) throw new Error(errorCode)
  if ((value.tlsMode === 'verify' && value.tlsServerName === undefined)
    || (value.engine === 'redis' && value.tlsMode === 'preferred')
    || (value.engine === 'mysql' && value.tlsMode === 'verify'
      && !isServerOpsMySqlTlsServerName(value.tlsServerName))) throw new Error(errorCode)
  /** 内联密码与复用已保存密码只能二选一，避免"看起来在用新密码、实际用旧密文"。 */
  if (value.password !== undefined && value.savedSourceId !== undefined) throw new Error(errorCode)
  if ((value.transport === 'ssh') !== (value.hostId !== undefined)) throw new Error(errorCode)
  /** SQLite 探测也只接受 SSH 文件身份，禁止复用任何已保存数据库密码。 */
  if (value.engine === 'sqlite') {
    if (value.transport !== 'ssh' || Object.hasOwn(value, 'address') || Object.hasOwn(value, 'port')
      || Object.hasOwn(value, 'username') || Object.hasOwn(value, 'password') || Object.hasOwn(value, 'savedSourceId')
      || value.tlsMode !== 'disabled' || Object.hasOwn(value, 'tlsServerName')
      || !isServerOpsSqliteFilePath(value.filePath) || !isSqliteMainDatabase(value.database)) throw new Error(errorCode)
  } else if (value.address === undefined || value.port === undefined || Object.hasOwn(value, 'filePath')) throw new Error(errorCode)
  if (value.engine === 'redis' && value.database !== undefined && !/^(?:1[0-5]|[0-9])$/u.test(value.database)) throw new Error(errorCode)
  return {
    transport: value.transport,
    ...(value.hostId === undefined ? {} : { hostId: value.hostId }),
    engine: value.engine,
    ...(value.address === undefined ? {} : { address: value.address }),
    ...(value.port === undefined ? {} : { port: value.port }),
    ...(value.filePath === undefined ? {} : { filePath: value.filePath }),
    ...(value.engine === 'sqlite' ? { database: 'main' } : value.database === undefined ? {} : { database: value.database }),
    ...(value.username === undefined ? {} : { username: value.username }),
    ...(value.password === undefined ? {} : { password: value.password }),
    ...(value.savedSourceId === undefined ? {} : { savedSourceId: value.savedSourceId }),
    tlsMode: value.tlsMode,
    ...(value.tlsServerName === undefined ? {} : { tlsServerName: value.tlsServerName }),
  }
}

/** 严格解析连接测试输入：已保存的数据源或未保存草稿。 */
export function parseServerOpsDataSourceProbeInput(value: unknown): ServerOpsDataSourceProbeInput {
  const errorCode = 'SERVER_OPS_DATA_SOURCE_PROBE_INPUT_INVALID'
  if (!isRecord(value)) throw new Error(errorCode)
  if (value.sourceId !== undefined) {
    if (!hasOnlyKeys(value, new Set(['sourceId'])) || !isServerOpsId(value.sourceId)) throw new Error(errorCode)
    return { sourceId: value.sourceId }
  }
  if (!hasOnlyKeys(value, new Set(['draft']))) throw new Error(errorCode)
  return { draft: parseServerOpsDataSourceProbeDraft(value.draft) }
}

/** 严格解析连接测试结果。 */
export function parseServerOpsDataProbeResult(value: unknown): ServerOpsDataProbeResult {
  const errorCode = 'SERVER_OPS_DATA_PROBE_RESULT_INVALID'
  const keys = new Set(['sourceId', 'engine', 'capability', 'serverVersion', 'latencyMs', 'tlsStatus', 'warnings'])
  if (!isRecord(value) || !hasOnlyKeys(value, keys)
    || (value.sourceId !== undefined && !isServerOpsId(value.sourceId))
    || !isServerOpsDataEngine(value.engine) || !isServerOpsDataCapability(value.capability)
    || (value.serverVersion !== undefined && !isDisplayString(value.serverVersion, 128))
    || (value.tlsStatus !== undefined && !isServerOpsDataTlsStatus(value.tlsStatus))
    || (value.latencyMs !== undefined && (typeof value.latencyMs !== 'number' || !Number.isSafeInteger(value.latencyMs)
      || value.latencyMs < 0 || value.latencyMs > 600_000))) throw new Error(errorCode)
  if (value.capability !== 'available' && (value.serverVersion !== undefined || value.latencyMs !== undefined
    || value.tlsStatus !== undefined)) throw new Error(errorCode)
  if (value.engine === 'sqlite' && value.tlsStatus !== undefined) throw new Error(errorCode)
  if (value.capability === 'available' && value.serverVersion === undefined) throw new Error(errorCode)
  return {
    ...(value.sourceId === undefined ? {} : { sourceId: value.sourceId }),
    engine: value.engine,
    capability: value.capability,
    ...(value.serverVersion === undefined ? {} : { serverVersion: value.serverVersion }),
    ...(value.latencyMs === undefined ? {} : { latencyMs: value.latencyMs }),
    ...(value.tlsStatus === undefined ? {} : { tlsStatus: value.tlsStatus }),
    warnings: parseWarnings(value.warnings, errorCode),
  }
}

/** 严格解析只读诊断输入。 */
export function parseServerOpsDataDiagnoseInput(value: unknown): ServerOpsDataDiagnoseInput {
  const errorCode = 'SERVER_OPS_DATA_DIAGNOSE_INPUT_INVALID'
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(['sourceId', 'section', 'database'])) || !isServerOpsId(value.sourceId)
    || (value.section !== undefined && value.section !== 'overview' && value.section !== 'sessions'
      && value.section !== 'statements' && value.section !== 'parameters')
    || (value.database !== undefined && (typeof value.database !== 'string' || value.database.length > 64
      || value.database.trim().length === 0 || /\p{Cc}/u.test(value.database)
      || (value.section !== 'sessions' && value.section !== 'statements')))) throw new Error(errorCode)
  return {
    sourceId: value.sourceId,
    ...(value.section === undefined ? {} : { section: value.section }),
    ...(value.database === undefined ? {} : { database: value.database }),
  }
}

/** 严格解析只读诊断结果。 */
export function parseServerOpsDataDiagnosticsResult(value: unknown): ServerOpsDataDiagnosticsResult {
  const errorCode = 'SERVER_OPS_DATA_DIAGNOSTICS_RESULT_INVALID'
  const keys = new Set(['sourceId', 'engine', 'capability', 'collectedAt', 'tlsStatus', 'metrics', 'tables', 'parameters', 'parametersTruncated', 'warnings'])
  if (!isRecord(value) || !hasOnlyKeys(value, keys) || !isServerOpsId(value.sourceId)
    || !isServerOpsDataEngine(value.engine) || !isServerOpsDataCapability(value.capability)
    || !isTimestamp(value.collectedAt)
    || (value.tlsStatus !== undefined && !isServerOpsDataTlsStatus(value.tlsStatus))
    || !Array.isArray(value.metrics) || value.metrics.length > 24
    || !Array.isArray(value.tables) || value.tables.length > 4
    || (value.parameters !== undefined && (!Array.isArray(value.parameters) || value.parameters.length > 1_000))
    || (value.parametersTruncated !== undefined && typeof value.parametersTruncated !== 'boolean')) throw new Error(errorCode)
  /** 参数逐项解析并限制公开字段，避免异常服务端值穿过 IPC。 */
  const parameters = value.parameters === undefined ? undefined : value.parameters.map((entry) => {
    if (!isRecord(entry) || !hasOnlyKeys(entry, new Set(['name', 'value', 'scope']))
      || !isDisplayString(entry.name, 128) || !isDisplayString(entry.value, 1_024, true) || entry.scope !== 'global') {
      throw new Error(errorCode)
    }
    return { name: entry.name, value: entry.value, scope: 'global' as const }
  })
  if (parameters !== undefined && new TextEncoder().encode(JSON.stringify(parameters)).byteLength > 262_144) throw new Error(errorCode)
  if (value.capability !== 'available' && (value.metrics.length > 0 || value.tables.length > 0 || (parameters?.length ?? 0) > 0)) throw new Error(errorCode)
  if ((value.capability !== 'available' || value.engine === 'sqlite') && value.tlsStatus !== undefined) throw new Error(errorCode)
  return {
    sourceId: value.sourceId,
    engine: value.engine,
    capability: value.capability,
    collectedAt: value.collectedAt,
    ...(value.tlsStatus === undefined ? {} : { tlsStatus: value.tlsStatus }),
    metrics: value.metrics.map((entry) => parseServerOpsDataMetric(entry, errorCode)),
    tables: value.tables.map((entry) => parseServerOpsDataTable(entry, errorCode)),
    ...(parameters === undefined ? {} : { parameters }),
    ...(value.parametersTruncated === undefined ? {} : { parametersTruncated: value.parametersTruncated }),
    warnings: parseWarnings(value.warnings, errorCode),
  }
}
