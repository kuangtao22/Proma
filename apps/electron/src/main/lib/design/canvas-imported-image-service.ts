import type {
  CanvasChangeSource,
  CanvasEdgeRelation,
  CanvasTarget,
  DesignAsset,
  DesignMutation,
  DesignPoint,
} from '@proma/shared'
import type { CanvasArtifactCreationService, CanvasArtifactCreationResult } from './canvas-artifact-creation'
import type {
  DesignAssetImportBatch,
  DesignAssetService,
  DesignAuthorizedImageSource,
} from './design-asset-service'
import type { DesignStore } from './design-store'

/** 把已授权本地图片导入原生 Canvas 所需的可信输入。 */
export interface CanvasImportedImageInput extends CanvasTarget {
  baseRevision: number
  title: string
  prompt?: string
  position?: DesignPoint
  sourceNodeId?: string
  relation?: CanvasEdgeRelation
  authorizedSource: DesignAuthorizedImageSource
  source: CanvasChangeSource
}

/** 导入服务只组合现有素材、Design 元数据和 Canvas 产物事务。 */
export interface CanvasImportedImageServiceDependencies {
  assets: Pick<DesignAssetService, 'importAuthorizedImageSources'>
  design: Pick<DesignStore, 'requireStableAuthoritativeDocument' | 'mutate'>
  artifacts: Pick<CanvasArtifactCreationService, 'create'>
  warn?: (message: string) => void
}

/** 已有图片导入服务的窄公开能力。 */
export interface CanvasImportedImageService {
  import: (input: CanvasImportedImageInput) => Promise<CanvasArtifactCreationResult>
}

/** 判断持久化素材是否仍精确属于本次导入批次。 */
function isSameImportedAsset(left: DesignAsset | undefined, right: DesignAsset): boolean {
  return Boolean(left
    && left.id === right.id
    && left.relativePath === right.relativePath
    && left.thumbnailRelativePath === right.thumbnailRelativePath
    && left.sha256 === right.sha256)
}

/** 在 Canvas 创建失败时只移除本次未公开的独占素材元数据。 */
function rollbackImportedAssetMetadata(
  dependencies: CanvasImportedImageServiceDependencies,
  projectId: string,
  asset: DesignAsset,
): void {
  const current = dependencies.design.requireStableAuthoritativeDocument(projectId)
  const persisted = current.assets.find((candidate) => candidate.id === asset.id)
  if (!persisted) return
  if (!isSameImportedAsset(persisted, asset)) throw new Error('CANVAS_IMAGE_IMPORT_ASSET_CONFLICT')
  /** 新素材 ID 尚未向调用方公开；出现引用说明边界被破坏，必须保留而非误删。 */
  if (current.nodes.some((node) => node.assetId === asset.id)
    || current.assets.some((candidate) => candidate.parentAssetId === asset.id)) {
    throw new Error('CANVAS_IMAGE_IMPORT_ASSET_REFERENCED')
  }
  const mutations: DesignMutation[] = [{ type: 'remove-assets', assetIds: [asset.id] }]
  dependencies.design.mutate(projectId, current.revision, mutations)
}

/** 创建“素材元数据先提交、Canvas 节点后提交”的安全导入服务。 */
export function createCanvasImportedImageService(
  dependencies: CanvasImportedImageServiceDependencies,
): CanvasImportedImageService {
  const warn = dependencies.warn ?? console.warn
  return {
    import: async (input) => {
      let batch: DesignAssetImportBatch | undefined
      let importedAsset: DesignAsset | undefined
      let metadataCommitted = false
      try {
        /** 恢复提升必须在图片解码和正式文件 promotion 前先阻断。 */
        const initialDesign = dependencies.design.requireStableAuthoritativeDocument(input.projectId)
        batch = await dependencies.assets.importAuthorizedImageSources(
          input.projectId,
          [input.authorizedSource],
          { kind: 'agent', sourceSessionId: input.source.sessionId },
        )
        importedAsset = batch[0]
        if (!importedAsset || batch.length !== 1) throw new Error('CANVAS_IMAGE_IMPORT_BATCH_INVALID')
        try {
          dependencies.design.mutate(input.projectId, initialDesign.revision, [{
            type: 'upsert-assets',
            assets: [importedAsset],
          }])
          metadataCommitted = true
        } catch (error) {
          /** JSON rename 后的耐久异常以 fresh Design 事实确认，避免误删已提交文件。 */
          const persisted = dependencies.design.requireStableAuthoritativeDocument(input.projectId)
            .assets.find((asset) => asset.id === importedAsset?.id)
          if (!isSameImportedAsset(persisted, importedAsset)) throw error
          metadataCommitted = true
        }

        const result = await dependencies.artifacts.create({
          projectId: input.projectId,
          canvasId: input.canvasId,
          baseRevision: input.baseRevision,
          artifactType: 'image',
          title: input.title,
          content: input.prompt?.trim() || '当前采用图片是创作参考素材；需要生成新版本前先补充明确提示词。',
          adoptedAssetId: importedAsset.id,
          ...(input.position ? { position: input.position } : {}),
          ...(input.sourceNodeId ? { sourceNodeId: input.sourceNodeId } : {}),
          ...(input.relation ? { relation: input.relation } : {}),
          source: input.source,
        })
        batch.commit()
        return result
      } catch (error) {
        if (metadataCommitted && importedAsset) {
          try {
            rollbackImportedAssetMetadata(dependencies, input.projectId, importedAsset)
          } catch (cleanupError) {
            /** 清理不确定时保留元数据和 promotion journal，禁止破坏可能已发布的文件。 */
            warn(`Canvas 图片导入元数据回滚失败: ${String(cleanupError)}`)
          }
        }
        batch?.rollback()
        throw error
      }
    },
  }
}
