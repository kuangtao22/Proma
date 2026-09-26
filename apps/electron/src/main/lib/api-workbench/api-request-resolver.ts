import { API_LIMITS } from '@proma/shared'
import { randomUUID } from 'node:crypto'
import type {
  ApiCatalog,
  ApiCollection,
  ApiEnvironment,
  ApiField,
  ApiResolvedRequest,
  ApiRequestDraft,
  ApiValue,
} from '@proma/shared'
import { cookieHeaderValue } from './api-cookies'
import type { ApiCookieJarRecord } from './api-cookies'
import { createMultipartBoundary, summarizeMultipart } from './api-multipart'
import type { ApiMultipartPlanPart } from './api-multipart'

/** 秘密解析结果同时携带版本，供 prepared 快照发送前复核。 */
export interface ApiResolvedSecret {
  value: string
  revision: string
}

/** 秘密解析请求绑定 workspace 内具体字段 owner，禁止引用横向移植。 */
export interface ApiSecretLookup {
  ref: string
  owner: string
}

/** 请求解析依赖，调用方只提供当前 workspace 已授权的目录与秘密解析器。 */
export interface ResolveApiRequestInput {
  catalog: ApiCatalog
  request: ApiRequestDraft
  requestId?: string
  environmentId?: string
  overrides?: ApiField[]
  /** 本次会话提取出的运行时变量；优先级高于环境变量、低于显式单次覆盖。 */
  runtimeVariables?: ApiField[]
  /** 当前 workspace 的 cookie；只有请求开启自动 Cookie 时才会被调用方传入。 */
  cookieJar?: readonly ApiCookieJarRecord[]
  /** 判定 cookie 是否过期用的时间；默认取当前时间。 */
  now?: number
  /** 解析文件引用；只有 multipart 请求会用到，返回 undefined 表示引用已失效。 */
  resolveFile?: (ref: string) => { fileName: string; sizeBytes: number; contentType: string } | undefined
  /** multipart 边界生成器，便于测试固定输出。 */
  createBoundary?: () => string
  resolveSecret: (lookup: ApiSecretLookup) => ApiResolvedSecret | undefined
}

/** 解析结果保留秘密版本和明文集合，前者用于失效检查，后者仅用于脱敏。 */
export interface ResolveApiRequestResult {
  request: ApiResolvedRequest
  environmentKind?: 'local' | 'test' | 'production'
  secretRevisions: Record<string, string>
  secretValues: string[]
  /**
   * multipart 的待发计划：文本字段已解析完毕，文件部分只带引用与元数据。
   * 真实字节由服务层读取（含上限与失效复核）后合成 base64 正文，本层不做 IO。
   */
  multipart?: {
    boundary: string
    parts: Array<
      | { kind: 'field'; name: string; value: string }
      | { kind: 'file'; name: string; fileName: string; contentType: string; sizeBytes: number; ref: string }
    >
  }
}

interface VariableValue {
  value: string
  secret: boolean
}

/**
 * 合并变量作用域链：工作区 < 集合 < 环境 < 运行时 < 单次覆盖。
 * 请求解析与加密密钥解析共用这一条链路，避免「模板里取到的值」和「签名用的密钥」来自不同作用域。
 */
