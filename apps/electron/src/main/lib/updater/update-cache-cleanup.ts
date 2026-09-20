import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmdirSync } from 'node:fs'
import type { Stats } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { gte, valid } from 'semver'
import {
  readJsonFileStrict,
  removeFileAtomic,
  writeJsonFileAtomicSecure,
} from '../safe-file'
import type { AtomicFileIdentity } from '../safe-file'

/** macOS 差分更新基线的最长保留时间。 */
export const MAC_DIFFERENTIAL_CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000
/** 新版主窗口连续稳定后才允许清理已安装包。 */
export const APPLIED_UPDATE_CACHE_CLEANUP_DELAY_MS = 15_000
/** Windows 文件短暂占用时的重试间隔。 */
export const APPLIED_UPDATE_CACHE_CLEANUP_RETRY_DELAY_MS = 1_000
/** 单次启动允许的清理重试次数。 */
export const APPLIED_UPDATE_CACHE_CLEANUP_MAX_RETRIES = 2

/** 当前缓存状态结构版本。 */
const CACHE_STATE_VERSION = 2
/** electron-updater 固定的待安装目录名。 */
const PENDING_DIRECTORY_NAME = 'pending'
/** macOS 差分更新可安全定向清理的文件名。 */
const MAC_DIFFERENTIAL_CACHE_FILES = ['update.zip', 'current.blockmap'] as const
/** 状态 JSON 的读取上限，防止异常文件无界占用内存。 */
const CACHE_STATE_MAX_BYTES = 64 * 1024

/** 单个已下载更新的受控缓存位置。 */
interface PendingUpdateCacheState {
  targetVersion: string
  downloadedFile: string
  pendingDirectory: string
  cacheDirectory: string
  platform: string
  downloadedAt: number
}

/** macOS 差分下载基线的独立生命周期。 */
interface MacDifferentialCacheState {
  cacheDirectory: string
  expiresAt: number
}

/** Proma 自主管理的 updater 缓存状态。 */
interface UpdateCacheState {
  schemaVersion: typeof CACHE_STATE_VERSION
  pendingUpdate?: PendingUpdateCacheState
  macDifferentialCache?: MacDifferentialCacheState
}

/** 单次缓存清理的公开结果。 */
export interface UpdateCacheCleanupResult {
  status: 'not-needed' | 'retained' | 'cleaned' | 'skipped-unsafe' | 'failed'
  deletedCount: number
}

/** 缓存清理器的路径、平台与可替换时间依赖。 */
export interface UpdateCacheCleanupOptions {
  /** Proma 自己拥有的状态文件，不写入 electron-updater 私有状态。 */
  stateFilePath: string
  /** electron-updater 使用的系统级缓存根目录。 */
  baseCacheDirectory: string
  /** 测试可替换的运行平台。 */
  platform?: NodeJS.Platform
  /** 测试可替换的当前时间。 */
  now?: () => number
  /** 缓存生命周期日志出口。 */
  log?: Pick<Console, 'info' | 'warn'>
  /** 测试可替换的 no-follow 路径检查。 */
  lstat?: (path: string) => Stats
}

/** 启动稳定门禁可替换依赖。 */
export interface UpdateCacheCleanupStartupGateOptions {
  /** 执行一次已安装版本缓存清理。 */
  cleanup: () => UpdateCacheCleanupResult
  /** 判断当前下载链路是否占用共享 pending。 */
  shouldDefer: () => boolean
  /** 测试可替换的延迟调度器。 */
  setTimeoutFn?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  /** 测试可替换的延迟取消器。 */
  clearTimeoutFn?: (timer: ReturnType<typeof setTimeout>) => void
  /** 缓存生命周期日志出口。 */
  log?: Pick<Console, 'info' | 'warn'>
}

