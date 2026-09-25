import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { Readable } from 'node:stream'
import type { Socket } from 'node:net'
import type { TLSSocket } from 'node:tls'
import { createBrotliDecompress, createGunzip, createInflate, type BrotliDecompress, type Gunzip, type Inflate } from 'node:zlib'
import { API_LIMITS } from '@proma/shared'
import type {
  ApiBodyInfo,
  ApiConnectionInfo,
  ApiFailure,
  ApiHeader,
  ApiHttpHop,
  ApiMethod,
  ApiResolvedRequest,
  ApiSseEvent,
  ApiSseFrame,
  ApiSseReader,
  ApiSseSummary,
  ApiTimings,
  ApiTransportResult,
} from '@proma/shared'
import { createApiSseReader } from '@proma/shared'

/** 原始响应与解压响应各自允许采集的硬上限。 */
const MAX_BODY_BYTES = 20 * 1024 * 1024
/** 请求行以外的 Header 总预算。 */
const MAX_HEADER_BYTES = 64 * 1024
/** 默认只把正文的前 256 KiB 留在内存中。 */
const DEFAULT_PREVIEW_BYTES = 256 * 1024
/** 单次 TCP/TLS 建链最多等待十秒，同时受请求总时限约束。 */
const CONNECT_TIMEOUT_MS = 10_000
/** 不允许由调用方直接控制的逐跳 Header。 */
const FILTERED_HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length',
])
/** 支持透明解压的 Content-Encoding。 */
const SUPPORTED_ENCODINGS = new Set(['gzip', 'deflate', 'br'])

/** 传输选项；回调在流消费路径中执行，因此天然提供背压。 */
export interface ApiTransportOptions {
  signal?: AbortSignal
  onRawChunk?: (chunk: Uint8Array) => Promise<void> | void
  onDecodedChunk?: (chunk: Uint8Array) => Promise<void> | void
  /** 事件流逐帧回调；只在最终响应的 Content-Type 为 text/event-stream 时触发。 */
  onSseEvent?: (event: ApiSseEvent) => void
  maxBodyBytes?: number
  previewBytes?: number
}

/** 事件流采集状态：跨 chunk 解码、分帧并编号。 */
interface SseCapture {
  reader: ApiSseReader
  decoder: TextDecoder
  startedAt: number
  totalEvents: number
  firstEventMs: number | null
}

/** 文本解码与最终正文预览共用同一份解码结果。 */
type BodyCaptureOptions = Required<Pick<ApiTransportOptions, 'maxBodyBytes' | 'previewBytes'>> & ApiTransportOptions & { sse?: SseCapture }

/** 事件流响应识别；同时兼容 charset 参数与大小写。 */
function isEventStream(response: IncomingMessage): boolean {
  return String(response.headers['content-type'] ?? '').toLowerCase().includes('text/event-stream')
}

/** 把一帧投影为公开事件并更新计数事实。 */
function emitSseFrame(capture: SseCapture, frame: ApiSseFrame, options: ApiTransportOptions): void {
  const receivedMs = Math.max(0, Math.round(performance.now() - capture.startedAt))
  const event: ApiSseEvent = {
    index: capture.totalEvents,
    receivedMs,
    event: frame.event,
    id: frame.id,
    comment: frame.comment,
    data: frame.data,
    ...(frame.retry === undefined ? {} : { retry: frame.retry }),
    raw: frame.raw,
    truncated: frame.truncated,
  }
  capture.totalEvents += 1
  if (capture.firstEventMs === null) capture.firstEventMs = receivedMs
  options.onSseEvent?.(event)
}

/** 把一段解码文本送入分帧器；未闭合内容留在读取器里等待后续 chunk。 */
function feedSseText(capture: SseCapture, text: string, options: ApiTransportOptions): void {
  for (const frame of capture.reader.push(text)) emitSseFrame(capture, frame, options)
}

