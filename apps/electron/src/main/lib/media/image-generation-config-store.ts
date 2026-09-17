/**
 * 独立生图供应商配置 Store。
 *
 * 与音频 Store 同构：只实现生图目录自己的语义（profile/请求解析、密文合并、
 * 创建时间保护、公开投影），文件级安全机制复用 SecureProfileCatalogFile。
 * 即梦没有密文：它的凭据是 CLI 本地登录态，由登录链路负责真实校验。
 */
import type {
  ImageGenerationProfile,
  ImageGenerationPublicCatalog,
  ImageGenerationPublicProfile,
  ReplaceImageGenerationCatalogRequest,
} from '@proma/shared'
import {
  IMAGE_GENERATION_PROVIDER_DESCRIPTORS,
  IMAGE_PROVIDER_API_KEY_MAX_LENGTH,
  parseImageGenerationProfile,
  parseReplaceImageGenerationCatalogRequest,
} from '@proma/shared'
import type { AtomicDestinationExpectation } from '../safe-file'
import { writeJsonFileAtomicSecure } from '../safe-file'
import { SecureProfileCatalogFile } from './secure-profile-catalog-file'

/** 独立生图目录允许占用的最大 JSON 字节数。 */
const IMAGE_GENERATION_CONFIG_MAX_BYTES = 1024 * 1024
/** 独立生图目录的 schema 版本。 */
const IMAGE_GENERATION_CATALOG_SCHEMA_VERSION = 1

/** 生图目录对外的稳定错误码。 */
const IMAGE_GENERATION_ERROR_CODES = {
  configInvalid: 'IMAGE_GENERATION_CONFIG_INVALID',
  configConflict: 'IMAGE_GENERATION_CONFIG_CONFLICT',
  configSizeLimit: 'IMAGE_GENERATION_CONFIG_SIZE_LIMIT',
  configWriteFailed: 'IMAGE_GENERATION_CONFIG_WRITE_FAILED',
  configOutcomeUnknown: 'IMAGE_GENERATION_CONFIG_OUTCOME_UNKNOWN',
} as const

/** Electron safeStorage 的最小依赖，测试可注入确定性实现。 */
export interface ImageGenerationSecureStorage {
  /** 当前环境是否支持系统级加密。 */
  isEncryptionAvailable(): boolean
  /** 返回实际存储后端，用于拒绝 Linux 明文降级。 */
  getSelectedStorageBackend(): string
  /** 把短期存在的明文转换为系统密文。 */
  encryptString(value: string): Buffer
  /** 仅在连接测试需要时解密指定配置。 */
  decryptString(value: Buffer): string
}

/** 独立生图配置 Store 的显式依赖。 */
export interface ImageGenerationConfigStoreOptions {
  /** 配置文件完整路径。 */
  configPath: string
  /** 系统安全存储适配器。 */
  secureStorage: ImageGenerationSecureStorage
  /** 生成更新时间的可替换时钟。 */
  now?: () => number
  /** 当前运行平台；生产默认使用 Node 进程平台。 */
  platform?: NodeJS.Platform
  /** 读取字节完成后、状态复验前调用，仅供竞态回归测试。 */
  beforeReadFinish?: () => void
  /** 写入调用前执行，仅供目标置换竞态回归测试。 */
  beforeCommit?: () => void
  /** 替换安全原子 writer，仅供 post-commit 故障回归测试。 */
  writeConfig?: typeof writeJsonFileAtomicSecure
}

/** 单条配置的磁盘结构；即梦没有密文，用 null 明确表示“无密钥”。 */
interface PersistedImageGenerationProfile {
  profile: ImageGenerationProfile
  encryptedApiKey: string | null
}

/** 磁盘目录与本次提交期望状态。 */
interface PersistedImageGenerationRead {
  catalog: { revision: number; profiles: PersistedImageGenerationProfile[] }
  expectedDestination: AtomicDestinationExpectation
}

/** 判断未知值是否为非数组对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 判断对象只包含声明的字段。 */
function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowedKeys.includes(key))
}

/** 严格解析可 JSON 化的非空 canonical base64 密文。 */
function parseEncryptedApiKey(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(IMAGE_GENERATION_ERROR_CODES.configInvalid)
  }
  /** 从 JSON 表示恢复的密文字节。 */
  const bytes = Buffer.from(value, 'base64')
  if (bytes.length === 0 || bytes.toString('base64') !== value) {
    throw new Error(IMAGE_GENERATION_ERROR_CODES.configInvalid)
  }
  return value
}

