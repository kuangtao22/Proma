/**
 * 崩溃安全的 JSON 文件读写工具
 *
 * 解决系统强制关机/崩溃时 JSON 索引文件被截断导致数据丢失的问题。
 * - 写入：write-to-temp → rename（POSIX 原子操作）+ .bak 备份
 * - 读取：主文件 → .tmp 残留 → .bak 回退，多层容错
 */

import { randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import type { Stats } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'

/** 安全 JSON 读取的可选 schema 校验配置。 */
export interface ReadJsonFileSafeOptions<T> extends DurabilitySyncOptions {
  /** 判断解析结果是否符合调用方要求的运行时 schema。 */
  validate?: (value: unknown) => value is T
}

/** 严格 JSON 读取的 schema 与错误上下文。 */
export interface ReadJsonFileStrictOptions<T> {
  /** 判断解析结果是否符合迁移提交要求的运行时 schema。 */
  validate: (value: unknown) => value is T
  /** 候选全部损坏时用于错误消息的业务对象名称。 */
  description: string
}

/** 原子文件边界实际达到的持久化等级。 */
export type DurabilityResult = 'directory' | 'file-only'

/** 跨原子写、目录创建和删除复用的持久化依赖。 */
interface DurabilitySyncOptions {
  /** 目标运行平台；生产默认使用当前 Node 平台。 */
  platform?: NodeJS.Platform
  /** 同步目录项；测试可注入平台 capability 错误。 */
  syncDirectory?: (directoryPath: string) => void
  /** rename 后同步已提交文件；Windows 生产默认重新打开文件并 fsync。 */
  syncFile?: (filePath: string) => void
  /** 以指定 flags 重新打开已提交文件；仅供默认文件同步合同测试。 */
  openFile?: (filePath: string, flags: number) => number
  /** 目录 fsync 不受支持时的中文降级提示。 */
  warnReducedDurability?: (message: string) => void
}

/** 普通 JSON/text 原子写的可选持久化依赖。 */
export interface AtomicWriteOptions extends DurabilitySyncOptions {}

/** no-follow 原子 JSON 写入的故障注入配置。 */
export interface SecureAtomicJsonWriteOptions extends DurabilitySyncOptions {
  /** 调用方读取期绑定的目标状态；不传时保持原有身份复验语义。 */
  expectedDestination?: AtomicDestinationExpectation
  /** 主文件提交成功后发布的 previous revision 备份。 */
  priorBackup?: SecureAtomicJsonPriorBackup
  /** 临时文件完成 fsync/close 后、最终身份复验前调用，仅供竞态回归测试。 */
  beforeRename?: (tempPath: string) => void
}

/** 与主文件一同预写、在主提交后发布的 JSON 备份。 */
export interface SecureAtomicJsonPriorBackup {
  /** 固定备份路径，必须与主文件位于同一目录。 */
  filePath: string
  /** 读取期主文件对应的 previous revision 数据。 */
  data: object
}

/** 原子删除普通文件时允许替换的窄测试依赖。 */
export interface AtomicFileRemoveOptions extends DurabilitySyncOptions {
  /** 只允许删除与调用方此前读取身份一致的文件。 */
  expectedIdentity?: AtomicFileIdentity
  /** rename 完成后、身份复验前调用，仅供稳定覆盖置换竞态。 */
  afterRenameBeforeVerify?: (tombstonePath: string) => void
  /** rename 已提交后清理 tombstone；生产默认使用 unlinkSync。 */
  unlinkTombstone?: (tombstonePath: string) => void
  /** 判断其他进程 PID 是否仍存在；生产默认使用 signal 0。 */
  isProcessAlive?: (processId: number) => boolean
  /** 当前 tombstone owner PID；生产默认使用当前进程。 */
  processId?: number
}

/** 持久创建目录时允许替换的窄测试依赖。 */
export interface DurableDirectoryOptions extends DurabilitySyncOptions {}

/** 可由读取方传回删除边界的最小文件系统对象身份。 */
export interface AtomicFileIdentity {
  /** 所在设备编号。 */
  dev: number
  /** 同一设备内 inode/file index。 */
  ino: number
}

/** 可用于 compare-and-swap 的完整文件内容状态。 */
export interface AtomicFileState extends AtomicFileIdentity {
  /** 文件字节数。 */
  size: number
  /** 最后修改时间戳。 */
  mtimeMs: number
  /** inode metadata 最后变化时间戳。 */
  ctimeMs: number
}

/** 明确区分目标应缺失或应匹配具体读取状态的 CAS 合同。 */
export type AtomicDestinationExpectation =
  | { kind: 'missing' }
  | { kind: 'state'; state: AtomicFileState }

/** 目标不再匹配调用方读取状态时抛出的可识别冲突。 */
export class AtomicDestinationConflictError extends Error {
  /** 稳定错误码供业务 Store 映射 revision 冲突。 */
  readonly code = 'ATOMIC_DESTINATION_CONFLICT'

  constructor() {
    super('安全原子写入目标状态冲突')
    this.name = 'AtomicDestinationConflictError'
  }
}

/** 主文件 rename 后可能出现的稳定提交阶段。 */
export type AtomicWritePostCommitStage =
  | 'mainDurabilityUncertain'
  | 'priorBackupDegraded'

/** 主文件已 rename 后抛出的 typed error，调用方不得按普通失败重试。 */
export class AtomicWritePostCommitError extends Error {
  /** 主文件 rename 已完成，是所有 post-commit 错误的不变量。 */
  readonly committed = true
  /** 区分主 durability 未确认或 backup 已降级。 */
  readonly stage: AtomicWritePostCommitStage
  /** 保留原始系统错误或安全状态错误。 */
  override readonly cause: unknown

  constructor(stage: AtomicWritePostCommitStage, cause: unknown) {
    const message = stage === 'mainDurabilityUncertain'
      ? '安全原子写入主文件已提交但持久性未确认'
      : '安全原子写入主文件已确认但备份降级'
    super(message, { cause })
    this.name = 'AtomicWritePostCommitError'
    this.stage = stage
    this.cause = cause
  }
}

/** safe-file 内部复用的文件身份别名。 */
type FileSystemIdentity = AtomicFileIdentity

/**
 * 原子写入 JSON 文件：write-to-temp → rename
 * 写入前自动保留 .bak 备份
 */
export function writeJsonFileAtomic(
  filePath: string,
  data: object,
  skipBackup = false,
  options: AtomicWriteOptions = {},
): DurabilityResult {
  const tmpPath = filePath + '.tmp'
  const bakPath = filePath + '.bak'

  // 备份当前文件（如果存在且可读）
  if (!skipBackup && existsSync(filePath)) {
    try {
      copyFileSync(filePath, bakPath)
    } catch {
      // 备份失败不阻塞写入
    }
  }

  // 写入临时文件
  writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8')

  // 原子重命名（POSIX rename 是原子操作）
  renameSync(tmpPath, filePath)
  return syncCommittedFileDurability(filePath, options)
}

/** 原子删除保留的匿名 tombstone 名称，编码 owner PID 与原文件身份。 */
const ATOMIC_DELETE_TOMBSTONE_PATTERN = /^\.proma-delete-(\d+)-(\d+)-(\d+)-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tombstone$/i
/** 当前进程仍在执行清理协议的 tombstone，禁止同进程交错回收。 */
const activeAtomicDeleteTombstones = new Set<string>()

/**
 * 先把明确的普通文件原子移出原路径，再清理同目录唯一 tombstone。
 * rename 成功即视为业务删除已提交；后续清理失败不会把旧文件恢复到原路径。
 *
 * @param filePath 需要删除的绝对普通文件路径。
 * @param options 可替换的 tombstone 清理依赖，仅用于稳定故障测试。
 */
export function removeFileAtomic(
  filePath: string,
  options: AtomicFileRemoveOptions = {},
): DurabilityResult {
  if (!isAbsolute(filePath) || basename(filePath) === '.' || basename(filePath) === '..') {
    throw new Error('原子删除必须使用明确的绝对文件路径')
  }
  /** 父目录存在时先回收此前已提交但未清理的匿名 tombstone。 */
  const parentPath = dirname(filePath)
  let parentStat: ReturnType<typeof lstatSync>
  try {
    parentStat = lstatSync(parentPath)
  } catch (error) {
    if (isMissingPathError(error)) {
      if (options.expectedIdentity) throw new Error('原子删除目标身份不匹配', { cause: error })
      return 'directory'
    }
    throw error
  }
  if (!parentStat.isDirectory()) throw new Error('原子删除父路径不是目录')
  const parentIdentity = toIdentity(parentStat)
  /** 绑定删除时先读取目标，避免回收 tombstone 后才发现调用方身份已经失效。 */
  let targetStat: Stats | undefined
  if (options.expectedIdentity) {
    try {
      targetStat = lstatSync(filePath)
    } catch (error) {
      throw new Error('原子删除目标身份不匹配', { cause: error })
    }
    if (!targetStat.isFile()) throw new Error('原子删除目标不是普通文件')
    if (!isSameIdentity(toIdentity(targetStat), options.expectedIdentity)) {
      throw new Error('原子删除目标身份不匹配')
    }
  }
  /** 回收旧 tombstone 后已达到的最低持久化等级。 */
  let durability = recoverAtomicDeleteTombstones(parentPath, parentIdentity, options)

  /** 删除前 no-follow 读取的目标身份。 */
  if (!targetStat) {
    try {
      targetStat = lstatSync(filePath)
    } catch (error) {
      if (isMissingPathError(error)) return durability
      throw error
    }
  }
  if (!targetStat.isFile()) throw new Error('原子删除目标不是普通文件')
  const targetIdentity = toIdentity(targetStat)

  /** 同目录随机 tombstone，避免与并发删除或历史残留冲突。 */
  const tombstonePath = join(
    parentPath,
    `.proma-delete-${options.processId ?? process.pid}-${targetIdentity.dev}-${targetIdentity.ino}-${randomUUID()}.tombstone`,
  )
  assertIdentityUnchanged(parentPath, parentIdentity, '原子删除父目录身份已变化', true)
  assertIdentityUnchanged(filePath, targetIdentity, '原子删除目标身份已变化', false)
  activeAtomicDeleteTombstones.add(tombstonePath)
  try {
    renameSync(filePath, tombstonePath)
    options.afterRenameBeforeVerify?.(tombstonePath)
    /** rename 后任何置换都 fail closed：保留当前路径，不猜测哪个对象可以删除。 */
    assertIdentityUnchanged(parentPath, parentIdentity, '原子删除父目录身份已变化', true)
    assertIdentityUnchanged(tombstonePath, targetIdentity, '原子删除 tombstone 身份已变化', false)
    durability = mergeDurability(durability, syncCommittedFileDurability(tombstonePath, options))
    try {
      /** 生产使用 unlinkSync，测试可稳定注入 rename 后清理失败。 */
      const unlinkTombstone = options.unlinkTombstone ?? unlinkSync
      unlinkTombstone(tombstonePath)
      durability = mergeDurability(durability, syncDirectoryDurability(parentPath, options))
    } catch (error) {
      throw new Error(`原子删除已提交，但 tombstone 清理失败: ${tombstonePath}`, { cause: error })
    }
    return durability
  } finally {
    activeAtomicDeleteTombstones.delete(tombstonePath)
  }
}

/**
 * 幂等回收同目录内由 Proma 原子删除协议遗留的匿名 tombstone。
 *
 * @param parentPath 已确认存在的实际父目录。
 * @param parentIdentity 调用开始时固定的父目录身份。
 * @param options PID 活性检查、unlink 与持久化依赖。
 * @returns 回收操作达到的最低持久化等级。
 */
function recoverAtomicDeleteTombstones(
  parentPath: string,
  parentIdentity: FileSystemIdentity,
  options: AtomicFileRemoveOptions,
): DurabilityResult {
  /** 本轮全部回收操作达到的最低持久化等级。 */
  let durability: DurabilityResult = 'directory'
  /** tombstone owner 的当前进程 ID。 */
  const currentProcessId = options.processId ?? process.pid
  /** 跨进程 PID 存活检查实现。 */
  const isProcessAlive = options.isProcessAlive ?? isProcessAliveStrict
  for (const entry of readdirSync(parentPath, { withFileTypes: true })) {
    const nameMatch = ATOMIC_DELETE_TOMBSTONE_PATTERN.exec(entry.name)
    if (!nameMatch) continue
    /** 名称中编码的 owner PID，只有明确 stale 才允许回收。 */
    const ownerProcessId = Number(nameMatch[1])
    if (!Number.isSafeInteger(ownerProcessId) || ownerProcessId <= 0) {
      throw new Error(`无法安全回收原子删除 tombstone: ${join(parentPath, entry.name)}`)
    }
    /** active 或其他仍存活进程的 tombstone 都不属于本轮回收。 */
    const tombstonePath = join(parentPath, entry.name)
    if (activeAtomicDeleteTombstones.has(tombstonePath)) continue
    if (ownerProcessId !== currentProcessId && isProcessAlive(ownerProcessId)) continue
    /** 文件名中的原 inode 身份用于拒绝后续同名置换。 */
    const expectedIdentity: FileSystemIdentity = {
      dev: Number(nameMatch[2]),
      ino: Number(nameMatch[3]),
    }
    /** 候选必须保持为当前用户拥有的单链接普通文件。 */
    const tombstoneStat = lstatSync(tombstonePath)
    if (entry.isSymbolicLink()
      || !entry.isFile()
      || !tombstoneStat.isFile()
      || !isOwnedByCurrentUser(tombstoneStat.uid)
      || tombstoneStat.nlink !== 1
      || !isSameIdentity(toIdentity(tombstoneStat), expectedIdentity)) {
      throw new Error(`无法安全回收原子删除 tombstone: ${tombstonePath}`)
    }
    const tombstoneIdentity = toIdentity(tombstoneStat)
    assertIdentityUnchanged(parentPath, parentIdentity, '原子删除父目录身份已变化', true)
    assertIdentityUnchanged(tombstonePath, tombstoneIdentity, '原子删除 tombstone 身份已变化', false)
    try {
      const unlinkTombstone = options.unlinkTombstone ?? unlinkSync
      unlinkTombstone(tombstonePath)
      durability = mergeDurability(durability, syncDirectoryDurability(parentPath, options))
    } catch (error) {
      throw new Error(`原子删除 tombstone 回收失败: ${tombstonePath}`, { cause: error })
    }
  }
  return durability
}

/**
 * 首次创建目录并同步父目录与目录自身；已存在的实际目录保持幂等。
 *
 * @param directoryPath 需要持久存在的目录绝对路径。
 * @param options 可替换目录同步实现的测试配置。
 */
export function ensureDirectoryDurable(
  directoryPath: string,
  options: DurableDirectoryOptions = {},
): DurabilityResult {
  if (!isAbsolute(directoryPath)) throw new Error('持久目录路径必须是绝对路径')
  try {
    const existingStat = lstatSync(directoryPath)
    if (!existingStat.isDirectory()) throw new Error('持久目录路径不是实际目录')
    return 'directory'
  } catch (error) {
    if (!isMissingPathError(error)) throw error
  }
  /** 新目录的父目录必须先存在且保持为实际目录。 */
  const parentPath = dirname(directoryPath)
  const parentStat = lstatSync(parentPath)
  if (!parentStat.isDirectory()) throw new Error('持久目录父路径不是实际目录')
  mkdirSync(directoryPath)
  /** 父目录不支持 fsync 时已明确降级，无需重复触发同一平台能力错误。 */
  const parentDurability = syncDirectoryDurability(parentPath, options)
  if (parentDurability === 'file-only') return parentDurability
  return syncDirectoryDurability(directoryPath, options)
}

/**
 * fsync 目录，确保此前 rename/mkdir/unlink 的目录项更新越过崩溃边界。
 * 当前平台不支持目录 fsync 时明确抛错，调用方不得把结果声明为 durable。
 *
 * @param directoryPath 需要同步的实际目录。
 */
export function syncDirectoryDurable(directoryPath: string): void {
  /** 目录 descriptor 只在本函数内拥有。 */
  let descriptor: number | null = null
  try {
    const flags = constants.O_RDONLY | (constants.O_DIRECTORY ?? 0)
    descriptor = openSync(directoryPath, flags)
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = null
  } catch (error) {
    throw new Error(`目录持久化同步失败: ${directoryPath}`, { cause: error })
  } finally {
    if (descriptor !== null) {
      try { closeSync(descriptor) } catch { /* 保留原始同步错误。 */ }
    }
  }
}

/** 重新打开并 fsync 已提交文件，供 Windows rename 后加强内容与 metadata 持久性。 */
function syncFileDurable(filePath: string, options: DurabilitySyncOptions): void {
  /** 文件 descriptor 只在本函数内拥有。 */
  let descriptor: number | null = null
  try {
    descriptor = (options.openFile ?? openSync)(filePath, constants.O_RDWR)
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = null
  } finally {
    if (descriptor !== null) {
      try { closeSync(descriptor) } catch { /* 保留原始文件同步错误。 */ }
    }
  }
}

/** rename 后按平台执行最强可用持久化，并返回真实能力等级。 */
function syncCommittedFileDurability(
  filePath: string,
  options: DurabilitySyncOptions,
): DurabilityResult {
  /** Windows 必须先保证已提交文件内容和 metadata 完成 fsync。 */
  const platform = options.platform ?? process.platform
  if (platform === 'win32') {
    if (options.syncFile) options.syncFile(filePath)
    else syncFileDurable(filePath, options)
  }
  return syncDirectoryDurability(dirname(filePath), options)
}

/** 同步目录项；只把 Windows 明确不支持的目录 fsync 降级为 file-only。 */
function syncDirectoryDurability(
  directoryPath: string,
  options: DurabilitySyncOptions,
): DurabilityResult {
  try {
    (options.syncDirectory ?? syncDirectoryDurable)(directoryPath)
    return 'directory'
  } catch (error) {
    if (!isWindowsDirectorySyncCapabilityError(error, options.platform ?? process.platform)) throw error
    const message = `当前 Windows 文件系统不支持目录 fsync，已降级为 file-only durability: ${directoryPath}`
    ;(options.warnReducedDurability ?? warnReducedDurabilityOnce)(message)
    return 'file-only'
  }
}

/** 合并多个阶段的 durability，任一阶段降级则整体为 file-only。 */
function mergeDurability(left: DurabilityResult, right: DurabilityResult): DurabilityResult {
  return left === 'file-only' || right === 'file-only' ? 'file-only' : 'directory'
}

/** 进程内只输出一次 Windows durability 降级提示。 */
let hasWarnedReducedDurability = false
function warnReducedDurabilityOnce(message: string): void {
  if (hasWarnedReducedDurability) return
  hasWarnedReducedDurability = true
  console.warn(`[文件持久化] ${message}`)
}

/** 只识别 Windows 目录 open/fsync 的明确 capability 错误。 */
function isWindowsDirectorySyncCapabilityError(error: unknown, platform: NodeJS.Platform): boolean {
  if (platform !== 'win32') return false
  /** syncDirectoryDurable 会用 cause 保留原始 Node 系统错误。 */
  const systemError = getSystemError(error)
  if (!systemError) return false
  return (systemError.syscall === 'open'
    && (systemError.code === 'EPERM' || systemError.code === 'EACCES' || systemError.code === 'EISDIR'))
    || (systemError.syscall === 'fsync'
      && ['EINVAL', 'ENOTSUP', 'EPERM', 'EACCES'].includes(systemError.code))
}

/** 从包装错误或其 cause 中提取 Node 系统错误字段。 */
function getSystemError(error: unknown): { code: string; syscall: string } | null {
  if (!(error instanceof Error)) return null
  if ('code' in error && typeof error.code === 'string'
    && 'syscall' in error && typeof error.syscall === 'string') {
    return { code: error.code, syscall: error.syscall }
  }
  return 'cause' in error ? getSystemError(error.cause) : null
}

/** 使用 signal 0 判断其他进程是否明确仍存在；未知错误继续 fail closed。 */
function isProcessAliveStrict(processId: number): boolean {
  try {
    process.kill(processId, 0)
    return true
  } catch (error) {
    const systemError = getSystemError(error)
    if (systemError?.code === 'ESRCH') return false
    if (systemError?.code === 'EPERM') return true
    throw error
  }
}

/**
 * 使用随机独占 temp 与 no-follow 复验原子写入安全敏感 JSON。
 *
 * @param filePath 同目录原子替换的目标绝对或相对路径。
 * @param data 需要序列化的 JSON 对象。
 * @param options 可选竞态测试注入点。
 */
export function writeJsonFileAtomicSecure(
  filePath: string,
  data: object,
  options: SecureAtomicJsonWriteOptions = {},
): DurabilityResult {
  /** 父目录在创建 temp 与 rename 之间必须保持同一文件系统身份。 */
  const parentPath = dirname(filePath)
  const parentStat = lstatSync(parentPath)
  if (!parentStat.isDirectory()) throw new Error('安全原子写入父路径不是目录')
  const parentIdentity = toIdentity(parentStat)
  /** 目标缺失或为当前用户拥有的普通文件，symlink/device 一律拒绝。 */
  const destinationState = readDestinationState(filePath)
  if (options.expectedDestination) {
    assertExpectedDestinationState(destinationState, options.expectedDestination)
  }
  /** prior backup 只允许同目录的独立文件路径。 */
  const priorBackup = options.priorBackup
  if (priorBackup
    && (dirname(priorBackup.filePath) !== parentPath || priorBackup.filePath === filePath)) {
    throw new Error('安全原子写入备份路径无效')
  }
  /** 固定 backup 的初始状态用于阻断主提交期间的并发置换。 */
  const backupDestinationState = priorBackup
    ? readDestinationState(priorBackup.filePath)
    : null
  /** 随机同目录名称避免攻击者预置固定 `.tmp` 路径。 */
  const tempPath = join(parentPath, `.${basename(filePath)}.${randomUUID()}.tmp`)
  /** backup 同样使用随机 staging，主 CAS 失败前绝不触碰固定路径。 */
  const backupTempPath = priorBackup
    ? join(parentPath, `.${basename(priorBackup.filePath)}.${randomUUID()}.tmp`)
    : null
  /** temp 创建后固定的身份，只用于清理自己创建且未被替换的路径。 */
  let tempIdentity: FileSystemIdentity | null = null
  /** backup staging 的身份独立追踪，失败只清理自身 inode。 */
  let backupTempIdentity: FileSystemIdentity | null = null
  /** descriptor 仅在本函数内拥有，所有失败路径都关闭。 */
  let descriptor: number | null = null

  try {
    const flags = constants.O_WRONLY
      | constants.O_CREAT
      | constants.O_EXCL
      | (constants.O_NOFOLLOW ?? 0)
    descriptor = openSync(tempPath, flags, 0o600)
    const openedStat = fstatSync(descriptor)
    if (!openedStat.isFile() || !isOwnedByCurrentUser(openedStat.uid)) {
      throw new Error('安全原子写入临时文件身份无效')
    }
    tempIdentity = toIdentity(openedStat)
    writeFileSync(descriptor, JSON.stringify(data, null, 2), 'utf8')
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = null

    if (priorBackup && backupTempPath) {
      descriptor = openSync(backupTempPath, flags, 0o600)
      const openedBackupStat = fstatSync(descriptor)
      if (!openedBackupStat.isFile() || !isOwnedByCurrentUser(openedBackupStat.uid)) {
        throw new Error('安全原子写入备份临时文件身份无效')
      }
      backupTempIdentity = toIdentity(openedBackupStat)
      writeFileSync(descriptor, JSON.stringify(priorBackup.data, null, 2), 'utf8')
      fsyncSync(descriptor)
      closeSync(descriptor)
      descriptor = null
    }

    options.beforeRename?.(tempPath)
    assertIdentityUnchanged(parentPath, parentIdentity, '安全原子写入父目录身份已变化', true)
    if (options.expectedDestination) {
      assertExpectedDestination(filePath, options.expectedDestination)
    } else {
      assertDestinationUnchanged(filePath, destinationState)
    }
    assertIdentityUnchanged(tempPath, tempIdentity, '安全原子写入临时文件身份已变化', false)
    if (priorBackup && backupTempPath && backupTempIdentity) {
      assertDestinationStateUnchanged(priorBackup.filePath, backupDestinationState)
      assertIdentityUnchanged(
        backupTempPath,
        backupTempIdentity,
        '安全原子写入备份临时文件身份已变化',
        false,
      )
    }
    renameSync(tempPath, filePath)
    tempIdentity = null
    /** 主 rename 是业务提交点，durability 失败必须单独标记为未确认。 */
    let mainDurability: DurabilityResult
    try {
      mainDurability = syncCommittedFileDurability(filePath, options)
    } catch (error) {
      throw new AtomicWritePostCommitError('mainDurabilityUncertain', error)
    }
    /** main durability 已确认；后续错误只允许降级 prior backup。 */
    if (priorBackup && backupTempPath && backupTempIdentity) {
      try {
        assertIdentityUnchanged(parentPath, parentIdentity, '安全原子写入父目录身份已变化', true)
        assertDestinationStateUnchanged(priorBackup.filePath, backupDestinationState)
        assertIdentityUnchanged(
          backupTempPath,
          backupTempIdentity,
          '安全原子写入备份临时文件身份已变化',
          false,
        )
        renameSync(backupTempPath, priorBackup.filePath)
        backupTempIdentity = null
        const backupDurability = syncCommittedFileDurability(priorBackup.filePath, options)
        return mainDurability === 'directory' && backupDurability === 'directory'
          ? 'directory'
          : 'file-only'
      } catch (error) {
        throw new AtomicWritePostCommitError('priorBackupDegraded', error)
      }
    }
    return mainDurability
  } finally {
    if (descriptor !== null) {
      try { closeSync(descriptor) } catch { /* 原始写入错误优先向上传播。 */ }
    }
    if (tempIdentity !== null) unlinkIfIdentityMatches(tempPath, tempIdentity)
    if (backupTempPath && backupTempIdentity !== null) {
      unlinkIfIdentityMatches(backupTempPath, backupTempIdentity)
    }
  }
}

/** 读取目标完整状态；不存在返回 null，存在但不是安全普通文件则拒绝。 */
function readDestinationState(path: string): AtomicFileState | null {
  try {
    const stat = lstatSync(path)
    if (!stat.isFile() || !isOwnedByCurrentUser(stat.uid)) {
      throw new Error('安全原子写入目标不是普通文件')
    }
    return toFileState(stat)
  } catch (error) {
    if (isMissingPathError(error)) return null
    throw error
  }
}

/** 在 temp 创建前确认当前状态满足调用方显式 CAS 预期。 */
function assertExpectedDestinationState(
  actual: AtomicFileState | null,
  expected: AtomicDestinationExpectation,
): void {
  if (expected.kind === 'missing') {
    if (actual !== null) throw new AtomicDestinationConflictError()
    return
  }
  if (actual === null || !isSameFileState(actual, expected.state)) {
    throw new AtomicDestinationConflictError()
  }
}

/** rename 前重新读取并确认显式 CAS 目标状态。 */
function assertExpectedDestination(path: string, expected: AtomicDestinationExpectation): void {
  let actual: AtomicFileState | null
  try {
    actual = readDestinationState(path)
  } catch {
    throw new AtomicDestinationConflictError()
  }
  assertExpectedDestinationState(actual, expected)
}

/** 确认普通安全路径的完整状态未在事务期间变化。 */
function assertDestinationStateUnchanged(
  path: string,
  expected: AtomicFileState | null,
): void {
  let actual: AtomicFileState | null
  try {
    actual = readDestinationState(path)
  } catch {
    throw new Error('安全原子写入备份目标状态已变化')
  }
  if ((actual === null) !== (expected === null)
    || (actual !== null && expected !== null && !isSameFileState(actual, expected))) {
    throw new Error('安全原子写入备份目标状态已变化')
  }
}

/** rename 前确认目标仍保持“缺失”或原文件身份，阻断目的路径置换。 */
function assertDestinationUnchanged(path: string, expected: FileSystemIdentity | null): void {
  if (expected === null) {
    try {
      lstatSync(path)
    } catch (error) {
      if (isMissingPathError(error)) return
      throw error
    }
    throw new Error('安全原子写入目标身份已变化')
  }
  assertIdentityUnchanged(path, expected, '安全原子写入目标身份已变化', false)
}

/** lstat 路径并确认类型与 dev/ino 均未改变。 */
function assertIdentityUnchanged(
  path: string,
  expected: FileSystemIdentity,
  message: string,
  expectDirectory: boolean,
): void {
  let stat: ReturnType<typeof lstatSync>
  try {
    stat = lstatSync(path)
  } catch (error) {
    throw new Error(message, { cause: error })
  }
  const matchesType = expectDirectory ? stat.isDirectory() : stat.isFile()
  if (!matchesType || !isSameIdentity(toIdentity(stat), expected)) throw new Error(message)
}

/** 只清理仍指向自己创建 inode 的 temp，绝不删除置换者文件。 */
function unlinkIfIdentityMatches(path: string, expected: FileSystemIdentity): void {
  try {
    const stat = lstatSync(path)
    if (stat.isFile() && isSameIdentity(toIdentity(stat), expected)) unlinkSync(path)
  } catch {
    // temp 已被删除或父目录被替换时没有可安全清理的当前路径。
  }
}

/** 提取跨复验稳定的文件系统身份字段。 */
function toIdentity(stat: Stats): FileSystemIdentity {
  return { dev: stat.dev, ino: stat.ino }
}

/** 提取显式 CAS 所需的完整 number 状态。 */
function toFileState(stat: Stats): AtomicFileState {
  return {
    ...toIdentity(stat),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  }
}

/** 比较文件身份和所有可观察内容版本字段。 */
function isSameFileState(left: AtomicFileState, right: AtomicFileState): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
}

