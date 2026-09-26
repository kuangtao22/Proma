import { createCipheriv, createDecipheriv, createHash, createHmac } from 'node:crypto'

/** 摘要、密文与明文的表示方式；raw 表示直接使用字符串本身（按 UTF-8 解释字节）。 */
export type ApiCryptoEncoding = 'hex' | 'base64' | 'raw'

/**
 * 加解密引擎的可分类错误：界面按 code 展示「密钥不匹配 / 解不开 / 算法不可用」，
 * 而不是把底层 OpenSSL 文案直接抛给用户。
 */
export class ApiCryptoError extends Error {
  constructor(
    /** 稳定错误码，供界面与运行记录分类消费；不进正文。 */
    public readonly code: 'API_CRYPTO_KEY_MISMATCH' | 'API_CRYPTO_DECRYPT_FAILED' | 'API_CRYPTO_UNSUPPORTED_ALGO',
    message: string,
  ) {
    super(`${code}: ${message}`)
    this.name = 'ApiCryptoError'
  }
}

/** 白名单算法到 Node 摘要名 / 密码名的映射；表里没有的名字一律视为未实现。 */
const DIGEST_ALGOS: Record<string, string> = { MD5: 'md5', SHA1: 'sha1', SHA256: 'sha256', SM3: 'sm3' }
const HMAC_ALGOS: Record<string, string> = { 'HMAC-SHA1': 'sha1', 'HMAC-SHA256': 'sha256' }
const CIPHER_ALGOS: Record<string, string> = { 'AES-128-CBC': 'aes-128-cbc', 'AES-256-CBC': 'aes-256-cbc', 'AES-128-GCM': 'aes-128-gcm', 'SM4-CBC': 'sm4-cbc' }
/** 需要认证标签的算法：必须按名字显式判断，`getAuthTag` 在非 GCM 的 cipher 上也存在、调用才抛错。 */
const AUTH_TAGGED_ALGOS = new Set(['AES-128-GCM'])

/** 该算法是否需要认证标签；编排层据此判断标签落点（P1 尚未定义，见 api-crypto-plan）。 */
export function isAuthenticatedCipher(algo: string): boolean {
  return AUTH_TAGGED_ALGOS.has(algo)
}

/** 加解密调用参数：tag 只在 GCM 这类需要认证标签的算法上出现。 */
export interface ApiCryptoCipherOptions {
  encoding: ApiCryptoEncoding
  /** GCM 认证标签（十六进制）；请求侧加密产出、响应侧解密传入。 */
  tag?: string
}

/**
 * 把底层错误收敛成可分类合同错误。
 * 注意：不能简单匹配 /Unsupported/ —— GCM 认证失败的文案是
 * “Unsupported state or unable to authenticate data”，那属于解密失败而不是算法不可用。
 */
function classifyCryptoFailure(error: unknown, algo: string, fallback: ApiCryptoError['code']): ApiCryptoError {
  if (error instanceof ApiCryptoError) return error
  const detail = error instanceof Error ? error.message : String(error)
  if (/digest method not supported|unknown cipher|unknown digest|unknown hash/i.test(detail)) {
    return new ApiCryptoError('API_CRYPTO_UNSUPPORTED_ALGO', `当前运行时无法执行算法 ${algo}`)
  }
  if (/invalid key length|invalid iv length|invalid initialization vector/i.test(detail)) {
    return new ApiCryptoError('API_CRYPTO_KEY_MISMATCH', `${algo} 的密钥或 IV 长度不对`)
  }
  /**
   * 解密失败只给可分类原因，不回显 OpenSSL 原文：
   * `error:1e000065:...:BAD_DECRYPT` 这类文本对用户没有意义，还会把排查方向带偏。
   */
  /** Bun 与 Node 的文案不同：`BAD_DECRYPT` 与 `bad decrypt` 都要认出来。 */
  if (/bad[_ ]?decrypt|wrong final block length|unable to authenticate/i.test(detail)) {
    return new ApiCryptoError('API_CRYPTO_DECRYPT_FAILED', `解密失败：密钥或 IV 不匹配，或响应不是 ${algo} 加密的密文`)
  }
  return new ApiCryptoError(fallback, `${algo} 执行失败`)
}

/** 二进制结果按目标编码输出；raw 只适用于文本算法，按 UTF-8 还原。 */
function encodeBuffer(buffer: Buffer, encoding: ApiCryptoEncoding): string {
  if (encoding === 'hex') return buffer.toString('hex')
  if (encoding === 'base64') return buffer.toString('base64')
  return buffer.toString('utf8')
}

/**
 * 把「编码后的字符串」还原成字节。
 * hex / base64 会先去掉空白再校验：服务端把密文换行包裹是常见做法，不能因此判成坏数据。
 */
function decodeBuffer(value: string, encoding: ApiCryptoEncoding): Buffer {
  if (encoding === 'raw') return Buffer.from(value, 'utf8')
  const compact = value.replace(/\s+/g, '')
  if (encoding === 'hex') {
    if (compact.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(compact)) throw new ApiCryptoError('API_CRYPTO_DECRYPT_FAILED', '内容不是合法的十六进制')
    return Buffer.from(compact, 'hex')
  }
  if (compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) throw new ApiCryptoError('API_CRYPTO_DECRYPT_FAILED', '内容不是合法的 base64')
  return Buffer.from(compact, 'base64')
}

