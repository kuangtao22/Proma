import { accessSync, constants, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'
import { PATH_MANAGEMENT_IPC_CHANNELS } from '@proma/shared'
import type {
  DataRootMigrationPreview,
  DataRootMigrationProgress,
  DataRootMigrationSelectionInput,
  DataRootOccupiedStorage,
  DataRootSelection,
  DataRootStartupMode,
  OpenDataRootTarget,
  PathManagementState,
  RecoverDataRootInput,
} from '@proma/shared'
import { DataRootLocator } from './data-root-locator'
import type { DataRootLocatorResult } from './data-root-locator'
import { DataRootMigrationCoordinator } from './data-root-migration'
import type { DataRootMigrationGuard } from './data-root-instance-lease'
import { ensurePromaDataRootMarker } from './data-root-marker'
import {
  inspectDataRootOccupied,
  inspectDataRootStorageFast,
  invalidateDataRootStorage,
} from './data-root-storage'
import type { DataRootStorageSnapshot } from './data-root-storage'

/** 路径 IPC handler 接收 Electron event 和经过 preload 约束的参数。 */
type PathManagementHandler = (event: unknown, ...args: unknown[]) => unknown

/** 所有 invoke handler 通道；每次按 mode 注册前统一清除旧集合。 */
const PATH_MANAGEMENT_HANDLER_CHANNELS: readonly string[] = [
  PATH_MANAGEMENT_IPC_CHANNELS.GET_STATE,
  PATH_MANAGEMENT_IPC_CHANNELS.GET_DATA_ROOT_OCCUPIED_STORAGE,
  PATH_MANAGEMENT_IPC_CHANNELS.PICK_DATA_ROOT,
  PATH_MANAGEMENT_IPC_CHANNELS.PREVIEW_DATA_ROOT_MIGRATION,
  PATH_MANAGEMENT_IPC_CHANNELS.START_DATA_ROOT_MIGRATION,
  PATH_MANAGEMENT_IPC_CHANNELS.GET_DATA_ROOT_MIGRATION_STATUS,
  PATH_MANAGEMENT_IPC_CHANNELS.RESUME_DATA_ROOT_MIGRATION,
  PATH_MANAGEMENT_IPC_CHANNELS.CANCEL_DATA_ROOT_MIGRATION,
  PATH_MANAGEMENT_IPC_CHANNELS.RECOVER_DATA_ROOT,
  PATH_MANAGEMENT_IPC_CHANNELS.OPEN_DATA_ROOT,
  PATH_MANAGEMENT_IPC_CHANNELS.EXIT_APP,
]

/** 路径 IPC event 必须携带调用方 webContents 身份。 */
interface PathManagementInvokeEvent {
  /** Electron invoke 调用的 renderer webContents。 */
  sender: object
}

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
  /** 只读预检用户刚选择的目标目录。 */
  previewTarget?: (targetRoot: string) => Promise<DataRootMigrationPreview>
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
  /** 动态取得当前模式唯一获授权的 renderer webContents。 */
  getExpectedWebContents: () => PathManagementWindow['webContents'] | null
  /** 可选目录选择器；测试与无 UI 环境可省略。 */
  dialog?: PathManagementDialog
  /** 可选系统文件管理器；测试与无 UI 环境可省略。 */
  shell?: PathManagementShell
  /** 注入协调器，测试可避免真实磁盘。 */
  coordinator?: PathManagementCoordinator
  /** 正常模式迁移前检查 Agent 与 Automation 是否活跃。 */
  hasActiveTasks?: () => boolean
  /** 正常模式迁移前检查是否存在共享数据根的其他实例。 */
  hasOtherPromaInstance?: () => boolean | Promise<boolean>
  /** 取得跨 dev/prod 共享的迁移 intent，阻止新 normal 实例进入。 */
  acquireMigrationGuard?: () => DataRootMigrationGuard | Promise<DataRootMigrationGuard>
  /** 测试可注入独立 home；生产固定使用系统 home。 */
  homeDir?: string
  /** 注入快速卷检查，测试可避免真实 statfs 与设备查询。 */
  inspectStorageFast?: (rootPath: string) => Promise<DataRootStorageSnapshot>
  /** 注入独立占用扫描，测试可精确控制慢扫描。 */
  inspectOccupiedStorage?: (rootPath: string) => Promise<DataRootOccupiedStorage>
  /** 注入服务端随机 selectionId，测试可稳定断言代次。 */
  createSelectionId?: () => string
}

