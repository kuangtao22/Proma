import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  isServerOpsId,
  parseServerOpsDataSourceTableResult,
  parseServerOpsDataSourceTablesResult,
} from '@proma/shared'
import type {
  ServerOpsDataSourceTableResult,
  ServerOpsDataSourceTablesResult,
} from '@proma/shared'
import { getConfigDir } from '../config-paths'
import { readAtomicFileState, readJsonFileStrict, writeJsonFileAtomicSecure } from '../safe-file'
import type { AtomicDestinationExpectation, ReadJsonFileStrictOptions } from '../safe-file'
import {
  createServerOpsConfigTransaction,
  resolveServerOpsConfigFilePath,
} from './server-ops-config-transaction'
import type { ServerOpsConfigTransaction } from './server-ops-config-transaction'

/** schema 缓存与其它运维配置共用的固定目录。 */
const SERVER_OPS_DIRECTORY = 'server-ops'
/** schema 缓存固定文件名。 */
const SERVER_OPS_DATA_SCHEMA_CACHE_FILENAME = 'schema-cache.json'
/** schema 缓存持久化版本。 */
const SERVER_OPS_DATA_SCHEMA_CACHE_VERSION = 1
/** 缓存项有效期固定为十分钟。 */
export const SERVER_OPS_DATA_SCHEMA_CACHE_TTL_MS = 10 * 60_000
/** 磁盘与内存最多保留的缓存项数。 */
export const SERVER_OPS_DATA_SCHEMA_CACHE_MAX_ENTRIES = 256
/** pretty JSON 文件总预算。 */
export const SERVER_OPS_DATA_SCHEMA_CACHE_MAX_BYTES = 4 * 1024 * 1024

/** 可缓存的目录范围。 */
export interface ServerOpsDataSchemaTablesCacheScope {
  kind: 'tables'
  sourceId: string
  database?: string
}

/** 可缓存的单表结构范围。 */
export interface ServerOpsDataSchemaTableCacheScope {
  kind: 'table'
  sourceId: string
  database: string
  table: string
}

/** schema 缓存的精确范围。 */
export type ServerOpsDataSchemaCacheScope = ServerOpsDataSchemaTablesCacheScope | ServerOpsDataSchemaTableCacheScope
/** 与范围对应的公开结果。 */
export type ServerOpsDataSchemaCacheValue = ServerOpsDataSourceTablesResult | ServerOpsDataSourceTableResult

/** 单条持久化缓存记录。 */
interface ServerOpsDataSchemaCacheEntry {
  scope: ServerOpsDataSchemaCacheScope
  identity: string
  cachedAt: number
  value: ServerOpsDataSchemaCacheValue
}

/** schema 缓存文件根结构。 */
interface ServerOpsDataSchemaCacheFile {
  version: typeof SERVER_OPS_DATA_SCHEMA_CACHE_VERSION
  /** 每次写入或失效都推进，阻断刷新前在途读取迟到回填。 */
  revision: number
  entries: ServerOpsDataSchemaCacheEntry[]
}

/** 一次 fresh-read 查询；缓存 miss 也返回当前跨实例 revision。 */
export interface ServerOpsDataSchemaCacheLookup {
  revision: number
  value?: ServerOpsDataSchemaCacheValue
  cachedAt?: number
}

/** 缓存 Store 可替换的安全文件与时间依赖。 */
export interface ServerOpsDataSchemaCacheDependencies {
  /** 严格读取 JSON；真正缺失返回 null，存在但所有候选损坏时抛错。 */
  readJson: <T>(filePath: string, options: ReadJsonFileStrictOptions<T>) => T | null
  writeJson: (filePath: string, data: object, expectedDestination: AtomicDestinationExpectation, priorBackup?: object) => void
  now: () => number
  transaction?: ServerOpsConfigTransaction
}

/** 判断未知值是否为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 判断缓存范围文本是否有界且不含控制字符。 */
function isCacheScopeText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
    && !/[\u0000-\u001f\u007f]/u.test(value)
}

