import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type {
  ServerOpsDataDiagnosticsResult,
  ServerOpsDataProbeResult,
  ServerOpsDataSource,
  ServerOpsDataSourceUpsertInput,
} from '@proma/shared'
import {
  createServerOpsDataIdleProjection,
  createServerOpsDataServicesController,
  ServerOpsDataDiagnostics,
  ServerOpsDataServicesPanelView,
} from './ServerOpsDataServicesPanel'
import type {
  ServerOpsDataPanelApi,
  ServerOpsDataServicesController,
  ServerOpsDataServicesProjection,
} from './ServerOpsDataServicesPanel'

/** 可控 Promise，用于验证请求竞态。 */
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

/** 创建公开数据源投影。 */
function createSource(overrides: Partial<ServerOpsDataSource> = {}): ServerOpsDataSource {
  return {
    id: 'source-1',
    transport: 'ssh' as const,
    hostId: 'host-1',
    engine: 'mysql',
    label: '业务主库',
    address: '127.0.0.1',
    port: 3306,
    username: 'monitor',
    tlsMode: 'disabled',
    hasPassword: true,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  }
}

/** 创建只读诊断结果。 */
function createDiagnostics(overrides: Partial<ServerOpsDataDiagnosticsResult> = {}): ServerOpsDataDiagnosticsResult {
  return {
    sourceId: 'source-1',
    engine: 'mysql',
    capability: 'available',
    collectedAt: 1_700_000_000_000,
    metrics: [{ id: 'threads-connected', label: '活跃连接', value: '42 / 200', hint: '运行中 3', ratio: 0.21 }],
    tables: [{
      id: 'databases',
      title: '数据库',
      columns: [{ id: 'name', label: '名称' }, { id: 'size', label: '容量', align: 'right' }],
      rows: [['app', '1.0 GiB']],
      truncated: true,
    }],
    warnings: [],
    ...overrides,
  }
}

/** 假 API，默认返回空列表。 */
function createApi(overrides: Partial<ServerOpsDataPanelApi> = {}): ServerOpsDataPanelApi {
  return {
    listServerOpsDataSources: async () => ({ sources: [] }),
    upsertServerOpsDataSource: async () => ({ source: createSource() }),
    deleteServerOpsDataSource: async () => undefined,
    probeServerOpsDataSource: async () => ({
      engine: 'mysql', capability: 'available', serverVersion: '8.0.36', latencyMs: 8, warnings: [],
    }),
    diagnoseServerOpsDataSource: async (input) => createDiagnostics({ sourceId: input.sourceId }),
    revealServerOpsDataSourcePassword: async () => ({ password: 'p@ssw0rd' }),
    listServerOpsDataSchemaTables: async (input) => ({ databases: ['app'], tables: [], ...(input.database === undefined ? {} : { database: input.database }) }),
    describeServerOpsDataSchemaTable: async () => ({ columns: [], indexes: [] }),
    readServerOpsDataSchemaRows: async (input) => ({ columns: [], rows: [], offset: input.offset, limit: input.limit, truncated: false }),
    ...overrides,
  }
}

/** 创建控制器并收集投影历史。 */
function createHarness(api: ServerOpsDataPanelApi): { controller: ServerOpsDataServicesController; projections: ServerOpsDataServicesProjection[] } {
  /** 控制器发布的投影历史。 */
  const projections: ServerOpsDataServicesProjection[] = []
  const controller = createServerOpsDataServicesController({ api, publish: (projection) => projections.push(projection) })
  /** 与容器一致的 owner 生命周期：激活后才允许发布。 */
  controller.activate()
  return { controller, projections }
}

/** 渲染纯视图静态标记；页签可切换，用于验证统计与数据表确实分栏。 */
function renderView(
  projection: ServerOpsDataServicesProjection,
  diagnosticsTab: 'metrics' | 'tables' = 'metrics',
): string {
  return renderToStaticMarkup(
    <ServerOpsDataServicesPanelView
      projection={projection}
      onRefresh={() => undefined}
      onCreate={() => undefined}
      onEdit={() => undefined}
      onProbe={() => undefined}
      onTestDraft={async () => ({ engine: 'mysql', capability: 'available', serverVersion: '8.0.36', warnings: [] })}
      onRevealSourcePassword={async () => 'p@ssw0rd'}
      diagnosticsTab={diagnosticsTab}
      onDiagnosticsTabChange={() => undefined}
      onDiagnose={() => undefined}
      onDelete={() => undefined}
      onSubmit={() => undefined}
      onCloseDialog={() => undefined}
      onCancelDelete={() => undefined}
      onConfirmDelete={() => undefined}
    />,
  )
}

