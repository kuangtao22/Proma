import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MediaAssetRecord, MediaAssetRef } from '@proma/shared'
import { MediaAssetThumbnailService } from './media-asset-thumbnail-service'

/** 构造固定图片记录，模拟统一媒体资产服务的权威返回。 */
function imageRecord(asset: MediaAssetRef): MediaAssetRecord {
  return {
    id: asset.assetId, revision: 1, hash: asset.hash, mediaKind: 'image', filename: 'asset.png',
    byteSize: 3, mediaType: 'image/png', createdAt: 1, metadata: { width: 8, height: 8 },
  }
}

describe('本地媒体图片缩略图服务', () => {
  test('Given 生产主进程注册媒体IPC When 检查接线 Then 复用统一素材与Design缩略图单例', () => {
    /** 主进程入口较大且依赖 Electron，这里锁定组合服务的关键生产接线。 */
    const source = readFileSync(join(import.meta.dir, '..', '..', 'ipc.ts'), 'utf8')
    expect(source).toContain("import { MediaAssetThumbnailService } from './lib/media/media-asset-thumbnail-service'")
    expect(source).toContain('const mediaAssetThumbnails = new MediaAssetThumbnailService({ assets: mediaAssets, thumbnails: designAssetService })')
    expect(source).toContain('readAssetThumbnail: async (projectId, asset) => mediaAssetThumbnails.read(projectId, asset)')
  })

  test('Given 当前项目完整图片引用 When 读取 Then 先校验记录并仅返回受管缩略图', () => {
    const asset = { assetId: 'asset-1', revision: 1, hash: 'a'.repeat(64), mediaKind: 'image' as const }
    const calls: unknown[] = []
    const service = new MediaAssetThumbnailService({
      assets: { getRecord: (projectId, reference) => { calls.push(['record', projectId, reference]); return imageRecord(reference) } },
      thumbnails: { readStoredThumbnail: (projectId, assetId, maxBytes) => {
        calls.push(['thumbnail', projectId, assetId, maxBytes])
        return { bytes: Buffer.from([1, 2, 3]), mediaType: 'image/webp' }
      } },
    })

    expect(service.read('project-1', asset)).toEqual({ bytes: Buffer.from([1, 2, 3]), contentType: 'image/webp' })
    expect(calls).toEqual([
      ['record', 'project-1', asset],
      ['thumbnail', 'project-1', 'asset-1', 512 * 1024],
    ])
  })

  test('Given 跨项目或错误引用 When 权威记录拒绝 Then 不尝试读取缩略图', () => {
    const asset = { assetId: 'asset-1', revision: 1, hash: 'a'.repeat(64), mediaKind: 'image' as const }
    let thumbnailReads = 0
    const service = new MediaAssetThumbnailService({
      assets: { getRecord: () => { throw new Error('MEDIA_ASSET_NOT_AUTHORIZED') } },
      thumbnails: { readStoredThumbnail: () => { thumbnailReads += 1; throw new Error('不应调用') } },
    })

    expect(() => service.read('other-project', asset)).toThrow('MEDIA_ASSET_NOT_AUTHORIZED')
    expect(thumbnailReads).toBe(0)
  })

  test('Given 非图片引用 When 读取 Then 在查询记录或文件前拒绝', () => {
    let recordReads = 0
    let thumbnailReads = 0
    const service = new MediaAssetThumbnailService({
      assets: { getRecord: () => { recordReads += 1; throw new Error('不应调用') } },
      thumbnails: { readStoredThumbnail: () => { thumbnailReads += 1; throw new Error('不应调用') } },
    })

    expect(() => service.read('project-1', {
      assetId: 'video-1', revision: 1, hash: 'b'.repeat(64), mediaKind: 'video',
    })).toThrow('MEDIA_ASSET_THUMBNAIL_IMAGE_REQUIRED')
    expect(recordReads).toBe(0)
    expect(thumbnailReads).toBe(0)
  })

  test('Given 缩略图缺失或超过512KiB When 读取 Then 明确拒绝且不回退原图', () => {
    const asset = { assetId: 'asset-1', revision: 1, hash: 'a'.repeat(64), mediaKind: 'image' as const }
    const unavailable = new MediaAssetThumbnailService({
      assets: { getRecord: (_projectId, reference) => imageRecord(reference) },
      thumbnails: { readStoredThumbnail: () => { throw new Error('DESIGN_THUMBNAIL_UNAVAILABLE') } },
    })
    const oversized = new MediaAssetThumbnailService({
      assets: { getRecord: (_projectId, reference) => imageRecord(reference) },
      thumbnails: { readStoredThumbnail: () => ({ bytes: Buffer.alloc((512 * 1024) + 1), mediaType: 'image/png' }) },
    })

    expect(() => unavailable.read('project-1', asset)).toThrow('DESIGN_THUMBNAIL_UNAVAILABLE')
    expect(() => oversized.read('project-1', asset)).toThrow('MEDIA_ASSET_THUMBNAIL_SIZE_LIMIT')
  })
})
