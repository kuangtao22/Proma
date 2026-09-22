import * as React from 'react'
import { atom, useAtom } from 'jotai'
import { ChevronDown, LoaderCircle, RefreshCw, Search, X } from 'lucide-react'
import type { ServerOpsAgentDatabaseScope, ServerOpsAgentReadResource, ServerOpsDataSource } from '@proma/shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { createServerOpsAgentCatalogController } from './server-ops-agent-catalog-controller'
import type { ServerOpsAgentCatalogApi, ServerOpsAgentCatalogProjection } from './server-ops-agent-catalog-controller'
import { toggleServerOpsExcludedTable } from './server-ops-agent-table-scope'

/** 目录选择器只读取元数据，提交授权仍由上层控制器负责。 */
interface CatalogProps {
  source: ServerOpsDataSource
  api?: ServerOpsAgentCatalogApi
  disabled: boolean
}

/** 缺少旧版本桥接时给出可操作提示，不把接口缺失显示成空库。 */
const UNAVAILABLE_CATALOG: ServerOpsAgentCatalogApi = {
  listServerOpsDataSchemaTables: async () => { throw new Error('请完整重启客户端后加载数据库目录') },
}

/** 按精确连接配置及库隔离目录状态；打开选择器之前不发送请求。 */
function useAgentCatalog({ source, api }: CatalogProps, database?: string) {
  /** 公开配置不含凭据，变化后丢弃旧目录，防止同 ID 复用旧端点结果。 */
  const identity = JSON.stringify(source)
  /** 每个选择器拥有独立 Jotai 状态，新目标第一帧即呈现空态。 */
  const projectionAtom = React.useMemo(() => atom<ServerOpsAgentCatalogProjection>({ status: 'idle', result: null, error: null }), [api, identity, database])
  const [projection, setProjection] = useAtom(projectionAtom)
  /** 控制器负责去重、取消发布及失败重试，组件只处理点击。 */
  const controller = React.useMemo(() => createServerOpsAgentCatalogController({ api: api ?? UNAVAILABLE_CATALOG, publish: setProjection }), [api, setProjection, identity, database])
  React.useEffect(() => {
    controller.activate()
    controller.select(source.id, identity, database)
    return () => controller.dispose()
  }, [controller, source.id, identity, database])
  return { projection, controller }
}

/** 单个连接的数据库禁用表编辑；当前库直接操作，其他已保存范围仍可管理。 */
interface DatabaseExclusionsProps extends CatalogProps {
  resource: Extract<ServerOpsAgentReadResource, { kind: 'mysql' | 'sqlite' }>
  currentDatabase?: string
  onChange: (databases: ServerOpsAgentDatabaseScope[]) => void
}

/** 使用工作台选库作为默认范围，返回仅管理禁用表的编辑区，不重复提供数据库选择器。 */
export function ServerOpsAgentDatabaseExclusions(props: DatabaseExclusionsProps): React.ReactElement {
  /** 当前库优先；项目首页仍能管理已有授权，无需为了编辑禁用项重新打开工作台。 */
  const current = props.resource.databases.find((scope) => scope.database === props.currentDatabase) ?? props.resource.databases[0]
  /** 其他已保存数据库独立展示，编辑当前库不会丢失其禁用项。 */
  const others = props.resource.databases.filter((scope) => scope !== current)
  /** 精确替换单库范围，保留同连接下其他库的禁用项。 */
  const updateScope = (next: ServerOpsAgentDatabaseScope): void => {
    props.onChange(props.resource.databases.map((scope) => scope.database === next.database ? next : scope))
  }
  if (!current) return <p className="text-[11px] text-muted-foreground">请先在该连接的数据库工作台顶部选择数据库，再打开授权设置。</p>
  return (
    <div className="min-w-0 space-y-3">
      <div className="space-y-1.5">
        <ServerOpsAgentTableExclusions
          key={JSON.stringify([props.source, current.database])}
          source={props.source}
          scope={current}
          api={props.api}
          disabled={props.disabled}
          onChange={updateScope}
        />
        <p className="break-all text-[11px] text-muted-foreground">当前数据库：{current.database}</p>
      </div>
      {others.length > 0 ? (
        <details className="border-t border-border/40 pt-2 text-[11px]">
          <summary className="cursor-pointer text-muted-foreground">其他已授权数据库（{others.length}）</summary>
          <div className="mt-2 space-y-3">
            {others.map((scope) => (
              <div key={scope.database} className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="break-all text-muted-foreground">{scope.database}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-6 px-1 text-[10px]"
                    disabled={props.disabled}
                    aria-label={`删除 ${scope.database} 授权`}
                    onClick={() => props.onChange(props.resource.databases.filter((entry) => entry.database !== scope.database))}
                  >
                    移除授权
                  </Button>
                </div>
                <ServerOpsAgentTableExclusions
                  key={JSON.stringify([props.source, scope.database])}
                  source={props.source}
                  scope={scope}
                  api={props.api}
                  disabled={props.disabled}
                  onChange={updateScope}
                />
              </div>
            ))}
          </div>
        </details>
      ) : null}
    </div>
  )
}

