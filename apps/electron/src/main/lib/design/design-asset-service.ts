import { createHash, randomUUID } from 'node:crypto'
import {
  constants,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import type { Stats } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import sharp from 'sharp'
import type { DesignAsset, DesignCanvasDocument } from '@proma/shared'
import { isValidImageBytes } from '../image-content-validation'
import { retainPromaPathUrl } from '../local-file-protocol'
import { removeFileAtomic, writeJsonFileAtomicSecure } from '../safe-file'
import type { DesignPathResolver, DesignPaths } from './design-paths'
import type { DesignStore } from './design-store'

/** 单个 Design 原图允许占用的最大字节数。 */
const MAX_IMAGE_BYTES = 64 * 1024 * 1024
/** Sharp 解码时允许的最大像素数，防止压缩炸弹耗尽内存。 */
const MAX_IMAGE_PIXELS = 64_000_000
/** 缩略图最长边，兼顾清晰度与画布大批量节点资源开销。 */
const THUMBNAIL_SIZE = 512
/** 单批图片累计字节预算，避免多个上限文件同时驻留。 */
const MAX_BATCH_IMAGE_BYTES = 128 * 1024 * 1024
/** 单批图片数量上限，限制连续 Sharp 解码工作量。 */
const MAX_BATCH_IMAGE_FILES = 16
/** 支持格式对应的签名 MIME 和规范磁盘扩展名。 */
const IMAGE_FORMATS = [
  { mediaType: 'image/png', extension: '.png' },
  { mediaType: 'image/jpeg', extension: '.jpg' },
  { mediaType: 'image/gif', extension: '.gif' },
  { mediaType: 'image/webp', extension: '.webp' },
] as const

/** 素材进入 Design 时保留的来源与版本关系。 */
export interface DesignAssetImportSource {
  kind: 'picker' | 'agent' | 'job'
  sourceSessionId?: string
  sourceJobId?: string
  parentAssetId?: string
  prompt?: string
}

/** 已 promotion 的导入批次；调用方必须在元数据结果明确后提交或回滚。 */
export interface DesignAssetImportBatch extends Array<DesignAsset> {
  /** 元数据已提交后消费 journal；清理失败只保留恢复证据，不反向报错。 */
  commit: () => void
  /** 元数据未提交时删除未引用文件；磁盘已引用时 fail safe 保留。 */
  rollback: () => void
}

/** 素材服务仅依赖可信路径、revision store 与主进程能力。 */
export interface DesignAssetServiceDependencies {
  /** 从稳定项目 ID 解析项目正式目录与可重建缓存目录。 */
  pathResolver: DesignPathResolver
  /** 提交素材元数据的 revision store。 */
  store: DesignStore
  /** 返回当前时间，测试可注入固定值。 */
  now?: () => number
  /** 所有写操作通过项目迁移守卫执行。 */
  runWorkspaceWrite: <T>(projectId: string, effect: () => T) => T
  /** 为 renderer 注册单个受信任目录授权。 */
  registerDirectoryPath: (directoryPath: string) => string
  /** 原子注册并 retain 一组 Design 媒体目录。 */
  registerRetainedDirectoryPaths?: (directoryPaths: string[]) => string[]
  /** 显式释放之前注册的 opaque URL。 */
  revokePathUrl: (url: string) => void
  /** 将 Design 媒体 token 固定到显式 release 生命周期。 */
  retainPathUrl?: (url: string) => boolean
  /** 删除提交后文件清理失败时记录告警。 */
  warn?: (message: string) => void
  /** 跨卷提升的窄文件系统依赖，仅用于稳定故障测试。 */
  filePromotion?: DesignFilePromotionDependencies
  /** 图片解码队列；生产默认进程级串行队列。 */
  processingQueue?: DesignAssetProcessingQueue
  /** 标识当前服务进程，用于启动时接管旧 promotion journal。 */
  runtimeId?: string
}

/** 图片处理队列的资源预算。 */
export interface DesignAssetProcessingQueueOptions {
  maxBatchBytes: number
  maxFiles: number
}

/** 串行化高内存 Sharp 工作，并在读取 Buffer 前执行累计预算。 */
export class DesignAssetProcessingQueue {
  /** 上一个排队任务完成后的稳定尾 Promise。 */
  private tail: Promise<void> = Promise.resolve()

  constructor(private readonly options: DesignAssetProcessingQueueOptions) {}

  /** 按已 stat 的文件大小排队执行单个批次。 */
  async run<T>(byteSizes: number[], effect: () => Promise<T>): Promise<T> {
    if (byteSizes.length > this.options.maxFiles) throw new Error('批次图片数量超出限制')
    const totalBytes = byteSizes.reduce((total, size) => total + size, 0)
    if (totalBytes > this.options.maxBatchBytes) throw new Error('批次图片累计大小超出限制')
    /** 当前任务等待的前序尾部。 */
    const previous = this.tail
    /** 当前任务完成时释放后续任务。 */
    let release: (() => void) | undefined
    this.tail = new Promise<void>((resolve) => { release = resolve })
    await previous
    try {
      return await effect()
    } finally {
      release?.()
    }
  }
}

/** 生产进程共享队列，跨项目也只允许一个高内存 Sharp 批次。 */
const defaultProcessingQueue = new DesignAssetProcessingQueue({
  maxBatchBytes: MAX_BATCH_IMAGE_BYTES,
  maxFiles: MAX_BATCH_IMAGE_FILES,
})

/** staging 文件提升过程可替换的窄文件系统依赖。 */
export interface DesignFilePromotionDependencies {
  /** 优先执行同卷原子 rename；测试可稳定注入 EXDEV。 */
  renameFile?: (sourcePath: string, targetPath: string) => void
  /** 安全删除已提交源文件或回滚目标文件。 */
  removeFile?: (filePath: string) => void
  /** 生成目标卷临时文件随机叶子。 */
  createRandomId?: () => string
  /** 清理未提交文件或目录；测试可稳定注入删除失败。 */
  cleanupPath?: (path: string) => void
}

/** 已完成验证、位于批次 staging 中的单个素材。 */
interface StagedAsset {
  asset: DesignAsset
  stagedAssetPath: string
  stagedThumbnailPath: string
  finalAssetPath: string
  finalThumbnailPath: string
  assetPromotionTemporaryPath: string
  thumbnailPromotionTemporaryPath: string
}

/** promotion 回滚时需要逐项确认不存在的受管路径。 */
interface PromotionCleanupTarget {
  path: string
  label: string
}

/** relink 元数据落盘后的可确认状态。 */
type RelinkMetadataState = 'committed' | 'rolled-back' | 'unknown'

/** 已验证图片的媒体类型、规范扩展名和尺寸。 */
interface ValidatedImage {
  bytes: Buffer
  mediaType: DesignAsset['mediaType']
  extension: string
  width: number
  height: number
  sha256: string
}

/** 为普通数组附加不可枚举事务方法，保持既有数组读取语义。 */
function createDesignAssetImportBatch(
  assets: DesignAsset[],
  commit: () => void,
  rollback: () => void,
): DesignAssetImportBatch {
  Object.defineProperties(assets, {
    commit: { value: commit, enumerable: false },
    rollback: { value: rollback, enumerable: false },
  })
  return assets as DesignAssetImportBatch
}

/** 跨崩溃恢复正式文件 promotion 的最小 journal。 */
interface PromotionJournal {
  schemaVersion: 1 | 2
  projectId: string
  runtimeId: string
  assetNames: string[]
  thumbnailNames: string[]
  stagingDirectoryName?: string
  assetTemporaryNames?: string[]
  thumbnailTemporaryNames?: string[]
  createdAt: number
}

/** 判断错误是否表示文件已不存在。 */
function isMissingPathError(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
}

/** 清理尚未提交的 staging 或回滚文件，不覆盖原始业务错误。 */
function removeUncommittedPath(path: string, cleanupPath?: (path: string) => void): boolean {
  try {
    if (cleanupPath) cleanupPath(path)
    else rmSync(path, { recursive: true, force: true })
    return !existsSync(path)
  } catch {
    // 未提交缓存可由启动清理重建，不能掩盖实际导入错误。
    return false
  }
}

/**
 * 构建 promotion 的统一清理清单。
 * @param stagedAssets 本批次已完成 staging 的素材。
 * @param batchDirectory 本批次独占 staging 目录。
 * @param includePromotedFiles 是否同时清理可能已暴露的正式文件。
 * @returns 按正式文件、跨卷临时文件、staging 排列的清理目标。
 */
function createPromotionCleanupTargets(
  stagedAssets: StagedAsset[],
  batchDirectory: string,
  includePromotedFiles: boolean,
): PromotionCleanupTarget[] {
  return [
    ...stagedAssets.flatMap((staged) => [
      ...(includePromotedFiles ? [
        { path: staged.finalAssetPath, label: '正式原图' },
        { path: staged.finalThumbnailPath, label: '正式缩略图' },
      ] : []),
      { path: staged.assetPromotionTemporaryPath, label: '跨卷临时原图' },
      { path: staged.thumbnailPromotionTemporaryPath, label: '跨卷临时缩略图' },
    ]),
    { path: batchDirectory, label: 'staging' },
  ]
}

/**
 * 清理 promotion 路径并逐项确认磁盘事实，任何失败只告警。
 * @param targets 需要清理并确认不存在的受管路径。
 * @param cleanupPath 可注入的底层清理实现。
 * @param warn 清理失败告警函数。
 * @returns 所有目标均已确认不存在时返回 true。
 */
function cleanupPromotionTargets(
  targets: PromotionCleanupTarget[],
  cleanupPath: ((path: string) => void) | undefined,
  warn: (message: string) => void,
): boolean {
  let cleanupComplete = true
  for (const target of targets) {
    if (removeUncommittedPath(target.path, cleanupPath)) continue
    cleanupComplete = false
    warn(`Design promotion ${target.label} 清理失败: ${target.path}`)
  }
  return cleanupComplete && targets.every((target) => !existsSync(target.path))
}

/**
 * 判断 relink 元数据状态是否足以安全消费 journal。
 * @param state mutate 及磁盘重载共同确认的元数据状态。
 * @returns 已提交或已回滚时返回 true，未知状态返回 false。
 */
function isKnownRelinkMetadataState(state: RelinkMetadataState): boolean {
  return state !== 'unknown'
}

/** 返回项目 promotion journal 的缓存目录。 */
function promotionJournalDirectory(paths: DesignPaths): string {
  return join(paths.jobsDir, 'promotions')
}

/** 原子写入批次正式路径 journal，并返回 journal 路径。 */
function writePromotionJournal(
  paths: DesignPaths,
  projectId: string,
  runtimeId: string,
  batchDirectory: string,
  stagedAssets: StagedAsset[],
  createdAt: number,
  existingJournalPath?: string,
): string {
  const directoryPath = promotionJournalDirectory(paths)
  mkdirSync(directoryPath, { recursive: true })
  const journalPath = existingJournalPath ?? join(directoryPath, `promotion-${randomUUID()}.json`)
  const journal: PromotionJournal = {
    schemaVersion: 2,
    projectId,
    runtimeId,
    assetNames: stagedAssets.map((item) => basename(item.finalAssetPath)),
    thumbnailNames: stagedAssets.map((item) => basename(item.finalThumbnailPath)),
    stagingDirectoryName: basename(batchDirectory),
    assetTemporaryNames: stagedAssets.map((item) => basename(item.assetPromotionTemporaryPath)),
    thumbnailTemporaryNames: stagedAssets.map((item) => basename(item.thumbnailPromotionTemporaryPath)),
    createdAt,
  }
  writeJsonFileAtomicSecure(journalPath, journal)
  return journalPath
}

/** 删除已完成或已完全回滚的 promotion journal。 */
function removePromotionJournal(journalPath: string): void {
  try {
    removeFileAtomic(journalPath)
  } catch (error) {
    if (!isMissingPathError(error)) throw error
  }
}

/** 校验磁盘 journal 只包含当前项目受管目录的随机叶子。 */
function parsePromotionJournal(raw: string, projectId: string): PromotionJournal | undefined {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!value || typeof value !== 'object') return undefined
  const record = value as Partial<PromotionJournal>
  const isSafeNames = (names: unknown): names is string[] => Array.isArray(names)
    && names.every((name) => typeof name === 'string' && basename(name) === name && name.length > 0)
  if ((record.schemaVersion !== 1 && record.schemaVersion !== 2)
    || record.projectId !== projectId
    || typeof record.runtimeId !== 'string'
    || typeof record.createdAt !== 'number'
    || !isSafeNames(record.assetNames)
    || !isSafeNames(record.thumbnailNames)) return undefined
  if (record.schemaVersion === 2) {
    const safeStagingName = typeof record.stagingDirectoryName === 'string'
      && basename(record.stagingDirectoryName) === record.stagingDirectoryName
      && (record.stagingDirectoryName.startsWith('import-') || record.stagingDirectoryName.startsWith('relink-'))
    const safeTemporaryNames = (names: unknown): names is string[] => isSafeNames(names)
      && names.every((name) => name.startsWith('.proma-promote-') && name.endsWith('.tmp'))
    if (!safeStagingName
      || !safeTemporaryNames(record.assetTemporaryNames)
      || !safeTemporaryNames(record.thumbnailTemporaryNames)
      || record.assetTemporaryNames.length !== record.assetNames.length
      || record.thumbnailTemporaryNames.length !== record.thumbnailNames.length) return undefined
  }
  return record as PromotionJournal
}

