import { existsSync, readFileSync } from 'node:fs'
import type {
  Channel,
  ImageGenerationChannelOption,
  ImageGenerationExecutor,
  ImageGenerationModelCatalogResult,
  ImageGenerationModelOption,
  ImageGenerationModelProfile,
  ImageGenerationModelSnapshot,
} from '@proma/shared'
import {
  IMAGE_GENERATION_MODEL_ID_MAX_LENGTH,
  IMAGE_GENERATION_MODEL_NAME_MAX_LENGTH,
} from '@proma/shared'
import type { ResolvedImageGenerationRoute } from './image-generation-runtime'
import { writeJsonFileAtomic } from './safe-file'

/** 新保存目录统一使用 schema v2，v1 只作为 Nano Banana 兼容输入。 */
const IMAGE_GENERATION_MODELS_SCHEMA_VERSION = 2
/** 旧 Nano Banana 配置合成项的稳定 ID。 */
const LEGACY_PROFILE_ID = 'legacy-nano-banana-default'
/** 旧配置未指定模型时使用的默认图片模型。 */
const DEFAULT_IMAGE_MODEL = 'gemini-3.1-flash-image-preview'
/** 当前主进程支持的生图执行器。 */
const SUPPORTED_EXECUTORS: ReadonlySet<ImageGenerationExecutor> = new Set([
  'nano-banana',
  'openai-images',
])
/** 两类 profile 共享的精确字段。 */
const BASE_PROFILE_KEYS = [
  'id',
  'name',
  'executor',
  'modelId',
  'enabled',
  'createdAt',
  'updatedAt',
] as const
/** 渠道引用型 profile 额外持久化的稳定渠道 ID。 */
const OPENAI_IMAGES_PROFILE_KEYS = [...BASE_PROFILE_KEYS, 'channelId'] as const

/** schema v1 只允许旧 Nano Banana profile。 */
interface ImageGenerationModelsFileV1 {
  schemaVersion: 1
  profiles: Array<Extract<ImageGenerationModelProfile, { executor: 'nano-banana' }>>
}

/** schema v2 支持多个可信图片执行器。 */
interface ImageGenerationModelsFileV2 {
  schemaVersion: 2
  profiles: ImageGenerationModelProfile[]
}

/** 读取时兼容的完整目录联合类型。 */
type ImageGenerationModelsFile = ImageGenerationModelsFileV1 | ImageGenerationModelsFileV2

/** 模型目录的文件路径、凭据和渠道依赖。 */
export interface ImageGenerationModelCatalogDependencies {
  /** 系统生图模型目录文件的绝对路径。 */
  configPath: string
  /** 按需读取旧 Nano Banana 凭据，不把凭据保存进模型目录。 */
  getNanoBananaCredentials: () => Record<string, string>
  /** 单次目录操作读取现有模型配置。 */
  listChannels: () => Channel[]
  /** 仅在主进程按需解密渠道凭据。 */
  decryptChannelApiKey: (channelId: string) => string
  /** 生成旧兼容 profile 时间戳；生产默认使用当前时间。 */
  now?: () => number
}

/** 目录读取后附带是否来自旧工具配置的信息。 */
interface LoadedProfiles {
  profiles: ImageGenerationModelProfile[]
  inheritedFromLegacyConfig: boolean
}

/** 当前 profile 或渠道不可用时的判断结果。 */
interface AvailabilityResult {
  available: boolean
  unavailableReason?: string
}

/** 单次公开调用固定的渠道、旧凭据和解密缓存。 */
interface CatalogInvocationState {
  nanoBananaCredentials: Record<string, string>
  channels: Channel[]
  channelCredentials: Map<string, AvailabilityResult & { apiKey?: string }>
}

/** 管理系统级生图模型 profile，并隔离渠道与旧工具凭据。 */
export class ImageGenerationModelCatalog {
  constructor(private readonly dependencies: ImageGenerationModelCatalogDependencies) {}

