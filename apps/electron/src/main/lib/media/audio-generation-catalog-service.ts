/**
 * 独立音频供应商「从供应商获取」服务。
 *
 * 用已保存的密文凭据或本次表单草稿凭据请求模型与音色候选，并把结果收敛成
 * 公开形态：只返回模型 ID 与音色 ID/名称，上游正文、HTTP 状态与本地路径
 * 一律不穿过该边界。
 */
import type {
  AudioGenerationCatalogFetchInput,
  AudioGenerationCatalogFetchResult,
  AudioGenerationProvider,
  AudioGenerationVoice,
} from '@proma/shared'
import {
  AUDIO_GENERATION_CATALOG_FAILURE_MESSAGES,
  AUDIO_GENERATION_CATALOG_MESSAGES,
  AUDIO_GENERATION_MODEL_LIMIT,
  AUDIO_GENERATION_PROVIDER_DEFAULTS,
  AUDIO_GENERATION_VOICE_LIMIT,
  parseAudioGenerationCatalogFetchInput,
  parseAudioGenerationCatalogFetchResult,
} from '@proma/shared'

/** 单个响应体允许占用的最大 UTF-8 字节数。 */
const CATALOG_RESPONSE_MAX_BYTES = 1024 * 1024
/** 单次拉取的默认超时时间，避免上游挂起阻塞设置页。 */
const DEFAULT_TIMEOUT_MS = 15_000

/** 判断未知值是否为可枚举的普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 凭据解析入口，由 IPC 层注入真实 Store。 */
export interface AudioGenerationCatalogCredentialStore {
  /** 解密指定配置的明文 API Key；失败时抛稳定错误。 */
  resolveApiKey(profileId: string): string
}

/** 拉取所需的最小 fetch 调用签名，便于测试注入普通函数。 */
export type AudioGenerationCatalogFetch = (input: string | URL, init?: RequestInit) => Promise<Response>

export interface AudioGenerationCatalogServiceOptions {
  /** 凭据来源。 */
  store: AudioGenerationCatalogCredentialStore
  /** 可注入的 fetch 实现，仅用于测试。 */
  fetchImpl?: AudioGenerationCatalogFetch
  /** 可注入的超时时间，仅用于测试。 */
  timeoutMs?: number
}

/** 供应商返回的模型与音色候选。 */
interface AudioGenerationCatalogCollection {
  models: string[]
  voices: AudioGenerationVoice[]
}

/** 管理「从供应商获取」，任何失败都收敛为固定文案的 failed 结果。 */
export class AudioGenerationCatalogService {
  /** 凭据来源。 */
  private readonly store: AudioGenerationCatalogCredentialStore
  /** 实际执行的 fetch。 */
  private readonly fetchImpl: AudioGenerationCatalogFetch
  /** 单次请求超时时间。 */
  private readonly timeoutMs: number

