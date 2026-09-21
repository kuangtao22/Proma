import * as React from 'react'
import { atom, useAtom } from 'jotai'
import { ChevronDown, ChevronLeft, ChevronRight, Columns3, Database, KeyRound, ListTree, ListFilter, RefreshCw, Search, Table2 } from 'lucide-react'
import type { ServerOpsDataRowFilters, ServerOpsDataSchemaCell, ServerOpsDataSchemaTableSummary } from '@proma/shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'
import { SERVER_OPS_STATUSBAR_CLASS, SERVER_OPS_TABLE_CLASS, SERVER_OPS_TAB_CLASS, SERVER_OPS_TOOLBAR_CLASS } from './server-ops-ui'
import type { ServerOpsSchemaBrowserProjection, ServerOpsSchemaDetailTab, ServerOpsSchemaLoadState } from './server-ops-schema-controller'
import { ServerOpsRowFilterPanel } from './ServerOpsRowFilterPanel'

/** 字节数展示；未知与零容量分开。 */
export function formatServerOpsSchemaBytes(value: number | undefined): string {
  if (value === undefined) return '未知'
  if (value < 1024) return `${value} B`
  /** 以 1024 进位，避免夸大实际容量。 */
  const units = ['KiB', 'MiB', 'GiB', 'TiB']
  let size = value / 1024
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1 }
  return `${size >= 100 ? Math.round(size) : size.toFixed(1)} ${units[unit]}`
}

/** 行数只作为估算显示。 */
export function formatServerOpsSchemaCount(value: number | undefined): string {
  return value === undefined ? '未知' : value.toLocaleString('en-US')
}

/** 将单元格类型转成可访问文本，不把 SQL NULL 伪装成空字符串。 */
export function formatServerOpsSchemaCell(cell: ServerOpsDataSchemaCell): string {
  if (cell === null) return 'NULL'
  if (cell === '') return '空字符串'
  if (typeof cell === 'string') return cell
  if (cell.kind === 'binary') return `二进制 · ${cell.bytes} B`
  return `${cell.text}…（已截断）`
}

/** 表视图由投影和显式动作驱动，目录刷新不重置表。 */
export interface ServerOpsSchemaBrowserViewProps {
  projection: ServerOpsSchemaBrowserProjection
  onSelectDatabase: (database: string) => void
  onOpenTable: (table: string) => void
  onBackToList: () => void
  onDetailTabChange: (tab: ServerOpsSchemaDetailTab) => void
  onLoadRows: (offset: number) => void
  onApplyRowFilters?: (filters: ServerOpsDataRowFilters | null) => void
  onLoadFilterFields?: () => void
  onRefresh: () => void
  onRefreshTables?: () => void
  directoryWidth?: number
  onDirectoryWidthChange?: (width: number) => void
  /** 工作台库级工具栏统一选库，独立表浏览仍保留自己的入口。 */
  showDatabaseSelector?: boolean
}

/** 错误/刷新提示限制在当前区域；保留正文时明确提示旧数据。 */
export function ServerOpsDataReadStatus({ state, onRetry }: { state: ServerOpsSchemaLoadState; onRetry: () => void }): React.ReactElement | null {
  if (state.status === 'loading') return <div role="status" className="flex shrink-0 items-center gap-2 px-4 py-2 text-xs text-muted-foreground"><RefreshCw className="size-3 animate-spin" />正在读取…{state.collectedAt ? '（保留上次结果）' : ''}</div>
  if (state.status !== 'error') return null
  return <div role="alert" className="mx-3 my-2 flex shrink-0 items-center gap-2 rounded-lg bg-destructive/5 px-3 py-2 text-xs"><span className="min-w-0 flex-1 break-words text-destructive">{state.error ?? '读取失败'}{state.collectedAt ? ' · 当前显示上次成功结果' : ''}</span><Button size="sm" variant="outline" onClick={onRetry}>重试</Button></div>
}

