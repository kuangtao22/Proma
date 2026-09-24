import { describe, expect, test } from 'bun:test'
import type { ApiAssertion, ApiTransportResult } from '@proma/shared'
import type { ApiSseEvent } from '@proma/shared'
import { evaluateApiAssertions } from './api-assertions'
import { redactApiBody, redactApiRequest } from './api-redaction'

const result: ApiTransportResult = {
  state: 'completed',
  hops: [{
    url: 'https://example.test', method: 'GET', requestHeaders: [], requestHeadersSource: 'captured',
    status: 201, statusText: 'Created', httpVersion: '1.1',
    responseHeaders: [{ name: 'X-Trace', value: 'abc' }], trailers: [],
    timings: { dnsMs: null, connectMs: null, tlsMs: null, sendMs: null, ttfbMs: 5, downloadMs: 2, totalMs: 7 },
    connection: { reused: false },
  }],
  body: { rawBytes: 48, decodedBytes: 48, contentType: 'application/json', encoding: 'utf-8', preview: '{"id":900719925474099312345,"token":"returned"}', previewTruncated: false, complete: true, decoded: true },
}

describe('接口断言与脱敏', () => {
  /** 构造可复用的事件流条目。 */
  function sseEvent(index: number, data: string): ApiSseEvent {
    return { index, receivedMs: index * 10, event: 'message', id: '', comment: '', data, raw: `data: ${data}\n`, truncated: false }
  }

  /** 带事件流计数事实的结果。 */
  const streaming: ApiTransportResult = { ...result, body: { ...result.body, contentType: 'text/event-stream' }, sse: { totalEvents: 3, firstEventMs: 120, endedReason: 'completed' } }

  test('Given 事件数量、首事件耗时与结束方式断言 When 满足 Then 逐条通过', () => {
    const evaluated = evaluateApiAssertions([
      { id: 'count', kind: 'sse-count', path: '', expected: '>=3' },
      { id: 'first', kind: 'sse-first-event', path: '', expected: '<=500' },
      { id: 'ended', kind: 'sse-ended', path: '', expected: 'completed' },
    ], streaming, { events: [sseEvent(0, 'a')], droppedEvents: 0 })

    expect(evaluated.every((entry) => entry.passed)).toBe(true)
  })

  test('Given 实际事件数量不足 When 评估 Then 失败并给出实际数量', () => {
    const [entry] = evaluateApiAssertions([{ id: 'count', kind: 'sse-count', path: '', expected: '5' }], streaming, { events: [], droppedEvents: 0 })

    expect(entry).toMatchObject({ passed: false, actual: '3' })
    expect(entry?.message).toContain('断言失败')
  })

  test('Given 流被取消 When 断言正常结束 Then 失败并显示真实结束原因', () => {
    const cancelled: ApiTransportResult = { ...streaming, state: 'cancelled', sse: { totalEvents: 2, firstEventMs: 30, endedReason: 'cancelled' } }

    const [entry] = evaluateApiAssertions([{ id: 'ended', kind: 'sse-ended', path: '', expected: 'completed' }], cancelled, { events: [], droppedEvents: 0 })

    expect(entry).toMatchObject({ passed: false, actual: 'cancelled' })
  })

  test('Given 最后一段数据断言 When 末尾是心跳 Then 取最后一个有数据的事件', () => {
    const events = [sseEvent(0, '{"delta":"甲"}'), sseEvent(1, '[DONE]'), { ...sseEvent(2, ''), comment: 'ping' }]
    const contains = evaluateApiAssertions([{ id: 'last', kind: 'sse-last-data', path: '', expected: '[DONE]' }], streaming, { events, droppedEvents: 0 })
    const exact = evaluateApiAssertions([{ id: 'last', kind: 'sse-last-data', path: '', expected: '=[DONE]' }], streaming, { events, droppedEvents: 0 })
    const mismatch = evaluateApiAssertions([{ id: 'last', kind: 'sse-last-data', path: '', expected: '=其它' }], streaming, { events, droppedEvents: 0 })

    expect(contains[0]).toMatchObject({ passed: true, actual: '[DONE]' })
    expect(exact[0]?.passed).toBe(true)
    expect(mismatch[0]).toMatchObject({ passed: false, actual: '[DONE]' })
  })

  test('Given 事件超过保留上限 When 断言最后一段数据 Then 无法验证而不是误判', () => {
    const dropped: ApiTransportResult = { ...streaming, sse: { totalEvents: 100, firstEventMs: 5, endedReason: 'completed' } }

    const [entry] = evaluateApiAssertions([{ id: 'last', kind: 'sse-last-data', path: '', expected: '[DONE]' }], dropped, { events: [], droppedEvents: 5 })

    expect(entry).toMatchObject({ passed: false })
    expect(entry?.message).toContain('无法验证')
  })

  test('Given 响应不是事件流 When 事件断言 Then 明确失败而不是静默通过', () => {
    const evaluated = evaluateApiAssertions([
      { id: 'count', kind: 'sse-count', path: '', expected: '>=1' },
      { id: 'ended', kind: 'sse-ended', path: '', expected: 'completed' },
    ], result, { events: [], droppedEvents: 0 })

    expect(evaluated.every((entry) => !entry.passed)).toBe(true)
    expect(evaluated[0]?.message).toContain('事件流')
  })

  test('Given 状态/Header/JSON/耗时断言 When 执行 Then 返回独立结果并保留大整数原文', () => {
    const assertions: ApiAssertion[] = [
      { id: 'status', kind: 'status', path: '', expected: '201' },
      { id: 'header', kind: 'header', path: 'x-trace', expected: 'abc' },
      { id: 'json', kind: 'json-value', path: 'id', expected: '900719925474099312345' },
      { id: 'exists', kind: 'json-exists', path: 'token', expected: 'true' },
      { id: 'duration', kind: 'duration', path: '', expected: '<=10' },
    ]
    expect(evaluateApiAssertions(assertions, result).every((entry) => entry.passed)).toBe(true)
  })

  test('Given 已知秘密和常见敏感字段 When 公开 Then 请求与响应均不泄漏', () => {
    const request = redactApiRequest({
      method: 'GET', url: 'https://example.test?a=secret',
      headers: [{ name: 'Authorization', value: 'Bearer secret' }], body: '', timeoutMs: 1_000,
      followRedirects: false, maxRedirects: 0,
      sensitiveHeaderNames: ['authorization'], sensitiveQueryNames: ['a'],
    }, ['secret'])
    expect(request.url).toBe('https://example.test/?a=%5BREDACTED%5D')
    expect(request.headers[0]?.value).toBe('[REDACTED]')
    expect(redactApiBody('{"token":"returned","message":"secret"}', ['secret']))
      .toBe('{"token":"[REDACTED]","message":"[REDACTED]"}')
  })

  test('Given 正文预览不完整 When json-exists expected=false Then 不得误报通过', () => {
    const incomplete: ApiTransportResult = {
      ...result,
      body: { ...result.body, previewTruncated: true, complete: false },
    }
    const [assertion] = evaluateApiAssertions([
      { id: 'missing', kind: 'json-exists', path: 'missing', expected: 'false' },
    ], incomplete)
    expect(assertion).toMatchObject({ passed: false, message: '正文不完整或超出预览范围，无法验证断言' })
  })

  test('Given JSON 路径指向原型属性或普通 marker 前缀字符串 When 断言 Then 不访问原型且不误认数字', () => {
    const body: ApiTransportResult = {
      ...result,
      body: { ...result.body, preview: '{"value":"__PROMA_JSON_NUMBER__:123"}' },
    }
    const assertions: ApiAssertion[] = [
      { id: 'prototype', kind: 'json-exists', path: '__proto__', expected: 'true' },
      { id: 'string', kind: 'json-value', path: 'value', expected: '__PROMA_JSON_NUMBER__:123' },
    ]
    const evaluated = evaluateApiAssertions(assertions, body)
    expect(evaluated[0]?.passed).toBe(false)
    expect(evaluated[1]?.passed).toBe(true)
  })

  test('Given JSON 类型断言 When 六种类型 Then 各自判对且大整数仍是 number', () => {
    const types: ApiTransportResult = {
      ...result,
      body: { ...result.body, preview: '{"s":"a","n":900719925474099312345,"b":true,"o":{},"arr":[1],"nil":null,"f":1.5}' },
    }
    const evaluated = evaluateApiAssertions([
      { id: 's', kind: 'json-type', path: 's', expected: 'string' },
      { id: 'n', kind: 'json-type', path: 'n', expected: 'number' },
      { id: 'b', kind: 'json-type', path: 'b', expected: 'boolean' },
      { id: 'o', kind: 'json-type', path: 'o', expected: 'object' },
      { id: 'arr', kind: 'json-type', path: 'arr', expected: 'array' },
      { id: 'nil', kind: 'json-type', path: 'nil', expected: 'null' },
      /** 大小写与空格要容错，浮点同样是 number。 */
      { id: 'f', kind: 'json-type', path: 'f', expected: ' Number ' },
    ], types)

    expect(evaluated.map((entry) => `${entry.id}:${entry.passed}:${entry.actual}`)).toEqual([
      's:true:string', 'n:true:number', 'b:true:boolean', 'o:true:object', 'arr:true:array', 'nil:true:null', 'f:true:number',
    ])
  })

  test('Given 类型不符、路径不存在或期望类型非法 When 评估 Then 逐条失败且原因可读', () => {
    const mismatch = evaluateApiAssertions([{ id: 'm', kind: 'json-type', path: 'token', expected: 'number' }], result)
    const missing = evaluateApiAssertions([{ id: 'x', kind: 'json-type', path: 'data.id', expected: 'string' }], result)
    const invalid = evaluateApiAssertions([{ id: 'i', kind: 'json-type', path: 'token', expected: '整数' }], result)

    /** 实际值只暴露类型名，不回显正文取值。 */
    expect(mismatch[0]).toMatchObject({ passed: false, actual: 'string', expected: 'number' })
    expect(mismatch[0]?.message).toBe('断言失败')
    expect(missing[0]).toMatchObject({ passed: false, actual: '' })
    expect(missing[0]?.message).toContain('找不到该路径')
    expect(invalid[0]?.passed).toBe(false)
    expect(invalid[0]?.message).toContain('期望类型无效')
  })

  test('Given 正文被截断 When 判定 JSON 类型 Then 判无法验证而不是通过', () => {
    const truncated: ApiTransportResult = { ...result, body: { ...result.body, previewTruncated: true } }

    const [entry] = evaluateApiAssertions([{ id: 't', kind: 'json-type', path: 'token', expected: 'string' }], truncated)

    expect(entry?.passed).toBe(false)
    expect(entry?.message).toContain('无法验证断言')
  })
})
