/**
 * 独立生图供应商配置的公开合同。
 *
 * 与音频生成同构：每家供应商自带凭据与模型清单，完全不引用 LLM 渠道；
 * 本文件只负责类型、供应商描述与严格解析，任何执行器都在主进程内独立实现。
 */

/** 首批支持的独立生图供应商。 */
export type ImageGenerationProvider = 'dreamina' | 'openai-images' | 'minimax'

/**
 * 单个模型可执行的生成能力。
 * 图片与视频共用一份能力清单，模型条目按能力区分产物类别。
 */
export type ImageGenerationCapability =
  | 'text-to-image'
  | 'image-to-image'
  | 'upscale'
  | 'text-to-video'
  | 'image-to-video'
  | 'first-last-frame'

/** 模型条目的产物类别，用于设置页分组与目录筛选。 */
export type ImageGenerationMediaKind = 'image' | 'video'

/** 能力到产物类别的归属；图片能力与视频能力不允许混用。 */
const IMAGE_GENERATION_CAPABILITY_KIND: Record<ImageGenerationCapability, ImageGenerationMediaKind> = {
  'text-to-image': 'image',
  'image-to-image': 'image',
  upscale: 'image',
  'text-to-video': 'video',
  'image-to-video': 'video',
  'first-last-frame': 'video',
}

/** 能力的中文展示文案，主进程与设置页共用同一份标签。 */
export const IMAGE_GENERATION_CAPABILITY_LABELS: Record<ImageGenerationCapability, string> = {
  'text-to-image': '文生图',
  'image-to-image': '图生图',
  upscale: '放大',
  'text-to-video': '文生视频',
  'image-to-video': '图生视频',
  'first-last-frame': '首尾帧',
}

/**
 * 判断模型条目属于图片还是视频。
 * 入参：模型条目；返回值：产物类别。
 * 出现任一视频能力即视为视频模型，避免同一模型被算进两个分组。
 */
export function imageGenerationModelKind(model: ImageGenerationModelEntry): ImageGenerationMediaKind {
  return model.capabilities.some((capability) => IMAGE_GENERATION_CAPABILITY_KIND[capability] === 'video')
    ? 'video'
    : 'image'
}

/** 已启用模型条目；params 保存供应商侧参数（如即梦的分辨率档位）。 */
export interface ImageGenerationModelEntry {
  id: string
  name?: string
  capabilities: ImageGenerationCapability[]
  params?: Record<string, string>
}

/** 各家共享的非敏感配置字段。 */
interface ImageGenerationProfileCommon {
  id: string
  name: string
  /** 已启用模型，顺序即用户添加顺序；至少一个且同一配置内不重复。 */
  models: ImageGenerationModelEntry[]
  enabled: boolean
  createdAt: number
  updatedAt: number
  /** 旧统一媒体目录条目 ID，仅用于迁移提示。 */
  legacyMediaProfileId?: string
}

/**
 * 独立生图配置。
 * 即梦只有 CLI，配置里不出现服务地址与密钥；另外两家使用 Base URL + API Key。
 */
export type ImageGenerationProfile =
  | (ImageGenerationProfileCommon & { provider: 'dreamina'; cliPath?: string })
  | (ImageGenerationProfileCommon & { provider: 'openai-images'; baseUrl: string })
  | (ImageGenerationProfileCommon & { provider: 'minimax'; baseUrl: string; groupId?: string })

/** 完整替换目录时对单条配置凭据执行的动作。 */
export type ImageGenerationCredentialUpdate =
  | { mode: 'preserve' }
  | { mode: 'replace'; apiKey: string }

/** 完整替换独立生图目录的 CAS 请求。 */
export interface ReplaceImageGenerationCatalogRequest {
  expectedRevision: number
  profiles: Array<{
    profile: ImageGenerationProfile
    credentialUpdate: ImageGenerationCredentialUpdate
  }>
}

/** Renderer 可读取的生图配置，不包含明文或密文凭据。 */
export type ImageGenerationPublicProfile = ImageGenerationProfile & {
  credentialConfigured: boolean
  /** 密钥型供应商的端点 origin；即梦没有服务地址。 */
  endpointOrigin?: string
}

/** Renderer 可读取的独立生图目录快照。 */
export interface ImageGenerationPublicCatalog {
  schemaVersion: 1
  revision: number
  profiles: ImageGenerationPublicProfile[]
}

/** 旧统一媒体目录中可提示迁移的最小生图配置摘要。 */
export interface LegacyImageProfileSummary {
  id: string
  name: string
  protocol: 'openai-images'
  modelId: string
  enabled: boolean
}

