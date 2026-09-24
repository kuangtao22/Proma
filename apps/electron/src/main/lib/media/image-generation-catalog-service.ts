/**
 * 独立生图供应商的目录拉取服务，同时充当连接测试。
 *
 * 密钥型供应商走 /v1/models 并按图像能力过滤；即梦没有 HTTP 接口，
 * 通过 `dreamina user_credit` 验证登录态并直接返回内置 model_version 清单。
 * 只返回模型 ID 与能力，上游正文、HTTP 状态、CLI 输出与本地路径都不穿过该边界。
 */
import type {
  ImageGenerationCatalogFetchInput,
  ImageGenerationCatalogFetchResult,
  ImageGenerationModelEntry,
  ImageGenerationProvider,
} from '@proma/shared'
import {
  IMAGE_GENERATION_CATALOG_FAILURE_MESSAGES,
  IMAGE_GENERATION_CATALOG_MESSAGES,
  IMAGE_GENERATION_PROVIDER_DEFAULTS,
  IMAGE_PROVIDER_MODEL_LIMIT,
  parseImageGenerationCatalogFetchInput,
  parseImageGenerationCatalogFetchResult,
} from '@proma/shared'

/** 单个响应体允许占用的最大 UTF-8 字节数。 */
const CATALOG_RESPONSE_MAX_BYTES = 1024 * 1024
/** 单次拉取的默认超时时间。 */
const DEFAULT_TIMEOUT_MS = 15_000
/** 允许检查的错误 cause 最大层数，避免处理不受信任对象时无界遍历。 */
const ERROR_CAUSE_MAX_DEPTH = 4
/** Node/Bun fetch 可能暴露的证书校验错误码，仅按结构化 code 判定。 */
const TLS_ERROR_CODES = new Set([
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_UNTRUSTED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'ERR_TLS_CERT_SIGNATURE_ALGORITHM_UNSUPPORTED',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
])

/** 判断未知值是否为可枚举的普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 凭据解析入口，由 IPC 层注入真实 Store。 */
export interface ImageGenerationCatalogCredentialStore {
  /** 解密指定配置的明文 API Key；即梦调用会抛稳定错误。 */
  resolveApiKey(profileId: string): string
}

/** 拉取所需的最小 fetch 调用签名，便于测试注入普通函数。 */
export type ImageGenerationCatalogFetch = (input: string | URL, init?: RequestInit) => Promise<Response>

/** CLI 调用结果，屏蔽 stdout 内容只保留成败。 */
export interface ImageGenerationCliResult {
  exitCode: number
  /** 需要区分“未安装”与“未登录”时由实现给出稳定错误码。 */
  failureCode?: 'cliMissing' | 'cliNotLoggedIn' | 'timeout'
}

export interface ImageGenerationCatalogServiceOptions {
  /** 凭据来源。 */
  store: ImageGenerationCatalogCredentialStore
  /** 可注入的 fetch 实现，仅用于测试。 */
  fetchImpl?: ImageGenerationCatalogFetch
  /** 可注入的 CLI 执行器，仅用于测试。 */
  runCli?: (args: readonly string[], cliPath: string) => Promise<ImageGenerationCliResult>
  /** 可注入的超时时间，仅用于测试。 */
  timeoutMs?: number
}

/** 管理「从供应商获取」，任何失败都收敛为固定文案的 failed 结果。 */
export class ImageGenerationCatalogService {
  private readonly store: ImageGenerationCatalogCredentialStore
  private readonly fetchImpl: ImageGenerationCatalogFetch
  private readonly runCli: (args: readonly string[], cliPath: string) => Promise<ImageGenerationCliResult>
  private readonly timeoutMs: number

