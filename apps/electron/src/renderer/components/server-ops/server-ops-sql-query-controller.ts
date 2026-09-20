import { getServerOpsSqlDiagnostic, validateServerOpsSqlQuery } from '@proma/shared'
import type {
  ServerOpsDataQueryCancelInput,
  ServerOpsDataQueryInput,
  ServerOpsDataQueryResult,
} from '@proma/shared'

/** SQL 查询页只依赖执行与取消两个可选桥接，兼容尚未升级的 preload。 */
export interface ServerOpsSqlQueryApi {
  query?: (input: ServerOpsDataQueryInput) => Promise<ServerOpsDataQueryResult>
  cancel?: (input: ServerOpsDataQueryCancelInput) => Promise<void>
}

/** 查询绑定的连接、配置和当前库；available 同时表达跳板可达性。 */
export interface ServerOpsSqlQueryContext {
  sourceId: string
  database: string | null
  configurationKey: string
  available: boolean
}

/** 比对当前页面与控制器的查询目标，防止 React effect 同步前查询旧数据库。 */
export function isServerOpsSqlQueryContextCurrent(actual: ServerOpsSqlQueryContext | null, expected: ServerOpsSqlQueryContext): boolean {
  return actual !== null && actual.sourceId === expected.sourceId && actual.database === expected.database
    && actual.configurationKey === expected.configurationKey && actual.available === expected.available
}

/** 成功结果固定执行快照，避免后续编辑让旧结果看起来属于新 SQL。 */
export interface ServerOpsSqlQueryExecution {
  sql: string
  database: string
  result: ServerOpsDataQueryResult
}

/** 查询页面的私有投影；草稿与业务行不进入全局导航或磁盘。 */
export interface ServerOpsSqlQueryProjection {
  context: ServerOpsSqlQueryContext | null
  draft: string
  maxRows: number
  status: 'idle' | 'running' | 'cancelling' | 'success' | 'error'
  activeQueryId: string | null
  execution: ServerOpsSqlQueryExecution | null
  error: string | null
  canExecute: boolean
}

/** 控制器依赖允许测试注入稳定查询 ID。 */
export interface ServerOpsSqlQueryControllerOptions {
  api: ServerOpsSqlQueryApi
  publish: (projection: ServerOpsSqlQueryProjection) => void
  createQueryId?: () => string
  /** 查询结束后通知历史保存，入参固定为发起时快照；不等待保存，也不改变查询终态。 */
  onExecuted?: (input: ServerOpsDataQueryInput) => void
}

