import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import type { BigIntStats } from 'node:fs'
import { lstat, lutimes, open, readlink, realpath, rename, symlink, unlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { Transform, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** 单个流缓冲区固定为 64 KiB，内存只随并发数线性增长。 */
const STREAM_BUFFER_SIZE = 64 * 1024

/** 普通文件临时叶子的固定前缀，后缀使用不可预测 UUID。 */
const TEMPORARY_LEAF_PREFIX = '.proma-copy-'

/** 平台支持时阻止 open 跟随最终路径上的符号链接。 */
const NO_FOLLOW_FLAG = constants.O_NOFOLLOW ?? 0

/** 平台支持时要求元数据句柄打开的是目录。 */
const DIRECTORY_OPEN_FLAG = constants.O_DIRECTORY ?? 0

/** 文件系统对象稳定身份，用于操作前后检测路径替换。 */
export interface FileSystemIdentity {
  path: string
  canonicalPath: string
  dev: bigint
  ino: bigint
}

/** 最近现存祖先及预计 canonical 路径。 */
export interface ProspectivePathIdentity {
  canonicalPath: string
  anchor: FileSystemIdentity
  exists: boolean
}

/** 目录树条目共享的源身份和元数据。 */
export interface ScannedEntryBase {
  relativePath: string
  sourcePath: string
  mode: number
  atime: Date
  mtime: Date
  dev: bigint
  ino: bigint
  mtimeNs: bigint
}

/** 扫描得到的普通文件。 */
export interface ScannedFileEntry extends ScannedEntryBase {
  kind: 'file'
  size: number
  sizeBigInt: bigint
}

/** 扫描得到的目录。 */
export interface ScannedDirectoryEntry extends ScannedEntryBase {
  kind: 'directory'
}

/** 扫描得到的符号链接，只保留链接文本而不解析目标。 */
export interface ScannedSymbolicLinkEntry extends ScannedEntryBase {
  kind: 'symbolic-link'
  linkTarget: string
}

/** 源清单中的任意条目。 */
export type ScannedEntry = ScannedFileEntry | ScannedDirectoryEntry | ScannedSymbolicLinkEntry

/** 原子复制普通文件所需的受控参数。 */
export interface AtomicFileCopyInput {
  entry: ScannedFileEntry
  targetPath: string
  parentIdentity: FileSystemIdentity
  signal: AbortSignal
  /** 源和临时句柄就绪后、pipeline 开始前汇报当前文件。 */
  onStart: () => void
}

/** 以固定大小缓冲和 pipeline 计算普通文件 SHA-256。 */
export async function hashFile(filePath: string): Promise<string> {
  /** 使用 no-follow 打开的普通文件句柄。 */
  const handle = await openRegularFileNoFollow(resolve(filePath))
  try {
    return await hashOpenFile(handle)
  } finally {
    await handle.close()
  }
}

/** 对 manifest 普通文件执行句柄身份校验和流式 SHA-256。 */
export async function hashManifestFile(entry: ScannedFileEntry, signal: AbortSignal): Promise<string> {
  /** no-follow 打开的源文件句柄。 */
  const handle = await open(entry.sourcePath, constants.O_RDONLY | NO_FOLLOW_FLAG)
  try {
    await assertOpenSourceMatchesManifest(handle, entry)
    /** 当前源文件的流式 SHA-256。 */
    const hash = await hashOpenFile(handle, signal)
    await assertOpenSourceMatchesManifest(handle, entry)
    return hash
  } finally {
    await handle.close()
  }
}

/** 通过稳定句柄判断目标普通文件是否可安全复用。 */
export async function isReusableFile(
  targetPath: string,
  parentIdentity: FileSystemIdentity,
  entry: ScannedFileEntry,
  expectedHash: string,
  signal: AbortSignal,
): Promise<boolean> {
  await assertDirectoryIdentity(parentIdentity)
  /** 已有目标条目的 no-follow lstat。 */
  const pathStats = await lstatOrNull(targetPath)
  if (!pathStats?.isFile()) return false
  /** no-follow 打开的目标稳定句柄。 */
  const handle = await openRegularFileNoFollow(targetPath)
  try {
    /** 哈希前的实时元数据必须匹配源清单且 inode 仅有一个链接。 */
    const beforeStats = await handle.stat({ bigint: true })
    if (!targetMetadataMatchesManifest(beforeStats, entry)) return false
    /** 同一稳定句柄上的目标内容哈希。 */
    const actualHash = await hashOpenFile(handle, signal)
    /** 哈希后再次复验，捕获读取期间新增硬链接或元数据变化。 */
    const afterStats = await handle.stat({ bigint: true })
    await assertDirectoryIdentity(parentIdentity)
    return targetMetadataMatchesManifest(afterStats, entry) && actualHash === expectedHash
  } finally {
    await handle.close()
  }
}

/** 使用随机临时叶子、exclusive/no-follow open、pipeline 和原子 rename 复制普通文件。 */
export async function copyFileAtomic(input: AtomicFileCopyInput): Promise<void> {
  const { entry, targetPath, parentIdentity, signal, onStart } = input
  throwIfAborted(signal)
  await assertDirectoryIdentity(parentIdentity)
  /** 与最终文件同目录、名称不可预测的临时叶子。 */
  const temporaryPath = join(parentIdentity.path, `${TEMPORARY_LEAF_PREFIX}${randomUUID()}.tmp`)
  /** 使用 no-follow 打开的稳定源文件句柄。 */
  const sourceHandle = await open(entry.sourcePath, constants.O_RDONLY | NO_FOLLOW_FLAG)
  /** exclusive/no-follow 创建的临时文件句柄。 */
  let temporaryHandle: FileHandle | undefined
  /** 临时文件创建后的稳定身份。 */
  let temporaryIdentity: { dev: bigint; ino: bigint } | undefined
  try {
    await assertOpenSourceMatchesManifest(sourceHandle, entry)
    temporaryHandle = await open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW_FLAG,
      entry.mode,
    )
    /** 临时文件句柄本身的身份用于 rename 后确认。 */
    const temporaryStats = await temporaryHandle.stat({ bigint: true })
    if (!temporaryStats.isFile()) throw new Error(`复制临时叶子不是普通文件: ${entry.relativePath}`)
    temporaryIdentity = { dev: temporaryStats.dev, ino: temporaryStats.ino }
    onStart()
    throwIfAborted(signal)
    await assertDirectoryIdentity(parentIdentity)
    /** 源读取流从创建起立即交给 pipeline 统一监听错误。 */
    const readable = sourceHandle.createReadStream({ autoClose: false, highWaterMark: STREAM_BUFFER_SIZE })
    /** 取消 Transform 在每个固定数据块边界同步检查信号。 */
    const cancellationTransform = new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        try {
          throwIfAborted(signal)
          callback(null, chunk)
        } catch (error) {
          callback(toError(error))
        }
      },
    })
    /** 临时写入流由 pipeline 从创建时统一接管错误、关闭 fd 与 AbortSignal。 */
    const writable = temporaryHandle.createWriteStream({ autoClose: true })
    await pipeline(readable, cancellationTransform, writable, { signal })
    temporaryHandle = undefined
    await assertOpenSourceMatchesManifest(sourceHandle, entry)
    /** pipeline 关闭写句柄后 no-follow 重开随机临时叶子。 */
    const metadataHandle = await openRegularFileNoFollow(temporaryPath)
    try {
      /** rename 前只修改复制器独占的临时 inode，避免触碰目标树外硬链接。 */
      const metadataStats = await metadataHandle.stat({ bigint: true })
      if (metadataStats.dev !== temporaryIdentity.dev
        || metadataStats.ino !== temporaryIdentity.ino
        || metadataStats.nlink !== 1n) {
        throw new Error(`复制临时叶子元数据处理前身份不一致: ${entry.relativePath}`)
      }
      await bestEffortMetadata(`文件权限 ${entry.relativePath}`, () => metadataHandle.chmod(entry.mode))
      await bestEffortMetadata(`文件时间 ${entry.relativePath}`, () => metadataHandle.utimes(entry.atime, entry.mtime))
    } finally {
      await metadataHandle.close()
    }
    /** 关闭句柄后临时路径仍必须指向原先创建的 inode。 */
    const closedTemporaryStats = await lstat(temporaryPath, { bigint: true })
    if (!closedTemporaryStats.isFile()
      || closedTemporaryStats.dev !== temporaryIdentity.dev
      || closedTemporaryStats.ino !== temporaryIdentity.ino
      || closedTemporaryStats.nlink !== 1n) {
      throw new Error(`复制临时叶子关闭后身份不一致: ${entry.relativePath}`)
    }
    await assertDirectoryIdentity(parentIdentity)
    // Node 无跨平台 openat/renameat：随机临时名与前后 dev/ino/canonical 复验只能收敛竞态窗，无法形式化消除两次系统调用之间的目录替换。
    await rename(temporaryPath, targetPath)
    await assertDirectoryIdentity(parentIdentity)
    /** rename 后目标必须仍是刚才创建的同一普通文件。 */
    const targetStats = await lstat(targetPath, { bigint: true })
    if (!targetStats.isFile()
      || targetStats.dev !== temporaryIdentity.dev
      || targetStats.ino !== temporaryIdentity.ino
      || targetStats.nlink !== 1n) {
      throw new Error(`目标文件原子提交后身份不一致: ${entry.relativePath}`)
    }
    await assertDirectoryIdentity(parentIdentity)
  } catch (error) {
    await safelyRemoveTemporaryLeaf(temporaryPath, parentIdentity)
    throw normalizePipelineAbort(error, signal)
  } finally {
    await Promise.all([sourceHandle.close(), temporaryHandle?.close() ?? Promise.resolve()])
  }
}

