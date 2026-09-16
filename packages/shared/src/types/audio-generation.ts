/** 首批支持的独立音频生成供应商。 */
export type AudioGenerationProvider = 'xiaomi' | 'minimax'

/** 音频生成配置的供应商无关字段。 */
export interface AudioGenerationProfileBase {
  id: string
  name: string
  baseUrl: string
  modelId: string
  voiceId: string
  enabled: boolean
  createdAt: number
  updatedAt: number
  legacyMediaProfileId?: string
}

/** 独立音频生成配置；供应商专属字段由判别联合约束。 */
export type AudioGenerationProfile =
  | (AudioGenerationProfileBase & { provider: 'xiaomi' })
  | (AudioGenerationProfileBase & { provider: 'minimax'; groupId?: string })

/** 完整替换目录时对单条配置凭据执行的动作。 */
export type AudioGenerationCredentialUpdate =
  | { mode: 'preserve' }
  | { mode: 'replace'; apiKey: string }

/** 完整替换独立音频目录的 CAS 请求。 */
export interface ReplaceAudioGenerationCatalogRequest {
  expectedRevision: number
  profiles: Array<{
    profile: AudioGenerationProfile
    credentialUpdate: AudioGenerationCredentialUpdate
  }>
}

/** Renderer 可读取的音频配置，不包含明文或密文凭据。 */
export type AudioGenerationPublicProfile = AudioGenerationProfile & {
  credentialConfigured: boolean
  endpointOrigin: string
}

/** Renderer 可读取的独立音频目录快照。 */
export interface AudioGenerationPublicCatalog {
  schemaVersion: 1
  revision: number
  profiles: AudioGenerationPublicProfile[]
}

/** 旧统一媒体目录中可提示迁移的最小音频配置摘要。 */
export interface LegacyAudioProfileSummary {
  id: string
  name: string
  protocol: 'minimax-speech'
  modelId: string
  enabled: boolean
}

/** 音频设置页一次读取所需的独立目录与旧配置提示。 */
export interface AudioGenerationSettingsResult {
  catalog: AudioGenerationPublicCatalog
  legacyAudioProfiles: LegacyAudioProfileSummary[]
  legacyWarning?: string
}

/** 使用当前未保存表单直接测试的输入，API Key 仅用于本次 IPC。 */
export interface AudioGenerationDraftTestInput {
  kind: 'draft'
  requestId: string
  profile: AudioGenerationProfile
  apiKey: string
}

/** 使用已保存密文按需测试的输入。 */
export interface AudioGenerationSavedTestInput {
  kind: 'saved'
  requestId: string
  profileId: string
}

/** 音频连接测试的两种互斥输入。 */
export type AudioGenerationTestInput = AudioGenerationDraftTestInput | AudioGenerationSavedTestInput

/** 可公开给 Renderer 的固定测试状态。 */
export type AudioGenerationTestState = 'success' | 'failed' | 'cancelled' | 'unavailable'

/** 音频连接测试的脱敏结果。 */
export interface AudioGenerationTestResult {
  requestId: string
  state: AudioGenerationTestState
  message: string
}

/** 取消指定音频连接测试的 IPC envelope。 */
export interface AudioGenerationTestCancelInput {
  requestId: string
}

/** 供应商可见名称及专属表单字段。 */
export interface AudioGenerationProviderDescriptor {
  provider: AudioGenerationProvider
  label: string
  specificFields: readonly 'groupId'[]
}

/** 设置页唯一可信的供应商描述，顺序同时定义界面展示顺序。 */
export const AUDIO_GENERATION_PROVIDER_DESCRIPTORS = [
  { provider: 'xiaomi', label: '小米 TTS', specificFields: [] },
  { provider: 'minimax', label: 'MiniMax Speech', specificFields: ['groupId'] },
] as const satisfies readonly AudioGenerationProviderDescriptor[]