/** 严格解析缓存范围。 */
function parseScope(value: unknown): ServerOpsDataSchemaCacheScope {
  if (!isRecord(value) || !isServerOpsId(value.sourceId)) throw new Error('SERVER_OPS_DATA_SCHEMA_CACHE_INVALID')
  if (value.kind === 'tables') {
    const keys = new Set(['kind', 'sourceId'].concat(value.database === undefined ? [] : ['database']))
    if (Object.keys(value).length !== keys.size || Object.keys(value).some((key) => !keys.has(key))
      || (value.database !== undefined && !isCacheScopeText(value.database, 64))) throw new Error('SERVER_OPS_DATA_SCHEMA_CACHE_INVALID')
    return { kind: 'tables', sourceId: value.sourceId, ...(value.database === undefined ? {} : { database: value.database }) }
  }
  if (value.kind === 'table' && isCacheScopeText(value.database, 64) && isCacheScopeText(value.table, 128)
    && Object.keys(value).length === 4
    && Object.keys(value).every((key) => ['kind', 'sourceId', 'database', 'table'].includes(key))) {
    return { kind: 'table', sourceId: value.sourceId, database: value.database, table: value.table }
  }
  throw new Error('SERVER_OPS_DATA_SCHEMA_CACHE_INVALID')
}

/** 按缓存范围解析公开结果，并拒绝目录结果串入其它数据库。 */
function parseCacheValue(
  scope: ServerOpsDataSchemaCacheScope,
  value: unknown,
): ServerOpsDataSchemaCacheValue {
  if (scope.kind === 'table') return parseServerOpsDataSourceTableResult(value)
  const parsed = parseServerOpsDataSourceTablesResult(value)
  if (parsed.database !== undefined && parsed.database !== scope.database) {
    throw new Error('SERVER_OPS_DATA_SCHEMA_CACHE_INVALID')
  }
  return parsed
}

/** 严格解析派生缓存文件，拒绝未知字段和重复键。 */
function parseCacheFile(value: unknown): ServerOpsDataSchemaCacheFile {
  if (!isRecord(value) || value.version !== SERVER_OPS_DATA_SCHEMA_CACHE_VERSION || !Array.isArray(value.entries)
    || value.entries.length > SERVER_OPS_DATA_SCHEMA_CACHE_MAX_ENTRIES
    || typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision < 0
    || Object.keys(value).length !== 3 || !Object.hasOwn(value, 'version')
    || !Object.hasOwn(value, 'revision') || !Object.hasOwn(value, 'entries')) {
    throw new Error('SERVER_OPS_DATA_SCHEMA_CACHE_INVALID')
  }
  /** 用于拒绝完全相同范围与身份的重复记录。 */
  const keys = new Set<string>()
  const entries = value.entries.map((candidate): ServerOpsDataSchemaCacheEntry => {
    if (!isRecord(candidate) || Object.keys(candidate).length !== 4
      || !Object.hasOwn(candidate, 'scope') || !Object.hasOwn(candidate, 'identity')
      || !Object.hasOwn(candidate, 'cachedAt') || !Object.hasOwn(candidate, 'value')
      || typeof candidate.identity !== 'string' || candidate.identity.length < 1 || candidate.identity.length > 128
      || typeof candidate.cachedAt !== 'number' || !Number.isSafeInteger(candidate.cachedAt) || candidate.cachedAt < 0) {
      throw new Error('SERVER_OPS_DATA_SCHEMA_CACHE_INVALID')
    }
    const scope = parseScope(candidate.scope)
    const parsedValue = parseCacheValue(scope, candidate.value)
    const key = getEntryKey(scope, candidate.identity)
    if (keys.has(key)) throw new Error('SERVER_OPS_DATA_SCHEMA_CACHE_INVALID')
    keys.add(key)
    return { scope, identity: candidate.identity, cachedAt: candidate.cachedAt, value: parsedValue }
  })
  return { version: SERVER_OPS_DATA_SCHEMA_CACHE_VERSION, revision: value.revision, entries }
}

/** safe-file validator：损坏候选可继续回退，全部损坏由严格读取边界抛错。 */
function isCacheFile(value: unknown): value is ServerOpsDataSchemaCacheFile {
  try { parseCacheFile(value); return true } catch { return false }
}

/** 生成精确缓存键，JSON 元组阻断分隔符碰撞。 */
function getEntryKey(scope: ServerOpsDataSchemaCacheScope, identity: string): string {
  return JSON.stringify([scope.kind, scope.sourceId, scope.database ?? null, scope.kind === 'table' ? scope.table : null, identity])
}

/** 深拷贝公开结果，阻断调用方修改 Store 快照。 */
function cloneValue<T extends ServerOpsDataSchemaCacheValue>(value: T): T {
  return structuredClone(value)
}

