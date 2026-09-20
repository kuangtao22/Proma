import * as React from 'react'
import { atom, useAtom, useSetAtom, useStore } from 'jotai'
import { MoreHorizontal, Pencil, PlugZap, Trash2 } from 'lucide-react'
import type { ServerOpsDataSource } from '@proma/shared'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { createServerOpsDatabaseNavigation, serverOpsDatabaseNavigationAtom, updateServerOpsDatabaseNavigationAtom } from '@/atoms/server-ops-database-atoms'
import type { ServerOpsDatabaseNavigation, ServerOpsDatabaseSection, ServerOpsDatabasePage, ServerOpsInstancePage } from '@/atoms/server-ops-database-atoms'
import type { ServerOpsDataConnectionJumpHost } from './ServerOpsDataConnectionView'
import { createServerOpsDataIdleProjection, createServerOpsDataServicesController } from './ServerOpsDataServicesPanel'
import type { ServerOpsDataPanelApi, ServerOpsDataSourceMutation } from './ServerOpsDataServicesPanel'
import { createServerOpsSchemaBrowserController, createServerOpsSchemaIdleProjection, ServerOpsDatabaseSelector, ServerOpsSchemaBrowserView } from './ServerOpsSchemaBrowser'
import { createServerOpsDiagnosticsController } from './server-ops-diagnostics-controller'
import type { ServerOpsDiagnosticsProjection } from './server-ops-diagnostics-controller'
import { ServerOpsDatabaseDiagnostics } from './ServerOpsDatabaseDiagnostics'
import { ServerOpsSqlQueryPanel } from './ServerOpsSqlQueryPanel'
import { ServerOpsDataSourceDialog } from './ServerOpsDataSourceDialog'
import { formatServerOpsDataProbeSummary } from './server-ops-data-display'
import { SERVER_OPS_SEGMENTED_CLASS } from './server-ops-ui'

/** 实例菜单直接对应全局读取，不再嵌套混合范围的运行诊断。 */
const instancePages = [['overview', '总览'], ['sessions', '会话'], ['statements', '语句分析'], ['parameters', '实例参数']] as const
/** 当前数据库可用的页面；表的结构、索引与属性仍留在数据浏览内部。 */
const databasePages = [['browse', '数据浏览'], ['query', 'SQL 查询'], ['sessions', '会话'], ['statements', '语句分析']] as const
/** 隐藏页面保留表浏览状态，各层只滚动正文。 */
const contentClass = 'm-0 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden data-[state=inactive]:hidden'
/** 库内与实例页签使用轻量下划线，避免与顶层范围分段控件争抢层级。 */
const pageTabsListClass = 'flex h-9 w-full shrink-0 items-end justify-start gap-1 overflow-x-auto rounded-none border-b border-border/40 bg-transparent p-0 px-3'
/** 页签的选中态只用文字与底边表达，不再绘制嵌套底色。 */
const pageTabClass = 'inline-flex h-9 shrink-0 items-center justify-center whitespace-nowrap rounded-none border-b-2 border-transparent px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:border-foreground/70 data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none'

/** 不含凭据的配置身份；仅展示名称与无关 SSH 状态不参与。 */
export function getServerOpsDatabaseReadIdentity(source: ServerOpsDataSource): string {
  return JSON.stringify([source.id, source.updatedAt, source.engine, source.transport, source.hostId, source.address, source.port,
    source.database, source.username, source.tlsMode, source.tlsServerName, source.hasPassword])
}

/** MySQL 独立工作台输入；连接头由外层统一渲染。 */
export interface ServerOpsDatabaseWorkbenchProps {
  api: ServerOpsDataPanelApi
  source: ServerOpsDataSource
  jumpHost: ServerOpsDataConnectionJumpHost | null
  viewScope: string
  renderHeader: (actions: React.ReactNode) => React.ReactNode
  onSourceMutated?: (change: ServerOpsDataSourceMutation) => void
}

/**
 * MySQL 工作台：连接管理、表浏览、实例诊断各有独立控制器。
 * 布局展开只改变父容器，不卸载控制器；全局仅保留轻量导航。
 */
