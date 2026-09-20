import type {
  ServerOpsDataSourceRowsInput, ServerOpsDataSourceRowsResult,
  ServerOpsDataSourceTableInput, ServerOpsDataSourceTableResult,
  ServerOpsDataSourceTablesInput, ServerOpsDataSourceTablesResult,
} from '@proma/shared'
import { enqueueServerOpsDataRead } from './server-ops-data-request-queue'
import { getServerOpsDataErrorMessage } from './server-ops-data-display'

/** 表浏览独立 API；读取来源始终由主进程验证。 */
export interface ServerOpsSchemaBrowserApi {
  listServerOpsDataSchemaTables(input: ServerOpsDataSourceTablesInput): Promise<ServerOpsDataSourceTablesResult>
  describeServerOpsDataSchemaTable(input: ServerOpsDataSourceTableInput): Promise<ServerOpsDataSourceTableResult>
  readServerOpsDataSchemaRows(input: ServerOpsDataSourceRowsInput): Promise<ServerOpsDataSourceRowsResult>
}

/** 表内页面按用户任务分类。 */
export type ServerOpsSchemaDetailTab = 'data' | 'structure' | 'indexes' | 'properties'

/** 每个读取区域独立展示加载、错误及最近成功时间。 */
export interface ServerOpsSchemaLoadState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  error: string | null
  collectedAt?: number
}

/** 不含凭据的来源身份，配置版本更新即作废旧结果。 */
export interface ServerOpsSchemaSource {
  id: string
  engine: 'mysql' | 'redis'
  database?: string
  updatedAt?: number
  /** 完整有效连接配置，避免同 ID / 同时间戳的地址变更复用旧请求。 */
  readIdentity?: string
}

/** 完整浏览投影只保留当前目录、当前表描述及当前页。 */
export interface ServerOpsSchemaBrowserProjection extends ServerOpsSchemaLoadState {
  sourceId: string | null
  engine: 'mysql' | 'redis' | null
  databases: string[]
  database: string | null
  tables: ServerOpsDataSourceTablesResult['tables']
  databasesTruncated?: boolean
  tablesTruncated?: boolean
  selectedTable: string | null
  detailTab: ServerOpsSchemaDetailTab
  structure: ServerOpsSchemaLoadState & ServerOpsDataSourceTableResult
  rows: ServerOpsSchemaLoadState & ServerOpsDataSourceRowsResult
}

/** 仅保留轻量导航，不包括查询结果或密码。 */
export interface ServerOpsSchemaNavigation {
  database: string | null
  table: string | null
  detailTab: ServerOpsSchemaDetailTab
  offset: number
}

/** 控制器输入；恢复导航会先验证库、表仍可见。 */
export interface ServerOpsSchemaBrowserControllerOptions {
  api: ServerOpsSchemaBrowserApi
  pageSize?: number
  initialNavigation?: ServerOpsSchemaNavigation
  publish: (projection: ServerOpsSchemaBrowserProjection) => void
}

/** 浏览操作与目录刷新分开，防止刷新当前页重置表选择。 */
export interface ServerOpsSchemaBrowserController {
  getProjection(): ServerOpsSchemaBrowserProjection
  activate(): void
  dispose(): void
  setSource(source: ServerOpsSchemaSource | null, readable?: boolean): void
  selectDatabase(database: string): void
  openTable(table: string): void
  backToList(): void
  setDetailTab(tab: ServerOpsSchemaDetailTab): void
  loadRows(offset: number): void
  refresh(): void
  refreshTables(): void
}

/** 创建不含请求和结果的初始状态。 */
export function createServerOpsSchemaIdleProjection(): ServerOpsSchemaBrowserProjection {
  return {
    sourceId: null, engine: null, status: 'idle', error: null,
    databases: [], database: null, tables: [], selectedTable: null, detailTab: 'data',
    structure: { status: 'idle', error: null, columns: [], indexes: [] },
    rows: { status: 'idle', error: null, columns: [], rows: [], offset: 0, limit: 50, truncated: false },
  }
}

