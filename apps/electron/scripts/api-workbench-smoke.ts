/** 独立 Electron 验收：真实 preload/IPC → Service → Utility → 回环 HTTP，数据只写临时目录。 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { app, BrowserWindow, ipcMain, safeStorage } from 'electron'
import { API_WORKBENCH_CHANNELS, createApiCaseReportRow, createApiRequestDraft, apiDraftFromDefinition, formatApiCaseReportMarkdown } from '@proma/shared'
import type { AgentSessionMeta, ApiCatalog, ApiPreparedPreview, ApiRun, ApiWorkbenchApi } from '@proma/shared'
import { ApiWorkbenchService } from '../src/main/lib/api-workbench/api-workbench-service'
import { ApiWorkbenchStore } from '../src/main/lib/api-workbench/api-workbench-store'
import { ApiRuntimeClient } from '../src/main/lib/api-workbench/api-runtime-client'
import { registerApiWorkbenchIpc } from '../src/main/lib/api-workbench/api-ipc'
import { createApiAgentFacade } from '../src/main/lib/api-workbench/api-agent-facade'

/** 临时根和该验收拥有的 Electron 内部目录，不触碰用户工作区。 */
const directory = mkdtempSync(join(tmpdir(), 'proma-api-smoke-'))
mkdirSync(join(directory, 'electron'))
app.setPath('userData', join(directory, 'electron'))
/** 只对本机合成请求计数，以证明重试/打开历史不会重复出网。 */
let calls = 0
/** 保留包含大整数和秘密回显的原始正文，检测脱敏和原文读取。 */
const payload = '{"id":90071992547409931234,"token":"fixture-secret","ok":true}'
/** 本测试的 HTTP server，慢接口供取消验证。 */
let receivedAuthorization = ''
const server = createServer((request, response) => {
  calls += 1
  if (request.url === '/slow') { response.writeHead(200); response.write('partial'); return }
  if (request.url === '/login') {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ token: 'fixture-token-9' }))
    return
  }
  if (request.url === '/me') {
    receivedAuthorization = String(request.headers.authorization ?? '')
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ ok: true }))
    return
  }
  if (request.url === '/stream') {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    response.write('data: 一\n\n')
    setTimeout(() => response.end('data: 二\n\n'), 15)
    return
  }
  if (request.url === '/stream-slow') {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    response.write('data: 首帧\n\n')
    return
  }
  response.writeHead(request.url === '/unauthorized' ? 401 : 200, ['Content-Type', 'application/json', 'Set-Cookie', 'a=one', 'Set-Cookie', 'b=two', 'Content-Encoding', 'gzip'])
  response.end(gzipSync(payload))
})
/** 与正式服务相同的真实 Utility client。 */
const runtime = new ApiRuntimeClient()
/** 异步清理使用实际服务对象，防止退出时残留子进程。 */
let service: ApiWorkbenchService | undefined
let window: BrowserWindow | undefined
/** 服务层向渲染进程广播的流式批次，用于验证通道与 preload 订阅。 */
const streamBatches: number[] = []
/** 全链路限时，不允许合成测试永久等待。 */
const watchdog = setTimeout(() => { console.error('[API smoke] 全链路超时'); void finish(1) }, 60_000)
/** 测试主窗口调用实际 preload，不在 renderer 注入模拟业务方法。 */
async function call<M extends Exclude<keyof ApiWorkbenchApi, 'onChanged'>>(method: M, input: Parameters<ApiWorkbenchApi[M]>[0]): Promise<Awaited<ReturnType<ApiWorkbenchApi[M]>>> {
  if (!window) throw new Error('窗口未创建')
  return window.webContents.executeJavaScript(`window.electronAPI.apiWorkbench[${JSON.stringify(method)}](${JSON.stringify(input)})`)
}
/** 验证持久化、真实传输、Agent 同源调用和取消语义。 */
async function smoke(): Promise<void> {
  app.dock?.hide()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const baseUrl = `http://127.0.0.1:${address.port}`
  const store = new ApiWorkbenchStore(directory, { safeStorage })
  service = new ApiWorkbenchService({
    store,
    transport: (request, options) => runtime.run(request, options),
    /** 与生产 singleton 相同的装配：服务事件经主进程广播到受信窗口。 */
    onStream: (event) => {
      streamBatches.push(event.events.length)
      window?.webContents.send(API_WORKBENCH_CHANNELS.STREAM, event)
    },
  })
  window = new BrowserWindow({ show: false, webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: false } })
  registerApiWorkbenchIpc({ ipc: ipcMain, service, isAuthorizedSender: (event) => event.sender.id === window?.webContents.id,
    requireSession: (id) => { if (id !== 'smoke-session') throw new Error('session not found'); return { id, workspaceId: 'smoke-project' } } })
  await window.loadURL('data:text/html,<html><body>API smoke</body></html>')
  /** 真实 preload 订阅，验证渲染进程确实能收到解析后的增量。 */
  await window.webContents.executeJavaScript("(() => { window.__apiStreamBatches = 0; window.__apiStreamOff = window.electronAPI.apiWorkbench.onStream(() => { window.__apiStreamBatches += 1 }); return true })()")
  const catalog = await call('getCatalog', { sessionId: 'smoke-session' }) as ApiCatalog
  const draft = { ...createApiRequestDraft(), name: '合成 GET', url: baseUrl + '/unauthorized', assertions: [{ id: 'status', kind: 'status' as const, path: '', expected: '401' }] }
  const saved = await call('saveCatalog', { sessionId: 'smoke-session', expectedRevision: catalog.revision, catalog: { ...catalog, requests: [{ ...draft, id: 'saved', revision: 1, updatedAt: Date.now() }] } }) as ApiCatalog
  assert.equal(saved.revision, 1)
  const prepared = await call('prepare', { sessionId: 'smoke-session', requestId: 'saved', request: apiDraftFromDefinition(saved.requests[0]!) }) as ApiPreparedPreview
  const run = await call('send', { sessionId: 'smoke-session', preparedId: prepared.preparedId }) as ApiRun
  assert.equal(run.state, 'completed', JSON.stringify(run))
  assert.equal(run.hops[0]?.status, 401)
  assert.equal(run.hops[0]?.responseHeaders.filter((header) => header.name.toLowerCase() === 'set-cookie').length, 2)
  assert.equal(run.assertions[0]?.passed, true)
  assert.ok(run.body.preview.includes('90071992547409931234'))
  assert.ok(!run.body.preview.includes('fixture-secret'))
  assert.equal((await call('send', { sessionId: 'smoke-session', preparedId: prepared.preparedId }) as ApiRun).id, run.id)
  assert.equal(calls, 1)
  assert.equal((await call('getRun', { sessionId: 'smoke-session', runId: run.id }) as ApiRun).id, run.id)
  if (safeStorage.isEncryptionAvailable()) {
    assert.equal(run.recording, 'saved')
    const reopened = new ApiWorkbenchStore(directory, { safeStorage })
    assert.equal(reopened.getRun('smoke-project', run.id).hops[0]?.status, 401)
    assert.equal((await reopened.readBody('smoke-project', run.id, { reveal: true })).text, payload)
    assert.ok(!readFileSync(join(directory, 'api-workbench', 'workspaces', 'smoke-project', 'runs', run.id, 'raw.bin.enc')).includes('fixture-secret'))
  }
  const abort = new AbortController()
  const facade = createApiAgentFacade({ sessionId: 'smoke-session', toolMode: 'standard', getSession: () => ({ id: 'smoke-session', workspaceId: 'smoke-project' } as AgentSessionMeta), service, runSignal: abort.signal, assertRunActive: () => { assert.equal(abort.signal.aborted, false) } })!
  const agentPrepared = await facade.prepare({ request: { url: baseUrl, method: 'POST' } })
  const args = { preparedId: agentPrepared.preparedId }
  await assert.rejects(facade.send(args), /APPROVAL_REQUIRED/)
  await facade.authorize('api_send_request', args, await facade.approval('api_send_request', args))
  const agentRun = await facade.send(args)
  assert.equal(agentRun.status, 200)
  assert.equal(calls, 2)
  assert.equal((await facade.send(args)).runId, agentRun.runId)
  /** 事件流：真实 utility 逐帧上报，运行记录与 Agent 检查都能读到明细。 */
  /** 流式请求同时带上事件级断言，验证「流式也能给出通过/失败结论」。 */
  const streamPrepared = await call('prepare', { sessionId: 'smoke-session', request: {
    ...draft,
    url: baseUrl + '/stream',
    assertions: [
      { id: 'sse_count', kind: 'sse-count' as const, path: '', expected: '>=2' },
      { id: 'sse_first', kind: 'sse-first-event' as const, path: '', expected: '<=5000' },
      { id: 'sse_ended', kind: 'sse-ended' as const, path: '', expected: 'completed' },
      { id: 'sse_last', kind: 'sse-last-data' as const, path: '', expected: '[未使用]' },
    ],
  } }) as ApiPreparedPreview
  const streamRun = await call('send', { sessionId: 'smoke-session', preparedId: streamPrepared.preparedId }) as ApiRun
  assert.equal(streamRun.state, 'completed', JSON.stringify(streamRun))
  assert.equal(streamRun.sse?.totalEvents, 2)
  assert.deepEqual(streamRun.sse?.events.map((event) => event.data), ['一', '二'])
  assert.equal(streamRun.sse?.endedReason, 'completed')
  assert.ok((streamRun.sse?.firstEventMs ?? -1) >= 0)
  assert.deepEqual(streamRun.assertions.map((entry) => entry.passed), [true, true, true, false])
  assert.equal(await window.webContents.executeJavaScript('window.__apiStreamBatches'), 1)
  const streamReopened = new ApiWorkbenchStore(directory, { safeStorage })
  assert.equal(streamReopened.getRun('smoke-project', streamRun.id).sse?.events.length, 2)
  assert.equal((await call('listRuns', { sessionId: 'smoke-session' })).runs.find((item) => item.id === streamRun.id)?.sse?.events.length, 0)
  const agentSse = await facade.inspect({ runId: streamRun.id, section: 'sse' }) as { stream: { totalEvents: number } | null; events: unknown[] }
  assert.equal(agentSse.stream?.totalEvents, 2)
  assert.equal(agentSse.events.length, 2)
  /** 事件流取消：保留已收到的事件，绝不自动重发。 */
  const streamSlowPrepared = await call('prepare', { sessionId: 'smoke-session', request: { ...draft, url: baseUrl + '/stream-slow' } }) as ApiPreparedPreview
  const streamPending = call('send', { sessionId: 'smoke-session', preparedId: streamSlowPrepared.preparedId })
  const streamStartedAt = Date.now()
  while (calls < 4 && Date.now() - streamStartedAt < 5_000) await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(calls, 4)
  await new Promise((resolve) => setTimeout(resolve, 30))
  await call('cancel', { sessionId: 'smoke-session', preparedId: streamSlowPrepared.preparedId })
  const streamCancelled = await streamPending as ApiRun
  assert.equal(streamCancelled.state, 'cancelled')
  assert.equal(streamCancelled.sse?.endedReason, 'cancelled')
  assert.deepEqual(streamCancelled.sse?.events.map((event) => event.data), ['首帧'])
  /** 提取与复用：登录响应里的 token 只写入宿主会话内存。 */
  const loginPrepared = await call('prepare', { sessionId: 'smoke-session', request: {
    ...draft, url: baseUrl + '/login', method: 'POST',
    extractions: [{ id: 'ex_token', name: 'sessionToken', from: 'json' as const, path: 'token', secret: true }],
  } }) as ApiPreparedPreview
  const loginRun = await call('send', { sessionId: 'smoke-session', preparedId: loginPrepared.preparedId }) as ApiRun
  assert.deepEqual(loginRun.extracted, [{ id: 'ex_token', name: 'sessionToken', from: 'json', found: true, secret: true }])
  assert.equal(JSON.stringify(loginRun).includes('fixture-token-9'), false, '运行记录不该出现提取到的明文')
  /** 后续请求用 {{sessionToken}} 复用；解析发生在主进程。 */
  const reusePrepared = await call('prepare', { sessionId: 'smoke-session', request: {
    ...draft, url: baseUrl + '/me',
    headers: [{ id: 'auth', name: 'Authorization', value: 'Bearer {{sessionToken}}', enabled: true }],
  } }) as ApiPreparedPreview
  const reuseRun = await call('send', { sessionId: 'smoke-session', preparedId: reusePrepared.preparedId }) as ApiRun
  assert.equal(receivedAuthorization, 'Bearer fixture-token-9', '服务端没有收到提取出来的 token')
  assert.equal(JSON.stringify(reuseRun).includes('fixture-token-9'), false, '运行记录不该出现运行时变量明文')
  /** 运行时变量面板只回传元数据，并可一键清空。 */
  const variables = await call('getRuntimeVariables', { sessionId: 'smoke-session' })
  assert.deepEqual(variables.variables.map((item) => item.name), ['sessionToken'])
  assert.equal(variables.variables[0]?.secret, true)
  assert.equal(JSON.stringify(variables).includes('fixture-token-9'), false, '运行时变量接口不该回传取值')
  assert.deepEqual(await call('clearRuntimeVariables', { sessionId: 'smoke-session' }), { cleared: 1 })
  assert.deepEqual(await call('getRuntimeVariables', { sessionId: 'smoke-session' }), { variables: [] })
  const slow = await call('prepare', { sessionId: 'smoke-session', request: { ...draft, url: baseUrl + '/slow' } }) as ApiPreparedPreview
  const pending = call('send', { sessionId: 'smoke-session', preparedId: slow.preparedId })
  /** 等到真实服务收到请求后取消，证明取消的是在途 socket 而非尚未派发任务。 */
  const startedAt = Date.now()
  while (calls < 7 && Date.now() - startedAt < 5_000) await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(calls, 7)
  await new Promise((resolve) => setTimeout(resolve, 25))
  await call('cancel', { sessionId: 'smoke-session', preparedId: slow.preparedId })
  const cancelled = await pending as ApiRun
  assert.equal(cancelled.state, 'cancelled')
  assert.ok(cancelled.body.preview.includes('partial'))
  /** 具名用例：同一接口两条用例一通过一失败，另验证不带用例时仍按请求自身断言。 */
  const caseCatalog = await call('getCatalog', { sessionId: 'smoke-session' }) as ApiCatalog
  /** 用例断言与请求自身断言故意不同，用于证明「按谁执行」可以区分。 */
  const caseRequest = {
    ...draft,
    name: '合作用例请求',
    url: baseUrl + '/unauthorized',
    assertions: [{ id: 'default_status', kind: 'status' as const, path: '', expected: '200' }],
    cases: [
      { id: 'case_expect_401', name: '未授权返回 401', assertions: [{ id: 'case_a', kind: 'status' as const, path: '', expected: '401' }] },
      { id: 'case_expect_200', name: '越权却期望 200', assertions: [{ id: 'case_b', kind: 'status' as const, path: '', expected: '200' }] },
    ],
  }
  /** 带用例的请求必须先保存进目录，运行时才能按 requestId 复核版本与所有权。 */
  const savedCases = await call('saveCatalog', { sessionId: 'smoke-session', expectedRevision: caseCatalog.revision, catalog: { ...caseCatalog, requests: [...caseCatalog.requests, { ...caseRequest, id: 'saved-cases', revision: 1, updatedAt: Date.now() }] } }) as ApiCatalog
  /** 保存后的真实定义，逐条用例都按它执行。 */
  const savedCaseDefinition = apiDraftFromDefinition(savedCases.requests.find((item) => item.id === 'saved-cases')!)
  /** 每个用例一次真实运行，结论必须来自该用例自己的断言。 */
  const caseRuns: ApiRun[] = []
  for (const testCase of caseRequest.cases) {
    const preview = await call('prepare', { sessionId: 'smoke-session', requestId: 'saved-cases', request: savedCaseDefinition, caseId: testCase.id }) as ApiPreparedPreview
    const caseRun = await call('send', { sessionId: 'smoke-session', preparedId: preview.preparedId }) as ApiRun
    assert.equal(caseRun.caseId, testCase.id)
    assert.equal(caseRun.hops[0]?.status, 401)
    caseRuns.push(caseRun)
  }
  assert.deepEqual(caseRuns.map((item) => item.assertions.map((assertion) => assertion.passed)), [[true], [false]])
  /** 用例不存在时必须在派发前拒绝，不能悄悄退回默认断言。 */
  await assert.rejects(call('prepare', { sessionId: 'smoke-session', requestId: 'saved-cases', request: savedCaseDefinition, caseId: 'case_missing' }), /API_WORKBENCH_CASE_NOT_FOUND/)
  /** 不带用例时按请求自身断言执行，运行记录不携带用例身份。 */
  const plainPreview = await call('prepare', { sessionId: 'smoke-session', requestId: 'saved-cases', request: savedCaseDefinition }) as ApiPreparedPreview
  const plainRun = await call('send', { sessionId: 'smoke-session', preparedId: plainPreview.preparedId }) as ApiRun
  assert.equal(plainRun.caseId, undefined)
  assert.deepEqual(plainRun.assertions.map((assertion) => assertion.passed), [false])
  /** 报告文本与界面同源：通过率、失败原因与断言计数都要出现，且不含秘密明文。 */
  const reportRows = caseRequest.cases.map((testCase, index) => createApiCaseReportRow(testCase, caseRuns[index]!))
  const report = formatApiCaseReportMarkdown(reportRows, { requestName: caseRequest.name, method: caseRequest.method, url: caseRequest.url, startedAt: Date.now() })
  assert.ok(report.includes('- 结果：1/2 通过'), report)
  assert.ok(report.includes('| 未授权返回 401 | 通过 | 401 | 1/1 |'), report)
  assert.ok(report.includes('| 越权却期望 200 | 失败 | 401 | 0/1 |'), report)
  assert.ok(report.includes('期望 200，实际 401'), report)
  assert.equal(report.includes('fixture-secret'), false)
  /** 报告行与真实运行一一对应，界面据此逐条打开 runId。 */
  assert.deepEqual(reportRows.map((row) => row.runId), caseRuns.map((run) => run.id))
  const history = await call('listRuns', { sessionId: 'smoke-session' })
  assert.equal(history.runs.length, 10)
  assert.equal(calls, 10)
  console.log('[API smoke] PASS', JSON.stringify({ electron: process.versions.electron, node: process.versions.node, encrypted: safeStorage.isEncryptionAvailable(), networkCalls: calls, streamBatches: streamBatches.length, checks: ['preload IPC', 'save reopen', '401 gzip raw headers', 'bigint preservation', 'secret redaction', 'agent approval', 'deduplicated send', 'cancel partial', 'sse frames', 'sse live broadcast', 'sse partial keep', 'extract reuse in memory', 'case runs and report', 'history'] }))
}
/** 清理该验收拥有的进程、窗口和端口，最后删除合成记录。 */
async function finish(code: number): Promise<void> {
  clearTimeout(watchdog)
  await Promise.all([service?.shutdown(), runtime.shutdown()])
  window?.destroy()
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  rmSync(directory, { recursive: true, force: true })
  app.exit(code)
}
void app.whenReady().then(smoke).then(() => finish(0), (error: unknown) => { console.error('[API smoke] FAIL', error); return finish(1) })