/** 判断两个路径状态指向同一文件系统对象。 */
function isSameIdentity(left: FileSystemIdentity, right: FileSystemIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

/** POSIX 校验文件 owner；无 getuid 的 Windows 由独占创建与 ACL 保证。 */
function isOwnedByCurrentUser(uid: number): boolean {
  return typeof process.getuid !== 'function' || uid === process.getuid()
}

/** 只把明确不存在视为缺失，权限或 IO 错误继续 fail closed。 */
function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
}

/** 原子重写文本文件（用于 JSONL 会话等非单个 JSON 文档）。 */
export function writeTextFileAtomic(
  filePath: string,
  content: string,
  options: AtomicWriteOptions = {},
): DurabilityResult {
  const tmpPath = filePath + '.tmp'
  writeFileSync(tmpPath, content, 'utf-8')
  renameSync(tmpPath, filePath)
  return syncCommittedFileDurability(filePath, options)
}

/**
 * 迭代写入 JSONL 文件，并在所有记录完成落盘后原子替换主文件。
 * @param filePath 目标 JSONL 文件路径。
 * @param values 逐条序列化的纯对象迭代器，避免先构造整份大字符串。
 * @param options 原子提交后的持久化配置。
 * @returns 当前平台实际达到的持久化等级。
 */