/** 旧生图目录读取失败时唯一允许跨 IPC 公开的脱敏警告。 */
export const IMAGE_GENERATION_LEGACY_WARNING = '旧生图配置读取失败，暂时无法显示迁移提示' as const

/** 生图设置页一次读取所需的独立目录与旧配置提示。 */
export interface ImageGenerationSettingsResult {
  catalog: ImageGenerationPublicCatalog
  legacyImageProfiles: LegacyImageProfileSummary[]
  legacyWarning?: typeof IMAGE_GENERATION_LEGACY_WARNING
}

/** 每个供应商固定的显示名与专属字段合同。 */
interface ImageGenerationProviderDescriptorDefinition {
  dreamina: { label: '即梦'; specificFields: readonly ['cliPath']; usesApiKey: false }
  'openai-images': { label: 'ChatGPT（OpenAI Images）'; specificFields: readonly []; usesApiKey: true }
  minimax: { label: 'MiniMax 图像'; specificFields: readonly ['groupId']; usesApiKey: true }
}

/** 供应商可见名称、专属字段与凭据形态的完整判别联合。 */
export type ImageGenerationProviderDescriptor = {
  [Provider in ImageGenerationProvider]: {
    provider: Provider
  } & ImageGenerationProviderDescriptorDefinition[Provider]
}[ImageGenerationProvider]

/** 按供应商键约束的完整描述映射，新增 provider 时必须同步声明。 */
const IMAGE_GENERATION_PROVIDER_DESCRIPTOR_BY_PROVIDER = {
  dreamina: { provider: 'dreamina', label: '即梦', specificFields: ['cliPath'], usesApiKey: false },
  'openai-images': { provider: 'openai-images', label: 'ChatGPT（OpenAI Images）', specificFields: [], usesApiKey: true },
  minimax: { provider: 'minimax', label: 'MiniMax 图像', specificFields: ['groupId'], usesApiKey: true },
} as const satisfies {
  [Provider in ImageGenerationProvider]: {
    provider: Provider
  } & ImageGenerationProviderDescriptorDefinition[Provider]
}

/** 设置页唯一可信的供应商描述，直接沿用映射插入顺序展示。 */
export const IMAGE_GENERATION_PROVIDER_DESCRIPTORS: readonly ImageGenerationProviderDescriptor[] = Object.values(
  IMAGE_GENERATION_PROVIDER_DESCRIPTOR_BY_PROVIDER,
)

/** 新建或切换供应商时用于自动填入的默认值。 */
export interface ImageGenerationProviderDefaults {
  /** 默认服务地址；即梦没有服务地址，返回空串。 */
  baseUrl: string
  /** 官方内置模型；空数组表示只能手填或按端点拉取。 */
  builtinModels: readonly ImageGenerationModelEntry[]
  /** 端点拉取模型时使用的请求路径；空串表示该供应商不支持拉取。 */
  modelsPath: string
}

/** 即梦 CLI 的模型版本，来自 `dreamina text2image -h` 的 supported combinations。 */
const DREAMINA_BUILTIN_MODELS: readonly ImageGenerationModelEntry[] = [
  { id: '3.0', name: '即梦 3.0', capabilities: ['text-to-image'], params: { resolution_type: '1k' } },
  { id: '3.1', name: '即梦 3.1', capabilities: ['text-to-image'], params: { resolution_type: '1k' } },
  { id: '4.0', name: '即梦 4.0', capabilities: ['text-to-image', 'image-to-image'], params: { resolution_type: '2k' } },
  { id: '4.1', name: '即梦 4.1', capabilities: ['text-to-image', 'image-to-image'], params: { resolution_type: '2k' } },
  { id: '4.5', name: '即梦 4.5', capabilities: ['text-to-image', 'image-to-image'], params: { resolution_type: '2k' } },
  { id: '4.6', name: '即梦 4.6', capabilities: ['text-to-image', 'image-to-image'], params: { resolution_type: '2k' } },
  { id: '4.7', name: '即梦 4.7', capabilities: ['text-to-image', 'image-to-image'], params: { resolution_type: '2k' } },
  { id: '5.0', name: '即梦 5.0', capabilities: ['text-to-image', 'image-to-image'], params: { resolution_type: '2k' } },
  { id: '5.0Pro', name: '即梦 5.0 Pro', capabilities: ['text-to-image', 'image-to-image'], params: { resolution_type: '2k' } },
]

/**
 * 即梦视频模型，来自三个视频子命令的 supported combinations 并集。
 * 能力按命令逐个核对：text2video 只支持 seedance2.0/2.5 系列，
 * frames2video 额外不含 seedance1.0fast，其余按各自列出为准。
 */
