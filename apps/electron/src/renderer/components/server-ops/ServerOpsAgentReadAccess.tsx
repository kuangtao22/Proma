import * as React from 'react'
import { atom, useAtom, useStore } from 'jotai'
import { Database, LoaderCircle, ShieldCheck } from 'lucide-react'
import { serverOpsReadResourceKey } from '@proma/shared'
import type { ServerOpsDataSource, ServerOpsProject } from '@proma/shared'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { serverOpsDatabaseNavigationAtom } from '@/atoms/server-ops-database-atoms'
import type { ServerOpsConnection } from './server-ops-connections'
import { createServerOpsAgentReadController, emptyServerOpsAgentReadProjection } from './server-ops-agent-read-controller'
import type { ServerOpsAgentReadAccessApi, ServerOpsDatabaseAgentPolicyApi } from './server-ops-agent-read-controller'
import { AgentOpsAccessControl } from '../agent/AgentOpsAccessControl'
import { summarizeServerOpsReadAccess } from './server-ops-agent-read-summary'
import { ServerOpsDatabaseAgentPolicy } from './ServerOpsDatabaseAgentPolicy'
import { resolveServerOpsAgentDatabase } from './server-ops-agent-table-scope'

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
  /** 仅当前正在查看的连接沿用选库，其他连接的浏览历史不作为编辑目标。 */
  activeSourceId?: string
  /** 从卡片进入时限定所编辑的连接，保存仍保留其他连接的既有规则。 */
  connectionId?: string
  /** 外部卡片已经提供入口；挂载后加载并打开同一个编辑器。 */
  dialogOnly?: boolean
  /** 关闭或保存后通知外部释放编辑器，并恢复卡片入口焦点。 */
  onClosed?: () => void
  api?: ServerOpsAgentReadAccessApi
  policyApi?: ServerOpsDatabaseAgentPolicyApi
  unavailableReason?: string
}

/** 旧 preload 没有新接口时仍展示安全提示，不让工作区崩溃。 */
const UNAVAILABLE_API: ServerOpsAgentReadAccessApi = { get: async () => null, set: async () => { throw new Error('只读授权接口尚未就绪，请更新客户端') } }

