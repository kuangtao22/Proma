import type {
  ApiAuth,
  ApiField,
  ApiMethod,
  ApiRequestBody,
  ApiRequestDraft,
} from './api-workbench'
import { parseApiRequestDraft } from './api-workbench'

/** 一次解析允许的最大字符数，避免超长粘贴占满渲染层主线程。 */
export const API_CURL_MAX_INPUT = 256 * 1024
/** 一次导入允许的最大命令条数。 */
export const API_CURL_MAX_COMMANDS = 32
/** 单条命令允许的最大参数个数，纯防御性上限。 */
const API_CURL_MAX_TOKENS = 8_192
/** 与工作台方法白名单一致；不在此列的方法不能静默降级。 */
const SUPPORTED_METHODS: readonly ApiMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']
/** 与存储层一致的敏感名称判定：命中即把字段标记为秘密。 */
const COMMON_SENSITIVE_NAME = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api[-_]?key|token|access[-_]?token|refresh[-_]?token|password|passwd|secret|client[-_]?secret)$/i
/** Header 名称必须满足 HTTP 令牌字符集。 */
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

/** 需要取值且已翻译的选项。 */
const VALUE_SUPPORTED = new Set([
  '-X', '--request', '-H', '--header', '-d', '--data', '--data-raw', '--data-binary', '--data-urlencode',
  '-u', '--user', '--url', '-m', '--max-time', '-b', '--cookie', '--json', '-A', '--user-agent', '-e', '--referer',
])
/** 需要取值但本期不翻译的选项：跳过取值本身，只记录说明。 */
const VALUE_IGNORED = new Set([
  '-o', '--output', '-x', '--proxy', '--connect-timeout', '--retry', '-w', '--write-out', '-c', '--cookie-jar',
  '-U', '--proxy-user', '--url-query', '--proto', '--limit-rate', '--resolve', '--interface', '-E',
])
/** 会读取本机文件或改变 TLS 信任的取值选项：整条命令不导入。 */
const VALUE_FATAL = new Map<string, string>([
  ['-F', 'multipart 表单与文件上传属于阶段 B2'],
  ['--form', 'multipart 表单与文件上传属于阶段 B2'],
  ['-T', '上传本机文件尚未支持'],
  ['--upload-file', '上传本机文件尚未支持'],
  ['--cert', '自定义客户端证书尚未支持'],
  ['--key', '自定义客户端证书私钥尚未支持'],
  ['--cacert', '自定义 CA 证书尚未支持'],
  ['-n', 'netrc 凭据文件尚未支持'],
  ['--netrc', 'netrc 凭据文件尚未支持'],
])
/** 只影响 curl 终端输出的开关，可安全忽略且不产生提示。 */
const FLAG_SILENT = new Set([
  '-s', '-S', '-v', '-i', '-f', '-g', '-N', '-4', '-6', '--silent', '--show-error', '--verbose', '--include',
  '--fail', '--globoff', '--no-buffer', '--http1.1', '--no-progress-meter', '--fail-with-body', '--path-as-is', '--raw',
])

/** 导入结果：草稿与需要用户知情的偏差分开返回。 */
export interface ApiCurlImportResult {
  /** 可直接载入编辑器或保存的请求草稿。 */
  drafts: ApiRequestDraft[]
  /** 未翻译或刻意拒绝的选项说明；只描述选项，不包含字段值。 */
  unsupported: string[]
  /** 已翻译但与 curl 行为不同的偏差说明。 */
  warnings: string[]
}

/** 导出结果：命令与被替换的秘密位置分开返回。 */
export interface ApiCurlExportResult {
  /** 可直接粘贴执行的 cURL 命令。 */
  command: string
  /** 被替换为变量占位符的字段名，用于界面提示。 */
  redactedSecrets: string[]
}

