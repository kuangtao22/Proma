import { createHash, randomUUID } from 'node:crypto'
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
import { lstat, opendir } from 'node:fs/promises'
import type {
  DataRootDeviceType,
  DataRootMigrationPreview,
  DataRootMigrationPreviewBlockerCode,
  DataRootMigrationProgress,
  DataRootMigrationRecord,
  DataRootMigrationStage,
  DataRootOccupiedStorage,
  PathManagementState,
} from '@proma/shared'
import { DataRootLocator } from './data-root-locator'
import type {
  CopyDirectoryInput,
  CopyDirectoryResult,
  DirectoryCopyOwnership,
  DirectoryCopySpace,
  InspectDirectoryCopyOwnershipInput,
  InspectDirectoryCopySpaceInput,
} from './verified-directory-copier'
import {
  copyDirectoryVerified,
  finalizeDirectoryCopy,
  inspectDirectoryCopyOwnership,
  inspectDirectoryCopySpace,
} from './verified-directory-copier'
import type { RebaseDataRootOwnedPathsInput, RebaseDataRootOwnedPathsResult } from './owned-path-rebaser'
import { rebaseDataRootOwnedPaths } from './owned-path-rebaser'
import { getCachedDataRootOccupied, inspectDataRootVolume } from './data-root-storage'
import type { DataRootVolumeSnapshot } from './data-root-storage'

export {
  DataRootStorageInspector,
  classifyLinuxMountInfo,
  classifyMacDiskInfo,
  classifyWindowsDriveType,
  detectDataRootDeviceType,
  inspectDataRootStorage,
  invalidateDataRootStorage,
  inspectDataRootVolume,
  readLinuxBlockRemovable,
  scanDataRootBytes,
  toSafeByteCount,
} from './data-root-storage'

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
  | 'CLEANUP_FAILED'
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
  createLockOwnerToken?: () => string
  now?: () => number
  getAvailableBytes?: (existingTargetAncestor: string) => Promise<number>
  /** 可注入目标卷元数据检查；指定 getAvailableBytes 时设备类型按 unknown 处理。 */
  inspectTargetVolume?: (existingTargetAncestor: string) => Promise<DataRootVolumeSnapshot>
  /** preview 可复用的会话期源占用缓存；最终计划不会使用。 */
  getCachedSourceOccupied?: (sourceRoot: string) => DataRootOccupiedStorage | undefined
  isPidRunning?: (pid: number) => boolean
  copyDirectory?: (input: CopyDirectoryInput) => Promise<CopyDirectoryResult>
  rebaseOwnedPaths?: (input: RebaseDataRootOwnedPathsInput) => RebaseDataRootOwnedPathsResult
  finalizeCopy?: (input: { migrationId: string; targetRoot: string }) => Promise<void>
  inspectCopyOwnership?: (input: InspectDirectoryCopyOwnershipInput) => Promise<DirectoryCopyOwnership>
  inspectCopySpace?: (input: InspectDirectoryCopySpaceInput) => Promise<DirectoryCopySpace>
  progressPersistIntervalMs?: number
}

/** 实例锁文件的最小持久化结构。 */
interface MigrationLockRecord {
  version: 1
  pid: number
  createdAt: number
  ownerToken: string
}

/** 限制异常崩溃形成的 recovery claim 链深度，损坏或恶意链条必须人工检查。 */
const MAX_RECOVERY_CLAIM_DEPTH = 64

/** 单次 run 独占的取消令牌，创建后 latch 只会从 false 变为 true。 */
interface MigrationRunToken {
  controller: AbortController
  cancelled: boolean
}

/** 预检得到且不创建目标目录的稳定信息。 */
interface MigrationPreflight {
  sourceRoot: string
  targetRoot: string
  totalBytes: number
  requiredBytes: number
  availableBytes?: number
  deviceType: DataRootDeviceType
}

/** plan 与 resume 共用的只读预检策略。 */
interface MigrationPreflightOptions {
  expectedSourceRoot?: string
  requireOwnedSidecar?: boolean
  checkSpace?: boolean
  checkRemainingSpace?: boolean
  reuseCachedSourceSize?: boolean
}