  /** 列出严格解析后的目录和清洗渠道；文件缺失时只读合成旧配置兼容项。 */
  listCatalog(): ImageGenerationModelCatalogResult {
    /** 本次公开调用共享的稳定依赖快照。 */
    const state = this.createInvocationState()
    /** 当前磁盘目录或旧配置合成结果。 */
    const loaded = this.loadProfiles(state.nanoBananaCredentials)
    return {
      profiles: loaded.profiles.map(copyProfile),
      channelOptions: state.channels.map((channel) => this.toChannelOption(channel, state)),
      inheritedFromLegacyConfig: loaded.inheritedFromLegacyConfig,
      credentialsConfigured: hasNanoBananaApiKey(state.nanoBananaCredentials),
    }
  }

  /** 列出全部 profile 的选择项，包括当前不可用项及明确原因。 */
  listOptions(): ImageGenerationModelOption[] {
    /** 本次列表计算只读取一次渠道和旧凭据。 */
    const state = this.createInvocationState()
    /** 当前磁盘目录或旧配置合成结果。 */
    const loaded = this.loadProfiles(state.nanoBananaCredentials)
    return loaded.profiles.map((profile) => toOption(
      profile,
      this.getAvailability(profile, state),
    ))
  }

  /** 严格校验并完整替换所有 profile，使用 safe-file 原子写入 schema v2。 */
  replaceProfiles(profiles: ImageGenerationModelProfile[]): ImageGenerationModelCatalogResult {
    if (!Array.isArray(profiles)) {
      throw new Error('生图模型 profiles 必须是数组')
    }
    /** 经 schema v2 字段校验并清洗展示文本后的完整 profile。 */
    const validatedProfiles = validateProfiles(profiles, SUPPORTED_EXECUTORS)
    /** 保存前固定渠道与凭据快照，避免逐项校验时配置漂移。 */
    const state = this.createInvocationState()
    for (const profile of validatedProfiles) {
      if (profile.executor !== 'openai-images') continue
      const availability = this.getOpenAIChannelAvailability(profile, state)
      if (!availability.available) {
        throw new Error(`${availability.unavailableReason}: ${profile.id}`)
      }
    }
    if (existsSync(this.dependencies.configPath)) {
      /** 写前确认当前主文件有效，避免覆盖唯一损坏事实或污染恢复候选。 */
      this.readModelsFile()
    }
    /** 写入值只包含固定 schema 与 profile 白名单字段。 */
    const file: ImageGenerationModelsFileV2 = {
      schemaVersion: IMAGE_GENERATION_MODELS_SCHEMA_VERSION,
      profiles: validatedProfiles,
    }
    writeJsonFileAtomic(this.dependencies.configPath, file)
    return {
      profiles: validatedProfiles.map(copyProfile),
      channelOptions: state.channels.map((channel) => this.toChannelOption(channel, state)),
      inheritedFromLegacyConfig: false,
      credentialsConfigured: hasNanoBananaApiKey(state.nanoBananaCredentials),
    }
  }

  /** 解析当前可执行的 profile，并固化任务所需公开字段。 */
  resolveAvailableSnapshot(profileId: string): ImageGenerationModelSnapshot {
    /** 本次解析固定使用同一渠道和凭据快照。 */
    const state = this.createInvocationState()
    /** 当前 ID 对应的严格解析 profile。 */
    const profile = this.findProfile(profileId, state.nanoBananaCredentials)
    this.assertProfileAvailable(profile, state)
    return toSnapshot(profile)
  }

  /** 确认历史快照仍可由当前同一执行配置运行；profile 改名不影响快照。 */
  assertSnapshotAvailable(snapshot: ImageGenerationModelSnapshot): void {
    /** 本次复核固定使用同一渠道和凭据快照。 */
    const state = this.createInvocationState()
    /** 当前 ID 对应的严格解析 profile。 */
    const profile = this.findProfile(snapshot.profileId, state.nanoBananaCredentials)
    this.assertProfileAvailable(profile, state)
    assertProfileMatchesSnapshot(profile, snapshot)
  }

