import * as React from 'react'
import type {
  DesignAnnotation,
  DesignCanvasDocument,
  DesignJobRecord,
  DesignMutation,
} from '@proma/shared'
import {
  Background,
  Controls,
  ReactFlow,
  applyNodeChanges,
} from '@xyflow/react'
import type {
  Edge,
  NodeTypes,
  OnMoveEnd,
  OnMove,
  OnNodeDrag,
  OnNodesChange,
  OnSelectionChangeFunc,
  ReactFlowProps,
} from '@xyflow/react'
import { useSetAtom, useStore } from 'jotai'
import type { DesignProjectState } from '@/atoms/design-atoms'
import {
  designProjectStatesAtom,
  executeDesignEditAtom,
  redoDesignEditAtom,
  undoDesignEditAtom,
  updateDesignProjectStateAtom,
} from '@/atoms/design-atoms'
import {
  areDesignMutationsJobSafe,
  resolveDesignKeyboardAction,
  selectionContainsDesignJobNode,
} from '@/lib/design-editor'
import { applyDesignMutationsToDocument } from './use-design-workspace'
import { DesignAnnotationLayer } from './DesignAnnotationLayer'
import { DesignAssetNode } from './DesignAssetNode'
import type { DesignAssetFlowNode } from './DesignAssetNode'
import {
  createMoveNodesMutation,
  createViewportMutation,
  mergeDocumentFlowNodes,
  toFlowNodes,
} from './design-canvas-model'

/** XYFlow 自定义节点表保持模块级稳定，避免重渲染重复注册。 */
const DESIGN_NODE_TYPES = { designAsset: DesignAssetNode } satisfies NodeTypes
/** 未加载任务列表时复用稳定空数组，避免 effect 因默认参数新引用重复同步节点。 */
const EMPTY_DESIGN_JOBS: DesignJobRecord[] = []

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
  /** 当前项目任务 journal。 */
  jobs?: DesignJobRecord[]
  /** 当前项目是否允许写入。 */
  writable: boolean
  /** 当前项目画布工具。 */
  activeTool: DesignProjectState['activeTool']
  /** 当前项目选择的节点 ID。 */
  selectedNodeIds: string[]
  /** 当前项目隔离保存的批注草稿。 */
  annotationDraft?: DesignProjectState['maskDraft']
  /** 无 DOM 测试可注入的 Flow renderer；生产默认使用 XYFlow。 */
  flowRenderer?: DesignCanvasFlowRenderer
}

/** DesignCanvas 实际传给 XYFlow 或测试 renderer 的完整属性。 */
export interface DesignCanvasFlowProps extends ReactFlowProps<DesignAssetFlowNode, Edge> {
  /** 当前受控节点数组。 */
  nodes: DesignAssetFlowNode[]
  /** 稳定的选区变化回调。 */
  onSelectionChange: OnSelectionChangeFunc<DesignAssetFlowNode, Edge>
  /** 记录本次活动拖动节点。 */
  onNodeDragStart: OnNodeDrag<DesignAssetFlowNode>
  /** 结束拖动并提交单一 mutation。 */
  onNodeDragStop: OnNodeDrag<DesignAssetFlowNode>
  /** 结束视口移动并提交单一 mutation。 */
  onMoveEnd: OnMoveEnd
}

/** 可观察 DesignCanvas Flow 属性的注入 renderer。 */
export type DesignCanvasFlowRenderer = (props: DesignCanvasFlowProps) => React.ReactNode

export interface DesignCanvasViewportPolicy {
  /** XYFlow 实例 mount 时使用的项目持久视口。 */
  defaultViewport: DesignCanvasDocument['viewport']
  /** revision 0 的首次非空画布允许自动取景并覆盖默认视口。 */
  fitView: boolean
}

/**
 * 计算项目画布 mount 时的视口优先级。
 * revision 0 的非空画布由 fitView 首次取景；已有 revision 时始终恢复持久 viewport。
 */
export function getDesignCanvasViewportPolicy(
  document: DesignCanvasDocument,
): DesignCanvasViewportPolicy {
  return {
    defaultViewport: document.viewport,
    fitView: document.nodes.length > 0 && document.revision === 0,
  }
}

/** 判断两个选区是否包含相同稳定节点 ID，不依赖返回顺序。 */
function haveSameSelectedNodeIds(current: string[], next: string[]): boolean {
  if (current.length !== next.length) return false
  /** 当前选区集合用于忽略 XYFlow 回调的顺序差异。 */
  const currentIds = new Set(current)
  return next.every((nodeId) => currentIds.has(nodeId))
}

