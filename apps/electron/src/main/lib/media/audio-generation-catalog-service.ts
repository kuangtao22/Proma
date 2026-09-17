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
  AudioGenerationVoice,
} from '@proma/shared'
import {
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
    try {
      const apiKey = input.credential.mode === 'draft'
        ? input.credential.apiKey
        : this.store.resolveApiKey(input.credential.profileId)
      const collected = await this.collect(input, apiKey)
      return parseAudioGenerationCatalogFetchResult({
        requestId: input.requestId,
        state: 'success',
        message: AUDIO_GENERATION_CATALOG_MESSAGES.success,
        models: collected.models,
        voices: collected.voices,
      })
    } catch {
      /** 失败只暴露固定文案，避免上游正文或本地路径进入 Renderer。 */
      return parseAudioGenerationCatalogFetchResult({
        requestId: input.requestId,
        state: 'failed',
        message: AUDIO_GENERATION_CATALOG_MESSAGES.failed,
        models: [],
        voices: [],
      })
    }
  }

  /** 按供应商收集模型与音色候选。 */
  private async collect(input: AudioGenerationCatalogFetchInput, apiKey: string): Promise<AudioGenerationCatalogCollection> {
    /** 归一化后的服务基地址，避免出现双斜杠。 */
    const baseUrl = input.baseUrl.replace(/\/+$/, '')
    const models = await this.fetchModels(baseUrl, apiKey)
    /** 小米音色是官方内置清单，不需要额外请求；MiniMax 需要按账号拉取。 */
    const voices = input.provider === 'xiaomi'
      ? [...AUDIO_GENERATION_PROVIDER_DEFAULTS.xiaomi.builtinVoices]
      : await this.fetchMiniMaxVoices(baseUrl, apiKey)
    return { models, voices }
  }

  /** 读取 OpenAI 兼容的模型列表，并归一化为去重后的稳定顺序。 */
  private async fetchModels(baseUrl: string, apiKey: string): Promise<string[]> {
    const payload = await this.requestJson(`${baseUrl}/models`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    return AudioGenerationCatalogService.extractModelIds(payload)
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
      const response = await this.fetchImpl(url, { ...init, signal: controller.signal })
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

  /** 提取模型 ID，兼容 data/models 数组与纯字符串数组三种形态。 */
  private static extractModelIds(payload: unknown): string[] {
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
      if (trimmed) seen.add(trimmed)
      if (seen.size >= AUDIO_GENERATION_MODEL_LIMIT) break
    }
    return [...seen]
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
