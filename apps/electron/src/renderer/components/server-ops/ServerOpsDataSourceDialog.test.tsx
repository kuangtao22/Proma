import { describe, expect, test } from 'bun:test'

import * as React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { parseServerOpsDataSourceProbeInput } from '@proma/shared'
import type { ServerOpsDataProbeResult, ServerOpsDataSource, ServerOpsDataSourceProbeDraft } from '@proma/shared'
import {
  applyServerOpsDataSourceEngineChange,
  buildServerOpsDataSourceProbeDraft,
  buildServerOpsDataSourceUpsertInput,
  createServerOpsDataSourceDraft,
  ServerOpsDataSourceFields,
  useServerOpsDataSourceDialogController,
  validateServerOpsDataSourceDraft,
} from './ServerOpsDataSourceDialog'

test('Given Agent 提议 Redis 与 SQLite 连接 When 预填新建表单 Then 不出现数据库密码或 MySQL 库名', () => {
  const redis = createServerOpsDataSourceDraft(null, 'redis', { kind: 'redis', label: '缓存', address: 'cache.internal', port: 6379, transport: 'ssh', hostId: 'host-a', database: '3' })
  expect(redis).toMatchObject({ engine: 'redis', label: '缓存', transport: 'ssh', hostId: 'host-a', database: '3', password: '' })
  const sqlite = createServerOpsDataSourceDraft(null, 'sqlite', { kind: 'sqlite', label: '审计', transport: 'ssh', hostId: 'host-b', filePath: '/srv/app/a.db' })
  expect(sqlite).toMatchObject({ engine: 'sqlite', hostId: 'host-b', filePath: '/srv/app/a.db', database: 'main', password: '' })
  const mysql = createServerOpsDataSourceDraft(null, 'mysql', { kind: 'mysql', label: '业务库', address: 'db.internal', port: 3306, transport: 'direct' })
  expect(mysql.database).toBe('')
})

test('Given MySQL 校验证书且数据库地址是 IP When 使用默认校验名 Then 提示证书 DNS 名并允许保留 IP 连接地址', () => {
  /** 连接端点可以是 IP，但 mysql2 的证书身份校验必须使用明确 DNS 名。 */
  const draft = { ...createServerOpsDataSourceDraft(null), label: '数据库', address: '127.0.0.1', tlsMode: 'verify' as const }
  expect(validateServerOpsDataSourceDraft(draft).tlsServerName).toContain('DNS')
  expect(validateServerOpsDataSourceDraft({ ...draft, tlsServerName: 'db.example.com' }).tlsServerName).toBeUndefined()
  expect(validateServerOpsDataSourceDraft({ ...draft, engine: 'redis' }).tlsServerName).toBeUndefined()
})

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
}

/** 创建可控 Promise，用于精确安排弹窗异步回执的先后顺序。 */
function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })
  return { promise, resolve, reject }
}

