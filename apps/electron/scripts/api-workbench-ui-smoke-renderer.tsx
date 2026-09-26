import '@fontsource-variable/inter/index.css'
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { createStore, Provider } from 'jotai'
import { createApiRequestDraft } from '@proma/shared'
import type { ApiCatalog, ApiCookieJarEntry, ApiCryptoProfile, ApiPreparedPreview, ApiResolvedRequest, ApiRun, ApiRunStreamChanged, ApiRuntimeVariable, ApiScenarioRun, ApiWorkbenchApi, PermissionRequest } from '@proma/shared'
import { ApiWorkbench } from '../src/renderer/components/api-workbench/ApiWorkbench'
import { PermissionBanner } from '../src/renderer/components/agent/PermissionBanner'
import { TooltipProvider } from '../src/renderer/components/ui/tooltip'
import { allPendingPermissionRequestsAtom } from '../src/renderer/atoms/agent-atoms'
import '../src/renderer/styles/globals.css'

/** smoke 运行状态只记录公开计数和目录，不包含凭据。 */
interface ApiSmokeState { catalog: ApiCatalog; runs: ApiRun[]; cookies: ApiCookieJarEntry[]; prepareCalls: number; sendCalls: number; getRunCalls: number; revealGetRunCalls: number; revealBodyCalls: number; clipboard: string; respondPermissionCalls: PermissionResponseRecord[]; scenarioPrepareCalls: number; scenarioRunCalls: number; scenarioRun: ApiScenarioRun | null; revealVariableCalls: number; savedProfileCalls: number }

/** 审批卡点击「允许/拒绝」时通过 preload 回传的载荷（夹具只记录，不真的授权）。 */
interface PermissionResponseRecord { requestId: string; behavior: 'allow' | 'deny'; alwaysAllow: boolean }

/** 初始目录提供一个可点击集合。 */
/** 公共配置夹具：一套方案 + 两个变量（一个秘密、一个普通），供加密分区与变量表格使用。 */
const cryptoProfile: ApiCryptoProfile = {
  id: 'profile_smoke', name: '烟测方案', description: '签名后加密正文', scope: 'workspace', appliesTo: 'all', revision: 1, updatedAt: 1,
  requestSteps: [
    { id: 'cs_sign', kind: 'sign', enabled: true, algo: 'HMAC-SHA256', keyRef: 'appSecret', encoding: 'hex', target: { in: 'header', name: 'X-Sign' }, template: '{{method}}\n{{path}}' },
    { id: 'cs_encrypt', kind: 'encrypt', enabled: true, algo: 'AES-128-CBC', keyRef: 'aesKey', ivRef: 'aesIv', encoding: 'base64', source: 'body', target: { in: 'body', name: 'body' } },
  ],
  responseSteps: [{ id: 'cs_decrypt', kind: 'decrypt', enabled: true, algo: 'AES-128-CBC', keyRef: 'aesKey', ivRef: 'aesIv', encoding: 'base64', source: 'response-body', onFailure: 'stop' }],
}

const state: ApiSmokeState = {
  catalog: {
    version: 1, revision: 0,
    collections: [{ id: 'default', name: '默认集合', description: '', variables: [] }],
    environments: [], requests: [],
    cryptoProfiles: [cryptoProfile],
    workspaceVariables: [
      { id: 'v_secret', name: 'appSecret', value: '', enabled: true, secret: true, secretRef: 'ref_secret' },
      { id: 'v_plain', name: 'baseUrl', value: 'http://127.0.0.1:18080', enabled: true },
    ],
  },
  runs: [], cookies: [], prepareCalls: 0, sendCalls: 0, getRunCalls: 0, revealGetRunCalls: 0, revealBodyCalls: 0, clipboard: '', respondPermissionCalls: [],
  scenarioPrepareCalls: 0, scenarioRunCalls: 0, scenarioRun: null, revealVariableCalls: 0, savedProfileCalls: 0,
}
/** 最近一次准备后的固定请求。 */
let preparedRequest: ApiResolvedRequest | null = null
/** 最近一次准备绑定的已保存请求 ID，用于让历史运行可以重发。 */
let preparedRequestId: string | undefined
/** 最近一次准备绑定的用例身份；为空表示这是一次不按用例的发送。 */
let preparedCaseId: string | undefined
/** 用例在本次 smoke 里首次出现的顺序，用来决定它是通过还是失败。 */
const caseOrder = new Map<string, number>()
/** 运行时变量面板的合成元数据；值从不离开主进程，这里也只有一个名字。 */
let runtimeVariables: ApiRuntimeVariable[] = [{ name: 'sessionToken', secret: true, source: '请求「Smoke 请求」', updatedAt: Date.now() }]
/** 供 smoke 注入的流式事件订阅者，验证实时事件真的能进入组件。 */
const streamListeners = new Set<(event: ApiRunStreamChanged) => void>()