/** 禁用表多选只编辑草稿；即使目录读取失败，已有禁用项也保持可见。 */
export function ServerOpsAgentTableExclusions(props: CatalogProps & { scope?: ServerOpsAgentDatabaseScope; onDatabaseChange?: (database: string) => void; onChange: (scope: ServerOpsAgentDatabaseScope) => void }): React.ReactElement {
  /** 展开与搜索仅在当前弹窗内保留，不持久化。 */
  const [openAtom] = React.useState(() => atom(false))
  const [searchAtom] = React.useState(() => atom(''))
  const [truncatedAtom] = React.useState(() => atom(false))
  const [databasesAtom] = React.useState(() => atom<string[]>([]))
  const [open, setOpen] = useAtom(openAtom)
  const [search, setSearch] = useAtom(searchAtom)
  const [catalogTruncated, setCatalogTruncated] = useAtom(truncatedAtom)
  const [databases, setDatabases] = useAtom(databasesAtom)
  /** 用于键盘与辅助技术关联展开内容。 */
  const listId = React.useId()
  const database = props.scope?.database
  const { projection, controller } = useAgentCatalog(props, database)
  /** 目录只在展开后加载，切库会保留展开状态并清理旧库的搜索条件。 */
  React.useEffect(() => { if (open) void controller.load() }, [open, controller])
  React.useEffect(() => { setSearch(''); setCatalogTruncated(false) }, [database, setSearch, setCatalogTruncated])
  /** 保留同连接已读取的可见库名单，切库加载时下拉仍可继续操作。 */
  React.useEffect(() => {
    if (projection.result) setDatabases(projection.result.databases)
  }, [projection.result, setDatabases])
  React.useEffect(() => {
    if (projection.result?.tablesTruncated && projection.tableSearch === undefined) setCatalogTruncated(true)
  }, [projection.result?.tablesTruncated, projection.tableSearch, setCatalogTruncated])
  /** 清空搜索立即恢复普通目录；远端搜索结果不能覆盖已选的禁用草稿。 */
  React.useEffect(() => {
    if (search.trim().length === 0 && projection.tableSearch !== undefined) void controller.load()
  }, [search, projection.tableSearch, controller])
  /** 名称保持完整，仅本地搜索使用大小写折叠。 */
  const excluded = props.scope?.excludedTables ?? []
  /** 与后台一致地识别大小写等价的禁用表。 */
  const excludedKeys = new Set(excluded.map((name) => name.toLowerCase()))
  /** 搜索词与远端查询统一去掉首尾空白，避免粘贴表名后隐藏已命中的结果。 */
  const searchKey = search.trim().toLowerCase()
  const tables = projection.result?.tables.filter((table) => table.name.toLowerCase().includes(searchKey)) ?? []
  /** 读取中允许保留选择，但禁止重复刷新。 */
  const loading = projection.status === 'loading'
  return (
    <div className="space-y-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-8 w-full justify-between bg-background/40 text-xs"
        disabled={props.disabled || !props.api}
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen(!open)}
      >
        <span>选择禁用表{excluded.length > 0 ? ` · 已禁用 ${excluded.length} 张` : ''}</span>
        <ChevronDown className={cn('size-3.5 shrink-0 transition-transform', open && 'rotate-180')} />
      </Button>
      {excluded.length > 0 ? (
        <div className="flex flex-wrap gap-1.5" aria-label={`${database} 已禁用表`}>
          {excluded.map((name) => (
            <span key={name} className="inline-flex max-w-full items-center gap-1 rounded-md border border-border/60 bg-background/40 px-2 py-1 text-[11px]">
              <span className="truncate" title={name}>{name}</span>
              <button
                type="button"
                disabled={props.disabled}
                className="shrink-0 rounded-sm p-0.5 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={`取消禁用 ${database}.${name}`}
                onClick={() => { if (props.scope) props.onChange(toggleServerOpsExcludedTable(props.scope, name)) }}
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
      ) : null}
      {open ? (
        <div id={listId} className="space-y-2 rounded-md border border-border/60 bg-background/30 p-2">
          {props.onDatabaseChange ? <Select value={database ?? ''} onValueChange={props.onDatabaseChange} disabled={props.disabled || databases.length === 0}>
            <SelectTrigger className="h-8 w-full text-xs" aria-label="选择禁用表所属数据库"><SelectValue placeholder="选择数据库" /></SelectTrigger>
            <SelectContent className="z-[280] max-h-56">{databases.map((name) => <SelectItem key={name} value={name}>{name}</SelectItem>)}</SelectContent>
          </Select> : null}
          {database ? <>
            <div className="flex items-center gap-2">
              <Input className="h-8 min-w-0 flex-1 text-xs" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索表名" aria-label={`搜索 ${database} 表名`} />
              <Button type="button" variant="ghost" size="sm" className="h-8 shrink-0 px-2" disabled={props.disabled || loading} aria-label={`刷新 ${database} 表列表`} onClick={() => { void controller.load(true, projection.tableSearch) }}>
                <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
              </Button>
            </div>
            {catalogTruncated && search.trim().length > 0 ? (
              <Button type="button" variant="outline" size="sm" className="h-7 gap-1.5 text-xs" disabled={props.disabled || loading || search.trim().length > 128}
                onClick={() => { void controller.load(false, search.trim()) }}>
                <Search className="size-3.5" />搜索全部表
              </Button>
            ) : null}
          </> : null}
          {loading ? <p role="status" className="flex items-center gap-2 py-2 text-[11px] text-muted-foreground"><LoaderCircle className="size-3.5 animate-spin" />正在读取{database ? '表名' : '数据库'}…</p> : null}
          {projection.error ? <p role="alert" className="text-[11px] text-destructive">{projection.error}，可点击刷新重试；已选范围保持不变。</p> : null}
          {!database && projection.error ? <Button type="button" variant="outline" size="sm" className="h-7 gap-1.5 text-xs" disabled={props.disabled} onClick={() => { void controller.load(true) }}><RefreshCw className="size-3.5" />刷新数据库</Button> : null}
          {!database && projection.status === 'ready' && databases.length === 0 ? <p className="text-[11px] text-muted-foreground">该连接没有可见数据库。</p> : null}
          {database && projection.status === 'ready' ? <>
            <div className="max-h-40 space-y-0.5 overflow-y-auto" role="group" aria-label={`${database} 禁用表多选`}>
              {tables.map((table) => {
                /** 勾选代表禁用；未勾选表默认可查询。 */
                const checked = excludedKeys.has(table.name.toLowerCase())
                return (
                  <label key={table.name} className="flex cursor-pointer items-start gap-2 rounded px-1.5 py-1.5 text-xs hover:bg-muted/60">
                    <input
                      type="checkbox"
                      className="mt-0.5 accent-primary"
                      checked={checked}
                      disabled={props.disabled || (!checked && excluded.length >= 100)}
                      aria-label={`禁止查询 ${database}.${table.name}`}
                      onChange={() => { if (props.scope) props.onChange(toggleServerOpsExcludedTable(props.scope, table.name)) }}
                    />
                    <span className="min-w-0 break-all">{table.name}{table.type === 'view' ? <span className="ml-1.5 text-[10px] text-muted-foreground">视图</span> : null}</span>
                  </label>
                )
              })}
              {tables.length === 0 ? <p className="p-2 text-[11px] text-muted-foreground">{search ? '没有匹配的表名' : '当前数据库没有可见表'}</p> : null}
            </div>
            {projection.result?.tablesTruncated ? <p className="text-[11px] text-muted-foreground">仅显示部分表；输入表名后可搜索全部表。</p> : null}
          </> : null}
          {database ? <p className="text-[10px] leading-4 text-muted-foreground">勾选即禁用，Agent 无法读取这些表；最多禁用 100 张表。</p> : null}
        </div>
      ) : null}
      {!props.api ? <p className="text-[11px] text-muted-foreground">目录接口尚未就绪，请完整重启客户端；已有范围仍会保留。</p> : null}
      <p className="text-[10px] leading-4 text-muted-foreground">{excluded.length ? '除已禁用表外，其余表默认可查询。' : '默认全部表可查询，只需勾选不允许查询的表。'}</p>
    </div>
  )
}
