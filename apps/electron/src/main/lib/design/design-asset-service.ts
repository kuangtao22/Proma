import { createHash, randomUUID } from 'node:crypto'
import {
  constants,
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
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
import { removeFileAtomic } from '../safe-file'
import type { DesignPathResolver, DesignPaths } from './design-paths'
import type { DesignStore } from './design-store'

/** 单个 Design 原图允许占用的最大字节数。 */
const MAX_IMAGE_BYTES = 64 * 1024 * 1024
/** Sharp 解码时允许的最大像素数，防止压缩炸弹耗尽内存。 */
const MAX_IMAGE_PIXELS = 64_000_000
/** 缩略图最长边，兼顾清晰度与画布大批量节点资源开销。 */
const THUMBNAIL_SIZE = 512
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
  /** 显式释放之前注册的 opaque URL。 */
  revokePathUrl: (url: string) => void
  /** 删除提交后文件清理失败时记录告警。 */
  warn?: (message: string) => void
}

/** 已完成验证、位于批次 staging 中的单个素材。 */
interface StagedAsset {
  asset: DesignAsset
  stagedAssetPath: string
  stagedThumbnailPath: string
  finalAssetPath: string
  finalThumbnailPath: string
}

/** 已验证图片的媒体类型、规范扩展名和尺寸。 */
interface ValidatedImage {
  bytes: Buffer
  mediaType: DesignAsset['mediaType']
  extension: string
  width: number
  height: number
  sha256: string
}

/** 判断错误是否表示文件已不存在。 */
function isMissingPathError(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
}

/** 清理尚未提交的 staging 或回滚文件，不覆盖原始业务错误。 */
function removeUncommittedPath(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true })
  } catch {
    // 未提交缓存可由启动清理重建，不能掩盖实际导入错误。
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
  }
}

/** 项目级安全素材导入、管理与媒体授权服务。 */
export class DesignAssetService {
  /** 当前时钟依赖。 */
  private readonly now: () => number
  /** 目录级媒体注册函数。 */
  private readonly registerDirectoryPath: (directoryPath: string) => string
  /** opaque 媒体授权释放函数。 */
  private readonly revokePathUrl: (url: string) => void
  /** 删除文件失败后的告警函数。 */
  private readonly warn: (message: string) => void

  constructor(private readonly dependencies: DesignAssetServiceDependencies) {
    this.now = dependencies.now ?? Date.now
    this.registerDirectoryPath = dependencies.registerDirectoryPath
    this.revokePathUrl = dependencies.revokePathUrl
    this.warn = dependencies.warn ?? console.warn
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
  ): Promise<DesignAsset[]> {
    return this.dependencies.runWorkspaceWrite(projectId, async () => {
      if (sourcePaths.length === 0) return []
      /** store 负责安全创建并验证完整受管目录链，素材服务不得绕过。 */
      this.dependencies.store.load(projectId)
      /** 每次导入使用独占批次目录，失败可整体清理。 */
      const paths = this.dependencies.pathResolver.resolve(projectId)
      const batchDirectory = join(paths.stagingDir, `import-${randomUUID()}`)
      /** 批次目录名不可预测，且父 staging 已由 store 安全验证。 */
      mkdirSync(batchDirectory)
      /** 全部验证并完成缩略图的 staging 结果。 */
      const stagedAssets: StagedAsset[] = []
      /** 已移动到正式目录的路径，用于罕见 rename 中途失败回滚。 */
      const committedPaths: string[] = []
      try {
        for (const sourcePath of sourcePaths) {
          stagedAssets.push(await stageAsset(paths, batchDirectory, sourcePath, source, this.now))
        }
        for (const staged of stagedAssets) {
          renameSync(staged.stagedAssetPath, staged.finalAssetPath)
          committedPaths.push(staged.finalAssetPath)
          renameSync(staged.stagedThumbnailPath, staged.finalThumbnailPath)
          committedPaths.push(staged.finalThumbnailPath)
        }
        return stagedAssets.map((item) => item.asset)
      } catch (error) {
        for (const committedPath of committedPaths) removeUncommittedPath(committedPath)
        throw error
      } finally {
        removeUncommittedPath(batchDirectory)
      }
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
      /** 旧元数据先从磁盘加载，版本和来源字段从此对象完整保留。 */
      const current = this.dependencies.store.load(projectId).document
      const existing = current.assets.find((item) => item.id === assetId)
      if (!existing) throw new Error(`素材不存在: ${assetId}`)
      const paths = this.dependencies.pathResolver.resolve(projectId)
      const batchDirectory = join(paths.stagingDir, `relink-${randomUUID()}`)
      mkdirSync(batchDirectory)
      /** 新内容用普通 staging 流程验证，但最终仍保留旧业务 ID 和来源关系。 */
      let staged: StagedAsset | undefined
      /** 只有画布元数据提交成功后，新正式文件才不应被失败回滚删除。 */
      let metadataCommitted = false
      try {
        staged = await stageAsset(paths, batchDirectory, sourcePath, { kind: 'picker' }, this.now)
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
        renameSync(staged.stagedAssetPath, staged.finalAssetPath)
        renameSync(staged.stagedThumbnailPath, staged.finalThumbnailPath)
        /** 文件就位后提交引用；冲突时删除新文件，旧元数据保持不变。 */
        const document = this.dependencies.store.mutate(projectId, expectedRevision, [{
          type: 'upsert-assets',
          assets: [relinked],
        }])
        metadataCommitted = true
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
        /** rename 或 revision 提交任一步失败，都不得在正式目录留下孤儿文件。 */
        if (staged && !metadataCommitted) {
          removeUncommittedPath(staged.finalAssetPath)
          removeUncommittedPath(staged.finalThumbnailPath)
        }
        removeUncommittedPath(batchDirectory)
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
      /** store 先验证或创建受管目录链，再允许注册媒体目录。 */
      this.dependencies.store.load(projectId)
      const paths = this.dependencies.pathResolver.resolve(projectId)
      /** 节点数量不影响授权条目数，项目始终只注册两个目录。 */
      const assetBaseUrl = this.registerDirectoryPath(paths.assetsDir)
      /** 第二个目录注册失败时立即回收第一个 token。 */
      let thumbnailBaseUrl: string
      try {
        thumbnailBaseUrl = this.registerDirectoryPath(paths.thumbnailsDir)
      } catch (error) {
        this.revokePathUrl(assetBaseUrl)
        throw error
      }
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