/** 管理 `server-ops/schema-cache.json` 的有界、可丢弃 schema 派生缓存。 */
export class ServerOpsDataSchemaCache {
  /** 缓存最终文件路径。 */
  private readonly filePath: string
  /** 可替换依赖。 */
  private readonly dependencies: ServerOpsDataSchemaCacheDependencies
  /** 覆盖 fresh-read 与提交的同步短事务。 */
  private readonly transaction: ServerOpsConfigTransaction
  /** 当前实例内镜像；每次公开操作前都会以磁盘 fresh-read 覆盖。 */
  private readonly memory = new Map<string, ServerOpsDataSchemaCacheEntry>()

  /** 创建缓存 Store，不在构造期信任或缓存磁盘内容。 */
  constructor(configDir = getConfigDir(), dependencies: Partial<ServerOpsDataSchemaCacheDependencies> = {}) {
    const directoryPath = join(configDir, SERVER_OPS_DIRECTORY)
    mkdirSync(directoryPath, { recursive: true })
    this.filePath = resolveServerOpsConfigFilePath(directoryPath, SERVER_OPS_DATA_SCHEMA_CACHE_FILENAME)
    this.dependencies = {
      readJson: readJsonFileStrict,
      writeJson: (filePath, data, expectedDestination, priorBackup) => {
        writeJsonFileAtomicSecure(filePath, data, {
          expectedDestination,
          ...(priorBackup ? { priorBackup: { filePath: `${filePath}.bak`, data: priorBackup } } : {}),
        })
      },
      now: Date.now,
      ...dependencies,
    }
    this.transaction = dependencies.transaction ?? createServerOpsConfigTransaction(directoryPath)
  }

  /** fresh-read 后按范围与完整安全身份读取未过期结果。 */
  get(scope: ServerOpsDataSchemaCacheScope, identity: string): { value: ServerOpsDataSchemaCacheValue; cachedAt: number } | undefined {
    const lookup = this.lookup(scope, identity)
    return lookup.value === undefined || lookup.cachedAt === undefined
      ? undefined
      : { value: lookup.value, cachedAt: lookup.cachedAt }
  }

  /** fresh-read 精确范围，并始终返回可用于写入 CAS 的 revision。 */
  lookup(scope: ServerOpsDataSchemaCacheScope, identity: string): ServerOpsDataSchemaCacheLookup {
    try {
      const loaded = this.readFile()
      this.replaceMemory(loaded.entries)
      const found = loaded.entries.find((entry) => getEntryKey(entry.scope, entry.identity) === getEntryKey(scope, identity))
      const age = this.dependencies.now() - (found?.cachedAt ?? 0)
      if (!found || age < 0 || age >= SERVER_OPS_DATA_SCHEMA_CACHE_TTL_MS) {
        return { revision: loaded.file.revision }
      }
      return { revision: loaded.file.revision, value: cloneValue(found.value), cachedAt: found.cachedAt }
    } catch (error) {
      this.memory.clear()
      throw error
    }
  }

  /** fresh-read、替换同键记录并按条数和字节预算提交。 */
  set(scope: ServerOpsDataSchemaCacheScope, identity: string, value: ServerOpsDataSchemaCacheValue): void {
    this.setInternal(scope, identity, value)
  }

  /** 仅在当前 revision 仍等于读取起点时提交。 */
  setIfRevision(scope: ServerOpsDataSchemaCacheScope, identity: string, value: ServerOpsDataSchemaCacheValue, expectedRevision: number): boolean {
    return this.setInternal(scope, identity, value, expectedRevision)
  }

  /** 执行带可选 revision CAS 的缓存写入。 */
  private setInternal(
    scope: ServerOpsDataSchemaCacheScope,
    identity: string,
    value: ServerOpsDataSchemaCacheValue,
    expectedRevision?: number,
  ): boolean {
    return this.transaction(() => {
      const loaded = this.readFile()
      if (expectedRevision !== undefined && loaded.file.revision !== expectedRevision) return false
      const now = this.dependencies.now()
      const nextEntry: ServerOpsDataSchemaCacheEntry = {
        scope: parseScope(scope), identity, cachedAt: now,
        value: parseCacheValue(scope, value),
      }
      const exactKey = getEntryKey(scope, identity)
      const next = [nextEntry, ...loaded.entries.filter((entry) => getEntryKey(entry.scope, entry.identity) !== exactKey)]
        .filter((entry) => now - entry.cachedAt <= SERVER_OPS_DATA_SCHEMA_CACHE_TTL_MS)
        .sort((left, right) => right.cachedAt - left.cachedAt)
        .slice(0, SERVER_OPS_DATA_SCHEMA_CACHE_MAX_ENTRIES)
      const nextRevision = loaded.file.revision + 1
      const limited = this.fitByteBudget(next, nextRevision)
      this.persist(limited, nextRevision, loaded.expectedDestination)
      this.replaceMemory(limited)
      return true
    })
  }