/** 判断已有目标是否为链接文本完全相同的符号链接。 */
export async function isReusableSymbolicLink(
  targetPath: string,
  parentIdentity: FileSystemIdentity,
  expectedTarget: string,
): Promise<boolean> {
  await assertDirectoryIdentity(parentIdentity)
  /** 已有目标条目的 no-follow lstat。 */
  const stats = await lstatOrNull(targetPath)
  if (!stats?.isSymbolicLink()) return false
  /** readlink 只读取链接文本，不跟随或读取链接目标。 */
  const linkTarget = await readlink(targetPath)
  await assertDirectoryIdentity(parentIdentity)
  return linkTarget === expectedTarget
}

/** 在同目录随机临时链接上创建文本目标，再原子 rename 到最终路径。 */
export async function replaceSymbolicLinkAtomic(
  entry: ScannedSymbolicLinkEntry,
  targetPath: string,
  parentIdentity: FileSystemIdentity,
): Promise<void> {
  await assertDirectoryIdentity(parentIdentity)
  /** 与最终链接同目录的不可预测临时链接。 */
  const temporaryPath = join(parentIdentity.path, `${TEMPORARY_LEAF_PREFIX}${randomUUID()}.link`)
  try {
    await symlink(entry.linkTarget, temporaryPath)
    await assertDirectoryIdentity(parentIdentity)
    /** 临时条目必须仍是相同文本的链接。 */
    const temporaryStats = await lstat(temporaryPath, { bigint: true })
    if (!temporaryStats.isSymbolicLink() || await readlink(temporaryPath) !== entry.linkTarget) {
      throw new Error(`符号链接临时叶子身份不一致: ${entry.relativePath}`)
    }
    await rename(temporaryPath, targetPath)
    await assertDirectoryIdentity(parentIdentity)
  } catch (error) {
    try {
      await assertDirectoryIdentity(parentIdentity)
      if ((await lstatOrNull(temporaryPath))?.isSymbolicLink()) await unlink(temporaryPath)
    } catch {
      // 父目录身份失效时不沿字符串路径清理，避免触碰目标根外对象。
    }
    throw error
  }
}