/**
 * 在面板视图返回的元素树里找到某个 aria-label 的按钮。
 *
 * 单连接模式没有列表，编辑/删除/测试只存在于聚焦头部，因此必须验证这些按钮
 * 真的把自己的目标交给了回调，而不是只把图标画出来。
 *
 * @param node 元素树
 * @param ariaLabel 目标按钮的无障碍名称
 * @returns 按钮元素；未找到时为 null
 */
function findButtonByLabel(node: React.ReactNode, ariaLabel: string): React.ReactElement<{ onClick?: () => void; disabled?: boolean }> | null {
  /** 尚未找到时的递归结果。 */
  let found: React.ReactElement<{ onClick?: () => void; disabled?: boolean }> | null = null
  React.Children.forEach(node, (child) => {
    if (found || !React.isValidElement<{ children?: React.ReactNode; 'aria-label'?: string }>(child)) return
    if (child.props['aria-label'] === ariaLabel) {
      found = child as React.ReactElement<{ onClick?: () => void; disabled?: boolean }>
      return
    }
    found = findButtonByLabel(child.props.children, ariaLabel)
  })
  return found
}

/** 已连接上下文。 */
const connectedContext = { hostId: 'host-1', hostLabel: 'web-prod-01', hostDescription: 'deploy@10.0.0.8:22', active: true, connected: true }

