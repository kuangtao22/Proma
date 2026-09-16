import { lstatSync, readFileSync } from 'node:fs'
import type {
  AudioGenerationProfile,
  AudioGenerationPublicCatalog,
  AudioGenerationPublicProfile,
  ReplaceAudioGenerationCatalogRequest,
} from '@proma/shared'
import {
  AUDIO_GENERATION_API_KEY_MAX_LENGTH,
  AUDIO_GENERATION_PROFILE_LIMIT,
  parseAudioGenerationProfile,
  parseReplaceAudioGenerationCatalogRequest,
} from '@proma/shared'
import { writeJsonFileAtomicSecure } from '../safe-file'
import { acquireMediaFileLock } from './media-file-lock'

/** 独立音频目录允许占用的最大 JSON 字节数。 */
const AUDIO_GENERATION_CONFIG_MAX_BYTES = 1024 * 1024

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
}

/** 单条配置在磁盘中的严格结构，只包含公开配置和密文。 */
interface PersistedAudioGenerationProfile {
  profile: AudioGenerationProfile
  encryptedApiKey: string
}

/** 独立音频配置文件的 v1 持久化结构。 */
interface PersistedAudioGenerationCatalog {
  schemaVersion: 1
  revision: number
  profiles: PersistedAudioGenerationProfile[]
}

/** 判断未知值是否为非数组对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 判断对象只包含声明的字段，阻止秘密或未来字段被静默保留。 */
function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowedKeys.includes(key))
}

/** 判断值是可安全递增的非负 revision。 */
function isCatalogRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** 严格解析可 JSON 化的非空 canonical base64 密文。 */
function parseEncryptedApiKey(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('AUDIO_GENERATION_CONFIG_INVALID')
  }
  /** 从 JSON 表示恢复的密文字节。 */
  const bytes = Buffer.from(value, 'base64')
  if (bytes.length === 0 || bytes.toString('base64') !== value) {
    throw new Error('AUDIO_GENERATION_CONFIG_INVALID')
  }
  return value
}

/** 严格解析磁盘目录，不接受未知字段、重复 ID 或非法 Profile。 */
function parsePersistedCatalog(value: unknown): PersistedAudioGenerationCatalog {
  if (!isRecord(value)
    || !hasOnlyKeys(value, ['schemaVersion', 'revision', 'profiles'])
    || value.schemaVersion !== 1
    || !isCatalogRevision(value.revision)
    || !Array.isArray(value.profiles)
    || value.profiles.length > AUDIO_GENERATION_PROFILE_LIMIT) {
    throw new Error('AUDIO_GENERATION_CONFIG_INVALID')
  }
  /** 按文件顺序解析后的持久化条目。 */
  const profiles = value.profiles.map((item): PersistedAudioGenerationProfile => {
    if (!isRecord(item) || !hasOnlyKeys(item, ['profile', 'encryptedApiKey'])) {
      throw new Error('AUDIO_GENERATION_CONFIG_INVALID')
    }
    return {
      profile: parseAudioGenerationProfile(item.profile),
      encryptedApiKey: parseEncryptedApiKey(item.encryptedApiKey),
    }
  })
  /** 用稳定 ID 检测目录内歧义目标。 */
  const profileIds = new Set(profiles.map((item) => item.profile.id))
  if (profileIds.size !== profiles.length) throw new Error('AUDIO_GENERATION_CONFIG_INVALID')
  return { schemaVersion: 1, revision: value.revision, profiles }
}

/** 把持久化条目转换为不含密文的 Renderer DTO。 */
function toPublicProfile(item: PersistedAudioGenerationProfile): AudioGenerationPublicProfile {
  return {
    ...item.profile,
    credentialConfigured: true,
    endpointOrigin: new URL(item.profile.baseUrl).origin,
  }
}

/** 把完整持久化目录转换为公开目录，不执行任何解密。 */
function toPublicCatalog(catalog: PersistedAudioGenerationCatalog): AudioGenerationPublicCatalog {
  return {
    schemaVersion: 1,
    revision: catalog.revision,
    profiles: catalog.profiles.map(toPublicProfile),
  }
}