/** 从未知异常读取 Node 文件系统错误码。 */
function getFileSystemErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined
  /** Node 错误对象中未经信任的 code 字段。 */
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

/** 使用 no-follow 稳定句柄读取 staging 或目标临时普通文件。 */
function readStableFileBytes(filePath: string): Buffer {
  /** 打开前捕获的实际文件身份。 */
  const initialStat = lstatSync(filePath)
  if (!initialStat.isFile() || initialStat.isSymbolicLink()) {
    throw new Error('待提升文件不是实际普通文件')
  }
  const descriptor = openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    /** 打开后与读取后必须保持同一 inode、大小和单链接普通文件。 */
    const beforeStat = fstatSync(descriptor)
    if (!beforeStat.isFile()
      || beforeStat.dev !== initialStat.dev
      || beforeStat.ino !== initialStat.ino
      || beforeStat.size !== initialStat.size
      || beforeStat.nlink !== 1) {
      throw new Error('待提升文件身份已变化')
    }
    const bytes = readFileSync(descriptor)
    const afterStat = fstatSync(descriptor)
    if (afterStat.dev !== beforeStat.dev
      || afterStat.ino !== beforeStat.ino
      || afterStat.size !== beforeStat.size
      || afterStat.nlink !== 1
      || bytes.byteLength !== beforeStat.size) {
      throw new Error('待提升文件读取期间已变化')
    }
    return bytes
  } finally {
    closeSync(descriptor)
  }
}

