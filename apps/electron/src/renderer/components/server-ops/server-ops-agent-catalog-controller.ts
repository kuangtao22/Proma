import type { ServerOpsDataSourceTablesInput, ServerOpsDataSourceTablesResult } from '@proma/shared'
import { enqueueServerOpsDataRead } from './server-ops-data-request-queue'
import { getServerOpsDataErrorMessage } from './server-ops-data-display'

/** 授权界面只需要按目标库读取表目录，不接触连接凭据。 */
export interface ServerOpsAgentCatalogApi {
  listServerOpsDataSchemaTables(input: ServerOpsDataSourceTablesInput): Promise<ServerOpsDataSourceTablesResult>
}

/** 当前目标的有界目录状态；旧目标的表绝不混入新目标。 */
export interface ServerOpsAgentCatalogProjection {
  status: 'idle' | 'loading' | 'ready' | 'error'
  result: ServerOpsDataSourceTablesResult | null
  error: string | null
  tableSearch?: string
}

/** 授权弹窗目录操作；目标绑定与实际读取分离。 */
export interface ServerOpsAgentCatalogController {
  activate(): void
  dispose(): void
  select(sourceId: string, identity: string, database?: string): void
  load(refresh?: boolean, tableSearch?: string): Promise<void>
  snapshot(): ServerOpsAgentCatalogProjection
}

/** 创建只保留当前连接/库快照的目录控制器，StrictMode 重放可合并底层读取。 */
export function createServerOpsAgentCatalogController(options: {
  api: ServerOpsAgentCatalogApi
  publish: (projection: ServerOpsAgentCatalogProjection) => void
}): ServerOpsAgentCatalogController {
  /** 生存期与目标代次，用于阻止旧回执发布。 */
  let active = false
  let revision = 0
  let target: { sourceId: string; identity: string; database?: string } | null = null
  let projection: ServerOpsAgentCatalogProjection = { status: 'idle', result: null, error: null }
  let loading: Promise<void> | null = null
  let loadingRefresh = false
  let currentSearch: string | undefined

  /** 替换当前投影，仅向已挂载的订阅者推送。 */
  const update = (next: ServerOpsAgentCatalogProjection): void => {
    projection = next
    if (active) options.publish(projection)
  }

  /** 只有显式加载或卸载后的读取重放才进入连接的表目录队列。 */
  const read = async (refresh = false, tableSearch?: string): Promise<void> => {
    if (!active || !target?.sourceId) return
    const searchChanged = tableSearch !== currentSearch
    if (searchChanged) {
      revision += 1
      loading = null
      currentSearch = tableSearch
    }
    if (projection.status === 'loading' && loading) return loading
    if (projection.status === 'ready' && !refresh && !searchChanged) return

    /** 固定本次目标，等待队列时也不读取后来选择的新库。 */
    const selected = target
    const owner = revision
    const valid = (): boolean => active && revision === owner
    const input: ServerOpsDataSourceTablesInput = {
      sourceId: selected.sourceId,
      ...(selected.database === undefined ? {} : { database: selected.database }),
      ...(tableSearch === undefined ? { cacheMode: refresh ? 'refresh' as const : 'prefer-cache' as const } : { tableSearch }),
    }
    update({ status: 'loading', result: null, error: null, ...(tableSearch === undefined ? {} : { tableSearch }) })
    loadingRefresh = refresh
    const request = enqueueServerOpsDataRead(options.api, `${selected.sourceId}:schema-tables`,
      JSON.stringify([selected.identity, input]), () => options.api.listServerOpsDataSchemaTables(input), valid)
      .then((result) => {
        if (!valid()) return
        if (selected.database !== undefined && result.database !== selected.database) {
          update({ status: 'error', result: null, error: '目标数据库不可用，请刷新连接后重试' })
          return
        }
        update({ status: 'ready', result, error: null, ...(tableSearch === undefined ? {} : { tableSearch }) })
      }, (error: unknown) => {
        if (!valid()) return
        update({ status: 'error', result: null, error: getServerOpsDataErrorMessage(error), ...(tableSearch === undefined ? {} : { tableSearch }) })
      })
    loading = request
    await request
    if (loading === request) loading = null
  }

  return {
    activate(): void {
      if (active) return
      active = true
      revision += 1
      /** 上次卸载失去发布权，重挂后重新订阅队列中的同一请求。 */
      const replay = projection.status === 'loading'
      if (replay) {
        projection = { status: 'idle', result: null, error: null }
        loading = null
      }
      options.publish(projection)
      if (replay) void read(loadingRefresh, currentSearch)
    },
    dispose(): void {
      active = false
      revision += 1
    },
    select(sourceId, identity, database): void {
      if (target?.sourceId === sourceId && target.identity === identity && target.database === database) return
      target = { sourceId, identity, ...(database === undefined ? {} : { database }) }
      revision += 1
      loading = null
      currentSearch = undefined
      update({ status: 'idle', result: null, error: null })
    },
    load: read,
    snapshot: (): ServerOpsAgentCatalogProjection => projection,
  }
}