const DREAMINA_BUILTIN_VIDEO_MODELS: readonly ImageGenerationModelEntry[] = [
  { id: 'seedance2.5', name: '即梦 Seedance 2.5', capabilities: ['text-to-video', 'image-to-video', 'first-last-frame'], params: { video_resolution: '720p' } },
  { id: 'seedance2.0', name: '即梦 Seedance 2.0', capabilities: ['text-to-video', 'image-to-video', 'first-last-frame'], params: { video_resolution: '720p' } },
  { id: 'seedance2.0fast', name: '即梦 Seedance 2.0 Fast', capabilities: ['text-to-video', 'image-to-video', 'first-last-frame'], params: { video_resolution: '720p' } },
  { id: 'seedance2.0_vip', name: '即梦 Seedance 2.0 VIP', capabilities: ['text-to-video', 'image-to-video', 'first-last-frame'], params: { video_resolution: '720p' } },
  { id: 'seedance2.0fast_vip', name: '即梦 Seedance 2.0 Fast VIP', capabilities: ['text-to-video', 'image-to-video', 'first-last-frame'], params: { video_resolution: '720p' } },
  { id: 'seedance2.0mini', name: '即梦 Seedance 2.0 Mini', capabilities: ['text-to-video', 'image-to-video', 'first-last-frame'], params: { video_resolution: '720p' } },
  { id: 'seedance1.5pro', name: '即梦 Seedance 1.5 Pro', capabilities: ['image-to-video', 'first-last-frame'], params: { video_resolution: '720p' } },
  { id: 'seedance1.0fast', name: '即梦 Seedance 1.0 Fast', capabilities: ['image-to-video'], params: { video_resolution: '720p' } },
]

/** OpenAI Images 的官方内置模型兜底；端点不可用时仍可选择。 */
const OPENAI_BUILTIN_MODELS: readonly ImageGenerationModelEntry[] = [
  { id: 'gpt-image-1', name: 'GPT Image 1', capabilities: ['text-to-image', 'image-to-image'] },
  { id: 'gpt-image-1-mini', name: 'GPT Image 1 mini', capabilities: ['text-to-image', 'image-to-image'] },
  { id: 'dall-e-3', name: 'DALL·E 3', capabilities: ['text-to-image'] },
]

/**
 * MiniMax 图像的官方内置模型。
 * 来自官方 OpenAPI 的 model 枚举
 * https://platform.minimaxi.com/docs/api-reference/image/generation/api/text-to-image.json：
 * 两个模型共用 `POST /v1/image_generation`，`subject_reference` 不限定模型，因此都支持图生图。
 */
const MINIMAX_BUILTIN_MODELS: readonly ImageGenerationModelEntry[] = [
  { id: 'image-01', name: 'Image 01', capabilities: ['text-to-image', 'image-to-image'] },
  { id: 'image-01-live', name: 'Image 01 Live', capabilities: ['text-to-image', 'image-to-image'] },
]

/**
 * MiniMax 视频模型，来自官方文生视频与图生视频 OpenAPI 的 model 枚举并集。
 * 两家命令的默认分辨率不同：Hailuo 系列默认 768P，T2V/I2V 系列默认 720P。
 */
const MINIMAX_BUILTIN_VIDEO_MODELS: readonly ImageGenerationModelEntry[] = [
  { id: 'MiniMax-Hailuo-2.3', name: 'MiniMax Hailuo 2.3', capabilities: ['text-to-video', 'image-to-video'], params: { resolution: '768P' } },
  { id: 'MiniMax-Hailuo-2.3-Fast', name: 'MiniMax Hailuo 2.3 Fast', capabilities: ['image-to-video'], params: { resolution: '768P' } },
  { id: 'MiniMax-Hailuo-02', name: 'MiniMax Hailuo 02', capabilities: ['text-to-video', 'image-to-video'], params: { resolution: '768P' } },
  { id: 'T2V-01-Director', name: 'MiniMax T2V-01 Director', capabilities: ['text-to-video'], params: { resolution: '720P' } },
  { id: 'T2V-01', name: 'MiniMax T2V-01', capabilities: ['text-to-video'], params: { resolution: '720P' } },
  { id: 'I2V-01-Director', name: 'MiniMax I2V-01 Director', capabilities: ['image-to-video'], params: { resolution: '720P' } },
  { id: 'I2V-01-live', name: 'MiniMax I2V-01 Live', capabilities: ['image-to-video'], params: { resolution: '720P' } },
  { id: 'I2V-01', name: 'MiniMax I2V-01', capabilities: ['image-to-video'], params: { resolution: '720P' } },
]

