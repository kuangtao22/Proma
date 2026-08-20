import { PATH_MANAGEMENT_IPC_CHANNELS } from '@proma/shared'
import type {
  DataRootMigrationProgress,
  PathManagementState,
  RecoverDataRootInput,
} from '@proma/shared'
import type { IpcRendererEvent } from 'electron'

/** 路径 preload adapter 依赖的最小 ipcRenderer 接口。 */
export interface PathManagementPreloadIpc {
  /** 调用主进程路径 handler。 */
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  /** 注册主进程事件 listener。 */
  on(channel: string, listener: (event: IpcRendererEvent, ...args: unknown[]) => void): void
  /** 移除同一 listener 引用。 */
  removeListener(channel: string, listener: (event: IpcRendererEvent, ...args: unknown[]) => void): void
}

/** 暴露给 renderer 的完整路径管理 API。 */
export interface PathManagementPreloadApi {
  /** 获取当前路径管理状态。 */
  getPathManagementState: () => Promise<PathManagementState>
  /** 使用系统选择器选择数据根目录。 */
  pickDataRoot: () => Promise<string | null>
  /** 创建迁移计划并请求重启。 */
  startDataRootMigration: (targetRoot: string) => Promise<void>
  /** 获取当前迁移进度。 */
  getDataRootMigrationStatus: () => Promise<DataRootMigrationProgress | null>
  /** 从已校验断点继续迁移。 */
  resumeDataRootMigration: () => Promise<void>
  /** 取消尚未切换的数据根迁移计划。 */
  cancelDataRootMigration: () => Promise<void>
  /** 执行离线数据根恢复动作。 */
  recoverDataRoot: (input: RecoverDataRootInput) => Promise<void>
  /** 在系统文件管理器打开当前数据根。 */
  openDataRoot: () => Promise<void>
  /** 退出轻量路径管理窗口。 */
  exitDataRootManagement: () => Promise<void>
  /** 订阅数据根迁移进度。 */
  onDataRootMigrationProgress: (callback: (progress: DataRootMigrationProgress) => void) => () => void
}

/** 创建只转发共享 typed 通道的路径 preload adapter。 */
export function createPathManagementPreloadApi(ipc: PathManagementPreloadIpc): PathManagementPreloadApi {
  return {
    getPathManagementState: () => ipc.invoke(
      PATH_MANAGEMENT_IPC_CHANNELS.GET_STATE,
    ) as Promise<PathManagementState>,
    pickDataRoot: () => ipc.invoke(
      PATH_MANAGEMENT_IPC_CHANNELS.PICK_DATA_ROOT,
    ) as Promise<string | null>,
    startDataRootMigration: (targetRoot) => ipc.invoke(
      PATH_MANAGEMENT_IPC_CHANNELS.START_DATA_ROOT_MIGRATION,
      targetRoot,
    ) as Promise<void>,
    getDataRootMigrationStatus: () => ipc.invoke(
      PATH_MANAGEMENT_IPC_CHANNELS.GET_DATA_ROOT_MIGRATION_STATUS,
    ) as Promise<DataRootMigrationProgress | null>,
    resumeDataRootMigration: () => ipc.invoke(
      PATH_MANAGEMENT_IPC_CHANNELS.RESUME_DATA_ROOT_MIGRATION,
    ) as Promise<void>,
    cancelDataRootMigration: () => ipc.invoke(
      PATH_MANAGEMENT_IPC_CHANNELS.CANCEL_DATA_ROOT_MIGRATION,
    ) as Promise<void>,
    recoverDataRoot: (input) => ipc.invoke(
      PATH_MANAGEMENT_IPC_CHANNELS.RECOVER_DATA_ROOT,
      input,
    ) as Promise<void>,
    openDataRoot: () => ipc.invoke(PATH_MANAGEMENT_IPC_CHANNELS.OPEN_DATA_ROOT) as Promise<void>,
    exitDataRootManagement: () => ipc.invoke(PATH_MANAGEMENT_IPC_CHANNELS.EXIT_APP) as Promise<void>,
    onDataRootMigrationProgress: (callback) => {
      /** Electron event 保留在 preload 内，只向 renderer 传递 typed progress。 */
      const listener = (_event: IpcRendererEvent, ...args: unknown[]): void => {
        callback(args[0] as DataRootMigrationProgress)
      }
      ipc.on(PATH_MANAGEMENT_IPC_CHANNELS.PROGRESS, listener)
      return () => { ipc.removeListener(PATH_MANAGEMENT_IPC_CHANNELS.PROGRESS, listener) }
    },
  }
}
