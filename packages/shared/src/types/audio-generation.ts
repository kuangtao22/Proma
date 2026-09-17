/** 首批支持的独立音频生成供应商。 */
export type AudioGenerationProvider = 'xiaomi' | 'minimax'

/** 音色来源，仅用于界面标注，不参与任何执行分支。 */
export type AudioGenerationVoiceSource = 'builtin' | 'remote' | 'manual'

/** 单条已启用音色；name 缺失时界面回退显示 id。 */
export interface AudioGenerationVoice {
  id: string
  name?: string
  source: AudioGenerationVoiceSource
}

/** 音频生成配置的供应商无关字段。 */
export interface AudioGenerationProfileBase {
  id: string
  name: string
  baseUrl: string
  modelId: string
  /** 已启用音色，顺序即用户添加顺序；至少一个且同一配置内不重复。 */
  voices: AudioGenerationVoice[]
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
  schemaVersion: 2
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

/** 旧音频目录读取失败时唯一允许跨 IPC 公开的脱敏警告。 */
export const AUDIO_GENERATION_LEGACY_WARNING = '旧音频配置读取失败，暂时无法显示迁移提示' as const

/** 音频设置页一次读取所需的独立目录与旧配置提示。 */
export interface AudioGenerationSettingsResult {
  catalog: AudioGenerationPublicCatalog
  legacyAudioProfiles: LegacyAudioProfileSummary[]
  legacyWarning?: typeof AUDIO_GENERATION_LEGACY_WARNING
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

/** 每个供应商固定的显示名和专属字段合同。 */
interface AudioGenerationProviderDescriptorDefinition {
  xiaomi: { label: '小米 TTS'; specificFields: readonly [] }
  minimax: { label: 'MiniMax Speech'; specificFields: readonly ['groupId'] }
}

/** 供应商可见名称及专属表单字段的完整判别联合。 */
export type AudioGenerationProviderDescriptor = {
  [Provider in AudioGenerationProvider]: {
    provider: Provider
  } & AudioGenerationProviderDescriptorDefinition[Provider]
}[AudioGenerationProvider]

/** 按供应商键约束的完整描述映射，新增 provider 时必须同步声明。 */
const AUDIO_GENERATION_PROVIDER_DESCRIPTOR_BY_PROVIDER = {
  xiaomi: { provider: 'xiaomi', label: '小米 TTS', specificFields: [] },
  minimax: { provider: 'minimax', label: 'MiniMax Speech', specificFields: ['groupId'] },
} as const satisfies {
  [Provider in AudioGenerationProvider]: {
    provider: Provider
  } & AudioGenerationProviderDescriptorDefinition[Provider]
}

/** 设置页唯一可信的供应商描述，直接沿用映射插入顺序展示。 */
export const AUDIO_GENERATION_PROVIDER_DESCRIPTORS: readonly AudioGenerationProviderDescriptor[] = Object.values(
  AUDIO_GENERATION_PROVIDER_DESCRIPTOR_BY_PROVIDER,
)

/** 测试结果允许公开的固定中文文案，禁止拼接上游正文或本地路径。 */
export const AUDIO_GENERATION_TEST_MESSAGES = {
  success: '音频生成服务连接测试成功',
  failed: '音频生成服务连接测试失败',
  cancelled: '音频生成服务连接测试已取消',
  unavailable: {
    xiaomi: '小米 TTS 尚缺少已验证的官方测试接口',
    minimax: 'MiniMax Speech 尚缺少已验证的官方测试接口',
  },
} as const

/** 单个目录允许保存的配置数量上限。 */
export const AUDIO_GENERATION_PROFILE_LIMIT = 128
/** 单条配置允许启用的音色数量上限。 */
export const AUDIO_GENERATION_VOICE_LIMIT = 64
/** 用户可见名称长度上限。 */
export const AUDIO_GENERATION_NAME_MAX_LENGTH = 128
/** 音色显示名称长度上限。 */
export const AUDIO_GENERATION_VOICE_NAME_MAX_LENGTH = 128
/** 当前独立音频目录的 schema 版本。 */
export const AUDIO_GENERATION_CATALOG_SCHEMA_VERSION = 2 as const
/** 仍需兼容读取的旧目录 schema 版本，读取时把 voiceId 迁移成单条音色。 */
export const LEGACY_AUDIO_GENERATION_CATALOG_SCHEMA_VERSION = 1 as const
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
  'id', 'name', 'provider', 'baseUrl', 'modelId', 'voices', 'enabled', 'createdAt', 'updatedAt', 'legacyMediaProfileId',
] as const
/** 单条音色允许出现的字段。 */
const VOICE_KEYS = ['id', 'name', 'source'] as const
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
  if (typeof value !== 'string' || value.length > maxLength) {
    throw new Error('AUDIO_GENERATION_CONFIG_INVALID')
  }
  /** 去除用户表单输入两端空白后的稳定文本。 */
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > maxLength) throw new Error('AUDIO_GENERATION_CONFIG_INVALID')
  return trimmed
}