/**
 * 三家供应商的默认服务地址与内置模型。
 * MiniMax 的 /v1/models 只登记对话模型，图像与视频模型都按官方 OpenAPI 枚举内置。
 */
export const IMAGE_GENERATION_PROVIDER_DEFAULTS: Record<ImageGenerationProvider, ImageGenerationProviderDefaults> = {
  dreamina: {
    baseUrl: '',
    builtinModels: [...DREAMINA_BUILTIN_MODELS, ...DREAMINA_BUILTIN_VIDEO_MODELS],
    modelsPath: '',
  },
  'openai-images': {
    baseUrl: 'https://api.openai.com/v1',
    builtinModels: OPENAI_BUILTIN_MODELS,
    modelsPath: '/models',
  },
  minimax: {
    baseUrl: 'https://api.minimax.cn/v1',
    builtinModels: [...MINIMAX_BUILTIN_MODELS, ...MINIMAX_BUILTIN_VIDEO_MODELS],
    modelsPath: '/models',
  },
}

/** 单个目录允许保存的配置数量上限。 */
export const IMAGE_PROVIDER_PROFILE_LIMIT = 128
/** 单条配置允许启用的模型数量上限。 */
export const IMAGE_PROVIDER_MODEL_LIMIT = 32
/** 用户可见名称长度上限。 */
export const IMAGE_PROVIDER_NAME_MAX_LENGTH = 128
/** 模型显示名称长度上限。 */
export const IMAGE_PROVIDER_MODEL_NAME_MAX_LENGTH = 128
/** 模型标识、供应商专属标识与稳定 ID 的长度上限。 */
export const IMAGE_PROVIDER_IDENTIFIER_MAX_LENGTH = 256
/** Base URL 的长度上限。 */
export const IMAGE_PROVIDER_URL_MAX_LENGTH = 2_048
/** 一次性 API Key 的长度上限。 */
export const IMAGE_PROVIDER_API_KEY_MAX_LENGTH = 4_096

/** 与音频目录一致的安全稳定 ID 字符合同。 */
const IMAGE_GENERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/
/** 会触发对象原型语义的保留 ID。 */
const RESERVED_IMAGE_GENERATION_IDS = new Set(['__proto__', 'constructor', 'prototype'])
/** 所有供应商共享的配置字段。 */
const PROFILE_COMMON_KEYS = ['id', 'name', 'provider', 'models', 'enabled', 'createdAt', 'updatedAt', 'legacyMediaProfileId'] as const
/** 模型条目允许出现的字段。 */
const MODEL_KEYS = ['id', 'name', 'capabilities', 'params'] as const
/** 合法能力集合。 */
const CAPABILITIES: readonly ImageGenerationCapability[] = [
  'text-to-image', 'image-to-image', 'upscale',
  'text-to-video', 'image-to-video', 'first-last-frame',
]

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

/** 解析稳定 ID，拒绝保留字与非法字符。 */
function parseStableId(value: unknown): string {
  if (typeof value !== 'string' || !IMAGE_GENERATION_ID_PATTERN.test(value)
    || RESERVED_IMAGE_GENERATION_IDS.has(value)) {
    throw new Error('IMAGE_GENERATION_CONFIG_INVALID')
  }
  return value
}

/** 解析必填文本：仅做首尾空白清洗与长度校验，保留内部字符。 */
function parseRequiredText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') throw new Error('IMAGE_GENERATION_CONFIG_INVALID')
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > maxLength) throw new Error('IMAGE_GENERATION_CONFIG_INVALID')
  return trimmed
}

/** 解析可选文本：缺失或空白都返回 undefined。 */
function parseOptionalText(value: unknown, maxLength: number): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error('IMAGE_GENERATION_CONFIG_INVALID')
  const trimmed = value.trim()
  if (!trimmed) return undefined
  if (trimmed.length > maxLength) throw new Error('IMAGE_GENERATION_CONFIG_INVALID')
  return trimmed
}

/** 解析密钥型供应商的服务地址：必须是 https 且不含凭据、查询与片段。 */
function parseBaseUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > IMAGE_PROVIDER_URL_MAX_LENGTH) {
    throw new Error('IMAGE_GENERATION_URL_INVALID')
  }
  const trimmed = value.trim().replace(/\/+$/, '')
  if (!trimmed) throw new Error('IMAGE_GENERATION_URL_INVALID')
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error('IMAGE_GENERATION_URL_INVALID')
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password
    || parsed.search || parsed.hash || !parsed.hostname) {
    throw new Error('IMAGE_GENERATION_URL_INVALID')
  }
  return trimmed
}

