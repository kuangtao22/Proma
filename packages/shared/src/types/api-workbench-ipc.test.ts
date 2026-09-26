import { expect, test } from 'bun:test'
import { createApiRequestDraft } from './api-workbench'
import { API_LIMITS } from './api-workbench'
import { parseApiCommand, parseApiResponse, parseApiRunStreamChanged } from './api-workbench-ipc'

test('Given prepare 命令 When 解析 Then 保留会话与请求', () => {
  const command = parseApiCommand({ method: 'prepare', input: { sessionId: 'session-1', request: createApiRequestDraft() } })
  expect(command.method).toBe('prepare')
})
test('Given 未知IPC方法或伪造workspace When 解析 Then 拒绝', () => {
  expect(() => parseApiCommand({ method: 'revealSecrets', input: {} })).toThrow()
  expect(() => parseApiCommand({ method: 'getCatalog', input: { sessionId: 'a', workspaceId: 'b' } })).toThrow()
})
test('Given 模型传入任意正文文件路径 When 解析 Then 拒绝', () => {
  expect(() => parseApiCommand({ method: 'readBody', input: { sessionId: 'a', runId: 'b', path: '/private/a' } })).toThrow()
})
test('Given 正文读取越过返回预算 When 解析 Then 拒绝', () => {
  expect(() => parseApiCommand({ method: 'readBody', input: { sessionId: 'a', runId: 'b', limit: 1e9 } })).toThrow()
})
test('Given 损坏主进程响应 When preload解析 Then 拒绝而非渲染未知对象', () => {
  expect(() => parseApiResponse('getRun', { id: 'a' })).toThrow()
  expect(() => parseApiResponse('readBody', { text: 'ok', offset: -1, nextOffset: null, totalChars: 1, truncated: false })).toThrow()
})
test('Given 有界正文结果 When 解析 Then 保留分页游标', () => {
  expect(parseApiResponse('readBody', { text: 'ok', offset: 0, nextOffset: 2, totalChars: 4, truncated: true })).toEqual({ text: 'ok', offset: 0, nextOffset: 2, totalChars: 4, truncated: true })
})

test('Given 合法正文包含 NUL When 跨 IPC 读取 Then 不把正文误判为损坏协议', () => {
  expect(parseApiResponse('readBody', { text: 'a\0b', offset: 0, nextOffset: null, totalChars: 3, truncated: false }).text).toBe('a\0b')
})

/** 公共配置四命令的合法输入工厂；用例只改动被验证的那一个字段。 */
function cryptoProfileInput(overrides: Record<string, unknown> = {}) {
  return {
    id: 'profile_backend', name: '后台签名', description: '', scope: 'workspace', appliesTo: 'all', revision: 0, updatedAt: 0,
    requestSteps: [{ id: 's1', kind: 'sign', enabled: true, algo: 'HMAC-SHA256', keyRef: 'appSecret', encoding: 'hex', target: { in: 'header', name: 'X-Sign' }, template: '{{method}}' }],
    responseSteps: [],
    ...overrides,
  }
}

test('Given 保存方案命令 When 解析 Then 校验算法白名单并拒绝伪造 workspace', () => {
  const command = parseApiCommand({ method: 'saveCryptoProfile', input: { sessionId: 'session-1', profile: cryptoProfileInput(), expectedRevision: null } })
  expect(command.method).toBe('saveCryptoProfile')
  /** 方案是配置入口：非法算法与缺密钥引用必须在进主进程之前就被拒绝。 */
  expect(() => parseApiCommand({ method: 'saveCryptoProfile', input: { sessionId: 'a', profile: cryptoProfileInput({ requestSteps: [{ id: 's1', kind: 'sign', enabled: true, algo: 'MD5-ROT13', keyRef: 'k', template: 'x', target: { in: 'header', name: 'X' } }] }), expectedRevision: null } })).toThrow()
  expect(() => parseApiCommand({ method: 'saveCryptoProfile', input: { sessionId: 'a', profile: cryptoProfileInput({ requestSteps: [{ id: 's1', kind: 'sign', enabled: true, algo: 'MD5', template: 'x', target: { in: 'header', name: 'X' } }] }), expectedRevision: null } })).toThrow()
  expect(() => parseApiCommand({ method: 'saveCryptoProfile', input: { sessionId: 'a', workspaceId: 'b', profile: cryptoProfileInput(), expectedRevision: null } })).toThrow()
})