/** 库级工具栏复用目录投影；compact 仅收紧工作台嵌入形态，独立表浏览保持默认布局。 */
export function ServerOpsDatabaseSelector({ projection, onSelectDatabase, onRefresh, children, compact = false }: {
  projection: ServerOpsSchemaBrowserProjection
  onSelectDatabase: (database: string) => void
  onRefresh: () => void
  children?: React.ReactNode
  compact?: boolean
}): React.ReactElement {
  /** 选库控件在两种容器中共用，不复制任何请求或错误逻辑。 */
  const controls = <>
      {compact ? null : <Database className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />}
      <Select value={projection.database ?? ''} onValueChange={onSelectDatabase}>
        <SelectTrigger className={cn(compact ? 'h-8 min-w-0 max-w-56 flex-1 gap-2 px-2.5 py-0 text-xs [&>svg]:shrink-0' : 'h-8 min-w-32 max-w-xs flex-1 basis-40 text-xs')} aria-label="选择数据库" title={projection.database ?? undefined}>
          {compact ? <Database className="size-3.5 text-muted-foreground" aria-hidden="true" /> : null}
          {/* 库名可收缩并省略，避免长名称挤出下拉箭头和刷新按钮。 */}
          <span className="min-w-0 flex-1 truncate text-left"><SelectValue placeholder={projection.status === 'loading' && !projection.databases.length ? '正在读取数据库…' : '选择数据库'} /></span>
        </SelectTrigger>
        <SelectContent className="z-[240]"><div className="max-h-72 overflow-y-auto">{projection.databases.map((database) => <SelectItem key={database} value={database}>{database}</SelectItem>)}</div></SelectContent>
      </Select>
      <Button size="icon-sm" variant="ghost" className={compact ? 'size-8 shrink-0 rounded-md text-muted-foreground focus-visible:ring-2 [&_svg]:size-3.5' : undefined} aria-label="刷新数据库目录" title="刷新数据库目录" disabled={projection.status === 'loading'} onClick={onRefresh}><RefreshCw className="size-3.5" aria-hidden="true" /></Button>
      {children}
  </>
  /** 目录状态仍紧跟选库器，不因嵌入顶层导航而丢失错误与刷新入口。 */
  const status = <>
    {projection.databasesTruncated ? <div className={cn('shrink-0 py-1 text-[11px] text-muted-foreground', compact ? 'px-0' : 'px-4')}>可见数据库目录已按上限截断</div> : null}
    <ServerOpsDataReadStatus state={projection} onRetry={onRefresh} />
  </>
  if (compact) return <div className="flex min-w-0 flex-[1_1_14rem] flex-col" data-server-ops-database-selector data-server-ops-database-selector-compact="true"><div className="flex min-w-0 items-center gap-2">{controls}</div>{status}</div>
  return <><div className={SERVER_OPS_TOOLBAR_CLASS} data-server-ops-database-selector>{controls}</div>{status}</>
}

