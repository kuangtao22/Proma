import { isAbsolute } from 'node:path'
import {
  API_LIMITS,
  apiInteger,
  apiRecord,
  parseApiId,
  parseApiResolvedRequest,
} from '@proma/shared'
import type {
  ApiBodyInfo,
  ApiConnectionInfo,
  ApiFailure,
  ApiHeader,
  ApiHttpHop,
  ApiResolvedRequest,
  ApiSseEvent,
  ApiSseSummary,
  ApiTimings,
  ApiTransportResult,
} from '@proma/shared'

/** Host 为一次运行分配的受管产物目录和内存密钥。 */
export interface ApiRuntimeArtifacts {
  directory: string
  keyBase64: string
}

/** utility 每个进程只接受一条 run，cancel 必须精确匹配 requestId。 */
export type ApiRuntimeRequest =
  | { type: 'api-workbench.run'; requestId: string; request: ApiResolvedRequest; artifacts?: ApiRuntimeArtifacts }
  | { type: 'api-workbench.cancel'; requestId: string }
  | { type: 'api-workbench.ack'; requestId: string }

/** utility 只返回 Shared 定义的传输事实与事件增量，不返回目录或密钥。 */
export type ApiRuntimeMessage =
  | { type: 'api-workbench.result'; requestId: string; result: ApiTransportResult }
  | { type: 'api-workbench.stream'; requestId: string; events: ApiSseEvent[] }

/** 抛出不携带原输入值的协议错误。 */
function invalid(path: string): never { throw new Error(`API_RUNTIME_PROTOCOL_INVALID: ${path}`) }
/** 解析有界字符串。 */
function text(value: unknown, path: string, max = 4096, allowNul = false): string {
  if (typeof value !== 'string' || value.length > max || (!allowNul && value.includes('\0'))) return invalid(path)
  return value
}
/** 解析严格布尔值。 */
function flag(value: unknown, path: string): boolean { if (typeof value !== 'boolean') return invalid(path); return value }
/** 解析有限非负耗时。 */
function duration(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 86_400_000) return invalid(path)
  return value
}
/** 解析可空耗时。 */
function nullableDuration(value: unknown, path: string): number | null { return value === null ? null : duration(value, path) }
/** 解析有界数组。 */
function list<T>(value: unknown, path: string, max: number, parser: (entry: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > max) return invalid(path)
  return value.map(parser)
}
/** 解析固定枚举。 */
function choice<T extends string>(value: unknown, path: string, values: readonly T[]): T {
  if (typeof value !== 'string' || !values.includes(value as T)) return invalid(path)
  return value as T
}

/** 解析运行时内部 Header，允许重复但不允许额外字段。 */
function header(value: unknown): ApiHeader {
  const record = apiRecord(value, ['name', 'value', 'source'], 'runtime.header')
  const source = record.source === undefined ? undefined : choice(record.source, 'runtime.header.source', ['user', 'generated'] as const)
  return {
    name: text(record.name, 'runtime.header.name', 256), value: text(record.value, 'runtime.header.value', 65536),
    ...(source === undefined ? {} : { source }),
  }
}

/** 解析 socket/TLS 可观测事实。 */
function connection(value: unknown): ApiConnectionInfo {
  const record = apiRecord(value, ['reused', 'remoteAddress', 'remotePort', 'localAddress', 'localPort', 'tls'], 'runtime.connection')
  const result: ApiConnectionInfo = { reused: flag(record.reused, 'runtime.connection.reused') }
  if (record.remoteAddress !== undefined) result.remoteAddress = text(record.remoteAddress, 'runtime.connection.remoteAddress', 256)
  if (record.remotePort !== undefined) result.remotePort = apiInteger(record.remotePort, 0, 65535, 'runtime.connection.remotePort')
  if (record.localAddress !== undefined) result.localAddress = text(record.localAddress, 'runtime.connection.localAddress', 256)
  if (record.localPort !== undefined) result.localPort = apiInteger(record.localPort, 0, 65535, 'runtime.connection.localPort')
  if (record.tls !== undefined) {
    const tls = apiRecord(record.tls, ['protocol', 'cipher', 'authorized', 'authorizationError', 'subject', 'issuer', 'validFrom', 'validTo'], 'runtime.connection.tls')
    result.tls = {
      protocol: text(tls.protocol, 'runtime.tls.protocol', 128), cipher: text(tls.cipher, 'runtime.tls.cipher', 256),
      authorized: flag(tls.authorized, 'runtime.tls.authorized'),
      ...(tls.authorizationError === undefined ? {} : { authorizationError: text(tls.authorizationError, 'runtime.tls.authorizationError', 1024) }),
      subject: text(tls.subject, 'runtime.tls.subject', 8192), issuer: text(tls.issuer, 'runtime.tls.issuer', 8192),
      validFrom: text(tls.validFrom, 'runtime.tls.validFrom', 256), validTo: text(tls.validTo, 'runtime.tls.validTo', 256),
    }
  }
  return result
}