/** 导入过程中的可变状态，按命令独立创建。 */
interface CurlCommandState {
  method?: ApiMethod
  explicitUrl?: string
  positional: string[]
  headers: ApiField[]
  data: string[]
  getMode: boolean
  headMode: boolean
  jsonMode: boolean
  followRedirects: boolean
  timeoutMs?: number
  username?: string
  password?: string
  unsupported: string[]
  warnings: string[]
  fatal: boolean
}

/** 分词结果附带是否出现命令替换证据。 */
interface TokenizeOutcome {
  tokens: string[]
  substitution: boolean
}

/** 取消标记；解析层面的致命错误必须显式抛出，不静默返回空结果。 */
function invalidCurl(reason: string): never {
  throw new Error(`API_CURL_INVALID: ${reason}`)
}

/** 截断用于提示的文本，避免把超长输入原样回显到界面。 */
function brief(value: string, max = 200): string {
  const trimmed = value.trim()
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed
}

/** 容错解码表单字段；非法百分号编码时退回原文，避免抛异常中断导入。 */
function decodeFormPart(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '))
  } catch {
    return value
  }
}

/**
 * 把一条命令拆成参数。
 * @param command 去掉 `curl` 前缀后的命令文本。
 * @returns 参数数组，以及是否检测到命令替换或反引号。
 */
function tokenizeCommand(command: string): TokenizeOutcome {
  const tokens: string[] = []
  let current = ''
  let started = false
  let inSingle = false
  let inDouble = false
  let substitution = false

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!
    if (inSingle) {
      if (char === "'") {
        inSingle = false
        continue
      }
      current += char
      continue
    }
    if (inDouble) {
      if (char === '"') {
        inDouble = false
        continue
      }
      if (char === '\\' && index + 1 < command.length) {
        const next = command[index + 1]!
        if (next === '"' || next === '\\' || next === '$' || next === '`') {
          current += next
          index += 1
          continue
        }
        current += char
        continue
      }
      if (char === '`' || (char === '$' && command[index + 1] === '(')) substitution = true
      current += char
      continue
    }
    if (char === "'") {
      inSingle = true
      started = true
      continue
    }
    if (char === '"') {
      inDouble = true
      started = true
      continue
    }
    if (char === '\\' && index + 1 < command.length) {
      current += command[index + 1]!
      index += 1
      started = true
      continue
    }
    if (/\s/.test(char)) {
      if (started) {
        tokens.push(current)
        current = ''
        started = false
      }
      continue
    }
    if (char === '`' || (char === '$' && command[index + 1] === '(')) substitution = true
    current += char
    started = true
  }

  if (inSingle || inDouble) invalidCurl('引号未闭合')
  if (started) tokens.push(current)
  if (tokens.length > API_CURL_MAX_TOKENS) invalidCurl('参数个数超过上限')
  return { tokens, substitution }
}

/** 按顶层 `&&` 切分一行；引号内的 `&&` 属于数据本身。 */
function splitTopLevelAnd(line: string): string[] {
  const parts: string[] = []
  let current = ''
  let inSingle = false
  let inDouble = false

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!
    if (inSingle) {
      current += char
      if (char === "'") inSingle = false
      continue
    }
    if (inDouble) {
      if (char === '\\' && index + 1 < line.length) {
        current += char + line[index + 1]!
        index += 1
        continue
      }
      current += char
      if (char === '"') inDouble = false
      continue
    }
    if (char === "'" || char === '"') {
      if (char === "'") inSingle = true
      else inDouble = true
      current += char
      continue
    }
    if (char === '\\' && index + 1 < line.length) {
      current += char + line[index + 1]!
      index += 1
      continue
    }
    if (char === '&' && line[index + 1] === '&') {
      parts.push(current)
      current = ''
      index += 1
      continue
    }
    current += char
  }

  parts.push(current)
  return parts
}

