/** 独立 API 模型可生成的媒体种类。 */
export type MediaApiModelKind = 'image' | 'audio' | 'video'

/** 已有或计划接入的供应商协议；协议名不代表运行适配已存在。 */
export type MediaApiModelProtocol =
  | 'openai-images'
  | 'minimax-image'
  | 'minimax-video'
  | 'minimax-speech'
  | 'minimax-music'

/** Agent 可用于确定性筛选的媒体任务能力。 */
export type MediaApiModelCapability =
  | 'text-to-image'
  | 'image-to-image'
  | 'text-to-video'
  | 'image-to-video'
  | 'text-to-speech'
  | 'voice-cloning'
  | 'text-to-music'

/** 保存于统一目录且只引用现有渠道凭据的非敏感模型配置。 */
export interface MediaApiModelProfile {
  id: string
  name: string
  mediaKind: MediaApiModelKind
  protocol: MediaApiModelProtocol
  channelId: string
  modelId: string
  capabilities: MediaApiModelCapability[]
  enabled: boolean
  createdAt: number
  updatedAt: number
}

/** 运行适配支持与配置存在分开报告，避免把示例协议冒充可执行能力。 */
export type MediaApiModelExecutionSupport =
  | { state: 'supported'; adapterId: string }
  | { state: 'configuration-only'; reason: string }
  | { state: 'unavailable'; reason: string }

/** 设置、Agent 候选与画布范围共用的公开目录条目。 */
export interface MediaApiModelCatalogEntry {
  profile: MediaApiModelProfile
  /** 当前渠道的用户可见名称；渠道已删除时缺省，由消费端回退到稳定 ID。 */
  channelName?: string
  support: MediaApiModelExecutionSupport
}

/** Renderer 读取的统一 API 媒体模型目录。 */
export interface MediaApiModelCatalogResult {
  revision: number
  entries: MediaApiModelCatalogEntry[]
}

/** 使用目录 revision 完整替换 API 媒体模型，防止多窗口静默覆盖。 */
export interface SaveMediaApiModelProfilesInput {
  profiles: MediaApiModelProfile[]
  expectedRevision: number
}

/** 设置页使用的协议固定输出类型与默认能力。 */
export interface MediaApiModelProtocolDescriptor {
  protocol: MediaApiModelProtocol
  mediaKind: MediaApiModelKind
  capabilities: readonly MediaApiModelCapability[]
}

/** 协议固定能力的公开只读描述，UI 不自行猜测协议语义。 */
export const MEDIA_API_MODEL_PROTOCOLS: readonly MediaApiModelProtocolDescriptor[] = [
  { protocol: 'openai-images', mediaKind: 'image', capabilities: ['text-to-image', 'image-to-image'] },
  { protocol: 'minimax-image', mediaKind: 'image', capabilities: ['text-to-image', 'image-to-image'] },
  { protocol: 'minimax-video', mediaKind: 'video', capabilities: ['text-to-video', 'image-to-video'] },
  { protocol: 'minimax-speech', mediaKind: 'audio', capabilities: ['text-to-speech', 'voice-cloning'] },
  { protocol: 'minimax-music', mediaKind: 'audio', capabilities: ['text-to-music'] },
] as const

/** 统一目录的精确字段，阻止把运行秘密或未知配置带入持久化。 */
const PROFILE_KEYS = ['id', 'name', 'mediaKind', 'protocol', 'channelId', 'modelId', 'capabilities', 'enabled', 'createdAt', 'updatedAt'] as const
/** 稳定 ID、渠道和模型标识的长度上限。 */
const IDENTIFIER_MAX_LENGTH = 256
/** 用户可见名称的长度上限。 */
const NAME_MAX_LENGTH = 128
/** 单模型允许的能力数量上限。 */
const CAPABILITY_LIMIT = 16
/** Canvas scope 可持久化的稳定模型 ID，与 scope parser 使用同一字符合同。 */
const MODEL_SCOPE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/
/** 会触发对象原型语义的保留 ID。 */
const RESERVED_MODEL_IDS = new Set(['__proto__', 'constructor', 'prototype'])