/**
 * 将 staging 文件提升为正式文件；跨卷时只让目标卷同目录 rename 暴露最终文件。
 * @param sourcePath 已完成生成和校验的 staging 普通文件。
 * @param targetPath 位于正式目录、尚不存在的随机目标路径。
 * @param dependencies 可替换的 rename、删除和随机 ID 依赖。
 * @param preparedTemporaryTargetPath journal 已记录的目标卷临时路径。
 */
export function promoteStagedFile(
  sourcePath: string,
  targetPath: string,
  dependencies: DesignFilePromotionDependencies = {},
  preparedTemporaryTargetPath?: string,
): void {
  const renameFile = dependencies.renameFile ?? renameSync
  const removeFile = dependencies.removeFile ?? removeFileAtomic
  const createRandomId = dependencies.createRandomId ?? randomUUID
  if (existsSync(targetPath)) throw new Error(`Design 正式文件已存在: ${targetPath}`)
  try {
    renameFile(sourcePath, targetPath)
    return
  } catch (error) {
    if (getFileSystemErrorCode(error) !== 'EXDEV') throw error
  }

  /** 跨卷复制只写入目标父目录内不可预测且独占的临时叶子。 */
  const temporaryTargetPath = preparedTemporaryTargetPath
    ?? join(dirname(targetPath), `.proma-promote-${createRandomId()}.tmp`)
  if (dirname(temporaryTargetPath) !== dirname(targetPath)
    || !basename(temporaryTargetPath).startsWith('.proma-promote-')
    || !basename(temporaryTargetPath).endsWith('.tmp')) {
    throw new Error('Design 跨卷临时路径不在正式目标目录')
  }
  try {
    /** staging 源通过稳定句柄读取，复制期间不会跟随叶子符号链接。 */
    const sourceBytes = readStableFileBytes(sourcePath)
    /** 目标临时文件以 exclusive/no-follow 创建，写入后 fsync 内容。 */
    const descriptor = openSync(
      temporaryTargetPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    )
    try {
      writeFileSync(descriptor, sourceBytes)
      fsyncSync(descriptor)
    } finally {
      closeSync(descriptor)
    }
    /** 重读目标临时文件并比较完整内容哈希，拒绝部分写入或置换。 */
    const targetBytes = readStableFileBytes(temporaryTargetPath)
    const sourceHash = createHash('sha256').update(sourceBytes).digest('hex')
    const targetHash = createHash('sha256').update(targetBytes).digest('hex')
    if (sourceBytes.byteLength !== targetBytes.byteLength || sourceHash !== targetHash) {
      throw new Error('Design 跨卷复制校验失败')
    }
    /** 临时文件与正式文件同目录，最后一步 rename 在目标卷原子可见。 */
    renameFile(temporaryTargetPath, targetPath)
    try {
      removeFile(sourcePath)
    } catch (error) {
      /** 源 staging 未能安全删除时回滚已提交目标，让调用方保持失败全清理语义。 */
      removeFile(targetPath)
      throw error
    }
  } finally {
    if (existsSync(temporaryTargetPath)) {
      removeUncommittedPath(temporaryTargetPath, dependencies.cleanupPath)
    }
  }
}

