import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createStore, Provider } from 'jotai'
import type { ServerOpsDataSource } from '@proma/shared'
import { ServerOpsDataConnectionView } from './ServerOpsDataConnectionView'
import type { ServerOpsDataPanelApi } from './ServerOpsDataServicesPanel'
import { createServerOpsDatabaseNavigation, getServerOpsDatabaseReadIdentity, serverOpsDatabaseNavigationAtom } from '@/atoms/server-ops-database-atoms'
import { ServerOpsWorkspaceToolbar } from './ServerOpsWorkspaceToolbar'
import type { ServerOpsWorkspaceToolbarContent } from './ServerOpsWorkspaceToolbar'

/** 复用生产顶部导航，静态夹具不发起项目或授权读取。 */
function renderWorkspaceToolbar(content: ServerOpsWorkspaceToolbarContent = {}): React.ReactNode {
  return <ServerOpsWorkspaceToolbar projects={[{ id: 'project-1', name: '生产环境', createdAt: 1, updatedAt: 1 }]} projectId="project-1" onSelectProject={() => undefined} {...content} actions={<button>Agent 只读授权</button>} />
}

/** 直连的数据库连接。 */
function createDirectSource(overrides: Partial<ServerOpsDataSource> = {}): ServerOpsDataSource {
  return {
    id: 'source-1',
    projectId: 'project-1',
    transport: 'direct',
    engine: 'mysql',
    label: '业务主库',
    address: '127.0.0.1',
    port: 13306,
    username: 'monitor',
    tlsMode: 'disabled',
    hasPassword: true,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

/** 静态渲染不需要真实 IPC 的假 API。 */
const api: ServerOpsDataPanelApi = {
  listServerOpsDataSources: async () => ({ sources: [] }),
  upsertServerOpsDataSource: async () => ({ source: createDirectSource() }),
  deleteServerOpsDataSource: async () => undefined,
  probeServerOpsDataSource: async () => ({ engine: 'mysql', capability: 'available', warnings: [] }),
  diagnoseServerOpsDataSource: async (input) => ({
    sourceId: input.sourceId, engine: 'mysql', capability: 'available', collectedAt: 1, metrics: [], tables: [], warnings: [],
  }),
  revealServerOpsDataSourcePassword: async () => ({ password: 'p@ssw0rd' }),
  listServerOpsDataSchemaTables: async (input) => ({ databases: ['app'], tables: [], ...(input.database === undefined ? {} : { database: input.database }) }),
  describeServerOpsDataSchemaTable: async () => ({ columns: [], indexes: [] }),
  readServerOpsDataSchemaRows: async (input) => ({ columns: [], rows: [], offset: input.offset, limit: input.limit, truncated: false }),
  readServerOpsDataSchemaCell: async () => ({ value: '完整内容' }),
}

/** 渲染数据连接详情视图。 */
function renderView(overrides: Partial<React.ComponentProps<typeof ServerOpsDataConnectionView>> = {}): string {
  return renderToStaticMarkup(
    <ServerOpsDataConnectionView
      api={api}
      source={createDirectSource()}
      projectLabel="生产环境"
      jumpHost={null}
      renderWorkspaceToolbar={renderWorkspaceToolbar}
      onOpenDrawer={() => undefined}
      onBackToProject={() => undefined}
      {...overrides}
    />,
  )
}

describe('数据连接详情视图', () => {
  test('Given MySQL 数据库工作台 When 首次渲染 Then 依次展示项目连接、范围选库、功能页签', () => {
    /** 身份在前、范围在后；选库器只出现一次，未选库不展示空表目录。 */
    const html = renderView()
    expect(html.match(/aria-label="切换运维项目"/g)).toHaveLength(1)
    expect(html.match(/aria-label="选择数据库"/g)).toHaveLength(1)
    expect(html).toContain('aria-label="工作台范围"')
    expect(html).toContain('data-server-ops-database-scope-toolbar')
    expect(html).toContain('data-server-ops-database-selector-compact="true"')
    expect(html.indexOf('data-server-ops-data-connection-view')).toBeLessThan(html.indexOf('data-server-ops-workspace-toolbar'))
    expect(html.indexOf('aria-label="切换运维项目"')).toBeLessThan(html.indexOf('aria-label="选择数据库"'))
    expect(html.indexOf('data-server-ops-connection-module')).toBeLessThan(html.indexOf('aria-label="工作台范围"'))
    expect(html.indexOf('aria-label="工作台范围"')).toBeLessThan(html.indexOf('aria-label="选择数据库"'))
    expect(html.indexOf('aria-label="选择数据库"')).toBeLessThan(html.indexOf('aria-label="数据库功能"'))
    expect(html).not.toContain('aria-label="打开表目录"')
    expect(html).not.toContain('aria-label="表目录宽度"')
    expect(html).toContain('从上方选择数据库，再选择表查看数据与结构。')
    expect(html).toContain('aria-label="数据库功能"')
    expect(html).toContain('data-server-ops-database-page-tabs="database"')
    expect(html).not.toContain('运行诊断')
    expect(html).not.toContain('实例参数')
    expect(html).not.toContain('trigger-logs')
    expect(html).toContain('语句分析')
  })

  test('Given 上次处于实例会话 When 恢复导航 Then 无选库器且实例菜单完整', () => {
    /** 注入真实轻导航 store，验证组件恢复而非仅检查标签配置。 */
    const store = createStore()
    const source = createDirectSource()
    const navigation = { ...createServerOpsDatabaseNavigation(getServerOpsDatabaseReadIdentity(source)), section: 'instance' as const, instancePage: 'sessions' as const }
    store.set(serverOpsDatabaseNavigationAtom, new Map([[JSON.stringify(['scope-test', source.id]), navigation]]))
    const html = renderToStaticMarkup(<Provider store={store}><ServerOpsDataConnectionView api={api} source={source} projectLabel="生产环境" jumpHost={null} renderWorkspaceToolbar={renderWorkspaceToolbar} viewScope="scope-test" onOpenDrawer={() => undefined} onBackToProject={() => undefined} /></Provider>)
    expect(html).not.toContain('aria-label="选择数据库"')
    expect(html).toContain('aria-label="切换运维项目"')
    expect(html).toContain('aria-label="实例功能"')
    expect(html).toContain('data-server-ops-database-page-tabs="instance"')
    expect(html).toContain('总览')
    expect(html).toContain('实例参数')
    expect(html).toContain('语句分析')
    expect(html).toContain('全部数据库')
    expect(html).not.toContain('等待选择数据库')
    expect(html).not.toContain('trigger-logs')
  })

  test('Given 直连的数据库连接 When 渲染 Then 展示连接身份、项目与返回项目入口', () => {
    const html = renderView()
    expect(html).toContain('data-server-ops-data-connection-view="source-1"')
    /** 项目只在统一选择器出现，连接身份不再重复项目面包屑。 */
    expect(html).not.toContain('data-server-ops-connection-project')
    expect(html).toContain('data-server-ops-connection-module')
    expect(html).toContain('生产环境')
    expect(html).toContain('业务主库')
    /** 第二行是这条连接的完整身份（地址、库、用户、密码状态、链路）。 */
    expect(html).toContain('data-server-ops-connection-detail')
    expect(html).toContain('127.0.0.1:13306')
    expect(html).not.toContain('已保存密码')
    expect(html).toContain('数据浏览')
    expect(html).toContain('SQL 查询')
    expect(html).toContain('aria-label="工作台范围"')
    expect(html).toContain('语句分析')
    expect(html).toContain('aria-label="连接操作"')
    expect(html).toContain('aria-label="展开工作台"')
    expect(html).toContain('MySQL')
    expect(html).toContain('aria-label="返回项目连接"')
    /** 数据连接直接进入只读诊断，不出现 SSH 能力页签（页签导航的 aria-label 是"服务器控制台"）。 */
    expect(html).not.toContain('aria-label="服务器控制台"')
    /**
     * 连接自身的地址、库、用户与链路说明由面板头部承担（静态渲染时面板还没有绑定上下文，
     * 因此那部分在 ServerOpsDataServicesPanel.test.tsx 里按聚焦投影验证）。
     */
  })

  test('Given Redis 连接 When 渲染 Then 引擎与图标按 Redis 展示', () => {
    const html = renderView({ source: createDirectSource({ engine: 'redis', label: '会话缓存', port: 16379, database: '0' }) })
    expect(html).toContain('会话缓存')
    expect(html).toContain('Redis')
    expect(html).toContain('aria-label="切换运维项目"')
    expect(html).not.toContain('aria-label="选择数据库"')
  })

  test('Given SQLite 连接 When 渲染 Then 显示文件路径且工作台只保留数据浏览与 SQL 查询', () => {
    const html = renderView({
      source: createDirectSource({
        transport: 'ssh', hostId: 'host-1', engine: 'sqlite', label: '审计文件',
        filePath: '/srv/data/audit.sqlite3', database: 'main', address: undefined, port: undefined,
      }),
      jumpHost: { id: 'host-1', label: '生产 API', description: 'deploy@10.0.0.8:22', connected: true },
    })
    expect(html).toContain('SQLite')
    expect(html).toContain('/srv/data/audit.sqlite3')
    expect(html).toContain('数据浏览')
    expect(html).toContain('SQL 查询')
    expect(html).toContain('aria-label="切换运维项目"')
    expect(html).not.toContain('aria-label="选择数据库"')
    expect(html).not.toContain('aria-label="工作台范围"')
    expect(html).not.toContain('会话')
    expect(html).not.toContain('语句分析')
    expect(html).not.toContain('实例参数')
  })

  test('Given 经跳板连接 When 渲染 Then 第二行说明跳板主机而不是只写"经跳板"', () => {
    const withHost = renderView({
      source: createDirectSource({ transport: 'ssh', hostId: 'host-1' }),
      jumpHost: { id: 'host-1', label: '生产 API', description: 'deploy@10.0.0.8:22', connected: false },
    })
    expect(withHost).toContain('经跳板 生产 API')
    /** 跳板主机已被删除时必须如实说明，而不是让人以为链路还在。 */
    const withoutHost = renderView({ source: createDirectSource({ transport: 'ssh', hostId: 'host-deleted' }), jumpHost: null })
    expect(withoutHost).toContain('经跳板 （跳板服务器已删除）')
  })

  test('Given 内网明文直连 When 渲染 Then 标注内网明文而不是假装已加密', () => {
    const html = renderView({ source: createDirectSource({ address: '172.16.10.198' }) })
    expect(html).toContain('data-server-ops-plaintext-direct="source-1"')
    expect(html).toContain('内网明文')
  })

  test('Given 公网开启证书校验 When 渲染 Then 不出现明文标记', () => {
    const html = renderView({
      source: createDirectSource({ address: '8.8.8.8', tlsMode: 'verify', tlsServerName: 'db.example.com' }),
    })
    expect(html).not.toContain('data-server-ops-plaintext-direct')
  })

  test('Given 内网选择优先 TLS When 渲染 Then 不将可能的回退当成已发生的明文', () => {
    const html = renderView({ source: createDirectSource({ address: '172.16.10.198', tlsMode: 'preferred' }) })
    expect(html).not.toContain('data-server-ops-plaintext-direct')
  })
})