/** 数据根迁移协调器：先复制与重写，最后原子切换 locator。 */
export class DataRootMigrationCoordinator {
  /** 固定 locator 是所有迁移 JSON 的唯一写入口。 */
  private readonly locator: DataRootLocator
  /** 数据根之外的进程互斥锁。 */
  private readonly lockPath: string
  /** 生成不参与路径拼接的唯一迁移 ID。 */
  private readonly createMigrationId: () => string
  /** 锁 owner token 与迁移 ID 分离，避免释放他人锁。 */
  private readonly createLockOwnerToken: () => string
  /** 可注入时钟。 */
  private readonly now: () => number
  /** 读取目标所在卷容量与设备分类。 */
  private readonly inspectTargetVolume: (existingTargetAncestor: string) => Promise<DataRootVolumeSnapshot>
  /** 同步读取设置页已完成的源占用缓存。 */
  private readonly getCachedSourceOccupied: (sourceRoot: string) => DataRootOccupiedStorage | undefined
  /** 可注入 PID 存活检查。 */
  private readonly isPidRunning: (pid: number) => boolean
  /** Task3 可恢复复制公开入口。 */
  private readonly copyDirectory: (input: CopyDirectoryInput) => Promise<CopyDirectoryResult>
  /** Task4 owned path 重写公开入口。 */
  private readonly rebaseOwnedPaths: (input: RebaseDataRootOwnedPathsInput) => RebaseDataRootOwnedPathsResult
  /** commit 后幂等清理 Task3 sidecar。 */
  private readonly finalizeCopy: (input: { migrationId: string; targetRoot: string }) => Promise<void>
  /** Task3 只读 sidecar 归属检查。 */
  private readonly inspectCopyOwnership: (
    input: InspectDirectoryCopyOwnershipInput,
  ) => Promise<DirectoryCopyOwnership>
  /** Task3 只读校验实际可复用文件并计算剩余写入字节。 */
  private readonly inspectCopySpace: (input: InspectDirectoryCopySpaceInput) => Promise<DirectoryCopySpace>
  /** 高频进度允许落盘的最短时间间隔。 */
  private readonly progressPersistIntervalMs: number
  /** 当前进程是否持有锁文件。 */
  private lockOwnerToken: string | null = null
  /** 当前执行中的唯一迁移 Promise。 */
  private activeRun: Promise<void> | null = null
  /** copying 阶段使用的取消控制器。 */
  private activeRunToken: MigrationRunToken | null = null
  /** 构造后自动触发一次 post-commit cleanup 重试，公开方法会等待它结束。 */
  private readonly startupCleanupRetry: Promise<void> | null

  constructor(options: DataRootMigrationCoordinatorOptions) {
    this.locator = options.locator
    this.lockPath = options.lockPath ?? resolve(dirname(options.locator.getLocatorPath()), '.proma-data-root-migration.lock')
    this.createMigrationId = options.createMigrationId ?? randomUUID
    this.createLockOwnerToken = options.createLockOwnerToken ?? randomUUID
    this.now = options.now ?? Date.now
    this.inspectTargetVolume = options.inspectTargetVolume
      ?? (options.getAvailableBytes === undefined
        ? inspectDataRootVolume
        : async (target) => ({ availableBytes: await options.getAvailableBytes?.(target) ?? 0, deviceType: 'unknown' }))
    this.getCachedSourceOccupied = options.getCachedSourceOccupied ?? getCachedDataRootOccupied
    this.isPidRunning = options.isPidRunning ?? isProcessRunning
    this.copyDirectory = options.copyDirectory ?? copyDirectoryVerified
    this.rebaseOwnedPaths = options.rebaseOwnedPaths ?? rebaseDataRootOwnedPaths
    this.finalizeCopy = options.finalizeCopy ?? finalizeDirectoryCopy
    this.inspectCopyOwnership = options.inspectCopyOwnership ?? inspectDirectoryCopyOwnership
    this.inspectCopySpace = options.inspectCopySpace ?? inspectDirectoryCopySpace
    this.progressPersistIntervalMs = options.progressPersistIntervalMs ?? 250
    if (!isAbsolute(this.lockPath)) throw new Error('迁移锁路径必须是绝对路径')
    if (!Number.isFinite(this.progressPersistIntervalMs) || this.progressPersistIntervalMs < 0) {
      throw new Error('进度持久化间隔必须是非负有限数')
    }
    this.startupCleanupRetry = this.locator.inspect().locatorFile?.postCommitCleanup === undefined
      ? null
      : Promise.resolve().then(async () => {
          try {
            await this.retryCommittedCleanupOnStartup()
          } catch {
            // 后台重试错误已持久化到公开 cleanup 状态，由后续显式操作返回可处理错误。
          }
        })
  }