/** normal 窗口内单次目标授权的服务端状态。 */
interface DataRootSelectionState extends DataRootSelection {
  generation: number
  status: 'selected' | 'previewing' | 'previewed' | 'starting'
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
  /** normal 窗口当前仍有效的服务端目标授权。 */
  let currentSelection: DataRootSelectionState | null = null
  /** pick 调用代次，较早对话框晚返回时不得恢复旧授权。 */
  let selectionGeneration = 0
  /** 生产使用密码学随机 UUID，renderer 无法猜测或自造授权。 */
  const createSelectionId = options.createSelectionId ?? randomUUID
  /** mode 可能在开发热重载中变化，先删除全部旧 handler 再建立最小 allowlist。 */
  for (const channel of PATH_MANAGEMENT_HANDLER_CHANNELS) options.ipc.removeHandler(channel)
  /** 注册前先移除同名 handler，兼容 Electron 开发热重载。 */
  const register = (channel: string, handler: PathManagementHandler): void => {
    options.ipc.handle(channel, (event, ...args) => {
      assertExpectedSender(event, options.getExpectedWebContents())
      return handler(event, ...args)
    })
    registeredChannels.push(channel)
  }
  /** 只向当前获授权的路径窗口推送迁移进度。 */
  const broadcastProgress = (progress: DataRootMigrationProgress): void => {
    invalidateDataRootStorage()
    options.getExpectedWebContents()?.send(PATH_MANAGEMENT_IPC_CHANNELS.PROGRESS, progress)
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

  if (options.mode === 'normal') {
    register(PATH_MANAGEMENT_IPC_CHANNELS.GET_STATE, async () => {
      const state = getCoordinator().getStatus()
      if (state.activeRoot === null || state.availability !== 'available') return state
      const storage = await (options.inspectStorageFast ?? inspectDataRootStorageFast)(state.activeRoot)
      return { ...state, ...storage }
    })
    register(PATH_MANAGEMENT_IPC_CHANNELS.GET_DATA_ROOT_OCCUPIED_STORAGE, async () => {
      const state = getCoordinator().getStatus()
      if (state.activeRoot === null || state.availability !== 'available') {
        return {
          occupiedStatus: 'unavailable',
          storageIssue: { code: 'SCAN_FAILED', message: '占用空间暂不可用' },
        } satisfies DataRootOccupiedStorage
      }
      return await (options.inspectOccupiedStorage ?? inspectDataRootOccupied)(state.activeRoot)
    })
    register(PATH_MANAGEMENT_IPC_CHANNELS.PICK_DATA_ROOT, async () => {
      if (!options.dialog) throw new Error('当前环境不支持选择数据根目录')
      /** 新 pick 一开始即使旧 selection 失效，不等待系统对话框返回。 */
      const generation = selectionGeneration + 1
      selectionGeneration = generation
      currentSelection = null
      /** 用户通过系统对话框选择的迁移目标目录。 */
      const result = await options.dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
      if (generation !== selectionGeneration) return null
      const targetRoot = result.canceled ? null : result.filePaths[0] ?? null
      if (targetRoot === null) return null
      if (!isAbsolute(targetRoot)) throw new Error('系统选择器返回的目标数据根不是绝对路径')
      /** 只有当前代次返回时才签发新授权。 */
      const selection: DataRootSelectionState = {
        selectionId: createSelectionId(),
        targetRoot,
        generation,
        status: 'selected',
      }
      currentSelection = selection
      return { selectionId: selection.selectionId, targetRoot: selection.targetRoot }
    })
    register(PATH_MANAGEMENT_IPC_CHANNELS.PREVIEW_DATA_ROOT_MIGRATION, async (_event, rawInput) => {
      const input = assertDataRootSelectionInput(rawInput)
      const selection = requireCurrentSelection(currentSelection, input)
      if (selection.status === 'starting') throw new Error('目标选择正在启动或已消费')
      if (selection.status === 'previewing') throw new Error('目标选择正在预检')
      const previewTarget = getCoordinator().previewTarget
      if (!previewTarget) throw new Error('当前环境不支持预检数据根目录')
      selection.status = 'previewing'
      try {
        const preview = await previewTarget.call(getCoordinator(), selection.targetRoot)
        if (currentSelection !== selection || selection.generation !== selectionGeneration) {
          throw new Error('目标选择已失效')
        }
        if (preview.targetRoot !== selection.targetRoot) throw new Error('预检返回的目标数据根不一致')
        selection.status = preview.blockers.length === 0 ? 'previewed' : 'selected'
        return preview
      } catch (error) {
        if (currentSelection === selection && selection.status === 'previewing') selection.status = 'selected'
        throw error
      }
    })
    register(PATH_MANAGEMENT_IPC_CHANNELS.START_DATA_ROOT_MIGRATION, async (_event, rawInput) => {
      const input = assertDataRootSelectionInput(rawInput)
      const selection = requireCurrentSelection(currentSelection, input)
      if (selection.status === 'selected') throw new Error('目标选择尚未完成预检')
      if (selection.status === 'previewing') throw new Error('目标选择正在预检')
      if (selection.status === 'starting') throw new Error('目标选择正在启动或已消费')
      /** START 是一次性 capability；在第一个 await 前终态消费，任何失败都必须重新 pick 和 preview。 */
      selection.status = 'starting'
      currentSelection = null
      try {
        await assertMigrationCanStart(options)
        /** intent guard 关闭其他 normal 实例的新入口，直到当前进程退出。 */
        const migrationGuard = await options.acquireMigrationGuard?.()
        /** 当前调用使用的协调器；只有实际尝试创建计划后才需要复检 pending。 */
        let migrationCoordinator: PathManagementCoordinator | null = null
        /** 标记 locator 当前是否仍持有 pending，决定当前 normal 进程能否继续。 */
        let migrationPending = false
        /** 安全复检 locator；状态不可读时按仍有 pending 处理，避免继续 normal 服务。 */
        const inspectMigrationPending = (): boolean => {
          if (migrationCoordinator === null) return false
          try {
            return migrationCoordinator.getStatus().migration !== null
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            console.warn(`[路径管理] 无法确认 pending 状态，按迁移仍存在处理: ${message}`)
            return true
          }
        }
        try {
          invalidateDataRootStorage()
          // 取得 intent 后二次预检，排除 intent 竞争窗口内进入的实例与任务。
          await assertMigrationCanStart(options)
          migrationCoordinator = getCoordinator()
          try {
            await migrationCoordinator.createPlan(selection.targetRoot)
            migrationPending = true
            /** plan 成功落盘即消费授权，后续任何重复 start 都无法复用。 */
            if (currentSelection === selection) currentSelection = null
          } catch (error) {
            // createPlan 理论上原子落盘；失败后仍复检，防止异常发生在持久化边界之后。
            migrationPending = inspectMigrationPending()
            throw error
          }
          try {
            // createPlan 的磁盘预检会让出事件循环；落盘后复检并撤销期间新出现的任务。
            await assertMigrationCanStart(options)
          } catch (error) {
            try {
              await migrationCoordinator.cancel()
              migrationPending = inspectMigrationPending()
            } catch (cancelError) {
              // 撤销失败时不能假定 pending 已清除，当前 normal 进程必须退出。
              migrationPending = true
              throw cancelError
            }
            throw error
          }
        } finally {
          /** guard 释放错误；是否允许降级取决于 locator 是否仍有 pending。 */
          let guardReleaseError: unknown = null
          try {
            migrationGuard?.release()
          } catch (error) {
            guardReleaseError = error
          }
          if (migrationPending) {
            if (guardReleaseError !== null) {
              const message = guardReleaseError instanceof Error ? guardReleaseError.message : String(guardReleaseError)
              console.warn(`[路径管理] 迁移 intent 清理失败，将由新进程回收: ${message}`)
            }
            relaunchNow()
          } else if (guardReleaseError !== null) {
            const message = guardReleaseError instanceof Error ? guardReleaseError.message : String(guardReleaseError)
            throw new Error(`迁移计划未创建，但迁移 intent 清理失败；请完全退出所有 Proma 实例后重试。原因: ${message}`)
          }
        }
      } catch (error) {
        throw error
      }
    })
    register(PATH_MANAGEMENT_IPC_CHANNELS.GET_DATA_ROOT_MIGRATION_STATUS, () => {
      const state = getCoordinator().getStatus()
      return {
        migration: state.migration,
        ...(state.postCommitCleanup === undefined ? {} : { postCommitCleanup: state.postCommitCleanup }),
      }
    })
  } else if (options.mode === 'data-root-migration') {
    register(PATH_MANAGEMENT_IPC_CHANNELS.GET_STATE, () => getCoordinator().getStatus())
    register(PATH_MANAGEMENT_IPC_CHANNELS.RESUME_DATA_ROOT_MIGRATION, async () => {
      invalidateDataRootStorage()
      try {
        await getCoordinator().resumePending(broadcastProgress)
        relaunchNow()
      } finally {
        invalidateDataRootStorage()
      }
    })
    register(PATH_MANAGEMENT_IPC_CHANNELS.CANCEL_DATA_ROOT_MIGRATION, async () => {
      try {
        await getCoordinator().cancel()
        relaunchNow()
      } finally {
        invalidateDataRootStorage()
      }
    })
  } else {
    register(PATH_MANAGEMENT_IPC_CHANNELS.GET_STATE, () => inspectFresh().state)
    register(PATH_MANAGEMENT_IPC_CHANNELS.PICK_DATA_ROOT, async () => {
      if (!options.dialog) throw new Error('当前环境不支持选择数据根目录')
      /** 用户通过系统对话框选择的目录结果。 */
      const result = await options.dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
      return result.canceled ? null : result.filePaths[0] ?? null
    })
    register(PATH_MANAGEMENT_IPC_CHANNELS.RECOVER_DATA_ROOT, (_event, input) => {
      recoverDataRoot(input, options.homeDir ?? homedir(), inspectFresh())
      if (isRecoveryResolved(input, inspectFresh())) relaunchNow()
    })
  }

  register(PATH_MANAGEMENT_IPC_CHANNELS.OPEN_DATA_ROOT, async (_event, rawTarget) => {
    if (!options.shell) throw new Error('当前环境不支持打开数据根目录')
    /** 必须显式声明 current/previous，禁止 renderer 依赖含糊的缺省行为。 */
    const target: OpenDataRootTarget = assertOpenDataRootTarget(rawTarget)
    /** 优先使用新鲜 recovery 状态，普通模式复用协调器状态。 */
    const resolvedState = options.mode === 'data-root-recovery'
      ? inspectFresh().state
      : getCoordinator().getStatus()
    /** 目录只能来自可信 locator 状态。 */
    const root = target === 'previous' ? resolvedState.previousRoot : resolvedState.activeRoot
    if (!root) {
      throw new Error(target === 'previous'
        ? '当前没有可打开的上次数据根目录'
        : '当前没有可打开的数据根目录')
    }
    /** Electron openPath 成功时返回空字符串，失败时返回错误摘要。 */
    const error = await options.shell.openPath(root)
    if (error) {
      throw new Error(target === 'previous' ? `无法打开上次数据根目录：${error}` : error)
    }
  })
  if (options.mode !== 'normal') {
    register(PATH_MANAGEMENT_IPC_CHANNELS.EXIT_APP, () => { options.app.quit() })
  }

  return registeredChannels
}

/** 运行时校验打开目标，避免 renderer 绕过 locator 打开任意路径。 */
function assertOpenDataRootTarget(value: unknown): OpenDataRootTarget {
  if (value === 'current' || value === 'previous') return value
  throw new Error('数据根打开目标无效')
}

/** 严格校验 renderer 回传的 selection 对象，不接受裸路径。 */
function assertDataRootSelectionInput(value: unknown): DataRootMigrationSelectionInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('数据根目标选择无效')
  }
  const input = value as { selectionId?: unknown; targetRoot?: unknown }
  if (
    typeof input.selectionId !== 'string'
    || input.selectionId.trim().length === 0
    || typeof input.targetRoot !== 'string'
    || !isAbsolute(input.targetRoot)
  ) throw new Error('数据根目标选择无效')
  return { selectionId: input.selectionId, targetRoot: input.targetRoot }
}

