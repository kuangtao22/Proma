import { API_LIMITS, apiInteger, apiRecord, parseApiCatalog, parseApiFields, parseApiId, parseApiRequestDraft, parseApiTarget } from './api-workbench'
import type { ApiWorkbenchApi, ApiTarget, ApiSaveCatalogInput, ApiPrepareInput, ApiSendInput, ApiRunInput, ApiReadBodyInput, ApiListRunsInput, ApiPinRunInput, ApiCatalog, ApiPreparedPreview, ApiRun, ApiBodySlice, ApiResolvedRequest, ApiHeader, ApiTimings, ApiHttpHop, ApiBodyInfo, ApiFailure, ApiRunChanged, ApiRunStreamChanged, ApiSseEvent, ApiSseStream, ApiExtractionOutcome, ApiRuntimeVariable, ApiCookieJarEntry, ApiPickedFile, ApiConnectionInfo, ApiScenarioRun, ApiScenarioStepOutcome, ApiScenarioPreparedPreview, ApiScenarioStepPreview } from './api-workbench'

/** IPC 命令的输入映射，拒绝用户自行声明 workspace。 */
export interface ApiCommandInputs { getCatalog: ApiTarget; saveCatalog: ApiSaveCatalogInput; prepare: ApiPrepareInput; send: ApiSendInput; cancel: ApiSendInput; listRuns: ApiListRunsInput; getRun: ApiRunInput; readBody: ApiReadBodyInput; pinRun: ApiPinRunInput; getRuntimeVariables: ApiTarget; clearRuntimeVariables: ApiTarget; getCookieJar: ApiTarget; clearCookieJar: ApiTarget; pickApiFiles: ApiTarget }
/** IPC 返回值映射，preload 必须验证实际响应。 */
export interface ApiCommandResults { getCatalog: ApiCatalog; saveCatalog: ApiCatalog; prepare: ApiPreparedPreview; send: ApiRun; cancel: void; listRuns: { runs: ApiRun[]; nextCursor: number | null }; getRun: ApiRun; readBody: ApiBodySlice; pinRun: ApiRun; getRuntimeVariables: { variables: ApiRuntimeVariable[] }; clearRuntimeVariables: { cleared: number }; getCookieJar: { cookies: ApiCookieJarEntry[] }; clearCookieJar: { cleared: number }; pickApiFiles: { files: ApiPickedFile[] } }
/** 严格分派所支持的方法。 */
export type ApiCommandMethod = keyof ApiCommandInputs
/** 方法与输入保持关联，主进程 switch 可直接收窄。 */
export type ApiCommand = { [M in ApiCommandMethod]: { method: M; input: ApiCommandInputs[M] } }[ApiCommandMethod]