function mergeVariables(input: {
  catalog: ApiCatalog
  collection: ApiCollection
  environment?: ApiEnvironment
  overrides?: ApiField[]
  runtimeVariables?: ApiField[]
  resolveSecret: (lookup: ApiSecretLookup) => ApiResolvedSecret | undefined
  secretRevisions: Record<string, string>
  secretValues: Set<string>
}): Map<string, VariableValue> {
  const variables = new Map<string, VariableValue>()
  /** 工作区级变量优先级最低：集合、环境、运行时与单次覆盖都能盖掉它。 */
  applyVariables(variables, input.catalog.workspaceVariables ?? [], 'workspace:variable', input.resolveSecret, input.secretRevisions, input.secretValues)
  applyVariables(variables, input.collection.variables, `collection:${input.collection.id}:variable`, input.resolveSecret, input.secretRevisions, input.secretValues)
  if (input.environment) applyVariables(variables, input.environment.variables, `environment:${input.environment.id}:variable`, input.resolveSecret, input.secretRevisions, input.secretValues)
  if (input.runtimeVariables) applyVariables(variables, input.runtimeVariables, 'runtime:variable', input.resolveSecret, input.secretRevisions, input.secretValues)
  if (input.overrides) applyVariables(variables, input.overrides, 'override:runtime:variable', input.resolveSecret, input.secretRevisions, input.secretValues)
  return variables
}

/** 加密密钥解析输入：只按名字取被方案显式引用的变量。 */
export interface ResolveApiCryptoSecretsInput {
  catalog: ApiCatalog
  /** 请求所属集合 id：决定集合级变量层。 */
  collectionId: string
  environmentId?: string
  overrides?: ApiField[]
  runtimeVariables?: ApiField[]
  /** 方案里引用的密钥变量名（keyRef / ivRef 去重后）。 */
  names: readonly string[]
  resolveSecret: (lookup: ApiSecretLookup) => ApiResolvedSecret | undefined
}

/**
 * 解析加密方案需要的密钥取值。
 * 只返回被显式点名的变量：方案没引用到的变量不会因为这条路径被读出来；
 * 找不到或取值为空的变量直接缺席，由编排层判成「缺密钥」并跳过该步。
 */
export function resolveApiCryptoSecrets(input: ResolveApiCryptoSecretsInput): Record<string, string> {
  const collection = input.catalog.collections.find((item) => item.id === input.collectionId)
  if (!collection) throw new Error('API_WORKBENCH_COLLECTION_NOT_FOUND')
  const environment = input.environmentId ? input.catalog.environments.find((item) => item.id === input.environmentId) : undefined
  if (input.environmentId && !environment) throw new Error('API_WORKBENCH_ENVIRONMENT_NOT_FOUND')
  const variables = mergeVariables({
    catalog: input.catalog,
    collection,
    ...(environment ? { environment } : {}),
    ...(input.overrides ? { overrides: input.overrides } : {}),
    ...(input.runtimeVariables ? { runtimeVariables: input.runtimeVariables } : {}),
    resolveSecret: input.resolveSecret,
    secretRevisions: {},
    secretValues: new Set<string>(),
  })
  const secrets: Record<string, string> = {}
  for (const name of input.names) {
    const found = variables.get(name)
    if (found?.value) secrets[name] = found.value
  }
  return secrets
}

/** 模板变量名称保持简单稳定，避免模板本身成为表达式执行入口。 */
const TEMPLATE_PATTERN = /\{\{([A-Za-z_][A-Za-z0-9_.-]{0,127})\}\}/g
const COMMON_SENSITIVE_NAME = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api[-_]?key|token|access[-_]?token|refresh[-_]?token|password|passwd|secret|client[-_]?secret)$/i

/** 读取字段值；secretRef 必须匹配调用方传入的精确 owner。 */
function resolveValue(
  value: ApiValue,
  owner: string,
  resolveSecret: ResolveApiRequestInput['resolveSecret'],
  secretRevisions: Record<string, string>,
  secretValues: Set<string>,
): VariableValue {
  if (value.secretRef) {
    const resolved = resolveSecret({ ref: value.secretRef, owner })
    if (!resolved) throw new Error('API_WORKBENCH_SECRET_NOT_FOUND')
    secretRevisions[value.secretRef] = resolved.revision
    if (resolved.value) secretValues.add(resolved.value)
    return { value: resolved.value, secret: true }
  }
  if (value.secret && value.value) secretValues.add(value.value)
  return { value: value.value, secret: value.secret === true }
}

