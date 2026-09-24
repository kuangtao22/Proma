import * as React from 'react'
import {
  Activity,
  Database,
  DatabaseZap,
  LoaderCircle,
  Pencil,
  PlugZap,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react'
import type {
  ServerOpsDataCapability,
  ServerOpsDataCredentialDiscoveryInput,
  ServerOpsDataCredentialDiscoveryResult,
  ServerOpsDataDiagnoseInput,
  ServerOpsDataDiagnosticsResult,
  ServerOpsDataProbeResult,
  ServerOpsDataSource,
  ServerOpsDataSourceDeleteInput,
  ServerOpsDataSourceListInput,
  ServerOpsDataSourceListResult,
  ServerOpsDataSourcePasswordInput,
  ServerOpsDataSourcePasswordResult,
  ServerOpsDiscoveredCredentialApplyInput,
  ServerOpsDiscoveredCredentialApplyResult,
  ServerOpsDataSourceCellInput,
  ServerOpsDataSourceCellResult,
  ServerOpsDataSourceProbeDraft,
  ServerOpsDataSourceProbeInput,
  ServerOpsDataSourceRowsInput,
  ServerOpsDataSourceRowsResult,
  ServerOpsDataSourceTableInput,
  ServerOpsDataSourceTableResult,
  ServerOpsDataSourceTablesInput,
  ServerOpsDataSourceTablesResult,
  ServerOpsDataSourceUpsertInput,
  ServerOpsDataSourceSetDefaultDatabaseInput,
  ServerOpsDataSourceUpsertResult,
  ServerOpsDataQueryCancelInput,
  ServerOpsDataQueryInput,
  ServerOpsDataQueryResult,
  ServerOpsDataQueryHistoryScope,
  ServerOpsDataQueryHistoryRecordInput,
  ServerOpsDataQueryHistoryResult,
} from '@proma/shared'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { SERVER_OPS_CARD_CLASS, SERVER_OPS_SEGMENTED_CLASS, SERVER_OPS_TAB_CLASS, SERVER_OPS_TABLE_CLASS, SERVER_OPS_TOOLBAR_CLASS } from './server-ops-ui'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { ServerOpsDataSourceDialog } from './ServerOpsDataSourceDialog'
import {
  SERVER_OPS_DATA_CAPABILITY_LABELS,
  formatServerOpsDataProbeSummary,
  formatServerOpsDataTlsPolicy,
  formatServerOpsDataTlsStatus,
  getServerOpsDataErrorMessage,
  isServerOpsDataSourceBusyError,
} from './server-ops-data-display'
import {
  createServerOpsSchemaBrowserController,
  createServerOpsSchemaIdleProjection,
  ServerOpsSchemaBrowserView,
} from './ServerOpsSchemaBrowser'
import type { ServerOpsSchemaBrowserProjection } from './ServerOpsSchemaBrowser'

/** 数据服务面板需要的 Renderer 侧 API；由工作区注入 preload bridge。 */
export interface ServerOpsDataPanelApi {
  listServerOpsDataSources(input: ServerOpsDataSourceListInput): Promise<ServerOpsDataSourceListResult>
  upsertServerOpsDataSource(input: ServerOpsDataSourceUpsertInput): Promise<ServerOpsDataSourceUpsertResult>
  /** 成功选库后只保存默认库；兼容尚未提供此能力的旧 bridge。 */
  setServerOpsDataSourceDefaultDatabase?: (input: ServerOpsDataSourceSetDefaultDatabaseInput) => Promise<ServerOpsDataSourceUpsertResult>
  deleteServerOpsDataSource(input: ServerOpsDataSourceDeleteInput): Promise<void>
  probeServerOpsDataSource(input: ServerOpsDataSourceProbeInput): Promise<ServerOpsDataProbeResult>
  diagnoseServerOpsDataSource(input: ServerOpsDataDiagnoseInput): Promise<ServerOpsDataDiagnosticsResult>
  /** 读取已保存密码明文；只在用户点"显示密码"时调用。 */
  revealServerOpsDataSourcePassword(input: ServerOpsDataSourcePasswordInput): Promise<ServerOpsDataSourcePasswordResult>
  /** 在本机发现可用的数据源凭据；只对回环地址开放，结果不含口令值。 */
  discoverServerOpsDataCredentials?(input: ServerOpsDataCredentialDiscoveryInput): Promise<ServerOpsDataCredentialDiscoveryResult>
  /** 取回用户点选的候选凭据；只填草稿，不落盘。 */
  applyServerOpsDiscoveredCredential?(input: ServerOpsDiscoveredCredentialApplyInput): Promise<ServerOpsDiscoveredCredentialApplyResult>
  /** 表浏览：库与表清单。 */
  listServerOpsDataSchemaTables(input: ServerOpsDataSourceTablesInput): Promise<ServerOpsDataSourceTablesResult>
  /** 表浏览：单表结构。 */
  describeServerOpsDataSchemaTable(input: ServerOpsDataSourceTableInput): Promise<ServerOpsDataSourceTableResult>
  /** 表浏览：分页行预览。 */
  readServerOpsDataSchemaRows(input: ServerOpsDataSourceRowsInput): Promise<ServerOpsDataSourceRowsResult>
  /** 表浏览：按需读取一格完整内容。 */
  readServerOpsDataSchemaCell(input: ServerOpsDataSourceCellInput): Promise<ServerOpsDataSourceCellResult>
  /** 当前数据库的显式只读 SQL 查询；旧 preload 下缺失并由 UI 禁用。 */
  queryServerOpsDatabase?: (input: ServerOpsDataQueryInput) => Promise<ServerOpsDataQueryResult>
  /** 取消当前窗口拥有的 SQL 查询，并等待底层释放完成。 */
  cancelServerOpsDatabaseQuery?: (input: ServerOpsDataQueryCancelInput) => Promise<void>
  /** 读取当前连接、当前数据库的本地 SQL 历史，不触发远程查询。 */
  listServerOpsDatabaseQueryHistory?: (input: ServerOpsDataQueryHistoryScope) => Promise<ServerOpsDataQueryHistoryResult>
  /** 保存实际执行语句；主进程去重并原子持久化，不保存结果数据。 */
  saveServerOpsDatabaseQueryHistory?: (input: ServerOpsDataQueryHistoryRecordInput) => Promise<ServerOpsDataQueryHistoryResult>
}

/** 数据源列表加载状态。 */
export type ServerOpsDataListStatus = 'idle' | 'loading' | 'ready' | 'error'

/** 单次连接测试的就地状态。 */
export interface ServerOpsDataProbeState {
  state: 'running' | 'done' | 'error'
  result?: ServerOpsDataProbeResult
  error?: string
}

/** 单次只读诊断状态；同一时刻只展示一个数据源的诊断结果。 */
export interface ServerOpsDataDiagnosticsState {
  sourceId: string
  state: 'running' | 'done' | 'error'
  result?: ServerOpsDataDiagnosticsResult
  error?: string
}

/** 面板当前绑定的主机与可见性上下文。 */
export interface ServerOpsDataServicesContext {
  hostId: string
  hostLabel: string
  hostDescription: string
  active: boolean
  connected: boolean
  /**
   * 单连接模式聚焦的数据源；`null` 表示"列出全部数据源"的列表模式。
   *
   * 项目制下数据库 / Redis 是独立连接，进入连接即进入只读诊断，
   * 因此聚焦模式不再读取全局列表，也不提供"新建数据源"。
   */
  focusSource?: ServerOpsDataSource | null
}

/** 数据服务面板公开投影，所有字段都可直接静态断言。 */
export interface ServerOpsDataServicesProjection {
  context: ServerOpsDataServicesContext | null
  status: ServerOpsDataListStatus
  error: string | null
  sources: ServerOpsDataSource[]
  probes: Readonly<Record<string, ServerOpsDataProbeState>>
  diagnostics: ServerOpsDataDiagnosticsState | null
  dialog: { mode: 'create' | 'edit'; source: ServerOpsDataSource | null } | null
  submitting: boolean
  dialogError: string | null
  deleteTarget: ServerOpsDataSource | null
}

/** 数据服务面板控制器依赖。 */
export interface ServerOpsDataServicesControllerOptions {
  api: ServerOpsDataPanelApi
  /** 工作台自行按页面读取时关闭旧版自动全量诊断，保留连接管理动作。 */
  automaticDiagnostics?: boolean
  /** 只向仍活跃的 React owner 发布不可变投影。 */
  publish: (projection: ServerOpsDataServicesProjection) => void
  /**
   * 单连接模式下数据源被编辑或删除后的通知。
   *
   * 聚焦模式不自己维护全局列表，数据源归属由调用方（工作区 atoms）持有，
   * 因此必须把"连接清单变了"这件事交回给所有者，否则连接会停留在旧身份上。
   */
  onSourceMutated?: (change: ServerOpsDataSourceMutation) => void
}

/**
 * 单连接模式下数据源的变更类别。
 *
 * 编辑只是身份变化，可以留在原连接上重读诊断；删除会让这条连接彻底消失，
 * 所有者必须据此把界面退回项目视图，而不是把用户甩到另一条连接上。
 */
export type ServerOpsDataSourceMutation = 'updated' | 'deleted'

/** 数据服务面板控制器：状态机与请求代次全部集中在这里。 */
export interface ServerOpsDataServicesController {
  getProjection(): ServerOpsDataServicesProjection
  /** 建立 owner 代次；StrictMode 重放与重新挂载都会调用。 */
  activate(): void
  setContext(context: ServerOpsDataServicesContext): void
  clearContext(): void
  refresh(): void
  probe(source: ServerOpsDataSource): void
  diagnose(source: ServerOpsDataSource): void
  openCreateDialog(): void
  openEditDialog(source: ServerOpsDataSource): void
  closeDialog(): void
  submitDialog(input: ServerOpsDataSourceUpsertInput): void
  requestDelete(source: ServerOpsDataSource): void
  cancelDelete(): void
  confirmDelete(): void
  dispose(): void
}

/** 创建初始投影。 */
export function createServerOpsDataIdleProjection(): ServerOpsDataServicesProjection {
  return {
    context: null,
    status: 'idle',
    error: null,
    sources: [],
    probes: {},
    diagnostics: null,
    dialog: null,
    submitting: false,
    dialogError: null,
    deleteTarget: null,
  }
}

/**
 * 创建数据服务面板控制器。
 *
 * @param options API 与投影发布边界
 * @returns 可独立测试的控制器
 */
export function createServerOpsDataServicesController(
  options: ServerOpsDataServicesControllerOptions,
): ServerOpsDataServicesController {
  /**
   * 当前 React owner 是否仍有效。
   *
   * 初始为 false：只有容器调用 `activate()` 之后才允许发布。
   * 这样 StrictMode 的"setup → cleanup → setup"不会把控制器永久留在失活状态。
   */
  let ownerActive = false
  /** 当前投影。 */
  let projection = createServerOpsDataIdleProjection()
  /** 主机、连接或可见性变化时推进的代次。 */
  let contextRevision = 0
  /**
   * 读取身份代次：只有"读的是谁"发生变化（聚焦连接、激活状态）时才推进。
   *
   * 展示字段（跳板连接状态、主机描述等）变化很频繁，若也作废在途读取，
   * 结果会被反复丢弃、界面永远停在"正在读取"。
   */
  let diagnosisRevision = 0
  /** 列表请求代次。 */
  let listRevision = 0

  /**
   * 聚焦数据源的稳定身份。
   *
   * 只比 `id` 不够：同一连接的名称、地址或密码状态变化后必须重建上下文，
   * 否则详情页会一直展示连接被编辑之前的身份。
   *
   * @param focus 聚焦的数据源
   * @returns 可供比较的身份字符串；没有聚焦项时为 null
   */
  const getFocusKey = (focus: ServerOpsDataSource | null | undefined): string | null => (
    focus ? `${focus.id}:${focus.updatedAt}` : null
  )

  /** 仅向仍活跃的 owner 发布不可变投影。 */
  const publish = (next: ServerOpsDataServicesProjection): void => {
    projection = next
    if (ownerActive) options.publish(next)
  }

  /** 合并投影字段并发布。 */
  const patch = (next: Partial<ServerOpsDataServicesProjection>): void => {
    publish({ ...projection, ...next })
  }

  /**
   * 判断异步读取结果是否仍应写回投影。
   *
   * 直连条目不绑定主机，切主机不该丢弃它的结果（否则界面会永远停在"进行中"）；
   * 经由跳板的条目仍要求当前上下文与目标主机一致，避免结果串到别的主机上。
   *
   * @param source 发起读取的数据源
   * @param revision 发起读取时的上下文代次
   * @returns 结果是否仍然有效
   */
  const isStillCurrent = (source: ServerOpsDataSource, revision: number): boolean => (
    ownerActive && diagnosisRevision === revision && projection.context?.active === true
    && (source.transport === 'direct' || projection.context.hostId === source.hostId)
  )

  /**
   * 读取单个数据源的只读诊断，并把结果写回当前投影。
   *
   * @param source 目标数据源
   */
  const diagnoseSource = (source: ServerOpsDataSource): void => {
    /** 本次诊断固定的上下文快照。 */
    const context = projection.context
    if (context === null || !context.active || (source.transport === 'ssh' && (!context.connected || context.hostId !== source.hostId))) return
    /** 本次诊断绑定的读取身份代次。 */
    const operationContextRevision = diagnosisRevision
    /** 发起前的诊断状态；单飞冲突时要恢复它，避免界面卡在"进行中"。 */
    const previousDiagnostics = projection.diagnostics
    patch({ diagnostics: { sourceId: source.id, state: 'running' } })
    void options.api.diagnoseServerOpsDataSource({ sourceId: source.id }).then((result) => {
      if (!isStillCurrent(source, operationContextRevision)) return
      patch({ diagnostics: { sourceId: source.id, state: 'done', result } })
    }).catch((error: unknown) => {
      if (!isStillCurrent(source, operationContextRevision)) return
      /**
       * 单飞冲突说明本次请求根本没开始：恢复到发起前的状态。
       * 若确实有上一次读取在跑，那它随后会写回结果；否则界面停在旧结果上仍可重试，
       * 不会因为把状态留在"进行中"而永久转圈（那时刷新按钮还是禁用的）。
       */
      if (isServerOpsDataSourceBusyError(error)) {
        patch({ diagnostics: previousDiagnostics })
        return
      }
      patch({
        diagnostics: {
          sourceId: source.id,
          state: 'error',
          error: getServerOpsDataErrorMessage(error),
          /** 错误时保留上一次成功的结果，页签与内容不会整体消失。 */
          ...(projection.diagnostics?.result === undefined ? {} : { result: projection.diagnostics.result }),
        },
      })
    })
  }

  /** 读取当前主机的数据源列表，并丢弃迟到结果。 */
  const loadSources = async (): Promise<void> => {
    /** 本次读取固定的上下文快照。 */
    const context = projection.context
    // 列表读取只要求页签可见：未连接 SSH 时同样要能列出与新建数据源。
    if (context?.active !== true) return
    // 单连接模式只渲染聚焦的数据源本身，不需要也不应该拉全局列表。
    if (context.focusSource) return
    /** 本次读取独占的代次；数据源列表是全局的，只按代次与可见性判定是否回写。 */
    const operationRevision = ++listRevision
    patch({ status: 'loading', error: null })
    try {
      const result = await options.api.listServerOpsDataSources({})
      // 只要求 owner 仍有效、本次仍是最新请求、页签仍可见。旧实现还要求"当前主机等于发起时的主机"，
      // 那是按主机过滤时代的残留：列表已经全局化，切主机时结果会被丢掉且不会重新加载，界面就永远停在 loading。
      if (!ownerActive || operationRevision !== listRevision || projection.context?.active !== true) return
      publish({ ...projection, status: 'ready', error: null, sources: [...result.sources] })
    } catch (error) {
      if (!ownerActive || operationRevision !== listRevision || projection.context?.active !== true) return
      patch({ status: 'error', error: getServerOpsDataErrorMessage(error) })
    }
  }

  return {
    getProjection: () => projection,

    /**
     * 重新取得 owner 代次。
     *
     * StrictMode 会执行"setup → cleanup → setup"，cleanup 里的 dispose 会把 owner 判为失活；
     * 若这里不重新激活并把当前投影重新交给 React，面板会永远停在失活那一刻的画面
     * （表现为：只读诊断一直转圈、编辑/删除/测试按钮点了没反应）。
     */
    activate(): void {
      if (ownerActive) return
      ownerActive = true
      /** 推进代次：上一个 owner 期间的在途读取不得再写回。 */
      contextRevision += 1
      listRevision += 1
      /** 把控制器内的当前投影重新同步给 React。 */
      publish(projection)
      /** 上一次 setup 期间发起的读取结果已被丢弃，这里补做一次，避免界面卡在"进行中"。 */
      const context = projection.context
      if (context?.active !== true) return
      if (context.focusSource) {
        if (options.automaticDiagnostics !== false) diagnoseSource(context.focusSource)
        return
      }
      void loadSources()
    },

    setContext(context: ServerOpsDataServicesContext): void {
      /** 上下文是否发生了需要作废在途请求的变化。 */
      const changed = projection.context?.hostId !== context.hostId
        || projection.context?.active !== context.active
        || projection.context?.connected !== context.connected
        || getFocusKey(projection.context?.focusSource) !== getFocusKey(context.focusSource)
      if (!changed) return
      /**
       * 读取身份是否变化：只有它变化才作废在途读取并重新发起。
       *
       * 聚焦模式下身份就是那条连接（`focusKey`）；列表模式下身份是当前主机，
       * 因为列表项的操作（测试/诊断）都按主机判定归属。
       */
      const previousIdentity = projection.context?.active === true
        ? (getFocusKey(projection.context.focusSource) ?? `host:${projection.context.hostId}`)
        : 'inactive'
      const nextIdentity = context.active ? (getFocusKey(context.focusSource) ?? `host:${context.hostId}`) : 'inactive'
      const identityChanged = previousIdentity !== nextIdentity
      contextRevision += 1
      listRevision += 1
      if (!identityChanged) {
        /**
         * 只有展示字段变化（跳板连接状态、主机描述等）：更新上下文但**保留在途读取**。
         * 否则同一份诊断会被反复丢弃重启，界面永远停在"正在读取只读诊断…"。
         */
        patch({ context })
        return
      }
      /** 读取身份变化：推进读取代次，丢弃旧连接的在途结果。 */
      diagnosisRevision += 1
      /** 聚焦模式下连接清单只有这一条，直接由上下文本身提供。 */
      const focusSources = context.active && context.focusSource ? [context.focusSource] : []
      publish({
        ...createServerOpsDataIdleProjection(),
        context,
        status: context.active ? (context.focusSource ? 'ready' : 'loading') : 'idle',
        sources: focusSources,
      })
      if (!context.active) return
      // 进入数据连接即进入只读诊断，用户不必再点一次按钮。
      if (context.focusSource) {
        if (options.automaticDiagnostics !== false) diagnoseSource(context.focusSource)
        return
      }
      /** 列表与新建不依赖 SSH 连接：直连数据源没有主机，配置阶段也不需要探测。 */
      void loadSources()
    },

    clearContext(): void {
      contextRevision += 1
      listRevision += 1
      publish(createServerOpsDataIdleProjection())
    },

    refresh(): void {
      const context = projection.context
      if (!context?.active) return
      /** 聚焦模式刷新的是该连接的诊断，而不是不会显示的全局列表。 */
      if (context.focusSource) {
        diagnoseSource(context.focusSource)
        return
      }
      void loadSources()
    },

    probe(source: ServerOpsDataSource): void {
      /** 本次测试固定的上下文快照。 */
      const context = projection.context
      /** 直连不依赖主机连接；经由跳板时必须处于可读上下文。 */
      if (context === null || !context.active || (source.transport === 'ssh' && (!context.connected || context.hostId !== source.hostId))) return
      /** 本次测试绑定的代次。 */
      const operationContextRevision = diagnosisRevision
      patch({ probes: { ...projection.probes, [source.id]: { state: 'running' } } })
      void options.api.probeServerOpsDataSource({ sourceId: source.id }).then((result) => {
        if (!isStillCurrent(source, operationContextRevision)) return
        patch({ probes: { ...projection.probes, [source.id]: { state: 'done', result } } })
      }).catch((error: unknown) => {
        if (!isStillCurrent(source, operationContextRevision)) return
        patch({ probes: { ...projection.probes, [source.id]: { state: 'error', error: getServerOpsDataErrorMessage(error) } } })
      })
    },

    diagnose: diagnoseSource,

    openCreateDialog(): void {
      // 配置数据源不需要 SSH 连接：直连条目压根没有主机，借跳板的也只需在读取时连接。
      if (!projection.context?.active) return
      patch({ dialog: { mode: 'create', source: null }, dialogError: null })
    },

    openEditDialog(source: ServerOpsDataSource): void {
      // 直连数据源不绑定主机，只有经由跳板时才要求当前上下文与目标主机一致。
      if (!projection.context?.active || (source.transport === 'ssh' && projection.context.hostId !== source.hostId)) return
      patch({ dialog: { mode: 'edit', source }, dialogError: null })
    },

    closeDialog(): void {
      patch({ dialog: null, dialogError: null, submitting: false })
    },

    submitDialog(input: ServerOpsDataSourceUpsertInput): void {
      /** 提交目标必须仍是当前主机。 */
      const context = projection.context
      if (context === null || !context.active || (input.transport === 'ssh' && (!context.connected || context.hostId !== input.hostId))) return
      patch({ submitting: true, dialogError: null })
      void options.api.upsertServerOpsDataSource(input).then(() => {
        if (!ownerActive) return
        patch({ submitting: false, dialog: null, dialogError: null })
        /** 聚焦模式没有本地列表可更新，交给所有者重新读取连接清单。 */
        if (projection.context?.focusSource) {
          options.onSourceMutated?.('updated')
          return
        }
        void loadSources()
      }).catch((error: unknown) => {
        if (!ownerActive) return
        patch({ submitting: false, dialogError: getServerOpsDataErrorMessage(error) })
      })
    },

    requestDelete(source: ServerOpsDataSource): void {
      if (!projection.context?.active || (source.transport === 'ssh' && projection.context.hostId !== source.hostId)) return
      patch({ deleteTarget: source })
    },

    cancelDelete(): void {
      patch({ deleteTarget: null })
    },

    confirmDelete(): void {
      /** 待删除数据源。 */
      const target = projection.deleteTarget
      /** 当前上下文。 */
      const context = projection.context
      if (!target || context === null || !context.active || (target.transport === 'ssh' && context.hostId !== target.hostId)) return
      patch({ deleteTarget: null })
      void options.api.deleteServerOpsDataSource({ sourceId: target.id }).then(() => {
        if (!ownerActive) return
        if (projection.diagnostics?.sourceId === target.id) patch({ diagnostics: null })
        /** 聚焦模式删除后，连接本身已经不存在，必须由所有者重建连接清单。 */
        if (projection.context?.focusSource) {
          options.onSourceMutated?.('deleted')
          return
        }
        void loadSources()
      }).catch((error: unknown) => {
        if (!ownerActive) return
        patch({ status: 'error', error: getServerOpsDataErrorMessage(error) })
      })
    },

    dispose(): void {
      ownerActive = false
      contextRevision += 1
      listRevision += 1
    },
  }
}

/** 按引擎返回列表图标。 */
function ServerOpsDataEngineIcon({ engine }: { engine: ServerOpsDataSource['engine'] }): React.ReactElement {
  const Icon = engine === 'redis' ? DatabaseZap : Database
  return <Icon className="size-4" aria-hidden="true" />
}

/** 引擎展示名。 */
function getEngineLabel(engine: ServerOpsDataSource['engine']): string {
  return engine === 'postgresql' ? 'PostgreSQL' : engine === 'mysql' ? 'MySQL' : engine === 'sqlite' ? 'SQLite' : 'Redis'
}

/** 指标卡网格。 */
export function ServerOpsDataMetricGrid({ metrics }: { metrics: ServerOpsDataDiagnosticsResult['metrics'] }): React.ReactElement {
  return (
    <div className="grid grid-cols-1 gap-3 p-4" data-server-ops-data-metric-grid="true">
      {metrics.map((metric) => (
        <div key={metric.id} className={cn(SERVER_OPS_CARD_CLASS, 'p-3')} data-server-ops-data-metric={metric.id}>
          <div className="truncate text-xs text-muted-foreground" title={metric.label}>{metric.label}</div>
          <div className="mt-1 truncate text-lg font-medium tracking-tight tabular-nums" title={metric.value}>{metric.value}</div>
          {metric.hint ? <div className="mt-0.5 truncate text-[11px] text-muted-foreground" title={metric.hint}>{metric.hint}</div> : null}
          {metric.ratio === undefined ? null : (
            <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-muted" role="presentation">
              <div className="h-full rounded-full bg-primary" style={{ width: `${Math.round(metric.ratio * 100)}%` }} />
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

/** 结果表格；调用方可按稳定列 ID 定制单元格，未提供时保持原始文本输出。 */
export function ServerOpsDataTable({ table, renderCell }: {
  table: ServerOpsDataDiagnosticsResult['tables'][number]
  renderCell?: (cell: string, columnId: string) => React.ReactNode
}): React.ReactElement {
  return (
    <div className={cn(SERVER_OPS_CARD_CLASS, 'mx-4 mb-4')} data-server-ops-data-table={table.id}>
      <div className="flex items-center justify-between gap-2 px-3 py-3">
        <div className="truncate text-xs font-medium">{table.title}</div>
        {table.truncated ? <span className="shrink-0 text-[11px] text-muted-foreground">已截断</span> : null}
      </div>
      {table.rows.length === 0 ? (
        <div className="px-3 pb-3 text-xs text-muted-foreground">{table.emptyText ?? '没有数据'}</div>
      ) : (
        <div className="overflow-x-auto">
          <table className={cn(SERVER_OPS_TABLE_CLASS, '[&_th.text-right]:text-right')}>
            <thead>
              <tr className="border-y border-border/30 text-muted-foreground">
                {table.columns.map((column) => (
                  <th
                    key={column.id}
                    scope="col"
                    className={cn('whitespace-nowrap px-3 py-1.5 font-normal', column.align === 'right' ? 'text-right' : 'text-left')}
                  >
                    {column.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row, rowIndex) => (
                <tr key={`${table.id}-${rowIndex}`}>
                  {row.map((cell, cellIndex) => (
                    <td
                      key={`${table.id}-${rowIndex}-${cellIndex}`}
                      className={cn(
                        'max-w-[22rem] truncate px-3 py-1.5 align-top',
                        table.columns[cellIndex]?.align === 'right' ? 'text-right tabular-nums' : 'text-left',
                      )}
                      title={cell}
                    >
                      {renderCell && table.columns[cellIndex] ? renderCell(cell, table.columns[cellIndex].id) : cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

/** 数据连接详情内部的分区页签。 */
export type ServerOpsDataDiagnosticsTab = 'metrics' | 'schema' | 'tables'

/** 页签元数据；顺序即界面顺序：先看健康度，再看库里有什么，最后是排障明细。 */
const SERVER_OPS_DATA_DIAGNOSTICS_TABS: readonly { id: ServerOpsDataDiagnosticsTab; label: string }[] = [
  { id: 'metrics', label: '统计' },
  { id: 'schema', label: '表' },
  { id: 'tables', label: '诊断表' },
]

/**
 * 只读诊断结果视图。
 *
 * 指标卡与数据表是两类不同用途的信息（"现在健康吗" vs "库里有什么"），
 * 堆在同一屏里会互相淹没，因此拆成两个页签；页签状态由外层持有，
 * 这样本组件保持纯函数、可以直接被静态断言。
 *
 * @param props 诊断状态、当前页签与重试回调
 * @returns 只读诊断区块
 */
export function ServerOpsDataDiagnostics({
  diagnostics,
  source,
  tab,
  onTabChange,
  onDiagnose,
  sourceActions,
  schemaContent,
}: {
  /** 诊断状态；null 表示还没读过（仍要渲染控制行，否则用户连刷新都点不到）。 */
  diagnostics: ServerOpsDataDiagnosticsState | null
  /** 重试诊断时复用的数据源；为空表示这条连接已不在当前列表里。 */
  source: ServerOpsDataSource | undefined
  tab: ServerOpsDataDiagnosticsTab
  onTabChange: (tab: ServerOpsDataDiagnosticsTab) => void
  onDiagnose: (source: ServerOpsDataSource) => void
  /**
   * 连接级动作（测试 / 编辑 / 删除）。
   *
   * 单连接模式下与诊断状态同一行渲染：面板不再单独占一行写身份，
   * 整页因此只剩"工具栏身份 + 这一行控制"两行。
   */
  sourceActions?: {
    probing: boolean
    onProbe: (source: ServerOpsDataSource) => void
    onEdit: (source: ServerOpsDataSource) => void
    onDelete: (source: ServerOpsDataSource) => void
  }
  /** 「表」页签的内容；由容器注入表浏览视图，视图本身保持纯函数。 */
  schemaContent?: React.ReactNode
}): React.ReactElement {
  /** 当前结果；读取中或失败时为空。 */
  const result = diagnostics?.result
  /** 连接级动作按钮组；只有单连接模式提供。 */
  const sourceActionButtons = sourceActions === undefined || source === undefined ? null : (
    <TooltipProvider delayDuration={200}>
      <div className="flex shrink-0 items-center gap-0.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button type="button" variant="ghost" size="icon-sm" aria-label={`测试 ${source.label} 的连接`} disabled={sourceActions.probing} onClick={() => sourceActions.onProbe(source)}>
              {sourceActions.probing ? <LoaderCircle className="size-3.5 animate-spin" /> : <PlugZap className="size-3.5" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>连接测试</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button type="button" variant="ghost" size="icon-sm" aria-label={`编辑 ${source.label}`} onClick={() => sourceActions.onEdit(source)}>
              <Pencil className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>编辑</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button type="button" variant="ghost" size="icon-sm" aria-label={`删除 ${source.label}`} onClick={() => sourceActions.onDelete(source)}>
              <Trash2 className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>删除</TooltipContent>
        </Tooltip>
      </div>
    </TooltipProvider>
  )
  /** 连接级动作与刷新按钮在任何状态下都必须可用，否则读取中的 15 秒里连编辑都点不到。 */
  const headerActions = (
    <div className="ml-auto flex shrink-0 items-center gap-2 text-[11px] text-muted-foreground">
      {result === undefined ? null : (
        <>
          <Badge variant="outline" className="font-normal">{SERVER_OPS_DATA_CAPABILITY_LABELS[result.capability]}</Badge>
          {formatServerOpsDataTlsStatus(result.tlsStatus) ? <span>{formatServerOpsDataTlsStatus(result.tlsStatus)}</span> : null}
          <span>{new Date(result.collectedAt).toLocaleTimeString('zh-CN')}</span>
        </>
      )}
      {sourceActionButtons}
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        aria-label={diagnostics?.state === 'error' ? '重试只读诊断' : '刷新只读诊断'}
        /*
         * 读取进行中也保持可点：万一某次结果丢失，用户必须还能手动重试；
         * 重复点击只会遇到单飞冲突，而单飞冲突现在会恢复原状、不会卡住界面。
         */
        disabled={!source}
        onClick={() => { if (source) onDiagnose(source) }}
      >
        <RefreshCw className={cn('size-3.5', diagnostics?.state === 'running' && 'animate-spin')} />
      </Button>
    </div>
  )
  return (
    <>
      <div className={SERVER_OPS_TOOLBAR_CLASS}>
        <span className="text-xs text-muted-foreground">只读诊断</span>
        {/*
          页签是这一页的导航，必须始终存在：诊断失败或还没读完时也要能切到「表」，
          否则一次读取冲突就会把整页内容锁死在错误提示上。
        */}
        <div className={SERVER_OPS_SEGMENTED_CLASS} role="tablist" aria-label="数据连接分区">
          {SERVER_OPS_DATA_DIAGNOSTICS_TABS.filter((entry) => source?.engine !== 'redis' || entry.id !== 'schema').map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              className={cn(SERVER_OPS_TAB_CLASS, 'aria-selected:bg-background aria-selected:shadow-sm')}
              aria-selected={tab === entry.id}
              data-server-ops-data-diagnostics-tab={entry.id}
              onClick={() => onTabChange(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </div>
        {headerActions}
      </div>
      {/* 诊断状态行只属于「统计」与「诊断表」两个页签；「表」是独立只读路径，不受诊断状态影响。 */}
      {tab !== 'schema' && diagnostics?.state === 'running' ? (
        <div className="flex items-center gap-2 px-3 py-3 text-xs text-muted-foreground" role="status">
          <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />正在读取只读诊断...
        </div>
      ) : null}
      {tab !== 'schema' && result === undefined && diagnostics?.state !== 'running' ? (
        <div className="px-3 py-3 text-xs text-muted-foreground">{diagnostics?.error ?? '尚未读取诊断数据，可点击刷新重试'}</div>
      ) : null}
      {tab === 'schema' || result === undefined || result.capability === 'available' ? null : (
        <div className="px-3 pb-2 text-xs text-muted-foreground">{result.warnings[0] ?? '当前无法读取诊断数据'}</div>
      )}
      {tab === 'schema' ? (schemaContent ?? null) : result === undefined ? null : tab === 'metrics' ? (
        result.metrics.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">本次诊断没有可展示的统计指标</div>
        ) : <ServerOpsDataMetricGrid metrics={result.metrics} />
      ) : result.tables.length === 0 ? (
        <div className="px-3 py-6 text-center text-xs text-muted-foreground">本次诊断没有可展示的数据表</div>
      ) : (
        result.tables.map((table) => <ServerOpsDataTable key={table.id} table={table} />)
      )}
    </>
  )
}

/** 数据服务面板纯视图属性。 */
export interface ServerOpsDataServicesPanelViewProps {
  projection: ServerOpsDataServicesProjection
  onRefresh: () => void
  onCreate: () => void
  onEdit: (source: ServerOpsDataSource) => void
  onProbe: (source: ServerOpsDataSource) => void
  /** 用弹窗里未保存的草稿测试连接；不落盘任何字段与密码。 */
  onTestDraft: (draft: ServerOpsDataSourceProbeDraft) => Promise<ServerOpsDataProbeResult>
  /** 读取已保存的密码明文；只在用户点"显示密码"时调用。 */
  onRevealSourcePassword: (sourceId: string) => Promise<string | null>
  /** 在本机发现凭据；旧客户端缺少对应方法时不渲染入口。 */
  onDiscoverCredentials?: (input: ServerOpsDataCredentialDiscoveryInput) => Promise<ServerOpsDataCredentialDiscoveryResult>
  /** 取回并填入点选的候选凭据。 */
  onApplyDiscoveredCredential?: (input: ServerOpsDiscoveredCredentialApplyInput) => Promise<ServerOpsDiscoveredCredentialApplyResult>
  /** 只读诊断当前分区（统计 / 数据表）。 */
  diagnosticsTab: ServerOpsDataDiagnosticsTab
  onDiagnosticsTabChange: (tab: ServerOpsDataDiagnosticsTab) => void
  /** 单连接模式下与诊断状态同排的连接级动作；为空表示不渲染。 */
  focusSourceActions?: {
    probing: boolean
    onProbe: (source: ServerOpsDataSource) => void
    onEdit: (source: ServerOpsDataSource) => void
    onDelete: (source: ServerOpsDataSource) => void
  }
  /** 「表」页签内容（表浏览）；由容器注入。 */
  schemaContent?: React.ReactNode
  onDiagnose: (source: ServerOpsDataSource) => void
  onDelete: (source: ServerOpsDataSource) => void
  onSubmit: (input: ServerOpsDataSourceUpsertInput) => void
  onCloseDialog: () => void
  onCancelDelete: () => void
  onConfirmDelete: () => void
}

/** 数据服务面板纯视图。 */
export function ServerOpsDataServicesPanelView({
  projection,
  onRefresh,
  onCreate,
  onEdit,
  onProbe,
  onTestDraft,
  onRevealSourcePassword,
  onDiscoverCredentials,
  onApplyDiscoveredCredential,
  diagnosticsTab,
  onDiagnosticsTabChange,
  focusSourceActions,
  schemaContent,
  onDiagnose,
  onDelete,
  onSubmit,
  onCloseDialog,
  onCancelDelete,
  onConfirmDelete,
}: ServerOpsDataServicesPanelViewProps): React.ReactElement {
  /** 当前上下文；未绑定时按未连接处理。 */
  const context = projection.context
  /** 诊断详情。 */
  const diagnostics = projection.diagnostics
  /** 已完成诊断对应的数据源，用于刷新时复用同一个目标。 */
  const diagnosticsSource = diagnostics ? projection.sources.find((source) => source.id === diagnostics.sourceId) : undefined
  /** 单连接模式聚焦的数据源；列表模式为 null。 */
  const focusSource = context?.focusSource ?? null
  /**
   * 未连接提示只对"经由跳板"的连接有意义。
   *
   * 直连数据源与 SSH 连接无关，对它们显示"当前未建立 SSH 连接"会让用户以为连不上；
   * 列表模式保持原行为（列表里可能同时存在两种连接方式）。
   */
  const showOfflineHint = context?.connected === false && (focusSource === null || focusSource.transport === 'ssh')
  /**
   * 只读诊断区块；列表模式与单连接模式共用同一份渲染，避免两套 UI 漂移。
   *
   * 统计与数据表由内部页签分开，页签状态由外层持有以保持本视图为纯函数。
   */
  const diagnosticsSection = diagnostics === null ? null : (
    <div data-server-ops-data-diagnostics="true">
      <ServerOpsDataDiagnostics
        diagnostics={diagnostics}
        source={diagnosticsSource}
        tab={diagnosticsTab}
        onTabChange={onDiagnosticsTabChange}
        onDiagnose={onDiagnose}
        sourceActions={focusSourceActions}
        schemaContent={schemaContent}
      />
    </div>
  )
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" style={{ containerType: 'inline-size' }} data-server-ops-data-panel="true">
      <style>{'@container (min-width: 700px) { [data-server-ops-data-metric-grid="true"] { grid-template-columns: repeat(2, minmax(0, 1fr)); } }'}</style>
      {/*
        单连接模式不再单独占一行写身份：项目名 › 连接名与完整身份都在外层工具栏（数据连接视图）里，
        这里只保留"动作"这一行，和诊断页签并列，避免同一条连接被写两遍、刷新出现两个。
      */}
      {focusSource ? null : (
      <div className={SERVER_OPS_TOOLBAR_CLASS}>
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium">数据服务</div>
          <div className="truncate text-[11px] text-muted-foreground">{context?.hostDescription ?? ''}</div>
        </div>
        {/* 新建数据源不依赖 SSH 连接：直连条目没有主机，借跳板的也只需在读取时连接。 */}
        <Button type="button" size="sm" variant="outline" disabled={context?.active !== true} onClick={onCreate}>
          <Plus className="size-3.5" />新建数据源
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="刷新数据源"
          disabled={context?.active !== true || projection.status === 'loading'}
          onClick={onRefresh}
        >
          <RefreshCw className={cn('size-3.5', projection.status === 'loading' && 'animate-spin')} aria-hidden="true" />
        </Button>
      </div>
      )}
      {/*
        SSH 未连接不再挡住整个页面：新建、编辑、删除数据源都不需要连接，
        只有经由跳板的连接测试与只读诊断需要；直连条目的可用性与 SSH 完全无关。
      */}
      {showOfflineHint ? (
        <div className="shrink-0 border-b border-border bg-muted/40 px-3 py-2 text-[11px] text-muted-foreground" data-server-ops-data-offline-hint>
          当前未建立 SSH 连接：可以配置数据源；经由跳板的连接测试与只读诊断需要先连接。
        </div>
      ) : null}
      {focusSource ? (
        /* 单连接模式：直接展示该连接的只读诊断，不渲染全局列表与空态。 */
        <div className="min-h-0 flex-1 overflow-y-auto">
          {/* 编辑或删除失败时列表模式的整页错误态不会出现，这里必须就地给出原因与重试。 */}
          {projection.status === 'error' ? (
            <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-3 text-xs" data-server-ops-data-focus-error>
              <span className="text-muted-foreground">{projection.error ?? '操作失败，请稍后重试'}</span>
              <Button type="button" size="sm" variant="outline" onClick={onRefresh}>
                <RefreshCw className="size-3.5" />重试
              </Button>
            </div>
          ) : null}
          {/*
            单连接模式下始终渲染控制行（页签 + 状态 + 连接动作 + 刷新），
            即使还没读过诊断也要能点刷新/编辑，不能只剩一句提示。
          */}
          <div data-server-ops-data-diagnostics="true">
            <ServerOpsDataDiagnostics
              diagnostics={diagnostics}
              source={diagnosticsSource}
              tab={diagnosticsTab}
              onTabChange={onDiagnosticsTabChange}
              onDiagnose={onDiagnose}
              sourceActions={focusSourceActions}
            />
          </div>
        </div>
      ) : projection.status === 'idle' || projection.status === 'loading' ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-xs text-muted-foreground" role="status">
          <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />正在读取数据源...
        </div>
      ) : projection.status === 'error' ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
          <p className="text-sm">数据源读取失败</p>
          <p className="text-xs text-muted-foreground">{projection.error ?? '请稍后重试'}</p>
          <Button type="button" size="sm" variant="outline" onClick={onRefresh}><RefreshCw className="size-3.5" />重试</Button>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {projection.sources.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
              <Database className="size-6 text-muted-foreground" aria-hidden="true" />
              <p className="text-sm">还没有为这台服务器配置数据源</p>
              <p className="max-w-sm text-xs text-muted-foreground">
                数据源通过当前 SSH 连接访问服务器视角的数据库地址，不会在本机开放监听端口。
              </p>
              <Button type="button" size="sm" onClick={onCreate}><Plus className="size-3.5" />新建数据源</Button>
            </div>
          ) : (
            <div className="divide-y divide-border border-b border-border">
              {projection.sources.map((source) => {
                /** 当前数据源的连接测试状态。 */
                const probe = projection.probes[source.id]
                /** 该数据源的诊断是否正在进行。 */
                const diagnosing = diagnostics?.sourceId === source.id && diagnostics.state === 'running'
                return (
                  <div key={source.id} className="flex items-center gap-3 px-3 py-2.5" data-server-ops-data-source={source.id}>
                    <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted/55 text-muted-foreground">
                      <ServerOpsDataEngineIcon engine={source.engine} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium">{source.label}</span>
                        <Badge variant="outline" className="shrink-0 font-normal">{getEngineLabel(source.engine)}</Badge>
                        {formatServerOpsDataTlsPolicy(source.tlsMode) ? <Badge variant="outline" className="shrink-0 font-normal" title="连接设置；实际加密状态以最近一次连接测试或诊断为准">{formatServerOpsDataTlsPolicy(source.tlsMode)}</Badge> : null}
                      </div>
                      <div className="truncate text-xs text-muted-foreground">
                        {source.engine === 'sqlite' ? source.filePath : `${source.address}:${source.port}`}
                        {source.engine === 'sqlite' || source.database === undefined ? '' : ` · 库 ${source.database}`}
                        {source.engine === 'sqlite' || source.username === undefined ? '' : ` · ${source.username}`}
                        {source.engine !== 'sqlite' && source.hasPassword ? ' · 已保存密码' : ''}
                      </div>
                      {probe ? (
                        <div className="mt-0.5 truncate text-[11px] text-muted-foreground" data-server-ops-data-probe={source.id}>
                          {probe.state === 'running' ? '正在测试连接...'
                            : probe.state === 'error' ? probe.error
                            : probe.result === undefined ? '' : formatServerOpsDataProbeSummary(probe.result)}
                        </div>
                      ) : null}
                    </div>
                    <TooltipProvider delayDuration={200}>
                      <div className="flex shrink-0 items-center gap-0.5">
                        {source.engine === 'sqlite' ? null : <Tooltip>
                          <TooltipTrigger asChild>
                            <Button type="button" variant="ghost" size="icon-sm" aria-label={`测试 ${source.label} 的连接`} disabled={probe?.state === 'running'} onClick={() => onProbe(source)}>
                              {probe?.state === 'running' ? <LoaderCircle className="size-3.5 animate-spin" /> : <PlugZap className="size-3.5" />}
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>连接测试</TooltipContent>
                        </Tooltip>}
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button type="button" variant="ghost" size="icon-sm" aria-label={`读取 ${source.label} 的只读诊断`} disabled={diagnosing} onClick={() => onDiagnose(source)}>
                              <Activity className="size-3.5" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>只读诊断</TooltipContent>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button type="button" variant="ghost" size="icon-sm" aria-label={`编辑 ${source.label}`} onClick={() => onEdit(source)}>
                              <Pencil className="size-3.5" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>编辑</TooltipContent>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button type="button" variant="ghost" size="icon-sm" aria-label={`删除 ${source.label}`} onClick={() => onDelete(source)}>
                              <Trash2 className="size-3.5" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>删除</TooltipContent>
                        </Tooltip>
                      </div>
                    </TooltipProvider>
                  </div>
                )
              })}
            </div>
          )}
          {diagnosticsSection}
        </div>
      )}
      <ServerOpsDataSourceDialog
        open={projection.dialog !== null}
        mode={projection.dialog?.mode ?? 'create'}
        source={projection.dialog?.source ?? null}
        hostId={context?.hostId ?? ''}
        hostLabel={context?.hostLabel ?? ''}
        hostOptions={context?.hostId ? [{ id: context.hostId, label: context.hostLabel }] : []}
        submitting={projection.submitting}
        error={projection.dialogError}
        onTest={onTestDraft}
        onRevealPassword={onRevealSourcePassword}
        onDiscoverCredentials={onDiscoverCredentials}
        onApplyDiscoveredCredential={onApplyDiscoveredCredential}
        onSubmit={onSubmit}
        onClose={onCloseDialog}
      />
      <AlertDialog open={projection.deleteTarget !== null} onOpenChange={(open) => { if (!open) onCancelDelete() }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除数据源</AlertDialogTitle>
            <AlertDialogDescription>
              将删除「{projection.deleteTarget?.label}」（{projection.deleteTarget?.engine === 'sqlite' ? projection.deleteTarget.filePath : `${projection.deleteTarget?.address}:${projection.deleteTarget?.port}`}），保存的连接配置将一并删除。此操作不可撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={onConfirmDelete}>删除</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/** 数据服务面板属性。 */
export interface ServerOpsDataServicesPanelProps {
  api: ServerOpsDataPanelApi
  /**
   * 单连接模式聚焦的数据源；提供时只展示该连接并自动读取只读诊断。
   *
   * 项目制下数据库 / Redis 是独立连接，从项目视图点进来必须直接看到诊断结果，
   * 而不是一份与当前选择无关的全局列表。
   */
  focusSource?: ServerOpsDataSource | null
  hostId: string
  hostLabel: string
  hostDescription: string
  /** 当前页签是否可见；不可见时必须停止请求并丢弃迟到的旧结果。 */
  active: boolean
  /** SSH 主机连接是否已建立；未连接时只展示说明，不发起任何请求。 */
  connected: boolean
  /** 单连接模式下数据源被编辑或删除后的通知；由工作区重建连接清单。 */
  onSourceMutated?: (change: ServerOpsDataSourceMutation) => void
}

/**
 * 数据服务页容器：把控制器投影接到纯视图上。
 *
 * @param props 面板属性
 * @returns 数据服务面板
 */
export function ServerOpsDataServicesPanel({
  api,
  focusSource = null,
  hostId,
  hostLabel,
  hostDescription,
  active,
  connected,
  onSourceMutated,
}: ServerOpsDataServicesPanelProps): React.ReactElement {
  /** 当前公开投影。 */
  const [projection, setProjection] = React.useState<ServerOpsDataServicesProjection>(createServerOpsDataIdleProjection)
  /** 只读诊断当前分区；切换连接时回到"数据统计"，避免在新连接上直接落在空表页。 */
  const [diagnosticsTab, setDiagnosticsTab] = React.useState<ServerOpsDataDiagnosticsTab>('metrics')
  React.useEffect(() => { setDiagnosticsTab('metrics') }, [focusSource?.id])
  /** 表浏览投影；与诊断并行，互不影响。 */
  const [schemaProjection, setSchemaProjection] = React.useState<ServerOpsSchemaBrowserProjection>(createServerOpsSchemaIdleProjection)
  /**
   * 单组件生命周期内稳定的表浏览控制器。
   *
   * 表浏览的读取带 owner 与请求代次，切库/换表/翻页的迟到结果一律丢弃。
   */
  const [schemaController] = React.useState(() => createServerOpsSchemaBrowserController({
    api: {
      listServerOpsDataSchemaTables: (input) => api.listServerOpsDataSchemaTables(input),
      describeServerOpsDataSchemaTable: (input) => api.describeServerOpsDataSchemaTable(input),
      readServerOpsDataSchemaRows: (input) => api.readServerOpsDataSchemaRows(input),
      readServerOpsDataSchemaCell: (input) => api.readServerOpsDataSchemaCell(input),
    },
    publish: setSchemaProjection,
  }))
  React.useEffect(() => {
    schemaController.activate()
    return () => schemaController.dispose()
  }, [schemaController])
  /** 绑定当前聚焦连接；Redis 只发布"暂不支持"的提示，不会发起请求。 */
  React.useEffect(() => {
    schemaController.setSource(focusSource === null
      ? null
      : {
        id: focusSource.id,
        engine: focusSource.engine,
        updatedAt: focusSource.updatedAt,
        ...(focusSource.database === undefined ? {} : { database: focusSource.database }),
      })
  }, [focusSource?.id, focusSource?.engine, focusSource?.database, focusSource?.updatedAt, schemaController])
  /** 最新一次渲染的回调，供只创建一次的控制器使用，避免闭包捕获旧的刷新函数。 */
  const onSourceMutatedRef = React.useRef(onSourceMutated)
  React.useEffect(() => {
    onSourceMutatedRef.current = onSourceMutated
  }, [onSourceMutated])
  /** 控制器只在组件生命周期内创建一次，保证请求代次连续。 */
  const controllerRef = React.useRef<ServerOpsDataServicesController | null>(null)
  if (controllerRef.current === null) {
    controllerRef.current = createServerOpsDataServicesController({
      api,
      publish: setProjection,
      onSourceMutated: (change) => onSourceMutatedRef.current?.(change),
    })
  }
  /** 当前控制器。 */
  const controller = controllerRef.current

  React.useEffect(() => {
    /** 每次真实挂载或 StrictMode setup 重放都建立新的 owner 代次。 */
    controller.activate()
    return () => controller.dispose()
  }, [controller])

  React.useEffect(() => {
    controller.setContext({ hostId, hostLabel, hostDescription, active, connected, focusSource })
  }, [controller, hostId, hostLabel, hostDescription, active, connected, focusSource])

  return (
    <ServerOpsDataServicesPanelView
      projection={projection}
      onRefresh={() => controller.refresh()}
      onCreate={() => controller.openCreateDialog()}
      onEdit={(source) => controller.openEditDialog(source)}
      onProbe={(source) => controller.probe(source)}
      onTestDraft={(draft) => api.probeServerOpsDataSource({ draft })}
      onRevealSourcePassword={async (sourceId) => (await api.revealServerOpsDataSourcePassword({ sourceId })).password}
      /*
        延迟读取可选接口：热更新遇到旧 preload 时保持 undefined，
        界面据此隐藏「从本机查找凭据」入口，而不是点了再报错。
      */
      onDiscoverCredentials={api.discoverServerOpsDataCredentials === undefined
        ? undefined : (input) => api.discoverServerOpsDataCredentials!(input)}
      onApplyDiscoveredCredential={api.applyServerOpsDiscoveredCredential === undefined
        ? undefined : (input) => api.applyServerOpsDiscoveredCredential!(input)}
      diagnosticsTab={diagnosticsTab}
      onDiagnosticsTabChange={setDiagnosticsTab}
      /*
        单连接模式下把连接级动作交给诊断行同排渲染：
        面板不再单独占一行写身份，整页因此只剩「工具栏身份 + 这一行控制」两行。
      */
      focusSourceActions={focusSource === null ? undefined : {
        probing: projection.probes[focusSource.id]?.state === 'running',
        onProbe: (source) => controller.probe(source),
        onEdit: (source) => controller.openEditDialog(source),
        onDelete: (source) => controller.requestDelete(source),
      }}
      /** 「表」页签：库 → 表清单 → 结构 / 数据，同样是只读路径。 */
      schemaContent={(
        <ServerOpsSchemaBrowserView
          projection={schemaProjection}
          onSelectDatabase={(database) => schemaController.selectDatabase(database)}
          onOpenTable={(table) => schemaController.openTable(table)}
          onBackToList={() => schemaController.backToList()}
          onDetailTabChange={(tab) => schemaController.setDetailTab(tab)}
          onLoadRows={(offset) => schemaController.loadRows(offset)}
          onOpenCell={(rowIndex, columnIndex) => schemaController.openCell(rowIndex, columnIndex)}
          onCloseCell={() => schemaController.closeCell()}
          onRefresh={() => schemaController.refresh()}
        />
      )}
      onDiagnose={(source) => controller.diagnose(source)}
      onDelete={(source) => controller.requestDelete(source)}
      onSubmit={(input) => controller.submitDialog(input)}
      onCloseDialog={() => controller.closeDialog()}
      onCancelDelete={() => controller.cancelDelete()}
      onConfirmDelete={() => controller.confirmDelete()}
    />
  )
}