/** 把整段粘贴内容拆成命令，并忽略说明文字。 */
function splitCurlCommands(input: string, warnings: string[]): string[] {
  if (input.length > API_CURL_MAX_INPUT) invalidCurl(`粘贴内容超过 ${API_CURL_MAX_INPUT} 字符上限`)
  /** 先把反斜杠换行合并，跨行参数才会归属同一条命令。 */
  const joined = input.replace(/\\(?:\r\n|\r|\n)/g, ' ')
  const commands: string[] = []
  let ignored = 0

  for (const line of joined.split(/\r?\n/)) {
    for (const piece of splitTopLevelAnd(line)) {
      const candidate = piece.trim().replace(/^[>$]\s*/, '')
      if (candidate === '') continue
      const prefix = /^curl(?:\.exe)?(?:\s|$)/i.exec(candidate)
      if (!prefix) {
        ignored += 1
        continue
      }
      commands.push(candidate.slice(prefix[0].length).trim())
    }
  }

  if (ignored > 0) warnings.push(`已忽略 ${ignored} 行非 curl 内容`)
  if (commands.length === 0) invalidCurl('未找到可解析的 curl 命令')
  if (commands.length > API_CURL_MAX_COMMANDS) invalidCurl(`一次最多导入 ${API_CURL_MAX_COMMANDS} 条命令`)
  return commands
}

/** 创建单条命令的初始状态。 */
function createCommandState(): CurlCommandState {
  return {
    positional: [], headers: [], data: [], getMode: false, headMode: false, jsonMode: false,
    followRedirects: false, unsupported: [], warnings: [], fatal: false,
  }
}

/**
 * 翻译单条命令的参数。
 * @param tokens 已分词的参数。
 * @param commandIndex 命令序号，从 1 开始。
 * @param state 待填充的可变状态。
 */
