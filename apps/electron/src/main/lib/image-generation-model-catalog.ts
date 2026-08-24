import { existsSync, readFileSync } from 'node:fs'
import type {
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
import { writeJsonFileAtomic } from './safe-file'

/** 目录文件当前唯一受支持的 schema 版本。 */
const IMAGE_GENERATION_MODELS_SCHEMA_VERSION = 1
/** 旧 Nano Banana 配置合成项的稳定 ID。 */
const LEGACY_PROFILE_ID = 'legacy-nano-banana-default'
/** 旧配置未指定模型时使用的默认图片模型。 */
const DEFAULT_IMAGE_MODEL = 'gemini-3.1-flash-image-preview'
/** 当前主进程能够执行的生图后端。 */
const SUPPORTED_EXECUTOR: ImageGenerationExecutor = 'nano-banana'
/** profile 允许持久化的完整字段集合。 */
const PROFILE_KEYS = [
  'id',
  'name',
  'executor',
  'modelId',
  'enabled',
  'createdAt',
  'updatedAt',
] as const

/** 磁盘上的系统生图模型目录结构。 */
interface ImageGenerationModelsFile {
  schemaVersion: 1
  profiles: ImageGenerationModelProfile[]
}

/** 模型目录的文件路径、旧凭据来源和时间依赖。 */
export interface ImageGenerationModelCatalogDependencies {
  /** 系统生图模型目录文件的绝对路径。 */
  configPath: string
  /** 按需读取旧 Nano Banana 凭据，不把凭据保存进模型目录。 */
  getNanoBananaCredentials: () => Record<string, string>
  /** 生成旧兼容 profile 时间戳；生产默认使用当前时间。 */
  now?: () => number
}

/** 目录读取后附带是否来自旧配置的信息。 */
interface LoadedProfiles {
  profiles: ImageGenerationModelProfile[]
  inheritedFromLegacyConfig: boolean
}

/** 当前 profile 不可用时的判断结果。 */
interface AvailabilityResult {
  available: boolean
  unavailableReason?: string
}

/** 管理系统级生图模型 profile，并隔离旧凭据与公开目录数据。 */
export class ImageGenerationModelCatalog {
  constructor(private readonly dependencies: ImageGenerationModelCatalogDependencies) {}

  /** 列出严格解析后的目录；文件缺失时只读合成旧配置兼容项。 */
  listCatalog(): ImageGenerationModelCatalogResult {
    /** 单次公开调用固定使用同一凭据快照，避免目录与状态漂移。 */
    const credentials = this.dependencies.getNanoBananaCredentials()
    /** 当前磁盘目录或旧配置合成结果。 */
    const loaded = this.loadProfiles(credentials)
    return {
      profiles: loaded.profiles.map(copyProfile),
      channelOptions: [],
      inheritedFromLegacyConfig: loaded.inheritedFromLegacyConfig,
      credentialsConfigured: hasNanoBananaApiKey(credentials),
    }
  }

  /** 列出全部 profile 的选择项，包括当前不可用项及明确原因。 */
  listOptions(): ImageGenerationModelOption[] {
    /** 凭据在本次列表计算中只读取一次，避免同次结果漂移。 */
    const credentials = this.dependencies.getNanoBananaCredentials()
    /** 当前磁盘目录或旧配置合成结果。 */
    const loaded = this.loadProfiles(credentials)
    return loaded.profiles.map((profile) => {
      /** profile 当前启用、执行器与凭据的综合可用性。 */
      const availability = getAvailability(profile, credentials)
      return {
        profileId: profile.id,
        name: profile.name,
        executor: profile.executor,
        modelId: profile.modelId,
        available: availability.available,
        ...(availability.unavailableReason === undefined
          ? {}
          : { unavailableReason: availability.unavailableReason }),
      }
    })
  }

  /** 严格校验并完整替换所有 profile，使用 safe-file 原子写入。 */
  replaceProfiles(profiles: ImageGenerationModelProfile[]): ImageGenerationModelCatalogResult {
    if (!Array.isArray(profiles)) {
      throw new Error('生图模型 profiles 必须是数组')
    }
    /** 经严格字段校验并清洗可展示文本后的完整 profile。 */
    const validatedProfiles = validateProfiles(profiles)
    /** 单次替换固定使用同一凭据快照，并供旧目录兼容读取复用。 */
    const credentials = this.dependencies.getNanoBananaCredentials()
    if (existsSync(this.dependencies.configPath)) {
      /** 写前确认当前主文件有效，避免覆盖唯一损坏事实或污染恢复候选。 */
      this.readModelsFile()
    }
    /** 写入值只包含固定 schema 与 profile 字段。 */
    const file: ImageGenerationModelsFile = {
      schemaVersion: IMAGE_GENERATION_MODELS_SCHEMA_VERSION,
      profiles: validatedProfiles,
    }
    writeJsonFileAtomic(this.dependencies.configPath, file)
    return {
      profiles: validatedProfiles.map(copyProfile),
      channelOptions: [],
      inheritedFromLegacyConfig: false,
      credentialsConfigured: hasNanoBananaApiKey(credentials),
    }
  }

  /** 解析当前可执行的 profile，并固化任务所需公开字段。 */
  resolveAvailableSnapshot(profileId: string): ImageGenerationModelSnapshot {
    /** 单次解析固定使用同一凭据快照，兼顾 legacy model 与可用性。 */
    const credentials = this.dependencies.getNanoBananaCredentials()
    /** 当前 ID 对应的严格解析 profile。 */
    const profile = this.findProfile(profileId, credentials)
    assertProfileAvailable(profile, credentials)
    return toSnapshot(profile)
  }

  /** 确认历史快照仍可由当前同一执行配置运行；profile 改名不影响快照。 */
  assertSnapshotAvailable(snapshot: ImageGenerationModelSnapshot): void {
    /** 单次校验固定使用同一凭据快照，兼顾 legacy model 与可用性。 */
    const credentials = this.dependencies.getNanoBananaCredentials()
    /** 当前 ID 对应的严格解析 profile。 */
    const profile = this.findProfile(snapshot.profileId, credentials)
    assertProfileAvailable(profile, credentials)
    if (profile.executor !== snapshot.executor || profile.modelId !== snapshot.modelId) {
      throw new Error(`生图模型快照与当前配置不一致: ${snapshot.profileId}`)
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
}

/** 从旧 Nano Banana 凭据合成只存在于内存的默认 profile。 */
function createLegacyProfile(
  credentials: Record<string, string>,
  now: number,
): ImageGenerationModelProfile {
  return validateProfile({
    id: LEGACY_PROFILE_ID,
    name: 'Nano Banana 默认模型',
    executor: SUPPORTED_EXECUTOR,
    modelId: credentials.model?.trim() || DEFAULT_IMAGE_MODEL,
    enabled: true,
    createdAt: now,
    updatedAt: now,
  }, 0)
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
  if (value.schemaVersion !== IMAGE_GENERATION_MODELS_SCHEMA_VERSION) {
    throw new Error(`不支持的生图模型目录 schemaVersion: ${String(value.schemaVersion)}`)
  }
  if (!Array.isArray(value.profiles)) {
    throw new Error('生图模型目录 profiles 必须是数组')
  }
  return {
    schemaVersion: IMAGE_GENERATION_MODELS_SCHEMA_VERSION,
    profiles: validateProfiles(value.profiles),
  }
}

/** 校验 profile 数组的字段、值域与 ID 唯一性，并返回独立副本。 */
function validateProfiles(profiles: readonly unknown[]): ImageGenerationModelProfile[] {
  /** 已出现的稳定 ID，用于拒绝目录内歧义项。 */
  const profileIds = new Set<string>()
  return profiles.map((profile, index) => {
    /** 当前项经字段和值域校验后的 profile。 */
    const validated = validateProfile(profile, index)
    if (profileIds.has(validated.id)) {
      throw new Error(`生图模型 profile ID 重复: ${validated.id}`)
    }
    profileIds.add(validated.id)
    return validated
  })
}

/** 校验单个 profile 的精确字段和值域，并只清洗 name/modelId 两个展示文本。 */
function validateProfile(value: unknown, index: number): ImageGenerationModelProfile {
  /** 错误消息中定位当前数组项的统一前缀。 */
  const description = `生图模型 profile[${index}]`
  if (!isPlainObject(value)) {
    throw new Error(`${description} 必须是普通对象`)
  }
  /** profile 不能缺字段或携带未定义字段，避免敏感值意外落盘。 */
  const keys = Object.keys(value)
  if (keys.length !== PROFILE_KEYS.length || !PROFILE_KEYS.every((key) => keys.includes(key))) {
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
  if (value.executor !== SUPPORTED_EXECUTOR) {
    throw new Error(`${description} executor 不受支持`)
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
  return {
    id: value.id,
    name: value.name.trim(),
    executor: value.executor,
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

/** 计算 profile 当前不可用原因，停用优先于凭据缺失。 */
function getAvailability(
  profile: ImageGenerationModelProfile,
  credentials: Record<string, string>,
): AvailabilityResult {
  if (!profile.enabled) {
    return { available: false, unavailableReason: '模型已停用' }
  }
  if (profile.executor !== SUPPORTED_EXECUTOR) {
    return { available: false, unavailableReason: '生图模型执行器不受支持' }
  }
  if (!hasNanoBananaApiKey(credentials)) {
    return { available: false, unavailableReason: 'Nano Banana API Key 未配置' }
  }
  return { available: true }
}

/** 当前 profile 不可用时抛出可直接展示或记录的明确错误。 */
function assertProfileAvailable(
  profile: ImageGenerationModelProfile,
  credentials: Record<string, string>,
): void {
  /** profile 当前启用、执行器与凭据的综合可用性。 */
  const availability = getAvailability(profile, credentials)
  if (!availability.available) {
    if (availability.unavailableReason === '模型已停用') {
      throw new Error(`生图模型已停用: ${profile.id}`)
    }
    throw new Error(`${availability.unavailableReason}: ${profile.id}`)
  }
}

/** 从当前 profile 创建不含凭据和路径的任务快照。 */
function toSnapshot(profile: ImageGenerationModelProfile): ImageGenerationModelSnapshot {
  return {
    profileId: profile.id,
    name: profile.name,
    executor: profile.executor,
    modelId: profile.modelId,
  }
}

/** 复制公开 profile，避免调用方修改目录内部读取结果。 */
function copyProfile(profile: ImageGenerationModelProfile): ImageGenerationModelProfile {
  return {
    id: profile.id,
    name: profile.name,
    executor: profile.executor,
    modelId: profile.modelId,
    enabled: profile.enabled,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  }
}