/** 解析单跳结果，确保 requestHeadersSource 不被 utility 伪造为 wire capture。 */
function hop(value: unknown): ApiHttpHop {
  const record = apiRecord(value, ['url', 'method', 'requestHeaders', 'requestHeadersSource', 'status', 'statusText', 'httpVersion', 'responseHeaders', 'trailers', 'timings', 'connection'], 'runtime.hop')
  const rawTimings = apiRecord(record.timings, ['dnsMs', 'connectMs', 'tlsMs', 'sendMs', 'ttfbMs', 'downloadMs', 'totalMs'], 'runtime.timings')
  const timings: ApiTimings = {
    dnsMs: nullableDuration(rawTimings.dnsMs, 'runtime.timings.dnsMs'), connectMs: nullableDuration(rawTimings.connectMs, 'runtime.timings.connectMs'),
    tlsMs: nullableDuration(rawTimings.tlsMs, 'runtime.timings.tlsMs'), sendMs: nullableDuration(rawTimings.sendMs, 'runtime.timings.sendMs'),
    ttfbMs: nullableDuration(rawTimings.ttfbMs, 'runtime.timings.ttfbMs'), downloadMs: nullableDuration(rawTimings.downloadMs, 'runtime.timings.downloadMs'),
    totalMs: duration(rawTimings.totalMs, 'runtime.timings.totalMs'),
  }
  return {
    url: text(record.url, 'runtime.hop.url', 16384), method: choice(record.method, 'runtime.hop.method', ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']),
    requestHeaders: list(record.requestHeaders, 'runtime.hop.requestHeaders', 256, header),
    requestHeadersSource: choice(record.requestHeadersSource, 'runtime.hop.requestHeadersSource', ['configured']),
    status: apiInteger(record.status, 100, 599, 'runtime.hop.status'), statusText: text(record.statusText, 'runtime.hop.statusText', 1024),
    httpVersion: text(record.httpVersion, 'runtime.hop.httpVersion', 32), responseHeaders: list(record.responseHeaders, 'runtime.hop.responseHeaders', 512, header),
    trailers: list(record.trailers, 'runtime.hop.trailers', 256, header), timings, connection: connection(record.connection),
  }
}

/** 解析有界正文摘要。 */
function body(value: unknown): ApiBodyInfo {
  const record = apiRecord(value, ['rawBytes', 'decodedBytes', 'contentType', 'encoding', 'preview', 'previewTruncated', 'complete', 'decoded'], 'runtime.body')
  return {
    rawBytes: apiInteger(record.rawBytes, 0, API_LIMITS.bodyBytes + 1024 * 1024, 'runtime.body.rawBytes'),
    decodedBytes: apiInteger(record.decodedBytes, 0, API_LIMITS.bodyBytes + 1024 * 1024, 'runtime.body.decodedBytes'),
    contentType: text(record.contentType, 'runtime.body.contentType', 4096), encoding: text(record.encoding, 'runtime.body.encoding', 256),
    preview: text(record.preview, 'runtime.body.preview', API_LIMITS.previewBytes, true),
    previewTruncated: flag(record.previewTruncated, 'runtime.body.previewTruncated'), complete: flag(record.complete, 'runtime.body.complete'), decoded: flag(record.decoded, 'runtime.body.decoded'),
  }
}

/** 解析可选传输错误。 */
function failure(value: unknown): ApiFailure {
  const record = apiRecord(value, ['code', 'phase', 'message'], 'runtime.error')
  return { code: text(record.code, 'runtime.error.code', 128), phase: text(record.phase, 'runtime.error.phase', 128), message: text(record.message, 'runtime.error.message', 4096) }
}

/** 严格解析 Shared ApiTransportResult。 */
export function parseApiTransportResult(value: unknown): ApiTransportResult {
  const record = apiRecord(value, ['state', 'hops', 'body', 'sse', 'error'], 'runtime.result')
  return {
    state: choice(record.state, 'runtime.result.state', ['completed', 'failed', 'cancelled']),
    hops: list(record.hops, 'runtime.result.hops', 11, hop), body: body(record.body),
    ...(record.sse === undefined ? {} : { sse: sseSummary(record.sse) }),
    ...(record.error === undefined ? {} : { error: failure(record.error) }),
  }
}

/** 解析事件流计数事实；事件明细不在进程消息里重复传输。 */
function sseSummary(value: unknown): ApiSseSummary {
  const record = apiRecord(value, ['totalEvents', 'firstEventMs', 'endedReason'], 'runtime.sse')
  return {
    totalEvents: apiInteger(record.totalEvents, 0, 1_000_000, 'runtime.sse.totalEvents'),
    firstEventMs: record.firstEventMs === null ? null : duration(record.firstEventMs, 'runtime.sse.firstEventMs'),
    endedReason: choice(record.endedReason, 'runtime.sse.endedReason', ['completed', 'cancelled', 'error']),
  }
}

/** 解析单条流式事件；字段有界且不接受未知键。 */
function sseEvent(value: unknown): ApiSseEvent {
  const record = apiRecord(value, ['index', 'receivedMs', 'event', 'id', 'comment', 'data', 'retry', 'raw', 'truncated'], 'runtime.sseEvent')
  return {
    index: apiInteger(record.index, 0, 1_000_000, 'runtime.sseEvent.index'),
    receivedMs: duration(record.receivedMs, 'runtime.sseEvent.receivedMs'),
    event: text(record.event, 'runtime.sseEvent.event', 256), id: text(record.id, 'runtime.sseEvent.id', 256),
    comment: text(record.comment, 'runtime.sseEvent.comment', API_LIMITS.sseEventChars),
    data: text(record.data, 'runtime.sseEvent.data', API_LIMITS.sseEventChars, true),
    ...(record.retry === undefined ? {} : { retry: apiInteger(record.retry, 0, 600_000, 'runtime.sseEvent.retry') }),
    raw: text(record.raw, 'runtime.sseEvent.raw', API_LIMITS.sseEventChars, true), truncated: flag(record.truncated, 'runtime.sseEvent.truncated'),
  }
}

/** 验证 AES-256-GCM 密钥采用规范 Base64 且恰好 32 字节。 */
function keyBase64(value: unknown): string {
  const encoded = text(value, 'runtime.artifacts.keyBase64', 128)
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) return invalid('runtime.artifacts.keyBase64')
  const key = Buffer.from(encoded, 'base64')
  if (key.byteLength !== 32 || key.toString('base64') !== encoded) return invalid('runtime.artifacts.keyBase64')
  return encoded
}