/** 尽力保留符号链接时间，不 chmod 以免平台跟随外部链接目标。 */
export async function preserveSymbolicLinkMetadata(
  entry: ScannedSymbolicLinkEntry,
  targetPath: string,
  parentIdentity: FileSystemIdentity,
): Promise<void> {
  await assertDirectoryIdentity(parentIdentity)
  await bestEffortMetadata(`符号链接时间 ${entry.relativePath}`, () => lutimes(targetPath, entry.atime, entry.mtime))
  await assertDirectoryIdentity(parentIdentity)
}

/** 尽力通过目录句柄保留权限与时间，避免重新解析可替换路径。 */
export async function preserveDirectoryMetadata(
  entry: ScannedDirectoryEntry,
  identity: FileSystemIdentity,
): Promise<void> {
  await assertDirectoryIdentity(identity)
  try {
    /** no-follow 打开的目录句柄。 */
    const handle = await open(identity.path, constants.O_RDONLY | DIRECTORY_OPEN_FLAG | NO_FOLLOW_FLAG)
    try {
      await bestEffortMetadata(`目录权限 ${entry.relativePath || '.'}`, () => handle.chmod(entry.mode))
      await bestEffortMetadata(`目录时间 ${entry.relativePath || '.'}`, () => handle.utimes(entry.atime, entry.mtime))
    } finally {
      await handle.close()
    }
  } catch (error) {
    console.warn(`[目录复制] 无法通过句柄保留目录元数据 ${entry.relativePath || '.'}:`, error)
  }
  await assertDirectoryIdentity(identity)
}