/** 构造可覆盖响应详情全部分区的合成运行。 */
function createRun(request: ApiResolvedRequest, requestId?: string, caseId?: string): ApiRun {
  /** 按用例运行时序号决定结论：第一个用例全通过，其余用例故意失败。 */
  const caseIndex = caseId === undefined ? undefined : caseOrder.get(caseId) ?? 0
  const casePassed = caseIndex === undefined || caseIndex === 0
  return {
    id: caseId === undefined ? 'run-smoke' : `run-${caseId}`, workspaceId: 'workspace-smoke', sessionId: 'session-smoke', source: 'manual', requestName: 'Smoke 请求',
    ...(requestId ? { requestId } : {}),
    ...(caseId ? { caseId } : {}),
    catalogRevision: state.catalog.revision, createdAt: Date.now() - 25, finishedAt: Date.now(), state: 'completed', request,
    hops: [{
      url: request.url, method: request.method, requestHeaders: request.headers, requestHeadersSource: 'configured', status: 200, statusText: 'OK', httpVersion: '1.1',
      responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], trailers: [{ name: 'X-Smoke-Trailer', value: 'done' }],
      timings: { dnsMs: 1, connectMs: 2, tlsMs: null, sendMs: 1, ttfbMs: 3, downloadMs: 1, totalMs: 8 },
      connection: { reused: false, localAddress: '127.0.0.1', localPort: 41000, remoteAddress: '127.0.0.1', remotePort: 8080 },
    }],
    body: { rawBytes: 11, decodedBytes: 11, contentType: 'application/json', encoding: 'utf-8', preview: '{"ok":true}', previewTruncated: false, complete: true, decoded: true },
    /** 不按用例时仍是原来的通过断言；按用例时区分通过/失败，覆盖报告两种结论。 */
    assertions: caseId === undefined
      ? [{ id: 'status', passed: true, expected: '200', actual: '200', message: '状态码匹配' }]
      : [{ id: casePassed ? 'case_pass' : 'case_fail', passed: casePassed, expected: casePassed ? '200' : '401', actual: '200', message: casePassed ? '断言通过' : '断言失败' }],
    recording: 'memory-only', pinned: false,
    /**
     * 加密事实：夹具固定给一条「缺密钥 → 明文发出」的记录。
     * 状态下必须显式标出来——一个 200 不能让人以为加密生效了。
     */
    crypto: {
      profileId: 'profile_smoke', profileName: '烟测方案', profileRevision: 1,
      executed: [{ id: 'cs_sign', kind: 'sign', algo: 'HMAC-SHA256' }],
      skipped: [{ id: 'cs_encrypt', kind: 'encrypt', algo: 'AES-128-CBC', reason: 'missing-secret', keyRef: 'aesKey' }],
      plaintextSent: true, decrypted: false,
    },
    /** 事件流事实与实时增量共用同一渲染路径。 */
    sse: {
      events: [
        { index: 0, receivedMs: 12, event: '', id: '', comment: 'keep-alive', data: '', raw: ': keep-alive\n\n', truncated: false },
        { index: 1, receivedMs: 48, event: 'delta', id: '7', comment: '', data: '第一段', raw: 'event: delta\nid: 7\ndata: 第一段\n\n', truncated: false },
      ],
      totalEvents: 2, firstEventMs: 12, droppedEvents: 0, endedReason: 'completed',
    },
  }
}

