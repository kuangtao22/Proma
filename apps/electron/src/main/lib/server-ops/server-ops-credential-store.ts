import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { getConfigDir } from '../config-paths'
import { readJsonFileSafe, writeJsonFileAtomic } from '../safe-file'

/** 主进程内部可解析的 SSH 凭据；禁止返回 Renderer。 */
export type ServerOpsResolvedCredential =
  | { kind: 'password'; password: string }
  | { kind: 'private-key'; keyPath: string; passphrase?: string }

/** Electron safeStorage 的最小加解密边界。 */
export interface ServerOpsSafeStorage {
  isEncryptionAvailable: () => boolean
  getSelectedStorageBackend: () => 'basic_text' | 'gnome_libsecret' | 'kwallet' | 'kwallet5' | 'kwallet6' | 'unknown'
  encryptString: (value: string) => Buffer
  decryptString: (value: Buffer) => string
}

/** 单条持久化凭据只保存 safeStorage 密文。 */
interface StoredCredential {
  ref: string
  hostId: string
  ciphertext: string
  createdAt: number
  updatedAt: number
}

/** 凭据文件的版本化根结构。 */
interface StoredCredentialFile {
  version: 1
  credentials: StoredCredential[]
}

/** 凭据 Store 的可替换系统依赖。 */
export interface ServerOpsCredentialStoreDependencies {
  platform: NodeJS.Platform
  safeStorage: ServerOpsSafeStorage
  uuid: () => string
  now: () => number
}

/** 判断未知值是否为有效的密文凭据文件。 */
function isStoredCredentialFile(value: unknown): value is StoredCredentialFile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  /** 待校验的版本化根对象。 */
  const root = value as Record<string, unknown>
  if (root.version !== 1 || !Array.isArray(root.credentials)) return false
  return root.credentials.every((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false
    /** 待校验的单条密文记录。 */
    const record = item as Record<string, unknown>
    return typeof record.ref === 'string'
      && typeof record.hostId === 'string'
      && typeof record.ciphertext === 'string'
      && typeof record.createdAt === 'number'
      && typeof record.updatedAt === 'number'
      && Object.keys(record).every((key) => ['ref', 'hostId', 'ciphertext', 'createdAt', 'updatedAt'].includes(key))
  })
}

/** 严格校验从 safeStorage 解密出的内部凭据。 */
function parseResolvedCredential(value: unknown): ServerOpsResolvedCredential {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('SERVER_OPS_CREDENTIAL_CORRUPTED')
  /** 待解析的凭据对象。 */
  const record = value as Record<string, unknown>
  if (record.kind === 'password'
    && typeof record.password === 'string'
    && record.password.length > 0
    && Object.keys(record).every((key) => ['kind', 'password'].includes(key))) {
    return { kind: 'password', password: record.password }
  }
  if (record.kind === 'private-key'
    && typeof record.keyPath === 'string'
    && record.keyPath.length > 0
    && (record.passphrase === undefined || typeof record.passphrase === 'string')
    && Object.keys(record).every((key) => ['kind', 'keyPath', 'passphrase'].includes(key))) {
    return { kind: 'private-key', keyPath: record.keyPath, ...(typeof record.passphrase === 'string' ? { passphrase: record.passphrase } : {}) }
  }
  throw new Error('SERVER_OPS_CREDENTIAL_CORRUPTED')
}

/** 管理内存凭据与 `safeStorage` 密文，不向公开 DTO 暴露秘密。 */
export class ServerOpsCredentialStore {
  /** 凭据密文文件的固定路径。 */
  private readonly filePath: string
  /** 可替换的平台、加密器、时间和 ID 边界。 */
  private readonly dependencies: ServerOpsCredentialStoreDependencies
  /** 当前已持久化凭据的内存索引。 */
  private stored: StoredCredential[]
  /** 本次应用生命周期内按主机保存的短期凭据。 */
  private readonly volatileByHost = new Map<string, ServerOpsResolvedCredential>()

