import * as React from 'react'
import { atom, useAtom } from 'jotai'
import { RefreshCw, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ServerOpsDataMetricGrid, ServerOpsDataTable } from './ServerOpsDataServicesPanel'
import { ServerOpsDataReadStatus } from './ServerOpsSchemaBrowserView'
import { cn } from '@/lib/utils'
import { SERVER_OPS_STATUSBAR_CLASS, SERVER_OPS_TABLE_CLASS, SERVER_OPS_TOOLBAR_CLASS } from './server-ops-ui'
import { formatServerOpsDataTlsStatus } from './server-ops-data-display'
import type { ServerOpsDiagnosticPage, ServerOpsDiagnosticsProjection } from './server-ops-diagnostics-controller'

/** 数据库诊断正文属性；导航与日志入口由外层工作台持有。 */
export interface ServerOpsDatabaseDiagnosticsProps {
  projection: ServerOpsDiagnosticsProjection
  page: Exclude<ServerOpsDiagnosticPage, 'logs'>
  scope: 'instance' | 'database'
  onRefresh: () => void
  onSelectDatabase?: (database: string) => void
}

/**
 * 渲染当前诊断页正文。
 *
 * @param props 当前页投影、读取范围与操作回调
 * @returns 不包含页面导航的诊断正文
 */