  constructor(options: ImageGenerationCatalogServiceOptions) {
    this.store = options.store
    this.fetchImpl = options.fetchImpl ?? fetch
    this.runCli = options.runCli ?? defaultRunCli
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  /** 解析输入、按供应商拉取，并返回脱敏结果。 */
  async fetch(value: unknown): Promise<ImageGenerationCatalogFetchResult> {
    const input = parseImageGenerationCatalogFetchInput(value)
    /** 分类失败文案；未识别的错误回落到通用文案。 */
    let failureMessage: string = IMAGE_GENERATION_CATALOG_MESSAGES.failed
    try {
      const models = input.provider === 'dreamina'
        ? await this.collectDreamina()
        : await this.collectHttp(input)
      return parseImageGenerationCatalogFetchResult({
        requestId: input.requestId,
        state: 'success',
        message: IMAGE_GENERATION_CATALOG_MESSAGES.success,
        models,
      })
    } catch (error) {
      if (error instanceof Error) failureMessage = ImageGenerationCatalogService.describeFailure(error, failureMessage)
      return parseImageGenerationCatalogFetchResult({
        requestId: input.requestId,
        state: 'failed',
        message: failureMessage,
        models: [],
      })
    }
  }

  /** 即梦：CLI 登录态探测 + 内置模型清单。 */
  private async collectDreamina(): Promise<ImageGenerationModelEntry[]> {
    /** CLI 路径缺省时交给 CLI 自己按 PATH 解析。 */
    const result = await this.runCli(['user_credit'], 'dreamina')
    if (result.failureCode === 'cliMissing') throw new Error('IMAGE_GENERATION_CATALOG_CLI_MISSING')
    if (result.failureCode === 'timeout') throw new Error('IMAGE_GENERATION_CATALOG_TIMEOUT')
    if (result.exitCode !== 0) throw new Error('IMAGE_GENERATION_CATALOG_CLI_NOT_LOGGED_IN')
    return IMAGE_GENERATION_PROVIDER_DEFAULTS.dreamina.builtinModels.map((model) => ({ ...model }))
  }

  /** 密钥型供应商：读取模型清单并按图像能力过滤。 */
  private async collectHttp(input: ImageGenerationCatalogFetchInput): Promise<ImageGenerationModelEntry[]> {
    if (input.provider === 'dreamina' || !input.baseUrl) {
      throw new Error('IMAGE_GENERATION_CATALOG_INVALID_RESPONSE')
    }
    /** 凭据解析失败与上游错误必须区分，便于用户知道改哪里。 */
    let apiKey: string
    try {
      apiKey = input.credential.mode === 'draft'
        ? input.credential.apiKey
        : input.credential.mode === 'saved'
          ? this.store.resolveApiKey(input.credential.profileId)
          : (() => { throw new Error('none') })()
    } catch {
      throw new Error('IMAGE_GENERATION_CATALOG_CREDENTIAL')
    }
    const baseUrl = input.baseUrl.replace(/\/+$/, '')
    const payload = await this.requestJson(`${baseUrl}/models`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    return ImageGenerationCatalogService.extractImageModels(payload, input.provider)
  }

  /** 把内部错误码翻译成可公开的固定文案。 */
  private static describeFailure(error: Error, fallback: string): string {
    switch (error.message) {
      case 'IMAGE_GENERATION_CATALOG_CREDENTIAL':
        return IMAGE_GENERATION_CATALOG_FAILURE_MESSAGES.credential
      case 'IMAGE_GENERATION_CATALOG_UNAUTHORIZED':
        return IMAGE_GENERATION_CATALOG_FAILURE_MESSAGES.unauthorized
      case 'IMAGE_GENERATION_CATALOG_NOT_FOUND':
        return IMAGE_GENERATION_CATALOG_FAILURE_MESSAGES.notFound
      case 'IMAGE_GENERATION_CATALOG_TIMEOUT':
        return IMAGE_GENERATION_CATALOG_FAILURE_MESSAGES.timeout
      case 'IMAGE_GENERATION_CATALOG_TLS':
        return IMAGE_GENERATION_CATALOG_FAILURE_MESSAGES.tls
      case 'IMAGE_GENERATION_CATALOG_NETWORK':
        return IMAGE_GENERATION_CATALOG_FAILURE_MESSAGES.network
      case 'IMAGE_GENERATION_CATALOG_REDIRECT':
        return IMAGE_GENERATION_CATALOG_FAILURE_MESSAGES.redirect
      case 'IMAGE_GENERATION_CATALOG_CLI_MISSING':
        return IMAGE_GENERATION_CATALOG_FAILURE_MESSAGES.cliMissing
      case 'IMAGE_GENERATION_CATALOG_CLI_NOT_LOGGED_IN':
        return IMAGE_GENERATION_CATALOG_FAILURE_MESSAGES.cliNotLoggedIn
      case 'IMAGE_GENERATION_CATALOG_INVALID_RESPONSE':
      case 'IMAGE_GENERATION_CATALOG_RESPONSE_LIMIT':
        return IMAGE_GENERATION_CATALOG_FAILURE_MESSAGES.malformed
      case 'IMAGE_GENERATION_CATALOG_UPSTREAM_STATUS':
        return IMAGE_GENERATION_CATALOG_FAILURE_MESSAGES.upstream
      default:
        return fallback
    }
  }

  /** 带超时与响应体上限的 JSON 请求。 */
  private async requestJson(url: string, init: RequestInit): Promise<unknown> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      /** 超时与取消必须与上游错误区分，便于提示用户检查网络或地址。 */
      let response: Response
      try {
        response = await this.fetchImpl(url, { ...init, redirect: 'manual', signal: controller.signal })
      } catch (error) {
        throw ImageGenerationCatalogService.classifyTransportFailure(error, controller.signal.aborted)
      }
      if (response.status >= 300 && response.status < 400) throw new Error('IMAGE_GENERATION_CATALOG_REDIRECT')
      if (response.status === 401 || response.status === 403) throw new Error('IMAGE_GENERATION_CATALOG_UNAUTHORIZED')
      if (response.status === 404) throw new Error('IMAGE_GENERATION_CATALOG_NOT_FOUND')
      if (!response.ok) throw new Error('IMAGE_GENERATION_CATALOG_UPSTREAM_STATUS')
      let text: string
      try {
        text = await response.text()
      } catch (error) {
        throw ImageGenerationCatalogService.classifyTransportFailure(error, controller.signal.aborted)
      }
      if (Buffer.byteLength(text, 'utf8') > CATALOG_RESPONSE_MAX_BYTES) {
        throw new Error('IMAGE_GENERATION_CATALOG_RESPONSE_LIMIT')
      }
      try {
        return JSON.parse(text) as unknown
      } catch {
        throw new Error('IMAGE_GENERATION_CATALOG_INVALID_RESPONSE')
      }
    } finally {
      clearTimeout(timer)
    }
  }

