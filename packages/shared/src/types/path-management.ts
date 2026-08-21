/** 数据根当前可访问性。 */
export type DataRootAvailability = 'available' | 'missing' | 'unavailable' | 'invalid'

/** 数据根所在存储设备的系统分类。 */
export type DataRootDeviceType = 'local' | 'removable' | 'network' | 'unknown'

/** 数据根占用空间扫描状态。 */
export type DataRootOccupiedStatus = 'loading' | 'ready' | 'unavailable'

/** 占用扫描可公开给界面的稳定错误分类。 */
export type DataRootOccupiedIssueCode =
  | 'SCAN_FAILED'
  | 'SCAN_LIMIT_EXCEEDED'
  | 'SCAN_TIMEOUT'
  | 'SCAN_CANCELLED'

/** 容量查询问题，与占用扫描诊断独立。 */
export interface DataRootCapacityIssue {
  code: 'CAPACITY_UNAVAILABLE'
  message: string
}

/** 占用扫描问题，不暴露底层文件路径或系统错误详情。 */
export interface DataRootOccupiedIssue {
  code: DataRootOccupiedIssueCode
  message: string
}

/** 独立于卷容量查询的占用空间结果。 */
export interface DataRootOccupiedStorage {
  occupiedBytes?: number
  occupiedStatus: Exclude<DataRootOccupiedStatus, 'loading'>
  occupiedIssue?: DataRootOccupiedIssue
}

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

/** 项目路径迁移从预检到完成的稳定执行阶段。 */
export type WorkspaceRelocationStage =
  | 'preflight'
  | 'copying'
  | 'verifying'
  | 'committing'
  | 'failed'
  | 'completed'

/** 当前允许占用工作区独占锁的操作类型。 */
export type WorkspaceOperationKind = 'relocation'

/** 启动项目路径迁移的共享请求。 */
export interface StartWorkspaceRelocationInput {
  workspaceId: string
  /**
   * 主进程 handler 只能接受原生选择器已授权并在执行前重新验证的路径，
   * 不得信任 renderer 直接传入的任意字符串。
   */
  targetRoot: string
  /** 原生目录选择器签发、只能消费一次的服务端授权。 */
  selectionId: string
  /** 授权用途，迁移与离线重定位不可交叉复用。 */
  purpose: 'relocation'
}

/** 继续或放弃持久化项目迁移的精确身份。 */
export interface WorkspaceRelocationRecoveryInput {
  workspaceId: string
  operationId: string
}

/** 项目目录选择器支持的两种互斥用途。 */
export type WorkspaceTargetPurpose = 'relocation' | 'relink'

/** 请求主进程打开项目目标目录选择器。 */
export interface PickWorkspaceTargetInput {
  workspaceId: string
  purpose: WorkspaceTargetPurpose
}

/** 主进程针对当前窗口签发的单次项目目标授权。 */
export interface WorkspaceTargetSelection extends PickWorkspaceTargetInput {
  selectionId: string
  targetRoot: string
}

/** 项目迁移预检返回给确认对话框的容量和路径信息。 */
export interface WorkspaceRelocationPreview {
  operationId: string
  workspaceId: string
  workspaceSlug: string
  sourceRoot: string
  targetRoot: string
  totalBytes: number
  remainingBytes: number
  availableBytes: number
  kind: 'managed' | 'external'
}

/** 提供给界面的项目路径迁移进度。 */
export interface WorkspaceRelocationProgress {
  operationId: string
  workspaceId: string
  stage: WorkspaceRelocationStage
  completedBytes: number
  totalBytes: number
  /** 该迁移是否仍由当前主进程持有活动控制器。 */
  active?: boolean
  currentRelativePath?: string
  error?: string
}

/** 路径管理界面使用的单个项目路径状态。 */
export interface WorkspacePathState {
  workspaceId: string
  name: string
  sourceRoot: string
  kind: 'managed' | 'external'
  availability: 'available' | 'missing' | 'unavailable'
  relocation: WorkspaceRelocationProgress | null
}