/** 合成 preload API，所有操作都停留在当前 renderer 内存。 */
const api: ApiWorkbenchApi = {
  getCatalog: async () => structuredClone(state.catalog),
  saveCatalog: async (input) => {
    state.catalog = { ...structuredClone(input.catalog), revision: state.catalog.revision + 1 }
    return structuredClone(state.catalog)
  },
  prepare: async (input): Promise<ApiPreparedPreview> => {
    state.prepareCalls += 1
    preparedRequestId = input.requestId
    preparedCaseId = input.caseId
    /** 用例第一次被准备时登记顺序，后续报告按该顺序给结论。 */
    if (input.caseId && !caseOrder.has(input.caseId)) caseOrder.set(input.caseId, caseOrder.size)
    preparedRequest = { method: input.request.method, url: input.request.url, headers: input.request.headers.map(({ name, value }) => ({ name, value })), body: input.request.body.text, timeoutMs: input.request.timeoutMs, followRedirects: input.request.followRedirects, maxRedirects: input.request.maxRedirects, sensitiveHeaderNames: [], sensitiveQueryNames: [] }
    /** 扮演 Host 的脱敏投影：真实运行里含秘密的 Header 只会以遮罩出现，供「载入编辑器」验证待重填提示。 */
    preparedRequest = { ...preparedRequest, headers: [...preparedRequest.headers, { name: 'X-Api-Key', value: '[REDACTED]' }], sensitiveHeaderNames: ['x-api-key'] }
    return { preparedId: 'prepared-smoke', request: preparedRequest, requestName: input.request.name, catalogRevision: state.catalog.revision, createdAt: Date.now(), expiresAt: Date.now() + 60_000, warnings: [] }
  },
  send: async () => {
    state.sendCalls += 1
    const run = createRun(preparedRequest ?? { ...createApiRequestDraft(), headers: [], body: '', sensitiveHeaderNames: [], sensitiveQueryNames: [] }, preparedRequestId, preparedCaseId)
    /** 每次运行都保留：用例报告要按 runId 逐条打开，历史也按真实条数展示。 */
    state.runs = [run, ...state.runs.filter((item) => item.id !== run.id)]
    return structuredClone(run)
  },
  cancel: async () => undefined,
  listRuns: async () => ({ runs: structuredClone(state.runs), nextCursor: null }),
  getRun: async (input) => {
    state.getRunCalls += 1
    if (input.reveal) state.revealGetRunCalls += 1
    return structuredClone(state.runs.find((item) => item.id === input.runId) ?? state.runs[0]!)
  },
  readBody: async (input) => {
    if (input.reveal) state.revealBodyCalls += 1
    const text = input.reveal ? '{"secret":"revealed"}' : '{"ok":true}'
    return { text, offset: input.offset, nextOffset: null, totalChars: text.length, truncated: false }
  },
  pinRun: async (input) => {
    const index = state.runs.findIndex((item) => item.id === input.runId)
    const target = index < 0 ? 0 : index
    state.runs[target] = { ...state.runs[target]!, pinned: input.pinned }
    return structuredClone(state.runs[target]!)
  },
  onChanged: () => () => undefined,
  onStream: (callback) => {
    streamListeners.add(callback)
    return () => { streamListeners.delete(callback) }
  },
  getRuntimeVariables: async () => ({ variables: runtimeVariables.map((item) => ({ ...item })) }),
  clearRuntimeVariables: async () => {
    const cleared = runtimeVariables.length
    runtimeVariables = []
    return { cleared }
  },
  /** Cookie 面板只回元数据：夹具里也没有取值字段。 */
  /** 原生文件对话框由主进程打开；夹具直接回一个引用与元数据（不含路径）。 */
  pickApiFiles: async () => ({ files: [{ ref: 'file_fixture1', fileName: 'smoke.png', sizeBytes: 2048, contentType: 'image/png' }] }),
  /** 流程：夹具扮演 Host 给出步骤清单与逐步结果，界面只负责展示与调度。 */
  prepareScenario: async (input) => {
    state.scenarioPrepareCalls += 1
    return {
      preparedId: 'prepared-scenario-smoke',
      scenarioId: input.scenarioId,
      scenarioName: '登录后看详情',
      catalogRevision: state.catalog.revision,
      environmentId: 'env_test',
      onFailure: 'stop',
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      warnings: [],
      steps: [
        { index: 0, stepId: 'step_login', name: '登录', requestId: 'request_login', method: 'POST', url: 'https://example.test/login', environmentKind: 'test', assertionCount: 1 },
        { index: 1, stepId: 'step_profile', name: '用户详情', requestId: 'request_profile', method: 'GET', url: 'https://example.test/profile', environmentKind: 'test', assertionCount: 2 },
      ],
    }
  },
  runScenario: async (input) => {
    state.scenarioRunCalls += 1
    const run: ApiScenarioRun = {
      id: 'scenario-run-smoke', workspaceId: 'workspace-smoke', sessionId: 'session-smoke', source: 'manual',
      scenarioId: 'scenario_login_profile', scenarioName: '登录后看详情', catalogRevision: state.catalog.revision, environmentId: 'env_test',
      state: 'completed', startedAt: Date.now() - 40, finishedAt: Date.now(),
      steps: [
        { stepId: 'step_login', name: '登录', state: 'passed', runId: 'run-step-login', status: 200, assertionPassed: 1, assertionTotal: 1, durationMs: 18 },
        { stepId: 'step_profile', name: '用户详情', state: 'passed', runId: 'run-step-profile', status: 200, assertionPassed: 2, assertionTotal: 2, durationMs: 22 },
      ],
      assertions: [
        { id: 'step_login', passed: true, expected: '步骤通过', actual: 'passed', message: '步骤通过' },
        { id: 'step_profile', passed: true, expected: '步骤通过', actual: 'passed', message: '步骤通过' },
      ],
    }
    state.scenarioRun = run
    void input
    return structuredClone(run)
  },
  cancelScenario: async () => undefined,
  listScenarioRuns: async () => ({ runs: state.scenarioRun ? [structuredClone(state.scenarioRun)] : [], nextCursor: null }),
  getScenarioRun: async (input) => structuredClone(state.scenarioRun ?? { id: input.scenarioRunId } as ApiScenarioRun),
  getCookieJar: async () => ({ cookies: state.cookies.map((item) => ({ ...item })) }),
  clearCookieJar: async () => {
    const cleared = state.cookies.length
    state.cookies = []
    return { cleared }
  },
  /** 公共配置：变量批写、方案保存、引用检查与「点 👁 才明文显示」。 */
  saveWorkspaceVariables: async (input) => {
    state.catalog = { ...state.catalog, revision: state.catalog.revision + 1, workspaceVariables: structuredClone(input.variables) }
    return { variables: structuredClone(input.variables) }
  },
  saveCryptoProfile: async (input) => {
    state.savedProfileCalls += 1
    const saved = { ...input.profile, revision: (input.profile.revision || 0) + 1, updatedAt: Date.now() }
    state.catalog = { ...state.catalog, revision: state.catalog.revision + 1, cryptoProfiles: [...(state.catalog.cryptoProfiles ?? []).filter((item) => item.id !== saved.id), saved] }
    return structuredClone(saved)
  },
  deleteCryptoProfile: async () => ({ removed: false, referencedBy: 1 }),
  getCryptoReferences: async (input) => ({ profiles: [cryptoProfile.name], requests: input.kind === 'profile' ? 1 : 0, collections: ['默认集合'] }),
  revealVariable: async () => {
    state.revealVariableCalls += 1
    return { name: 'appSecret', value: 'cb-app-2026-9f2c8a1d' }
  },
}

