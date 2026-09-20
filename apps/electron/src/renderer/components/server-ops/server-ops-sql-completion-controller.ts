import type { ServerOpsDataSourceTableInput, ServerOpsDataSourceTableResult, ServerOpsDataSourceTablesInput, ServerOpsDataSourceTablesResult } from '@proma/shared'
import type { ServerOpsSqlCompletionSchema } from './server-ops-sql-completion'
import { enqueueServerOpsDataRead } from './server-ops-data-request-queue'

/** 结构接口独立于查询接口，旧 preload 缺失时编辑器仍能输入关键字。 */
export interface ServerOpsSqlCompletionApi {
  listServerOpsDataSchemaTables?: (input: ServerOpsDataSourceTablesInput) => Promise<ServerOpsDataSourceTablesResult>
  describeServerOpsDataSchemaTable?: (input: ServerOpsDataSourceTableInput) => Promise<ServerOpsDataSourceTableResult>
}

/** 页面切换和连接可达性共同构成缓存投影的生命周期。 */
export interface ServerOpsSqlCompletionContext {
  sourceId: string
  database: string | null
  configurationKey: string
  available: boolean
}

/** 只发布元数据、加载状态和面向用户的错误信息。 */
export interface ServerOpsSqlCompletionProjection extends ServerOpsSqlCompletionSchema {
  status: 'idle' | 'loading' | 'ready' | 'error'
  pendingTables: number
  error: string | null
  tablesTruncated: boolean
}

/** 时间可注入，便于验证过期行为而不等待真实十分钟。 */
interface CompletionControllerOptions {
  api: ServerOpsSqlCompletionApi
  publish: (projection: ServerOpsSqlCompletionProjection) => void
  now?: () => number
}

/** 页面元数据最长保留十分钟；后端独立验证持久缓存时效。 */
const SCHEMA_TTL_MS = 10 * 60 * 1000
/** 单次补全最多加载十六张引用表，避免异常长 SQL 产生大量 IPC。 */
const MAX_REFERENCED_TABLES = 16
/** 字段常驻最多三十二张表，防止长时间编辑累积全库结构。 */
const MAX_CACHED_TABLES = 32

/** 创建空投影，连接或库切换时立即清除旧候选。 */
export function createServerOpsSqlCompletionIdleProjection(): ServerOpsSqlCompletionProjection {
  return { contextKey: '', database: null, tables: [], columns: Object.create(null), status: 'idle', pendingTables: 0, error: null, tablesTruncated: false }
}

/** 同一连接配置与可达性才允许共享页面候选。 */
export function getServerOpsSqlCompletionContextKey(context: ServerOpsSqlCompletionContext): string {
  return JSON.stringify([context.sourceId, context.database, context.configurationKey, context.available])
}