export function ServerOpsDatabaseWorkbench({ api, source, jumpHost, viewScope, renderHeader, onSourceMutated }: ServerOpsDatabaseWorkbenchProps): React.ReactElement {
  /** 从当前 Jotai store 恢复本 Pane 的轻量导航，测试 Provider 也能隔离。 */
  const store = useStore()
  const saveNavigation = useSetAtom(updateServerOpsDatabaseNavigationAtom)
  const viewKey = JSON.stringify([viewScope, source.id])
  const identity = getServerOpsDatabaseReadIdentity(source)
  /** 一次挂载固定初值；同 ID 配置变化通过后续 effect 清理。 */
  const [initial] = React.useState(() => {
    const saved = store.get(serverOpsDatabaseNavigationAtom).get(viewKey)
    return saved?.configurationKey === identity && (saved.section === 'instance' || saved.section === 'database') ? saved : createServerOpsDatabaseNavigation(identity)
  })
  /** 所有界面投影使用本组件私有 Jotai atom，不泄漏业务行到全局。 */
  const [navigationAtom] = React.useState(() => atom(initial))
  const [navigation, setNavigation] = useAtom(navigationAtom)
  const [schemaAtom] = React.useState(() => atom(createServerOpsSchemaIdleProjection()))
  const [schema, setSchema] = useAtom(schemaAtom)
  /** 实例和当前库分开缓存，切换范围不会把同名页面的快照串用。 */
  const [instanceDiagnosticsAtom] = React.useState(() => atom<ServerOpsDiagnosticsProjection>({ page: null, database: null, pages: {} }))
  const [instanceDiagnostics, setInstanceDiagnostics] = useAtom(instanceDiagnosticsAtom)
  const [databaseDiagnosticsAtom] = React.useState(() => atom<ServerOpsDiagnosticsProjection>({ page: null, database: null, pages: {} }))
  const [databaseDiagnostics, setDatabaseDiagnostics] = useAtom(databaseDiagnosticsAtom)
  const [managementAtom] = React.useState(() => atom(createServerOpsDataIdleProjection()))
  const [management, setManagement] = useAtom(managementAtom)
  /** 最新变更通知避免控制器捕获过期的项目列表刷新闭包。 */
  const mutationRef = React.useRef(onSourceMutated)
  mutationRef.current = onSourceMutated
  /** 控制器随连接工作台创建一次，展开/切页不会重新构建。 */
  const [schemaController] = React.useState(() => createServerOpsSchemaBrowserController({ api, publish: setSchema, initialNavigation: initial }))
  const [instanceDiagnosticsController] = React.useState(() => createServerOpsDiagnosticsController({ api, publish: setInstanceDiagnostics }))
  const [databaseDiagnosticsController] = React.useState(() => createServerOpsDiagnosticsController({ api, publish: setDatabaseDiagnostics }))
  const [managementController] = React.useState(() => createServerOpsDataServicesController({ api, publish: setManagement, automaticDiagnostics: false, onSourceMutated: (change) => mutationRef.current?.(change) }))
  /** 直连不依赖 SSH；跳板未连通只影响读取，不影响编辑配置。 */
  const readable = source.transport === 'direct' || (jumpHost !== null && jumpHost.id === source.hostId && jumpHost.connected)
  /** 配置同 ID 更新后，新请求不再携带旧目标导航。 */
  React.useEffect(() => {
    setNavigation((previous) => previous.configurationKey === identity ? previous : createServerOpsDatabaseNavigation(identity))
  }, [identity, setNavigation])
  React.useEffect(() => {
    schemaController.activate()
    instanceDiagnosticsController.activate()
    databaseDiagnosticsController.activate()
    managementController.activate()
    return () => { schemaController.dispose(); instanceDiagnosticsController.dispose(); databaseDiagnosticsController.dispose(); managementController.dispose() }
  }, [schemaController, instanceDiagnosticsController, databaseDiagnosticsController, managementController])
  React.useEffect(() => {
    schemaController.setSource({ id: source.id, engine: source.engine, updatedAt: source.updatedAt, readIdentity: identity, ...(source.database === undefined ? {} : { database: source.database }) }, readable)
  }, [schemaController, source.id, source.engine, source.updatedAt, source.database, identity, readable])
  React.useEffect(() => {
    managementController.setContext({ active: true, connected: jumpHost?.connected ?? false, hostId: jumpHost?.id ?? '', hostLabel: jumpHost?.label ?? '', hostDescription: jumpHost?.description ?? '', focusSource: source })
  }, [managementController, source, jumpHost?.id, jumpHost?.label, jumpHost?.description, jumpHost?.connected])
  React.useEffect(() => {
    /** 读取控制器当前投影，避免同 ID 配置重置时使用上次渲染的库名。 */
    const currentSchema = schemaController.getProjection()
    /** 先暂停两区并固定配置身份，恢复库导航时绝不临时查询全部库。 */
    const configurationMatches = navigation.configurationKey === identity
    const waitingForDatabase = currentSchema.sourceId !== source.id || currentSchema.database === null
    instanceDiagnosticsController.selectPage(null)
    databaseDiagnosticsController.selectPage(null)
    instanceDiagnosticsController.setSource(source.id, identity, readable)
    databaseDiagnosticsController.setSource(source.id, identity, readable)
    databaseDiagnosticsController.setDatabase(currentSchema.database)
    instanceDiagnosticsController.selectPage(configurationMatches && navigation.section === 'instance' ? navigation.instancePage : null)
    databaseDiagnosticsController.selectPage(configurationMatches && navigation.section === 'database' && !waitingForDatabase && navigation.databasePage !== 'browse' && navigation.databasePage !== 'query' ? navigation.databasePage : null)
  }, [instanceDiagnosticsController, databaseDiagnosticsController, schemaController, schema.database, schema.status, schema.sourceId, navigation.configurationKey, navigation.section, navigation.instancePage, navigation.databasePage, source.id, identity, readable])
  /** 只在目录已验证后记住库表，初始化空投影不能覆盖恢复目标。 */
  React.useEffect(() => {
    if (schema.status !== 'ready' || schema.sourceId !== source.id) return
    setNavigation((previous) => previous.database === schema.database && previous.table === schema.selectedTable && previous.detailTab === schema.detailTab && previous.offset === schema.rows.offset ? previous : {
      ...previous, database: schema.database, table: schema.selectedTable, detailTab: schema.detailTab, offset: schema.rows.offset,
    })
  }, [schema.status, schema.sourceId, schema.database, schema.selectedTable, schema.detailTab, schema.rows.offset, source.id, setNavigation])
  React.useEffect(() => { saveNavigation({ key: viewKey, navigation }) }, [saveNavigation, viewKey, navigation])
  /** 合并轻量导航字段，重复交互不产生额外状态写入。 */
  const updateNavigation = (update: Partial<ServerOpsDatabaseNavigation>): void => setNavigation((previous) => ({ ...previous, ...update }))
  /** 一次交互同时切换浏览和诊断范围，避免新库标题下短暂保留旧库正文。 */
  const selectDatabase = (database: string): void => {
    databaseDiagnosticsController.setDatabase(database)
    schemaController.selectDatabase(database)
  }
  /** 容量汇总只提供入口，真实库目录仍由浏览控制器校验；同库保留原表和页码。 */
  const browseDatabase = (database: string): void => {
    databaseDiagnosticsController.selectPage(null)
    selectDatabase(database)
    updateNavigation({ section: 'database', databasePage: 'browse' })
  }
  /** 测试状态独立于当前页面的刷新与错误。 */
  const probe = management.probes[source.id]
  /** 连接级操作集中到更多菜单，主内容只保留当前页操作。 */
  const actions = <DropdownMenu><DropdownMenuTrigger asChild><Button size="icon-sm" variant="ghost" aria-label="连接操作"><MoreHorizontal className="size-4" /></Button></DropdownMenuTrigger><DropdownMenuContent align="end" className="z-[260]">
    <DropdownMenuItem disabled={!readable || probe?.state === 'running'} onSelect={() => managementController.probe(source)}><PlugZap className="mr-2 size-3.5" />{probe?.state === 'running' ? '正在测试连接…' : '测试连接'}</DropdownMenuItem>
    <DropdownMenuItem onSelect={() => managementController.openEditDialog(source)}><Pencil className="mr-2 size-3.5" />连接设置</DropdownMenuItem><DropdownMenuSeparator /><DropdownMenuItem className="text-destructive" onSelect={() => managementController.requestDelete(source)}><Trash2 className="mr-2 size-3.5" />删除连接</DropdownMenuItem>
  </DropdownMenuContent></DropdownMenu>
  return <>
    {renderHeader(actions)}
    {probe ? <div role="status" className="mx-4 my-2 shrink-0 rounded-lg bg-muted/40 px-3 py-2 text-xs leading-relaxed text-muted-foreground">{probe.state === 'running' ? '正在测试连接…' : probe.state === 'error' ? probe.error : probe.result ? formatServerOpsDataProbeSummary(probe.result) : ''}</div> : null}
    {management.error ? <div role="alert" className="mx-4 my-2 shrink-0 rounded-lg bg-destructive/5 px-3 py-2 text-xs leading-relaxed text-destructive">{management.error}</div> : null}
    {!readable ? <div className="mx-4 my-2 shrink-0 rounded-lg bg-muted/40 px-3 py-2 text-xs leading-relaxed text-muted-foreground">跳板服务器尚未连接，连接后才能读取数据库。连接设置仍可编辑。</div> : null}
    <Tabs className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" value={navigation.section} onValueChange={(section) => updateNavigation({ section: section as ServerOpsDatabaseSection })}>
      <div className="flex min-h-11 shrink-0 flex-wrap items-start gap-x-3 gap-y-1 border-b border-border/40 px-3 py-2" data-server-ops-database-scope-toolbar>
        <TabsList className={SERVER_OPS_SEGMENTED_CLASS} aria-label="工作台范围">
          <TabsTrigger className="h-7 px-2.5 text-xs" value="instance">实例</TabsTrigger>
          <TabsTrigger className="h-7 px-2.5 text-xs" value="database">数据库</TabsTrigger>
        </TabsList>
        {navigation.section === 'database'
          ? <ServerOpsDatabaseSelector compact projection={schema} onSelectDatabase={selectDatabase} onRefresh={schemaController.refreshTables} />
          : <span className="flex h-8 items-center text-[11px] text-muted-foreground" data-server-ops-database-scope-label>全部数据库</span>}
      </div>
      <TabsContent value="instance" className={contentClass}>
        <Tabs className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" value={navigation.instancePage} onValueChange={(instancePage) => updateNavigation({ instancePage: instancePage as ServerOpsInstancePage })}>
          <TabsList className={pageTabsListClass} aria-label="实例功能" data-server-ops-database-page-tabs="instance">
            {instancePages.map(([page, label]) => <TabsTrigger key={page} className={pageTabClass} value={page}>{label}</TabsTrigger>)}
          </TabsList>
          {instancePages.map(([page]) => <TabsContent key={page} value={page} className={contentClass}>
            <ServerOpsDatabaseDiagnostics projection={instanceDiagnostics} page={page} scope="instance" onRefresh={instanceDiagnosticsController.refresh} onSelectDatabase={browseDatabase} />
          </TabsContent>)}
        </Tabs>
      </TabsContent>
      <TabsContent value="database" forceMount className={contentClass}>
        <Tabs className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" value={navigation.databasePage} onValueChange={(databasePage) => updateNavigation({ databasePage: databasePage as ServerOpsDatabasePage })}>
          {navigation.section === 'database' ? <TabsList className={pageTabsListClass} aria-label="数据库功能" data-server-ops-database-page-tabs="database">
            {databasePages.map(([page, label]) => <TabsTrigger key={page} className={pageTabClass} value={page}>{label}</TabsTrigger>)}
          </TabsList> : null}
          <TabsContent value="browse" forceMount className={contentClass}>
            <ServerOpsSchemaBrowserView projection={schema} showDatabaseSelector={false} onSelectDatabase={selectDatabase} onOpenTable={schemaController.openTable} onBackToList={schemaController.backToList} onDetailTabChange={schemaController.setDetailTab} onLoadRows={schemaController.loadRows} onRefresh={schemaController.refresh} onRefreshTables={schemaController.refreshTables} directoryWidth={navigation.directoryWidth} onDirectoryWidthChange={(directoryWidth) => updateNavigation({ directoryWidth })} />
          </TabsContent>
          <TabsContent value="query" className={contentClass}>
            <ServerOpsSqlQueryPanel api={api} sourceId={source.id} database={schema.database} configurationKey={identity} available={readable} />
          </TabsContent>
          {databasePages.map(([page]) => page === 'browse' || page === 'query' ? null : <TabsContent key={page} value={page} className={contentClass}>
            <ServerOpsDatabaseDiagnostics projection={databaseDiagnostics} page={page} scope="database" onRefresh={databaseDiagnosticsController.refresh} />
          </TabsContent>)}
        </Tabs>
      </TabsContent>
    </Tabs>
    <ServerOpsDataSourceDialog open={management.dialog !== null} mode="edit" source={management.dialog?.source ?? source} hostId={jumpHost?.id ?? ''} hostLabel={jumpHost?.label ?? ''} submitting={management.submitting} error={management.dialogError} elevated onTest={(draft) => api.probeServerOpsDataSource({ draft })} onRevealPassword={async (sourceId) => (await api.revealServerOpsDataSourcePassword({ sourceId })).password} onSubmit={managementController.submitDialog} onClose={managementController.closeDialog} />
    <Dialog open={management.deleteTarget !== null} onOpenChange={(open) => { if (!open) managementController.cancelDelete() }}><DialogContent className="z-[260]" overlayClassName="z-[250]"><DialogTitle>删除连接</DialogTitle><DialogDescription>删除「{source.label}」的本地连接配置及已保存密码，不会删除数据库中的表和数据。</DialogDescription><DialogFooter><Button variant="outline" onClick={managementController.cancelDelete}>取消</Button><Button variant="destructive" onClick={managementController.confirmDelete}>删除连接</Button></DialogFooter></DialogContent></Dialog>
  </>
}
