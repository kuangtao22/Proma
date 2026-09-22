import * as React from 'react'
import { useStore } from 'jotai'
import { LoaderCircle, ShieldCheck } from 'lucide-react'
import { serverOpsReadResourceKey } from '@proma/shared'
import type { ServerOpsAgentDatabaseScope, ServerOpsDataSource, ServerOpsProject } from '@proma/shared'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { serverOpsDatabaseNavigationAtom } from '@/atoms/server-ops-database-atoms'
import type { ServerOpsConnection } from './server-ops-connections'
import { createServerOpsAgentReadController, emptyServerOpsAgentReadProjection } from './server-ops-agent-read-controller'
import type { ServerOpsAgentReadAccessApi } from './server-ops-agent-read-controller'
import { AgentOpsAccessControl } from '../agent/AgentOpsAccessControl'
import { summarizeServerOpsReadAccess } from './server-ops-agent-read-summary'
import { ServerOpsAgentDatabaseExclusions } from './ServerOpsAgentTablePicker'
import { createServerOpsQueryableScope, resolveServerOpsAgentDatabase } from './server-ops-agent-table-scope'

/** 授权编辑器只接收公开连接目录，不接触密码或隐式项目权限。 */
export interface ServerOpsAgentReadAccessProps {
  sessionId: string | null
  projectId: string
  projects: readonly ServerOpsProject[]
  connections: readonly ServerOpsConnection[]
  allConnections: readonly ServerOpsConnection[]
  dataSources: readonly ServerOpsDataSource[]
  /** 与数据库工作台一致的 Pane 导航范围，避免跨会话或面板复用选库。 */
  viewScope?: string
  /** 仅当前正在查看的连接可沿用选库，其他连接的浏览历史不能扩大授权。 */
  activeSourceId?: string
  api?: ServerOpsAgentReadAccessApi
  unavailableReason?: string
}

/** 旧 preload 没有新接口时禁用入口，不使工作区崩溃。 */
const UNAVAILABLE_API: ServerOpsAgentReadAccessApi = { get: async () => null, set: async () => { throw new Error('只读授权接口尚未就绪，请更新客户端') } }

