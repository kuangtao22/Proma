import { API_LIMITS, type ApiResolvedRequest } from '@proma/shared'

const COMMON_SENSITIVE_NAME = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api[-_]?key|token|access[-_]?token|refresh[-_]?token|password|passwd|secret|client[-_]?secret)$/i
/** 正文和 Header 使用的兼容遮罩。 */
const REDACTED_VALUE = '[REDACTED]'
/** URL 使用的百分号编码遮罩。 */
const REDACTED_URL_VALUE = '%5BREDACTED%5D'
/** 公开 URL 采用比 Shared resolved request 更严格的通用字符串上限。 */
const PUBLIC_URL_MAX_LENGTH = 8_192
/** Shared 单个 Header value 的字符上限。 */
const PUBLIC_HEADER_MAX_LENGTH = 65_536
/** 小内容允许的最小输出增长空间。 */
const MIN_OUTPUT_HEADROOM = 64 * 1024
/** 大内容允许的最大输出增长空间。 */
const MAX_OUTPUT_HEADROOM = 1024 * 1024
/** 小内容允许的最少候选匹配次数。 */
const MIN_CANDIDATE_CHECKS = 100_000
/** 大内容按字符数分配的候选匹配倍数。 */
const CANDIDATE_CHECKS_PER_CHARACTER = 8
/** 用于校验公开请求正文仍满足 Shared 的 UTF-8 字节上限。 */
const UTF8_ENCODER = new TextEncoder()

interface RedactionPattern {
  /** 仅在原始输入中查找的秘密文本。 */
  value: string
  /** 命中秘密后写入公开投影的固定遮罩。 */
  replacement: string
  /** 是否允许百分号编码中的十六进制位忽略大小写。 */
  percentEncoded: boolean
}

interface RedactionBudget {
  /** 公开投影允许生成的最大字符数。 */
  maxOutputLength: number
  /** 单次扫描允许执行的候选匹配次数。 */
  maxCandidateChecks: number
}

/** 构建去重后的明文与 URL 编码匹配模式，并保持长值优先。 */
function createRedactionPatterns(
  secrets: readonly string[],
  plainReplacement = REDACTED_VALUE,
): RedactionPattern[] {
  /** 先处理较长秘密，避免短秘密抢占其前缀。 */
  const uniqueSecrets = [...new Set(secrets)].filter(Boolean).sort((a, b) => b.length - a.length)
  if (uniqueSecrets.length === 0) return []

  /** 保存模式类型和值的组合，避免重复候选增加扫描开销。 */
  const patternKeys = new Set<string>()
  /** 依次保存受保护遮罩、明文秘密及其编码等价形式。 */
  const patterns: RedactionPattern[] = []
  /** 加入一个尚未出现的匹配模式。 */
  const addPattern = (value: string, replacement: string, percentEncoded: boolean): void => {
    /** 模式类型参与键值，允许同一文本同时保留精确和编码语义。 */
    const key = `${percentEncoded ? 'encoded' : 'plain'}\0${value}`
    if (patternKeys.has(key)) return
    patternKeys.add(key)
    patterns.push({ value, replacement, percentEncoded })
  }

  addPattern(REDACTED_VALUE, plainReplacement, false)
  addPattern(REDACTED_URL_VALUE, REDACTED_URL_VALUE, true)

  for (const secret of uniqueSecrets) {
    addPattern(secret, plainReplacement, false)
    /** URL 序列化后可能出现的等价编码文本。 */
    const encodedSecret = encodeURIComponent(secret)
    addPattern(encodedSecret, REDACTED_URL_VALUE, true)
    /** application/x-www-form-urlencoded 还会编码空格、~、! 等字符。 */
    const formEncodedSecret = encodeSearchPart(secret)
    addPattern(formEncodedSecret, REDACTED_URL_VALUE, true)
  }

  return patterns.sort((a, b) => b.value.length - a.value.length)
}

/** 比较原始输入与模式；仅百分号后的两个十六进制位忽略大小写。 */
function matchesRedactionPattern(input: string, cursor: number, pattern: RedactionPattern): boolean {
  if (!pattern.percentEncoded) return input.startsWith(pattern.value, cursor)
  if (cursor + pattern.value.length > input.length) return false

  for (let index = 0; index < pattern.value.length; index += 1) {
    /** 百分号编码单元由固定百分号和两个大小写等价十六进制位组成。 */
    const encodedUnit = pattern.value[index] === '%'
      && /^[0-9A-Fa-f]{2}$/.test(pattern.value.slice(index + 1, index + 3))
    if (encodedUnit) {
      if (input[cursor + index] !== '%'
        || input.slice(cursor + index + 1, cursor + index + 3).toUpperCase()
          !== pattern.value.slice(index + 1, index + 3).toUpperCase()) return false
      index += 2
      continue
    }
    if (input[cursor + index] !== pattern.value[index]) return false
  }
  return true
}