  /** 实时复核任务快照，并解析只在本次主进程调用内存在的敏感运行路由。 */
  resolveExecutionRoute(snapshot: ImageGenerationModelSnapshot): ResolvedImageGenerationRoute {
    /** 解密结果只保留在本方法的单次调用状态。 */
    const state = this.createInvocationState()
    /** 快照必须仍精确引用同一 profile。 */
    const profile = this.findProfile(snapshot.profileId, state.nanoBananaCredentials)
    this.assertProfileAvailable(profile, state)
    assertProfileMatchesSnapshot(profile, snapshot)
    if (profile.executor === 'nano-banana' && snapshot.executor === 'nano-banana') {
      return { executor: 'nano-banana', snapshot }
    }
    if (profile.executor !== 'openai-images' || snapshot.executor !== 'openai-images') {
      throw new Error(`生图模型快照与当前配置不一致: ${snapshot.profileId}`)
    }
    /** 可用性校验已经保证渠道存在。 */
    const channel = state.channels.find((candidate) => candidate.id === profile.channelId)
    if (!channel) throw new Error(`关联的模型配置已不存在: ${profile.id}`)
    /** 同一调用复用可用性阶段的解密结果。 */
    const credential = this.getChannelCredential(channel.id, state)
    if (!credential.available || !credential.apiKey) {
      throw new Error(`${credential.unavailableReason}: ${profile.id}`)
    }
    return {
      executor: 'openai-images',
      snapshot,
      baseUrl: channel.baseUrl.trim(),
      apiKey: credential.apiKey,
    }
  }

  /** 创建单次调用状态，避免同次结果读取不同渠道或重复解密。 */
  private createInvocationState(): CatalogInvocationState {
    return {
      nanoBananaCredentials: this.dependencies.getNanoBananaCredentials(),
      channels: this.dependencies.listChannels(),
      channelCredentials: new Map(),
    }
  }

  /** 按稳定 ID 查找当前 profile，不存在时明确拒绝。 */
  private findProfile(
    profileId: string,
    credentials: Record<string, string>,
  ): ImageGenerationModelProfile {
    /** 当前目录中与任务快照关联的 profile。 */
    const profile = this.loadProfiles(credentials).profiles.find(
      (candidate) => candidate.id === profileId,
    )
    if (profile === undefined) {
      throw new Error(`生图模型不存在: ${profileId}`)
    }
    return profile
  }

  /** 只在主文件不存在时合成旧 profile；任何已存在文件都必须严格读取。 */
  private loadProfiles(credentials: Record<string, string>): LoadedProfiles {
    if (!existsSync(this.dependencies.configPath)) {
      /** 合成时间在单次调用中固定，确保 createdAt 与 updatedAt 一致。 */
      const now = (this.dependencies.now ?? Date.now)()
      return {
        profiles: [createLegacyProfile(credentials, now)],
        inheritedFromLegacyConfig: true,
      }
    }
    return {
      profiles: this.readModelsFile().profiles,
      inheritedFromLegacyConfig: false,
    }
  }

  /** 直接严格读取已确认存在的主文件，不从 tmp 或 bak 隐式恢复。 */
  private readModelsFile(): ImageGenerationModelsFile {
    /** 已存在目录的原始 JSON 文本；读取错误必须原样向上传递。 */
    const raw = readFileSync(this.dependencies.configPath, 'utf8')
    /** JSON 解析后的未知值，随后进入严格 schema 校验。 */
    let parsed: unknown
    try {
      parsed = JSON.parse(raw) as unknown
    } catch (error) {
      throw new Error('生图模型目录 JSON 损坏', { cause: error })
    }
    return parseModelsFile(parsed)
  }

  /** 计算 profile 当前可用性，停用优先于执行器凭据。 */
  private getAvailability(
    profile: ImageGenerationModelProfile,
    state: CatalogInvocationState,
  ): AvailabilityResult {
    if (!profile.enabled) {
      return { available: false, unavailableReason: '模型已停用' }
    }
    if (profile.executor === 'nano-banana') {
      return hasNanoBananaApiKey(state.nanoBananaCredentials)
        ? { available: true }
        : { available: false, unavailableReason: 'Nano Banana API Key 未配置' }
    }
    return this.getOpenAIChannelAvailability(profile, state)
  }