/** 解析单个模型条目，拒绝未知字段与空能力集合。 */
function parseModelEntry(value: unknown): ImageGenerationModelEntry {
  if (!isRecord(value) || !hasOnlyKeys(value, MODEL_KEYS) || !Array.isArray(value.capabilities)
    || value.capabilities.length === 0) {
    throw new Error('IMAGE_GENERATION_CONFIG_INVALID')
  }
  /** 能力逐个校验并去重，顺序保持用户声明顺序。 */
  const capabilities: ImageGenerationCapability[] = []
  for (const capability of value.capabilities) {
    if (typeof capability !== 'string' || !CAPABILITIES.includes(capability as ImageGenerationCapability)) {
      throw new Error('IMAGE_GENERATION_CONFIG_INVALID')
    }
    if (!capabilities.includes(capability as ImageGenerationCapability)) {
      capabilities.push(capability as ImageGenerationCapability)
    }
  }
  const id = parseRequiredText(value.id, IMAGE_PROVIDER_IDENTIFIER_MAX_LENGTH)
  const name = parseOptionalText(value.name, IMAGE_PROVIDER_MODEL_NAME_MAX_LENGTH)
  /** 供应商参数只接受字符串键值，避免嵌套结构穿透持久化。 */
  let params: Record<string, string> | undefined
  if (value.params !== undefined) {
    if (!isRecord(value.params)) throw new Error('IMAGE_GENERATION_CONFIG_INVALID')
    params = {}
    for (const [key, raw] of Object.entries(value.params)) {
      if (!key.trim() || typeof raw !== 'string') throw new Error('IMAGE_GENERATION_CONFIG_INVALID')
      params[key] = parseRequiredText(raw, IMAGE_PROVIDER_IDENTIFIER_MAX_LENGTH)
    }
  }
  return {
    ...(name === undefined ? {} : { name }),
    id,
    capabilities,
    ...(params === undefined ? {} : { params }),
  }
}

/** 严格解析已启用模型列表：至少一条、ID 唯一、能力合法。 */
function parseModelItems(value: unknown, requireAtLeastOne: boolean): ImageGenerationModelEntry[] {
  if (!Array.isArray(value)
    || value.length < (requireAtLeastOne ? 1 : 0)
    || value.length > IMAGE_PROVIDER_MODEL_LIMIT) {
    throw new Error('IMAGE_GENERATION_CONFIG_INVALID')
  }
  /** 已出现的模型 ID，用于拒绝同一配置内的重复模型。 */
  const seenIds = new Set<string>()
  return value.map((item) => {
    const entry = parseModelEntry(item)
    if (seenIds.has(entry.id)) throw new Error('IMAGE_GENERATION_CONFIG_INVALID')
    seenIds.add(entry.id)
    return entry
  })
}

/** 严格解析已启用模型列表：至少一条、ID 唯一、能力合法。 */
export function parseImageGenerationModelList(value: unknown): ImageGenerationModelEntry[] {
  return parseModelItems(value, true)
}

/** 解析供应商返回的模型清单，允许为空（例如端点只登记对话模型）。 */
export function parseImageGenerationCatalogModels(value: unknown): ImageGenerationModelEntry[] {
  return parseModelItems(value, false)
}

/** 拉取可用模型时的凭据来源；即梦没有密钥，使用 none。 */
export type ImageGenerationCatalogCredential =
  | { mode: 'saved'; profileId: string }
  | { mode: 'draft'; apiKey: string }
  | { mode: 'none' }

/** 从供应商拉取可用模型（同时也是连接测试）的输入。 */
export interface ImageGenerationCatalogFetchInput {
  requestId: string
  provider: ImageGenerationProvider
  baseUrl?: string
  groupId?: string
  credential: ImageGenerationCatalogCredential
}

/** 拉取结果的公开形态，不含上游正文、路径或凭据。 */
export interface ImageGenerationCatalogFetchResult {
  requestId: string
  state: 'success' | 'failed'
  message: string
  models: ImageGenerationModelEntry[]
}

/** 拉取结果唯一允许公开的固定文案。 */
export const IMAGE_GENERATION_CATALOG_MESSAGES = {
  success: '已从供应商获取可用生图模型',
  failed: '从供应商获取失败，请检查服务地址与凭据',
} as const

/** 拉取失败的分类固定文案；按原因给可操作提示，但不携带上游正文。 */
export const IMAGE_GENERATION_CATALOG_FAILURE_MESSAGES = {
  credential: '凭据不可用，请重新填写 API Key',
  unauthorized: '鉴权失败，请检查 API Key',
  notFound: '服务地址不正确，未找到模型接口',
  upstream: '供应商返回错误状态，请稍后重试',
  timeout: '请求超时，请检查网络或服务地址',
  malformed: '供应商返回格式无法识别',
  cliMissing: '未找到即梦 CLI，请检查安装或 cliPath 配置',
  cliNotLoggedIn: '即梦未登录或登录已失效，请点击登录',
} as const

