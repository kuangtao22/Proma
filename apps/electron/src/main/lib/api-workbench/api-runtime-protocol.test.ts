import { describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { parseApiRuntimeRequest, parseApiRuntimeResponse } from './api-runtime-protocol'

/** 构造可通过严格协议解析的最小结果。 */
function runtimeResult(preview = ''): unknown {
  return {
    state: 'completed', hops: [],
    body: { rawBytes: Buffer.byteLength(preview), decodedBytes: Buffer.byteLength(preview), contentType: 'application/octet-stream', encoding: '', preview, previewTruncated: false, complete: true, decoded: false },
  }
}

/** 构造可解析的单条流式事件。 */
function sseEvent(index: number, data = 'x'): Record<string, unknown> {
  return { index, receivedMs: index * 5, event: 'message', id: '', comment: '', data, raw: `data: ${data}\n`, truncated: false }
}

describe('api runtime protocol', () => {
  test('Given 事件增量消息，When 解析，Then 保留事件并拒绝混入结果字段', () => {
    const message = parseApiRuntimeResponse({ type: 'api-workbench.stream', requestId: 'request-1', events: [sseEvent(0, '甲'), sseEvent(1, '乙')] })

    expect(message.type).toBe('api-workbench.stream')
    if (message.type === 'api-workbench.stream') expect(message.events.map((event) => event.data)).toEqual(['甲', '乙'])
    expect(() => parseApiRuntimeResponse({ type: 'api-workbench.stream', requestId: 'request-1', events: [], result: runtimeResult() })).toThrow()
    expect(() => parseApiRuntimeResponse({ type: 'api-workbench.stream', requestId: 'request-1', events: [sseEvent(0), sseEvent(0)] })).not.toThrow()
    expect(() => parseApiRuntimeResponse({ type: 'api-workbench.stream', requestId: 'request-1', events: [{ index: 0 }] })).toThrow()
  })

  test('Given 结果消息携带事件计数，When 解析，Then 保留 endedReason 与首事件耗时', () => {
    const result = { ...(runtimeResult() as Record<string, unknown>), sse: { totalEvents: 3, firstEventMs: 12, endedReason: 'cancelled' } }

    const message = parseApiRuntimeResponse({ type: 'api-workbench.result', requestId: 'request-1', result })

    if (message.type !== 'api-workbench.result') throw new Error('期望结果消息')
    expect(message.result.sse).toEqual({ totalEvents: 3, firstEventMs: 12, endedReason: 'cancelled' })
    expect(() => parseApiRuntimeResponse({ type: 'api-workbench.result', requestId: 'request-1', result: { ...(runtimeResult() as Record<string, unknown>), sse: { totalEvents: 1, firstEventMs: null, endedReason: 'unknown' } } })).toThrow()
    expect(() => parseApiRuntimeResponse({ type: 'api-workbench.result', requestId: 'request-1', result: runtimeResult(), events: [] })).toThrow()
  })

  test('Given 完整 run 消息，When 解析，Then 只保留白名单字段和 32 字节密钥', () => {
    const keyBase64 = randomBytes(32).toString('base64')
    const request = parseApiRuntimeRequest({
      type: 'api-workbench.run', requestId: 'request-1',
      request: { method: 'GET', url: 'http://127.0.0.1/', headers: [], body: '', timeoutMs: 1_000, followRedirects: false, maxRedirects: 0, sensitiveHeaderNames: [], sensitiveQueryNames: [] },
      artifacts: { directory: '/tmp/api-run', keyBase64 },
    })

    expect(request.type).toBe('api-workbench.run')
    if (request.type === 'api-workbench.run') expect(request.artifacts).toEqual({ directory: '/tmp/api-run', keyBase64 })
  })

  test('Given 未知字段、短密钥或错配结果形状，When 解析，Then 明确拒绝', () => {
    expect(() => parseApiRuntimeRequest({ type: 'api-workbench.cancel', requestId: 'request-1', extra: true })).toThrow()
    expect(() => parseApiRuntimeRequest({
      type: 'api-workbench.run', requestId: 'request-1',
      request: { method: 'GET', url: 'http://127.0.0.1/', headers: [], body: '', timeoutMs: 1_000, followRedirects: false, maxRedirects: 0, sensitiveHeaderNames: [], sensitiveQueryNames: [] },
      artifacts: { directory: '/tmp/api-run', keyBase64: Buffer.alloc(31).toString('base64') },
    })).toThrow()
    expect(() => parseApiRuntimeResponse({ type: 'api-workbench.result', requestId: 'request-1', result: { state: 'completed' } })).toThrow()
  })

  test('Given 精确 requestId 的 ack，When 解析，Then 不允许夹带运行字段', () => {
    expect(parseApiRuntimeRequest({ type: 'api-workbench.ack', requestId: 'request-1' })).toEqual({ type: 'api-workbench.ack', requestId: 'request-1' })
    expect(() => parseApiRuntimeRequest({ type: 'api-workbench.ack', requestId: 'request-1', request: {} })).toThrow()
  })

  test('Given 二进制预览含 NUL，When 解析 utility 结果，Then 合法正文不会被协议误拒绝', () => {
    const response = parseApiRuntimeResponse({ type: 'api-workbench.result', requestId: 'request-1', result: runtimeResult('A\0B') })
    if (response.type !== 'api-workbench.result') throw new Error('期望结果消息')
    expect(response.result.body.preview).toBe('A\0B')
    expect(response.result.body.decoded).toBe(false)
  })
})