/** 将一层变量写入映射；后写入层覆盖前一层。 */
function applyVariables(
  target: Map<string, VariableValue>,
  fields: readonly ApiField[],
  ownerPrefix: string,
  resolveSecret: ResolveApiRequestInput['resolveSecret'],
  secretRevisions: Record<string, string>,
  secretValues: Set<string>,
): void {
  for (const field of fields) {
    if (!field.enabled || !field.name) continue
    target.set(field.name, resolveValue(field, `${ownerPrefix}:${field.id}`, resolveSecret, secretRevisions, secretValues))
  }
}

/** 字节预算在每次变量展开前检查，避免先生成巨大正文再截断。 */
function checkRequestBytes(bytes: number): number {
  if (bytes > API_LIMITS.requestBytes) throw new Error('API_WORKBENCH_REQUEST_TOO_LARGE: 请求上限为 1 MiB')
  return bytes
}

/** 替换模板并在缺失变量时 fail closed。 */
function interpolate(value: string, variables: ReadonlyMap<string, VariableValue>, encode: (value: string) => string): string {
  let bytes = checkRequestBytes(Buffer.byteLength(value))
  return value.replace(TEMPLATE_PATTERN, (match, name: string) => {
    const variable = variables.get(name)
    if (!variable) throw new Error(`API_WORKBENCH_VARIABLE_UNRESOLVED:${name}`)
    const replacement = encode(variable.value)
    bytes = checkRequestBytes(bytes + Buffer.byteLength(replacement) - Buffer.byteLength(match))
    return replacement
  })
}

/** 判断模板是否引用任一秘密变量，用于把 taint 传播到目标 Header/query。 */
function containsSecretTemplate(value: string, variables: ReadonlyMap<string, VariableValue>): boolean {
  for (const match of value.matchAll(TEMPLATE_PATTERN)) {
    if (variables.get(match[1]!)?.secret) return true
  }
  return false
}

/** URL 起始位置允许变量提供完整 http(s) origin，其余位置按 URL component 编码。 */
function interpolateUrl(value: string, variables: ReadonlyMap<string, VariableValue>): string {
  let first = true
  let bytes = checkRequestBytes(Buffer.byteLength(value))
  return value.replace(TEMPLATE_PATTERN, (match, name: string) => {
    const variable = variables.get(name)
    if (!variable) throw new Error(`API_WORKBENCH_VARIABLE_UNRESOLVED:${name}`)
    const atOrigin = first && value.startsWith(`{{${name}}}`) && /^https?:\/\//i.test(variable.value)
    first = false
    const replacement = atOrigin ? variable.value.replace(/\/$/, '') : encodeURIComponent(variable.value)
    bytes = checkRequestBytes(bytes + Buffer.byteLength(replacement) - Buffer.byteLength(match))
    return replacement
  })
}

/** 在解析秘密前先拒绝明显缺失的模板名，使错误不受未使用秘密影响。 */
function assertTemplateNamesKnown(source: string, knownNames: ReadonlySet<string>): void {
  for (const match of source.matchAll(TEMPLATE_PATTERN)) {
    if (!knownNames.has(match[1]!)) throw new Error(`API_WORKBENCH_VARIABLE_UNRESOLVED:${match[1]}`)
  }
}

/** JSON 字符串内部只转义内容，不添加包围引号。 */
function escapeJsonString(value: string): string {
  return JSON.stringify(value).slice(1, -1)
}

/**
 * 在不 stringify 整棵对象的前提下替换 JSON 模板。
 * 字符串内按 JSON 转义，字符串外保留调用方提供的 JSON token，从而不改写大整数。
 */