/** 判断文件系统错误是否只表示目标尚未创建。 */
function isMissingFileError(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

/** 独立音频生成配置 Store，负责严格读取、CAS 与凭据加解密。 */
export class AudioGenerationConfigStore {
  /** 配置文件完整路径。 */
  private readonly configPath: string
  /** 系统安全存储适配器。 */
  private readonly secureStorage: AudioGenerationSecureStorage
  /** 单调业务时钟由调用方保证，Store 复验不会回退现有时间。 */
  private readonly now: () => number

  /** 创建绑定单一配置文件的 Store。 */
  constructor(options: AudioGenerationConfigStoreOptions) {
    this.configPath = options.configPath
    this.secureStorage = options.secureStorage
    this.now = options.now ?? Date.now
  }

  /** 返回严格解析的公开目录；首次缺失返回 revision 0。 */
  readPublic(): AudioGenerationPublicCatalog {
    return toPublicCatalog(this.readPersisted())
  }

  /**
   * 以单一 revision 完整替换目录。
   * 锁内串行化读取、CAS、密文合并和原子提交，失败不会发布部分结果。
   */
  replace(input: ReplaceAudioGenerationCatalogRequest): AudioGenerationPublicCatalog {
    /** Shared parser 是所有调用入口的最终请求约束。 */
    const request = parseReplaceAudioGenerationCatalogRequest(input)
    return this.withLock(() => {
      /** 锁内读取的当前目录是本次 CAS 唯一基线。 */
      const current = this.readPersisted()
      if (current.revision !== request.expectedRevision) {
        throw new Error('AUDIO_GENERATION_CONFIG_CONFLICT')
      }
      if (current.revision === Number.MAX_SAFE_INTEGER) {
        throw new Error('AUDIO_GENERATION_CONFIG_INVALID')
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
          throw new Error('AUDIO_GENERATION_CONFIG_INVALID')
        }
        /** 重新交给 Shared parser 约束更新时间覆盖后的最终 Profile。 */
        const nextProfile = parseAudioGenerationProfile({ ...profile, createdAt, updatedAt })
        if (credentialUpdate.mode === 'preserve') {
          if (!existing) throw new Error('AUDIO_GENERATION_CREDENTIAL_PRESERVE_INVALID')
          return { profile: nextProfile, encryptedApiKey: existing.encryptedApiKey }
        }
        return {
          profile: nextProfile,
          encryptedApiKey: this.encryptApiKey(credentialUpdate.apiKey),
        }
      })
      /** revision 只在完整目录成功提交时推进一次。 */
      const next: PersistedAudioGenerationCatalog = {
        schemaVersion: 1,
        revision: current.revision + 1,
        profiles,
      }
      this.assertSerializedSize(next)
      writeJsonFileAtomicSecure(this.configPath, next)
      return toPublicCatalog(next)
    })
  }

  /** 按稳定 ID 解密单个 API Key，仅供主进程连接测试使用。 */
  resolveApiKey(profileId: string): string {
    /** 严格读取仍不解密其它条目。 */
    const item = this.readPersisted().profiles.find((candidate) => candidate.profile.id === profileId)
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

  /** 严格读取主文件；存在但损坏时不回退空目录或自动覆盖。 */
  private readPersisted(): PersistedAudioGenerationCatalog {
    try {
      /** lstat 阻止配置路径通过符号链接指向非受管文件。 */
      const stats = lstatSync(this.configPath)
      if (!stats.isFile()) throw new Error('AUDIO_GENERATION_CONFIG_INVALID')
      if (stats.size > AUDIO_GENERATION_CONFIG_MAX_BYTES) {
        throw new Error('AUDIO_GENERATION_CONFIG_SIZE_LIMIT')
      }
      /** 文件大小已受限后再一次性读取和解析 JSON。 */
      const contents = readFileSync(this.configPath, 'utf8')
      return parsePersistedCatalog(JSON.parse(contents) as unknown)
    } catch (error) {
      if (isMissingFileError(error)) {
        return { schemaVersion: 1, revision: 0, profiles: [] }
      }
      if (error instanceof Error && error.message === 'AUDIO_GENERATION_CONFIG_SIZE_LIMIT') throw error
      throw new Error('AUDIO_GENERATION_CONFIG_INVALID', { cause: error })
    }
  }

  /** 在跨进程媒体文件锁内执行一次同步目录更新，并保证释放锁。 */
  private withLock<T>(operation: () => T): T {
    /** 锁文件与配置文件相邻，所有 Store 实例使用同一竞争点。 */
    const release = acquireMediaFileLock(`${this.configPath}.lock`)
    try {
      return operation()
    } finally {
      release()
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
      if (this.secureStorage.isEncryptionAvailable()
        && this.secureStorage.getSelectedStorageBackend() !== 'basic_text') return
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
      throw new Error('AUDIO_GENERATION_CONFIG_INVALID')
    }
    return value
  }

  /** 按实际 pretty JSON 编码检查待提交文件大小。 */
  private assertSerializedSize(catalog: PersistedAudioGenerationCatalog): void {
    /** secure writer 使用相同的两空格 JSON 格式。 */
    const bytes = Buffer.byteLength(JSON.stringify(catalog, null, 2), 'utf8')
    if (bytes > AUDIO_GENERATION_CONFIG_MAX_BYTES) {
      throw new Error('AUDIO_GENERATION_CONFIG_SIZE_LIMIT')
    }
  }
}