/** 单一工具栏入口、原连接卡片弹窗；数据库禁用和服务器授权统一保存与取消。 */
export function ServerOpsAgentReadAccess({ sessionId, projectId, projects, allConnections, dataSources, viewScope = 'default', activeSourceId, connectionId, dialogOnly = false, onClosed, api, policyApi, unavailableReason }: ServerOpsAgentReadAccessProps): React.ReactElement {
  /** 只在打开时读取当前 Pane 的选库，不订阅翻页或后台目录请求。 */
  const store = useStore()
  /** 打开时冻结编辑目标，后续导航不偷偷改变禁用项归属。 */
  const databaseTargetsRef = React.useRef<ReadonlyMap<string, string>>(new Map())
  /** 授权事实和未保存草稿共用一个 Jotai 投影，防止两个弹窗状态失配。 */
  const projectionAtom = React.useMemo(() => atom(emptyServerOpsAgentReadProjection()), [])
  const [projection, setProjection] = useAtom(projectionAtom)
  /** 目录只在用户展开多选时读取，不参与授权保存。 */
  const catalogApi = React.useMemo(() => api?.listServerOpsDataSchemaTables ? { listServerOpsDataSchemaTables: api.listServerOpsDataSchemaTables } : undefined, [api])
  /** 到期时间仅本地按分钟更新，不触发后台轮询。 */
  const nowAtom = React.useMemo(() => atom(Date.now()), [])
  const [now, setNow] = useAtom(nowAtom)
  /** 两种保存仍走各自受控接口，控制器负责合并交互和失败状态。 */
  const controller = React.useMemo(() => createServerOpsAgentReadController({ api: api ?? UNAVAILABLE_API, policyApi, publish: setProjection }), [api, policyApi, setProjection])
  /** 无普通会话时仍允许管理持久数据库规则，服务器授权保持不可用。 */
  const targetSession = api ? sessionId : null
  /** 切换项目或会话时，当帧就隐藏旧弹窗和草稿。 */
  const view = projection.sessionId === targetSession && projection.projectId === projectId ? projection : emptyServerOpsAgentReadProjection()
  /** 关闭弹窗后恢复入口焦点，保留原键盘交互。 */
  const triggerRef = React.useRef<HTMLButtonElement>(null)
  /** 记录实际打开过的生命周期，区分首读等待与保存后的关闭。 */
  const openedRef = React.useRef(false)
  /** 异步首读完成后使用最新目标，不因连接列表重渲染重复打开。 */
  const openEditorRef = React.useRef<() => void>(() => undefined)
  /** 卡片范围仅影响展示和用户动作，不裁剪权威授权快照。 */
  const targetConnection = allConnections.find((connection) => connection.id === connectionId)
  React.useEffect(() => {
    controller.activate()
    const unsubscribe = api?.onChanged?.((event) => controller.changed(event))
    const unsubscribePolicy = policyApi?.onChanged?.((policy) => controller.databaseChanged(policy))
    return () => { unsubscribe?.(); unsubscribePolicy?.(); controller.dispose() }
  }, [api, policyApi, controller])
  React.useEffect(() => {
    /** 卸载或会话切换后，首读回执不能重新打开旧连接。 */
    let current = true
    void controller.select(targetSession, projectId).then(() => {
      if (current && dialogOnly && !controller.snapshot().error) openEditorRef.current()
    })
    return () => { current = false }
  }, [controller, targetSession, projectId, dialogOnly])
  React.useEffect(() => {
    if (view.open) openedRef.current = true
    else if (openedRef.current) onClosed?.()
  }, [view.open, onClosed])
  React.useEffect(() => {
    if (!view.access) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [view.access?.expiresAt, setNow])
  /** 打开统一弹窗，仅从正在查看的当前项目连接捕获选库。 */
  const openEditor = (): void => {
    const targets = new Map<string, string>()
    const source = dataSources.find((entry) => entry.id === activeSourceId && entry.projectId === projectId)
    if (source) {
      const database = resolveServerOpsAgentDatabase(source,
        store.get(serverOpsDatabaseNavigationAtom).get(JSON.stringify([viewScope, source.id])))
      if (database) targets.set(source.id, database)
    }
    databaseTargetsRef.current = targets
    controller.open()
    controller.edit(controller.snapshot().resources.filter((resource) => resource.kind === 'ssh' || resource.kind === 'redis'))
    void controller.loadImpact()
  }
  openEditorRef.current = openEditor
  /** 首读中也允许取消；保存中的关闭继续由控制器阻止。 */
  const closeEditor = (): void => {
    if (view.saving) return
    if (dialogOnly && !openedRef.current) onClosed?.()
    else controller.close()
  }
  /** SSH 和 Redis 沿用原授权勾选，数据库只有禁用表选择。 */
  const toggleResource = (connection: ServerOpsConnection): void => {
    if (view.resources.some((resource) => serverOpsReadResourceKey(resource) === connection.id)) {
      controller.edit(view.resources.filter((resource) => serverOpsReadResourceKey(resource) !== connection.id))
    } else if (connection.kind === 'ssh' && connection.hostId) {
      controller.edit([...view.resources, { kind: 'ssh', hostId: connection.hostId }])
    } else if (connection.kind === 'redis' && connection.sourceId) {
      controller.edit([...view.resources, { kind: 'redis', sourceId: connection.sourceId }])
    }
  }
  /** 当前项目全部连接保持原卡片顺序；其他项目已设置的范围仍可管理。 */
  const managed = allConnections.filter((connection) => connectionId ? connection.id === connectionId : connection.projectId === projectId
    || view.resources.some((resource) => serverOpsReadResourceKey(resource) === connection.id)
    || view.databaseExclusions.some((entry) => entry.sourceId === connection.sourceId))
  /** 已删除服务器资源保留撤销入口，不能悄悄丢弃已有权限。 */
  const missing = view.resources.filter((resource) => !connectionId && (resource.kind === 'ssh' || resource.kind === 'redis')
    && !allConnections.some((connection) => connection.id === serverOpsReadResourceKey(resource)))
  /** 已删除数据源的禁用规则仍展示，用户可明确清除。 */
  const missingDatabases = view.databaseExclusions.filter((entry) => !connectionId && !dataSources.some((source) => source.id === entry.sourceId))
  /** 保存期间锁定整份草稿，加载策略时不允许以空名单提交。 */
  const busy = view.loading || view.saving || view.databaseLoading || (dialogOnly && !view.open) || (targetConnection?.kind === 'database' && !policyApi)
  /** 显示原会话租约的期限，不把持久数据库规则计入到期数量。 */
  const remainingMinutes = view.access ? Math.max(0, Math.ceil((view.access.expiresAt - now) / 60_000)) : 0
  /** 使用已有连接目录生成摘要，不增加读取。 */
  const summary = summarizeServerOpsReadAccess(view.access && connectionId ? { ...view.access, resources: view.access.resources.filter((resource) => serverOpsReadResourceKey(resource) === connectionId) } : view.access, now, new Map(allConnections.map((connection) => [connection.id, connection.label])))
  /** 撤销只针对会话服务器授权，不能误删数据库禁用规则。 */
  const hasServerAccess = view.access?.resources.some((resource) => (resource.kind === 'ssh' || resource.kind === 'redis') && (!connectionId || serverOpsReadResourceKey(resource) === connectionId)) ?? false
  return <>
    {!dialogOnly ? <Button ref={triggerRef} type="button" variant="outline" size="sm" className="h-8 gap-1.5 rounded-md bg-content-area px-2 text-xs text-foreground/80" aria-label="Agent 只读授权"
      title={policyApi || targetSession ? '管理 Agent 只读授权与数据库禁用表' : unavailableReason ?? '请完整重启客户端以使用只读授权'}
      disabled={(!targetSession && !policyApi) || view.loading} onClick={openEditor}>
      {view.loading ? <LoaderCircle className="size-3.5 animate-spin" /> : <ShieldCheck className="size-3.5" />}
      <span className="shrink-0">Agent 只读授权</span>
    </Button> : null}
    <Dialog open={view.open || (dialogOnly && !openedRef.current)} onOpenChange={(open) => { if (!open) closeEditor() }}>
      <DialogContent className="z-[260] flex max-h-[90vh] w-[calc(100%-2rem)] max-w-2xl flex-col gap-3 overflow-hidden" overlayClassName="z-[250]" hideClose={view.saving}
        onCloseAutoFocus={(event) => { event.preventDefault(); triggerRef.current?.focus() }}
        onEscapeKeyDown={(event) => { event.stopPropagation(); if (view.saving) event.preventDefault() }}>
        <DialogHeader><DialogTitle>Agent 只读授权{targetConnection ? ` · ${targetConnection.label}` : ''}</DialogTitle><DialogDescription>{targetConnection?.kind === 'database' ? '未禁用的表默认可读；在这里多选禁用表，保存后生效。' : targetConnection ? '仅编辑当前连接；服务器与 Redis 共用当前会话的 30 分钟授权期限，修改后统一更新。' : '数据库默认可读，只需选择禁用表；服务器与 Redis 仍按当前会话授权，有效期 30 分钟。'}</DialogDescription></DialogHeader>
        {view.loading ? <p role="status" className="text-xs text-muted-foreground">正在读取授权…</p> : null}
        {targetSession ? <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-muted-foreground">当前会话工具模式</span>
          <AgentOpsAccessControl sessionId={targetSession} />
          <span className="text-muted-foreground">选择「运维只读」后仅开放运维读取工具。</span>
        </div> : <p className="text-xs text-muted-foreground">{unavailableReason ?? '当前没有普通 Agent 会话'}，可编辑数据库禁用表；服务器授权需先选择会话。</p>}
        {hasServerAccess ? <p className="break-words text-xs text-muted-foreground">{summary.target} · {summary.capability} · {remainingMinutes > 0 ? `剩余约 ${remainingMinutes} 分钟` : '已到期'}</p> : null}
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
          {managed.map((connection) => {
            /** 稳定连接 ID 关联服务器草稿，改名不改变授权目标。 */
            const selected = view.resources.find((resource) => serverOpsReadResourceKey(resource) === connection.id)
            /** 数据库卡片复用已有公开数据源，表目录仍按需读取。 */
            const source = dataSources.find((entry) => entry.id === connection.sourceId)
            return <div key={connection.id} className="min-w-0 space-y-2 rounded-md border border-border/60 p-3">
              <label className="flex min-w-0 items-start gap-2 text-xs font-medium">
                {connection.kind === 'database' ? <Database className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                  : <input type="checkbox" className="mt-0.5 accent-primary" disabled={busy || !targetSession} checked={Boolean(selected)} onChange={() => toggleResource(connection)} aria-label={`授权连接 ${connection.label}`} />}
                <span className="min-w-0 flex-1"><span className="block break-words">{connection.label}{connection.kind === 'database' ? <span className="ml-2 text-[10px] font-normal text-muted-foreground">默认只读</span> : null}</span><span className="mt-0.5 block break-all text-[10px] font-normal text-muted-foreground">{connection.detail}</span></span>
                <span className="max-w-24 break-words text-[10px] font-normal text-muted-foreground">{connection.projectId === projectId ? '当前项目' : projects.find((project) => project.id === connection.projectId)?.name ?? '其他项目'}</span>
              </label>
              {selected?.kind === 'ssh' ? <div className="ml-5 space-y-1.5 text-[11px] text-muted-foreground"><p>读取已连接服务器的概览、服务列表与有限发现结果；需要先在界面连接。</p><label className="flex items-start gap-2"><input type="checkbox" disabled={busy || !targetSession} checked={selected.readLogs === true} aria-label={`允许读取 ${connection.label} 日志`} onChange={(event) => controller.edit(view.resources.map((resource) => resource.kind === 'ssh' && resource.hostId === selected.hostId ? { ...resource, readLogs: event.target.checked } : resource))} /><span>单独允许读取服务器日志快照（最多 200 行；日志可能包含业务信息）</span></label></div> : null}
              {selected?.kind === 'redis' ? <p className="ml-5 text-[11px] text-muted-foreground">实例 INFO 与隐藏命令参数的慢日志指标，不读取键值。</p> : null}
              {connection.kind === 'database' ? <div className="ml-5 min-w-0 text-xs">
                {view.databasePolicy && source ? <ServerOpsDatabaseAgentPolicy source={source} currentDatabase={databaseTargetsRef.current.get(source.id)}
                  exclusions={view.databaseExclusions} disabled={busy} api={catalogApi} onChange={(exclusions) => controller.editDatabase(exclusions)} />
                  : <p className="text-[11px] text-muted-foreground">{view.databaseLoading ? '正在读取禁用规则…' : policyApi ? '禁用规则尚未加载，请重试。' : '请完整重启客户端后设置禁用表，已有规则不会改变。'}</p>}
              </div> : null}
            </div>
          })}
          {missing.map((resource) => <div key={serverOpsReadResourceKey(resource)} className="flex items-center justify-between gap-2 text-xs"><span className="break-all">资源已移除：{serverOpsReadResourceKey(resource)}</span><Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => controller.edit(view.resources.filter((entry) => serverOpsReadResourceKey(entry) !== serverOpsReadResourceKey(resource)))}>移出授权</Button></div>)}
          {missingDatabases.map((entry) => <div key={JSON.stringify([entry.sourceId, entry.database])} className="flex items-center justify-between gap-2 text-xs"><span className="break-all">已移除连接的禁用表：{entry.sourceId} / {entry.database}</span><Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => controller.editDatabase(view.databaseExclusions.filter((item) => item.sourceId !== entry.sourceId || item.database !== entry.database))}>清除禁用</Button></div>)}
          {managed.length === 0 ? <p className="text-xs text-muted-foreground">当前项目暂无连接，可以管理其它项目已设置的范围。</p> : null}
        </div>
        <p className="text-[11px] leading-5 text-muted-foreground">未禁用的业务表（含新增表）默认可查询，勾选的表保存后持久禁用；支持结构、数据预览和只读 SQL，修改仅生成脚本或程序。服务器日志需单独授权。{view.databasePolicy?.revision === 0 ? '旧版临时禁用未持久保存，需重新勾选保存。' : ''}</p>
        {view.databaseError ? <p role="alert" className="break-words text-xs text-destructive">{view.databaseError}</p> : null}
        {view.error && view.error !== view.databaseError ? <p role="alert" className="break-words text-xs text-destructive">{view.error}</p> : null}
        <div className="flex flex-wrap justify-end gap-2">
          {targetSession && targetConnection?.kind !== 'database' ? <Button type="button" variant="ghost" size="sm" className="mr-auto" disabled={busy || view.impactLoading || !hasServerAccess} onClick={() => { void controller.save(connectionId ? view.resources.filter((resource) => serverOpsReadResourceKey(resource) !== connectionId) : [], false) }}>{connectionId ? '撤销此连接授权' : '撤销服务器授权'}</Button> : null}
          {((policyApi && !view.databasePolicy && !view.databaseLoading) || (dialogOnly && !view.open && view.error)) ? <Button type="button" variant="outline" size="sm" disabled={view.saving || view.loading} onClick={() => {
            if (!dialogOnly || view.open) openEditor()
            else void controller.select(targetSession, projectId).then(() => { if (!controller.snapshot().error) openEditorRef.current() })
          }}>重试</Button> : null}
          <Button type="button" variant="outline" size="sm" disabled={view.saving} onClick={closeEditor}>取消</Button>
          <Button type="button" size="sm" disabled={busy || view.impactLoading || Boolean(view.databaseError)} onClick={() => { void controller.save(undefined, true, !connectionId) }}>
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