function interpolateJson(source: string, variables: ReadonlyMap<string, VariableValue>): string {
  let result = ''
  let bytes = checkRequestBytes(Buffer.byteLength(source))
  let index = 0
  let inString = false
  let escaped = false
  while (index < source.length) {
    const character = source[index]!
    if (character === '"' && !escaped) inString = !inString
    escaped = character === '\\' && !escaped
    if (character !== '\\') escaped = false
    if (source.startsWith('{{', index)) {
      const end = source.indexOf('}}', index + 2)
      if (end < 0) throw new Error('API_WORKBENCH_VARIABLE_UNRESOLVED')
      const name = source.slice(index + 2, end)
      const variable = variables.get(name)
      if (!variable) throw new Error(`API_WORKBENCH_VARIABLE_UNRESOLVED:${name}`)
      const replacement = inString ? escapeJsonString(variable.value) : variable.value
      bytes = checkRequestBytes(bytes + Buffer.byteLength(replacement) - Buffer.byteLength(source.slice(index, end + 2)))
      result += replacement
      index = end + 2
      continue
    }
    result += character
    index += 1
  }
  try { JSON.parse(result) } catch { throw new Error('API_WORKBENCH_JSON_INVALID') }
  return result
}

/** 解析请求快照，按 override > environment > collection 合并变量。 */
export function resolveApiRequest(input: ResolveApiRequestInput): ResolveApiRequestResult {
  const collection = input.catalog.collections.find((item) => item.id === input.request.collectionId)
  if (!collection) throw new Error('API_WORKBENCH_COLLECTION_NOT_FOUND')
  const environment = input.environmentId
    ? input.catalog.environments.find((item) => item.id === input.environmentId)
    : undefined
  if (input.environmentId && !environment) throw new Error('API_WORKBENCH_ENVIRONMENT_NOT_FOUND')

  const knownNames = new Set<string>()
  /** 工作区级变量同样参与模板解析，必须计入已知变量名，否则 URL 用 {{baseUrl}} 会被误判为未知模板。 */
  for (const field of [...(input.catalog.workspaceVariables ?? []), ...collection.variables, ...(environment?.variables ?? []), ...(input.overrides ?? [])]) {
    if (field.enabled && field.name) knownNames.add(field.name)
  }
  assertTemplateNamesKnown(input.request.url, knownNames)

  const secretRevisions: Record<string, string> = {}
  const secretValues = new Set<string>()
  const variables = mergeVariables({
    catalog: input.catalog,
    collection,
    ...(environment ? { environment } : {}),
    ...(input.overrides ? { overrides: input.overrides } : {}),
    ...(input.runtimeVariables ? { runtimeVariables: input.runtimeVariables } : {}),
    resolveSecret: input.resolveSecret,
    secretRevisions,
    secretValues,
  })

  const rawUrl = interpolateUrl(input.request.url, variables)
  let url: URL
  try { url = new URL(rawUrl) } catch { throw new Error('API_WORKBENCH_URL_INVALID') }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('API_WORKBENCH_URL_INVALID')
  if (url.username || url.password) throw new Error('API_WORKBENCH_URL_CREDENTIALS_FORBIDDEN')
  const sensitiveQueryNames: string[] = []
  const sourceQuery = input.request.url.split('?', 2)[1]?.split('#', 1)[0] ?? ''
  for (const segment of sourceQuery.split('&')) {
    const separator = segment.indexOf('=')
    if (separator < 0 || !containsSecretTemplate(segment.slice(separator + 1), variables)) continue
    const sourceName = segment.slice(0, separator)
    sensitiveQueryNames.push(interpolate(sourceName, variables, (value) => value))
  }
  for (const field of input.request.query) {
    if (!field.enabled || !field.name) continue
    const owner = `request:${input.requestId ?? 'draft'}:query:${field.id}`
    const resolved = resolveValue(field, owner, input.resolveSecret, secretRevisions, secretValues)
    const name = interpolate(field.name, variables, (value) => value)
    const value = interpolate(resolved.value, variables, (item) => item)
    url.searchParams.append(name, value)
    if (resolved.secret || containsSecretTemplate(field.value, variables) || COMMON_SENSITIVE_NAME.test(name)) sensitiveQueryNames.push(name)
  }

  const headers: ApiResolvedRequest['headers'] = []
  const sensitiveHeaderNames: string[] = []
  for (const field of input.request.headers) {
    if (!field.enabled || !field.name) continue
    const owner = `request:${input.requestId ?? 'draft'}:header:${field.id}`
    const resolved = resolveValue(field, owner, input.resolveSecret, secretRevisions, secretValues)
    const name = interpolate(field.name, variables, (value) => value)
    const value = interpolate(resolved.value, variables, (item) => item)
    if (/[\r\n]/.test(name + value)) throw new Error('API_WORKBENCH_HEADER_INVALID')
    headers.push({ name, value, source: 'user' })
    if (resolved.secret || containsSecretTemplate(field.value, variables) || COMMON_SENSITIVE_NAME.test(name)) sensitiveHeaderNames.push(name)
  }

  /**
   * 自动 Cookie 默认关闭：关闭时既不读也不写，行为与升级前完全一致。
   * 草稿里已经显式写了 Cookie 头时以人的写法为准，不再叠加 jar。
   */
  if (input.request.useCookieJar && (input.cookieJar?.length ?? 0) > 0 && !headers.some((header) => header.name.toLowerCase() === 'cookie')) {
    /** 按插值后的最终 URL 选值：host、路径、协议与过期时间都参与匹配。 */
    const cookieHeader = cookieHeaderValue(input.cookieJar ?? [], url, input.now ?? Date.now())
    if (cookieHeader) {
      headers.push({ name: 'Cookie', value: cookieHeader, source: 'generated' })
      /** 注入的 cookie 视为敏感头，运行记录与预览按既有规则脱敏。 */
      sensitiveHeaderNames.push('Cookie')
    }
  }

  const auth = input.request.auth
  if (auth.type !== 'none') {
    const owner = `request:${input.requestId ?? 'draft'}:auth:value`
    const resolved = resolveValue(auth.value, owner, input.resolveSecret, secretRevisions, secretValues)
    const value = interpolate(resolved.value, variables, (item) => item)
    if (!value) throw new Error('API_WORKBENCH_AUTH_EMPTY')
    secretValues.add(value)
    if (auth.type === 'bearer') {
      headers.push({ name: 'Authorization', value: `Bearer ${value}`, source: 'generated' })
      sensitiveHeaderNames.push('Authorization')
    } else if (auth.type === 'basic') {
      const basicValue = `Basic ${Buffer.from(`${auth.username ?? ''}:${value}`).toString('base64')}`
      headers.push({ name: 'Authorization', value: basicValue, source: 'generated' })
      secretValues.add(basicValue)
      sensitiveHeaderNames.push('Authorization')
    } else if (auth.in === 'query') {
      const name = auth.name || 'api_key'
      url.searchParams.append(name, value)
      sensitiveQueryNames.push(name)
    } else {
      const name = auth.name || 'X-API-Key'
      headers.push({ name, value, source: 'generated' })
      sensitiveHeaderNames.push(name)
    }
  }

  let body = ''
  /** multipart 的待发计划；文件字节由服务层读取后合成。 */
  let multipart: ResolveApiRequestResult['multipart']
  if (input.request.body.kind === 'json') {
    body = interpolateJson(input.request.body.text, variables)
    if (!headers.some((header) => header.name.toLowerCase() === 'content-type')) {
      headers.push({ name: 'Content-Type', value: 'application/json', source: 'generated' })
    }
  } else if (input.request.body.kind === 'text') {
    body = interpolate(input.request.body.text, variables, (value) => value)
  } else if (input.request.body.kind === 'urlencoded') {
    const form = new URLSearchParams()
    for (const field of input.request.body.fields) {
      if (!field.enabled || !field.name) continue
      const owner = `request:${input.requestId ?? 'draft'}:body:${field.id}`
      const resolved = resolveValue(field, owner, input.resolveSecret, secretRevisions, secretValues)
      form.append(interpolate(field.name, variables, (value) => value), interpolate(resolved.value, variables, (value) => value))
      checkRequestBytes(Buffer.byteLength(form.toString()))
      if (resolved.secret || containsSecretTemplate(field.value, variables)) {
        const encoded = new URLSearchParams([['value', interpolate(resolved.value, variables, (value) => value)]]).toString().slice('value='.length)
        if (encoded) secretValues.add(encoded)
      }
    }
    body = form.toString()
    if (!headers.some((header) => header.name.toLowerCase() === 'content-type')) {
      headers.push({ name: 'Content-Type', value: 'application/x-www-form-urlencoded', source: 'generated' })
    }
  } else if (input.request.body.kind === 'multipart') {
    /** 边界每次都重新生成，避免跨请求复用一个可预测的分隔符。 */
    const boundary = input.createBoundary?.() ?? createMultipartBoundary(randomUUID())
    const parts: ApiMultipartPlanPart[] = []
    for (const field of input.request.body.fields) {
      if (!field.enabled || !field.name) continue
      const owner = `request:${input.requestId ?? 'draft'}:body:${field.id}`
      const resolved = resolveValue(field, owner, input.resolveSecret, secretRevisions, secretValues)
      const value = interpolate(resolved.value, variables, (item) => item)
      /** 文本字段同样可能是秘密：取值只用于发送与脱敏，不进公开投影的明文之外的地方。 */
      if (resolved.secret || containsSecretTemplate(field.value, variables)) secretValues.add(value)
      parts.push({ kind: 'field', name: interpolate(field.name, variables, (item) => item), value })
    }
    for (const file of input.request.body.files ?? []) {
      const meta = input.resolveFile?.(file.ref)
      /** 引用失效必须在这里拒绝：否则会静默发出不带附件的请求。 */
      if (!meta) throw new Error('API_WORKBENCH_FILE_REF_NOT_FOUND: 所选文件已失效，请重新选择文件')
      parts.push({
        kind: 'file',
        name: interpolate(file.name, variables, (item) => item),
        fileName: meta.fileName,
        contentType: file.contentType ?? meta.contentType,
        sizeBytes: meta.sizeBytes,
        ref: file.ref,
      })
    }
    if (parts.length === 0) throw new Error('API_WORKBENCH_MULTIPART_EMPTY: multipart 请求至少需要一个字段或文件')
    multipart = { boundary, parts }
    /** 公开投影只保留结构摘要：文件字节绝不进入运行记录与模型上下文。 */
    body = summarizeMultipart(boundary, parts)
    if (!headers.some((header) => header.name.toLowerCase() === 'content-type')) {
      headers.push({ name: 'Content-Type', value: `multipart/form-data; boundary=${boundary}`, source: 'generated' })
    }
  }

  checkRequestBytes(Buffer.byteLength(body) + Buffer.byteLength(url.toString()) + headers.reduce((sum, header) => sum + Buffer.byteLength(header.name) + Buffer.byteLength(header.value), 0))
  if ([...secretValues].reduce((sum, value) => sum + Buffer.byteLength(value), 0) > API_LIMITS.requestBytes) throw new Error('API_WORKBENCH_SECRET_BUDGET_EXCEEDED')
  return {
    request: {
      method: input.request.method,
      url: url.toString(),
      headers,
      body,
      timeoutMs: input.request.timeoutMs,
      followRedirects: input.request.followRedirects,
      maxRedirects: input.request.maxRedirects,
      sensitiveHeaderNames: [...new Set(sensitiveHeaderNames.map((name) => name.toLowerCase()))],
      sensitiveQueryNames: [...new Set(sensitiveQueryNames)],
    },
    ...(environment ? { environmentKind: environment.kind } : {}),
    secretRevisions,
    secretValues: [...secretValues].filter(Boolean),
    ...(multipart ? { multipart } : {}),
  }
}