  /** 把 fetch 与正文读取异常收敛为不含上游消息的稳定错误码。 */
  private static classifyTransportFailure(error: unknown, timedOut: boolean): Error {
    if (timedOut) return new Error('IMAGE_GENERATION_CATALOG_TIMEOUT')
    return new Error(ImageGenerationCatalogService.hasTlsErrorCode(error)
      ? 'IMAGE_GENERATION_CATALOG_TLS'
      : 'IMAGE_GENERATION_CATALOG_NETWORK')
  }

  /** 在有限层 cause 链上查找已知 TLS code，不根据可能含敏感信息的 message 猜测。 */
  private static hasTlsErrorCode(error: unknown): boolean {
    let current: unknown = error
    for (let depth = 0; depth <= ERROR_CAUSE_MAX_DEPTH && isRecord(current); depth += 1) {
      if (typeof current.code === 'string' && TLS_ERROR_CODES.has(current.code)) return true
      current = current.cause
    }
    return false
  }

  /**
   * 提取图像模型。
   * 入参：上游响应与供应商；返回值：只保留能做图的模型（能力按命名推断，参数留给执行器默认）。
   * 两家的 /models 都同时登记对话模型，必须过滤，避免选到纯文本模型。
   */
  private static extractImageModels(payload: unknown, provider: ImageGenerationProvider): ImageGenerationModelEntry[] {
    const candidates = Array.isArray(payload)
      ? payload
      : isRecord(payload) && Array.isArray(payload.data)
        ? payload.data
        : isRecord(payload) && Array.isArray(payload.models)
          ? payload.models
          : null
    if (candidates === null) throw new Error('IMAGE_GENERATION_CATALOG_INVALID_RESPONSE')
    const seen = new Set<string>()
    const models: ImageGenerationModelEntry[] = []
    for (const entry of candidates) {
      const id = typeof entry === 'string'
        ? entry
        : isRecord(entry) && typeof entry.id === 'string'
          ? entry.id
          : ''
      const trimmed = id.trim()
      if (!trimmed || seen.has(trimmed) || !ImageGenerationCatalogService.isImageModel(provider, trimmed)) continue
      seen.add(trimmed)
      models.push({
        id: trimmed,
        capabilities: ImageGenerationCatalogService.inferCapabilities(provider, trimmed),
      })
      if (models.length >= IMAGE_PROVIDER_MODEL_LIMIT) break
    }
    return models
  }

  /** 判断模型 ID 是否属于该供应商的图像族。 */
  private static isImageModel(provider: ImageGenerationProvider, modelId: string): boolean {
    return provider === 'openai-images'
      ? /image|dall-e/i.test(modelId)
      : /^image[-_]/i.test(modelId)
  }

  /** 按命名推断能力：OpenAI 的 gpt-image 系列同时支持图生图。 */
  private static inferCapabilities(
    provider: ImageGenerationProvider,
    modelId: string,
  ): ImageGenerationModelEntry['capabilities'] {
    if (provider === 'openai-images') {
      return /^gpt-image/i.test(modelId)
        ? ['text-to-image', 'image-to-image']
        : ['text-to-image']
    }
    return ['text-to-image']
  }
}

/** 生产默认：用 CLI 验证即梦登录态，不读取或保存任何凭据。 */
async function defaultRunCli(args: readonly string[], cliPath: string): Promise<ImageGenerationCliResult> {
  const { spawn } = await import('node:child_process')
  return await new Promise<ImageGenerationCliResult>((resolve) => {
    let settled = false
    const child = spawn(cliPath, [...args], { stdio: 'ignore' })
    /** CLI 缺失与普通失败必须区分，前者提示安装路径。 */
    child.once('error', () => { if (!settled) { settled = true; resolve({ exitCode: 1, failureCode: 'cliMissing' }) } })
    child.once('exit', (code) => { if (!settled) { settled = true; resolve({ exitCode: code ?? 1 }) } })
  })
}