/** 单个目录允许保存的配置数量上限。 */
export const AUDIO_GENERATION_PROFILE_LIMIT = 128
/** 用户可见名称长度上限。 */
export const AUDIO_GENERATION_NAME_MAX_LENGTH = 128
/** 模型、音色、供应商专属标识与稳定 ID 的长度上限。 */
export const AUDIO_GENERATION_IDENTIFIER_MAX_LENGTH = 256
/** Base URL 的长度上限。 */
export const AUDIO_GENERATION_URL_MAX_LENGTH = 2_048
/** 一次性 API Key 的长度上限。 */
export const AUDIO_GENERATION_API_KEY_MAX_LENGTH = 4_096
/** 可公开提示消息的长度上限。 */
export const AUDIO_GENERATION_MESSAGE_MAX_LENGTH = 2_048

/** 与现有媒体模型目录一致的安全稳定 ID 字符合同。 */
const AUDIO_GENERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/
/** 会触发对象原型语义的保留 ID。 */
const RESERVED_AUDIO_GENERATION_IDS = new Set(['__proto__', 'constructor', 'prototype'])
/** 所有供应商共享的配置字段。 */
const PROFILE_BASE_KEYS = [
  'id', 'name', 'provider', 'baseUrl', 'modelId', 'voiceId', 'enabled', 'createdAt', 'updatedAt', 'legacyMediaProfileId',
] as const
/** 公开配置在持久化配置之外增加的字段。 */
const PUBLIC_PROFILE_KEYS = ['credentialConfigured', 'endpointOrigin'] as const

/** 判断未知值是否为可枚举的普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 判断对象仅包含调用方声明的字段。 */
function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowedKeys.includes(key))
}

/** 判断未知数字是非负安全整数。 */
function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** 解析稳定业务 ID，拒绝原型保留字和不安全字符。 */
function parseStableId(value: unknown): string {
  if (typeof value !== 'string' || !AUDIO_GENERATION_ID_PATTERN.test(value)
    || RESERVED_AUDIO_GENERATION_IDS.has(value)) {
    throw new Error('AUDIO_GENERATION_CONFIG_INVALID')
  }
  return value
}

/** 清洗必填短文本，并按固定上限拒绝异常输入。 */
function parseRequiredText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') throw new Error('AUDIO_GENERATION_CONFIG_INVALID')
  /** 去除用户表单输入两端空白后的稳定文本。 */
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > maxLength) throw new Error('AUDIO_GENERATION_CONFIG_INVALID')
  return trimmed
}

/** 清洗可选短文本；已声明但为空时归一为缺省。 */
function parseOptionalText(value: unknown, maxLength: number): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error('AUDIO_GENERATION_CONFIG_INVALID')
  /** 去除表单输入两端空白后的可选文本。 */
  const trimmed = value.trim()
  if (!trimmed) return undefined
  if (trimmed.length > maxLength) throw new Error('AUDIO_GENERATION_CONFIG_INVALID')
  return trimmed
}

/** 解析安全 Base URL，并移除重复尾斜杠形成稳定表示。 */
function parseBaseUrl(value: unknown): string {
  if (typeof value !== 'string') throw new Error('AUDIO_GENERATION_URL_INVALID')
  /** 清除用户输入两端空白，避免 URL parser 隐式容错产生歧义。 */
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > AUDIO_GENERATION_URL_MAX_LENGTH) {
    throw new Error('AUDIO_GENERATION_URL_INVALID')
  }
  try {
    /** 使用标准 URL 解析器验证协议、凭据和可公开部分。 */
    const parsed = new URL(trimmed)
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error('AUDIO_GENERATION_URL_INVALID')
    }
    return parsed.toString().replace(/\/+$/, '')
  } catch {
    throw new Error('AUDIO_GENERATION_URL_INVALID')
  }
}

