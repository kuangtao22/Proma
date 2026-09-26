import { randomBytes } from 'node:crypto'
import type { ApiCryptoOverrides, ApiCryptoProfile, ApiCryptoStep } from '@proma/shared'
import { ApiCryptoError, decryptValue, digestValue, encryptValue, evaluateCryptoTemplate, isAuthenticatedCipher } from './api-crypto'
import type { ApiCryptoTemplateContext, ApiCryptoTemplateGroup } from './api-crypto'

/** 被跳过或被执行的步骤事实：只记身份、类型与算法名，密钥值永不进入事实。 */
export interface ApiCryptoStepFact {
  id: string
  kind: string
  algo: string
}
/**
 * 被跳过的步骤：
 * - `missing-secret` 密钥变量没填值（用户还没填或换环境后缺项）；
 * - `disabled` 方案里这一步被显式停用；
 * - `invalid-config` 方案本身不完整（例如签名没有模板/落点），属于配置问题而不是缺密钥。
 */
export interface ApiCryptoSkipFact extends ApiCryptoStepFact {
  reason: 'missing-secret' | 'disabled' | 'invalid-config'
  /** 导致跳过的那一个变量名，界面据此提示「缺 aesKey」。 */
  keyRef?: string
}

/** 编排输入里的请求形态；数组保留顺序与重复名称，与既有解析链路一致。 */
export interface ApiCryptoRequestInput {
  method: string
  path: string
  query: Array<{ name: string; value: string }>
  headers: Array<{ name: string; value: string }>
  body: string
}

/** 请求侧执行结果：既有变形后的请求，也有「哪些步骤被跳过、为什么」的事实。 */
export interface ApiCryptoRequestOutcome {
  method: string
  path: string
  headers: Array<{ name: string; value: string }>
  query: Array<{ name: string; value: string }>
  body: string
  executed: ApiCryptoStepFact[]
  skipped: ApiCryptoSkipFact[]
  /** 因缺密钥或配置不完整而未加密/未签名：状态条与运行记录必须显式标注。 */
  plaintextSent: boolean
  /** 派生步骤的实际取值（非秘密），便于按记录复现本次签名。 */
  derived: Record<string, string>
  /** 被加密前的正文；只在实际发生加密时出现，供记录对照「发出的密文 ↔ 变形前明文」。 */
  bodyBeforeTransform?: string
}

/** 响应侧执行结果：还原后的正文 + 解密事实 + 可分类失败原因。 */
export interface ApiCryptoResponseOutcome {
  body: string
  decrypted: boolean
  executed: ApiCryptoStepFact[]
  skipped: ApiCryptoSkipFact[]
  failure?: { code: string; message: string }
}

export interface ApplyRequestStepsInput {
  profile: ApiCryptoProfile
  /** 已解析的密钥值（变量名 → 值）；缺项即视为缺密钥，跳过该步而不是报错。 */
  secrets: Record<string, string>
  request: ApiCryptoRequestInput
  overrides?: ApiCryptoOverrides
  /** 覆盖时钟（毫秒）与随机串，便于测试精确复算签名；缺省取当前时间与随机值。 */
  now?: number
  nonce?: string
}

export interface ApplyResponseStepsInput {
  profile: ApiCryptoProfile
  secrets: Record<string, string>
  responseBody: string
  overrides?: ApiCryptoOverrides
}

/** 查询串按原顺序拼接，保留重复参数。 */
function joinQuery(rows: Array<{ name: string; value: string }>): string {
  return rows.map((row) => `${row.name}=${row.value}`).join('&')
}

/** 排序后的查询串：先按名称再按值，供 {{query.sorted}} 使用。 */
function sortQuery(rows: Array<{ name: string; value: string }>): Array<{ name: string; value: string }> {
  return [...rows].sort((left, right) => left.name === right.name ? left.value.localeCompare(right.value) : left.name.localeCompare(right.name))
}

