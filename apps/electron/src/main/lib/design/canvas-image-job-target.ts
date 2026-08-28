import type { CanvasChangeEvent, DesignJobTarget } from '@proma/shared'
import type { CanvasDocumentStore } from './canvas-document-store'
import type { CanvasImageModuleStore } from './canvas-image-module-store'

/** Design Job 中只归属 Canvas 图片模块的目标。 */
export type CanvasImageJobTarget = Extract<DesignJobTarget, { kind: 'canvas-image' }>

/** Canvas 图片 Job 输出采用边界。 */
export interface CanvasImageJobTargetAdapter {
  assertTarget: (projectId: string, target: CanvasImageJobTarget) => Promise<void>
  adoptOutput: (projectId: string, target: CanvasImageJobTarget, assetId: string) => Promise<void>
  isOutputAdopted: (projectId: string, target: CanvasImageJobTarget, assetId: string) => Promise<boolean>
}

/** Canvas 图片 Job 目标适配器的可信依赖。 */
export interface CanvasImageJobTargetAdapterDependencies {
  canvasStore: Pick<CanvasDocumentStore, 'requireStableAuthoritativeDocument' | 'mutate'>
  imageStore: Pick<CanvasImageModuleStore, 'load' | 'adoptAsset'>
  /** 节点投影提交后通知 Renderer 重新加载对应 Canvas。 */
  onCanvasChanged?: (event: CanvasChangeEvent) => void
}

/** 把 Job 目标补全为图片模块 Store 使用的四重身份。 */
function toImageTarget(projectId: string, target: CanvasImageJobTarget) {
  return {
    projectId,
    canvasId: target.canvasId,
    nodeId: target.nodeId,
    imageModuleId: target.imageModuleId,
  }
}

/** 创建严格绑定 Canvas 节点与图片配置的 Job 目标适配器。 */
export function createCanvasImageJobTargetAdapter(
  dependencies: CanvasImageJobTargetAdapterDependencies,
): CanvasImageJobTargetAdapter {
  /** 读取并复核图节点与图片配置仍属于同一目标。 */
  const loadOwnedTarget = async (projectId: string, target: CanvasImageJobTarget) => {
    /** 图片模块 Store 使用的完整身份。 */
    const imageTarget = toImageTarget(projectId, target)
    /** Canvas 图是节点投影的权威事实。 */
    const document = dependencies.canvasStore.requireStableAuthoritativeDocument({
      projectId,
      canvasId: target.canvasId,
    })
    /** 目标节点必须继续引用同一图片模块。 */
    const node = document.nodes.find((candidate) => candidate.id === target.nodeId)
    if (!node || node.kind !== 'image' || node.imageModuleId !== target.imageModuleId) {
      throw new Error('CANVAS_IMAGE_TARGET_INVALID')
    }
    /** 配置读取会再次校验目录身份与 contentId。 */
    const config = await dependencies.imageStore.load(imageTarget)
    if (config.contentId !== target.imageModuleId) throw new Error('CANVAS_IMAGE_TARGET_INVALID')
    return { imageTarget, document, node, config }
  }

  return {
    assertTarget: async (projectId, target) => {
      await loadOwnedTarget(projectId, target)
    },
    adoptOutput: async (projectId, target, assetId) => {
      /** 首次读取同时锁定采用前的配置 revision。 */
      let owned = await loadOwnedTarget(projectId, target)
      if (owned.config.adoptedAssetId !== assetId) {
        await dependencies.imageStore.adoptAsset(
          owned.imageTarget,
          owned.config.revision,
          assetId,
        )
        /** 配置提交后重新读取图，允许崩溃重放只修复节点投影。 */
        owned = await loadOwnedTarget(projectId, target)
      }
      if (owned.node.adoptedAssetId === assetId) return
      /** 节点投影提交后的权威文档携带本次广播必须使用的准确 revision。 */
      const updatedDocument = dependencies.canvasStore.mutate(
        { projectId, canvasId: target.canvasId },
        owned.document.revision,
        [{ type: 'upsert-nodes', nodes: [{ ...owned.node, adoptedAssetId: assetId }] }],
        (current) => {
          /** CAS 提交前再次确认节点没有换绑到其它模块。 */
          const currentNode = current.nodes.find((candidate) => candidate.id === target.nodeId)
          if (!currentNode || currentNode.kind !== 'image'
            || currentNode.imageModuleId !== target.imageModuleId) {
            throw new Error('CANVAS_IMAGE_TARGET_INVALID')
          }
        },
      )
      try {
        dependencies.onCanvasChanged?.({
          projectId,
          canvasId: target.canvasId,
          revision: updatedDocument.revision,
          cause: 'graph',
        })
      } catch (error) {
        /** 广播失败不能回滚已经提交的配置与 Canvas 节点事实。 */
        console.error('[CanvasImageJobTarget] Canvas 变化广播失败:', error)
      }
    },
    isOutputAdopted: async (projectId, target, assetId) => {
      /** 只有配置事实和图投影同时命中才算采用完成。 */
      const owned = await loadOwnedTarget(projectId, target)
      return owned.config.adoptedAssetId === assetId && owned.node.adoptedAssetId === assetId
    },
  }
}