/** 使用 no-follow 稳定句柄读取 picker/Agent 已授权的实际普通文件。 */
function readAuthorizedImage(sourcePath: string): Buffer {
  if (!isAbsolute(sourcePath)) throw new Error('图片来源必须是绝对路径')
  /** lstat 先拒绝末级符号链接和目录等非普通对象。 */
  const initialStat = lstatSync(sourcePath)
  if (!initialStat.isFile() || initialStat.isSymbolicLink()) {
    throw new Error('图片必须是实际普通文件')
  }
  if (initialStat.size > MAX_IMAGE_BYTES) throw new Error('图片不能超过 64 MiB')

  /** O_NOFOLLOW 在支持的平台阻断检查后替换为链接的竞态。 */
  const descriptor = openSync(sourcePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    /** 打开后的稳定身份必须与 lstat 对象一致且保持单一普通文件。 */
    const beforeStat = fstatSync(descriptor)
    if (!beforeStat.isFile()
      || beforeStat.dev !== initialStat.dev
      || beforeStat.ino !== initialStat.ino
      || beforeStat.size > MAX_IMAGE_BYTES) {
      throw new Error('图片文件身份已变化')
    }
    /** 文件大小已先受限，因此一次 Buffer 读取的内存上限固定为 64 MiB。 */
    const bytes = readFileSync(descriptor)
    const afterStat = fstatSync(descriptor)
    if (afterStat.dev !== beforeStat.dev
      || afterStat.ino !== beforeStat.ino
      || afterStat.size !== beforeStat.size
      || bytes.byteLength !== beforeStat.size) {
      throw new Error('图片文件读取期间已变化')
    }
    return bytes
  } finally {
    closeSync(descriptor)
  }
}

/** 确认已持久化素材叶子仍是 assets 目录中的实际普通文件。 */
function assertStoredAssetFile(assetPath: string): Stats {
  /** no-follow 的叶子检查拒绝缺失文件、目录和指向项目外的符号链接。 */
  let assetStat: Stats
  try {
    assetStat = lstatSync(assetPath)
  } catch (error) {
    if (isMissingPathError(error)) throw new Error('素材文件不存在')
    throw error
  }
  if (!assetStat.isFile() || assetStat.isSymbolicLink()) {
    throw new Error('素材文件不是实际普通文件')
  }
  return assetStat
}

/** 使用稳定 no-follow 句柄读取素材，并复验持久化大小与 SHA-256。 */
function readStoredAssetBytes(assetPath: string, asset: DesignAsset): Buffer {
  /** 打开前捕获的实际文件身份。 */
  const initialStat = assertStoredAssetFile(assetPath)
  const descriptor = openSync(assetPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    /** 打开后必须仍是同一普通文件，且大小与素材元数据一致。 */
    const beforeStat = fstatSync(descriptor)
    if (!beforeStat.isFile()
      || beforeStat.dev !== initialStat.dev
      || beforeStat.ino !== initialStat.ino
      || beforeStat.size !== asset.byteSize
      || beforeStat.size > MAX_IMAGE_BYTES) {
      throw new Error('素材文件身份或大小已变化')
    }
    /** 大小已经过持久化元数据和固定上限双重约束。 */
    const bytes = readFileSync(descriptor)
    const afterStat = fstatSync(descriptor)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    if (afterStat.dev !== beforeStat.dev
      || afterStat.ino !== beforeStat.ino
      || afterStat.size !== beforeStat.size
      || bytes.byteLength !== beforeStat.size
      || sha256 !== asset.sha256) {
      throw new Error('素材文件内容已变化')
    }
    return bytes
  } finally {
    closeSync(descriptor)
  }
}

/** 按真实字节签名识别四种受支持图片格式。 */
function detectImageFormat(bytes: Buffer): Pick<ValidatedImage, 'mediaType' | 'extension'> {
  for (const format of IMAGE_FORMATS) {
    if (isValidImageBytes(format.mediaType, bytes)) return format
  }
  throw new Error('不支持或损坏的图片')
}

/** 完成签名、像素上限、尺寸和哈希校验。 */
async function validateImage(sourcePath: string): Promise<ValidatedImage> {
  /** 受大小上限约束并通过稳定句柄读取的完整源字节。 */
  const bytes = readAuthorizedImage(sourcePath)
  /** 扩展名不参与信任，格式完全由内容签名决定。 */
  const format = detectImageFormat(bytes)
  /** Sharp 的 limitInputPixels 是解码边界，metadata 失败统一视为损坏图片。 */
  let metadata: Awaited<ReturnType<ReturnType<typeof sharp>['metadata']>>
  try {
    metadata = await sharp(bytes, { limitInputPixels: MAX_IMAGE_PIXELS }).metadata()
  } catch {
    throw new Error('不支持或损坏的图片')
  }
  if (!metadata.width || !metadata.height || metadata.width * metadata.height > MAX_IMAGE_PIXELS) {
    throw new Error('图片像素不能超过 64000000')
  }
  return {
    bytes,
    ...format,
    width: metadata.width,
    height: metadata.height,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }
}

/** 将单个已验证图片及缩略图写入本批次独占 staging。 */
async function stageAsset(
  paths: DesignPaths,
  batchDirectory: string,
  sourcePath: string,
  source: DesignAssetImportSource,
  now: () => number,
): Promise<StagedAsset> {
  /** 图片格式和尺寸均在任何 staging 写入前完成验证。 */
  const image = await validateImage(sourcePath)
  /** 素材业务 ID 与不可预测磁盘叶子分别独立生成。 */
  const assetId = randomUUID()
  /** 原图正式磁盘名只由随机值和规范扩展组成。 */
  const assetDiskName = `${randomUUID()}${image.extension}`
  /** 缩略图固定 WebP 且使用独立随机磁盘名。 */
  const thumbnailDiskName = `${randomUUID()}.webp`
  /** 本批次内原图 staging 路径。 */
  const stagedAssetPath = join(batchDirectory, assetDiskName)
  /** 本批次内缩略图 staging 路径。 */
  const stagedThumbnailPath = join(batchDirectory, thumbnailDiskName)
  writeFileSync(stagedAssetPath, image.bytes, { flag: 'wx' })
  await sharp(image.bytes, { limitInputPixels: MAX_IMAGE_PIXELS })
    .resize(THUMBNAIL_SIZE, THUMBNAIL_SIZE, { fit: 'inside', withoutEnlargement: true })
    .webp()
    .toFile(stagedThumbnailPath)

  return {
    asset: {
      id: assetId,
      filename: basename(sourcePath),
      relativePath: `assets/${assetDiskName}`,
      thumbnailRelativePath: `thumbnails/${thumbnailDiskName}`,
      mediaType: image.mediaType,
      width: image.width,
      height: image.height,
      byteSize: image.bytes.byteLength,
      sha256: image.sha256,
      createdAt: now(),
      ...(source.sourceSessionId ? { sourceSessionId: source.sourceSessionId } : {}),
      ...(source.sourceJobId ? { sourceJobId: source.sourceJobId } : {}),
      ...(source.parentAssetId ? { parentAssetId: source.parentAssetId } : {}),
      ...(source.prompt !== undefined ? { prompt: source.prompt } : {}),
    },
    stagedAssetPath,
    stagedThumbnailPath,
    finalAssetPath: join(paths.assetsDir, assetDiskName),
    finalThumbnailPath: join(paths.thumbnailsDir, thumbnailDiskName),
    assetPromotionTemporaryPath: join(paths.assetsDir, `.proma-promote-${randomUUID()}.tmp`),
    thumbnailPromotionTemporaryPath: join(paths.thumbnailsDir, `.proma-promote-${randomUUID()}.tmp`),
  }
}

