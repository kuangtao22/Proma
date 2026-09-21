import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import type {
  ServerOpsAgentAccess,
  ServerOpsAgentAccessChanged,
  ServerOpsAuditRecord,
  ServerOpsConnectionState,
  ServerOpsHost,
  ServerOpsLogIdentity,
  ServerOpsLogStartInput,
  ServerOpsLogStartResult,
  ServerOpsOverviewResult,
} from '@proma/shared'

test('Given 旧SSH授权覆盖只读租约 When 用户已确认影响 Then 提交原影响token', async () => {
  const calls: Array<{ token?: string; granted: boolean }> = []
  const controller = createServerOpsAgentAccessController({
    getAccess: async () => null,
    setAccess: async (access, token) => { calls.push({ token, granted: access.granted }); return access },
    publish: () => undefined,
    reportError: () => undefined,
  })
  controller.activate()
  await controller.select({ sessionId: 'session-1', hostId: 'host-1' })
  await controller.toggle('captured-impact-token')
  expect(calls).toEqual([{ token: 'captured-impact-token', granted: true }])
  controller.dispose()
})
import {
  createServerOpsAuditController,
  createServerOpsAgentAccessController,
  isServerOpsCredentialRecoveryState,
  resolveServerOpsAgentAccessSession,
  resolveServerOpsAgentAccessTarget,
  resolveServerOpsAgentAccessViewState,
  resolveServerOpsProjectDataSourceHosts,
  shouldPromptForServerOpsCredential,
  ServerOpsWorkspaceView,
  serverOpsDataApi,
} from './ServerOpsWorkspace'
import { useServerOpsTransferLeave } from './useServerOpsTransferLeave'
import type { ServerOpsAgentAccessProjection } from '@/atoms/server-ops-atoms'
import { createServerOpsOverviewController, ServerOpsOverviewPanel } from './ServerOpsOverviewPanel'
import type { ServerOpsOverviewProjection } from './ServerOpsOverviewPanel'
import { ServerOpsServicesPanel } from './ServerOpsServicesPanel'
import { createServerOpsLogsController, ServerOpsLogsPanel } from './ServerOpsLogsPanel'
import type { ServerOpsLogsController, ServerOpsLogsProjection } from './ServerOpsLogsPanel'
import { buildServerOpsConnections, resolveServerOpsWorkspaceTarget } from './server-ops-connections'
import type { ServerOpsConnection } from './server-ops-connections'
import { createServerOpsSqlQueryHistoryController } from './server-ops-sql-query-history-controller'
import { createServerOpsSqlQueryController } from './server-ops-sql-query-controller'

test('Given 实际工作区加载旧 preload When 进入 SQL 工作台 Then 禁用执行并明确提示重启而非伪装为可调用接口', async () => {
  /** 保存测试前的全局窗口，避免兼容性用例影响其它组件。 */
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { electronAPI: {} } })
  try {
    /** 通过实际工作区适配器验证能力检查，不直接注入空接口替代生产接线。 */
    const history = createServerOpsSqlQueryHistoryController({
      api: { list: serverOpsDataApi.listServerOpsDatabaseQueryHistory, save: serverOpsDataApi.saveServerOpsDatabaseQueryHistory },
      publish: () => undefined,
    })
    history.activate()
    history.setContext({ sourceId: 'source-1', database: 'app', configurationKey: 'v1' })
    await Promise.resolve()
    expect(history.snapshot().error).toBe('SQL 查询历史接口尚未就绪，请重启应用后重试')
    expect(serverOpsDataApi.saveServerOpsDatabaseQueryHistory).toBeUndefined()
    /** 执行与取消任一接口缺失时都不能发起查询。 */
    const query = createServerOpsSqlQueryController({
      api: { query: serverOpsDataApi.queryServerOpsDatabase, cancel: serverOpsDataApi.cancelServerOpsDatabaseQuery },
      publish: () => undefined,
    })
    query.activate()
    query.setContext({ sourceId: 'source-1', database: 'app', configurationKey: 'v1', available: true })
    query.setDraft('SELECT id FROM users')
    expect(query.snapshot().canExecute).toBe(false)
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('Given 项目有多台服务器 When 新建数据源 Then 网络引擎沿用首台跳板且 SQLite 可选择全部服务器', () => {
  const connections: ServerOpsConnection[] = [
    { id: 'ssh:host-a', kind: 'ssh', projectId: 'project-1', label: '应用服务器', detail: 'ops@10.0.0.8:22', hostId: 'host-a' },
    { id: 'ssh:host-b', kind: 'ssh', projectId: 'project-1', label: '审计服务器', detail: 'ops@10.0.0.9:22', hostId: 'host-b' },
    { id: 'ssh:host-c', kind: 'ssh', projectId: 'project-2', label: '其他项目', detail: 'ops@10.0.1.8:22', hostId: 'host-c' },
  ]
  expect(resolveServerOpsProjectDataSourceHosts(connections, 'project-1')).toEqual({
    defaultHost: { id: 'host-a', label: '应用服务器' },
    hostOptions: [{ id: 'host-a', label: '应用服务器' }, { id: 'host-b', label: '审计服务器' }],
  })
})

test('Given 新 preload 已加载 When 实际工作区读取历史 Then 保留桥接返回值与原始数据库范围', async () => {
  /** 只使用本地模拟范围，不读写用户真实历史。 */
  const scope = { sourceId: 'source-1', database: 'app' }
  /** 记录真实适配器转交的参数。 */
  const calls: unknown[] = []
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { electronAPI: {
    listServerOpsDatabaseQueryHistory: async (input: unknown) => { calls.push(input); return { entries: [] } },
  } } })
  try {
    expect(await serverOpsDataApi.listServerOpsDatabaseQueryHistory?.(scope)).toEqual({ entries: [] })
    expect(calls).toEqual([scope])
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
}

/** 创建可控 Promise，验证授权 IPC 的 loading 与迟到结果。 */
function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })
  return { promise, resolve, reject }
}

