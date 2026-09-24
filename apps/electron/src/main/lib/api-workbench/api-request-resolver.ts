import { API_LIMITS } from '@proma/shared'
import type {
  ApiCatalog,
  ApiField,
  ApiResolvedRequest,
  ApiRequestDraft,
  ApiValue,
} from '@proma/shared'

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
  resolveSecret: (lookup: ApiSecretLookup) => ApiResolvedSecret | undefined
}

/** 解析结果保留秘密版本和明文集合，前者用于失效检查，后者仅用于脱敏。 */
export interface ResolveApiRequestResult {
  request: ApiResolvedRequest
  environmentKind?: 'local' | 'test' | 'production'
  secretRevisions: Record<string, string>
  secretValues: string[]
}

interface VariableValue {
  value: string
  secret: boolean
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
  for (const field of [...collection.variables, ...(environment?.variables ?? []), ...(input.overrides ?? [])]) {
    if (field.enabled && field.name) knownNames.add(field.name)
  }
  assertTemplateNamesKnown(input.request.url, knownNames)

  const secretRevisions: Record<string, string> = {}
  const secretValues = new Set<string>()
  const variables = new Map<string, VariableValue>()
  applyVariables(variables, collection.variables, `collection:${collection.id}:variable`, input.resolveSecret, secretRevisions, secretValues)
  if (environment) applyVariables(variables, environment.variables, `environment:${environment.id}:variable`, input.resolveSecret, secretRevisions, secretValues)
  if (input.runtimeVariables) applyVariables(variables, input.runtimeVariables, 'runtime:variable', input.resolveSecret, secretRevisions, secretValues)
  if (input.overrides) applyVariables(variables, input.overrides, 'override:runtime:variable', input.resolveSecret, secretRevisions, secretValues)

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
  }
}
