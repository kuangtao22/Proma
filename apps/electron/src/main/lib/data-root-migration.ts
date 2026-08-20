import { randomUUID } from 'node:crypto'
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { lstat, opendir, statfs } from 'node:fs/promises'
import type {
  DataRootMigrationProgress,
  DataRootMigrationRecord,
  DataRootMigrationStage,
  PathManagementState,
} from '@proma/shared'
import { DataRootLocator } from './data-root-locator'
import type { CopyDirectoryInput, CopyDirectoryResult } from './verified-directory-copier'
import { copyDirectoryVerified, finalizeDirectoryCopy } from './verified-directory-copier'
import type { RebaseDataRootOwnedPathsInput, RebaseDataRootOwnedPathsResult } from './owned-path-rebaser'
import { rebaseDataRootOwnedPaths } from './owned-path-rebaser'

/** 用户可处理的迁移错误分类。 */
export type DataRootMigrationErrorCode =
  | 'INVALID_SOURCE'
  | 'UNSAFE_TARGET'
  | 'TARGET_NOT_WRITABLE'
  | 'TARGET_NOT_EMPTY'
  | 'INSUFFICIENT_SPACE'
  | 'MIGRATION_LOCKED'
  | 'MIGRATION_BUSY'
  | 'COPY_FAILED'
  | 'REBASE_FAILED'
  | 'LOCATOR_WRITE_FAILED'

/** 对外仅暴露稳定摘要，底层异常保留在 cause。 */
export class DataRootMigrationError extends Error {
  /** 稳定错误分类。 */
  readonly code: DataRootMigrationErrorCode

  constructor(code: DataRootMigrationErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'DataRootMigrationError'
    this.code = code
  }
}

/** 协调器所有可替换依赖，便于跨平台验证容量、PID 与时间。 */
export interface DataRootMigrationCoordinatorOptions {
  locator: DataRootLocator
  lockPath?: string
  createMigrationId?: () => string
  now?: () => number
  getAvailableBytes?: (existingTargetAncestor: string) => Promise<number>
  isPidRunning?: (pid: number) => boolean
  copyDirectory?: (input: CopyDirectoryInput) => Promise<CopyDirectoryResult>
  rebaseOwnedPaths?: (input: RebaseDataRootOwnedPathsInput) => RebaseDataRootOwnedPathsResult
  finalizeCopy?: (input: { migrationId: string; targetRoot: string }) => Promise<void>
  progressPersistIntervalMs?: number
}

/** 实例锁文件的最小持久化结构。 */
interface MigrationLockRecord {
  version: 1
  pid: number
  createdAt: number
}

/** 预检得到且不创建目标目录的稳定信息。 */
interface MigrationPreflight {
  sourceRoot: string
  targetRoot: string
  totalBytes: number
}

/** 数据根迁移协调器：先复制与重写，最后原子切换 locator。 */
export class DataRootMigrationCoordinator {
  /** 固定 locator 是所有迁移 JSON 的唯一写入口。 */
  private readonly locator: DataRootLocator
  /** 数据根之外的进程互斥锁。 */
  private readonly lockPath: string
  /** 生成不参与路径拼接的唯一迁移 ID。 */
  private readonly createMigrationId: () => string
  /** 可注入时钟。 */
  private readonly now: () => number
  /** 可注入目标可用容量读取器。 */
  private readonly getAvailableBytes: (existingTargetAncestor: string) => Promise<number>
  /** 可注入 PID 存活检查。 */
  private readonly isPidRunning: (pid: number) => boolean
  /** Task3 可恢复复制公开入口。 */
  private readonly copyDirectory: (input: CopyDirectoryInput) => Promise<CopyDirectoryResult>
  /** Task4 owned path 重写公开入口。 */
  private readonly rebaseOwnedPaths: (input: RebaseDataRootOwnedPathsInput) => RebaseDataRootOwnedPathsResult
  /** commit 后幂等清理 Task3 sidecar。 */
  private readonly finalizeCopy: (input: { migrationId: string; targetRoot: string }) => Promise<void>
  /** 高频进度允许落盘的最短时间间隔。 */
  private readonly progressPersistIntervalMs: number
  /** 当前进程是否持有锁文件。 */
  private ownsLock = false
  /** 当前执行中的唯一迁移 Promise。 */
  private activeRun: Promise<void> | null = null
  /** copying 阶段使用的取消控制器。 */
  private abortController: AbortController | null = null
  /** 取消请求用于区分用户取消与复制故障。 */
  private cancellationRequested = false