/** 让生产组件读取合成 preload，并向 Electron 验收暴露只读状态。 */
/** 复制走真实 preload 能力：这里记录文本，供 smoke 校验报告内容。 */
/** respondPermission 记录载荷：审批卡的「允许」必须走这条真实通道，而不是直接改状态。 */
Object.defineProperty(window, 'electronAPI', {
  configurable: true,
  value: {
    apiWorkbench: api,
    writeClipboardText: async (text: string) => { state.clipboard = text },
    respondPermission: async (response: PermissionResponseRecord) => { state.respondPermissionCalls.push({ ...response }) },
  },
})
Object.defineProperty(window, '__apiWorkbenchSmoke', { configurable: true, get: () => structuredClone(state) })
/** smoke 夹具：确认框一律「确认」，避免隐藏窗口里的 window.confirm 把流程挂住。 */
Object.defineProperty(window, 'confirm', { configurable: true, value: () => true })
/** 记录「打开运行」事件：验证流程里的某一步能跳到它自己的运行记录。 */
window.addEventListener('proma:open-api-run', (event) => {
  const detail = (event as CustomEvent<{ runId?: string }>).detail
  ;(window as typeof window & { __apiWorkbenchOpenRun?: string }).__apiWorkbenchOpenRun = detail?.runId
})
/** smoke 唯一的流式注入入口；只接受已通过合同校验的事件。 */
Object.defineProperty(window, '__apiWorkbenchEmitStream', {
  configurable: true,
  value: (event: ApiRunStreamChanged) => { for (const listener of streamListeners) listener(event) },
})
/** smoke 用：扮演 Host 提供两三条 cookie 元数据，用于验证面板展示与清空。 */
Object.defineProperty(window, '__apiWorkbenchSmokeSeedCookies', {
  configurable: true,
  value: () => {
    state.cookies = [
      { name: 'sid', domain: '127.0.0.1', path: '/', secure: false, httpOnly: true, expiresAt: null, updatedAt: Date.now() },
      { name: 'theme', domain: '127.0.0.1', path: '/app', secure: false, httpOnly: false, expiresAt: Date.now() + 60_000, updatedAt: Date.now() },
    ]
    return true
  },
})
/** Agent 用例窗口：夹具扮演 Host，提供一条由 Agent 声明、一条由人工创建的用例。 */
if (new URLSearchParams(location.search).has('agent-case')) {
  state.catalog = {
    version: 1, revision: 4,
    collections: [{ id: 'default', name: 'Agent 集合', description: '', variables: [] }],
    environments: [],
    requests: [{
      ...createApiRequestDraft('default'), id: 'request_agent', revision: 2, updatedAt: 1,
      name: 'Agent 建的接口', url: 'https://example.test/orders', method: 'POST',
      cases: [
        { id: 'case_agent_ok', name: 'Agent 猜的下单成功', assertions: [{ id: 'agent_a', kind: 'status', path: '', expected: '201' }], source: 'agent' },
        { id: 'case_human_deny', name: '人工写的越权', assertions: [{ id: 'human_a', kind: 'status', path: '', expected: '403' }], source: 'user' },
      ],
    }],
  }
}