/** 结束或中断时交出残余帧，并把采集状态投影为计数事实。 */
function finishSse(capture: SseCapture, options: ApiTransportOptions, endedReason: ApiSseSummary['endedReason']): ApiSseSummary {
  const leftover = capture.reader.flush()
  if (leftover) emitSseFrame(capture, leftover, options)
  return { totalEvents: capture.totalEvents, firstEventMs: capture.firstEventMs, endedReason }
}

/** 带稳定分类的内部错误，最终只投影公开故障字段。 */
class ApiTransportError extends Error {
  constructor(readonly code: string, readonly phase: string, message: string) {
    super(message)
    this.name = 'ApiTransportError'
  }
}

/** 单跳读取期间持续更新的有界正文事实。 */
interface BodyCapture {
  rawBytes: number
  decodedBytes: number
  previewChunks: Buffer[]
  previewBytes: number
  previewTruncated: boolean
}

/** socket 生命周期与可观测连接阶段。 */
interface SocketObservation {
  socket?: Socket
  closePromise: Promise<void>
  resolveClose: () => void
  lookupAt?: number
  connectAt?: number
  secureAt?: number
  reused: boolean
}

/** 单跳执行成功后的响应与下一跳上下文。 */
interface HopResponse {
  response: IncomingMessage
  request: ClientRequest
  hop: ApiHttpHop
  observation: SocketObservation
  responseAt: number
  finishAt?: number
  startedAt: number
}

/** 重定向决策只允许继续、停止或解释性拒绝三种结果。 */
type RedirectDecision =
  | { kind: 'none' }
  | { kind: 'follow'; url: URL; method: ApiMethod; body: Buffer }
  | { kind: 'reject'; error: ApiTransportError }

/** 生成无响应或尚未读取正文时的空事实。 */
function emptyBody(): ApiBodyInfo {
  return { rawBytes: 0, decodedBytes: 0, contentType: '', encoding: '', preview: '', previewTruncated: false, complete: false, decoded: false }
}

/** 使用单调时钟计算毫秒，保留小数以免短阶段伪装成零。 */
function elapsed(start: number, end: number): number {
  return Math.max(Number.EPSILON, end - start)
}

/** 将 Node 原始 Header 平铺数组恢复为保序且允许重复的记录。 */
function headersFromRaw(rawHeaders: readonly string[]): ApiHeader[] {
  const headers: ApiHeader[] = []
  for (let index = 0; index < rawHeaders.length; index += 2) {
    headers.push({ name: rawHeaders[index] ?? '', value: rawHeaders[index + 1] ?? '' })
  }
  return headers
}

/** 计算 UTF-8 Header 近似协议字段长度；不把它描述为 TCP wire bytes。 */
function headerBytes(headers: readonly ApiHeader[]): number {
  return headers.reduce((total, header) => total + Buffer.byteLength(header.name) + Buffer.byteLength(header.value) + 4, 2)
}

/** 验证并生成执行器实际配置给 Node 的请求 Header。 */
function prepareRequestHeaders(url: URL, headers: readonly ApiHeader[], body: Buffer): ApiHeader[] {
  let contentLength: string | undefined
  const configured: ApiHeader[] = []
  for (const header of headers) {
    const normalizedName = header.name.toLowerCase()
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(header.name) || /[\r\n]/.test(header.value)) {
      throw new ApiTransportError('API_HEADER_INVALID', 'request', '请求 Header 包含非法名称或换行符')
    }
    if (normalizedName === 'transfer-encoding') {
      throw new ApiTransportError('API_TRANSFER_ENCODING_UNSUPPORTED', 'request', '请求正文由执行器定长发送，不接受 Transfer-Encoding')
    }
    if (normalizedName === 'content-length') {
      if (contentLength !== undefined) throw new ApiTransportError('API_CONTENT_LENGTH_DUPLICATE', 'request', '请求包含重复 Content-Length')
      contentLength = header.value.trim()
      continue
    }
    if (FILTERED_HOP_HEADERS.has(normalizedName)) continue
    configured.push({ name: header.name, value: header.value, source: header.source ?? 'user' })
  }
  const actualLength = String(body.byteLength)
  if (contentLength !== undefined && (!/^\d+$/.test(contentLength) || contentLength !== actualLength)) {
    throw new ApiTransportError('API_CONTENT_LENGTH_MISMATCH', 'request', 'Content-Length 与 UTF-8 请求正文长度不一致')
  }
  const generated: ApiHeader[] = [
    { name: 'Host', value: url.host, source: 'generated' },
    { name: 'Connection', value: 'close', source: 'generated' },
    { name: 'Content-Length', value: actualLength, source: 'generated' },
  ]
  const result = [...configured, ...generated]
  if (headerBytes(result) > MAX_HEADER_BYTES) throw new ApiTransportError('API_HEADER_LIMIT', 'request', '请求 Header 总量超过 64 KiB')
  return result
}