  constructor(options: DataRootMigrationCoordinatorOptions) {
    this.locator = options.locator
    this.lockPath = options.lockPath ?? resolve(dirname(options.locator.getLocatorPath()), '.proma-data-root-migration.lock')
    this.createMigrationId = options.createMigrationId ?? randomUUID
    this.now = options.now ?? Date.now
    this.getAvailableBytes = options.getAvailableBytes ?? getStatfsAvailableBytes
    this.isPidRunning = options.isPidRunning ?? isProcessRunning
    this.copyDirectory = options.copyDirectory ?? copyDirectoryVerified
    this.rebaseOwnedPaths = options.rebaseOwnedPaths ?? rebaseDataRootOwnedPaths
    this.finalizeCopy = options.finalizeCopy ?? finalizeDirectoryCopy
    this.progressPersistIntervalMs = options.progressPersistIntervalMs ?? 250
    if (!isAbsolute(this.lockPath)) throw new Error('迁移锁路径必须是绝对路径')
    if (!Number.isFinite(this.progressPersistIntervalMs) || this.progressPersistIntervalMs < 0) {
      throw new Error('进度持久化间隔必须是非负有限数')
    }
  }

  /** 无副作用返回 locator 当前状态。 */
  getStatus(): PathManagementState {
    return this.locator.inspect().state
  }

  /**
   * 完成全部只读预检后创建 pending 计划；失败会释放临时实例锁。
   *
   * @param targetRoot 用户选择的绝对目标目录。
   * @returns 已持久化的 pending 进度。
   */
  async createPlan(targetRoot: string): Promise<DataRootMigrationProgress> {
    if (this.activeRun !== null) throw new DataRootMigrationError('MIGRATION_BUSY', '数据根迁移正在运行')
    this.acquireLock()
    try {
      const preflight = await this.preflight(targetRoot)
      const timestamp = this.now()
      const migration: DataRootMigrationRecord = {
        id: this.createMigrationId(),
        sourceRoot: preflight.sourceRoot,
        targetRoot: preflight.targetRoot,
        stage: 'pending',
        completedBytes: 0,
        totalBytes: preflight.totalBytes,
        startedAt: timestamp,
        updatedAt: timestamp,
      }
      this.locator.beginMigration(migration)
      return toProgress(migration)
    } catch (error) {
      this.releaseLock()
      throw error
    }
  }

  /** 运行 locator 中的 pending/failed/switching 迁移。 */
  async runPending(onProgress: (progress: DataRootMigrationProgress) => void = () => {}): Promise<void> {
    if (this.activeRun !== null) throw new DataRootMigrationError('MIGRATION_BUSY', '数据根迁移正在运行')
    const execution = this.executePending(onProgress)
    this.activeRun = execution
    try {
      await execution
    } finally {
      this.activeRun = null
    }
  }

  /** 与 runPending 同义，强调由持久化断点恢复。 */
  async resumePending(onProgress: (progress: DataRootMigrationProgress) => void = () => {}): Promise<void> {
    return this.runPending(onProgress)
  }

  /** pending/failed 立即取消，copying 先中止再由运行循环清除 locator。 */
  async cancel(): Promise<void> {
    const migration = this.locator.inspect().locatorFile?.migration
    if (!migration) throw new Error('当前没有可取消的数据根迁移')
    if (!['pending', 'failed', 'copying'].includes(migration.stage)) throw new Error('切换阶段不能取消')
    if (this.activeRun !== null) {
      this.cancellationRequested = true
      this.abortController?.abort()
      try {
        await this.activeRun
      } catch (error) {
        if (!isAbortError(error)) throw error
      }
      return
    }
    this.locator.cancelMigration(migration.id)
    this.releaseLock()
  }