/** 流程窗口：夹具提供两条请求与一条引用它们的流程，用于验证「运行 → 逐步结果」。 */
if (new URLSearchParams(location.search).has('scenario')) {
  state.catalog = {
    version: 1, revision: 6,
    collections: [{ id: 'default', name: '后台', description: '', variables: [] }],
    environments: [{ id: 'env_test', name: '测试环境', kind: 'test', variables: [] }],
    requests: [
      { ...createApiRequestDraft('default'), id: 'request_login', revision: 1, updatedAt: 1, name: '登录', method: 'POST', url: 'https://example.test/login' },
      { ...createApiRequestDraft('default'), id: 'request_profile', revision: 1, updatedAt: 1, name: '用户详情', method: 'GET', url: 'https://example.test/profile' },
    ],
    scenarios: [{
      id: 'scenario_login_profile', name: '登录后看详情', description: '', collectionId: 'default', folder: '用户模块',
      steps: [
        { id: 'step_login', name: '登录', requestId: 'request_login' },
        { id: 'step_profile', name: '用户详情', requestId: 'request_profile', caseId: 'case_smoke' },
      ],
      environmentId: 'env_test', onFailure: 'stop', revision: 1, updatedAt: 1,
    }],
  }
}

/** smoke 页面只挂载生产接口工作台。 */
function SmokeApp(): React.ReactElement {
  React.useEffect(() => { document.body.dataset.smokeReady = 'true' }, [])
  return <TooltipProvider delayDuration={0}><div className="h-screen w-screen bg-background"><ApiWorkbench sessionId="session-smoke" workspaceScope="workspace-smoke" /></div></TooltipProvider>
}