  constructor(configDir = getConfigDir(), dependencies: Partial<ServerOpsCredentialStoreDependencies> = {}) {
    /** 运维模块固定数据目录。 */
    const directoryPath = join(configDir, 'server-ops')
    mkdirSync(directoryPath, { recursive: true })
    this.filePath = join(directoryPath, 'credentials.json')
    /** 未注入 Electron safeStorage 时使用的 fail-closed 边界。 */
    const unavailableSafeStorage: ServerOpsSafeStorage = {
      isEncryptionAvailable: () => false,
      getSelectedStorageBackend: () => 'unknown',
      encryptString: () => { throw new Error('SERVER_OPS_SECURE_STORAGE_UNAVAILABLE') },
      decryptString: () => { throw new Error('SERVER_OPS_SECURE_STORAGE_UNAVAILABLE') },
    }
    this.dependencies = { platform: process.platform, safeStorage: unavailableSafeStorage, uuid: randomUUID, now: Date.now, ...dependencies }
    this.stored = readJsonFileSafe(this.filePath, { validate: isStoredCredentialFile })?.credentials ?? []
  }

  /** 设置只在本次主进程生命周期内存在的凭据。 */
  setVolatile(hostId: string, credential: ServerOpsResolvedCredential): void {
    this.volatileByHost.set(hostId, { ...credential })
  }

  /** 将凭据保存为 safeStorage 密文并返回非敏感引用。 */
  remember(hostId: string, credential: ServerOpsResolvedCredential): string {
    this.assertSecureStorage()
    /** 当前主机已有的持久化凭据。 */
    const existing = this.stored.find((item) => item.hostId === hostId)
    /** 写入后供主机资产引用的稳定 ID。 */
    const ref = existing?.ref ?? this.dependencies.uuid()
    /** 当前写入的时间戳。 */
    const now = this.dependencies.now()
    /** safeStorage 产生且仅以 base64 编码承载的密文。 */
    const ciphertext = this.dependencies.safeStorage.encryptString(JSON.stringify(credential)).toString('base64')
    /** 待原子提交的新记录。 */
    const nextRecord: StoredCredential = { ref, hostId, ciphertext, createdAt: existing?.createdAt ?? now, updatedAt: now }
    /** 完整下一凭据快照。 */
    const next = existing ? this.stored.map((item) => item.ref === existing.ref ? nextRecord : item) : [...this.stored, nextRecord]
    writeJsonFileAtomic(this.filePath, { version: 1, credentials: next })
    this.stored = next
    this.setVolatile(hostId, credential)
    return ref
  }

  /** 优先读取短期凭据，否则按主机绑定的密文引用解密。 */
  resolve(hostId: string, credentialRef?: string): ServerOpsResolvedCredential | undefined {
    /** 本次生命周期内最近提交的短期凭据。 */
    const volatile = this.volatileByHost.get(hostId)
    if (volatile) return { ...volatile }
    if (!credentialRef) return undefined
    /** 必须同时匹配 hostId 和 ref，禁止跨主机复用引用。 */
    const stored = this.stored.find((item) => item.hostId === hostId && item.ref === credentialRef)
    if (!stored) return undefined
    this.assertSecureStorage()
    try {
      /** safeStorage 解密后的短生命周期 JSON 文本。 */
      const plaintext = this.dependencies.safeStorage.decryptString(Buffer.from(stored.ciphertext, 'base64'))
      return parseResolvedCredential(JSON.parse(plaintext) as unknown)
    } catch {
      throw new Error('SERVER_OPS_CREDENTIAL_DECRYPT_FAILED')
    }
  }

  /** 返回主机已持久化凭据的公开引用。 */
  getCredentialRef(hostId: string): string | undefined {
    return this.stored.find((item) => item.hostId === hostId)?.ref
  }

  /** 删除主机的内存与持久化凭据。 */
  forgetHost(hostId: string): void {
    this.volatileByHost.delete(hostId)
    /** 删除目标主机后的密文快照。 */
    const next = this.stored.filter((item) => item.hostId !== hostId)
    if (next.length === this.stored.length) return
    writeJsonFileAtomic(this.filePath, { version: 1, credentials: next })
    this.stored = next
  }

  /** 清除所有短期明文引用。 */
  clearVolatile(): void {
    this.volatileByHost.clear()
  }

  /** Linux 明文 backend 和不可用状态一律拒绝落盘或解密。 */
  private assertSecureStorage(): void {
    if (!this.dependencies.safeStorage.isEncryptionAvailable()) throw new Error('SERVER_OPS_SECURE_STORAGE_UNAVAILABLE')
    if (this.dependencies.platform === 'linux' && this.dependencies.safeStorage.getSelectedStorageBackend() === 'basic_text') {
      throw new Error('SERVER_OPS_SECURE_STORAGE_UNAVAILABLE')
    }
  }
}
