import * as React from 'react'
import { LoaderCircle, ShieldCheck } from 'lucide-react'
import { serverOpsReadResourceKey } from '@proma/shared'
import type { ServerOpsAgentReadResource, ServerOpsDataSource, ServerOpsProject } from '@proma/shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { ServerOpsConnection } from './server-ops-connections'
import { createServerOpsAgentReadController, emptyServerOpsAgentReadProjection } from './server-ops-agent-read-controller'
import type { ServerOpsAgentReadAccessApi } from './server-ops-agent-read-controller'

/** SQL 查询权限使用独立文案，明确它不突破当前库表白名单。 */
export const SERVER_OPS_AGENT_QUERY_PERMISSION_LABEL = '允许只读 SQL 查询（仍限制在上述库表范围）'

/** 行读取是 SQL 查询的前置权限；关闭时必须同步撤销查询权限。 */
export function updateServerOpsAgentScopeReadRows<T extends { readRows: boolean; query?: boolean }>(scope: T, readRows: boolean): T {
  return { ...scope, readRows, ...(readRows ? {} : { query: false }) }
}

/** 授权编辑器只接收公开连接目录，不接触密码或隐式项目权限。 */
export interface ServerOpsAgentReadAccessProps {
  sessionId: string | null
  projectId: string
  projects: readonly ServerOpsProject[]
  connections: readonly ServerOpsConnection[]
  allConnections: readonly ServerOpsConnection[]
  dataSources: readonly ServerOpsDataSource[]
  api?: ServerOpsAgentReadAccessApi
  unavailableReason?: string
}

/** 旧 preload 没有新接口时禁用入口，不使工作区崩溃。 */
const UNAVAILABLE_API: ServerOpsAgentReadAccessApi = { get: async () => null, set: async () => { throw new Error('只读授权接口尚未就绪，请更新客户端') } }

