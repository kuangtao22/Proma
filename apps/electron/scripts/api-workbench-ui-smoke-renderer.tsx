import '@fontsource-variable/inter/index.css'
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { createApiRequestDraft } from '@proma/shared'
import type { ApiCatalog, ApiPreparedPreview, ApiResolvedRequest, ApiRun, ApiRunStreamChanged, ApiRuntimeVariable, ApiWorkbenchApi } from '@proma/shared'
import { ApiWorkbench } from '../src/renderer/components/api-workbench/ApiWorkbench'
import { TooltipProvider } from '../src/renderer/components/ui/tooltip'
import '../src/renderer/styles/globals.css'

/** smoke 运行状态只记录公开计数和目录，不包含凭据。 */
interface ApiSmokeState { catalog: ApiCatalog; runs: ApiRun[]; prepareCalls: number; sendCalls: number; getRunCalls: number; revealGetRunCalls: number; revealBodyCalls: number }

/** 初始目录提供一个可点击集合。 */
const state: ApiSmokeState = {
  catalog: { version: 1, revision: 0, collections: [{ id: 'default', name: '默认集合', description: '', variables: [] }], environments: [], requests: [] },
  runs: [], prepareCalls: 0, sendCalls: 0, getRunCalls: 0, revealGetRunCalls: 0, revealBodyCalls: 0,
}
/** 最近一次准备后的固定请求。 */
let preparedRequest: ApiResolvedRequest | null = null
/** 最近一次准备绑定的已保存请求 ID，用于让历史运行可以重发。 */
let preparedRequestId: string | undefined
/** 运行时变量面板的合成元数据；值从不离开主进程，这里也只有一个名字。 */
let runtimeVariables: ApiRuntimeVariable[] = [{ name: 'sessionToken', secret: true, source: '请求「Smoke 请求」', updatedAt: Date.now() }]
/** 供 smoke 注入的流式事件订阅者，验证实时事件真的能进入组件。 */
const streamListeners = new Set<(event: ApiRunStreamChanged) => void>()

/** 构造可覆盖响应详情全部分区的合成运行。 */
function createRun(request: ApiResolvedRequest, requestId?: string): ApiRun {
  return {
    id: 'run-smoke', workspaceId: 'workspace-smoke', sessionId: 'session-smoke', source: 'manual', requestName: 'Smoke 请求',
    ...(requestId ? { requestId } : {}),
    catalogRevision: state.catalog.revision, createdAt: Date.now() - 25, finishedAt: Date.now(), state: 'completed', request,
    hops: [{
      url: request.url, method: request.method, requestHeaders: request.headers, requestHeadersSource: 'configured', status: 200, statusText: 'OK', httpVersion: '1.1',
      responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], trailers: [{ name: 'X-Smoke-Trailer', value: 'done' }],
      timings: { dnsMs: 1, connectMs: 2, tlsMs: null, sendMs: 1, ttfbMs: 3, downloadMs: 1, totalMs: 8 },
      connection: { reused: false, localAddress: '127.0.0.1', localPort: 41000, remoteAddress: '127.0.0.1', remotePort: 8080 },
    }],
    body: { rawBytes: 11, decodedBytes: 11, contentType: 'application/json', encoding: 'utf-8', preview: '{"ok":true}', previewTruncated: false, complete: true, decoded: true },
    assertions: [{ id: 'status', passed: true, expected: '200', actual: '200', message: '状态码匹配' }], recording: 'memory-only', pinned: false,
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
    preparedRequest = { method: input.request.method, url: input.request.url, headers: input.request.headers.map(({ name, value }) => ({ name, value })), body: input.request.body.text, timeoutMs: input.request.timeoutMs, followRedirects: input.request.followRedirects, maxRedirects: input.request.maxRedirects, sensitiveHeaderNames: [], sensitiveQueryNames: [] }
    return { preparedId: 'prepared-smoke', request: preparedRequest, requestName: input.request.name, catalogRevision: state.catalog.revision, createdAt: Date.now(), expiresAt: Date.now() + 60_000, warnings: [] }
  },
  send: async () => {
    state.sendCalls += 1
    const run = createRun(preparedRequest ?? { ...createApiRequestDraft(), headers: [], body: '', sensitiveHeaderNames: [], sensitiveQueryNames: [] }, preparedRequestId)
    state.runs = [run]
    return structuredClone(run)
  },
  cancel: async () => undefined,
  listRuns: async () => ({ runs: structuredClone(state.runs), nextCursor: null }),
  getRun: async (input) => { state.getRunCalls += 1; if (input.reveal) state.revealGetRunCalls += 1; return structuredClone(state.runs[0]!) },
  readBody: async (input) => {
    if (input.reveal) state.revealBodyCalls += 1
    const text = input.reveal ? '{"secret":"revealed"}' : '{"ok":true}'
    return { text, offset: input.offset, nextOffset: null, totalChars: text.length, truncated: false }
  },
  pinRun: async (input) => { state.runs[0] = { ...state.runs[0]!, pinned: input.pinned }; return structuredClone(state.runs[0]!) },
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
}

/** 让生产组件读取合成 preload，并向 Electron 验收暴露只读状态。 */
Object.defineProperty(window, 'electronAPI', { configurable: true, value: { apiWorkbench: api } })
Object.defineProperty(window, '__apiWorkbenchSmoke', { configurable: true, get: () => structuredClone(state) })
/** smoke 唯一的流式注入入口；只接受已通过合同校验的事件。 */
Object.defineProperty(window, '__apiWorkbenchEmitStream', {
  configurable: true,
  value: (event: ApiRunStreamChanged) => { for (const listener of streamListeners) listener(event) },
})

/** smoke 页面只挂载生产接口工作台。 */
function SmokeApp(): React.ReactElement {
  React.useEffect(() => { document.body.dataset.smokeReady = 'true' }, [])
  return <TooltipProvider delayDuration={0}><div className="h-screen w-screen bg-background"><ApiWorkbench sessionId="session-smoke" workspaceScope="workspace-smoke" /></div></TooltipProvider>
}

createRoot(document.getElementById('root')!).render(<SmokeApp />)