/** 持续表目录与右侧表工作区；窄面板目录通过局部 Dialog 覆盖。 */
export function ServerOpsSchemaBrowserView({
  projection, onSelectDatabase, onOpenTable, onDetailTabChange, onLoadRows, onRefresh,
  onRefreshTables = onRefresh, onApplyRowFilters, onLoadFilterFields,
  directoryWidth = 190, onDirectoryWidthChange, showDatabaseSelector = true,
}: ServerOpsSchemaBrowserViewProps): React.ReactElement {
  /** 临时界面状态不持久化业务内容。 */
  const [uiAtom] = React.useState(() => atom({ search: '', directoryOpen: false, filterOpen: false }))
  const [ui, setUi] = useAtom(uiAtom)
  /** 覆盖目录限制在发起工作区。 */
  const containerRef = React.useRef<HTMLDivElement>(null)
  /** 手势起点不触发 React 更新。 */
  const resizeRef = React.useRef<{ x: number; width: number } | null>(null)
  React.useEffect(() => { setUi({ search: '', directoryOpen: false, filterOpen: false }) }, [projection.sourceId, projection.database, setUi])
  React.useEffect(() => { setUi((previous) => ({ ...previous, filterOpen: false })) }, [projection.selectedTable, setUi])
  /** 首次展开才取字段；目录刷新结束后补取，避免与后端缓存失效竞态。 */
  React.useEffect(() => {
    if (ui.filterOpen && projection.detailTab === 'data' && projection.status === 'ready' && projection.structure.status === 'idle') onLoadFilterFields?.()
  }, [ui.filterOpen, projection.detailTab, projection.status, projection.structure.status, onLoadFilterFields])
  /** 每个工作区的无障碍关联独立，避免并排打开相同表时重复 ID。 */
  const filterPanelId = React.useId()
  /** 搜索只筛选已加载目录，不额外访问数据库。 */
  const filtered = React.useMemo(() => {
    const query = ui.search.toLocaleLowerCase()
    return projection.tables.filter((table) => table.name.toLocaleLowerCase().includes(query))
  }, [projection.tables, ui.search])
  /** 属性复用同一份目录元数据。 */
  const selectedSummary = React.useMemo(() => projection.tables.find((table) => table.name === projection.selectedTable), [projection.tables, projection.selectedTable])
  /** 选择后关闭覆盖层，Radix 恢复触发器焦点。 */
  const selectTable = React.useCallback((table: string): void => { onOpenTable(table); setUi((previous) => ({ ...previous, directoryOpen: false })) }, [onOpenTable, setUi])
  /** 目录条目仅随清单、选中表或点击动作变化，筛选面板和行状态不重建整份列表。 */
  const directoryEntries = React.useMemo(() => filtered.map((table) => <li key={table.name}>
    <button type="button" className={cn('flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-2 text-left text-xs transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40', projection.selectedTable === table.name && 'bg-accent/70 font-medium text-accent-foreground')} aria-current={projection.selectedTable === table.name ? 'true' : undefined} data-server-ops-schema-table={table.name} onClick={() => selectTable(table.name)} title={`${table.engine ?? '未知引擎'} · 约 ${formatServerOpsSchemaCount(table.rows)} 行 · ${formatServerOpsSchemaBytes(table.sizeBytes)}`}>
      {table.type === 'view' ? <Columns3 className="size-3.5 shrink-0 text-muted-foreground" /> : <Table2 className="size-3.5 shrink-0 text-muted-foreground" />}<span className="min-w-0 flex-1 truncate">{table.name}</span>
    </button>
  </li>), [filtered, projection.selectedTable, selectTable])
  /** 限制目录宽度，保障右侧最小可读空间。 */
  const resize = (width: number): void => onDirectoryWidthChange?.(Math.min(240, Math.max(160, width)))
  /** 宽窄模式复用的目录内容。 */
  const directory = (
    <div className="flex h-full min-h-0 flex-col bg-muted/10" data-server-ops-schema-directory>
      <div className="flex min-h-11 shrink-0 items-center gap-1.5 px-2 py-2">
        <div className="relative min-w-0 flex-1"><Search className="pointer-events-none absolute left-2 top-2 size-3 text-muted-foreground" /><Input className="h-7 pl-6 text-xs" aria-label="搜索表名" placeholder="搜索表名" value={ui.search} onChange={(event) => setUi((previous) => ({ ...previous, search: event.target.value }))} /></div>
        <Button size="icon-sm" variant="ghost" aria-label="刷新表清单" disabled={projection.status === 'loading'} onClick={onRefreshTables}><RefreshCw className="size-3" /></Button>
      </div>
      <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 py-1" data-server-ops-schema-table-list aria-label="表目录">
        {directoryEntries}
        {filtered.length === 0 ? <li className="px-3 py-6 text-center text-xs text-muted-foreground">{projection.database === null ? '先选择数据库' : projection.status === 'loading' ? '正在读取表目录…' : ui.search ? '已加载目录中无匹配表' : projection.status === 'error' ? '目录读取失败，可重试' : '该库下没有可见的表'}</li> : null}
      </ul>
      <div className={SERVER_OPS_STATUSBAR_CLASS}>{ui.search ? `${filtered.length} / ` : ''}{projection.tablesTruncated ? '已加载 ' : ''}{projection.tables.length} 张表{projection.tablesTruncated ? ' · 目录已截断' : ''}</div>
    </div>
  )
  /** 选库上移后，窄面板仍需可独立打开表目录。 */
  const directoryToggle = <Dialog open={ui.directoryOpen} onOpenChange={(directoryOpen) => setUi((previous) => ({ ...previous, directoryOpen }))}>
    <DialogTrigger asChild><Button className="db-directory-trigger shrink-0" variant="outline" size="sm" aria-label="打开表目录"><ListTree className="size-3.5" />表目录</Button></DialogTrigger>
    <DialogContent container={containerRef.current} className="absolute inset-0 z-[230] flex h-full max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none p-0" overlayClassName="absolute inset-0 z-[220]">
      <DialogTitle className="shrink-0 border-b border-border/40 px-4 py-4 text-sm">{projection.database ?? '数据库'} · 表目录</DialogTitle><DialogDescription className="sr-only">搜索并选择一张表后查看数据。</DialogDescription>{directory}
    </DialogContent>
  </Dialog>
  if (projection.engine === 'redis') return <div className="p-4 text-xs text-muted-foreground" data-server-ops-schema-unsupported>Redis 使用 INFO、Keyspace 和 SLOWLOG，不提供关系表浏览。</div>
  return (
    <div ref={containerRef} className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" style={{ containerType: 'inline-size', containerName: 'db-browser', '--directory-width': `${directoryWidth}px` } as React.CSSProperties} data-server-ops-schema-browser={projection.database ?? 'none'}>
      <style>{'.db-table-directory,.db-directory-resize{display:none}.db-browser-body{display:flex}@container db-browser (min-width:720px){.db-table-directory,.db-directory-resize{display:block}.db-directory-trigger,.db-directory-toolbar{display:none}.db-browser-body{display:grid;grid-template-columns:var(--directory-width) 4px minmax(0,1fr)}}'}</style>
      {showDatabaseSelector ? <ServerOpsDatabaseSelector projection={projection} onSelectDatabase={onSelectDatabase} onRefresh={onRefreshTables}>{directoryToggle}</ServerOpsDatabaseSelector>
        : <div className={cn(SERVER_OPS_TOOLBAR_CLASS, 'db-directory-toolbar')}>{directoryToggle}<span className="min-w-0 truncate text-xs text-muted-foreground">{projection.database ?? '先选择数据库'}</span></div>}
      <div className="db-browser-body min-h-0 min-w-0 flex-1 overflow-hidden">
        <aside className="db-table-directory min-h-0 overflow-hidden">{directory}</aside>
        <div className="db-directory-resize cursor-col-resize touch-none bg-border/30 hover:bg-primary/30 focus-visible:bg-primary/30" role="separator" tabIndex={0} aria-label="表目录宽度" aria-orientation="vertical" aria-valuemin={160} aria-valuemax={240} aria-valuenow={directoryWidth}
          onKeyDown={(event) => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); resize(directoryWidth + (event.key === 'ArrowLeft' ? -10 : 10)) } }}
          onPointerDown={(event) => { resizeRef.current = { x: event.clientX, width: directoryWidth }; event.currentTarget.setPointerCapture(event.pointerId) }}
          onPointerMove={(event) => { if (resizeRef.current) resize(resizeRef.current.width + event.clientX - resizeRef.current.x) }}
          onPointerUp={(event) => { resizeRef.current = null; event.currentTarget.releasePointerCapture(event.pointerId) }} onLostPointerCapture={() => { resizeRef.current = null }} />
        {projection.selectedTable === null ? <div className="flex min-w-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-muted-foreground"><div className="rounded-xl bg-muted/50 p-3"><Table2 className="size-6" /></div><p className="text-sm font-medium text-foreground">{projection.database === null ? '选择数据库开始浏览' : '从表目录选择一张表'}</p><p className="text-xs">数据、结构、索引和属性会显示在这里</p></div> : (
          <Tabs className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" value={projection.detailTab} onValueChange={(tab) => onDetailTabChange(tab as ServerOpsSchemaDetailTab)} data-server-ops-schema-table-detail={projection.selectedTable}>
            <div className={SERVER_OPS_TOOLBAR_CLASS}>
              <div className="flex min-w-[7rem] flex-1 items-center gap-2"><Table2 className="size-3.5 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1 truncate text-xs font-medium" title={`${projection.database}.${projection.selectedTable}`}>{projection.selectedTable}</span><span className="text-[10px] text-muted-foreground">只读</span></div>
              {/* 筛选入口复用相邻页签的尺寸、圆角和状态底色，保持同一行控件一致。 */}
              {projection.detailTab === 'data' && onApplyRowFilters && onLoadFilterFields ? <Button type="button" size="sm" variant="ghost" className={cn(SERVER_OPS_TAB_CLASS, 'py-1 active:scale-100 [&_svg]:size-3.5')} data-state={ui.filterOpen || projection.rowFilters !== null ? 'active' : 'inactive'} aria-expanded={ui.filterOpen} aria-controls={filterPanelId} onClick={() => setUi((previous) => ({ ...previous, filterOpen: !previous.filterOpen }))}><ListFilter className="size-3.5" />筛选{projection.rowFilters ? <span className="rounded bg-primary/10 px-1 text-[10px] tabular-nums text-primary">{projection.rowFilters.conditions.length}</span> : null}<ChevronDown className={cn('size-3 transition-transform', ui.filterOpen && 'rotate-180')} /></Button> : null}
              <TabsList className="h-8 shrink-0 justify-start gap-0.5 bg-transparent p-0" aria-label="表详情分区">{([['data', '数据'], ['structure', '结构'], ['indexes', '索引'], ['properties', '属性']] as const).map(([id, label]) => <TabsTrigger key={id} value={id} className={SERVER_OPS_TAB_CLASS} data-server-ops-schema-detail-tab={id}>{label}</TabsTrigger>)}</TabsList>
              <Button size="icon-sm" variant="ghost" className="ml-auto" aria-label="刷新当前表页面" onClick={onRefresh}><RefreshCw className="size-3.5" /></Button>
            </div>
            <TabsContent value="data" className="m-0 flex min-h-0 flex-1 flex-col overflow-hidden data-[state=inactive]:hidden">
              {onApplyRowFilters && onLoadFilterFields ? <div id={filterPanelId} className="shrink-0"><ServerOpsRowFilterPanel key={JSON.stringify([projection.sourceId, projection.database, projection.selectedTable])} open={ui.filterOpen} columns={projection.structure.columns} structureStatus={projection.structure.status} structureError={projection.structure.error} appliedFilters={projection.rowFilters} busy={projection.rows.status === 'loading'} onApply={onApplyRowFilters} onRetryFields={onLoadFilterFields} /></div> : null}
              <SchemaRowsPanel state={projection.rows} filtered={projection.rowFilters !== null} onLoadRows={onLoadRows} onRetry={onRefresh} />
            </TabsContent>
            <TabsContent value="structure" className="m-0 flex min-h-0 flex-1 flex-col overflow-hidden data-[state=inactive]:hidden"><SchemaStructurePanel state={projection.structure} onRetry={onRefresh} /></TabsContent>
            <TabsContent value="indexes" className="m-0 flex min-h-0 flex-1 flex-col overflow-hidden data-[state=inactive]:hidden"><SchemaIndexesPanel state={projection.structure} onRetry={onRefresh} /></TabsContent>
            <TabsContent value="properties" className="m-0 min-h-0 flex-1 overflow-auto"><SchemaPropertiesPanel table={selectedSummary} /></TabsContent>
          </Tabs>
        )}
      </div>
    </div>
  )
}