/** 从 bigint lstat 提取稳定身份和元数据。 */
export function metadataFromStats(stats: BigIntStats): Omit<ScannedEntryBase, 'relativePath' | 'sourcePath'> {
  return {
    mode: Number(stats.mode),
    atime: new Date(Number(stats.atimeMs)),
    mtime: new Date(Number(stats.mtimeMs)),
    dev: stats.dev,
    ino: stats.ino,
    mtimeNs: stats.mtimeNs,
  }
}

/** 捕获普通目录的 canonical 路径和 dev/ino 身份。 */
export async function captureDirectoryIdentity(directoryPath: string): Promise<FileSystemIdentity> {
  /** no-follow bigint lstat。 */
  const stats = await lstat(directoryPath, { bigint: true })
  if (!stats.isDirectory()) throw new Error(`目录身份捕获失败，路径不是普通目录: ${directoryPath}`)
  return { path: directoryPath, canonicalPath: await realpath(directoryPath), dev: stats.dev, ino: stats.ino }
}

/** 复验目录仍是原 dev/ino 和 canonical 路径。 */
export async function assertDirectoryIdentity(identity: FileSystemIdentity): Promise<void> {
  /** 当前路径的 no-follow bigint lstat。 */
  const stats = await lstat(identity.path, { bigint: true })
  if (!stats.isDirectory()
    || stats.dev !== identity.dev
    || stats.ino !== identity.ino
    || normalizePathForIdentity(await realpath(identity.path)) !== normalizePathForIdentity(identity.canonicalPath)) {
    throw new Error(`目录身份复验失败: ${identity.path}`)
  }
}

