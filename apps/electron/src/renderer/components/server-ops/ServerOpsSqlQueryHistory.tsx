import * as React from 'react'
import { ArrowUpToLine, History, LoaderCircle, RefreshCw } from 'lucide-react'
import { SERVER_OPS_DATA_QUERY_HISTORY_LIMIT } from '@proma/shared'
import { Button } from '@/components/ui/button'
import type { ServerOpsSqlQueryHistoryProjection } from './server-ops-sql-query-history-controller'

/** 历史纯视图的输入；回填仅更新编辑器，读取与保存重试由控制器处理。 */
export interface ServerOpsSqlQueryHistoryProps {
  projection: ServerOpsSqlQueryHistoryProjection
  onUse: (sql: string) => void
  onRefresh: () => void
}

/** 当前库的本地 SQL 历史列表，与结果表共用输出区且独立滚动。 */
export function ServerOpsSqlQueryHistory({ projection, onUse, onRefresh }: ServerOpsSqlQueryHistoryProps): React.ReactElement {
  /** 列表刷新期间保留原记录，但明确显示读取状态。 */
  const loading = projection.status === 'loading'
  return <section className="flex min-h-40 min-w-0 flex-1 flex-col" aria-label="查询历史语句" data-server-ops-sql-history>
    <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-2 border-b border-border/40 px-4 py-2 text-[11px] text-muted-foreground">
      <p className="min-w-0 flex-1 leading-5">当前数据库 · 最近 {SERVER_OPS_DATA_QUERY_HISTORY_LIMIT} 条 · 相同语句仅保留一条</p>
      <Button type="button" size="sm" variant="ghost" className="h-7 gap-1.5 px-2 text-[11px]" disabled={loading || !projection.context?.database} onClick={onRefresh} aria-label="刷新查询历史">
        {loading ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" /> : <RefreshCw className="size-3.5" aria-hidden="true" />}刷新
      </Button>
    </div>
    {projection.error ? <p role="alert" className="px-4 py-3 text-xs text-destructive">{projection.error}</p> : null}
    {projection.entries.length > 0 ? <ol className="min-h-0 flex-1 divide-y divide-border/40 overflow-y-auto">
      {projection.entries.map((entry) => <li key={entry.id} className="min-w-0 px-4 py-3 transition-colors hover:bg-muted/20">
        <div className="mb-1.5 flex min-w-0 flex-wrap items-center gap-2">
          <time className="mr-auto text-[11px] tabular-nums text-muted-foreground" dateTime={new Date(entry.createdAt).toISOString()}>{new Date(entry.createdAt).toLocaleString('zh-CN', { hour12: false })}</time>
          <Button type="button" variant="ghost" size="sm" className="h-7 gap-1.5 px-2 text-[11px]" onClick={() => onUse(entry.sql)}><ArrowUpToLine className="size-3.5" aria-hidden="true" />填入编辑器</Button>
        </div>
        <pre className="max-h-24 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/30 px-2.5 py-2 font-mono text-xs leading-5" tabIndex={0}><code>{entry.sql}</code></pre>
      </li>)}
    </ol> : <div className="flex min-h-32 flex-1 flex-col items-center justify-center gap-2 px-4 py-6 text-center text-muted-foreground">
      {loading ? <LoaderCircle className="size-5 animate-spin" aria-hidden="true" /> : <History className="size-5" aria-hidden="true" />}
      <p className="text-xs font-medium" role="status">{loading ? '正在读取查询历史' : projection.error ? '查询历史暂不可用' : '暂无查询历史'}</p>
      {!loading && !projection.error ? <p className="text-[11px] leading-5">执行后的 SQL 会自动保存在本机，不保存查询结果。</p> : null}
    </div>}
  </section>
}