/** 清洗可选短文本；已声明但为空时归一为缺省。 */
function parseOptionalText(value: unknown, maxLength: number): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length > maxLength) {
    throw new Error('AUDIO_GENERATION_CONFIG_INVALID')
  }
  /** 去除表单输入两端空白后的可选文本。 */
  const trimmed = value.trim()
  if (!trimmed) return undefined
  if (trimmed.length > maxLength) throw new Error('AUDIO_GENERATION_CONFIG_INVALID')
  return trimmed
}

/** 解析安全 Base URL，并移除重复尾斜杠形成稳定表示。 */
function parseBaseUrl(value: unknown): string {
  if (typeof value !== 'string') throw new Error('AUDIO_GENERATION_URL_INVALID')
  if (value.length > AUDIO_GENERATION_URL_MAX_LENGTH || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error('AUDIO_GENERATION_URL_INVALID')
  }
  /** 清除用户输入两端空白，避免 URL parser 隐式容错产生歧义。 */
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > AUDIO_GENERATION_URL_MAX_LENGTH) {
    throw new Error('AUDIO_GENERATION_URL_INVALID')
  }
  try {
    /** 使用标准 URL 解析器验证协议、凭据和可公开部分。 */
    const parsed = new URL(trimmed)
    if (trimmed.includes('?') || trimmed.includes('#')
      || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error('AUDIO_GENERATION_URL_INVALID')
    }
    return parsed.toString().replace(/\/+$/, '')
  } catch {
    throw new Error('AUDIO_GENERATION_URL_INVALID')
  }
}

/**
 * 严格解析已启用音色列表。
 * 入参：来自磁盘或 IPC 的未知值；返回值：清洗后的有序音色数组。
 * 空列表、超限、未知字段、非法来源与重复 ID 一律拒绝，避免歧义音色进入执行链。
 */
export function parseAudioGenerationVoiceList(value: unknown): AudioGenerationVoice[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > AUDIO_GENERATION_VOICE_LIMIT) {
    throw new Error('AUDIO_GENERATION_CONFIG_INVALID')
  }
  /** 已出现过的音色 ID，用于拒绝同一配置内的重复音色。 */
  const seenIds = new Set<string>()
  return value.map((item): AudioGenerationVoice => {
    if (!isRecord(item) || !hasOnlyKeys(item, VOICE_KEYS)) {
      throw new Error('AUDIO_GENERATION_CONFIG_INVALID')
    }
    const id = parseRequiredText(item.id, AUDIO_GENERATION_IDENTIFIER_MAX_LENGTH)
    if (seenIds.has(id)) throw new Error('AUDIO_GENERATION_CONFIG_INVALID')
    seenIds.add(id)
    if (item.source !== 'builtin' && item.source !== 'remote' && item.source !== 'manual') {
      throw new Error('AUDIO_GENERATION_CONFIG_INVALID')
    }
    /** 显示名称可选，缺失时由界面回退显示 id。 */
    const name = parseOptionalText(item.name, AUDIO_GENERATION_VOICE_NAME_MAX_LENGTH)
    return name === undefined ? { id, source: item.source } : { id, name, source: item.source }
  })
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
    voices: parseAudioGenerationVoiceList(value.voices),
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
    || value.catalog.schemaVersion !== AUDIO_GENERATION_CATALOG_SCHEMA_VERSION
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
  if (value.legacyWarning !== undefined && value.legacyWarning !== AUDIO_GENERATION_LEGACY_WARNING) {
    throw new Error('AUDIO_GENERATION_CONFIG_INVALID')
  }
  /** 可选警告统一投影为固定常量，禁止保留任意输入文本。 */
  const legacyWarning = value.legacyWarning === undefined ? undefined : AUDIO_GENERATION_LEGACY_WARNING
  return {
    catalog: { schemaVersion: AUDIO_GENERATION_CATALOG_SCHEMA_VERSION, revision: value.catalog.revision, profiles },
    legacyAudioProfiles,
    ...(legacyWarning === undefined ? {} : { legacyWarning }),
  }
}

/** 判断测试状态属于固定公开集合。 */
function isTestState(value: unknown): value is AudioGenerationTestState {
  return value === 'success' || value === 'failed' || value === 'cancelled' || value === 'unavailable'
}

/** 按测试状态解析唯一允许公开的固定消息。 */
function parsePublicMessage(state: AudioGenerationTestState, value: unknown): string {
  /** 已执行原始长度限制和空白清洗的候选测试消息。 */
  const message = parseRequiredText(value, AUDIO_GENERATION_MESSAGE_MAX_LENGTH)
  if (state === 'unavailable') {
    /** 首批两个供应商各自允许的暂不可用固定消息。 */
    const unavailableMessages: readonly string[] = Object.values(AUDIO_GENERATION_TEST_MESSAGES.unavailable)
    if (!unavailableMessages.includes(message)) throw new Error('AUDIO_GENERATION_CONFIG_INVALID')
    return message
  }
  if (message !== AUDIO_GENERATION_TEST_MESSAGES[state]) {
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
    message: parsePublicMessage(value.state, value.message),
  }
}

/** 严格解析取消测试请求的最小 envelope。 */
export function parseAudioGenerationTestCancelInput(value: unknown): AudioGenerationTestCancelInput {
  if (!isRecord(value) || !hasOnlyKeys(value, ['requestId'])) {
    throw new Error('AUDIO_GENERATION_CONFIG_INVALID')
  }
  return { requestId: parseStableId(value.requestId) }
}
