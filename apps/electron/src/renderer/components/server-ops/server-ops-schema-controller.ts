import type {
  ServerOpsDataRowFilters,
  ServerOpsDataSchemaCell,
  ServerOpsDataSourceCellInput, ServerOpsDataSourceCellResult,
  ServerOpsDataSourceRowsInput, ServerOpsDataSourceRowsResult,
  ServerOpsDataSourceTableInput, ServerOpsDataSourceTableResult,
  ServerOpsDataSourceTablesInput, ServerOpsDataSourceTablesResult,
} from '@proma/shared'
import { parseServerOpsDataRowFilters } from '@proma/shared'
import { enqueueServerOpsDataRead } from './server-ops-data-request-queue'
import { getServerOpsDataErrorMessage } from './server-ops-data-display'

/** 表浏览独立 API；读取来源始终由主进程验证。 */
export interface ServerOpsSchemaBrowserApi {
  listServerOpsDataSchemaTables(input: ServerOpsDataSourceTablesInput): Promise<ServerOpsDataSourceTablesResult>
  describeServerOpsDataSchemaTable(input: ServerOpsDataSourceTableInput): Promise<ServerOpsDataSourceTableResult>
  readServerOpsDataSchemaRows(input: ServerOpsDataSourceRowsInput): Promise<ServerOpsDataSourceRowsResult>
  readServerOpsDataSchemaCell(input: ServerOpsDataSourceCellInput): Promise<ServerOpsDataSourceCellResult>
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
  engine: 'mysql' | 'postgresql' | 'sqlite' | 'redis'
  database?: string
  updatedAt?: number
  /** 完整有效连接配置，避免同 ID / 同时间戳的地址变更复用旧请求。 */
  readIdentity?: string
}

/** 当前打开的单元格详情；正文仅存在于 renderer 内存。 */
export interface ServerOpsSchemaCellDetail {
  status: 'loading' | 'ready' | 'error' | 'unavailable'
  error: string | null
  column: string
  absoluteOffset: number
  preview: ServerOpsDataSchemaCell
  value?: ServerOpsDataSourceCellResult['value']
}

/** 完整浏览投影只保留当前目录、当前表描述及当前页。 */
export interface ServerOpsSchemaBrowserProjection extends ServerOpsSchemaLoadState {
  /** 目录读取成功但本地默认库保存失败，不阻断当前浏览。 */
  defaultDatabaseError: string | null
  sourceId: string | null
  engine: 'mysql' | 'postgresql' | 'sqlite' | 'redis' | null
  databases: string[]
  database: string | null
  tables: ServerOpsDataSourceTablesResult['tables']
  databasesTruncated?: boolean
  tablesTruncated?: boolean
  selectedTable: string | null
  detailTab: ServerOpsSchemaDetailTab
  /** 仅当前表内存保留的已应用条件，不写入导航持久化。 */
  rowFilters: ServerOpsDataRowFilters | null
  structure: ServerOpsSchemaLoadState & ServerOpsDataSourceTableResult
  rows: ServerOpsSchemaLoadState & ServerOpsDataSourceRowsResult
  cellDetail: ServerOpsSchemaCellDetail | null
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
  /** 仅显式选库且目录成功后调用；有效性检查用于跳过过期的排队保存。 */
  onDatabaseSelected?: (database: string, isCurrent: () => boolean) => Promise<void>
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
  openCell(rowIndex: number, columnIndex: number): void
  closeCell(): void
  loadFilterFields(): void
  applyRowFilters(filters: ServerOpsDataRowFilters | null): void
  refresh(): void
  refreshTables(): void
}