/** 解析独立音频配置，并严格保留供应商字段差异。 */
export function parseAudioGenerationProfile(value: unknown): AudioGenerationProfile {
  if (!isRecord(value) || (value.provider !== 'xiaomi' && value.provider !== 'minimax')) {
    throw new Error('AUDIO_GENERATION_CONFIG_INVALID')
  }
  /** 当前供应商允许进入配置的字段集合。 */
  const allowedKeys = value.provider === 'minimax' ? [...PROFILE_BASE_KEYS, 'groupId'] : PROFILE_BASE_KEYS
  if (!hasOnlyKeys(value, allowedKeys)
    || typeof value.enabled !== 'boolean'
    || !isNonNegativeSafeInteger(value.createdAt)
    || !isNonNegativeSafeInteger(value.updatedAt)
    || value.updatedAt < value.createdAt) {
    throw new Error('AUDIO_GENERATION_CONFIG_INVALID')
  }
  /** 两个供应商共享且已清洗的配置字段。 */
  const common: AudioGenerationProfileBase = {
    id: parseStableId(value.id),
    name: parseRequiredText(value.name, AUDIO_GENERATION_NAME_MAX_LENGTH),
    baseUrl: parseBaseUrl(value.baseUrl),
    modelId: parseRequiredText(value.modelId, AUDIO_GENERATION_IDENTIFIER_MAX_LENGTH),
    voiceId: parseRequiredText(value.voiceId, AUDIO_GENERATION_IDENTIFIER_MAX_LENGTH),
    enabled: value.enabled,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  }
  /** 可选的旧目录引用仅接受同一安全 ID 合同。 */
  const legacyMediaProfileId = value.legacyMediaProfileId === undefined
    ? undefined
    : parseStableId(value.legacyMediaProfileId)
  if (legacyMediaProfileId !== undefined) common.legacyMediaProfileId = legacyMediaProfileId
  if (value.provider === 'xiaomi') return { ...common, provider: 'xiaomi' }
  /** MiniMax 专属的可选 Group ID。 */
  const groupId = parseOptionalText(value.groupId, AUDIO_GENERATION_IDENTIFIER_MAX_LENGTH)
  return groupId === undefined
    ? { ...common, provider: 'minimax' }
    : { ...common, provider: 'minimax', groupId }
}

/** 解析单条凭据更新，明文只在 replace 分支短暂存在。 */
function parseCredentialUpdate(value: unknown): AudioGenerationCredentialUpdate {
  if (!isRecord(value) || value.mode === 'preserve' && !hasOnlyKeys(value, ['mode'])) {
    throw new Error('AUDIO_GENERATION_CONFIG_INVALID')
  }
  if (value.mode === 'preserve') return { mode: 'preserve' }
  if (value.mode !== 'replace' || !hasOnlyKeys(value, ['mode', 'apiKey'])) {
    throw new Error('AUDIO_GENERATION_CONFIG_INVALID')
  }
  return {
    mode: 'replace',
    apiKey: parseRequiredText(value.apiKey, AUDIO_GENERATION_API_KEY_MAX_LENGTH),
  }
}

/** 严格解析完整目录替换请求，阻止重复 ID 和秘密字段旁路。 */
export function parseReplaceAudioGenerationCatalogRequest(value: unknown): ReplaceAudioGenerationCatalogRequest {
  if (!isRecord(value) || !hasOnlyKeys(value, ['expectedRevision', 'profiles'])
    || !isNonNegativeSafeInteger(value.expectedRevision)
    || !Array.isArray(value.profiles)
    || value.profiles.length > AUDIO_GENERATION_PROFILE_LIMIT) {
    throw new Error('AUDIO_GENERATION_CONFIG_INVALID')
  }
  /** 按请求顺序严格解析后的目录条目。 */
  const profiles = value.profiles.map((item) => {
    if (!isRecord(item) || !hasOnlyKeys(item, ['profile', 'credentialUpdate'])) {
      throw new Error('AUDIO_GENERATION_CONFIG_INVALID')
    }
    return {
      profile: parseAudioGenerationProfile(item.profile),
      credentialUpdate: parseCredentialUpdate(item.credentialUpdate),
    }
  })
  /** 用于阻止同一替换请求中出现重复配置 ID。 */
  const profileIds = new Set(profiles.map((item) => item.profile.id))
  if (profileIds.size !== profiles.length) throw new Error('AUDIO_GENERATION_CONFIG_INVALID')
  return { expectedRevision: value.expectedRevision, profiles }
}