/** 等待 Hook 的异步分支与 React 状态提交完成。 */
async function flushPromises(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

/** 创建只运行弹窗 Controller Hook 的最小 React 宿主。 */
function createControllerHost(): { render: (node: React.ReactElement) => void; unmount: () => void; restore: () => void } {
  /** React 事件系统依赖的最小 EventTarget。 */
  const eventTarget = { addEventListener: () => undefined, removeEventListener: () => undefined }
  class FakeHtmlIFrameElement {}
  /** Hook 不渲染 DOM，宿主只需满足 React root 的文档边界。 */
  const fakeWindow = { ...eventTarget, event: undefined, HTMLIFrameElement: FakeHtmlIFrameElement }
  /** Hook 测试使用的最小文档。 */
  const fakeDocument = { ...eventTarget, nodeType: 9, defaultView: fakeWindow, activeElement: null, body: null, documentElement: { namespaceURI: 'http://www.w3.org/1999/xhtml' } }
  /** React root 使用的最小容器。 */
  const container = { ...eventTarget, nodeType: 1, tagName: 'DIV', namespaceURI: 'http://www.w3.org/1999/xhtml', ownerDocument: fakeDocument }
  /** 临时替换的全局 DOM 边界。 */
  const globals = globalThis as unknown as { window?: unknown; document?: unknown; IS_REACT_ACT_ENVIRONMENT?: boolean }
  const previousWindow = globals.window
  const previousDocument = globals.document
  const previousActEnvironment = globals.IS_REACT_ACT_ENVIRONMENT
  globals.window = fakeWindow
  globals.document = fakeDocument
  globals.IS_REACT_ACT_ENVIRONMENT = true
  /** 真实 React root，用来执行 Effect、清理函数与状态更新。 */
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

/** 弹窗 Controller Hook 的公开状态与动作。 */
type DialogController = ReturnType<typeof useServerOpsDataSourceDialogController>

/** 以 null 视图暴露生产 Hook，避免测试依赖 Radix DOM 实现。 */
function DialogControllerProbe(props: Parameters<typeof useServerOpsDataSourceDialogController>[0] & {
  onController: (controller: DialogController) => void
}): null {
  /** 当前真实弹窗 Controller。 */
  const controller = useServerOpsDataSourceDialogController(props)
  React.useEffect(() => props.onController(controller), [controller, props])
  return null
}

/** 断言 Hook 已经完成首次发布。 */
function requireController(controller: DialogController | null): DialogController {
  if (controller === null) throw new Error('测试弹窗 Controller 尚未初始化')
  return controller
}

/** 创建成功的连接测试结果。 */
function createProbeResult(serverVersion: string): ServerOpsDataProbeResult {
  return { engine: 'mysql', capability: 'available', serverVersion, latencyMs: 12, warnings: [] }
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
    database: 'app',
    username: 'monitor',
    tlsMode: 'disabled',
    hasPassword: true,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  }
}

/** 渲染表单字段静态标记。 */
function renderFields(options: {
  mode?: 'create' | 'edit'
  source?: ServerOpsDataSource | null
  hasSavedPassword?: boolean
  draft?: ReturnType<typeof createServerOpsDataSourceDraft>
  errors?: Record<string, string>
  showPassword?: boolean
  /** 空字符串复现当前项目没有跳板服务器的状态。 */
  hostId?: string
} = {}): string {
  const draft = options.draft ?? createServerOpsDataSourceDraft(options.source ?? null)
  return renderToStaticMarkup(
    <ServerOpsDataSourceFields
      draft={draft}
      errors={options.errors ?? {}}
      mode={options.mode ?? 'create'}
      hasSavedPassword={options.hasSavedPassword ?? options.source?.hasPassword === true}
      showPassword={options.showPassword ?? false}
      hostId={options.hostId ?? 'host-1'}
      hostLabel="生产 API"
      hostOptions={[{ id: 'host-1', label: '生产 API' }, { id: 'host-2', label: '报表服务器' }]}
      onChange={() => undefined}
      onEngineChange={() => undefined}
      onShowPasswordChange={() => undefined}
    />,
  )
}

describe('数据源表单', () => {
  test('Given 新建 SQLite When 选择服务器与绝对路径 Then 只构造 SSH 文件连接字段', () => {
    const draft = {
      ...createServerOpsDataSourceDraft(null, 'sqlite'),
      label: '审计文件',
      hostId: 'host-2',
      filePath: '/srv/data/audit.sqlite3',
    }
    expect(validateServerOpsDataSourceDraft(draft)).toEqual({})
    expect(buildServerOpsDataSourceProbeDraft({ hostId: '', source: null, draft })).toEqual({
      transport: 'ssh',
      hostId: 'host-2',
      engine: 'sqlite',
      filePath: '/srv/data/audit.sqlite3',
      database: 'main',
      tlsMode: 'disabled',
    })
    expect(buildServerOpsDataSourceUpsertInput({ hostId: '', source: null, draft })).toEqual({
      transport: 'ssh',
      hostId: 'host-2',
      engine: 'sqlite',
      label: '审计文件',
      filePath: '/srv/data/audit.sqlite3',
      database: 'main',
      tlsMode: 'disabled',
    })
  })

  test('Given SQLite 表单 When 渲染 Then 提供项目服务器选择、文件路径与 Python 环境提示', () => {
    const draft = { ...createServerOpsDataSourceDraft(null, 'sqlite'), label: '审计文件', hostId: 'host-2' }
    const html = renderFields({ draft })
    expect(html).toContain('SQLite')
    expect(html).toContain('aria-label="服务器"')
    expect(html).toContain('id="server-ops-data-file-path"')
    expect(html).toContain('Python 3.11+')
    expect(html).not.toContain('服务器视角地址')
    expect(html).not.toContain('登录凭据')
    expect(html).not.toContain('TLS 模式')
  })

  test('Given SQLite 路径为空、相对路径或 URI When 校验 Then 阻止保存并给出路径错误', () => {
    const base = { ...createServerOpsDataSourceDraft(null, 'sqlite'), label: '审计文件', hostId: 'host-1' }
    for (const filePath of ['', 'data/audit.db', 'file:/srv/data/audit.db', ':memory:']) {
      expect(validateServerOpsDataSourceDraft({ ...base, filePath }).filePath).toContain('绝对路径')
    }
  })

  test('Given 新建表单 When 渲染 Then 带出 MySQL 默认端口并隐藏已保存密码入口', () => {
    expect(createServerOpsDataSourceDraft(null).tlsMode).toBe('preferred')
    expect(createServerOpsDataSourceDraft(null, 'redis').tlsMode).toBe('disabled')
    const html = renderFields()
    // Radix Select 的当前值在 SSR 静态标记里不落地，这里以默认端口和字段集合为断言依据。
    expect(html).toContain('value="3306"')
    expect(html).toContain('id="server-ops-data-engine"')
    expect(html).toContain('id="server-ops-data-tls"')
    expect(html).toContain('数据库地址')
    expect(html).not.toContain('库名')
    expect(html).not.toContain('id="server-ops-data-database"')
    expect(html).toContain('id="server-ops-data-username"')
    expect(html).not.toContain('清除已保存密码')
  })

  test('Given MySQL 与 Redis When 切换引擎 Then 更新端口且不沿用另一种引擎的数据库', () => {
    const draft = { ...createServerOpsDataSourceDraft(null), database: 'app' }
    const next = applyServerOpsDataSourceEngineChange(draft, 'redis')
    expect(next.engine).toBe('redis')
    expect(next.port).toBe('6379')
    expect(next.database).toBe('')
    expect(next.tlsMode).toBe('required')
    expect(renderFields({ draft: next }).includes('逻辑库（0-15）')).toBe(true)
    expect(renderFields({ draft: next })).not.toContain('优先 TLS')
    /** Redis 库号与 SQLite main 都不能成为 MySQL 隐藏的默认库。 */
    for (const previous of [{ ...next, database: '2' }, createServerOpsDataSourceDraft(null, 'sqlite')]) {
      /** 切回 MySQL 后的连接草稿，仅保留实例连接信息。 */
      const mysqlDraft = applyServerOpsDataSourceEngineChange(previous, 'mysql')
      expect(mysqlDraft.database).toBe('')
      expect(mysqlDraft.port).toBe('3306')
      expect(renderFields({ draft: mysqlDraft })).not.toContain('id="server-ops-data-database"')
    }
  })

  test('Given 新建 MySQL 选择 TLS When 渲染 Then 明确模式的回退及证书边界', () => {
    const html = renderFields()
    expect(html).toContain('仅服务器明确不支持时允许明文回退')
    expect(renderFields({ draft: { ...createServerOpsDataSourceDraft(null), tlsMode: 'required' } }))
      .toContain('不校验证书')
  })

  test('Given 当前项目没有 SSH 服务器 When 切换连接方式 Then 直连说明与缺少跳板提示按实际路径显示', () => {
    /** 公网域名的连接由本机发起，并不要求先添加服务器。 */
    const html = renderFields({ hostId: '', draft: { ...createServerOpsDataSourceDraft(null), address: 'db.example.com' } })
    expect(html).toContain('直接连接支持远程域名与 IP')
    expect(html).not.toContain('当前项目没有可用的 SSH 服务器')
    expect(renderFields({ hostId: '', draft: { ...createServerOpsDataSourceDraft(null), transport: 'ssh' } }))
      .toContain('当前项目没有可用的 SSH 服务器')
    expect(html).toContain('数据库地址')
    expect(html).not.toContain('服务器视角地址')
  })

  test('Given SSH 连接缺少跳板 When 校验 Then 明确提示选择直连或添加服务器且不误报地址', () => {
    /** 合法远程域名应通过地址语法校验，错误只归因于缺少跳板。 */
    const draft = { ...createServerOpsDataSourceDraft(null), label: '远程库', transport: 'ssh' as const, address: 'db.example.com' }
    expect(validateServerOpsDataSourceDraft(draft, '')).toEqual({ hostId: '经由 SSH 需要一台跳板服务器；请先添加服务器，或改选「直接连接」' })
    expect(validateServerOpsDataSourceDraft(draft, 'host-1')).toEqual({})
  })

  test('Given 域名直连 When TLS 未开启或缺少证书主机名 Then 校验明确指出具体字段', () => {
    /** 与后端 TLS 边界相同，远程域名自身仍然是合法地址。 */
    const draft = { ...createServerOpsDataSourceDraft(null), label: '远程库', address: 'db.example.com' }
    expect(validateServerOpsDataSourceDraft(draft)).toEqual({})
    expect(validateServerOpsDataSourceDraft(draft).address).toBeUndefined()
    expect(validateServerOpsDataSourceDraft({ ...draft, tlsMode: 'disabled' }).tlsMode).toContain('TLS')
    expect(validateServerOpsDataSourceDraft({ ...draft, tlsMode: 'required' })).toEqual({})
    expect(validateServerOpsDataSourceDraft({ ...draft, tlsMode: 'verify' })).toEqual({})
    expect(validateServerOpsDataSourceDraft({ ...draft, tlsMode: 'verify', tlsServerName: 'db.example.com' })).toEqual({})
    expect(validateServerOpsDataSourceDraft({ ...draft, tlsMode: 'verify', tlsServerName: 'not a host' }).tlsServerName).toBeDefined()
    expect(validateServerOpsDataSourceDraft({ ...draft, engine: 'redis', tlsMode: 'preferred' }).tlsMode).toContain('Redis')
  })

  test('Given 缺少跳板的远程 MySQL 草稿 When 改为 TLS 直连后测试 Then 无需名称和服务器即可按完整域名发起请求', async () => {
    /** 捕获发送给主进程的草稿，验证失败时没有请求副作用。 */
    const requests: ServerOpsDataSourceProbeDraft[] = []
    /** 当前真实 Hook 及其最小宿主。 */
    let controller: DialogController | null = null
    const host = createControllerHost()
    try {
      await act(async () => {
        host.render(<DialogControllerProbe open mode="create" source={null} hostId="" onTest={async (draft) => {
          requests.push(draft)
          return createProbeResult('remote-mysql')
        }} onController={(next) => { controller = next }} />)
      })
      act(() => requireController(controller).patchDraft({ transport: 'ssh', address: 'db.example.com' }))
      await act(async () => { await requireController(controller).testConnection() })
      expect(requests).toHaveLength(0)
      expect(requireController(controller).errors.hostId).toContain('跳板服务器')
      expect(requireController(controller).testError).toContain('直接连接')
      expect(requireController(controller).errors.address).toBeUndefined()

      act(() => requireController(controller).patchDraft({ transport: 'direct' }))
      expect(requireController(controller).errors.hostId).toBeUndefined()
      await act(async () => { await requireController(controller).testConnection() })
      expect(requests).toHaveLength(1)
      expect(requests[0]).toMatchObject({ address: 'db.example.com', tlsMode: 'preferred' })

      act(() => requireController(controller).patchDraft({ tlsMode: 'verify' }))
      expect(requireController(controller).draft.tlsServerName).toBe('db.example.com')
      await act(async () => { await requireController(controller).testConnection() })
      expect(requests).toHaveLength(2)
      expect(requests[1]).toEqual({ transport: 'direct', engine: 'mysql', address: 'db.example.com', port: 3306, tlsMode: 'verify', tlsServerName: 'db.example.com' })
      expect(parseServerOpsDataSourceProbeInput({ draft: requests[1] })).toEqual({ draft: requests[1]! })
      expect(requireController(controller).errors).toEqual({})
      expect(requireController(controller).testResult?.serverVersion).toBe('remote-mysql')
      expect(requireController(controller).testing).toBe(false)
    } finally {
      act(() => host.unmount())
      host.restore()
    }
  })

  test('Given 校验主机名自动跟随 When 用户覆盖并修改数据库地址 Then 保留手动指定证书名', async () => {
    let controller: DialogController | null = null
    const host = createControllerHost()
    try {
      await act(async () => host.render(<DialogControllerProbe open mode="create" source={null} hostId="jump-host" onController={(next) => { controller = next }} />))
      act(() => requireController(controller).patchDraft({ transport: 'ssh', address: 'db.internal', tlsMode: 'verify' }))
      expect(requireController(controller).draft.tlsServerName).toBe('db.internal')
      act(() => requireController(controller).patchDraft({ address: 'db-alt.internal' }))
      expect(requireController(controller).draft.tlsServerName).toBe('db-alt.internal')
      act(() => requireController(controller).patchDraft({ tlsServerName: 'certificate.internal' }))
      act(() => requireController(controller).patchDraft({ address: 'db-new.internal' }))
      expect(requireController(controller).draft.tlsServerName).toBe('certificate.internal')
    } finally {
      act(() => host.unmount())
      host.restore()
    }
  })

  test('Given 自动证书名 When 清空后键入自定义证书名 Then 保留编辑中间态且后续地址不覆盖', async () => {
    let controller: DialogController | null = null
    const host = createControllerHost()
    try {
      await act(async () => host.render(<DialogControllerProbe open mode="create" source={null} hostId="host-1" onController={(next) => { controller = next }} />))
      act(() => requireController(controller).patchDraft({ address: 'db.internal', tlsMode: 'verify' }))
      expect(requireController(controller).draft.tlsServerName).toBe('db.internal')
      act(() => requireController(controller).patchDraft({ tlsServerName: '' }))
      expect(requireController(controller).draft.tlsServerName).toBe('')
      expect(renderFields({ draft: requireController(controller).draft })).toContain('id="server-ops-data-tls-name"')
      expect(renderFields({ draft: requireController(controller).draft })).toMatch(/id="server-ops-data-tls-name"[^>]*value=""/)
      act(() => requireController(controller).patchDraft({ tlsServerName: 'certificate.internal' }))
      act(() => requireController(controller).patchDraft({ address: 'db-new.internal' }))
      expect(requireController(controller).draft.tlsServerName).toBe('certificate.internal')
    } finally {
      act(() => host.unmount())
      host.restore()
    }
  })

  test('Given 清空自定义证书名 When 再修改数据库地址 Then 恢复自动跟随新地址', async () => {
    let controller: DialogController | null = null
    const host = createControllerHost()
    const source = createSource({ address: 'db-old.internal', tlsMode: 'verify', tlsServerName: 'certificate.internal' })
    try {
      await act(async () => host.render(<DialogControllerProbe open mode="edit" source={source} hostId="host-1" onController={(next) => { controller = next }} />))
      act(() => requireController(controller).patchDraft({ tlsServerName: '' }))
      expect(requireController(controller).draft.tlsServerName).toBe('')
      act(() => requireController(controller).patchDraft({ address: 'db-new.internal' }))
      expect(requireController(controller).draft.tlsServerName).toBe('db-new.internal')
    } finally {
      act(() => host.unmount())
      host.restore()
    }
  })

  test('Given 已保存连接有独立证书名 When 编辑数据库地址 Then 旧证书名不被自动替换', async () => {
    let controller: DialogController | null = null
    const host = createControllerHost()
    const source = createSource({ address: 'db-old.internal', tlsMode: 'verify', tlsServerName: 'certificate.internal' })
    try {
      await act(async () => host.render(<DialogControllerProbe open mode="edit" source={source} hostId="host-1" onController={(next) => { controller = next }} />))
      act(() => requireController(controller).patchDraft({ address: 'db-new.internal' }))
      expect(requireController(controller).draft.tlsServerName).toBe('certificate.internal')
      expect(buildServerOpsDataSourceUpsertInput({ hostId: 'host-1', source, draft: requireController(controller).draft }))
        .toMatchObject({ address: 'db-new.internal', tlsServerName: 'certificate.internal' })
    } finally {
      act(() => host.unmount())
      host.restore()
    }
  })

  test('Given 编辑已有密码的数据源 When 渲染 Then 默认星号占位且不把占位作为密码回填', () => {
    const html = renderFields({ mode: 'edit', source: createSource(), hasSavedPassword: true })
    /** 只检查目标输入框的公开属性，不依赖 React 输出属性的先后顺序。 */
    const passwordInput = html.match(/<input[^>]*id="server-ops-data-password"[^>]*>/u)?.[0] ?? ''
    expect(passwordInput).toContain('type="password"')
    expect(passwordInput).toContain('placeholder="********"')
    expect(passwordInput).toContain('value=""')
    expect(html).toContain('已保存密码，输入新密码可替换。')
    expect(html).toContain('清除已保存密码')
    expect(html).not.toContain('password-canary')
    expect(renderFields({ mode: 'edit', source: createSource({ hasPassword: false }) })).not.toContain('placeholder="********"')
    /** 清除模式不再展示已保存占位，也不能通过眼睛重新启用密码。 */
    const cleared = renderFields({ mode: 'edit', source: createSource(), draft: { ...createServerOpsDataSourceDraft(createSource()), clearPassword: true } })
    expect(cleared).not.toContain('placeholder="********"')
    expect(cleared).toMatch(/aria-label="显示密码"[^>]*disabled/u)
  })

  test('Given TLS 校验证书 When 渲染 Then 展示真实主机名输入与说明', () => {
    const draft = { ...createServerOpsDataSourceDraft(null), tlsMode: 'verify' as const, tlsServerName: 'db.internal' }
    const html = renderFields({ draft })
    expect(html).toContain('数据库真实主机名')
    expect(html).toContain('证书中的 DNS 主机名')
    expect(html).toContain('value="db.internal"')
  })

  test('Given 字段非法 When 校验 Then 返回对应中文错误', () => {
    const base = createServerOpsDataSourceDraft(null)
    expect(Object.keys(validateServerOpsDataSourceDraft(base))).toContain('label')
    expect(validateServerOpsDataSourceDraft({ ...base, label: '库', address: '10.0.0.1 3306' }).address)
      .toBe('地址必填、不超过 255 个字符且不能包含空白')
    expect(validateServerOpsDataSourceDraft({ ...base, label: '库', port: '0' }).port)
      .toBe('端口必须是 1 到 65535 之间的整数')
    expect(validateServerOpsDataSourceDraft({ ...base, label: '库', engine: 'redis', database: '16' }).database)
      .toBe('Redis 逻辑库必须是 0 到 15 之间的数字')
    expect(validateServerOpsDataSourceDraft({ ...base, label: '库', tlsMode: 'verify', tlsServerName: 'invalid name' }).tlsServerName)
      .toBe('证书主机名不能超过 255 个字符或包含空白')
    expect(validateServerOpsDataSourceDraft({ ...base, label: '库', address: '127.0.0.1' })).toEqual({})
  })

  test('Given 编辑带旧库名的 MySQL 且留空密码 When 构造输入 Then 移除默认库并保留密码', () => {
    /** 旧连接可以继续编辑，但已移除的库名不再作为隐藏配置提交。 */
    const source = createSource()
    /** 编辑草稿应清除旧库名。 */
    const draft = createServerOpsDataSourceDraft(source)
    expect(draft.database).toBe('')
    expect(renderFields({ mode: 'edit', source })).not.toContain('id="server-ops-data-database"')
    const input = buildServerOpsDataSourceUpsertInput({
      hostId: 'host-1',
      source,
      draft,
    })
    expect(input).toEqual({
      transport: 'ssh',
      hostId: 'host-1',
      sourceId: 'source-1',
      engine: 'mysql',
      label: '业务主库',
      address: '127.0.0.1',
      port: 3306,
      username: 'monitor',
      tlsMode: 'disabled',
    })
    expect('password' in input).toBe(false)
    expect('clearPassword' in input).toBe(false)
    /** 在途表单残留的旧库名也不得参与校验、连接测试或保存。 */
    const staleDraft = { ...draft, database: 'x'.repeat(65) }
    expect(validateServerOpsDataSourceDraft(staleDraft, 'host-1')).toEqual({})
    expect(buildServerOpsDataSourceProbeDraft({ hostId: 'host-1', source, draft: staleDraft }))
      .not.toHaveProperty('database')
    expect(buildServerOpsDataSourceUpsertInput({ hostId: 'host-1', source, draft: staleDraft }))
      .not.toHaveProperty('database')
  })

  test('Given 开启清除密码 When 构造输入 Then 提交 clearPassword 且不提交 password', () => {
    const draft = { ...createServerOpsDataSourceDraft(createSource()), clearPassword: true, password: '' }
    const input = buildServerOpsDataSourceUpsertInput({ hostId: 'host-1', source: createSource(), draft })
    expect(input.clearPassword).toBe(true)
    expect('password' in input).toBe(false)
  })

  test('Given 新建并填写密码与 TLS When 构造输入 Then 携带密码与真实主机名', () => {
    const draft = {
      ...createServerOpsDataSourceDraft(null),
      label: '缓存',
      engine: 'redis' as const,
      port: '6379',
      database: '2',
      password: 'p@ss',
      tlsMode: 'verify' as const,
      tlsServerName: 'redis.internal',
    }
    const input = buildServerOpsDataSourceUpsertInput({ hostId: 'host-1', source: null, draft })
    expect(input).toEqual({
      transport: 'direct',
      engine: 'redis',
      label: '缓存',
      address: '127.0.0.1',
      port: 6379,
      database: '2',
      password: 'p@ss',
      tlsMode: 'verify',
      tlsServerName: 'redis.internal',
    })
  })

  test('Given 未保存草稿 When 构造连接测试输入 Then 只带本次要用的凭据与连接字段', () => {
    /** 新建：表单里刚填的密码按原样进入本次测试。 */
    expect(buildServerOpsDataSourceProbeDraft({
      hostId: 'host-1',
      source: null,
      draft: { ...createServerOpsDataSourceDraft(null), label: '新库', password: 'p@ss', username: 'monitor' },
    })).toEqual({
      transport: 'direct', engine: 'mysql', address: '127.0.0.1', port: 3306, username: 'monitor', password: 'p@ss', tlsMode: 'preferred',
    })

    /** 编辑且留空密码：复用已保存密文，不假装没有密码。 */
    expect(buildServerOpsDataSourceProbeDraft({
      hostId: 'host-1',
      source: createSource(),
      draft: createServerOpsDataSourceDraft(createSource()),
    })).toEqual({
      transport: 'ssh', hostId: 'host-1', engine: 'mysql', address: '127.0.0.1', port: 3306,
      username: 'monitor', savedSourceId: 'source-1', tlsMode: 'disabled',
    })

    /** 勾选清除密码后不得再复用旧密文。 */
    const cleared = buildServerOpsDataSourceProbeDraft({
      hostId: 'host-1',
      source: createSource(),
      draft: { ...createServerOpsDataSourceDraft(createSource()), clearPassword: true },
    })
    expect(cleared === null ? {} : cleared).not.toMatchObject({ savedSourceId: 'source-1' })
    expect(cleared === null ? {} : cleared).not.toMatchObject({ password: expect.anything() })

    /** 经由跳板但项目里没有可用服务器时无法构造输入。 */
    expect(buildServerOpsDataSourceProbeDraft({
      hostId: '',
      source: null,
      draft: { ...createServerOpsDataSourceDraft(null), transport: 'ssh' as const },
    })).toBeNull()

    /** 端口非法时不发起测试，避免让主进程抛参数错误。 */
    expect(buildServerOpsDataSourceProbeDraft({
      hostId: 'host-1',
      source: null,
      draft: { ...createServerOpsDataSourceDraft(null), port: '0' },
    })).toBeNull()
  })

  test('Given 校验证书模式 When 构造连接测试输入 Then 带上数据库真实主机名', () => {
    expect(buildServerOpsDataSourceProbeDraft({
      hostId: 'host-1',
      source: null,
      draft: {
        ...createServerOpsDataSourceDraft(null),
        tlsMode: 'verify' as const,
        tlsServerName: 'db.internal',
      },
    })).toMatchObject({ tlsMode: 'verify', tlsServerName: 'db.internal' })
  })

  test('Given 内网地址关闭 TLS When 渲染表单 Then 提前说明会被标记为内网明文', () => {
    /** 与用户实际填法一致：私有网段 + 直连 + 关闭 TLS。 */
    const draft = { ...createServerOpsDataSourceDraft(null), label: '内网库', address: '172.16.10.198', tlsMode: 'disabled' as const }
    const html = renderFields({ draft })
    expect(html).toContain('data-server-ops-data-plaintext-hint')
    expect(html).toContain('内网明文')
    expect(html).not.toContain('data-server-ops-data-tls-required-hint')
  })

  test('Given 公网地址或主机名关闭 TLS When 渲染表单 Then 提前说明会被拒绝', () => {
    /** 公网地址：必须开证书校验，否则主进程会拒绝发起连接。 */
    const publicDraft = { ...createServerOpsDataSourceDraft(null), label: '公网库', address: '8.8.8.8', tlsMode: 'disabled' as const }
    expect(renderFields({ draft: publicDraft })).toContain('data-server-ops-data-tls-required-hint')
    /** 主机名无法离线判定归属，同样提前提示，避免保存一个永远连不上的配置。 */
    const hostnameDraft = { ...createServerOpsDataSourceDraft(null), label: '域名库', address: 'db.internal', tlsMode: 'disabled' as const }
    expect(renderFields({ draft: hostnameDraft })).toContain('data-server-ops-data-tls-required-hint')
  })

  test('Given 显示已保存密码 When 构造写入与测试输入 Then 按"保留原密码"处理', () => {
    /** 用户点开眼睛后密码框里是被取回的明文。 */
    const draft = { ...createServerOpsDataSourceDraft(createSource()), password: 'revealed-secret' }
    /** 取回明文后的写入输入：不带 password，也不带 clearPassword。 */
    const input = buildServerOpsDataSourceUpsertInput({ hostId: 'host-1', source: createSource(), draft, passwordFromStore: true })
    expect('password' in input).toBe(false)
    expect('clearPassword' in input).toBe(false)
    /** 测试同样复用主进程密文，而不是把明文当成本次新填的凭据。 */
    expect(buildServerOpsDataSourceProbeDraft({ hostId: 'host-1', source: createSource(), draft, passwordFromStore: true }))
      .toMatchObject({ savedSourceId: 'source-1' })
    expect(buildServerOpsDataSourceProbeDraft({ hostId: 'host-1', source: createSource(), draft, passwordFromStore: true }))
      .not.toMatchObject({ password: 'revealed-secret' })

    /** 用户手动改过密码框后，就必须按新密码提交。 */
    const edited = { ...draft, password: 'typed-secret' }
    expect(buildServerOpsDataSourceUpsertInput({ hostId: 'host-1', source: createSource(), draft: edited }))
      .toMatchObject({ password: 'typed-secret' })
  })

  test('Given 已保存密码 When 显示再隐藏 Then 按需读取且隐藏后保留密文并释放回显明文', async () => {
    /** 只统计解密入口次数，夹具密码不来自真实安全存储。 */
    let reads = 0
    /** 当前 Hook 投影与固定编辑身份。 */
    let controller: DialogController | null = null
    const source = createSource()
    const host = createControllerHost()
    try {
      await act(async () => {
        host.render(<DialogControllerProbe open mode="edit" source={source} hostId="host-1" onRevealPassword={async () => { reads += 1; return 'saved-fixture-secret' }} onController={(next) => { controller = next }} />)
      })
      expect(reads).toBe(0)
      expect(requireController(controller).draft.password).toBe('')
      await act(async () => { await requireController(controller).setPasswordVisibility(true) })
      expect(reads).toBe(1)
      expect(requireController(controller).draft.password).toBe('saved-fixture-secret')
      expect(requireController(controller).showPassword).toBe(true)
      await act(async () => { await requireController(controller).setPasswordVisibility(false) })
      /** 隐藏后仅保留已保存状态；保存与测试继续引用主进程中的原凭据。 */
      const hidden = requireController(controller)
      expect(hidden.showPassword).toBe(false)
      expect(hidden.draft.password).toBe('')
      expect(buildServerOpsDataSourceUpsertInput({ hostId: 'host-1', source, draft: hidden.draft, passwordFromStore: hidden.passwordFromStore })).not.toHaveProperty('password')
      expect(buildServerOpsDataSourceProbeDraft({ hostId: 'host-1', source, draft: hidden.draft, passwordFromStore: hidden.passwordFromStore })).toMatchObject({ savedSourceId: source.id })
      await act(async () => { await requireController(controller).setPasswordVisibility(true) })
      expect(reads).toBe(2)
      /** 用户自己输入的新密码切换隐藏时须完整保留。 */
      act(() => requireController(controller).patchDraft({ password: 'typed-fixture-secret' }))
      await act(async () => { await requireController(controller).setPasswordVisibility(false) })
      expect(requireController(controller).draft.password).toBe('typed-fixture-secret')
      act(() => requireController(controller).patchDraft({ clearPassword: true, password: '' }))
      await act(async () => { await requireController(controller).setPasswordVisibility(true) })
      expect(reads).toBe(2)
      expect(requireController(controller).draft.clearPassword).toBe(true)
      expect(requireController(controller).showPassword).toBe(false)
    } finally {
      act(() => host.unmount())
      host.restore()
    }
  })

  test('Given 已保存密码读取在途 When 用户恢复隐藏 Then 迟到结果不能再次显示明文', async () => {
    /** 延迟回执验证隐藏动作同步撤销该次显示请求。 */
    const reveal = createDeferred<string | null>()
    let controller: DialogController | null = null
    const host = createControllerHost()
    try {
      await act(async () => {
        host.render(<DialogControllerProbe open mode="edit" source={createSource()} hostId="host-1" onRevealPassword={() => reveal.promise} onController={(next) => { controller = next }} />)
      })
      act(() => { void requireController(controller).setPasswordVisibility(true) })
      await act(async () => { await requireController(controller).setPasswordVisibility(false) })
      await act(async () => { reveal.resolve('late-fixture-secret'); await flushPromises() })
      expect(requireController(controller).showPassword).toBe(false)
      expect(requireController(controller).revealingPassword).toBe(false)
      expect(requireController(controller).draft.password).toBe('')
    } finally {
      act(() => host.unmount())
      host.restore()
    }
  })

  test('Given A 的密码读取迟到 When 弹窗切到 B Then success/catch/finally 都不能污染 B', async () => {
    /** A 的读取由测试控制，B 不发起读取。 */
    const revealA = createDeferred<string | null>()
    /** B 的读取保持在途，用于证明 A 的 finally 不能提前结束 B 的 loading。 */
    const revealB = createDeferred<string | null>()
    /** 当前 Hook 投影。 */
    let controller: DialogController | null = null
    /** A 与 B 使用不同身份和可观察字段。 */
    const sourceA = createSource({ id: 'source-a', engine: 'redis', label: 'Redis A', database: '1' })
    const sourceB = createSource({ id: 'source-b', engine: 'redis', label: 'Redis B', database: '2' })
    /** Hook 使用的最小 React 宿主。 */
    const host = createControllerHost()
    try {
      await act(async () => {
        host.render(<DialogControllerProbe open mode="edit" source={sourceA} initialEngine="redis" hostId="host-1" onRevealPassword={() => revealA.promise} onController={(next) => { controller = next }} />)
      })
      act(() => { void requireController(controller).setPasswordVisibility(true) })
      await act(flushPromises)
      expect(requireController(controller).revealingPassword).toBe(true)

      await act(async () => {
        host.render(<DialogControllerProbe open mode="edit" source={sourceB} initialEngine="redis" hostId="host-1" onRevealPassword={() => revealB.promise} onController={(next) => { controller = next }} />)
      })
      expect(requireController(controller).draft.label).toBe('Redis B')
      act(() => { void requireController(controller).setPasswordVisibility(true) })
      await act(flushPromises)
      expect(requireController(controller).revealingPassword).toBe(true)

      await act(async () => {
        revealA.resolve('a-secret')
        await flushPromises()
      })
      expect(requireController(controller).draft).toMatchObject({ label: 'Redis B', password: '' })
      expect(requireController(controller).passwordFromStore).toBe(false)
      expect(requireController(controller).showPassword).toBe(false)
      expect(requireController(controller).testError).toBeNull()
      expect(requireController(controller).revealingPassword).toBe(true)

      await act(async () => {
        revealB.resolve('b-secret')
        await flushPromises()
      })
      expect(requireController(controller).draft).toMatchObject({ label: 'Redis B', password: 'b-secret' })
      expect(requireController(controller).passwordFromStore).toBe(true)
      expect(requireController(controller).showPassword).toBe(true)
      expect(requireController(controller).revealingPassword).toBe(false)
    } finally {
      act(() => host.unmount())
      host.restore()
    }
  })

  test('Given A 的测试跨越关闭并重开同一来源 When 旧请求失败 Then catch/finally 不覆盖新会话', async () => {
    /** 第一次打开时尚未完成的旧测试。 */
    const oldTest = createDeferred<ServerOpsDataProbeResult>()
    /** 重开后保持在途的新测试，用于证明旧 finally 不会提前结束 loading。 */
    const currentTest = createDeferred<ServerOpsDataProbeResult>()
    /** 当前 Hook 投影。 */
    let controller: DialogController | null = null
    /** 同一来源用于证明仅比较 sourceId 不足。 */
    const sourceA = createSource({ id: 'source-a', label: 'MySQL A' })
    /** Hook 使用的最小 React 宿主。 */
    const host = createControllerHost()
    try {
      await act(async () => {
        host.render(<DialogControllerProbe open mode="edit" source={sourceA} hostId="host-1" onTest={() => oldTest.promise} onController={(next) => { controller = next }} />)
      })
      act(() => { void requireController(controller).testConnection() })
      await act(flushPromises)
      expect(requireController(controller).testing).toBe(true)

      await act(async () => {
        host.render(<DialogControllerProbe open={false} mode="edit" source={sourceA} hostId="host-1" onTest={() => oldTest.promise} onController={(next) => { controller = next }} />)
      })
      await act(async () => {
        host.render(<DialogControllerProbe open mode="edit" source={sourceA} hostId="host-1" onTest={() => currentTest.promise} onController={(next) => { controller = next }} />)
      })
      act(() => { void requireController(controller).testConnection() })
      await act(flushPromises)
      expect(requireController(controller).testing).toBe(true)

      await act(async () => {
        oldTest.reject(new Error('A_OLD_TEST_FAILURE'))
        await flushPromises()
      })
      expect(requireController(controller).testResult).toBeNull()
      expect(requireController(controller).testError).toBeNull()
      expect(requireController(controller).testing).toBe(true)

      await act(async () => {
        currentTest.resolve(createProbeResult('new-session'))
        await flushPromises()
      })
      expect(requireController(controller).testResult?.serverVersion).toBe('new-session')
      expect(requireController(controller).testing).toBe(false)
    } finally {
      act(() => host.unmount())
      host.restore()
    }
  })

  test('Given 读取已保存密码期间用户手输新密码 When 旧明文返回 Then 不覆盖用户输入', async () => {
    /** 尚未完成的已保存密码读取。 */
    const reveal = createDeferred<string | null>()
    /** 当前 Hook 投影。 */
    let controller: DialogController | null = null
    /** Hook 使用的最小 React 宿主。 */
    const host = createControllerHost()
    try {
      await act(async () => {
        host.render(<DialogControllerProbe open mode="edit" source={createSource()} hostId="host-1" onRevealPassword={() => reveal.promise} onController={(next) => { controller = next }} />)
      })
      act(() => { void requireController(controller).setPasswordVisibility(true) })
      await act(flushPromises)
      act(() => requireController(controller).patchDraft({ password: 'typed-new-secret' }))
      await act(async () => {
        reveal.resolve('saved-old-secret')
        await flushPromises()
      })
      expect(requireController(controller).draft.password).toBe('typed-new-secret')
      expect(requireController(controller).passwordFromStore).toBe(false)
      expect(requireController(controller).revealingPassword).toBe(false)
    } finally {
      act(() => host.unmount())
      host.restore()
    }
  })

  test('Given 测试连接期间草稿被修改 When 旧 success 返回 Then 旧结果失效且 loading 收口', async () => {
    /** 尚未完成的旧草稿测试。 */
    const oldTest = createDeferred<ServerOpsDataProbeResult>()
    /** 当前 Hook 投影。 */
    let controller: DialogController | null = null
    /** Hook 使用的最小 React 宿主。 */
    const host = createControllerHost()
    try {
      await act(async () => {
        host.render(<DialogControllerProbe open mode="edit" source={createSource()} hostId="host-1" onTest={() => oldTest.promise} onController={(next) => { controller = next }} />)
      })
      act(() => { void requireController(controller).testConnection() })
      await act(flushPromises)
      act(() => requireController(controller).patchDraft({ address: '127.0.0.2' }))
      await act(async () => {
        oldTest.resolve(createProbeResult('old-draft'))
        await flushPromises()
      })
      expect(requireController(controller).draft.address).toBe('127.0.0.2')
      expect(requireController(controller).testResult).toBeNull()
      expect(requireController(controller).testError).toBeNull()
      expect(requireController(controller).testing).toBe(false)
    } finally {
      act(() => host.unmount())
      host.restore()
    }
  })

  test('Given create 模式在 host A 测试中 When 跳板切到 host B Then A 的迟到结果不能写回', async () => {
    /** host A 尚未完成的连接测试。 */
    const hostATest = createDeferred<ServerOpsDataProbeResult>()
    /** 当前 Hook 投影。 */
    let controller: DialogController | null = null
    /** Hook 使用的最小 React 宿主。 */
    const host = createControllerHost()
    try {
      await act(async () => {
        host.render(<DialogControllerProbe open mode="create" source={null} hostId="host-a" onTest={() => hostATest.promise} onController={(next) => { controller = next }} />)
      })
      act(() => requireController(controller).patchDraft({ transport: 'ssh', label: '新建 Redis' }))
      act(() => { void requireController(controller).testConnection() })
      await act(flushPromises)
      expect(requireController(controller).testing).toBe(true)

      await act(async () => {
        host.render(<DialogControllerProbe open mode="create" source={null} hostId="host-b" onTest={() => Promise.resolve(createProbeResult('host-b'))} onController={(next) => { controller = next }} />)
      })
      expect(requireController(controller).testing).toBe(false)
      expect(requireController(controller).draft).toEqual(createServerOpsDataSourceDraft(null))

      await act(async () => {
        hostATest.resolve(createProbeResult('host-a-late'))
        await flushPromises()
      })
      expect(requireController(controller).testResult).toBeNull()
      expect(requireController(controller).testError).toBeNull()
      expect(requireController(controller).testing).toBe(false)
    } finally {
      act(() => host.unmount())
      host.restore()
    }
  })
})
