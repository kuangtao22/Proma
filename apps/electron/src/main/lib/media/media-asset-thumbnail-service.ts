import type { MediaAssetRecord, MediaAssetRef } from '@proma/shared'
import type { StoredDesignThumbnail } from '../design/design-asset-service'

/** Renderer 单次可读取的最大缩略图字节数。 */
const MAX_ASSET_THUMBNAIL_BYTES = 512 * 1024

/** 本地缩略图读取所需的最小权威服务集合。 */
export interface MediaAssetThumbnailServiceDependencies {
  assets: { getRecord(projectId: string, asset: MediaAssetRef): MediaAssetRecord }
  thumbnails: { readStoredThumbnail(projectId: string, assetId: string, maxBytes?: number): StoredDesignThumbnail }
}

/** 通过完整媒体引用读取受管图片缩略图。 */
export class MediaAssetThumbnailService {
  constructor(private readonly dependencies: MediaAssetThumbnailServiceDependencies) {}

  /** 读取图片缩略图，完整引用失配、缩略图缺失或超限时直接拒绝。 */
  read(projectId: string, asset: MediaAssetRef): { bytes: Uint8Array; contentType: string } {
    if (asset.mediaKind !== 'image') throw new Error('MEDIA_ASSET_THUMBNAIL_IMAGE_REQUIRED')
    const record = this.dependencies.assets.getRecord(projectId, asset)
    if (record.mediaKind !== 'image') throw new Error('MEDIA_ASSET_THUMBNAIL_IMAGE_REQUIRED')
    const thumbnail = this.dependencies.thumbnails.readStoredThumbnail(projectId, record.id, MAX_ASSET_THUMBNAIL_BYTES)
    if (thumbnail.bytes.byteLength > MAX_ASSET_THUMBNAIL_BYTES) throw new Error('MEDIA_ASSET_THUMBNAIL_SIZE_LIMIT')
    return { bytes: thumbnail.bytes, contentType: thumbnail.mediaType }
  }
}