/** 按需读取表目录和字段，串行字段 IPC、合并重复请求并拒绝迟到回执。 */
export function createServerOpsSqlCompletionController(options: CompletionControllerOptions) {
  let state = createServerOpsSqlCompletionIdleProjection()
  /** 挂载 owner 与上下文代次阻止 StrictMode/切库后的旧结果回填。 */
  let active = false
  let generation = 0
  let context: ServerOpsSqlCompletionContext | null = null
  /** 记录最近目录时间及每张表的读取时间。 */
  let catalogAt = 0
  const columnTimes = new Map<string, number>()
  /** 错误只在显式刷新时重试，避免每个按键重发失败请求。 */
  const failedTables = new Set<string>()
  const inFlight = new Map<string, Promise<void>>()
  let catalogRequest: Promise<void> | null = null
  const now = options.now ?? Date.now

  /** 发布不可变外壳，内部字典只通过复制替换更新。 */
  const patch = (next: Partial<ServerOpsSqlCompletionProjection>): void => {
    state = { ...state, ...next }
    if (active) options.publish(state)
  }
  /** 清空当前结构与请求归属；已发 IPC 自行完成但不可发布。 */
  const reset = (): void => {
    generation += 1
    columnTimes.clear(); failedTables.clear(); inFlight.clear(); catalogRequest = null
    state = { ...createServerOpsSqlCompletionIdleProjection(), contextKey: context ? getServerOpsSqlCompletionContextKey(context) : '', database: context?.database ?? null }
    patch({})
  }
  /** 目录读取成功后仅保留匹配当前库的表；刷新首先使字段全部失效。 */
  const loadCatalog = (refresh = false): Promise<void> => {
    if (!active || !context?.database || !context.available) return Promise.resolve()
    if (catalogRequest && !refresh) return catalogRequest
    if (refresh) reset()
    const owner = generation
    const selected = { sourceId: context.sourceId, database: context.database, cacheMode: refresh ? 'refresh' as const : 'prefer-cache' as const }
    const valid = (): boolean => active && generation === owner
    const list = options.api.listServerOpsDataSchemaTables
    if (!list) { patch({ status: 'error', error: '结构联想接口尚未就绪，请重启应用后重试' }); return Promise.resolve() }
    patch({ status: 'loading', error: null })
    const request = enqueueServerOpsDataRead(options.api, `${selected.sourceId}:schema-tables`, JSON.stringify([state.contextKey, selected]), () => list(selected), valid)
      .then((result) => {
        if (!valid()) return
        if (result.database !== selected.database) throw new Error('SCHEMA_DATABASE_MISMATCH')
        catalogAt = now()
        patch({ tables: result.tables, tablesTruncated: result.tablesTruncated ?? false, status: 'ready', error: null })
      }).catch(() => {
        if (valid()) patch({ tables: [], columns: Object.create(null), status: 'error', error: '读取数据库结构失败，可点击「刷新结构」重试' })
      }).finally(() => { if (catalogRequest === request) catalogRequest = null })
    catalogRequest = request
    return request
  }
  /** 所有联想位置都检查目录时效；仅表名输入也不会无限使用旧表目录。 */
  const ensureCatalog = async (): Promise<void> => {
    if (catalogRequest) await catalogRequest
    else if (state.status === 'ready' && now() - catalogAt >= SCHEMA_TTL_MS) await loadCatalog()
  }
  /** 加载当前 SQL 明确引用的字段，不预取全库；重复请求复用同一 Promise。 */
  const ensureColumns = async (tables: string[]): Promise<void> => {
    if (!active || !context?.database || !context.available) return
    const owner = generation
    await ensureCatalog()
    if (!active || owner !== generation || state.status !== 'ready') return
    const describe = options.api.describeServerOpsDataSchemaTable
    if (!describe) return
    const requests: Promise<void>[] = []
    for (const table of [...new Set(tables)].slice(0, MAX_REFERENCED_TABLES)) {
      if (!state.tables.some((entry) => entry.name === table && entry.type !== 'view') || failedTables.has(table)) continue
      const collectedAt = columnTimes.get(table)
      if (collectedAt !== undefined && now() - collectedAt < SCHEMA_TTL_MS) continue
      const existing = inFlight.get(table)
      if (existing) { requests.push(existing); continue }
      /** 多个连续补全请求共享总预算，防止快速改写 SQL 累积长队列。 */
      if (inFlight.size >= MAX_REFERENCED_TABLES) break
      /** 过期结构先撤下，读取失败时也不能把旧权限下的字段继续用于补全。 */
      if (Object.hasOwn(state.columns, table)) {
        const columns = { ...state.columns }
        delete columns[table]; columnTimes.delete(table); patch({ columns })
      }
      /** 所有字段使用同一数据源队列，最多一个远端字段请求在运行。 */
      const input = { sourceId: context.sourceId, database: context.database, table, cacheMode: 'prefer-cache' as const }
      const valid = (): boolean => active && owner === generation
      const request = enqueueServerOpsDataRead(options.api, `${input.sourceId}:schema-table`, JSON.stringify([state.contextKey, input]), () => describe(input), valid)
        .then((result) => {
          if (!valid()) return
          const columns = { ...state.columns, [table]: result.columns }
          columnTimes.delete(table); columnTimes.set(table, now())
          while (columnTimes.size > MAX_CACHED_TABLES) {
            const oldest = columnTimes.keys().next().value!
            columnTimes.delete(oldest); delete columns[oldest]
          }
          patch({ columns })
        }).catch(() => {
          if (valid()) { failedTables.add(table); patch({ error: '部分表字段读取失败，可点击「刷新结构」重试' }) }
        }).finally(() => {
          if (inFlight.get(table) === request) inFlight.delete(table)
          if (valid()) patch({ pendingTables: inFlight.size })
        })
      inFlight.set(table, request); requests.push(request)
    }
    patch({ pendingTables: inFlight.size })
    await Promise.all(requests)
  }
  return {
    /** 返回当前只读投影，供稳定的补全源读取最新元数据。 */
    snapshot: (): ServerOpsSqlCompletionProjection => state,
    /** 页面挂载或 StrictMode 重放时重新读取当前上下文。 */
    activate(): void { if (active) return; active = true; reset(); if (context) void loadCatalog() },
    /** 停止发布并失效在途结果，不保留已卸载页面的元数据。 */
    dispose(): void { active = false; reset() },
    /** 切换数据库/配置/可达性时立即清空候选并获取新目录。 */
    setContext(next: ServerOpsSqlCompletionContext): void {
      if (context && getServerOpsSqlCompletionContextKey(context) === getServerOpsSqlCompletionContextKey(next)) return
      context = { ...next }; reset(); void loadCatalog()
    },
    ensureColumns,
    ensureCatalog,
    /** 手动刷新先使字段缓存失效，后续补全按需重新读取。 */
    refresh: (): Promise<void> => loadCatalog(true),
  }
}
