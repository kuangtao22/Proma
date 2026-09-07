import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import type { DesignAsset, DesignMediaAssetRecord, MediaAssetRecord, MediaAssetRef, MediaKind } from '@proma/shared'
import type { InternalDesignStore } from '../design/design-store'
import type { MediaDesignAssets } from './media-design-assets'
import { detectMediaFileSignature, probeMediaFile } from './media-file-probe'
import type { ProbedMediaFile } from './media-file-probe'
import { acquireMediaFileLock } from './media-file-lock'

const MAX_MEDIA_BYTES = 128 * 1024 * 1024

/** 媒体登记来源只接受 Host 固化身份，不接收模型提供的项目或路径。 */
export interface MediaAssetRegistrationOrigin {
  mediaRunId: string
  designJobId?: string
  sourceSessionId?: string
}

/** 服务只解析 DesignPathResolver 给出的受管目录。 */
interface MediaAssetPaths { designRoot: string; assetsDir: string }

/** 音视频探测和存储依赖均可在边界测试中替换。 */
export interface MediaAssetServiceDependencies {
  pathResolver: { resolve(projectId: string): MediaAssetPaths }
  store: Pick<InternalDesignStore, 'requireStableAuthoritativeDocument' | 'mutateInternal'>
  images: Pick<MediaDesignAssets, 'read' | 'register'>
  resolveImagePath(projectId: string, assetId: string): string
  runWorkspaceWrite<T>(projectId: string, effect: () => T): T
  probe?: (path: string, signatureBytes: Uint8Array) => Promise<ProbedMediaFile>
  now?: () => number
}

/** 进程级串行队列避免多个128MiB音视频同时驻留和探测。 */
class MediaProcessingQueue {
  private tail: Promise<void> = Promise.resolve()

  /** 当前任务无论成功失败都会释放后继。 */
  async run<T>(effect: () => Promise<T>): Promise<T> {
    const previous = this.tail
    let release: () => void = () => undefined
    this.tail = new Promise<void>((resolve) => { release = resolve })
    await previous
    try { return await effect() } finally { release() }
  }
}

const processingQueue = new MediaProcessingQueue()

/** 映射旧图片记录，不复制图片文件或持久化元数据。 */
function publicImage(asset: DesignAsset): MediaAssetRecord {
  return {
    id: asset.id,
    revision: 1,
    hash: asset.sha256,
    mediaKind: 'image',
    filename: asset.filename,
    byteSize: asset.byteSize,
    mediaType: asset.mediaType,
    createdAt: asset.createdAt,
    ...(asset.sourceMediaRunId ? { sourceMediaRunId: asset.sourceMediaRunId } : {}),
    ...(asset.sourceMediaOutputKey ? { sourceMediaOutputKey: asset.sourceMediaOutputKey } : {}),
    ...(asset.sourceSessionId ? { sourceSessionId: asset.sourceSessionId } : {}),
    metadata: { width: asset.width, height: asset.height },
  }
}

/** 移除主进程内部相对路径后返回公共记录。 */
function publicMedia(asset: DesignMediaAssetRecord): MediaAssetRecord {
  const { relativePath: _relativePath, ...record } = asset
  return structuredClone(record)
}

/** 从公共记录构造不可变运行引用。 */
function reference(record: MediaAssetRecord): MediaAssetRef {
  return { assetId: record.id, revision: 1, hash: record.hash, mediaKind: record.mediaKind }
}