function translateCommand(tokens: readonly string[], commandIndex: number, state: CurlCommandState): void {
  let cursor = 0
  let fieldSeed = 0
  /** 每次新增字段行都使用命令内唯一的编辑身份。 */
  const nextFieldId = (): string => {
    fieldSeed += 1
    return `curl${commandIndex}f${fieldSeed}`
  }

  while (cursor < tokens.length) {
    const token = tokens[cursor]!
    if (token === '--') {
      cursor += 1
      while (cursor < tokens.length) {
        state.positional.push(tokens[cursor]!)
        cursor += 1
      }
      break
    }
    if (!token.startsWith('-') || token === '-') {
      state.positional.push(token)
      cursor += 1
      continue
    }

    let name = token
    let inlineValue: string | undefined
    if (token.startsWith('--')) {
      const separator = token.indexOf('=')
      if (separator > 1) {
        name = token.slice(0, separator)
        inlineValue = token.slice(separator + 1)
      }
    } else if (token.length > 2) {
      const head = token.slice(0, 2)
      if (VALUE_SUPPORTED.has(head) || VALUE_IGNORED.has(head) || VALUE_FATAL.has(head)) {
        name = head
        inlineValue = token.slice(2)
      } else if ([...token.slice(1)].every((char) => FLAG_SILENT.has(`-${char}`))) {
        cursor += 1
        continue
      }
    }

    const takesValue = VALUE_SUPPORTED.has(name) || VALUE_IGNORED.has(name) || VALUE_FATAL.has(name)
    let value = inlineValue
    if (takesValue && value === undefined) {
      value = tokens[cursor + 1]
      cursor += 1
      if (value === undefined) {
        state.unsupported.push(`${name} 缺少取值，已忽略`)
        break
      }
    }
    cursor += 1

    const fatalReason = VALUE_FATAL.get(name)
    if (fatalReason) {
      state.fatal = true
      state.unsupported.push(`${name} 未支持：${fatalReason}，已跳过该命令`)
      continue
    }

    if (name === '-X' || name === '--request') {
      const upper = (value ?? '').toUpperCase()
      if ((SUPPORTED_METHODS as readonly string[]).includes(upper)) state.method = upper as ApiMethod
      else {
        state.fatal = true
        state.unsupported.push(`请求方法 ${brief(upper, 32)} 不在支持范围，已跳过该命令`)
      }
      continue
    }
    if (name === '-H' || name === '--header') {
      const raw = value ?? ''
      if (raw.startsWith('@')) {
        state.fatal = true
        state.unsupported.push(`${name} ${brief(raw, 80)} 引用了本机文件：工作台未读取文件，已跳过该命令`)
        continue
      }
      const colon = raw.indexOf(':')
      const semicolon = raw.indexOf(';')
      if (colon < 0 && semicolon < 0) {
        state.unsupported.push(`请求头 "${brief(raw, 64)}" 缺少冒号，已忽略`)
        continue
      }
      const cut = colon >= 0 && (semicolon < 0 || colon < semicolon) ? colon : semicolon
      const headerName = raw.slice(0, cut).trim()
      const headerValue = cut === colon ? raw.slice(colon + 1).replace(/^\s+/, '') : ''
      if (!HEADER_NAME_PATTERN.test(headerName) || /[\r\n]/.test(headerValue)) {
        state.unsupported.push(`请求头 "${brief(headerName, 64)}" 名称或取值非法，已忽略`)
        continue
      }
      state.headers.push({
        id: nextFieldId(),
        name: headerName,
        value: headerValue,
        enabled: true,
        ...(COMMON_SENSITIVE_NAME.test(headerName) ? { secret: true } : {}),
      })
      continue
    }
    if (name === '-d' || name === '--data' || name === '--data-raw' || name === '--data-binary' || name === '--data-urlencode') {
      const raw = value ?? ''
      if (raw.startsWith('@')) {
        state.fatal = true
        state.unsupported.push(`${name} ${brief(raw, 80)} 引用了本机文件：工作台未读取文件，已跳过该命令`)
        continue
      }
      if (name === '--data-urlencode') {
        const separator = raw.indexOf('=')
        if (separator > 0) {
          state.data.push(`${raw.slice(0, separator)}=${encodeURIComponent(raw.slice(separator + 1))}`)
          continue
        }
        state.warnings.push('--data-urlencode 的无名形式按原文提交')
        state.data.push(encodeURIComponent(raw))
        continue
      }
      state.data.push(raw)
      continue
    }
    if (name === '-u' || name === '--user') {
      const raw = value ?? ''
      const separator = raw.indexOf(':')
      if (separator < 0) {
        state.warnings.push('需要交互输入密码的 -u 形式未支持，已忽略鉴权')
        continue
      }
      state.username = raw.slice(0, separator)
      state.password = raw.slice(separator + 1)
      continue
    }
    if (name === '--url') {
      state.explicitUrl = value ?? ''
      continue
    }
    if (name === '-m' || name === '--max-time') {
      const seconds = Number(value)
      if (!Number.isFinite(seconds) || seconds <= 0) {
        state.warnings.push(`${name} ${brief(value ?? '', 32)} 无法识别，已使用默认超时`)
        continue
      }
      const milliseconds = Math.round(seconds * 1000)
      state.timeoutMs = Math.min(300_000, Math.max(100, milliseconds))
      if (state.timeoutMs !== milliseconds) state.warnings.push(`超时已收敛到 ${state.timeoutMs} 毫秒`)
      continue
    }
    if (name === '-b' || name === '--cookie') {
      const raw = value ?? ''
      if (!raw.includes('=')) {
        state.fatal = true
        state.unsupported.push(`${name} ${brief(raw, 80)} 引用了本机 Cookie 文件：工作台未读取文件，已跳过该命令`)
        continue
      }
      state.headers.push({ id: nextFieldId(), name: 'Cookie', value: raw, enabled: true, secret: true })
      continue
    }
    if (name === '--json') {
      const raw = value ?? ''
      if (raw.startsWith('@')) {
        state.fatal = true
        state.unsupported.push(`${name} ${brief(raw, 80)} 引用了本机文件：工作台未读取文件，已跳过该命令`)
        continue
      }
      state.jsonMode = true
      state.data.push(raw)
      continue
    }
    if (name === '-A' || name === '--user-agent') {
      state.headers.push({ id: nextFieldId(), name: 'User-Agent', value: value ?? '', enabled: true })
      continue
    }
    if (name === '-e' || name === '--referer') {
      state.headers.push({ id: nextFieldId(), name: 'Referer', value: value ?? '', enabled: true })
      continue
    }
    if (name === '-L' || name === '--location') {
      state.followRedirects = true
      continue
    }
    if (name === '-G' || name === '--get') {
      state.getMode = true
      continue
    }
    if (name === '-I' || name === '--head') {
      state.headMode = true
      continue
    }
    if (name === '-k' || name === '--insecure') {
      state.unsupported.push(`${name} 未支持：工作台始终校验 TLS 证书，本次不会关闭证书校验`)
      continue
    }
    if (name === '--compressed') {
      state.warnings.push('--compressed 已忽略：响应压缩由工作台统一处理')
      continue
    }
    if (name === '--http2' || name === '--http2-prior-knowledge') {
      state.unsupported.push(`${name} 未支持：工作台目前只发 HTTP/1.1`)
      continue
    }
    if (FLAG_SILENT.has(name)) continue
    state.unsupported.push(`${name} 未支持，已忽略`)
  }
}