/** 路径管理界面与主进程共享的当前状态。 */
export interface PathManagementState {
  activeRoot: string | null
  previousRoot?: string
  availability: DataRootAvailability
  deviceType: DataRootDeviceType
  occupiedBytes?: number
  occupiedStatus?: DataRootOccupiedStatus
  capacityIssue?: DataRootCapacityIssue
  occupiedIssue?: DataRootOccupiedIssue
  availableBytes?: number
  migration: DataRootMigrationProgress | null
  postCommitCleanup?: DataRootPostCommitCleanupProgress
  /**
   * normal settings 模式后续由 Task 4 填充；migration/recovery 轻量窗口不加载业务工作区，
   * 避免状态生产者为了展示离线数据根恢复界面而访问不可用的数据根。
   */
  workspaces?: WorkspacePathState[]
}

/** 只读目标预检允许公开给用户处理的稳定错误分类。 */
export type DataRootMigrationPreviewBlockerCode =
  | 'INVALID_SOURCE'
  | 'UNSAFE_TARGET'
  | 'TARGET_NOT_WRITABLE'
  | 'TARGET_NOT_EMPTY'
  | 'INSUFFICIENT_SPACE'

/** 只读目标预检发现的阻断项。 */
export interface DataRootMigrationPreviewBlocker {
  code: DataRootMigrationPreviewBlockerCode
  message: string
}

/** 用户确认迁移前展示的目标卷与容量信息。 */
export interface DataRootMigrationPreview {
  targetRoot: string
  deviceType: DataRootDeviceType
  availableBytes?: number
  requiredBytes: number
  blockers: DataRootMigrationPreviewBlocker[]
}

/** 主进程系统选择器签发的单次迁移目标授权。 */
export interface DataRootSelection {
  selectionId: string
  targetRoot: string
}

/** preview/start 必须原样回传的服务端选择授权。 */
export type DataRootMigrationSelectionInput = DataRootSelection

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

/** 设置页允许打开的数据根位置，禁止 renderer 传入任意文件系统路径。 */
export type OpenDataRootTarget = 'current' | 'previous'

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
  GET_DATA_ROOT_OCCUPIED_STORAGE: 'path-management:get-data-root-occupied-storage',
  PICK_DATA_ROOT: 'path-management:pick-data-root',
  PREVIEW_DATA_ROOT_MIGRATION: 'path-management:preview-data-root-migration',
  START_DATA_ROOT_MIGRATION: 'path-management:start-data-root-migration',
  GET_DATA_ROOT_MIGRATION_STATUS: 'path-management:get-data-root-migration-status',
  RESUME_DATA_ROOT_MIGRATION: 'path-management:resume-data-root-migration',
  CANCEL_DATA_ROOT_MIGRATION: 'path-management:cancel-data-root-migration',
  PICK_WORKSPACE_TARGET: 'path-management:pick-workspace-target',
  PREVIEW_WORKSPACE_RELOCATION: 'path-management:preview-workspace-relocation',
  START_WORKSPACE_RELOCATION: 'path-management:start-workspace-relocation',
  GET_WORKSPACE_RELOCATION_STATUS: 'path-management:get-workspace-relocation-status',
  CANCEL_WORKSPACE_RELOCATION: 'path-management:cancel-workspace-relocation',
  RESUME_WORKSPACE_RELOCATION: 'path-management:resume-workspace-relocation',
  ABANDON_WORKSPACE_RELOCATION: 'path-management:abandon-workspace-relocation',
  RELINK_WORKSPACE: 'path-management:relink-workspace',
  WORKSPACE_RELOCATION_PROGRESS: 'path-management:workspace-relocation-progress',
  RECOVER_DATA_ROOT: 'path-management:recover-data-root',
  OPEN_DATA_ROOT: 'path-management:open-data-root',
  EXIT_APP: 'path-management:exit-app',
  PROGRESS: 'path-management:progress',
} as const