/**
 * 构造待签/待加密模板上下文。
 * 每次都按**当前**请求形态重建，所以「签名签的是明文还是密文」完全由步骤顺序决定。
 * 正文摘要用取值器惰性计算：只有模板真的引用了 {{body.sha256}} 才付哈希成本。
 */
function templateContext(outcome: ApiCryptoRequestOutcome): ApiCryptoTemplateContext {
  const body: ApiCryptoTemplateGroup = {
    get raw(): string { return outcome.body },
    get sha256(): string { return digestValue('SHA256', '', outcome.body, 'hex') },
    get md5(): string { return digestValue('MD5', '', outcome.body, 'hex') },
  }
  const query: ApiCryptoTemplateGroup = { raw: joinQuery(outcome.query), sorted: joinQuery(sortQuery(outcome.query)) }
  return { method: outcome.method, path: outcome.path, query, body, ...outcome.derived }
}

/** 把步骤结果写进请求头或查询参数；同名覆盖而不是追加，请求头按不区分大小写比较。 */
function writeTarget(outcome: ApiCryptoRequestOutcome, target: { in: string; name: string }, value: string): void {
  const rows = target.in === 'query' ? outcome.query : outcome.headers
  const index = rows.findIndex((row) => target.in === 'query' ? row.name === target.name : row.name.toLowerCase() === target.name.toLowerCase())
  if (index >= 0) rows[index] = { name: target.name, value }
  else rows.push({ name: target.name, value })
}

/** 步骤实际使用的密钥变量名：接口级覆盖优先于方案。 */
function resolveKeyRef(step: ApiCryptoStep, overrides?: ApiCryptoOverrides): string | undefined {
  return overrides?.keyRefs?.[step.id] ?? step.keyRef
}

/** 找出第一个没填值的密钥变量；都没有缺项时返回 undefined。 */
function findMissingSecret(refs: readonly string[], secrets: Record<string, string>): string | undefined {
  return refs.find((ref) => !secrets[ref])
}

/**
 * 判断步骤配置是否足以执行。
 * 签名必须有模板与落点（且不能落到正文——正文落点在本模型里没有定义），
 * 加密只支持整段正文，且认证加密（GCM）的标签落点属于 P2，此处按配置不完整处理。
 */
function isConfigComplete(step: ApiCryptoStep): boolean {
  if (isAuthenticatedCipher(step.algo)) return false
  if (step.kind === 'sign') return Boolean(step.template && step.target && step.target.in !== 'body')
  if (step.kind === 'encrypt') return Boolean(step.ivRef && (step.source === undefined || step.source === 'body'))
  /** 解密只作用于整段响应正文，必须有 IV；认证加密的标签落点同样属于 P2。 */
  if (step.kind === 'decrypt') return Boolean(step.ivRef && (step.source === undefined || step.source === 'response-body'))
  return false
}

