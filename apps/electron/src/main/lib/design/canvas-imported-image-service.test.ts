import { describe, expect, test } from 'bun:test'
import type { DesignAsset, DesignCanvasDocument } from '@proma/shared'
import { createEmptyDesignDocument } from '@proma/shared'
import type { DesignAssetImportBatch } from './design-asset-service'
import { createCanvasImportedImageService } from './canvas-imported-image-service'

const target = { projectId: 'project-1', canvasId: 'canvas-1' }

/** 为测试素材数组附加与生产一致的提交和回滚方法。 */
function createImportBatch(asset: DesignAsset, effects: { commits: number; rollbacks: number }): DesignAssetImportBatch {
  const assets = [asset] as DesignAssetImportBatch
  Object.defineProperties(assets, {
    commit: { value: () => { effects.commits += 1 }, enumerable: false },
    rollback: { value: () => { effects.rollbacks += 1 }, enumerable: false },
  })
  return assets
}

/** 构造可观察 Design 元数据、素材批次和 Canvas 产物提交的测试依赖。 */
function createFixture(options: { artifactError?: Error } = {}) {
  let designDocument: DesignCanvasDocument = createEmptyDesignDocument(target.projectId, 1)
  const effects = { commits: 0, rollbacks: 0 }
  const artifactInputs: Array<Record<string, unknown>> = []
  const asset: DesignAsset = {
    id: 'asset-imported',
    filename: 'turnaround.png',
    relativePath: 'assets/imported.png',
    thumbnailRelativePath: 'thumbnails/imported.webp',
    mediaType: 'image/png',
    width: 1200,
    height: 800,
    byteSize: 100,
    sha256: 'a'.repeat(64),
    createdAt: 2,
    sourceSessionId: 'session-1',
  }
  const service = createCanvasImportedImageService({
    assets: {
      importAuthorizedImageSources: async () => createImportBatch(asset, effects),
    },
    design: {
      requireStableAuthoritativeDocument: () => structuredClone(designDocument),
      mutate: (_projectId, expectedRevision, mutations) => {
        if (expectedRevision !== designDocument.revision) throw new Error('DESIGN_REVISION_CONFLICT')
        for (const mutation of mutations) {
          if (mutation.type === 'upsert-assets') designDocument.assets.push(...mutation.assets)
          if (mutation.type === 'remove-assets') {
            designDocument.assets = designDocument.assets.filter((item) => !mutation.assetIds.includes(item.id))
          }
        }
        designDocument = { ...designDocument, revision: designDocument.revision + 1, updatedAt: designDocument.updatedAt + 1 }
        return structuredClone(designDocument)
      },
    },
    artifacts: {
      create: async (input) => {
        artifactInputs.push(structuredClone(input) as unknown as Record<string, unknown>)
        if (options.artifactError) throw options.artifactError
        return {
          canvasId: input.canvasId,
          nodeId: 'image-node-1',
          revision: 4,
          artifactType: 'image' as const,
          sourceToolCallId: input.source.toolCallId,
        }
      },
    },
  })
  return { service, effects, artifactInputs, getDesignDocument: () => structuredClone(designDocument) }
}

describe('Canvas 已有图片导入服务', () => {
  test('Given 当前会话授权图片 When 导入原生 Canvas Then 先登记项目素材再创建已采用图片节点', async () => {
    const fixture = createFixture()
    const result = await fixture.service.import({
      ...target,
      baseRevision: 3,
      title: '马小本三视图',
      prompt: '角色身份参考图，不直接重新生成。',
      authorizedSource: {
        sourcePath: '/authorized/turnaround.png',
        byteSize: 100,
        readBytes: () => Buffer.from('image'),
        close: () => undefined,
      },
      source: { sessionId: 'session-1', runStartedAt: 10, toolCallId: 'tool-import-1' },
    })

    expect(result).toMatchObject({ nodeId: 'image-node-1', revision: 4 })
    expect(fixture.artifactInputs).toEqual([expect.objectContaining({
      artifactType: 'image',
      adoptedAssetId: 'asset-imported',
    })])
    expect(fixture.getDesignDocument().assets.map((asset) => asset.id)).toEqual(['asset-imported'])
    expect(fixture.effects).toEqual({ commits: 1, rollbacks: 0 })
  })

  test('Given Canvas 节点创建失败 When 导入回滚 Then 删除本次素材元数据并清理批次', async () => {
    const fixture = createFixture({ artifactError: new Error('CANVAS_CREATE_FAILED') })

    await expect(fixture.service.import({
      ...target,
      baseRevision: 3,
      title: '马小本三视图',
      authorizedSource: {
        sourcePath: '/authorized/turnaround.png',
        byteSize: 100,
        readBytes: () => Buffer.from('image'),
        close: () => undefined,
      },
      source: { sessionId: 'session-1', runStartedAt: 10, toolCallId: 'tool-import-2' },
    })).rejects.toThrow('CANVAS_CREATE_FAILED')

    expect(fixture.getDesignDocument().assets).toEqual([])
    expect(fixture.effects).toEqual({ commits: 0, rollbacks: 1 })
  })
})
