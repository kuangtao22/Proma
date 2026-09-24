import { describe, expect, test } from 'bun:test'
import type { ApiExtraction, ApiSseEvent, ApiTransportResult } from '@proma/shared'
import { evaluateApiExtractions } from './api-extractions'

/** 构造最小传输结果，正文内容按用例覆盖。 */
function result(preview: string, overrides: Partial<ApiTransportResult['body']> = {}): ApiTransportResult {
  return {
    state: 'completed',
    hops: [{
      url: 'https://example.test/login', method: 'POST', requestHeaders: [], requestHeadersSource: 'configured',
      status: 200, statusText: 'OK', httpVersion: '1.1',
      responseHeaders: [{ name: 'Set-Cookie', value: 'sid=one' }, { name: 'set-cookie', value: 'sid=two' }], trailers: [],
      timings: { dnsMs: null, connectMs: null, tlsMs: null, sendMs: null, ttfbMs: null, downloadMs: null, totalMs: 1 },
      connection: { reused: false },
    }],
    body: { rawBytes: preview.length, decodedBytes: preview.length, contentType: 'application/json', encoding: 'utf-8', preview, previewTruncated: false, complete: true, decoded: true, ...overrides },
  }
}

/** 构造单条提取规则。 */
function rule(from: ApiExtraction['from'], path: string, name = 'token', secret = true): ApiExtraction {
  return { id: `ex_${name}`, name, from, path, secret }
}

/** 构造事件流条目。 */
function sseEvent(index: number, data: string): ApiSseEvent {
  return { index, receivedMs: index * 10, event: '', id: '', comment: '', data, raw: `data: ${data}\n`, truncated: false }
}

describe('运行时变量提取', () => {
  test('Given 正文 JSON 路径 When 提取 Then 保留大整数原文并标记命中', () => {
    const evaluated = evaluateApiExtractions(
      [rule('json', 'id', 'userId', false), rule('json', 'token')],
      result('{"token":"abc123","id":900719925474099312345}'),
    )

    expect(evaluated.map((entry) => entry.value)).toEqual(['900719925474099312345', 'abc123'])
    expect(evaluated.every((entry) => entry.outcome.found)).toBe(true)
  })

  test('Given 响应 Header When 提取 Then 忽略大小写并合并重复值', () => {
    const [entry] = evaluateApiExtractions([rule('header', 'Set-Cookie', 'session')], result('{}'))

    expect(entry?.outcome.found).toBe(true)
    expect(entry?.value).toBe('sid=one, sid=two')
  })

  test('Given 事件流最后一段数据 When 提取 Then 支持内部 JSON 路径', () => {
    const events = [sseEvent(0, '{"delta":"甲"}'), sseEvent(1, '{"delta":"终"}'), { ...sseEvent(2, ''), comment: 'ping' }]
    const stream = { events, droppedEvents: 0 }
    const evaluated = evaluateApiExtractions(
      [rule('sse-last-data', 'delta', 'lastDelta', false), rule('sse-last-data', '', 'lastRaw')],
      { ...result(''), body: { ...result('').body, contentType: 'text/event-stream' }, sse: { totalEvents: 3, firstEventMs: 5, endedReason: 'completed' } },
      stream,
    )

    expect(evaluated[0]?.value).toBe('终')
    expect(evaluated[1]?.value).toBe('{"delta":"终"}')
  })

  test('Given 正文被截断 When 提取 JSON Then 未命中并说明原因', () => {
    const [entry] = evaluateApiExtractions([rule('json', 'token')], result('{"token":"abc"', { complete: false, previewTruncated: true }))

    expect(entry?.outcome.found).toBe(false)
    expect(entry?.value).toBeUndefined()
    expect(entry?.outcome.message).toContain('无法验证')
  })

  test('Given 事件超过保留上限 When 提取最后一段数据 Then 未命中且不猜值', () => {
    const stream = { events: [sseEvent(0, '{"delta":"甲"}')], droppedEvents: 4 }
    const [entry] = evaluateApiExtractions(
      [rule('sse-last-data', 'delta')],
      { ...result(''), sse: { totalEvents: 5, firstEventMs: 1, endedReason: 'completed' } },
      stream,
    )

    expect(entry?.outcome.found).toBe(false)
    expect(entry?.outcome.message).toContain('无法验证')
  })

  test('Given 空值或超长值 When 提取 Then 未命中以免写入无效变量', () => {
    const empty = evaluateApiExtractions([rule('json', 'token')], result('{"token":""}'))
    const tooLong = evaluateApiExtractions([rule('json', 'token')], result(JSON.stringify({ token: 'x'.repeat(5000) })))

    expect(empty[0]?.outcome.found).toBe(false)
    expect(tooLong[0]?.outcome.found).toBe(false)
    expect(tooLong[0]?.outcome.message).toContain('字符上限')
  })

  test('Given 路径不存在 When 提取 Then 只影响该条规则', () => {
    const evaluated = evaluateApiExtractions([rule('json', 'missing'), rule('json', 'token')], result('{"token":"abc"}'))

    expect(evaluated.map((entry) => entry.outcome.found)).toEqual([false, true])
    expect(evaluated[1]?.value).toBe('abc')
  })

  test('Given 响应不是事件流 When 用事件流来源 Then 未命中并说明', () => {
    const [entry] = evaluateApiExtractions([rule('sse-last-data', 'delta')], result('{"a":1}'))

    expect(entry?.outcome.found).toBe(false)
    expect(entry?.outcome.message).toContain('事件流')
  })
})