/** 判断路径物理位置仍位于受管 Design 根，且 assets 目录不是符号链接。 */
function assertManagedAssetsDirectory(paths: MediaAssetPaths): void {
  const designStats = lstatSync(paths.designRoot)
  const assetStats = lstatSync(paths.assetsDir)
  if (!designStats.isDirectory() || designStats.isSymbolicLink() || !assetStats.isDirectory() || assetStats.isSymbolicLink()) throw new Error('MEDIA_ASSET_PATH_UNSAFE')
  const root = realpathSync(paths.designRoot)
  const assets = realpathSync(paths.assetsDir)
  const relativePath = relative(root, assets)
  if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${sep}`)) throw new Error('MEDIA_ASSET_PATH_UNSAFE')
}

/** 从稳定 descriptor 读取并复验大小、mtime与hash。 */
function readStableFile(path: string, expectedSize: number, expectedHash: string): Uint8Array {
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    const before = fstatSync(descriptor)
    if (!before.isFile() || before.size !== expectedSize || before.size > MAX_MEDIA_BYTES) throw new Error('MEDIA_ASSET_CHANGED')
    const bytes = readFileSync(descriptor)
    const after = fstatSync(descriptor)
    if (bytes.byteLength !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs
      || createHash('sha256').update(bytes).digest('hex') !== expectedHash) throw new Error('MEDIA_ASSET_CHANGED')
    return bytes
  } finally { closeSync(descriptor) }
}

/** 校验输出来源 ID，避免进入文件名或跨运行幂等键的异常输入。 */
function assertOutputIdentity(operationId: string, origin: MediaAssetRegistrationOrigin): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(operationId)
    || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(origin.mediaRunId)
    || (origin.sourceSessionId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(origin.sourceSessionId))) {
    throw new Error('MEDIA_OUTPUT_IDENTITY_INVALID')
  }
}

/** 查找同一运行输出的图片或音视频记录。 */
function findOutput(document: ReturnType<InternalDesignStore['requireStableAuthoritativeDocument']>, origin: MediaAssetRegistrationOrigin, operationId: string): MediaAssetRecord | undefined {
  const image = document.assets.find((asset) => asset.sourceMediaRunId === origin.mediaRunId && asset.sourceMediaOutputKey === operationId)
  if (image) return publicImage(image)
  const media = (document.mediaAssets ?? []).find((asset) => asset.sourceMediaRunId === origin.mediaRunId && asset.sourceMediaOutputKey === operationId)
  return media ? publicMedia(media) : undefined
}

/** 统一读取、登记和枚举图片/音频/视频资产。 */
export class MediaAssetService {
  private readonly probe: NonNullable<MediaAssetServiceDependencies['probe']>
  private readonly now: () => number

  constructor(private readonly dependencies: MediaAssetServiceDependencies) {
    this.probe = dependencies.probe ?? probeMediaFile
    this.now = dependencies.now ?? Date.now
  }

  /** 列出项目权威文档中的公共元数据，不检查或泄露磁盘路径。 */
  async list(projectId: string): Promise<MediaAssetRecord[]> {
    const document = this.dependencies.store.requireStableAuthoritativeDocument(projectId)
    return [...document.assets.map(publicImage), ...(document.mediaAssets ?? []).map(publicMedia)]
  }

  /** 返回与不可变引用完全一致的公共记录。 */
  getRecord(projectId: string, asset: MediaAssetRef): MediaAssetRecord {
    const document = this.dependencies.store.requireStableAuthoritativeDocument(projectId)
    const image = document.assets.find((item) => item.id === asset.assetId)
    const record = image ? publicImage(image) : (() => {
      const media = (document.mediaAssets ?? []).find((item) => item.id === asset.assetId)
      return media ? publicMedia(media) : undefined
    })()
    if (!record || asset.revision !== 1 || asset.hash !== record.hash || asset.mediaKind !== record.mediaKind) throw new Error('MEDIA_ASSET_NOT_AUTHORIZED')
    return record
  }

  /** 只从权威记录和 DesignPathResolver 解析正式文件路径。 */
  resolveAssetPath(projectId: string, asset: MediaAssetRef): string {
    this.getRecord(projectId, asset)
    const document = this.dependencies.store.requireStableAuthoritativeDocument(projectId)
    const image = document.assets.find((item) => item.id === asset.assetId)
    if (image) return this.dependencies.resolveImagePath(projectId, image.id)
    const media = (document.mediaAssets ?? []).find((item) => item.id === asset.assetId)
    if (!media) throw new Error('MEDIA_ASSET_NOT_AUTHORIZED')
    const paths = this.dependencies.pathResolver.resolve(projectId)
    assertManagedAssetsDirectory(paths)
    const path = join(paths.designRoot, media.relativePath)
    if (dirname(path) !== paths.assetsDir) throw new Error('MEDIA_ASSET_PATH_UNSAFE')
    return path
  }

  /** 使用稳定文件身份读取音视频；图片继续复用既有 Design 图片服务。 */
  async read(projectId: string, asset: MediaAssetRef): Promise<Uint8Array> {
    const record = this.getRecord(projectId, asset)
    if (record.mediaKind === 'image') return await this.dependencies.images.read(projectId, asset)
    return await processingQueue.run(async () => readStableFile(this.resolveAssetPath(projectId, asset), record.byteSize, record.hash))
  }

  /** 图片委托原服务；音视频探测成功后与 Design 文档同 revision 原子登记。 */
  async register(
    projectId: string,
    operationId: string,
    bytes: Uint8Array,
    _contentType: string | null,
    origin: MediaAssetRegistrationOrigin,
    expectedMediaKind?: MediaKind,
  ): Promise<MediaAssetRef> {
    assertOutputIdentity(operationId, origin)
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_MEDIA_BYTES) throw new Error('MEDIA_ASSET_SIZE_LIMIT')
    const hash = createHash('sha256').update(bytes).digest('hex')
    const authoritative = this.dependencies.store.requireStableAuthoritativeDocument(projectId)
    const existingImage = authoritative.assets.find((asset) => asset.sourceMediaRunId === origin.mediaRunId && asset.sourceMediaOutputKey === operationId)
    const existing = findOutput(authoritative, origin, operationId)
    if (existing) {
      if (existing.hash !== hash || existing.sourceSessionId !== origin.sourceSessionId
        || (existingImage && existingImage.sourceJobId !== origin.designJobId)) throw new Error('MEDIA_OUTPUT_IDENTITY_CONFLICT')
      if (expectedMediaKind !== undefined && existing.mediaKind !== expectedMediaKind) throw new Error('MEDIA_INPUT_TYPE_INVALID')
      return reference(existing)
    }
    /** 文件签名先于任何正式持久化判断图片；复合音视频容器继续交给 ffprobe 判定真实流类型。 */
    const signature = detectMediaFileSignature(bytes)
    if (signature.mediaKind === 'image') {
      if (expectedMediaKind !== undefined && expectedMediaKind !== 'image') throw new Error('MEDIA_INPUT_TYPE_INVALID')
      return await this.dependencies.images.register(projectId, operationId, bytes, _contentType, origin)
    }
    return await processingQueue.run(async () => await this.dependencies.runWorkspaceWrite(projectId, async () => {
      const paths = this.dependencies.pathResolver.resolve(projectId)
      assertManagedAssetsDirectory(paths)
      const outputIdentity = createHash('sha256').update(JSON.stringify([origin.mediaRunId, operationId])).digest('hex')
      const release = acquireMediaFileLock(join(paths.assetsDir, `.media-output-${outputIdentity}.lock`))
      try {
      const current = this.dependencies.store.requireStableAuthoritativeDocument(projectId)
      const replay = findOutput(current, origin, operationId)
      if (replay) {
        if (replay.hash !== hash || replay.sourceSessionId !== origin.sourceSessionId) throw new Error('MEDIA_OUTPUT_IDENTITY_CONFLICT')
        if (expectedMediaKind !== undefined && replay.mediaKind !== expectedMediaKind) throw new Error('MEDIA_INPUT_TYPE_INVALID')
        return reference(replay)
      }
      const id = `media-${createHash('sha256').update(`${origin.mediaRunId}\0${operationId}`).digest('hex').slice(0, 40)}`
      const temporaryPath = join(paths.assetsDir, `.${id}-${randomUUID()}.tmp`)
      let promoted = false
      try {
        const descriptor = openSync(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
        try { writeFileSync(descriptor, bytes); fsyncSync(descriptor) } finally { closeSync(descriptor) }
        const probed = await this.probe(temporaryPath, bytes.subarray(0, 64))
        if (expectedMediaKind !== undefined && probed.mediaKind !== expectedMediaKind) throw new Error('MEDIA_INPUT_TYPE_INVALID')
        const filename = `${id}${probed.extension}`
        const finalPath = join(paths.assetsDir, filename)
        if (existsSync(finalPath)) {
          try { readStableFile(finalPath, bytes.byteLength, hash) } catch (error) {
            throw new Error('MEDIA_OUTPUT_IDENTITY_CONFLICT', { cause: error })
          }
          unlinkSync(temporaryPath)
        } else {
          renameSync(temporaryPath, finalPath)
          const directory = openSync(paths.assetsDir, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
          try { fsyncSync(directory) } finally { closeSync(directory) }
        }
        promoted = true
        /** 分支构造保留媒体类别与 metadata 的判别联合。 */
        const base = {
          id, revision: 1 as const, hash, filename, relativePath: `assets/${filename}`,
          byteSize: bytes.byteLength, mediaType: probed.mediaType, createdAt: this.now(),
          sourceMediaRunId: origin.mediaRunId, sourceMediaOutputKey: operationId,
          ...(origin.sourceSessionId ? { sourceSessionId: origin.sourceSessionId } : {}),
        }
        const asset: DesignMediaAssetRecord = probed.mediaKind === 'audio'
          ? { ...base, mediaKind: 'audio', metadata: probed.metadata }
          : { ...base, mediaKind: 'video', metadata: probed.metadata }
        try {
          this.dependencies.store.mutateInternal(projectId, current.revision, [{ type: 'upsert-media-assets', assets: [asset] }])
        } catch (error) {
          const committed = findOutput(this.dependencies.store.requireStableAuthoritativeDocument(projectId), origin, operationId)
          if (!committed) throw error
          if (committed.hash !== hash || committed.sourceSessionId !== origin.sourceSessionId) throw new Error('MEDIA_OUTPUT_IDENTITY_CONFLICT')
          return reference(committed)
        }
        return reference(publicMedia(asset))
      } catch (error) {
        if (!promoted) {
          try { unlinkSync(temporaryPath) } catch (cleanupError) {
            if (!(cleanupError instanceof Error && 'code' in cleanupError && cleanupError.code === 'ENOENT')) throw cleanupError
          }
        }
        throw error
      }
      } finally { release() }
    }))
  }
}
