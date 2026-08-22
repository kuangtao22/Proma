import { accessSync, constants, existsSync, mkdirSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { isDataRootLocatorFile } from '@proma/shared'
import type {
  DataRootLocatorFile,
  DataRootMigrationProgress,
  DataRootMigrationRecord,
  DataRootMigrationStage,
  PathManagementState,
} from '@proma/shared'
import { readJsonFileSafe, writeJsonFileAtomic } from './safe-file'

/** 固定定位器初始化参数。 */
export interface DataRootLocatorOptions {
  /** 用户 home 目录，用于固定定位文件和默认数据根。 */
  homeDir: string
}

/** 获取活动数据根时允许的显式副作用。 */
export interface RequireActiveRootOptions {
  /** 仅当定位文件缺失且默认根不存在时，允许创建默认根。 */
  createDefault?: boolean
}

/** 定位器检查结果的状态判别值。 */
export type DataRootLocatorStatus = 'ready' | 'unavailable' | 'invalid' | 'migration'

/** 固定定位器解析出的当前状态。 */
export interface DataRootLocatorResult {
  status: DataRootLocatorStatus
  state: PathManagementState
  locatorFile?: DataRootLocatorFile
  error?: string
}

/** 单次迁移更新允许修改的字段。 */
export interface DataRootMigrationUpdate {
  stage?: DataRootMigrationStage
  completedBytes?: number
  updatedAt: number
  error?: string
}

/** 零进度迁移在隔离进程中重建容量基线所需字段。 */
export interface DataRootMigrationBaselineUpdate {
  /** 隔离进程最终扫描得到的普通文件总字节数。 */
  totalBytes: number
  /** 本次基线写入时间。 */
  updatedAt: number
}

/**
 * 管理固定 `~/.proma-location.json`，让开发版与正式版解析同一个业务数据根。
 */
export class DataRootLocator {
  /** 固定定位文件的绝对路径。 */
  private readonly locatorPath: string
  /** 未配置自定义根时使用的默认绝对路径。 */
  private readonly defaultRoot: string
  /** 首次解析后复用的结果，写入成功时会被刷新。 */
  private cachedResult: DataRootLocatorResult | null = null

  /**
   * 创建固定定位器。
   *
   * @param options 用户 home 目录配置。
   */
  constructor(options: DataRootLocatorOptions) {
    if (!isAbsolute(options.homeDir)) {
      throw new Error('homeDir 必须是绝对路径')
    }

    this.locatorPath = join(resolve(options.homeDir), '.proma-location.json')
    this.defaultRoot = join(resolve(options.homeDir), '.proma')
  }

  /**
   * 返回位于数据根之外的固定定位文件路径。
   *
   * @returns `homeDir/.proma-location.json` 的绝对路径。
   */
  getLocatorPath(): string {
    return this.locatorPath
  }

  /**
   * 无副作用地解析并检查当前数据根，首次解析后返回缓存结果。
   *
   * @returns 可判别的定位状态、路径管理状态和已校验定位文件。
   */
  inspect(): DataRootLocatorResult {
    if (this.cachedResult !== null) {
      return this.cachedResult
    }

    if (!this.hasLocatorCandidates()) {
      this.cachedResult = this.createResultForRoot(this.defaultRoot, undefined, true)
      return this.cachedResult
    }

    /** safe-file 会依次尝试主文件、临时文件和备份文件。 */
    const rawLocatorFile = readJsonFileSafe(this.locatorPath, { validate: isDataRootLocatorFile })
    if (rawLocatorFile === null) {
      this.cachedResult = {
        status: 'invalid',
        state: createPathManagementState(null, 'invalid', null),
        error: '数据根定位文件损坏或字段无效',
      }
      return this.cachedResult
    }

    this.cachedResult = this.createResultForRoot(rawLocatorFile.activeRoot, rawLocatorFile, false)
    return this.cachedResult
  }

  /**
   * 获取当前活动数据根；只有默认根可通过显式选项创建。
   *
   * @param options 是否允许创建缺失的默认数据根。
   * @returns 已存在或刚创建的活动数据根绝对路径。
   */
  requireActiveRoot(options: RequireActiveRootOptions = {}): string {
    /** 获取当前缓存状态，避免重复读取固定定位文件。 */
    const result = this.inspect()
    /** invalid 状态为 null，其余可用状态必须收窄为绝对路径。 */
    const activeRoot = result.state.activeRoot
    /** 仅无定位文件时解析出的默认路径拥有自动创建权限。 */
    const usesImplicitDefault = result.locatorFile === undefined && activeRoot === this.defaultRoot

    if (result.status === 'ready' && result.state.availability === 'missing' && usesImplicitDefault && options.createDefault) {
      mkdirSync(this.defaultRoot, { recursive: true })
      this.cachedResult = this.createResultForRoot(this.defaultRoot, undefined, true)
      return this.defaultRoot
    }

    if (
      (result.status === 'ready' || result.status === 'migration')
      && result.state.availability === 'available'
      && activeRoot !== null
    ) {
      return activeRoot
    }

    throw new Error(result.status === 'invalid' ? '数据根定位文件无效' : '数据根不可用')
  }

  /**
   * 校验并原子写入完整定位文件，然后刷新内存缓存。
   *
   * @param locatorFile 待持久化的完整定位文件。
   * @returns 写入后重新解析得到的最新状态。
   */
  write(locatorFile: DataRootLocatorFile): DataRootLocatorResult {
    if (!isDataRootLocatorFile(locatorFile)) {
      throw new Error('拒绝写入无效的数据根定位文件')
    }

    writeJsonFileAtomic(this.locatorPath, locatorFile)
    this.cachedResult = null
    return this.inspect()
  }

  /**
   * 创建唯一 pending 迁移记录，不改变当前活动根。
   *
   * @param migration 已完成预检的迁移记录。
   * @returns 写入后的定位状态。
   */
  beginMigration(migration: DataRootMigrationRecord): DataRootLocatorResult {
    const result = this.inspect()
    const activeRoot = result.state.activeRoot
    if (activeRoot === null || result.state.availability !== 'available') throw new Error('当前活动数据根不可用')
    if (result.locatorFile?.migration !== undefined) throw new Error('已有数据根迁移正在进行')
    if (result.locatorFile?.postCommitCleanup !== undefined) throw new Error('上一次数据根迁移尚未完成清理')
    if (migration.sourceRoot !== activeRoot) throw new Error('迁移源根必须是当前活动数据根')
    if (migration.stage !== 'pending' || migration.completedBytes !== 0) throw new Error('新迁移必须从 pending 零进度开始')
    return this.write({
      version: 1,
      activeRoot,
      ...(result.locatorFile?.previousRoot === undefined ? {} : { previousRoot: result.locatorFile.previousRoot }),
      migration,
    })
  }

  /**
   * 按迁移 ID 原子更新进度，并拒绝阶段或字节回退。
   *
   * @param migrationId 当前迁移 ID。
   * @param update 阶段、已提交字节和错误摘要。
   * @returns 写入后的定位状态。
   */
  updateMigration(migrationId: string, update: DataRootMigrationUpdate): DataRootLocatorResult {
    const result = this.inspect()
    const locatorFile = result.locatorFile
    const current = locatorFile?.migration
    if (!locatorFile || !current) throw new Error('当前没有可更新的数据根迁移')
    if (current.id !== migrationId) throw new Error('迁移 ID 不匹配')
    const nextStage = update.stage ?? current.stage
    const nextCompletedBytes = update.completedBytes ?? current.completedBytes
    if (!isAllowedMigrationTransition(current.stage, nextStage)) throw new Error('数据根迁移阶段不能跳转或倒退')
    if (nextCompletedBytes < current.completedBytes || nextCompletedBytes > current.totalBytes) {
      throw new Error('数据根迁移已完成字节必须单调且不超过总量')
    }
    if (update.updatedAt < current.updatedAt) throw new Error('数据根迁移更新时间不能倒退')
    const migration: DataRootMigrationRecord = {
      ...current,
      stage: nextStage,
      completedBytes: nextCompletedBytes,
      updatedAt: update.updatedAt,
      ...(update.error === undefined ? {} : { error: update.error }),
    }
    if (update.error === undefined && nextStage !== 'failed') delete migration.error
    return this.write({ ...locatorFile, migration })
  }

  /**
   * 在复制尚未开始且目标没有断点时，用隔离进程的最终扫描结果刷新容量基线。
   *
   * @param migrationId 当前迁移 ID。
   * @param update 新容量与更新时间。
   * @returns 写入后的定位状态。
   */
  rebaselineUnstartedMigration(
    migrationId: string,
    update: DataRootMigrationBaselineUpdate,
  ): DataRootLocatorResult {
    /** 当前定位文件的可信解析结果。 */
    const result = this.inspect()
    /** 包含迁移计划的固定定位文件。 */
    const locatorFile = result.locatorFile
    /** 待刷新容量基线的迁移记录。 */
    const current = locatorFile?.migration
    if (!locatorFile || !current) throw new Error('当前没有可更新的数据根迁移')
    if (current.id !== migrationId) throw new Error('迁移 ID 不匹配')
    if (!['pending', 'failed'].includes(current.stage) || current.completedBytes !== 0) {
      throw new Error('仅未开始复制的数据根迁移可以刷新容量基线')
    }
    if (!Number.isSafeInteger(update.totalBytes) || update.totalBytes < 0) {
      throw new Error('数据根迁移总字节数无效')
    }
    if (update.updatedAt < current.updatedAt) throw new Error('数据根迁移更新时间不能倒退')
    /** 保留迁移身份与阶段，仅替换隔离扫描确认的容量和时间。 */
    const migration: DataRootMigrationRecord = {
      ...current,
      totalBytes: update.totalBytes,
      updatedAt: update.updatedAt,
    }
    return this.write({ ...locatorFile, migration })
  }

  /**
   * 在切换前取消迁移并保留目标副本。
   *
   * @param migrationId 当前迁移 ID。
   * @returns 清除迁移记录后的定位状态。
   */
  cancelMigration(migrationId: string): DataRootLocatorResult {
    const result = this.inspect()
    const locatorFile = result.locatorFile
    const migration = locatorFile?.migration
    if (!locatorFile || !migration) throw new Error('当前没有可取消的数据根迁移')
    if (migration.id !== migrationId) throw new Error('迁移 ID 不匹配')
    if (!['pending', 'failed', 'copying'].includes(migration.stage)) throw new Error('当前迁移阶段不能取消')
    const { migration: _migration, ...remaining } = locatorFile
    return this.write(remaining)
  }

  /**
   * 完成当前迁移：原子切换到目标根、记录源根并清除迁移状态。
   *
   * @param migrationId 调用方确认要提交的迁移 ID。
   * @returns 切换后重新解析得到的最新状态。
   */
  commitMigration(migrationId: string): DataRootLocatorResult {
    /** 从缓存或磁盘获取已严格校验的定位文件。 */
    const result = this.inspect()
    /** 待提交的持久化迁移记录。 */
    const migration = result.locatorFile?.migration
    if (migration === undefined) {
      throw new Error('当前没有可提交的数据根迁移')
    }
    if (migration.id !== migrationId) {
      throw new Error('迁移 ID 不匹配')
    }
    if (migration.stage !== 'switching') {
      throw new Error('迁移尚未进入切换阶段')
    }
    if (migration.completedBytes !== migration.totalBytes) {
      throw new Error('迁移数据尚未完成')
    }
    if (inspectRootAvailability(migration.targetRoot) !== 'available') {
      throw new Error('迁移目标根不可用')
    }

    return this.write({
      version: 1,
      activeRoot: migration.targetRoot,
      previousRoot: migration.sourceRoot,
      postCommitCleanup: {
        migrationId: migration.id,
        targetRoot: migration.targetRoot,
      },
    })
  }

  /**
   * finalize 成功后清除 post-commit cleanup 意图。
   *
   * @param migrationId 已完成清理的迁移 ID。
   * @returns 清理后的定位状态。
   */
  clearPostCommitCleanup(migrationId: string): DataRootLocatorResult {
    const result = this.inspect()
    const locatorFile = result.locatorFile
    const cleanup = locatorFile?.postCommitCleanup
    if (!locatorFile || !cleanup) return result
    if (cleanup.migrationId !== migrationId) throw new Error('清理记录的迁移 ID 不匹配')
    const { postCommitCleanup: _cleanup, ...remaining } = locatorFile
    return this.write(remaining)
  }

  /**
   * 更新 post-commit cleanup 的公开错误；传入 undefined 表示重试已开始。
   *
   * @param migrationId 待清理迁移 ID。
   * @param error 清理失败摘要；重试开始时省略。
   * @returns 更新后重新解析得到的定位状态。
   */
  updatePostCommitCleanupError(migrationId: string, error?: string): DataRootLocatorResult {
    const result = this.inspect()
    const locatorFile = result.locatorFile
    const cleanup = locatorFile?.postCommitCleanup
    if (!locatorFile || !cleanup) throw new Error('当前没有待处理的迁移清理')
    if (cleanup.migrationId !== migrationId) throw new Error('清理记录的迁移 ID 不匹配')
    return this.write({
      ...locatorFile,
      postCommitCleanup: {
        migrationId: cleanup.migrationId,
        targetRoot: cleanup.targetRoot,
        ...(error === undefined ? {} : { error }),
      },
    })
  }

  /**
   * 判断主定位文件或恢复候选是否存在。
   *
   * @returns 任一候选文件存在时返回 true。
   */
  private hasLocatorCandidates(): boolean {
    return existsSync(this.locatorPath)
      || existsSync(`${this.locatorPath}.tmp`)
      || existsSync(`${this.locatorPath}.bak`)
  }

  /**
   * 根据活动根可用性和迁移记录组装统一结果。
   *
   * @param activeRoot 当前仍生效的数据根。
   * @param locatorFile 已校验的持久化定位文件。
   * @param implicitDefault 是否为定位文件缺失时的隐式默认根。
   * @returns 可供主进程与界面消费的定位结果。
   */
  private createResultForRoot(
    activeRoot: string,
    locatorFile: DataRootLocatorFile | undefined,
    implicitDefault: boolean,
  ): DataRootLocatorResult {
    /** 在不创建目录的前提下检查活动根。 */
    const availability = inspectRootAvailability(activeRoot)
    /** 将持久化迁移记录映射为共享进度合同。 */
    const migration = locatorFile?.migration === undefined
      ? null
      : toMigrationProgress(locatorFile.migration)
    /** 默认根缺失仍可进入 ready，等待调用方显式创建。 */
    const status: DataRootLocatorStatus = migration !== null
      ? 'migration'
      : availability === 'available' || (implicitDefault && availability === 'missing')
        ? 'ready'
        : 'unavailable'

    return {
      status,
      state: {
        ...createPathManagementState(activeRoot, availability, migration),
        ...(locatorFile?.previousRoot === undefined ? {} : { previousRoot: locatorFile.previousRoot }),
        ...(locatorFile?.postCommitCleanup === undefined
          ? {}
          : {
              postCommitCleanup: {
                migrationId: locatorFile.postCommitCleanup.migrationId,
                targetRoot: locatorFile.postCommitCleanup.targetRoot,
                status: locatorFile.postCommitCleanup.error === undefined
                  ? 'pending' as const
                  : 'failed' as const,
                ...(locatorFile.postCommitCleanup.error === undefined
                  ? {}
                  : { error: locatorFile.postCommitCleanup.error }),
              },
            }),
      },
      ...(locatorFile === undefined ? {} : { locatorFile }),
    }
  }
}

/**
 * 检查目录是否存在且具备读、写、进入权限，不创建任何文件。
 *
 * @param root 待检查的数据根绝对路径。
 * @returns 对应的共享可用性状态。
 */
function inspectRootAvailability(root: string): PathManagementState['availability'] {
  if (!existsSync(root)) {
    return 'missing'
  }

  try {
    if (!statSync(root).isDirectory()) {
      return 'unavailable'
    }
    accessSync(root, constants.R_OK | constants.W_OK | constants.X_OK)
    return 'available'
  } catch {
    return 'unavailable'
  }
}

/**
 * 创建不含容量信息的基础路径管理状态。
 *
 * @param activeRoot 当前活动根；定位文件无效且无法恢复时为 null。
 * @param availability 当前可访问性。
 * @param migration 当前迁移进度。
 * @returns 共享路径管理状态。
 */
function createPathManagementState(
  activeRoot: string | null,
  availability: PathManagementState['availability'],
  migration: DataRootMigrationProgress | null,
): PathManagementState {
  return {
    activeRoot,
    availability,
    deviceType: 'unknown',
    migration,
  }
}

/**
 * 将持久化迁移记录转换为界面进度。
 *
 * @param record 已校验的迁移记录。
 * @returns 共享迁移进度。
 */
function toMigrationProgress(record: DataRootMigrationRecord): DataRootMigrationProgress {
  return {
    migrationId: record.id,
    stage: record.stage,
    completedBytes: record.completedBytes,
    totalBytes: record.totalBytes,
    ...(record.error === undefined ? {} : { error: record.error }),
  }
}

/** 迁移主路径只允许向前推进，failed 仅允许回到 copying 重试。 */
function isAllowedMigrationTransition(
  current: DataRootMigrationStage,
  next: DataRootMigrationStage,
): boolean {
  if (current === next) return true
  if (next === 'failed') return current !== 'switching'
  if (current === 'failed') return next === 'copying'
  const order: DataRootMigrationStage[] = ['pending', 'copying', 'verifying', 'rebasing', 'switching']
  return order.indexOf(next) === order.indexOf(current) + 1
}