test('Given 工作区变量批写 When 解析 Then 只接受有界字段并拒绝伪造 workspace', () => {
  const command = parseApiCommand({ method: 'saveWorkspaceVariables', input: { sessionId: 'session-1', variables: [{ id: 'v1', name: 'appSecret', value: 'x', enabled: true, secret: true }] } })
  expect(command.method).toBe('saveWorkspaceVariables')
  expect(() => parseApiCommand({ method: 'saveWorkspaceVariables', input: { sessionId: 'a', variables: [{ id: 'v1', name: 'a', value: 'x', enabled: true, path: '/etc/passwd' }] } })).toThrow()
  expect(() => parseApiCommand({ method: 'saveWorkspaceVariables', input: { sessionId: 'a', variables: Array.from({ length: API_LIMITS.maxFields + 1 }, (_, index) => ({ id: `v${index}`, name: 'a', value: '', enabled: true })) } })).toThrow()
  expect(() => parseApiCommand({ method: 'saveWorkspaceVariables', input: { sessionId: 'a', workspaceId: 'b', variables: [] } })).toThrow()
})

test('Given 方案删除与引用检查命令 When 解析 Then 保留身份并校验枚举', () => {
  expect(parseApiCommand({ method: 'deleteCryptoProfile', input: { sessionId: 'a', id: 'profile_backend', force: true } })).toMatchObject({ method: 'deleteCryptoProfile' })
  expect(() => parseApiCommand({ method: 'deleteCryptoProfile', input: { sessionId: 'a', id: 'profile_backend', force: 'yes' } })).toThrow()
  expect(parseApiCommand({ method: 'getCryptoReferences', input: { sessionId: 'a', kind: 'variable', name: 'aesIv' } })).toMatchObject({ method: 'getCryptoReferences' })
  expect(() => parseApiCommand({ method: 'getCryptoReferences', input: { sessionId: 'a', kind: 'secret', name: 'aesIv' } })).toThrow()
})

test('Given 公共配置回执 When 解析 Then 只接受合同字段并拒绝畸形数值', () => {
  expect(parseApiResponse('saveCryptoProfile', cryptoProfileInput()).id).toBe('profile_backend')
  expect(() => parseApiResponse('saveCryptoProfile', { ...cryptoProfileInput(), secretValue: 'x' })).toThrow()
  expect(parseApiResponse('deleteCryptoProfile', { removed: false, referencedBy: 2 })).toEqual({ removed: false, referencedBy: 2 })
  expect(() => parseApiResponse('deleteCryptoProfile', { removed: false, referencedBy: -1 })).toThrow()
  /** 变量回执只回引用与名称：出现取值以外的未知字段一律判损坏协议。 */
  expect(parseApiResponse('saveWorkspaceVariables', { variables: [{ id: 'v1', name: 'appSecret', value: '', enabled: true, secret: true, secretRef: 'ref_1' }] }))
    .toEqual({ variables: [{ id: 'v1', name: 'appSecret', value: '', enabled: true, secret: true, secretRef: 'ref_1' }] })
  expect(() => parseApiResponse('saveWorkspaceVariables', { variables: [{ id: 'v1', name: 'a', value: '', enabled: true, plaintext: 'x' }] })).toThrow()
  expect(parseApiResponse('getCryptoReferences', { profiles: ['后台签名'], requests: 3, collections: ['后台接口'] })).toEqual({ profiles: ['后台签名'], requests: 3, collections: ['后台接口'] })
  expect(() => parseApiResponse('getCryptoReferences', { profiles: [1], requests: 3, collections: [] })).toThrow()
})