/**
 * 严格解析独立生图配置。
 * 入参：来自磁盘或 IPC 的未知值；返回值：按供应商收窄的已清洗配置。
 * 即梦不接受服务地址与 Group ID，另外两家必须提供服务地址；未知字段一律拒绝。
 */
export function parseImageGenerationProfile(value: unknown): ImageGenerationProfile {
  if (!isRecord(value)) throw new Error('IMAGE_GENERATION_CONFIG_INVALID')
  if (value.provider !== 'dreamina' && value.provider !== 'openai-images' && value.provider !== 'minimax') {
    throw new Error('IMAGE_GENERATION_CONFIG_INVALID')
  }
  /** 当前供应商允许进入配置的字段集合。 */
  const allowedKeys = value.provider === 'dreamina'
    ? [...PROFILE_COMMON_KEYS, 'cliPath']
    : value.provider === 'minimax'
      ? [...PROFILE_COMMON_KEYS, 'baseUrl', 'groupId']
      : [...PROFILE_COMMON_KEYS, 'baseUrl']
  if (!hasOnlyKeys(value, allowedKeys)
    || typeof value.enabled !== 'boolean'
    || !isNonNegativeSafeInteger(value.createdAt)
    || !isNonNegativeSafeInteger(value.updatedAt)
    || value.updatedAt < value.createdAt) {
    throw new Error('IMAGE_GENERATION_CONFIG_INVALID')
  }
  /** 三家共享且已清洗的字段。 */
  const common: ImageGenerationProfileCommon = {
    id: parseStableId(value.id),
    name: parseRequiredText(value.name, IMAGE_PROVIDER_NAME_MAX_LENGTH),
    models: parseImageGenerationModelList(value.models),
    enabled: value.enabled,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  }
  /** 可选的旧目录引用仅接受同一安全 ID 合同。 */
  const legacyMediaProfileId = value.legacyMediaProfileId === undefined
    ? undefined
    : parseStableId(value.legacyMediaProfileId)
  if (legacyMediaProfileId !== undefined) common.legacyMediaProfileId = legacyMediaProfileId
  if (value.provider === 'dreamina') {
    /** 即梦 CLI 路径可选，缺省时主进程按 PATH 解析。 */
    const cliPath = parseOptionalText(value.cliPath, IMAGE_PROVIDER_URL_MAX_LENGTH)
    return cliPath === undefined
      ? { ...common, provider: 'dreamina' }
      : { ...common, provider: 'dreamina', cliPath }
  }
  if (value.provider === 'openai-images') {
    return { ...common, provider: 'openai-images', baseUrl: parseBaseUrl(value.baseUrl) }
  }
  /** MiniMax 专属的可选 Group ID。 */
  const groupId = parseOptionalText(value.groupId, IMAGE_PROVIDER_IDENTIFIER_MAX_LENGTH)
  return groupId === undefined
    ? { ...common, provider: 'minimax', baseUrl: parseBaseUrl(value.baseUrl) }
    : { ...common, provider: 'minimax', baseUrl: parseBaseUrl(value.baseUrl), groupId }
}

/** 解析单条凭据更新；即梦不接受密钥替换。 */
function parseCredentialUpdate(value: unknown, provider: ImageGenerationProvider): ImageGenerationCredentialUpdate {
  if (!isRecord(value) || typeof value.mode !== 'string') {
    throw new Error('IMAGE_GENERATION_CONFIG_INVALID')
  }
  if (value.mode === 'preserve') {
    if (!hasOnlyKeys(value, ['mode'])) throw new Error('IMAGE_GENERATION_CONFIG_INVALID')
    return { mode: 'preserve' }
  }
  if (value.mode !== 'replace' || !hasOnlyKeys(value, ['mode', 'apiKey'])
    || !IMAGE_GENERATION_PROVIDER_DESCRIPTORS.find((descriptor) => descriptor.provider === provider)?.usesApiKey) {
    throw new Error('IMAGE_GENERATION_CONFIG_INVALID')
  }
  return {
    mode: 'replace',
    apiKey: parseRequiredText(value.apiKey, IMAGE_PROVIDER_API_KEY_MAX_LENGTH),
  }
}

