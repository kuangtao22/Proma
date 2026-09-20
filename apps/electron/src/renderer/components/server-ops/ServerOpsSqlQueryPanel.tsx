import * as React from 'react'
import { atom, useAtom } from 'jotai'
import { CircleHelp, Code2, History, LoaderCircle, Play, RotateCw, ShieldCheck, Square, Table2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'
import type { ServerOpsDataPanelApi } from './ServerOpsDataServicesPanel'
import { formatServerOpsSchemaCell } from './ServerOpsSchemaBrowserView'
import { createServerOpsSqlQueryController, createServerOpsSqlQueryIdleProjection } from './server-ops-sql-query-controller'
import { getServerOpsSqlQueryWarningMessage } from './server-ops-sql-query-controller'
import type { ServerOpsSqlQueryExecution } from './server-ops-sql-query-controller'
import { SERVER_OPS_STATUSBAR_CLASS, SERVER_OPS_TAB_CLASS, SERVER_OPS_TABLE_CLASS } from './server-ops-ui'
import { createServerOpsSqlQueryHistoryController, createServerOpsSqlQueryHistoryIdleProjection } from './server-ops-sql-query-history-controller'
import { ServerOpsSqlQueryHistory } from './ServerOpsSqlQueryHistory'
import type { ServerOpsDataSchemaCell } from '@proma/shared'

/** 执行、取消与本地历史使用独立可选接口，兼容尚未升级的 preload。 */
export type ServerOpsSqlQueryPanelApi = Pick<ServerOpsDataPanelApi, 'queryServerOpsDatabase' | 'cancelServerOpsDatabaseQuery' | 'listServerOpsDatabaseQueryHistory' | 'saveServerOpsDatabaseQueryHistory'>

/** SQL 查询页面输入；database 由工作台顶部选库器统一控制。 */
export interface ServerOpsSqlQueryPanelProps {
  api: ServerOpsSqlQueryPanelApi
  sourceId: string
  database: string | null
  configurationKey: string
  available: boolean
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
export function ServerOpsSqlQueryPanel({ api, sourceId, database, configurationKey, available }: ServerOpsSqlQueryPanelProps): React.ReactElement {
  /** 每个 Pane 使用独立表单标识，标题标签可准确聚焦自己的编辑器。 */
  const editorId = React.useId()
  /** 从历史回填后将键盘焦点交回当前 Pane 的编辑器。 */
  const editorRef = React.useRef<HTMLTextAreaElement>(null)
  /** 草稿、查询行和执行快照只存在于当前组件的私有 atom。 */
  const [projectionAtom] = React.useState(() => atom(createServerOpsSqlQueryIdleProjection()))
  const [projection, setProjection] = useAtom(projectionAtom)
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

  /** 点击、快捷键与错误重试使用同一入口，真正执行时自动切回结果页签。 */
  const executeQuery = (): void => {
    if (!controller.snapshot().canExecute) return
    setOutputTab('result')
    void controller.execute()
  }
  /** 历史回填不执行 SQL，也不改变上次成功结果的执行快照。 */
  const useHistorySql = (sql: string): void => {
    controller.setDraft(sql)
    editorRef.current?.focus()
  }
  /** Ctrl/Cmd + Enter 只执行当前快照，不因普通换行自动查询。 */
  const handleEditorKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== 'Enter' || (!event.ctrlKey && !event.metaKey) || event.nativeEvent.isComposing) return
    event.preventDefault()
    executeQuery()
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
  const emptyDescription = unavailableReason ?? (projection.status === 'cancelling' ? '正在释放本次查询，完成后可重新执行。' : busy ? '查询完成后，结果会显示在这里。' : projection.error ? '请根据上方提示调整 SQL 后重试。' : '在上方输入 SQL，点击「执行」或使用快捷键。')
  return <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto" data-server-ops-sql-query>
    <section className="m-3 shrink-0 overflow-hidden rounded-xl border border-border/60 bg-content-area" aria-label="SQL 查询编辑区" data-server-ops-sql-editor-region>
      <div className="flex min-w-0 flex-wrap items-center gap-2 border-b border-border/40 bg-muted/20 px-3 py-1.5">
        <label htmlFor={editorId} className="flex items-center gap-1.5 text-xs font-medium"><Code2 className="size-3.5 text-muted-foreground" aria-hidden="true" />SQL 编辑器</label>
        <span className="flex items-center gap-1 rounded-md bg-muted/70 px-1.5 py-0.5 text-[10px] text-muted-foreground"><ShieldCheck className="size-3" aria-hidden="true" />只读 SELECT</span>
        <Popover>
          <PopoverTrigger asChild><Button type="button" variant="ghost" size="sm" className="ml-auto h-7 gap-1 rounded-md px-1.5 text-[11px] text-muted-foreground" aria-label="查询说明"><CircleHelp className="size-3.5" aria-hidden="true" />查询说明</Button></PopoverTrigger>
          <PopoverContent align="end" className="z-[260] w-80 max-w-[calc(100vw-2rem)] space-y-2 text-xs leading-5">
            <h3 className="font-medium">只读查询说明</h3>
            <p className="text-muted-foreground">支持当前库基础表的单条 SELECT、筛选、排序、分组聚合与受控 JOIN，不修改数据库。暂不支持子查询、UNION、视图和跨库查询。</p>
            <p className="text-muted-foreground">每次最多返回 200 行。大字段请明确选择字段，或使用 <code className="break-words font-mono text-foreground">SUBSTRING(字段, 1, 256)</code>。</p>
            <p className="text-muted-foreground">查询结果不会自动刷新，修改 SQL 后需要重新执行。</p>
          </PopoverContent>
        </Popover>
      </div>
      <textarea
        id={editorId}
        ref={editorRef}
        className="block h-32 min-h-24 max-h-64 w-full resize-y bg-transparent px-3 py-2.5 font-mono text-xs leading-6 outline-none transition-colors placeholder:text-muted-foreground/50 focus-visible:bg-muted/10 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/30"
        aria-label="SQL 编辑器"
        spellCheck={false}
        placeholder={'SELECT id, name\nFROM users\nORDER BY id DESC'}
        value={projection.draft}
        onChange={(event) => controller.setDraft(event.target.value)}
        onKeyDown={handleEditorKeyDown}
      />
      <div className="flex min-w-0 flex-wrap items-center gap-2 border-t border-border/40 bg-muted/10 px-3 py-2" data-server-ops-sql-actions>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button type="button" size="sm" aria-label="执行查询" disabled={!projection.canExecute} onClick={executeQuery}>
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