test('Given 明文揭示命令 When 解析 Then 非工作区必须带 scopeId，回执只允许名字与值', () => {
  expect(parseApiCommand({ method: 'revealVariable', input: { sessionId: 'a', scope: 'workspace', fieldId: 'v1' } })).toMatchObject({ method: 'revealVariable' })
  expect(parseApiCommand({ method: 'revealVariable', input: { sessionId: 'a', scope: 'collection', scopeId: 'backend', fieldId: 'v1' } })).toMatchObject({ method: 'revealVariable' })
  /** 集合/环境层级缺 scopeId 直接拒绝：否则会落到别的作用域去取值。 */
  expect(() => parseApiCommand({ method: 'revealVariable', input: { sessionId: 'a', scope: 'collection', fieldId: 'v1' } })).toThrow()
  expect(() => parseApiCommand({ method: 'revealVariable', input: { sessionId: 'a', scope: 'secret', fieldId: 'v1' } })).toThrow()
  expect(parseApiResponse('revealVariable', { name: 'appSecret', value: 'cb-app-2026' })).toEqual({ name: 'appSecret', value: 'cb-app-2026' })
  expect(() => parseApiResponse('revealVariable', { name: 'appSecret', value: 'x', secretRef: 'r1' })).toThrow()
})

/** 构造含事件流的最小运行记录，避免每个用例重复展开字段。 */
function runWithSse(sse: unknown): Record<string, unknown> {
  return {
    id: 'run_1', workspaceId: 'workspace', sessionId: 'session', source: 'manual', requestName: '流式',
    catalogRevision: 0, createdAt: 1, finishedAt: 2, state: 'completed',
    request: {
      method: 'GET', url: 'https://example.test/stream', headers: [], body: '', timeoutMs: 1000,
      followRedirects: false, maxRedirects: 0, sensitiveHeaderNames: [], sensitiveQueryNames: [],
    },
    hops: [],
    body: {
      rawBytes: 0, decodedBytes: 0, contentType: 'text/event-stream', encoding: '', preview: '',
      previewTruncated: false, complete: true, decoded: false,
    },
    assertions: [], recording: 'saved', pinned: false, sse,
  }
}

/** 构造单个事件流条目。 */
function sseEvent(index: number, data = 'x'): Record<string, unknown> {
  return { index, receivedMs: index * 10, event: 'message', id: String(index), comment: '', data, raw: `data: ${data}\n`, truncated: false }
}

test('Given 运行含事件流 When 解析 Then 保留序号、到达时间与结束原因', () => {
  const parsed = parseApiResponse('getRun', runWithSse({
    events: [sseEvent(0, '甲'), { ...sseEvent(1, ''), comment: 'keep-alive' }],
    totalEvents: 2, firstEventMs: 5, droppedEvents: 0, endedReason: 'completed',
  }))

  expect(parsed.sse?.events.map((event) => event.data)).toEqual(['甲', ''])
  expect(parsed.sse?.events[1]?.comment).toBe('keep-alive')
  expect(parsed.sse?.firstEventMs).toBe(5)
  expect(parsed.sse?.endedReason).toBe('completed')
})

test('Given 事件明细超过条数上限 When 解析 Then 拒绝畸形记录', () => {
  const events = Array.from({ length: API_LIMITS.sseEvents + 1 }, (_, index) => sseEvent(index))

  expect(() => parseApiResponse('getRun', runWithSse({ events, totalEvents: events.length, firstEventMs: 0, droppedEvents: 0, endedReason: 'completed' }))).toThrow()
})

test('Given 单条事件超过字符上限或含未知字段 When 解析 Then 拒绝', () => {
  const oversized = sseEvent(0, 'x'.repeat(API_LIMITS.sseEventChars + 1))

  expect(() => parseApiResponse('getRun', runWithSse({ events: [oversized], totalEvents: 1, firstEventMs: 0, droppedEvents: 0, endedReason: 'completed' }))).toThrow()
  expect(() => parseApiResponse('getRun', runWithSse({
    events: [{ ...sseEvent(0), extra: true }], totalEvents: 1, firstEventMs: 0, droppedEvents: 0, endedReason: 'completed',
  }))).toThrow()
})

