import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { isServerOpsId } from '@proma/shared'
import { getConfigDir } from '../config-paths'
import { readAtomicFileState, readJsonFileSafe, writeJsonFileAtomicSecure } from '../safe-file'
import type { AtomicDestinationExpectation, ReadJsonFileSafeOptions } from '../safe-file'
import {
  createServerOpsConfigTransaction,
  resolveServerOpsConfigFilePath,
} from './server-ops-config-transaction'
import type { ServerOpsConfigTransaction } from './server-ops-config-transaction'
import type { ServerOpsSafeStorage } from './server-ops-credential-store'

/** 数据源凭据相对业务配置根的目录名。 */
const SERVER_OPS_DIRECTORY = 'server-ops'
/** 数据源凭据文件名；与 SSH 凭据 `credentials.json` 刻意分开。 */
const SERVER_OPS_DATA_CREDENTIALS_FILENAME = 'data-source-credentials.json'
/** 当前数据源凭据文件 schema 版本。 */
const SERVER_OPS_DATA_CREDENTIALS_VERSION = 1

/** 单条持久化数据源凭据只保存 safeStorage 密文。 */
interface StoredDataSourceCredential {
  ref: string
  sourceId: string
  hostId: string
  ciphertext: string
  createdAt: number
  updatedAt: number
}

/** 数据源凭据文件的版本化根结构。 */
interface StoredDataSourceCredentialFile {
  version: typeof SERVER_OPS_DATA_CREDENTIALS_VERSION
  credentials: StoredDataSourceCredential[]
}

/** 数据源凭据 Store 的可替换系统依赖。 */
export interface ServerOpsDataSourceCredentialStoreDependencies {
  platform: NodeJS.Platform
  safeStorage: ServerOpsSafeStorage
  uuid: () => string
  now: () => number
  /** 使用 safe-file 候选恢复规则读取密文文件。 */
  readJson: <T>(filePath: string, options: ReadJsonFileSafeOptions<T>) => T | null
  /** 使用 safe-file 原子提交完整密文快照。 */
  writeJson: (
    filePath: string,
    data: object,
    expectedDestination: AtomicDestinationExpectation,
    priorBackup?: object,
  ) => void
  /** 覆盖 fresh-read 与原子提交的同步短事务。 */
  transaction?: ServerOpsConfigTransaction
}

/** 判断未知值是否为普通可枚举对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 判断未知值是否为有效的密文凭据文件。 */
function isStoredDataSourceCredentialFile(value: unknown): value is StoredDataSourceCredentialFile {
  if (!isRecord(value) || value.version !== SERVER_OPS_DATA_CREDENTIALS_VERSION || !Array.isArray(value.credentials)) return false
  if (Object.keys(value).some((key) => key !== 'version' && key !== 'credentials')) return false
  return value.credentials.every((item) => {
    if (!isRecord(item)) return false
    return typeof item.ref === 'string' && isServerOpsId(item.ref)
      && typeof item.sourceId === 'string' && isServerOpsId(item.sourceId)
      && typeof item.hostId === 'string' && isServerOpsId(item.hostId)
      && typeof item.ciphertext === 'string' && item.ciphertext.length > 0
      && typeof item.createdAt === 'number' && Number.isSafeInteger(item.createdAt)
      && typeof item.updatedAt === 'number' && Number.isSafeInteger(item.updatedAt)
      && Object.keys(item).every((key) => ['ref', 'sourceId', 'hostId', 'ciphertext', 'createdAt', 'updatedAt'].includes(key))
  })
}

/** 管理数据源密码密文；秘密只以 safeStorage 密文落盘。 */
export class ServerOpsDataSourceCredentialStore {
  /** 数据源凭据密文文件路径。 */
  private readonly filePath: string
  /** 可替换的平台、加密器、时间与 ID 边界。 */
  private readonly dependencies: ServerOpsDataSourceCredentialStoreDependencies
  /** 覆盖同目录协作写入的同步短事务。 */
  private readonly transaction: ServerOpsConfigTransaction
  /**
   * 调用方是否注入了真实 safeStorage。
   *
   * 未注入属于接线错误（Store 会退化成 fail-closed 占位实现），必须与"系统真的不支持加密"
   * 用不同错误码区分，否则表相是"保存密码永远失败"且无法定位。
   */
  private readonly safeStorageInjected: boolean