/** 解析公开配置，并校验摘要 origin 与 Base URL 一致。 */
function parsePublicProfile(value: unknown): AudioGenerationPublicProfile {
  if (!isRecord(value) || (value.provider !== 'xiaomi' && value.provider !== 'minimax')) {
    throw new Error('AUDIO_GENERATION_CONFIG_INVALID')
  }
  /** 当前公开 Profile 的精确允许字段。 */
  const profileKeys = value.provider === 'minimax' ? [...PROFILE_BASE_KEYS, 'groupId'] : PROFILE_BASE_KEYS
  if (!hasOnlyKeys(value, [...profileKeys, ...PUBLIC_PROFILE_KEYS])
    || typeof value.credentialConfigured !== 'boolean') {
    throw new Error('AUDIO_GENERATION_CONFIG_INVALID')
  }
  /** 去除公开摘要字段后交给持久化 Profile parser 复验。 */
  const profileValue = Object.fromEntries(profileKeys
    .filter((key) => Object.hasOwn(value, key))
    .map((key) => [key, value[key]]))
  /** 已通过供应商判别和公共字段校验的配置。 */
  const profile = parseAudioGenerationProfile(profileValue)
  /** 从清洗后的 Base URL 得到唯一可公开端点 origin。 */
  const endpointOrigin = new URL(profile.baseUrl).origin
  if (value.endpointOrigin !== endpointOrigin) throw new Error('AUDIO_GENERATION_CONFIG_INVALID')
  return { ...profile, credentialConfigured: value.credentialConfigured, endpointOrigin }
}

/** 解析旧统一媒体目录中允许公开的最小摘要。 */
function parseLegacyProfileSummary(value: unknown): LegacyAudioProfileSummary {
  if (!isRecord(value)
    || !hasOnlyKeys(value, ['id', 'name', 'protocol', 'modelId', 'enabled'])
    || value.protocol !== 'minimax-speech'
    || typeof value.enabled !== 'boolean') {
    throw new Error('AUDIO_GENERATION_CONFIG_INVALID')
  }
  return {
    id: parseStableId(value.id),
    name: parseRequiredText(value.name, AUDIO_GENERATION_NAME_MAX_LENGTH),
    protocol: 'minimax-speech',
    modelId: parseRequiredText(value.modelId, AUDIO_GENERATION_IDENTIFIER_MAX_LENGTH),
    enabled: value.enabled,
  }
}

