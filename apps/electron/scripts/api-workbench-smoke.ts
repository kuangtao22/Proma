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
/** 会话型接口真实收到的 Cookie 头，用于证明自动 Cookie 确实生效。 */
let receivedCookie = ''
const server = createServer((request, response) => {
  calls += 1
  if (request.url === '/slow') { response.writeHead(200); response.write('partial'); return }
  if (request.url === '/session') {
    /** 第一次下发 cookie；之后靠 cookie 才算已登录，服务端只回显收到的 Cookie。 */
    receivedCookie = String(request.headers.cookie ?? '')
    response.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': ['sid=smoke-cookie-1; Path=/; HttpOnly', 'theme=dark; Path=/'] })
    response.end(JSON.stringify({ ok: true, cookie: receivedCookie }))
    return
  }
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
  assert.ok(report.includes('| 未授权返回 401 | 人工 | 通过 | 401 | 1/1 |'), report)
  assert.ok(report.includes('| 越权却期望 200 | 人工 | 失败 | 401 | 0/1 |'), report)
  assert.ok(report.includes('期望 200，实际 401'), report)
  assert.equal(report.includes('fixture-secret'), false)
  /** 报告行与真实运行一一对应，界面据此逐条打开 runId。 */
  assert.deepEqual(reportRows.map((row) => row.runId), caseRuns.map((run) => run.id))
  /** Agent 出题：只能新增自己的用例，来源由 Host 盖章，人工用例不可被改。 */
  const authoredPrepared = await facade.prepare({ request: {
    name: 'Agent 建的接口',
    url: baseUrl + '/unauthorized',
    method: 'GET',
    cases: [{ id: 'case_agent_ok', name: 'Agent 猜的未授权', assertions: [{ id: 'agent_a', kind: 'status' as const, path: '', expected: '401' }] }],
  } })
  const authoredSaving = { preparedId: authoredPrepared.preparedId, expectedRevision: authoredPrepared.catalogRevision }
  const authoredSnapshot = await facade.approval('api_save_request', authoredSaving)
  assert.deepEqual(authoredSnapshot.save?.caseDiff, [{ caseId: 'case_agent_ok', caseName: 'Agent 猜的未授权', source: 'agent', change: 'added', assertionCount: 1 }])
  await facade.authorize('api_save_request', authoredSaving, authoredSnapshot)
  await facade.save(authoredSaving)
  /** 落库的用例带 Host 盖章的来源，模型自称的来源被忽略。 */
  const authoredSaved = (await call('getCatalog', { sessionId: 'smoke-session' }) as ApiCatalog).requests.find((item) => item.name === 'Agent 建的接口')
  assert.equal(authoredSaved?.cases?.[0]?.source, 'agent')
  /** Agent 也能按人工写好的用例执行，并在发送审批里说明跑的是哪一组断言。 */
  const caseSendPrepared = await facade.prepare({ requestId: 'saved-cases', caseId: 'case_expect_401' })
  const caseSendSnapshot = await facade.approval('api_send_request', { preparedId: caseSendPrepared.preparedId })
  assert.equal(caseSendSnapshot.send?.caseId, 'case_expect_401')
  assert.equal(caseSendSnapshot.send?.caseName, '未授权返回 401')
  assert.equal(caseSendSnapshot.send?.assertionCount, 1)
  /** 人工用例：改断言或删除都在审批之前被拒，目录保持原样。 */
  const humanCatalog = await call('getCatalog', { sessionId: 'smoke-session' }) as ApiCatalog
  const humanDefinition = humanCatalog.requests.find((item) => item.id === 'saved-cases')!
  const humanCase = humanDefinition.cases![0]!
  assert.equal(humanCase.source, 'user')
  const tampered = await facade.prepare({ requestId: 'saved-cases', request: { cases: [{ ...humanCase, name: '被 Agent 改名的用例' }] } })
  const dropped = await facade.prepare({ requestId: 'saved-cases', request: { cases: [] } })
  await assert.rejects(facade.approval('api_save_request', { preparedId: tampered.preparedId, expectedRevision: humanCatalog.revision }), /API_WORKBENCH_USER_CASE_PROTECTED/)
  await assert.rejects(facade.approval('api_save_request', { preparedId: dropped.preparedId, expectedRevision: humanCatalog.revision }), /API_WORKBENCH_USER_CASE_PROTECTED/)
  assert.deepEqual((await call('getCatalog', { sessionId: 'smoke-session' }) as ApiCatalog).requests.find((item) => item.id === 'saved-cases')?.cases, humanDefinition.cases)
  /** 保留人工用例、追加自己的用例则允许，报告里两个来源并列。 */
  const appended = await facade.prepare({ requestId: 'saved-cases', request: { cases: [
    ...humanDefinition.cases!,
    { id: 'case_agent_extra', name: 'Agent 补的缺参数', assertions: [{ id: 'agent_b', kind: 'status' as const, path: '', expected: '400' }] },
  ] } })
  const appendedSaving = { preparedId: appended.preparedId, expectedRevision: humanCatalog.revision }
  const appendedSnapshot = await facade.approval('api_save_request', appendedSaving)
  assert.deepEqual(appendedSnapshot.save?.caseDiff, [{ caseId: 'case_agent_extra', caseName: 'Agent 补的缺参数', source: 'agent', change: 'added', assertionCount: 1 }])
  await facade.authorize('api_save_request', appendedSaving, appendedSnapshot)
  await facade.save(appendedSaving)
  const mixedDefinition = (await call('getCatalog', { sessionId: 'smoke-session' }) as ApiCatalog).requests.find((item) => item.id === 'saved-cases')!
  assert.deepEqual(mixedDefinition.cases?.map((item) => `${item.id}:${item.source}`), ['case_expect_401:user', 'case_expect_200:user', 'case_agent_extra:agent'])
  /** 报告按来源并列：人工用例的真实通过结论与 Agent 用例的未执行分开表达。 */
  const mixedReport = formatApiCaseReportMarkdown([
    createApiCaseReportRow(mixedDefinition.cases![0]!, caseRuns[0]!),
    createApiCaseReportRow(mixedDefinition.cases![2]!, null, '未执行'),
  ], { requestName: mixedDefinition.name, method: mixedDefinition.method, url: mixedDefinition.url, startedAt: Date.now() })
  assert.ok(mixedReport.includes('| 未授权返回 401 | 人工 | 通过 | 401 | 1/1 |'), mixedReport)
  assert.ok(mixedReport.includes('| Agent 补的缺参数 | Agent | 未执行 | — | 0/1 | — | 未执行 |'), mixedReport)
  assert.ok(mixedReport.includes('- 结果：1/1 通过'), mixedReport)
  /** 自动 Cookie：登录下发 cookie，开启自动 Cookie 的后续请求才带上它。 */
  /** JSON 类型断言：类型对了才算通过，比较结果只暴露类型名。 */
  const typedPrepared = await call('prepare', { sessionId: 'smoke-session', request: {
    ...draft,
    url: baseUrl + '/typed',
    assertions: [
      { id: 'json_number', kind: 'json-type' as const, path: 'id', expected: 'number' },
      { id: 'json_string', kind: 'json-type' as const, path: 'id', expected: 'string' },
    ],
  } }) as ApiPreparedPreview
  const typedRun = await call('send', { sessionId: 'smoke-session', preparedId: typedPrepared.preparedId }) as ApiRun
  assert.equal(typedRun.state, 'completed')
  assert.deepEqual(typedRun.assertions.map((item) => `${item.passed}:${item.expected}:${item.actual}`), ['true:number:number', 'false:string:number'])
  /** 原响应里的 id 是 20 位大整数：断言结果只写类型名，不回显取值。 */
  assert.equal(JSON.stringify(typedRun.assertions).includes('90071992547409931234'), false)
  const sessionDraft = { ...draft, url: baseUrl + '/session', useCookieJar: true }
  const sessionFirst = await call('prepare', { sessionId: 'smoke-session', request: sessionDraft }) as ApiPreparedPreview
  await call('send', { sessionId: 'smoke-session', preparedId: sessionFirst.preparedId })
  assert.equal(receivedCookie, '', '首次请求不该带 cookie')
  /** 界面只能拿到元数据，取值永远不出主进程。 */
  const jar = await call('getCookieJar', { sessionId: 'smoke-session' }) as { cookies: Array<{ name: string; domain: string; path: string; httpOnly: boolean }> }
  assert.deepEqual(jar.cookies.map((cookie) => `${cookie.name}@${cookie.domain}${cookie.path}`).sort(), ['sid@127.0.0.1/', 'theme@127.0.0.1/'])
  assert.equal(jar.cookies.find((cookie) => cookie.name === 'sid')?.httpOnly, true)
  assert.equal(JSON.stringify(jar).includes('smoke-cookie-1'), false, 'Cookie 元数据不该回传取值')
  /** 同 host 的第二次请求带上 cookie，服务端确实收到。 */
  const sessionSecond = await call('prepare', { sessionId: 'smoke-session', request: sessionDraft }) as ApiPreparedPreview
  const sessionRun = await call('send', { sessionId: 'smoke-session', preparedId: sessionSecond.preparedId }) as ApiRun
  assert.equal(receivedCookie, 'sid=smoke-cookie-1; theme=dark', '服务端没有收到自动 Cookie')
  /** 注入的 Cookie 头在记录里按敏感头遮罩。 */
  assert.equal(sessionRun.request.headers.find((header) => header.name === 'Cookie')?.value, '[REDACTED]')
  assert.equal(sessionRun.request.sensitiveHeaderNames.includes('cookie'), true)
  /** 关闭自动 Cookie 的请求既不读也不写：服务端收不到 cookie。 */
  const sessionPlain = await call('prepare', { sessionId: 'smoke-session', request: { ...draft, url: baseUrl + '/session' } }) as ApiPreparedPreview
  await call('send', { sessionId: 'smoke-session', preparedId: sessionPlain.preparedId })
  assert.equal(receivedCookie, '', '关闭自动 Cookie 的请求不该带 cookie')
  /** 清空后再次开启自动 Cookie 也拿不到任何 cookie。 */
  assert.deepEqual(await call('clearCookieJar', { sessionId: 'smoke-session' }), { cleared: 2 })
  const sessionAfterClear = await call('prepare', { sessionId: 'smoke-session', request: sessionDraft }) as ApiPreparedPreview
  await call('send', { sessionId: 'smoke-session', preparedId: sessionAfterClear.preparedId })
  assert.equal(receivedCookie, '', '清空后不该再带 cookie')
  /** 清空丢掉的是已有 cookie；这次请求又拿到了服务端新下发的那两条。 */
  const jarAfterClear = await call('getCookieJar', { sessionId: 'smoke-session' }) as { cookies: Array<{ name: string }> }
  assert.deepEqual(jarAfterClear.cookies.map((cookie) => cookie.name).sort(), ['sid', 'theme'])
  const history = await call('listRuns', { sessionId: 'smoke-session' })
  assert.equal(history.runs.length, 15)
  assert.equal(calls, 15)
  console.log('[API smoke] PASS', JSON.stringify({ electron: process.versions.electron, node: process.versions.node, encrypted: safeStorage.isEncryptionAvailable(), networkCalls: calls, streamBatches: streamBatches.length, checks: ['preload IPC', 'save reopen', '401 gzip raw headers', 'bigint preservation', 'secret redaction', 'agent approval', 'deduplicated send', 'cancel partial', 'sse frames', 'sse live broadcast', 'sse partial keep', 'extract reuse in memory', 'case runs and report', 'agent authored cases', 'human case protection', 'cookie jar send/clear', 'json type assertions', 'history'] }))
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