/** 把证书主体对象转换为稳定且不声称是原始证书字节的文本。 */
function certificateName(value: Record<string, string | string[] | undefined> | undefined): string {
  if (!value) return ''
  return Object.entries(value).flatMap(([key, entry]) => entry === undefined ? [] : [`${key}=${Array.isArray(entry) ? entry.join('+') : entry}`]).join(', ')
}

/** 从当前直连 socket 提取地址和 TLS 事实。 */
function connectionInfo(observation: SocketObservation): ApiConnectionInfo {
  const socket = observation.socket
  const connection: ApiConnectionInfo = {
    reused: observation.reused,
    ...(socket?.remoteAddress ? { remoteAddress: socket.remoteAddress } : {}),
    ...(socket?.remotePort ? { remotePort: socket.remotePort } : {}),
    ...(socket?.localAddress ? { localAddress: socket.localAddress } : {}),
    ...(socket?.localPort ? { localPort: socket.localPort } : {}),
  }
  if (!socket || !('getCipher' in socket)) return connection
  const tlsSocket = socket as TLSSocket
  const cipher = tlsSocket.getCipher()
  const certificate = tlsSocket.getPeerCertificate() || undefined
  connection.tls = {
    protocol: tlsSocket.getProtocol() ?? '', cipher: cipher?.name ?? '', authorized: tlsSocket.authorized,
    ...(tlsSocket.authorizationError ? { authorizationError: String(tlsSocket.authorizationError) } : {}),
    subject: certificateName(certificate?.subject), issuer: certificateName(certificate?.issuer),
    validFrom: certificate?.valid_from ?? '', validTo: certificate?.valid_to ?? '',
  }
  return connection
}

/** 等待 socket 真正 close；尚未分配 socket 时直接完成。 */
async function waitForSocketClose(observation: SocketObservation): Promise<void> {
  if (!observation.socket || observation.socket.destroyed) return
  await observation.closePromise
}

/** 把 socket 销毁并等到 close，取消和限额失败共用该收口。 */
async function destroyAndWait(response: IncomingMessage | undefined, request: ClientRequest, observation: SocketObservation): Promise<void> {
  response?.destroy()
  request.destroy()
  observation.socket?.destroy()
  await waitForSocketClose(observation)
}

/** 将底层网络错误归到用户可解释的连接阶段。 */
function networkError(error: unknown): ApiTransportError {
  if (error instanceof ApiTransportError) return error
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
  const message = error instanceof Error ? error.message : String(error)
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return new ApiTransportError('API_DNS_FAILED', 'dns', message)
  if (code === 'HPE_HEADER_OVERFLOW') return new ApiTransportError('API_RESPONSE_HEADER_LIMIT', 'response-header', '响应 Header 总量超过 64 KiB')
  if (code.startsWith('CERT_') || code.includes('TLS') || code.includes('SSL')) return new ApiTransportError('API_TLS_FAILED', 'tls', message)
  if (['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH'].includes(code)) return new ApiTransportError('API_CONNECT_FAILED', 'connect', message)
  return new ApiTransportError('API_REQUEST_FAILED', 'request', message)
}