/** 创建带独立请求代次的浏览控制器，迟到结果只能写回原目标。 */
export function createServerOpsSchemaBrowserController(options: ServerOpsSchemaBrowserControllerOptions): ServerOpsSchemaBrowserController {
  /** 每页行数与主进程合同一致。 */
  const pageSize = Math.min(200, Math.max(1, Math.trunc(options.pageSize ?? 50)))
  /** 当前投影与订阅归属。 */
  let projection = createServerOpsSchemaIdleProjection()
  let active = false
  let ownerRevision = 0
  /** 各区域独立代次，切页不会丢弃另一区域的在途结果。 */
  let catalogRevision = 0
  let tableRevision = 0
  let structureRevision = 0
  let rowsRevision = 0
  /** 当前配置身份与首读标志。 */
  let sourceKey: string | null = null
  let initialCatalog = true
  /** SSH 可达性独立于配置身份；断线时释放结果，重连重新验证导航。 */
  let readable = false
  /** 只在首次有效目录返回后恢复一次。 */
  let resume = options.initialNavigation

  /** 将不可变状态发布给仍有效的 owner。 */
  const patch = (update: Partial<ServerOpsSchemaBrowserProjection>): void => {
    projection = { ...projection, ...update }
    if (active) options.publish(projection)
  }
  /** 清空目标正文，绝不把前一个库/表的数据留在新标题下。 */
  const resetTable = (): void => {
    tableRevision += 1
    patch({ selectedTable: null, detailTab: 'data', structure: createServerOpsSchemaIdleProjection().structure,
      rows: { ...createServerOpsSchemaIdleProjection().rows, limit: pageSize } })
  }
  /** 单表描述和数据的共同身份；每次发起时固定，不读取后来的选择。 */
  const target = (): ServerOpsDataSourceTableInput | null => projection.sourceId && projection.database && projection.selectedTable
    ? { sourceId: projection.sourceId, database: projection.database, table: projection.selectedTable } : null

  /** 读取表描述；结构/索引共享一次结果。 */
  const loadStructure = (): void => {
    const selected = target()
    if (!selected || !active || !readable || projection.structure.status === 'loading') return
    const owner = ownerRevision
    const table = tableRevision
    const revision = ++structureRevision
    const valid = (): boolean => active && owner === ownerRevision && table === tableRevision && revision === structureRevision
    patch({ structure: { ...projection.structure, status: 'loading', error: null } })
    void enqueueServerOpsDataRead(options.api, `${selected.sourceId}:schema-table`, JSON.stringify([sourceKey, selected]),
      () => options.api.describeServerOpsDataSchemaTable(selected), valid).then((result) => {
      if (valid()) patch({ structure: { ...result, status: 'ready', error: null, collectedAt: Date.now() } })
    }, (error: unknown) => {
      if (valid()) patch({ structure: { ...projection.structure, status: 'error', error: getServerOpsDataErrorMessage(error) } })
    })
  }

  /** 读取一页数据；换页清空旧页，同页刷新保留最近成功结果。 */
  const loadRows = (offset: number): void => {
    const selected = target()
    if (!selected || !active || !readable || !Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000 || offset % pageSize !== 0) return
    if (projection.rows.status === 'loading' && projection.rows.offset === offset) return
    const owner = ownerRevision
    const table = tableRevision
    const revision = ++rowsRevision
    const valid = (): boolean => active && owner === ownerRevision && table === tableRevision && revision === rowsRevision
    const input = { ...selected, offset, limit: pageSize }
    patch({ rows: { ...(projection.rows.offset === offset ? projection.rows : createServerOpsSchemaIdleProjection().rows),
      status: 'loading', error: null, offset, limit: pageSize } })
    void enqueueServerOpsDataRead(options.api, `${selected.sourceId}:schema-rows`, JSON.stringify([sourceKey, input]),
      () => options.api.readServerOpsDataSchemaRows(input), valid).then((result) => {
      if (valid()) patch({ rows: { ...result, status: 'ready', error: null, collectedAt: Date.now() } })
    }, (error: unknown) => {
      if (valid()) patch({ rows: { ...projection.rows, status: 'error', error: getServerOpsDataErrorMessage(error) } })
    })
  }

  /** 选择新表默认读取数据；恢复导航可指定原来的表内页面。 */
  const openTable = (table: string, tab: ServerOpsSchemaDetailTab = 'data', offset = 0): void => {
    if (!projection.tables.some((entry) => entry.name === table) || projection.selectedTable === table) return
    resetTable()
    /** 结构/索引恢复也保留数据页码，但只在切回数据时读取该页。 */
    patch({ selectedTable: table, detailTab: tab, rows: { ...projection.rows, offset } })
    if (tab === 'data') loadRows(offset)
    else if (tab !== 'properties') loadStructure()
  }

  /** 读取目录；首次省略库名，由主进程只在配置库有效时预选。 */
  const loadTables = (database: string | null, initial = false): void => {
    const sourceId = projection.sourceId
    if (!sourceId || !active || !readable || projection.engine !== 'mysql') return
    const owner = ownerRevision
    const revision = ++catalogRevision
    const valid = (): boolean => active && owner === ownerRevision && revision === catalogRevision
    const input = database === null || initial ? { sourceId } : { sourceId, database }
    initialCatalog = initial
    patch({ status: 'loading', error: null })
    void enqueueServerOpsDataRead(options.api, `${sourceId}:schema-tables`, JSON.stringify([sourceKey, input]),
      () => options.api.listServerOpsDataSchemaTables(input), valid).then((result) => {
      if (!valid()) return
      initialCatalog = false
      patch({ status: 'ready', error: null, collectedAt: Date.now(), databases: result.databases, database: result.database ?? null,
        tables: result.tables, tablesTruncated: result.tablesTruncated, databasesTruncated: result.databasesTruncated })
      if (projection.selectedTable && !result.tables.some((entry) => entry.name === projection.selectedTable)) resetTable()
      if (resume) {
        /** 只有恢复的库仍可见才继续，不猜另一库。 */
        const saved = resume
        if (saved.database && result.databases.includes(saved.database) && saved.database !== projection.database) {
          patch({ database: saved.database, tables: [] })
          loadTables(saved.database)
          return
        }
        resume = undefined
        if (saved.database === projection.database && saved.table) openTable(saved.table, saved.detailTab, saved.offset)
      }
    }, (error: unknown) => {
      if (valid()) patch({ status: 'error', error: getServerOpsDataErrorMessage(error) })
    })
  }

  return {
    getProjection: () => projection,
    activate(): void {
      if (active) return
      active = true
      ownerRevision += 1
      /** StrictMode 重放重新订阅原请求，协调器避免重复 IPC。 */
      const catalogLoading = projection.status === 'loading'
      const rowsLoading = projection.rows.status === 'loading'
      const structureLoading = projection.structure.status === 'loading'
      if (rowsLoading) projection = { ...projection, rows: { ...projection.rows, status: 'idle' } }
      if (structureLoading) projection = { ...projection, structure: { ...projection.structure, status: 'idle' } }
      options.publish(projection)
      if (catalogLoading) loadTables(projection.database, initialCatalog)
      if (rowsLoading) loadRows(projection.rows.offset)
      if (structureLoading) loadStructure()
    },
    dispose(): void { active = false; ownerRevision += 1 },
    setSource(source, nextReadable = true): void {
      /** 相同配置只改变可达性时保留轻导航；真实配置变更必须丢弃。 */
      const key = source ? JSON.stringify([source.id, source.engine, source.database, source.updatedAt, source.readIdentity]) : null
      const canRead = source?.engine === 'mysql' && nextReadable
      const configurationChanged = key !== sourceKey
      if (!configurationChanged && readable === canRead) return
      /** 初始化之外的配置变更不允许恢复旧配置的库表导航。 */
      if (configurationChanged && sourceKey !== null) resume = undefined
      /** 多段目录恢复尚未结束时，完整 resume 优先于当前半成品投影。 */
      else if (!configurationChanged && readable && !canRead && projection.database && !resume) {
        resume = { database: projection.database, table: projection.selectedTable, detailTab: projection.detailTab, offset: projection.rows.offset }
      }
      sourceKey = key
      readable = canRead
      ownerRevision += 1
      catalogRevision += 1
      tableRevision += 1
      projection = { ...createServerOpsSchemaIdleProjection(), sourceId: source?.id ?? null, engine: source?.engine ?? null }
      patch({})
      if (readable) loadTables(null, true)
    },
    selectDatabase(database): void {
      if (!database || database === projection.database) return
      resume = undefined
      resetTable()
      patch({ database, tables: [], collectedAt: undefined })
      loadTables(database)
    },
    openTable,
    backToList: resetTable,
    setDetailTab(tab): void {
      patch({ detailTab: tab })
      if (tab === 'data' && projection.rows.status === 'idle') loadRows(projection.rows.offset)
      if ((tab === 'structure' || tab === 'indexes') && projection.structure.status === 'idle') loadStructure()
    },
    loadRows,
    refreshTables(): void { if (projection.status !== 'loading') loadTables(projection.database, projection.database === null) },
    refresh(): void {
      if (!target()) { if (projection.status !== 'loading') loadTables(projection.database, initialCatalog); return }
      if (projection.detailTab === 'data') loadRows(projection.rows.offset)
      else if (projection.detailTab === 'properties') { if (projection.status !== 'loading') loadTables(projection.database) }
      else loadStructure()
    },
  }
}