/** 解析目标最近现存祖先和预计 canonical 路径。 */
export async function resolveProspectivePath(requestedPath: string): Promise<ProspectivePathIdentity> {
  /** 从目标向上查找时积累的缺失路径片段。 */
  const missingSegments: string[] = []
  /** 当前正在探测的路径。 */
  let candidate = resolve(requestedPath)
  while (true) {
    /** 当前候选的 no-follow lstat。 */
    const stats = await lstatOrNull(candidate)
    if (stats) {
      if (stats.isSymbolicLink()) throw new Error(`目标路径现存祖先不能是符号链接: ${candidate}`)
      if (!stats.isDirectory()) throw new Error(`目标路径现存祖先不是目录: ${candidate}`)
      /** 最近现存祖先身份。 */
      const anchor = await captureDirectoryIdentity(candidate)
      /** 在真实祖先后追加尚不存在的路径片段。 */
      const canonicalPath = missingSegments.reduce((current, segment) => join(current, segment), anchor.canonicalPath)
      return { canonicalPath, anchor, exists: missingSegments.length === 0 }
    }
    /** 当前缺失路径的父目录。 */
    const parent = dirname(candidate)
    if (parent === candidate) throw new Error(`无法解析目标最近现存祖先: ${requestedPath}`)
    missingSegments.unshift(basename(candidate))
    candidate = parent
  }
}

/** 拒绝 canonical 同路径或任一方向嵌套的源目标。 */
export function validateRootRelationship(sourceRoot: string, targetRoot: string): void {
  /** 用于当前平台身份比较的源 canonical 路径。 */
  const normalizedSource = normalizePathForIdentity(sourceRoot)
  /** 用于当前平台身份比较的目标 canonical 路径。 */
  const normalizedTarget = normalizePathForIdentity(targetRoot)
  if (normalizedSource === normalizedTarget
    || isPathInside(normalizedSource, normalizedTarget)
    || isPathInside(normalizedTarget, normalizedSource)) {
    throw new Error('复制源与目标物理路径不能相同或互相嵌套')
  }
}

/** 将相对条目解析到根内，并拒绝根本身与路径逃逸。 */
export function resolveContainedPath(root: string, relativePath: string): string {
  /** 解析后的绝对候选路径。 */
  const candidate = resolve(root, relativePath)
  if (!isPathInside(root, candidate)) throw new Error(`目录条目路径逃逸目标根: ${relativePath}`)
  return candidate
}

/** 返回条目父目录相对路径，根下叶子返回空字符串。 */
export function relativeParent(relativePath: string): string {
  /** path.dirname 对根下文件返回点号。 */
  const parent = dirname(relativePath)
  return parent === '.' ? '' : parent
}

/** 返回相对路径深度。 */
export function pathDepth(relativePath: string): number {
  return relativePath.length === 0 ? 0 : relativePath.split(sep).length
}

/** lstat 不存在路径时返回 null，其他错误保持原样。 */
export async function lstatOrNull(filePath: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(filePath)
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return null
    throw error
  }
}

/** 在入口、文件和数据块边界抛出标准 AbortError。 */
export function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  /** 对调用方可识别的标准取消错误。 */
  const error = new Error('目录复制已取消')
  error.name = 'AbortError'
  throw error
}

/** 使用 pipeline 从打开句柄计算 SHA-256。 */
async function hashOpenFile(handle: FileHandle, signal?: AbortSignal): Promise<string> {
  throwIfAborted(signal)
  /** 增量 SHA-256 计算器。 */
  const hash = createHash('sha256')
  /** 从句柄创建后立即交给 pipeline 的读取流。 */
  const readable = handle.createReadStream({ autoClose: false, highWaterMark: STREAM_BUFFER_SIZE })
  /** 消费每个固定缓冲数据块的 hash sink。 */
  const sink = new Writable({
    write: (chunk: Buffer, _encoding, callback) => {
      try {
        throwIfAborted(signal)
        hash.update(chunk)
        throwIfAborted(signal)
        callback()
      } catch (error) {
        callback(toError(error))
      }
    },
  })
  try {
    await pipeline(readable, sink, { signal })
    return hash.digest('hex')
  } catch (error) {
    throw normalizePipelineAbort(error, signal)
  }
}