/**
 * 建立一跳 HTTP/1.1 请求并在收到响应头时返回。
 * @param body 本跳的正文缓冲区；含附件的请求由主进程提前合成好字节。
 */
function openHop(url: URL, method: ApiMethod, body: Buffer, headers: ApiHeader[], deadline: number, signal?: AbortSignal): Promise<HopResponse> {
  const startedAt = performance.now()
  const observation: SocketObservation = { closePromise: Promise.resolve(), resolveClose: () => {}, reused: false }
  return new Promise<HopResponse>((resolve, reject) => {
    let settled = false
    let finishAt: number | undefined
    let response: IncomingMessage | undefined
    let connectTimer: ReturnType<typeof setTimeout> | undefined
    let totalTimer: ReturnType<typeof setTimeout> | undefined
    let removeAbort = (): void => {}
    const cleanup = (): void => {
      if (connectTimer) clearTimeout(connectTimer)
      if (totalTimer) clearTimeout(totalTimer)
      removeAbort()
    }
    const fail = async (error: ApiTransportError): Promise<void> => {
      if (settled) return
      settled = true
      cleanup()
      await destroyAndWait(response, clientRequest, observation)
      reject(error)
    }
    const rawHeaders = headers.flatMap((header) => [header.name, header.value])
    const requestFunction = url.protocol === 'https:' ? httpsRequest : httpRequest
    const clientRequest = requestFunction({
      protocol: url.protocol, hostname: url.hostname, port: url.port || undefined,
      method, path: `${url.pathname}${url.search}`, headers: rawHeaders, agent: false, maxHeaderSize: MAX_HEADER_BYTES,
    }, (incoming) => {
      response = incoming
      if (settled) { incoming.destroy(); return }
      settled = true
      cleanup()
      const responseAt = performance.now()
      /** Send 从最后一个可观测建链边界开始；复用 socket 无建链事件时回退请求起点。 */
      const sendStartedAt = observation.secureAt ?? observation.connectAt ?? observation.lookupAt ?? startedAt
      const timings: ApiTimings = {
        dnsMs: observation.lookupAt === undefined ? null : elapsed(startedAt, observation.lookupAt),
        connectMs: observation.connectAt === undefined ? null : elapsed(observation.lookupAt ?? startedAt, observation.connectAt),
        tlsMs: observation.secureAt === undefined ? null : elapsed(observation.connectAt ?? observation.lookupAt ?? startedAt, observation.secureAt),
        sendMs: finishAt === undefined ? null : elapsed(sendStartedAt, finishAt),
        ttfbMs: finishAt === undefined ? null : elapsed(finishAt, responseAt), downloadMs: null,
        totalMs: elapsed(startedAt, responseAt),
      }
      resolve({
        response: incoming, request: clientRequest, observation, responseAt, finishAt, startedAt,
        hop: {
          url: url.toString(), method, requestHeaders: headers, requestHeadersSource: 'configured',
          status: incoming.statusCode ?? 0, statusText: incoming.statusMessage ?? '', httpVersion: incoming.httpVersion,
          responseHeaders: headersFromRaw(incoming.rawHeaders), trailers: [], timings,
          connection: connectionInfo(observation),
        },
      })
    })
    clientRequest.once('finish', () => { finishAt = performance.now() })
    clientRequest.once('socket', (socket) => {
      observation.socket = socket
      observation.reused = clientRequest.reusedSocket
      observation.closePromise = new Promise<void>((resolveClose) => { observation.resolveClose = resolveClose })
      socket.once('close', observation.resolveClose)
      socket.once('lookup', () => { observation.lookupAt = performance.now() })
      socket.once('connect', () => {
        observation.connectAt = performance.now()
        if (connectTimer) clearTimeout(connectTimer)
      })
      if ('once' in socket && url.protocol === 'https:') {
        ;(socket as TLSSocket).once('secureConnect', () => {
          observation.secureAt = performance.now()
          if (connectTimer) clearTimeout(connectTimer)
        })
      }
    })
    clientRequest.once('error', (error) => { void fail(networkError(error)) })
    const remainingMs = Math.max(1, deadline - Date.now())
    connectTimer = setTimeout(() => { void fail(new ApiTransportError('API_CONNECT_TIMEOUT', 'connect', '连接超时')) }, Math.min(CONNECT_TIMEOUT_MS, remainingMs))
    totalTimer = setTimeout(() => { void fail(new ApiTransportError('API_TOTAL_TIMEOUT', 'timeout', '请求总时限已到')) }, remainingMs)
    const abort = (): void => { void fail(new ApiTransportError('API_ABORTED', 'cancel', '请求已取消')) }
    if (signal) {
      if (signal.aborted) { abort(); return }
      signal.addEventListener('abort', abort, { once: true })
      removeAbort = () => signal.removeEventListener('abort', abort)
    }
    clientRequest.end(body)
  })
}