/** 只扫描原始输入一次；超过公开投影或匹配预算时返回整段遮罩。 */
function redactWithBudget(
  value: string,
  patterns: readonly RedactionPattern[],
  budget: RedactionBudget,
  fallback = REDACTED_VALUE,
): string {
  if (patterns.length === 0) return value

  /** 按首字符分组，避免每个位置都遍历全部秘密。 */
  const patternsByFirstCharacter = new Map<string, RedactionPattern[]>()
  for (const pattern of patterns) {
    /** 同组模式继承全局的长度降序。 */
    const candidates = patternsByFirstCharacter.get(pattern.value[0]!) ?? []
    candidates.push(pattern)
    patternsByFirstCharacter.set(pattern.value[0]!, candidates)
  }

  /** 分段保存结果，避免逐字符拼接产生额外复制。 */
  const output: string[] = []
  /** 已写入分段的总字符数。 */
  let outputLength = 0
  /** 已执行的候选匹配次数。 */
  let candidateChecks = 0
  /** 原始输入中已经复制或替换完毕的位置。 */
  let copiedUntil = 0
  /** 当前扫描位置。 */
  let cursor = 0

  while (cursor < value.length) {
    /** 当前字符可能命中的模式，顺序保证最长匹配优先。 */
    const candidates = patternsByFirstCharacter.get(value[cursor]!)
    let matched: RedactionPattern | undefined
    if (candidates) {
      for (const candidate of candidates) {
        candidateChecks += 1
        if (candidateChecks > budget.maxCandidateChecks) return fallback
        if (matchesRedactionPattern(value, cursor, candidate)) {
          matched = candidate
          break
        }
      }
    }

    if (!matched) {
      cursor += 1
      continue
    }

    /** 本次追加包含上一个命中后的原文片段和固定遮罩。 */
    const nextOutputLength = outputLength + cursor - copiedUntil + matched.replacement.length
    if (nextOutputLength > budget.maxOutputLength) return fallback
    output.push(value.slice(copiedUntil, cursor), matched.replacement)
    outputLength = nextOutputLength
    cursor += matched.value.length
    copiedUntil = cursor
  }

  /** 扫描结束后尚未复制的原文尾部。 */
  const tail = value.slice(copiedUntil)
  if (outputLength + tail.length > budget.maxOutputLength) return fallback
  output.push(tail)
  return output.join('')
}

/** 为正文和 Header 生成线性扫描与有限扩张预算。 */
function createContentBudget(inputLength: number, contractLimit: number): RedactionBudget {
  /** 小内容保留基本余量，大内容最多允许额外生成 1 MiB。 */
  const outputHeadroom = Math.min(MAX_OUTPUT_HEADROOM, Math.max(MIN_OUTPUT_HEADROOM, inputLength))
  return {
    maxOutputLength: Math.min(contractLimit, inputLength + outputHeadroom),
    maxCandidateChecks: Math.max(MIN_CANDIDATE_CHECKS, inputLength * CANDIDATE_CHECKS_PER_CHARACTER),
  }
}

/** 替换文本中的已知秘密，且不重新扫描已生成的遮罩。 */
function redactKnownValues(value: string, secrets: readonly string[], contractLimit: number): string {
  return redactWithBudget(value, createRedactionPatterns(secrets), createContentBudget(value.length, contractLimit))
}

/** 使用 URLSearchParams 的规则编码单个 query name 或 value。 */
function encodeSearchPart(value: string): string {
  /** 空名称让序列化结果固定以等号开头，移除后即为目标编码文本。 */
  const params = new URLSearchParams([['', value]])
  return params.toString().slice(1)
}

