import { PATH_MANAGEMENT_IPC_CHANNELS } from '@proma/shared'
import type {
  DataRootMigrationProgress,
  DataRootMigrationPreview,
  DataRootMigrationSelectionInput,
  DataRootMigrationStatus,
  DataRootOccupiedStorage,
  DataRootSelection,
  OpenDataRootTarget,
  PickWorkspaceTargetInput,
  PathManagementState,
  RecoverDataRootInput,
  WorkspaceRelocationPreview,
  WorkspaceRelocationProgress,
  WorkspaceRelocationRecoveryInput,
  WorkspaceTargetSelection,
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

/** 普通主窗口可用的路径管理 API。 */
export interface NormalPathManagementPreloadApi {
  /** 获取当前路径管理状态。 */
  getPathManagementState: () => Promise<PathManagementState>
  /** 独立刷新当前数据根占用空间，不阻塞首屏卷信息。 */
  getDataRootOccupiedStorage: () => Promise<DataRootOccupiedStorage>
  /** 使用系统选择器选择迁移目标目录。 */
  pickDataRoot: () => Promise<DataRootSelection | null>
  /** 只读预检系统选择器刚返回的目标目录。 */
  previewDataRootMigration: (input: DataRootMigrationSelectionInput) => Promise<DataRootMigrationPreview>
  /** 创建迁移计划并请求重启。 */
  startDataRootMigration: (input: DataRootMigrationSelectionInput) => Promise<void>
  /** 获取当前迁移与提交后清理状态。 */
  getDataRootMigrationStatus: () => Promise<DataRootMigrationStatus>
  /** 在系统文件管理器打开 locator 中的当前或上次数据根。 */
  openDataRoot: (target: OpenDataRootTarget) => Promise<void>
  /** 订阅数据根迁移进度。 */
  onDataRootMigrationProgress: (callback: (progress: DataRootMigrationProgress) => void) => () => void
  /** 使用系统选择器签发当前窗口独占的项目目标授权。 */
  pickWorkspaceTarget: (input: PickWorkspaceTargetInput) => Promise<WorkspaceTargetSelection | null>
  /** 只读预检刚选择的迁移目标。 */
  previewWorkspaceRelocation: (input: WorkspaceTargetSelection) => Promise<WorkspaceRelocationPreview>
  /** 启动项目复制、校验与原子引用提交。 */
  startWorkspaceRelocation: (input: WorkspaceTargetSelection) => Promise<WorkspaceRelocationProgress>
  /** 读取指定项目当前的可恢复迁移状态。 */
  getWorkspaceRelocationStatus: (workspaceId: string) => Promise<WorkspaceRelocationProgress | null>
  /** 取消仍处于 copying 的项目迁移。 */
  cancelWorkspaceRelocation: (operationId: string) => Promise<boolean>
  /** 使用持久化 journal 的原路径继续迁移。 */
  resumeWorkspaceRelocation: (input: WorkspaceRelocationRecoveryInput) => Promise<WorkspaceRelocationProgress>
  /** 放弃持久化迁移，仅清理 Proma 管理的恢复元数据。 */
  abandonWorkspaceRelocation: (input: WorkspaceRelocationRecoveryInput) => Promise<void>
  /** 离线项目仅重新绑定已存在目录，不执行复制。 */
  relinkWorkspace: (input: WorkspaceTargetSelection) => Promise<void>
  /** 订阅项目迁移进度并返回 listener 清理函数。 */
  onWorkspaceRelocationProgress: (callback: (progress: WorkspaceRelocationProgress) => void) => () => void
}

/** 迁移专用窗口可用的最小路径管理 API。 */
export interface DataRootMigrationPreloadApi {
  /** 获取当前路径管理状态。 */
  getPathManagementState: () => Promise<PathManagementState>
  /** 从已校验断点继续迁移。 */
  resumeDataRootMigration: () => Promise<void>
  /** 取消尚未切换的数据根迁移计划。 */
  cancelDataRootMigration: () => Promise<void>
  /** 在系统文件管理器打开 locator 中的当前或上次数据根。 */
  openDataRoot: (target: OpenDataRootTarget) => Promise<void>
  /** 退出轻量路径管理窗口。 */
  exitDataRootManagement: () => Promise<void>
  /** 订阅数据根迁移进度。 */
  onDataRootMigrationProgress: (callback: (progress: DataRootMigrationProgress) => void) => () => void
}

/** 恢复专用窗口可用的最小路径管理 API。 */
export interface DataRootRecoveryPreloadApi {
  /** 获取当前路径管理状态。 */
  getPathManagementState: () => Promise<PathManagementState>
  /** 使用系统选择器重新定位数据根。 */
  pickDataRoot: () => Promise<string | null>
  /** 执行离线数据根恢复动作。 */
  recoverDataRoot: (input: RecoverDataRootInput) => Promise<void>
  /** 在系统文件管理器打开 locator 中的当前或上次数据根。 */
  openDataRoot: (target: OpenDataRootTarget) => Promise<void>
  /** 退出轻量路径管理窗口。 */
  exitDataRootManagement: () => Promise<void>
}

/** dedicated preload 根据主进程注入 mode 暴露的 API 联合。 */
export type PathManagementPreloadApi = DataRootMigrationPreloadApi | DataRootRecoveryPreloadApi

/** dedicated 路径窗口允许的两种启动模式。 */
export type DedicatedPathManagementMode = 'data-root-migration' | 'data-root-recovery'

/** 创建普通主窗口路径 API，仅覆盖 normal 主进程 allowlist。 */
export function createNormalPathManagementPreloadApi(
  ipc: PathManagementPreloadIpc,
): NormalPathManagementPreloadApi {
  return {
    getPathManagementState: () => invokePathManagementState(ipc),
    getDataRootOccupiedStorage: () => ipc.invoke(
      PATH_MANAGEMENT_IPC_CHANNELS.GET_DATA_ROOT_OCCUPIED_STORAGE,
    ) as Promise<DataRootOccupiedStorage>,
    pickDataRoot: () => invokePickDataRoot<DataRootSelection>(ipc),
    previewDataRootMigration: (input) => ipc.invoke(
      PATH_MANAGEMENT_IPC_CHANNELS.PREVIEW_DATA_ROOT_MIGRATION,
      input,
    ) as Promise<DataRootMigrationPreview>,
    startDataRootMigration: (input) => ipc.invoke(
      PATH_MANAGEMENT_IPC_CHANNELS.START_DATA_ROOT_MIGRATION,
      input,
    ) as Promise<void>,
    getDataRootMigrationStatus: () => ipc.invoke(
      PATH_MANAGEMENT_IPC_CHANNELS.GET_DATA_ROOT_MIGRATION_STATUS,
    ) as Promise<DataRootMigrationStatus>,
    openDataRoot: (target) => invokeOpenDataRoot(ipc, target),
    onDataRootMigrationProgress: createProgressSubscriber(ipc),
    pickWorkspaceTarget: (input) => ipc.invoke(
      PATH_MANAGEMENT_IPC_CHANNELS.PICK_WORKSPACE_TARGET,
      input,
    ) as Promise<WorkspaceTargetSelection | null>,
    previewWorkspaceRelocation: (input) => ipc.invoke(
      PATH_MANAGEMENT_IPC_CHANNELS.PREVIEW_WORKSPACE_RELOCATION,
      input,
    ) as Promise<WorkspaceRelocationPreview>,
    startWorkspaceRelocation: (input) => ipc.invoke(
      PATH_MANAGEMENT_IPC_CHANNELS.START_WORKSPACE_RELOCATION,
      input,
    ) as Promise<WorkspaceRelocationProgress>,
    getWorkspaceRelocationStatus: (workspaceId) => ipc.invoke(
      PATH_MANAGEMENT_IPC_CHANNELS.GET_WORKSPACE_RELOCATION_STATUS,
      workspaceId,
    ) as Promise<WorkspaceRelocationProgress | null>,
    cancelWorkspaceRelocation: (operationId) => ipc.invoke(
      PATH_MANAGEMENT_IPC_CHANNELS.CANCEL_WORKSPACE_RELOCATION,
      operationId,
    ) as Promise<boolean>,
    resumeWorkspaceRelocation: (input) => ipc.invoke(
      PATH_MANAGEMENT_IPC_CHANNELS.RESUME_WORKSPACE_RELOCATION,
      input,
    ) as Promise<WorkspaceRelocationProgress>,
    abandonWorkspaceRelocation: (input) => ipc.invoke(
      PATH_MANAGEMENT_IPC_CHANNELS.ABANDON_WORKSPACE_RELOCATION,
      input,
    ) as Promise<void>,
    relinkWorkspace: (input) => ipc.invoke(
      PATH_MANAGEMENT_IPC_CHANNELS.RELINK_WORKSPACE,
      input,
    ) as Promise<void>,
    onWorkspaceRelocationProgress: createWorkspaceProgressSubscriber(ipc),
  }
}

/** 创建迁移专用窗口 API，仅覆盖 migration 主进程 allowlist。 */
export function createMigrationPathManagementPreloadApi(
  ipc: PathManagementPreloadIpc,
): DataRootMigrationPreloadApi {
  return {
    getPathManagementState: () => invokePathManagementState(ipc),
    resumeDataRootMigration: () => ipc.invoke(
      PATH_MANAGEMENT_IPC_CHANNELS.RESUME_DATA_ROOT_MIGRATION,
    ) as Promise<void>,
    cancelDataRootMigration: () => ipc.invoke(
      PATH_MANAGEMENT_IPC_CHANNELS.CANCEL_DATA_ROOT_MIGRATION,
    ) as Promise<void>,
    openDataRoot: (target) => invokeOpenDataRoot(ipc, target),
    exitDataRootManagement: () => invokeExitDataRootManagement(ipc),
    onDataRootMigrationProgress: createProgressSubscriber(ipc),
  }
}

/** 创建恢复专用窗口 API，仅覆盖 recovery 主进程 allowlist。 */
export function createRecoveryPathManagementPreloadApi(
  ipc: PathManagementPreloadIpc,
): DataRootRecoveryPreloadApi {
  return {
    getPathManagementState: () => invokePathManagementState(ipc),
    pickDataRoot: () => invokePickDataRoot<string>(ipc),
    recoverDataRoot: (input) => ipc.invoke(
      PATH_MANAGEMENT_IPC_CHANNELS.RECOVER_DATA_ROOT,
      input,
    ) as Promise<void>,
    openDataRoot: (target) => invokeOpenDataRoot(ipc, target),
    exitDataRootManagement: () => invokeExitDataRootManagement(ipc),
  }
}

/** 根据主进程注入的专用窗口 mode 选择精确 API 对象。 */
export function createDedicatedPathManagementPreloadApi(
  mode: DedicatedPathManagementMode,
  ipc: PathManagementPreloadIpc,
): PathManagementPreloadApi {
  return mode === 'data-root-migration'
    ? createMigrationPathManagementPreloadApi(ipc)
    : createRecoveryPathManagementPreloadApi(ipc)
}

/** 调用所有 mode 共用的状态查询通道。 */
function invokePathManagementState(ipc: PathManagementPreloadIpc): Promise<PathManagementState> {
  return ipc.invoke(PATH_MANAGEMENT_IPC_CHANNELS.GET_STATE) as Promise<PathManagementState>
}

/** 调用 normal/recovery 共用的目录选择通道。 */
function invokePickDataRoot<T extends string | DataRootSelection>(ipc: PathManagementPreloadIpc): Promise<T | null> {
  return ipc.invoke(PATH_MANAGEMENT_IPC_CHANNELS.PICK_DATA_ROOT) as Promise<T | null>
}

/** 调用所有 mode 共用的打开数据根通道。 */
function invokeOpenDataRoot(ipc: PathManagementPreloadIpc, target: OpenDataRootTarget): Promise<void> {
  return ipc.invoke(PATH_MANAGEMENT_IPC_CHANNELS.OPEN_DATA_ROOT, target) as Promise<void>
}

/** 调用 dedicated mode 共用的退出通道。 */
function invokeExitDataRootManagement(ipc: PathManagementPreloadIpc): Promise<void> {
  return ipc.invoke(PATH_MANAGEMENT_IPC_CHANNELS.EXIT_APP) as Promise<void>
}

/** 创建只传递 typed progress 并可按原 listener 取消的订阅函数。 */
function createProgressSubscriber(
  ipc: PathManagementPreloadIpc,
): (callback: (progress: DataRootMigrationProgress) => void) => () => void {
  return (callback) => {
    /** Electron event 保留在 preload 内，只向 renderer 传递 typed progress。 */
    const listener = (_event: IpcRendererEvent, ...args: unknown[]): void => {
      callback(args[0] as DataRootMigrationProgress)
    }
    ipc.on(PATH_MANAGEMENT_IPC_CHANNELS.PROGRESS, listener)
    return () => { ipc.removeListener(PATH_MANAGEMENT_IPC_CHANNELS.PROGRESS, listener) }
  }
}

/** 创建只传递项目 typed progress 并可移除原 listener 的订阅函数。 */
function createWorkspaceProgressSubscriber(
  ipc: PathManagementPreloadIpc,
): (callback: (progress: WorkspaceRelocationProgress) => void) => () => void {
  return (callback) => {
    /** Electron event 不跨越 preload 安全边界。 */
    const listener = (_event: IpcRendererEvent, ...args: unknown[]): void => {
      callback(args[0] as WorkspaceRelocationProgress)
    }
    ipc.on(PATH_MANAGEMENT_IPC_CHANNELS.WORKSPACE_RELOCATION_PROGRESS, listener)
    return () => { ipc.removeListener(PATH_MANAGEMENT_IPC_CHANNELS.WORKSPACE_RELOCATION_PROGRESS, listener) }
  }
}
