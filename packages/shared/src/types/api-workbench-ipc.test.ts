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