/** 严格解析设置页组合结果，避免秘密或未知 Main 字段进入 Renderer。 */
export function parseAudioGenerationSettingsResult(value: unknown): AudioGenerationSettingsResult {
  if (!isRecord(value) || !hasOnlyKeys(value, ['catalog', 'legacyAudioProfiles', 'legacyWarning'])
    || !isRecord(value.catalog)
    || !hasOnlyKeys(value.catalog, ['schemaVersion', 'revision', 'profiles'])
    || value.catalog.schemaVersion !== 1
    || !isNonNegativeSafeInteger(value.catalog.revision)
    || !Array.isArray(value.catalog.profiles)
    || value.catalog.profiles.length > AUDIO_GENERATION_PROFILE_LIMIT
    || !Array.isArray(value.legacyAudioProfiles)
    || value.legacyAudioProfiles.length > AUDIO_GENERATION_PROFILE_LIMIT) {
    throw new Error('AUDIO_GENERATION_CONFIG_INVALID')
  }
  /** 严格解析后的公开独立音频配置。 */
  const profiles = value.catalog.profiles.map(parsePublicProfile)
  /** 严格解析后的旧配置摘要。 */
  const legacyAudioProfiles = value.legacyAudioProfiles.map(parseLegacyProfileSummary)
  /** 两个目录分别检查重复 ID，禁止歧义操作目标。 */
  if (new Set(profiles.map((profile) => profile.id)).size !== profiles.length
    || new Set(legacyAudioProfiles.map((profile) => profile.id)).size !== legacyAudioProfiles.length) {
    throw new Error('AUDIO_GENERATION_CONFIG_INVALID')
  }
  /** 可选的旧目录读取警告，只接受有界中文公开消息。 */
  const legacyWarning = value.legacyWarning === undefined
    ? undefined
    : parsePublicMessage(value.legacyWarning)
  return {
    catalog: { schemaVersion: 1, revision: value.catalog.revision, profiles },
    legacyAudioProfiles,
    ...(legacyWarning === undefined ? {} : { legacyWarning }),
  }
}

/** 判断测试状态属于固定公开集合。 */
function isTestState(value: unknown): value is AudioGenerationTestState {
  return value === 'success' || value === 'failed' || value === 'cancelled' || value === 'unavailable'
}

/** 解析经过 Main 归一化的中文消息，并拒绝明显的凭据或完整 URL 回显。 */
function parsePublicMessage(value: unknown): string {
  /** 清洗并限制后的候选公开消息。 */
  const message = parseRequiredText(value, AUDIO_GENERATION_MESSAGE_MAX_LENGTH)
  if (!/[\u3400-\u9fff]/u.test(message)
    || /https?:\/\/|bearer\s+\S+|authorization\s*[:=]|secret[-_]/iu.test(message)) {
    throw new Error('AUDIO_GENERATION_CONFIG_INVALID')
  }
  return message
}

/** 严格解析草稿或已保存配置的测试请求。 */
export function parseAudioGenerationTestInput(value: unknown): AudioGenerationTestInput {
  if (!isRecord(value)) throw new Error('AUDIO_GENERATION_CONFIG_INVALID')
  if (value.kind === 'draft' && hasOnlyKeys(value, ['kind', 'requestId', 'profile', 'apiKey'])) {
    return {
      kind: 'draft',
      requestId: parseStableId(value.requestId),
      profile: parseAudioGenerationProfile(value.profile),
      apiKey: parseRequiredText(value.apiKey, AUDIO_GENERATION_API_KEY_MAX_LENGTH),
    }
  }
  if (value.kind === 'saved' && hasOnlyKeys(value, ['kind', 'requestId', 'profileId'])) {
    return {
      kind: 'saved',
      requestId: parseStableId(value.requestId),
      profileId: parseStableId(value.profileId),
    }
  }
  throw new Error('AUDIO_GENERATION_CONFIG_INVALID')
}

/** 严格解析脱敏测试结果，阻止底层异常字段越过 IPC。 */
export function parseAudioGenerationTestResult(value: unknown): AudioGenerationTestResult {
  if (!isRecord(value) || !hasOnlyKeys(value, ['requestId', 'state', 'message']) || !isTestState(value.state)) {
    throw new Error('AUDIO_GENERATION_CONFIG_INVALID')
  }
  return {
    requestId: parseStableId(value.requestId),
    state: value.state,
    message: parsePublicMessage(value.message),
  }
}

/** 严格解析取消测试请求的最小 envelope。 */
export function parseAudioGenerationTestCancelInput(value: unknown): AudioGenerationTestCancelInput {
  if (!isRecord(value) || !hasOnlyKeys(value, ['requestId'])) {
    throw new Error('AUDIO_GENERATION_CONFIG_INVALID')
  }
  return { requestId: parseStableId(value.requestId) }
}