/** 创建不含请求和结果的初始状态。 */
export function createServerOpsSchemaIdleProjection(): ServerOpsSchemaBrowserProjection {
  return {
    sourceId: null, engine: null, status: 'idle', error: null, defaultDatabaseError: null,
    databases: [], database: null, tables: [], selectedTable: null, detailTab: 'data', rowFilters: null,
    structure: { status: 'idle', error: null, columns: [], indexes: [] },
    rows: { status: 'idle', error: null, columns: [], rows: [], offset: 0, limit: 50, truncated: false },
    cellDetail: null,
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
  /** 单元格详情独立代次；关闭或任何行身份变化都会作废全文回执。 */
  let cellRevision = 0
  /** 当前配置身份与首读标志。 */
  let sourceKey: string | null = null
  let initialCatalog = true
  /** SSH 可达性独立于配置身份；断线时释放结果，重连重新验证导航。 */
  let readable = false
  /** 只在首次有效目录返回后恢复一次。 */
  let resume = options.initialNavigation
  /** 仅用户选库产生保存意图；初始化、恢复导航和常规刷新不会反向覆盖默认库。 */
  let databaseSelection: string | null = null

  /** 将不可变状态发布给仍有效的 owner。 */
  const patch = (update: Partial<ServerOpsSchemaBrowserProjection>): void => {
    projection = { ...projection, ...update }
    if (active) options.publish(projection)
  }
  /** 清空详情并作废在途全文读取。 */
  const invalidateCellDetail = (): void => {
    cellRevision += 1
    if (projection.cellDetail !== null) patch({ cellDetail: null })
  }
  /** 清空目标正文，绝不把前一个库/表的数据留在新标题下。 */
  const resetTable = (): void => {
    invalidateCellDetail()
    tableRevision += 1
    patch({ selectedTable: null, detailTab: 'data', rowFilters: null, structure: createServerOpsSchemaIdleProjection().structure,
      rows: { ...createServerOpsSchemaIdleProjection().rows, limit: pageSize } })
  }
  /** 单表描述和数据的共同身份；每次发起时固定，不读取后来的选择。 */
  const target = (): ServerOpsDataSourceTableInput | null => projection.sourceId && projection.database && projection.selectedTable
    ? { sourceId: projection.sourceId, database: projection.database, table: projection.selectedTable } : null

  /** 读取表描述；结构/索引共享一次结果。 */
  const loadStructure = (cacheMode: 'prefer-cache' | 'refresh' = 'prefer-cache'): void => {
    const selected = target()
    if (!selected || !active || !readable || projection.structure.status === 'loading') return
    const owner = ownerRevision
    const table = tableRevision
    const revision = ++structureRevision
    const valid = (): boolean => active && owner === ownerRevision && table === tableRevision && revision === structureRevision
    patch({ structure: { ...projection.structure, status: 'loading', error: null } })
    /** 只有结构读取携带缓存策略；数据行 target 保持原有实时合同。 */
    const input = { ...selected, cacheMode }
    void enqueueServerOpsDataRead(options.api, `${selected.sourceId}:schema-table`, JSON.stringify([sourceKey, input]),
      () => options.api.describeServerOpsDataSchemaTable(input), valid).then((result) => {
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
    invalidateCellDetail()
    const owner = ownerRevision
    const table = tableRevision
    const revision = ++rowsRevision
    const valid = (): boolean => active && owner === ownerRevision && table === tableRevision && revision === rowsRevision
    const input = { ...selected, offset, limit: pageSize,
      ...(projection.rowFilters === null ? {} : { filters: parseServerOpsDataRowFilters(projection.rowFilters) }) }
    patch({ rows: { ...(projection.rows.offset === offset ? projection.rows : createServerOpsSchemaIdleProjection().rows),
      status: 'loading', error: null, offset, limit: pageSize } })
    void enqueueServerOpsDataRead(options.api, `${selected.sourceId}:schema-rows`, JSON.stringify([sourceKey, input]),
      () => options.api.readServerOpsDataSchemaRows(input), valid).then((result) => {
      if (valid()) patch({ rows: { ...result, status: 'ready', error: null, collectedAt: Date.now() } })
    }, (error: unknown) => {
      if (valid()) patch({ rows: { ...projection.rows, status: 'error', error: getServerOpsDataErrorMessage(error, input.filters ? 'filtered-rows' : undefined) } })
    })
  }

  /** 打开当前页的一个单元格；只有带摘要的截断文本需要额外读取。 */
  const openCell = (rowIndex: number, columnIndex: number): void => {
    const selected = target()
    if (!selected || !active || !readable || !Number.isSafeInteger(rowIndex) || !Number.isSafeInteger(columnIndex)
      || projection.rows.status === 'loading' || rowIndex < 0 || columnIndex < 0
      || rowIndex >= projection.rows.rows.length || columnIndex >= projection.rows.columns.length) return
    /** 当前页内的单元格预览。 */
    const preview = projection.rows.rows[rowIndex]?.[columnIndex]
    /** 由当前列投影验证的列名。 */
    const column = projection.rows.columns[columnIndex]
    /** 后端合同使用整表绝对位置，不使用页内行号。 */
    const absoluteOffset = projection.rows.offset + rowIndex
    if (preview === undefined || column === undefined || absoluteOffset > 1_000_199) return
    const revision = ++cellRevision
    if (typeof preview !== 'object' || preview === null || preview.kind === 'binary') {
      patch({ cellDetail: { status: 'ready', error: null, column, absoluteOffset, preview, value: preview } })
      return
    }
    if (preview.sha256 === undefined) {
      patch({ cellDetail: { status: 'unavailable', error: '当前预览缺少校验摘要，无法读取完整内容；请刷新表后重试', column, absoluteOffset, preview } })
      return
    }
    /** 发起请求时冻结 owner、表、行页和筛选条件身份。 */
    const owner = ownerRevision
    /** 当前表代次。 */
    const table = tableRevision
    /** 当前行页代次。 */
    const rows = rowsRevision
    /** 当前已应用筛选条件的不可变副本。 */
    const filters = projection.rowFilters === null ? undefined : parseServerOpsDataRowFilters(projection.rowFilters)
    /** 单格全文请求。 */
    const input: ServerOpsDataSourceCellInput = { ...selected, offset: absoluteOffset, columnIndex, expectedColumn: column,
      sha256: preview.sha256, ...(filters === undefined ? {} : { filters }) }
    /** 检查全文回执仍属于当前打开的同一格。 */
    const valid = (): boolean => active && owner === ownerRevision && table === tableRevision && rows === rowsRevision && revision === cellRevision
    patch({ cellDetail: { status: 'loading', error: null, column, absoluteOffset, preview } })
    void enqueueServerOpsDataRead(options.api, `${selected.sourceId}:schema-cell`, JSON.stringify([sourceKey, input]),
      () => options.api.readServerOpsDataSchemaCell(input), valid).then((result) => {
      if (valid()) patch({ cellDetail: { status: 'ready', error: null, column, absoluteOffset, preview, value: result.value } })
    }, (error: unknown) => {
      if (valid()) patch({ cellDetail: { status: 'error', error: getServerOpsDataErrorMessage(error), column, absoluteOffset, preview } })
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
  const loadTables = (database: string | null, initial = false, cacheMode: 'prefer-cache' | 'refresh' = 'prefer-cache'): void => {
    const sourceId = projection.sourceId
    if (!sourceId || !active || !readable || projection.engine === 'redis') return
    const owner = ownerRevision
    const revision = ++catalogRevision
    const valid = (): boolean => active && owner === ownerRevision && revision === catalogRevision
    const input = database === null || initial ? { sourceId, cacheMode } : { sourceId, database, cacheMode }
    initialCatalog = initial
    patch({ status: 'loading', error: null })
    void enqueueServerOpsDataRead(options.api, `${sourceId}:schema-tables`, JSON.stringify([sourceKey, input]),
      () => options.api.listServerOpsDataSchemaTables(input), valid).then(async (result) => {
      if (!valid()) return
      /** 保存成功后再开放当前库，避免默认库更新取消紧接着发出的表读取。 */
      let defaultDatabaseError: string | null = null
      if (databaseSelection !== null && databaseSelection === result.database && options.onDatabaseSelected) {
        try {
          await options.onDatabaseSelected(databaseSelection, valid)
          if (valid()) databaseSelection = null
        } catch (error: unknown) {
          defaultDatabaseError = `已打开数据库，但未能记住默认库：${getServerOpsDataErrorMessage(error)}。刷新后重试。`
        }
        if (!valid()) return
      }
      initialCatalog = false
      patch({ status: 'ready', error: null, defaultDatabaseError, collectedAt: Date.now(), databases: result.databases, database: result.database ?? null,
        tables: result.tables, tablesTruncated: result.tablesTruncated, databasesTruncated: result.databasesTruncated })
      if (projection.selectedTable && !result.tables.some((entry) => entry.name === projection.selectedTable)) resetTable()
      /** 先完成目录失效，再刷新当前结构，避免并发失效把新字段缓存抹掉。 */
      if (cacheMode === 'refresh' && projection.selectedTable && (projection.detailTab === 'structure' || projection.detailTab === 'indexes')) {
        /** 刷新目录期间可能刚切入结构页，必须同时撤销那次旧缓存请求的发布权。 */
        structureRevision += 1
        patch({ structure: createServerOpsSchemaIdleProjection().structure })
        loadStructure('refresh')
      }
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
    dispose(): void { active = false; ownerRevision += 1; cellRevision += 1; projection = { ...projection, cellDetail: null } },
    setSource(source, nextReadable = true): void {
      /** 相同配置只改变可达性时保留轻导航；真实配置变更必须丢弃。 */
      const key = source ? source.readIdentity ?? JSON.stringify([source.id, source.engine, source.database, source.updatedAt]) : null
      const canRead = source !== null && source.engine !== 'redis' && nextReadable
      const configurationChanged = key !== sourceKey
      if (!configurationChanged && readable === canRead) return
      /** 初始化之外的配置变更不允许恢复旧配置的库表导航。 */
      if (configurationChanged && sourceKey !== null) { resume = undefined; databaseSelection = null }
      /** 多段目录恢复尚未结束时，完整 resume 优先于当前半成品投影。 */
      else if (!configurationChanged && readable && !canRead && projection.database && !resume) {
        resume = { database: projection.database, table: projection.selectedTable, detailTab: projection.detailTab,
          offset: projection.rowFilters === null ? projection.rows.offset : 0 }
      }
      sourceKey = key
      readable = canRead
      ownerRevision += 1
      catalogRevision += 1
      tableRevision += 1
      projection = {
        ...createServerOpsSchemaIdleProjection(),
        sourceId: source?.id ?? null,
        engine: source?.engine ?? null,
        database: source?.engine === 'sqlite' ? 'main' : null,
        databases: source?.engine === 'sqlite' ? ['main'] : [],
      }
      patch({})
      if (readable) loadTables(null, true)
    },
    selectDatabase(database): void {
      if (projection.engine === 'sqlite' && database !== 'main') return
      if (!database || database === projection.database) return
      resume = undefined
      databaseSelection = database
      resetTable()
      patch({ database, tables: [], collectedAt: undefined, defaultDatabaseError: null })
      loadTables(database)
    },
    openTable,
    backToList: resetTable,
    openCell,
    closeCell: invalidateCellDetail,
    setDetailTab(tab): void {
      patch({ detailTab: tab })
      if (tab === 'data' && projection.rows.status === 'idle') loadRows(projection.rows.offset)
      if ((tab === 'structure' || tab === 'indexes') && projection.structure.status === 'idle') loadStructure()
    },
    loadRows,
    loadFilterFields(): void {
      if (projection.status === 'loading' || (projection.structure.status !== 'idle' && projection.structure.status !== 'error')) return
      loadStructure(projection.structure.status === 'error' ? 'refresh' : 'prefer-cache')
    },
    applyRowFilters(filters): void {
      if (!target() || !active || !readable) return
      /** 复制条件快照，避免面板草稿变化污染已提交请求和分页身份。 */
      const rowFilters = filters === null ? null : parseServerOpsDataRowFilters(filters)
      if (JSON.stringify(rowFilters) === JSON.stringify(projection.rowFilters)) return
      rowsRevision += 1
      patch({ rowFilters, rows: { ...createServerOpsSchemaIdleProjection().rows, limit: pageSize } })
      loadRows(0)
    },
    refreshTables(): void {
      if (projection.status === 'loading') return
      invalidateCellDetail()
      /** 目录刷新会使后端字段失效，页面也同步清除已展示的旧描述。 */
      structureRevision += 1
      patch({ structure: createServerOpsSchemaIdleProjection().structure })
      loadTables(projection.database, projection.database === null, 'refresh')
    },
    refresh(): void {
      if (!target()) { if (projection.status !== 'loading') loadTables(projection.database, initialCatalog, 'refresh'); return }
      if (projection.detailTab === 'data') loadRows(projection.rows.offset)
      else if (projection.detailTab === 'properties') { if (projection.status !== 'loading') loadTables(projection.database, false, 'refresh') }
      else loadStructure('refresh')
    },
  }
}