/** 项目级安全素材导入、管理与媒体授权服务。 */
export class DesignAssetService {
  /** 当前时钟依赖。 */
  private readonly now: () => number
  /** 目录级媒体注册函数。 */
  private readonly registerDirectoryPath: (directoryPath: string) => string
  /** 两目录原子注册函数，容量不足时不得返回部分 token。 */
  private readonly registerRetainedDirectoryPaths: (directoryPaths: string[]) => string[]
  /** opaque 媒体授权释放函数。 */
  private readonly revokePathUrl: (url: string) => void
  /** Design 目录授权的显式 lease 保留函数。 */
  private readonly retainPathUrl: (url: string) => boolean
  /** 删除文件失败后的告警函数。 */
  private readonly warn: (message: string) => void
  /** 进程级图片资源队列。 */
  private readonly processingQueue: DesignAssetProcessingQueue
  /** 当前服务实例的恢复所有者 ID。 */
  private readonly runtimeId: string

  constructor(private readonly dependencies: DesignAssetServiceDependencies) {
    this.now = dependencies.now ?? Date.now
    this.registerDirectoryPath = dependencies.registerDirectoryPath
    this.revokePathUrl = dependencies.revokePathUrl
    this.retainPathUrl = dependencies.retainPathUrl ?? retainPromaPathUrl
    this.registerRetainedDirectoryPaths = dependencies.registerRetainedDirectoryPaths
      ?? ((directoryPaths) => this.registerAndRetainDirectoryPaths(directoryPaths))
    this.warn = dependencies.warn ?? console.warn
    this.processingQueue = dependencies.processingQueue ?? defaultProcessingQueue
    this.runtimeId = dependencies.runtimeId ?? randomUUID()
  }