  /** 无副作用返回 locator 当前状态。 */
  getStatus(): PathManagementState {
    return this.locator.inspect().state
  }

  /** 复用迁移预检生成只读目标预览，不获取锁、不写 locator、不创建目录。 */
  async previewTarget(targetRoot: string): Promise<DataRootMigrationPreview> {
    const normalizedTarget = resolve(targetRoot)
    try {
      const preflight = await this.preflight(
        targetRoot,
        `preview-${this.createMigrationId()}`,
        { reuseCachedSourceSize: true },
      )
      return {
        targetRoot: preflight.targetRoot,
        deviceType: preflight.deviceType,
        ...(preflight.availableBytes === undefined ? {} : { availableBytes: preflight.availableBytes }),
        requiredBytes: preflight.requiredBytes,
        blockers: [],
      }
    } catch (error) {
      const blocker = toPreviewBlocker(error)
      /** 阻断不应隐藏仍可安全读取的容量摘要。 */
      const metadata = await this.inspectPreviewMetadata(normalizedTarget)
      return {
        targetRoot: normalizedTarget,
        deviceType: metadata.deviceType,
        ...(metadata.availableBytes === undefined ? {} : { availableBytes: metadata.availableBytes }),
        requiredBytes: metadata.requiredBytes,
        blockers: [blocker],
      }
    }
  }

  /** blocker 场景下尽最大努力读取源大小与目标卷，不让展示元数据覆盖真实阻断原因。 */
  private async inspectPreviewMetadata(targetRoot: string): Promise<{
    requiredBytes: number
    availableBytes?: number
    deviceType: DataRootDeviceType
  }> {
    let requiredBytes = 0
    try {
      const sourceRoot = this.locator.requireActiveRoot()
      const cached = this.getCachedSourceOccupied(sourceRoot)
      requiredBytes = cached?.occupiedStatus === 'ready' && cached.occupiedBytes !== undefined
        ? cached.occupiedBytes
        : await scanSourceBytes(sourceRoot)
    } catch {
      // INVALID_SOURCE blocker 已携带可处理原因，摘要保持 0。
    }
    try {
      const prospectiveTarget = resolveProspectiveTarget(targetRoot)
      const volume = await this.inspectTargetVolume(prospectiveTarget.existingAncestor)
      return { requiredBytes, ...volume }
    } catch {
      return { requiredBytes, deviceType: 'unknown' }
    }
  }

