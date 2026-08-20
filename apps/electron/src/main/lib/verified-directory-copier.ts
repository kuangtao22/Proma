import { lstat, mkdir, opendir, readlink, realpath, rmdir, unlink } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import type { DataRootMigrationProgress } from '@proma/shared'
import {
  assertDirectoryIdentity,
  captureDirectoryIdentity,
  copyFileAtomic,
  hashManifestFile,
  hashTargetFile,
  isReusableFile,
  isReusableSymbolicLink,
  lstatOrNull,
  metadataFromStats,
  pathDepth,
  preserveDirectoryMetadata,
  preserveFileMetadata,
  preserveSymbolicLinkMetadata,
  relativeParent,
  replaceSymbolicLinkAtomic,
  resolveContainedPath,
  resolveProspectivePath,
  throwIfAborted,
  validateRootRelationship,
  type FileSystemIdentity,
  type ScannedDirectoryEntry,
  type ScannedEntry,
  type ScannedFileEntry,
  type ScannedSymbolicLinkEntry,
} from './verified-directory-copy-filesystem'
import {
  getDirectoryCopySidecarPath,
  prepareDirectoryCopySidecar,
} from './verified-directory-copy-sidecar'

export { hashFile } from './verified-directory-copy-filesystem'
export { finalizeDirectoryCopy, getDirectoryCopySidecarPath } from './verified-directory-copy-sidecar'
export type { FinalizeDirectoryCopyInput } from './verified-directory-copy-sidecar'

/** 源目录的稳定清单。 */
interface DirectoryManifest {
  root: ScannedDirectoryEntry
  entries: Map<string, ScannedEntry>
  directories: ScannedDirectoryEntry[]
  leaves: Array<ScannedFileEntry | ScannedSymbolicLinkEntry>
  totalBytes: number
}

/** 目标扫描条目，用于精确 reconciliation。 */
interface TargetEntry {
  relativePath: string
  path: string
  parentRelativePath: string
  kind: ScannedEntry['kind'] | 'special'
  depth: number
}

/** 一次目标扫描同时返回条目与已验证目录身份。 */
interface TargetTreeSnapshot {
  entries: TargetEntry[]
  directoryIdentities: Map<string, FileSystemIdentity>
}

/** 复制期间共享的单调统计。 */
interface CopyState {
  completedBytes: number
  verifiedFiles: number
  reusedFiles: number
}

/** 归一化后的调用参数，同时保留 marker 使用的调用方绝对路径。 */
interface NormalizedCopyDirectoryInput extends CopyDirectoryInput {
  sourceRoot: string
  targetRoot: string
  requestedSourceRoot: string
  requestedTargetRoot: string
  sidecarPath: string
  concurrency: number
}