  /**
   * 批量导入主进程已授权的图片；整批 staging 成功后才移动到正式目录。
   * @param projectId 已登记项目稳定 ID。
   * @param sourcePaths 主进程 picker、Agent 或任务产出的绝对路径。
   * @param source 素材来源和版本关系。
   * @returns 已落入正式目录、尚未写入画布的素材元数据。
   */
  async importAuthorizedFiles(
    projectId: string,
    sourcePaths: string[],
    source: DesignAssetImportSource,
  ): Promise<DesignAssetImportBatch> {
    return this.dependencies.runWorkspaceWrite(projectId, async () => {
      if (sourcePaths.length === 0) {
        return createDesignAssetImportBatch([], () => undefined, () => undefined)
      }
      /** stat 只读取大小，累计预算在任何 Buffer 或 Sharp 解码前拒绝。 */
      const byteSizes = sourcePaths.map((sourcePath) => lstatSync(sourcePath).size)
      return this.processingQueue.run(byteSizes, async () => {
      /** store 负责安全创建并验证完整受管目录链，素材服务不得绕过。 */
      this.dependencies.store.load(projectId)
      /** 每次导入使用独占批次目录，失败可整体清理。 */
      const paths = this.dependencies.pathResolver.resolve(projectId)
      const batchDirectory = join(paths.stagingDir, `import-${randomUUID()}`)
      /** 全部验证并完成缩略图的 staging 结果。 */
      const stagedAssets: StagedAsset[] = []
      /** staging 全部成功后、任何正式文件可见前写入恢复 journal。 */
      let journalPath: string | undefined
      try {
        /** 先记录 staging 目录，进程在图片验证中崩溃也可由下一实例清理。 */
        journalPath = writePromotionJournal(
          paths,
          projectId,
          this.runtimeId,
          batchDirectory,
          [],
          this.now(),
        )
        /** journal 先于目录可见，消除 mkdir 后、恢复记录前的崩溃窗口。 */
        mkdirSync(batchDirectory)
        for (const sourcePath of sourcePaths) {
          stagedAssets.push(await stageAsset(paths, batchDirectory, sourcePath, source, this.now))
        }
        /** promotion 前补齐正式叶子和目标卷临时叶子。 */
        journalPath = writePromotionJournal(
          paths,
          projectId,
          this.runtimeId,
          batchDirectory,
          stagedAssets,
          this.now(),
          journalPath,
        )
        for (const staged of stagedAssets) {
          promoteStagedFile(
            staged.stagedAssetPath,
            staged.finalAssetPath,
            this.dependencies.filePromotion,
            staged.assetPromotionTemporaryPath,
          )
          promoteStagedFile(
            staged.stagedThumbnailPath,
            staged.finalThumbnailPath,
            this.dependencies.filePromotion,
            staged.thumbnailPromotionTemporaryPath,
          )
        }
        /** 返回给 IPC 的素材数组仍保持普通数组语义。 */
        const assets = stagedAssets.map((item) => item.asset)
        /** 精确事务只管理本批次 journal，不扫描或接管其他进行中任务。 */
        let settled = false
        const commit = (): void => {
          if (settled || !journalPath) return
          /** commit 只清理可重建的跨卷临时文件与 staging，不触碰已被元数据引用的正式文件。 */
          const cleanupTargets = createPromotionCleanupTargets(stagedAssets, batchDirectory, false)
          /** 任一瞬态路径未确认删除时保留 journal，供新 runtime 继续恢复。 */
          const cleanupComplete = cleanupPromotionTargets(
            cleanupTargets,
            this.dependencies.filePromotion?.cleanupPath,
            this.warn,
          )
          if (!cleanupComplete) return
          try {
            removePromotionJournal(journalPath)
            settled = true
          } catch (error) {
            this.warn(`Design promotion journal 延迟清理: ${journalPath}: ${String(error)}`)
          }
        }
        const rollback = (): void => {
          if (settled || !journalPath) return
          /** 先读取磁盘事实，处理 JSON 已 rename 但 durability 同步失败的模糊提交。 */
          let persistedAssets: DesignAsset[]
          try {
            persistedAssets = this.dependencies.store.load(projectId).document.assets
          } catch (error) {
            this.warn(`Design promotion 回滚状态无法确认，已保留恢复证据: ${String(error)}`)
            return
          }
          /** 只有未被当前画布精确引用的文件才允许删除。 */
          const unreferencedStagedAssets: StagedAsset[] = []
          /** 即时可读引用不证明目录 durability，存在引用时必须保留 journal 到下一进程。 */
          let hasPersistedReference = false
          for (const staged of stagedAssets) {
            const referenced = persistedAssets.some((asset) => (
              asset.id === staged.asset.id
              && asset.relativePath === staged.asset.relativePath
              && asset.thumbnailRelativePath === staged.asset.thumbnailRelativePath
            ))
            if (referenced) {
              hasPersistedReference = true
              continue
            }
            unreferencedStagedAssets.push(staged)
          }
          /** rollback 清理所有瞬态路径，并仅加入磁盘未引用素材的正式文件。 */
          const cleanupTargets = [
            ...unreferencedStagedAssets.flatMap((staged) => [
              { path: staged.finalAssetPath, label: '正式原图' },
              { path: staged.finalThumbnailPath, label: '正式缩略图' },
            ]),
            ...createPromotionCleanupTargets(stagedAssets, batchDirectory, false),
          ]
          /** 路径清理不完整或存在即时引用时都保留 journal，等待跨进程磁盘事实确认。 */
          const cleanupComplete = cleanupPromotionTargets(
            cleanupTargets,
            this.dependencies.filePromotion?.cleanupPath,
            this.warn,
          )
          if (!cleanupComplete || hasPersistedReference) return
          try {
            removePromotionJournal(journalPath)
            settled = true
          } catch (error) {
            this.warn(`Design promotion journal 延迟清理: ${journalPath}: ${String(error)}`)
          }
        }
        return createDesignAssetImportBatch(assets, commit, rollback)
      } catch (error) {
        /** 异常回滚必须覆盖 journal 中所有 final/temp/staging，并逐项确认磁盘已不存在。 */
        const cleanupTargets = createPromotionCleanupTargets(stagedAssets, batchDirectory, true)
        /** 只有所有路径均确认不存在，才允许消费恢复 journal。 */
        const cleanupComplete = cleanupPromotionTargets(
          cleanupTargets,
          this.dependencies.filePromotion?.cleanupPath,
          this.warn,
        )
        if (journalPath && cleanupComplete) {
          try {
            removePromotionJournal(journalPath)
          } catch (cleanupError) {
            /** journal 删除失败也不能覆盖原始导入错误。 */
            this.warn(`Design promotion journal 延迟清理: ${journalPath}: ${String(cleanupError)}`)
          }
        }
        throw error
      } finally {
        removeUncommittedPath(batchDirectory, this.dependencies.filePromotion?.cleanupPath)
      }
      })
    })
  }

  /**
   * 删除未被节点引用的素材元数据，再以原子删除清理原图和缩略图。
   * @param projectId 已登记项目稳定 ID。
   * @param assetId 待删除素材 ID。
   * @param expectedRevision renderer 读取时的画布 revision。
   * @returns 删除提交后的最新画布文档。
   */
  deleteAsset(projectId: string, assetId: string, expectedRevision: number): DesignCanvasDocument {
    return this.dependencies.runWorkspaceWrite(projectId, () => {
      /** 删除前从磁盘最新快照解析素材和引用，避免信任 renderer 状态。 */
      const current = this.dependencies.store.load(projectId).document
      const asset = current.assets.find((item) => item.id === assetId)
      if (!asset) throw new Error(`素材不存在: ${assetId}`)
      if (current.nodes.some((node) => node.assetId === assetId)) {
        throw new Error('素材仍被画布节点引用')
      }
      /** 结构性删除先经过 revision 冲突检查并原子提交 JSON。 */
      const document = this.dependencies.store.mutate(projectId, expectedRevision, [{
        type: 'remove-assets',
        assetIds: [assetId],
      }])
      /** 元数据提交后清理失败只能告警，不能恢复可能已被其他窗口观察的 revision。 */
      for (const filePath of this.resolveStoredAssetFiles(projectId, asset)) {
        try {
          removeFileAtomic(filePath)
        } catch (error) {
          this.warn(`Design 素材文件删除失败: ${filePath}: ${String(error)}`)
        }
      }
      return document
    })
  }