  /** 计算渠道引用 profile 的连接、模型和凭据可用性。 */
  private getOpenAIChannelAvailability(
    profile: Extract<ImageGenerationModelProfile, { executor: 'openai-images' }>,
    state: CatalogInvocationState,
  ): AvailabilityResult {
    /** profile 当前引用的渠道。 */
    const channel = state.channels.find((candidate) => candidate.id === profile.channelId)
    if (!channel) return { available: false, unavailableReason: '关联的模型配置已不存在' }
    if (!channel.enabled) return { available: false, unavailableReason: '关联的模型配置已停用' }
    if (!channel.baseUrl.trim()) return { available: false, unavailableReason: '关联的模型配置缺少 Base URL' }
    /** 真实模型 ID 必须仍在该渠道中启用。 */
    const model = channel.models.find((candidate) => candidate.id === profile.modelId)
    if (!model?.enabled) return { available: false, unavailableReason: '关联模型不可用' }
    return this.getChannelCredential(channel.id, state)
  }

  /** 每个渠道在单次公开操作中最多解密一次。 */
  private getChannelCredential(
    channelId: string,
    state: CatalogInvocationState,
  ): AvailabilityResult & { apiKey?: string } {
    /** 已缓存的解密成功或失败结果。 */
    const cached = state.channelCredentials.get(channelId)
    if (cached) return cached
    try {
      /** 去除用户输入的无意义首尾空白后再判断可用性。 */
      const apiKey = this.dependencies.decryptChannelApiKey(channelId).trim()
      const result: AvailabilityResult & { apiKey?: string } = apiKey
        ? { available: true, apiKey }
        : { available: false, unavailableReason: '关联的模型配置缺少 API Key' }
      state.channelCredentials.set(channelId, result)
      return result
    } catch {
      const result = { available: false, unavailableReason: '关联的模型配置凭据不可用' }
      state.channelCredentials.set(channelId, result)
      return result
    }
  }

  /** 生成 Renderer 可见的清洗渠道选项。 */
  private toChannelOption(
    channel: Channel,
    state: CatalogInvocationState,
  ): ImageGenerationChannelOption {
    /** 只公开已启用模型，避免 Renderer 自行解释 ChannelModel 状态。 */
    const models = channel.models
      .filter((model) => model.enabled)
      .map((model) => ({ id: model.id, name: model.name }))
    /** 渠道级不可用性不依赖某个具体 profile。 */
    let availability: AvailabilityResult
    if (!channel.enabled) {
      availability = { available: false, unavailableReason: '模型配置已停用' }
    } else if (!channel.baseUrl.trim()) {
      availability = { available: false, unavailableReason: '模型配置缺少 Base URL' }
    } else if (models.length === 0) {
      availability = { available: false, unavailableReason: '模型配置没有已启用模型' }
    } else {
      availability = this.getChannelCredential(channel.id, state)
    }
    return {
      channelId: channel.id,
      name: channel.name,
      available: availability.available,
      models,
      ...(availability.unavailableReason === undefined
        ? {}
        : { unavailableReason: availability.unavailableReason }),
    }
  }

  /** 当前 profile 不可用时抛出可展示但不含凭据的明确错误。 */
  private assertProfileAvailable(
    profile: ImageGenerationModelProfile,
    state: CatalogInvocationState,
  ): void {
    /** profile 当前启用、执行器与凭据的综合可用性。 */
    const availability = this.getAvailability(profile, state)
    if (availability.available) return
    if (availability.unavailableReason === '模型已停用') {
      throw new Error(`生图模型已停用: ${profile.id}`)
    }
    throw new Error(`${availability.unavailableReason}: ${profile.id}`)
  }
}

/** 从旧 Nano Banana 凭据合成只存在于内存的默认 profile。 */
function createLegacyProfile(
  credentials: Record<string, string>,
  now: number,
): Extract<ImageGenerationModelProfile, { executor: 'nano-banana' }> {
  const profile = validateProfile({
    id: LEGACY_PROFILE_ID,
    name: 'Nano Banana 默认模型',
    executor: 'nano-banana',
    modelId: credentials.model?.trim() || DEFAULT_IMAGE_MODEL,
    enabled: true,
    createdAt: now,
    updatedAt: now,
  }, 0, new Set<ImageGenerationExecutor>(['nano-banana']))
  if (profile.executor !== 'nano-banana') throw new Error('旧生图模型执行器无效')
  return profile
}