/** 将主进程稳定码收敛为中文说明，未知驱动正文绝不进入界面。 */
export function getServerOpsSqlQueryErrorMessage(error: unknown, phase: 'query' | 'cancel' = 'query'): string {
  const text = error instanceof Error ? error.message : String(error)
  if (text.includes('SERVER_OPS_OTHER_INSTANCE_ACTIVE')) return '审计记录需要初始化或升级，请先退出其他 Proma 实例后重试；SQL 尚未执行'
  if (text.includes('SERVER_OPS_TRUST_BUSY')) return '运维配置正在准备，请稍后重试；SQL 尚未执行'
  if (text.includes('SERVER_OPS_CONFIG_BUSY')) return '运维配置正在写入，请稍后重试；SQL 尚未执行'
  if (text.includes('SERVER_OPS_CONFIG_LOCK_UNAVAILABLE')) return '运维配置写锁不可用，请重启或更新 Proma 后重试；SQL 尚未执行'
  if (text.includes('SERVER_OPS_CONFIG_OUTCOME_UNKNOWN')) return '审计写入状态无法确认，请稍后重试，若持续失败再重启 Proma；SQL 尚未执行'
  if (text.includes('SERVER_OPS_AUDIT_READ_FAILED')) return '本地审计记录无法读取，需要检查审计文件；SQL 尚未执行'
  if (text.includes('SERVER_OPS_AUDIT_SCHEMA_NOT_PREPARED')) return '本地审计记录尚未准备完成，请重启 Proma 后重试；SQL 尚未执行'
  if (text.includes('SERVER_OPS_AUDIT_WRITE_FAILED')) return '本地审计记录写入失败，请检查磁盘空间和配置目录权限后重启 Proma；SQL 尚未执行'
  if (text.includes('SERVER_OPS_AUDIT_START_WRITE_FAILED')) return '无法记录查询审计，请检查本地运维配置后重试；SQL 尚未执行'
  if (text.includes('SERVER_OPS_DATA_QUERY_SENSITIVE_COLUMN') || text.includes('SERVER_OPS_SQL_SENSITIVE_COLUMN')) return '查询包含敏感字段，无法执行'
  if (text.includes('SERVER_OPS_DATA_QUERY_TABLE_UNAVAILABLE')) return '查询中的表不存在、不可见或不是基础表'
  if (text.includes('SERVER_OPS_DATA_QUERY_COLUMN_UNAVAILABLE')) return '查询中的字段不存在或不可见'
  if (text.includes('SERVER_OPS_DATA_QUERY_PERMISSION_DENIED')) return '数据库认证失败或账号权限不足'
  if (text.includes('SERVER_OPS_DATA_QUERY_TIMEOUT')) return '查询超时，请缩小扫描范围后重试'
  if (text.includes('SERVER_OPS_DATA_QUERY_TOO_MANY_COLUMNS')) return '查询结果字段超过 64 列，请减少选择字段'
  if (text.includes('SERVER_OPS_DATA_QUERY_COLUMN_TOO_LARGE')) return '字段内容过大，请明确选择字段，或使用 SUBSTRING(字段, 1, 256) 缩小文本后查询'
  if (text.includes('SERVER_OPS_DATA_QUERY_ENGINE_UNSUPPORTED')) return '当前数据源不支持 SQL 查询'
  if (text.includes('SERVER_OPS_DATA_QUERY_SOURCE_CHANGED') || text.includes('SERVER_OPS_DATA_SOURCE_CHANGED')) return '连接配置已变化，请重新执行查询'
  if (text.includes('SERVER_OPS_DATA_CANCELLED') || text.includes('SERVER_OPS_SQL_CANCELLED')) return '查询已取消'
  if (text.includes('SERVER_OPS_DATA_TIMEOUT')) return '查询超时，请缩小扫描范围后重试'
  if (text.includes('SERVER_OPS_DATA_SOURCE_BUSY')) return '该数据源已有查询或读取正在进行，请稍后重试'
  if (text.includes('SERVER_OPS_DATA_BUSY')) return '同时进行的数据库读取过多，请稍后重试'
  if (text.includes('SERVER_OPS_SQL_BUSY')) return '该数据源已有 SQL 查询正在进行，请等待完成或取消后重试'
  if (text.includes('SERVER_OPS_SQL_CROSS_DATABASE') || text.includes('SERVER_OPS_SQL_SYSTEM_SCHEMA')) return '只允许查询当前已授权数据库中的基础表'
  if (text.includes('SERVER_OPS_AUDIT_RESULT_WRITE_FAILED')) return '查询已完成，但审计结果写入失败'
  /** Electron IPC 会包裹错误文字，只提取已知稳定码，不回显驱动正文。 */
  const parserCode = text.match(/\bSERVER_OPS_SQL_[A-Z_]+\b/u)?.[0]
  const diagnostic = parserCode ? getServerOpsSqlDiagnostic(parserCode) : null
  if (diagnostic) return diagnostic.message
  if (text.includes('SERVER_OPS_DATA_QUERY_SQL_INVALID')) return '数据库未通过 SQL 语法检查，请检查语句和数据库版本'
  if (text.includes('SERVER_OPS_SQL_')) return 'SQL 校验未通过，请调整后重试'
  if (/AUTH|ACCESS_DENIED|PERMISSION_DENIED/iu.test(text)) return '数据库认证失败或账号权限不足'
  if (text.includes('SERVER_OPS_DATA_QUERY_FAILED')) return 'SQL 查询失败，请检查连接、语句与账号权限'
  return phase === 'cancel' ? '取消查询失败，请稍后重试' : 'SQL 查询失败，请稍后重试'
}