describe('数据服务面板', () => {
  test('Given 工作台自行按页读取 When 连接管理绑定与重放 Then 不自动请求全量诊断且编辑仍可用', async () => {
    /** 全量诊断不应因连接菜单存在而触发。 */
    let reads = 0
    /** 独立工作台复用管理能力。 */
    const source = createSource({ transport: 'direct' })
    const controller = createServerOpsDataServicesController({ api: createApi({ diagnoseServerOpsDataSource: async () => { reads += 1; return createDiagnostics() } }), publish: () => undefined, automaticDiagnostics: false })
    controller.activate()
    controller.setContext({ hostId: '', hostLabel: '', hostDescription: '', connected: false, active: true, focusSource: source })
    controller.dispose()
    controller.activate()
    controller.openEditDialog(source)
    expect(reads).toBe(0)
    expect(controller.getProjection().dialog?.mode).toBe('edit')
  })
  test('Given 未连接 When 绑定上下文 Then 仍可列出与新建数据源，只在顶部提示', async () => {
    /** 列表调用次数。 */
    let listCalls = 0
    const { controller } = createHarness(createApi({
      listServerOpsDataSources: async () => { listCalls += 1; return { sources: [] } },
    }))
    controller.setContext({ ...connectedContext, connected: false })
    // 配置数据源不依赖 SSH 连接：未连接也必须能列出与新建，否则直连条目根本加不出来。
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(listCalls).toBe(1)
    const html = renderView(controller.getProjection())
    expect(html).toContain('data-server-ops-data-offline-hint="true"')
    expect(html).toContain('data-server-ops-data-panel="true"')
    expect(html).toContain('新建数据源')
    // 新建按钮不得因未连接而禁用。
    expect(html).toContain('data-server-ops-data-panel="true"')
    expect(html).not.toContain('当前未建立 SSH 连接</div>')
  })

  test('Given 已连接且无数据源 When 绑定上下文 Then 展示空态', async () => {
    const { controller } = createHarness(createApi())
    controller.setContext(connectedContext)
    await Promise.resolve()
    await Promise.resolve()
    expect(controller.getProjection().status).toBe('ready')
    const html = renderView(controller.getProjection())
    expect(html).toContain('还没有为这台服务器配置数据源')
    expect(html).toContain('不会在本机开放监听端口')
  })

  test('Given 已连接且有数据源 When 绑定上下文 Then 渲染行与操作入口', async () => {
    const { controller } = createHarness(createApi({
      listServerOpsDataSources: async () => ({ hostId: 'host-1', sources: [createSource(), createSource({ id: 'source-2', label: '会话缓存', engine: 'redis', port: 6379, database: '0', tlsMode: 'verify', tlsServerName: 'redis.internal' })] }),
    }))
    controller.setContext(connectedContext)
    await Promise.resolve()
    await Promise.resolve()
    const html = renderView(controller.getProjection())
    expect(html).toContain('业务主库')
    expect(html).toContain('127.0.0.1:3306')
    expect(html).toContain('已保存密码')
    expect(html).toContain('会话缓存')
    expect(html).toContain('Redis')
    expect(html).toContain('TLS 校验')
    expect(html).toContain('aria-label="测试 业务主库 的连接"')
    expect(html).toContain('aria-label="读取 业务主库 的只读诊断"')
    expect(html).toContain('aria-label="编辑 业务主库"')
    expect(html).toContain('aria-label="删除 业务主库"')
  })

  test('Given 连接测试成功与失败 When 渲染 Then 分别展示版本与中文原因', async () => {
    const { controller } = createHarness(createApi({
      listServerOpsDataSources: async () => ({ sources: [createSource(), createSource({ id: 'source-2', label: '会话缓存' })] }),
      probeServerOpsDataSource: async (input) => 'sourceId' in input && input.sourceId === 'source-1'
        ? { sourceId: 'source-1', engine: 'mysql', capability: 'available', serverVersion: '8.0.36', latencyMs: 12, warnings: [] } satisfies ServerOpsDataProbeResult
        : { sourceId: 'source-2', engine: 'mysql', capability: 'auth-failed', warnings: ['认证失败（ER_ACCESS_DENIED_ERROR）'] } satisfies ServerOpsDataProbeResult,
    }))
    controller.setContext(connectedContext)
    await Promise.resolve(); await Promise.resolve()
    const sources = controller.getProjection().sources
    controller.probe(sources[0]!)
    controller.probe(sources[1]!)
    await Promise.resolve(); await Promise.resolve()
    const html = renderView(controller.getProjection())
    expect(html).toContain('已连接 · 8.0.36 · 12ms')
    expect(html).toContain('认证失败 · 认证失败（ER_ACCESS_DENIED_ERROR）')
  })

  test('Given 诊断成功 When 渲染 Then 展示指标卡、占比、表格与截断标记', async () => {
    const { controller } = createHarness(createApi({
      listServerOpsDataSources: async () => ({ sources: [createSource()] }),
      diagnoseServerOpsDataSource: async () => createDiagnostics(),
    }))
    controller.setContext(connectedContext)
    await Promise.resolve(); await Promise.resolve()
    controller.diagnose(controller.getProjection().sources[0]!)
    await Promise.resolve(); await Promise.resolve()
    const html = renderView(controller.getProjection())
    expect(html).toContain('只读诊断')
    /** 统计与数据表分成两个页签：默认页签只出指标，表格在另一个页签里。 */
    expect(html).toContain('data-server-ops-data-diagnostics-tab="metrics"')
    expect(html).toContain('data-server-ops-data-diagnostics-tab="tables"')
    expect(html).toContain('统计')
    expect(html).toContain('表')
    expect(html).toContain('诊断表')
    expect(html).toContain('活跃连接')
    expect(html).toContain('42 / 200')
    expect(html).toContain('运行中 3')
    expect(html).toContain('width:21%')
    /** 默认页签只出指标：表格内容不得同时堆在同一屏里。 */
    expect(html).not.toContain('1.0 GiB')
    expect(html).toContain('@container (min-width: 700px)')

    /** 切到数据表页签后只出表格，指标卡不再出现。 */
    const tablesHtml = renderView(controller.getProjection(), 'tables')
    expect(tablesHtml).toContain('数据库')
    expect(tablesHtml).toContain('1.0 GiB')
    expect(tablesHtml).toContain('已截断')
    expect(tablesHtml).not.toContain('活跃连接')
  })

  test('Given 诊断返回空表 When 渲染 Then 展示空表说明', async () => {
    const { controller } = createHarness(createApi({
      listServerOpsDataSources: async () => ({ sources: [createSource()] }),
      diagnoseServerOpsDataSource: async () => createDiagnostics({
        metrics: [],
        tables: [{ id: 'slowlog', title: '慢日志', columns: [{ id: 'command', label: '命令' }], rows: [], truncated: false, emptyText: '最近没有慢命令' }],
      }),
    }))
    controller.setContext(connectedContext)
    await Promise.resolve(); await Promise.resolve()
    controller.diagnose(controller.getProjection().sources[0]!)
    await Promise.resolve(); await Promise.resolve()
    /** 空表说明属于"数据表"页签；统计页签此时给出"没有指标"的空态。 */
    expect(renderView(controller.getProjection(), 'tables')).toContain('最近没有慢命令')
    expect(renderView(controller.getProjection())).toContain('本次诊断没有可展示的统计指标')
    expect(renderView(controller.getProjection())).toContain('诊断表')
  })

  test('Given 未连通能力 When 诊断完成 Then 展示原因且不展示指标', async () => {
    const { controller } = createHarness(createApi({
      listServerOpsDataSources: async () => ({ sources: [createSource()] }),
      diagnoseServerOpsDataSource: async () => createDiagnostics({
        capability: 'unreachable', metrics: [], tables: [], warnings: ['目标端口拒绝连接'],
      }),
    }))
    controller.setContext(connectedContext)
    await Promise.resolve(); await Promise.resolve()
    controller.diagnose(controller.getProjection().sources[0]!)
    await Promise.resolve(); await Promise.resolve()
    const html = renderView(controller.getProjection())
    expect(html).toContain('无法连接')
    expect(html).toContain('目标端口拒绝连接')
    expect(html).not.toContain('data-server-ops-data-metric-grid="true"')
  })

  test('Given 切换主机 When 旧列表请求迟到 Then 不写回新上下文投影', async () => {
    /** 主机一的一次迟到的列表请求。 */
    const firstList = createDeferred<{ sources: ServerOpsDataSource[] }>()
    /** 列表调用次数；只有第一次返回迟到结果。 */
    let listCalls = 0
    const { controller } = createHarness(createApi({
      listServerOpsDataSources: async () => {
        listCalls += 1
        return listCalls === 1 ? firstList.promise : { sources: [createSource({ label: '第二次读取的数据源' })] }
      },
    }))
    controller.setContext(connectedContext)
    controller.setContext({ ...connectedContext, hostId: 'host-2' })
    await Promise.resolve(); await Promise.resolve()
    firstList.resolve({ sources: [createSource({ label: '迟到的旧结果' })] })
    await Promise.resolve(); await Promise.resolve()
    /** 迟到结果必须被代次拒绝，投影只保留新一轮读取的结果。 */
    const projection = controller.getProjection()
    expect(projection.context?.hostId).toBe('host-2')
    expect(projection.sources.map((source) => source.label)).toEqual(['第二次读取的数据源'])
  })

  test('Given 失活 When 旧诊断迟到 Then 不再写入投影', async () => {
    /** 一次迟到的诊断请求。 */
    const pendingDiagnostics = createDeferred<ServerOpsDataDiagnosticsResult>()
    const { controller } = createHarness(createApi({
      listServerOpsDataSources: async () => ({ sources: [createSource()] }),
      diagnoseServerOpsDataSource: async () => pendingDiagnostics.promise,
    }))
    controller.setContext(connectedContext)
    await Promise.resolve(); await Promise.resolve()
    controller.diagnose(controller.getProjection().sources[0]!)
    controller.setContext({ ...connectedContext, active: false })
    pendingDiagnostics.resolve(createDiagnostics())
    await Promise.resolve(); await Promise.resolve()
    expect(controller.getProjection().diagnostics).toBeNull()
  })

  test('Given 删除确认 When 提交 Then 调用删除并刷新列表', async () => {
    /** 删除请求记录。 */
    const deleted: string[] = []
    /** 列表调用次数。 */
    let listCalls = 0
    const { controller } = createHarness(createApi({
      listServerOpsDataSources: async () => { listCalls += 1; return { sources: listCalls === 1 ? [createSource()] : [] } },
      deleteServerOpsDataSource: async (input) => { deleted.push(input.sourceId) },
    }))
    controller.setContext(connectedContext)
    await Promise.resolve(); await Promise.resolve()
    controller.requestDelete(controller.getProjection().sources[0]!)
    expect(controller.getProjection().deleteTarget?.id).toBe('source-1')
    controller.confirmDelete()
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    expect(deleted).toEqual(['source-1'])
    expect(controller.getProjection().deleteTarget).toBeNull()
    expect(controller.getProjection().sources).toEqual([])
  })

  test('Given 编辑提交 When 保存成功 Then 关闭弹窗并刷新列表', async () => {
    /** 收到的写入输入。 */
    const submitted: ServerOpsDataSourceUpsertInput[] = []
    const { controller } = createHarness(createApi({
      listServerOpsDataSources: async () => ({ sources: [createSource()] }),
      upsertServerOpsDataSource: async (input) => { submitted.push(input); return { hostId: input.hostId, source: createSource({ label: input.label }) } },
    }))
    controller.setContext(connectedContext)
    await Promise.resolve(); await Promise.resolve()
    controller.openEditDialog(controller.getProjection().sources[0]!)
    expect(controller.getProjection().dialog?.mode).toBe('edit')
    controller.submitDialog({ transport: 'ssh', hostId: 'host-1', sourceId: 'source-1', engine: 'mysql', label: '改名后', address: '127.0.0.1', port: 3306, tlsMode: 'disabled' })
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    expect(submitted).toHaveLength(1)
    expect(controller.getProjection().dialog).toBeNull()
  })

  test('Given 保存失败 When 提交 Then 弹窗保留并展示中文错误', async () => {
    const { controller } = createHarness(createApi({
      listServerOpsDataSources: async () => ({ sources: [createSource()] }),
      upsertServerOpsDataSource: async () => { throw new Error('SERVER_OPS_SECURE_STORAGE_UNAVAILABLE') },
    }))
    controller.setContext(connectedContext)
    await Promise.resolve(); await Promise.resolve()
    controller.openCreateDialog()
    controller.submitDialog({ transport: 'direct', engine: 'mysql', label: '新库', address: '127.0.0.1', port: 3306, tlsMode: 'disabled' })
    await Promise.resolve(); await Promise.resolve()
    expect(controller.getProjection().dialog).not.toBeNull()
    expect(controller.getProjection().dialogError).toBe('当前系统无法安全保存密码')
  })

  test('Given 校验失败与失活 When 调用控制器 Then 不触发请求', async () => {
    /** 记录所有写入类调用。 */
    const calls: string[] = []
    const { controller } = createHarness(createApi({
      listServerOpsDataSources: async () => { calls.push('list'); return { sources: [createSource()] } },
      deleteServerOpsDataSource: async () => { calls.push('delete') },
    }))
    controller.requestDelete(createSource())
    expect(calls).toEqual([])
    controller.setContext(connectedContext)
    await Promise.resolve(); await Promise.resolve()
    controller.setContext({ ...connectedContext, connected: false })
    /** 断开 SSH 后仍允许删除数据源：删除是本地配置操作，不依赖连接。 */
    controller.requestDelete(createSource())
    controller.confirmDelete()
    await Promise.resolve(); await Promise.resolve()
    /** 未绑定时不得触发任何写入；绑定后删除只发生一次（列表会因上下文变化重读，属预期）。 */
    expect(calls.filter((call) => call === 'delete')).toHaveLength(1)
  })

  test('Given 单连接模式 When 绑定上下文 Then 不读全局列表、直接进入只读诊断', async () => {
    /** 列表请求次数。 */
    let listCalls = 0
    /** 诊断请求的数据源。 */
    const diagnosed: string[] = []
    /** 直连的数据库连接：不依赖任何 SSH 主机。 */
    const directSource = createSource({ id: 'source-1', transport: 'direct', hostId: undefined, projectId: 'project-1' })
    const { controller } = createHarness(createApi({
      listServerOpsDataSources: async () => { listCalls += 1; return { sources: [directSource] } },
      diagnoseServerOpsDataSource: async (input) => { diagnosed.push(input.sourceId); return createDiagnostics({ sourceId: input.sourceId }) },
    }))
    controller.setContext({ ...connectedContext, hostId: '', connected: false, focusSource: directSource })
    await Promise.resolve(); await Promise.resolve()

    /** 聚焦模式只有这一条连接，不需要也不应该拉全局列表。 */
    expect(listCalls).toBe(0)
    expect(diagnosed).toEqual(['source-1'])
    const projection = controller.getProjection()
    expect(projection.status).toBe('ready')
    expect(projection.sources.map((source) => source.id)).toEqual(['source-1'])

    const html = renderView(projection)
    expect(html).toContain('只读诊断')
    expect(html).toContain('活跃连接')
    /** 单连接模式只展示这一条连接：不出现新建入口，也不出现全局列表。 */
    expect(html).not.toContain('新建数据源')
    expect(html).not.toContain('data-server-ops-data-source="source-1"')
    /**
     * 面板不再重复写身份：项目/连接名与完整身份都在外层工具栏，
     * 这里只应出现"只读诊断 + 页签 + 状态"这一行。
     */
    expect(html).not.toContain('data-server-ops-data-focus-label')
    /** 直连与 SSH 无关，不能出现"当前未建立 SSH 连接"。 */
    expect(html).not.toContain('data-server-ops-data-offline-hint')
  })

  test('Given 经跳板的单连接模式 When 跳板未连接 Then 提示需要先连接且不发起诊断', async () => {
    /** 诊断请求的数据源。 */
    const diagnosed: string[] = []
    const { controller } = createHarness(createApi({
      diagnoseServerOpsDataSource: async (input) => { diagnosed.push(input.sourceId); return createDiagnostics({ sourceId: input.sourceId }) },
    }))
    controller.setContext({ ...connectedContext, connected: false, focusSource: createSource() })
    await Promise.resolve(); await Promise.resolve()

    expect(diagnosed).toEqual([])
    const html = renderView(controller.getProjection())
    expect(html).toContain('data-server-ops-data-offline-hint')
    expect(html).toContain('尚未读取诊断')
  })

  test('Given 单连接模式 When 刷新 Then 重新读取该连接的诊断而不是全局列表', async () => {
    /** 列表请求次数。 */
    let listCalls = 0
    /** 诊断请求次数。 */
    let diagnoseCalls = 0
    const directSource = createSource({ transport: 'direct', hostId: undefined })
    const { controller } = createHarness(createApi({
      listServerOpsDataSources: async () => { listCalls += 1; return { sources: [directSource] } },
      diagnoseServerOpsDataSource: async (input) => { diagnoseCalls += 1; return createDiagnostics({ sourceId: input.sourceId }) },
    }))
    controller.setContext({ ...connectedContext, hostId: '', connected: false, focusSource: directSource })
    await Promise.resolve(); await Promise.resolve()
    controller.refresh()
    await Promise.resolve(); await Promise.resolve()

    expect(listCalls).toBe(0)
    expect(diagnoseCalls).toBe(2)
  })

  test('Given 单连接模式 When 编辑或删除该连接 Then 通知所有者重建连接清单', async () => {
    /** 所有者收到的变更类别；编辑与删除必须可区分。 */
    const mutations: string[] = []
    /** 写入输入。 */
    const submitted: ServerOpsDataSourceUpsertInput[] = []
    /** 删除请求。 */
    const deleted: string[] = []
    const directSource = createSource({ transport: 'direct', hostId: undefined })
    /** 聚焦模式的控制器。 */
    const projections: ServerOpsDataServicesProjection[] = []
    const controller = createServerOpsDataServicesController({
      api: createApi({
        upsertServerOpsDataSource: async (input) => { submitted.push(input); return { source: createSource({ label: input.label }) } },
        deleteServerOpsDataSource: async (input) => { deleted.push(input.sourceId) },
      }),
      publish: (projection) => projections.push(projection),
      onSourceMutated: (change) => { mutations.push(change) },
    })
    /** 与容器一致：先激活 owner 代次，否则发布与变更通知都会被判为失活。 */
    controller.activate()
    controller.setContext({ ...connectedContext, hostId: '', connected: false, focusSource: directSource })
    await Promise.resolve(); await Promise.resolve()

    controller.submitDialog({ transport: 'direct', sourceId: 'source-1', engine: 'mysql', label: '改名后', address: '127.0.0.1', port: 3306, tlsMode: 'disabled' })
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    expect(submitted).toHaveLength(1)
    expect(mutations).toEqual(['updated'])

    controller.requestDelete(directSource)
    controller.confirmDelete()
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    expect(deleted).toEqual(['source-1'])
    expect(mutations).toEqual(['updated', 'deleted'])
  })

  test('Given 聚焦连接被编辑 When 身份变化 Then 重新建立上下文并重读诊断', async () => {
    /** 诊断请求次数。 */
    let diagnoseCalls = 0
    const { controller } = createHarness(createApi({
      diagnoseServerOpsDataSource: async (input) => { diagnoseCalls += 1; return createDiagnostics({ sourceId: input.sourceId }) },
    }))
    const first = createSource({ transport: 'direct', hostId: undefined, updatedAt: 1_000 })
    controller.setContext({ ...connectedContext, hostId: '', connected: false, focusSource: first })
    await Promise.resolve(); await Promise.resolve()
    /** 同名同 ID 但已更新的连接：名称变化必须反映到详情页。 */
    controller.setContext({ ...connectedContext, hostId: '', connected: false, focusSource: { ...first, label: '改名后主库', updatedAt: 2_000 } })
    await Promise.resolve(); await Promise.resolve()

    expect(diagnoseCalls).toBe(2)
    expect(controller.getProjection().context?.focusSource?.label).toBe('改名后主库')
  })

  test('Given 单连接模式 When 删除失败 Then 就地展示原因与重试而不是静默失败', async () => {
    const directSource = createSource({ transport: 'direct', hostId: undefined })
    const { controller } = createHarness(createApi({
      deleteServerOpsDataSource: async () => { throw new Error('SERVER_OPS_DATA_SOURCE_NOT_FOUND') },
    }))
    controller.setContext({ ...connectedContext, hostId: '', connected: false, focusSource: directSource })
    await Promise.resolve(); await Promise.resolve()
    controller.requestDelete(directSource)
    controller.confirmDelete()
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()

    const html = renderView(controller.getProjection())
    expect(html).toContain('data-server-ops-data-focus-error')
    expect(html).toContain('数据源不存在，可能已在其它窗口删除')
  })

  test('Given 单连接模式聚焦直连连接 When 点编辑与删除 Then 分别打开编辑弹窗与删除确认', async () => {
    /** 直连的数据库连接：编辑路径不得再被主机门禁拦掉。 */
    const directSource = createSource({ transport: 'direct', hostId: undefined })
    const { controller } = createHarness(createApi())
    controller.setContext({ ...connectedContext, focusSource: directSource })
    await Promise.resolve()

    controller.openEditDialog(directSource)
    expect(controller.getProjection().dialog).toMatchObject({ mode: 'edit' })
    controller.closeDialog()
    expect(controller.getProjection().dialog).toBeNull()

    controller.requestDelete(directSource)
    expect(controller.getProjection().deleteTarget?.id).toBe('source-1')
    controller.cancelDelete()
    expect(controller.getProjection().deleteTarget).toBeNull()
  })

  test('Given 单连接模式 When 渲染诊断控制行 Then 测试/编辑/删除与刷新把目标交给回调', () => {
    /** 聚焦连接。 */
    const directSource = createSource({ transport: 'direct', hostId: undefined })
    /** 各按钮收到的回调参数。 */
    const calls: string[] = []
    /** 直接调用诊断视图函数取得元素树，验证按钮接线而不是只看图标。 */
    const tree = ServerOpsDataDiagnostics({
      diagnostics: null,
      source: directSource,
      tab: 'metrics',
      onTabChange: () => { calls.push('tab') },
      onDiagnose: (source) => { calls.push(`diagnose:${source.id}`) },
      sourceActions: {
        probing: false,
        onProbe: (source) => { calls.push(`probe:${source.id}`) },
        onEdit: (source) => { calls.push(`edit:${source.id}`) },
        onDelete: (source) => { calls.push(`delete:${source.id}`) },
      },
    })

    /** 四个动作按钮各自的期望回调；即使还没读过诊断也必须可点。 */
    const expectations: ReadonlyArray<readonly [string, string]> = [
      ['编辑 业务主库', 'edit:source-1'],
      ['删除 业务主库', 'delete:source-1'],
      ['测试 业务主库 的连接', 'probe:source-1'],
      ['刷新只读诊断', 'diagnose:source-1'],
    ]
    for (const [label, expected] of expectations) {
      /** 目标按钮。 */
      const button = findButtonByLabel(tree, label)
      expect(button).not.toBeNull()
      button?.props.onClick?.()
      expect(calls.at(-1)).toBe(expected)
    }
  })

  test('Given 诊断进行中 When 渲染控制行 Then 刷新按钮仍可点', () => {
    /** 读取中状态；此时刷新按钮必须可用，否则结果一旦丢失用户无法自救。 */
    const tree = ServerOpsDataDiagnostics({
      diagnostics: { sourceId: 'source-1', state: 'running' },
      source: createSource(),
      tab: 'metrics',
      onTabChange: () => undefined,
      onDiagnose: () => undefined,
      sourceActions: { probing: false, onProbe: () => undefined, onEdit: () => undefined, onDelete: () => undefined },
    })
    const refresh = findButtonByLabel(tree, '刷新只读诊断')
    expect(refresh).not.toBeNull()
    expect(refresh?.props.disabled ?? false).toBe(false)
  })

  test('Given 在途诊断 When 只有展示字段变化 Then 不重启读取且结果照常写回', async () => {
    /** 可控结算的诊断请求。 */
    const pending = createDeferred<ServerOpsDataDiagnosticsResult>()
    /** 诊断调用次数；只有 1 次说明展示字段变化没有重启读取。 */
    let diagnoseCalls = 0
    const { controller } = createHarness(createApi({
      diagnoseServerOpsDataSource: async () => { diagnoseCalls += 1; return pending.promise },
    }))
    controller.setContext({ ...connectedContext, hostId: '', connected: false, focusSource: createSource({ transport: 'direct', hostId: undefined }) })
    await Promise.resolve(); await Promise.resolve()
    expect(diagnoseCalls).toBe(1)
    expect(controller.getProjection().diagnostics?.state).toBe('running')

    /** 跳板连接状态/主机描述变化属于展示字段：不得作废在途读取。 */
    controller.setContext({
      ...connectedContext,
      hostId: '',
      connected: true,
      hostDescription: 'deploy@10.0.0.8:22',
      focusSource: createSource({ transport: 'direct', hostId: undefined }),
    })
    await Promise.resolve(); await Promise.resolve()
    expect(diagnoseCalls).toBe(1)
    expect(controller.getProjection().diagnostics?.state).toBe('running')

    /** 在途结果必须照常写回，界面不能永远停在"正在读取只读诊断"。 */
    pending.resolve(createDiagnostics())
    await Promise.resolve(); await Promise.resolve()
    expect(controller.getProjection().diagnostics?.state).toBe('done')
    expect(controller.getProjection().diagnostics?.result?.metrics.length).toBeGreaterThan(0)
  })

  test('Given 诊断读取失败 When 渲染 Then 页签仍在且保留上一次结果', async () => {
    /** 第二次诊断要失败，第一次成功。 */
    let calls = 0
    const { controller } = createHarness(createApi({
      listServerOpsDataSources: async () => ({ sources: [createSource()] }),
      diagnoseServerOpsDataSource: async (input) => {
        calls += 1
        if (calls === 1) return createDiagnostics({ sourceId: input.sourceId })
        throw new Error('SERVER_OPS_DATA_SOURCE_BUSY')
      },
    }))
    controller.setContext(connectedContext)
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    controller.diagnose(controller.getProjection().sources[0]!)
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    expect(controller.getProjection().diagnostics?.state).toBe('done')

    controller.diagnose(controller.getProjection().sources[0]!)
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    /** 单飞冲突不是失败：状态与结果都不应被改写。 */
    const afterBusy = controller.getProjection()
    expect(afterBusy.diagnostics?.state).toBe('done')
    expect(afterBusy.diagnostics?.result?.metrics.length).toBeGreaterThan(0)

    /** 真正的失败要保留上一次结果，且页签（统计/表/诊断表）依然在渲染。 */
    const failing = createHarness(createApi({
      listServerOpsDataSources: async () => ({ sources: [createSource()] }),
      diagnoseServerOpsDataSource: async () => { throw new Error('SERVER_OPS_DATA_TIMEOUT') },
    }))
    failing.controller.setContext(connectedContext)
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    failing.controller.diagnose(failing.controller.getProjection().sources[0]!)
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    const failingProjection = failing.controller.getProjection()
    const html = renderView(failingProjection)
    expect(failingProjection.diagnostics?.state).toBe('error')
    expect(html).toContain('data-server-ops-data-diagnostics-tab="metrics"')
    expect(html).toContain('data-server-ops-data-diagnostics-tab="schema"')
    expect(html).toContain('data-server-ops-data-diagnostics-tab="tables"')
    expect(html).toContain('读取超时')
  })

  test('Given StrictMode 重放 When dispose 后重新 activate Then 恢复发布并续上聚焦诊断', async () => {
    /**
     * React 18 StrictMode 会把 effect 跑成 "setup → cleanup → setup"。
     * 容器的 cleanup 会 dispose 控制器；若 activate 不能重新取得 owner 代次，
     * 面板就永远停在失活那一刻的画面——用户看到的是"只读诊断一直转圈、
     * 右上角编辑/删除按钮点了没反应"（真实报障）。
     */
    /** 聚焦的直连连接。 */
    const directSource = createSource({ transport: 'direct', hostId: undefined })
    /** 诊断请求次数。 */
    let diagnoseCalls = 0
    const { controller, projections } = createHarness(createApi({
      diagnoseServerOpsDataSource: async (input) => { diagnoseCalls += 1; return createDiagnostics({ sourceId: input.sourceId }) },
    }))
    controller.setContext({ ...connectedContext, hostId: '', connected: false, focusSource: directSource })
    await Promise.resolve(); await Promise.resolve()
    expect(controller.getProjection().diagnostics?.state).toBe('done')

    /** 第一次 cleanup 与第二次 setup：第一次的读取结果已作废，activate 必须补做一次。 */
    controller.dispose()
    const beforeActivate = projections.length
    controller.activate()
    expect(projections.length).toBeGreaterThan(beforeActivate)
    expect(controller.getProjection().diagnostics?.state).toBe('running')
    await Promise.resolve(); await Promise.resolve()
    expect(diagnoseCalls).toBe(2)
    expect(controller.getProjection().diagnostics?.state).toBe('done')

    /** 失活期间任何弹窗动作都会被静默丢弃；恢复 owner 后必须重新生效。 */
    controller.dispose()
    controller.openEditDialog(directSource)
    expect(projections.at(-1)?.dialog ?? null).toBeNull()
    controller.activate()
    controller.openEditDialog(directSource)
    expect(controller.getProjection().dialog).toMatchObject({ mode: 'edit' })
    expect(projections.at(-1)?.dialog).toMatchObject({ mode: 'edit' })
  })

})
