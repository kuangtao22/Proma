import { accessSync, constants, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'
import { PATH_MANAGEMENT_IPC_CHANNELS } from '@proma/shared'
import type {
  DataRootMigrationProgress,
  DataRootStartupMode,
  PathManagementState,
  RecoverDataRootInput,
} from '@proma/shared'
import { DataRootLocator } from './data-root-locator'
import type { DataRootLocatorResult } from './data-root-locator'
import { DataRootMigrationCoordinator } from './data-root-migration'
import type { DataRootMigrationGuard } from './data-root-instance-lease'
import { ensurePromaDataRootMarker } from './data-root-marker'

/** 路径 IPC handler 接收 Electron event 和经过 preload 约束的参数。 */
type PathManagementHandler = (event: unknown, ...args: unknown[]) => unknown

/** 路径 IPC 注册所需的最小 Electron 主进程接口。 */
export interface PathManagementIpcRegistrar {
  /** 注册一个 invoke handler。 */
  handle(channel: string, handler: PathManagementHandler): void
  /** 移除旧 handler，支持开发模式热重载。 */
  removeHandler(channel: string): void
}

/** 路径窗口接收迁移进度所需的最小接口。 */
export interface PathManagementWindow {
  /** 判断窗口是否已经销毁。 */
  isDestroyed(): boolean
  /** 向 renderer 推送 typed 迁移进度。 */
  webContents: { send(channel: string, progress: DataRootMigrationProgress): void }
}

/** Electron 应用重启与退出的最小接口。 */
export interface PathManagementApp {
  /** 请求 Electron 在本进程退出后重启。 */
  relaunch(): void
  /** 立即进入应用退出流程。 */
  quit(): void
}

/** 系统目录选择器的最小返回结构。 */
export interface PathManagementDialog {
  /** 选择一个目标数据根目录。 */
  showOpenDialog(options: { properties: ['openDirectory', 'createDirectory'] }): Promise<{
    canceled: boolean
    filePaths: string[]
  }>
}

/** 系统文件管理器能力。 */
export interface PathManagementShell {
  /** 在系统文件管理器中打开目录。 */
  openPath(path: string): Promise<string>
}

/** 迁移协调器暴露给 IPC 的稳定最小合同。 */
export interface PathManagementCoordinator {
  /** 返回 locator 与迁移的公开状态。 */
  getStatus(): PathManagementState
  /** 创建已完成预检的迁移计划。 */
  createPlan(targetRoot: string): Promise<DataRootMigrationProgress>
  /** 执行当前 pending 迁移。 */
  runPending(onProgress?: (progress: DataRootMigrationProgress) => void): Promise<void>
  /** 从持久化断点继续迁移。 */
  resumePending(onProgress?: (progress: DataRootMigrationProgress) => void): Promise<void>
  /** 取消尚未切换的迁移。 */
  cancel(): Promise<void>
}

/** 注册路径管理通道所需依赖。 */
export interface RegisterPathManagementIpcOptions {
  /** 当前启动隔离模式。 */
  mode: DataRootStartupMode
  /** 可测试的 ipcMain 最小接口。 */
  ipc: PathManagementIpcRegistrar
  /** Electron 应用生命周期接口。 */
  app: PathManagementApp
  /** 获取当前全部窗口，用于广播进度。 */
  getAllWindows: () => PathManagementWindow[]
  /** 可选目录选择器；测试与无 UI 环境可省略。 */
  dialog?: PathManagementDialog
  /** 可选系统文件管理器；测试与无 UI 环境可省略。 */
  shell?: PathManagementShell
  /** 注入协调器，测试可避免真实磁盘。 */
  coordinator?: PathManagementCoordinator
  /** 正常模式迁移前检查 Agent 与 Automation 是否活跃。 */
  hasActiveTasks?: () => boolean
  /** 正常模式迁移前检查是否存在共享数据根的其他实例。 */
  hasOtherPromaInstance?: () => boolean
  /** 取得跨 dev/prod 共享的迁移 intent，阻止新 normal 实例进入。 */
  acquireMigrationGuard?: () => DataRootMigrationGuard
  /** 测试可注入独立 home；生产固定使用系统 home。 */
  homeDir?: string
}

/** 进程级 locator 延迟创建，模块导入本身不读取文件系统。 */
let defaultLocator: DataRootLocator | null = null
/** 进程级迁移协调器延迟创建，避免 recovery 模式提前执行 cleanup。 */
let defaultCoordinator: DataRootMigrationCoordinator | null = null

/** 返回进程级固定 locator，供 bootstrap 在所有业务初始化前检查。 */
export function getDefaultDataRootLocator(): DataRootLocator {
  if (defaultLocator === null) defaultLocator = new DataRootLocator({ homeDir: homedir() })
  return defaultLocator
}

/** 根据无副作用 locator 结果选择启动模式，迁移记录优先于可用性。 */
export function resolveDataRootStartupMode(result: DataRootLocatorResult): DataRootStartupMode {
  if (result.status === 'migration' || result.state.migration !== null) return 'data-root-migration'
  if (result.status === 'unavailable' || result.status === 'invalid') return 'data-root-recovery'
  return 'normal'
}

/** 注册当前启动模式允许的路径管理 IPC，并返回实际注册通道供测试审计。 */
export function registerPathManagementIpcHandlers(
  options: RegisterPathManagementIpcOptions,
): string[] {
  /** 当前模式共用的 locator；测试 home 使用独立实例。 */
  const locator = options.homeDir === undefined
    ? getDefaultDataRootLocator()
    : new DataRootLocator({ homeDir: options.homeDir })
  /** 当前模式按需创建的迁移协调器；recovery 全程不得触碰。 */
  let coordinator: PathManagementCoordinator | null = null
  /** 仅 normal/migration handler 调用，避免 recovery 注册阶段自动重试 cleanup。 */
  const getCoordinator = (): PathManagementCoordinator => {
    if (coordinator === null) coordinator = options.coordinator ?? getDefaultCoordinator(locator)
    return coordinator
  }
  /** 本次实际注册的通道，防止迁移模式意外暴露业务 IPC。 */
  const registeredChannels: string[] = []
  /** 注册前先移除同名 handler，兼容 Electron 开发热重载。 */
  const register = (channel: string, handler: PathManagementHandler): void => {
    options.ipc.removeHandler(channel)
    options.ipc.handle(channel, handler)
    registeredChannels.push(channel)
  }
  /** 向仍存活的路径窗口广播进度。 */
  const broadcastProgress = (progress: DataRootMigrationProgress): void => {
    for (const window of options.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(PATH_MANAGEMENT_IPC_CHANNELS.PROGRESS, progress)
    }
  }
  /** 同一调用栈请求重启并退出，不留下 setImmediate 竞态窗口。 */
  const relaunchNow = (): void => {
    options.app.relaunch()
    options.app.quit()
  }
  /** 使用新 locator 重读磁盘，避免 recovery 页拿到启动时缓存。 */
  const inspectFresh = (): DataRootLocatorResult => new DataRootLocator({
    homeDir: options.homeDir ?? homedir(),
  }).inspect()

  register(PATH_MANAGEMENT_IPC_CHANNELS.GET_STATE, () => (
    options.mode === 'data-root-recovery' ? inspectFresh().state : getCoordinator().getStatus()
  ))
  register(PATH_MANAGEMENT_IPC_CHANNELS.PICK_DATA_ROOT, async () => {
    if (!options.dialog) throw new Error('当前环境不支持选择数据根目录')
    /** 用户通过系统对话框选择的目录结果。 */
    const result = await options.dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    return result.canceled ? null : result.filePaths[0] ?? null
  })
  register(PATH_MANAGEMENT_IPC_CHANNELS.GET_DATA_ROOT_MIGRATION_STATUS, () => {
    /** recovery 直接读取 locator，其他模式复用协调器的 cleanup 重试结果。 */
    const state = options.mode === 'data-root-recovery'
      ? inspectFresh().state
      : getCoordinator().getStatus()
    return {
      migration: state.migration,
      ...(state.postCommitCleanup === undefined ? {} : { postCommitCleanup: state.postCommitCleanup }),
    }
  })

  if (options.mode === 'normal') {
    register(PATH_MANAGEMENT_IPC_CHANNELS.START_DATA_ROOT_MIGRATION, async (_event, targetRoot) => {
      if (typeof targetRoot !== 'string') throw new Error('目标数据根必须是字符串')
      assertMigrationCanStart(options)
      /** intent guard 关闭其他 normal 实例的新入口，直到当前进程退出。 */
      const migrationGuard = options.acquireMigrationGuard?.()
      try {
        // 取得 intent 后二次预检，排除 intent 竞争窗口内进入的实例与任务。
        assertMigrationCanStart(options)
        await getCoordinator().createPlan(targetRoot)
        try {
          // createPlan 的磁盘预检会让出事件循环；落盘后复检并撤销期间新出现的任务。
          assertMigrationCanStart(options)
        } catch (error) {
          await getCoordinator().cancel()
          throw error
        }
        // Promise continuation 在处理下一个 IPC 前执行，计划写入后不再开放新的任务事件循环。
        relaunchNow()
      } catch (error) {
        migrationGuard?.release()
        throw error
      }
    })
  } else if (options.mode === 'data-root-migration') {
    register(PATH_MANAGEMENT_IPC_CHANNELS.RESUME_DATA_ROOT_MIGRATION, async () => {
      await getCoordinator().resumePending(broadcastProgress)
      relaunchNow()
    })
    register(PATH_MANAGEMENT_IPC_CHANNELS.CANCEL_DATA_ROOT_MIGRATION, async () => {
      await getCoordinator().cancel()
      relaunchNow()
    })
  }

  register(PATH_MANAGEMENT_IPC_CHANNELS.RECOVER_DATA_ROOT, (_event, input) => {
    recoverDataRoot(input, options.homeDir ?? homedir(), inspectFresh())
    if (isRecoveryResolved(input, inspectFresh())) relaunchNow()
  })
  register(PATH_MANAGEMENT_IPC_CHANNELS.OPEN_DATA_ROOT, async () => {
    if (!options.shell) throw new Error('当前环境不支持打开数据根目录')
    /** 优先使用新鲜 recovery 状态，普通模式复用协调器状态。 */
    const activeRoot = options.mode === 'data-root-recovery'
      ? inspectFresh().state.activeRoot
      : getCoordinator().getStatus().activeRoot
    if (activeRoot === null) throw new Error('当前没有可打开的数据根目录')
    /** Electron openPath 成功时返回空字符串，失败时返回错误摘要。 */
    const error = await options.shell.openPath(activeRoot)
    if (error) throw new Error(error)
  })
  register(PATH_MANAGEMENT_IPC_CHANNELS.EXIT_APP, () => { options.app.quit() })

  return registeredChannels
}

/** 延迟创建默认协调器，确保 recovery 模式不会触发迁移或 cleanup。 */
function getDefaultCoordinator(locator: DataRootLocator): DataRootMigrationCoordinator {
  if (defaultCoordinator === null) defaultCoordinator = new DataRootMigrationCoordinator({ locator })
  return defaultCoordinator
}

/** 正常模式迁移计划写入前检查全部运行时互斥条件。 */
function assertMigrationCanStart(options: RegisterPathManagementIpcOptions): void {
  if (options.hasActiveTasks?.() === true) throw new Error('仍有 Agent 或 Automation 正在运行，无法迁移数据根')
  if (options.hasOtherPromaInstance?.() === true) throw new Error('另一个 Proma 实例正在使用数据根，无法迁移')
}

/** 执行无普通业务依赖的数据根恢复动作。 */
function recoverDataRoot(input: unknown, homeDir: string, current: DataRootLocatorResult): void {
  if (!isRecoverDataRootInput(input)) throw new Error('数据根恢复请求无效')
  if (input.action === 'recheck') return
  if (current.state.postCommitCleanup !== undefined) {
    throw new Error('迁移已提交但仍待清理，请恢复当前目标盘后重新检测；此时不能重新定位或切回旧根')
  }
  /** 恢复写入必须基于当前磁盘 locator，而不是启动缓存。 */
  const locator = new DataRootLocator({ homeDir })
  /** 用户重新定位或切回的候选根目录。 */
  const candidateRoot = input.action === 'relocate' ? input.selectedRoot : current.state.previousRoot
  if (!candidateRoot) throw new Error(input.action === 'relocate' ? '请选择新的数据根目录' : '没有可切回的旧数据根')
  assertAvailableDirectory(candidateRoot)
  ensurePromaDataRootMarker(candidateRoot)
  /** 当前离线根保留为 previousRoot，便于用户在设备恢复后再次定位。 */
  const unavailableRoot = current.state.activeRoot
  locator.write({
    version: 1,
    activeRoot: resolve(candidateRoot),
    ...(unavailableRoot === null ? {} : { previousRoot: unavailableRoot }),
  })
}

/** 判断恢复动作完成后是否已经可以回到 normal 模式。 */
function isRecoveryResolved(input: unknown, latest: DataRootLocatorResult): boolean {
  return isRecoverDataRootInput(input)
    && resolveDataRootStartupMode(latest) === 'normal'
}

/** 运行时校验 renderer 传入的恢复请求。 */
function isRecoverDataRootInput(input: unknown): input is RecoverDataRootInput {
  if (typeof input !== 'object' || input === null) return false
  /** renderer 输入按 unknown 字段逐项校验。 */
  const value = input as { action?: unknown; selectedRoot?: unknown }
  return (value.action === 'recheck' || value.action === 'relocate' || value.action === 'restore-previous')
    && (value.selectedRoot === undefined || typeof value.selectedRoot === 'string')
}

/** 验证候选数据根为具备读写进入权限的绝对目录。 */
function assertAvailableDirectory(root: string): void {
  if (!isAbsolute(root)) throw new Error('数据根必须是绝对路径')
  try {
    if (!statSync(root).isDirectory()) throw new Error('数据根必须是目录')
    accessSync(root, constants.R_OK | constants.W_OK | constants.X_OK)
  } catch (error) {
    if (error instanceof Error && error.message === '数据根必须是目录') throw error
    throw new Error('所选数据根当前不可读写', { cause: error })
  }
}
