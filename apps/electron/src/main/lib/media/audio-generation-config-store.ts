/**
 * 独立音频生成配置 Store。
 *
 * 只保留音频目录自己的语义：profile/请求解析、旧 schema 迁移、密文合并、
 * 创建时间保护与公开投影；文件级安全机制（fd 稳定读取、目录 CAS、锁、原子写、
 * 结果未知）统一由 SecureProfileCatalogFile 提供，避免与其它供应商目录重复实现。
 */
import type {
  AudioGenerationProfile,
  AudioGenerationPublicCatalog,
  AudioGenerationPublicProfile,
  ReplaceAudioGenerationCatalogRequest,
} from '@proma/shared'
import {
  AUDIO_GENERATION_API_KEY_MAX_LENGTH,
  AUDIO_GENERATION_CATALOG_SCHEMA_VERSION,
  LEGACY_AUDIO_GENERATION_CATALOG_SCHEMA_VERSIONS,
  parseAudioGenerationProfile,
  parseReplaceAudioGenerationCatalogRequest,
} from '@proma/shared'
import type { AtomicDestinationExpectation } from '../safe-file'
import { writeJsonFileAtomicSecure } from '../safe-file'
import { SecureProfileCatalogFile } from './secure-profile-catalog-file'

/** 独立音频目录允许占用的最大 JSON 字节数。 */
const AUDIO_GENERATION_CONFIG_MAX_BYTES = 1024 * 1024

/** 音频目录对外的稳定错误码。 */
const AUDIO_GENERATION_ERROR_CODES = {
  configInvalid: 'AUDIO_GENERATION_CONFIG_INVALID',
  configConflict: 'AUDIO_GENERATION_CONFIG_CONFLICT',
  configSizeLimit: 'AUDIO_GENERATION_CONFIG_SIZE_LIMIT',
  configWriteFailed: 'AUDIO_GENERATION_CONFIG_WRITE_FAILED',
  configOutcomeUnknown: 'AUDIO_GENERATION_CONFIG_OUTCOME_UNKNOWN',
} as const

/** Electron safeStorage 的最小依赖，测试可注入确定性实现。 */
export interface AudioGenerationSecureStorage {
  /** 当前环境是否支持系统级加密。 */
  isEncryptionAvailable(): boolean
  /** 返回实际存储后端，用于拒绝 Linux 明文降级。 */
  getSelectedStorageBackend(): string
  /** 把短期存在的明文转换为系统密文。 */
  encryptString(value: string): Buffer
  /** 仅在连接测试需要时解密指定配置。 */
  decryptString(value: Buffer): string
}

/** 独立音频配置 Store 的显式依赖。 */
export interface AudioGenerationConfigStoreOptions {
  /** 配置文件完整路径。 */
  configPath: string
  /** 系统安全存储适配器。 */
  secureStorage: AudioGenerationSecureStorage
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

/** 单条配置在磁盘中的严格结构，只包含公开配置和密文。 */
interface PersistedAudioGenerationProfile {
  profile: AudioGenerationProfile
  encryptedApiKey: string
}

/** 磁盘目录与本次提交期望状态。 */
interface PersistedAudioGenerationRead {
  catalog: { revision: number; profiles: PersistedAudioGenerationProfile[] }
  expectedDestination: AtomicDestinationExpectation
}

/** 判断未知值是否为非数组对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 判断对象只包含声明的字段，阻止秘密或未来字段被静默保留。 */
function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowedKeys.includes(key))
}

/** 严格解析可 JSON 化的非空 canonical base64 密文。 */
function parseEncryptedApiKey(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(AUDIO_GENERATION_ERROR_CODES.configInvalid)
  }
  /** 从 JSON 表示恢复的密文字节。 */
  const bytes = Buffer.from(value, 'base64')
  if (bytes.length === 0 || bytes.toString('base64') !== value) {
    throw new Error(AUDIO_GENERATION_ERROR_CODES.configInvalid)
  }
  return value
}

/**
 * 把旧目录的扁平模型/音色迁移成 v3 的模型条目。
 * 入参：磁盘上的未知 profile 形状与来源 schema 版本；返回值：可交给严格解析器的 v3 形状或原值。
 * v1 是单值 voiceId，v2 是扁平音色列表；两者都归属当时唯一的 modelId。
 */