export function ServerOpsDatabaseDiagnostics({
  projection,
  page,
  scope,
  onRefresh,
  onSelectDatabase,
}: ServerOpsDatabaseDiagnosticsProps): React.ReactElement {
  /** 参数名筛选只在当前有界快照上运行。 */
  const [searchAtom] = React.useState(() => atom(''))
  const [search, setSearch] = useAtom(searchAtom)
  /** 当前类别独立的状态和最近成功快照。 */
  const state = projection.pages[page] ?? { status: 'idle', error: null }
  /** 库级正文没有合法库身份时暂停展示，不能回退或泄露旧库快照。 */
  const waitingForDatabase = scope === 'database' && projection.database === null
  /** 只有范围合法时才允许读取当前页快照。 */
  const result = waitingForDatabase ? undefined : state.result
  /** 参数搜索使用当前合法快照，避免等待选库时保留旧内容。 */
  const parameters = result?.parameters?.filter((entry) => entry.name.toLocaleLowerCase().includes(search.toLocaleLowerCase())) ?? []
  /** 页面说明描述数据来源及边界，不把累计摘要称作原始慢日志。 */
  const description = page === 'statements'
    ? scope === 'database'
      ? '按默认库归属筛选 · 累计 SQL 模板摘要 · 最多 20 条 · 非原始慢日志'
      : '全部数据库（含未归属） · 按默认库归属汇总 · 累计 SQL 模板摘要 · 最多 20 条 · 非原始慢日志'
    : page === 'sessions'
      ? scope === 'database'
        ? '按会话当前库筛选 · 当前账号可见会话 · 最多 50 条'
        : '全部数据库（含未归属） · 当前账号可见会话 · 最多 50 条'
      : page === 'parameters' ? '全局变量 · 只读 · 连接地址和密码在连接设置中'
        : '实例快照 · 可见库容量汇总 · 非完整目录 · 复制状态'
  /** 正文范围由外层导航明确指定，实例级空 database 表示查询全部可见数据。 */
  const scopeLabel = waitingForDatabase ? '等待选择数据库'
    : scope === 'database' ? `数据库 ${projection.database ?? ''}`
      : '实例范围'
  /** 刷新名称与外层声明的范围一致，不再依据页面类型猜测。 */
  const refreshLabel = scope === 'database' ? '刷新当前数据库页面' : '刷新当前实例页面'
  /**
   * 总览库名列提供进入数据浏览的原生按钮，其余列保持普通文本。
   *
   * @param cell 当前单元格文本
   * @param columnId runtime 提供的稳定列 ID
   * @returns 库名导航按钮或原始文本
   */
  const renderDatabaseCell = (cell: string, columnId: string): React.ReactNode => (
    columnId === 'name' && onSelectDatabase
      ? <button
          type="button"
          className="max-w-full truncate text-left text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          aria-label={`浏览数据库 ${cell}`}
          data-server-ops-database-link={cell}
          onClick={() => onSelectDatabase(cell)}
        >{cell}</button>
      : cell
  )

  return <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" style={{ containerType: 'inline-size', containerName: 'db-diagnostics' }}>
    {/* 按诊断面板实际宽度排布：三列保证每张卡约 220px，空间不足时回退两列。 */}
    <style>{`
      [data-server-ops-diagnostic-page] > [data-server-ops-data-metric-grid="true"] { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      @container db-diagnostics (min-width: 720px) {
        [data-server-ops-diagnostic-page] > [data-server-ops-data-metric-grid="true"] { grid-template-columns: repeat(3, minmax(0, 1fr)); }
      }
    `}</style>
    <div className={SERVER_OPS_TOOLBAR_CLASS}>
      <div className="min-w-0 flex-1 break-words text-[11px] leading-relaxed text-muted-foreground" data-server-ops-diagnostic-scope>{scopeLabel} · {description}</div>
      <Button
        size="icon-sm"
        variant="ghost"
        className="shrink-0"
        aria-label={refreshLabel}
        title={refreshLabel}
        disabled={waitingForDatabase || state.status === 'loading'}
        onClick={onRefresh}
      >
        <RefreshCw className={cn('size-3.5', state.status === 'loading' && 'animate-spin')} />
      </Button>
    </div>
    {waitingForDatabase ? (
      <p className="px-4 py-6 text-center text-xs text-muted-foreground">先选择数据库，再查看当前数据库的诊断内容。</p>
    ) : <>
      <ServerOpsDataReadStatus state={state} onRetry={onRefresh} />
      {result?.warnings.length ? <div className="mx-4 mt-2 shrink-0 rounded-lg bg-muted/40 px-3 py-2 text-xs leading-relaxed text-muted-foreground">{result.warnings.map((warning) => <p key={warning}>{warning}</p>)}</div> : null}
      {page === 'parameters' ? <>
        <div className="flex shrink-0 items-center gap-2 px-4 py-3">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 size-3.5 text-muted-foreground" />
            <Input className="h-8 pl-8 text-xs" placeholder="搜索参数名称" aria-label="搜索参数名称" value={search} onChange={(event) => setSearch(event.target.value)} />
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-auto" data-server-ops-parameters>
          <table className={SERVER_OPS_TABLE_CLASS}>
            <thead className="sticky top-0 bg-content-area"><tr><th>参数名称</th><th>当前值</th><th>作用域</th></tr></thead>
            <tbody>{parameters.map((entry) => <tr key={entry.name}><td className="whitespace-nowrap font-mono">{entry.name}</td><td className="max-w-[24rem] break-all font-mono">{entry.value === '' ? <span className="italic text-muted-foreground">空字符串</span> : entry.value}</td><td className="whitespace-nowrap text-muted-foreground">全局</td></tr>)}</tbody>
          </table>
          {state.status === 'ready' && !parameters.length ? <p className="p-6 text-center text-xs text-muted-foreground">{search ? '没有匹配的参数名称' : '没有可见参数'}</p> : null}
        </div>
      </> : <div className={cn('min-h-0 flex-1 overflow-auto', !result?.metrics.length && 'pt-3')} data-server-ops-diagnostic-page={page}>
        {/* 指标网格自带顶部留白；仅有结果表时补齐与说明栏之间的间距。 */}
        {result?.metrics.length ? <ServerOpsDataMetricGrid metrics={result.metrics} /> : null}
        {result?.tables.map((table) => <ServerOpsDataTable
          key={table.id}
          table={page === 'overview' && table.id === 'databases' ? { ...table, title: '数据库容量' }
            : page === 'statements' && table.id === 'statements' ? { ...table, title: '语句分析' }
              : table}
          renderCell={page === 'overview' && scope === 'instance' && table.id === 'databases' ? renderDatabaseCell : undefined}
        />)}
        {state.status === 'ready' && result && !result.metrics.length && !result.tables.length ? <p className="p-6 text-center text-xs text-muted-foreground">当前页面没有可展示的结果</p> : null}
      </div>}
      {state.collectedAt || (page === 'parameters' && result) ? <div className={SERVER_OPS_STATUSBAR_CLASS}>{page === 'parameters' && result ? <span>{parameters.length} / {result.parameters?.length ?? 0} 个参数{result.parametersTruncated ? ' · 结果已按上限截断' : ''}</span> : null}{formatServerOpsDataTlsStatus(result?.tlsStatus) ? <span>{formatServerOpsDataTlsStatus(result?.tlsStatus)}</span> : null}{state.collectedAt ? <span>采样时间 {new Date(state.collectedAt).toLocaleString('zh-CN')} · 手动刷新</span> : null}</div> : null}
    </>}
  </div>
}
