import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ServerOpsDataRowFilters, ServerOpsDataSourceRowsInput } from '@proma/shared'
import {
  createServerOpsSchemaBrowserController,
  createServerOpsSchemaIdleProjection,
  ServerOpsDatabaseSelector,
  SchemaRowsGrid,
  ServerOpsSchemaBrowserView,
} from './ServerOpsSchemaBrowser'
import type { ServerOpsSchemaBrowserApi, ServerOpsSchemaBrowserProjection } from './ServerOpsSchemaBrowser'

/** 可控 Promise，用于验证迟到结果被丢弃。 */
interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

/** 创建可控 Promise。 */
function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((nextResolve, nextReject) => { resolve = nextResolve; reject = nextReject })
  return { promise, resolve, reject }
}

/** 假 API：默认返回库 `app` 下两张表。 */
function createApi(overrides: Partial<ServerOpsSchemaBrowserApi> = {}): ServerOpsSchemaBrowserApi {
  return {
    listServerOpsDataSchemaTables: async (input) => ({
      databases: ['app', 'chebenben'],
      tables: [
        { name: 'users', engine: 'InnoDB', rows: 12, sizeBytes: 16_384 },
        { name: 'orders', engine: 'InnoDB', rows: 3 },
      ],
      database: input.database ?? 'app',
    }),
    describeServerOpsDataSchemaTable: async () => ({
      columns: [{ name: 'id', type: 'int unsigned', nullable: false, primaryKey: true }],
      indexes: [{ name: 'PRIMARY', unique: true, columns: ['id'] }],
    }),
    readServerOpsDataSchemaRows: async (input) => ({
      columns: ['id', 'name'],
      rows: [[String(input.offset + 1), 'alice']],
      offset: input.offset,
      limit: input.limit,
      truncated: false,
      totalEstimate: 120,
    }),
    ...overrides,
  }
}

/** 创建控制器并收集投影。 */
function createHarness(api: ServerOpsSchemaBrowserApi): { controller: ReturnType<typeof createServerOpsSchemaBrowserController>; projections: ServerOpsSchemaBrowserProjection[] } {
  const projections: ServerOpsSchemaBrowserProjection[] = []
  const controller = createServerOpsSchemaBrowserController({ api, pageSize: 50, publish: (projection) => projections.push(projection) })
  controller.activate()
  return { controller, projections }
}

/** 等待异步链路推进。 */
async function flush(): Promise<void> {
  /** 推进协调队列及 API 回执，不依赖真实计时器。 */
  for (let tick = 0; tick < 30; tick += 1) await Promise.resolve()
}