function migrateLegacyAudioProfile(value: unknown, schemaVersion: number): unknown {
  if (!isRecord(value)) return value
  if (schemaVersion === 1) {
    if (typeof value.voiceId !== 'string' || typeof value.modelId !== 'string') return value
    const { voiceId, modelId, ...rest } = value
    return {
      ...rest,
      models: [{ id: modelId, voices: [{ id: voiceId, name: voiceId, source: 'manual' }] }],
    }
  }
  if (schemaVersion === 2) {
    if (typeof value.modelId !== 'string' || !Array.isArray(value.voices)) return value
    const { modelId, voices, ...rest } = value
    return { ...rest, models: [{ id: modelId, voices }] }
  }
  return value
}

/** 解析磁盘条目：旧版本先迁移形状，再交给 Shared 严格解析。 */
function parsePersistedAudioEntry(value: unknown, schemaVersion: number): PersistedAudioGenerationProfile {
  if (!isRecord(value) || !hasOnlyKeys(value, ['profile', 'encryptedApiKey'])) {
    throw new Error(AUDIO_GENERATION_ERROR_CODES.configInvalid)
  }
  /** 旧文件只影响本次读取的解释方式，绝不回写用户文件。 */
  const migrated = schemaVersion === AUDIO_GENERATION_CATALOG_SCHEMA_VERSION
    ? value.profile
    : migrateLegacyAudioProfile(value.profile, schemaVersion)
  return {
    profile: parseAudioGenerationProfile(migrated),
    encryptedApiKey: parseEncryptedApiKey(value.encryptedApiKey),
  }
}

/** 把持久化条目转换为不含密文的 Renderer DTO。 */
function toPublicProfile(item: PersistedAudioGenerationProfile): AudioGenerationPublicProfile {
  return {
    ...item.profile,
    credentialConfigured: true,
    endpointOrigin: new URL(item.profile.baseUrl).origin,
  }
}

/** 独立音频生成配置 Store，负责严格读取、CAS 与凭据加解密。 */
export class AudioGenerationConfigStore {
  /** 目录文件的安全读写层。 */
  private readonly file: SecureProfileCatalogFile<PersistedAudioGenerationProfile>
  /** 系统安全存储适配器。 */
  private readonly secureStorage: AudioGenerationSecureStorage
  /** 单调业务时钟由调用方保证，Store 复验不会回退现有时间。 */
  private readonly now: () => number
  /** 用于限定 safeStorage backend 探测的平台。 */
  private readonly platform: NodeJS.Platform

  /** 创建绑定单一配置文件的 Store。 */
  constructor(options: AudioGenerationConfigStoreOptions) {
    this.file = new SecureProfileCatalogFile<PersistedAudioGenerationProfile>({
      configPath: options.configPath,
      maxBytes: AUDIO_GENERATION_CONFIG_MAX_BYTES,
      schemaVersion: AUDIO_GENERATION_CATALOG_SCHEMA_VERSION,
      legacySchemaVersions: LEGACY_AUDIO_GENERATION_CATALOG_SCHEMA_VERSIONS,
      errorCodes: AUDIO_GENERATION_ERROR_CODES,
      parseEntry: parsePersistedAudioEntry,
      ...(options.beforeReadFinish === undefined ? {} : { beforeReadFinish: options.beforeReadFinish }),
      ...(options.beforeCommit === undefined ? {} : { beforeCommit: options.beforeCommit }),
      ...(options.writeConfig === undefined ? {} : { writeConfig: options.writeConfig }),
    })
    this.secureStorage = options.secureStorage
    this.now = options.now ?? Date.now
    this.platform = options.platform ?? process.platform
  }

  /** 返回严格解析的公开目录；首次缺失返回 revision 0。 */
  readPublic(): AudioGenerationPublicCatalog {
    return this.toPublicCatalog(this.readPersisted().catalog)
  }