/** XYFlow 无限画布：逐帧交互留在组件内存，结束事件才进入 Jotai mutation 队列。 */
export function DesignCanvas({
  document,
  thumbnailBaseUrl,
  jobs = EMPTY_DESIGN_JOBS,
  writable,
  activeTool,
  selectedNodeIds,
  annotationDraft = [],
  flowRenderer,
}: DesignCanvasProps): React.ReactElement {
  const updateProjectState = useSetAtom(updateDesignProjectStateAtom)
  const executeEdit = useSetAtom(executeDesignEditAtom)
  const undoEdit = useSetAtom(undoDesignEditAtom)
  const redoEdit = useSetAtom(redoDesignEditAtom)
  const store = useStore()
  /** 最新选择集合用于文档同步时恢复节点选择态。 */
  const selectedNodeIdsRef = React.useRef(selectedNodeIds)
  selectedNodeIdsRef.current = selectedNodeIds
  /** 当前拖动手势包含的节点 ID，document 更新时保护其本地位置。 */
  const activeDragNodeIdsRef = React.useRef<Set<string>>(new Set())
  /** XYFlow 节点保存在组件内存，拖动帧不会触发 Jotai 或自动保存。 */
  const [flowNodes, setFlowNodes] = React.useState<DesignAssetFlowNode[]>(() => {
    /** 首帧选择集合用于恢复项目切换前的选区。 */
    const selectedIds = new Set(selectedNodeIds)
    return toFlowNodes(document, { thumbnailBaseUrl, jobs }).map((node) => ({
      ...node,
      selected: selectedIds.has(node.id),
    }))
  })
  /** 当前工具与可写状态对应的画布交互配置。 */
  const interaction = getDesignCanvasInteractionConfig(activeTool, writable)
  /** 当前项目 mount 时的视口恢复与首次取景策略。 */
  const viewportPolicy = getDesignCanvasViewportPolicy(document)
  /** XYFlow 移动期间仅保存在组件内存，批注层逐帧跟随但不触发自动保存。 */
  const [liveViewport, setLiveViewport] = React.useState(viewportPolicy.defaultViewport)

  React.useEffect(() => {
    setLiveViewport(document.viewport)
  }, [document.viewport])

  React.useEffect(() => {
    /** 文档变更后同步展示字段，并保护活动拖动节点的本地坐标。 */
    const selectedIds = new Set(selectedNodeIdsRef.current)
    const documentNodes = toFlowNodes(document, { thumbnailBaseUrl, jobs }).map((node) => ({
      ...node,
      selected: selectedIds.has(node.id),
    }))
    setFlowNodes((current) => mergeDocumentFlowNodes(
      current,
      documentNodes,
      activeDragNodeIdsRef.current,
    ))
  }, [document, jobs, thumbnailBaseUrl])

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
        if (!current.snapshot?.writable
          || current.conflictRecoveryPending
          || current.authoritativeRecoveryState !== 'idle') return {}
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

  /** 仅在选区内容真正变化时写入当前项目 Jotai 状态。 */
  const handleSelectionChange = React.useCallback<OnSelectionChangeFunc<DesignAssetFlowNode, Edge>>(({ nodes }) => {
    /** XYFlow 返回的当前选区稳定 ID。 */
    const nextSelectedNodeIds = nodes.map((node) => node.id)
    /** 回调触发时读取该项目 atom 最新选区，避免 prop 尚未重渲染时重复写入。 */
    /** 最新项目状态同时决定是否需要清除右栏独立素材选中态。 */
    const currentState = store.get(designProjectStatesAtom).get(document.projectId)
    const currentSelectedNodeIds = currentState?.selectedNodeIds ?? selectedNodeIdsRef.current
    if (haveSameSelectedNodeIds(currentSelectedNodeIds, nextSelectedNodeIds)
      && !currentState?.inspectorAssetId) return
    selectedNodeIdsRef.current = nextSelectedNodeIds
    updateProjectState({
      projectId: document.projectId,
      update: { selectedNodeIds: nextSelectedNodeIds, inspectorAssetId: null },
    })
  }, [document.projectId, store, updateProjectState])

  /** 记录本次拖动涉及的全部节点，防止保存响应覆盖其逐帧位置。 */
  const handleNodeDragStart = React.useCallback<OnNodeDrag<DesignAssetFlowNode>>((_event, _node, nodes) => {
    activeDragNodeIdsRef.current = new Set(nodes.map((node) => node.id))
  }, [])

  /** 拖动结束后清除保护集合，并只提交一个 move-nodes mutation。 */
  const handleNodeDragStop = React.useCallback<OnNodeDrag<DesignAssetFlowNode>>((_event, _node, nodes) => {
    activeDragNodeIdsRef.current.clear()
    commitMutation(createMoveNodesMutation(nodes))
  }, [commitMutation])

  /** 视口交互结束后只提交一个 set-viewport mutation。 */
  const handleMoveEnd = React.useCallback<OnMoveEnd>((_event, viewport) => {
    setLiveViewport(viewport)
    commitMutation(createViewportMutation(viewport))
  }, [commitMutation])

  /** 视口逐帧变化仅用于批注层视觉同步。 */
  const handleMove = React.useCallback<OnMove>((_event, viewport) => {
    setLiveViewport(viewport)
  }, [])

  /** 把完成的箭头或蒙版作为单次可撤销编辑提交。 */
  const handleCreateAnnotation = React.useCallback((annotation: DesignAnnotation): void => {
    executeEdit({
      projectId: document.projectId,
      command: { type: 'add-annotation', annotation },
    })
  }, [document.projectId, executeEdit])

  /** 批注草稿保存在当前项目状态，切换项目不会串用。 */
  const handleAnnotationDraftChange = React.useCallback((maskDraft: DesignProjectState['maskDraft']): void => {
    updateProjectState({ projectId: document.projectId, update: { maskDraft } })
  }, [document.projectId, updateProjectState])

  /** 调用浏览器安全随机源生成批注或编辑实体身份。 */
  const createEntityId = React.useCallback((): string => globalThis.crypto.randomUUID(), [])
  /** 为批注手势生成稳定身份；controller 通过 useCallback 避免渲染时反复重建。 */
  const createAnnotationIdentity = React.useCallback(() => ({
    id: createEntityId(),
    createdAt: Date.now(),
  }), [createEntityId])

  React.useEffect(() => {
    /** Design 页面活动期间接管有限编辑快捷键。 */
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (!writable) return
      /** 每次键盘事件读取项目最新状态，避免 React prop 更新间隙操作旧选区。 */
      const state = store.get(designProjectStatesAtom).get(document.projectId)
      const selection = state?.selectedNodeIds ?? selectedNodeIdsRef.current
      /** 最新文档用于同步判断 job 选区与历史项是否允许结构编辑。 */
      const latestDocument = state?.snapshot?.document ?? document
      const undoEntry = state?.history.at(-1)
      const redoEntry = state?.future.at(-1)
      const action = resolveDesignKeyboardAction(
        event,
        selection.length > 0,
        !selectionContainsDesignJobNode(latestDocument, selection),
        Boolean(undoEntry && areDesignMutationsJobSafe(latestDocument, undoEntry.inverse)),
        Boolean(redoEntry && areDesignMutationsJobSafe(latestDocument, redoEntry.forward)),
      )
      if (!action) return
      event.preventDefault()
      switch (action) {
        case 'undo':
          undoEdit({ projectId: document.projectId })
          break
        case 'redo':
          redoEdit({ projectId: document.projectId })
          break
        case 'duplicate':
          executeEdit({
            projectId: document.projectId,
            command: {
              type: 'duplicate-selection',
              nodeIds: selection,
              duplicateNodeIds: selection.map(() => createEntityId()),
            },
          })
          break
        case 'delete':
          executeEdit({
            projectId: document.projectId,
            command: { type: 'delete-selection', nodeIds: selection },
          })
          break
        case 'group':
          executeEdit({
            projectId: document.projectId,
            command: {
              type: 'group-selection',
              nodeIds: selection,
              groupId: createEntityId(),
              name: `组 ${document.groups.length + 1}`,
            },
          })
          break
        case 'ungroup':
          executeEdit({
            projectId: document.projectId,
            command: { type: 'ungroup-selection', nodeIds: selection },
          })
          break
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => { window.removeEventListener('keydown', handleKeyDown) }
  }, [createEntityId, document.groups.length, document.projectId, executeEdit, redoEdit, store, undoEdit, writable])

  /** 传给 XYFlow 的属性集中构造，测试可观察真实回调与启动策略。 */
  const flowProps: DesignCanvasFlowProps = {
    nodes: flowNodes,
    edges: [],
    nodeTypes: DESIGN_NODE_TYPES,
    defaultViewport: viewportPolicy.defaultViewport,
    minZoom: 0.05,
    maxZoom: 8,
    selectionOnDrag: interaction.selectionOnDrag,
    panOnDrag: interaction.panOnDrag,
    multiSelectionKeyCode: ['Meta', 'Control'],
    deleteKeyCode: null,
    onlyRenderVisibleElements: true,
    nodesDraggable: interaction.nodesDraggable,
    nodesConnectable: false,
    onNodesChange: handleNodesChange,
    onSelectionChange: handleSelectionChange,
    onNodeDragStart: handleNodeDragStart,
    onNodeDragStop: handleNodeDragStop,
    onMove: handleMove,
    onMoveEnd: handleMoveEnd,
    fitView: viewportPolicy.fitView,
  }

  return (
    <div className="design-canvas relative h-full w-full" aria-label="设计画布" data-project-id={document.projectId}>
      {flowRenderer ? flowRenderer(flowProps) : (
        <ReactFlow<DesignAssetFlowNode> {...flowProps}>
          <Background gap={24} size={1} />
          <Controls showInteractive={false} />
        </ReactFlow>
      )}
      <DesignAnnotationLayer
        annotations={document.annotations}
        activeTool={activeTool}
        writable={writable}
        viewport={liveViewport}
        draft={annotationDraft}
        onDraftChange={handleAnnotationDraftChange}
        onCreate={handleCreateAnnotation}
        createIdentity={createAnnotationIdentity}
      />
    </div>
  )
}