/** 密钥型供应商使用 API Key，即梦没有密文。 */
function providerUsesApiKey(provider: ImageGenerationProfile['provider']): boolean {
  return IMAGE_GENERATION_PROVIDER_DESCRIPTORS.find((descriptor) => descriptor.provider === provider)?.usesApiKey ?? false
}

/** 解析磁盘条目：密钥与配置必须同时匹配供应商形态。 */
function parsePersistedImageEntry(value: unknown): PersistedImageGenerationProfile {
  if (!isRecord(value) || !hasOnlyKeys(value, ['profile', 'encryptedApiKey'])) {
    throw new Error(IMAGE_GENERATION_ERROR_CODES.configInvalid)
  }
  const profile = parseImageGenerationProfile(value.profile)
  if (!providerUsesApiKey(profile.provider)) {
    /** 即梦磁盘条目不允许出现任何密文槽位内容。 */
    if (value.encryptedApiKey !== null && value.encryptedApiKey !== undefined) {
      throw new Error(IMAGE_GENERATION_ERROR_CODES.configInvalid)
    }
    return { profile, encryptedApiKey: null }
  }
  return { profile, encryptedApiKey: parseEncryptedApiKey(value.encryptedApiKey) }
}

/** 把持久化条目转换为不含密文的 Renderer DTO。 */
function toPublicProfile(item: PersistedImageGenerationProfile): ImageGenerationPublicProfile {
  const base = {
    ...item.profile,
    /** 即梦凭据是 CLI 登录态，缺失与否由登录链路判定，这里不视为缺少密钥。 */
    credentialConfigured: providerUsesApiKey(item.profile.provider) ? item.encryptedApiKey !== null : true,
  }
  return item.profile.provider === 'dreamina'
    ? base
    : { ...base, endpointOrigin: new URL(item.profile.baseUrl).origin }
}

/** 独立生图配置 Store，负责严格读取、CAS 与凭据加解密。 */
export class ImageGenerationConfigStore {
  /** 目录文件的安全读写层。 */
  private readonly file: SecureProfileCatalogFile<PersistedImageGenerationProfile>
  /** 系统安全存储适配器。 */
  private readonly secureStorage: ImageGenerationSecureStorage
  /** 单调业务时钟。 */
  private readonly now: () => number
  /** 用于限定 safeStorage backend 探测的平台。 */
  private readonly platform: NodeJS.Platform

  /** 创建绑定单一配置文件的 Store。 */
  constructor(options: ImageGenerationConfigStoreOptions) {
    this.file = new SecureProfileCatalogFile<PersistedImageGenerationProfile>({
      configPath: options.configPath,
      maxBytes: IMAGE_GENERATION_CONFIG_MAX_BYTES,
      schemaVersion: IMAGE_GENERATION_CATALOG_SCHEMA_VERSION,
      errorCodes: IMAGE_GENERATION_ERROR_CODES,
      parseEntry: (value) => parsePersistedImageEntry(value),
      ...(options.beforeReadFinish === undefined ? {} : { beforeReadFinish: options.beforeReadFinish }),
      ...(options.beforeCommit === undefined ? {} : { beforeCommit: options.beforeCommit }),
      ...(options.writeConfig === undefined ? {} : { writeConfig: options.writeConfig }),
    })
    this.secureStorage = options.secureStorage
    this.now = options.now ?? Date.now
    this.platform = options.platform ?? process.platform
  }

  /** 返回严格解析的公开目录；首次缺失返回 revision 0。 */
  readPublic(): ImageGenerationPublicCatalog {
    return this.toPublicCatalog(this.readPersisted().catalog)
  }