/** 窗口与 renderer 健康事件绑定依赖。 */
export interface UpdateCacheCleanupHealthEventsOptions {
  /** 接收失败信号并释放门禁的控制器。 */
  gate: Pick<ReturnType<typeof createUpdateCacheCleanupStartupGate>, 'markRendererFailed' | 'dispose'>
  /** 订阅窗口卡死并返回解绑函数。 */
  addWindowUnresponsiveListener: (listener: () => void) => () => void
  /** 订阅主框架加载失败并返回解绑函数。 */
  addDidFailLoadListener: (listener: (errorCode: number, isMainFrame: boolean) => void) => () => void
  /** 订阅 renderer 退出并返回解绑函数。 */
  addRenderProcessGoneListener: (listener: () => void) => () => void
}

/** pending 为共享下载目录，活跃下载期间禁止任何清理。 */
export function shouldDeferUpdateCacheCleanup(hasActiveDownload: boolean, isDownloading: boolean): boolean {
  return hasActiveDownload || isDownloading
}

/** 计算 electron-updater 在当前平台使用的默认缓存根目录。 */
export function getDefaultUpdaterBaseCacheDirectory(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory = homedir(),
): string {
  if (platform === 'win32') return environment.LOCALAPPDATA || join(homeDirectory, 'AppData', 'Local')
  if (platform === 'darwin') return join(homeDirectory, 'Library', 'Caches')
  return environment.XDG_CACHE_HOME || join(homeDirectory, '.cache')
}