/** 严格解析目录根结构和 profile 数组，拒绝未知版本或额外字段。 */
function parseModelsFile(value: unknown): ImageGenerationModelsFile {
  if (!isPlainObject(value)) {
    throw new Error('生图模型目录格式无效：根节点必须是普通对象')
  }
  /** 根节点字段必须完整且仅包含 schemaVersion 与 profiles。 */
  const rootKeys = Object.keys(value)
  if (rootKeys.length !== 2 || !rootKeys.includes('schemaVersion') || !rootKeys.includes('profiles')) {
    throw new Error('生图模型目录格式无效：必须且只能包含 schemaVersion 和 profiles')
  }
  if (!Array.isArray(value.profiles)) {
    throw new Error('生图模型目录 profiles 必须是数组')
  }
  if (value.schemaVersion === 1) {
    const profiles = validateProfiles(
      value.profiles,
      new Set<ImageGenerationExecutor>(['nano-banana']),
    )
    return {
      schemaVersion: 1,
      profiles: profiles.map((profile) => {
        if (profile.executor !== 'nano-banana') throw new Error('schema v1 只支持 Nano Banana')
        return profile
      }),
    }
  }
  if (value.schemaVersion === 2) {
    return {
      schemaVersion: 2,
      profiles: validateProfiles(value.profiles, SUPPORTED_EXECUTORS),
    }
  }
  throw new Error(`不支持的生图模型目录 schemaVersion: ${String(value.schemaVersion)}`)
}

/** 校验 profile 数组的字段、值域与 ID 唯一性，并返回独立副本。 */
function validateProfiles(
  profiles: readonly unknown[],
  allowedExecutors: ReadonlySet<ImageGenerationExecutor>,
): ImageGenerationModelProfile[] {
  /** 已出现的稳定 ID，用于拒绝目录内歧义项。 */
  const profileIds = new Set<string>()
  return profiles.map((profile, index) => {
    /** 当前项经字段和值域校验后的 profile。 */
    const validated = validateProfile(profile, index, allowedExecutors)
    if (profileIds.has(validated.id)) {
      throw new Error(`生图模型 profile ID 重复: ${validated.id}`)
    }
    profileIds.add(validated.id)
    return validated
  })
}

/** 校验单个 profile 的精确字段和值域，并只清洗展示文本。 */
function validateProfile(
  value: unknown,
  index: number,
  allowedExecutors: ReadonlySet<ImageGenerationExecutor>,
): ImageGenerationModelProfile {
  /** 错误消息中定位当前数组项的统一前缀。 */
  const description = `生图模型 profile[${index}]`
  if (!isPlainObject(value)) {
    throw new Error(`${description} 必须是普通对象`)
  }
  if (!SUPPORTED_EXECUTORS.has(value.executor as ImageGenerationExecutor)
    || !allowedExecutors.has(value.executor as ImageGenerationExecutor)) {
    throw new Error(`${description} executor 不受支持`)
  }
  /** executor 决定唯一允许的字段集合。 */
  const keys = Object.keys(value)
  const expectedKeys = value.executor === 'openai-images'
    ? OPENAI_IMAGES_PROFILE_KEYS
    : BASE_PROFILE_KEYS
  if (keys.length !== expectedKeys.length || !expectedKeys.every((key) => keys.includes(key))) {
    throw new Error(`${description} 字段不完整或包含未知字段`)
  }
  if (typeof value.id !== 'string' || value.id.length === 0 || value.id !== value.id.trim()) {
    throw new Error(`${description} id 必须是无首尾空白的非空字符串`)
  }
  if (typeof value.name !== 'string' || value.name.trim().length === 0) {
    throw new Error(`${description} name 必须是非空字符串`)
  }
  if (value.name.length > IMAGE_GENERATION_MODEL_NAME_MAX_LENGTH) {
    throw new Error(`${description} name 长度不能超过 ${IMAGE_GENERATION_MODEL_NAME_MAX_LENGTH} 个字符`)
  }
  if (typeof value.modelId !== 'string' || value.modelId.trim().length === 0) {
    throw new Error(`${description} modelId 必须是非空字符串`)
  }
  if (value.modelId.length > IMAGE_GENERATION_MODEL_ID_MAX_LENGTH) {
    throw new Error(`${description} modelId 长度不能超过 ${IMAGE_GENERATION_MODEL_ID_MAX_LENGTH} 个字符`)
  }
  if (typeof value.enabled !== 'boolean') {
    throw new Error(`${description} enabled 必须是 boolean`)
  }
  if (!isFiniteNonNegativeNumber(value.createdAt)) {
    throw new Error(`${description} createdAt 必须是有限非负数`)
  }
  if (!isFiniteNonNegativeNumber(value.updatedAt)) {
    throw new Error(`${description} updatedAt 必须是有限非负数`)
  }
  /** 渠道 profile 额外校验稳定 channelId。 */
  if (value.executor === 'openai-images') {
    if (typeof value.channelId !== 'string'
      || value.channelId.length === 0
      || value.channelId !== value.channelId.trim()
      || value.channelId.length > IMAGE_GENERATION_MODEL_ID_MAX_LENGTH) {
      throw new Error(`${description} channelId 必须是无首尾空白的非空字符串`)
    }
    return {
      id: value.id,
      name: value.name.trim(),
      executor: 'openai-images',
      channelId: value.channelId,
      modelId: value.modelId.trim(),
      enabled: value.enabled,
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
    }
  }
  return {
    id: value.id,
    name: value.name.trim(),
    executor: 'nano-banana',
    modelId: value.modelId.trim(),
    enabled: value.enabled,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  }
}