/** 单次复制持有的受控目录身份与取消上下文。 */
interface CopyContext {
  input: NormalizedCopyDirectoryInput
  manifest: DirectoryManifest
  state: CopyState
  signal: AbortSignal
  sourceRootIdentity: FileSystemIdentity
  targetRootIdentity: FileSystemIdentity
  targetAnchorIdentity: FileSystemIdentity
  targetDirectories: Map<string, FileSystemIdentity>
  sourceHashes: Map<string, string>
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

/** 流式复制目录树并逐文件校验，成功后保留树外 sidecar 等待 finalize。 */
export async function copyDirectoryVerified(input: CopyDirectoryInput): Promise<CopyDirectoryResult> {
  throwIfAborted(input.signal)
  /** canonicalize 后用于所有数据树操作的输入。 */
  const normalizedInput = await normalizeInput(input)
  /** 初始源清单，特殊文件会在目标数据修改前被拒绝。 */
  const manifest = await scanDirectory(normalizedInput.sourceRoot, input.signal)
  /** 源根初始身份用于最终稳定性复验。 */
  const sourceRootIdentity = await captureDirectoryIdentity(normalizedInput.sourceRoot)
  /** 目标创建、授权和物理别名检查结果。 */
  const roots = await prepareRoots(normalizedInput, sourceRootIdentity)
  /** 初次 reconciliation 删除同一迁移拥有的过期残留。 */
  const targetDirectories = await reconcileTarget(manifest, roots.targetRootIdentity, input.signal)
  /** 单次执行内部控制器用于一个 worker 失败时中断所有 pipeline。 */
  const executionController = new AbortController()
  /** 将调用方取消同步到内部控制器。 */
  const abortExecution = (): void => executionController.abort()
  input.signal?.addEventListener('abort', abortExecution, { once: true })
  if (input.signal?.aborted) executionController.abort()
  /** 所有 worker 共享的统计。 */
  const state: CopyState = { completedBytes: 0, verifiedFiles: 0, reusedFiles: 0 }
  /** 已计算的源普通文件哈希，最终目标复验时复用。 */
  const sourceHashes = new Map<string, string>()
  /** worker 每次领取的下一个清单位置。 */
  let nextIndex = 0
  /** 首个业务错误优先于随后产生的 AbortError。 */
  let firstError: unknown
  /** worker 使用的完整稳定上下文。 */
  const context: CopyContext = {
    input: normalizedInput,
    manifest,
    state,
    signal: executionController.signal,
    sourceRootIdentity,
    targetRootIdentity: roots.targetRootIdentity,
    targetAnchorIdentity: roots.targetAnchorIdentity,
    targetDirectories,
    sourceHashes,
  }
  /** 单个 worker 循环领取条目，异常时终止其他 worker。 */
  const runWorker = async (): Promise<void> => {
    while (!executionController.signal.aborted) {
      /** 当前 worker 独占领取的清单下标。 */
      const currentIndex = nextIndex
      nextIndex += 1
      /** 当前 worker 处理的普通文件或符号链接。 */
      const entry = manifest.leaves[currentIndex]
      if (!entry) return
      try {
        await copyAndVerifyEntry(entry, context)
      } catch (error) {
        if (firstError === undefined) firstError = error
        executionController.abort()
      }
    }
  }

  try {
    /** 实际 worker 数不会超过条目数，也不会低于一。 */
    const workerCount = Math.max(1, Math.min(normalizedInput.concurrency, manifest.leaves.length || 1))
    await Promise.all(Array.from({ length: workerCount }, runWorker))
    if (firstError !== undefined) throw firstError
    throwIfAborted(input.signal)
    /** 最终源重扫捕获新增、删除、类型、大小、mtime 和身份变化。 */
    const finalManifest = await scanDirectory(normalizedInput.sourceRoot, input.signal)
    assertManifestUnchanged(manifest, finalManifest)
    await assertSourceFilesMatchHashes(context)
    await assertStableRoots(context)
    /** 完成前再次 reconciliation 并精确验证目标集合。 */
    context.targetDirectories = await reconcileTarget(manifest, roots.targetRootIdentity, input.signal)
    await assertTargetMatchesManifest(context)
    await preserveAllDirectoryMetadata(manifest, context.targetDirectories)
    await assertStableRoots(context)
    return {
      verifiedFiles: state.verifiedFiles,
      reusedFiles: state.reusedFiles,
      totalBytes: manifest.totalBytes,
    }
  } finally {
    executionController.abort()
    input.signal?.removeEventListener('abort', abortExecution)
  }
}

/** 归一化输入并把数据树操作根切换为 canonical 路径。 */
async function normalizeInput(input: CopyDirectoryInput): Promise<NormalizedCopyDirectoryInput> {
  /** 调用方指定或默认使用的低并发数。 */
  const concurrency = input.concurrency ?? 2
  if (input.migrationId.trim().length === 0) throw new Error('目录复制 migrationId 不能为空')
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error('目录复制 concurrency 必须是正整数')
  /** marker 中保留的调用方源绝对路径。 */
  const requestedSourceRoot = resolve(input.sourceRoot)
  /** marker 中保留的调用方目标绝对路径。 */
  const requestedTargetRoot = resolve(input.targetRoot)
  /** realpath 前的源根 no-follow lstat，源根本身不能是符号链接。 */
  const requestedSourceStats = await lstat(requestedSourceRoot, { bigint: true })
  if (!requestedSourceStats.isDirectory()) throw new Error('复制源根必须是实际目录，不能是符号链接或普通文件')
  /** 现存源根的真实路径。 */
  const canonicalSourceRoot = await realpath(requestedSourceRoot)
  /** 目标最近现存祖先解析后的预计真实路径。 */
  const prospectiveTarget = await resolveProspectivePath(requestedTargetRoot)
  validateRootRelationship(canonicalSourceRoot, prospectiveTarget.canonicalPath)
  return {
    ...input,
    sourceRoot: canonicalSourceRoot,
    targetRoot: prospectiveTarget.canonicalPath,
    requestedSourceRoot,
    requestedTargetRoot,
    sidecarPath: join(
      dirname(prospectiveTarget.canonicalPath),
      basename(getDirectoryCopySidecarPath(requestedTargetRoot)),
    ),
    concurrency,
  }
}

/** 创建或恢复目标根，并在创建前后重复验证物理路径和身份。 */
async function prepareRoots(
  input: NormalizedCopyDirectoryInput,
  sourceRootIdentity: FileSystemIdentity,
): Promise<{ targetRootIdentity: FileSystemIdentity; targetAnchorIdentity: FileSystemIdentity }> {
  /** 创建前目标最近现存祖先及预计真实路径。 */
  const prospectiveTarget = await resolveProspectivePath(input.requestedTargetRoot)
  validateRootRelationship(sourceRootIdentity.canonicalPath, prospectiveTarget.canonicalPath)
  if (prospectiveTarget.exists) {
    /** 已存在目标根不得是链接或非目录。 */
    const existingTargetStats = await lstat(input.targetRoot, { bigint: true })
    if (!existingTargetStats.isDirectory()) throw new Error(`复制目标根不是普通目录: ${input.requestedTargetRoot}`)
    if (existingTargetStats.dev === sourceRootIdentity.dev && existingTargetStats.ino === sourceRootIdentity.ino) {
      throw new Error('复制源与目标解析为同一物理路径')
    }
  }
  /** 已存在目标根是否为空。 */
  const targetIsEmpty = prospectiveTarget.exists ? await isDirectoryEmpty(input.targetRoot) : true
  await prepareDirectoryCopySidecar({
    migrationId: input.migrationId,
    requestedSourceRoot: input.requestedSourceRoot,
    requestedTargetRoot: input.requestedTargetRoot,
    sidecarPath: input.sidecarPath,
    targetIsEmpty,
  })
  await assertDirectoryIdentity(prospectiveTarget.anchor)
  if (!prospectiveTarget.exists) await mkdir(input.targetRoot, { recursive: true })
  await assertDirectoryIdentity(prospectiveTarget.anchor)
  /** 创建后的目标根稳定身份。 */
  const targetRootIdentity = await captureDirectoryIdentity(input.targetRoot)
  validateRootRelationship(sourceRootIdentity.canonicalPath, targetRootIdentity.canonicalPath)
  if (targetRootIdentity.dev === sourceRootIdentity.dev && targetRootIdentity.ino === sourceRootIdentity.ino) {
    throw new Error('复制源与目标解析为同一物理路径')
  }
  return { targetRootIdentity, targetAnchorIdentity: prospectiveTarget.anchor }
}

/** 递归扫描源目录，符号链接只读取文本，特殊文件明确失败。 */
async function scanDirectory(sourceRoot: string, signal?: AbortSignal): Promise<DirectoryManifest> {
  throwIfAborted(signal)
  /** 源根目录自身的 no-follow lstat。 */
  const rootStats = await lstat(sourceRoot, { bigint: true })
  if (!rootStats.isDirectory()) throw new Error(`复制源根不是普通目录: ${sourceRoot}`)
  /** 根目录清单条目。 */
  const root: ScannedDirectoryEntry = {
    kind: 'directory', relativePath: '', sourcePath: sourceRoot, ...metadataFromStats(rootStats),
  }
  /** 按相对路径索引的全部子条目。 */
  const entries = new Map<string, ScannedEntry>()
  /** 按扫描顺序保存的目录。 */
  const directories: ScannedDirectoryEntry[] = []
  /** 等待复制的文件和链接。 */
  const leaves: Array<ScannedFileEntry | ScannedSymbolicLinkEntry> = []
  /** 普通文件总字节数。 */
  let totalBytes = 0
  /** 扫描单个目录并在每个条目边界响应取消。 */
  const visit = async (relativeDirectory: string): Promise<void> => {
    throwIfAborted(signal)
    /** containment 校验后的当前目录绝对路径。 */
    const directoryPath = relativeDirectory.length === 0
      ? sourceRoot
      : resolveContainedPath(sourceRoot, relativeDirectory)
    /** 异步目录迭代器避免一次载入全部名称。 */
    const handle = await opendir(directoryPath)
    for await (const directoryEntry of handle) {
      throwIfAborted(signal)
      /** 当前条目相对源根的路径。 */
      const relativePath = relativeDirectory.length === 0
        ? directoryEntry.name
        : join(relativeDirectory, directoryEntry.name)
      /** containment 校验后的源绝对路径。 */
      const sourcePath = resolveContainedPath(sourceRoot, relativePath)
      /** no-follow lstat 保证链接不会被透明跟随。 */
      const stats = await lstat(sourcePath, { bigint: true })
      if (stats.isDirectory()) {
        /** 当前目录清单条目。 */
        const entry: ScannedDirectoryEntry = {
          kind: 'directory', relativePath, sourcePath, ...metadataFromStats(stats),
        }
        entries.set(relativePath, entry)
        directories.push(entry)
        await visit(relativePath)
      } else if (stats.isFile()) {
        if (stats.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`普通文件过大，无法安全计数: ${relativePath}`)
        /** 当前普通文件清单条目。 */
        const entry: ScannedFileEntry = {
          kind: 'file', relativePath, sourcePath, size: Number(stats.size), sizeBigInt: stats.size,
          ...metadataFromStats(stats),
        }
        entries.set(relativePath, entry)
        leaves.push(entry)
        totalBytes += entry.size
        if (!Number.isSafeInteger(totalBytes)) throw new Error('目录总字节数超过安全整数范围')
      } else if (stats.isSymbolicLink()) {
        /** 链接目标保持原始文本，绝不 stat 或读取目标内容。 */
        const linkTarget = await readlink(sourcePath)
        /** 当前符号链接清单条目。 */
        const entry: ScannedSymbolicLinkEntry = {
          kind: 'symbolic-link', relativePath, sourcePath, linkTarget, ...metadataFromStats(stats),
        }
        entries.set(relativePath, entry)
        leaves.push(entry)
      } else {
        throw new Error(`源目录包含不支持的特殊文件: ${relativePath}`)
      }
    }
  }
  await visit('')
  return { root, entries, directories, leaves, totalBytes }
}

/** 比较初始与最终源清单，任何集合或元数据变化都失败。 */
function assertManifestUnchanged(initial: DirectoryManifest, current: DirectoryManifest): void {
  if (!sameScannedEntry(initial.root, current.root) || initial.entries.size !== current.entries.size) {
    throw new Error('源目录在复制期间发生变化，保留断点等待恢复')
  }
  for (const [relativePath, initialEntry] of initial.entries) {
    /** 最终重扫中相同相对路径的条目。 */
    const currentEntry = current.entries.get(relativePath)
    if (!currentEntry || !sameScannedEntry(initialEntry, currentEntry)) {
      throw new Error(`源目录在复制期间发生变化: ${relativePath}`)
    }
  }
}

/** 比较两个清单条目的类型、身份、mtime 和类型专属字段。 */
function sameScannedEntry(left: ScannedEntry, right: ScannedEntry): boolean {
  if (left.kind !== right.kind
    || left.dev !== right.dev
    || left.ino !== right.ino
    || left.mode !== right.mode
    || left.mtimeNs !== right.mtimeNs) return false
  if (left.kind === 'file' && right.kind === 'file') return left.sizeBigInt === right.sizeBigInt
  if (left.kind === 'symbolic-link' && right.kind === 'symbolic-link') return left.linkTarget === right.linkTarget
  return left.kind === 'directory' && right.kind === 'directory'
}

/** 精确清理迁移拥有的目标，并返回所有期望目录的稳定身份。 */
async function reconcileTarget(
  manifest: DirectoryManifest,
  targetRootIdentity: FileSystemIdentity,
  signal?: AbortSignal,
): Promise<Map<string, FileSystemIdentity>> {
  throwIfAborted(signal)
  await assertDirectoryIdentity(targetRootIdentity)
  /** 目标当前所有条目的 no-follow 扫描结果。 */
  const snapshot = await scanTargetTree(targetRootIdentity, signal)
  /** 从深到浅删除源清单中不存在或类型不一致的残留。 */
  const removalOrder = [...snapshot.entries].sort((left, right) => right.depth - left.depth)
  /** 扫描时同步捕获的现存目录身份。 */
  const directoryIdentities = snapshot.directoryIdentities
  for (const actualEntry of removalOrder) {
    throwIfAborted(signal)
    /** 源清单对当前路径的期望条目。 */
    const expectedEntry = manifest.entries.get(actualEntry.relativePath)
    if (expectedEntry && expectedEntry.kind === actualEntry.kind) continue
    /** 删除前复验父目录身份。 */
    const parentIdentity = directoryIdentities.get(actualEntry.parentRelativePath)
    if (!parentIdentity) throw new Error(`目标目录身份缺失: ${actualEntry.parentRelativePath}`)
    await assertDirectoryIdentity(parentIdentity)
    if (actualEntry.kind === 'directory') await rmdir(actualEntry.path)
    else await unlink(actualEntry.path)
    await assertDirectoryIdentity(parentIdentity)
    directoryIdentities.delete(actualEntry.relativePath)
  }
  /** 由浅到深创建缺失目录并持有身份。 */
  const orderedDirectories = [...manifest.directories].sort(
    (left, right) => pathDepth(left.relativePath) - pathDepth(right.relativePath),
  )
  for (const entry of orderedDirectories) {
    throwIfAborted(signal)
    /** 当前目录父级的稳定身份。 */
    const parentIdentity = directoryIdentities.get(relativeParent(entry.relativePath))
    if (!parentIdentity) throw new Error(`目标目录身份缺失: ${relativeParent(entry.relativePath)}`)
    await assertDirectoryIdentity(parentIdentity)
    /** containment 校验后的目标目录路径。 */
    const targetPath = resolveContainedPath(targetRootIdentity.path, entry.relativePath)
    /** 当前目录已有条目的 no-follow lstat。 */
    const stats = await lstatOrNull(targetPath)
    if (!stats) await mkdir(targetPath)
    else if (!stats.isDirectory()) throw new Error(`目标目录类型 reconciliation 失败: ${entry.relativePath}`)
    await assertDirectoryIdentity(parentIdentity)
    directoryIdentities.set(entry.relativePath, await captureDirectoryIdentity(targetPath))
  }
  await assertDirectoryIdentity(targetRootIdentity)
  return directoryIdentities
}

/** no-follow 扫描目标树；特殊文件只作为待清理条目。 */
async function scanTargetTree(
  targetRootIdentity: FileSystemIdentity,
  signal?: AbortSignal,
): Promise<TargetTreeSnapshot> {
  /** 扫描得到的目标条目。 */
  const entries: TargetEntry[] = []
  /** 根目录和扫描到的全部子目录身份。 */
  const directoryIdentities = new Map<string, FileSystemIdentity>([['', targetRootIdentity]])
  /** 递归扫描单个已验证目录。 */
  const visit = async (directoryIdentity: FileSystemIdentity, relativeDirectory: string): Promise<void> => {
    throwIfAborted(signal)
    await assertDirectoryIdentity(directoryIdentity)
    /** 当前目标目录迭代器。 */
    const handle = await opendir(directoryIdentity.path)
    for await (const directoryEntry of handle) {
      throwIfAborted(signal)
      /** 当前目标条目的相对路径。 */
      const relativePath = relativeDirectory.length === 0
        ? directoryEntry.name
        : join(relativeDirectory, directoryEntry.name)
      /** containment 校验后的当前目标路径。 */
      const targetPath = resolveContainedPath(targetRootIdentity.path, relativePath)
      /** no-follow lstat 防止目标链接逃逸。 */
      const stats = await lstat(targetPath, { bigint: true })
      /** 当前条目的种类。 */
      const kind: TargetEntry['kind'] = stats.isDirectory()
        ? 'directory'
        : stats.isFile()
          ? 'file'
          : stats.isSymbolicLink()
            ? 'symbolic-link'
            : 'special'
      entries.push({
        relativePath,
        path: targetPath,
        parentRelativePath: relativeDirectory,
        kind,
        depth: pathDepth(relativePath),
      })
      if (kind === 'directory') {
        /** 当前子目录的稳定身份。 */
        const childIdentity = await captureDirectoryIdentity(targetPath)
        directoryIdentities.set(relativePath, childIdentity)
        await visit(childIdentity, relativePath)
      }
    }
    await assertDirectoryIdentity(directoryIdentity)
  }
  await visit(targetRootIdentity, '')
  return { entries, directoryIdentities }
}

/** 复制并校验单个文件或链接。 */
async function copyAndVerifyEntry(
  entry: ScannedFileEntry | ScannedSymbolicLinkEntry,
  context: CopyContext,
): Promise<void> {
  throwIfAborted(context.signal)
  /** 当前叶子的父目录身份。 */
  const parentIdentity = getTargetParentIdentity(entry.relativePath, context)
  /** containment 校验后的最终目标路径。 */
  const targetPath = resolveContainedPath(context.input.targetRoot, entry.relativePath)
  if (entry.kind === 'file') await copyAndVerifyFile(entry, targetPath, parentIdentity, context)
  else await copyAndVerifySymbolicLink(entry, targetPath, parentIdentity, context)
  context.state.verifiedFiles += 1
}

/** 按 SHA-256 复用或原子复制普通文件，并只局部重试一次。 */
async function copyAndVerifyFile(
  entry: ScannedFileEntry,
  targetPath: string,
  parentIdentity: FileSystemIdentity,
  context: CopyContext,
): Promise<void> {
  /** 对源句柄执行身份校验后得到的基准 SHA-256。 */
  const sourceHash = await hashManifestFile(entry, context.signal)
  context.sourceHashes.set(entry.relativePath, sourceHash)
  /** 已有目标是否可以直接复用。 */
  const reusable = await isReusableFile(targetPath, parentIdentity, entry.sizeBigInt, sourceHash, context.signal)
  if (reusable) {
    context.state.reusedFiles += 1
    advanceProgress(entry, entry.size, context)
  } else {
    await copyFile(entry, targetPath, parentIdentity, context, true)
  }
  await preserveFileMetadata(entry, targetPath, parentIdentity)
  /** 首次和局部重拷后的验证序号。 */
  for (let attempt = 0; attempt < 2; attempt += 1) {
    emitProgress(entry.relativePath, 'verifying', context)
    if (await hashTargetFile(targetPath, parentIdentity, context.signal) === sourceHash) return
    if (attempt === 0) {
      await copyFile(entry, targetPath, parentIdentity, context, false)
      await preserveFileMetadata(entry, targetPath, parentIdentity)
    }
  }
  throw new Error(`文件校验失败，重试后仍不一致: ${entry.relativePath}`)
}

/** 调用受控文件系统 primitive，并把数据块映射为迁移进度。 */
async function copyFile(
  entry: ScannedFileEntry,
  targetPath: string,
  parentIdentity: FileSystemIdentity,
  context: CopyContext,
  trackProgress: boolean,
): Promise<void> {
  await copyFileAtomic({
    entry,
    targetPath,
    parentIdentity,
    signal: context.signal,
    trackProgress,
    onChunk: (chunkBytes) => advanceProgress(entry, chunkBytes, context),
    onEmptyFile: () => emitProgress(entry.relativePath, 'copying', context),
  })
}

/** 按链接文本复用或原子重建符号链接，并只局部重试一次。 */
async function copyAndVerifySymbolicLink(
  entry: ScannedSymbolicLinkEntry,
  targetPath: string,
  parentIdentity: FileSystemIdentity,
  context: CopyContext,
): Promise<void> {
  /** 已有目标是否为相同文本链接。 */
  const reusable = await isReusableSymbolicLink(targetPath, parentIdentity, entry.linkTarget)
  if (reusable) context.state.reusedFiles += 1
  else await replaceSymbolicLinkAtomic(entry, targetPath, parentIdentity)
  emitProgress(entry.relativePath, 'copying', context)
  await preserveSymbolicLinkMetadata(entry, targetPath, parentIdentity)
  /** 首次和局部重建后的验证序号。 */
  for (let attempt = 0; attempt < 2; attempt += 1) {
    emitProgress(entry.relativePath, 'verifying', context)
    if (await isReusableSymbolicLink(targetPath, parentIdentity, entry.linkTarget)) return
    if (attempt === 0) {
      await replaceSymbolicLinkAtomic(entry, targetPath, parentIdentity)
      await preserveSymbolicLinkMetadata(entry, targetPath, parentIdentity)
    }
  }
  throw new Error(`符号链接校验失败，重试后仍不一致: ${entry.relativePath}`)
}

/** 最终精确验证目标集合、文件哈希和链接文本。 */
async function assertTargetMatchesManifest(context: CopyContext): Promise<void> {
  /** 最终目标树的 no-follow 扫描结果。 */
  const snapshot = await scanTargetTree(context.targetRootIdentity, context.signal)
  if (snapshot.entries.length !== context.manifest.entries.size) throw new Error('目标目录条目集合与源清单不一致')
  for (const targetEntry of snapshot.entries) {
    /** 源清单对应条目。 */
    const sourceEntry = context.manifest.entries.get(targetEntry.relativePath)
    if (!sourceEntry || sourceEntry.kind !== targetEntry.kind) {
      throw new Error(`目标目录条目集合与源清单不一致: ${targetEntry.relativePath}`)
    }
    if (sourceEntry.kind === 'file') {
      /** 复制阶段保存的源哈希。 */
      const sourceHash = context.sourceHashes.get(sourceEntry.relativePath)
      if (!sourceHash) throw new Error(`缺少源文件哈希: ${sourceEntry.relativePath}`)
      /** 当前文件父目录稳定身份。 */
      const parentIdentity = getTargetParentIdentity(sourceEntry.relativePath, context)
      if (await hashTargetFile(targetEntry.path, parentIdentity, context.signal) !== sourceHash) {
        throw new Error(`最终目标文件校验失败: ${sourceEntry.relativePath}`)
      }
    } else if (sourceEntry.kind === 'symbolic-link') {
      /** 当前链接父目录稳定身份。 */
      const parentIdentity = getTargetParentIdentity(sourceEntry.relativePath, context)
      if (!await isReusableSymbolicLink(targetEntry.path, parentIdentity, sourceEntry.linkTarget)) {
        throw new Error(`最终目标符号链接校验失败: ${sourceEntry.relativePath}`)
      }
    }
  }
}

/** 最终重新哈希所有普通源文件，捕获伪造回旧 mtime 的同大小内容变化。 */
async function assertSourceFilesMatchHashes(context: CopyContext): Promise<void> {
  for (const entry of context.manifest.leaves) {
    if (entry.kind !== 'file') continue
    /** 复制前记录的源 SHA-256。 */
    const expectedHash = context.sourceHashes.get(entry.relativePath)
    if (!expectedHash) throw new Error(`缺少源文件哈希: ${entry.relativePath}`)
    /** 最终通过稳定句柄重新计算的源 SHA-256。 */
    const currentHash = await hashManifestFile(entry, context.signal)
    if (currentHash !== expectedHash) throw new Error(`源文件内容在复制期间发生变化: ${entry.relativePath}`)
  }
}

/** 内容与校验完成后由深到浅保留目录元数据。 */
async function preserveAllDirectoryMetadata(
  manifest: DirectoryManifest,
  directoryIdentities: Map<string, FileSystemIdentity>,
): Promise<void> {
  /** 深层目录优先，避免后续子目录操作改变父目录时间。 */
  const directories = [...manifest.directories].sort(
    (left, right) => pathDepth(right.relativePath) - pathDepth(left.relativePath),
  )
  for (const entry of directories) {
    /** reconciliation 捕获的目标目录身份。 */
    const identity = directoryIdentities.get(entry.relativePath)
    if (!identity) throw new Error(`目标目录身份缺失: ${entry.relativePath}`)
    await preserveDirectoryMetadata(entry, identity)
  }
  /** 目标根的稳定身份。 */
  const rootIdentity = directoryIdentities.get('')
  if (!rootIdentity) throw new Error('目标根目录身份缺失')
  await preserveDirectoryMetadata(manifest.root, rootIdentity)
}

/** 获取条目父目录在 reconciliation 后持有的稳定身份。 */
function getTargetParentIdentity(relativePath: string, context: CopyContext): FileSystemIdentity {
  /** reconciliation 捕获的父目录身份。 */
  const identity = context.targetDirectories.get(relativeParent(relativePath))
  if (!identity) throw new Error(`目标目录身份缺失: ${relativeParent(relativePath)}`)
  return identity
}

/** 更新普通文件已完成字节并发出单调进度。 */
function advanceProgress(entry: ScannedFileEntry, completedChunkBytes: number, context: CopyContext): void {
  context.state.completedBytes = Math.min(
    context.manifest.totalBytes,
    context.state.completedBytes + completedChunkBytes,
  )
  emitProgress(entry.relativePath, 'copying', context)
}

/** 发出单个条目当前阶段的稳定进度快照。 */
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

/** 复验源根、目标现存祖先与目标根身份。 */
async function assertStableRoots(context: CopyContext): Promise<void> {
  await assertDirectoryIdentity(context.sourceRootIdentity)
  await assertDirectoryIdentity(context.targetAnchorIdentity)
  await assertDirectoryIdentity(context.targetRootIdentity)
}

/** 判断目录是否没有任何直接条目。 */
async function isDirectoryEmpty(directoryPath: string): Promise<boolean> {
  /** 只需读取第一个名称即可判断是否为空。 */
  const handle = await opendir(directoryPath)
  try {
    return await handle.read() === null
  } finally {
    await handle.close()
  }
}