/** 创建只清理已确认安装版本缓存的生命周期管理器。 */
export function createUpdateCacheCleanup(options: UpdateCacheCleanupOptions) {
  /** 当前运行平台。 */
  const platform = options.platform ?? process.platform
  /** 当前时间来源。 */
  const now = options.now ?? Date.now
  /** 缓存生命周期日志出口。 */
  const log = options.log ?? console
  /** pending 严格存在性检查，测试可注入非 ENOENT 故障。 */
  const lstat = options.lstat ?? lstatSync
  /** 规范化后的 Proma 状态文件路径。 */
  const stateFilePath = resolve(options.stateFilePath)
  /** 规范化后的系统缓存根路径。 */
  const baseCacheDirectory = resolve(options.baseCacheDirectory)

  /** 记录 electron-updater 已完成下载的目标版本与文件位置。 */
  function recordDownloadedUpdate(targetVersion: string, downloadedFile: string): boolean {
    try {
      /** 规范化后的下载文件路径。 */
      const downloadedFilePath = resolve(downloadedFile)
      /** 下载文件所在的 pending 目录。 */
      const pendingDirectory = dirname(downloadedFilePath)
      /** pending 的直接父缓存目录。 */
      const cacheDirectory = dirname(pendingDirectory)

      if (valid(targetVersion) === null
        || !isSafeManagedPendingDirectory(pendingDirectory, cacheDirectory, baseCacheDirectory)
        || getRegularFileIdentity(downloadedFilePath) === null) {
        log.warn(`[更新缓存] 跳过记录未验证的下载路径: ${downloadedFilePath}`)
        return false
      }

      /** 已有状态或新建空状态。 */
      const state = readState(stateFilePath, log) ?? createEmptyState()
      state.pendingUpdate = {
        targetVersion,
        downloadedFile: downloadedFilePath,
        pendingDirectory,
        cacheDirectory,
        platform,
        downloadedAt: now(),
      }
      return persistState(stateFilePath, state, log)
    } catch (error) {
      log.warn(`[更新缓存] 无法记录下载缓存状态，将跳过后续自动清理: ${String(error)}`)
      return false
    }
  }

  /** 当前应用版本达到目标后清理已安装更新缓存。 */
  function cleanupForRunningVersion(runningVersion: string): UpdateCacheCleanupResult {
    /** 安全读取的当前缓存状态。 */
    const state = readState(stateFilePath, log)
    if (state === null) return { status: 'not-needed', deletedCount: 0 }

    /** 本轮已删除的普通文件数量。 */
    let deletedCount = 0
    /** 本轮是否需要提交更新后的状态。 */
    let didChangeState = false
    /** 本轮是否遇到不可信路径。 */
    let didSkipUnsafePath = false
    /** 本轮是否遇到可重试文件系统失败。 */
    let didFail = false

    if (state.macDifferentialCache) {
      /** macOS 差分缓存的独立清理结果。 */
      const macResult = cleanupExpiredMacDifferentialCache(
        state.macDifferentialCache,
        platform,
        baseCacheDirectory,
        now,
        log,
      )
      deletedCount += macResult.deletedCount
      if (macResult.status === 'cleaned') {
        state.macDifferentialCache = undefined
        didChangeState = true
      } else if (macResult.status === 'skipped-unsafe') {
        state.macDifferentialCache = undefined
        didChangeState = true
        didSkipUnsafePath = true
      } else if (macResult.status === 'failed') {
        didFail = true
      }
    }

    if (state.pendingUpdate) {
      /** 待安装更新状态快照。 */
      const pending = state.pendingUpdate
      /** pending 路径的严格四态检查结果。 */
      const pendingStatus = inspectPendingState(pending, baseCacheDirectory, lstat)
      if (pendingStatus === 'unsafe') {
        log.warn('[更新缓存] pending 路径未通过安全校验，保留状态供诊断')
        didSkipUnsafePath = true
      } else if (pendingStatus === 'failed') {
        log.warn('[更新缓存] 无法确认 pending 路径状态，保留状态供下次启动重试')
        didFail = true
      } else if (!isVersionAtLeast(runningVersion, pending.targetVersion)) {
        // 当前仍是旧版，安装包必须保留给下一次安装尝试。
      } else {
        /** pending 目录的定向清理结果。 */
        const removal = removePendingDirectory(
          pending.pendingDirectory,
          pending.cacheDirectory,
          baseCacheDirectory,
        )
        deletedCount += removal.deletedCount
        if (removal.status === 'removed' || removal.status === 'absent') {
          log.info(`[更新缓存] 已确认运行 v${runningVersion}，清理 ${removal.deletedCount} 个已安装更新文件`)
          state.pendingUpdate = undefined
          didChangeState = true
          /** macOS 的 update.zip 是后续差分下载基线。 */
          const macDifferentialArchive = join(pending.cacheDirectory, 'update.zip')
          if (platform === 'darwin'
            && pending.platform === 'darwin'
            && getRegularFileIdentity(macDifferentialArchive) !== null) {
            state.macDifferentialCache = {
              cacheDirectory: pending.cacheDirectory,
              expiresAt: now() + MAC_DIFFERENTIAL_CACHE_TTL_MS,
            }
          }
        } else if (removal.status === 'unsafe') {
          didSkipUnsafePath = true
        } else {
          didFail = true
        }
      }
    }

    if (didChangeState) {
      if (hasStateEntries(state)) {
        if (!persistState(stateFilePath, state, log)) didFail = true
      } else if (!removeStateFiles(stateFilePath, log)) {
        didFail = true
      }
    }

    if (didSkipUnsafePath) return { status: 'skipped-unsafe', deletedCount }
    if (didFail) return { status: 'failed', deletedCount }
    if (deletedCount > 0 || didChangeState) return { status: 'cleaned', deletedCount }
    return { status: 'retained', deletedCount }
  }

  return { recordDownloadedUpdate, cleanupForRunningVersion }
}