/** 判断未知值是否为可安全枚举字段的普通对象。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  /** 原型必须是标准对象或无原型对象，拒绝类实例携带隐式行为。 */
  const prototype = Object.getPrototypeOf(value) as unknown
  return prototype === Object.prototype || prototype === null
}

/** 判断时间戳字段是否为有限非负数。 */
function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/** 判断旧 Nano Banana API Key 当前是否有效配置。 */
function hasNanoBananaApiKey(credentials: Record<string, string>): boolean {
  return (credentials.apiKey?.trim().length ?? 0) > 0
}

/** 把 profile 和可用性转换为不含敏感字段的选择项。 */
function toOption(
  profile: ImageGenerationModelProfile,
  availability: AvailabilityResult,
): ImageGenerationModelOption {
  /** 两类选项共享的展示字段。 */
  const base = {
    profileId: profile.id,
    name: profile.name,
    modelId: profile.modelId,
    available: availability.available,
    ...(availability.unavailableReason === undefined
      ? {}
      : { unavailableReason: availability.unavailableReason }),
  }
  return profile.executor === 'openai-images'
    ? { ...base, executor: 'openai-images', channelId: profile.channelId }
    : { ...base, executor: 'nano-banana' }
}

/** 从当前 profile 创建不含凭据和路径的任务快照。 */
function toSnapshot(profile: ImageGenerationModelProfile): ImageGenerationModelSnapshot {
  /** 名称在任务创建时固化，后续 profile 改名不污染历史记录。 */
  const base = {
    profileId: profile.id,
    name: profile.name,
    modelId: profile.modelId,
  }
  return profile.executor === 'openai-images'
    ? { ...base, executor: 'openai-images', channelId: profile.channelId }
    : { ...base, executor: 'nano-banana' }
}

/** 严格比较任务快照中的稳定执行字段。 */
function assertProfileMatchesSnapshot(
  profile: ImageGenerationModelProfile,
  snapshot: ImageGenerationModelSnapshot,
): void {
  const matches = profile.executor === snapshot.executor
    && profile.modelId === snapshot.modelId
    && (profile.executor !== 'openai-images'
      || (snapshot.executor === 'openai-images' && profile.channelId === snapshot.channelId))
  if (!matches) {
    throw new Error(`生图模型快照与当前配置不一致: ${snapshot.profileId}`)
  }
}

/** 复制公开 profile，避免调用方修改目录内部读取结果。 */
function copyProfile(profile: ImageGenerationModelProfile): ImageGenerationModelProfile {
  if (profile.executor === 'openai-images') {
    return {
      id: profile.id,
      name: profile.name,
      executor: 'openai-images',
      channelId: profile.channelId,
      modelId: profile.modelId,
      enabled: profile.enabled,
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
    }
  }
  return {
    id: profile.id,
    name: profile.name,
    executor: 'nano-banana',
    modelId: profile.modelId,
    enabled: profile.enabled,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  }
}