/** 抛出稳定错误，不回显不可信值。 */
function bad(path: string): never { throw new Error('API_WORKBENCH_INVALID: ' + path) }
/** 解析有界字符串。 */
function str(value: unknown, path: string, max = 8192): string { if (typeof value !== 'string' || value.length > max) return bad(path); return value }
/** 布尔值不得隐式转换。 */
function bool(value: unknown): boolean { if (typeof value !== 'boolean') return bad('boolean'); return value }
/** 验证枚举，不允许未知状态进入 UI。 */
function one<T extends string>(value: unknown, values: readonly T[]): T { if (typeof value !== 'string' || !values.includes(value as T)) return bad('enum'); return value as T }
/** 验证有界数组；响应 Header 名称可以重复。 */
function list<T>(value: unknown, parser: (item: unknown) => T, max = 128): T[] { if (!Array.isArray(value) || value.length > max) return bad('array'); return value.map(parser) }
/** 可观测计时允许小数但禁止负数、NaN 和无限值。 */
function duration(value: unknown): number { if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 86_400_000) return bad('duration'); return value }
/** 解析可空计时；null 表示未发生或不可观测。 */
function nullableDuration(value: unknown): number | null { return value === null ? null : duration(value) }
/** 解析会话输入的共有字段。 */
function target(record: Record<string, unknown>): ApiTarget { return parseApiTarget({ sessionId: record.sessionId }) }
/** 解析单个 IPC 命令，复制所有字段避免调用方后续变更输入。 */
export function parseApiCommand(value: unknown): ApiCommand {
  const root = apiRecord(value, ['method', 'input'], 'command')
  const method = one(root.method, ['getCatalog', 'saveCatalog', 'prepare', 'send', 'cancel', 'listRuns', 'getRun', 'readBody', 'pinRun', 'getRuntimeVariables', 'clearRuntimeVariables', 'getCookieJar', 'clearCookieJar', 'pickApiFiles'])
  switch (method) {
    case 'getCatalog': return { method, input: parseApiTarget(root.input) }
    case 'saveCatalog': {
      const input = apiRecord(root.input, ['sessionId', 'expectedRevision', 'catalog'])
      return { method, input: { ...target(input), expectedRevision: apiInteger(input.expectedRevision, 0, Number.MAX_SAFE_INTEGER, 'expectedRevision'), catalog: parseApiCatalog(input.catalog) } }
    }
    case 'prepare': {
      const input = apiRecord(root.input, ['sessionId', 'request', 'requestId', 'environmentId', 'overrides', 'caseId'])
      return { method, input: { ...target(input), request: parseApiRequestDraft(input.request), ...(input.requestId === undefined ? {} : { requestId: parseApiId(input.requestId) }), ...(input.environmentId === undefined ? {} : { environmentId: parseApiId(input.environmentId) }), ...(input.overrides === undefined ? {} : { overrides: parseApiFields(input.overrides) }), ...(input.caseId === undefined ? {} : { caseId: parseApiId(input.caseId) }) } }
    }
    case 'send': case 'cancel': {
      const input = apiRecord(root.input, ['sessionId', 'preparedId'])
      return { method, input: { ...target(input), preparedId: parseApiId(input.preparedId) } }
    }
    case 'getRun': {
      const input = apiRecord(root.input, ['sessionId', 'runId', 'reveal'])
      return { method, input: { ...target(input), runId: parseApiId(input.runId), ...(input.reveal === undefined ? {} : { reveal: bool(input.reveal) }) } }
    }
    case 'readBody': {
      const input = apiRecord(root.input, ['sessionId', 'runId', 'offset', 'limit', 'reveal'])
      return { method, input: { ...target(input), runId: parseApiId(input.runId), ...(input.reveal === undefined ? {} : { reveal: bool(input.reveal) }), ...(input.offset === undefined ? {} : { offset: apiInteger(input.offset, 0, API_LIMITS.bodyBytes, 'offset') }), ...(input.limit === undefined ? {} : { limit: apiInteger(input.limit, 1, API_LIMITS.previewBytes, 'limit') }) } }
    }
    case 'listRuns': {
      const input = apiRecord(root.input, ['sessionId', 'cursor', 'limit'])
      return { method, input: { ...target(input), ...(input.cursor === undefined ? {} : { cursor: apiInteger(input.cursor, 0, API_LIMITS.maxRuns, 'cursor') }), ...(input.limit === undefined ? {} : { limit: apiInteger(input.limit, 1, 50, 'limit') }) } }
    }
    case 'pinRun': {
      const input = apiRecord(root.input, ['sessionId', 'runId', 'pinned'])
      return { method, input: { ...target(input), runId: parseApiId(input.runId), pinned: bool(input.pinned) } }
    }
    /** 运行时变量命令只接收会话身份，workspace 由主进程解析。 */
    case 'getRuntimeVariables': case 'clearRuntimeVariables': return { method, input: parseApiTarget(root.input) }
    case 'getCookieJar': case 'clearCookieJar': return { method, input: parseApiTarget(root.input) }
    case 'pickApiFiles': return { method, input: parseApiTarget(root.input) }
  }
}
/** 原始响应头值允许协议字符，但始终限定字符串长度。 */
function header(value: unknown): ApiHeader {
  const record = apiRecord(value, ['name', 'value', 'source'])
  return { name: str(record.name, 'header.name', 256), value: str(record.value, 'header.value', 65536), ...(record.source === undefined ? {} : { source: one(record.source, ['user', 'generated'] as const) }) }
}
/** base64 正文的字符上限：按 20 MiB 原始字节的最坏膨胀再加边界余量。 */
const MAX_BODY_BASE64_CHARS = Math.ceil((API_LIMITS.bodyBytes * 4) / 3) + 4096
/** 解析附件摘要；只允许字段名、文件名、大小与 sha256。 */
function attachmentSummary(value: unknown) {
  const record = apiRecord(value, ['field', 'fileName', 'sizeBytes', 'sha256'])
  const sha256 = str(record.sha256, 'attachment.sha256', 64)
  if (!/^[0-9a-f]{64}$/.test(sha256)) return bad('attachment.sha256')
  return {
    field: str(record.field, 'attachment.field', 256),
    fileName: str(record.fileName, 'attachment.fileName', 256),
    sizeBytes: apiInteger(record.sizeBytes, 0, API_LIMITS.bodyBytes, 'attachment.sizeBytes'),
    sha256,
  }
}
/** 准备结果的请求已经是解析后的公开投影，敏感部分应被 Host 遮罩。 */
export function parseApiResolvedRequest(value: unknown): ApiResolvedRequest {
  const record = apiRecord(value, ['method', 'url', 'headers', 'body', 'timeoutMs', 'followRedirects', 'maxRedirects', 'sensitiveHeaderNames', 'sensitiveQueryNames', 'bodyBase64', 'attachments'])
  if (typeof record.body !== 'string' || new TextEncoder().encode(record.body).byteLength > API_LIMITS.requestBytes) return bad('request.bodyBytes')
  /** 二进制正文只在主进程与 Utility 之间流转；这里同样按上限收紧。 */
  const bodyBase64 = record.bodyBase64 === undefined ? undefined : str(record.bodyBase64, 'bodyBase64', MAX_BODY_BASE64_CHARS)
  return {
    method: one(record.method, ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']), url: str(record.url, 'url', 16384), headers: list(record.headers, header, 256), body: str(record.body, 'body', API_LIMITS.bodyBytes),
    timeoutMs: apiInteger(record.timeoutMs, 100, 300000, 'timeoutMs'), followRedirects: bool(record.followRedirects), maxRedirects: apiInteger(record.maxRedirects, 0, 10, 'maxRedirects'),
    sensitiveHeaderNames: list(record.sensitiveHeaderNames, (item) => str(item, 'sensitiveHeader', 256)), sensitiveQueryNames: list(record.sensitiveQueryNames, (item) => str(item, 'sensitiveQuery', 256)),
    ...(bodyBase64 === undefined ? {} : { bodyBase64 }),
    ...(record.attachments === undefined ? {} : { attachments: list(record.attachments, attachmentSummary, API_LIMITS.maxFileParts) }),
  }
}
/** 解析准备回执，不能携带内部密钥和路径。 */
export function parseApiPreparedPreview(value: unknown): ApiPreparedPreview {
  const record = apiRecord(value, ['preparedId', 'request', 'requestName', 'catalogRevision', 'environmentId', 'environmentKind', 'createdAt', 'expiresAt', 'warnings'])
  return { preparedId: parseApiId(record.preparedId), request: parseApiResolvedRequest(record.request), requestName: str(record.requestName, 'requestName', 128), catalogRevision: apiInteger(record.catalogRevision, 0, Number.MAX_SAFE_INTEGER, 'revision'), createdAt: apiInteger(record.createdAt, 0, Number.MAX_SAFE_INTEGER, 'createdAt'), expiresAt: apiInteger(record.expiresAt, 0, Number.MAX_SAFE_INTEGER, 'expiresAt'), warnings: list(record.warnings, (item) => str(item, 'warning', 2048), 32), ...(record.environmentId === undefined ? {} : { environmentId: parseApiId(record.environmentId) }), ...(record.environmentKind === undefined ? {} : { environmentKind: one(record.environmentKind, ['local', 'test', 'production'] as const) }) }
}
/** 解析连接事实和当前 TLS 层。 */
function connection(value: unknown): ApiConnectionInfo {
  const record = apiRecord(value, ['reused', 'remoteAddress', 'remotePort', 'localAddress', 'localPort', 'tls'])
  const result: ApiConnectionInfo = { reused: bool(record.reused) }
  for (const key of ['remoteAddress', 'localAddress'] as const) if (record[key] !== undefined) result[key] = str(record[key], key, 256)
  for (const key of ['remotePort', 'localPort'] as const) if (record[key] !== undefined) result[key] = apiInteger(record[key], 0, 65535, key)
  if (record.tls !== undefined) {
    const tls = apiRecord(record.tls, ['protocol', 'cipher', 'authorized', 'authorizationError', 'subject', 'issuer', 'validFrom', 'validTo'])
    result.tls = { protocol: str(tls.protocol, 'tls.protocol', 128), cipher: str(tls.cipher, 'tls.cipher', 256), authorized: bool(tls.authorized), subject: str(tls.subject, 'tls.subject'), issuer: str(tls.issuer, 'tls.issuer'), validFrom: str(tls.validFrom, 'tls.validFrom', 256), validTo: str(tls.validTo, 'tls.validTo', 256), ...(tls.authorizationError === undefined ? {} : { authorizationError: str(tls.authorizationError, 'tls.error', 1024) }) }
  }
  return result
}
/** 逐跳数据保留原始响应头和明确的发送配置来源。 */
function hop(value: unknown): ApiHttpHop {
  const record = apiRecord(value, ['url', 'method', 'requestHeaders', 'requestHeadersSource', 'status', 'statusText', 'httpVersion', 'responseHeaders', 'trailers', 'timings', 'connection'])
  const timing = apiRecord(record.timings, ['dnsMs', 'connectMs', 'tlsMs', 'sendMs', 'ttfbMs', 'downloadMs', 'totalMs'])
  const timings: ApiTimings = { dnsMs: nullableDuration(timing.dnsMs), connectMs: nullableDuration(timing.connectMs), tlsMs: nullableDuration(timing.tlsMs), sendMs: nullableDuration(timing.sendMs), ttfbMs: nullableDuration(timing.ttfbMs), downloadMs: nullableDuration(timing.downloadMs), totalMs: duration(timing.totalMs) }
  return { url: str(record.url, 'hop.url', 16384), method: one(record.method, ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']), requestHeaders: list(record.requestHeaders, header, 256), requestHeadersSource: one(record.requestHeadersSource, ['configured', 'captured', 'unavailable']), status: apiInteger(record.status, 100, 599, 'status'), statusText: str(record.statusText, 'statusText', 1024), httpVersion: str(record.httpVersion, 'httpVersion', 32), responseHeaders: list(record.responseHeaders, header, 512), trailers: list(record.trailers, header, 256), timings, connection: connection(record.connection) }
}
/** 正文摘要与真实采集完整度。 */
function bodyInfo(value: unknown): ApiBodyInfo {
  const record = apiRecord(value, ['rawBytes', 'decodedBytes', 'contentType', 'encoding', 'preview', 'previewTruncated', 'complete', 'decoded'])
  return { rawBytes: apiInteger(record.rawBytes, 0, API_LIMITS.bodyBytes + 1024 * 1024, 'rawBytes'), decodedBytes: apiInteger(record.decodedBytes, 0, API_LIMITS.bodyBytes + 1024 * 1024, 'decodedBytes'), contentType: str(record.contentType, 'contentType', 4096), encoding: str(record.encoding, 'encoding', 256), preview: str(record.preview, 'preview', API_LIMITS.previewBytes), previewTruncated: bool(record.previewTruncated), complete: bool(record.complete), decoded: bool(record.decoded) }
}
/** 分类错误只能携带有界消息。 */
function failure(value: unknown): ApiFailure { const record = apiRecord(value, ['code', 'phase', 'message']); return { code: str(record.code, 'code', 128), phase: str(record.phase, 'phase', 128), message: str(record.message, 'message', 4096) } }
/** 严格验证运行公开结果，原始密钥不能混进 DTO。 */
export function parseApiRun(value: unknown): ApiRun {
  const record = apiRecord(value, ['id', 'workspaceId', 'sessionId', 'source', 'requestName', 'requestId', 'environmentId', 'catalogRevision', 'createdAt', 'finishedAt', 'state', 'request', 'hops', 'body', 'assertions', 'error', 'recording', 'pinned', 'sse', 'extracted', 'caseId'])
  return {
    id: parseApiId(record.id), workspaceId: parseApiId(record.workspaceId), sessionId: parseApiId(record.sessionId), source: one(record.source, ['manual', 'agent']), requestName: str(record.requestName, 'requestName', 128),
    ...(record.requestId === undefined ? {} : { requestId: parseApiId(record.requestId) }), ...(record.environmentId === undefined ? {} : { environmentId: parseApiId(record.environmentId) }),
    catalogRevision: apiInteger(record.catalogRevision, 0, Number.MAX_SAFE_INTEGER, 'catalogRevision'), createdAt: apiInteger(record.createdAt, 0, Number.MAX_SAFE_INTEGER, 'createdAt'), ...(record.finishedAt === undefined ? {} : { finishedAt: apiInteger(record.finishedAt, 0, Number.MAX_SAFE_INTEGER, 'finishedAt') }),
    state: one(record.state, ['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted']), request: parseApiResolvedRequest(record.request), hops: list(record.hops, hop, 11), body: bodyInfo(record.body),
    assertions: list(record.assertions, (value) => { const entry = apiRecord(value, ['id', 'passed', 'expected', 'actual', 'message']); return { id: parseApiId(entry.id), passed: bool(entry.passed), expected: str(entry.expected, 'expected', 4096), actual: str(entry.actual, 'actual', 4096), message: str(entry.message, 'message', 4096) } }, 64),
    ...(record.error === undefined ? {} : { error: failure(record.error) }), recording: one(record.recording, ['saved', 'memory-only', 'failed']), pinned: bool(record.pinned),
    ...(record.sse === undefined ? {} : { sse: sseStream(record.sse) }),
    ...(record.extracted === undefined ? {} : { extracted: list(record.extracted, extractionOutcome, API_LIMITS.maxExtractions) }),
    ...(record.caseId === undefined ? {} : { caseId: parseApiId(record.caseId) }),
  }
}
/** 解析场景步骤投影；index 必须连续，界面据此逐行展示执行顺序。 */
export function parseApiScenarioPreparedPreview(value: unknown): ApiScenarioPreparedPreview {
  const record = apiRecord(value, ['preparedId', 'scenarioId', 'scenarioName', 'catalogRevision', 'environmentId', 'onFailure', 'createdAt', 'expiresAt', 'warnings', 'steps'])
  const steps = list(record.steps, (item): ApiScenarioStepPreview => {
    const entry = apiRecord(item, ['index', 'stepId', 'name', 'requestId', 'caseId', 'method', 'url', 'environmentKind', 'assertionCount'])
    return {
      index: apiInteger(entry.index, 0, API_LIMITS.maxScenarioSteps - 1, 'step.index'),
      stepId: parseApiId(entry.stepId),
      name: str(entry.name, 'step.name', 128),
      requestId: parseApiId(entry.requestId),
      ...(entry.caseId === undefined ? {} : { caseId: parseApiId(entry.caseId) }),
      method: one(entry.method, ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const),
      url: str(entry.url, 'step.url', 16384),
      ...(entry.environmentKind === undefined ? {} : { environmentKind: one(entry.environmentKind, ['local', 'test', 'production'] as const) }),
      assertionCount: apiInteger(entry.assertionCount, 0, 64, 'step.assertionCount'),
    }
  }, API_LIMITS.maxScenarioSteps)
  if (steps.some((step, index) => step.index !== index)) return bad('scenario.steps.index')
  return {
    preparedId: parseApiId(record.preparedId),
    scenarioId: parseApiId(record.scenarioId),
    scenarioName: str(record.scenarioName, 'scenarioName', 128),
    catalogRevision: apiInteger(record.catalogRevision, 0, Number.MAX_SAFE_INTEGER, 'catalogRevision'),
    ...(record.environmentId === undefined ? {} : { environmentId: parseApiId(record.environmentId) }),
    onFailure: one(record.onFailure, ['stop', 'continue'] as const),
    createdAt: apiInteger(record.createdAt, 0, Number.MAX_SAFE_INTEGER, 'createdAt'),
    expiresAt: apiInteger(record.expiresAt, 0, Number.MAX_SAFE_INTEGER, 'expiresAt'),
    warnings: list(record.warnings, (item) => str(item, 'warning', 2048), 32),
    steps,
  }
}
/** 场景单步结论：只保留状态与计数，正文留在该步自己的运行记录里。 */
function scenarioStepOutcome(value: unknown): ApiScenarioStepOutcome {
  const record = apiRecord(value, ['stepId', 'name', 'state', 'runId', 'status', 'assertionPassed', 'assertionTotal', 'durationMs', 'message'])
  return {
    stepId: parseApiId(record.stepId),
    name: str(record.name, 'step.name', 128),
    state: one(record.state, ['passed', 'failed', 'skipped', 'error'] as const),
    ...(record.runId === undefined ? {} : { runId: parseApiId(record.runId) }),
    status: record.status === null ? null : apiInteger(record.status, 100, 599, 'step.status'),
    assertionPassed: apiInteger(record.assertionPassed, 0, 64, 'step.assertionPassed'),
    assertionTotal: apiInteger(record.assertionTotal, 0, 64, 'step.assertionTotal'),
    durationMs: nullableDuration(record.durationMs),
    ...(record.message === undefined ? {} : { message: str(record.message, 'step.message', 4096) }),
  }
}
/** 解析场景运行摘要；步骤 stepId 必须唯一，避免结果与步骤对不上。 */
export function parseApiScenarioRun(value: unknown): ApiScenarioRun {
  const record = apiRecord(value, ['id', 'workspaceId', 'sessionId', 'source', 'scenarioId', 'scenarioName', 'catalogRevision', 'environmentId', 'state', 'startedAt', 'finishedAt', 'steps', 'assertions', 'error'])
  const steps = list(record.steps, scenarioStepOutcome, API_LIMITS.maxScenarioSteps)
  if (new Set(steps.map((step) => step.stepId)).size !== steps.length) return bad('scenarioRun.steps.duplicateId')
  return {
    id: parseApiId(record.id),
    workspaceId: parseApiId(record.workspaceId),
    sessionId: parseApiId(record.sessionId),
    source: one(record.source, ['manual', 'agent'] as const),
    ...(record.scenarioId === undefined ? {} : { scenarioId: parseApiId(record.scenarioId) }),
    scenarioName: str(record.scenarioName, 'scenarioName', 128),
    catalogRevision: apiInteger(record.catalogRevision, 0, Number.MAX_SAFE_INTEGER, 'catalogRevision'),
    ...(record.environmentId === undefined ? {} : { environmentId: parseApiId(record.environmentId) }),
    state: one(record.state, ['running', 'completed', 'failed', 'cancelled'] as const),
    startedAt: apiInteger(record.startedAt, 0, Number.MAX_SAFE_INTEGER, 'startedAt'),
    ...(record.finishedAt === undefined ? {} : { finishedAt: apiInteger(record.finishedAt, 0, Number.MAX_SAFE_INTEGER, 'finishedAt') }),
    steps,
    assertions: list(record.assertions, (item) => {
      const entry = apiRecord(item, ['id', 'passed', 'expected', 'actual', 'message'])
      return { id: parseApiId(entry.id), passed: bool(entry.passed), expected: str(entry.expected, 'expected', 4096), actual: str(entry.actual, 'actual', 4096), message: str(entry.message, 'message', 4096) }
    }, API_LIMITS.maxScenarioSteps),
    ...(record.error === undefined ? {} : { error: failure(record.error) }),
  }
}
/** 解析运行时变量元数据；出现 value 等取值字段一律拒绝。 */
function runtimeVariable(value: unknown): ApiRuntimeVariable {
  const record = apiRecord(value, ['name', 'secret', 'source', 'updatedAt'])
  const name = str(record.name, 'runtimeVariable.name', 128)
  if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.test(name)) return bad('runtimeVariable.name')
  return {
    name, secret: bool(record.secret), source: str(record.source, 'runtimeVariable.source', 128),
    updatedAt: apiInteger(record.updatedAt, 0, Number.MAX_SAFE_INTEGER, 'runtimeVariable.updatedAt'),
  }
}
/** Cookie 名与域只做形状校验：界面展示用，取值本来就不在这条通道上。 */
const COOKIE_NAME = /^[^\s\x00-\x1f;,"\\]{1,256}$/
const COOKIE_DOMAIN = /^[A-Za-z0-9.:\-[\]]{1,255}$/
/**
 * 解析 Cookie Jar 元数据；出现 value 等取值字段一律拒绝，避免取值从这条通道漏出。
 */
function cookieJarEntry(value: unknown): ApiCookieJarEntry {
  const record = apiRecord(value, ['name', 'domain', 'path', 'secure', 'httpOnly', 'expiresAt', 'updatedAt'])
  const name = str(record.name, 'cookie.name', 256)
  const domain = str(record.domain, 'cookie.domain', 255)
  const path = str(record.path, 'cookie.path', 1024)
  if (!COOKIE_NAME.test(name)) return bad('cookie.name')
  if (!COOKIE_DOMAIN.test(domain)) return bad('cookie.domain')
  if (!path.startsWith('/')) return bad('cookie.path')
  return {
    name, domain, path,
    secure: bool(record.secure), httpOnly: bool(record.httpOnly),
    expiresAt: record.expiresAt === null ? null : apiInteger(record.expiresAt, 0, Number.MAX_SAFE_INTEGER, 'cookie.expiresAt'),
    updatedAt: apiInteger(record.updatedAt, 0, Number.MAX_SAFE_INTEGER, 'cookie.updatedAt'),
  }
}
/** 解析提取结果；只允许结果事实与原因，出现取值字段会被拒绝。 */
function extractionOutcome(value: unknown): ApiExtractionOutcome {
  const record = apiRecord(value, ['id', 'name', 'from', 'found', 'secret', 'message'])
  return {
    id: parseApiId(record.id), name: str(record.name, 'extracted.name', 128),
    from: one(record.from, ['json', 'header', 'sse-last-data']),
    found: bool(record.found), secret: bool(record.secret),
    ...(record.message === undefined ? {} : { message: str(record.message, 'extracted.message', 200) }),
  }
}
/** 解析单条事件流明细；字段有界且不接受未知键。 */
function sseEvent(value: unknown): ApiSseEvent {
  const record = apiRecord(value, ['index', 'receivedMs', 'event', 'id', 'comment', 'data', 'retry', 'raw', 'truncated'])
  return {
    index: apiInteger(record.index, 0, 1_000_000, 'sse.index'),
    receivedMs: apiInteger(record.receivedMs, 0, 86_400_000, 'sse.receivedMs'),
    event: str(record.event, 'sse.event', 256), id: str(record.id, 'sse.id', 256),
    comment: str(record.comment, 'sse.comment', API_LIMITS.sseEventChars),
    data: str(record.data, 'sse.data', API_LIMITS.sseEventChars),
    ...(record.retry === undefined ? {} : { retry: apiInteger(record.retry, 0, 600_000, 'sse.retry') }),
    raw: str(record.raw, 'sse.raw', API_LIMITS.sseEventChars), truncated: bool(record.truncated),
  }
}
/** 解析运行记录里的有界事件明细与计数事实。 */
function sseStream(value: unknown): ApiSseStream {
  const record = apiRecord(value, ['events', 'totalEvents', 'firstEventMs', 'droppedEvents', 'endedReason'])
  return {
    events: list(record.events, sseEvent, API_LIMITS.sseEvents),
    totalEvents: apiInteger(record.totalEvents, 0, 1_000_000, 'sse.totalEvents'),
    firstEventMs: record.firstEventMs === null ? null : apiInteger(record.firstEventMs, 0, 86_400_000, 'sse.firstEventMs'),
    droppedEvents: apiInteger(record.droppedEvents, 0, 1_000_000, 'sse.droppedEvents'),
    endedReason: one(record.endedReason, ['completed', 'cancelled', 'error']),
  }
}
/** 解析正文片段，截断标记与完整原始记录分别表达。 */
function bodySlice(value: unknown): ApiBodySlice {
  const record = apiRecord(value, ['text', 'offset', 'nextOffset', 'totalChars', 'truncated'])
  return { text: str(record.text, 'text', API_LIMITS.previewBytes), offset: apiInteger(record.offset, 0, API_LIMITS.bodyBytes, 'offset'), nextOffset: record.nextOffset === null ? null : apiInteger(record.nextOffset, 0, API_LIMITS.bodyBytes, 'nextOffset'), totalChars: apiInteger(record.totalChars, 0, API_LIMITS.bodyBytes, 'totalChars'), truncated: bool(record.truncated) }
}
/** 按方法验证返回值，再收窄为静态返回合同。 */
export function parseApiResponse<M extends ApiCommandMethod>(method: M, value: unknown): ApiCommandResults[M] {
  let result: unknown
  switch (method) {
    case 'getCatalog': case 'saveCatalog': result = parseApiCatalog(value); break
    case 'prepare': result = parseApiPreparedPreview(value); break
    case 'send': case 'getRun': case 'pinRun': result = parseApiRun(value); break
    case 'readBody': result = bodySlice(value); break
    case 'getRuntimeVariables': {
      const record = apiRecord(value, ['variables'])
      result = { variables: list(record.variables, runtimeVariable, 64) }; break
    }
    case 'clearRuntimeVariables': {
      const record = apiRecord(value, ['cleared'])
      result = { cleared: apiInteger(record.cleared, 0, 64, 'cleared') }; break
    }
    case 'getCookieJar': {
      const record = apiRecord(value, ['cookies'])
      result = { cookies: list(record.cookies, cookieJarEntry, 128) }; break
    }
    case 'clearCookieJar': {
      const record = apiRecord(value, ['cleared'])
      result = { cleared: apiInteger(record.cleared, 0, 128, 'cleared') }; break
    }
    case 'pickApiFiles': {
      const record = apiRecord(value, ['files'])
      /** 回执里只允许元数据；出现路径或字节一律判损坏协议。 */
      result = { files: list(record.files, (item): ApiPickedFile => {
        const entry = apiRecord(item, ['ref', 'fileName', 'sizeBytes', 'contentType'])
        return {
          ref: parseApiId(entry.ref),
          fileName: str(entry.fileName, 'file.fileName', 256),
          sizeBytes: apiInteger(entry.sizeBytes, 0, API_LIMITS.bodyBytes, 'file.sizeBytes'),
          contentType: str(entry.contentType, 'file.contentType', 256),
        }
      }, API_LIMITS.maxFileParts) }; break
    }
    case 'listRuns': {
      const record = apiRecord(value, ['runs', 'nextCursor'])
      result = { runs: list(record.runs, parseApiRun, 50), nextCursor: record.nextCursor === null ? null : apiInteger(record.nextCursor, 0, API_LIMITS.maxRuns, 'nextCursor') }; break
    }
    case 'cancel': if (value !== undefined && value !== null) return bad('cancel.result'); result = undefined; break
  }
  return result as ApiCommandResults[M]
}
/** 事件只含身份与状态，避免把响应正文推送给所有视图。 */
export function parseApiRunChanged(value: unknown): ApiRunChanged {
  const record = apiRecord(value, ['sessionId', 'runId', 'state'])
  return { sessionId: parseApiId(record.sessionId), runId: parseApiId(record.runId), state: one(record.state, ['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted']) }
}
/** 流式事件通知只按上限携带增量，渲染层仍按会话与运行过滤。 */
export function parseApiRunStreamChanged(value: unknown): ApiRunStreamChanged {
  const record = apiRecord(value, ['sessionId', 'runId', 'events'])
  return {
    sessionId: parseApiId(record.sessionId), runId: parseApiId(record.runId),
    events: list(record.events, sseEvent, API_LIMITS.sseDeltaEvents),
  }
}
/** 编译期确认所有 Promise 方法都在 IPC 映射中。 */
type ApiMethodsCovered = Exclude<keyof ApiWorkbenchApi, 'onChanged' | 'onStream'> extends ApiCommandMethod ? true : never
/** 导出覆盖事实便于工具/测试发现新增接口漏接线。 */
export const API_METHODS_COVERED: ApiMethodsCovered = true
