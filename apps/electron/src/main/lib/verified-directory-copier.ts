import {
  chmod,
  lstat,
  lutimes,
  mkdir,
  opendir,
  readlink,
  rm,
  symlink,
  utimes,
} from 'node:fs/promises'
import { createReadStream, createWriteStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { finished } from 'node:stream/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Stats } from 'node:fs'
import type { DataRootMigrationProgress } from '@proma/shared'
import { readJsonFileSafe, writeJsonFileAtomic } from './safe-file'

/** 复制断点在目标目录内使用的保留文件名。 */
export const DIRECTORY_COPY_MARKER_FILE = '.proma-directory-copy.json'

/** 单个流缓冲区固定为 64 KiB，避免内存随文件大小增长。 */
const STREAM_BUFFER_SIZE = 64 * 1024

/** 断点 marker 的稳定 schema。 */
interface DirectoryCopyMarker {
  version: 1
  migrationId: string
  sourceRoot: string
  targetRoot: string
}

/** 目录树内所有条目共享的扫描信息。 */
interface ScannedEntryBase {
  relativePath: string
  sourcePath: string
  mode: number
  atime: Date
  mtime: Date
}

/** 扫描得到的普通文件。 */
interface ScannedFileEntry extends ScannedEntryBase {
  kind: 'file'
  size: number
}

/** 扫描得到的目录。 */
interface ScannedDirectoryEntry extends ScannedEntryBase {
  kind: 'directory'
}

/** 扫描得到的符号链接；链接目标仅保存文本，不解析或跟随。 */
interface ScannedSymbolicLinkEntry extends ScannedEntryBase {
  kind: 'symbolic-link'
  linkTarget: string
}

/** 完整扫描结果，普通文件字节数用于稳定进度上限。 */
interface DirectoryManifest {
  root: ScannedDirectoryEntry
  directories: ScannedDirectoryEntry[]
  leaves: Array<ScannedFileEntry | ScannedSymbolicLinkEntry>
  totalBytes: number
}

/** 并发 worker 共享的执行统计与进度状态。 */
interface CopyState {
  completedBytes: number
  verifiedFiles: number
  reusedFiles: number
}

/** 单个文件或链接复制时使用的稳定上下文。 */
interface CopyContext {
  input: NormalizedCopyDirectoryInput
  manifest: DirectoryManifest
  state: CopyState
}

/** 解析为绝对路径并补齐默认并发数的输入。 */
interface NormalizedCopyDirectoryInput extends CopyDirectoryInput {
  sourceRoot: string
  targetRoot: string
  concurrency: number
}

/** 可恢复目录复制的调用参数。 */
export interface CopyDirectoryInput {
  migrationId: string
  sourceRoot: string
  targetRoot: string
  concurrency?: number
  signal?: AbortSignal
  onProgress: (progress: DataRootMigrationProgress) => void
}

/** 目录复制与逐项校验后的统计。 */
export interface CopyDirectoryResult {
  verifiedFiles: number
  reusedFiles: number
  totalBytes: number
}

/**
 * 以固定大小读取缓冲计算普通文件 SHA-256。
 *
 * @param filePath 需要哈希的普通文件路径。
 * @returns 小写十六进制 SHA-256。
 */
export async function hashFile(filePath: string): Promise<string> {
  return hashFileWithSignal(filePath)
}

/**
 * 流式复制目录树并逐文件校验，支持同 migrationId 的断点恢复。
 *
 * @param input 迁移标识、源目标目录、取消信号和进度回调。
 * @returns 已校验、已复用条目数及普通文件总字节数。
 */
export async function copyDirectoryVerified(input: CopyDirectoryInput): Promise<CopyDirectoryResult> {
  /** 完成默认值与绝对路径归一化后的复制参数。 */
  const normalizedInput = normalizeInput(input)
  validateRootRelationship(normalizedInput.sourceRoot, normalizedInput.targetRoot)
  throwIfAborted(normalizedInput.signal)

  /** 源目录的一次性清单，保证特殊文件在写目标前被拒绝。 */
  const manifest = await scanDirectory(normalizedInput.sourceRoot, normalizedInput.signal)
  await prepareTargetRoot(normalizedInput)
  await prepareTargetDirectories(manifest, normalizedInput)

  /** 所有低并发 worker 共享的单调进度和结果统计。 */
  const state: CopyState = { completedBytes: 0, verifiedFiles: 0, reusedFiles: 0 }
  /** worker 每次领取下一个条目的共享下标。 */
  let nextIndex = 0
  /** 首个 worker 错误，用于停止领取新任务并在全部 worker 收敛后抛出。 */
  let firstError: unknown
  /** 单个 worker 循环领取文件或链接并完成复制校验。 */
  const runWorker = async (): Promise<void> => {
    while (firstError === undefined) {
      /** 当前 worker 独占领取的清单下标。 */
      const currentIndex = nextIndex
      nextIndex += 1
      /** 当前 worker 需要处理的文件或链接。 */
      const entry = manifest.leaves[currentIndex]
      if (!entry) return
      try {
        await copyAndVerifyEntry(entry, { input: normalizedInput, manifest, state })
      } catch (error) {
        if (firstError === undefined) firstError = error
      }
    }
  }
  /** 实际 worker 数不会超过文件数，也不会低于一。 */
  const workerCount = Math.max(1, Math.min(normalizedInput.concurrency, manifest.leaves.length || 1))
  await Promise.all(Array.from({ length: workerCount }, runWorker))
  if (firstError !== undefined) throw firstError

  await preserveAllDirectoryMetadata(manifest, normalizedInput.targetRoot)
  return {
    verifiedFiles: state.verifiedFiles,
    reusedFiles: state.reusedFiles,
    totalBytes: manifest.totalBytes,
  }
}

/** 校验和标准化外部输入，避免无界并发或空迁移标识。 */
function normalizeInput(input: CopyDirectoryInput): NormalizedCopyDirectoryInput {
  /** 调用方指定或默认使用的低并发数。 */
  const concurrency = input.concurrency ?? 2
  if (input.migrationId.trim().length === 0) throw new Error('目录复制 migrationId 不能为空')
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error('目录复制 concurrency 必须是正整数')
  return {
    ...input,
    migrationId: input.migrationId,
    sourceRoot: resolve(input.sourceRoot),
    targetRoot: resolve(input.targetRoot),
    concurrency,
  }
}

/** 拒绝相同或互相嵌套的源目标根，防止递归复制和源数据覆盖。 */
function validateRootRelationship(sourceRoot: string, targetRoot: string): void {
  if (sourceRoot === targetRoot || isPathInside(sourceRoot, targetRoot) || isPathInside(targetRoot, sourceRoot)) {
    throw new Error('目录复制的源目录与目标目录不能相同或互相嵌套')
  }
}

/** 递归扫描源目录，符号链接只读取链接文本，任何特殊文件都明确失败。 */
async function scanDirectory(sourceRoot: string, signal?: AbortSignal): Promise<DirectoryManifest> {
  throwIfAborted(signal)
  /** 源根目录自身的 lstat，不允许把根符号链接当目录跟随。 */
  const rootStats = await lstat(sourceRoot)
  if (!rootStats.isDirectory()) throw new Error(`复制源根不是普通目录: ${sourceRoot}`)
  /** 用于最终保留目标根元数据的根条目。 */
  const root = createDirectoryEntry('', sourceRoot, rootStats)
  /** 按扫描顺序保存的全部子目录。 */
  const directories: ScannedDirectoryEntry[] = []
  /** 等待低并发复制与校验的普通文件和符号链接。 */
  const leaves: Array<ScannedFileEntry | ScannedSymbolicLinkEntry> = []
  /** 普通文件内容的总字节数。 */
  let totalBytes = 0

  /** 扫描单个目录，不跟随扫描中遇到的符号链接。 */
  const visit = async (relativeDirectory: string): Promise<void> => {
    throwIfAborted(signal)
    /** 当前扫描目录的绝对路径。 */
    const directoryPath = relativeDirectory.length === 0 ? sourceRoot : resolveContainedPath(sourceRoot, relativeDirectory)
    /** 使用异步目录迭代避免一次读取超大目录的全部名称。 */
    const handle = await opendir(directoryPath)
    for await (const directoryEntry of handle) {
      throwIfAborted(signal)
      /** 当前条目相对源根的跨平台路径。 */
      const relativePath = relativeDirectory.length === 0
        ? directoryEntry.name
        : join(relativeDirectory, directoryEntry.name)
      if (relativePath === DIRECTORY_COPY_MARKER_FILE) {
        throw new Error(`源目录包含复制器保留文件名: ${DIRECTORY_COPY_MARKER_FILE}`)
      }
      /** 当前条目经过 containment 校验后的绝对路径。 */
      const sourcePath = resolveContainedPath(sourceRoot, relativePath)
      /** lstat 保证符号链接不会被透明跟随。 */
      const stats = await lstat(sourcePath)
      if (stats.isDirectory()) {
        /** 当前扫描到的目录条目。 */
        const childDirectory = createDirectoryEntry(relativePath, sourcePath, stats)
        directories.push(childDirectory)
        await visit(relativePath)
      } else if (stats.isFile()) {
        leaves.push({
          kind: 'file',
          relativePath,
          sourcePath,
          size: stats.size,
          ...metadataFromStats(stats),
        })
        totalBytes += stats.size
      } else if (stats.isSymbolicLink()) {
        /** 链接目标保持原始文本，绝不 realpath 或 stat。 */
        const linkTarget = await readlink(sourcePath)
        leaves.push({
          kind: 'symbolic-link',
          relativePath,
          sourcePath,
          linkTarget,
          ...metadataFromStats(stats),
        })
      } else {
        throw new Error(`源目录包含不支持的特殊文件: ${relativePath}`)
      }
    }
  }

  await visit('')
  return { root, directories, leaves, totalBytes }
}

/** 从 lstat 结果提取尽力保留的通用元数据。 */
function metadataFromStats(stats: Stats): Pick<ScannedEntryBase, 'mode' | 'atime' | 'mtime'> {
  return { mode: stats.mode, atime: stats.atime, mtime: stats.mtime }
}

/** 创建一个目录扫描条目。 */
function createDirectoryEntry(relativePath: string, sourcePath: string, stats: Stats): ScannedDirectoryEntry {
  return { kind: 'directory', relativePath, sourcePath, ...metadataFromStats(stats) }
}

/** 校验目标为空或归属于同一个 migrationId，并使用 safe-file 原子创建新 marker。 */
async function prepareTargetRoot(input: NormalizedCopyDirectoryInput): Promise<void> {
  throwIfAborted(input.signal)
  /** 目标根存在时的 lstat；符号链接根不得被跟随。 */
  const targetStats = await lstatOrNull(input.targetRoot)
  if (targetStats && !targetStats.isDirectory()) throw new Error(`复制目标根不是普通目录: ${input.targetRoot}`)
  if (!targetStats) await mkdir(input.targetRoot, { recursive: true })

  /** 目标根当前直接包含的名称。 */
  const targetNames: string[] = []
  /** 异步遍历目标根，避免为超大断点目录额外分配 Dirent 数组。 */
  const targetHandle = await opendir(input.targetRoot)
  for await (const entry of targetHandle) targetNames.push(entry.name)
  /** 目标断点 marker 的固定路径。 */
  const markerPath = join(input.targetRoot, DIRECTORY_COPY_MARKER_FILE)
  if (targetNames.length === 0) {
    /** 首次复制使用的严格 marker。 */
    const marker: DirectoryCopyMarker = {
      version: 1,
      migrationId: input.migrationId,
      sourceRoot: input.sourceRoot,
      targetRoot: input.targetRoot,
    }
    writeJsonFileAtomic(markerPath, marker)
    return
  }
  /** safe-file 可能在崩溃边界留下的三个可信 marker 候选名称。 */
  const markerCandidateNames = [
    DIRECTORY_COPY_MARKER_FILE,
    `${DIRECTORY_COPY_MARKER_FILE}.tmp`,
    `${DIRECTORY_COPY_MARKER_FILE}.bak`,
  ]
  if (!targetNames.some((name) => markerCandidateNames.includes(name))) {
    throw new Error('复制目标非空且没有可信断点 marker，拒绝覆盖')
  }

  /** 经 safe-file 语法恢复和严格 schema 校验后的 marker。 */
  const marker = readJsonFileSafe<DirectoryCopyMarker>(markerPath, { validate: isDirectoryCopyMarker })
  if (!marker) throw new Error('复制目标 marker 无效，拒绝恢复')
  if (marker.migrationId !== input.migrationId) throw new Error('复制目标的迁移标识与当前任务不一致')
  if (marker.sourceRoot !== input.sourceRoot || marker.targetRoot !== input.targetRoot) {
    throw new Error('复制目标 marker 的源目标路径与当前任务不一致')
  }
}

/** 严格校验 marker 字段集合和值类型，拒绝宽松兼容未知 schema。 */
function isDirectoryCopyMarker(value: unknown): value is DirectoryCopyMarker {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  /** 转成只读未知字段映射后逐项校验。 */
  const record = value as Record<string, unknown>
  /** marker 允许的完整字段集合。 */
  const expectedKeys = ['migrationId', 'sourceRoot', 'targetRoot', 'version']
  /** 实际字段按字典序排列后用于严格比较。 */
  const actualKeys = Object.keys(record).sort()
  return actualKeys.length === expectedKeys.length
    && actualKeys.every((key, index) => key === expectedKeys[index])
    && record.version === 1
    && typeof record.migrationId === 'string'
    && typeof record.sourceRoot === 'string'
    && typeof record.targetRoot === 'string'
}

/** 按源目录层级创建目标目录，并拒绝任何已有符号链接目录。 */
async function prepareTargetDirectories(
  manifest: DirectoryManifest,
  input: NormalizedCopyDirectoryInput,
): Promise<void> {
  for (const entry of manifest.directories) {
    throwIfAborted(input.signal)
    await ensureContainedDirectory(input.targetRoot, entry.relativePath)
  }
}

/** 逐层创建目录，确保中间层不会通过符号链接逃逸到目标根外。 */
async function ensureContainedDirectory(targetRoot: string, relativePath: string): Promise<void> {
  /** containment 校验后的最终目录路径。 */
  const finalPath = resolveContainedPath(targetRoot, relativePath)
  /** 从目标根到最终目录的路径片段。 */
  const segments = relative(targetRoot, finalPath).split(sep).filter((segment) => segment.length > 0)
  /** 当前逐层校验或创建的路径。 */
  let currentPath = targetRoot
  for (const segment of segments) {
    currentPath = join(currentPath, segment)
    /** 当前层已有文件系统条目的 lstat。 */
    const stats = await lstatOrNull(currentPath)
    if (!stats) {
      await mkdir(currentPath)
    } else if (!stats.isDirectory()) {
      throw new Error(`目标目录层级包含非目录条目: ${relativePath}`)
    }
  }
}

/** 复制并校验单个普通文件或符号链接。 */
async function copyAndVerifyEntry(
  entry: ScannedFileEntry | ScannedSymbolicLinkEntry,
  context: CopyContext,
): Promise<void> {
  throwIfAborted(context.input.signal)
  /** containment 校验后的目标条目路径。 */
  const targetPath = resolveContainedPath(context.input.targetRoot, entry.relativePath)
  if (entry.kind === 'file') {
    await copyAndVerifyFile(entry, targetPath, context)
  } else {
    await copyAndVerifySymbolicLink(entry, targetPath, context)
  }
  context.state.verifiedFiles += 1
}

/** 按 SHA-256 复用或复制普通文件，并在不一致时只重拷一次。 */
async function copyAndVerifyFile(
  entry: ScannedFileEntry,
  targetPath: string,
  context: CopyContext,
): Promise<void> {
  /** 复制开始前计算的源内容基准哈希。 */
  const sourceHash = await hashFileWithSignal(entry.sourcePath, context.input.signal)
  /** 目标是否已经是可复用的同内容普通文件。 */
  const reusable = await isReusableFile(targetPath, entry.size, sourceHash, context.input.signal)
  if (reusable) {
    context.state.reusedFiles += 1
    advanceProgress(entry, entry.size, 'copying', context)
  } else {
    await removeTargetEntry(targetPath)
    await streamCopyFile(entry, targetPath, context, true)
  }
  await preserveFileMetadata(entry, targetPath)

  /** 首次和重拷后的验证序号，最多执行两次。 */
  for (let attempt = 0; attempt < 2; attempt += 1) {
    emitProgress(entry.relativePath, 'verifying', context)
    throwIfAborted(context.input.signal)
    /** 当前目标内容的 SHA-256。 */
    const targetHash = await hashFileWithSignal(targetPath, context.input.signal)
    if (targetHash === sourceHash) return
    if (attempt === 0) {
      await removeTargetEntry(targetPath)
      await streamCopyFile(entry, targetPath, context, false)
      await preserveFileMetadata(entry, targetPath)
    }
  }
  throw new Error(`文件校验失败，重试后仍不一致: ${entry.relativePath}`)
}

/** 判断已有目标是否为大小与 SHA-256 都一致的普通文件。 */
async function isReusableFile(
  targetPath: string,
  expectedSize: number,
  expectedHash: string,
  signal?: AbortSignal,
): Promise<boolean> {
  /** 已有目标条目的 lstat。 */
  const targetStats = await lstatOrNull(targetPath)
  if (!targetStats?.isFile() || targetStats.size !== expectedSize) return false
  return await hashFileWithSignal(targetPath, signal) === expectedHash
}

/** 流式复制普通文件；重试时不重复增加已完成字节。 */
async function streamCopyFile(
  entry: ScannedFileEntry,
  targetPath: string,
  context: CopyContext,
  trackProgress: boolean,
): Promise<void> {
  throwIfAborted(context.input.signal)
  /** 固定缓冲区的源读取流。 */
  const readable = createReadStream(entry.sourcePath, { highWaterMark: STREAM_BUFFER_SIZE })
  /** 直接覆盖当前迁移拥有的目标文件的写入流。 */
  const writable = createWriteStream(targetPath, { flags: 'w', mode: entry.mode })
  try {
    for await (const chunk of readable) {
      throwIfAborted(context.input.signal)
      /** 当前 Buffer 数据块写入内核缓冲区的结果。 */
      const accepted = writable.write(chunk)
      if (trackProgress) advanceProgress(entry, chunk.byteLength, 'copying', context)
      throwIfAborted(context.input.signal)
      if (!accepted) await once(writable, 'drain')
    }
    writable.end()
    await finished(writable)
    if (entry.size === 0 && trackProgress) emitProgress(entry.relativePath, 'copying', context)
  } finally {
    readable.destroy()
    writable.destroy()
  }
}

/** 按链接文本复用或复制符号链接，并验证目标仍是同一链接。 */
async function copyAndVerifySymbolicLink(
  entry: ScannedSymbolicLinkEntry,
  targetPath: string,
  context: CopyContext,
): Promise<void> {
  /** 目标是否已经是相同文本的符号链接。 */
  const reusable = await isReusableSymbolicLink(targetPath, entry.linkTarget)
  if (reusable) {
    context.state.reusedFiles += 1
  } else {
    await removeTargetEntry(targetPath)
    await symlink(entry.linkTarget, targetPath)
  }
  emitProgress(entry.relativePath, 'copying', context)
  await preserveSymbolicLinkMetadata(entry, targetPath)
  emitProgress(entry.relativePath, 'verifying', context)
  throwIfAborted(context.input.signal)
  /** 验证时重新 lstat，确保目标没有被替换成普通文件。 */
  const targetStats = await lstatOrNull(targetPath)
  if (!targetStats?.isSymbolicLink() || await readlink(targetPath) !== entry.linkTarget) {
    throw new Error(`符号链接校验失败: ${entry.relativePath}`)
  }
}

/** 判断已有目标是否为链接文本完全相同的符号链接。 */
async function isReusableSymbolicLink(targetPath: string, expectedTarget: string): Promise<boolean> {
  /** 已有目标条目的 lstat。 */
  const targetStats = await lstatOrNull(targetPath)
  return targetStats?.isSymbolicLink() === true && await readlink(targetPath) === expectedTarget
}

/** 删除当前迁移目标中的单个冲突条目，调用前路径已通过 containment 校验。 */
async function removeTargetEntry(targetPath: string): Promise<void> {
  if (await lstatOrNull(targetPath)) await rm(targetPath, { recursive: true, force: true })
}

/** 更新普通文件已完成字节，并同步发出不超过总量的单调进度。 */
function advanceProgress(
  entry: ScannedFileEntry,
  completedChunkBytes: number,
  stage: 'copying' | 'verifying',
  context: CopyContext,
): void {
  context.state.completedBytes = Math.min(
    context.manifest.totalBytes,
    context.state.completedBytes + completedChunkBytes,
  )
  emitProgress(entry.relativePath, stage, context)
}

/** 发出单个文件或链接当前阶段的稳定进度快照。 */
function emitProgress(
  currentRelativePath: string,
  stage: 'copying' | 'verifying',
  context: CopyContext,
): void {
  context.input.onProgress({
    migrationId: context.input.migrationId,
    stage,
    completedBytes: context.state.completedBytes,
    totalBytes: context.manifest.totalBytes,
    currentRelativePath,
  })
}

/** 使用固定缓冲流计算 SHA-256，并在每个数据块前后响应取消。 */
async function hashFileWithSignal(filePath: string, signal?: AbortSignal): Promise<string> {
  throwIfAborted(signal)
  /** 当前文件的增量 SHA-256 计算器。 */
  const hash = createHash('sha256')
  /** 固定 64 KiB 缓冲的文件读取流。 */
  const readable = createReadStream(filePath, { highWaterMark: STREAM_BUFFER_SIZE })
  try {
    for await (const chunk of readable) {
      throwIfAborted(signal)
      hash.update(chunk)
      throwIfAborted(signal)
    }
    return hash.digest('hex')
  } finally {
    readable.destroy()
  }
}

/** 尽力保留普通文件权限与时间，失败只告警且不影响内容校验。 */
async function preserveFileMetadata(entry: ScannedFileEntry, targetPath: string): Promise<void> {
  await bestEffortMetadata(`文件权限 ${entry.relativePath}`, () => chmod(targetPath, entry.mode))
  await bestEffortMetadata(`文件时间 ${entry.relativePath}`, () => utimes(targetPath, entry.atime, entry.mtime))
}

/** 尽力保留符号链接时间；不使用 chmod，避免平台跟随链接修改外部目标。 */
async function preserveSymbolicLinkMetadata(
  entry: ScannedSymbolicLinkEntry,
  targetPath: string,
): Promise<void> {
  await bestEffortMetadata(`符号链接时间 ${entry.relativePath}`, () => lutimes(targetPath, entry.atime, entry.mtime))
}

/** 内容完成后由深到浅保留目录权限和时间，最后处理目标根。 */
async function preserveAllDirectoryMetadata(manifest: DirectoryManifest, targetRoot: string): Promise<void> {
  /** 深层目录优先，避免后续子目录元数据操作再次改变父目录时间。 */
  const directories = [...manifest.directories].sort(
    (left, right) => right.relativePath.split(sep).length - left.relativePath.split(sep).length,
  )
  for (const entry of directories) {
    /** containment 校验后的目标目录路径。 */
    const targetPath = resolveContainedPath(targetRoot, entry.relativePath)
    await preserveDirectoryMetadata(entry, targetPath)
  }
  await preserveDirectoryMetadata(manifest.root, targetRoot)
}

/** 尽力保留单个目录的权限与时间。 */
async function preserveDirectoryMetadata(entry: ScannedDirectoryEntry, targetPath: string): Promise<void> {
  await bestEffortMetadata(`目录权限 ${entry.relativePath || '.'}`, () => chmod(targetPath, entry.mode))
  await bestEffortMetadata(`目录时间 ${entry.relativePath || '.'}`, () => utimes(targetPath, entry.atime, entry.mtime))
}

/** 执行平台相关元数据操作，失败只输出 warning。 */
async function bestEffortMetadata(label: string, operation: () => Promise<void>): Promise<void> {
  try {
    await operation()
  } catch (error) {
    console.warn(`[目录复制] 无法保留${label}:`, error)
  }
}

/** lstat 不存在路径时返回 null，其他错误保持原样抛出。 */
async function lstatOrNull(filePath: string): Promise<Stats | null> {
  try {
    return await lstat(filePath)
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return null
    throw error
  }
}

/** 判断未知错误是否携带 Node.js 文件系统错误码。 */
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

/** 将相对条目解析到根内，并拒绝根本身与任何路径逃逸。 */
function resolveContainedPath(root: string, relativePath: string): string {
  /** 解析后的绝对候选路径。 */
  const candidate = resolve(root, relativePath)
  if (!isPathInside(root, candidate)) throw new Error(`目录条目路径逃逸目标根: ${relativePath}`)
  return candidate
}

/** 使用 path.relative 判断 candidate 是否严格位于 root 内。 */
function isPathInside(root: string, candidate: string): boolean {
  /** 从根到候选路径的相对表达。 */
  const relativePath = relative(root, candidate)
  return relativePath.length > 0
    && relativePath !== '..'
    && !relativePath.startsWith(`..${sep}`)
    && !isAbsolute(relativePath)
}

/** 在入口、每个文件和每个数据块边界抛出标准 AbortError。 */
function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  /** 对调用方可识别的标准取消错误。 */
  const error = new Error('目录复制已取消')
  error.name = 'AbortError'
  throw error
}
