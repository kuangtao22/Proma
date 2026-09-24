import '@fontsource-variable/inter/index.css'
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { createApiRequestDraft } from '@proma/shared'
import type { ApiCatalog, ApiCookieJarEntry, ApiPreparedPreview, ApiResolvedRequest, ApiRun, ApiRunStreamChanged, ApiRuntimeVariable, ApiWorkbenchApi } from '@proma/shared'
import { ApiWorkbench } from '../src/renderer/components/api-workbench/ApiWorkbench'
import { TooltipProvider } from '../src/renderer/components/ui/tooltip'
import '../src/renderer/styles/globals.css'

/** smoke 运行状态只记录公开计数和目录，不包含凭据。 */
interface ApiSmokeState { catalog: ApiCatalog; runs: ApiRun[]; cookies: ApiCookieJarEntry[]; prepareCalls: number; sendCalls: number; getRunCalls: number; revealGetRunCalls: number; revealBodyCalls: number; clipboard: string }

/** 初始目录提供一个可点击集合。 */
const state: ApiSmokeState = {
  catalog: { version: 1, revision: 0, collections: [{ id: 'default', name: '默认集合', description: '', variables: [] }], environments: [], requests: [] },
  runs: [], cookies: [], prepareCalls: 0, sendCalls: 0, getRunCalls: 0, revealGetRunCalls: 0, revealBodyCalls: 0, clipboard: '',
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
  getCookieJar: async () => ({ cookies: state.cookies.map((item) => ({ ...item })) }),
  clearCookieJar: async () => {
    const cleared = state.cookies.length
    state.cookies = []
    return { cleared }
  },
}

/** 让生产组件读取合成 preload，并向 Electron 验收暴露只读状态。 */
/** 复制走真实 preload 能力：这里记录文本，供 smoke 校验报告内容。 */
Object.defineProperty(window, 'electronAPI', { configurable: true, value: { apiWorkbench: api, writeClipboardText: async (text: string) => { state.clipboard = text } } })
Object.defineProperty(window, '__apiWorkbenchSmoke', { configurable: true, get: () => structuredClone(state) })
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

/** smoke 页面只挂载生产接口工作台。 */
function SmokeApp(): React.ReactElement {
  React.useEffect(() => { document.body.dataset.smokeReady = 'true' }, [])
  return <TooltipProvider delayDuration={0}><div className="h-screen w-screen bg-background"><ApiWorkbench sessionId="session-smoke" workspaceScope="workspace-smoke" /></div></TooltipProvider>
}

createRoot(document.getElementById('root')!).render(<SmokeApp />)