/** 为响应选择严格支持的单层解压器。 */
function decoderFor(encoding: string): Gunzip | Inflate | BrotliDecompress | undefined {
  if (encoding === 'gzip') return createGunzip()
  if (encoding === 'deflate') return createInflate()
  if (encoding === 'br') return createBrotliDecompress()
  return undefined
}

/** 有背压地读取正文，并分别执行原始与解码回调。 */
async function captureBody(response: IncomingMessage, capture: BodyCapture, deadline: number, options: BodyCaptureOptions): Promise<void> {
  const encoding = String(response.headers['content-encoding'] ?? '').trim().toLowerCase()
  const abort = (): void => { response.destroy(new ApiTransportError('API_ABORTED', 'cancel', '请求已取消')) }
  const timeout = setTimeout(() => response.destroy(new ApiTransportError('API_TOTAL_TIMEOUT', 'timeout', '请求总时限已到')), Math.max(1, deadline - Date.now()))
  if (options.signal?.aborted) abort()
  else options.signal?.addEventListener('abort', abort, { once: true })
  const rawSource = Readable.from((async function* (): AsyncGenerator<Buffer> {
    for await (const value of response) {
      const chunk = Buffer.from(value)
      capture.rawBytes += chunk.byteLength
      if (capture.rawBytes > options.maxBodyBytes) throw new ApiTransportError('API_RAW_BODY_LIMIT', 'body', '原始响应正文超过采集上限')
      await options.onRawChunk?.(chunk)
      yield chunk
    }
  })())
  const decoder = decoderFor(encoding)
  const decodedStream = decoder ? rawSource.pipe(decoder) : rawSource
  try {
    for await (const value of decodedStream) {
      const chunk = Buffer.from(value)
      capture.decodedBytes += chunk.byteLength
      if (capture.decodedBytes > options.maxBodyBytes) throw new ApiTransportError('API_DECODED_BODY_LIMIT', 'decode', '解码响应正文超过采集上限')
      await options.onDecodedChunk?.(chunk)
      /** 事件流按解码后的文本分帧，避免在多字节字符中间切断。 */
      if (options.sse) feedSseText(options.sse, options.sse.decoder.decode(chunk, { stream: true }), options)
      const remaining = options.previewBytes - capture.previewBytes
      if (remaining > 0) {
        const previewChunk = chunk.subarray(0, remaining)
        capture.previewChunks.push(previewChunk)
        capture.previewBytes += previewChunk.byteLength
      }
      if (chunk.byteLength > remaining) capture.previewTruncated = true
    }
  } finally {
    clearTimeout(timeout)
    options.signal?.removeEventListener('abort', abort)
  }
}