/** 创建新版窗口稳定期门禁与有界清理重试器。 */
export function createUpdateCacheCleanupStartupGate(options: UpdateCacheCleanupStartupGateOptions) {
  /** 延迟调度实现。 */
  const setTimeoutFn = options.setTimeoutFn ?? setTimeout
  /** 延迟取消实现。 */
  const clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout
  /** 缓存生命周期日志出口。 */
  const log = options.log ?? console
  /** 当前待执行的门禁或重试定时器。 */
  let timer: ReturnType<typeof setTimeout> | null = null
  /** 当前启动中已执行的失败重试次数。 */
  let retryCount = 0
  /** renderer 失败后永久阻止本次启动清理。 */
  let rendererFailed = false
  /** 已完成、延后或释放后阻止陈旧回调重复执行。 */
  let finished = false

  /** 以指定延迟安排下一次清理尝试。 */
  function scheduleAttempt(delayMs: number): void {
    timer = setTimeoutFn(runCleanup, delayMs)
  }

  /** 执行一次门禁检查与缓存清理。 */
  function runCleanup(): void {
    timer = null
    if (rendererFailed || finished) return
    if (options.shouldDefer()) {
      finished = true
      log.info('[更新缓存] 有更新正在下载，跳过本次已安装包清理')
      return
    }

    /** 业务清理返回的可重试结果。 */
    const result = options.cleanup()
    if (result.status === 'failed' && retryCount < APPLIED_UPDATE_CACHE_CLEANUP_MAX_RETRIES) {
      retryCount += 1
      log.warn(`[更新缓存] 清理未完成，1 秒后重试（${retryCount}/${APPLIED_UPDATE_CACHE_CLEANUP_MAX_RETRIES}）`)
      scheduleAttempt(APPLIED_UPDATE_CACHE_CLEANUP_RETRY_DELAY_MS)
      return
    }
    if (result.status === 'failed') {
      log.warn('[更新缓存] 缓存清理多次失败，将在下次启动时重试')
    } else if (result.status === 'skipped-unsafe') {
      log.warn('[更新缓存] 跳过了未通过路径安全校验的缓存清理')
    }
    finished = true
  }

  /** 主窗口可见后启动稳定期计时。 */
  function schedule(): void {
    if (rendererFailed || finished) return
    if (timer !== null) clearTimeoutFn(timer)
    retryCount = 0
    scheduleAttempt(APPLIED_UPDATE_CACHE_CLEANUP_DELAY_MS)
  }

  /** renderer 主框架失败或崩溃时取消本次启动清理。 */
  function markRendererFailed(): void {
    rendererFailed = true
    if (timer !== null) {
      clearTimeoutFn(timer)
      timer = null
    }
  }

  /** 释放窗口关联的定时器并阻止陈旧回调。 */
  function dispose(): void {
    finished = true
    if (timer !== null) {
      clearTimeoutFn(timer)
      timer = null
    }
  }

  return { schedule, markRendererFailed, dispose }
}

/** 绑定窗口健康事件，并返回同时解绑监听与释放门禁的幂等控制器。 */
export function bindUpdateCacheCleanupHealthEvents(options: UpdateCacheCleanupHealthEventsOptions) {
  /** 所有健康失败事件共用的门禁关闭入口。 */
  const markRendererFailed = (): void => options.gate.markRendererFailed()
  /** 主框架加载失败时过滤正常导航取消和子框架错误。 */
  const handleDidFailLoad = (errorCode: number, isMainFrame: boolean): void => {
    if (isMainFrame && errorCode !== -3) options.gate.markRendererFailed()
  }
  /** 窗口卡死监听的解绑函数。 */
  const removeWindowUnresponsiveListener = options.addWindowUnresponsiveListener(markRendererFailed)
  /** 主框架加载失败监听的解绑函数。 */
  const removeDidFailLoadListener = options.addDidFailLoadListener(handleDidFailLoad)
  /** renderer 退出监听的解绑函数。 */
  const removeRenderProcessGoneListener = options.addRenderProcessGoneListener(markRendererFailed)
  /** 防止 cleanupUpdater 与窗口 closed 重复解绑。 */
  let disposed = false

  /** 幂等解绑全部健康监听并释放门禁定时器。 */
  function dispose(): void {
    if (disposed) return
    disposed = true
    removeWindowUnresponsiveListener()
    removeDidFailLoadListener()
    removeRenderProcessGoneListener()
    options.gate.dispose()
  }

  return {
    dispose,
  }
}

/** 创建不包含任何缓存条目的状态。 */
function createEmptyState(): UpdateCacheState {
  return { schemaVersion: CACHE_STATE_VERSION }
}

/** 判断状态中是否仍有需要跨启动保留的缓存条目。 */
function hasStateEntries(state: UpdateCacheState): boolean {
  return state.pendingUpdate !== undefined || state.macDifferentialCache !== undefined
}

