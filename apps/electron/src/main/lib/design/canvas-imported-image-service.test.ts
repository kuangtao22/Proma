import { describe, expect, test } from 'bun:test'
import type { DesignAsset, DesignCanvasDocument } from '@proma/shared'
import { createEmptyDesignDocument } from '@proma/shared'
import type { DesignAssetImportBatch } from './design-asset-service'
import { CanvasArtifactPreflightError } from './canvas-artifact-preflight'
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
function createFixture(options: {
  artifactError?: Error
  preflightError?: Error
  rollbackMetadataError?: Error
} = {}) {
  let designDocument: DesignCanvasDocument = createEmptyDesignDocument(target.projectId, 1)
  const effects = { commits: 0, rollbacks: 0, imports: 0, preflights: 0, mutations: 0 }
  const warnings: string[] = []
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
      importAuthorizedImageSources: async () => {
        effects.imports += 1
        return createImportBatch(asset, effects)
      },
    },
    design: {
      requireStableAuthoritativeDocument: () => structuredClone(designDocument),
      mutate: (_projectId, expectedRevision, mutations) => {
        effects.mutations += 1
        if (expectedRevision !== designDocument.revision) throw new Error('DESIGN_REVISION_CONFLICT')
        if (options.rollbackMetadataError && mutations.some((mutation) => mutation.type === 'remove-assets')) {
          throw options.rollbackMetadataError
        }
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
      validateCreate: () => {
        effects.preflights += 1
        if (options.preflightError) throw options.preflightError
      },
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
    warn: (message) => { warnings.push(message) },
  })
  return { service, effects, warnings, artifactInputs, getDesignDocument: () => structuredClone(designDocument) }
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
    expect(fixture.effects).toEqual({ commits: 1, rollbacks: 0, imports: 1, preflights: 1, mutations: 1 })
  })

  test('Given 来源节点与 relation 完整 When 导入图片 Then 原样传给创建事务并正常提交', async () => {
    const fixture = createFixture()

    await fixture.service.import({
      ...target,
      baseRevision: 3,
      title: '马小本三视图',
      sourceNodeId: 'requirements-1',
      relation: 'reference',
      authorizedSource: {
        sourcePath: '/authorized/turnaround.png',
        byteSize: 100,
        readBytes: () => Buffer.from('image'),
        close: () => undefined,
      },
      source: { sessionId: 'session-1', runStartedAt: 10, toolCallId: 'tool-import-linked' },
    })

    expect(fixture.artifactInputs).toEqual([expect.objectContaining({
      sourceNodeId: 'requirements-1',
      relation: 'reference',
      adoptedAssetId: 'asset-imported',
    })])
    expect(fixture.effects.commits).toBe(1)
  })

  test('Given relation 缺少来源节点 When 导入图片 Then 在素材 promotion 与元数据写入前确定拒绝', async () => {
    const preflightError = new CanvasArtifactPreflightError('CANVAS_ARTIFACT_RELATION_UNEXPECTED')
    const fixture = createFixture({ preflightError })

    const error = await fixture.service.import({
      ...target,
      baseRevision: 3,
      title: '马小本三视图',
      relation: 'association',
      authorizedSource: {
        sourcePath: '/authorized/turnaround.png',
        byteSize: 100,
        readBytes: () => Buffer.from('image'),
        close: () => undefined,
      },
      source: { sessionId: 'session-1', runStartedAt: 10, toolCallId: 'tool-import-invalid' },
    }).catch((cause: unknown) => cause)

    expect(error).toBe(preflightError)
    expect(fixture.getDesignDocument().assets).toEqual([])
    expect(fixture.effects).toEqual({ commits: 0, rollbacks: 0, imports: 0, preflights: 1, mutations: 0 })
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
    expect(fixture.effects).toEqual({ commits: 0, rollbacks: 1, imports: 1, preflights: 1, mutations: 2 })
  })

  test('Given 第二次预检拒绝且导入已开始 When 回滚 Then 因文件清理无法证明而降级为未知', async () => {
    const artifactError = new CanvasArtifactPreflightError('CANVAS_REVISION_CONFLICT')
    const fixture = createFixture({ artifactError })

    const error = await fixture.service.import({
      ...target,
      baseRevision: 3,
      title: '马小本三视图',
      authorizedSource: {
        sourcePath: '/authorized/turnaround.png',
        byteSize: 100,
        readBytes: () => Buffer.from('image'),
        close: () => undefined,
      },
      source: { sessionId: 'session-1', runStartedAt: 10, toolCallId: 'tool-import-preflight-retry' },
    }).catch((cause: unknown) => cause)

    expect(error).not.toBeInstanceOf(CanvasArtifactPreflightError)
    expect(error).toMatchObject({ message: 'CANVAS_IMAGE_IMPORT_COMPENSATION_UNCERTAIN' })
    expect(fixture.getDesignDocument().assets).toEqual([])
    expect(fixture.effects.rollbacks).toBe(1)
  })

  test('Given 第二次预检拒绝但元数据补偿不确定 When 回滚 Then 降级为普通未知错误', async () => {
    const artifactError = new CanvasArtifactPreflightError('CANVAS_REVISION_CONFLICT')
    const fixture = createFixture({
      artifactError,
      rollbackMetadataError: new Error('DESIGN_REMOVE_RESULT_UNCERTAIN'),
    })

    const error = await fixture.service.import({
      ...target,
      baseRevision: 3,
      title: '马小本三视图',
      authorizedSource: {
        sourcePath: '/authorized/turnaround.png',
        byteSize: 100,
        readBytes: () => Buffer.from('image'),
        close: () => undefined,
      },
      source: { sessionId: 'session-1', runStartedAt: 10, toolCallId: 'tool-import-cleanup-uncertain' },
    }).catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(CanvasArtifactPreflightError)
    expect(error).toMatchObject({ message: 'CANVAS_IMAGE_IMPORT_COMPENSATION_UNCERTAIN' })
    expect(fixture.getDesignDocument().assets.map((asset) => asset.id)).toEqual(['asset-imported'])
    expect(fixture.warnings).toEqual([
      'Canvas 图片导入元数据回滚失败: Error: DESIGN_REMOVE_RESULT_UNCERTAIN',
    ])
  })
})
