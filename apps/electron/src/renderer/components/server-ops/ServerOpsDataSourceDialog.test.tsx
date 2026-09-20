import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ServerOpsDataProbeResult, ServerOpsDataSource } from '@proma/shared'
import {
  applyServerOpsDataSourceEngineChange,
  buildServerOpsDataSourceProbeDraft,
  buildServerOpsDataSourceUpsertInput,
  createServerOpsDataSourceDraft,
  ServerOpsDataSourceFields,
  useServerOpsDataSourceDialogController,
  validateServerOpsDataSourceDraft,
} from './ServerOpsDataSourceDialog'

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
} = {}): string {
  const draft = options.draft ?? createServerOpsDataSourceDraft(options.source ?? null)
  return renderToStaticMarkup(
    <ServerOpsDataSourceFields
      draft={draft}
      errors={options.errors ?? {}}
      mode={options.mode ?? 'create'}
      hasSavedPassword={options.hasSavedPassword ?? options.source?.hasPassword === true}
      showPassword={options.showPassword ?? false}
      hostLabel="生产 API"
      onChange={() => undefined}
      onEngineChange={() => undefined}
      onShowPasswordChange={() => undefined}
    />,
  )
}

describe('数据源表单', () => {
  test('Given 新建表单 When 渲染 Then 带出 MySQL 默认端口并隐藏已保存密码入口', () => {
    const html = renderFields()
    // Radix Select 的当前值在 SSR 静态标记里不落地，这里以默认端口和字段集合为断言依据。
    expect(html).toContain('value="3306"')
    expect(html).toContain('id="server-ops-data-engine"')
    expect(html).toContain('id="server-ops-data-tls"')
    expect(html).toContain('服务器视角地址')
    expect(html).toContain('库名')
    expect(html).not.toContain('清除已保存密码')
  })

  test('Given 切换到 Redis When 应用变更 Then 带入 6379 并清空库名', () => {
    const draft = { ...createServerOpsDataSourceDraft(null), database: 'app' }
    const next = applyServerOpsDataSourceEngineChange(draft, 'redis')
    expect(next.engine).toBe('redis')
    expect(next.port).toBe('6379')
    expect(next.database).toBe('')
    expect(renderFields({ draft: next }).includes('逻辑库（0-15）')).toBe(true)
  })

  test('Given 编辑已有密码的数据源 When 渲染 Then 展示保留提示与清除入口且不回填密码', () => {
    const html = renderFields({ mode: 'edit', source: createSource(), hasSavedPassword: true })
    expect(html).toContain('留空表示保留已保存密码')
    expect(html).toContain('清除已保存密码')
    expect(html).toContain('value=""')
    expect(html).not.toContain('password-canary')
  })

  test('Given TLS 校验证书 When 渲染 Then 展示真实主机名输入与说明', () => {
    const draft = { ...createServerOpsDataSourceDraft(null), tlsMode: 'verify' as const, tlsServerName: 'db.internal' }
    const html = renderFields({ draft })
    expect(html).toContain('数据库真实主机名')
    expect(html).toContain('证书里签发的名字')
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
    expect(validateServerOpsDataSourceDraft({ ...base, label: '库', tlsMode: 'verify' }).tlsServerName)
      .toBe('校验证书时必须填写数据库真实主机名，且不能包含空白')
    expect(validateServerOpsDataSourceDraft({ ...base, label: '库', address: '127.0.0.1' })).toEqual({})
  })

  test('Given 编辑留空密码 When 构造输入 Then 不携带 password', () => {
    const input = buildServerOpsDataSourceUpsertInput({
      hostId: 'host-1',
      source: createSource(),
      draft: createServerOpsDataSourceDraft(createSource()),
    })
    expect(input).toEqual({
      transport: 'ssh',
      hostId: 'host-1',
      sourceId: 'source-1',
      engine: 'mysql',
      label: '业务主库',
      address: '127.0.0.1',
      port: 3306,
      database: 'app',
      username: 'monitor',
      tlsMode: 'disabled',
    })
    expect('password' in input).toBe(false)
    expect('clearPassword' in input).toBe(false)
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
      transport: 'direct', engine: 'mysql', address: '127.0.0.1', port: 3306, username: 'monitor', password: 'p@ss', tlsMode: 'disabled',
    })

    /** 编辑且留空密码：复用已保存密文，不假装没有密码。 */
    expect(buildServerOpsDataSourceProbeDraft({
      hostId: 'host-1',
      source: createSource(),
      draft: createServerOpsDataSourceDraft(createSource()),
    })).toEqual({
      transport: 'ssh', hostId: 'host-1', engine: 'mysql', address: '127.0.0.1', port: 3306,
      database: 'app', username: 'monitor', savedSourceId: 'source-1', tlsMode: 'disabled',
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
    const draft = { ...createServerOpsDataSourceDraft(null), label: '内网库', address: '172.16.10.198' }
    const html = renderFields({ draft })
    expect(html).toContain('data-server-ops-data-plaintext-hint')
    expect(html).toContain('内网明文')
    expect(html).not.toContain('data-server-ops-data-tls-required-hint')
  })

  test('Given 公网地址或主机名关闭 TLS When 渲染表单 Then 提前说明会被拒绝', () => {
    /** 公网地址：必须开证书校验，否则主进程会拒绝发起连接。 */
    const publicDraft = { ...createServerOpsDataSourceDraft(null), label: '公网库', address: '8.8.8.8' }
    expect(renderFields({ draft: publicDraft })).toContain('data-server-ops-data-tls-required-hint')
    /** 主机名无法离线判定归属，同样提前提示，避免保存一个永远连不上的配置。 */
    const hostnameDraft = { ...createServerOpsDataSourceDraft(null), label: '域名库', address: 'db.internal' }
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
