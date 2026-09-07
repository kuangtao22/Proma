import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createEmptyDesignDocument } from '@proma/shared'
import type { DesignCanvasDocument, DesignInternalMutation, MediaAssetRef } from '@proma/shared'
import { MediaAssetService, type MediaAssetServiceDependencies } from './media-asset-service'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

/** 构造可模拟提交结果未知的统一媒体资产服务。 */
function fixture(options: { throwAfterCommit?: boolean; throwBeforeCommit?: boolean; probeUnavailable?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'proma-media-assets-'))
  roots.push(root)
  const assetsDir = join(root, '.proma', 'design', 'assets')
  mkdirSync(assetsDir, { recursive: true })
  let document: DesignCanvasDocument = createEmptyDesignDocument('project-1', 10)
  let throwAfterCommit = options.throwAfterCommit === true
  let throwBeforeCommit = options.throwBeforeCommit === true
  let imageRegistrations = 0
  const imageBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
  const dependencies: MediaAssetServiceDependencies = {
    pathResolver: { resolve: () => ({ projectId: 'project-1', projectRoot: root, designRoot: join(root, '.proma', 'design'), assetsDir }) },
    store: {
      requireStableAuthoritativeDocument: () => structuredClone(document),
      mutateInternal: (_projectId, expectedRevision, mutations: DesignInternalMutation[]) => {
        expect(expectedRevision).toBe(document.revision)
        if (throwBeforeCommit) { throwBeforeCommit = false; throw new Error('元数据尚未提交') }
        for (const mutation of mutations) {
          if (mutation.type === 'upsert-media-assets') document = { ...document, revision: document.revision + 1, mediaAssets: [...(document.mediaAssets ?? []).filter((item) => !mutation.assets.some((next) => next.id === item.id)), ...mutation.assets] }
          else document = { ...document, revision: document.revision + 1, mediaAssets: (document.mediaAssets ?? []).filter((item) => !mutation.assetIds.includes(item.id)) }
        }
        if (throwAfterCommit) { throwAfterCommit = false; throw new Error('提交结果未知') }
        return structuredClone(document)
      },
    },
    images: {
      read: async () => imageBytes,
      register: async () => { imageRegistrations += 1; return { assetId: 'image-1', revision: 1, hash: createHash('sha256').update(imageBytes).digest('hex'), mediaKind: 'image' } },
    },
    resolveImagePath: (_projectId, assetId) => join(assetsDir, `${assetId}.png`),
    runWorkspaceWrite: (_projectId, effect) => effect(),
    probe: async () => {
      if (options.probeUnavailable) throw new Error('MEDIA_PROBE_UNAVAILABLE')
      return { mediaKind: 'video', mediaType: 'video/mp4', extension: '.mp4', metadata: { width: 1280, height: 720, durationMs: 2000, fps: 24, codec: 'h264', hasAudio: true } }
    },
    now: () => 100,
  }
  return { service: new MediaAssetService(dependencies), getDocument: () => document, assetsDir, imageBytes, getImageRegistrations: () => imageRegistrations }
}

const mp4 = Buffer.from('000000186674797069736f6d00000000', 'hex')