/** 把正文采集状态转换为 Shared 合同。 */
function bodyInfo(response: IncomingMessage | undefined, capture: BodyCapture, complete: boolean): ApiBodyInfo {
  const encoding = String(response?.headers['content-encoding'] ?? '').trim().toLowerCase()
  return {
    rawBytes: capture.rawBytes, decodedBytes: capture.decodedBytes,
    contentType: String(response?.headers['content-type'] ?? ''), encoding,
    preview: Buffer.concat(capture.previewChunks).toString('utf8'),
    previewTruncated: capture.previewTruncated, complete,
    decoded: SUPPORTED_ENCODINGS.has(encoding),
  }
}

/** 根据状态码执行阶段 A 的方法改写，并在网络动作前拒绝越界来源。 */
function redirectDecision(currentUrl: URL, method: ApiMethod, body: Buffer, status: number, location: string | undefined, request: ApiResolvedRequest, hopCount: number): RedirectDecision {
  if (!request.followRedirects || !location || ![301, 302, 303, 307, 308].includes(status)) return { kind: 'none' }
  if (hopCount >= request.maxRedirects) return { kind: 'reject', error: new ApiTransportError('API_REDIRECT_LIMIT', 'redirect', '重定向次数超过配置上限') }
  let target: URL
  try { target = new URL(location, currentUrl) } catch { return { kind: 'reject', error: new ApiTransportError('API_REDIRECT_INVALID', 'redirect', '重定向地址无效') } }
  if (!['http:', 'https:'].includes(target.protocol)) return { kind: 'reject', error: new ApiTransportError('API_REDIRECT_PROTOCOL', 'redirect', '重定向协议不受支持') }
  if (currentUrl.protocol === 'https:' && target.protocol === 'http:') return { kind: 'reject', error: new ApiTransportError('API_REDIRECT_DOWNGRADE', 'redirect', '拒绝从 HTTPS 自动降级到 HTTP') }
  if (currentUrl.origin !== target.origin) return { kind: 'reject', error: new ApiTransportError('API_REDIRECT_CROSS_ORIGIN', 'redirect', '跨来源重定向需要用户明确确认，未自动发送下一跳') }
  let nextMethod = method
  if ((status === 301 || status === 302) && method === 'POST') nextMethod = 'GET'
  if (status === 303 && method !== 'HEAD') nextMethod = 'GET'
  return { kind: 'follow', url: target, method: nextMethod, body: nextMethod === 'GET' ? Buffer.alloc(0) : body }
}

/** 将内部错误转换为不会携带秘密正文或 Header 值的失败事实。 */
function failure(error: unknown): ApiFailure {
  const transportError = networkError(error)
  return { code: transportError.code, phase: transportError.phase, message: transportError.message }
}

/**
 * 执行固定的 HTTP/HTTPS 请求快照。每跳使用独立 HTTP/1.1 连接，并在 socket
 * 真正关闭后才返回，确保取消、限额和重定向都不遗留本地网络资源。
 */