  /** 以单一 revision 完整替换目录，锁内串行化 CAS 与密文合并。 */
  replace(input: ReplaceImageGenerationCatalogRequest): ImageGenerationPublicCatalog {
    const request = parseReplaceImageGenerationCatalogRequest(input)
    return this.file.withLock(() => {
      const currentRead = this.readPersisted()
      const current = currentRead.catalog
      if (current.revision !== request.expectedRevision) {
        throw new Error(IMAGE_GENERATION_ERROR_CODES.configConflict)
      }
      if (current.revision === Number.MAX_SAFE_INTEGER) {
        throw new Error(IMAGE_GENERATION_ERROR_CODES.configInvalid)
      }
      /** 当前条目按 ID 索引，供保留创建时间与密文。 */
      const currentById = new Map(current.profiles.map((item) => [item.profile.id, item]))
      const updatedAt = this.readCurrentTime()
      const profiles = request.profiles.map(({ profile, credentialUpdate }): PersistedImageGenerationProfile => {
        const existing = currentById.get(profile.id)
        const createdAt = existing?.profile.createdAt ?? profile.createdAt
        if (updatedAt < createdAt || existing && updatedAt < existing.profile.updatedAt) {
          throw new Error(IMAGE_GENERATION_ERROR_CODES.configInvalid)
        }
        const nextProfile = parseImageGenerationProfile({ ...profile, createdAt, updatedAt })
        if (!providerUsesApiKey(nextProfile.provider)) return { profile: nextProfile, encryptedApiKey: null }
        if (credentialUpdate.mode === 'preserve') {
          if (!existing) throw new Error('IMAGE_GENERATION_CREDENTIAL_PRESERVE_INVALID')
          return { profile: nextProfile, encryptedApiKey: existing.encryptedApiKey }
        }
        return { profile: nextProfile, encryptedApiKey: this.encryptApiKey(credentialUpdate.apiKey) }
      })
      this.file.commit({
        revision: current.revision + 1,
        entries: profiles,
        expectedDestination: currentRead.expectedDestination,
      })
      return this.toPublicCatalog({ revision: current.revision + 1, profiles })
    })
  }

  /** 按稳定 ID 解密单个 API Key；即梦没有可解密凭据。 */
  resolveApiKey(profileId: string): string {
    const item = this.readPersisted().catalog.profiles.find((candidate) => candidate.profile.id === profileId)
    if (!item) throw new Error('IMAGE_GENERATION_PROFILE_NOT_FOUND')
    if (!providerUsesApiKey(item.profile.provider) || item.encryptedApiKey === null) {
      throw new Error('IMAGE_GENERATION_CREDENTIAL_NOT_APPLICABLE')
    }
    this.assertSecureStorage()
    try {
      const value = this.secureStorage.decryptString(Buffer.from(item.encryptedApiKey, 'base64'))
      if (typeof value !== 'string'
        || !value.trim()
        || value !== value.trim()
        || value.length > IMAGE_PROVIDER_API_KEY_MAX_LENGTH) {
        throw new Error('empty credential')
      }
      return value
    } catch {
      throw new Error('IMAGE_GENERATION_CREDENTIAL_DECRYPT_FAILED')
    }
  }

  /** 严格读取主文件并检查目录内 ID 唯一。 */
  private readPersisted(): PersistedImageGenerationRead {
    const read = this.file.read()
    const profileIds = new Set(read.entries.map((item) => item.profile.id))
    if (profileIds.size !== read.entries.length) {
      throw new Error(IMAGE_GENERATION_ERROR_CODES.configInvalid)
    }
    return {
      catalog: { revision: read.revision, profiles: read.entries },
      expectedDestination: read.expectedDestination,
    }
  }

  /** 把完整持久化目录转换为公开目录，不执行任何解密。 */
  private toPublicCatalog(catalog: { revision: number; profiles: PersistedImageGenerationProfile[] }): ImageGenerationPublicCatalog {
    return {
      schemaVersion: IMAGE_GENERATION_CATALOG_SCHEMA_VERSION,
      revision: catalog.revision,
      profiles: catalog.profiles.map(toPublicProfile),
    }
  }

  /** 校验系统后端后加密单个 API Key，并返回 canonical base64。 */
  private encryptApiKey(apiKey: string): string {
    this.assertSecureStorage()
    try {
      const encrypted = this.secureStorage.encryptString(apiKey)
      if (!Buffer.isBuffer(encrypted) || encrypted.length === 0) {
        throw new Error('empty ciphertext')
      }
      return encrypted.toString('base64')
    } catch {
      throw new Error('IMAGE_GENERATION_CREDENTIAL_ENCRYPT_FAILED')
    }
  }

  /** fail-closed 检查系统安全存储，明确拒绝 basic_text 降级。 */
  private assertSecureStorage(): void {
    try {
      if (!this.secureStorage.isEncryptionAvailable()) {
        throw new Error('unavailable')
      }
      if (this.platform !== 'linux') return
      if (this.secureStorage.getSelectedStorageBackend() !== 'basic_text') return
    } catch {
      // 后端探测异常不得向上泄露系统错误或触发明文降级。
    }
    throw new Error('IMAGE_GENERATION_SECURE_STORAGE_UNAVAILABLE')
  }

  /** 读取并校验本次替换使用的统一更新时间。 */
  private readCurrentTime(): number {
    const value = this.now()
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(IMAGE_GENERATION_ERROR_CODES.configInvalid)
    }
    return value
  }
}