  /** 失效一个 source、一个库或一张表下的缓存。 */
  invalidate(scope: { sourceId: string; database?: string; table?: string }): void {
    this.transaction(() => {
      const loaded = this.readFile()
      const remaining = loaded.entries.filter((entry) => !(entry.scope.sourceId === scope.sourceId
        && (scope.database === undefined || entry.scope.database === scope.database)
        && (scope.table === undefined || (entry.scope.kind === 'table' && entry.scope.table === scope.table))))
      this.persist(remaining, loaded.file.revision + 1, loaded.expectedDestination)
      this.replaceMemory(remaining)
    })
  }

  /** fresh-read 当前文件并捕获对应目标身份。 */
  private readFile(): { file: ServerOpsDataSchemaCacheFile; entries: ServerOpsDataSchemaCacheEntry[]; expectedDestination: AtomicDestinationExpectation } {
    const loaded = this.dependencies.readJson(this.filePath, {
      validate: isCacheFile,
      description: 'schema 派生缓存',
      maxBytes: SERVER_OPS_DATA_SCHEMA_CACHE_MAX_BYTES,
      secureRecovery: true,
    })
    const file = loaded === null
      ? { version: SERVER_OPS_DATA_SCHEMA_CACHE_VERSION, revision: 0, entries: [] } satisfies ServerOpsDataSchemaCacheFile
      : parseCacheFile(loaded)
    return { file, entries: file.entries, expectedDestination: this.captureDestinationExpectation() }
  }

  /** 用最近记录前缀满足 4MiB 文件预算。 */
  private fitByteBudget(entries: ServerOpsDataSchemaCacheEntry[], revision: number): ServerOpsDataSchemaCacheEntry[] {
    let accepted = entries
    while (accepted.length > 0 && this.getFileBytes(accepted, revision) > SERVER_OPS_DATA_SCHEMA_CACHE_MAX_BYTES) {
      accepted = accepted.slice(0, -1)
    }
    return accepted
  }

  /** 计算与安全写入一致的 pretty JSON 字节数。 */
  private getFileBytes(entries: readonly ServerOpsDataSchemaCacheEntry[], revision: number): number {
    return new TextEncoder().encode(JSON.stringify({ version: SERVER_OPS_DATA_SCHEMA_CACHE_VERSION, revision, entries }, null, 2)).byteLength
  }

  /** 使用 safe-file 原子提交完整派生快照。 */
  private persist(
    entries: readonly ServerOpsDataSchemaCacheEntry[],
    revision: number,
    expectedDestination: AtomicDestinationExpectation,
  ): void {
    const file: ServerOpsDataSchemaCacheFile = {
      version: SERVER_OPS_DATA_SCHEMA_CACHE_VERSION,
      revision,
      entries: entries.map((entry) => ({ ...entry, scope: { ...entry.scope }, value: cloneValue(entry.value) })),
    }
    /** 派生缓存的 backup 必须与新主文件一致，避免 refresh 后恢复已失效旧结构。 */
    this.dependencies.writeJson(this.filePath, file, expectedDestination, file)
  }

  /** 用有界磁盘快照替换当前内存镜像。 */
  private replaceMemory(entries: readonly ServerOpsDataSchemaCacheEntry[]): void {
    this.memory.clear()
    for (const entry of entries.slice(0, SERVER_OPS_DATA_SCHEMA_CACHE_MAX_ENTRIES)) {
      this.memory.set(getEntryKey(entry.scope, entry.identity), { ...entry, scope: { ...entry.scope }, value: cloneValue(entry.value) })
    }
  }

  /** 捕获 fresh-read 对应的目标身份。 */
  private captureDestinationExpectation(): AtomicDestinationExpectation {
    const state = readAtomicFileState(this.filePath)
    return state === null ? { kind: 'missing' } : { kind: 'state', state }
  }
}