  /**
   * 以单一 revision 完整替换目录。
   * 锁内串行化读取、CAS、密文合并和原子提交，失败不会发布部分结果。
   */
  replace(input: ReplaceAudioGenerationCatalogRequest): AudioGenerationPublicCatalog {
    /** Shared parser 是所有调用入口的最终请求约束。 */
    const request = parseReplaceAudioGenerationCatalogRequest(input)
    return this.file.withLock(() => {
      /** 锁内读取的当前目录是本次 CAS 唯一基线。 */
      const currentRead = this.readPersisted()
      /** 严格读取后的目录内容。 */
      const current = currentRead.catalog
      if (current.revision !== request.expectedRevision) {
        throw new Error(AUDIO_GENERATION_ERROR_CODES.configConflict)
      }
      if (current.revision === Number.MAX_SAFE_INTEGER) {
        throw new Error(AUDIO_GENERATION_ERROR_CODES.configInvalid)
      }
      /** 当前条目按 ID 索引，供保留创建时间和密文。 */
      const currentById = new Map(current.profiles.map((item) => [item.profile.id, item]))
      /** 本次提交的统一更新时间。 */
      const updatedAt = this.readCurrentTime()
      /** 合并凭据动作后的完整新目录。 */
      const profiles = request.profiles.map(({ profile, credentialUpdate }): PersistedAudioGenerationProfile => {
        /** 同 ID 旧条目存在时，创建时间属于既有实体且不可被表单改写。 */
        const existing = currentById.get(profile.id)
        /** 新条目沿用输入创建时间，已有条目保留原始创建时间。 */
        const createdAt = existing?.profile.createdAt ?? profile.createdAt
        if (updatedAt < createdAt || existing && updatedAt < existing.profile.updatedAt) {
          throw new Error(AUDIO_GENERATION_ERROR_CODES.configInvalid)
        }
        /** 重新交给 Shared parser 约束更新时间覆盖后的最终 Profile。 */
        const nextProfile = parseAudioGenerationProfile({ ...profile, createdAt, updatedAt })
        if (credentialUpdate.mode === 'preserve') {
          if (!existing) throw new Error('AUDIO_GENERATION_CREDENTIAL_PRESERVE_INVALID')
          return { profile: nextProfile, encryptedApiKey: existing.encryptedApiKey }
        }
        return { profile: nextProfile, encryptedApiKey: this.encryptApiKey(credentialUpdate.apiKey) }
      })
      /** revision 只在完整目录成功提交时推进一次。 */
      this.file.commit({
        revision: current.revision + 1,
        entries: profiles,
        expectedDestination: currentRead.expectedDestination,
      })
      return this.toPublicCatalog({ revision: current.revision + 1, profiles })
    })
  }

  /** 按稳定 ID 解密单个 API Key，仅供主进程连接测试使用。 */
  resolveApiKey(profileId: string): string {
    /** 严格读取仍不解密其它条目。 */
    const item = this.readPersisted().catalog.profiles.find((candidate) => candidate.profile.id === profileId)
    if (!item) throw new Error('AUDIO_GENERATION_PROFILE_NOT_FOUND')
    this.assertSecureStorage()
    try {
      /** 只把目标条目的密文交给系统安全存储。 */
      const value = this.secureStorage.decryptString(Buffer.from(item.encryptedApiKey, 'base64'))
      if (typeof value !== 'string'
        || !value.trim()
        || value !== value.trim()
        || value.length > AUDIO_GENERATION_API_KEY_MAX_LENGTH) {
        throw new Error('empty credential')
      }
      return value
    } catch {
      throw new Error('AUDIO_GENERATION_CREDENTIAL_DECRYPT_FAILED')
    }
  }

  /** 严格读取主文件并检查目录内 ID 唯一。 */
  private readPersisted(): PersistedAudioGenerationRead {
    const read = this.file.read()
    /** 用稳定 ID 检测目录内歧义目标。 */
    const profileIds = new Set(read.entries.map((item) => item.profile.id))
    if (profileIds.size !== read.entries.length) {
      throw new Error(AUDIO_GENERATION_ERROR_CODES.configInvalid)
    }
    return {
      catalog: { revision: read.revision, profiles: read.entries },
      expectedDestination: read.expectedDestination,
    }
  }

  /** 把完整持久化目录转换为公开目录，不执行任何解密。 */
  private toPublicCatalog(catalog: { revision: number; profiles: PersistedAudioGenerationProfile[] }): AudioGenerationPublicCatalog {
    return {
      schemaVersion: AUDIO_GENERATION_CATALOG_SCHEMA_VERSION,
      revision: catalog.revision,
      profiles: catalog.profiles.map(toPublicProfile),
    }
  }

  /** 校验系统后端后加密单个 API Key，并返回 canonical base64。 */
  private encryptApiKey(apiKey: string): string {
    this.assertSecureStorage()
    try {
      /** Shared parser 已完成 API Key trim 和长度校验。 */
      const encrypted = this.secureStorage.encryptString(apiKey)
      if (!Buffer.isBuffer(encrypted) || encrypted.length === 0) {
        throw new Error('empty ciphertext')
      }
      return encrypted.toString('base64')
    } catch {
      throw new Error('AUDIO_GENERATION_CREDENTIAL_ENCRYPT_FAILED')
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
    throw new Error('AUDIO_GENERATION_SECURE_STORAGE_UNAVAILABLE')
  }

  /** 读取并校验本次替换使用的统一更新时间。 */
  private readCurrentTime(): number {
    /** 单次替换只调用一次时钟，保证目录内时间一致。 */
    const value = this.now()
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(AUDIO_GENERATION_ERROR_CODES.configInvalid)
    }
    return value
  }
}