/** 项目工具栏入口与当前 Agent 的多资源只读授权编辑器。 */
export function ServerOpsAgentReadAccess({ sessionId, projectId, projects, connections, allConnections, dataSources, viewScope = 'default', activeSourceId, api, unavailableReason }: ServerOpsAgentReadAccessProps): React.ReactElement {
  /** 只在用户打开弹窗时读取导航快照，不订阅浏览器翻页或后台查询。 */
  const store = useStore()
  /** 打开编辑器时捕获选库，后续渲染与勾选共用同一草稿目标。 */
  const databaseTargetsRef = React.useRef<ReadonlyMap<string, string>>(new Map())
  /** 权威数量与编辑草稿由实际使用的控制器分开维护。 */
  const [projection, setProjection] = React.useState(emptyServerOpsAgentReadProjection)
  /** 目录桥接仅用于用户点选，不参与授权事实读取或保存。 */
  const catalogApi = React.useMemo(() => api?.listServerOpsDataSchemaTables ? { listServerOpsDataSchemaTables: api.listServerOpsDataSchemaTables } : undefined, [api])
  /** 到期显示仅按分钟刷新本地时间，不触发连接目录或后台轮询。 */
  const [now, setNow] = React.useState(() => Date.now())
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
    const unsubscribe = api?.onChanged?.((event) => {
      if (event.current?.sessionId !== targetSession && event.previous?.sessionId !== targetSession) return
      controller.changed(event)
    })
    return () => { unsubscribe?.(); controller.dispose() }
  }, [api, controller, targetSession])
  React.useEffect(() => {
    void controller.select(targetSession, projectId)
  }, [controller, targetSession, projectId])
  React.useEffect(() => {
    if (!view.access) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [view.access?.expiresAt])
  /** 只替换精确数据源的权限，其它项目的已有范围保持原样。 */
  const updateDatabaseScopes = (sourceId: string, databases: ServerOpsAgentDatabaseScope[]): void => {
    controller.edit(view.resources.map((resource) => {
      if ((resource.kind !== 'mysql' && resource.kind !== 'sqlite') || resource.sourceId !== sourceId) return resource
      /** 默认查询仅限选中库，不隐式开放跨库实例诊断。 */
      return { ...resource, databases, instance: false }
    }))
  }
  /** 打开时固定当前 Pane 选库；后续勾选只改草稿，保存前不产生授权。 */
  const openEditor = (): void => {
    /** 只使用正在查看的连接，其他连接或项目首页不从浏览历史新增授权库。 */
    const targets = new Map<string, string>()
    const navigation = store.get(serverOpsDatabaseNavigationAtom)
    const source = dataSources.find((entry) => entry.id === activeSourceId
      && connections.some((connection) => connection.sourceId === entry.id))
    if (source) {
      const database = resolveServerOpsAgentDatabase(source, navigation.get(JSON.stringify([viewScope, source.id])))
      if (database) targets.set(source.id, database)
    }
    databaseTargetsRef.current = targets
    controller.open(targets)
    void controller.loadImpact()
  }
  /** 用户选中连接后沿用工作台选库；SQLite 固定 main，默认可查询未禁用表。 */
  const toggleResource = (connection: ServerOpsConnection): void => {
    if (view.resources.some((resource) => serverOpsReadResourceKey(resource) === connection.id)) {
      controller.edit(view.resources.filter((resource) => serverOpsReadResourceKey(resource) !== connection.id))
      return
    }
    if (connection.kind === 'ssh' && connection.hostId) {
      controller.edit([...view.resources, { kind: 'ssh', hostId: connection.hostId }])
      return
    }
    const source = dataSources.find((entry) => entry.id === connection.sourceId)
    if (!source) return
    /** 选库在打开弹窗时固定，不用其他 Pane 或配置中的旧库名猜测目标。 */
    const database = source.engine === 'sqlite' ? 'main' : databaseTargetsRef.current.get(source.id)
    controller.edit([
      ...view.resources,
      source.engine === 'redis'
        ? { kind: 'redis', sourceId: source.id }
        : { kind: source.engine, sourceId: source.id, instance: false, databases: database ? [createServerOpsQueryableScope(database)] : [] },
    ])
  }
  /** 当前项目可新选连接；其它项目只展示已授权资源。 */
  const managed = allConnections.filter((connection) => connection.projectId === projectId || view.resources.some((resource) => serverOpsReadResourceKey(resource) === connection.id))
  /** 目录消失的残留条目仍允许撤销，不隐藏在用户视野之外。 */
  const missing = view.resources.filter((resource) => !allConnections.some((connection) => connection.id === serverOpsReadResourceKey(resource)))
  /** 在途提交锁定编辑，避免提交内容与当前勾选不一致。 */
  const busy = view.loading || view.saving
  /** 数据库查询必须有明确选库目标，避免隐式开放其它库。 */
  const missingMySqlDatabase = view.resources.some((resource) => resource.kind === 'mysql' && resource.databases.length === 0)
  /** 加入当前库后若超出合同容量，保留原库并让用户从其他授权中明确移除。 */
  const tooManyDatabases = view.resources.some((resource) => resource.kind === 'mysql' && resource.databases.length > 20)
  /** 已授权资源的期限由主进程快照给出，不因 UI 读操作续期。 */
  const remainingMinutes = view.access ? Math.max(0, Math.ceil((view.access.expiresAt - now) / 60_000)) : 0
  /** 编辑器已有完整连接目录，无需额外查询即可显示授权目标名称。 */
  const summary = summarizeServerOpsReadAccess(view.access, now, new Map(allConnections.map((connection) => [connection.id, connection.label])))
  return <>
    <Button ref={triggerRef} type="button" variant="outline" size="sm" className="h-8 gap-1.5 rounded-md bg-content-area px-2 text-xs text-foreground/80" aria-label="Agent 只读授权"
      title={unavailableReason ?? (!api ? '请更新客户端以使用只读授权' : '管理当前 Agent 的只读运维范围')}
      disabled={!targetSession || view.loading} onClick={openEditor}>
      {view.loading ? <LoaderCircle className="size-3.5 animate-spin" /> : <ShieldCheck className="size-3.5" />}
      <span className="shrink-0">Agent 只读授权</span>
    </Button>
    {!targetSession ? <span className="sr-only">{unavailableReason ?? '无普通 Agent 会话'}</span> : null}
    <Dialog open={view.open} onOpenChange={(open) => { if (!open) controller.close() }}>
      <DialogContent className="z-[260] flex max-h-[90vh] w-[calc(100%-2rem)] max-w-2xl flex-col gap-3 overflow-hidden" overlayClassName="z-[250]" hideClose={view.saving}
        onCloseAutoFocus={(event) => { event.preventDefault(); triggerRef.current?.focus() }}
        onEscapeKeyDown={(event) => { event.stopPropagation(); if (view.saving) event.preventDefault() }}>
        <DialogHeader><DialogTitle>Agent 只读授权</DialogTitle><DialogDescription>选择当前会话可读取的连接；每次授权固定 30 分钟，不开放远程命令或文件修改。</DialogDescription></DialogHeader>
        {targetSession ? <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-muted-foreground">当前会话工具模式</span>
          <AgentOpsAccessControl sessionId={targetSession} />
          <span className="text-muted-foreground">选择「运维只读」后仅开放运维读取工具。</span>
        </div> : null}
        {view.access ? <p className="break-words text-xs text-muted-foreground">{summary.target} · {summary.capability}</p> : null}
        {view.access ? <p className="text-xs text-muted-foreground">当前 {view.access.resources.length} 项 · {remainingMinutes > 0 ? `剩余约 ${remainingMinutes} 分钟` : '已到期'} · 到期 {new Date(view.access.expiresAt).toLocaleString('zh-CN')}</p> : null}
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
          {managed.map((connection) => {
            /** 稳定 ID 保证改名和移动不会改变已选能力。 */
            const selected = view.resources.find((resource) => serverOpsReadResourceKey(resource) === connection.id)
            /** 数据库连接选中后才显示权限编辑。 */
            const databaseResource = selected?.kind === 'mysql' || selected?.kind === 'sqlite' ? selected : undefined
            /** 目录请求使用公开配置身份，不能跨连接复用库表结果。 */
            const source = dataSources.find((entry) => entry.id === connection.sourceId)
            return <div key={connection.id} className="min-w-0 space-y-2 rounded-md border border-border/60 p-3">
              <label className="flex min-w-0 items-start gap-2 text-xs font-medium">
                <input type="checkbox" className="mt-0.5 accent-primary" disabled={busy} checked={Boolean(selected)} onChange={() => toggleResource(connection)} aria-label={`授权连接 ${connection.label}`} />
                <span className="min-w-0 flex-1"><span className="block break-words">{connection.label}</span><span className="mt-0.5 block break-all text-[10px] font-normal text-muted-foreground">{connection.detail}</span></span>
                <span className="max-w-24 break-words text-[10px] font-normal text-muted-foreground">{connection.projectId === projectId ? '当前项目' : projects.find((project) => project.id === connection.projectId)?.name ?? '其他项目'}</span>
              </label>
              {selected?.kind === 'ssh' ? <div className="ml-5 space-y-1.5 text-[11px] text-muted-foreground"><p>读取已连接服务器的概览、服务列表与有限发现结果；需要先在界面连接。</p><label className="flex items-start gap-2"><input type="checkbox" disabled={busy} checked={selected.readLogs === true} aria-label={`允许读取 ${connection.label} 日志`} onChange={(event) => controller.edit(view.resources.map((resource) => resource.kind === 'ssh' && resource.hostId === selected.hostId ? { ...resource, readLogs: event.target.checked } : resource))} /><span>单独允许读取服务器日志快照（最多 200 行；日志可能包含业务信息）</span></label></div> : null}
              {selected?.kind === 'redis' ? <p className="ml-5 text-[11px] text-muted-foreground">实例 INFO 与隐藏命令参数的慢日志指标，不读取键值。</p> : null}
              {databaseResource ? <div className="ml-5 min-w-0 text-xs">
                {source ? <ServerOpsAgentDatabaseExclusions
                  source={source}
                  resource={databaseResource}
                  currentDatabase={databaseTargetsRef.current.get(databaseResource.sourceId)}
                  api={catalogApi}
                  disabled={busy}
                  onChange={(databases) => updateDatabaseScopes(databaseResource.sourceId, databases)}
                /> : <p className="text-[11px] text-muted-foreground">连接配置不可用，请刷新连接列表。</p>}
              </div> : null}
            </div>
          })}
          {missing.map((resource) => <div key={serverOpsReadResourceKey(resource)} className="flex items-center justify-between gap-2 text-xs"><span className="break-all">资源已移除：{serverOpsReadResourceKey(resource)}</span><Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => controller.edit(view.resources.filter((entry) => serverOpsReadResourceKey(entry) !== serverOpsReadResourceKey(resource)))}>移出授权</Button></div>)}
          {connections.length === 0 ? <p className="text-xs text-muted-foreground">当前项目暂无连接，可以管理其它项目中已授权的连接。</p> : null}
        </div>
        <p className="text-[11px] leading-5 text-muted-foreground">保存后，所选数据库默认可查询全部未禁用表（含新增表），支持结构、数据预览和只读 SQL，不开放写入。读取结果会发送给当前模型，连接凭据不会发送；日志仍需单独授权。新消息使用保存后的权限；撤权不能收回已发送的内容。</p>
        {missingMySqlDatabase ? <p role="alert" className="text-xs text-destructive">请先在数据库工作台顶部选库，再打开授权设置；也可取消勾选尚未选库的连接。</p> : null}
        {tooManyDatabases ? <p role="alert" className="text-xs text-destructive">每个连接最多授权 20 个数据库，请展开“其他已授权数据库”移除不再需要的范围。</p> : null}
        {view.error ? <p role="alert" className="break-words text-xs text-destructive">{view.error}</p> : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" className="mr-auto" disabled={busy || view.impactLoading || !view.access} onClick={() => { void controller.save([]) }}>撤销全部</Button>
          <Button type="button" variant="outline" size="sm" disabled={view.saving} onClick={() => controller.close()}>取消</Button>
          <Button type="button" size="sm" disabled={busy || view.impactLoading || missingMySqlDatabase || tooManyDatabases} onClick={() => { void controller.save() }}>
            {view.saving ? <LoaderCircle className="size-3.5 animate-spin" /> : null}保存授权
          </Button>
        </div>
      </DialogContent>
    </Dialog>
    <AlertDialog open={view.confirming} onOpenChange={(open) => { if (!open) controller.cancelConfirmation() }}>
      <AlertDialogContent className="z-[280]"><AlertDialogHeader><AlertDialogTitle>替换服务器操作授权？</AlertDialogTitle>
        <AlertDialogDescription>保存只读授权将撤销会话 {view.impact?.legacy?.sessionId ?? '未知'} 对服务器 {view.impact?.legacy?.hostId ?? '未知'} 的操作权限。请确认当前范围后继续。</AlertDialogDescription>
      </AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>返回编辑</AlertDialogCancel><AlertDialogAction onClick={() => { void controller.confirmSave() }}>撤销旧授权并保存</AlertDialogAction></AlertDialogFooter></AlertDialogContent>
    </AlertDialog>
  </>
}
