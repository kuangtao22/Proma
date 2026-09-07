import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { DesignAsset, MediaAssetRef } from '@proma/shared'
import type { DesignAssetService } from '../design/design-asset-service'
import type { DesignStore } from '../design/design-store'
import { acquireMediaFileLock } from './media-file-lock'

/** 仅由可信 Host 传入的输出来源，普通 Agent 不可伪造 Design Job 归属。 */
export interface MediaOutputOrigin { mediaRunId: string; designJobId?: string; sourceSessionId?: string }

/** 复用项目素材提交与迁移锁的窄边界。 */
export interface MediaDesignAssetDependencies {
  store: Pick<DesignStore, 'requireStableAuthoritativeDocument' | 'mutate'>
  assets: Pick<DesignAssetService, 'resolveAssetPath' | 'importAuthorizedImageSources'>
  getStagingDirectory(projectId: string): string
  runWorkspaceWrite<T>(projectId: string, effect: () => T): T
}

/** 旧图片资产是不可变实体，统一媒体引用规范化为 revision 1。 */
function assetRef(asset: DesignAsset): MediaAssetRef {
  return { assetId: asset.id, revision: 1, hash: asset.sha256, mediaKind: 'image' }
}

/** 使普通媒体与 Canvas 图片共用素材库，而不复制第二份图片持久化实现。 */
export class MediaDesignAssets {
  constructor(private readonly dependencies: MediaDesignAssetDependencies) {}

  /** 读取权威元数据授权的稳定文件；调用方继续按引用 hash 复验内容。 */
  async read(projectId: string, reference: MediaAssetRef): Promise<Uint8Array> {
    const document = this.dependencies.store.requireStableAuthoritativeDocument(projectId)
    const asset = document.assets.find((item) => item.id === reference.assetId)
    if (!asset || reference.revision !== 1 || reference.mediaKind !== 'image' || asset.sha256 !== reference.hash) throw new Error('MEDIA_ASSET_NOT_AUTHORIZED')
    const path = this.dependencies.assets.resolveAssetPath(projectId, asset.id)
    const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const before = fstatSync(descriptor)
      if (!before.isFile() || before.size !== asset.byteSize || before.size > 64 * 1024 * 1024) throw new Error('MEDIA_ASSET_CHANGED')
      const bytes = Buffer.alloc(before.size + 1)
      let offset = 0
      while (offset < bytes.length) {
        const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset)
        if (count === 0) break
        offset += count
      }
      const after = fstatSync(descriptor)
      if (offset !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('MEDIA_ASSET_CHANGED')
      return bytes.subarray(0, offset)
    } finally { closeSync(descriptor) }
  }

  /**
   * 按运行输出身份登记图片，素材服务负责实际解码和缩略图。
   * Store 提交已成功而 manifest 尚未更新时，重试从权威来源键返回原资产。
   */
  async register(projectId: string, operationId: string, bytes: Uint8Array, _contentType: string | null, origin: MediaOutputOrigin): Promise<MediaAssetRef> {
    return this.dependencies.runWorkspaceWrite(projectId, async () => {
      this.dependencies.store.requireStableAuthoritativeDocument(projectId)
      const outputIdentity = createHash('sha256').update(JSON.stringify([origin.mediaRunId, operationId])).digest('hex')
      const release = acquireMediaFileLock(join(this.dependencies.getStagingDirectory(projectId), `media-output-${outputIdentity}.lock`))
      try {
      const existing = this.dependencies.store.requireStableAuthoritativeDocument(projectId).assets.find((asset) => asset.sourceMediaRunId === origin.mediaRunId && asset.sourceMediaOutputKey === operationId)
      if (existing) {
        if (existing.sha256 !== createHash('sha256').update(bytes).digest('hex') || existing.sourceJobId !== origin.designJobId
          || existing.sourceSessionId !== origin.sourceSessionId) throw new Error('MEDIA_OUTPUT_IDENTITY_CONFLICT')
        return assetRef(existing)
      }
      const batch = await this.dependencies.assets.importAuthorizedImageSources(projectId, [{
        sourcePath: join(this.dependencies.getStagingDirectory(projectId), `${origin.mediaRunId}.png`),
        byteSize: bytes.byteLength, readBytes: () => Buffer.from(bytes), close: () => undefined,
      }], { kind: 'job', sourceMediaRunId: origin.mediaRunId, sourceMediaOutputKey: operationId,
        ...(origin.designJobId ? { sourceJobId: origin.designJobId } : {}),
        ...(origin.sourceSessionId ? { sourceSessionId: origin.sourceSessionId } : {}) })
      const asset = batch[0]
      if (!asset) { batch.rollback(); throw new Error('MEDIA_OUTPUT_MISSING') }
      try {
        const current = this.dependencies.store.requireStableAuthoritativeDocument(projectId)
        this.dependencies.store.mutate(projectId, current.revision, [{ type: 'upsert-assets', assets: [asset] }])
        batch.commit()
        return assetRef(asset)
      } catch (error) {
        const current = this.dependencies.store.requireStableAuthoritativeDocument(projectId)
        const committed = current.assets.find((candidate) => candidate.id === asset.id)
        if (committed) { batch.commit(); return assetRef(committed) }
        batch.rollback()
        throw error
      }
      } finally { release() }
    })
  }
}