/** 严格解析完整目录替换请求，阻止重复 ID 和秘密字段旁路。 */
export function parseReplaceImageGenerationCatalogRequest(value: unknown): ReplaceImageGenerationCatalogRequest {
  if (!isRecord(value) || !hasOnlyKeys(value, ['expectedRevision', 'profiles'])
    || !isNonNegativeSafeInteger(value.expectedRevision)
    || !Array.isArray(value.profiles)
    || value.profiles.length > IMAGE_PROVIDER_PROFILE_LIMIT) {
    throw new Error('IMAGE_GENERATION_CONFIG_INVALID')
  }
  /** 按请求顺序严格解析后的目录条目。 */
  const profiles = value.profiles.map((item) => {
    if (!isRecord(item) || !hasOnlyKeys(item, ['profile', 'credentialUpdate'])) {
      throw new Error('IMAGE_GENERATION_CONFIG_INVALID')
    }
    const profile = parseImageGenerationProfile(item.profile)
    return {
      profile,
      credentialUpdate: parseCredentialUpdate(item.credentialUpdate, profile.provider),
    }
  })
  /** 同一次替换内不允许出现重复 ID。 */
  const ids = new Set(profiles.map((item) => item.profile.id))
  if (ids.size !== profiles.length) throw new Error('IMAGE_GENERATION_CONFIG_INVALID')
  return { expectedRevision: value.expectedRevision, profiles }
}

/** 严格解析旧目录摘要，只接受声明字段。 */
function parseLegacyImageProfileSummary(value: unknown): LegacyImageProfileSummary {
  if (!isRecord(value) || !hasOnlyKeys(value, ['id', 'name', 'protocol', 'modelId', 'enabled'])
    || value.protocol !== 'openai-images' || typeof value.enabled !== 'boolean') {
    throw new Error('IMAGE_GENERATION_CONFIG_INVALID')
  }
  return {
    id: parseStableId(value.id),
    name: parseRequiredText(value.name, IMAGE_PROVIDER_NAME_MAX_LENGTH),
    protocol: 'openai-images',
    modelId: parseRequiredText(value.modelId, IMAGE_PROVIDER_IDENTIFIER_MAX_LENGTH),
    enabled: value.enabled,
  }
}

/** 解析 Renderer 可见的公开配置，凭据状态只能是布尔值。 */
function parsePublicImageProfile(value: unknown): ImageGenerationPublicProfile {
  if (!isRecord(value) || typeof value.credentialConfigured !== 'boolean') {
    throw new Error('IMAGE_GENERATION_CONFIG_INVALID')
  }
  const { credentialConfigured, endpointOrigin, ...rest } = value
  const profile = parseImageGenerationProfile(rest)
  if (endpointOrigin !== undefined && endpointOrigin !== null) {
    if (typeof endpointOrigin !== 'string' || !endpointOrigin.startsWith('https://')) {
      throw new Error('IMAGE_GENERATION_CONFIG_INVALID')
    }
  }
  return {
    ...profile,
    credentialConfigured,
    ...(typeof endpointOrigin === 'string' ? { endpointOrigin } : {}),
  }
}

/**
 * 严格解析拉取可用模型的输入。
 * 入参：来自 Renderer 的未知值；返回值：已校验的拉取请求。
 * 即梦使用 none 凭据且不允许服务地址；密钥型供应商必须有服务地址与凭据。
 */
export function parseImageGenerationCatalogFetchInput(value: unknown): ImageGenerationCatalogFetchInput {
  if (!isRecord(value)
    || !hasOnlyKeys(value, ['requestId', 'provider', 'baseUrl', 'groupId', 'credential'])
    || (value.provider !== 'dreamina' && value.provider !== 'openai-images' && value.provider !== 'minimax')
    || !isRecord(value.credential)) {
    throw new Error('IMAGE_GENERATION_CONFIG_INVALID')
  }
  const requestId = parseStableId(value.requestId)
  /** 凭据形态按供应商收口：即梦只能 none，另外两家只能 saved 或 draft。 */
  let credential: ImageGenerationCatalogCredential
  if (value.credential.mode === 'none') {
    if (!hasOnlyKeys(value.credential, ['mode']) || value.provider !== 'dreamina') {
      throw new Error('IMAGE_GENERATION_CONFIG_INVALID')
    }
    credential = { mode: 'none' }
  } else if (value.credential.mode === 'saved') {
    if (!hasOnlyKeys(value.credential, ['mode', 'profileId']) || value.provider === 'dreamina') {
      throw new Error('IMAGE_GENERATION_CONFIG_INVALID')
    }
    credential = { mode: 'saved', profileId: parseStableId(value.credential.profileId) }
  } else if (value.credential.mode === 'draft') {
    if (!hasOnlyKeys(value.credential, ['mode', 'apiKey']) || value.provider === 'dreamina') {
      throw new Error('IMAGE_GENERATION_CONFIG_INVALID')
    }
    credential = {
      mode: 'draft',
      apiKey: parseRequiredText(value.credential.apiKey, IMAGE_PROVIDER_API_KEY_MAX_LENGTH),
    }
  } else {
    throw new Error('IMAGE_GENERATION_CONFIG_INVALID')
  }
  if (value.provider === 'dreamina') {
    if (value.baseUrl !== undefined || value.groupId !== undefined) {
      throw new Error('IMAGE_GENERATION_CONFIG_INVALID')
    }
    return { requestId, provider: 'dreamina', credential }
  }
  const baseUrl = parseBaseUrl(value.baseUrl)
  const groupId = value.provider === 'minimax'
    ? parseOptionalText(value.groupId, IMAGE_PROVIDER_IDENTIFIER_MAX_LENGTH)
    : undefined
  if (value.provider === 'openai-images' && value.groupId !== undefined) {
    throw new Error('IMAGE_GENERATION_CONFIG_INVALID')
  }
  return {
    requestId,
    provider: value.provider,
    baseUrl,
    ...(groupId === undefined ? {} : { groupId }),
    credential,
  }
}