  /**
   * 使用主进程重新选择的单个图片原位修复缺失素材。
   * @param projectId 已登记项目稳定 ID。
   * @param assetId 保持不变的素材 ID。
   * @param sourcePath 主进程重新选择的绝对文件路径。
   * @param expectedRevision renderer 读取时的画布 revision。
   * @returns 元数据替换后的最新画布文档。
   */
  async relinkAsset(
    projectId: string,
    assetId: string,
    sourcePath: string,
    expectedRevision: number,
  ): Promise<DesignCanvasDocument> {
    return this.dependencies.runWorkspaceWrite(projectId, async () => {
      const byteSize = lstatSync(sourcePath).size
      return this.processingQueue.run([byteSize], async () => {
      /** 旧元数据先从磁盘加载，版本和来源字段从此对象完整保留。 */
      const current = this.dependencies.store.load(projectId).document
      const existing = current.assets.find((item) => item.id === assetId)
      if (!existing) throw new Error(`素材不存在: ${assetId}`)
      const paths = this.dependencies.pathResolver.resolve(projectId)
      const batchDirectory = join(paths.stagingDir, `relink-${randomUUID()}`)
      /** 新内容用普通 staging 流程验证，但最终仍保留旧业务 ID 和来源关系。 */
      let staged: StagedAsset | undefined
      /** 元数据磁盘结果三态；unknown 必须保留新文件与 journal 等待恢复。 */
      let metadataState: RelinkMetadataState = 'rolled-back'
      /** 重新定位 promotion 的恢复 journal。 */
      let journalPath: string | undefined
      try {
        journalPath = writePromotionJournal(
          paths,
          projectId,
          this.runtimeId,
          batchDirectory,
          [],
          this.now(),
        )
        /** journal 先于目录可见，确保 relink staging 也可跨进程恢复。 */
        mkdirSync(batchDirectory)
        staged = await stageAsset(paths, batchDirectory, sourcePath, { kind: 'picker' }, this.now)
        journalPath = writePromotionJournal(
          paths,
          projectId,
          this.runtimeId,
          batchDirectory,
          [staged],
          this.now(),
          journalPath,
        )
        const relinked: DesignAsset = {
          ...existing,
          filename: staged.asset.filename,
          relativePath: staged.asset.relativePath,
          thumbnailRelativePath: staged.asset.thumbnailRelativePath,
          mediaType: staged.asset.mediaType,
          width: staged.asset.width,
          height: staged.asset.height,
          byteSize: staged.asset.byteSize,
          sha256: staged.asset.sha256,
        }
        promoteStagedFile(
          staged.stagedAssetPath,
          staged.finalAssetPath,
          this.dependencies.filePromotion,
          staged.assetPromotionTemporaryPath,
        )
        promoteStagedFile(
          staged.stagedThumbnailPath,
          staged.finalThumbnailPath,
          this.dependencies.filePromotion,
          staged.thumbnailPromotionTemporaryPath,
        )
        /** 文件就位后提交引用；冲突时删除新文件，旧元数据保持不变。 */
        let document: DesignCanvasDocument
        try {
          document = this.dependencies.store.mutate(projectId, expectedRevision, [{
            type: 'upsert-assets',
            assets: [relinked],
          }])
          metadataState = 'committed'
        } catch (error) {
          /** mutate 可能已 rename JSON、仅在目录 durability 同步时失败；重载确认引用后保留新文件。 */
          try {
            const persisted = this.dependencies.store.load(projectId).document
            const persistedAsset = persisted.assets.find((item) => item.id === assetId)
            metadataState = persistedAsset?.relativePath === relinked.relativePath
              && persistedAsset.thumbnailRelativePath === relinked.thumbnailRelativePath
              ? 'committed'
              : 'rolled-back'
          } catch {
            /** 无法确认磁盘提交状态时保留文件与 journal，由下一进程按磁盘事实恢复。 */
            metadataState = 'unknown'
          }
          throw error
        }
        /** 提交成功后再清理旧文件；缺失文件视为重新定位的正常状态。 */
        for (const oldPath of this.resolveStoredAssetFiles(projectId, existing)) {
          if (oldPath === staged.finalAssetPath || oldPath === staged.finalThumbnailPath) continue
          try {
            removeFileAtomic(oldPath)
          } catch (error) {
            if (!isMissingPathError(error)) {
              this.warn(`Design 旧素材文件删除失败: ${oldPath}: ${String(error)}`)
            }
          }
        }
        return document
      } finally {
        /** rolled-back 必须清理正式文件；committed/unknown 仅清理可重建的瞬态路径。 */
        const cleanupTargets = createPromotionCleanupTargets(
          staged ? [staged] : [],
          batchDirectory,
          metadataState === 'rolled-back',
        )
        /** 清理失败不得覆盖 relink 的原始业务异常。 */
        const cleanupComplete = cleanupPromotionTargets(
          cleanupTargets,
          this.dependencies.filePromotion?.cleanupPath,
          this.warn,
        )
        /** unknown 状态始终保留 journal，由新 runtime 根据磁盘引用恢复。 */
        if (journalPath && isKnownRelinkMetadataState(metadataState) && cleanupComplete) {
          try {
            removePromotionJournal(journalPath)
          } catch (error) {
            /** journal 删除失败只告警，不反向改写元数据或原始 relink 结果。 */
            this.warn(`Design promotion journal 延迟清理: ${journalPath}: ${String(error)}`)
          }
        }
      }
      })
    })
  }

  /**
   * 接管旧服务实例留下的 promotion journal，删除未被 canvas 引用的正式孤儿。
   * @param projectId 已登记项目稳定 ID。
   */
  recoverPromotionJournals(projectId: string): void {
    this.dependencies.runWorkspaceWrite(projectId, () => {
      const document = this.dependencies.store.load(projectId).document
      const paths = this.dependencies.pathResolver.resolve(projectId)
      const directoryPath = promotionJournalDirectory(paths)
      mkdirSync(directoryPath, { recursive: true })
      const referencedAssets = new Set(document.assets.map((asset) => basename(asset.relativePath)))
      const referencedThumbnails = new Set(document.assets.map((asset) => basename(asset.thumbnailRelativePath)))
      for (const name of readdirSync(directoryPath)) {
        if (!name.startsWith('promotion-') || !name.endsWith('.json')) continue
        const journalPath = join(directoryPath, name)
        const journal = parsePromotionJournal(readFileSync(journalPath, 'utf8'), projectId)
        if (!journal || journal.runtimeId === this.runtimeId) continue
        /** 任何清理失败都保留 journal，供下次启动继续恢复。 */
        let recovered = true
        for (const assetName of journal.assetNames) {
          if (referencedAssets.has(assetName)) continue
          try { removeFileAtomic(join(paths.assetsDir, assetName)) } catch (error) {
            if (!isMissingPathError(error)) {
              recovered = false
              this.warn(`Design promotion 孤儿清理失败: ${assetName}: ${String(error)}`)
            }
          }
        }
        for (const thumbnailName of journal.thumbnailNames) {
          if (referencedThumbnails.has(thumbnailName)) continue
          try { removeFileAtomic(join(paths.thumbnailsDir, thumbnailName)) } catch (error) {
            if (!isMissingPathError(error)) {
              recovered = false
              this.warn(`Design promotion 缩略图清理失败: ${thumbnailName}: ${String(error)}`)
            }
          }
        }
        /** schema 2 还覆盖跨卷目标临时文件与任意阶段崩溃留下的 staging。 */
        for (const temporaryName of journal.assetTemporaryNames ?? []) {
          try { removeFileAtomic(join(paths.assetsDir, temporaryName)) } catch (error) {
            if (!isMissingPathError(error)) {
              recovered = false
              this.warn(`Design promotion 临时原图清理失败: ${temporaryName}: ${String(error)}`)
            }
          }
        }
        for (const temporaryName of journal.thumbnailTemporaryNames ?? []) {
          try { removeFileAtomic(join(paths.thumbnailsDir, temporaryName)) } catch (error) {
            if (!isMissingPathError(error)) {
              recovered = false
              this.warn(`Design promotion 临时缩略图清理失败: ${temporaryName}: ${String(error)}`)
            }
          }
        }
        if (journal.stagingDirectoryName) {
          try {
            rmSync(join(paths.stagingDir, journal.stagingDirectoryName), { recursive: true, force: true })
          } catch (error) {
            recovered = false
            this.warn(`Design promotion staging 清理失败: ${journal.stagingDirectoryName}: ${String(error)}`)
          }
        }
        if (recovered) removePromotionJournal(journalPath)
      }
    })
  }