/**
 * 偏移栏窗口：左边放一条占位栏（模拟聊天栏），工作台只占右侧一栏。
 * 用来验证「窄栏目录抽屉必须停在工作台这一栏内」，而不是贴到窗口最左侧。
 */
function OffsetPaneApp(): React.ReactElement {
  React.useEffect(() => { document.body.dataset.smokeReady = 'true' }, [])
  return (
    <TooltipProvider delayDuration={0}>
      <div className="flex h-screen w-screen bg-background">
        <div aria-label="左侧占位栏" className="w-80 shrink-0 border-r border-border/50 bg-muted/20" />
        <div className="min-w-0 flex-1"><ApiWorkbench sessionId="session-smoke" workspaceScope="workspace-smoke" /></div>
      </div>
    </TooltipProvider>
  )
}

/**
 * 审批卡窗口：夹具扮演 Host 推入一条「Agent 指定文件」的发送审批，
 * 重点是让「允许」按钮走真实组件逻辑（respondPermission），而不是 smoke 直接改状态。
 */
function ApprovalApp(): React.ReactElement {
  React.useEffect(() => { document.body.dataset.smokeReady = 'true' }, [])
  return (
    <TooltipProvider delayDuration={0}>
      <div className="flex h-screen w-screen items-end bg-background">
        <PermissionBanner sessionId="session-approval" onStop={() => undefined} />
      </div>
    </TooltipProvider>
  )
}

/** 夹具里的审批请求：工具名、附件行与真实运行同形，路径用 realpath 形态。 */
const approvalRequest: PermissionRequest = {
  requestId: 'permission-smoke',
  sessionId: 'session-approval',
  toolName: 'api_send_request',
  toolInput: {
    preparedId: 'prepared-smoke',
    preview: { requestName: 'Agent 上传附件', environmentId: 'env_test', request: { method: 'POST', url: 'https://example.test/upload' } },
    send: { assertionCount: 0 },
    files: [{ field: 'file', path: '/Users/ada/secret/id_rsa', sizeBytes: 1675 }],
  },
  description: '发送接口请求',
  dangerLevel: 'dangerous',
  allowAlways: false,
}

const search = new URLSearchParams(location.search)
if (search.has('approval')) {
  const store = createStore()
  store.set(allPendingPermissionRequestsAtom, new Map([['session-approval', [approvalRequest]]]))
  createRoot(document.getElementById('root')!).render(<Provider store={store}><ApprovalApp /></Provider>)
} else if (search.has('big-catalog')) {
  /** 大目录窗口：60 条请求铺满目录区，用来验证「一级（集合）行吸顶」。 */
  state.catalog = {
    version: 1, revision: 9,
    collections: [{ id: 'default', name: '后台接口', description: '', variables: [] }],
    environments: [],
    requests: Array.from({ length: 60 }, (_value, index) => ({
      ...createApiRequestDraft('default'),
      id: `request_${index}`,
      revision: 1,
      updatedAt: 1,
      name: `渠道模型绑定 ${index}`,
      method: 'POST' as const,
      url: `{{baseUrl}}/admin/v1/channel/${index}`,
      folder: index % 2 === 0 ? 'AI 能力与模型' : '',
    })),
  }
  createRoot(document.getElementById('root')!).render(<SmokeApp />)
} else if (search.has('offset-pane')) {
  createRoot(document.getElementById('root')!).render(<OffsetPaneApp />)
} else {
  createRoot(document.getElementById('root')!).render(<SmokeApp />)
}