/** 统一固定表头和数据网格尺寸，让滚动留在内容区。 */
const gridClass = cn(SERVER_OPS_TABLE_CLASS, 'whitespace-nowrap [&_th]:sticky [&_th]:top-0 [&_th]:z-10 [&_th]:border-b [&_th]:border-border/40 [&_th]:bg-content-area')

/** 只依赖行快照的表格；外层加载态、筛选展开和分页按钮更新不会重做单元格格式化。 */
export const SchemaRowsGrid = React.memo(function SchemaRowsGrid({ columns, rows, offset }: Pick<ServerOpsSchemaBrowserProjection['rows'], 'columns' | 'rows' | 'offset'>): React.ReactElement {
  return <table className={gridClass}><thead><tr>{columns.map((column) => <th key={column} scope="col">{column}</th>)}</tr></thead><tbody>{rows.map((row, rowIndex) => <tr key={`${offset + rowIndex}`}>{row.map((cell, cellIndex) => {
    /** 同一格的 title 与正文共享展示文本，不重复格式化。 */
    const text = formatServerOpsSchemaCell(cell)
    return <td key={cellIndex} className={cn('max-w-[20rem] truncate font-mono', typeof cell === 'string' && /^-?\d+(\.\d+)?$/u.test(cell) && 'text-right tabular-nums', (cell === null || cell === '' || typeof cell === 'object') && 'text-muted-foreground italic')} title={text}>{text}</td>
  })}</tr>)}</tbody></table>
})