/** 安全读取并校验缓存状态；不可信状态按不可自动清理处理。 */
function readState(filePath: string, log: Pick<Console, 'warn'>): UpdateCacheState | null {
  try {
    return readJsonFileStrict(filePath, {
      validate: isUpdateCacheState,
      description: '更新缓存状态',
      maxBytes: CACHE_STATE_MAX_BYTES,
      secureRecovery: true,
    })
  } catch (error) {
    log.warn(`[更新缓存] 无法安全读取缓存状态，已放弃自动清理: ${String(error)}`)
    return null
  }
}

/** 使用安全原子写持久化完整缓存状态。 */
function persistState(stateFilePath: string, state: UpdateCacheState, log: Pick<Console, 'warn'>): boolean {
  try {
    /** 状态文件直属目录。 */
    const stateDirectory = dirname(stateFilePath)
    mkdirSync(stateDirectory, { recursive: true })
    if (!isPlainDirectory(stateDirectory)) throw new Error('更新缓存状态目录不是普通目录')
    writeJsonFileAtomicSecure(stateFilePath, state)
    return true
  } catch (error) {
    log.warn(`[更新缓存] 无法持久化缓存状态: ${String(error)}`)
    return false
  }
}

/** 严格校验完整缓存状态结构。 */
function isUpdateCacheState(value: unknown): value is UpdateCacheState {
  if (!isRecord(value) || value.schemaVersion !== CACHE_STATE_VERSION) return false
  /** 状态根允许出现的固定字段。 */
  const allowedKeys = new Set(['schemaVersion', 'pendingUpdate', 'macDifferentialCache'])
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) return false
  return (value.pendingUpdate === undefined || isPendingUpdateCacheState(value.pendingUpdate))
    && (value.macDifferentialCache === undefined || isMacDifferentialCacheState(value.macDifferentialCache))
    && (value.pendingUpdate !== undefined || value.macDifferentialCache !== undefined)
}

/** 严格校验待安装更新状态。 */
function isPendingUpdateCacheState(value: unknown): value is PendingUpdateCacheState {
  if (!isRecord(value)) return false
  /** 待安装状态允许出现的固定字段。 */
  const expectedKeys = ['targetVersion', 'downloadedFile', 'pendingDirectory', 'cacheDirectory', 'platform', 'downloadedAt']
  return Object.keys(value).length === expectedKeys.length
    && expectedKeys.every((key) => Object.hasOwn(value, key))
    && typeof value.targetVersion === 'string'
    && typeof value.downloadedFile === 'string'
    && typeof value.pendingDirectory === 'string'
    && typeof value.cacheDirectory === 'string'
    && typeof value.platform === 'string'
    && typeof value.downloadedAt === 'number'
    && Number.isFinite(value.downloadedAt)
}

/** 严格校验 macOS 差分缓存状态。 */
function isMacDifferentialCacheState(value: unknown): value is MacDifferentialCacheState {
  return isRecord(value)
    && Object.keys(value).length === 2
    && typeof value.cacheDirectory === 'string'
    && typeof value.expiresAt === 'number'
    && Number.isFinite(value.expiresAt)
}

/** pending 目录的严格路径状态。 */
type PendingDirectoryStatus = 'safe' | 'absent' | 'unsafe' | 'failed'

/** 严格校验持久化 pending 状态仍指向受控缓存目录。 */
function inspectPendingState(
  state: PendingUpdateCacheState,
  baseCacheDirectory: string,
  lstat: (path: string) => Stats,
): PendingDirectoryStatus {
  if (!isAbsolute(state.downloadedFile)
    || !isAbsolute(state.pendingDirectory)
    || !isAbsolute(state.cacheDirectory)
    || resolve(dirname(state.downloadedFile)) !== resolve(state.pendingDirectory)) {
    return 'unsafe'
  }
  return inspectManagedPendingDirectory(
    state.pendingDirectory,
    state.cacheDirectory,
    baseCacheDirectory,
    lstat,
  )
}

/** 校验 pending 是受控缓存目录的直接普通子目录。 */
function isSafeManagedPendingDirectory(
  pendingDirectory: string,
  cacheDirectory: string,
  baseCacheDirectory: string,
): boolean {
  return inspectManagedPendingDirectory(
    pendingDirectory,
    cacheDirectory,
    baseCacheDirectory,
    lstatSync,
  ) === 'safe'
}