/** 严格解析 Host 发给 utility 的运行或取消消息。 */
export function parseApiRuntimeRequest(value: unknown): ApiRuntimeRequest {
  const record = apiRecord(value, ['type', 'requestId', 'request', 'artifacts'], 'runtime.request')
  const type = choice(record.type, 'runtime.request.type', ['api-workbench.run', 'api-workbench.cancel', 'api-workbench.ack'])
  const requestId = parseApiId(record.requestId)
  if (type === 'api-workbench.cancel' || type === 'api-workbench.ack') {
    if (record.request !== undefined || record.artifacts !== undefined) return invalid('runtime.cancel.fields')
    return { type, requestId }
  }
  const request = parseApiResolvedRequest(record.request)
  if (record.artifacts === undefined) return { type, requestId, request }
  const artifacts = apiRecord(record.artifacts, ['directory', 'keyBase64'], 'runtime.artifacts')
  const directory = text(artifacts.directory, 'runtime.artifacts.directory', 4096)
  if (!isAbsolute(directory)) return invalid('runtime.artifacts.directory')
  return { type, requestId, request, artifacts: { directory, keyBase64: keyBase64(artifacts.keyBase64) } }
}

/** 严格解析 utility 消息，并让 client 继续核对当前 requestId。 */
export function parseApiRuntimeResponse(value: unknown): ApiRuntimeMessage {
  const record = apiRecord(value, ['type', 'requestId', 'result', 'events'], 'runtime.response')
  const type = choice(record.type, 'runtime.response.type', ['api-workbench.result', 'api-workbench.stream'])
  const requestId = parseApiId(record.requestId)
  if (type === 'api-workbench.stream') {
    if (record.result !== undefined) return invalid('runtime.stream.result')
    return {
      type, requestId,
      events: list(record.events, 'runtime.stream.events', API_LIMITS.sseDeltaEvents, sseEvent),
    }
  }
  if (record.events !== undefined) return invalid('runtime.result.events')
  return { type, requestId, result: parseApiTransportResult(record.result) }
}