test('Given 流式事件通知 When 解析 Then 校验会话、运行与事件边界', () => {
  const parsed = parseApiRunStreamChanged({ sessionId: 'session', runId: 'run_1', events: [sseEvent(3, '第二帧')] })

  expect(parsed.events[0]?.data).toBe('第二帧')
  expect(() => parseApiRunStreamChanged({ sessionId: 'session', events: [] })).toThrow()
  expect(() => parseApiRunStreamChanged({ sessionId: 'session', runId: 'run_1', events: [{ index: 0 }] })).toThrow()
})

test('Given 运行时变量命令 When 解析 Then 只接受会话身份且拒绝伪造 workspace', () => {
  expect(parseApiCommand({ method: 'getRuntimeVariables', input: { sessionId: 'session-1' } })).toEqual({ method: 'getRuntimeVariables', input: { sessionId: 'session-1' } })
  expect(parseApiCommand({ method: 'clearRuntimeVariables', input: { sessionId: 'session-1' } }).method).toBe('clearRuntimeVariables')
  expect(() => parseApiCommand({ method: 'getRuntimeVariables', input: { sessionId: 'session-1', workspaceId: 'other' } })).toThrow()
})

test('Given 运行时变量回执 When 解析 Then 只接受元数据并拒绝取值字段', () => {
  const accepted = parseApiResponse('getRuntimeVariables', { variables: [{ name: 'access_token', secret: true, source: '请求「登录」', updatedAt: 5 }] })
  const cleared = parseApiResponse('clearRuntimeVariables', { cleared: 2 })

  expect(accepted.variables[0]?.name).toBe('access_token')
  expect(cleared.cleared).toBe(2)
  expect(() => parseApiResponse('getRuntimeVariables', { variables: [{ name: 'token', secret: true, source: 'x', updatedAt: 1, value: 'leak' }] })).toThrow()
  expect(() => parseApiResponse('getRuntimeVariables', { variables: [{ name: '1bad', secret: true, source: 'x', updatedAt: 1 }] })).toThrow()
  expect(() => parseApiResponse('clearRuntimeVariables', { cleared: 99 })).toThrow()
})

test('Given Cookie Jar 命令 When 解析 Then 只接受会话身份且拒绝伪造 workspace', () => {
  expect(parseApiCommand({ method: 'getCookieJar', input: { sessionId: 'session-1' } })).toEqual({ method: 'getCookieJar', input: { sessionId: 'session-1' } })
  expect(parseApiCommand({ method: 'clearCookieJar', input: { sessionId: 'session-1' } }).method).toBe('clearCookieJar')
  expect(() => parseApiCommand({ method: 'getCookieJar', input: { sessionId: 'session-1', workspaceId: 'other' } })).toThrow()
})

test('Given Cookie Jar 回执 When 解析 Then 只接受元数据并拒绝取值与畸形作用域', () => {
  const entry = { name: 'session', domain: '127.0.0.1', path: '/', secure: false, httpOnly: true, expiresAt: null, updatedAt: 5 }
  const accepted = parseApiResponse('getCookieJar', { cookies: [entry] })

  expect(accepted.cookies[0]?.name).toBe('session')
  expect(accepted.cookies[0]?.httpOnly).toBe(true)
  expect(parseApiResponse('clearCookieJar', { cleared: 3 }).cleared).toBe(3)
  /** 取值不在契约里：出现 value 一律判损坏协议。 */
  expect(() => parseApiResponse('getCookieJar', { cookies: [{ ...entry, value: 'leak' }] })).toThrow()
  expect(() => parseApiResponse('getCookieJar', { cookies: [{ ...entry, path: 'no-slash' }] })).toThrow()
  expect(() => parseApiResponse('getCookieJar', { cookies: [{ ...entry, name: 'bad name' }] })).toThrow()
  expect(() => parseApiResponse('getCookieJar', { cookies: [{ ...entry, domain: 'evil domain' }] })).toThrow()
  expect(() => parseApiResponse('getCookieJar', { cookies: Array.from({ length: 129 }, () => entry) })).toThrow()
  expect(() => parseApiResponse('clearCookieJar', { cleared: 999 })).toThrow()
})
