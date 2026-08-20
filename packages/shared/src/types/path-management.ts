/** 数据根当前可访问性。 */
export type DataRootAvailability = 'available' | 'missing' | 'unavailable' | 'invalid'

/** 可恢复迁移任务的执行阶段。 */
export type DataRootMigrationStage = 'pending' | 'copying' | 'verifying' | 'rebasing' | 'switching' | 'failed'

/** 提供给界面的数据根迁移进度。 */
export interface DataRootMigrationProgress {
  migrationId: string
  stage: DataRootMigrationStage
  completedBytes: number
  totalBytes: number
  currentRelativePath?: string
  error?: string
}

/** 路径管理界面与主进程共享的当前状态。 */
export interface PathManagementState {
  activeRoot: string | null
  previousRoot?: string
  availability: DataRootAvailability
  deviceType: 'local' | 'removable' | 'network' | 'unknown'
  occupiedBytes?: number
  availableBytes?: number
  migration: DataRootMigrationProgress | null
  postCommitCleanup?: DataRootPostCommitCleanupProgress
}

/** 已提交迁移仍待完成的 sidecar 清理状态。 */
export interface DataRootPostCommitCleanupProgress {
  migrationId: string
  targetRoot: string
  status: 'pending' | 'failed'
  error?: string
}

/** 迁移与提交后清理的完整状态，避免 cleanup-only 被误判为无任务。 */
export interface DataRootMigrationStatus {
  migration: DataRootMigrationProgress | null
  postCommitCleanup?: DataRootPostCommitCleanupProgress
}

/** 数据根不可用时允许用户选择的恢复动作。 */
export type DataRootRecoveryAction = 'recheck' | 'relocate' | 'restore-previous'

/** Electron 启动时根据固定 locator 选择的业务隔离模式。 */
export type DataRootStartupMode = 'normal' | 'data-root-migration' | 'data-root-recovery'

/** 数据根恢复请求。 */
export interface RecoverDataRootInput {
  action: DataRootRecoveryAction
  selectedRoot?: string
}

/** 固定定位文件中持久化的可恢复迁移记录。 */
export interface DataRootMigrationRecord {
  id: string
  sourceRoot: string
  targetRoot: string
  stage: DataRootMigrationStage
  completedBytes: number
  totalBytes: number
  startedAt: number
  updatedAt: number
  error?: string
}

/** 数据根已切换后仍待完成的幂等清理意图。 */
export interface DataRootPostCommitCleanupRecord {
  migrationId: string
  targetRoot: string
  error?: string
}

/** 位于用户 home 下、独立于可迁移数据根的固定定位文件。 */
export interface DataRootLocatorFile {
  version: 1
  activeRoot: string
  previousRoot?: string
  migration?: DataRootMigrationRecord
  postCommitCleanup?: DataRootPostCommitCleanupRecord
}

/** 支持的迁移阶段集合，供 Electron 与 CLI 共用运行时 schema。 */
const DATA_ROOT_MIGRATION_STAGES: ReadonlySet<DataRootMigrationStage> = new Set([
  'pending', 'copying', 'verifying', 'rebasing', 'switching', 'failed',
])

/** 浏览器安全地校验 locator v1，不依赖 node:path。 */
export function isDataRootLocatorFile(value: unknown): value is DataRootLocatorFile {
  if (!isRecord(value) || value.version !== 1 || !isPortableAbsolutePath(value.activeRoot)) return false
  if (value.previousRoot !== undefined && !isPortableAbsolutePath(value.previousRoot)) return false
  if (value.migration !== undefined) {
    if (!isDataRootMigrationRecord(value.migration) || value.migration.sourceRoot !== value.activeRoot) return false
  }
  if (value.postCommitCleanup !== undefined) {
    if (value.migration !== undefined || !isDataRootPostCommitCleanupRecord(value.postCommitCleanup)) return false
    if (value.postCommitCleanup.targetRoot !== value.activeRoot) return false
  }
  return true
}

/** 校验可恢复迁移记录的完整数值与路径约束。 */
function isDataRootMigrationRecord(value: unknown): value is DataRootMigrationRecord {
  if (!isRecord(value)) return false
  return isNonEmptyString(value.id)
    && isPortableAbsolutePath(value.sourceRoot)
    && isPortableAbsolutePath(value.targetRoot)
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

/** cleanup 记录只接受完整且无额外字段的固定 schema。 */
function isDataRootPostCommitCleanupRecord(value: unknown): value is DataRootPostCommitCleanupRecord {
  if (!isRecord(value)) return false
  const keys = Object.keys(value).sort()
  const hasError = value.error !== undefined
  const expectedKeys = hasError ? ['error', 'migrationId', 'targetRoot'] : ['migrationId', 'targetRoot']
  return keys.length === expectedKeys.length
    && keys.every((key, index) => key === expectedKeys[index])
    && isNonEmptyString(value.migrationId)
    && isPortableAbsolutePath(value.targetRoot)
    && (!hasError || isNonEmptyString(value.error))
}

/** 识别 POSIX、Windows drive、反斜杠 UNC 与 slash UNC 绝对路径。 */
function isPortableAbsolutePath(value: unknown): value is string {
  if (!isNonEmptyString(value)) return false
  return value.startsWith('/')
    || /^[a-zA-Z]:[\\/]/.test(value)
    || /^\\\\[^\\/]+[\\/][^\\/]+/.test(value)
}

/** 判断 unknown 是否为普通 JSON 对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 判断 unknown 是否为非空字符串。 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/** 判断 unknown 是否为有限非负数。 */
function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/** 路径管理四层 IPC 合同使用的稳定通道名。 */
export const PATH_MANAGEMENT_IPC_CHANNELS = {
  GET_STATE: 'path-management:get-state',
  PICK_DATA_ROOT: 'path-management:pick-data-root',
  START_DATA_ROOT_MIGRATION: 'path-management:start-data-root-migration',
  GET_DATA_ROOT_MIGRATION_STATUS: 'path-management:get-data-root-migration-status',
  RESUME_DATA_ROOT_MIGRATION: 'path-management:resume-data-root-migration',
  CANCEL_DATA_ROOT_MIGRATION: 'path-management:cancel-data-root-migration',
  RECOVER_DATA_ROOT: 'path-management:recover-data-root',
  OPEN_DATA_ROOT: 'path-management:open-data-root',
  EXIT_APP: 'path-management:exit-app',
  PROGRESS: 'path-management:progress',
} as const