export function writeJsonLinesFileAtomic(
  filePath: string,
  values: Iterable<object>,
  options: AtomicWriteOptions = {},
): DurabilityResult {
  /** 同目录临时文件保证最终 rename 不跨文件系统。 */
  const temporaryPath = `${filePath}.tmp`
  /** 临时文件 descriptor 只在本次完整写入期间持有。 */
  const descriptor = openSync(
    temporaryPath,
    constants.O_CREAT | constants.O_TRUNC | constants.O_WRONLY,
    0o600,
  )
  try {
    for (const value of values) {
      writeFileSync(descriptor, `${JSON.stringify(value)}\n`, 'utf8')
    }
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
  renameSync(temporaryPath, filePath)
  return syncCommittedFileDurability(filePath, options)
}

/**
 * 安全读取 JSON 索引文件
 * 优先读主文件，语法或 schema 无效时尝试 .tmp / .bak，都失败返回 null。
 *
 * @param filePath 主 JSON 文件路径。
 * @param options 可选的运行时 schema validator；省略时保持原有 parse-only 行为。
 * @returns 第一个有效候选，全部无效时返回 null。
 */
export function readJsonFileSafe<T>(filePath: string, options: ReadJsonFileSafeOptions<T> = {}): T | null {
  /** 上次原子写可能遗留的临时文件路径。 */
  const tmpPath = filePath + '.tmp'
  /** 上次成功主文件的备份路径。 */
  const bakPath = filePath + '.bak'

  // 1. 尝试读取主文件
  if (existsSync(filePath)) {
    /** 主文件是否成功读取并解析为 JSON。 */
    let parsedPrimary = false
    /** 主文件解析后的未知值，仅在 parsedPrimary 为 true 时校验。 */
    let primaryValue: unknown
    try {
      const raw = readFileSync(filePath, 'utf-8')
      if (raw.trim().length > 0) {
        primaryValue = JSON.parse(raw)
        parsedPrimary = true
      }
    } catch {
      console.warn(`[数据恢复] 主索引文件损坏: ${filePath}`)
    }
    if (parsedPrimary && isAcceptedJsonValue(primaryValue, options.validate)) {
      return primaryValue
    }
  }

  // 2. 检查是否有未完成的 .tmp 文件（上次 rename 前崩溃）
  if (existsSync(tmpPath)) {
    /** 临时文件是否成功读取并解析为 JSON。 */
    let parsedTmp = false
    /** 临时文件解析后的未知值，仅在 parsedTmp 为 true 时校验。 */
    let tmpValue: unknown
    try {
      const raw = readFileSync(tmpPath, 'utf-8')
      if (raw.trim().length > 0) {
        tmpValue = JSON.parse(raw)
        parsedTmp = true
      }
    } catch {
      // .tmp 也损坏，继续 fallback
    }
    if (parsedTmp && isAcceptedJsonValue(tmpValue, options.validate)) {
      // .tmp 有效 → 提升为主文件；提升失败必须保留 tmp 并向上传播。
      renameSync(tmpPath, filePath)
      syncCommittedFileDurability(filePath, options)
      console.log(`[数据恢复] 从 .tmp 文件恢复: ${filePath}`)
      return tmpValue
    }
    // 清理无效的 .tmp
    try { unlinkSync(tmpPath) } catch { /* ignore */ }
  }

  // 3. Fallback 到 .bak
  if (existsSync(bakPath)) {
    /** 备份文件是否成功读取并解析为 JSON。 */
    let parsedBackup = false
    /** 备份文件解析后的未知值，仅在 parsedBackup 为 true 时校验。 */
    let backupValue: unknown
    try {
      const raw = readFileSync(bakPath, 'utf-8')
      if (raw.trim().length > 0) {
        backupValue = JSON.parse(raw)
        parsedBackup = true
      }
    } catch {
      console.error(`[数据恢复] .bak 文件也损坏: ${bakPath}`)
    }
    if (parsedBackup && isAcceptedJsonValue(backupValue, options.validate)) {
      // 用 .bak 恢复主文件；恢复失败必须原样向上传播。
      writeJsonFileAtomic(filePath, backupValue as object, true, options)
      console.log(`[数据恢复] 从 .bak 文件恢复: ${filePath}`)
      return backupValue
    }
  }

  return null // 全部失败，需要上层从 JSONL 重建
}

/**
 * 严格读取主/tmp/bak JSON 候选：真正全部缺失返回 null，存在但全部损坏则抛错。
 * 普通展示读取继续使用 readJsonFileSafe；该边界只供不可丢数据的迁移提交使用。
 *
 * @param filePath 主 JSON 文件路径。
 * @param options 必需的运行时 schema 与业务错误上下文。
 * @returns 第一个合法候选，三个候选真正缺失时返回 null。
 */
export function readJsonFileStrict<T>(filePath: string, options: ReadJsonFileStrictOptions<T>): T | null {
  /** 读取前确认是否至少存在一个候选，区分“尚未创建”和“数据全部损坏”。 */
  const candidatePaths = [filePath, `${filePath}.tmp`, `${filePath}.bak`]
  const hasCandidate = candidatePaths.some(jsonCandidateExistsStrict)
  if (!hasCandidate) return null
  const value = readJsonFileSafe<T>(filePath, { validate: options.validate })
  if (value === null) throw new Error(`${options.description}的所有 JSON 候选均损坏`)
  return value
}

/** lstat 候选并只把明确不存在视为缺失，权限和 I/O 错误继续向上传播。 */
function jsonCandidateExistsStrict(candidatePath: string): boolean {
  try {
    lstatSync(candidatePath)
    return true
  } catch (error) {
    if (isMissingPathError(error)) return false
    throw error
  }
}

/**
 * 判断解析后的 JSON 是否满足可选 schema。
 *
 * @param value JSON.parse 返回的未知值。
 * @param validate 调用方可选的类型守卫。
 * @returns 未提供 validator 或校验通过时返回 true。
 */
function isAcceptedJsonValue<T>(
  value: unknown,
  validate: ReadJsonFileSafeOptions<T>['validate'],
): value is T {
  return validate === undefined || validate(value)
}
