import * as React from 'react'
import { atom, useAtom } from 'jotai'
import { CircleHelp, Code2, History, ListChecks, LoaderCircle, Play, RotateCw, ShieldCheck, Square, Table2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'
import type { ServerOpsDataPanelApi } from './ServerOpsDataServicesPanel'
import { formatServerOpsSchemaCell } from './ServerOpsSchemaBrowserView'
import { createServerOpsSqlQueryController, createServerOpsSqlQueryIdleProjection, isServerOpsSqlQueryContextCurrent } from './server-ops-sql-query-controller'
import { getServerOpsSqlQueryWarningMessage } from './server-ops-sql-query-controller'
import type { ServerOpsSqlQueryExecution } from './server-ops-sql-query-controller'
import { SERVER_OPS_STATUSBAR_CLASS, SERVER_OPS_TAB_CLASS, SERVER_OPS_TABLE_CLASS } from './server-ops-ui'
import { createServerOpsSqlQueryHistoryController, createServerOpsSqlQueryHistoryIdleProjection } from './server-ops-sql-query-history-controller'
import { ServerOpsSqlQueryHistory } from './ServerOpsSqlQueryHistory'
import type { ServerOpsDataSchemaCell } from '@proma/shared'
import { SERVER_OPS_DATA_QUERY_TIMEOUT_MS } from '@proma/shared'
import { ServerOpsSqlEditor } from './ServerOpsSqlEditor'
import type { ServerOpsSqlEditorHandle } from './ServerOpsSqlEditor'
import { createServerOpsSqlCompletionSource } from './server-ops-sql-completion'
import type { ServerOpsSqlDialect } from './server-ops-sql-completion'
import { createServerOpsSqlCompletionController, createServerOpsSqlCompletionIdleProjection, getServerOpsSqlCompletionContextKey } from './server-ops-sql-completion-controller'
import type { ServerOpsSqlCompletionApi } from './server-ops-sql-completion-controller'
import { validateServerOpsSqlDraft } from './server-ops-sql-validation'
import type { ServerOpsSqlDraftValidation, ServerOpsSqlEditorDiagnostic } from './server-ops-sql-validation'

/** 空诊断保持引用稳定，等待防抖时不反复更新 CodeMirror 扩展。 */
const EMPTY_DIAGNOSTICS: ServerOpsSqlEditorDiagnostic[] = []
/** 校验结果绑定原始草稿及连接上下文，迟到结果不能标记新文本。 */
interface SqlValidationSnapshot {
  sql: string
  contextKey: string
  result: ServerOpsSqlDraftValidation
}

/** 执行、取消与本地历史使用独立可选接口，兼容尚未升级的 preload。 */
export type ServerOpsSqlQueryPanelApi = Pick<ServerOpsDataPanelApi, 'queryServerOpsDatabase' | 'cancelServerOpsDatabaseQuery' | 'listServerOpsDatabaseQueryHistory' | 'saveServerOpsDatabaseQueryHistory'> & ServerOpsSqlCompletionApi

/** SQL 查询页面输入；database 由工作台顶部选库器统一控制。 */
export interface ServerOpsSqlQueryPanelProps {
  api: ServerOpsSqlQueryPanelApi
  sourceId: string
  database: string | null
  configurationKey: string
  available: boolean
  /** 查询解析、编辑与补全使用的数据源方言。 */
  dialect?: ServerOpsSqlDialect
}

/** 查询结果纯视图，固定显示执行快照并让空结果保留真实列头。 */
export function ServerOpsSqlQueryResult({ execution, busy }: { execution: ServerOpsSqlQueryExecution; busy: boolean }): React.ReactElement {
  return <section className="flex min-h-64 min-w-0 flex-1 flex-col overflow-hidden" aria-label="查询结果" data-server-ops-sql-result>
    <div className="shrink-0 border-b border-border/40 px-4 py-2 text-[11px] leading-5 text-muted-foreground">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <span className="mr-auto min-w-0 truncate" title={execution.database}>数据库：<strong className="font-medium text-foreground">{execution.database}</strong></span>
        <span className="tabular-nums">{execution.result.rowCount} 行 · {execution.result.durationMs} ms</span>
        {execution.result.truncated ? <span className="text-amber-700 dark:text-amber-400">结果已截断</span> : null}
      </div>
      {busy ? <p className="mt-1 flex items-center gap-1.5" role="status"><LoaderCircle className="size-3 animate-spin" aria-hidden="true" />正在执行新查询，以下为上次成功结果</p> : null}
      <div className="mt-1 min-w-0 truncate font-mono text-[10px]" title={execution.sql}>执行 SQL：{execution.sql}</div>
    </div>
    {execution.result.warnings.length ? <ul className="max-h-24 shrink-0 space-y-1 overflow-y-auto bg-muted/30 px-4 py-2 text-[11px] text-muted-foreground" data-server-ops-sql-warnings>{execution.result.warnings.map((warning: string, index: number) => <li key={`${index}:${warning}`} className="break-words">{getServerOpsSqlQueryWarningMessage(warning)}</li>)}</ul> : null}
    <div className="min-h-0 min-w-0 flex-1 overflow-auto">
      <table className={cn(SERVER_OPS_TABLE_CLASS, 'whitespace-nowrap [&_th]:sticky [&_th]:top-0 [&_th]:z-10 [&_th]:bg-content-area')}>
        <thead><tr>{execution.result.columns.map((column: string, index: number) => <th key={`${index}:${column}`} scope="col">{column}</th>)}</tr></thead>
        <tbody>{execution.result.rows.map((row: ServerOpsDataSchemaCell[], rowIndex: number) => <tr key={rowIndex}>{execution.result.columns.map((_: string, cellIndex: number) => {
          const cell = row[cellIndex] ?? null
          return <td key={cellIndex} className={cn('max-w-[20rem] truncate font-mono', typeof cell === 'string' && /^-?\d+(\.\d+)?$/u.test(cell) && 'text-right tabular-nums', (cell === null || cell === '' || typeof cell === 'object') && 'text-muted-foreground italic')} title={formatServerOpsSchemaCell(cell)}>{formatServerOpsSchemaCell(cell)}</td>
        })}</tr>)}</tbody>
      </table>
      {execution.result.rows.length === 0 ? <div className="p-8 text-center text-xs text-muted-foreground">查询成功，结果为空</div> : null}
    </div>
    <div className={SERVER_OPS_STATUSBAR_CLASS}><span>{execution.result.rowCount} 行</span><span>{execution.result.columns.length} 列</span>{execution.result.truncated ? <span>已按行数或结果大小上限截断</span> : null}</div>
  </section>
}

/** 当前数据库下的按需只读 SQL 查询页面。 */
export function ServerOpsSqlQueryPanel({ api, sourceId, database, configurationKey, available, dialect = 'mysql' }: ServerOpsSqlQueryPanelProps): React.ReactElement {
  /** 每个 Pane 使用独立表单标识，标题标签可准确聚焦自己的编辑器。 */
  const editorId = React.useId()
  /** 独立无障碍说明标识保证双 Pane 中不会引用另一编辑器的诊断。 */
  const diagnosticsId = React.useId()
  /** 从历史回填后将键盘焦点交回当前 Pane 的编辑器。 */
  const editorRef = React.useRef<ServerOpsSqlEditorHandle>(null)
  /** 元数据只保存在当前 Pane 的私有 atom；持久缓存由主进程管理。 */
  const [completionAtom] = React.useState(() => atom(createServerOpsSqlCompletionIdleProjection()))
  const [completion, setCompletion] = useAtom(completionAtom)
  const completionController = React.useMemo(() => createServerOpsSqlCompletionController({ api, publish: setCompletion }), [api, setCompletion])
  /** 稳定 source 在每次补全时获取最新结构，避免键入时重新配置编辑器。 */
  const completionSource = React.useMemo(() => createServerOpsSqlCompletionSource({ dialect, getSchema: completionController.snapshot, ensureCatalog: completionController.ensureCatalog, ensureColumns: completionController.ensureColumns }), [completionController, dialect])
  const completionContextKey = getServerOpsSqlCompletionContextKey({ sourceId, database, configurationKey, available })
  const visibleCompletion = React.useMemo(() => completion.contextKey === completionContextKey ? completion : createServerOpsSqlCompletionIdleProjection(), [completion, completionContextKey])
  /** 草稿、查询行和执行快照只存在于当前组件的私有 atom。 */
  const [projectionAtom] = React.useState(() => atom(createServerOpsSqlQueryIdleProjection()))
  const [projection, setProjection] = useAtom(projectionAtom)
  /** 渲染与事件同时核对目标，防止选库 props 先于控制器 effect 更新时误查旧库。 */
  const currentQueryContext = { sourceId, database, configurationKey, available }
  const queryContextMatches = isServerOpsSqlQueryContextCurrent(projection.context, currentQueryContext)
  /** 输入法组合与诊断只属于当前 Pane；不进入持久草稿或查询历史。 */
  const [validationAtom] = React.useState(() => atom<SqlValidationSnapshot | null>(null))
  const [validation, setValidation] = useAtom(validationAtom)
  const [composingAtom] = React.useState(() => atom(false))
  const [composing, setComposing] = useAtom(composingAtom)
  /** 文本或连接一变就隐藏旧结果，等待本次本地校验，不沿用旧的绿色通过状态。 */
  const visibleValidation = !composing && validation?.sql === projection.draft && validation.contextKey === completionContextKey ? validation.result : null
  const diagnostics = visibleValidation?.diagnostics ?? EMPTY_DIAGNOSTICS
  /** 输出页签和历史读取独立于查询结果，切换页签不取消在途查询。 */
  const [outputTabAtom] = React.useState(() => atom<'result' | 'history'>('result'))
  const [outputTab, setOutputTab] = useAtom(outputTabAtom)
  const [historyAtom] = React.useState(() => atom(createServerOpsSqlQueryHistoryIdleProjection()))
  const [history, setHistory] = useAtom(historyAtom)
  /** 历史写入独立收口；本地保存失败不会覆盖 SQL 执行状态。 */
  const historyController = React.useMemo(() => createServerOpsSqlQueryHistoryController({
    api: { list: api.listServerOpsDatabaseQueryHistory, save: api.saveServerOpsDatabaseQueryHistory },
    publish: setHistory,
  }), [api, setHistory])
  /** 桥接引用稳定时控制器保持稳定，切库由显式上下文代次处理。 */
  const controller = React.useMemo(() => createServerOpsSqlQueryController({
    api: {
      query: api.queryServerOpsDatabase,
      cancel: api.cancelServerOpsDatabaseQuery,
    },
    publish: setProjection,
    onExecuted: (input) => { void historyController.record({ sourceId: input.sourceId, database: input.database, sql: input.sql }) },
  }), [api, setProjection, historyController])

  React.useEffect(() => {
    completionController.activate()
    return () => completionController.dispose()
  }, [completionController])
  React.useEffect(() => {
    completionController.setContext({ sourceId, database, configurationKey, available })
  }, [completionController, sourceId, database, configurationKey, available])
  React.useEffect(() => {
    historyController.activate()
    return () => historyController.dispose()
  }, [historyController])
  React.useEffect(() => {
    historyController.setContext({ sourceId, database, configurationKey })
    setOutputTab('result')
  }, [historyController, sourceId, database, configurationKey, setOutputTab])
  React.useEffect(() => {
    controller.activate()
    return () => controller.dispose()
  }, [controller])
  React.useEffect(() => {
    controller.setContext({ sourceId, database, configurationKey, available })
  }, [controller, sourceId, database, configurationKey, available])

  React.useEffect(() => {
    if (composing || !database || !projection.draft.trim()) return
    /** 停顿 350ms 后只读取现有结构，快速输入和卸载会清理待执行校验。 */
    const timer = setTimeout(() => {
      setValidation({ sql: projection.draft, contextKey: completionContextKey, result: validateServerOpsSqlDraft(projection.draft, database, visibleCompletion, dialect) })
    }, 350)
    return () => clearTimeout(timer)
  }, [projection.draft, database, completionContextKey, visibleCompletion, composing, dialect, setValidation])

  /** 手动校验及执行前检查共用纯函数，不调用查询或历史接口。 */
  const validateDraft = (locate: boolean): ServerOpsSqlDraftValidation => {
    const sql = controller.snapshot().draft
    const result = validateServerOpsSqlDraft(sql, database, visibleCompletion, dialect)
    setValidation({ sql, contextKey: completionContextKey, result })
    if (locate && result.diagnostics[0]) editorRef.current?.reveal(result.diagnostics[0])
    return result
  }

  /** 点击、快捷键与错误重试使用同一入口，真正执行时自动切回结果页签。 */
  const executeQuery = (): void => {
    if (composing || !isServerOpsSqlQueryContextCurrent(controller.snapshot().context, currentQueryContext) || !controller.snapshot().canExecute) return
    const result = validateDraft(false)
    if (result.status === 'invalid') {
      if (result.diagnostics[0]) editorRef.current?.reveal(result.diagnostics[0])
      return
    }
    setOutputTab('result')
    void controller.execute(currentQueryContext)
  }
  /** 历史回填不执行 SQL，也不改变上次成功结果的执行快照。 */
  const useHistorySql = (sql: string): void => {
    controller.setDraft(sql)
    editorRef.current?.focus()
  }
  /** 接口、选库和连接状态按最具体原因提示。 */
  const unavailableReason = !api.queryServerOpsDatabase || !api.cancelServerOpsDatabaseQuery
    ? '查询接口尚未就绪，请重启应用后重试。'
    : !database ? '请先在顶部选择数据库。'
      : !available ? '当前连接不可达，恢复连接后才能查询。' : null
  const busy = projection.status === 'running' || projection.status === 'cancelling'
  const execution = projection.execution
  /** props 切库到 effect 生效之间也不展示旧数据库历史。 */
  const visibleHistory = history.context?.sourceId === sourceId && history.context.database === database && history.context.configurationKey === configurationKey
    ? history : createServerOpsSqlQueryHistoryIdleProjection()
  /** 结果尚未出现时仍明确区分等待执行、执行中、取消和不可用原因。 */
  const emptyTitle = unavailableReason ? '暂时无法查询' : projection.status === 'cancelling' ? '正在取消查询' : busy ? '正在执行查询' : projection.error ? '查询未完成' : '等待执行查询'
  /** 空白区只显示当前最相关的操作提示，详细语法规则放入查询说明。 */
  const emptyDescription = unavailableReason ?? (projection.status === 'cancelling' ? '正在释放本次查询，完成后可重新执行。' : busy ? '查询完成后，结果会显示在这里。' : projection.error ? '请根据上方提示处理后重试。' : '在上方输入 SQL，点击「执行」或使用快捷键。')
  return <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto" data-server-ops-sql-query data-server-ops-sql-dialect={dialect}>
    <section className="m-3 shrink-0 overflow-hidden rounded-xl border border-border/60 bg-content-area" aria-label="SQL 查询编辑区" data-server-ops-sql-editor-region>
      <div className="flex min-w-0 flex-wrap items-center gap-2 border-b border-border/40 bg-muted/20 px-3 py-1.5">
        <label htmlFor={editorId} className="flex items-center gap-1.5 text-xs font-medium"><Code2 className="size-3.5 text-muted-foreground" aria-hidden="true" />SQL 编辑器</label>
        <span className="flex items-center gap-1 rounded-md bg-muted/70 px-1.5 py-0.5 text-[10px] text-muted-foreground"><ShieldCheck className="size-3" aria-hidden="true" />只读 SELECT</span>
        <Popover>
          <PopoverTrigger asChild><Button type="button" variant="ghost" size="sm" className="ml-auto h-7 gap-1 rounded-md px-1.5 text-[11px] text-muted-foreground" aria-label="查询说明"><CircleHelp className="size-3.5" aria-hidden="true" />查询说明</Button></PopoverTrigger>
          <PopoverContent align="end" className="z-[260] w-80 max-w-[calc(100vw-2rem)] space-y-2 text-xs leading-5">
            <h3 className="font-medium">只读查询说明</h3>
            <p className="text-muted-foreground">支持当前库基础表的单条 SELECT、筛选、排序、分组聚合与受控 JOIN，不修改数据库。暂不支持子查询、UNION、视图和跨库查询。</p>
            <p className="text-muted-foreground">每次最多返回 200 行。大字段请明确选择字段，或使用 <code className="break-words font-mono text-foreground">{dialect === 'sqlite' ? 'substr(字段, 1, 256)' : 'SUBSTRING(字段, 1, 256)'}</code>。</p>
            <p className="text-muted-foreground">单表与联表均设 {SERVER_OPS_DATA_QUERY_TIMEOUT_MS / 1_000} 秒执行上限，超时释放本次连接。请优先限定查询条件；超时后不会自动重试。</p>
            <p className="text-muted-foreground">查询结果不会自动刷新，修改 SQL 后需要重新执行。</p>
          </PopoverContent>
        </Popover>
      </div>
      <ServerOpsSqlEditor
        id={editorId}
        ref={editorRef}
        contextKey={completionContextKey}
        completionSource={completionSource}
        diagnostics={diagnostics}
        diagnosticsId={diagnosticsId}
        dialect={dialect}
        value={projection.draft}
        onChange={(value) => controller.setDraft(value)}
        onExecute={executeQuery}
        onCompositionChange={setComposing}
      />
      <div className="flex min-w-0 items-center gap-2 border-t border-border/30 px-3 py-1 text-[10px] text-muted-foreground" data-server-ops-sql-schema-status>
        {visibleCompletion.status === 'loading' || visibleCompletion.pendingTables > 0 ? <LoaderCircle className="size-3 shrink-0 animate-spin" aria-hidden="true" /> : null}
        <span className="min-w-0 flex-1 truncate" role="status" title={visibleCompletion.error ?? undefined}>{visibleCompletion.error ?? (visibleCompletion.status === 'loading' ? '正在读取表目录…' : visibleCompletion.pendingTables > 0 ? '正在读取字段…' : visibleCompletion.status === 'ready' ? `${visibleCompletion.tables.length} 张表${visibleCompletion.tablesTruncated ? '（目录已截断）' : ''} · 字段按需加载 · Tab 接受联想` : '选择数据库后可联想表名和字段')}</span>
        <Button type="button" variant="ghost" size="sm" className="h-6 shrink-0 gap-1 px-1.5 text-[10px]" disabled={!database || !available || visibleCompletion.status === 'loading'} onClick={() => { void completionController.refresh() }} aria-label="刷新数据库结构"><RotateCw className="size-3" aria-hidden="true" />刷新结构</Button>
      </div>
      <div id={diagnosticsId} className="max-h-28 overflow-y-auto border-t border-border/30 px-3 py-1.5 text-[11px] leading-5" data-server-ops-sql-validation>
        {diagnostics.length > 0 ? <ul className="space-y-1" aria-label="SQL 校验提示">{diagnostics.map((diagnostic, index) => {
          /** 用户看到的行列从 1 开始，位置不泄漏 SQL 中的常量。 */
          const before = projection.draft.slice(0, diagnostic.from).split('\n')
          const location = `第 ${before.length} 行，第 ${(before.at(-1)?.length ?? 0) + 1} 列`
          const category = diagnostic.category === 'schema' ? '结构提醒' : diagnostic.category === 'unsupported' ? '暂不支持' : diagnostic.category === 'policy' ? '查询限制' : '语法错误'
          return <li key={`${diagnostic.code}:${diagnostic.from}:${index}`}><button type="button" className={cn('w-full rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40', diagnostic.severity === 'error' ? 'text-destructive' : 'text-amber-700 dark:text-amber-400')} onClick={() => editorRef.current?.reveal(diagnostic)} title={`点击定位：${location}`}><span className="font-medium">{category}</span><span className="ml-2 text-muted-foreground">{location}</span><span className="block break-words">{diagnostic.message}</span></button></li>
        })}</ul> : null}
        <p role="status" aria-live="polite" className={cn('text-muted-foreground', diagnostics.length > 0 && 'sr-only')}>
          {diagnostics.length > 0 ? `${diagnostics.length} 条校验提示：${diagnostics[0]?.message}` : !database ? '选择数据库后可校验 SQL' : !projection.draft.trim() ? '输入 SQL 后自动校验，也可点击「校验」' : composing ? '输入完成后自动校验' : !visibleValidation ? '等待输入完成后校验…' : '语法校验通过，执行时仍会检查结构与权限。'}
        </p>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2 border-t border-border/40 bg-muted/10 px-3 py-2" data-server-ops-sql-actions>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button type="button" size="sm" variant="outline" aria-label="校验 SQL" disabled={!database || !projection.draft.trim() || composing} onClick={() => { validateDraft(true) }}><ListChecks className="size-3.5" aria-hidden="true" />校验</Button>
          <Button type="button" size="sm" aria-label="执行查询" disabled={!queryContextMatches || !projection.canExecute || composing} onClick={executeQuery}>
            {projection.status === 'running' ? <LoaderCircle className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}执行
          </Button>
          <Button type="button" size="sm" variant="outline" aria-label="取消查询" disabled={projection.status !== 'running'} onClick={() => { void controller.cancel() }}>
            {projection.status === 'cancelling' ? <LoaderCircle className="size-3.5 animate-spin" /> : <Square className="size-3.5" />}{projection.status === 'cancelling' ? '取消中' : '取消'}
          </Button>
        </div>
        <span className="text-[10px] text-muted-foreground">Ctrl/Cmd + Enter</span>
        <label className="ml-auto flex shrink-0 items-center gap-2 text-[11px] text-muted-foreground">最多行数
          <input className="h-7 w-16 rounded-md border border-border/60 bg-content-area px-2 text-xs tabular-nums text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40" type="number" min={1} max={200} step={1} value={projection.maxRows} disabled={busy} onChange={(event) => controller.setMaxRows(event.currentTarget.valueAsNumber)} />
        </label>
      </div>
    </section>
    {unavailableReason && execution ? <p className="shrink-0 px-4 py-2 text-xs text-muted-foreground">{unavailableReason}</p> : null}
    {projection.error ? <div role="alert" className="mx-3 my-2 flex shrink-0 flex-wrap items-center gap-2 rounded-md bg-destructive/5 px-3 py-2 text-xs"><span className="min-w-0 flex-1 break-words text-destructive">{projection.error}</span><Button type="button" size="sm" variant="outline" disabled={projection.activeQueryId === null ? !projection.canExecute : projection.status !== 'running'} onClick={() => { if (projection.activeQueryId === null) executeQuery(); else void controller.cancel() }}><RotateCw className="size-3.5" />{projection.activeQueryId === null ? '重试' : '重试取消'}</Button></div> : null}
    {visibleHistory.failedCount > 0 ? <div role="alert" className="mx-3 mb-2 flex shrink-0 flex-wrap items-center gap-2 rounded-md bg-amber-500/5 px-3 py-2 text-xs"><span className="min-w-0 flex-1 text-amber-700 dark:text-amber-400">{visibleHistory.failedCount} 条 SQL 未能保存到查询历史，不影响查询结果。</span><Button type="button" size="sm" variant="outline" disabled={visibleHistory.saving} onClick={() => { void historyController.retryFailed() }}><RotateCw className="size-3.5" />重试保存</Button></div> : null}
    <Tabs value={outputTab} onValueChange={(value) => { setOutputTab(value === 'history' ? 'history' : 'result'); if (value === 'history') void historyController.refresh() }} className="flex min-h-40 min-w-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-y border-border/40 px-3">
        <TabsList aria-label="查询输出" className="h-10 justify-start gap-1 rounded-none bg-transparent p-0">
          <TabsTrigger value="result" className={SERVER_OPS_TAB_CLASS}><Table2 className="size-3.5" aria-hidden="true" />查询结果</TabsTrigger>
          <TabsTrigger value="history" className={SERVER_OPS_TAB_CLASS}><History className="size-3.5" aria-hidden="true" />查询历史{visibleHistory.entries.length > 0 ? <span className="text-[10px] tabular-nums text-muted-foreground">{visibleHistory.entries.length}</span> : null}</TabsTrigger>
        </TabsList>
        {visibleHistory.saving ? <span className="ml-auto flex items-center gap-1 text-[10px] text-muted-foreground" role="status"><LoaderCircle className="size-3 animate-spin" aria-hidden="true" />保存中</span> : null}
      </div>
      <TabsContent value="result" className="mt-0 flex min-h-40 min-w-0 flex-1 flex-col data-[state=inactive]:hidden">
        {execution ? <ServerOpsSqlQueryResult execution={execution} busy={busy} /> : (
          <section className="flex min-h-40 min-w-0 flex-1 flex-col" aria-label="查询结果">
            <div className="flex min-h-28 flex-1 flex-col items-center justify-center gap-2 px-4 py-6 text-center text-muted-foreground">
              <span className="flex size-9 items-center justify-center rounded-xl bg-muted/40">{busy ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : <Table2 className="size-4" aria-hidden="true" />}</span>
              <p className="text-xs font-medium text-foreground/80" role="status">{emptyTitle}</p>
              <p className="max-w-sm text-[11px] leading-5">{emptyDescription}</p>
            </div>
          </section>
        )}
      </TabsContent>
      <TabsContent value="history" className="mt-0 flex min-h-40 min-w-0 flex-1 flex-col data-[state=inactive]:hidden">
        <ServerOpsSqlQueryHistory projection={visibleHistory} onUse={useHistorySql} onRefresh={() => { void historyController.refresh() }} />
      </TabsContent>
    </Tabs>
  </div>
}