  /**
   * 完成全部只读预检后创建 pending 计划；失败会释放临时实例锁。
   *
   * @param targetRoot 用户选择的绝对目标目录。
   * @returns 已持久化的 pending 进度。
   */
  async createPlan(targetRoot: string): Promise<DataRootMigrationProgress> {
    if (this.activeRun !== null) throw new DataRootMigrationError('MIGRATION_BUSY', '数据根迁移正在运行')
    if (this.startupCleanupRetry) await this.startupCleanupRetry
    /** 标记本次规划调用是否新建 lease，避免释放已有待执行计划持有的 lease。 */
    const acquiredLease = this.acquireLock()
    try {
      await this.cleanupCommittedMigration()
      const migrationId = this.createMigrationId()
      const preflight = await this.preflight(targetRoot, migrationId)
      const timestamp = this.now()
      const migration: DataRootMigrationRecord = {
        id: migrationId,
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
      if (acquiredLease) this.releaseLock()
      throw error
    }
  }

  /** 运行 locator 中的 pending/failed/switching 迁移。 */
  async runPending(onProgress: (progress: DataRootMigrationProgress) => void = () => {}): Promise<void> {
    if (this.activeRun !== null) throw new DataRootMigrationError('MIGRATION_BUSY', '数据根迁移正在运行')
    const token: MigrationRunToken = { controller: new AbortController(), cancelled: false }
    this.activeRunToken = token
    const execution = this.executePending(token, onProgress)
    this.activeRun = execution
    try {
      await execution
    } finally {
      this.activeRun = null
      if (this.activeRunToken === token) this.activeRunToken = null
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
      const token = this.activeRunToken
      if (token) {
        token.cancelled = true
        token.controller.abort()
      }
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
  private async executePending(
    token: MigrationRunToken,
    onProgress: (progress: DataRootMigrationProgress) => void,
  ): Promise<void> {
    if (this.startupCleanupRetry) await this.startupCleanupRetry
    this.acquireLock()
    try {
      await this.cleanupCommittedMigration()
      this.throwIfCancelled(token)
      let migration = this.locator.inspect().locatorFile?.migration
      if (!migration) return
      try {
        const recheck = await this.preflight(migration.targetRoot, migration.id, {
          expectedSourceRoot: migration.sourceRoot,
          requireOwnedSidecar: ['verifying', 'rebasing', 'switching'].includes(migration.stage),
          checkSpace: ['pending', 'failed', 'copying'].includes(migration.stage),
          checkRemainingSpace: ['failed', 'copying'].includes(migration.stage),
        }, token)
        if (
          ['pending', 'failed', 'copying'].includes(migration.stage)
          && recheck.totalBytes !== migration.totalBytes
        ) throw new DataRootMigrationError('COPY_FAILED', '源目录容量在计划创建后发生变化')
        this.throwIfCancelled(token)
      } catch (error) {
        if (isAbortError(error)) throw error
        const migrationError = error instanceof DataRootMigrationError
          ? error
          : new DataRootMigrationError('COPY_FAILED', '迁移环境复检失败', error)
        if (migration.stage === 'switching') {
          throw this.persistSwitchingError(migration.id, migrationError.message, migrationError.code, migrationError)
        }
        throw this.persistFailure(migration.id, migrationError.message, migrationError.code, migrationError)
      }
      if (migration.stage === 'switching') {
        if (migration.completedBytes !== migration.totalBytes) {
          throw new DataRootMigrationError('COPY_FAILED', '切换前目标数据未完整校验')
        }
        this.locator.commitMigration(migration.id)
        await this.cleanupCommittedMigration()
        this.throwIfCancelled(token)
        return
      }

      if (migration.stage === 'pending' || migration.stage === 'failed' || migration.stage === 'copying') {
        this.throwIfCancelled(token)
        migration = this.transition(migration, 'copying', onProgress)
        let lastPersistedAt = this.now()
        let persistedBytes = migration.completedBytes
        let observedBytes = migration.completedBytes
        try {
          const result = await this.copyDirectory({
            migrationId: migration.id,
            sourceRoot: migration.sourceRoot,
            targetRoot: migration.targetRoot,
            signal: token.controller.signal,
            onProgress: (progress) => {
              observedBytes = Math.max(observedBytes, Math.min(migration!.totalBytes, progress.completedBytes))
              const publicProgress: DataRootMigrationProgress = {
                ...progress,
                stage: 'copying',
                completedBytes: observedBytes,
                totalBytes: migration!.totalBytes,
              }
              const currentTime = this.now()
              if (observedBytes > persistedBytes && currentTime - lastPersistedAt >= this.progressPersistIntervalMs) {
                this.locator.updateMigration(migration!.id, { completedBytes: observedBytes, updatedAt: currentTime })
                persistedBytes = observedBytes
                lastPersistedAt = currentTime
              }
              this.notifyProgress(onProgress, publicProgress)
            },
          })
          this.throwIfCancelled(token)
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
          if (token.cancelled || isAbortError(error)) {
            if (this.locator.inspect().locatorFile?.migration) this.locator.cancelMigration(migration.id)
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
        }
        this.throwIfCancelled(token)
        migration = this.transition(migration, 'verifying', onProgress)
      }

      this.throwIfCancelled(token)
      if (migration.stage === 'verifying') migration = this.transition(migration, 'rebasing', onProgress)
      try {
        this.rebaseOwnedPaths({ sourceRoot: migration.sourceRoot, targetRoot: migration.targetRoot })
      } catch (error) {
        throw this.persistFailure(migration.id, '更新 Proma-owned 路径失败', 'REBASE_FAILED', error)
      }
      this.throwIfCancelled(token)
      migration = this.transition(migration, 'switching', onProgress)
      try {
        await this.preflight(migration.targetRoot, migration.id, {
          expectedSourceRoot: migration.sourceRoot,
          requireOwnedSidecar: true,
          checkSpace: false,
        }, token)
        this.throwIfCancelled(token)
      } catch (error) {
        if (isAbortError(error)) throw error
        throw this.persistSwitchingError(
          migration.id,
          '切换前目标副本复检失败',
          'COPY_FAILED',
          error,
        )
      }
      try {
        this.locator.commitMigration(migration.id)
      } catch (error) {
        throw this.persistSwitchingError(
          migration.id,
          '切换数据根失败',
          'LOCATOR_WRITE_FAILED',
          error,
        )
      }
      await this.cleanupCommittedMigration()
      this.throwIfCancelled(token)
    } finally {
      this.releaseLock()
    }
  }

  /** 每个 await 与阶段边界后检查单向取消 latch。 */
  private throwIfCancelled(token: MigrationRunToken): void {
    if (!token.cancelled && !token.controller.signal.aborted) return
    const migration = this.locator.inspect().locatorFile?.migration
    if (migration && ['pending', 'failed', 'copying'].includes(migration.stage)) {
      this.locator.cancelMigration(migration.id)
    }
    throw createAbortError()
  }

  /** 阶段边界立即落盘并发送事件。 */
  private transition(
    migration: DataRootMigrationRecord,
    stage: DataRootMigrationStage,
    onProgress: (progress: DataRootMigrationProgress) => void,
  ): DataRootMigrationRecord {
    /** 已成功持久化的新迁移记录。 */
    let updated: DataRootMigrationRecord
    try {
      const result = this.locator.updateMigration(migration.id, {
        stage,
        updatedAt: Math.max(this.now(), migration.updatedAt),
      })
      /** 从 locator 回读的持久化迁移记录。 */
      const persisted = result.locatorFile?.migration
      if (!persisted) throw new Error('迁移阶段写入后记录缺失')
      updated = persisted
    } catch (error) {
      throw this.persistFailure(migration.id, '保存迁移阶段失败', 'LOCATOR_WRITE_FAILED', error)
    }
    this.notifyProgress(onProgress, toProgress(updated))
    return updated
  }

  /** observer/IPC 通知属于 best-effort，不参与 locator 与迁移事务成败。 */
  private notifyProgress(
    onProgress: (progress: DataRootMigrationProgress) => void,
    progress: DataRootMigrationProgress,
  ): void {
    try {
      onProgress(progress)
    } catch {
      // observer 生命周期独立于迁移事务，断连或消费异常不应回滚已持久化状态。
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

  /** switching 失败保持阶段不倒退，只原子记录可读错误供下次恢复。 */
  private persistSwitchingError(
    migrationId: string,
    message: string,
    code: DataRootMigrationErrorCode,
    cause: unknown,
  ): DataRootMigrationError {
    try {
      const current = this.locator.inspect().locatorFile?.migration
      if (current?.stage === 'switching') {
        this.locator.updateMigration(migrationId, {
          stage: 'switching',
          updatedAt: Math.max(this.now(), current.updatedAt),
          error: message,
        })
      }
    } catch (locatorError) {
      return new DataRootMigrationError('LOCATOR_WRITE_FAILED', '保存切换错误状态失败', locatorError)
    }
    return new DataRootMigrationError(code, message, cause)
  }

  /** 构造阶段自动重试遗留 cleanup，并独占本次新建的实例 lease。 */
  private async retryCommittedCleanupOnStartup(): Promise<void> {
    if (!this.locator.inspect().locatorFile?.postCommitCleanup) return
    /** 标记启动清理是否新建 lease，避免误释放同实例已有 lease。 */
    const acquiredLease = this.acquireLock()
    try {
      await this.cleanupCommittedMigration()
    } finally {
      if (acquiredLease) this.releaseLock()
    }
  }

  /** commit 已成功时清理 sidecar；失败公开持久化并返回可处理错误。 */
  private async cleanupCommittedMigration(): Promise<void> {
    const cleanup = this.locator.inspect().locatorFile?.postCommitCleanup
    if (!cleanup) return
    try {
      this.locator.updatePostCommitCleanupError(cleanup.migrationId)
      await this.finalizeCopy({ migrationId: cleanup.migrationId, targetRoot: cleanup.targetRoot })
      this.locator.clearPostCommitCleanup(cleanup.migrationId)
    } catch (error) {
      try {
        this.locator.updatePostCommitCleanupError(cleanup.migrationId, '清理迁移断点失败')
      } catch (locatorError) {
        throw new DataRootMigrationError('LOCATOR_WRITE_FAILED', '保存迁移清理错误失败', locatorError)
      }
      throw new DataRootMigrationError(
        'CLEANUP_FAILED',
        '迁移已完成，但清理断点失败；请重试后再创建新迁移',
        error,
      )
    }
  }

  /** 只读验证源、目标物理关系、写权限与容量，不创建目标目录。 */
  private async preflight(
    targetRoot: string,
    migrationId: string,
    options: MigrationPreflightOptions = {},
    token?: MigrationRunToken,
  ): Promise<MigrationPreflight> {
    if (!isAbsolute(targetRoot)) throw new DataRootMigrationError('UNSAFE_TARGET', '目标数据根必须是绝对路径')
    let sourceRoot: string
    try {
      sourceRoot = this.locator.requireActiveRoot()
      if (options.expectedSourceRoot !== undefined && sourceRoot !== options.expectedSourceRoot) {
        throw new Error('活动数据根与迁移源根不一致')
      }
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
    let ownership: DirectoryCopyOwnership
    try {
      ownership = await this.inspectCopyOwnership({
        migrationId,
        sourceRoot,
        targetRoot: normalizedTarget,
      })
    } catch (error) {
      throw new DataRootMigrationError('UNSAFE_TARGET', '无法验证目标迁移归属', error)
    }
    if (token) this.throwIfCancelled(token)
    if (ownership === 'foreign' || ownership === 'invalid') {
      throw new DataRootMigrationError('UNSAFE_TARGET', '目标 sidecar 不属于当前迁移或已损坏')
    }
    if (options.requireOwnedSidecar && ownership !== 'owned') {
      throw new DataRootMigrationError('UNSAFE_TARGET', '目标副本不属于当前迁移')
    }
    if (options.requireOwnedSidecar && !existsSync(normalizedTarget)) {
      throw new DataRootMigrationError('UNSAFE_TARGET', '目标副本目录不存在')
    }
    if (existsSync(normalizedTarget) && readdirSync(normalizedTarget).length > 0 && ownership !== 'owned') {
      throw new DataRootMigrationError('TARGET_NOT_EMPTY', '非空目标不属于当前迁移')
    }
    let totalBytes = 0
    if (options.checkSpace !== false) {
      try {
        const cached = options.reuseCachedSourceSize ? this.getCachedSourceOccupied(sourceRoot) : undefined
        totalBytes = cached?.occupiedStatus === 'ready' && cached.occupiedBytes !== undefined
          ? cached.occupiedBytes
          : await scanSourceBytes(sourceRoot)
      } catch (error) {
        throw new DataRootMigrationError('INVALID_SOURCE', '无法扫描当前数据根', error)
      }
      if (token) this.throwIfCancelled(token)
    }
    /** 当前阶段实际仍需写入目标磁盘的字节数。 */
    let requiredBytes = totalBytes
    if (options.checkSpace !== false && options.checkRemainingSpace && ownership === 'owned') {
      /** sidecar 与目标文件复验得到的空间占用明细。 */
      let copySpace: DirectoryCopySpace
      try {
        copySpace = await this.inspectCopySpace({
          migrationId,
          sourceRoot,
          targetRoot: normalizedTarget,
          ...(token === undefined ? {} : { signal: token.controller.signal }),
        })
      } catch (error) {
        throw new DataRootMigrationError('COPY_FAILED', '无法验证断点可复用数据', error)
      }
      if (
        !Number.isSafeInteger(copySpace.totalBytes)
        || !Number.isSafeInteger(copySpace.reusableBytes)
        || !Number.isSafeInteger(copySpace.remainingBytes)
        || copySpace.totalBytes !== totalBytes
        || copySpace.reusableBytes < 0
        || copySpace.remainingBytes < 0
        || copySpace.reusableBytes + copySpace.remainingBytes !== copySpace.totalBytes
      ) {
        throw new DataRootMigrationError('COPY_FAILED', '断点空间估算结果无效')
      }
      requiredBytes = copySpace.remainingBytes
      if (token) this.throwIfCancelled(token)
    }
    let availableBytes: number | undefined
    let deviceType: DataRootDeviceType = 'unknown'
    if (options.checkSpace !== false) {
      try {
        const volume = await this.inspectTargetVolume(prospectiveTarget.existingAncestor)
        availableBytes = volume.availableBytes
        deviceType = volume.deviceType
      } catch (error) {
        throw new DataRootMigrationError('TARGET_NOT_WRITABLE', '无法读取目标磁盘可用空间', error)
      }
      if (token) this.throwIfCancelled(token)
      if (availableBytes === undefined || !Number.isSafeInteger(availableBytes) || availableBytes < 0) {
        throw new DataRootMigrationError('TARGET_NOT_WRITABLE', '无法读取目标磁盘可用空间')
      }
      if (availableBytes < requiredBytes) {
        throw new DataRootMigrationError('INSUFFICIENT_SPACE', '目标磁盘可用空间不足')
      }
    }
    return {
      sourceRoot: resolve(sourceRoot),
      targetRoot: normalizedTarget,
      totalBytes,
      requiredBytes,
      availableBytes,
      deviceType,
    }
  }

  /** open(wx) 建立进程锁，返回本次调用是否新建 lease。 */
  private acquireLock(): boolean {
    if (this.lockOwnerToken !== null) return false
    const ownerToken = this.createLockOwnerToken()
    if (tryCreateMigrationLock(this.lockPath, ownerToken, this.now())) {
      this.lockOwnerToken = ownerToken
      return true
    }

    const recoveryPath = `${this.lockPath}.recover`
    const recoveryOwnerToken = this.createLockOwnerToken()
    const recoveryClaimPath = this.acquireRecoveryLock(recoveryPath, recoveryOwnerToken)
    try {
      const initial = readMigrationLock(this.lockPath)
      if (!initial || this.isPidRunning(initial.pid)) {
        throw new DataRootMigrationError('MIGRATION_LOCKED', '另一个 Proma 实例正在使用数据根迁移')
      }
      const confirmed = readMigrationLock(this.lockPath)
      if (!confirmed || confirmed.ownerToken !== initial.ownerToken || this.isPidRunning(confirmed.pid)) {
        throw new DataRootMigrationError('MIGRATION_LOCKED', '迁移锁 owner 在接管期间发生变化')
      }
      unlinkSync(this.lockPath)
      if (!tryCreateMigrationLock(this.lockPath, ownerToken, this.now())) {
        throw new DataRootMigrationError('MIGRATION_LOCKED', '陈旧锁接管后主锁被其他实例占用')
      }
      this.lockOwnerToken = ownerToken
      return true
    } finally {
      releaseActiveLockClaim(recoveryClaimPath)
    }
  }

  /**
   * 获取 recovery mutex：陈旧 claim 永不删除，竞争者只原子创建同一个确定性 successor。
   * 这避免了 Node 缺少原子 compare-unlink 时，旧 contender 误删新 owner 的竞态。
   */
  private acquireRecoveryLock(recoveryPath: string, ownerToken: string): string {
    let claimPath = recoveryPath
    for (let depth = 0; depth < MAX_RECOVERY_CLAIM_DEPTH; depth += 1) {
      if (tryCreateMigrationLock(claimPath, ownerToken, this.now())) return claimPath
      const initial = readMigrationLock(claimPath)
      if (!initial || this.isPidRunning(initial.pid)) {
        throw new DataRootMigrationError('MIGRATION_LOCKED', '另一个实例正在接管陈旧迁移锁')
      }
      const confirmed = readMigrationLock(claimPath)
      if (!confirmed || confirmed.ownerToken !== initial.ownerToken || this.isPidRunning(confirmed.pid)) {
        throw new DataRootMigrationError('MIGRATION_LOCKED', 'recovery mutex owner 在检查期间发生变化')
      }
      claimPath = getRecoverySuccessorPath(recoveryPath, claimPath, initial.ownerToken)
    }
    throw new DataRootMigrationError('MIGRATION_LOCKED', '陈旧 recovery mutex 链过深，无法安全接管')
  }

  /** 仅删除由当前 coordinator 成功创建的锁。 */
  private releaseLock(): void {
    if (this.lockOwnerToken === null) return
    releaseActiveLockClaim(this.lockPath)
    this.lockOwnerToken = null
  }
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

/** no-follow 递归统计普通文件字节；符号链接计零，特殊文件在计划阶段明确拒绝。 */
async function scanSourceBytes(rootPath: string): Promise<number> {
  let totalBytes = 0
  const pending = [rootPath]
  while (pending.length > 0) {
    const current = pending.pop()
    if (!current) continue
    const directory = await opendir(current)
    for await (const entry of directory) {
      const entryPath = resolve(current, entry.name)
      /** no-follow 获取的目录项真实类型与大小。 */
      const stats = await lstat(entryPath, { bigint: true })
      if (stats.isDirectory()) {
        pending.push(entryPath)
      } else if (stats.isFile()) {
        if (stats.size > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw new Error('普通文件过大，无法安全计数')
        }
        totalBytes += Number(stats.size)
        if (!Number.isSafeInteger(totalBytes)) throw new Error('目录总字节数超过安全整数范围')
      } else if (!stats.isSymbolicLink()) {
        throw new Error('源目录包含不支持的特殊文件')
      }
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

/** 把 coordinator 错误收敛为预览允许公开的稳定 blocker。 */
function toPreviewBlocker(error: unknown): {
  code: DataRootMigrationPreviewBlockerCode
  message: string
} {
  if (error instanceof DataRootMigrationError && isPreviewBlockerCode(error.code)) {
    return { code: error.code, message: error.message }
  }
  return { code: 'UNSAFE_TARGET', message: error instanceof Error ? error.message : '无法预检目标数据根' }
}

/** 预览只公开用户可在确认前处理的预检错误。 */
function isPreviewBlockerCode(code: DataRootMigrationErrorCode): code is DataRootMigrationPreviewBlockerCode {
  return ['INVALID_SOURCE', 'UNSAFE_TARGET', 'TARGET_NOT_WRITABLE', 'TARGET_NOT_EMPTY', 'INSUFFICIENT_SPACE'].includes(code)
}

/** 严格读取锁记录，损坏锁不允许自动删除。 */
function readMigrationLock(lockPath: string): MigrationLockRecord | null {
  try {
    const value: unknown = JSON.parse(readFileSync(lockPath, 'utf-8'))
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
    const record = value as Record<string, unknown>
    const keys = Object.keys(record).sort()
    if (
      keys.length !== 4
      || keys[0] !== 'createdAt'
      || keys[1] !== 'ownerToken'
      || keys[2] !== 'pid'
      || keys[3] !== 'version'
      || record.version !== 1
      || !Number.isSafeInteger(record.pid)
      || (record.pid as number) <= 0
      || typeof record.createdAt !== 'number'
      || !Number.isFinite(record.createdAt)
      || record.createdAt < 0
      || typeof record.ownerToken !== 'string'
      || record.ownerToken.trim().length === 0
    ) return null
    return {
      version: 1,
      pid: record.pid as number,
      createdAt: record.createdAt,
      ownerToken: record.ownerToken,
    }
  } catch {
    return null
  }
}

/** 用 open(wx) 创建带随机 owner 的锁；已存在时返回 false。 */
function tryCreateMigrationLock(lockPath: string, ownerToken: string, createdAt: number): boolean {
  if (ownerToken.trim().length === 0 || !Number.isFinite(createdAt) || createdAt < 0) {
    throw new DataRootMigrationError('MIGRATION_LOCKED', '迁移锁 owner 或时间无效')
  }
  let created = false
  try {
    const descriptor = openSync(lockPath, 'wx', 0o600)
    created = true
    try {
      const record: MigrationLockRecord = { version: 1, pid: process.pid, createdAt, ownerToken }
      writeFileSync(descriptor, JSON.stringify(record), 'utf-8')
      fsyncSync(descriptor)
    } finally {
      closeSync(descriptor)
    }
    return true
  } catch (error) {
    if (isFileExistsError(error)) return false
    if (created) {
      try {
        unlinkSync(lockPath)
      } catch (unlinkError) {
        if (!isFileMissingError(unlinkError)) {
          throw new DataRootMigrationError('MIGRATION_LOCKED', '清理未完成的迁移实例锁失败', unlinkError)
        }
      }
    }
    throw new DataRootMigrationError('MIGRATION_LOCKED', '无法建立迁移实例锁', error)
  }
}

/** 根据不可变前驱 claim 生成所有 contender 一致竞争的固定长度 successor 路径。 */
function getRecoverySuccessorPath(recoveryPath: string, claimPath: string, ownerToken: string): string {
  const claimDigest = createHash('sha256')
    .update(claimPath)
    .update('\0')
    .update(ownerToken)
    .digest('hex')
    .slice(0, 32)
  return `${recoveryPath}.claim-${claimDigest}`
}

/** 活跃 holder 直接释放自己原子创建的 claim；其他 owner 只能在该 syscall 返回后创建。 */
function releaseActiveLockClaim(claimPath: string): void {
  try {
    unlinkSync(claimPath)
  } catch (error) {
    if (!isFileMissingError(error)) throw error
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