/** 以 no-follow 打开并确认普通文件身份。 */
async function openRegularFileNoFollow(filePath: string): Promise<FileHandle> {
  /** 打开前的 no-follow bigint lstat。 */
  const pathStats = await lstat(filePath, { bigint: true })
  if (!pathStats.isFile()) throw new Error(`哈希目标不是普通文件: ${filePath}`)
  /** 使用 no-follow 的只读句柄。 */
  const handle = await open(filePath, constants.O_RDONLY | NO_FOLLOW_FLAG)
  try {
    /** 打开对象的实时类型。 */
    const stats = await handle.stat({ bigint: true })
    if (!stats.isFile() || stats.dev !== pathStats.dev || stats.ino !== pathStats.ino) {
      throw new Error(`哈希目标打开前后身份不一致: ${filePath}`)
    }
    return handle
  } catch (error) {
    await handle.close()
    throw error
  }
}

/** 对源打开句柄 fstat，确认与初始 manifest 一致。 */
async function assertOpenSourceMatchesManifest(handle: FileHandle, entry: ScannedFileEntry): Promise<void> {
  /** 打开源句柄的实时 bigint stat。 */
  const stats = await handle.stat({ bigint: true })
  if (!stats.isFile()
    || stats.dev !== entry.dev
    || stats.ino !== entry.ino
    || Number(stats.mode) !== entry.mode
    || stats.size !== entry.sizeBigInt
    || stats.mtimeNs !== entry.mtimeNs) {
    throw new Error(`源目录普通文件在复制期间发生变化: ${entry.relativePath}`)
  }
}

/** 判断目标句柄元数据是否与源清单一致且没有其他硬链接。 */
function targetMetadataMatchesManifest(stats: BigIntStats, entry: ScannedFileEntry): boolean {
  /** Date 精度为毫秒，目标 utimes 也按同一精度写入。 */
  const expectedMtimeNs = BigInt(entry.mtime.getTime()) * 1_000_000n
  return stats.isFile()
    && stats.nlink === 1n
    && stats.size === entry.sizeBigInt
    && Number(stats.mode) === entry.mode
    && stats.mtimeNs === expectedMtimeNs
}

/** 仅在父目录身份仍可信时清理随机临时叶子。 */
async function safelyRemoveTemporaryLeaf(
  temporaryPath: string,
  parentIdentity: FileSystemIdentity,
): Promise<void> {
  try {
    await assertDirectoryIdentity(parentIdentity)
    /** 临时叶子的 no-follow lstat。 */
    const stats = await lstatOrNull(temporaryPath)
    if (stats?.isFile()) await unlink(temporaryPath)
  } catch {
    // Node 没有跨平台 openat：父目录身份不可信时宁可留下迁移临时文件，也不沿字符串路径清理根外对象。
  }
}

/** 执行平台相关元数据操作，失败只输出 warning。 */
async function bestEffortMetadata(label: string, operation: () => Promise<void>): Promise<void> {
  try {
    await operation()
  } catch (error) {
    console.warn(`[目录复制] 无法保留${label}:`, error)
  }
}

/** 当前平台路径身份比较规范化。 */
function normalizePathForIdentity(filePath: string): string {
  return process.platform === 'win32' ? filePath.toLowerCase() : filePath
}

/** 使用 path.relative 判断 candidate 是否严格位于 root 内。 */
function isPathInside(root: string, candidate: string): boolean {
  /** 从根到候选的相对路径。 */
  const relativePath = relative(root, candidate)
  return relativePath.length > 0
    && relativePath !== '..'
    && !relativePath.startsWith(`..${sep}`)
    && !isAbsolute(relativePath)
}

/** 判断未知错误是否带 Node.js 文件系统错误码。 */
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

/** 把未知异常转换为 stream callback 接受的 Error。 */
function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

/** pipeline 因 signal 取消时保留可识别 AbortError。 */
function normalizePipelineAbort(error: unknown, signal?: AbortSignal): Error {
  if (signal?.aborted) {
    /** 对调用方稳定暴露的取消错误。 */
    const abortError = new Error('目录复制已取消')
    abortError.name = 'AbortError'
    return abortError
  }
  return toError(error)
}
