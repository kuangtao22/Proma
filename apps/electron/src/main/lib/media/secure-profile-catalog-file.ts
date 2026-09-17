/**
 * 独立供应商目录文件的安全读写层。
 *
 * 只负责与安全相关的文件机制：fd 稳定读取（O_NOFOLLOW + 读取前后状态比对）、
 * 目录级期望状态 CAS、O_EXCL 跨进程锁、原子写与结果未知映射、固定 schema 版本。
 * 各供应商目录（音频、生图……）注入自己的条目解析与迁移规则，避免复制这套代码。
 */
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs'
import type { Stats } from 'node:fs'
import type { AtomicDestinationExpectation, AtomicFileState } from '../safe-file'
import {
  AtomicDestinationConflictError,
  AtomicWritePostCommitError,
  readAtomicFileState,
  writeJsonFileAtomicSecure,
} from '../safe-file'
import { acquireMediaFileLock } from './media-file-lock'

/** 注入的错误码前缀，保证每个目录对外仍暴露自己的稳定错误码。 */
export interface SecureProfileCatalogErrorCodes {
  configInvalid: string
  configConflict: string
  configSizeLimit: string
  configWriteFailed: string
  configOutcomeUnknown: string
}

/** 目录级安全读写选项。 */
export interface SecureProfileCatalogFileOptions<TEntry> {
  /** 配置文件完整路径。 */
  configPath: string
  /** 允许占用的最大 JSON 字节数。 */
  maxBytes: number
  /** 当前 schema 版本，写回一律使用它。 */
  schemaVersion: number
  /** 仍需兼容读取的旧版本；命中时交给 parseEntry 迁移。 */
  legacySchemaVersions?: readonly number[]
  /** 错误码前缀。 */
  errorCodes: SecureProfileCatalogErrorCodes
  /** 解析单条条目；schemaVersion 为旧版本时由实现自行迁移形状。 */
  parseEntry: (value: unknown, schemaVersion: number) => TEntry
  /** 读取完成后的窄竞态测试钩子。 */
  beforeReadFinish?: () => void
  /** 安全原子提交前的窄竞态测试钩子。 */
  beforeCommit?: () => void
  /** 生产默认直接使用 safe-file 的安全原子 writer。 */
  writeConfig?: typeof writeJsonFileAtomicSecure
}

/** 严格读取结果：内容与提交 CAS 所需的文件状态。 */
export interface SecureProfileCatalogRead<TEntry> {
  /** 当前 schema 版本下的条目顺序。 */
  entries: TEntry[]
  /** 目录 revision。 */
  revision: number
  /** 本次提交必须匹配的期望目标状态。 */
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

/** 判断值是可安全递增的非负 revision。 */
export function isCatalogRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** 判断文件系统错误是否只表示目标尚未创建。 */
function isMissingFileError(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

/** 从已打开文件描述符状态投影安全原子写使用的完整状态。 */
function toAtomicFileState(stats: Stats): AtomicFileState {
  return {
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
  }
}

/** 比较读取前后或路径当前状态是否仍是同一份完整文件。 */
function isSameAtomicFileState(left: AtomicFileState, right: AtomicFileState): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
}

/** 当前平台可取得 UID 时要求配置文件属于当前用户。 */
function isOwnedByCurrentUser(uid: number): boolean {
  return typeof process.getuid !== 'function' || uid === process.getuid()
}

/** 进程内可复用的安全目录文件。 */
export class SecureProfileCatalogFile<TEntry> {
  /** 配置文件完整路径。 */
  private readonly configPath: string
  /** 允许占用的最大字节数。 */
  private readonly maxBytes: number
  /** 当前 schema 版本。 */
  private readonly schemaVersion: number
  /** 仍需兼容读取的旧版本。 */
  private readonly legacySchemaVersions: readonly number[]
  /** 对外错误码。 */
  private readonly errorCodes: SecureProfileCatalogErrorCodes
  /** 单条条目解析与迁移。 */
  private readonly parseEntry: (value: unknown, schemaVersion: number) => TEntry
  /** 读取完成后的窄竞态测试钩子。 */
  private readonly beforeReadFinish?: () => void
  /** 安全原子提交前的窄竞态测试钩子。 */
  private readonly beforeCommit?: () => void
  /** 安全原子 writer。 */
  private readonly writeConfig: typeof writeJsonFileAtomicSecure

  constructor(options: SecureProfileCatalogFileOptions<TEntry>) {
    this.configPath = options.configPath
    this.maxBytes = options.maxBytes
    this.schemaVersion = options.schemaVersion
    this.legacySchemaVersions = options.legacySchemaVersions ?? []
    this.errorCodes = options.errorCodes
    this.parseEntry = options.parseEntry
    this.beforeReadFinish = options.beforeReadFinish
    this.beforeCommit = options.beforeCommit
    this.writeConfig = options.writeConfig ?? writeJsonFileAtomicSecure
  }

  /** 在跨进程媒体文件锁内执行一次同步目录更新，并保证释放锁。 */
  withLock<T>(operation: () => T): T {
    /** 锁文件与配置文件相邻，所有实例使用同一竞争点。 */
    const release = acquireMediaFileLock(`${this.configPath}.lock`)
    try {
      return operation()
    } finally {
      release()
    }
  }