/** 判断未知值是否为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 判断字符串是否为受支持的媒体类型。 */
function isMediaKind(value: unknown): value is MediaApiModelKind {
  return value === 'image' || value === 'audio' || value === 'video'
}

/** 判断字符串是否为已声明的供应商协议。 */
function isProtocol(value: unknown): value is MediaApiModelProtocol {
  return typeof value === 'string' && MEDIA_API_MODEL_PROTOCOLS.some((item) => item.protocol === value)
}

/** 判断字符串是否为已声明的任务能力。 */
function isCapability(value: unknown): value is MediaApiModelCapability {
  return value === 'text-to-image' || value === 'image-to-image'
    || value === 'text-to-video' || value === 'image-to-video'
    || value === 'text-to-speech' || value === 'voice-cloning' || value === 'text-to-music'
}

/** 读取并清洗必填短文本。 */
function parseText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) throw new Error(`${label}无效`)
  return value.trim()
}

/** 解析可安全进入 Canvas scope 的稳定模型 ID。 */
function parseModelScopeId(value: unknown): string {
  if (typeof value !== 'string' || !MODEL_SCOPE_ID_PATTERN.test(value) || RESERVED_MODEL_IDS.has(value)) {
    throw new Error('模型 ID 无效')
  }
  return value
}

/** 解析统一媒体模型配置，并校验协议、媒体类型与能力的一致性。 */
export function parseMediaApiModelProfile(value: unknown): MediaApiModelProfile {
  if (!isRecord(value) || !Object.keys(value).every((key) => PROFILE_KEYS.includes(key as typeof PROFILE_KEYS[number]))) {
    throw new Error('媒体 API 模型字段无效')
  }
  if (!isMediaKind(value.mediaKind) || !isProtocol(value.protocol)) throw new Error('媒体 API 模型协议或类型无效')
  /** 已收窄的媒体类型，供闭包内稳定索引。 */
  const mediaKind = value.mediaKind
  /** 已收窄的供应商协议。 */
  const protocol = value.protocol
  /** 协议的唯一公开描述。 */
  const descriptor = MEDIA_API_MODEL_PROTOCOLS.find((item) => item.protocol === protocol)
  if (!descriptor || descriptor.mediaKind !== mediaKind) throw new Error('媒体 API 模型协议与输出类型不匹配')
  if (!Array.isArray(value.capabilities) || value.capabilities.length === 0 || value.capabilities.length > CAPABILITY_LIMIT) throw new Error('媒体 API 模型能力无效')
  /** 逐项收窄后的任务能力。 */
  const parsedCapabilities = value.capabilities.map((capability): MediaApiModelCapability => {
    if (!isCapability(capability)) throw new Error('媒体 API 模型能力无效')
    return capability
  })
  /** 去重后的任务能力。 */
  const capabilities = [...new Set(parsedCapabilities)]
  if (capabilities.length !== value.capabilities.length
    || !capabilities.every((capability) => descriptor.capabilities.includes(capability))) {
    throw new Error('媒体 API 模型能力与输出类型不匹配')
  }
  if (typeof value.enabled !== 'boolean' || !Number.isSafeInteger(value.createdAt) || Number(value.createdAt) < 0
    || !Number.isSafeInteger(value.updatedAt) || Number(value.updatedAt) < Number(value.createdAt)) {
    throw new Error('媒体 API 模型状态无效')
  }
  return {
    id: parseModelScopeId(value.id),
    name: parseText(value.name, '模型名称', NAME_MAX_LENGTH),
    mediaKind,
    protocol,
    channelId: parseText(value.channelId, '渠道 ID', IDENTIFIER_MAX_LENGTH),
    modelId: parseText(value.modelId, '供应商模型 ID', IDENTIFIER_MAX_LENGTH),
    capabilities,
    enabled: value.enabled,
    createdAt: Number(value.createdAt),
    updatedAt: Number(value.updatedAt),
  }
}

/** 只有启用且具备真实 adapter 的模型才能进入执行候选。 */
export function canExecuteMediaApiModel(entry: Pick<MediaApiModelCatalogEntry, 'profile' | 'support'>): boolean {
  return entry.profile.enabled && entry.support.state === 'supported' && entry.support.adapterId.trim().length > 0
}