  /**
   * 创建数据源凭据 Store。
   *
   * @param configDir Proma 业务配置根
   * @param dependencies 测试可替换依赖
   */
  constructor(
    configDir = getConfigDir(),
    dependencies: Partial<ServerOpsDataSourceCredentialStoreDependencies> = {},
  ) {
    /** 与 SSH 凭据共用的运维目录。 */
    const directoryPath = join(configDir, SERVER_OPS_DIRECTORY)
    mkdirSync(directoryPath, { recursive: true })
    this.filePath = resolveServerOpsConfigFilePath(directoryPath, SERVER_OPS_DATA_CREDENTIALS_FILENAME)
    /** 未注入 Electron safeStorage 时使用的 fail-closed 边界。 */
    const unavailableSafeStorage: ServerOpsSafeStorage = {
      isEncryptionAvailable: () => false,
      getSelectedStorageBackend: () => 'unknown',
      encryptString: () => { throw new Error('SERVER_OPS_SECURE_STORAGE_UNAVAILABLE') },
      decryptString: () => { throw new Error('SERVER_OPS_SECURE_STORAGE_UNAVAILABLE') },
    }
    this.safeStorageInjected = dependencies.safeStorage !== undefined
    this.dependencies = {
      platform: process.platform,
      safeStorage: unavailableSafeStorage,
      uuid: randomUUID,
      now: Date.now,
      readJson: readJsonFileSafe,
      writeJson: (filePath, data, expectedDestination, priorBackup) => {
        writeJsonFileAtomicSecure(filePath, data, {
          expectedDestination,
          ...(priorBackup ? { priorBackup: { filePath: `${filePath}.bak`, data: priorBackup } } : {}),
        })
      },
      ...dependencies,
    }
    this.transaction = dependencies.transaction ?? createServerOpsConfigTransaction(directoryPath)
  }

  /**
   * 加密保存数据源密码并返回稳定引用。
   *
   * @param hostId 数据源所属主机
   * @param sourceId 目标数据源
   * @param secret 数据库密码明文，仅在本进程内存在
   * @returns 供数据源元数据引用的稳定 ref
   */
  setSecret(hostId: string, sourceId: string, secret: string): string {
    if (!isServerOpsId(hostId) || !isServerOpsId(sourceId)) throw new Error('SERVER_OPS_DATA_CREDENTIAL_ID_INVALID')
    if (secret.length < 1 || secret.length > 8_192 || secret.includes('\u0000')) throw new Error('SERVER_OPS_DATA_CREDENTIAL_INVALID')
    this.assertSecureStorage()
    /** safeStorage 产生的密文只以 base64 承载。 */
    const ciphertext = this.dependencies.safeStorage.encryptString(secret).toString('base64')
    return this.transaction(() => {
      /** 锁内权威快照，避免跨实例丢更新。 */
      const authoritative = this.readStoredCredentials()
      /** 当前数据源已有的持久化凭据。 */
      const existing = authoritative.credentials.find((item) => item.sourceId === sourceId)
      /** 复用原 ref 保证数据源元数据无需重写。 */
      const ref = existing?.ref ?? this.dependencies.uuid()
      if (!isServerOpsId(ref)) throw new Error('SERVER_OPS_DATA_CREDENTIAL_ID_INVALID')
      /** 当前写入时间。 */
      const now = this.dependencies.now()
      /** 待原子提交的记录。 */
      const nextRecord: StoredDataSourceCredential = {
        ref,
        sourceId,
        hostId,
        ciphertext,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      }
      /** 完整下一快照。 */
      const next = existing
        ? authoritative.credentials.map((item) => item.ref === existing.ref ? nextRecord : item)
        : [...authoritative.credentials, nextRecord]
      this.writeStoredCredentials(next, authoritative.expectedDestination, authoritative.priorBackup)
      return ref
    })
  }

  /**
   * 解密读取数据源密码。
   *
   * @param ref 数据源元数据中的凭据引用
   * @returns 明文密码；引用不存在时返回 undefined
   */
  resolveSecret(ref: string): string | undefined {
    if (!isServerOpsId(ref)) return undefined
    /** 精确匹配 ref 的密文记录。 */
    const stored = this.readStoredCredentials().credentials.find((item) => item.ref === ref)
    if (!stored) return undefined
    this.assertSecureStorage()
    try {
      /** 解密后的密码明文，仅在本进程内使用。 */
      const secret = this.dependencies.safeStorage.decryptString(Buffer.from(stored.ciphertext, 'base64'))
      if (secret.length < 1) throw new Error('empty')
      return secret
    } catch {
      throw new Error('SERVER_OPS_DATA_CREDENTIAL_CORRUPTED')
    }
  }

