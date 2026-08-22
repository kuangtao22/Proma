import * as React from 'react'
import type { DesignCanvasDocument, DesignMutation } from '@proma/shared'
import {
  Background,
  Controls,
  ReactFlow,
  applyNodeChanges,
} from '@xyflow/react'
import type { NodeTypes, OnNodesChange } from '@xyflow/react'
import { useSetAtom } from 'jotai'
import type { DesignProjectState } from '@/atoms/design-atoms'
import { updateDesignProjectStateAtom } from '@/atoms/design-atoms'
import { applyDesignMutationsToDocument } from './use-design-workspace'
import { DesignAssetNode } from './DesignAssetNode'
import type { DesignAssetFlowNode } from './DesignAssetNode'
import {
  createMoveNodesMutation,
  createViewportMutation,
  toFlowNodes,
} from './design-canvas-model'

/** XYFlow 自定义节点表保持模块级稳定，避免重渲染重复注册。 */
const DESIGN_NODE_TYPES = { designAsset: DesignAssetNode } satisfies NodeTypes

export interface DesignCanvasInteractionConfig {
  /** 选择模式允许拖出框选区域。 */
  selectionOnDrag: boolean
  /** 平移模式使用主键，选择模式保留中键和右键平移。 */
  panOnDrag: true | number[]
  /** 仅可写项目的选择模式允许拖动节点。 */
  nodesDraggable: boolean
}

/**
 * 根据当前工具与可写状态生成稳定的 XYFlow 交互配置。
 * @param activeTool 当前项目画布工具。
 * @param writable 当前项目是否允许写入。
 * @returns 选择、平移和节点拖动配置。
 */
export function getDesignCanvasInteractionConfig(
  activeTool: DesignProjectState['activeTool'],
  writable: boolean,
): DesignCanvasInteractionConfig {
  return {
    selectionOnDrag: activeTool === 'select',
    panOnDrag: activeTool === 'pan' ? true : [1, 2],
    nodesDraggable: writable && activeTool === 'select',
  }
}

export interface DesignCanvasProps {
  /** 当前项目的乐观画布文档。 */
  document: DesignCanvasDocument
  /** 当前窗口持有的缩略图媒体授权根。 */
  thumbnailBaseUrl?: string
  /** 当前项目是否允许写入。 */
  writable: boolean
  /** 当前项目画布工具。 */
  activeTool: DesignProjectState['activeTool']
  /** 当前项目选择的节点 ID。 */
  selectedNodeIds: string[]
}

/** XYFlow 无限画布：逐帧交互留在组件内存，结束事件才进入 Jotai mutation 队列。 */
export function DesignCanvas({
  document,
  thumbnailBaseUrl,
  writable,
  activeTool,
  selectedNodeIds,
}: DesignCanvasProps): React.ReactElement {
  const updateProjectState = useSetAtom(updateDesignProjectStateAtom)
  /** 最新选择集合用于文档同步时恢复节点选择态。 */
  const selectedNodeIdsRef = React.useRef(selectedNodeIds)
  selectedNodeIdsRef.current = selectedNodeIds
  /** XYFlow 节点保存在组件内存，拖动帧不会触发 Jotai 或自动保存。 */
  const [flowNodes, setFlowNodes] = React.useState<DesignAssetFlowNode[]>(() => {
    /** 首帧选择集合用于恢复项目切换前的选区。 */
    const selectedIds = new Set(selectedNodeIds)
    return toFlowNodes(document, { thumbnailBaseUrl }).map((node) => ({
      ...node,
      selected: selectedIds.has(node.id),
    }))
  })
  /** 当前工具与可写状态对应的画布交互配置。 */
  const interaction = getDesignCanvasInteractionConfig(activeTool, writable)

  React.useEffect(() => {
    /** 文档变更后以乐观快照为基线重建展示节点。 */
    const selectedIds = new Set(selectedNodeIdsRef.current)
    setFlowNodes(toFlowNodes(document, { thumbnailBaseUrl }).map((node) => ({
      ...node,
      selected: selectedIds.has(node.id),
    })))
  }, [document, thumbnailBaseUrl])

  React.useEffect(() => {
    /** 仅同步选择位，不覆盖拖动中的局部位置。 */
    const selectedIds = new Set(selectedNodeIds)
    setFlowNodes((current) => current.map((node) => ({
      ...node,
      selected: selectedIds.has(node.id),
    })))
  }, [selectedNodeIds])

  /**
   * 乐观应用并排队一个 Design mutation。
   * @param mutation 本次结束型交互产生的单一 mutation。
   * @returns 无返回值。
   */
  const commitMutation = React.useCallback((mutation: DesignMutation): void => {
    if (!writable) return
    updateProjectState({
      projectId: document.projectId,
      update: (current) => {
        if (!current.snapshot) return {}
        return {
          snapshot: {
            ...current.snapshot,
            document: applyDesignMutationsToDocument(current.snapshot.document, [mutation]),
          },
          pendingMutations: [...current.pendingMutations, mutation],
          saveState: current.saveState === 'failed' ? 'failed' : 'dirty',
          viewportDraft: mutation.type === 'set-viewport' ? mutation.viewport : current.viewportDraft,
        }
      },
    })
  }, [document.projectId, updateProjectState, writable])

  /** 逐帧节点变化只更新 XYFlow 局部状态。 */
  const handleNodesChange = React.useCallback<OnNodesChange<DesignAssetFlowNode>>((changes) => {
    setFlowNodes((current) => applyNodeChanges(changes, current))
  }, [])

  return (
    <div className="design-canvas h-full w-full" aria-label="设计画布">
      <ReactFlow<DesignAssetFlowNode>
        nodes={flowNodes}
        edges={[]}
        nodeTypes={DESIGN_NODE_TYPES}
        defaultViewport={document.viewport}
        minZoom={0.05}
        maxZoom={8}
        selectionOnDrag={interaction.selectionOnDrag}
        panOnDrag={interaction.panOnDrag}
        multiSelectionKeyCode={['Meta', 'Control']}
        deleteKeyCode={null}
        onlyRenderVisibleElements
        nodesDraggable={interaction.nodesDraggable}
        nodesConnectable={false}
        onNodesChange={handleNodesChange}
        onSelectionChange={({ nodes }) => {
          /** XYFlow 返回的当前选区稳定 ID。 */
          const nextSelectedNodeIds = nodes.map((node) => node.id)
          updateProjectState({
            projectId: document.projectId,
            update: { selectedNodeIds: nextSelectedNodeIds },
          })
        }}
        onNodeDragStop={(_event, _node, nodes) => {
          commitMutation(createMoveNodesMutation(nodes))
        }}
        onMoveEnd={(_event, viewport) => {
          commitMutation(createViewportMutation(viewport))
        }}
        fitView={document.nodes.length > 0 && document.revision === 0}
      >
        <Background gap={24} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  )
}