/** 等待当前微任务队列完成，确保控制器异步分支已推进。 */
async function flushPromises(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

/** 创建授权测试所需的内存 IPC 与投影观察器。 */
function createAgentAccessHarness(activate = true) {
  /** 查询调用记录。 */
  const getCalls: Array<{ sessionId: string; hostId: string }> = []
  /** 写入调用记录。 */
  const setCalls: ServerOpsAgentAccess[] = []
  /** Renderer 投影历史。 */
  const projections: ServerOpsAgentAccessProjection[] = []
  /** 用户可见错误记录。 */
  const errors: string[] = []
  /** 默认查询实现返回未授权。 */
  let getAccess = async (target: { sessionId: string; hostId: string }): Promise<ServerOpsAgentAccess | null> => {
    getCalls.push(target)
    return null
  }
  /** 默认写入实现原样接管授权事实，撤销时返回空槽。 */
  let setAccess = async (access: ServerOpsAgentAccess): Promise<ServerOpsAgentAccess | null> => {
    setCalls.push(access)
    return access.granted ? access : null
  }
  const controller = createServerOpsAgentAccessController({
    getAccess: (target) => getAccess(target),
    setAccess: (access) => setAccess(access),
    publish: (projection) => { projections.push(projection) },
    reportError: (message) => { errors.push(message) },
  })
  if (activate) controller.activate()
  return {
    controller,
    errors,
    getCalls,
    projections,
    setCalls,
    setGetAccess: (implementation: typeof getAccess) => { getAccess = implementation },
    setSetAccess: (implementation: typeof setAccess) => { setAccess = implementation },
  }
}

/** 创建工作区测试使用的服务器资产。 */
function createHost(): ServerOpsHost {
  return {
    id: 'host-1',
    name: '生产 API',
    address: '10.0.0.8',
    port: 22,
    username: 'deploy',
    authMethod: 'ssh-agent',
    tags: ['生产'],
    createdAt: 1,
    updatedAt: 1,
  }
}

/** 创建控制器生命周期测试所需的最小合法概览快照。 */
function createOverviewSnapshot(hostId: string): ServerOpsOverviewResult {
  return {
    hostId,
    capturedAt: 1,
    sampleWindowMs: 1_000,
    filesystems: [],
    processes: [],
    warnings: [],
  }
}

/** 创建静态工作区视图所需回调。 */
function createCallbacks() {
  return {
    onOpenDrawer: () => undefined,
    onCreateHost: () => undefined,
    onEditHost: () => undefined,
    onDeleteHost: () => undefined,
    onSectionChange: () => undefined,
  }
}

/** 在纯视图返回树中查找概览组件的 React 实例身份。 */
function findOverviewElementKey(node: React.ReactNode): React.Key | null | undefined {
  /** 尚未找到时保持 undefined，以区分组件存在但未设置 key。 */
  let found: React.Key | null | undefined
  React.Children.forEach(node, (child) => {
    if (found !== undefined || !React.isValidElement<{ children?: React.ReactNode }>(child)) return
    if (child.type === ServerOpsOverviewPanel) {
      found = child.key
      return
    }
    found = findOverviewElementKey(child.props.children)
  })
  return found
}

/** 在纯视图返回树中查找常驻的服务面板 React 元素。 */
function findServicesElement(node: React.ReactNode): React.ReactElement<React.ComponentProps<typeof ServerOpsServicesPanel>> | null {
  /** 尚未找到时递归检查子节点。 */
  let found: React.ReactElement<React.ComponentProps<typeof ServerOpsServicesPanel>> | null = null
  React.Children.forEach(node, (child) => {
    if (found || !React.isValidElement<{ children?: React.ReactNode }>(child)) return
    if (child.type === ServerOpsServicesPanel) {
      found = child as React.ReactElement<React.ComponentProps<typeof ServerOpsServicesPanel>>
      return
    }
    found = findServicesElement(child.props.children)
  })
  return found
}

/** 在纯视图返回树中查找常驻的日志面板 React 元素。 */
function findLogsElement(node: React.ReactNode): React.ReactElement<React.ComponentProps<typeof ServerOpsLogsPanel>> | null {
  /** 尚未找到时递归检查子节点。 */
  let found: React.ReactElement<React.ComponentProps<typeof ServerOpsLogsPanel>> | null = null
  React.Children.forEach(node, (child) => {
    if (found || !React.isValidElement<{ children?: React.ReactNode }>(child)) return
    if (child.type === ServerOpsLogsPanel) {
      found = child as React.ReactElement<React.ComponentProps<typeof ServerOpsLogsPanel>>
      return
    }
    found = findLogsElement(child.props.children)
  })
  return found
}

interface MinimalEventTarget {
  addEventListener: () => void
  removeEventListener: () => void
}

/** 创建只执行日志生命周期探针的最小 React reconciliation 宿主。 */
function createReconciliationRoot(): {
  render: (node: React.ReactElement) => void
  unmount: () => void
  restore: () => void
} {
  const eventTarget: MinimalEventTarget = { addEventListener: () => undefined, removeEventListener: () => undefined }
  class FakeHtmlIFrameElement {}
  const fakeWindow = { ...eventTarget, event: undefined, HTMLIFrameElement: FakeHtmlIFrameElement }
  const fakeDocument = {
    ...eventTarget,
    nodeType: 9,
    defaultView: fakeWindow,
    activeElement: null,
    body: null,
    documentElement: { namespaceURI: 'http://www.w3.org/1999/xhtml' },
  }
  const container = {
    ...eventTarget,
    nodeType: 1,
    tagName: 'DIV',
    namespaceURI: 'http://www.w3.org/1999/xhtml',
    ownerDocument: fakeDocument,
  }
  const globals = globalThis as unknown as { window?: unknown; document?: unknown; IS_REACT_ACT_ENVIRONMENT?: boolean }
  const previousWindow = globals.window
  const previousDocument = globals.document
  const previousActEnvironment = globals.IS_REACT_ACT_ENVIRONMENT
  globals.window = fakeWindow
  globals.document = fakeDocument
  globals.IS_REACT_ACT_ENVIRONMENT = true
  const root = createRoot(container as unknown as Element)
  return {
    render: (node) => { root.render(node) },
    unmount: () => { root.unmount() },
    restore: () => {
      globals.window = previousWindow
      globals.document = previousDocument
      globals.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
    },
  }
}

/** 传输收口的真实快照形状；测试只关心 status。 */
interface TransferSnapshotStub {
  status: string
}

/** 只渲染传输退出确认 hook 的探针。 */
function TransferLeaveProbe({
  scopeKey,
  onRequestLeave,
}: {
  scopeKey: string | null
  onRequestLeave: (requestLeave: (action: () => void) => void) => void
}): React.ReactElement {
  /** 真实的传输退出确认能力。 */
  const { requestLeave, dialog } = useServerOpsTransferLeave(scopeKey)
  React.useEffect(() => {
    onRequestLeave(requestLeave)
  }, [onRequestLeave, requestLeave])
  return <>{dialog}</>
}

/**
 * 创建注入 electronAPI 的最小 React root。
 *
 * `createReconciliationRoot` 只提供 window/document 骨架，
 * 这里再补上传出确认需要的两个 IPC 方法。
 *
 * @param electronApi 传输相关 IPC 替身
 * @returns 可渲染、可卸载并恢复全局环境的最小 root
 */
function createTransferLeaveRoot(electronApi: {
  listServerOpsTransfers: () => Promise<TransferSnapshotStub[]>
  closeServerOpsTransferOwner: () => Promise<void>
}): {
  render: (node: React.ReactElement) => void
  unmount: () => void
  restore: () => void
} {
  const eventTarget: MinimalEventTarget = { addEventListener: () => undefined, removeEventListener: () => undefined }
  class FakeHtmlIFrameElement {}
  const fakeWindow = { ...eventTarget, event: undefined, HTMLIFrameElement: FakeHtmlIFrameElement, electronAPI: electronApi }
  const fakeDocument = {
    ...eventTarget,
    nodeType: 9,
    defaultView: fakeWindow,
    activeElement: null,
    body: null,
    documentElement: { namespaceURI: 'http://www.w3.org/1999/xhtml' },
  }
  const container = {
    ...eventTarget,
    nodeType: 1,
    tagName: 'DIV',
    namespaceURI: 'http://www.w3.org/1999/xhtml',
    ownerDocument: fakeDocument,
  }
  const globals = globalThis as unknown as { window?: unknown; document?: unknown; IS_REACT_ACT_ENVIRONMENT?: boolean }
  const previousWindow = globals.window
  const previousDocument = globals.document
  const previousActEnvironment = globals.IS_REACT_ACT_ENVIRONMENT
  globals.window = fakeWindow
  globals.document = fakeDocument
  globals.IS_REACT_ACT_ENVIRONMENT = true
  const root = createRoot(container as unknown as Element)
  return {
    render: (node) => { root.render(node) },
    unmount: () => { root.unmount() },
    restore: () => {
      globals.window = previousWindow
      globals.document = previousDocument
      globals.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
    },
  }
}

interface LogsLifecycleProbeProps extends React.ComponentProps<typeof ServerOpsLogsPanel> {
  start: (input: ServerOpsLogStartInput) => Promise<ServerOpsLogStartResult>
  stop: (input: ServerOpsLogIdentity) => Promise<void>
  onController: (controller: ServerOpsLogsController) => void
  onProjection: (projection: ServerOpsLogsProjection) => void
}

/** 以真实 controller 生命周期观测 Workspace key 对 React 实例复用的影响。 */
function LogsLifecycleProbe({
  hostId,
  connectionId,
  active,
  connected,
  start,
  stop,
  onController,
  onProjection,
}: LogsLifecycleProbeProps): null {
  /** 每个 React 实例只创建一个日志 controller。 */
  const [controller] = React.useState(() => createServerOpsLogsController({
    start,
    stop,
    acknowledge: async () => undefined,
    exportLogs: async () => ({ saved: false }),
    publish: onProjection,
    notify: () => undefined,
    scheduleMaterialize: (callback) => {
      callback()
      return () => undefined
    },
  }))
  React.useEffect(() => {
    onController(controller)
    controller.activate()
    return () => controller.dispose()
  }, [controller, onController])
  React.useEffect(() => {
    void controller.select({ hostId, connectionId, active, connected })
  }, [active, connected, connectionId, controller, hostId])
  return null
}

describe('服务器运维右侧工作区', () => {
  test('Given 旧审计 success 迟到 When 完整筛选目标已切换 Then 不能覆盖新请求', async () => {
    /** 旧目标与新目标各自可控的 IPC 响应。 */
    const oldRead = createDeferred<{ records: ServerOpsAuditRecord[] }>()
    const nextRead = createDeferred<{ records: ServerOpsAuditRecord[] }>()
    /** 控制器发布的审计投影历史。 */
    const projections: Array<{ query: unknown; status: string; records: ServerOpsAuditRecord[]; error: string | null }> = []
    /** 按调用次序返回旧、新两个请求。 */
    let callCount = 0
    const controller = createServerOpsAuditController({
      listAudit: () => (++callCount === 1 ? oldRead.promise : nextRead.promise),
      publish: (projection) => { projections.push(projection) },
    })
    controller.activate()
    const oldRequest = controller.select({ hostFilter: 'current', actorFilter: 'agent', operationFilter: 'exec', selectedHostId: 'host-1' })
    const nextRequest = controller.select({ hostFilter: 'all', actorFilter: 'all', operationFilter: 'connect', selectedHostId: 'host-2' })

    oldRead.resolve({ records: [{
      id: 'audit-old', timestamp: 1, sessionId: 'session-1', hostId: 'host-1', actor: 'agent', operation: 'exec',
      phase: 'result', outcome: 'success', exitCode: 0,
    }] })
    await oldRequest
    expect(projections.at(-1)).toMatchObject({
      query: { hostFilter: 'all', actorFilter: 'all', operationFilter: 'connect', selectedHostId: 'host-2' }, status: 'loading', records: [],
    })

    nextRead.resolve({ records: [] })
    await nextRequest
    expect(projections.at(-1)).toMatchObject({ status: 'ready', records: [] })
  })

  test('Given 刷新已推进请求代次 When 旧审计 reject 迟到 Then 不覆盖刷新结果或错误', async () => {
    /** 首次读取与刷新读取的可控响应。 */
    const oldRead = createDeferred<{ records: ServerOpsAuditRecord[] }>()
    const refreshRead = createDeferred<{ records: ServerOpsAuditRecord[] }>()
    /** 控制器发布的审计投影历史。 */
    const projections: Array<{ query: unknown; status: string; records: ServerOpsAuditRecord[]; error: string | null }> = []
    /** 按调用次序返回旧请求与刷新请求。 */
    let callCount = 0
    const controller = createServerOpsAuditController({
      listAudit: () => (++callCount === 1 ? oldRead.promise : refreshRead.promise),
      publish: (projection) => { projections.push(projection) },
    })
    controller.activate()
    const firstRequest = controller.select({ hostFilter: 'current', actorFilter: 'all', operationFilter: 'all', selectedHostId: 'host-1' })
    const refreshRequest = controller.refresh()

    oldRead.reject(new Error('OLD_AUDIT_ERROR'))
    await firstRequest
    expect(projections.at(-1)).toMatchObject({ status: 'loading', error: null })

    refreshRead.resolve({ records: [] })
    await refreshRequest
    expect(projections.at(-1)).toMatchObject({ status: 'ready', records: [], error: null })
  })

  test('Given 当前服务器筛选但没有 selectedHost When 选择审计目标 Then 同步清空旧状态并显示 ready 空态', async () => {
    /** 审计 IPC 调用次数，无服务器时必须保持为零。 */
    let calls = 0
    /** 控制器发布的审计投影历史。 */
    const projections: Array<{ query: unknown; status: string; records: ServerOpsAuditRecord[]; error: string | null }> = []
    const controller = createServerOpsAuditController({
      listAudit: async () => { calls += 1; return { records: [] } },
      publish: (projection) => { projections.push(projection) },
    })
    controller.activate()

    await controller.select({ hostFilter: 'current', actorFilter: 'all', operationFilter: 'all', selectedHostId: null })

    expect(calls).toBe(0)
    expect(projections.at(-1)).toMatchObject({ status: 'ready', records: [], error: null })
  })

  test('Given 审计 owner 已 dispose When 旧请求随后完成 Then 不再发布任何投影', async () => {
    /** 卸载前发出的可控审计请求。 */
    const read = createDeferred<{ records: ServerOpsAuditRecord[] }>()
    /** 卸载前后的投影历史。 */
    const projections: Array<{ query: unknown; status: string; records: ServerOpsAuditRecord[]; error: string | null }> = []
    const controller = createServerOpsAuditController({
      listAudit: () => read.promise,
      publish: (projection) => { projections.push(projection) },
    })
    controller.activate()
    const request = controller.select({ hostFilter: 'all', actorFilter: 'all', operationFilter: 'all', selectedHostId: 'host-1' })
    controller.dispose()
    const countAfterDispose = projections.length

    read.resolve({ records: [] })
    await request

    expect(projections).toHaveLength(countAfterDispose)
  })

  test('Given 审计页正在加载、失败或为空 When 渲染 Then 显示独立状态与刷新入口', () => {
    const host = createHost()
    for (const [auditStatus, expected] of [
      ['loading', '正在读取审计记录...'],
      ['error', '审计记录读取失败'],
      ['ready', '暂无审计记录'],
    ] as const) {
      const html = renderToStaticMarkup(
        <ServerOpsWorkspaceView
          {...createCallbacks()}
          status="ready"
          hosts={[host]}
          selectedHost={host}
          activeSection="audit"
          auditStatus={auditStatus}
          auditError={auditStatus === 'error' ? 'SERVER_OPS_AUDIT_READ_FAILED' : null}
          auditRecords={[]}
          auditHostFilter="current"
          auditOperationFilter="all"
          onAuditHostFilterChange={() => undefined}
          onAuditOperationFilterChange={() => undefined}
          onRefreshAudit={() => undefined}
        />,
      )
      expect(html).toContain(expected)
      if (auditStatus === 'error') expect(html).toContain('SERVER_OPS_AUDIT_READ_FAILED')
    }
  })

  test('Given 审计记录 When 选择筛选 Then 展示时间、操作、结果、脱敏命令和错误码且控件可访问', () => {
    const host = createHost()
    /** Renderer 只消费主进程返回的公开审计 DTO。 */
    const records: ServerOpsAuditRecord[] = [
      {
        id: 'audit-1', timestamp: Date.UTC(2026, 8, 5), sessionId: 'session-1', hostId: 'host-1', actor: 'agent',
        operation: 'exec', phase: 'result', outcome: 'success', durationMs: 20,
        command: 'echo ok', exitCode: 0, commandTruncated: false,
      },
      {
        id: 'audit-2', timestamp: Date.UTC(2026, 8, 5, 0, 1), sessionId: 'session-1', hostId: 'host-1', actor: 'agent',
        operation: 'exec', phase: 'result', outcome: 'error', durationMs: 25,
        command: 'curl --token [REDACTED]', exitCode: 23, commandTruncated: true,
      },
      {
        id: 'audit-3', timestamp: Date.UTC(2026, 8, 5, 0, 2), sessionId: 'session-1', hostId: 'host-1', actor: 'agent',
        operation: 'exec', phase: 'result', outcome: 'error', durationMs: 30,
        command: 'run worker', signal: 'SIGTERM', commandTruncated: false,
      },
      {
        id: 'audit-4', timestamp: Date.UTC(2026, 8, 5, 0, 3), sessionId: 'session-1', hostId: 'host-1', actor: 'agent',
        operation: 'exec', phase: 'result', outcome: 'error', durationMs: 35,
        command: 'read remote', errorCode: 'REMOTE_EXEC_FAILED', commandTruncated: false,
      },
    ]
    const html = renderToStaticMarkup(
      <ServerOpsWorkspaceView
        {...createCallbacks()}
        status="ready"
        hosts={[host]}
        selectedHost={host}
        activeSection="audit"
        auditStatus="ready"
        auditRecords={records}
        auditHostFilter="all"
        auditOperationFilter="exec"
        onAuditHostFilterChange={() => undefined}
        onAuditOperationFilterChange={() => undefined}
        onRefreshAudit={() => undefined}
      />,
    )

    expect(html).toContain('全部服务器')
    expect(html).toContain('执行命令')
    expect(html).toContain('成功')
    expect(html).toContain('失败')
    expect(html).toContain('curl --token [REDACTED]')
    expect(html).toContain('REMOTE_EXEC_FAILED')
    expect(html).toContain('退出码 0')
    expect(html).toContain('退出码 23')
    expect(html).toContain('Signal SIGTERM')
    expect(html).toContain('命令摘要已截断')
    expect(html).toContain('aria-label="筛选审计操作"')
  })

  test('Given 用户服务动作审计 When 渲染审计页 Then 显示 actor、unit 与动作且不显示命令占位', () => {
    const host = createHost()
    /** 用户确认后产生的服务重启结果审计。 */
    const serviceRecord: ServerOpsAuditRecord = {
      id: 'audit-service-1',
      timestamp: Date.UTC(2026, 8, 5),
      sessionId: 'session-1',
      hostId: 'host-1',
      actor: 'user',
      operation: 'service-restart',
      phase: 'result',
      outcome: 'success',
      unitId: 'nginx.service',
    }
    const html = renderToStaticMarkup(
      <ServerOpsWorkspaceView
        {...createCallbacks()}
        status="ready"
        hosts={[host]}
        selectedHost={host}
        activeSection="audit"
        auditStatus="ready"
        auditRecords={[serviceRecord]}
        auditHostFilter="current"
        auditActorFilter="user"
        auditOperationFilter="service-restart"
      />,
    )

    expect(html).toContain('用户')
    expect(html).toContain('nginx.service')
    expect(html).toContain('重启')
    expect(html).not.toContain('命令：-')
    expect(html).toContain('aria-label="筛选审计主体"')
    expect(html).not.toContain('<option value="exec">')
  })

  test('Given 信任审计包含进行中和未知结果 When 渲染 Then 显示稳定中文且不渲染缺失身份', () => {
    const host = createHost()
    const records: ServerOpsAuditRecord[] = [
      {
        id: 'audit-trust-start', operationId: 'operation-1', timestamp: Date.UTC(2026, 8, 7), windowId: 7,
        hostId: host.id, actor: 'user', operation: 'trust-replace', resourceType: 'host-trust', phase: 'start', outcome: 'pending',
      },
      {
        id: 'audit-trust-result', operationId: 'operation-2', timestamp: Date.UTC(2026, 8, 7, 0, 1), windowId: 7,
        hostId: host.id, actor: 'user', operation: 'trust-revoke', resourceType: 'host-trust', phase: 'result', outcome: 'unknown',
      },
    ]
    const html = renderToStaticMarkup(
      <ServerOpsWorkspaceView
        {...createCallbacks()} status="ready" hosts={[host]} selectedHost={host} activeSection="audit"
        auditStatus="ready" auditRecords={records} auditActorFilter="user" auditOperationFilter="all"
      />,
    )

    expect(html).toContain('替换服务器信任')
    expect(html).toContain('撤销服务器信任')
    expect(html).toContain('进行中')
    expect(html).toContain('结果未知')
    expect(html).not.toContain('undefined')
    expect(html).toContain('<option value="trust-replace">')
    expect(html).toContain('<option value="trust-revoke">')
  })

  test('Given 已选择服务器 When 渲染工具栏 Then 次要服务器操作收进菜单且 Agent Shield 权限入口保持可见', () => {
    const host = createHost()
    const html = renderToStaticMarkup(
      <ServerOpsWorkspaceView {...createCallbacks()} status="ready" hosts={[host]} selectedHost={host} activeSection="overview" />,
    )

    expect(html).toContain('aria-label="更多服务器操作"')
    expect(html).toContain('aria-label="允许当前 Agent 使用此服务器"')
  })

  test('Given 审计 actor 筛选 When 加载当前主机服务操作 Then IPC 包含完整 actor 与 operation', async () => {
    /** 记录控制器映射出的公开 IPC 筛选。 */
    const inputs: unknown[] = []
    const controller = createServerOpsAuditController({
      listAudit: async (input) => {
        inputs.push(input)
        return { records: [] }
      },
      publish: () => undefined,
    })
    controller.activate()

    await controller.select({
      hostFilter: 'current',
      actorFilter: 'user',
      operationFilter: 'service-restart',
      selectedHostId: 'host-1',
    })

    expect(inputs).toEqual([{
      hostId: 'host-1',
      actor: 'user',
      operation: 'service-restart',
      limit: 500,
    }])
  })

  test('Given 新旧控制器共享投影 sink When 旧 owner 卸载后请求迟到 Then 不覆盖新 owner 或报告错误', async () => {
    /** 两个组件 owner 共享的 Jotai 投影 sink。 */
    const sharedProjections: ServerOpsAgentAccessProjection[] = []
    /** 旧 owner 的可控读取。 */
    const oldRead = createDeferred<ServerOpsAgentAccess | null>()
    /** 旧 owner 的可控写入。 */
    const oldWrite = createDeferred<ServerOpsAgentAccess | null>()
    /** 卸载后不得出现的 toast。 */
    const oldErrors: string[] = []
    const oldController = createServerOpsAgentAccessController({
      getAccess: () => oldRead.promise,
      setAccess: () => oldWrite.promise,
      publish: (projection) => { sharedProjections.push(projection) },
      reportError: (message) => { oldErrors.push(message) },
    })
    oldController.activate()
    void oldController.select({ sessionId: 'agent-old', hostId: 'host-old' })
    const oldToggle = oldController.toggle()
    oldController.dispose()

    const newController = createServerOpsAgentAccessController({
      getAccess: async (target) => ({ ...target, granted: true }),
      setAccess: async (access) => access,
      publish: (projection) => { sharedProjections.push(projection) },
      reportError: () => undefined,
    })
    newController.activate()
    await newController.select({ sessionId: 'agent-new', hostId: 'host-new' })
    const newOwnerProjectionCount = sharedProjections.length

    oldRead.resolve({ sessionId: 'agent-old', hostId: 'host-old', granted: true })
    oldWrite.reject(new Error('旧 owner 失败'))
    await oldToggle
    await flushPromises()

    expect(sharedProjections).toHaveLength(newOwnerProjectionCount)
    expect(sharedProjections.at(-1)).toMatchObject({
      target: { sessionId: 'agent-new', hostId: 'host-new' },
      access: { sessionId: 'agent-new', hostId: 'host-new', granted: true },
    })
    expect(oldErrors).toEqual([])
  })

  test('Given StrictMode 重放同一 controller When dispose 后重新 activate Then fresh-read 当前目标', async () => {
    const harness = createAgentAccessHarness(false)
    harness.controller.activate()
    await harness.controller.select({ sessionId: 'agent-1', hostId: 'host-1' })
    harness.controller.dispose()
    harness.controller.activate()
    await harness.controller.select({ sessionId: 'agent-1', hostId: 'host-1' })

    expect(harness.getCalls).toEqual([
      { sessionId: 'agent-1', hostId: 'host-1' },
      { sessionId: 'agent-1', hostId: 'host-1' },
    ])
  })

  test('Given Renderer 投影仍属于旧目标 When 绑定新目标 Then 按钮禁用且不显示旧授权', () => {
    /** 旧主机的已授权投影。 */
    const projection: ServerOpsAgentAccessProjection = {
      target: { sessionId: 'agent-1', hostId: 'host-old' },
      access: { sessionId: 'agent-1', hostId: 'host-old', granted: true },
      status: 'ready',
      error: null,
    }
    /** 组件绑定新主机时必须先进入等待主进程事实的状态。 */
    const viewState = resolveServerOpsAgentAccessViewState({
      projection,
      sessionId: 'agent-1',
      hostId: 'host-new',
    })
    const html = renderToStaticMarkup(
      <ServerOpsWorkspaceView
        {...createCallbacks()}
        status="ready"
        hosts={[{ ...createHost(), id: 'host-new' }]}
        selectedHost={{ ...createHost(), id: 'host-new' }}
        activeSection="overview"
        {...viewState}
        onToggleAgentAccess={() => undefined}
      />,
    )

    expect(viewState).toMatchObject({ agentAccessGranted: false, agentAccessStatus: 'loading' })
    expect(html).toContain('aria-pressed="false"')
    expect(html).toContain('data-server-ops-agent-access="true" disabled=""')
    expect(html).not.toContain('aria-label="撤销当前 Agent 的服务器权限"')
  })

  test('Given 没有 selectedHost When 渲染顶栏 Then 显示禁用 Shield 并提示先选服务器', () => {
    const html = renderToStaticMarkup(
      <ServerOpsWorkspaceView
        {...createCallbacks()}
        status="ready"
        hosts={[]}
        selectedHost={null}
        activeSection="overview"
        agentAccessAvailable={false}
        agentAccessGranted={false}
        agentAccessStatus="idle"
        agentAccessDisabledReason="请先选择服务器"
        onToggleAgentAccess={() => undefined}
      />,
    )

    expect(html).toContain('data-server-ops-agent-access="true" disabled=""')
    expect(html).toContain('aria-label="请先选择服务器"')
    expect(html).toContain('aria-pressed="false"')
  })

  test('Given 定时任务会话 When 解析授权会话 Then 返回禁用原因而不是发起授权请求', () => {
    /** 用户自己新建的普通 Agent 会话。 */
    const ordinarySession = { id: 'agent-1', title: '排查 API 延迟', createdAt: 1, updatedAt: 1 }
    /** 定时任务创建的会话；列表里可见，但不允许获取服务器授权。 */
    const automationSession = {
      id: 'agent-automation', title: '用心读书每日汇报', sourceAutomationId: 'automation-1', createdAt: 1, updatedAt: 1,
    }

    expect(resolveServerOpsAgentAccessSession([ordinarySession], 'agent-1')).toEqual({ sessionId: 'agent-1' })
    expect(resolveServerOpsAgentAccessSession([ordinarySession], null)).toEqual({ sessionId: null })
    /** 元数据尚未加载时保持原行为，由主进程守卫兜底。 */
    expect(resolveServerOpsAgentAccessSession([], 'agent-1')).toEqual({ sessionId: 'agent-1' })

    /** 定时任务会话解析后的授权身份。 */
    const resolved = resolveServerOpsAgentAccessSession([ordinarySession, automationSession], 'agent-automation')
    expect(resolved.sessionId).toBeNull()
    expect(resolved.unavailableReason).toBe('当前会话不是普通 Agent 会话（定时任务或子会话），请切换会话后再授权')
  })

  test('Given 定时任务会话 When 渲染顶栏 Then 禁用 Shield 并给出会话类型原因', () => {
    /** 会话类型不可用时同步计算出的视图状态。 */
    const viewState = resolveServerOpsAgentAccessViewState({
      projection: { target: null, access: null, status: 'idle', error: null },
      sessionId: null,
      hostId: 'host-1',
      sessionUnavailableReason: '当前会话不是普通 Agent 会话（定时任务或子会话），请切换会话后再授权',
    })
    /** 顶栏 Shield 的静态标记。 */
    const html = renderToStaticMarkup(
      <ServerOpsWorkspaceView
        {...createCallbacks()}
        status="ready"
        hosts={[createHost()]}
        selectedHost={createHost()}
        activeSection="overview"
        {...viewState}
        onToggleAgentAccess={() => undefined}
      />,
    )

    expect(viewState).toMatchObject({ agentAccessAvailable: false, agentAccessStatus: 'idle' })
    expect(html).toContain('data-server-ops-agent-access="true" disabled=""')
    expect(html).toContain('aria-label="当前会话不是普通 Agent 会话（定时任务或子会话），请切换会话后再授权"')
    expect(html).not.toContain('aria-label="请先打开普通 Agent 会话"')
  })

  test('Given 没有普通 Agent session When 渲染顶栏 Then 禁用 Shield 并提示先打开会话', () => {
    /** 当前已选择服务器，但不存在普通 Agent 会话。 */
    const host = createHost()
    const html = renderToStaticMarkup(
      <ServerOpsWorkspaceView
        {...createCallbacks()}
        status="ready"
        hosts={[host]}
        selectedHost={host}
        activeSection="overview"
        agentAccessAvailable={false}
        agentAccessGranted={false}
        agentAccessStatus="idle"
        agentAccessDisabledReason="请先打开普通 Agent 会话"
        onToggleAgentAccess={() => undefined}
      />,
    )

    expect(html).toContain('data-server-ops-agent-access="true" disabled=""')
    expect(html).toContain('aria-label="请先打开普通 Agent 会话"')
    expect(html).toContain('aria-pressed="false"')
    expect(html).toContain('data-server-ops-agent-access-tooltip-trigger="true" tabindex="0" aria-label="请先打开普通 Agent 会话"')
  })

  test('Given SSH 未连接 When 渲染授权按钮 Then 当前 Agent 仍可授权且文案准确', () => {
    /** 当前选中的测试服务器。 */
    const host = createHost()
    /** 未连接但具备普通 Agent 会话的工作区。 */
    const html = renderToStaticMarkup(
      <ServerOpsWorkspaceView
        {...createCallbacks()}
        status="ready"
        hosts={[host]}
        selectedHost={host}
        activeSection="overview"
        agentAccessAvailable
        agentAccessGranted={false}
        agentAccessStatus="ready"
        onToggleAgentAccess={() => undefined}
      />,
    )

    expect(html).toContain('aria-label="允许当前 Agent 使用此服务器"')
    expect(html).toContain('aria-pressed="false"')
    expect(html).toContain('允许当前 Agent 使用此服务器')
    expect(html).not.toContain('data-server-ops-agent-access="true" disabled=""')
    expect(html).not.toContain('data-server-ops-agent-access-tooltip-trigger="true" tabindex="0"')
  })

  test('Given 已授权或正在同步 When 渲染授权按钮 Then aria-pressed、Tooltip 和 loading 可感知', () => {
    /** 当前选中的测试服务器。 */
    const host = createHost()
    /** 已授权工作区。 */
    const grantedHtml = renderToStaticMarkup(
      <ServerOpsWorkspaceView
        {...createCallbacks()}
        status="ready"
        hosts={[host]}
        selectedHost={host}
        activeSection="overview"
        agentAccessAvailable
        agentAccessGranted
        agentAccessStatus="ready"
        onToggleAgentAccess={() => undefined}
      />,
    )
    /** 正在撤销的工作区。 */
    const loadingHtml = renderToStaticMarkup(
      <ServerOpsWorkspaceView
        {...createCallbacks()}
        status="ready"
        hosts={[host]}
        selectedHost={host}
        activeSection="overview"
        agentAccessAvailable
        agentAccessGranted
        agentAccessStatus="loading"
        onToggleAgentAccess={() => undefined}
      />,
    )

    expect(grantedHtml).toContain('aria-label="撤销当前 Agent 的服务器权限"')
    expect(grantedHtml).toContain('aria-pressed="true"')
    expect(grantedHtml).toContain('撤销当前 Agent 的服务器权限')
    expect(loadingHtml).toContain('aria-busy="true"')
    expect(loadingHtml).toContain('正在同步当前 Agent 的服务器权限')
    expect(loadingHtml).toContain('disabled=""')
  })

  test('Given 当前身份 When grant 和 revoke 未完成 Then 保持原事实并发布 loading', async () => {
    const harness = createAgentAccessHarness()
    const grant = createDeferred<ServerOpsAgentAccess | null>()
    const revoke = createDeferred<ServerOpsAgentAccess | null>()
    await harness.controller.select({ sessionId: 'agent-1', hostId: 'host-1' })
    harness.setSetAccess((access) => {
      harness.setCalls.push(access)
      return access.granted ? grant.promise : revoke.promise
    })

    const granting = harness.controller.toggle()
    expect(harness.projections.at(-1)).toMatchObject({ status: 'loading', access: null })
    grant.resolve({ sessionId: 'agent-1', hostId: 'host-1', granted: true })
    await granting
    expect(harness.projections.at(-1)).toMatchObject({ status: 'ready', access: { granted: true } })

    const revoking = harness.controller.toggle()
    expect(harness.projections.at(-1)).toMatchObject({ status: 'loading', access: { granted: true } })
    revoke.resolve(null)
    await revoking
    expect(harness.projections.at(-1)).toMatchObject({ status: 'ready', access: null })
  })

  test('Given IPC 写入失败 When 切换授权 Then 不伪造授权并报告错误', async () => {
    const harness = createAgentAccessHarness()
    await harness.controller.select({ sessionId: 'agent-1', hostId: 'host-1' })
    harness.setSetAccess(async (access) => {
      harness.setCalls.push(access)
      throw new Error('IPC unavailable')
    })

    await harness.controller.toggle()

    expect(harness.projections.at(-1)).toMatchObject({ status: 'error', access: null, error: 'IPC unavailable' })
    expect(harness.errors).toEqual(['IPC unavailable'])
  })

  test('Given host 或 session 切换 When 旧读取迟到 Then 先撤销旧组合且不污染新组合', async () => {
    const harness = createAgentAccessHarness()
    const oldRead = createDeferred<ServerOpsAgentAccess | null>()
    const nextRead = createDeferred<ServerOpsAgentAccess | null>()
    harness.setGetAccess((target) => {
      harness.getCalls.push(target)
      return target.hostId === 'host-1' ? oldRead.promise : nextRead.promise
    })

    void harness.controller.select({ sessionId: 'agent-1', hostId: 'host-1' })
    await flushPromises()
    const switching = harness.controller.select({ sessionId: 'agent-2', hostId: 'host-2' })
    await flushPromises()
    expect(harness.setCalls).toEqual([{ sessionId: 'agent-1', hostId: 'host-1', granted: false }])
    expect(harness.getCalls.at(-1)).toEqual({ sessionId: 'agent-2', hostId: 'host-2' })

    nextRead.resolve({ sessionId: 'agent-2', hostId: 'host-2', granted: true })
    await switching
    oldRead.resolve({ sessionId: 'agent-1', hostId: 'host-1', granted: true })
    await flushPromises()
    expect(harness.projections.at(-1)).toMatchObject({
      target: { sessionId: 'agent-2', hostId: 'host-2' },
      access: { sessionId: 'agent-2', hostId: 'host-2', granted: true },
    })
  })

  test('Given 另一 Pane 移动已授权主机 When 当前项目退回清单 Then 保留授权直到用户显式离开', async () => {
    /** 模拟主进程的精确授权槽，项目移动不能触碰它。 */
    let authority: ServerOpsAgentAccess | null = { sessionId: 'agent-1', hostId: 'host-1', granted: true }
    /** 真实授权控制器通过模拟 IPC 观察是否发生撤销。 */
    const harness = createAgentAccessHarness()
    harness.setGetAccess(async () => authority)
    harness.setSetAccess(async (access) => { harness.setCalls.push(access); authority = access.granted ? access : null; return authority })
    /** 当前 Pane 原先明确查看项目一的服务器。 */
    const selection = { sessionId: 'agent-1', selectedConnectionId: 'ssh:host-1', projectViewActive: false }
    const source = { projects: [], hosts: [{ ...createHost(), projectId: 'project-1' }], dataSources: [], connectionStates: {} }
    await harness.controller.select(resolveServerOpsAgentAccessTarget({ ...selection, connections: buildServerOpsConnections(source) }))
    /** 另一 Pane 的移动回执只改变共享归属。 */
    const connections = buildServerOpsConnections({ ...source, hosts: [{ ...source.hosts[0]!, projectId: 'project-2' }] })
    expect(resolveServerOpsWorkspaceTarget({ ...selection, connections: connections.filter((entry) => entry.projectId === 'project-1') })).toEqual({ kind: 'project' })
    expect(resolveServerOpsAgentAccessTarget({ ...selection, connections })).toEqual({ sessionId: 'agent-1', hostId: 'host-1' })
    await harness.controller.select(resolveServerOpsAgentAccessTarget({ ...selection, connections }))
    expect(harness.setCalls).toEqual([])
    expect(authority).toEqual({ sessionId: 'agent-1', hostId: 'host-1', granted: true })

    /** 显式进入项目仍按原规则撤销，不能把移动特例变成永久授权。 */
    await harness.controller.select(resolveServerOpsAgentAccessTarget({ ...selection, connections, projectViewActive: true }))
    expect(harness.setCalls).toEqual([{ sessionId: 'agent-1', hostId: 'host-1', granted: false }])
    expect(authority).toBeNull()
  })

  test('Given 全局主机已删除或身份无效 When 解析移动后的授权目标 Then 返回空且删除会撤销原组合', async () => {
    /** 有效的全局连接，不通过字符串前缀推测主机身份。 */
    const connections = buildServerOpsConnections({ projects: [], hosts: [createHost()], dataSources: [], connectionStates: {} })
    const selection = { sessionId: 'agent-1', selectedConnectionId: 'ssh:host-1', projectViewActive: false, connections }
    const harness = createAgentAccessHarness()
    await harness.controller.select(resolveServerOpsAgentAccessTarget(selection))
    expect(resolveServerOpsAgentAccessTarget({ ...selection, sessionId: null })).toBeNull()
    expect(resolveServerOpsAgentAccessTarget({ ...selection, selectedConnectionId: 'ssh:missing' })).toBeNull()
    await harness.controller.select(resolveServerOpsAgentAccessTarget({ ...selection, connections: [] }))
    expect(harness.setCalls).toEqual([{ sessionId: 'agent-1', hostId: 'host-1', granted: false }])
  })

  test('Given 当前组合已授权 When SSH disconnect 完成 Then Renderer 投影立即撤销', async () => {
    const harness = createAgentAccessHarness()
    harness.setGetAccess(async (target) => ({ ...target, granted: true }))
    await harness.controller.select({ sessionId: 'agent-1', hostId: 'host-1' })

    harness.controller.resetAfterDisconnect({ sessionId: 'agent-1', hostId: 'host-1' })

    expect(harness.projections.at(-1)).toMatchObject({ status: 'ready', access: null })
  })

  test('Given 主进程授权 Store 变化 When 收到事件 Then 仅同步当前精确组合', async () => {
    const harness = createAgentAccessHarness()
    await harness.controller.select({ sessionId: 'agent-1', hostId: 'host-1' })
    /** 当前组合获得授权的主进程事件。 */
    const grantedEvent: ServerOpsAgentAccessChanged = {
      previous: null,
      current: { sessionId: 'agent-1', hostId: 'host-1', granted: true },
    }
    harness.controller.handleChanged(grantedEvent)
    expect(harness.projections.at(-1)).toMatchObject({ status: 'ready', access: grantedEvent.current })

    harness.controller.handleChanged({
      previous: grantedEvent.current,
      current: { sessionId: 'agent-2', hostId: 'host-2', granted: true },
    })
    expect(harness.projections.at(-1)).toMatchObject({ status: 'ready', access: null })

    /** 与当前组合无关的事件不得改变投影。 */
    const beforeUnrelated = harness.projections.length
    harness.controller.handleChanged({
      previous: null,
      current: { sessionId: 'agent-3', hostId: 'host-3', granted: true },
    })
    expect(harness.projections).toHaveLength(beforeUnrelated)
  })

  test('已有凭据和 SSH Agent 直接连接，缺少凭据时才补录', () => {
    /** 带安全凭据引用的密码主机。 */
    const passwordHost: ServerOpsHost = { ...createHost(), authMethod: 'password', credentialRef: 'credential-1' }
    /** 尚未保存密码的主机。 */
    const missingCredentialHost: ServerOpsHost = { ...passwordHost }
    delete missingCredentialHost.credentialRef

    expect(shouldPromptForServerOpsCredential(passwordHost)).toBe(false)
    expect(shouldPromptForServerOpsCredential(createHost())).toBe(false)
    expect(shouldPromptForServerOpsCredential(missingCredentialHost)).toBe(true)
  })

  test('凭据缺失、解密、私钥读取和认证错误进入补录流程', () => {
    for (const errorCode of [
      'SERVER_OPS_CREDENTIAL_REQUIRED',
      'SERVER_OPS_CREDENTIAL_DECRYPT_FAILED',
      'SERVER_OPS_SECURE_STORAGE_UNAVAILABLE',
      'SERVER_OPS_PRIVATE_KEY_UNAVAILABLE',
      'SERVER_OPS_AUTH_FAILED',
    ]) {
      expect(isServerOpsCredentialRecoveryState({ hostId: 'host-1', phase: 'error', errorCode })).toBe(true)
    }
    expect(isServerOpsCredentialRecoveryState({
      hostId: 'host-1',
      phase: 'error',
      errorCode: 'SERVER_OPS_CONNECTION_TIMEOUT',
    })).toBe(false)
  })

  test('无服务器时呈现真实空状态和添加入口', () => {
    /** 空主机工作区 HTML。 */
    const html = renderToStaticMarkup(
      <ServerOpsWorkspaceView
        {...createCallbacks()}
        status="ready"
        hosts={[]}
        selectedHost={null}
        activeSection="overview"
      />,
    )

    expect(html).toContain('data-server-ops-workspace="true"')
    expect(html).toContain('还没有服务器')
    expect(html).toContain('添加服务器')
    expect(html).not.toContain('CPU 使用率')
  })

  test('选中服务器后挂载真实概览面板且不保留静态占位指标', () => {
    /** 当前选中的测试服务器。 */
    const host = createHost()
    /** 概览工作区 HTML。 */
    const overviewHtml = renderToStaticMarkup(
      <ServerOpsWorkspaceView
        {...createCallbacks()}
        status="ready"
        hosts={[host]}
        selectedHost={host}
        activeSection="overview"
      />,
    )

    for (const label of ['概览', '终端', '服务', '日志', '文件', 'Docker', '审计']) {
      expect(overviewHtml).toContain(label)
    }
    /**
     * 数据服务不再是页签：数据库 / Redis 是项目内的独立连接，
     * 从项目视图点进去才是数据服务详情，页签里不能出现第二个入口。
     */
    expect(overviewHtml).not.toContain('数据服务')
    expect(overviewHtml).toContain('生产 API')
    expect(overviewHtml).toContain('deploy@10.0.0.8:22')
    expect(overviewHtml).toContain('尚未连接')
    expect(overviewHtml).toContain('server-ops-workspace-container')
    expect(overviewHtml).toContain('data-server-ops-overview-panel="true"')
    expect(overviewHtml).toContain('data-server-ops-connection-action="true"')
    expect(overviewHtml).toContain('data-server-ops-connection-label="true"')
    expect(overviewHtml).not.toContain('68%')
    expect(overviewHtml).not.toContain('下一阶段')
    expect(overviewHtml).not.toContain('连接身份')
  })

  test('Given 项目制的连接视图 When 渲染 Then 提供返回项目入口且不再出现数据服务页签', () => {
    /** 当前选中的测试服务器。 */
    const host = createHost()
    /** 带项目导航的连接视图 HTML。 */
    const html = renderToStaticMarkup(
      <ServerOpsWorkspaceView
        {...createCallbacks()}
        status="ready"
        hosts={[host]}
        selectedHost={host}
        activeSection="overview"
        onBackToProject={() => undefined}
        projectLabel="默认项目"
      />,
    )

    /** 项目列表在抽屉里；回项目视图由面包屑第一段承担，不再单独占一个返回按钮。 */
    expect(html).toContain('aria-label="打开项目列表"')
    expect(html).toContain('aria-label="返回项目视图"')
    expect(html).toContain('data-server-ops-connection-project')
    expect(html).toContain('默认项目')
    expect(html).toContain('data-server-ops-connection-module')
    expect(html).not.toContain('数据服务')
  })

  test('Given 传输收口仍在进行 When 作用域发生变化 Then 挂起的离开动作被作废', async () => {
    /**
     * 这条断言锁住的是"点数据库却进了服务器界面"那类 bug 的机制：
     * 容器若在调用 `requestLeave` 之前就翻动视图，中间渲染会立刻按旧选择画出上一条连接，
     * 传输作用域随之变化，挂起中的确认被自己的中间渲染作废。
     * 因此导航必须在确认回调里一次性提交（见 ServerOpsWorkspace 的 handleSelectConnection）。
     */
    /** 可控结算的在途传输列表响应。 */
    const pendingList = createDeferred<TransferSnapshotStub[]>()
    const root = createTransferLeaveRoot({
      listServerOpsTransfers: () => pendingList.promise,
      closeServerOpsTransferOwner: async () => undefined,
    })
    /** 最近一次渲染拿到的 requestLeave。 */
    let requestLeave: ((action: () => void) => void) | null = null
    /** 实际提交的导航动作。 */
    const commits: string[] = []
    /** 探针回调必须稳定，避免 effect 反复触发。 */
    const handleRequestLeave = (next: (action: () => void) => void): void => { requestLeave = next }
    try {
      await act(async () => {
        root.render(<TransferLeaveProbe scopeKey="host-a" onRequestLeave={handleRequestLeave} />)
      })
      act(() => { requestLeave?.((() => { commits.push('leave') })) })
      /** 收口尚未返回时作用域变化：等价于容器提前把视图切到了上一条连接。 */
      await act(async () => {
        root.render(<TransferLeaveProbe scopeKey="host-b" onRequestLeave={handleRequestLeave} />)
      })
      await act(async () => {
        pendingList.resolve([])
        await pendingList.promise
        /** 收口链还有 closeOwner 与计数复位，全部在 act 内结算完，避免测试外的异步更新告警。 */
        await flushPromises()
        await flushPromises()
      })
      expect(commits).toEqual([])
    } finally {
      /** 卸载同样会触发 hook 的清理状态更新，必须包在 act 内。 */
      await act(async () => { root.unmount() })
      root.restore()
    }
  })

  test('Given 传输收口仍在进行 When 作用域未变 Then 动作照常提交', async () => {
    /** 可控结算的在途传输列表响应。 */
    const pendingList = createDeferred<TransferSnapshotStub[]>()
    const root = createTransferLeaveRoot({
      listServerOpsTransfers: () => pendingList.promise,
      closeServerOpsTransferOwner: async () => undefined,
    })
    /** 最近一次渲染拿到的 requestLeave。 */
    let requestLeave: ((action: () => void) => void) | null = null
    /** 实际提交的导航动作。 */
    const commits: string[] = []
    /** 探针回调必须稳定，避免 effect 反复触发。 */
    const handleRequestLeave = (next: (action: () => void) => void): void => { requestLeave = next }
    try {
      await act(async () => {
        root.render(<TransferLeaveProbe scopeKey="host-a" onRequestLeave={handleRequestLeave} />)
      })
      act(() => { requestLeave?.((() => { commits.push('leave') })) })
      await act(async () => {
        pendingList.resolve([])
        await pendingList.promise
        /** 收口链还有 closeOwner 与计数复位，全部在 act 内结算完，避免测试外的异步更新告警。 */
        await flushPromises()
        await flushPromises()
      })
      expect(commits).toEqual(['leave'])
    } finally {
      /** 卸载同样会触发 hook 的清理状态更新，必须包在 act 内。 */
      await act(async () => { root.unmount() })
      root.restore()
    }
  })

  test('Given 已选择服务器 When 在概览与服务页切换 Then 服务面板保持同一实例且仅切换 active', () => {
    const host = { ...createHost(), id: 'host-2', name: '生产数据库', address: '10.0.0.9', port: 2222, username: 'dbadmin' }
    const connectionState: ServerOpsConnectionState = {
      hostId: host.id,
      phase: 'connected',
      connectionId: 'connection-1',
    }
    const createView = (activeSection: 'overview' | 'services') => ServerOpsWorkspaceView({
      ...createCallbacks(),
      status: 'ready',
      hosts: [createHost(), host],
      selectedHost: host,
      activeSection,
      connectionState,
      agentSessionId: 'session-1',
    })

    const overviewServices = findServicesElement(createView('overview'))
    const activeServices = findServicesElement(createView('services'))

    expect(overviewServices).not.toBeNull()
    expect(activeServices).not.toBeNull()
    expect(overviewServices?.key).toBe(activeServices?.key)
    expect(overviewServices?.props).toMatchObject({
      sessionId: 'session-1', hostId: 'host-2', active: false, connected: true,
      hostLabel: '生产数据库', hostDescription: 'dbadmin@10.0.0.9:2222',
    })
    expect(activeServices?.props).toMatchObject({
      sessionId: 'session-1', hostId: 'host-2', active: true, connected: true,
      hostLabel: '生产数据库', hostDescription: 'dbadmin@10.0.0.9:2222',
    })
    expect(JSON.stringify(activeServices?.props)).not.toContain('connection-1')
  })

  test('Given 已选择服务器 When 在其它页与日志页切换 Then 日志面板按连接实例常驻且非活动时隐藏不可聚焦', () => {
    const host = { ...createHost(), id: 'host-2', name: '生产数据库', address: '10.0.0.9', port: 2222, username: 'dbadmin' }
    const connectionState: ServerOpsConnectionState = {
      hostId: host.id,
      phase: 'connected',
      connectionId: 'connection-logs-1',
    }
    const createView = (activeSection: 'overview' | 'logs') => ServerOpsWorkspaceView({
      ...createCallbacks(),
      status: 'ready',
      hosts: [host],
      selectedHost: host,
      activeSection,
      connectionState,
      agentSessionId: 'session-1',
    })

    const inactiveView = createView('overview')
    const activeView = createView('logs')
    const nextConnectionView = ServerOpsWorkspaceView({
      ...createCallbacks(),
      status: 'ready',
      hosts: [host],
      selectedHost: host,
      activeSection: 'logs',
      connectionState: { ...connectionState, connectionId: 'connection-logs-2' },
      agentSessionId: 'session-1',
    })
    const inactiveLogs = findLogsElement(inactiveView)
    const activeLogs = findLogsElement(activeView)
    const nextConnectionLogs = findLogsElement(nextConnectionView)

    expect(inactiveLogs).not.toBeNull()
    expect(activeLogs).not.toBeNull()
    expect(nextConnectionLogs).not.toBeNull()
    expect(inactiveLogs?.key).toBe(activeLogs?.key)
    expect(activeLogs?.key).toBe(nextConnectionLogs?.key)
    expect(inactiveLogs?.props).toMatchObject({ hostId: 'host-2', active: false, connected: true })
    expect(activeLogs?.props).toMatchObject({ hostId: 'host-2', connectionId: 'connection-logs-1', active: true, connected: true })
    expect(nextConnectionLogs?.props).toMatchObject({ hostId: 'host-2', connectionId: 'connection-logs-2', active: true, connected: true })
    expect(renderToStaticMarkup(activeView)).not.toContain('connection-logs-1')
    const inactiveHtml = renderToStaticMarkup(inactiveView)
    expect(inactiveHtml).toContain('data-server-ops-logs-container="true"')
    expect(inactiveHtml).toContain('aria-hidden="true"')
    expect(inactiveHtml).not.toContain('尚未建立 SSH 连接')
  })

  test('Given A 日志流停止未确认 When 同一 React root 切换到 B Then 不得用新 controller 绕过门禁', async () => {
    /** 两台主机拥有独立且明确的连接代次。 */
    const hostA = { ...createHost(), id: 'host-a', name: '主机 A' }
    const hostB = { ...createHost(), id: 'host-b', name: '主机 B' }
    /** A 的 stop 保持可控，用于覆盖 Workspace reconciliation 与旧流终态竞态。 */
    const stopA = createDeferred<void>()
    /** 真实 controller 发起的启动记录。 */
    const starts: ServerOpsLogStartInput[] = []
    /** 真实 controller 发起的停止记录。 */
    const stops: ServerOpsLogIdentity[] = []
    /** React 实际创建过的 controller 实例。 */
    const controllers: ServerOpsLogsController[] = []
    /** 所有实例发布到同一日志位置的投影。 */
    const projections: ServerOpsLogsProjection[] = []
    /** 为每次成功启动生成测试内唯一流身份。 */
    let streamSequence = 0
    /** 日志启动实现记录目标主机并立即返回。 */
    const start = async (input: ServerOpsLogStartInput): Promise<ServerOpsLogStartResult> => {
      starts.push(input)
      return { hostId: input.hostId, streamId: `stream-${++streamSequence}` }
    }
    /** 只有 A 的旧流停止保持 pending，B 的清理可以正常完成。 */
    const stop = (input: ServerOpsLogIdentity): Promise<void> => {
      stops.push(input)
      return input.hostId === hostA.id ? stopA.promise : Promise.resolve()
    }
    /** 记录 React effect 实际挂载的 controller。 */
    const onController = (controller: ServerOpsLogsController): void => { controllers.push(controller) }
    /** 记录 controller 投影，验证错误文本不会泄漏底层异常。 */
    const onProjection = (projection: ServerOpsLogsProjection): void => { projections.push(projection) }
    /** 从真实 Workspace 树提取日志元素身份，再由同一 root 执行 reconciliation。 */
    const createProbe = (host: ServerOpsHost, activeSection: 'overview' | 'logs'): React.ReactElement => {
      const workspace = ServerOpsWorkspaceView({
        ...createCallbacks(),
        status: 'ready',
        hosts: [hostA, hostB],
        selectedHost: host,
        activeSection,
        connectionState: { hostId: host.id, phase: 'connected', connectionId: `connection-${host.id}` },
      })
      const logs = findLogsElement(workspace)
      if (!logs) throw new Error('日志面板未挂载')
      return (
        <LogsLifecycleProbe
          key={logs.key ?? undefined}
          {...logs.props}
          start={start}
          stop={stop}
          onController={onController}
          onProjection={onProjection}
        />
      )
    }
    const root = createReconciliationRoot()
    try {
      await act(async () => {
        root.render(createProbe(hostA, 'logs'))
        await flushPromises()
      })
      expect(starts).toEqual([{ hostId: hostA.id, source: { kind: 'system' }, since: '15m', priority: 'info', tailLines: 200 }])

      await act(async () => {
        root.render(createProbe(hostB, 'logs'))
        await flushPromises()
      })
      expect(stops).toEqual([{ hostId: hostA.id, streamId: 'stream-1' }])
      expect(starts.filter((input) => input.hostId === hostB.id)).toHaveLength(0)

      await act(async () => {
        stopA.reject(new Error('secret host switch stop failure'))
        await flushPromises()
        await flushPromises()
      })
      expect(starts.filter((input) => input.hostId === hostB.id)).toHaveLength(0)
      expect(JSON.stringify(projections.at(-1))).not.toContain('secret')

      controllers[0]?.handleExit({ hostId: hostA.id, streamId: 'stream-1', reason: 'stopped' })
      await act(async () => {
        root.render(createProbe(hostB, 'overview'))
        await flushPromises()
      })
      await act(async () => {
        root.render(createProbe(hostB, 'logs'))
        await flushPromises()
      })
      expect(controllers).toHaveLength(1)
      expect(starts.filter((input) => input.hostId === hostB.id)).toHaveLength(1)
    } finally {
      act(() => { root.unmount() })
      root.restore()
    }
  })

  test('Given A 已成功且后台换连接 When 经 B 切回 A 首读失败 Then 不复用旧快照且连接标识不进入 DOM', async () => {
    /** 创建指定主机和连接状态的纯工作区视图。 */
    const createOverviewView = (hostId: string, connectionState: ServerOpsConnectionState): React.ReactElement => {
      /** 当前测试主机。 */
      const host = { ...createHost(), id: hostId }
      return ServerOpsWorkspaceView({
        ...createCallbacks(),
        status: 'ready',
        hosts: [host],
        selectedHost: host,
        activeSection: 'overview',
        connectionState,
      })
    }
    /** A 首次成功快照所属的连接实例身份。 */
    const firstAState: ServerOpsConnectionState = {
      hostId: 'host-a',
      phase: 'connected',
      connectionId: 'connection-a-1',
    }
    /** 用户切换到 B 后的概览实例身份。 */
    const bState: ServerOpsConnectionState = {
      hostId: 'host-b',
      phase: 'connected',
      connectionId: 'connection-b-1',
    }
    /** A 在后台断线并以新连接代次重连后的状态。 */
    const reconnectedAState: ServerOpsConnectionState = {
      hostId: 'host-a',
      phase: 'connected',
      connectionId: 'connection-a-2',
    }
    /** 当前模拟的 SSH 连接代次，由每次纯视图渲染同步推进。 */
    let currentConnectionId = firstAState.connectionId
    /** 当前 React key 对应的概览控制器。 */
    let mountedKey: React.Key | null | undefined
    /** 当前挂载实例持有的控制器。 */
    let mountedController: ReturnType<typeof createServerOpsOverviewController> | null = null
    /** 所有实例发布到同一视图位置的投影历史。 */
    const projections: ServerOpsOverviewProjection[] = []
    /** 按 React key 模拟 Overview 组件卸载和重建。 */
    const mountOverview = (hostId: string, state: ServerOpsConnectionState): void => {
      const nextKey = findOverviewElementKey(createOverviewView(hostId, state))
      currentConnectionId = state.phase === 'connected' ? state.connectionId : ''
      if (nextKey !== mountedKey) {
        mountedController?.dispose()
        mountedController = createServerOpsOverviewController({
          getOverview: async ({ hostId: requestedHostId }) => {
            if (requestedHostId === 'host-a' && currentConnectionId === 'connection-a-2') {
              throw new Error('SERVER_OPS_OVERVIEW_FAILED')
            }
            return createOverviewSnapshot(requestedHostId)
          },
          publish: (projection) => { projections.push(projection) },
          setInterval: () => 1,
          clearInterval: () => undefined,
        })
        mountedController.activate()
        mountedKey = nextKey
      }
      if (!mountedController) throw new Error('概览控制器未挂载')
      mountedController.select({ hostId, active: true, connected: state.phase === 'connected' })
    }

    mountOverview('host-a', firstAState)
    await flushPromises()
    expect(projections.at(-1)).toMatchObject({ status: 'ready', snapshot: { hostId: 'host-a' } })
    mountOverview('host-b', bState)
    await flushPromises()
    mountOverview('host-a', reconnectedAState)
    expect(projections.at(-1)).toMatchObject({ status: 'loading', snapshot: null })
    await flushPromises()
    expect(projections.at(-1)).toMatchObject({ status: 'error', snapshot: null, stale: false })

    const html = renderToStaticMarkup(
      <ServerOpsWorkspaceView
        {...createCallbacks()}
        status="ready"
        hosts={[{ ...createHost(), id: 'host-a' }]}
        selectedHost={{ ...createHost(), id: 'host-a' }}
        activeSection="overview"
        connectionState={reconnectedAState}
      />,
    )
    expect(html).not.toContain('connection-a-2')
    expect(html).not.toContain('connectionId')
  })
})