  /** 串行执行恢复、复制、重写、切换和 post-commit cleanup。 */
  private async executePending(onProgress: (progress: DataRootMigrationProgress) => void): Promise<void> {
    this.acquireLock()
    try {
      await this.cleanupCommittedMigration()
      let migration = this.locator.inspect().locatorFile?.migration
      if (!migration) return
      if (migration.stage === 'switching') {
        this.locator.commitMigration(migration.id)
        await this.cleanupCommittedMigration()
        return
      }

      if (migration.stage === 'pending' || migration.stage === 'failed' || migration.stage === 'copying') {
        this.cancellationRequested = false
        this.abortController = new AbortController()
        migration = this.transition(migration, 'copying', onProgress)
        let lastPersistedAt = this.now()
        let persistedBytes = migration.completedBytes
        let observedBytes = migration.completedBytes
        try {
          const result = await this.copyDirectory({
            migrationId: migration.id,
            sourceRoot: migration.sourceRoot,
            targetRoot: migration.targetRoot,
            signal: this.abortController.signal,
            onProgress: (progress) => {
              observedBytes = Math.max(observedBytes, Math.min(migration!.totalBytes, progress.completedBytes))
              onProgress({ ...progress, completedBytes: observedBytes, totalBytes: migration!.totalBytes })
              const currentTime = this.now()
              if (observedBytes > persistedBytes && currentTime - lastPersistedAt >= this.progressPersistIntervalMs) {
                this.locator.updateMigration(migration!.id, { completedBytes: observedBytes, updatedAt: currentTime })
                persistedBytes = observedBytes
                lastPersistedAt = currentTime
              }
            },
          })
          if (this.cancellationRequested) throw createAbortError()
          if (result.totalBytes !== migration.totalBytes) throw new Error('源目录容量在计划创建后发生变化')
          migration = this.locator.inspect().locatorFile?.migration ?? migration
          if (migration.completedBytes < migration.totalBytes) {
            this.locator.updateMigration(migration.id, {
              completedBytes: migration.totalBytes,
              updatedAt: Math.max(this.now(), migration.updatedAt),
            })
            migration = this.locator.inspect().locatorFile?.migration ?? migration
          }
        } catch (error) {
          if (this.cancellationRequested || isAbortError(error)) {
            this.locator.cancelMigration(migration.id)
            throw error
          }
          const current = this.locator.inspect().locatorFile?.migration
          if (current && observedBytes > current.completedBytes) {
            try {
              this.locator.updateMigration(current.id, {
                completedBytes: observedBytes,
                updatedAt: Math.max(this.now(), current.updatedAt),
              })
            } catch (locatorError) {
              throw this.persistFailure(current.id, '保存迁移进度失败', 'LOCATOR_WRITE_FAILED', locatorError)
            }
          }
          throw this.persistFailure(migration.id, '复制数据失败', 'COPY_FAILED', error)
        } finally {
          this.abortController = null
        }
        migration = this.transition(migration, 'verifying', onProgress)
      }

      if (migration.stage === 'verifying') migration = this.transition(migration, 'rebasing', onProgress)
      try {
        this.rebaseOwnedPaths({ sourceRoot: migration.sourceRoot, targetRoot: migration.targetRoot })
      } catch (error) {
        throw this.persistFailure(migration.id, '更新 Proma-owned 路径失败', 'REBASE_FAILED', error)
      }
      migration = this.transition(migration, 'switching', onProgress)
      try {
        this.locator.commitMigration(migration.id)
      } catch (error) {
        throw new DataRootMigrationError('LOCATOR_WRITE_FAILED', '切换数据根失败', error)
      }
      await this.cleanupCommittedMigration()
    } finally {
      this.abortController = null
      this.cancellationRequested = false
      this.releaseLock()
    }
  }

  /** 阶段边界立即落盘并发送事件。 */
  private transition(
    migration: DataRootMigrationRecord,
    stage: DataRootMigrationStage,
    onProgress: (progress: DataRootMigrationProgress) => void,
  ): DataRootMigrationRecord {
    try {
      const result = this.locator.updateMigration(migration.id, {
        stage,
        updatedAt: Math.max(this.now(), migration.updatedAt),
      })
      const updated = result.locatorFile?.migration
      if (!updated) throw new Error('迁移阶段写入后记录缺失')
      onProgress(toProgress(updated))
      return updated
    } catch (error) {
      throw this.persistFailure(migration.id, '保存迁移阶段失败', 'LOCATOR_WRITE_FAILED', error)
    }
  }

  /** failure 边界立即保存用户可读摘要，同时保留原始 cause。 */
  private persistFailure(
    migrationId: string,
    message: string,
    code: DataRootMigrationErrorCode,
    cause: unknown,
  ): DataRootMigrationError {
    try {
      const current = this.locator.inspect().locatorFile?.migration
      if (current && current.stage !== 'switching') {
        this.locator.updateMigration(migrationId, {
          stage: 'failed',
          completedBytes: current.completedBytes,
          updatedAt: Math.max(this.now(), current.updatedAt),
          error: message,
        })
      }
    } catch (locatorError) {
      return new DataRootMigrationError('LOCATOR_WRITE_FAILED', '保存迁移失败状态失败', locatorError)
    }
    return new DataRootMigrationError(code, message, cause)
  }