/** 查询结果警告同样不回显内部稳定码或驱动正文。 */
export function getServerOpsSqlQueryWarningMessage(warning: string): string {
  if (warning.includes('SERVER_OPS_AUDIT_RESULT_WRITE_FAILED')) return '查询已完成，但审计结果写入失败'
  return '查询已完成，但服务返回了附加警告'
}

/** 只识别服务端明确的取消终态，避免把普通查询失败当成正常取消。 */
function isServerOpsSqlQueryCancelled(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error)
  return text.includes('SERVER_OPS_SQL_CANCELLED') || text.includes('SERVER_OPS_DATA_CANCELLED')
}

/** 创建不含连接和业务数据的初始投影。 */
export function createServerOpsSqlQueryIdleProjection(): ServerOpsSqlQueryProjection {
  return { context: null, draft: '', maxRows: 50, status: 'idle', activeQueryId: null, execution: null, error: null, canExecute: false }
}

/** 创建单个数据库工作台私有的 SQL 查询状态机。 */
export function createServerOpsSqlQueryController(options: ServerOpsSqlQueryControllerOptions) {
  /** 当前投影只在所属工作台挂载期存在。 */
  let state = createServerOpsSqlQueryIdleProjection()
  /** 查询执行代次只在新查询或确认取消时推进；取消失败不能作废真实运行。 */
  let generation = 0
  /** 取消尝试独立编号，查询先结束时可精确忽略迟到取消回执。 */
  let cancellationGeneration = 0
  /** 当前真实查询身份独立于可变页面上下文。 */
  let activeRequest: { queryId: string; sourceId: string; database: string; configurationKey: string; generation: number; abandoned: boolean } | null = null
  /** React StrictMode 清理后禁止旧 owner 发布。 */
  let active = false

  /** 生成跨本次应用运行唯一的查询 ID。 */
  const createQueryId = (): string => options.createQueryId?.() ?? globalThis.crypto.randomUUID()
  /** 计算按钮门禁；执行与取消缺一时不启动无法可靠收口的查询。 */
  const canExecute = (): boolean => Boolean(
    active
    && state.context?.available
    && state.context.database
    && state.draft.trim()
    && options.api.query
    && options.api.cancel
    && activeRequest === null,
  )
  /** 跨 await 读取当前运行时状态，避免沿用发起查询时的静态窄化结果。 */
  const currentStatus = (): ServerOpsSqlQueryProjection['status'] => state.status
  /** 发布不可变副本，测试和 React 均不能反向修改内部状态。 */
  const publish = (): void => {
    state.canExecute = canExecute()
    if (active) options.publish(structuredClone(state))
  }
  /** 发起一次取消；失败保留查询身份和可重试入口，查询自身终态仍可解锁。 */
  const cancelActiveQuery = async (): Promise<void> => {
    const request = activeRequest
    const cancel = options.api.cancel
    if (!active || !request || !cancel || state.status === 'cancelling') return
    const cancellation = ++cancellationGeneration
    state.status = 'cancelling'; state.error = null
    publish()
    try {
      await cancel({ sourceId: request.sourceId, queryId: request.queryId })
      if (!active || activeRequest !== request || cancellationGeneration !== cancellation) return
      generation += 1
      activeRequest = null
      state.status = 'idle'; state.activeQueryId = null; state.error = null
    } catch (error) {
      if (!active || activeRequest !== request || cancellationGeneration !== cancellation) return
      state.status = 'running'
      state.error = getServerOpsSqlQueryErrorMessage(error, 'cancel')
    } finally {
      if (active && cancellationGeneration === cancellation) publish()
    }
  }

  return {
    /** 返回控制器快照，供组件和异步行为测试读取。 */
    snapshot: (): ServerOpsSqlQueryProjection => structuredClone(state),
    /** StrictMode setup 重新启用同一控制器。 */
    activate(): void { active = true; publish() },
    /** 切库、连接配置变化或可达性变化都清空旧结果并取消在途请求。 */
    setContext(context: ServerOpsSqlQueryContext): void {
      if (isServerOpsSqlQueryContextCurrent(state.context, context)) return
      state = { ...state, context: { ...context }, execution: null, error: null }
      if (activeRequest) {
        activeRequest.abandoned = true
        /** 新上下文必须等待旧查询真实结束，不能提前撞上同源单飞门禁。 */
        if (state.status !== 'cancelling') void cancelActiveQuery()
      } else {
        state.status = 'idle'; state.activeQueryId = null
      }
      publish()
    },
    /** 编辑 SQL 草稿不改变上一次执行快照。 */
    setDraft(draft: string): void { state.draft = draft; state.error = null; publish() },
    /** UI 上限固定 200 行，异常输入回落到合法整数。 */
    setMaxRows(maxRows: number): void {
      state.maxRows = Math.min(200, Math.max(1, Number.isFinite(maxRows) ? Math.floor(maxRows) : 50))
      publish()
    },
    /** 按点击瞬间的 SQL、数据库和行数执行，不自动响应草稿变化。 */
    async execute(expectedContext?: ServerOpsSqlQueryContext): Promise<void> {
      if (!canExecute()) return
      /** UI 将本次显示的目标一起提交，尚未同步上下文时只拒绝，不猜测或切换目标。 */
      if (expectedContext && !isServerOpsSqlQueryContextCurrent(state.context, expectedContext)) return
      const context = state.context
      const query = options.api.query
      if (!context?.database || !query) return
      /** 每次按下执行都检查当前文本，不能依赖防抖前的旧结果；本地拒绝不记历史。 */
      const validation = validateServerOpsSqlQuery(state.draft, context.database)
      if (!validation.plan) {
        state.status = 'error'; state.error = validation.diagnostics[0]?.message ?? 'SQL 校验未通过，请调整后重试'
        publish()
        return
      }
      const queryId = createQueryId()
      const revision = ++generation
      const sql = state.draft.trim()
      const database = context.database
      /** 捕获完整执行参数，后续编辑、切库或卸载不改变这条历史的归属。 */
      const input: ServerOpsDataQueryInput = { sourceId: context.sourceId, database, queryId, sql, maxRows: state.maxRows }
      activeRequest = { queryId, sourceId: context.sourceId, database, configurationKey: context.configurationKey, generation: revision, abandoned: false }
      state.status = 'running'; state.activeQueryId = queryId; state.error = null
      publish()
      try {
        const result = await query(input)
        const request = activeRequest
        if (!active || generation !== revision || !request || request.queryId !== queryId) return
        if (result.queryId !== queryId || result.database !== database) {
          activeRequest = null; cancellationGeneration += 1; state.activeQueryId = null
          state.status = 'error'; state.error = '查询结果与当前请求不匹配'; publish(); return
        }
        activeRequest = null; cancellationGeneration += 1; state.activeQueryId = null
        if (request.abandoned) { state.status = 'idle'; state.error = null; publish(); return }
        state.execution = { sql, database, result: structuredClone(result) }
        state.status = 'success'; state.error = null
        publish()
      } catch (error) {
        const request = activeRequest
        if (!active || generation !== revision || !request || request.queryId !== queryId) return
        const explicitlyCancelling = currentStatus() === 'cancelling'
        activeRequest = null; cancellationGeneration += 1; state.activeQueryId = null
        if (request.abandoned) { state.status = 'idle'; state.error = null; publish(); return }
        if (explicitlyCancelling && isServerOpsSqlQueryCancelled(error)) { state.status = 'idle'; state.error = null; publish(); return }
        state.status = 'error'
        state.error = getServerOpsSqlQueryErrorMessage(error)
        publish()
      } finally {
        try { options.onExecuted?.(input) } catch { /* 历史故障由独立状态呈现，不覆盖查询结果或取消状态。 */ }
      }
    },
    /** 用户取消在服务确认前保持 busy，确认后回到可重试状态。 */
    async cancel(): Promise<void> {
      if (!active || state.status !== 'running' || !activeRequest) return
      await cancelActiveQuery()
    },
    /** 卸载立即使回执失效，并尽力取消真实请求。 */
    dispose(): void {
      const request = activeRequest
      generation += 1; cancellationGeneration += 1; activeRequest = null; active = false
      if (request && options.api.cancel) void options.api.cancel({ sourceId: request.sourceId, queryId: request.queryId }).catch(() => undefined)
    },
  }
}