/** 生成不包含已知 Header、query 和正文秘密的公开请求投影。 */
export function redactApiRequest(request: ApiResolvedRequest, secrets: readonly string[] = []): ApiResolvedRequest {
  const sensitiveHeaders = new Set(request.sensitiveHeaderNames.map((name) => name.toLowerCase()))
  const sensitiveQueries = new Set(request.sensitiveQueryNames)
  const url = new URL(request.url)
  /** 按原顺序保存 query，保留重复参数这一请求事实。 */
  const queryEntries: Array<readonly [string, string]> = []
  for (const [name, value] of url.searchParams) {
    queryEntries.push([
      name,
      sensitiveQueries.has(name) || COMMON_SENSITIVE_NAME.test(name) ? REDACTED_VALUE : value,
    ])
  }

  /** URL 的每个原字符最多扩张为一个编码遮罩。 */
  const urlPatterns = createRedactionPatterns(secrets, REDACTED_URL_VALUE)
  /** 每个组件的候选预算覆盖理论最坏情况，不触发不安全的部分结果。 */
  const redactUrlPart = (value: string): string => redactWithBudget(value, urlPatterns, {
    maxOutputLength: PUBLIC_URL_MAX_LENGTH,
    maxCandidateChecks: value.length * Math.max(1, urlPatterns.length),
  }, REDACTED_URL_VALUE)
  /** 只保护根路径分隔符，其余路径整体扫描以捕获跨段秘密。 */
  const redactedPath = `/${redactUrlPart(url.pathname.slice(1))}`
  /** query 按 name/value 重建，& 和 = 分隔符均不参与秘密扫描。 */
  const redactedQuery = queryEntries.length > 0
    ? `?${queryEntries.map(([name, value]) => `${redactUrlPart(encodeSearchPart(name))}=${redactUrlPart(encodeSearchPart(value))}`).join('&')}`
    : ''
  /** hash 的首个结构分隔符不参与秘密扫描。 */
  const redactedHash = url.hash ? `#${redactUrlPart(url.hash.slice(1))}` : ''
  /** 先组合完整公开 URL，再统一执行协议长度降级。 */
  const expandedUrl = `${url.origin}${redactedPath}${redactedQuery}${redactedHash}`
  const redactedUrl = expandedUrl.length <= PUBLIC_URL_MAX_LENGTH
    ? expandedUrl
    : `${url.origin}/${REDACTED_URL_VALUE}`
  return {
    method: request.method,
    url: redactedUrl,
    timeoutMs: request.timeoutMs,
    followRedirects: request.followRedirects,
    maxRedirects: request.maxRedirects,
    sensitiveHeaderNames: request.sensitiveHeaderNames,
    sensitiveQueryNames: request.sensitiveQueryNames,
    /** 附件摘要可以公开；二进制正文（bodyBase64）永远不进公开投影。 */
    ...(request.attachments ? { attachments: request.attachments } : {}),
    headers: request.headers.map((header) => ({
      ...header,
      value: sensitiveHeaders.has(header.name.toLowerCase()) || COMMON_SENSITIVE_NAME.test(header.name)
        ? REDACTED_VALUE
        : redactKnownValues(header.value, secrets, PUBLIC_HEADER_MAX_LENGTH),
    })),
    body: redactApiBody(request.body, secrets),
  }
}

/** 对响应正文实施保守脱敏；不 parse/stringify JSON，避免改写大整数原文。 */
export function redactApiBody(body: string, secrets: readonly string[] = []): string {
  /** 常见 JSON 敏感值必须先整体遮罩，避免短秘密破坏键名后逃过识别。 */
  const commonRedacted = body.replace(
    /("(?:authorization|cookie|set-cookie|x-api-key|api[-_]?key|token|access[-_]?token|refresh[-_]?token|password|passwd|secret|client[-_]?secret)"\s*:\s*)"(?:\\.|[^"\\])*"/gi,
    '$1"[REDACTED]"',
  )
  /** preview 不扩张；完整响应正文保留自身预算但不得超过 Store 正文合同。 */
  const bodyContractLimit = Math.min(
    API_LIMITS.bodyBytes,
    Math.max(API_LIMITS.previewBytes, body.length),
  )
  if (commonRedacted.length > bodyContractLimit) return REDACTED_VALUE
  /** 已生成的常见字段遮罩会由模式表保护，不会被后续短秘密破坏。 */
  const knownRedacted = redactKnownValues(commonRedacted, secrets, bodyContractLimit)
  /** 请求受 1 MiB 字节合同约束，较大的完整响应则只禁止净字节增长。 */
  const bodyByteLimit = Math.max(API_LIMITS.requestBytes, UTF8_ENCODER.encode(body).byteLength)
  return UTF8_ENCODER.encode(knownRedacted).byteLength <= bodyByteLimit
    ? knownRedacted
    : REDACTED_VALUE
}
