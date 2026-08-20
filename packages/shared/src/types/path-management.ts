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
}

/** 数据根不可用时允许用户选择的恢复动作。 */
export type DataRootRecoveryAction = 'recheck' | 'relocate' | 'restore-previous'

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

/** 位于用户 home 下、独立于可迁移数据根的固定定位文件。 */
export interface DataRootLocatorFile {
  version: 1
  activeRoot: string
  previousRoot?: string
  migration?: DataRootMigrationRecord
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
  PROGRESS: 'path-management:progress',
} as const