/** 用 lstat 严格区分普通目录、明确缺失、不安全对象和其他读取失败。 */
function inspectManagedPendingDirectory(
  pendingDirectory: string,
  cacheDirectory: string,
  baseCacheDirectory: string,
  lstat: (path: string) => Stats,
): PendingDirectoryStatus {
  if (basename(pendingDirectory) !== PENDING_DIRECTORY_NAME
    || resolve(dirname(pendingDirectory)) !== resolve(cacheDirectory)
    || !isSafeManagedCacheDirectory(cacheDirectory, baseCacheDirectory)) {
    return 'unsafe'
  }
  try {
    /** pending 路径自身的 no-follow 状态。 */
    const stat = lstat(pendingDirectory)
    return stat.isDirectory() && !stat.isSymbolicLink() ? 'safe' : 'unsafe'
  } catch (error) {
    return isMissingPathError(error) ? 'absent' : 'failed'
  }
}

/** 校验应用缓存目录是系统缓存根的直接普通子目录。 */
function isSafeManagedCacheDirectory(cacheDirectory: string, baseCacheDirectory: string): boolean {
  if (!isAbsolute(cacheDirectory) || resolve(dirname(cacheDirectory)) !== resolve(baseCacheDirectory)) return false
  if (!isPlainDirectory(baseCacheDirectory) || !isPlainDirectory(cacheDirectory)) return false
  try {
    /** 缓存根的真实规范路径。 */
    const realBaseCacheDirectory = resolve(realpathSync(baseCacheDirectory))
    /** 应用缓存目录的真实规范路径。 */
    const realCacheDirectory = resolve(realpathSync(cacheDirectory))
    return resolve(realpathSync(dirname(cacheDirectory))) === realBaseCacheDirectory
      && resolve(dirname(realCacheDirectory)) === realBaseCacheDirectory
  } catch {
    return false
  }
}

/** 判断运行版本是否已达到记录的目标版本，包括 Bone 预发布顺序。 */
function isVersionAtLeast(runningVersion: string, targetVersion: string): boolean {
  /** semver 解析后的运行版本。 */
  const running = valid(runningVersion)
  /** semver 解析后的目标版本。 */
  const target = valid(targetVersion)
  return running !== null && target !== null && gte(running, target)
}

/** pending 目录定向清理的内部结果。 */
interface PendingRemovalResult {
  status: 'removed' | 'absent' | 'failed' | 'unsafe'
  deletedCount: number
}

/** 仅在所有条目预检为普通文件后逐个按身份删除 pending。 */
function removePendingDirectory(
  pendingDirectory: string,
  cacheDirectory: string,
  baseCacheDirectory: string,
): PendingRemovalResult {
  /** 删除前再次严格确认 pending 当前状态。 */
  const pendingStatus = inspectManagedPendingDirectory(
    pendingDirectory,
    cacheDirectory,
    baseCacheDirectory,
    lstatSync,
  )
  if (pendingStatus === 'absent') return { status: 'absent', deletedCount: 0 }
  if (pendingStatus === 'unsafe') return { status: 'unsafe', deletedCount: 0 }
  if (pendingStatus === 'failed') return { status: 'failed', deletedCount: 0 }

  try {
    /** 清理前固定的全部普通文件及其身份。 */
    const entries = readdirSync(pendingDirectory).map((entryName) => {
      /** 单个 pending 条目的绝对路径。 */
      const entryPath = join(pendingDirectory, entryName)
      /** 清理前读取的普通文件身份。 */
      const identity = getRegularFileIdentity(entryPath)
      if (identity === null) throw new UnsafePendingEntryError()
      return { entryPath, identity }
    })
    /** 已经成功原子移除的文件数。 */
    let deletedCount = 0
    for (const entry of entries) {
      removeFileAtomic(entry.entryPath, { expectedIdentity: entry.identity })
      deletedCount += 1
    }
    if (!isSafeManagedPendingDirectory(pendingDirectory, cacheDirectory, baseCacheDirectory)) {
      return { status: 'unsafe', deletedCount }
    }
    rmdirSync(pendingDirectory)
    return { status: 'removed', deletedCount }
  } catch (error) {
    if (error instanceof UnsafePendingEntryError) return { status: 'unsafe', deletedCount: 0 }
    return { status: 'failed', deletedCount: 0 }
  }
}