  /** commit 已成功时清理 sidecar；清理失败只保留意图，不回滚或标记失败。 */
  private async cleanupCommittedMigration(): Promise<void> {
    const cleanup = this.locator.inspect().locatorFile?.postCommitCleanup
    if (!cleanup) return
    try {
      await this.finalizeCopy({ migrationId: cleanup.migrationId, targetRoot: cleanup.targetRoot })
      this.locator.clearPostCommitCleanup(cleanup.migrationId)
    } catch {
      // 活动根已经提交；保留 cleanup record 供下次启动幂等重试。
    }
  }

  /** 只读验证源、目标物理关系、写权限与容量，不创建目标目录。 */
  private async preflight(targetRoot: string): Promise<MigrationPreflight> {
    if (!isAbsolute(targetRoot)) throw new DataRootMigrationError('UNSAFE_TARGET', '目标数据根必须是绝对路径')
    let sourceRoot: string
    try {
      sourceRoot = this.locator.requireActiveRoot()
      if (!lstatSync(sourceRoot).isDirectory()) throw new Error('活动数据根必须是实际目录')
      accessSync(sourceRoot, constants.R_OK | constants.W_OK | constants.X_OK)
    } catch (error) {
      throw new DataRootMigrationError('INVALID_SOURCE', '当前数据根不可用', error)
    }
    const normalizedTarget = resolve(targetRoot)
    let prospectiveTarget: { canonicalPath: string; existingAncestor: string }
    try {
      prospectiveTarget = resolveProspectiveTarget(normalizedTarget)
      validateRootRelationship(realpathSync(sourceRoot), prospectiveTarget.canonicalPath)
      if (existsSync(normalizedTarget)) {
        if (!lstatSync(normalizedTarget).isDirectory()) {
          throw new DataRootMigrationError('TARGET_NOT_WRITABLE', '目标数据根必须是目录')
        }
        if (readdirSync(normalizedTarget).length > 0) {
          throw new DataRootMigrationError('TARGET_NOT_EMPTY', '目标数据根必须为空')
        }
      }
    } catch (error) {
      if (error instanceof DataRootMigrationError) throw error
      throw new DataRootMigrationError('UNSAFE_TARGET', '目标数据根路径不安全', error)
    }
    try {
      accessSync(
        existsSync(normalizedTarget) ? normalizedTarget : prospectiveTarget.existingAncestor,
        constants.W_OK | constants.X_OK,
      )
    } catch (error) {
      throw new DataRootMigrationError('TARGET_NOT_WRITABLE', '目标数据根不可写', error)
    }
    let totalBytes: number
    try {
      totalBytes = await scanSourceBytes(sourceRoot)
    } catch (error) {
      throw new DataRootMigrationError('INVALID_SOURCE', '无法扫描当前数据根', error)
    }
    let availableBytes: number
    try {
      availableBytes = await this.getAvailableBytes(prospectiveTarget.existingAncestor)
    } catch (error) {
      throw new DataRootMigrationError('TARGET_NOT_WRITABLE', '无法读取目标磁盘可用空间', error)
    }
    if (!Number.isFinite(availableBytes) || availableBytes < totalBytes) {
      throw new DataRootMigrationError('INSUFFICIENT_SPACE', '目标磁盘可用空间不足')
    }
    return { sourceRoot: resolve(sourceRoot), targetRoot: normalizedTarget, totalBytes }
  }

  /** open(wx) 建立进程锁，仅确认 PID 不存在时删除陈旧锁。 */
  private acquireLock(): void {
    if (this.ownsLock) return
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const descriptor = openSync(this.lockPath, 'wx', 0o600)
        try {
          const record: MigrationLockRecord = { version: 1, pid: process.pid, createdAt: this.now() }
          writeFileSync(descriptor, JSON.stringify(record), 'utf-8')
          fsyncSync(descriptor)
        } finally {
          closeSync(descriptor)
        }
        this.ownsLock = true
        return
      } catch (error) {
        if (!isFileExistsError(error)) throw new DataRootMigrationError('MIGRATION_LOCKED', '无法建立迁移实例锁', error)
        const record = readMigrationLock(this.lockPath)
        if (!record || this.isPidRunning(record.pid)) {
          throw new DataRootMigrationError('MIGRATION_LOCKED', '另一个 Proma 实例正在使用数据根迁移')
        }
        unlinkSync(this.lockPath)
      }
    }
    throw new DataRootMigrationError('MIGRATION_LOCKED', '无法取得迁移实例锁')
  }

  /** 仅删除由当前 coordinator 成功创建的锁。 */
  private releaseLock(): void {
    if (!this.ownsLock) return
    try {
      unlinkSync(this.lockPath)
    } catch (error) {
      if (!isFileMissingError(error)) throw error
    } finally {
      this.ownsLock = false
    }
  }
}