/** 按目标编码转换文本字节，供注入请求与解析响应复用。 */
export function encodeValue(value: string, encoding: ApiCryptoEncoding): string {
  return encodeBuffer(Buffer.from(value, 'utf8'), encoding)
}

/** 把编码后的文本还原成字符串；编码不合法时报可分类错误而不是返回空串。 */
export function decodeValue(value: string, encoding: ApiCryptoEncoding): string {
  return decodeBuffer(value, encoding).toString('utf8')
}

/**
 * 计算摘要或 HMAC 签名。
 * @param algo 白名单算法名，例如 MD5 / SHA256 / HMAC-SHA256 / SM3
 * @param key HMAC 密钥（非 HMAC 算法忽略该参数），按 UTF-8 字节解释
 * @param content 待签内容
 * @param encoding 输出编码
 * @returns 编码后的摘要字符串
 */
export function digestValue(algo: string, key: string, content: string, encoding: ApiCryptoEncoding): string {
  const hmacName = HMAC_ALGOS[algo]
  const digestName = DIGEST_ALGOS[algo]
  if (!hmacName && !digestName) throw new ApiCryptoError('API_CRYPTO_UNSUPPORTED_ALGO', `未实现的算法 ${algo}`)
  try {
    const bytes = Buffer.from(content, 'utf8')
    const digest = hmacName ? createHmac(hmacName, Buffer.from(key, 'utf8')).update(bytes).digest() : createHash(digestName as string).update(bytes).digest()
    return encodeBuffer(digest, encoding)
  } catch (error) {
    throw classifyCryptoFailure(error, algo, 'API_CRYPTO_UNSUPPORTED_ALGO')
  }
}

/**
 * 对称加密。
 * CBC 走 PKCS#7 自动填充；GCM 额外返回认证标签（固定十六进制）。
 * @returns 密文与可选 tag，按 options.encoding 编码
 */
export function encryptValue(algo: string, key: string, iv: string, plaintext: string, options: ApiCryptoCipherOptions): { ciphertext: string; tag?: string } {
  const name = CIPHER_ALGOS[algo]
  if (!name) throw new ApiCryptoError('API_CRYPTO_UNSUPPORTED_ALGO', `未实现的算法 ${algo}`)
  try {
    const cipher = createCipheriv(name, Buffer.from(key, 'utf8'), Buffer.from(iv, 'utf8'))
    const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()])
    /** GCM 需要把认证标签一并带出，CBC 没有这一步。 */
    const tag = AUTH_TAGGED_ALGOS.has(algo) ? (cipher as unknown as { getAuthTag(): Buffer }).getAuthTag().toString('hex') : undefined
    return { ciphertext: encodeBuffer(ciphertext, options.encoding), ...(tag === undefined ? {} : { tag }) }
  } catch (error) {
    throw classifyCryptoFailure(error, algo, 'API_CRYPTO_KEY_MISMATCH')
  }
}

/**
 * 对称解密。
 * @param options encoding 与（GCM 时的）tag
 * @returns 解密后的明文
 */
export function decryptValue(algo: string, key: string, iv: string, ciphertext: string, options: ApiCryptoCipherOptions): string {
  const name = CIPHER_ALGOS[algo]
  if (!name) throw new ApiCryptoError('API_CRYPTO_UNSUPPORTED_ALGO', `未实现的算法 ${algo}`)
  try {
    const decipher = createDecipheriv(name, Buffer.from(key, 'utf8'), Buffer.from(iv, 'utf8'))
    if (options.tag !== undefined && AUTH_TAGGED_ALGOS.has(algo)) (decipher as unknown as { setAuthTag(tag: Buffer): void }).setAuthTag(Buffer.from(options.tag, 'hex'))
    return Buffer.concat([decipher.update(decodeBuffer(ciphertext, options.encoding)), decipher.final()]).toString('utf8')
  } catch (error) {
    throw classifyCryptoFailure(error, algo, 'API_CRYPTO_DECRYPT_FAILED')
  }
}

/** 可按 `.` 逐层取值的占位符分组，例如 body.sha256、query.sorted。 */
export interface ApiCryptoTemplateGroup {
  raw?: string
  sorted?: string
  sha256?: string
  md5?: string
}

/** 模板上下文：方法、路径、派生值与正文摘要；派生步骤注入的值也走同一张表。 */
export interface ApiCryptoTemplateContext {
  method?: string
  path?: string
  timestamp?: string
  nonce?: string
  query?: string | ApiCryptoTemplateGroup
  body?: ApiCryptoTemplateGroup
  /** 允许 timestamp / nonce 之外的派生占位符按名字直接注入。 */
  [key: string]: string | ApiCryptoTemplateGroup | undefined
}

/** 占位符名按 `.` 逐层取值；取不到或不是字符串时返回 undefined。 */
function resolveTemplateToken(context: ApiCryptoTemplateContext, token: string): string | undefined {
  const [head = '', ...rest] = token.split('.')
  let value: unknown = context[head]
  for (const key of rest) {
    if (!value || typeof value !== 'object') return undefined
    value = (value as Record<string, unknown>)[key]
  }
  return typeof value === 'string' ? value : undefined
}

/**
 * 求值待签/待加密模板。
 * 未知占位符**保持原样**：静默替换成空串会生成一个「看起来成功但签错」的请求，比报错更难查。
 */
export function evaluateCryptoTemplate(template: string, context: ApiCryptoTemplateContext): string {
  return template.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (raw, token: string) => resolveTemplateToken(context, token) ?? raw)
}