/** 从位置参数和 `--url` 中选出目标地址，兼容未知选项留下多余位置参数的情况。 */
function pickUrl(state: CurlCommandState): string | undefined {
  const candidates = [...(state.explicitUrl ? [state.explicitUrl] : []), ...state.positional]
  const httpCandidate = candidates.find((candidate) => /^https?:\/\//i.test(candidate) || candidate.includes('{{'))
  return httpCandidate ?? state.explicitUrl ?? state.positional[0]
}

/** 按 `&` 拆分表单编码正文；任意一段不是键值对时返回 undefined。 */
function parseFormPairs(input: string): { name: string; value: string }[] | undefined {
  if (input === '') return undefined
  const pairs: { name: string; value: string }[] = []
  for (const part of input.split('&')) {
    const separator = part.indexOf('=')
    if (separator <= 0) return undefined
    const name = decodeFormPart(part.slice(0, separator))
    if (name === '') return undefined
    pairs.push({ name, value: decodeFormPart(part.slice(separator + 1)) })
  }
  return pairs.length > 0 ? pairs : undefined
}

/** 生成可读的草稿名称：方法加路径，无法解析地址时退回完整地址。 */
function draftName(method: ApiMethod, url: string): string {
  try {
    const parsed = new URL(url)
    return `${method} ${parsed.pathname === '' ? '/' : parsed.pathname}`.slice(0, 128)
  } catch {
    return `${method} ${url}`.slice(0, 128)
  }
}

/**
 * 把单条命令转换为请求草稿。
 * @param state 已翻译的命令状态。
 * @param commandIndex 命令序号，从 1 开始。
 * @returns 通过共享合同校验的草稿；命令被拒绝时返回 undefined。
 */
function buildDraft(state: CurlCommandState, commandIndex: number): ApiRequestDraft | undefined {
  const url = pickUrl(state)
  if (!url) {
    state.fatal = true
    state.unsupported.push('缺少请求地址，已跳过该命令')
    return undefined
  }
  if (!/^https?:\/\//i.test(url) && !url.includes('{{')) {
    state.fatal = true
    state.unsupported.push(`地址不是 http/https 协议：${brief(url, 200)}，已跳过该命令`)
    return undefined
  }
  for (const extra of state.positional) {
    if (extra !== url) state.unsupported.push(`已忽略额外的地址 ${brief(extra, 80)}`)
  }
  if (state.fatal) return undefined

  const method: ApiMethod = state.method
    ?? (state.headMode ? 'HEAD' : state.getMode ? 'GET' : state.data.length > 0 ? 'POST' : 'GET')
  const joined = state.data.join('&')
  const pairs = parseFormPairs(joined)
  const contentType = [...state.headers]
    .reverse()
    .find((header) => header.name.toLowerCase() === 'content-type')?.value ?? ''

  let body: ApiRequestBody = { kind: 'none', text: '', fields: [] }
  const query: ApiField[] = []
  /** 表单行需要连续且唯一的编辑身份，因此在此统一分配。 */
  let fieldSeed = 0
  const toFields = (rows: readonly { name: string; value: string }[]): ApiField[] => rows.map((row) => {
    fieldSeed += 1
    return { id: `curl${commandIndex}q${fieldSeed}`, name: row.name, value: row.value, enabled: true }
  })

  if (state.data.length > 0) {
    if (state.getMode) {
      if (pairs) query.push(...toFields(pairs))
      else state.unsupported.push('-G 与无法解析为键值对的正文组合未支持，已忽略该正文')
    } else if (state.jsonMode || /json/i.test(contentType)) {
      body = { kind: 'json', text: joined, fields: [] }
    } else if (/x-www-form-urlencoded/i.test(contentType)) {
      body = pairs ? { kind: 'urlencoded', text: '', fields: toFields(pairs) } : { kind: 'text', text: joined, fields: [] }
    } else if (contentType.trim() !== '') {
      body = { kind: 'text', text: joined, fields: [] }
    } else if (pairs) {
      body = { kind: 'urlencoded', text: '', fields: toFields(pairs) }
    } else {
      body = { kind: 'text', text: joined, fields: [] }
    }
  }

  const auth: ApiAuth = state.username === undefined
    ? { type: 'none', value: { value: '' } }
    : { type: 'basic', username: state.username, value: { value: state.password ?? '', secret: true } }

  const draft: ApiRequestDraft = {
    name: draftName(method, url),
    collectionId: 'default',
    folder: '',
    description: '',
    method,
    url,
    query,
    headers: state.headers,
    body,
    auth,
    timeoutMs: state.timeoutMs ?? 30_000,
    followRedirects: state.followRedirects,
    maxRedirects: 5,
    assertions: [],
  }

  try {
    return parseApiRequestDraft(draft)
  } catch (error) {
    state.fatal = true
    state.unsupported.push(`参数不满足工作台合同：${error instanceof Error ? error.message : '未知原因'}`)
    return undefined
  }
}

/**
 * 解析粘贴的 cURL 文本。
 * @param input 可能包含多条命令与说明文字的原始文本。
 * @returns 可导入的草稿以及未支持项和偏差说明。
 */
export function parseCurlCommands(input: string): ApiCurlImportResult {
  const drafts: ApiRequestDraft[] = []
  const unsupported: string[] = []
  const warnings: string[] = []
  const commands = splitCurlCommands(input, warnings)

  commands.forEach((command, index) => {
    const commandIndex = index + 1
    const state = createCommandState()
    try {
      const outcome = tokenizeCommand(command)
      if (outcome.substitution) {
        state.unsupported.push('命令替换 $(...) 或反引号未执行，已按字面量保留，请手动替换为具体值')
      }
      translateCommand(outcome.tokens, commandIndex, state)
      const draft = buildDraft(state, commandIndex)
      if (draft) drafts.push(draft)
    } catch (error) {
      state.fatal = true
      state.unsupported.push(error instanceof Error ? error.message.replace(/^API_CURL_INVALID: /, '') : '无法解析该命令')
    }
    for (const item of state.unsupported) unsupported.push(`第 ${commandIndex} 条：${item}`)
    for (const item of state.warnings) warnings.push(`第 ${commandIndex} 条：${item}`)
  })

  return { drafts, unsupported, warnings }
}

/** 生成变量占位符名称；非法字符会被剔除，避免破坏模板语法。 */
function placeholderFor(name: string): string {
  const cleaned = name.replace(/[^0-9A-Za-z]/g, '')
  return `{{${cleaned === '' ? 'Secret' : cleaned.slice(0, 64)}}}`
}

/** 单引号包裹 shell 参数，内部单引号按 POSIX 规则转义。 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

/**
 * 把查询行合并进地址；地址无法解析时退回手工拼接。
 * @param url 原始地址，可能已带查询串。
 * @param rows 需要追加的键值对。
 * @returns 合并后的地址文本。
 */
function mergeQueryIntoUrl(url: string, rows: readonly { name: string; value: string }[]): string {
  const enabled = rows.filter((row) => row.name !== '')
  if (enabled.length === 0) return url
  try {
    const parsed = new URL(url)
    for (const row of enabled) parsed.searchParams.append(row.name, row.value)
    return parsed.toString()
  } catch {
    const suffix = enabled
      .map((row) => `${encodeURIComponent(row.name)}=${encodeURIComponent(row.value)}`)
      .join('&')
    return `${url}${url.includes('?') ? '&' : '?'}${suffix}`
  }
}

/**
 * 把请求草稿导出为 cURL 命令。
 * @param draft 待导出的草稿。
 * @returns 命令文本与被替换的秘密位置；秘密只以变量占位符出现。
 */
export function createCurlCommand(draft: ApiRequestDraft): ApiCurlExportResult {
  const parsed = parseApiRequestDraft(draft)
  const redactedSecrets: string[] = []
  /** 替换秘密值并记录位置；空值不视为需要替换的秘密。 */
  const protect = (name: string, value: string, secret?: boolean): string => {
    if (secret === true && value !== '') {
      redactedSecrets.push(name)
      return placeholderFor(name)
    }
    return value
  }

  const auth = parsed.auth
  let authHeader: { name: string; value: string } | undefined
  let authQuery: { name: string; value: string } | undefined
  let authUser: string | undefined
  if (auth.type === 'bearer') {
    authHeader = { name: 'Authorization', value: `Bearer ${protect('Authorization', auth.value.value, auth.value.secret)}` }
  } else if (auth.type === 'basic') {
    authUser = `${auth.username ?? ''}:${protect('Password', auth.value.value, auth.value.secret)}`
  } else if (auth.type === 'api-key') {
    const keyName = auth.name ?? 'X-Api-Key'
    const keyValue = protect(keyName, auth.value.value, auth.value.secret)
    if (auth.in === 'query') authQuery = { name: keyName, value: keyValue }
    else authHeader = { name: keyName, value: keyValue }
  }

  const queryRows = [
    ...parsed.query.filter((row) => row.enabled).map((row) => ({ name: row.name, value: protect(row.name, row.value, row.secret) })),
    ...(authQuery ? [authQuery] : []),
  ]
  const segments = [
    `--request ${parsed.method}`,
    `--url ${shellQuote(mergeQueryIntoUrl(parsed.url, queryRows))}`,
  ]
  for (const header of parsed.headers.filter((item) => item.enabled)) {
    segments.push(`--header ${shellQuote(`${header.name}: ${protect(header.name, header.value, header.secret)}`)}`)
  }
  if (authHeader) segments.push(`--header ${shellQuote(`${authHeader.name}: ${authHeader.value}`)}`)
  if (authUser !== undefined) segments.push(`--user ${shellQuote(authUser)}`)

  if (parsed.body.kind === 'json' || parsed.body.kind === 'text') {
    if (parsed.body.text !== '') segments.push(`--data-raw ${shellQuote(parsed.body.text)}`)
  } else if (parsed.body.kind === 'urlencoded') {
    const encoded = parsed.body.fields
      .filter((field) => field.enabled && field.name !== '')
      .map((field) => {
        /** 秘密表单值同样只导出占位符，其余值按表单规则编码。 */
        const value = field.secret === true && field.value !== ''
          ? protect(field.name, field.value, field.secret)
          : encodeURIComponent(field.value)
        return `${encodeURIComponent(field.name)}=${value}`
      })
      .join('&')
    if (encoded !== '') segments.push(`--data-raw ${shellQuote(encoded)}`)
  }

  return { command: `curl ${segments.join(' \\\n  ')}`, redactedSecrets: [...new Set(redactedSecrets)] }
}