/** 字段页只显示字段，不将索引堆进同一页面。 */
function SchemaStructurePanel({ state, onRetry }: { state: ServerOpsSchemaBrowserProjection['structure']; onRetry: () => void }): React.ReactElement {
  return <><ServerOpsDataReadStatus state={state} onRetry={onRetry} /><div className="min-h-0 flex-1 overflow-auto" data-server-ops-schema-structure><table className={gridClass}><thead><tr>{['字段名', '类型', '可空', '默认值', '额外属性', '注释'].map((label) => <th key={label}>{label}</th>)}</tr></thead><tbody>{state.columns.map((column) => <tr key={column.name} data-server-ops-schema-column={column.name}><td><span className="flex items-center gap-1.5">{column.primaryKey ? <KeyRound className="size-3 text-amber-600" aria-label="主键" /> : null}{column.name}</span></td><td className="font-mono">{column.type}</td><td>{column.nullable ? '是' : '否'}</td><td>{column.defaultText === '' ? <span className="text-muted-foreground">空字符串</span> : column.defaultText ?? '未指定 / NULL'}</td><td>{column.extra || '—'}</td><td>{column.comment || '—'}</td></tr>)}</tbody></table></div></>
}

/** 索引页复用 describe 结果，无额外请求。 */
function SchemaIndexesPanel({ state, onRetry }: { state: ServerOpsSchemaBrowserProjection['structure']; onRetry: () => void }): React.ReactElement {
  return <><ServerOpsDataReadStatus state={state} onRetry={onRetry} /><div className="min-h-0 flex-1 overflow-auto"><table className={gridClass}><thead><tr><th>索引名称</th><th>唯一</th><th>字段（按顺序）</th></tr></thead><tbody>{state.indexes.map((index) => <tr key={index.name} data-server-ops-schema-index={index.name}><td>{index.name}</td><td>{index.unique ? '是' : '否'}</td><td>{index.columns.join(' → ')}</td></tr>)}</tbody></table>{state.status === 'ready' && !state.indexes.length ? <p className="p-6 text-center text-xs text-muted-foreground">这张表没有索引</p> : null}</div></>
}