export async function executeApiTransport(request: ApiResolvedRequest, options: ApiTransportOptions = {}): Promise<ApiTransportResult> {
  const hops: ApiHttpHop[] = []
  const maxBodyBytes = Math.min(MAX_BODY_BYTES, Math.max(1, options.maxBodyBytes ?? MAX_BODY_BYTES))
  const previewBytes = Math.min(maxBodyBytes, Math.max(0, options.previewBytes ?? DEFAULT_PREVIEW_BYTES))
  const captureOptions = { ...options, maxBodyBytes, previewBytes }
  const deadline = Date.now() + request.timeoutMs
  let currentUrl: URL
  try {
    currentUrl = new URL(request.url)
    if (!['http:', 'https:'].includes(currentUrl.protocol)) throw new ApiTransportError('API_PROTOCOL_UNSUPPORTED', 'request', '仅支持 HTTP 和 HTTPS')
    if (currentUrl.username || currentUrl.password) throw new ApiTransportError('API_URL_CREDENTIALS_UNSUPPORTED', 'request', 'URL 不允许内嵌凭据')
  } catch (error) {
    return { state: 'failed', hops, body: emptyBody(), error: failure(error) }
  }
  let method = request.method
  /** 含附件的请求带的是已经合成好的二进制正文；其余请求按 UTF-8 文本发送。 */
  let body: Buffer = request.bodyBase64 === undefined ? Buffer.from(request.body) : Buffer.from(request.bodyBase64, 'base64')
  if (body.byteLength > API_LIMITS.bodyBytes) throw new ApiTransportError('API_REQUEST_BODY_LIMIT', 'request', '请求正文超过上限')
  let finalBody = emptyBody()
  for (;;) {
    const capture: BodyCapture = { rawBytes: 0, decodedBytes: 0, previewChunks: [], previewBytes: 0, previewTruncated: false }
    /** 仅最终响应采集事件流；重定向跳转只丢弃正文。 */
    let sseCapture: SseCapture | undefined
    let opened: HopResponse | undefined
    try {
      if (options.signal?.aborted) throw new ApiTransportError('API_ABORTED', 'cancel', '请求已取消')
      if (Date.now() >= deadline) throw new ApiTransportError('API_TOTAL_TIMEOUT', 'timeout', '请求总时限已到')
      const requestHeaders = prepareRequestHeaders(currentUrl, request.headers, body)
      opened = await openHop(currentUrl, method, body, requestHeaders, deadline, options.signal)
      hops.push(opened.hop)
      const locationValue = opened.response.headers.location
      const decision = redirectDecision(currentUrl, method, body, opened.hop.status, locationValue, request, hops.length - 1)
      if (decision.kind === 'reject') {
        await destroyAndWait(opened.response, opened.request, opened.observation)
        opened.hop.trailers = headersFromRaw(opened.response.rawTrailers)
        opened.hop.timings.totalMs = elapsed(opened.startedAt, performance.now())
        return { state: 'failed', hops, body: bodyInfo(opened.response, capture, false), error: failure(decision.error) }
      }
      if (decision.kind === 'none' && isEventStream(opened.response)) {
        sseCapture = { reader: createApiSseReader(), decoder: new TextDecoder(), startedAt: opened.startedAt, totalEvents: 0, firstEventMs: null }
      }
      const callbacks: BodyCaptureOptions = {
        ...(decision.kind === 'follow' ? { maxBodyBytes, previewBytes: 0 } : captureOptions),
        ...(sseCapture ? { sse: sseCapture } : {}),
      }
      await captureBody(opened.response, capture, deadline, callbacks)
      opened.hop.trailers = headersFromRaw(opened.response.rawTrailers)
      const bodyEndedAt = performance.now()
      opened.hop.timings.downloadMs = elapsed(opened.responseAt, bodyEndedAt)
      await waitForSocketClose(opened.observation)
      opened.hop.timings.totalMs = elapsed(opened.startedAt, performance.now())
      if (decision.kind === 'none') {
        finalBody = bodyInfo(opened.response, capture, true)
        return {
          state: 'completed', hops, body: finalBody,
          ...(sseCapture ? { sse: finishSse(sseCapture, options, 'completed') } : {}),
        }
      }
      currentUrl = decision.url
      method = decision.method
      body = decision.body
    } catch (error) {
      if (opened) await destroyAndWait(opened.response, opened.request, opened.observation)
      finalBody = opened ? bodyInfo(opened.response, capture, false) : emptyBody()
      const transportFailure = failure(error)
      const cancelled = transportFailure.code === 'API_ABORTED'
      return {
        state: cancelled ? 'cancelled' : 'failed', hops, body: finalBody,
        ...(sseCapture ? { sse: finishSse(sseCapture, options, cancelled ? 'cancelled' : 'error') } : {}),
        error: transportFailure,
      }
    }
  }
}