/** 标记 pending 中出现了目录、链接或其他不受支持对象。 */
class UnsafePendingEntryError extends Error {}

/** 仅接受实际目录并拒绝软链接。 */
function isPlainDirectory(path: string): boolean {
  try {
    /** 当前路径的 no-follow 状态。 */
    const stat = lstatSync(path)
    return stat.isDirectory() && !stat.isSymbolicLink()
  } catch {
    return false
  }
}

/** 读取当前用户普通文件的删除身份，链接或其他对象返回 null。 */
function getRegularFileIdentity(path: string): AtomicFileIdentity | null {
  try {
    /** 当前路径的 no-follow 状态。 */
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink() || !isOwnedByCurrentUser(stat)) return null
    return { dev: stat.dev, ino: stat.ino }
  } catch {
    return null
  }
}

/** 对支持 uid 的平台确认文件归当前用户所有。 */
function isOwnedByCurrentUser(stat: Stats): boolean {
  return typeof process.getuid !== 'function' || stat.uid === process.getuid()
}

/** 清理已经过期的 macOS 差分更新基线。 */
function cleanupExpiredMacDifferentialCache(
  state: MacDifferentialCacheState,
  platform: NodeJS.Platform,
  baseCacheDirectory: string,
  now: () => number,
  log: Pick<Console, 'info'>,
): UpdateCacheCleanupResult {
  if (platform !== 'darwin' || !isSafeManagedCacheDirectory(state.cacheDirectory, baseCacheDirectory)) {
    return { status: 'skipped-unsafe', deletedCount: 0 }
  }
  if (!Number.isFinite(state.expiresAt) || now() < state.expiresAt) {
    return { status: 'retained', deletedCount: 0 }
  }

  /** 清理前固定的差分缓存普通文件身份。 */
  const candidates = MAC_DIFFERENTIAL_CACHE_FILES.map((fileName) => {
    /** 差分缓存候选路径。 */
    const filePath = join(state.cacheDirectory, fileName)
    return { filePath, identity: getRegularFileIdentity(filePath) }
  })
  /** 已删除的差分缓存文件数量。 */
  let deletedCount = 0
  try {
    for (const candidate of candidates) {
      if (candidate.identity === null) {
        if (existsSync(candidate.filePath)) return { status: 'failed', deletedCount }
        continue
      }
      removeFileAtomic(candidate.filePath, { expectedIdentity: candidate.identity })
      deletedCount += 1
    }
  } catch {
    return { status: 'failed', deletedCount }
  }
  log.info(`[更新缓存] 已回收 ${deletedCount} 个过期的 macOS 差分更新缓存文件`)
  return { status: 'cleaned', deletedCount }
}

/** 安全移除主状态及历史兼容候选，不可信对象保留并报告失败。 */
function removeStateFiles(stateFilePath: string, log: Pick<Console, 'warn'>): boolean {
  try {
    for (const candidate of [stateFilePath, `${stateFilePath}.tmp`, `${stateFilePath}.bak`]) {
      /** 候选状态文件的普通文件身份。 */
      const identity = getRegularFileIdentity(candidate)
      if (identity !== null) {
        removeFileAtomic(candidate, { expectedIdentity: identity })
      } else if (existsSync(candidate)) {
        throw new Error(`更新缓存状态候选不是普通文件: ${candidate}`)
      }
    }
    return true
  } catch (error) {
    log.warn(`[更新缓存] 无法安全移除缓存状态: ${String(error)}`)
    return false
  }
}

/** 判断未知值是非数组对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 只把系统明确返回的 ENOENT 视为路径不存在。 */
function isMissingPathError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 'ENOENT'
}