/** 属性复用当前目录，未知值保持未知。 */
function SchemaPropertiesPanel({ table }: { table: ServerOpsDataSchemaTableSummary | undefined }): React.ReactElement {
  /** 按对象归属展示元数据，不触发额外查询。 */
  const entries = [ ['名称', table?.name ?? '未知'], ['对象类型', table?.type === 'view' ? '视图' : table?.type === 'table' ? '表' : '未知'], ['引擎', table?.engine ?? '未知'], ['估算行数', table?.rows === undefined ? '未知' : `约 ${formatServerOpsSchemaCount(table.rows)} 行`], ['容量', formatServerOpsSchemaBytes(table?.sizeBytes)], ['更新时间', table?.updatedAt === undefined ? '未知' : new Date(table.updatedAt).toLocaleString('zh-CN')], ['注释', table?.comment || '无'] ]
  return <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-4 p-4 text-xs" data-server-ops-schema-properties>{entries.map(([label, value]) => <React.Fragment key={label}><dt className="text-muted-foreground">{label}</dt><dd className="break-words">{value}</dd></React.Fragment>)}</dl>
}

/** 只读分页网格，空表也保留真实字段头。 */
function SchemaRowsPanel({ state, filtered, onLoadRows, onRetry }: { state: ServerOpsSchemaBrowserProjection['rows']; filtered: boolean; onLoadRows: (offset: number) => void; onRetry: () => void }): React.ReactElement {
  /** 在途请求与偏移上限共同限制分页操作。 */
  const busy = state.status === 'loading'
  const hasMore = state.hasMore ?? state.rows.length >= state.limit
  return <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" data-server-ops-schema-rows>
    <ServerOpsDataReadStatus state={state} onRetry={onRetry} />
    <div className="min-h-0 min-w-0 flex-1 overflow-auto"><SchemaRowsGrid columns={state.columns} rows={state.rows} offset={state.offset} />{state.status === 'ready' && !state.rows.length ? <div className="p-8 text-center text-xs text-muted-foreground">{filtered ? '没有符合筛选条件的记录' : '暂无记录'}</div> : null}</div>
    {state.orderedByPrimaryKey === false ? <p className="shrink-0 bg-muted/30 px-4 py-1.5 text-[11px] text-muted-foreground">无主键，分页顺序可能变化</p> : null}
    {state.truncated ? <p className="shrink-0 bg-muted/30 px-4 py-1.5 text-[11px] text-muted-foreground">已按列数、文本或结果大小上限截断</p> : null}
    <div className={SERVER_OPS_STATUSBAR_CLASS}><span className="min-w-0 flex-1 tabular-nums">{filtered ? '筛选结果 · ' : ''}{state.rows.length ? `第 ${state.offset + 1}–${state.offset + state.rows.length} 行` : '0 行'}{filtered || state.totalEstimate === undefined ? '' : ` / 约 ${formatServerOpsSchemaCount(state.totalEstimate)} 行`}</span><span>{state.limit} 行/页</span><Button size="icon-sm" variant="ghost" aria-label="上一页" disabled={busy || state.offset === 0} onClick={() => onLoadRows(Math.max(0, state.offset - state.limit))}><ChevronLeft className="size-3.5" /></Button><Button size="icon-sm" variant="ghost" aria-label="下一页" disabled={busy || !hasMore || state.offset + state.limit > 1_000_000} onClick={() => onLoadRows(state.offset + state.limit)}><ChevronRight className="size-3.5" /></Button></div>
  </div>
}