/** 只接受当前窗口最新、服务端签发且路径完全一致的 selection。 */
function requireCurrentSelection(
  current: DataRootSelectionState | null,
  input: DataRootMigrationSelectionInput,
): DataRootSelectionState {
  if (
    current === null
    || current.selectionId !== input.selectionId
    || current.targetRoot !== input.targetRoot
  ) throw new Error('目标选择已失效')
  return current
}

/** 拒绝任何非当前模式预期窗口发起的路径 IPC。 */
function assertExpectedSender(event: unknown, expected: object | null): asserts event is PathManagementInvokeEvent {
  if (expected === null || typeof event !== 'object' || event === null || !('sender' in event) || event.sender !== expected) {
    throw new Error('当前窗口无权执行路径管理操作')
  }
}

/** 延迟创建默认协调器，确保 recovery 模式不会触发迁移或 cleanup。 */
function getDefaultCoordinator(locator: DataRootLocator): DataRootMigrationCoordinator {
  if (defaultCoordinator === null) defaultCoordinator = new DataRootMigrationCoordinator({ locator })
  return defaultCoordinator
}

/** 正常模式迁移计划写入前检查全部运行时互斥条件。 */
async function assertMigrationCanStart(options: RegisterPathManagementIpcOptions): Promise<void> {
  if (options.hasActiveTasks?.() === true) throw new Error('仍有 Agent 或 Automation 正在运行，无法迁移数据根')
  if (await options.hasOtherPromaInstance?.() === true) {
    throw new Error('另一个 Proma 实例正在使用数据根，无法迁移')
  }
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