/** 使用 Node statfs 计算普通用户可用字节。 */
async function getStatfsAvailableBytes(directoryPath: string): Promise<number> {
  const stats = await statfs(directoryPath, { bigint: true })
  return Number(stats.bavail * stats.bsize)
}

/** kill(pid, 0) 不发送信号，仅判断 PID 是否仍存在。 */
function isProcessRunning(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return !(error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ESRCH')
  }
}

/** 递归统计普通文件字节；符号链接不跟随，特殊文件交由 copier 严格拒绝。 */
async function scanSourceBytes(rootPath: string): Promise<number> {
  let totalBytes = 0
  const pending = [rootPath]
  while (pending.length > 0) {
    const current = pending.pop()
    if (!current) continue
    const directory = await opendir(current)
    for await (const entry of directory) {
      const entryPath = resolve(current, entry.name)
      if (entry.isDirectory()) pending.push(entryPath)
      else if (entry.isFile()) totalBytes += (await lstat(entryPath)).size
    }
  }
  return totalBytes
}

/** 将缺失目标映射到最近现存祖先下的预计 canonical 路径。 */
function resolveProspectiveTarget(targetRoot: string): { canonicalPath: string; existingAncestor: string } {
  let existingAncestor = targetRoot
  while (!existsSync(existingAncestor)) {
    const parent = dirname(existingAncestor)
    if (parent === existingAncestor) throw new Error('找不到目标目录的现存祖先')
    existingAncestor = parent
  }
  const canonicalAncestor = realpathSync(existingAncestor)
  const suffix = relative(existingAncestor, targetRoot)
  return {
    canonicalPath: resolve(canonicalAncestor, suffix),
    existingAncestor,
  }
}

/** 拒绝相同、嵌套或经 realpath/prospective path 形成的物理别名。 */
function validateRootRelationship(sourceRoot: string, targetRoot: string): void {
  const targetFromSource = relative(sourceRoot, targetRoot)
  const sourceFromTarget = relative(targetRoot, sourceRoot)
  if (targetFromSource === '' || isContainedRelative(targetFromSource) || isContainedRelative(sourceFromTarget)) {
    throw new DataRootMigrationError('UNSAFE_TARGET', '源数据根和目标数据根必须不同且不能互相嵌套')
  }
}

/** path.relative 的结果是否表示严格后代。 */
function isContainedRelative(relativePath: string): boolean {
  return relativePath.length > 0
    && relativePath !== '..'
    && !relativePath.startsWith(`..${sep}`)
    && !isAbsolute(relativePath)
}

/** 迁移记录转换为 UI 进度。 */
function toProgress(record: DataRootMigrationRecord): DataRootMigrationProgress {
  return {
    migrationId: record.id,
    stage: record.stage,
    completedBytes: record.completedBytes,
    totalBytes: record.totalBytes,
    ...(record.error === undefined ? {} : { error: record.error }),
  }
}

/** 严格读取锁记录，损坏锁不允许自动删除。 */
function readMigrationLock(lockPath: string): MigrationLockRecord | null {
  try {
    const value: unknown = JSON.parse(readFileSync(lockPath, 'utf-8'))
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
    const record = value as Record<string, unknown>
    if (record.version !== 1 || !Number.isSafeInteger(record.pid) || typeof record.createdAt !== 'number') return null
    return { version: 1, pid: record.pid as number, createdAt: record.createdAt }
  } catch {
    return null
  }
}

/** 判断 open(wx) 的已存在错误。 */
function isFileExistsError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'EEXIST'
}

/** 判断释放锁时文件已不存在。 */
function isFileMissingError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

/** AbortError 跨 Node/Bun 实现只依赖标准 name。 */
function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

/** 创建跨 Node/Bun 都可识别的标准取消异常。 */
function createAbortError(): Error {
  return Object.assign(new Error('数据根迁移已取消'), { name: 'AbortError' })
}