  /** 严格读取主文件；存在但损坏时不回退空目录或自动覆盖。 */
  read(): SecureProfileCatalogRead<TEntry> {
    /** 打开的描述符在 finally 中唯一关闭。 */
    let descriptor: number | null = null
    try {
      /** O_NOFOLLOW 让读取直接绑定普通文件，不经由路径符号链接。 */
      descriptor = openSync(this.configPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      /** 读取前绑定文件描述符指向的完整状态。 */
      const beforeStats = fstatSync(descriptor)
      if (!beforeStats.isFile() || !isOwnedByCurrentUser(beforeStats.uid)) {
        throw new Error(this.errorCodes.configInvalid)
      }
      if (beforeStats.size > this.maxBytes) {
        throw new Error(this.errorCodes.configSizeLimit)
      }
      /** 初始大小最多 maxBytes，因此实际读取不会超过目录资源上限。 */
      const bytes = Buffer.alloc(beforeStats.size)
      /** 已从同一描述符读取的字节数。 */
      let offset = 0
      while (offset < bytes.length) {
        /** 使用显式位置读取，避免共享文件偏移影响结果。 */
        const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset)
        if (count === 0) break
        offset += count
      }
      this.beforeReadFinish?.()
      /** 读取后再次核对同一描述符，阻止原地截断或改写。 */
      const afterState = toAtomicFileState(fstatSync(descriptor))
      /** 读取前用于解析和后续提交 CAS 的固定状态。 */
      const beforeState = toAtomicFileState(beforeStats)
      if (offset !== bytes.length || !isSameAtomicFileState(beforeState, afterState)) {
        throw new Error(this.errorCodes.configConflict)
      }
      /** 复验路径仍指向刚读取的文件，阻止 rename 置换后返回旧快照。 */
      const currentPathState = readAtomicFileState(this.configPath)
      if (currentPathState === null || !isSameAtomicFileState(beforeState, currentPathState)) {
        throw new Error(this.errorCodes.configConflict)
      }
      /** 状态全部稳定后才解析固定长度的 UTF-8 JSON。 */
      const parsed = this.parseCatalog(JSON.parse(bytes.toString('utf8')) as unknown)
      return {
        entries: parsed.entries,
        revision: parsed.revision,
        expectedDestination: { kind: 'state', state: beforeState },
      }
    } catch (error) {
      if (isMissingFileError(error) && descriptor === null) {
        return { entries: [], revision: 0, expectedDestination: { kind: 'missing' } }
      }
      if (isMissingFileError(error)) throw new Error(this.errorCodes.configConflict)
      if (error instanceof Error
        && (error.message === this.errorCodes.configSizeLimit || error.message === this.errorCodes.configConflict)) {
        throw error
      }
      throw new Error(this.errorCodes.configInvalid)
    } finally {
      if (descriptor !== null) {
        try { closeSync(descriptor) } catch { /* 对外只保留稳定业务错误。 */ }
      }
    }
  }

  /** 以期望状态为基线原子提交完整目录，失败不发布部分结果。 */
  commit(input: {
    revision: number
    entries: TEntry[]
    expectedDestination: AtomicDestinationExpectation
  }): void {
    const next = { schemaVersion: this.schemaVersion, revision: input.revision, profiles: input.entries }
    this.assertSerializedSize(next)
    this.beforeCommit?.()
    try {
      this.writeConfig(this.configPath, next, { expectedDestination: input.expectedDestination })
    } catch (error) {
      if (error instanceof AtomicDestinationConflictError) throw new Error(this.errorCodes.configConflict)
      if (error instanceof AtomicWritePostCommitError) throw new Error(this.errorCodes.configOutcomeUnknown)
      if (!this.matchesExpectedDestination(input.expectedDestination)) {
        throw new Error(this.errorCodes.configConflict)
      }
      throw new Error(this.errorCodes.configWriteFailed)
    }
  }

  /** 解析磁盘目录，只接受当前版本与声明的旧版本。 */
  private parseCatalog(value: unknown): { entries: TEntry[]; revision: number } {
    if (!isRecord(value)
      || !hasOnlyKeys(value, ['schemaVersion', 'revision', 'profiles'])
      || typeof value.schemaVersion !== 'number'
      || (value.schemaVersion !== this.schemaVersion && !this.legacySchemaVersions.includes(value.schemaVersion))
      || !isCatalogRevision(value.revision)
      || !Array.isArray(value.profiles)) {
      throw new Error(this.errorCodes.configInvalid)
    }
    const schemaVersion = value.schemaVersion
    return { entries: value.profiles.map((item) => this.parseEntry(item, schemaVersion)), revision: value.revision }
  }

  /** 按实际 pretty JSON 编码检查待提交文件大小。 */
  private assertSerializedSize(catalog: unknown): void {
    /** secure writer 使用相同的两空格 JSON 格式。 */
    const bytes = Buffer.byteLength(JSON.stringify(catalog, null, 2), 'utf8')
    if (bytes > this.maxBytes) throw new Error(this.errorCodes.configSizeLimit)
  }

  /** 判断失败后的目标是否仍匹配读取期状态，用于识别未类型化的路径置换。 */
  private matchesExpectedDestination(expected: AtomicDestinationExpectation): boolean {
    try {
      /** 当前路径状态由 safe-file 的同一安全读取边界提供。 */
      const current = readAtomicFileState(this.configPath)
      if (expected.kind === 'missing') return current === null
      return current !== null && isSameAtomicFileState(expected.state, current)
    } catch {
      return false
    }
  }
}
