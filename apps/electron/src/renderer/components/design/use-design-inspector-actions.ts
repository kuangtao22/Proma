import * as React from 'react'
import type {
  DesignCanvasDocument,
  DesignPoint,
  DesignViewport,
} from '@proma/shared'
import { useSetAtom, useStore } from 'jotai'
import { toast } from 'sonner'
import {
  designProjectStatesAtom,
  updateDesignProjectStateAtom,
} from '@/atoms/design-atoms'
import type { DesignProjectState } from '@/atoms/design-atoms'
import { designAdapter, type DesignAdapter } from '@/lib/design-adapter'
import {
  applyDesignMutationsToDocument,
  isDesignRecoveryRequired,
} from './use-design-workspace'

/** 将 XYFlow viewport 与容器尺寸转换为可见画布中心。 */
function getViewportCenter(viewport: DesignViewport): DesignPoint {
  if (typeof document === 'undefined') return {
    x: -viewport.x / viewport.zoom || 0,
    y: -viewport.y / viewport.zoom || 0,
  }
  /** 画布槽位是页面提供的稳定尺寸来源。 */
  const canvas = document.querySelector<HTMLElement>('[data-design-canvas-slot]')
  /** 未挂载画布时退化为当前 viewport 原点，不阻塞导入。 */
  const bounds = canvas?.getBoundingClientRect()
  return {
    x: ((bounds?.width ?? 0) / 2 - viewport.x) / viewport.zoom,
    y: ((bounds?.height ?? 0) / 2 - viewport.y) / viewport.zoom,
  }
}

/** Inspector 与画布空态共用的素材命令。 */
export interface DesignInspectorActions {
  importAssets: () => void
  deleteAsset: (assetId: string) => void
  relinkAsset: (assetId: string) => void
  exportAsset: (assetId: string) => void
  selectAsset: (assetId: string) => void
}

/** Inspector 素材命令的异常恢复入口。 */
export interface DesignInspectorActionOptions {
  /** 主进程要求恢复时交给工作区唯一 controller 重新加载。 */
  onRecoveryRequired?: () => void | Promise<void>
}

/**
 * 检查素材删除是否会留下画布引用。
 * @param document 当前权威画布文档。
 * @param assetId 待删除素材 ID。
 * @returns 存在引用时返回稳定用户提示，否则返回 null。
 */
export function getDesignAssetDeleteBlockReason(
  document: DesignCanvasDocument,
  assetId: string,
): string | null {
  return document.nodes.some((node) => node.assetId === assetId)
    ? '请先从画布移除该素材的全部节点'
    : null
}