describe('统一媒体资产服务', () => {
  test('Given 既有Design图片 When 列出、读取和登记 Then 映射revision1且不复制图片文件或元数据', async () => {
    const f = fixture()
    const imageHash = createHash('sha256').update(f.imageBytes).digest('hex')
    const document = f.getDocument()
    document.assets.push({ id: 'existing-image', filename: 'a.png', relativePath: 'assets/a.png', thumbnailRelativePath: 'thumbnails/a.webp', mediaType: 'image/png', width: 1, height: 1, byteSize: f.imageBytes.byteLength, sha256: imageHash, createdAt: 1 })
    const registered = await f.service.register('project-1', 'image.main:0', f.imageBytes, 'audio/mpeg', { mediaRunId: 'run-image' })
    expect(registered.mediaKind).toBe('image')
    expect(f.getImageRegistrations()).toBe(1)
    expect((await f.service.list('project-1')).find((item) => item.id === 'existing-image')).toMatchObject({ mediaKind: 'image', metadata: { width: 1, height: 1 } })
  })

  test('Given 视频字节但调用方声称音频 MIME When 登记 Then 以签名和探测结果保存视频记录', async () => {
    const f = fixture()
    const reference = await f.service.register('project-1', 'video.main:0', mp4, 'audio/mpeg', { mediaRunId: 'run-video', sourceSessionId: 'session-1' })
    expect(reference.mediaKind).toBe('video')
    const record = f.service.getRecord('project-1', reference)
    expect(record).toMatchObject({ mediaKind: 'video', mediaType: 'video/mp4', metadata: { fps: 24, hasAudio: true }, sourceSessionId: 'session-1' })
    expect(record).not.toHaveProperty('relativePath')
    expect(readFileSync(f.service.resolveAssetPath('project-1', reference))).toEqual(mp4)
    expect(await f.service.read('project-1', reference)).toEqual(mp4)
  })

  test('Given 实际媒体类型与调用方目标槽位不符 When 登记 Then 在任何正式持久化前拒绝并清理临时文件', async () => {
    const image = fixture()
    await expect(image.service.register(
      'project-1',
      'image.main:0',
      image.imageBytes,
      'image/png',
      { mediaRunId: 'run-image' },
      'audio',
    )).rejects.toThrow('MEDIA_INPUT_TYPE_INVALID')
    expect(image.getImageRegistrations()).toBe(0)
    expect(image.getDocument().assets).toEqual([])
    expect(readdirSync(image.assetsDir)).toEqual([])

    const video = fixture()
    await expect(video.service.register(
      'project-1',
      'video.main:0',
      mp4,
      'video/mp4',
      { mediaRunId: 'run-video' },
      'audio',
    )).rejects.toThrow('MEDIA_INPUT_TYPE_INVALID')
    expect(video.getDocument().mediaAssets ?? []).toEqual([])
    expect(readdirSync(video.assetsDir)).toEqual([])
  })

  test('Given ffprobe不可用 When 登记音视频 Then 不宣布成功且不留下正式文件或元数据', async () => {
    const f = fixture({ probeUnavailable: true })
    await expect(f.service.register('project-1', 'video.main:0', mp4, 'video/mp4', { mediaRunId: 'run-video' })).rejects.toThrow('MEDIA_PROBE_UNAVAILABLE')
    expect(f.getDocument().mediaAssets ?? []).toEqual([])
    expect(readdirSync(f.assetsDir)).toEqual([])
  })

  test('Given 同一输出键已登记 When 字节不同或提交回执丢失后重试 Then 冲突或幂等恢复正式文件', async () => {
    const f = fixture({ throwAfterCommit: true })
    const first = await f.service.register('project-1', 'video.main:0', mp4, 'video/mp4', { mediaRunId: 'run-video' })
    const replay = await f.service.register('project-1', 'video.main:0', mp4, null, { mediaRunId: 'run-video' })
    expect(replay).toEqual(first)
    expect(f.getDocument().mediaAssets).toHaveLength(1)
    await expect(f.service.register('project-1', 'video.main:0', Buffer.concat([mp4, Buffer.from([1])]), 'video/mp4', { mediaRunId: 'run-video' })).rejects.toThrow('MEDIA_OUTPUT_IDENTITY_CONFLICT')
  })

  test('Given 正式文件已提升但元数据提交前崩溃 When 重试 Then 复用原文件并补交元数据', async () => {
    const f = fixture({ throwBeforeCommit: true })
    await expect(f.service.register('project-1', 'video.main:0', mp4, 'video/mp4', { mediaRunId: 'run-video' })).rejects.toThrow('元数据尚未提交')
    const filesBefore = readdirSync(f.assetsDir)
    expect(filesBefore).toHaveLength(1)
    const recovered = await f.service.register('project-1', 'video.main:0', mp4, 'video/mp4', { mediaRunId: 'run-video' })
    expect(recovered.mediaKind).toBe('video')
    expect(readdirSync(f.assetsDir)).toEqual(filesBefore)
    expect(f.getDocument().mediaAssets).toHaveLength(1)
  })

  test('Given 引用版本或hash不匹配 When 读取 Then 在打开文件前拒绝', async () => {
    const f = fixture()
    const reference = await f.service.register('project-1', 'video.main:0', mp4, 'video/mp4', { mediaRunId: 'run-video' })
    const forged: MediaAssetRef = { ...reference, hash: '0'.repeat(64) }
    await expect(f.service.read('project-1', forged)).rejects.toThrow('MEDIA_ASSET_NOT_AUTHORIZED')
  })
})
