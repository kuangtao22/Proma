import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DesignAsset, DesignCanvasDocument } from '@proma/shared'
import type { DesignAssetImportBatch } from '../design/design-asset-service'
import { MediaDesignAssets } from './media-design-assets'

/** 输出锁使用每项测试独立的真实临时目录。 */
let stagingDirectory = ''
beforeEach(() => { stagingDirectory = mkdtempSync(join(tmpdir(), 'proma-media-image-')) })
afterEach(() => { rmSync(stagingDirectory, { recursive: true, force: true }) })

describe('媒体产物复用 Design 素材提交', () => {
  test('Given 同一运行输出 When 登记后重启重试 Then 返回同一素材而不重复导入', async () => {
    let imports = 0
    let document = { revision: 1, assets: [] } as unknown as DesignCanvasDocument
    const adapter = new MediaDesignAssets({
      store: { requireStableAuthoritativeDocument: () => document,
        mutate: (_projectId, _revision, mutations) => {
          const mutation = mutations[0]
          if (mutation?.type !== 'upsert-assets') throw new Error('错误 mutation')
          document = { ...document, revision: document.revision + 1, assets: mutation.assets }
          return document
        } },
      assets: { resolveAssetPath: () => '/not-read', importAuthorizedImageSources: async (_projectId, _sources, source) => {
        imports += 1
        const batch = [{ id: 'asset', sha256: createHash('sha256').update(new Uint8Array([1])).digest('hex'), sourceJobId: source.sourceJobId,
          sourceMediaRunId: source.sourceMediaRunId, sourceMediaOutputKey: source.sourceMediaOutputKey,
          mediaType: 'image/png' }] as unknown as DesignAssetImportBatch
        batch.commit = () => undefined
        batch.rollback = () => undefined
        return batch
      } },
      getStagingDirectory: () => stagingDirectory,
      runWorkspaceWrite: (_projectId, effect) => effect(),
    })
    const first = await adapter.register('p', 'run:image.main:0', new Uint8Array([1]), 'image/png', { mediaRunId: 'run', designJobId: 'job' })
    const second = await adapter.register('p', 'run:image.main:0', new Uint8Array([1]), 'image/png', { mediaRunId: 'run', designJobId: 'job' })
    expect(first.assetId).toBe(second.assetId)
    expect(imports).toBe(1)
    expect((document.assets[0] as DesignAsset).sourceJobId).toBe('job')
    await expect(adapter.register('p', 'run:image.main:0', new Uint8Array([2]), 'image/png', { mediaRunId: 'run', designJobId: 'job' })).rejects.toThrow('MEDIA_OUTPUT_IDENTITY_CONFLICT')
  })

  test('Given Store已提交但mutate回执抛错 When 登记重试 Then 采用已提交素材且不重复导入', async () => {
    let imports = 0
    let commits = 0
    let rollbacks = 0
    let throwAfterCommit = true
    let document = { revision: 1, assets: [] } as unknown as DesignCanvasDocument
    const adapter = new MediaDesignAssets({
      store: {
        requireStableAuthoritativeDocument: () => document,
        mutate: (_projectId, _revision, mutations) => {
          /** 先提交权威元数据，再模拟调用方未收到成功回执。 */
          const mutation = mutations[0]
          if (mutation?.type !== 'upsert-assets') throw new Error('错误 mutation')
          document = { ...document, revision: document.revision + 1, assets: mutation.assets }
          if (throwAfterCommit) {
            throwAfterCommit = false
            throw new Error('提交结果未知')
          }
          return document
        },
      },
      assets: {
        resolveAssetPath: () => '/not-read',
        importAuthorizedImageSources: async (_projectId, _sources, source) => {
          imports += 1
          const batch = [{ id: 'asset-after-commit', sha256: createHash('sha256').update(new Uint8Array([1])).digest('hex'), sourceJobId: source.sourceJobId,
            sourceMediaRunId: source.sourceMediaRunId, sourceMediaOutputKey: source.sourceMediaOutputKey,
            mediaType: 'image/png' }] as unknown as DesignAssetImportBatch
          batch.commit = () => { commits += 1 }
          batch.rollback = () => { rollbacks += 1 }
          return batch
        },
      },
      getStagingDirectory: () => stagingDirectory,
      runWorkspaceWrite: (_projectId, effect) => effect(),
    })

    const first = await adapter.register('p', 'run:image.main:0', new Uint8Array([1]), 'image/png', { mediaRunId: 'run', designJobId: 'job' })
    const replay = await adapter.register('p', 'run:image.main:0', new Uint8Array([1]), 'image/png', { mediaRunId: 'run', designJobId: 'job' })
    expect(first.assetId).toBe('asset-after-commit')
    expect(replay).toEqual(first)
    expect(imports).toBe(1)
    expect(commits).toBe(1)
    expect(rollbacks).toBe(0)
  })
})