  constructor(options: AudioGenerationCatalogServiceOptions) {
    this.store = options.store
    this.fetchImpl = options.fetchImpl ?? fetch
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  /** 解析输入、按供应商拉取，并返回脱敏结果。 */
  async fetch(value: unknown): Promise<AudioGenerationCatalogFetchResult> {
    const input = parseAudioGenerationCatalogFetchInput(value)
    /** 分类失败文案；未识别的错误回落到通用文案。 */
    let failureMessage: string = AUDIO_GENERATION_CATALOG_MESSAGES.failed
    try {
      /** 已保存凭据解密失败与上游错误必须区分，便于用户知道改哪里。 */
      let apiKey: string
      try {
        apiKey = input.credential.mode === 'draft'
          ? input.credential.apiKey
          : this.store.resolveApiKey(input.credential.profileId)
      } catch {
        throw new Error('AUDIO_GENERATION_CATALOG_CREDENTIAL')
      }
      const collected = await this.collect(input, apiKey)
      return parseAudioGenerationCatalogFetchResult({
        requestId: input.requestId,
        state: 'success',
        message: AUDIO_GENERATION_CATALOG_MESSAGES.success,
        models: collected.models,
        voices: collected.voices,
      })
    } catch (error) {
      if (error instanceof Error) {
        failureMessage = AudioGenerationCatalogService.describeFailure(error, failureMessage)
      }
      /** 失败只暴露分类固定文案，避免上游正文或本地路径进入 Renderer。 */
      return parseAudioGenerationCatalogFetchResult({
        requestId: input.requestId,
        state: 'failed',
        message: failureMessage,
        models: [],
        voices: [],
      })
    }
  }

  /** 把内部错误码翻译成可公开的固定文案。 */
  private static describeFailure(error: Error, fallback: string): string {
    switch (error.message) {
      case 'AUDIO_GENERATION_CATALOG_CREDENTIAL':
        return AUDIO_GENERATION_CATALOG_FAILURE_MESSAGES.credential
      case 'AUDIO_GENERATION_CATALOG_UNAUTHORIZED':
        return AUDIO_GENERATION_CATALOG_FAILURE_MESSAGES.unauthorized
      case 'AUDIO_GENERATION_CATALOG_NOT_FOUND':
        return AUDIO_GENERATION_CATALOG_FAILURE_MESSAGES.notFound
      case 'AUDIO_GENERATION_CATALOG_TIMEOUT':
        return AUDIO_GENERATION_CATALOG_FAILURE_MESSAGES.timeout
      case 'AUDIO_GENERATION_CATALOG_INVALID_RESPONSE':
      case 'AUDIO_GENERATION_CATALOG_RESPONSE_LIMIT':
        return AUDIO_GENERATION_CATALOG_FAILURE_MESSAGES.malformed
      case 'AUDIO_GENERATION_CATALOG_UPSTREAM_STATUS':
        return AUDIO_GENERATION_CATALOG_FAILURE_MESSAGES.upstream
      default:
        return fallback
    }
  }

  /** 按供应商收集模型与音色候选。 */
  private async collect(input: AudioGenerationCatalogFetchInput, apiKey: string): Promise<AudioGenerationCatalogCollection> {
    /** 归一化后的服务基地址，避免出现双斜杠。 */
    const baseUrl = input.baseUrl.replace(/\/+$/, '')
    const models = await this.fetchModels(input.provider, baseUrl, apiKey)
    /** 小米音色是官方内置清单，不需要额外请求；MiniMax 需要按账号拉取。 */
    const voices = input.provider === 'xiaomi'
      ? [...AUDIO_GENERATION_PROVIDER_DEFAULTS.xiaomi.builtinVoices]
      : await this.fetchMiniMaxVoices(baseUrl, apiKey)
    return { models, voices }
  }

  /** 读取 OpenAI 兼容的模型列表，并归一化为去重后的稳定顺序。 */
  private async fetchModels(provider: AudioGenerationProvider, baseUrl: string, apiKey: string): Promise<string[]> {
    const payload = await this.requestJson(`${baseUrl}/models`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    return AudioGenerationCatalogService.extractModelIds(payload, provider)
  }

  /** 读取 MiniMax Voice Management 的音色列表。 */
  private async fetchMiniMaxVoices(baseUrl: string, apiKey: string): Promise<AudioGenerationVoice[]> {
    const payload = await this.requestJson(`${baseUrl}/get_voice`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ voice_type: 'all' }),
    })
    return AudioGenerationCatalogService.extractMiniMaxVoices(payload)
  }

  /** 带超时与响应体上限的 JSON 请求。 */
  private async requestJson(url: string, init: RequestInit): Promise<unknown> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      /** 超时与取消必须与上游错误区分，便于提示用户检查网络或地址。 */
      let response: Response
      try {
        response = await this.fetchImpl(url, { ...init, signal: controller.signal })
      } catch {
        throw new Error(controller.signal.aborted
          ? 'AUDIO_GENERATION_CATALOG_TIMEOUT'
          : 'AUDIO_GENERATION_CATALOG_UPSTREAM_STATUS')
      }
      if (response.status === 401 || response.status === 403) {
        throw new Error('AUDIO_GENERATION_CATALOG_UNAUTHORIZED')
      }
      if (response.status === 404) throw new Error('AUDIO_GENERATION_CATALOG_NOT_FOUND')
      if (!response.ok) throw new Error('AUDIO_GENERATION_CATALOG_UPSTREAM_STATUS')
      const text = await response.text()
      if (Buffer.byteLength(text, 'utf8') > CATALOG_RESPONSE_MAX_BYTES) {
        throw new Error('AUDIO_GENERATION_CATALOG_RESPONSE_LIMIT')
      }
      return JSON.parse(text) as unknown
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * 提取语音合成模型 ID。
   * 入参：上游响应与供应商；返回值：只包含能做 TTS 的模型 ID。
   * 两家的 /models 都同时返回对话模型，音频配置里必须过滤，避免选到 LLM：
   * 小米的语音模型名都带 `tts`（mimo-v2.5-tts 及 voiceclone / voicedesign 变体），
   * MiniMax 的语音模型名以 `speech-` 开头。
   */
  private static extractModelIds(payload: unknown, provider: AudioGenerationProvider): string[] {
    const candidates = Array.isArray(payload)
      ? payload
      : isRecord(payload) && Array.isArray(payload.data)
        ? payload.data
        : isRecord(payload) && Array.isArray(payload.models)
          ? payload.models
          : null
    if (candidates === null) throw new Error('AUDIO_GENERATION_CATALOG_INVALID_RESPONSE')
    /** 已出现的模型 ID，保持上游顺序并去重。 */
    const seen = new Set<string>()
    for (const entry of candidates) {
      const id = typeof entry === 'string'
        ? entry
        : isRecord(entry) && typeof entry.id === 'string'
          ? entry.id
          : isRecord(entry) && typeof entry.name === 'string'
            ? entry.name
            : ''
      const trimmed = id.trim()
      if (trimmed && AudioGenerationCatalogService.isSpeechModel(provider, trimmed)) seen.add(trimmed)
      if (seen.size >= AUDIO_GENERATION_MODEL_LIMIT) break
    }
    return [...seen]
  }

  /** 判断模型 ID 是否属于该供应商的语音合成族。 */
  private static isSpeechModel(provider: AudioGenerationProvider, modelId: string): boolean {
    return provider === 'xiaomi'
      ? /tts/i.test(modelId)
      : /^speech[-_]/i.test(modelId)
  }

  /** 提取 MiniMax 系统、克隆与生成音色，条目缺少 voice_id 时跳过。 */
  private static extractMiniMaxVoices(payload: unknown): AudioGenerationVoice[] {
    if (!isRecord(payload)) throw new Error('AUDIO_GENERATION_CATALOG_INVALID_RESPONSE')
    /** 已出现的音色 ID，避免三个分组之间重复。 */
    const seen = new Set<string>()
    const voices: AudioGenerationVoice[] = []
    for (const groupKey of ['system_voice', 'voice_cloning', 'voice_generation'] as const) {
      const group = payload[groupKey]
      const items = Array.isArray(group)
        ? group
        : isRecord(group) && Array.isArray(group.items)
          ? group.items
          : []
      for (const item of items) {
        if (!isRecord(item) || typeof item.voice_id !== 'string') continue
        const id = item.voice_id.trim()
        if (!id || seen.has(id)) continue
        seen.add(id)
        const name = typeof item.voice_name === 'string' ? item.voice_name.trim() : ''
        voices.push(name ? { id, name, source: 'remote' } : { id, source: 'remote' })
        if (voices.length >= AUDIO_GENERATION_VOICE_LIMIT) return voices
      }
    }
    return voices
  }
}
