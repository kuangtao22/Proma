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
export interface ReadJsonFileSafeOptions<T> {
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

/** no-follow 原子 JSON 写入的故障注入配置。 */
export interface SecureAtomicJsonWriteOptions {
  /** 临时文件完成 fsync/close 后、最终身份复验前调用，仅供竞态回归测试。 */
  beforeRename?: (tempPath: string) => void
  /** rename 后同步父目录；生产默认执行真实目录 fsync。 */
  syncDirectory?: (directoryPath: string) => void
}

/** 原子删除普通文件时允许替换的窄测试依赖。 */
export interface AtomicFileRemoveOptions {
  /** rename 完成后、身份复验前调用，仅供稳定覆盖置换竞态。 */
  afterRenameBeforeVerify?: (tombstonePath: string) => void
  /** rename 已提交后清理 tombstone；生产默认使用 unlinkSync。 */
  unlinkTombstone?: (tombstonePath: string) => void
  /** 每次目录项变更后同步父目录；生产默认执行真实目录 fsync。 */
  syncDirectory?: (directoryPath: string) => void
}

/** 持久创建目录时允许替换的窄测试依赖。 */
export interface DurableDirectoryOptions {
  /** 创建目录后同步父目录和新目录；生产默认执行真实目录 fsync。 */
  syncDirectory?: (directoryPath: string) => void
}

/** 需要跨检查保持不变的文件系统对象身份。 */
interface FileSystemIdentity {
  /** 所在设备编号。 */
  dev: number
  /** 同一设备内 inode/file index。 */
  ino: number
}

/**
 * 原子写入 JSON 文件：write-to-temp → rename
 * 写入前自动保留 .bak 备份
 */
export function writeJsonFileAtomic(filePath: string, data: object, skipBackup = false): void {
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
  syncDirectoryDurable(dirname(filePath))
}

/** 原子删除保留的匿名 tombstone 名称，不包含原始业务路径。 */
const ATOMIC_DELETE_TOMBSTONE_PATTERN = /^\.proma-delete-(\d+)-(\d+)-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tombstone$/i

/**
 * 先把明确的普通文件原子移出原路径，再清理同目录唯一 tombstone。
 * rename 成功即视为业务删除已提交；后续清理失败不会把旧文件恢复到原路径。
 *
 * @param filePath 需要删除的绝对普通文件路径。
 * @param options 可替换的 tombstone 清理依赖，仅用于稳定故障测试。
 */
export function removeFileAtomic(filePath: string, options: AtomicFileRemoveOptions = {}): void {
  if (!isAbsolute(filePath) || basename(filePath) === '.' || basename(filePath) === '..') {
    throw new Error('原子删除必须使用明确的绝对文件路径')
  }
  /** 父目录存在时先回收此前已提交但未清理的匿名 tombstone。 */
  const parentPath = dirname(filePath)
  let parentStat: ReturnType<typeof lstatSync>
  try {
    parentStat = lstatSync(parentPath)
  } catch (error) {
    if (isMissingPathError(error)) return
    throw error
  }
  if (!parentStat.isDirectory()) throw new Error('原子删除父路径不是目录')
  const parentIdentity = toIdentity(parentStat)
  const syncDirectory = options.syncDirectory ?? syncDirectoryDurable
  recoverAtomicDeleteTombstones(parentPath, parentIdentity, options.unlinkTombstone ?? unlinkSync, syncDirectory)

  /** 删除前 no-follow 读取的目标身份。 */
  let targetStat: ReturnType<typeof lstatSync>
  try {
    targetStat = lstatSync(filePath)
  } catch (error) {
    if (isMissingPathError(error)) return
    throw error
  }
  if (!targetStat.isFile()) throw new Error('原子删除目标不是普通文件')
  const targetIdentity = toIdentity(targetStat)

  /** 同目录随机 tombstone，避免与并发删除或历史残留冲突。 */
  const tombstonePath = join(
    parentPath,
    `.proma-delete-${targetIdentity.dev}-${targetIdentity.ino}-${randomUUID()}.tombstone`,
  )
  assertIdentityUnchanged(parentPath, parentIdentity, '原子删除父目录身份已变化', true)
  assertIdentityUnchanged(filePath, targetIdentity, '原子删除目标身份已变化', false)
  renameSync(filePath, tombstonePath)
  options.afterRenameBeforeVerify?.(tombstonePath)
  /** rename 后任何置换都 fail closed：保留当前路径，不猜测哪个对象可以删除。 */
  assertIdentityUnchanged(parentPath, parentIdentity, '原子删除父目录身份已变化', true)
  assertIdentityUnchanged(tombstonePath, targetIdentity, '原子删除 tombstone 身份已变化', false)
  syncDirectory(parentPath)
  try {
    /** 生产使用 unlinkSync，测试可稳定注入 rename 后清理失败。 */
    const unlinkTombstone = options.unlinkTombstone ?? unlinkSync
    unlinkTombstone(tombstonePath)
    syncDirectory(parentPath)
  } catch (error) {
    throw new Error(`原子删除已提交，但 tombstone 清理失败: ${tombstonePath}`, { cause: error })
  }
}

/**
 * 幂等回收同目录内由 Proma 原子删除协议遗留的匿名 tombstone。
 *
 * @param parentPath 已确认存在的实际父目录。
 * @param parentIdentity 调用开始时固定的父目录身份。
 * @param unlinkTombstone 删除已验证 tombstone 的实现。
 * @param syncDirectory 每次 unlink 后持久同步父目录的实现。
 */
function recoverAtomicDeleteTombstones(
  parentPath: string,
  parentIdentity: FileSystemIdentity,
  unlinkTombstone: (tombstonePath: string) => void,
  syncDirectory: (directoryPath: string) => void,
): void {
  for (const entry of readdirSync(parentPath, { withFileTypes: true })) {
    const nameMatch = ATOMIC_DELETE_TOMBSTONE_PATTERN.exec(entry.name)
    if (!nameMatch) continue
    /** 文件名中的原 inode 身份用于拒绝后续同名置换。 */
    const expectedIdentity: FileSystemIdentity = {
      dev: Number(nameMatch[1]),
      ino: Number(nameMatch[2]),
    }
    /** 候选必须保持为当前用户拥有的单链接普通文件。 */
    const tombstonePath = join(parentPath, entry.name)
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
      unlinkTombstone(tombstonePath)
      syncDirectory(parentPath)
    } catch (error) {
      throw new Error(`原子删除 tombstone 回收失败: ${tombstonePath}`, { cause: error })
    }
  }
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
): void {
  if (!isAbsolute(directoryPath)) throw new Error('持久目录路径必须是绝对路径')
  try {
    const existingStat = lstatSync(directoryPath)
    if (!existingStat.isDirectory()) throw new Error('持久目录路径不是实际目录')
    return
  } catch (error) {
    if (!isMissingPathError(error)) throw error
  }
  /** 新目录的父目录必须先存在且保持为实际目录。 */
  const parentPath = dirname(directoryPath)
  const parentStat = lstatSync(parentPath)
  if (!parentStat.isDirectory()) throw new Error('持久目录父路径不是实际目录')
  mkdirSync(directoryPath)
  const syncDirectory = options.syncDirectory ?? syncDirectoryDurable
  syncDirectory(parentPath)
  syncDirectory(directoryPath)
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
): void {
  /** 父目录在创建 temp 与 rename 之间必须保持同一文件系统身份。 */
  const parentPath = dirname(filePath)
  const parentStat = lstatSync(parentPath)
  if (!parentStat.isDirectory()) throw new Error('安全原子写入父路径不是目录')
  const parentIdentity = toIdentity(parentStat)
  /** 目标缺失或为当前用户拥有的普通文件，symlink/device 一律拒绝。 */
  const destinationIdentity = readDestinationIdentity(filePath)
  /** 随机同目录名称避免攻击者预置固定 `.tmp` 路径。 */
  const tempPath = join(parentPath, `.${basename(filePath)}.${randomUUID()}.tmp`)
  /** temp 创建后固定的身份，只用于清理自己创建且未被替换的路径。 */
  let tempIdentity: FileSystemIdentity | null = null
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

    options.beforeRename?.(tempPath)
    assertIdentityUnchanged(parentPath, parentIdentity, '安全原子写入父目录身份已变化', true)
    assertDestinationUnchanged(filePath, destinationIdentity)
    assertIdentityUnchanged(tempPath, tempIdentity, '安全原子写入临时文件身份已变化', false)
    renameSync(tempPath, filePath)
    tempIdentity = null
    const syncDirectory = options.syncDirectory ?? syncDirectoryDurable
    syncDirectory(parentPath)
  } finally {
    if (descriptor !== null) {
      try { closeSync(descriptor) } catch { /* 原始写入错误优先向上传播。 */ }
    }
    if (tempIdentity !== null) unlinkIfIdentityMatches(tempPath, tempIdentity)
  }
}

/** 读取目标身份；不存在返回 null，存在但不是安全普通文件则拒绝。 */
function readDestinationIdentity(path: string): FileSystemIdentity | null {
  try {
    const stat = lstatSync(path)
    if (!stat.isFile() || !isOwnedByCurrentUser(stat.uid)) {
      throw new Error('安全原子写入目标不是普通文件')
    }
    return toIdentity(stat)
  } catch (error) {
    if (isMissingPathError(error)) return null
    throw error
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
export function writeTextFileAtomic(filePath: string, content: string): void {
  const tmpPath = filePath + '.tmp'
  writeFileSync(tmpPath, content, 'utf-8')
  renameSync(tmpPath, filePath)
  syncDirectoryDurable(dirname(filePath))
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
      syncDirectoryDurable(dirname(filePath))
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
      writeJsonFileAtomic(filePath, backupValue as object, true)
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