/** 素材级异步操作和导入布局的共享 hook。 */
export function useDesignInspectorActions(
  projectId: string | null,
  adapter: Pick<DesignAdapter, 'importAssets' | 'deleteAsset' | 'relinkAsset' | 'exportAsset'> = designAdapter,
  options: DesignInspectorActionOptions = {},
): DesignInspectorActions {
  const store = useStore()
  const updateState = useSetAtom(updateDesignProjectStateAtom)
  /** 稳定提取恢复回调，避免 options 对象引用进入 hook 依赖。 */
  const onRecoveryRequired = options.onRecoveryRequired

  /** 读取当前项目最新状态，避免异步结果覆盖返回期间的新编辑。 */
  const getLatestState = React.useCallback((): DesignProjectState | undefined => (
    projectId ? store.get(designProjectStatesAtom).get(projectId) : undefined
  ), [projectId, store])

  /** 四种素材命令共用恢复分流，确保全部交给工作区唯一 controller。 */
  const handleAssetActionError = React.useCallback((error: unknown, fallbackMessage: string): void => {
    if (isDesignRecoveryRequired(error) && onRecoveryRequired) {
      void Promise.resolve(onRecoveryRequired()).catch((recoveryError) => {
        toast.error(recoveryError instanceof Error ? recoveryError.message : '恢复设计工作区失败')
      })
      return
    }
    toast.error(error instanceof Error ? error.message : fallbackMessage)
  }, [onRecoveryRequired])

  /** 导入素材时把当前 revision 与可见中心交给主进程原子提交。 */
  const importAssets = React.useCallback((): void => {
    const initial = getLatestState()
    if (!projectId
      || !initial?.snapshot?.writable
      || initial.saveState !== 'saved'
      || initial.conflictRecoveryPending
      || initial.authoritativeRecoveryState !== 'idle') return
    /** 调用前素材集合用于识别主进程本次新建的素材。 */
    const previousAssetIds = new Set(initial.snapshot.document.assets.map((asset) => asset.id))
    /** Renderer 只提供布局意图，不接触节点 ID、路径或素材元数据。 */
    const viewportCenter = getViewportCenter(initial.snapshot.document.viewport)
    void adapter.importAssets({
      projectId,
      expectedRevision: initial.snapshot.document.revision,
      viewportCenter,
    }).then((importedSnapshot) => {
      /** 导入返回时再次读取本地状态，避免覆盖并发产生的乐观编辑。 */
      const latest = getLatestState()
      if (!latest?.snapshot) return
      /** 主进程返回的新增节点是唯一权威结果，Renderer 仅重放导入期间的本地变更。 */
      const importedNodeIds = importedSnapshot.document.nodes
        .filter((node) => node.assetId && !previousAssetIds.has(node.assetId))
        .map((node) => node.id)
      const optimisticDocument = applyDesignMutationsToDocument(
        importedSnapshot.document,
        latest.pendingMutations,
      )
      updateState({
        projectId,
        update: {
          snapshot: { ...importedSnapshot, document: optimisticDocument },
          ...(importedNodeIds.length > 0 ? {
            selectedNodeIds: importedNodeIds,
            inspectorAssetId: null,
          } : {}),
          error: null,
        },
      })
    }).catch((error) => handleAssetActionError(error, '导入图片失败'))
  }, [adapter, getLatestState, handleAssetActionError, projectId, updateState])

  /** 删除未被画布节点引用的素材。 */
  const deleteAsset = React.useCallback((assetId: string): void => {
    const current = getLatestState()
    if (!projectId
      || !current?.snapshot?.writable
      || current.saveState !== 'saved'
      || current.conflictRecoveryPending
      || current.authoritativeRecoveryState !== 'idle') return
    /** 引用检查必须在调用主进程前完成。 */
    const blockReason = getDesignAssetDeleteBlockReason(current.snapshot.document, assetId)
    if (blockReason) {
      toast.error(blockReason)
      return
    }
    /** 成功素材删除会由主进程同步回收来源创作任务，Renderer 预先保留其聚合身份。 */
    const sourceJobId = current.snapshot.document.assets.find((asset) => asset.id === assetId)?.sourceJobId
    const sourceCreativeTaskId = sourceJobId
      ? current.jobs.find((job) => job.id === sourceJobId)?.creativeTaskId
      : undefined
    void adapter.deleteAsset({ projectId, assetId, expectedRevision: current.snapshot.document.revision })
      .then((document) => updateState({ projectId, update: (latest) => {
        /** 同步清理已由主进程删除的 attempts 和 trace，避免短暂显示幽灵详情。 */
        const taskDetailsByJobId = new Map(latest.taskDetailsByJobId)
        if (sourceJobId) {
          for (const [jobId, entry] of taskDetailsByJobId) {
            if (jobId === sourceJobId
              || (sourceCreativeTaskId && entry.details?.creativeTaskId === sourceCreativeTaskId)) {
              taskDetailsByJobId.delete(jobId)
            }
          }
        }
        return {
          snapshot: latest.snapshot ? {
            ...latest.snapshot,
            document: applyDesignMutationsToDocument(document, latest.pendingMutations),
          } : latest.snapshot,
          jobs: sourceJobId
            ? latest.jobs.filter((job) => (
                sourceCreativeTaskId
                  ? job.creativeTaskId !== sourceCreativeTaskId
                  : job.id !== sourceJobId
              ))
            : latest.jobs,
          taskDetailsByJobId,
          selectedNodeIds: [],
          inspectorAssetId: null,
        }
      } }))
      .catch((error) => handleAssetActionError(error, '删除素材失败'))
  }, [adapter, getLatestState, handleAssetActionError, projectId, updateState])

  /** 调用主进程选择器原位更新缺失素材元数据。 */
  const relinkAsset = React.useCallback((assetId: string): void => {
    const current = getLatestState()
    if (!projectId
      || !current?.snapshot?.writable
      || current.saveState !== 'saved'
      || current.conflictRecoveryPending
      || current.authoritativeRecoveryState !== 'idle') return
    void adapter.relinkAsset({ projectId, assetId, expectedRevision: current.snapshot.document.revision })
      .then((document) => updateState({ projectId, update: (latest) => ({
        snapshot: latest.snapshot ? {
          ...latest.snapshot,
          document: applyDesignMutationsToDocument(document, latest.pendingMutations),
        } : latest.snapshot,
      }) }))
      .catch((error) => handleAssetActionError(error, '重新定位素材失败'))
  }, [adapter, getLatestState, handleAssetActionError, projectId, updateState])

  /** 导出只读取权威素材，不依赖项目 writable。 */
  const exportAsset = React.useCallback((assetId: string): void => {
    if (!projectId) return
    void adapter.exportAsset({ projectId, assetId })
      .catch((error) => handleAssetActionError(error, '导出素材失败'))
  }, [adapter, handleAssetActionError, projectId])

  /** 选择素材时同步选中画布中第一个引用节点。 */
  const selectAsset = React.useCallback((assetId: string): void => {
    const current = getLatestState()
    if (!projectId || !current?.snapshot) return
    /** 一个素材可能存在多个节点，版本入口定位到文档顺序中的首个节点。 */
    const node = current.snapshot.document.nodes.find((item) => item.assetId === assetId)
    updateState({
      projectId,
      update: {
        selectedNodeIds: node ? [node.id] : [],
        inspectorAssetId: assetId,
      },
    })
  }, [getLatestState, projectId, updateState])

  return { importAssets, deleteAsset, relinkAsset, exportAsset, selectAsset }
}