describe('数据连接表浏览', () => {
  test('Given 50×100 个单元格 When 渲染行网格 Then 每格展示文本只读取一次', () => {
    /** 用 getter 计数真实格式化路径，不用不稳定的墙钟时间作为性能断言。 */
    let reads = 0
    const cell = { kind: 'text' as const, truncated: true as const, get text() { reads += 1; return '预览' } }
    const columns = Array.from({ length: 100 }, (_, index) => `column_${index}`)
    const rows = Array.from({ length: 50 }, () => Array.from({ length: 100 }, () => cell))
    const html = renderToStaticMarkup(<SchemaRowsGrid columns={columns} rows={rows} offset={0} />)
    expect(reads).toBe(5_000)
    expect(html).toContain('title="预览…（已截断）"')
  })

  test('Given 旧后台不认识筛选字段 When 应用条件 Then 显示完整重启提示并保留条件', async () => {
    /** 正常无筛选读取可用，模拟热更新后的旧主进程拒绝扩展合同。 */
    const base = createApi()
    const { controller } = createHarness(createApi({ readServerOpsDataSchemaRows: async (input) => {
      if (input.filters) throw new Error('SERVER_OPS_DATA_SCHEMA_ROWS_INPUT_INVALID')
      return base.readServerOpsDataSchemaRows(input)
    } }))
    controller.setSource({ id: 'source-1', engine: 'mysql' }); await flush()
    controller.openTable('users'); await flush()
    controller.applyRowFilters({ match: 'all', conditions: [{ column: 'id', operator: 'eq', value: '1' }] }); await flush()
    expect(controller.getProjection().rows.status).toBe('error')
    expect(controller.getProjection().rows.error).toBe('当前后台尚不支持筛选参数，请完整退出并重新启动客户端后重试')
    expect(controller.getProjection().rowFilters?.conditions).toHaveLength(1)
  })
  test('Given 无匹配行的已应用筛选 When 渲染数据页 Then 保留筛选入口和状态且不显示整表估算', () => {
    /** 故意携带整表估算，验证界面不会将其误标成匹配总数。 */
    const projection: ServerOpsSchemaBrowserProjection = {
      ...createServerOpsSchemaIdleProjection(), sourceId: 'source-1', engine: 'mysql', database: 'app', selectedTable: 'users', status: 'ready',
      rowFilters: { match: 'all', conditions: [{ column: 'id', operator: 'gt', value: '9000' }] },
      rows: { status: 'ready', error: null, columns: ['id'], rows: [], offset: 0, limit: 50, truncated: false, totalEstimate: 120 },
    }
    const html = renderToStaticMarkup(<ServerOpsSchemaBrowserView projection={projection} onSelectDatabase={() => undefined} onOpenTable={() => undefined} onBackToList={() => undefined} onDetailTabChange={() => undefined} onLoadRows={() => undefined} onRefresh={() => undefined} onApplyRowFilters={() => undefined} onLoadFilterFields={() => undefined} />)
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('筛选结果')
    expect(html).toContain('没有符合筛选条件的记录')
    expect(html).not.toContain('约 120 行')
  })

  test('Given 筛选字段已经载入 When 刷新目录 Then 等目录失效结束再读取字段', async () => {
    /** 目录刷新在途时不允许字段命中即将失效的后端缓存。 */
    const catalog = createDeferred<Awaited<ReturnType<ServerOpsSchemaBrowserApi['listServerOpsDataSchemaTables']>>>()
    const base = createApi()
    let catalogCalls = 0
    let structureCalls = 0
    const { controller } = createHarness(createApi({
      listServerOpsDataSchemaTables: async (input) => ++catalogCalls === 1 ? base.listServerOpsDataSchemaTables(input) : catalog.promise,
      describeServerOpsDataSchemaTable: async (input) => { structureCalls += 1; return base.describeServerOpsDataSchemaTable(input) },
    }))
    controller.setSource({ id: 'source-1', engine: 'mysql' }); await flush()
    controller.openTable('users'); await flush()
    controller.loadFilterFields(); await flush()
    controller.refreshTables()
    controller.loadFilterFields(); await flush()
    expect(structureCalls).toBe(1)
    catalog.resolve(await base.listServerOpsDataSchemaTables({ sourceId: 'source-1', database: 'app' })); await flush()
    controller.loadFilterFields(); await flush()
    expect(structureCalls).toBe(2)
  })

  test('Given 数据浏览尚未读取字段 When 打开筛选两次 Then 按需读取一次结构且不重读数据', async () => {
    /** 分别记录字段与数据读取次数，确保展开面板不会自动查询。 */
    const calls = { structure: 0, rows: 0 }
    /** 复用正常目录与结构夹具。 */
    const base = createApi()
    const { controller } = createHarness(createApi({
      describeServerOpsDataSchemaTable: (input) => { calls.structure += 1; return base.describeServerOpsDataSchemaTable(input) },
      readServerOpsDataSchemaRows: (input) => { calls.rows += 1; return base.readServerOpsDataSchemaRows(input) },
    }))
    controller.setSource({ id: 'source-1', engine: 'mysql' }); await flush()
    controller.openTable('users'); await flush()
    expect(calls).toEqual({ structure: 0, rows: 1 })
    controller.loadFilterFields(); controller.loadFilterFields(); await flush()
    controller.loadFilterFields(); await flush()
    expect(calls).toEqual({ structure: 1, rows: 1 })
    expect(controller.getProjection().detailTab).toBe('data')
  })

  test('Given 多字段筛选 When 应用翻页刷新并切表 Then 页码归零、保留条件且目标变化后清空', async () => {
    /** 捕获完整请求，区分筛选分页与无筛选分页。 */
    const requests: ServerOpsDataSourceRowsInput[] = []
    const base = createApi()
    const { controller } = createHarness(createApi({ readServerOpsDataSchemaRows: (input) => {
      requests.push(input); return base.readServerOpsDataSchemaRows(input)
    } }))
    /** 含空字符串与 NULL 的组合不会被当作未填值。 */
    const filters: ServerOpsDataRowFilters = { match: 'any', conditions: [{ column: 'name', operator: 'eq', value: '' }, { column: 'id', operator: 'is-not-null' }] }
    controller.setSource({ id: 'source-1', engine: 'mysql' }); await flush()
    controller.openTable('users'); await flush(); controller.loadRows(50); await flush()
    controller.applyRowFilters(filters); await flush()
    expect(requests.at(-1)).toMatchObject({ filters, offset: 0 })
    /** 应用后复制条件，外部草稿再改动不会改变当前查询身份。 */
    filters.conditions[0]!.value = 'changed-draft'
    controller.loadRows(50); await flush(); controller.refresh(); await flush()
    expect(requests.at(-1)).toMatchObject({ offset: 50, filters: { match: 'any', conditions: [{ column: 'name', operator: 'eq', value: '' }, { column: 'id', operator: 'is-not-null' }] } })
    controller.applyRowFilters(null); await flush()
    expect(requests.at(-1)).not.toHaveProperty('filters')
    expect(requests.at(-1)?.offset).toBe(0)
    controller.applyRowFilters(filters); await flush(); controller.openTable('orders'); await flush()
    expect(controller.getProjection().rowFilters).toBeNull()
    expect(requests.at(-1)).toMatchObject({ table: 'orders', offset: 0 })
    expect(requests.at(-1)).not.toHaveProperty('filters')
  })

  test('Given 同页旧查询未完成 When 连续应用两组筛选 Then 丢弃旧回执并仅执行最新排队条件', async () => {
    /** 首轮无筛选请求尚未结束。 */
    const stale = createDeferred<Awaited<ReturnType<ServerOpsSchemaBrowserApi['readServerOpsDataSchemaRows']>>>()
    const requests: ServerOpsDataSourceRowsInput[] = []
    const { controller, projections } = createHarness(createApi({ readServerOpsDataSchemaRows: async (input) => {
      requests.push(input)
      return input.filters ? { columns: ['id'], rows: [['filtered']], offset: input.offset, limit: input.limit, truncated: false } : stale.promise
    } }))
    controller.setSource({ id: 'source-1', engine: 'mysql' }); await flush(); controller.openTable('users'); await flush()
    controller.applyRowFilters({ match: 'all', conditions: [{ column: 'id', operator: 'eq', value: '1' }] })
    controller.applyRowFilters({ match: 'all', conditions: [{ column: 'id', operator: 'eq', value: '2' }] })
    expect(controller.getProjection().rows.rows).toEqual([])
    stale.resolve({ columns: ['id'], rows: [['stale']], offset: 0, limit: 50, truncated: false }); await flush()
    expect(requests).toHaveLength(2)
    expect(requests[1]?.filters?.conditions[0]?.value).toBe('2')
    expect(controller.getProjection().rows.rows).toEqual([['filtered']])
    expect(projections.some((projection) => projection.rows.rows.some((row) => row[0] === 'stale'))).toBe(false)
  })

  test('Given 筛选结果已翻页 When 连接断开重连 Then 清除条件并从未筛选首页恢复', async () => {
    /** 条件不进入持久导航，因此断线时同步归零与条件有关的页码。 */
    const { controller } = createHarness(createApi())
    const source = { id: 'source-1', engine: 'mysql' as const }
    controller.setSource(source); await flush(); controller.openTable('users'); await flush()
    controller.applyRowFilters({ match: 'all', conditions: [{ column: 'id', operator: 'gt', value: '5' }] }); await flush()
    controller.loadRows(50); await flush()
    controller.setSource(source, false); controller.setSource(source, true); await flush()
    expect(controller.getProjection().rowFilters).toBeNull()
    expect(controller.getProjection().rows.offset).toBe(0)
  })

  test('Given 目录刷新在途 When 切到结构页并收到旧字段 Then 丢弃旧结果并强制刷新结构', async () => {
    /** 控制目录和字段回执顺序，复现两个页签读取交错。 */
    const catalog = createDeferred<{ databases: string[]; database: string; tables: { name: string }[] }>()
    const stale = createDeferred<{ columns: { name: string; type: string; nullable: boolean; primaryKey: boolean }[]; indexes: [] }>()
    const modes: string[] = []
    let catalogs = 0
    const base = createApi()
    const { controller, projections } = createHarness(createApi({
      listServerOpsDataSchemaTables: async (input) => ++catalogs === 1 ? base.listServerOpsDataSchemaTables(input) : catalog.promise,
      describeServerOpsDataSchemaTable: async (input) => {
        modes.push(input.cacheMode ?? 'live')
        return input.cacheMode === 'refresh' ? base.describeServerOpsDataSchemaTable(input) : stale.promise
      },
    }))
    controller.setSource({ id: 'source-1', engine: 'mysql', database: 'app' }); await flush()
    controller.openTable('users'); await flush(); controller.refreshTables(); controller.setDetailTab('structure'); await flush()
    catalog.resolve({ database: 'app', databases: ['app'], tables: [{ name: 'users' }] }); await flush()
    stale.resolve({ columns: [{ name: 'stale', type: 'int', nullable: true, primaryKey: false }], indexes: [] }); await flush()
    expect(modes).toEqual(['prefer-cache', 'refresh'])
    expect(projections.some((projection) => projection.structure.columns.some((column) => column.name === 'stale'))).toBe(false)
    expect(controller.getProjection().structure.columns[0]?.name).toBe('id')
  })
  test('Given 缓存浏览 When 手动刷新目录或结构 Then 绕过缓存且数据行保持实时', async () => {
    /** 按操作记录缓存策略，避免刷新按钮误读旧结构。 */
    const calls: string[] = []
    const base = createApi()
    const { controller } = createHarness(createApi({
      listServerOpsDataSchemaTables: async (input) => { calls.push(`tables:${input.cacheMode}`); return base.listServerOpsDataSchemaTables(input) },
      describeServerOpsDataSchemaTable: async (input) => { calls.push(`structure:${input.cacheMode}`); return base.describeServerOpsDataSchemaTable(input) },
      readServerOpsDataSchemaRows: async (input) => { expect(Object.hasOwn(input, 'cacheMode')).toBe(false); return base.readServerOpsDataSchemaRows(input) },
    }))
    controller.setSource({ id: 'source-1', engine: 'mysql', database: 'app' }); await flush()
    controller.openTable('users'); await flush(); controller.setDetailTab('structure'); await flush()
    controller.refresh(); await flush(); controller.refreshTables(); await flush()
    expect(calls.slice(0, 4)).toEqual(['tables:prefer-cache', 'structure:prefer-cache', 'structure:refresh', 'tables:refresh'])
  })
  test('Given MySQL 连接 When 绑定 Then 自动读取库与表清单', async () => {
    const { controller } = createHarness(createApi())
    controller.setSource({ id: 'source-1', engine: 'mysql', database: 'app' })
    await flush()

    const projection = controller.getProjection()
    expect(projection.status).toBe('ready')
    expect(projection.databases).toEqual(['app', 'chebenben'])
    expect(projection.database).toBe('app')
    expect(projection.tables.map((table) => table.name)).toEqual(['users', 'orders'])
  })

  test('Given SQLite 连接 When 绑定 Then 读取固定 main 库的表清单', async () => {
    const { controller } = createHarness(createApi({
      listServerOpsDataSchemaTables: async () => ({ databases: ['main'], database: 'main', tables: [{ name: 'events' }] }),
    }))
    controller.setSource({ id: 'source-sqlite', engine: 'sqlite', database: 'main' })
    await flush()
    expect(controller.getProjection()).toMatchObject({
      engine: 'sqlite', status: 'ready', databases: ['main'], database: 'main', tables: [{ name: 'events' }],
    })
  })

  test('Given Redis 连接 When 绑定 Then 只发布不支持提示且不发请求', async () => {
    /** 记录实际发出的调用。 */
    const calls: string[] = []
    const { controller } = createHarness(createApi({
      listServerOpsDataSchemaTables: async (input) => {
        calls.push(`list:${input.sourceId}`)
        return { databases: [], tables: [] }
      },
    }))
    controller.setSource({ id: 'source-redis', engine: 'redis' })
    await flush()

    expect(calls).toEqual([])
    expect(controller.getProjection().engine).toBe('redis')
    expect(controller.getProjection().status).toBe('idle')
  })

  test('Given 打开一张表 When 默认进入数据 Then 按需读取数据且结构与索引复用', async () => {
    /** 记录行读取的偏移。 */
    const offsets: number[] = []
    const { controller } = createHarness(createApi({
      readServerOpsDataSchemaRows: async (input) => {
        offsets.push(input.offset)
        return { columns: ['id'], rows: [[String(input.offset + 1)]], offset: input.offset, limit: input.limit, truncated: false }
      },
    }))
    controller.setSource({ id: 'source-1', engine: 'mysql', database: 'app' })
    await flush()
    controller.openTable('users')
    await flush()
    expect(controller.getProjection().selectedTable).toBe('users')
    expect(controller.getProjection().detailTab).toBe('data')
    expect(controller.getProjection().structure.status).toBe('idle')
    expect(offsets).toEqual([0])

    controller.setDetailTab('data')
    await flush()
    expect(offsets).toEqual([0])
    expect(controller.getProjection().rows.rows).toEqual([['1']])

    controller.loadRows(50)
    await flush()
    expect(offsets).toEqual([0, 50])
    expect(controller.getProjection().rows.rows).toEqual([['51']])

    controller.setDetailTab('structure')
    await flush()
    expect(controller.getProjection().structure.columns[0]?.name).toBe('id')
    controller.setDetailTab('indexes')
    expect(controller.getProjection().structure.indexes[0]?.name).toBe('PRIMARY')

    controller.backToList()
    expect(controller.getProjection().selectedTable).toBeNull()
    expect(controller.getProjection().rows.status).toBe('idle')
  })

  test('Given 切库 While 旧清单请求迟到 Then 不覆盖新库结果', async () => {
    /** 第一次清单请求（app 库）可控结算。 */
    const firstList = createDeferred<{ databases: string[]; tables: { name: string }[]; database?: string }>()
    let listCalls = 0
    const { controller } = createHarness(createApi({
      listServerOpsDataSchemaTables: async (input) => {
        listCalls += 1
        if (listCalls === 1) return firstList.promise as never
        return { databases: ['app', 'chebenben'], tables: [{ name: 'cb_payment' }], database: input.database }
      },
    }))
    controller.setSource({ id: 'source-1', engine: 'mysql', database: 'app' })
    await Promise.resolve()
    controller.selectDatabase('chebenben')
    await flush()
    /** 旧库的迟到结果不得写回，否则界面会把 app 的表显示成 chebenben 的表。 */
    firstList.resolve({ databases: ['app', 'chebenben'], tables: [{ name: 'users' }], database: 'app' })
    await flush()

    const projection = controller.getProjection()
    expect(projection.database).toBe('chebenben')
    expect(projection.tables.map((table) => table.name)).toEqual(['cb_payment'])
  })

  test('Given 读取失败 When 渲染视图 Then 给出原因与重试而不是空白', async () => {
    const { controller } = createHarness(createApi({
      listServerOpsDataSchemaTables: async () => { throw new Error('SERVER_OPS_DATA_SCHEMA_UNAVAILABLE: 认证失败（ER_ACCESS_DENIED_ERROR）') },
    }))
    controller.setSource({ id: 'source-1', engine: 'mysql', database: 'app' })
    await flush()

    const projection = controller.getProjection()
    expect(projection.status).toBe('error')
    expect(projection.error).toBe('认证失败（ER_ACCESS_DENIED_ERROR）')
    const html = renderToStaticMarkup(
      <ServerOpsSchemaBrowserView
        projection={projection}
        onSelectDatabase={() => undefined}
        onOpenTable={() => undefined}
        onBackToList={() => undefined}
        onDetailTabChange={() => undefined}
        onLoadRows={() => undefined}
        onRefresh={() => undefined}
      />,
    )
    expect(html).toContain('认证失败（ER_ACCESS_DENIED_ERROR）')
    expect(html).toContain('重试')
  })

  test('Given 表清单就绪 When 渲染 Then 列出表并在点表后展示结构与数据页签', async () => {
    const { controller } = createHarness(createApi())
    controller.setSource({ id: 'source-1', engine: 'mysql', database: 'app' })
    await flush()
    /** 渲染属性与回调由测试直接提供，验证的是视图形状。 */
    const render = (projection: ServerOpsSchemaBrowserProjection): string => renderToStaticMarkup(
      <ServerOpsSchemaBrowserView
        projection={projection}
        onSelectDatabase={() => undefined}
        onOpenTable={() => undefined}
        onBackToList={() => undefined}
        onDetailTabChange={() => undefined}
        onLoadRows={() => undefined}
        onRefresh={() => undefined}
      />,
    )
    const listHtml = render(controller.getProjection())
    expect(listHtml).toContain('data-server-ops-schema-table="users"')
    expect(listHtml).toContain('InnoDB · 约 12 行 · 16.0 KiB')
    expect(listHtml).toContain('选择数据库')

    controller.openTable('users')
    await flush()
    const detailHtml = render(controller.getProjection())
    expect(detailHtml).toContain('data-server-ops-schema-table-detail="users"')
    expect(detailHtml).toContain('data-server-ops-schema-detail-tab="structure"')
    expect(detailHtml).toContain('data-server-ops-schema-detail-tab="data"')
    expect(detailHtml).toContain('data-server-ops-schema-table="orders"')
    expect(detailHtml).toContain('data-server-ops-schema-detail-tab="indexes"')
    expect(detailHtml).toContain('data-server-ops-schema-detail-tab="properties"')
    expect(detailHtml).toContain('alice')
  })

  test('Given 工作台组合选库 When 紧凑渲染 Then 使用可嵌入样式且不改变默认工具栏', async () => {
    const { controller } = createHarness(createApi())
    controller.setSource({ id: 'source-1', engine: 'mysql', database: 'app' })
    await flush()
    const projection = controller.getProjection()
    const compactHtml = renderToStaticMarkup(<ServerOpsDatabaseSelector compact projection={projection} onSelectDatabase={() => undefined} onRefresh={() => undefined} />)
    const defaultHtml = renderToStaticMarkup(<ServerOpsDatabaseSelector projection={projection} onSelectDatabase={() => undefined} onRefresh={() => undefined} />)
    expect(compactHtml).toContain('data-server-ops-database-selector-compact="true"')
    expect(compactHtml).toContain('aria-label="选择数据库"')
    expect(defaultHtml).not.toContain('data-server-ops-database-selector-compact')
    expect(defaultHtml).toContain('data-server-ops-database-selector')
  })

  test('Given 刷新遇到单飞冲突 When 读取 Then 保留上一次清单而不是卡在加载中', async () => {
    /** 第一次返回真实清单，之后模拟"上一次读取还在跑"。 */
    let calls = 0
    const { controller } = createHarness(createApi({
      listServerOpsDataSchemaTables: async (input) => {
        calls += 1
        if (calls === 1) return { databases: ['app'], tables: [{ name: 'users' }], database: input.database }
        throw new Error('SERVER_OPS_DATA_SOURCE_BUSY')
      },
    }))
    controller.setSource({ id: 'source-1', engine: 'mysql', database: 'app' })
    await flush()
    expect(controller.getProjection().tables.map((table) => table.name)).toEqual(['users'])

    controller.refresh()
    await flush()
    /** BUSY 有可见错误与重试，保留成功清单，不能恢复到无人负责的 loading。 */
    expect(controller.getProjection().status).toBe('error')
    expect(controller.getProjection().tables.map((table) => table.name)).toEqual(['users'])
  })

  test('Given StrictMode setup cleanup setup When 首读未结束 Then 新 owner 收到同一读取结果', async () => {
    /** 库目录仍在底层连接中读取。 */
    const pending = createDeferred<{ databases: string[]; tables: { name: string }[]; database: string }>()
    /** 统计底层实际请求。 */
    let calls = 0
    /** 两次 setup 共用的控制器。 */
    const { controller } = createHarness(createApi({ listServerOpsDataSchemaTables: () => { calls += 1; return pending.promise } }))
    controller.setSource({ id: 'source-1', engine: 'mysql', database: 'app' })
    await Promise.resolve()
    controller.dispose()
    controller.activate()
    controller.setSource({ id: 'source-1', engine: 'mysql', database: 'app' })
    pending.resolve({ databases: ['app'], tables: [{ name: 'users' }], database: 'app' })
    await flush()
    expect(calls).toBe(1)
    expect(controller.getProjection().status).toBe('ready')
  })

  test('Given 同 ID 配置更新 When 旧行结果迟到 Then 旧配置结果不得覆盖新配置', async () => {
    /** 旧配置行回执。 */
    const pending = createDeferred<Awaited<ReturnType<ServerOpsSchemaBrowserApi['readServerOpsDataSchemaRows']>>>()
    /** 旧配置读取暂不结束。 */
    const { controller } = createHarness(createApi({ readServerOpsDataSchemaRows: () => pending.promise }))
    controller.setSource({ id: 'source-1', engine: 'mysql', database: 'app', updatedAt: 1 })
    await flush()
    controller.openTable('users')
    await Promise.resolve()
    controller.setSource({ id: 'source-1', engine: 'mysql', database: 'chebenben', updatedAt: 2 })
    pending.resolve({ columns: ['id'], rows: [['old-secret']], offset: 0, limit: 50, truncated: false })
    await flush()
    expect(controller.getProjection().selectedTable).toBeNull()
    expect(controller.getProjection().rows.rows).toEqual([])
  })

  test('Given 非默认库的第 2 页 When 跳板断开再重连 Then 重新验证目录并恢复库表页码', async () => {
    /** 断线恢复期间只保存轻导航，不保留旧业务行。 */
    const { controller } = createHarness(createApi())
    /** 同一个有效连接配置，SSH 可达性独立变化。 */
    const source = { id: 'source-1', engine: 'mysql' as const, database: 'app', updatedAt: 1 }
    controller.setSource(source)
    await flush()
    controller.selectDatabase('chebenben')
    await flush()
    controller.openTable('users')
    await flush()
    controller.loadRows(50)
    await flush()

    controller.setSource(source, false)
    expect(controller.getProjection().rows.rows).toEqual([])
    expect(controller.getProjection().status).toBe('idle')
    controller.setSource(source, true)
    await flush()
    expect(controller.getProjection().database).toBe('chebenben')
    expect(controller.getProjection().selectedTable).toBe('users')
    expect(controller.getProjection().rows.offset).toBe(50)
    expect(controller.getProjection().rows.rows[0]?.[0]).toBe('51')
  })

  test('Given 跳板离线时配置发生更新 When 重连 Then 不恢复旧配置的库表', async () => {
    /** 配置更新与短暂断线使用不同失效规则。 */
    const { controller } = createHarness(createApi())
    /** 初始连接身份。 */
    const source = { id: 'source-1', engine: 'mysql' as const, database: 'app', updatedAt: 1 }
    controller.setSource(source)
    await flush()
    controller.openTable('users')
    await flush()
    controller.setSource(source, false)
    controller.setSource({ ...source, updatedAt: 2 }, false)
    controller.setSource({ ...source, updatedAt: 2 }, true)
    await flush()
    expect(controller.getProjection().selectedTable).toBeNull()
    expect(controller.getProjection().rows.rows).toEqual([])
  })

  test('Given 非默认库恢复尚在读取目录 When 跳板再次断线 Then 完整导航不被半成品覆盖', async () => {
    /** 第二轮目标库目录故意迟到，覆盖真实跳板抖动窗口。 */
    const pending = createDeferred<Awaited<ReturnType<ServerOpsSchemaBrowserApi['listServerOpsDataSchemaTables']>>>()
    /** 只让恢复阶段的目标库目录进入等待。 */
    let restoring = false
    const baseApi = createApi()
    const { controller } = createHarness(createApi({ listServerOpsDataSchemaTables: (input) => restoring && input.database === 'chebenben' ? pending.promise : baseApi.listServerOpsDataSchemaTables(input) }))
    /** 保持有效配置不变，只切换跳板许可。 */
    const source = { id: 'source-1', engine: 'mysql' as const, database: 'app', updatedAt: 1 }
    controller.setSource(source)
    await flush()
    controller.selectDatabase('chebenben')
    await flush()
    controller.openTable('users')
    await flush()
    controller.loadRows(50)
    await flush()
    controller.setSource(source, false)
    restoring = true
    controller.setSource(source, true)
    await flush()
    expect(controller.getProjection().status).toBe('loading')
    controller.setSource(source, false)
    controller.setSource(source, true)
    restoring = false
    pending.resolve({ databases: ['app', 'chebenben'], database: 'chebenben', tables: [{ name: 'users' }] })
    await flush()
    expect(controller.getProjection().database).toBe('chebenben')
    expect(controller.getProjection().selectedTable).toBe('users')
    expect(controller.getProjection().rows.offset).toBe(50)
  })

  test('Given 第 2 页切至结构 When 断线恢复再切回数据 Then 保留页码且不预读行', async () => {
    /** 记录恢复结构期间有没有偷偷预读数据。 */
    const offsets: number[] = []
    const baseApi = createApi()
    const { controller } = createHarness(createApi({ readServerOpsDataSchemaRows: (input) => { offsets.push(input.offset); return baseApi.readServerOpsDataSchemaRows(input) } }))
    /** 断线不改变此连接的配置身份。 */
    const source = { id: 'source-1', engine: 'mysql' as const, database: 'app', updatedAt: 1 }
    controller.setSource(source)
    await flush()
    controller.openTable('users')
    await flush()
    controller.loadRows(50)
    await flush()
    controller.setDetailTab('structure')
    await flush()
    controller.setSource(source, false)
    controller.setSource(source, true)
    await flush()
    expect(controller.getProjection().detailTab).toBe('structure')
    expect(controller.getProjection().rows.offset).toBe(50)
    expect(offsets).toEqual([0, 50])
    controller.setDetailTab('data')
    await flush()
    expect(offsets).toEqual([0, 50, 50])
  })

  test('Given 刷新当前数据失败 When 同目标已有结果 Then 保留上次数据并能重新读取', async () => {
    /** 控制后续刷新失败。 */
    let fail = false
    /** 真实投影保留而不是在错误时清空。 */
    const { controller } = createHarness(createApi({ readServerOpsDataSchemaRows: async (input) => {
      if (fail) throw new Error('SERVER_OPS_DATA_SOURCE_BUSY')
      return { columns: ['id'], rows: [['1']], offset: input.offset, limit: input.limit, truncated: false }
    } }))
    controller.setSource({ id: 'source-1', engine: 'mysql', database: 'app' })
    await flush()
    controller.openTable('users')
    await flush()
    fail = true
    controller.refresh()
    await flush()
    expect(controller.getProjection().rows.status).toBe('error')
    expect(controller.getProjection().rows.rows).toEqual([['1']])
    fail = false
    controller.refresh()
    await flush()
    expect(controller.getProjection().rows.status).toBe('ready')
  })

  test('Given Redis 连接 When 渲染表页签 Then 说明暂不支持而不是空壳', () => {
    const html = renderToStaticMarkup(
      <ServerOpsSchemaBrowserView
        projection={{ ...createServerOpsSchemaIdleProjection(), sourceId: 'source-redis', engine: 'redis' }}
        onSelectDatabase={() => undefined}
        onOpenTable={() => undefined}
        onBackToList={() => undefined}
        onDetailTabChange={() => undefined}
        onLoadRows={() => undefined}
        onRefresh={() => undefined}
      />,
    )
    expect(html).toContain('data-server-ops-schema-unsupported')
    expect(html).toContain('Redis')
  })
})