  /**
   * 将原图复制到主进程 save dialog 返回的绝对目标。
   * @param projectId 已登记项目稳定 ID。
   * @param assetId 待导出素材 ID。
   * @param targetPath 主进程文件选择器返回的绝对路径。
   */
  async exportAsset(projectId: string, assetId: string, targetPath: string): Promise<void> {
    if (!isAbsolute(targetPath)) throw new Error('导出目标必须来自主进程文件选择器')
    /** 导出是用户选择位置的写操作，同样受项目迁移锁约束。 */
    await this.dependencies.runWorkspaceWrite(projectId, async () => {
      /** 素材记录只从当前磁盘画布读取，不信任 renderer 传入路径。 */
      const document = this.dependencies.store.load(projectId).document
      const asset = document.assets.find((item) => item.id === assetId)
      if (!asset) throw new Error(`素材不存在: ${assetId}`)
      const sourcePath = this.resolveStoredAssetFiles(projectId, asset)[0]
      /** no-follow 稳定句柄读取并用持久化 SHA-256 复验源内容。 */
      const bytes = readStoredAssetBytes(sourcePath, asset)
      /** 同目录随机临时文件确保目标替换只在完整复制后发生。 */
      const temporaryTarget = join(dirname(targetPath), `.${basename(targetPath)}.${randomUUID()}.proma-export`)
      try {
        writeFileSync(temporaryTarget, bytes, { flag: 'wx' })
        renameSync(temporaryTarget, targetPath)
      } finally {
        if (existsSync(temporaryTarget)) unlinkSync(temporaryTarget)
      }
    })
  }

  /**
   * 为项目原图和缩略图各注册一个目录级媒体授权。
   * @param projectId 已登记项目稳定 ID。
   * @returns 两个 opaque URL 与幂等释放函数。
   */
  createMediaAccess(projectId: string): {
    assetBaseUrl: string
    thumbnailBaseUrl: string
    release: () => void
  } {
    return this.dependencies.runWorkspaceWrite(projectId, () => {
      this.recoverPromotionJournals(projectId)
      /** store 先验证或创建受管目录链，再允许注册媒体目录。 */
      this.dependencies.store.load(projectId)
      const paths = this.dependencies.pathResolver.resolve(projectId)
      /** 节点数量不影响授权条目数，两个目录必须共享同一容量事务。 */
      const urls = this.registerRetainedDirectoryPaths([paths.assetsDir, paths.thumbnailsDir])
      if (urls.length !== 2 || urls.some((url) => typeof url !== 'string' || !url.startsWith('proma-file://'))) {
        for (const url of urls) this.revokePathUrl(url)
        throw new Error('Design 媒体目录授权未完整注册')
      }
      const [assetBaseUrl, thumbnailBaseUrl] = urls as [string, string]
      /** release 可由视图卸载和项目切换重复调用。 */
      let released = false
      return {
        assetBaseUrl,
        thumbnailBaseUrl,
        release: () => {
          if (released) return
          released = true
          this.revokePathUrl(assetBaseUrl)
          this.revokePathUrl(thumbnailBaseUrl)
        },
      }
    })
  }

  /** 兼容非 registry 注入：逐个注册后统一 retain，失败则回收本批全部 URL。 */
  private registerAndRetainDirectoryPaths(directoryPaths: string[]): string[] {
    const urls: string[] = []
    try {
      for (const directoryPath of directoryPaths) urls.push(this.registerDirectoryPath(directoryPath))
      for (const url of urls) {
        if (!this.retainPathUrl(url)) throw new Error('Design 媒体目录授权 retain 失败')
      }
      return urls
    } catch (error) {
      for (const url of urls) this.revokePathUrl(url)
      throw error
    }
  }

  /**
   * 从磁盘画布元数据解析素材原图路径，不接受 renderer 传入相对路径。
   * @param projectId 已登记项目稳定 ID。
   * @param assetId 素材稳定 ID。
   * @returns 可信 assets 目录内的绝对路径。
   */
  resolveAssetPath(projectId: string, assetId: string): string {
    const document = this.dependencies.store.load(projectId).document
    const asset = document.assets.find((item) => item.id === assetId)
    if (!asset) throw new Error(`素材不存在: ${assetId}`)
    /** 返回前先 no-follow 确认叶子，供 job/session 等主进程入口 fail closed。 */
    const assetPath = this.resolveStoredAssetFiles(projectId, asset)[0]
    assertStoredAssetFile(assetPath)
    return assetPath
  }

  /** 根据已通过 store schema 的素材记录解析原图与缩略图路径。 */
  private resolveStoredAssetFiles(projectId: string, asset: DesignAsset): [string, string] {
    const paths = this.dependencies.pathResolver.resolve(projectId)
    return [
      join(paths.designRoot, asset.relativePath),
      join(paths.cacheRoot, asset.thumbnailRelativePath),
    ]
  }
}