/** 执行请求侧全部步骤；任何一步都只跳过、不抛错，保证请求照常发出。 */
export function applyRequestSteps(input: ApplyRequestStepsInput): ApiCryptoRequestOutcome {
  const outcome: ApiCryptoRequestOutcome = {
    method: input.request.method, path: input.request.path,
    headers: [...input.request.headers], query: [...input.request.query], body: input.request.body,
    executed: [], skipped: [], plaintextSent: false, derived: {},
  }
  for (const step of input.profile.requestSteps) {
    const fact: ApiCryptoStepFact = { id: step.id, kind: step.kind, algo: step.algo }
    if (!step.enabled) {
      /** 显式停用是配置意图，不算「本次未加密」，因此不置 plaintextSent。 */
      outcome.skipped.push({ ...fact, reason: 'disabled' })
      continue
    }
    if (step.kind === 'derive') {
      /** 派生只生成时间与随机串：时间戳写进 target，nonce 通过 {{nonce}} 模板引用。 */
      outcome.derived = { timestamp: String(Math.floor((input.now ?? Date.now()) / 1000)), nonce: input.nonce ?? randomBytes(16).toString('hex') }
      if (step.target) writeTarget(outcome, step.target, outcome.derived.timestamp as string)
      outcome.executed.push(fact)
      continue
    }
    /** 请求侧出现解密步骤属于方案写错，直接跳过并如实标注。 */
    if (step.kind !== 'sign' && step.kind !== 'encrypt') {
      outcome.skipped.push({ ...fact, reason: 'invalid-config' })
      continue
    }
    const keyRef = resolveKeyRef(step, input.overrides)
    if (!keyRef || !isConfigComplete(step)) {
      outcome.skipped.push({ ...fact, reason: 'invalid-config' })
      outcome.plaintextSent = true
      continue
    }
    const missing = findMissingSecret([keyRef, ...(step.ivRef === undefined ? [] : [step.ivRef])], input.secrets)
    if (missing) {
      outcome.skipped.push({ ...fact, reason: 'missing-secret', keyRef: missing })
      outcome.plaintextSent = true
      continue
    }
    if (step.kind === 'sign') {
      const content = evaluateCryptoTemplate(step.template as string, templateContext(outcome))
      const value = digestValue(step.algo, input.secrets[keyRef] as string, content, step.encoding ?? 'hex')
      const target = step.target as { in: string; name: string }
      writeTarget(outcome, { in: target.in, name: input.overrides?.targetNames?.[step.id] ?? target.name }, value)
      outcome.executed.push(fact)
      continue
    }
    const cipher = encryptValue(step.algo, input.secrets[keyRef] as string, input.secrets[step.ivRef as string] as string, outcome.body, { encoding: step.encoding ?? 'base64' })
    outcome.bodyBeforeTransform = outcome.body
    outcome.body = cipher.ciphertext
    outcome.executed.push(fact)
  }
  return outcome
}

/** 执行响应侧全部步骤；解密失败按 onFailure 决定是否继续后续步骤，并把原因交回调用方。 */
export function applyResponseSteps(input: ApplyResponseStepsInput): ApiCryptoResponseOutcome {
  const outcome: ApiCryptoResponseOutcome = { body: input.responseBody, decrypted: false, executed: [], skipped: [] }
  for (const step of input.profile.responseSteps) {
    const fact: ApiCryptoStepFact = { id: step.id, kind: step.kind, algo: step.algo }
    if (!step.enabled) {
      outcome.skipped.push({ ...fact, reason: 'disabled' })
      continue
    }
    if (step.kind !== 'decrypt' || !isConfigComplete(step)) {
      outcome.skipped.push({ ...fact, reason: 'invalid-config' })
      continue
    }
    const keyRef = resolveKeyRef(step, input.overrides)
    if (!keyRef) {
      outcome.skipped.push({ ...fact, reason: 'invalid-config' })
      continue
    }
    const missing = findMissingSecret([keyRef, step.ivRef as string], input.secrets)
    if (missing) {
      /** 解密侧缺密钥不阻断：密文原文照常可查，只标记「未解密」。 */
      outcome.skipped.push({ ...fact, reason: 'missing-secret', keyRef: missing })
      continue
    }
    try {
      outcome.body = decryptValue(step.algo, input.secrets[keyRef] as string, input.secrets[step.ivRef as string] as string, outcome.body, { encoding: step.encoding ?? 'base64' })
      outcome.decrypted = true
      outcome.executed.push(fact)
    } catch (error) {
      outcome.failure = error instanceof ApiCryptoError
        ? { code: error.code, message: error.message }
        : { code: 'API_CRYPTO_DECRYPT_FAILED', message: String(error) }
      /** 默认 fail closed：解密失败就不再往下跑，避免断言和提取拿到乱码。 */
      if ((input.overrides?.onFailure ?? step.onFailure ?? 'stop') === 'stop') return outcome
    }
  }
  return outcome
}