/** 项目工具栏入口与当前 Agent 的多资源只读授权编辑器。 */
export function ServerOpsAgentReadAccess({ sessionId, projectId, projects, connections, allConnections, dataSources, api, unavailableReason }: ServerOpsAgentReadAccessProps): React.ReactElement {
  /** 权威数量与编辑草稿由实际使用的控制器分开维护。 */
  const [projection, setProjection] = React.useState(emptyServerOpsAgentReadProjection)
  /** 保留正在输入的尾随换行，表数组则单独归一化。 */
  const [tableDrafts, setTableDrafts] = React.useState<Record<string, string>>({})
  /** 每个连接待添加的库名，必须由用户明确输入。 */
  const [databaseDrafts, setDatabaseDrafts] = React.useState<Record<string, string>>({})
  /** 只有桥接引用变化才重建控制器，不在普通渲染时重新请求。 */
  const controller = React.useMemo(() => createServerOpsAgentReadController({ api: api ?? UNAVAILABLE_API, publish: setProjection }), [api])
  /** 接口未就绪时使用空目标。 */
  const targetSession = api ? sessionId : null
  /** 同步门禁早于 effect，切会话当帧不展示旧授权。 */
  const view = projection.sessionId === targetSession && projection.projectId === projectId ? projection : emptyServerOpsAgentReadProjection()
  /** 受控弹窗关闭后恢复真实按钮焦点。 */
  const triggerRef = React.useRef<HTMLButtonElement>(null)
  React.useEffect(() => {
    controller.activate()
    const unsubscribe = api?.onChanged?.((event) => { controller.changed(event); setTableDrafts({}); setDatabaseDrafts({}) })
    return () => { unsubscribe?.(); controller.dispose() }
  }, [api, controller])
  React.useEffect(() => {
    setTableDrafts({}); setDatabaseDrafts({})
    void controller.select(targetSession, projectId)
  }, [controller, targetSession, projectId])

  /** 只替换精确数据源的权限，其它项目的已有范围保持原样。 */
  const updateMysql = (sourceId: string, patch: Partial<Extract<ServerOpsAgentReadResource, { kind: 'mysql' }>>): void => {
    controller.edit(view.resources.map((resource) => resource.kind === 'mysql' && resource.sourceId === sourceId ? { ...resource, ...patch } : resource))
  }
  /** 勾选只添加最小权限；MySQL 还需明确实例或库才能保存。 */
  const toggleResource = (connection: ServerOpsConnection): void => {
    if (view.resources.some((resource) => serverOpsReadResourceKey(resource) === connection.id)) {
      controller.edit(view.resources.filter((resource) => serverOpsReadResourceKey(resource) !== connection.id)); return
    }
    if (connection.kind === 'ssh' && connection.hostId) {
      controller.edit([...view.resources, { kind: 'ssh', hostId: connection.hostId }]); return
    }
    const source = dataSources.find((entry) => entry.id === connection.sourceId)
    if (!source) return
    controller.edit([...view.resources, source.engine === 'redis' ? { kind: 'redis', sourceId: source.id } : { kind: 'mysql', sourceId: source.id, instance: false, databases: [] }])
  }
  /** 当前项目可新选连接；其它项目只展示已授权资源。 */
  const managed = allConnections.filter((connection) => connection.projectId === projectId || view.resources.some((resource) => serverOpsReadResourceKey(resource) === connection.id))
  /** 目录消失的残留条目仍允许撤销，不隐藏在用户视野之外。 */
  const missing = view.resources.filter((resource) => !allConnections.some((connection) => connection.id === serverOpsReadResourceKey(resource)))
  /** 在途提交锁定编辑，避免提交内容与当前勾选不一致。 */
  const busy = view.loading || view.saving
  return <>
    <Button ref={triggerRef} type="button" variant="outline" size="sm" className="gap-1.5 rounded-lg bg-content-area text-[13px] text-foreground/80" aria-label="授权给当前 Agent"
      title={unavailableReason ?? (!api ? '请更新客户端以使用只读授权' : '管理当前 Agent 的只读运维范围')}
      disabled={!targetSession || view.loading} onClick={() => { setTableDrafts({}); setDatabaseDrafts({}); controller.open() }}>
      {view.loading ? <LoaderCircle className="size-3.5 animate-spin" /> : <ShieldCheck className="size-3.5" />}
      {view.access ? `只读授权 ${view.access.resources.length}` : '授权给当前 Agent'}
    </Button>
    {!targetSession ? <span className="sr-only">{unavailableReason ?? '无普通 Agent 会话'}</span> : null}
    <Dialog open={view.open} onOpenChange={(open) => { if (!open) controller.close() }}>
      <DialogContent className="z-[260] flex max-h-[90vh] w-[calc(100%-2rem)] max-w-2xl flex-col gap-3 overflow-hidden" overlayClassName="z-[250]" hideClose={view.saving}
        onCloseAutoFocus={(event) => { event.preventDefault(); triggerRef.current?.focus() }}
        onEscapeKeyDown={(event) => { event.stopPropagation(); if (view.saving) event.preventDefault() }}>
        <DialogHeader><DialogTitle>Agent 只读授权</DialogTitle><DialogDescription>选择当前会话可读取的连接。保存会替换原有服务器操作授权，不开放远程命令或文件修改。</DialogDescription></DialogHeader>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
          {managed.map((connection) => {
            /** 稳定 ID 保证改名和移动不会改变已选能力。 */
            const selected = view.resources.find((resource) => serverOpsReadResourceKey(resource) === connection.id)
            /** 数据库连接选中后才显示权限编辑。 */
            const mysql = selected?.kind === 'mysql' ? selected : undefined
            /** 明确新增库名；重复添加不覆盖该库已有表范围。 */
            const addDatabase = (): void => {
              const database = databaseDrafts[connection.id]?.trim()
              if (!mysql || !database || mysql.databases.some((scope) => scope.database === database)) return
              updateMysql(mysql.sourceId, { databases: [...mysql.databases, { database, tables: null, readRows: false }] })
              setDatabaseDrafts((drafts) => ({ ...drafts, [connection.id]: '' }))
            }
            return <div key={connection.id} className="min-w-0 space-y-2 rounded-md border border-border/60 p-3">
              <label className="flex min-w-0 items-start gap-2 text-xs font-medium">
                <input type="checkbox" className="mt-0.5 accent-primary" disabled={busy} checked={Boolean(selected)} onChange={() => toggleResource(connection)} aria-label={`授权连接 ${connection.label}`} />
                <span className="min-w-0 flex-1"><span className="block break-words">{connection.label}</span><span className="mt-0.5 block break-all text-[10px] font-normal text-muted-foreground">{connection.detail}</span></span>
                <span className="max-w-24 break-words text-[10px] font-normal text-muted-foreground">{connection.projectId === projectId ? '当前项目' : projects.find((project) => project.id === connection.projectId)?.name ?? '其他项目'}</span>
              </label>
              {selected?.kind === 'ssh' ? <p className="ml-5 text-[11px] text-muted-foreground">读取已连接服务器的概览和服务列表；需要先在界面连接。</p> : null}
              {selected?.kind === 'redis' ? <p className="ml-5 text-[11px] text-muted-foreground">实例 INFO 与隐藏命令参数的慢日志指标，不读取键值。</p> : null}
              {mysql ? <div className="ml-5 min-w-0 space-y-3 border-l border-border/60 pl-3 text-xs">
                <label className="flex items-start gap-2"><input type="checkbox" disabled={busy} checked={mysql.instance} onChange={(event) => updateMysql(mysql.sourceId, { instance: event.target.checked })} aria-label={`允许 ${connection.label} 实例诊断`} /><span>实例诊断：总览、所有库的会话与语句指标、参数</span></label>
                <div className="flex gap-2"><Input className="h-8 min-w-0 text-xs" aria-label={`${connection.label} 授权库名`} maxLength={64} disabled={busy} value={databaseDrafts[connection.id] ?? ''} placeholder="输入明确的数据库名称"
                  onChange={(event) => setDatabaseDrafts((drafts) => ({ ...drafts, [connection.id]: event.target.value }))}
                  onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); addDatabase() } }} />
                  <Button type="button" variant="outline" size="sm" disabled={busy || !databaseDrafts[connection.id]?.trim() || mysql.databases.length >= 20} onClick={addDatabase}>添加库</Button></div>
                {mysql.databases.map((scope) => {
                  /** 同名库的输入状态按连接隔离。 */
                  const key = JSON.stringify([mysql.sourceId, scope.database])
                  /** 编辑只替换精确库条目。 */
                  const updateScope = (patch: Partial<typeof scope>): void => updateMysql(mysql.sourceId, { databases: mysql.databases.map((entry) => entry.database === scope.database ? { ...entry, ...patch } : entry) })
                  return <div key={scope.database} className="min-w-0 space-y-2 rounded bg-muted/30 p-2.5">
                    <div className="flex items-center justify-between gap-2"><span className="break-all font-medium">{scope.database}</span><Button type="button" variant="ghost" size="sm" className="h-6 shrink-0 px-1 text-[10px]" disabled={busy} aria-label={`删除 ${scope.database} 授权`} onClick={() => updateMysql(mysql.sourceId, { databases: mysql.databases.filter((entry) => entry.database !== scope.database) })}>删除</Button></div>
                    <label className="flex items-start gap-2"><input type="checkbox" disabled={busy} checked={scope.tables === null} aria-label={`${scope.database} 全部表`} onChange={(event) => {
                      /** 切回白名单时恢复可见草稿，防止界面有表名而实际提交空集合。 */
                      const previousNames = tableDrafts[key] ?? scope.tables?.join('\n') ?? ''
                      setTableDrafts((drafts) => ({ ...drafts, [key]: previousNames }))
                      updateScope({ tables: event.target.checked ? null : [...new Set(previousNames.split('\n').map((name) => name.trim()).filter(Boolean))] })
                    }} /><span>该库全部表（含库级会话与语句指标）</span></label>
                    {scope.tables !== null ? <textarea className="min-h-16 w-full resize-y rounded-md border border-border/60 bg-background px-2 py-1 text-[11px]" disabled={busy} value={tableDrafts[key] ?? scope.tables.join('\n')}
                      placeholder="每行一个表名；至少填写一张表" aria-label={`${scope.database} 表白名单`}
                      onChange={(event) => { const value = event.target.value; setTableDrafts((drafts) => ({ ...drafts, [key]: value })); updateScope({ tables: [...new Set(value.split('\n').map((name) => name.trim()).filter(Boolean))] }) }} /> : null}
                    <label className="flex items-start gap-2"><input type="checkbox" disabled={busy} checked={scope.readRows} aria-label={`允许读取 ${scope.database} 行数据`} onChange={(event) => updateScope(updateServerOpsAgentScopeReadRows(scope, event.target.checked))} /><span>允许读取{scope.tables === null ? '该库全部表' : '指定表'}的行数据（每次最多 50 行）</span></label>
                    <label className="flex items-start gap-2"><input type="checkbox" disabled={busy || !scope.readRows} checked={scope.query === true} aria-label={`允许查询 ${scope.database}`} onChange={(event) => updateScope({ query: event.target.checked })} /><span>{SERVER_OPS_AGENT_QUERY_PERMISSION_LABEL}</span></label>
                    <p className="text-[10px] leading-4 text-muted-foreground">{scope.tables === null ? '默认只读结构和诊断；SQL 查询需同时开启行读取和查询权限。' : '指定表范围同样约束 SQL 查询，不读取未授权表；敏感字段处理不保证完全匿名化。'}</p>
                  </div>
                })}
              </div> : null}
            </div>
          })}
          {missing.map((resource) => <div key={serverOpsReadResourceKey(resource)} className="flex items-center justify-between gap-2 text-xs"><span className="break-all">资源已移除：{serverOpsReadResourceKey(resource)}</span><Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => controller.edit(view.resources.filter((entry) => serverOpsReadResourceKey(entry) !== serverOpsReadResourceKey(resource)))}>移出授权</Button></div>)}
          {connections.length === 0 ? <p className="text-xs text-muted-foreground">当前项目暂无连接，可以管理其它项目中已授权的连接。</p> : null}
        </div>
        <p className="text-[11px] leading-5 text-muted-foreground">授权的结构、诊断、所选行数据和显式允许的 SQL 查询结果会发送给当前模型，密码不发送。常见敏感列会遮罩，但不保证完全匿名化。新增或移入项目的连接不会自动获得授权。</p>
        {view.error ? <p role="alert" className="break-words text-xs text-destructive">{view.error}</p> : null}
        <div className="flex flex-wrap justify-end gap-2"><Button type="button" variant="ghost" size="sm" className="mr-auto" disabled={busy || !view.access} onClick={() => { void controller.save([]) }}>撤销全部</Button><Button type="button" variant="outline" size="sm" disabled={view.saving} onClick={() => controller.close()}>取消</Button><Button type="button" size="sm" disabled={busy} onClick={() => { void controller.save() }}>{view.saving ? <LoaderCircle className="size-3.5 animate-spin" /> : null}保存授权</Button></div>
      </DialogContent>
    </Dialog>
  </>
}