  /**
   * 判断指定引用是否已有密文。
   *
   * @param ref 数据源元数据中的凭据引用
   * @returns 是否存在对应密文
   */
  hasSecret(ref: string): boolean {
    if (!isServerOpsId(ref)) return false
    return this.readStoredCredentials().credentials.some((item) => item.ref === ref)
  }

  /**
   * 删除指定数据源的密文。
   *
   * @param sourceId 目标数据源
   * @returns 是否实际删除
   */
  removeSecret(sourceId: string): boolean {
    if (!isServerOpsId(sourceId)) throw new Error('SERVER_OPS_DATA_CREDENTIAL_ID_INVALID')
    return this.transaction(() => {
      /** 锁内权威快照。 */
      const authoritative = this.readStoredCredentials()
      /** 待保留的其它凭据。 */
      const remaining = authoritative.credentials.filter((item) => item.sourceId !== sourceId)
      if (remaining.length === authoritative.credentials.length) return false
      this.writeStoredCredentials(remaining, authoritative.expectedDestination, authoritative.priorBackup)
      return true
    })
  }

  /**
   * 删除指定主机的全部数据源密文。
   *
   * @param hostId 目标主机
   * @returns 实际删除条数
   */
  removeByHost(hostId: string): number {
    if (!isServerOpsId(hostId)) throw new Error('SERVER_OPS_DATA_CREDENTIAL_ID_INVALID')
    return this.transaction(() => {
      /** 锁内权威快照。 */
      const authoritative = this.readStoredCredentials()
      /** 待保留的其它主机凭据。 */
      const remaining = authoritative.credentials.filter((item) => item.hostId !== hostId)
      /** 实际删除条数。 */
      const removed = authoritative.credentials.length - remaining.length
      if (removed === 0) return 0
      this.writeStoredCredentials(remaining, authoritative.expectedDestination, authoritative.priorBackup)
      return removed
    })
  }

  /** Linux 明文 backend 和不可用状态一律拒绝落盘或解密。 */
  private assertSecureStorage(): void {
    if (!this.dependencies.safeStorage.isEncryptionAvailable()) {
      throw new Error(this.safeStorageInjected ? 'SERVER_OPS_SECURE_STORAGE_UNAVAILABLE' : 'SERVER_OPS_SAFE_STORAGE_NOT_INJECTED')
    }
    if (this.dependencies.platform === 'linux' && this.dependencies.safeStorage.getSelectedStorageBackend() === 'basic_text') {
      throw new Error('SERVER_OPS_SECURE_STORAGE_UNAVAILABLE')
    }
  }

  /** 每次从权威文件读取密文；已有坏文件不得降级为空后被覆盖。 */
  private readStoredCredentials(): {
    credentials: StoredDataSourceCredential[]
    expectedDestination: AtomicDestinationExpectation
    priorBackup?: object
  } {
    /** 读取前目标文件是否已存在。 */
    const existed = existsSync(this.filePath)
    const loaded = this.dependencies.readJson(this.filePath, { validate: isStoredDataSourceCredentialFile })
    /** 提交时必须匹配的目标身份。 */
    const expectedDestination = this.captureDestinationExpectation()
    if (loaded === null) {
      if (existed) throw new Error('SERVER_OPS_DATA_CREDENTIAL_READ_FAILED')
      return { credentials: [], expectedDestination }
    }
    return {
      credentials: loaded.credentials.map((item) => ({ ...item })),
      expectedDestination,
      priorBackup: loaded.credentials.map((item) => ({ ...item })),
    }
  }

  /** 原子提交完整密文快照。 */
  private writeStoredCredentials(
    credentials: readonly StoredDataSourceCredential[],
    expectedDestination: AtomicDestinationExpectation,
    priorBackup?: object,
  ): void {
    this.dependencies.writeJson(
      this.filePath,
      {
        version: SERVER_OPS_DATA_CREDENTIALS_VERSION,
        credentials: credentials.map((item) => ({ ...item })),
      } satisfies StoredDataSourceCredentialFile,
      expectedDestination,
      priorBackup,
    )
  }

  /** 捕获 fresh-read 对应的目标身份。 */
  private captureDestinationExpectation(): AtomicDestinationExpectation {
    const state = readAtomicFileState(this.filePath)
    return state === null ? { kind: 'missing' } : { kind: 'state', state }
  }
}
