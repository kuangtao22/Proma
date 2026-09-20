import type { ServerOpsDataDiagnoseInput, ServerOpsDataDiagnosticsResult } from '@proma/shared'
import type { ServerOpsSchemaLoadState } from './server-ops-schema-controller'
import { enqueueServerOpsDataRead } from './server-ops-data-request-queue'
import { getServerOpsDataErrorMessage } from './server-ops-data-display'

/** 实例诊断页面；日志没有来源，不会发起虚构请求。 */
export type ServerOpsDiagnosticPage = 'overview' | 'sessions' | 'statements' | 'logs' | 'parameters'
/** 已经读取的每页快照及其独立错误。 */
export interface ServerOpsDiagnosticState extends ServerOpsSchemaLoadState { result?: ServerOpsDataDiagnosticsResult }
/** 诊断内存缓存只跟随当前连接工作台存活。 */
export interface ServerOpsDiagnosticsProjection {
  page: ServerOpsDiagnosticPage | null
  /** 当前公共选库；null 表示未限定数据库。 */
  database: string | null
  pages: Partial<Record<ServerOpsDiagnosticPage, ServerOpsDiagnosticState>>
}
/** 按页请求需要的最小 bridge。 */
export interface ServerOpsDiagnosticsApi { diagnoseServerOpsDataSource(input: ServerOpsDataDiagnoseInput): Promise<ServerOpsDataDiagnosticsResult> }
/** 诊断控制器动作；绑定本身不读取，页面选择才触发查询。 */
export interface ServerOpsDiagnosticsController {
  getProjection(): ServerOpsDiagnosticsProjection
  activate(): void
  dispose(): void
  setSource(sourceId: string, identity: string, readable: boolean): void
  /** 切库只作废会话和慢语句，保留实例页缓存及在途读取。 */
  setDatabase(database: string | null): void
  selectPage(page: ServerOpsDiagnosticPage | null): void
  refresh(): void
}

/** 是否为能按数据库默认归属筛选的页面。 */
export function isServerOpsDatabaseScopedPage(page: ServerOpsDiagnosticPage | null): boolean {
  return page === 'sessions' || page === 'statements'
}

/** 创建按需诊断控制器；库级与实例级结果分别失效，布局不参与读取身份。 */
export function createServerOpsDiagnosticsController(options: { api: ServerOpsDiagnosticsApi; publish: (projection: ServerOpsDiagnosticsProjection) => void }): ServerOpsDiagnosticsController {
  /** 生命周期代次、连接身份与运行许可。 */
  let active = false
  let generation = 0
  let sourceId = ''
  let identity = ''
  let readable = false
  /** 独立库选择代次，避免切库使全局参数请求失去归属。 */
  let databaseGeneration = 0
  /** 只缓存当前连接已访问过的有界页面。 */
  let projection: ServerOpsDiagnosticsProjection = { page: null, database: null, pages: {} }
  /** 发布给当前 owner。 */
  const publish = (): void => { if (active) options.publish(projection) }
  /** 更新单页，保留其他页面的结果。 */
  const updatePage = (page: ServerOpsDiagnosticPage, state: ServerOpsDiagnosticState): void => {
    projection = { ...projection, pages: { ...projection.pages, [page]: state } }
    publish()
  }
  /** 当前页面才发查询；重放订阅复用协调器中的底层请求。 */
  const read = (): void => {
    const page = projection.page
    if (!active || !readable || !sourceId || page === null || page === 'logs') return
    const previous = projection.pages[page]
    if (previous?.status === 'loading') return
    const expected = generation
    const targetSource = sourceId
    /** 查询范围固定到发起时的选择，不读取异步回调时的新库名。 */
    const scoped = isServerOpsDatabaseScopedPage(page)
    const database = scoped ? projection.database : null
    const expectedDatabase = databaseGeneration
    /** 排队旧页面可跳过；已经发出的结果在同配置下仍可缓存。 */
    const valid = (): boolean => active && readable && generation === expected && (!scoped || databaseGeneration === expectedDatabase)
    updatePage(page, { ...previous, status: 'loading', error: null })
    void enqueueServerOpsDataRead(options.api, `${sourceId}:diagnostics`, JSON.stringify([identity, page, database]),
      () => options.api.diagnoseServerOpsDataSource({ sourceId: targetSource, section: page, ...(database === null ? {} : { database }) }),
      () => valid() && projection.page === page).then((result) => {
      if (!valid()) return
      if (result.capability !== 'available') {
        updatePage(page, { ...previous, status: 'error', error: result.warnings.join('；') || '当前账号无法读取此页面' })
        return
      }
      updatePage(page, { status: 'ready', error: null, result, collectedAt: result.collectedAt })
    }, (error: unknown) => {
      if (!valid()) return
      /** 失效排队项回到 idle，重新访问时可真正加载。 */
      updatePage(page, error instanceof Error && error.message === 'SERVER_OPS_DATA_READ_CANCELLED'
        ? { ...previous, status: previous?.result ? 'ready' : 'idle', error: null }
        : { ...previous, status: 'error', error: getServerOpsDataErrorMessage(error) })
    })
  }
  return {
    getProjection: () => projection,
    activate(): void {
      if (active) return
      active = true
      generation += 1
      /** 在旧 owner 结束后，所有 loading 状态须重新取得所有者。 */
      projection = { ...projection, pages: Object.fromEntries(Object.entries(projection.pages).map(([page, state]) => [page, state.status === 'loading' ? { ...state, status: 'idle' } : state])) }
      publish()
      if (projection.page && projection.pages[projection.page]?.status === 'idle') read()
    },
    dispose(): void { active = false; generation += 1 },
    setSource(nextSource, nextIdentity, nextReadable): void {
      const changed = sourceId !== nextSource || identity !== nextIdentity
      const becameReadable = !readable && nextReadable
      if (!changed && readable === nextReadable) return
      sourceId = nextSource
      identity = nextIdentity
      readable = nextReadable
      generation += 1
      /** 新配置不能继承旧页的读取意图，等待工作台重新验证库范围再激活。 */
      if (changed || !nextReadable) projection = { page: changed ? null : projection.page, database: changed ? null : projection.database, pages: {} }
      publish()
      if (!changed && becameReadable) read()
    },
    setDatabase(database): void {
      if (projection.database === database) return
      databaseGeneration += 1
      /** 只保留实例级快照；旧库正文不能挂在新库名下。 */
      const pages = { ...projection.pages }
      delete pages.sessions
      delete pages.statements
      projection = { ...projection, database, pages }
      publish()
      if (isServerOpsDatabaseScopedPage(projection.page)) read()
    },
    selectPage(page): void {
      projection = { ...projection, page }
      publish()
      if (page && (!projection.pages[page] || projection.pages[page]?.status === 'idle')) read()
    },
    refresh: read,
  }
}
