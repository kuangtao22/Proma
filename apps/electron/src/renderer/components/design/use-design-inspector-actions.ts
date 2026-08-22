import * as React from 'react'
import type {
  DesignAsset,
  DesignCanvasDocument,
  DesignMutation,
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
import { applyDesignMutationsToDocument } from './use-design-workspace'

/**
 * 为导入素材创建同一批本地 mutation。
 * @param document 导入完成后的权威画布文档。
 * @param assets 本次新增的素材元数据。
 * @param viewportCenter 当前可见画布中心坐标。
 * @param createNodeId 可注入的稳定节点 ID 工厂。
 * @returns 同步素材和创建节点的两个 mutation；保存 IPC 只提交节点 mutation。
 */
export function createImportedDesignMutations(
  document: DesignCanvasDocument,
  assets: DesignAsset[],
  viewportCenter: DesignPoint,
  createNodeId: () => string,
): DesignMutation[] {
  /** 新节点从现有最大层级之后依次排列。 */
  const firstZIndex = Math.max(-1, ...document.nodes.map((node) => node.zIndex)) + 1
  /** 每个素材创建一个固定尺寸节点，避免加载状态导致布局跳动。 */
  const nodes = assets.map((asset, index) => ({
    id: createNodeId(),
    kind: 'asset' as const,
    assetId: asset.id,
    position: { x: viewportCenter.x + index * 24, y: viewportCenter.y + index * 24 },
    width: 320,
    height: 240,
    zIndex: firstZIndex + index,
  }))
  return [{ type: 'upsert-assets', assets }, { type: 'upsert-nodes', nodes }]
}

/** 将 XYFlow viewport 与容器尺寸转换为可见画布中心。 */
function getViewportCenter(viewport: DesignViewport): DesignPoint {
  if (typeof document === 'undefined') return { x: -viewport.x / viewport.zoom, y: -viewport.y / viewport.zoom }
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
): DesignInspectorActions {
  const store = useStore()
  const updateState = useSetAtom(updateDesignProjectStateAtom)

  /** 读取当前项目最新状态，避免异步结果覆盖返回期间的新编辑。 */
  const getLatestState = React.useCallback((): DesignProjectState | undefined => (
    projectId ? store.get(designProjectStatesAtom).get(projectId) : undefined
  ), [projectId, store])

  /** 导入素材后在可见中心创建节点，并只把允许的节点 mutation 进入保存队列。 */
  const importAssets = React.useCallback((): void => {
    const initial = getLatestState()
    if (!projectId || !initial?.snapshot?.writable || initial.saveState !== 'saved' || initial.conflictRecoveryPending) return
    /** 调用前素材集合用于识别主进程本次新建的素材。 */
    const previousAssetIds = new Set(initial.snapshot.document.assets.map((asset) => asset.id))
    void adapter.importAssets({ projectId }).then((importedSnapshot) => {
      /** 导入返回时再次读取本地状态，避免覆盖并发产生的乐观编辑。 */
      const latest = getLatestState()
      if (!latest?.snapshot) return
      /** 仅本次新增素材需要创建对应画布节点。 */
      const importedAssets = importedSnapshot.document.assets.filter((asset) => !previousAssetIds.has(asset.id))
      if (importedAssets.length === 0) {
        updateState({
          projectId,
          update: {
            snapshot: {
              ...importedSnapshot,
              document: applyDesignMutationsToDocument(
                importedSnapshot.document,
                latest.pendingMutations,
              ),
            },
          },
        })
        return
      }
      /** 素材和节点在同一次界面更新中应用。 */
      const mutations = createImportedDesignMutations(
        importedSnapshot.document,
        importedAssets,
        getViewportCenter(importedSnapshot.document.viewport),
        () => globalThis.crypto.randomUUID(),
      )
      /** 主进程已经提交素材 mutation，Renderer 保存只追加节点 mutation。 */
      const nodeMutation = mutations.find((mutation) => mutation.type === 'upsert-nodes')
      if (!nodeMutation || nodeMutation.type !== 'upsert-nodes') return
      /** 先重放导入期间已有本地变更，再应用本次完整界面批次。 */
      const optimisticDocument = applyDesignMutationsToDocument(
        importedSnapshot.document,
        [...latest.pendingMutations, ...mutations],
      )
      updateState({
        projectId,
        update: {
          snapshot: { ...importedSnapshot, document: optimisticDocument },
          selectedNodeIds: nodeMutation.nodes.map((node) => node.id),
          inspectorAssetId: null,
          history: [...latest.history, {
            forward: [nodeMutation],
            inverse: [{ type: 'remove-nodes', nodeIds: nodeMutation.nodes.map((node) => node.id) }],
          }],
          future: [],
          pendingMutations: [...latest.pendingMutations, nodeMutation],
          saveState: 'dirty',
          error: null,
        },
      })
    }).catch((error) => toast.error(error instanceof Error ? error.message : '导入图片失败'))
  }, [adapter, getLatestState, projectId, updateState])

  /** 删除未被画布节点引用的素材。 */
  const deleteAsset = React.useCallback((assetId: string): void => {
    const current = getLatestState()
    if (!projectId || !current?.snapshot?.writable || current.saveState !== 'saved' || current.conflictRecoveryPending) return
    /** 引用检查必须在调用主进程前完成。 */
    const blockReason = getDesignAssetDeleteBlockReason(current.snapshot.document, assetId)
    if (blockReason) {
      toast.error(blockReason)
      return
    }
    void adapter.deleteAsset({ projectId, assetId, expectedRevision: current.snapshot.document.revision })
      .then((document) => updateState({ projectId, update: (latest) => ({
        snapshot: latest.snapshot ? {
          ...latest.snapshot,
          document: applyDesignMutationsToDocument(document, latest.pendingMutations),
        } : latest.snapshot,
        selectedNodeIds: [],
        inspectorAssetId: null,
      }) }))
      .catch((error) => toast.error(error instanceof Error ? error.message : '删除素材失败'))
  }, [adapter, getLatestState, projectId, updateState])

  /** 调用主进程选择器原位更新缺失素材元数据。 */
  const relinkAsset = React.useCallback((assetId: string): void => {
    const current = getLatestState()
    if (!projectId || !current?.snapshot?.writable || current.saveState !== 'saved' || current.conflictRecoveryPending) return
    void adapter.relinkAsset({ projectId, assetId, expectedRevision: current.snapshot.document.revision })
      .then((document) => updateState({ projectId, update: (latest) => ({
        snapshot: latest.snapshot ? {
          ...latest.snapshot,
          document: applyDesignMutationsToDocument(document, latest.pendingMutations),
        } : latest.snapshot,
      }) }))
      .catch((error) => toast.error(error instanceof Error ? error.message : '重新定位素材失败'))
  }, [adapter, getLatestState, projectId, updateState])

  /** 导出只读取权威素材，不依赖项目 writable。 */
  const exportAsset = React.useCallback((assetId: string): void => {
    if (!projectId) return
    void adapter.exportAsset({ projectId, assetId })
      .catch((error) => toast.error(error instanceof Error ? error.message : '导出素材失败'))
  }, [adapter, projectId])

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