/** 严格解析拉取结果的消息：成功只接受固定文案，失败接受分类文案。 */
function parseCatalogMessage(state: 'success' | 'failed', value: unknown): string {
  const message = parseRequiredText(value, IMAGE_PROVIDER_IDENTIFIER_MAX_LENGTH)
  if (state === 'success') {
    if (message !== IMAGE_GENERATION_CATALOG_MESSAGES.success) {
      throw new Error('IMAGE_GENERATION_CONFIG_INVALID')
    }
    return message
  }
  /** 失败文案只允许通用文案或已声明的分类文案。 */
  const allowed: readonly string[] = [
    IMAGE_GENERATION_CATALOG_MESSAGES.failed,
    ...Object.values(IMAGE_GENERATION_CATALOG_FAILURE_MESSAGES),
  ]
  if (!allowed.includes(message)) throw new Error('IMAGE_GENERATION_CONFIG_INVALID')
  return message
}

/** 严格解析拉取结果，模型清单允许为空但必须逐条合法。 */
export function parseImageGenerationCatalogFetchResult(value: unknown): ImageGenerationCatalogFetchResult {
  if (!isRecord(value)
    || !hasOnlyKeys(value, ['requestId', 'state', 'message', 'models'])
    || (value.state !== 'success' && value.state !== 'failed')) {
    throw new Error('IMAGE_GENERATION_CONFIG_INVALID')
  }
  return {
    requestId: parseStableId(value.requestId),
    state: value.state,
    message: parseCatalogMessage(value.state, value.message),
    models: parseImageGenerationCatalogModels(value.models),
  }
}

/** 严格解析设置读取结果，公开目录与旧摘要分别校验重复 ID。 */
export function parseImageGenerationSettingsResult(value: unknown): ImageGenerationSettingsResult {
  if (!isRecord(value) || !hasOnlyKeys(value, ['catalog', 'legacyImageProfiles', 'legacyWarning'])
    || !isRecord(value.catalog) || !hasOnlyKeys(value.catalog, ['schemaVersion', 'revision', 'profiles'])
    || value.catalog.schemaVersion !== 1
    || !isNonNegativeSafeInteger(value.catalog.revision)
    || !Array.isArray(value.catalog.profiles)
    || value.catalog.profiles.length > IMAGE_PROVIDER_PROFILE_LIMIT
    || !Array.isArray(value.legacyImageProfiles)
    || value.legacyImageProfiles.length > IMAGE_PROVIDER_PROFILE_LIMIT) {
    throw new Error('IMAGE_GENERATION_CONFIG_INVALID')
  }
  const profiles = value.catalog.profiles.map(parsePublicImageProfile)
  const legacyImageProfiles = value.legacyImageProfiles.map(parseLegacyImageProfileSummary)
  if (new Set(profiles.map((profile) => profile.id)).size !== profiles.length
    || new Set(legacyImageProfiles.map((profile) => profile.id)).size !== legacyImageProfiles.length) {
    throw new Error('IMAGE_GENERATION_CONFIG_INVALID')
  }
  if (value.legacyWarning !== undefined && value.legacyWarning !== IMAGE_GENERATION_LEGACY_WARNING) {
    throw new Error('IMAGE_GENERATION_CONFIG_INVALID')
  }
  return {
    catalog: { schemaVersion: 1, revision: value.catalog.revision, profiles },
    legacyImageProfiles,
    ...(value.legacyWarning === undefined ? {} : { legacyWarning: IMAGE_GENERATION_LEGACY_WARNING }),
  }
}
