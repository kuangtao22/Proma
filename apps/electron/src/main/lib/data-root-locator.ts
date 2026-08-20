import { accessSync, constants, existsSync, mkdirSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
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

/** 支持的迁移阶段集合，用于运行时严格校验 JSON。 */
const DATA_ROOT_MIGRATION_STAGES: ReadonlySet<DataRootMigrationStage> = new Set([
  'pending',
  'copying',
  'verifying',
  'rebasing',
  'switching',
  'failed',
])

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

/**
 * 严格校验固定定位文件的版本、绝对路径和迁移字段。
 *
 * @param value 从 JSON 恢复链读取的未知数据。
 * @returns 数据符合 v1 定位合同的类型判断结果。
 */
function isDataRootLocatorFile(value: unknown): value is DataRootLocatorFile {
  if (!isRecord(value) || value.version !== 1 || !isAbsolutePath(value.activeRoot)) {
    return false
  }
  if (value.previousRoot !== undefined && !isAbsolutePath(value.previousRoot)) {
    return false
  }
  if (value.migration !== undefined) {
    if (!isDataRootMigrationRecord(value.migration) || value.migration.sourceRoot !== value.activeRoot) {
      return false
    }
  }
  return true
}

/**
 * 严格校验可恢复迁移记录。
 *
 * @param value 待校验的未知迁移数据。
 * @returns 数据符合迁移记录合同的类型判断结果。
 */
function isDataRootMigrationRecord(value: unknown): value is DataRootMigrationRecord {
  if (!isRecord(value)) {
    return false
  }

  return isNonEmptyString(value.id)
    && isAbsolutePath(value.sourceRoot)
    && isAbsolutePath(value.targetRoot)
    && typeof value.stage === 'string'
    && DATA_ROOT_MIGRATION_STAGES.has(value.stage as DataRootMigrationStage)
    && isNonNegativeFiniteNumber(value.completedBytes)
    && isNonNegativeFiniteNumber(value.totalBytes)
    && value.completedBytes <= value.totalBytes
    && isNonNegativeFiniteNumber(value.startedAt)
    && isNonNegativeFiniteNumber(value.updatedAt)
    && value.updatedAt >= value.startedAt
    && (value.error === undefined || typeof value.error === 'string')
}

/**
 * 判断未知值是否为可安全按键访问的对象。
 *
 * @param value 待判断值。
 * @returns 非空且非数组对象时返回 true。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 判断未知值是否为非空字符串。
 *
 * @param value 待判断值。
 * @returns 去除首尾空白后仍有内容时返回 true。
 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * 判断未知值是否为绝对路径。
 *
 * @param value 待判断值。
 * @returns 非空绝对路径时返回 true。
 */
function isAbsolutePath(value: unknown): value is string {
  return isNonEmptyString(value) && isAbsolute(value)
}

/**
 * 判断未知值是否为有限非负数。
 *
 * @param value 待判断值。
 * @returns 有限且不小于零时返回 true。
 */
function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}
