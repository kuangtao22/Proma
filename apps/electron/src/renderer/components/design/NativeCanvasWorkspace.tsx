import * as React from 'react'
import { applyCanvasMutations } from '@proma/shared'
import type {
  CanvasAgentTarget,
  CanvasAgentNodeCreationResult,
  CanvasChangeEvent,
  CanvasDocument,
  CanvasImageModuleConfig,
  CanvasNodeLifecycleResult,
  CanvasMutation,
  CanvasNode,
  CanvasNodeKind,
  CanvasTarget,
  CanvasWorkspaceSnapshot,
  CreateCanvasAgentNodeInput,
  CreateCanvasContentNodeInput,
  DeleteCanvasNodeInput,
  DesignPoint,
  DesignJobRecord,
  RebuildCanvasAgentNodeInput,
  RebuildCanvasAgentNodeResult,
} from '@proma/shared'
import { useAtomValue, useSetAtom, useStore } from 'jotai'
import { ArchiveRestore, LoaderCircle, RotateCcw } from 'lucide-react'
import {
  canvasAgentRunningSessionIdsAtom,
  canvasAgentOptimisticRunGenerationsAtom,
  canvasAgentRunGenerationsAtom,
  createInitialNativeCanvasState,
  createNativeCanvasKey,
  createNativeCanvasWorkbenchChangeUpdate,
  nativeCanvasStatesAtom,
  updateNativeCanvasStateAtom,
} from '@/atoms/native-canvas-atoms'
import type {
  CanvasImageModuleDraft,
  CanvasImageModuleSaveState,
  NativeCanvasState,
} from '@/atoms/native-canvas-atoms'
import {
  createInitialDesignProjectState,
  designProjectStatesAtom,
} from '@/atoms/design-atoms'
import {
  channelSettingsFocusAtom,
  settingsOpenAtom,
  settingsTabAtom,
} from '@/atoms/settings-tab'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { CanvasPublicOperationError, designAdapter } from '@/lib/design-adapter'
import type { DesignAdapter } from '@/lib/design-adapter'
import { copyTextToClipboard } from '@/lib/clipboard'
import { CanvasAgentRecoveryPanel } from './CanvasAgentRecoveryPanel'
import { CanvasNodeWorkbenchOverlay } from './CanvasNodeWorkbenchOverlay'
import { CanvasImageWorkbench } from './CanvasImageWorkbench'
import { NativeCanvasGraph } from './NativeCanvasGraph'
import type { NativeCanvasFlowRenderer } from './NativeCanvasGraph'
import { NativeCanvasDeleteDialog, isNativeCanvasDeleteShortcut } from './NativeCanvasDeleteDialog'
import {
  NativeCanvasTrashDialog,
  createNativeCanvasTrashController,
} from './NativeCanvasTrashDialog'
import type { NativeCanvasTrashController, NativeCanvasTrashState } from './NativeCanvasTrashDialog'
import { NativeCanvasToolbar } from './NativeCanvasToolbar'
import {
  CanvasAgentConversation,
  type CanvasAgentConversationAdapter,
  type CanvasAgentConversationProps,
} from './CanvasAgentConversation'
import {
  canReplayNativeCanvasPositionMutations,
  coalesceNativeCanvasMutationsForSave,
  findAvailableNativeCanvasChildPosition,
  findNativeCanvasGlobalAppendPosition,
  isNativeCanvasPositionMutation,
  NATIVE_CANVAS_NODE_GAP,
  NATIVE_CANVAS_NODE_HEIGHT,
  NATIVE_CANVAS_NODE_WIDTH,
  overlapsNativeCanvasNodes,
  replayNativeCanvasPositionMutations,
} from './native-canvas-model'
import {
  useCanvasImageModule,
  type CanvasImageModuleAdapter,
} from './use-canvas-image-module'
import {
  useDesignImageModelSelection,
  type DesignImageModelSelectionAdapter,
} from './use-design-image-model-selection'

/** 原生 Canvas 自动保存采用 400ms 尾触发。 */
export const NATIVE_CANVAS_SAVE_DEBOUNCE_MS = 400

/** 图片配置连续编辑合并为一次保存，避免每次输入都触发磁盘写入。 */
export const NATIVE_CANVAS_IMAGE_SAVE_DEBOUNCE_MS = 500

/** 合法节点 ID 不允许使用该内部保留值，用于复用 dirty 切换确认关闭工作台。 */
export const NATIVE_CANVAS_WORKBENCH_CLOSE_TARGET = '__close-workbench__'
/** SAVE 要求立即加载权威恢复快照的稳定错误前缀。 */
export const NATIVE_CANVAS_RECOVERY_REQUIRED_CODE = 'CANVAS_RECOVERY_REQUIRED'
/** SAVE 基线 revision 已落后的稳定错误前缀。 */
export const NATIVE_CANVAS_REVISION_CONFLICT_CODE = 'CANVAS_REVISION_CONFLICT'
/** SAVE 提交结果无法确认时的稳定错误前缀。 */
export const NATIVE_CANVAS_COMMIT_UNCERTAIN_CODE = 'CANVAS_COMMIT_UNCERTAIN'
/** 无法安全重放结构修改时显示的稳定冲突文本。 */
export const NATIVE_CANVAS_STRUCTURAL_CONFLICT_MESSAGE = 'Canvas 结构已在恢复期间变化，请处理本地结构冲突'

/** 路由顶部节点类型选择到统一创建命令。 */
export function runNativeCanvasToolbarAddNode(
  kind: CanvasNodeKind,
  execute: (request: CanvasNodeCreateCommandRequest) => void,
): void {
  execute({ kind })
}
/** controller 使用的最小原生 Canvas adapter 合同。 */
export interface NativeCanvasAdapter {
  loadCanvas: DesignAdapter['loadCanvas']
  saveCanvas: DesignAdapter['saveCanvas']
  onCanvasChanged: DesignAdapter['onCanvasChanged']
  /** 旧测试替身可省略，真实 Design adapter 始终提供。 */
  createCanvasAgentNode?: DesignAdapter['createCanvasAgentNode']
  /** 非 Agent 内容节点必须通过主进程生命周期创建。 */
  createCanvasContentNode?: DesignAdapter['createCanvasContentNode']
  /** 任意节点删除均通过主进程权威生命周期提交。 */
  deleteCanvasNode?: DesignAdapter['deleteCanvasNode']
  /** 回收区只在用户打开时按需读取。 */
  listCanvasTrash?: DesignAdapter['listCanvasTrash']
  /** 内容节点恢复由主进程返回权威 snapshot。 */
  restoreCanvasNode?: DesignAdapter['restoreCanvasNode']
  /** 坏节点重建能力仅在完整 Adapter 接通时可用。 */
  rebuildCanvasAgentNode?: DesignAdapter['rebuildCanvasAgentNode']
  /** Canvas Agent 对话三入口需同时存在才渲染面板。 */
  getCanvasAgentMessages?: DesignAdapter['getCanvasAgentMessages']
  sendCanvasAgentMessage?: DesignAdapter['sendCanvasAgentMessage']
  stopCanvasAgent?: DesignAdapter['stopCanvasAgent']
  /** 图片模块完整能力只在展开图片节点时按需组合。 */
  loadCanvasImageModule?: DesignAdapter['loadCanvasImageModule']
  saveCanvasImageModule?: DesignAdapter['saveCanvasImageModule']
  createCanvasImageJob?: DesignAdapter['createCanvasImageJob']
  cancelCanvasImageJob?: DesignAdapter['cancelCanvasImageJob']
  retryCanvasImageJob?: DesignAdapter['retryCanvasImageJob']
  adoptCanvasImageAsset?: DesignAdapter['adoptCanvasImageAsset']
  releaseCanvasImageMedia?: DesignAdapter['releaseCanvasImageMedia']
  onCanvasImageModuleChanged?: DesignAdapter['onCanvasImageModuleChanged']
  getTaskDetails?: DesignAdapter['getTaskDetails']
  getTaskTrace?: DesignAdapter['getTaskTrace']
  /** Canvas 工作台复用项目模型目录，但模型选择仍写入图片模块草稿。 */
  getImageModelSelection?: DesignAdapter['getImageModelSelection']
  setImageModelSelection?: DesignAdapter['setImageModelSelection']
  onImageModelProfilesChanged?: DesignAdapter['onImageModelProfilesChanged']
  onImageModelSelectionChanged?: DesignAdapter['onImageModelSelectionChanged']
}

/** 添加 Agent 按钮的局部异步状态。 */
export interface CanvasAgentNodeCommandState {
  loading: boolean
  error: string | null
}

/** 空图创建位置换算使用的真实 Canvas surface 尺寸。 */
export interface NativeCanvasSurfaceBounds {
  width: number
  height: number
}

/** 添加 Agent 命令可选的扩展来源。 */
export interface CanvasAgentNodeCommandRequest {
  sourceNodeId?: string
}

/** 通用节点创建命令请求，类型和扩展来源共同定义一次用户意图。 */
export interface CanvasNodeCreateCommandRequest {
  kind: CanvasNodeKind
  sourceNodeId?: string
}

/** 通用节点创建完成事实，保留类型以安全归一主进程结果。 */
export interface CanvasNodeCreateCommandSuccess {
  kind: CanvasNodeKind
  nodeId: string
  result: CanvasAgentNodeCreationResult | CanvasNodeLifecycleResult
}

/** 四类节点共享的创建控制器依赖。 */
export interface CanvasNodeCreateCommandDependencies {
  target: CanvasTarget
  createAgentNode: (input: CreateCanvasAgentNodeInput) => Promise<CanvasAgentNodeCreationResult>
  createContentNode: (input: CreateCanvasContentNodeInput) => Promise<CanvasNodeLifecycleResult>
  createId: () => string
  getDocument: () => CanvasDocument
  getPosition: (sourceNodeId?: string) => DesignPoint
  onStateChange: (state: CanvasAgentNodeCommandState) => void
  onSuccess: (success: CanvasNodeCreateCommandSuccess) => void
}

/** 通用节点创建命令接口。 */
export interface CanvasNodeCreateCommandController {
  execute: (request: CanvasNodeCreateCommandRequest) => Promise<void>
  cancel: () => void
}

/** 添加 Agent 命令的可注入依赖，避免把幂等 operation 混入保存状态机。 */
export interface CanvasAgentNodeCommandDependencies {
  target: CanvasTarget
  createAgentNode: (input: CreateCanvasAgentNodeInput) => Promise<CanvasAgentNodeCreationResult>
  createId: () => string
  getPosition: (sourceNodeId?: string) => DesignPoint
  onStateChange: (state: CanvasAgentNodeCommandState) => void
  onSuccess: (nodeId: string, result: CanvasAgentNodeCreationResult) => void
}

/** 单次用户创建 operation 的命令接口。 */
export interface CanvasAgentNodeCommandController {
  execute: (request?: CanvasAgentNodeCommandRequest) => Promise<void>
  cancel: () => void
}

/** 重建坏 Agent 节点命令的可注入依赖。 */
export interface CanvasAgentNodeRebuildDependencies {
  target: CanvasAgentTarget
  rebuildAgentNode: (input: RebuildCanvasAgentNodeInput) => Promise<RebuildCanvasAgentNodeResult>
  createId: () => string
  onStateChange: (state: CanvasAgentNodeCommandState) => void
  onSuccess: (result: RebuildCanvasAgentNodeResult) => void
}

/** 单个坏节点重建 operation 的命令接口。 */
export interface CanvasAgentNodeRebuildController {
  execute: () => Promise<void>
  cancel: () => void
}

/** 运行节点停止完成前保留的删除身份与 Canvas 代次。 */
export interface PendingCanvasStopDelete {
  /** 每次 STOP attempt 独立递增的 Renderer 请求代次。 */
  requestGeneration: number
  canvasKey: string
  nodeId: string
  sessionId: string
  /** 发起 STOP 时 authoritative-first 捕获的明确运行代次。 */
  startedAt: number
  stopAccepted: boolean
}

/** STOP 删除观察到的当前运行代次状态。 */
export type PendingCanvasStopDeleteGenerationStatus = 'active' | 'ended' | 'replaced' | 'unknown'

/** 确认保存或放弃后，把待切换目标提升为唯一展开工作台。 */
export function createResolvedNativeCanvasWorkbenchSwitchUpdate(
  current: NativeCanvasState,
): Pick<NativeCanvasState, 'expandedNodeId' | 'pendingWorkbenchSwitchNodeId' | 'workbenchDraft'> {
  return {
    expandedNodeId: current.pendingWorkbenchSwitchNodeId === NATIVE_CANVAS_WORKBENCH_CLOSE_TARGET
      ? null
      : current.pendingWorkbenchSwitchNodeId,
    pendingWorkbenchSwitchNodeId: null,
    workbenchDraft: null,
  }
}

/** 关闭当前工作台时只清理临时态，保留普通节点选区。 */
export function createClosedNativeCanvasWorkbenchUpdate(): Pick<
  NativeCanvasState,
  'expandedNodeId' | 'pendingWorkbenchSwitchNodeId' | 'workbenchDraft'
> {
  return {
    expandedNodeId: null,
    pendingWorkbenchSwitchNodeId: null,
    workbenchDraft: null,
  }
}

/**
 * 请求关闭工作台；dirty 时登记内部关闭目标并复用保存、放弃、取消确认。
 * @param current 当前 Canvas 临时状态。
 * @returns 立即关闭或等待确认的局部状态更新。
 */
export function createNativeCanvasWorkbenchCloseRequestUpdate(
  current: NativeCanvasState,
): Partial<NativeCanvasState> {
  if (current.expandedNodeId
    && current.workbenchDraft?.nodeId === current.expandedNodeId
    && current.workbenchDraft.dirty) {
    return { pendingWorkbenchSwitchNodeId: NATIVE_CANVAS_WORKBENCH_CLOSE_TARGET }
  }
  return createClosedNativeCanvasWorkbenchUpdate()
}

/** 工作台卸载清理协调器使用的微任务调度入口。 */
export type NativeCanvasWorkbenchCleanupScheduler = (task: () => void) => void

/** 按 stateKey 隔离 StrictMode 演练与真实卸载的协调接口。 */
export interface NativeCanvasWorkbenchCleanupCoordinator {
  mount: (stateKey: string, clearWorkbench: () => void) => () => void
}

/** 单个 stateKey 当前活跃挂载与待清理代次。 */
interface NativeCanvasWorkbenchCleanupEntry {
  activeMountIds: Set<number>
  pendingCleanupId: number | null
}

/**
 * 创建按 stateKey 隔离的延迟卸载协调器。
 * @param scheduleMicrotask 将候选清理排到当前 React effect 序列之后。
 * @returns setup 可取消同 key 待清理、真实最后卸载才执行的协调器。
 */
export function createNativeCanvasWorkbenchCleanupCoordinator(
  scheduleMicrotask: NativeCanvasWorkbenchCleanupScheduler,
): NativeCanvasWorkbenchCleanupCoordinator {
  /** 每个 Canvas 独立保存挂载集合，避免不同 workspace 相互取消。 */
  const entries = new Map<string, NativeCanvasWorkbenchCleanupEntry>()
  let nextIdentity = 1
  return {
    mount: (stateKey, clearWorkbench) => {
      const entry = entries.get(stateKey) ?? {
        activeMountIds: new Set<number>(),
        pendingCleanupId: null,
      }
      entries.set(stateKey, entry)
      /** 同 key 在微任务前重挂表示 StrictMode 演练或即时恢复，取消旧候选。 */
      entry.pendingCleanupId = null
      const mountId = nextIdentity
      nextIdentity += 1
      entry.activeMountIds.add(mountId)
      let disposed = false
      return () => {
        if (disposed) return
        disposed = true
        entry.activeMountIds.delete(mountId)
        if (entry.activeMountIds.size > 0) return
        const cleanupId = nextIdentity
        nextIdentity += 1
        entry.pendingCleanupId = cleanupId
        scheduleMicrotask(() => {
          /** 旧代次、已重挂或已被替换的 entry 都没有清理资格。 */
          if (entries.get(stateKey) !== entry
            || entry.pendingCleanupId !== cleanupId
            || entry.activeMountIds.size > 0) return
          entries.delete(stateKey)
          entry.pendingCleanupId = null
          clearWorkbench()
        })
      }
    },
  }
}

/** Renderer 生命周期共享协调器，同 key StrictMode 重挂可取消前一轮候选清理。 */
const nativeCanvasWorkbenchCleanupCoordinator = createNativeCanvasWorkbenchCleanupCoordinator(
  (task) => { void Promise.resolve().then(task) },
)

/**
 * 计算独立 Agent 节点创建位置。
 * @param document 当前权威 Canvas 文档。
 * @param surfaceBounds 当前真实 Canvas surface 尺寸。
 * @returns 新节点左上角世界坐标。
 */
export function findNativeCanvasAgentNodeCreationPosition(
  document: CanvasDocument,
  surfaceBounds: NativeCanvasSurfaceBounds,
): DesignPoint {
  /** 只有空图才把真实 surface 中心换算为世界坐标。 */
  const emptyCanvasCenter = {
    x: (surfaceBounds.width / 2 - document.viewport.x) / document.viewport.zoom,
    y: (surfaceBounds.height / 2 - document.viewport.y) / document.viewport.zoom,
  }
  /** 空图仍以画布中心创建，避免初始节点贴近边缘。 */
  if (document.nodes.length === 0) {
    return findNativeCanvasGlobalAppendPosition(emptyCanvasCenter, document.nodes)
  }
  /** 优先保留既有全局横向追加语义。 */
  const globalAppendPosition = findNativeCanvasGlobalAppendPosition(emptyCanvasCenter, document.nodes)
  /** 当前可视世界坐标保留一格边距，避免新节点贴住画布边缘。 */
  const visibleBounds = {
    left: (NATIVE_CANVAS_NODE_GAP - document.viewport.x) / document.viewport.zoom,
    top: (NATIVE_CANVAS_NODE_GAP - document.viewport.y) / document.viewport.zoom,
    right: (surfaceBounds.width - NATIVE_CANVAS_NODE_GAP - document.viewport.x) / document.viewport.zoom,
    bottom: (surfaceBounds.height - NATIVE_CANVAS_NODE_GAP - document.viewport.y) / document.viewport.zoom,
  }
  /** 全局追加点完整可见时不改变原有排列。 */
  const globalAppendVisible = globalAppendPosition.x >= visibleBounds.left
    && globalAppendPosition.y >= visibleBounds.top
    && globalAppendPosition.x + NATIVE_CANVAS_NODE_WIDTH <= visibleBounds.right
    && globalAppendPosition.y + NATIVE_CANVAS_NODE_HEIGHT <= visibleBounds.bottom
  if (globalAppendVisible) return globalAppendPosition

  /** 只用当前可视节点确定网格起点，用户平移到空白区域时从视口左上开始。 */
  const visibleNodes = document.nodes.filter((node) => (
    node.position.x + NATIVE_CANVAS_NODE_WIDTH >= visibleBounds.left
    && node.position.x <= visibleBounds.right
    && node.position.y + NATIVE_CANVAS_NODE_HEIGHT >= visibleBounds.top
    && node.position.y <= visibleBounds.bottom
  ))
  /** 横向起点沿用可视节点最左列，保持已有卡片对齐。 */
  const anchorX = visibleNodes.length > 0
    ? Math.max(visibleBounds.left, Math.min(...visibleNodes.map((node) => node.position.x)))
    : visibleBounds.left
  /** 纵向起点沿用可视节点首行，新增节点自然换到下一行。 */
  const anchorY = visibleNodes.length > 0
    ? Math.max(visibleBounds.top, Math.min(...visibleNodes.map((node) => node.position.y)))
    : visibleBounds.top
  /** 可视区最多容纳的固定宽度列数。 */
  const columnCount = Math.max(0, Math.floor(
    (visibleBounds.right - anchorX + NATIVE_CANVAS_NODE_GAP)
    / (NATIVE_CANVAS_NODE_WIDTH + NATIVE_CANVAS_NODE_GAP),
  ))
  /** 可视区最多容纳的固定高度行数。 */
  const rowCount = Math.max(0, Math.floor(
    (visibleBounds.bottom - anchorY + NATIVE_CANVAS_NODE_GAP)
    / (NATIVE_CANVAS_NODE_HEIGHT + NATIVE_CANVAS_NODE_GAP),
  ))
  for (let row = 0; row < rowCount; row += 1) {
    for (let column = 0; column < columnCount; column += 1) {
      /** 候选按从左到右、从上到下排列，已有节点位置始终不变。 */
      const candidate = {
        x: anchorX + column * (NATIVE_CANVAS_NODE_WIDTH + NATIVE_CANVAS_NODE_GAP),
        y: anchorY + row * (NATIVE_CANVAS_NODE_HEIGHT + NATIVE_CANVAS_NODE_GAP),
      }
      if (!overlapsNativeCanvasNodes(candidate, document.nodes)) return candidate
    }
  }
  /** 可视区确实无空位时退回确定性的全局追加，避免创建被阻断。 */
  return globalAppendPosition
}

/**
 * 创建 Agent 节点成功后的局部状态更新。
 * @param current 创建完成时的当前 Canvas 状态。
 * @param nodeId 主进程已创建的节点 ID。
 * @param result 主进程返回的权威创建结果。
 * @returns 只接管权威文档、选区与错误的局部更新。
 */
export function createNativeCanvasAgentNodeSuccessUpdate(
  current: NativeCanvasState,
  nodeId: string,
  result: CanvasAgentNodeCreationResult,
): Partial<NativeCanvasState> {
  /** 普通 graph 可能先于创建回调接管更高 revision，迟到结果不得倒退文档。 */
  const currentDocument = current.snapshot?.document
  if (currentDocument && currentDocument.revision > result.document.revision) {
    /** 只有更高 revision 已包含新节点时才允许把选区切到该节点。 */
    const containsCreatedNode = currentDocument.nodes.some((node) => node.id === nodeId)
    return {
      selectedNodeId: containsCreatedNode ? nodeId : current.selectedNodeId,
      error: null,
    }
  }
  /** 创建请求在途期间已经投影的位置变更按真实发生顺序重新收集。 */
  const positionMutations = [
    ...current.inFlightMutations,
    ...current.pendingMutations,
  ].filter((mutation) => (
    isNativeCanvasPositionMutation(mutation)
    && canReplayNativeCanvasPositionMutations(result.document, [mutation])
  ))
  /** 只在主进程新权威结构上重放安全位置，不自动应用任何结构 mutation。 */
  const projectedDocument = replayNativeCanvasPositionMutations(result.document, positionMutations)
  return {
    snapshot: current.snapshot
      ? { ...current.snapshot, document: projectedDocument }
      : { document: projectedDocument, writable: true, nodeIssues: [] },
    selectedNodeId: nodeId,
    error: null,
  }
}

/**
 * 将四类创建结果归一为只选中新折叠节点的状态更新。
 * @param current 创建完成时当前 keyed Canvas 状态。
 * @param success 类型化创建结果和预分配节点身份。
 * @returns 只接管权威文档和新节点选区，始终保留请求期间形成的工作台状态。
 */
export function createNativeCanvasNodeCreationSuccessUpdate(
  current: NativeCanvasState,
  success: CanvasNodeCreateCommandSuccess,
): Partial<NativeCanvasState> {
  const resultDocument = 'snapshot' in success.result
    ? success.result.snapshot.document
    : success.result.document
  const agentResult: CanvasAgentNodeCreationResult = 'snapshot' in success.result
    ? { document: resultDocument, session: {} as never }
    : success.result
  const update = createNativeCanvasAgentNodeSuccessUpdate(
    current,
    success.nodeId,
    agentResult,
  )
  /** 更高 revision 已接管时只沿用单调 helper 结果，禁止覆盖当前工作台。 */
  if (current.snapshot && current.snapshot.document.revision > resultDocument.revision) return update
  if (success.kind !== 'agent' && update.snapshot && 'snapshot' in success.result) {
    /** 生命周期旧结果没有刷新预览时沿用当前授权 URL，后续 LOAD 再权威替换。 */
    const imagePreviews = success.result.snapshot.imagePreviews ?? current.snapshot?.imagePreviews
    update.snapshot = {
      ...success.result.snapshot,
      ...(imagePreviews ? { imagePreviews } : {}),
      document: update.snapshot.document,
    }
  }
  return update
}

/**
 * 删除或恢复成功后整体接管主进程权威快照。
 * @param current 生命周期完成时的当前 Renderer 状态。
 * @param result 主进程返回的权威生命周期事实。
 * @param selectedNodeId 恢复时选中新节点，删除时传 null。
 * @returns 清理工作台 dirty、待切换和历史结构 mutation 的状态更新。
 */
export function createNativeCanvasLifecycleSuccessUpdate(
  current: NativeCanvasState,
  result: CanvasNodeLifecycleResult,
  selectedNodeId: string | null,
): Partial<NativeCanvasState> {
  /** 更高 revision 已由事件接管时，迟到生命周期结果不得回退图。 */
  if (current.snapshot && current.snapshot.document.revision > result.snapshot.document.revision) {
    return {}
  }
  return {
    /** 删除或恢复旧结果未携带预览字段时保留当前共享缩略图映射。 */
    snapshot: {
      ...result.snapshot,
      ...(result.snapshot.imagePreviews
        ? {}
        : current.snapshot?.imagePreviews
          ? { imagePreviews: current.snapshot.imagePreviews }
          : {}),
    },
    selectedNodeId,
    conversationNodeId: null,
    expandedNodeId: null,
    pendingWorkbenchSwitchNodeId: null,
    workbenchDraft: null,
    pendingMutations: [],
    inFlightMutations: [],
    saveState: 'saved',
    error: null,
  }
}

/** 批量删除控制器依赖，复用单节点主进程生命周期并串行推进 revision。 */
export interface NativeCanvasBatchDeleteDependencies {
  target: CanvasTarget
  nodeIds: readonly string[]
  initialRevision: number
  deleteNode: (input: DeleteCanvasNodeInput) => Promise<CanvasNodeLifecycleResult>
  createOperationId: () => string
  operationCache?: Map<string, DeleteCanvasNodeInput>
  isActive?: () => boolean
  onDeleted: (
    nodeId: string,
    result: CanvasNodeLifecycleResult,
    remainingNodeIds: readonly string[],
  ) => void
}

/** 批量删除串行结果；失败时已成功节点不会回滚。 */
export interface NativeCanvasBatchDeleteResult {
  deletedNodeIds: string[]
  remainingNodeIds: string[]
  error: unknown | null
}

/**
 * 串行删除一组 Canvas 节点，后一请求始终使用前一权威结果的 revision。
 * @param dependencies 删除目标、生命周期 API、幂等 ID 与成功回调。
 * @returns 已删除、剩余节点和首个失败原因。
 */
export async function deleteNativeCanvasNodesSequentially(
  dependencies: NativeCanvasBatchDeleteDependencies,
): Promise<NativeCanvasBatchDeleteResult> {
  /** 成功节点按提交顺序记录，供部分失败提示使用。 */
  const deletedNodeIds: string[] = []
  /** 调用方可持有缓存，使失败重试复用同一完整幂等请求。 */
  const operationCache = dependencies.operationCache ?? new Map<string, DeleteCanvasNodeInput>()
  /** 下一节点必须基于最近一次主进程权威 revision。 */
  let expectedRevision = dependencies.initialRevision

  for (let index = 0; index < dependencies.nodeIds.length; index += 1) {
    if (dependencies.isActive && !dependencies.isActive()) {
      return {
        deletedNodeIds,
        remainingNodeIds: dependencies.nodeIds.slice(index),
        error: null,
      }
    }
    /** 当前节点身份来自确认时的稳定选区快照。 */
    const nodeId = dependencies.nodeIds[index]
    if (!nodeId) continue
    /** 同一失败节点重试时复用 operationId 和 expectedRevision。 */
    const operation = operationCache.get(nodeId) ?? {
      ...dependencies.target,
      nodeId,
      operationId: dependencies.createOperationId(),
      expectedRevision,
    }
    operationCache.set(nodeId, operation)
    try {
      /** 每一步等待权威快照后才提交下一节点，避免 revision 并发冲突。 */
      const result = await dependencies.deleteNode(operation)
      deletedNodeIds.push(nodeId)
      operationCache.delete(nodeId)
      expectedRevision = result.snapshot.document.revision
      const remainingNodeIds = dependencies.nodeIds.slice(index + 1)
      dependencies.onDeleted(nodeId, result, remainingNodeIds)
    } catch (error: unknown) {
      return {
        deletedNodeIds,
        remainingNodeIds: dependencies.nodeIds.slice(index),
        error,
      }
    }
  }
  return { deletedNodeIds, remainingNodeIds: [], error: null }
}

/**
 * 统计删除节点会同步移除的关联边。
 * @param document 当前权威 Canvas 文档。
 * @param nodeId 待删除节点 ID。
 * @returns 输入或输出命中该节点的边数量。
 */
export function getNativeCanvasConnectedEdgeCount(
  document: CanvasDocument,
  nodeId: string,
): number {
  return document.edges.filter((edge) => (
    edge.sourceNodeId === nodeId || edge.targetNodeId === nodeId
  )).length
}

/**
 * 统计批量删除会移除的去重关联边。
 * @param document 当前权威 Canvas 文档。
 * @param nodeIds 待删除节点集合。
 * @returns 任一端命中选区的边数量，每条边只计算一次。
 */
export function getNativeCanvasBatchConnectedEdgeCount(
  document: CanvasDocument,
  nodeIds: readonly string[],
): number {
  /** Set 避免节点数增加后产生边数乘节点数的重复扫描。 */
  const selectedNodeIdSet = new Set(nodeIds)
  return document.edges.filter((edge) => (
    selectedNodeIdSet.has(edge.sourceNodeId) || selectedNodeIdSet.has(edge.targetNodeId)
  )).length
}

/**
 * 复核停止后删除请求仍属于当前 Canvas 和同一 Agent session。
 * @param pending 待完成的停止后删除身份。
 * @param stateKey 当前 Renderer Canvas 组合键。
 * @param node 当前权威文档中同 ID 节点。
 * @returns Canvas、节点和 session 均未漂移时返回 true。
 */
export function isPendingCanvasStopDeleteCurrent(
  pending: PendingCanvasStopDelete,
  stateKey: string,
  node: CanvasDocument['nodes'][number] | undefined,
  currentStartedAt: number | null | undefined,
): boolean {
  return pending.canvasKey === stateKey
    && node?.kind === 'agent'
    && node.id === pending.nodeId
    && node.agentSessionId === pending.sessionId
    && currentStartedAt === pending.startedAt
}

/** 只复核 Canvas、节点和 session 身份，不把已结束误判为未知 generation。 */
function isPendingCanvasStopDeleteTargetCurrent(
  pending: PendingCanvasStopDelete,
  stateKey: string,
  node: CanvasDocument['nodes'][number] | undefined,
): boolean {
  return pending.canvasKey === stateKey
    && node?.kind === 'agent'
    && node.id === pending.nodeId
    && node.agentSessionId === pending.sessionId
}

/**
 * 按 authoritative 优先合同判断 STOP 捕获代次是否仍活动、结束或已被替换。
 * @param pending 发起停止时捕获的明确代次。
 * @param authoritativeGenerations 当前权威代次 Map；null 表示 busy 但代次未知。
 * @param optimisticGenerations 当前尚未被权威接管的乐观代次 Map。
 * @param runningSessionIds 当前 busy session 集合。
 * @returns 只有 generation Map 明确释放且 busy 消失时返回 ended。
 */
export function getPendingCanvasStopDeleteGenerationStatus(
  pending: PendingCanvasStopDelete,
  authoritativeGenerations: ReadonlyMap<string, number | null>,
  optimisticGenerations: ReadonlyMap<string, number>,
  runningSessionIds: ReadonlySet<string>,
): PendingCanvasStopDeleteGenerationStatus {
  if (authoritativeGenerations.has(pending.sessionId)) {
    const current = authoritativeGenerations.get(pending.sessionId)
    if (current === null || current === undefined) return 'unknown'
    return current === pending.startedAt ? 'active' : 'replaced'
  }
  if (optimisticGenerations.has(pending.sessionId)) {
    return optimisticGenerations.get(pending.sessionId) === pending.startedAt
      ? 'active'
      : 'replaced'
  }
  return runningSessionIds.has(pending.sessionId) ? 'unknown' : 'ended'
}

/**
 * 仅允许同一 STOP 代次把待删除状态标记为已接受。
 * @param current 当前可能已被新运行接管的待删除状态。
 * @param requested 发起本次 STOP Promise 时捕获的状态。
 * @returns 身份和 startedAt 全匹配时返回已接受状态，否则保持当前状态。
 */
export function createStopAcceptedPendingCanvasDelete(
  current: PendingCanvasStopDelete | null,
  requested: PendingCanvasStopDelete,
): PendingCanvasStopDelete | null {
  if (!current
    || current.requestGeneration !== requested.requestGeneration
    || current.canvasKey !== requested.canvasKey
    || current.nodeId !== requested.nodeId
    || current.sessionId !== requested.sessionId
    || current.startedAt !== requested.startedAt) return current
  return { ...current, stopAccepted: true }
}

/** STOP Promise settle 前读取的同步身份与副作用边界。 */
export interface NativeCanvasStopDeleteAttemptDependencies {
  getCurrentRequestGeneration: () => number
  getPending: () => PendingCanvasStopDelete | null
  onAccepted: () => void
  onRejected: (error: unknown) => void
}

/** 判断 STOP 回调是否仍属于当前 token 和完整 pending 身份。 */
function isNativeCanvasStopDeleteAttemptCurrent(
  requested: PendingCanvasStopDelete,
  dependencies: NativeCanvasStopDeleteAttemptDependencies,
): boolean {
  if (dependencies.getCurrentRequestGeneration() !== requested.requestGeneration) return false
  const current = dependencies.getPending()
  return current?.requestGeneration === requested.requestGeneration
    && current.canvasKey === requested.canvasKey
    && current.nodeId === requested.nodeId
    && current.sessionId === requested.sessionId
    && current.startedAt === requested.startedAt
}

/**
 * 等待单次 STOP，并在任何 UI 副作用前复核 token 与完整业务身份。
 * @param requested 发起 STOP 时固化的 pending 身份。
 * @param stopPromise 当前 STOP 请求 Promise。
 * @param dependencies 同步身份读取与当前 attempt 专属副作用。
 * @returns Promise settle 后完成，不传播已由 UI 收口的失败。
 */
export async function settleNativeCanvasStopDeleteAttempt(
  requested: PendingCanvasStopDelete,
  stopPromise: Promise<void>,
  dependencies: NativeCanvasStopDeleteAttemptDependencies,
): Promise<void> {
  try {
    await stopPromise
    if (!isNativeCanvasStopDeleteAttemptCurrent(requested, dependencies)) return
    dependencies.onAccepted()
  } catch (error) {
    if (!isNativeCanvasStopDeleteAttemptCurrent(requested, dependencies)) return
    dependencies.onRejected(error)
  }
}

/** 捕获当前 authoritative-first 明确运行代次；未知或缺失统一返回 null。 */
function getCurrentCanvasAgentRunGeneration(
  sessionId: string,
  authoritativeGenerations: ReadonlyMap<string, number | null>,
  optimisticGenerations: ReadonlyMap<string, number>,
): number | null {
  if (authoritativeGenerations.has(sessionId)) {
    return authoritativeGenerations.get(sessionId) ?? null
  }
  return optimisticGenerations.get(sessionId) ?? null
}

/**
 * 生成重建成功后的完整状态更新。
 * @param result 主进程返回的权威重建结果。
 * @param nodeId 已重建的节点 ID。
 * @returns 整体接管 snapshot 并保持目标节点打开的状态更新。
 */
export function createRebuiltNativeCanvasStateUpdate(
  result: RebuildCanvasAgentNodeResult,
  nodeId: string,
): Partial<NativeCanvasState> {
  return {
    snapshot: result.snapshot,
    selectedNodeId: nodeId,
    expandedNodeId: nodeId,
    error: null,
  }
}

/** 非 Agent 类型到固定新节点标题的稳定映射。 */
const NATIVE_CANVAS_CONTENT_NODE_TITLES: Record<Exclude<CanvasNodeKind, 'agent'>, string> = {
  image: '新生图',
  document: '新文档',
  webview: '新原型',
}

/** 判断两次创建请求是否属于同一可重试用户操作。 */
function isSameCanvasNodeCreateRequest(
  left: CanvasNodeCreateCommandRequest | null,
  right: CanvasNodeCreateCommandRequest,
): boolean {
  return left?.kind === right.kind && left.sourceNodeId === right.sourceNodeId
}

/**
 * 创建四类节点共享的幂等命令控制器。
 * @param dependencies 两类主进程 API、权威文档读取和状态回调。
 * @returns 同一 kind 与 sourceNodeId 失败重试时完整复用请求的控制器。
 */
export function createCanvasNodeCommandController(
  dependencies: CanvasNodeCreateCommandDependencies,
): CanvasNodeCreateCommandController {
  /** 当前失败可重试的精确用户意图。 */
  let operationRequest: CanvasNodeCreateCommandRequest | null = null
  /** 已生成的完整主进程请求，失败后必须原样复用。 */
  let operation: CreateCanvasAgentNodeInput | CreateCanvasContentNodeInput | null = null
  /** 当前唯一在途 Promise，避免连点产生重复 operation。 */
  let inFlight: Promise<void> | null = null
  /** Canvas 生命周期代次隔离切换后的迟到结果。 */
  let generation = 0
  let disposed = false

  return {
    execute: (request) => {
      if (disposed) return Promise.reject(new Error('Canvas 节点创建命令已取消'))
      if (inFlight) return inFlight
      if (!operation || !isSameCanvasNodeCreateRequest(operationRequest, request)) {
        const operationId = dependencies.createId()
        const nodeId = dependencies.createId()
        const position = dependencies.getPosition(request.sourceNodeId)
        operationRequest = { ...request }
        if (request.kind === 'agent') {
          const relationship = request.sourceNodeId
            ? { sourceNodeId: request.sourceNodeId, edgeId: dependencies.createId() }
            : undefined
          operation = {
              ...dependencies.target,
              operationId,
              nodeId,
              title: '新 Agent',
              position,
              ...(relationship ? { relationship } : {}),
            }
        } else {
          /** 内容身份先于可选边身份分配，完整请求在失败重试时保持不变。 */
          const contentId = dependencies.createId()
          const relationship = request.sourceNodeId
            ? { sourceNodeId: request.sourceNodeId, edgeId: dependencies.createId() }
            : undefined
          operation = {
              ...dependencies.target,
              operationId,
              nodeId,
              kind: request.kind,
              contentId,
              title: NATIVE_CANVAS_CONTENT_NODE_TITLES[request.kind],
              position,
              expectedRevision: dependencies.getDocument().revision,
              ...(relationship ? { relationship } : {}),
            }
        }
      }
      const command = operation
      /** operation 与 request 在同一同步分支中共同生成，此处固定捕获已确认类型。 */
      const commandKind = operationRequest!.kind
      const requestGeneration = generation
      dependencies.onStateChange({ loading: true, error: null })
      const createPromise = commandKind === 'agent'
        ? dependencies.createAgentNode(command as CreateCanvasAgentNodeInput)
        : dependencies.createContentNode(command as CreateCanvasContentNodeInput)
      const requestPromise = createPromise.then((result) => {
        if (disposed || generation !== requestGeneration) return
        dependencies.onSuccess({ kind: commandKind, nodeId: command.nodeId, result })
        operation = null
        operationRequest = null
        dependencies.onStateChange({ loading: false, error: null })
      }).catch((error: unknown) => {
        if (!disposed && generation === requestGeneration) {
          dependencies.onStateChange({
            loading: false,
            error: getNativeCanvasOperationErrorMessage('create', error),
          })
        }
        throw error
      }).finally(() => {
        if (inFlight === requestPromise) inFlight = null
      })
      inFlight = requestPromise
      return requestPromise
    },
    cancel: () => {
      disposed = true
      generation += 1
      operation = null
      operationRequest = null
      dependencies.onStateChange({ loading: false, error: null })
    },
  }
}

/**
 * 创建保留失败 operationId 的 Agent 节点命令控制器。
 * @param dependencies 主进程创建 API、ID、位置和状态回调。
 * @returns 防重复执行、支持显式重试与取消的命令。
 */
export function createCanvasAgentNodeCommandController(
  dependencies: CanvasAgentNodeCommandDependencies,
): CanvasAgentNodeCommandController {
  /** 兼容既有 Agent 单类型测试和调用者，实际状态机只保留统一实现。 */
  const controller = createCanvasNodeCommandController({
    target: dependencies.target,
    createAgentNode: dependencies.createAgentNode,
    createContentNode: async () => {
      throw new Error('Agent 创建控制器不支持内容节点')
    },
    createId: dependencies.createId,
    getDocument: () => {
      throw new Error('Agent 创建不需要读取文档 revision')
    },
    getPosition: dependencies.getPosition,
    onStateChange: dependencies.onStateChange,
    onSuccess: ({ nodeId, result }) => {
      if ('snapshot' in result) return
      dependencies.onSuccess(nodeId, result)
    },
  })
  return {
    execute: (request = {}) => controller.execute({ kind: 'agent', ...request }),
    cancel: controller.cancel,
  }
}

/** 创建保留失败 operationId 的坏节点重建控制器。 */
export function createCanvasAgentNodeRebuildController(
  dependencies: CanvasAgentNodeRebuildDependencies,
): CanvasAgentNodeRebuildController {
  /** 首次重建生成并在失败重试时复用的完整请求。 */
  let operation: RebuildCanvasAgentNodeInput | null = null
  /** 单节点只允许一个重建请求在途。 */
  let inFlight: Promise<void> | null = null
  /** lifecycle 代次隔离切换 Canvas 后的迟到结果。 */
  let generation = 0
  /** cleanup 后控制器永久失效。 */
  let disposed = false

  return {
    execute: () => {
      if (disposed) return Promise.reject(new Error('Canvas Agent 重建命令已取消'))
      if (inFlight) return inFlight
      if (!operation) {
        operation = { ...dependencies.target, operationId: dependencies.createId() }
      }
      /** 本轮请求固定捕获 operation 和代次。 */
      const request = operation
      const requestGeneration = generation
      dependencies.onStateChange({ loading: true, error: null })
      const requestPromise = dependencies.rebuildAgentNode(request).then((result) => {
        if (disposed || generation !== requestGeneration) return
        dependencies.onSuccess(result)
        operation = null
        dependencies.onStateChange({ loading: false, error: null })
      }).catch((error: unknown) => {
        if (!disposed && generation === requestGeneration) {
          dependencies.onStateChange({
            loading: false,
            error: getNativeCanvasOperationErrorMessage('rebuild', error),
          })
        }
        throw error
      }).finally(() => {
        if (inFlight === requestPromise) inFlight = null
      })
      inFlight = requestPromise
      return requestPromise
    },
    cancel: () => {
      if (disposed) return
      disposed = true
      generation += 1
      operation = null
      dependencies.onStateChange({ loading: false, error: null })
    },
  }
}

/** 可注入的尾触发调度器。 */
export interface NativeCanvasScheduler {
  setTimeout: (callback: () => void, delayMs: number) => number
  clearTimeout: (timerId: number) => void
}

/** 图片草稿尾触发自动保存控制器。 */
export interface CanvasImageDraftAutoSaveController {
  /** 根据最新草稿与保存状态重排一次自动保存。 */
  schedule: (
    draft: CanvasImageModuleDraft | null,
    saveState: CanvasImageModuleSaveState,
    enabled?: boolean,
  ) => void
  /** 真实卸载时取消定时器并隔离迟到回调。 */
  dispose: () => void
}

/** 图片草稿自动保存控制器依赖。 */
export interface CanvasImageDraftAutoSaveDependencies {
  scheduler: NativeCanvasScheduler
  commitDraft: () => Promise<CanvasImageModuleConfig | null>
}

/** 将可编辑字段序列化为稳定签名，用于区分新编辑与同内容失败重试。 */
function createCanvasImageDraftSignature(draft: CanvasImageModuleDraft): string {
  return JSON.stringify([
    draft.prompt,
    draft.selectedModelProfileId,
    draft.aspectRatio,
    draft.imageSize,
    draft.contextMode,
  ])
}

/**
 * 创建图片草稿尾触发自动保存控制器。
 * @param dependencies 调度器和当前图片模块提交命令。
 * @returns 连续输入合并、保存串行且卸载安全的控制器。
 */
export function createCanvasImageDraftAutoSaveController(
  dependencies: CanvasImageDraftAutoSaveDependencies,
): CanvasImageDraftAutoSaveController {
  let timerId: number | null = null
  let disposed = false
  let inFlight = false
  let latestDraft: CanvasImageModuleDraft | null = null
  let latestSaveState: CanvasImageModuleSaveState = 'saved'
  let enabled = true
  let lastAttemptedSignature: string | null = null

  /** 清理尚未触发的保存，不影响已经进入主进程的请求。 */
  const clearTimer = (): void => {
    if (timerId === null) return
    dependencies.scheduler.clearTimeout(timerId)
    timerId = null
  }

  /** 使用最新状态安排一次保存；同内容失败不会形成无限重试。 */
  const scheduleLatest = (): void => {
    clearTimer()
    if (disposed || !enabled || inFlight || !latestDraft?.dirty
      || latestSaveState === 'saving' || latestSaveState === 'conflict') return
    const signature = createCanvasImageDraftSignature(latestDraft)
    if (latestSaveState === 'failed' && signature === lastAttemptedSignature) return
    timerId = dependencies.scheduler.setTimeout(() => {
      timerId = null
      if (disposed || !enabled || inFlight) return
      inFlight = true
      lastAttemptedSignature = signature
      void dependencies.commitDraft().catch(() => undefined).finally(() => {
        inFlight = false
        if (!disposed && latestDraft?.dirty
          && createCanvasImageDraftSignature(latestDraft) !== lastAttemptedSignature) {
          scheduleLatest()
        }
      })
    }, NATIVE_CANVAS_IMAGE_SAVE_DEBOUNCE_MS)
  }

  return {
    schedule: (draft, saveState, nextEnabled = true) => {
      latestDraft = draft
      latestSaveState = saveState
      enabled = nextEnabled
      if (!draft?.dirty) lastAttemptedSignature = null
      scheduleLatest()
    },
    dispose: () => {
      if (disposed) return
      disposed = true
      clearTimer()
      latestDraft = null
    },
  }
}

/** controller 状态更新既支持局部值也支持基于最新状态计算。 */
export type NativeCanvasStateUpdate = Partial<NativeCanvasState>
  | ((current: NativeCanvasState) => Partial<NativeCanvasState>)

/** 无 React controller 的依赖。 */
export interface NativeCanvasWorkspaceControllerDependencies {
  target: CanvasTarget
  adapter: NativeCanvasAdapter
  getState: () => NativeCanvasState
  updateState: (update: NativeCanvasStateUpdate) => void
  scheduler: NativeCanvasScheduler
}

/** 原生 Canvas 工作区生命周期与 mutation 入口。 */
export interface NativeCanvasWorkspaceController {
  start: () => void
  sync: () => void
  enqueueMutation: (mutation: CanvasMutation) => void
  retryLoad: () => void
  retrySave: () => void
  retryRecovery: () => void
  acceptRemoteVersion: () => void
  dispose: () => void
}

/** 当前 controller 持有的单个在途保存批次。 */
interface ActiveNativeCanvasSave {
  generation: number
  batch: CanvasMutation[]
}

/** Workspace 各操作遇到未知异常时使用的固定公开文案。 */
const NATIVE_CANVAS_OPERATION_ERROR_MESSAGES = {
  load: '画布暂时无法加载。',
  save: '画布暂时无法保存。',
  create: '节点创建失败，请重试。',
  delete: '节点删除失败，请重试。',
  rebuild: '重建失败，请重试。',
  stop: '停止失败，节点未删除。',
} as const

/** Workspace 可显示错误对应的操作类型。 */
type NativeCanvasOperation = keyof typeof NATIVE_CANVAS_OPERATION_ERROR_MESSAGES

/**
 * 将未知异常转换为稳定用户文本。
 * @param operation 当前 Canvas 操作。
 * @param error Adapter 或运行时抛出的未知异常。
 * @returns 公开错误文案或当前操作的固定回退。
 */
function getNativeCanvasOperationErrorMessage(
  operation: NativeCanvasOperation,
  error: unknown,
): string {
  return error instanceof CanvasPublicOperationError
    ? error.message
    : NATIVE_CANVAS_OPERATION_ERROR_MESSAGES[operation]
}

/** 从主进程稳定消息前缀识别需要权威 LOAD 的 SAVE 错误。 */
function isNativeCanvasAuthoritativeSaveError(error: unknown): boolean {
  if (error instanceof CanvasPublicOperationError) {
    return error.code === 'CANVAS_REVISION_CONFLICT'
  }
  /** 非 Error 值没有稳定前缀，继续沿用普通失败路径。 */
  if (!(error instanceof Error)) return false
  return [
    NATIVE_CANVAS_RECOVERY_REQUIRED_CODE,
    NATIVE_CANVAS_REVISION_CONFLICT_CODE,
    NATIVE_CANVAS_COMMIT_UNCERTAIN_CODE,
  ].some((code) => error.message.includes(code))
}

/** 创建无 React 依赖、绑定固定双身份的原生 Canvas controller。 */
export function createNativeCanvasWorkspaceController(
  dependencies: NativeCanvasWorkspaceControllerDependencies,
): NativeCanvasWorkspaceController {
  /** 普通图刷新 LOAD 代次，不允许取消权威恢复。 */
  let ordinaryLoadGeneration = 0
  /** 权威恢复 LOAD 独立代次，不受普通 graph 事件影响。 */
  let recoveryLoadGeneration = 0
  let saveGeneration = 0
  /** 当前远端变化订阅释放函数。 */
  let unsubscribe: (() => void) | null = null
  /** 尚未触发的 trailing save 任务。 */
  let saveTimerId: number | null = null
  /** 已从共享状态移出的在途 mutation 所有权。 */
  let activeSave: ActiveNativeCanvasSave | null = null
  /** controller 卸载后所有迟到回调均无副作用。 */
  let disposed = false
  /** 当前 controller 是否有权威恢复 LOAD 在途。 */
  let authoritativeRecoveryInFlight = false

  /** 清除尚未触发的保存任务。 */
  const clearSaveTimer = (): void => {
    if (saveTimerId === null) return
    dependencies.scheduler.clearTimeout(saveTimerId)
    saveTimerId = null
  }

  /** 判断当前状态是否允许自动保存。 */
  const canSave = (state: NativeCanvasState): boolean => Boolean(
    state.snapshot
    && state.pendingMutations.length > 0
    && state.inFlightMutations.length === 0
    && state.saveState !== 'saving'
    && state.saveState !== 'failed'
    && state.saveState !== 'conflict'
    && state.authoritativeRecoveryState === 'idle'
    && activeSave === null,
  )

  /** 把在途 batch 同步归还 pending 队列头部并清除所有权。 */
  const restoreActiveSave = (): void => {
    const interrupted = activeSave
    if (!interrupted) return
    activeSave = null
    dependencies.updateState((latest) => ({
      pendingMutations: [...interrupted.batch, ...latest.pendingMutations],
      inFlightMutations: [],
      saveState: 'dirty',
    }))
  }

  /** 统一阻断旧 SAVE/普通 LOAD，并把在途 mutation 归还给当前权威切换。 */
  const fenceAuthoritativeSnapshot = (): void => {
    clearSaveTimer()
    restoreActiveSave()
    saveGeneration += 1
    ordinaryLoadGeneration += 1
  }

  /** 权威恢复成功后按位置/结构边界接管新快照。 */
  const applyAuthoritativeSnapshot = (snapshot: CanvasWorkspaceSnapshot): void => {
    const latest = dependencies.getState()
    const pending = latest.pendingMutations
    if (!canReplayNativeCanvasPositionMutations(snapshot.document, pending)) {
      dependencies.updateState({
        phase: 'ready',
        snapshot,
        inFlightMutations: [],
        saveState: 'conflict',
        selectedNodeId: null,
        conversationNodeId: null,
        expandedNodeId: null,
        pendingWorkbenchSwitchNodeId: null,
        workbenchDraft: null,
        authoritativeRecoveryState: 'idle',
        error: NATIVE_CANVAS_STRUCTURAL_CONFLICT_MESSAGE,
      })
      return
    }
    /** 位置类 mutation 可安全重放到任意恢复 revision 的权威结构上。 */
    const document = replayNativeCanvasPositionMutations(snapshot.document, pending)
    dependencies.updateState({
      phase: 'ready',
      snapshot: { ...snapshot, document },
      inFlightMutations: [],
      saveState: pending.length > 0 ? 'dirty' : 'saved',
      selectedNodeId: null,
      conversationNodeId: null,
      expandedNodeId: null,
      pendingWorkbenchSwitchNodeId: null,
      workbenchDraft: null,
      authoritativeRecoveryState: 'idle',
      error: null,
    })
    scheduleSave()
  }

  /** 合并 recovery 期间观察到的最高普通 graph revision。 */
  const deferGraphRefresh = (revision: number): void => {
    dependencies.updateState((latest) => ({
      deferredGraphRevision: Math.max(latest.deferredGraphRevision ?? revision, revision),
    }))
  }

  /** recovery 成功后消费最高目标，并最多发起一次普通图对账。 */
  const flushDeferredGraphRefresh = (recoveredRevision: number): void => {
    if (disposed) return
    const targetRevision = dependencies.getState().deferredGraphRevision
    if (targetRevision === null) return
    dependencies.updateState({ deferredGraphRevision: null })
    if (targetRevision > recoveredRevision) loadSnapshot(false)
  }

  /** 发起普通或权威 LOAD；两类请求只失效各自旧回调。 */
  const loadSnapshot = (authoritative: boolean): void => {
    if (disposed) return
    const generation = authoritative
      ? recoveryLoadGeneration + 1
      : ordinaryLoadGeneration + 1
    if (authoritative) {
      recoveryLoadGeneration = generation
      authoritativeRecoveryInFlight = true
      /** recovery 开始时旧普通结果已失去基线资格。 */
      ordinaryLoadGeneration += 1
    } else {
      ordinaryLoadGeneration = generation
    }
    /** 判断本次请求是否仍持有对应 LOAD 类别的最新代次。 */
    const isCurrentRequest = (): boolean => authoritative
      ? generation === recoveryLoadGeneration
      : generation === ordinaryLoadGeneration
    if (!authoritative && !dependencies.getState().snapshot) {
      dependencies.updateState({ phase: 'loading', error: null })
    }
    void dependencies.adapter.loadCanvas(dependencies.target).then((snapshot) => {
      if (disposed || !isCurrentRequest()) return
      if (authoritative || snapshot.recoveredFrom) {
        if (authoritative) authoritativeRecoveryInFlight = false
        /** 普通 LOAD 也可能在磁盘提升后返回恢复快照，必须执行完整 SAVE fence。 */
        if (!authoritative) fenceAuthoritativeSnapshot()
        applyAuthoritativeSnapshot(snapshot)
        flushDeferredGraphRefresh(snapshot.document.revision)
        return
      }
      /** 普通图刷新保留本窗口尚未提交的乐观 mutation。 */
      const latest = dependencies.getState()
      if (latest.saveState === 'conflict') {
        /** 结构冲突只能展示权威结构，pending 与错误保留给显式冲突处理。 */
        dependencies.updateState({ phase: 'ready', snapshot })
        return
      }
      const localMutations = [...latest.inFlightMutations, ...latest.pendingMutations]
      const document = applyCanvasMutations(snapshot.document, localMutations)
      /** 普通远端刷新若已删除展开节点，也必须释放对应临时工作台。 */
      const expandedNodeStillExists = latest.expandedNodeId === null
        || document.nodes.some((node) => node.id === latest.expandedNodeId)
      dependencies.updateState({
        phase: 'ready',
        snapshot: { ...snapshot, document },
        saveState: localMutations.length > 0 ? latest.saveState : 'saved',
        ...(!expandedNodeStillExists ? {
          expandedNodeId: null,
          pendingWorkbenchSwitchNodeId: null,
          workbenchDraft: null,
        } : {}),
        error: null,
      })
    }).catch((error: unknown) => {
      if (disposed || !isCurrentRequest()) return
      if (authoritative) {
        authoritativeRecoveryInFlight = false
        dependencies.updateState((latest) => ({
          phase: latest.snapshot ? 'ready' : 'error',
          saveState: 'failed',
          authoritativeRecoveryState: 'failed',
          error: `恢复 Canvas 失败：${getNativeCanvasOperationErrorMessage('load', error)}`,
        }))
        return
      }
      dependencies.updateState({
        phase: 'error',
        error: getNativeCanvasOperationErrorMessage('load', error),
      })
    })
  }

  /** 开始权威恢复：先归还在途所有权，再失效旧 SAVE 与 LOAD 回调。 */
  const startAuthoritativeRecovery = (): void => {
    if (disposed) return
    fenceAuthoritativeSnapshot()
    dependencies.updateState((latest) => ({
      phase: latest.snapshot ? 'ready' : 'loading',
      inFlightMutations: [],
      saveState: 'failed',
      expandedNodeId: null,
      pendingWorkbenchSwitchNodeId: null,
      workbenchDraft: null,
      authoritativeRecoveryState: 'loading',
      error: '正在恢复 Canvas',
    }))
    loadSnapshot(true)
  }

  /** 按最新状态重新安排一次 400ms 保存。 */
  const scheduleSave = (): void => {
    clearSaveTimer()
    if (disposed || !canSave(dependencies.getState())) return
    saveTimerId = dependencies.scheduler.setTimeout(() => {
      saveTimerId = null
      const current = dependencies.getState()
      if (disposed || !current.snapshot || !canSave(current)) return
      /** 保存批次仅压缩 viewport，不改变其他 mutation 顺序。 */
      const batch = coalesceNativeCanvasMutationsForSave(current.pendingMutations)
      if (batch.length === 0) return
      const generation = saveGeneration + 1
      saveGeneration = generation
      const request: ActiveNativeCanvasSave = { generation, batch }
      activeSave = request
      dependencies.updateState({
        pendingMutations: [],
        inFlightMutations: batch,
        saveState: 'saving',
        error: null,
      })
      void dependencies.adapter.saveCanvas({
        ...dependencies.target,
        expectedRevision: current.snapshot.document.revision,
        mutations: batch,
      }).then((savedDocument: CanvasDocument) => {
        if (disposed || generation !== saveGeneration || activeSave !== request) return
        activeSave = null
        dependencies.updateState((latest) => ({
          snapshot: latest.snapshot
            ? {
                ...latest.snapshot,
                document: applyCanvasMutations(savedDocument, latest.pendingMutations),
              }
            : latest.snapshot,
          inFlightMutations: [],
          saveState: latest.pendingMutations.length > 0 ? 'dirty' : 'saved',
          error: null,
        }))
        scheduleSave()
      }).catch((error: unknown) => {
        if (disposed || generation !== saveGeneration || activeSave !== request) return
        if (isNativeCanvasAuthoritativeSaveError(error)) {
          /** 由 recovery-required、revision conflict 与 commit-uncertain 共同进入权威 LOAD。 */
          startAuthoritativeRecovery()
          return
        }
        activeSave = null
        dependencies.updateState((latest) => ({
          pendingMutations: [...batch, ...latest.pendingMutations],
          inFlightMutations: [],
          saveState: 'failed',
          error: getNativeCanvasOperationErrorMessage('save', error),
        }))
      })
    }, NATIVE_CANVAS_SAVE_DEBOUNCE_MS)
  }

  return {
    start: () => {
      if (disposed || unsubscribe) return
      unsubscribe = dependencies.adapter.onCanvasChanged(dependencies.target, (event: CanvasChangeEvent) => {
        if (disposed
          || event.projectId !== dependencies.target.projectId
          || event.canvasId !== dependencies.target.canvasId) return
        if (event.cause === 'recovery') {
          startAuthoritativeRecovery()
          return
        }
        /** recovery 期间只保留最高 graph 目标，禁止普通 LOAD 抢占恢复代次。 */
        const latest = dependencies.getState()
        if (authoritativeRecoveryInFlight || latest.authoritativeRecoveryState !== 'idle') {
          deferGraphRefresh(event.revision)
          return
        }
        /** 稳定状态下普通图事件只在 revision 单调前进时刷新。 */
        const currentRevision = latest.snapshot?.document.revision ?? -1
        if (event.revision > currentRevision) loadSnapshot(false)
      })
      /** remount 必须继续 keyed state 中未完成或失败的权威恢复。 */
      if (dependencies.getState().authoritativeRecoveryState !== 'idle') {
        startAuthoritativeRecovery()
        return
      }
      loadSnapshot(false)
    },
    sync: () => {
      scheduleSave()
    },
    enqueueMutation: (mutation) => {
      if (disposed) return
      dependencies.updateState((current) => {
        if (!current.snapshot
          || current.authoritativeRecoveryState !== 'idle'
          || current.saveState === 'conflict') return {}
        return {
          snapshot: {
            ...current.snapshot,
            document: applyCanvasMutations(current.snapshot.document, [mutation]),
          },
          pendingMutations: [...current.pendingMutations, mutation],
          saveState: current.saveState === 'failed'
            ? 'failed'
            : current.saveState === 'saving' ? 'saving' : 'dirty',
        }
      })
      scheduleSave()
    },
    retryLoad: () => {
      if (disposed) return
      if (dependencies.getState().authoritativeRecoveryState !== 'idle') {
        startAuthoritativeRecovery()
        return
      }
      dependencies.updateState({ phase: 'loading', error: null })
      loadSnapshot(false)
    },
    retrySave: () => {
      if (disposed) return
      const current = dependencies.getState()
      if (current.saveState !== 'failed' || current.authoritativeRecoveryState !== 'idle') return
      dependencies.updateState({ saveState: 'dirty', error: null })
      scheduleSave()
    },
    retryRecovery: () => {
      if (disposed || dependencies.getState().authoritativeRecoveryState !== 'failed') return
      startAuthoritativeRecovery()
    },
    acceptRemoteVersion: () => {
      if (disposed || dependencies.getState().saveState !== 'conflict') return
      clearSaveTimer()
      /** 用户明确采用远端版本时丢弃冲突 batch，并隔离任何旧 SAVE 回调。 */
      activeSave = null
      saveGeneration += 1
      dependencies.updateState({
        pendingMutations: [],
        inFlightMutations: [],
        saveState: 'saved',
        authoritativeRecoveryState: 'idle',
        error: null,
      })
    },
    dispose: () => {
      if (disposed) return
      clearSaveTimer()
      /** 归还在途 batch 后再使旧回调失效，避免 mutation 丢失或重复归还。 */
      restoreActiveSave()
      disposed = true
      ordinaryLoadGeneration += 1
      recoveryLoadGeneration += 1
      saveGeneration += 1
      authoritativeRecoveryInFlight = false
      unsubscribe?.()
      unsubscribe = null
    },
  }
}

/** 工作台编辑器注册的唯一草稿提交能力。 */
export interface NativeCanvasWorkbenchDraftCommitter {
  nodeId: string
  commitDraft: () => Promise<void>
}

/** 创建包含 Workspace 与节点双身份的提交器注册键。 */
export function createNativeCanvasWorkbenchDraftCommitterKey(
  stateKey: string,
  nodeId: string,
): string {
  return JSON.stringify([stateKey, nodeId])
}

/** 图片工作台同时需要模块命令和项目模型目录命令。 */
type NativeCanvasImageWorkbenchAdapter = CanvasImageModuleAdapter & DesignImageModelSelectionAdapter

/** 图片工作台向当前 Workspace 动态登记草稿提交器。 */
type RegisterNativeCanvasWorkbenchDraftCommitter = (
  committer: NativeCanvasWorkbenchDraftCommitter,
) => () => void

/** 生图前置流程只依赖保存和创建两个顺序命令。 */
export interface CanvasImageGenerationPreflightDependencies {
  commitDraft: () => Promise<CanvasImageModuleConfig | null>
  createJob: () => Promise<DesignJobRecord | null>
}

/**
 * 保存当前图片配置后才允许创建付费任务。
 * @param dependencies 当前图片模块的保存和创建命令。
 * @returns 主进程返回的任务；工作台已失效时返回 null。
 */
export async function commitCanvasImageDraftAndCreateJob(
  dependencies: CanvasImageGenerationPreflightDependencies,
): Promise<DesignJobRecord | null> {
  /** null 表示模块已经失效或没有权威配置，必须停止创建。 */
  const savedConfig = await dependencies.commitDraft()
  if (!savedConfig) return null
  return dependencies.createJob()
}

/** 从 Workspace 可选 Adapter 中提取图片工作台需要的完整窄合同。 */
function createNativeCanvasImageWorkbenchAdapter(
  adapter: NativeCanvasAdapter,
): NativeCanvasImageWorkbenchAdapter | null {
  if (!adapter.loadCanvasImageModule
    || !adapter.saveCanvasImageModule
    || !adapter.createCanvasImageJob
    || !adapter.cancelCanvasImageJob
    || !adapter.retryCanvasImageJob
    || !adapter.adoptCanvasImageAsset
    || !adapter.releaseCanvasImageMedia
    || !adapter.onCanvasImageModuleChanged
    || !adapter.getTaskDetails
    || !adapter.getTaskTrace
    || !adapter.getImageModelSelection
    || !adapter.setImageModelSelection
    || !adapter.onImageModelProfilesChanged
    || !adapter.onImageModelSelectionChanged) return null
  return {
    loadCanvasImageModule: adapter.loadCanvasImageModule,
    saveCanvasImageModule: adapter.saveCanvasImageModule,
    createCanvasImageJob: adapter.createCanvasImageJob,
    cancelCanvasImageJob: adapter.cancelCanvasImageJob,
    retryCanvasImageJob: adapter.retryCanvasImageJob,
    adoptCanvasImageAsset: adapter.adoptCanvasImageAsset,
    releaseCanvasImageMedia: adapter.releaseCanvasImageMedia,
    onCanvasImageModuleChanged: adapter.onCanvasImageModuleChanged,
    getTaskDetails: adapter.getTaskDetails,
    getTaskTrace: adapter.getTaskTrace,
    getImageModelSelection: adapter.getImageModelSelection,
    setImageModelSelection: adapter.setImageModelSelection,
    onImageModelProfilesChanged: adapter.onImageModelProfilesChanged,
    onImageModelSelectionChanged: adapter.onImageModelSelectionChanged,
  }
}

/** 当前展开图片节点的真实工作台输入。 */
interface CanvasImageNodeWorkbenchProps {
  node: Extract<CanvasNode, { kind: 'image' }>
  target: CanvasTarget
  writable: boolean
  adapter: NativeCanvasImageWorkbenchAdapter
  autoSaveEnabled: boolean
  onDirtyChange: (nodeId: string, dirty: boolean) => void
  onRegisterDraftCommitter: RegisterNativeCanvasWorkbenchDraftCommitter
}

/** 只在图片节点展开时挂载模块状态、模型目录和媒体授权。 */
function CanvasImageNodeWorkbench({
  node,
  target,
  writable,
  adapter,
  autoSaveEnabled,
  onDirtyChange,
  onRegisterDraftCommitter,
}: CanvasImageNodeWorkbenchProps): React.ReactElement {
  /** 图片节点的四元业务身份。 */
  const imageTarget = React.useMemo(() => ({
    ...target,
    nodeId: node.id,
    imageModuleId: node.imageModuleId,
  }), [node.id, node.imageModuleId, target.canvasId, target.projectId])
  /** 当前图片模块独立的状态和命令。 */
  const imageModule = useCanvasImageModule(imageTarget, adapter)
  /** 模型目录复用项目级清洗选项，不改变图片模块自己的选择。 */
  const projectModelStates = useAtomValue(designProjectStatesAtom)
  /** 还未加载模型目录时使用不共享集合的项目初始状态。 */
  const fallbackModelState = React.useMemo(createInitialDesignProjectState, [target.projectId])
  /** 当前项目模型目录状态。 */
  const modelState = projectModelStates.get(target.projectId) ?? fallbackModelState
  /** 模型广播和手动重试命令。 */
  const modelSelection = useDesignImageModelSelection(target.projectId, adapter)
  /** 打开设置面板所需的三个原子命令。 */
  const setSettingsOpen = useSetAtom(settingsOpenAtom)
  const setSettingsTab = useSetAtom(settingsTabAtom)
  const setChannelSettingsFocus = useSetAtom(channelSettingsFocusAtom)
  /** 提交器始终转发到最近一次 render 的模块命令。 */
  const commitDraftRef = React.useRef(imageModule.commitDraft)
  commitDraftRef.current = imageModule.commitDraft
  /** 当前挂载节点独占一个尾触发保存控制器，切换确认时会暂停。 */
  const autoSaveController = React.useMemo(() => createCanvasImageDraftAutoSaveController({
    scheduler: {
      setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
      clearTimeout: (timerId) => window.clearTimeout(timerId),
    },
    commitDraft: () => commitDraftRef.current(),
  }), [])

  React.useEffect(() => onRegisterDraftCommitter({
    nodeId: node.id,
    commitDraft: async () => {
      await commitDraftRef.current()
    },
  }), [node.id, onRegisterDraftCommitter])

  React.useEffect(() => {
    onDirtyChange(node.id, imageModule.state.draft?.dirty === true)
  }, [imageModule.state.draft?.dirty, node.id, onDirtyChange])

  React.useEffect(() => {
    autoSaveController.schedule(
      imageModule.state.draft,
      imageModule.state.saveState,
      autoSaveEnabled,
    )
  }, [
    autoSaveController,
    autoSaveEnabled,
    imageModule.state.draft,
    imageModule.state.saveState,
  ])

  React.useEffect(() => () => autoSaveController.dispose(), [autoSaveController])

  /** 打开渠道设置并聚焦生图模型区。 */
  const configureModels = React.useCallback((): void => {
    setSettingsTab('channels')
    setChannelSettingsFocus('image-models')
    setSettingsOpen(true)
  }, [setChannelSettingsFocus, setSettingsOpen, setSettingsTab])

  /** 生成严格等待草稿提交成功；错误由图片模块状态原位展示。 */
  const generate = React.useCallback((): void => {
    void commitCanvasImageDraftAndCreateJob({
      commitDraft: imageModule.commitDraft,
      createJob: imageModule.createJob,
    }).catch(() => undefined)
  }, [imageModule.commitDraft, imageModule.createJob])

  /** 采用历史素材前从权威任务列表解析它的来源 Job。 */
  const adoptAsset = React.useCallback((assetId: string): void => {
    const sourceJob = imageModule.state.snapshot?.jobs.find((job) => (
      job.status === 'succeeded' && job.outputAssetId === assetId
    ))
    if (!sourceJob) return
    void imageModule.adoptAsset(sourceJob.id, assetId).catch(() => undefined)
  }, [imageModule])

  return (
    <CanvasImageWorkbench
      state={imageModule.state}
      writable={writable}
      imageModelOptions={modelState.imageModelOptions}
      imageModelLoadState={modelState.imageModelLoadState}
      imageModelError={modelState.imageModelError}
      onDraftChange={imageModule.updateDraft}
      onGenerate={generate}
      onCancel={(jobId) => { void imageModule.cancelJob(jobId).catch(() => undefined) }}
      onRetry={(jobId) => { void imageModule.retryJob(jobId).catch(() => undefined) }}
      onPreviewAsset={(assetId) => imageModule.previewAsset(assetId)}
      onAdoptAsset={adoptAsset}
      onLoadTaskDetails={(jobId, includeTrace) => {
        void imageModule.loadTaskDetails(jobId, includeTrace).catch(() => undefined)
      }}
      onConfigureModels={configureModels}
      onRetryLoad={() => {
        imageModule.retryLoad()
        if (modelState.imageModelLoadState === 'failed') modelSelection.retryLoad()
      }}
      onCopyPrompt={(prompt) => { void copyTextToClipboard(prompt).catch(() => undefined) }}
    />
  )
}

/** dirty 工作台保存按钮的稳定可用性结果。 */
export interface NativeCanvasWorkbenchCommitAvailability {
  enabled: boolean
  reason: string | null
}

/** 只有当前展开节点注册了提交器时才允许保存并切换。 */
export function getNativeCanvasWorkbenchCommitAvailability(
  expandedNodeId: string | null,
  committer: NativeCanvasWorkbenchDraftCommitter | undefined,
): NativeCanvasWorkbenchCommitAvailability {
  if (expandedNodeId && committer?.nodeId === expandedNodeId) {
    return { enabled: true, reason: null }
  }
  return {
    enabled: false,
    reason: '当前工作台未注册保存能力，暂时不能保存并切换。',
  }
}

/** 单次草稿保存捕获的工作区与工作台身份。 */
export interface NativeCanvasWorkbenchDraftCommitOperation {
  stateKey: string
  sourceExpandedNodeId: string
  sourceDraftNodeId: string | null
  targetNodeId: string
  commitDraft: () => Promise<void>
}

/** 草稿保存协调器依赖，只允许通过当前 Jotai 状态判断异步结果归属。 */
export interface NativeCanvasWorkbenchDraftCommitCoordinatorDependencies {
  getCurrentWorkspaceKey: () => string
  getState: (stateKey: string) => NativeCanvasState | undefined
  onSuccess: (operation: NativeCanvasWorkbenchDraftCommitOperation) => void
  onFailure: (operation: NativeCanvasWorkbenchDraftCommitOperation) => void
  onSettled: (operation: NativeCanvasWorkbenchDraftCommitOperation) => void
}

/** 草稿保存协调接口，新操作和显式失效都会递增单调代次。 */
export interface NativeCanvasWorkbenchDraftCommitCoordinator {
  execute: (operation: NativeCanvasWorkbenchDraftCommitOperation) => Promise<void>
  invalidate: () => void
}

/**
 * 创建草稿保存异步结果协调器。
 * @param dependencies 读取当前工作区身份并提交匹配结果的依赖。
 * @returns 只有代次和完整工作台身份仍匹配时才产生副作用的协调器。
 */
export function createNativeCanvasWorkbenchDraftCommitCoordinator(
  dependencies: NativeCanvasWorkbenchDraftCommitCoordinatorDependencies,
): NativeCanvasWorkbenchDraftCommitCoordinator {
  let generation = 0
  /** 只有同代次且 Workspace 仍挂载时，旧 Promise 才拥有本地 saving 指示器。 */
  const ownsSavingIndicator = (
    operation: NativeCanvasWorkbenchDraftCommitOperation,
    operationGeneration: number,
  ): boolean => operationGeneration === generation
    && dependencies.getCurrentWorkspaceKey() === operation.stateKey
  /** 完整源/目标身份仍匹配时，才允许应用保存成功或失败的业务结果。 */
  const canApplyResult = (
    operation: NativeCanvasWorkbenchDraftCommitOperation,
    operationGeneration: number,
  ): boolean => {
    if (!ownsSavingIndicator(operation, operationGeneration)) return false
    const current = dependencies.getState(operation.stateKey)
    return current?.expandedNodeId === operation.sourceExpandedNodeId
      && (current.workbenchDraft?.nodeId ?? null) === operation.sourceDraftNodeId
      && current.pendingWorkbenchSwitchNodeId === operation.targetNodeId
  }
  return {
    execute: async (operation) => {
      generation += 1
      const operationGeneration = generation
      try {
        await operation.commitDraft()
      } catch {
        if (!ownsSavingIndicator(operation, operationGeneration)) return
        if (canApplyResult(operation, operationGeneration)) dependencies.onFailure(operation)
        dependencies.onSettled(operation)
        return
      }
      if (!ownsSavingIndicator(operation, operationGeneration)) return
      if (canApplyResult(operation, operationGeneration)) dependencies.onSuccess(operation)
      dependencies.onSettled(operation)
    },
    invalidate: () => {
      generation += 1
    },
  }
}

/** 原生 Canvas React 壳输入。 */
export interface NativeCanvasWorkspaceProps {
  target: CanvasTarget
  title: string
  adapter?: NativeCanvasAdapter
  flowRenderer?: NativeCanvasFlowRenderer
  /** 测试或宿主可注入对话渲染器；默认使用真实 Canvas Agent 对话组件。 */
  conversationRenderer?: React.ComponentType<CanvasAgentConversationProps>
}

/** 将隔离 Jotai 状态绑定到纯 controller，并渲染当前加载阶段。 */
export function NativeCanvasWorkspace({
  target,
  title,
  adapter = designAdapter,
  flowRenderer,
  conversationRenderer,
}: NativeCanvasWorkspaceProps): React.ReactElement {
  /** 双身份 key 决定唯一状态与 effect 生命周期。 */
  const stateKey = createNativeCanvasKey(target.projectId, target.canvasId)
  const states = useAtomValue(nativeCanvasStatesAtom)
  const updateNativeCanvasState = useSetAtom(updateNativeCanvasStateAtom)
  const store = useStore()
  const runningSessionIds = useAtomValue(canvasAgentRunningSessionIdsAtom)
  const runGenerations = useAtomValue(canvasAgentRunGenerationsAtom)
  const optimisticRunGenerations = useAtomValue(canvasAgentOptimisticRunGenerationsAtom)
  const controllerRef = React.useRef<NativeCanvasWorkspaceController | null>(null)
  const commandRef = React.useRef<CanvasNodeCreateCommandController | null>(null)
  const trashControllerRef = React.useRef<NativeCanvasTrashController | null>(null)
  const rebuildCommandRef = React.useRef<CanvasAgentNodeRebuildController | null>(null)
  /** DELETE 异步回调代次，Canvas 切换后立即失效旧删除请求。 */
  const deleteGenerationRef = React.useRef(0)
  /** STOP attempt 独立单调代次，不能与后续 DELETE 请求共用生命周期。 */
  const stopDeleteRequestGenerationRef = React.useRef(0)
  /** 删除失败重试复用同一完整幂等请求，成功或 Canvas 切换后清理。 */
  const deleteOperationRef = React.useRef<DeleteCanvasNodeInput | null>(null)
  /** 批量删除按节点缓存独立 operation，部分失败后只重试剩余节点。 */
  const batchDeleteOperationRef = React.useRef(new Map<string, DeleteCanvasNodeInput>())
  /** 空图新增落点必须使用真实画布表面，不读取侧栏或窗口全宽。 */
  const canvasSurfaceRef = React.useRef<HTMLDivElement | null>(null)
  const [createState, setCreateState] = React.useState<CanvasAgentNodeCommandState>({
    loading: false,
    error: null,
  })
  const [rebuildState, setRebuildState] = React.useState<CanvasAgentNodeCommandState>({
    loading: false,
    error: null,
  })
  const [deleteDialogOpen, setDeleteDialogOpen] = React.useState(false)
  const [deleteSubmitting, setDeleteSubmitting] = React.useState(false)
  const [deleteError, setDeleteError] = React.useState<string | null>(null)
  /** Renderer 局部完整选区；Jotai 的 selectedNodeId 继续作为详情主节点。 */
  const [selectedNodeIds, setSelectedNodeIds] = React.useState<string[]>([])
  const [trashOpen, setTrashOpen] = React.useState(false)
  const [trashState, setTrashState] = React.useState<NativeCanvasTrashState>({
    entries: [], loading: false, restoringTrashId: null, error: null,
  })
  const [workbenchSwitchSaving, setWorkbenchSwitchSaving] = React.useState(false)
  const [workbenchSwitchError, setWorkbenchSwitchError] = React.useState<string | null>(null)
  /** 已挂载重内容工作台按节点 ID 动态登记的提交器。 */
  const [workbenchDraftCommitters, setWorkbenchDraftCommitters] = React.useState<Map<
    string,
    NativeCanvasWorkbenchDraftCommitter
  >>(() => new Map())
  /** 图片工作台只有在 Adapter 四组合同齐全时才接通。 */
  const imageWorkbenchAdapter = React.useMemo(
    () => createNativeCanvasImageWorkbenchAdapter(adapter),
    [adapter],
  )
  /** 当前渲染的 Workspace key，供迟到草稿保存结果复核组件身份。 */
  const currentWorkspaceKeyRef = React.useRef(stateKey)
  currentWorkspaceKeyRef.current = stateKey
  /** 草稿保存代次跨 render 保持单调，不允许旧 Promise 污染新工作台。 */
  const workbenchDraftCommitCoordinatorRef = React.useRef<NativeCanvasWorkbenchDraftCommitCoordinator | null>(null)
  if (!workbenchDraftCommitCoordinatorRef.current) {
    workbenchDraftCommitCoordinatorRef.current = createNativeCanvasWorkbenchDraftCommitCoordinator({
      getCurrentWorkspaceKey: () => currentWorkspaceKeyRef.current,
      getState: (key) => store.get(nativeCanvasStatesAtom).get(key),
      onSuccess: ({ stateKey: operationStateKey }) => {
        updateNativeCanvasState({
          key: operationStateKey,
          update: createResolvedNativeCanvasWorkbenchSwitchUpdate,
        })
        setWorkbenchSwitchError(null)
      },
      onFailure: () => setWorkbenchSwitchError('保存草稿失败，请重试。'),
      onSettled: () => setWorkbenchSwitchSaving(false),
    })
  }
  /** 停止请求与权威运行终态之间的待删除身份。 */
  const [pendingStopDelete, setPendingStopDelete] = React.useState<PendingCanvasStopDelete | null>(null)
  /** Promise 回调同步读取当前 pending，避免 React state 提交时序留下竞态窗口。 */
  const pendingStopDeleteRef = React.useRef<PendingCanvasStopDelete | null>(null)
  /** 同步替换 ref 与 React state，所有 STOP 回调只读取该唯一身份。 */
  const replacePendingStopDelete = React.useCallback((next: PendingCanvasStopDelete | null): void => {
    pendingStopDeleteRef.current = next
    setPendingStopDelete(next)
  }, [])
  /** 失效当前 STOP token 后清除 pending，迟到 resolve/reject 完全无副作用。 */
  const invalidatePendingStopDelete = React.useCallback((): void => {
    stopDeleteRequestGenerationRef.current += 1
    replacePendingStopDelete(null)
  }, [replacePendingStopDelete])
  /** SSR 首帧使用该 key 专属的全新状态，不启动任何消息或 Canvas API。 */
  const fallbackState = React.useMemo(createInitialNativeCanvasState, [stateKey])
  const state = states.get(stateKey) ?? fallbackState
  /** 工作区快照只建立一次素材预览索引，所有折叠卡片共享且不触发图片模块 LOAD。 */
  const imagePreviewUrls = React.useMemo(() => new Map(
    (state.snapshot?.imagePreviews ?? []).map((preview) => [preview.assetId, preview.previewUrl]),
  ), [state.snapshot?.imagePreviews])
  /** 识别创建、恢复和问题定位等外部主选中变化，避免旧多选遮住新目标。 */
  const previousSelectedNodeIdRef = React.useRef(state.selectedNodeId)
  /** 权威文档过滤已删除节点，防止迟到选区引用不存在的节点。 */
  const validSelectedNodeIds = React.useMemo(() => {
    if (!state.snapshot) return []
    const documentNodeIds = new Set(state.snapshot.document.nodes.map((node) => node.id))
    return selectedNodeIds.filter((nodeId) => documentNodeIds.has(nodeId))
  }, [selectedNodeIds, state.snapshot])
  /** 完整选区节点用于批量删除摘要和运行态边界检查。 */
  const selectedNodes = React.useMemo(() => {
    if (!state.snapshot) return []
    const selectedNodeIdSet = new Set(validSelectedNodeIds)
    return state.snapshot.document.nodes.filter((node) => selectedNodeIdSet.has(node.id))
  }, [state.snapshot, validSelectedNodeIds])
  /** Agent 工作台节点始终从当前 Canvas 权威内存文档解析，不保存 Renderer sessionId。 */
  const conversationNode = state.snapshot?.document.nodes.find((node) => (
    node.id === state.expandedNodeId && node.kind === 'agent'
  ))
  /** 节点问题只取主进程权威快照，不从会话读取失败反推。 */
  const conversationNodeIssue = state.snapshot?.nodeIssues.find((issue) => (
    issue.nodeId === conversationNode?.id
  ))
  /** 首个选中节点继续作为详情与单节点停止删除的主节点。 */
  const selectedNode = selectedNodes[0]
    ?? state.snapshot?.document.nodes.find((node) => node.id === state.selectedNodeId)
  /** 单节点运行态仍按当前 Agent 节点绑定的 session 判断。 */
  const selectedNodeBusy = selectedNode?.kind === 'agent'
    && runningSessionIds.has(selectedNode.agentSessionId)
  /** 批量选择中任意运行中 Agent 都会阻断整个批次，避免不明确的部分删除。 */
  const hasBusySelectedNode = selectedNodes.some((node) => (
    node.kind === 'agent' && runningSessionIds.has(node.agentSessionId)
  ))

  React.useEffect(() => {
    /** 在调度状态更新前捕获变化事实，避免并发渲染时 ref 提前推进。 */
    const primaryChanged = previousSelectedNodeIdRef.current !== state.selectedNodeId
    previousSelectedNodeIdRef.current = state.selectedNodeId
    /** 远端删除或首次加载时收敛选区；已有有效多选不得被主节点压缩。 */
    setSelectedNodeIds((current) => {
      if (!state.snapshot) return current.length === 0 ? current : []
      const documentNodeIds = new Set(state.snapshot.document.nodes.map((node) => node.id))
      const validNodeIds = current.filter((nodeId) => documentNodeIds.has(nodeId))
      /** 外部命令切换主节点时改为新单选；Graph 自身更新时首项已经一致。 */
      if (primaryChanged && state.selectedNodeId && documentNodeIds.has(state.selectedNodeId)
        && validNodeIds[0] !== state.selectedNodeId) {
        return [state.selectedNodeId]
      }
      if (validNodeIds.length > 0) {
        return validNodeIds.length === current.length ? current : validNodeIds
      }
      return state.selectedNodeId && documentNodeIds.has(state.selectedNodeId)
        ? [state.selectedNodeId]
        : []
    })
  }, [state.selectedNodeId, state.snapshot, stateKey])

  /** 登记提交器并返回身份安全的释放函数，迟到 cleanup 不删除新实例。 */
  const registerWorkbenchDraftCommitter = React.useCallback<RegisterNativeCanvasWorkbenchDraftCommitter>((committer) => {
    /** 注册键必须包含 Canvas，避免同名节点跨 Workspace 复用。 */
    const registryKey = createNativeCanvasWorkbenchDraftCommitterKey(stateKey, committer.nodeId)
    setWorkbenchDraftCommitters((current) => {
      const next = new Map(current)
      next.set(registryKey, committer)
      return next
    })
    return () => {
      setWorkbenchDraftCommitters((current) => {
        if (current.get(registryKey) !== committer) return current
        const next = new Map(current)
        next.delete(registryKey)
        return next
      })
    }
  }, [stateKey])

  React.useEffect(() => {
    /** 浏览器调度器仅在 effect 内创建，SSR 不触发副作用。 */
    const scheduler: NativeCanvasScheduler = {
      setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
      clearTimeout: (timerId) => window.clearTimeout(timerId),
    }
    const controller = createNativeCanvasWorkspaceController({
      target: { projectId: target.projectId, canvasId: target.canvasId },
      adapter,
      getState: () => store.get(nativeCanvasStatesAtom).get(stateKey)
        ?? createInitialNativeCanvasState(),
      updateState: (update) => updateNativeCanvasState({ key: stateKey, update }),
      scheduler,
    })
    controllerRef.current = controller
    controller.start()
    return () => {
      controller.dispose()
      if (controllerRef.current === controller) controllerRef.current = null
    }
  }, [adapter, stateKey, store, target.canvasId, target.projectId, updateNativeCanvasState])

  React.useEffect(() => {
    const disposeCleanup = nativeCanvasWorkbenchCleanupCoordinator.mount(stateKey, () => {
      /** 微任务后仍未重挂才表示真实 Canvas 切换或卸载。 */
      updateNativeCanvasState({
        key: stateKey,
        update: createClosedNativeCanvasWorkbenchUpdate(),
      })
    })
    return () => {
      workbenchDraftCommitCoordinatorRef.current?.invalidate()
      disposeCleanup()
    }
  }, [stateKey, updateNativeCanvasState])

  React.useEffect(() => {
    if (!adapter.createCanvasAgentNode || !adapter.createCanvasContentNode) {
      commandRef.current = null
      return
    }
    /** 每个 projectId:canvasId 生命周期拥有独立 operation，切换即视为取消。 */
    setCreateState({ loading: false, error: null })
    const command = createCanvasNodeCommandController({
      target,
      createAgentNode: adapter.createCanvasAgentNode,
      createContentNode: adapter.createCanvasContentNode,
      createId: () => window.crypto.randomUUID(),
      getDocument: () => {
        const document = store.get(nativeCanvasStatesAtom).get(stateKey)?.snapshot?.document
        if (!document) throw new Error('Canvas 尚未加载完成')
        return document
      },
      getPosition: (sourceNodeId) => {
        /** 点击时读取最新权威文档，避免迟到视图闭包决定创建位置。 */
        const latest = store.get(nativeCanvasStatesAtom).get(stateKey)
        const document = latest?.snapshot?.document
        if (!document) throw new Error('Canvas 尚未加载完成')
        if (sourceNodeId) {
          return findAvailableNativeCanvasChildPosition(sourceNodeId, document.nodes)
        }
        const bounds = canvasSurfaceRef.current?.getBoundingClientRect()
        return findNativeCanvasAgentNodeCreationPosition(document, {
          width: bounds?.width ?? 0,
          height: bounds?.height ?? 0,
        })
      },
      onStateChange: setCreateState,
      onSuccess: (success) => updateNativeCanvasState({
        key: stateKey,
        update: (current) => createNativeCanvasNodeCreationSuccessUpdate(current, success),
      }),
    })
    commandRef.current = command
    return () => {
      command.cancel()
      if (commandRef.current === command) commandRef.current = null
    }
  }, [adapter, stateKey, store, target.canvasId, target.projectId, updateNativeCanvasState])

  React.useEffect(() => {
    if (!adapter.listCanvasTrash || !adapter.restoreCanvasNode) {
      trashControllerRef.current = null
      return
    }
    const controller = createNativeCanvasTrashController({
      target,
      listTrash: adapter.listCanvasTrash,
      restoreNode: adapter.restoreCanvasNode,
      createId: () => window.crypto.randomUUID(),
      getDocument: () => {
        const document = store.get(nativeCanvasStatesAtom).get(stateKey)?.snapshot?.document
        if (!document) throw new Error('Canvas 尚未加载完成')
        return document
      },
      getEmptyCanvasCenter: () => {
        const document = store.get(nativeCanvasStatesAtom).get(stateKey)?.snapshot?.document
        if (!document) return { x: 0, y: 0 }
        const bounds = canvasSurfaceRef.current?.getBoundingClientRect()
        return {
          x: ((bounds?.width ?? 0) / 2 - document.viewport.x) / document.viewport.zoom,
          y: ((bounds?.height ?? 0) / 2 - document.viewport.y) / document.viewport.zoom,
        }
      },
      onStateChange: setTrashState,
      onRestored: (result, nodeId) => {
        workbenchDraftCommitCoordinatorRef.current?.invalidate()
        updateNativeCanvasState({
          key: stateKey,
          update: (current) => createNativeCanvasLifecycleSuccessUpdate(current, result, nodeId),
        })
      },
    })
    trashControllerRef.current = controller
    return () => {
      controller.cancel()
      if (trashControllerRef.current === controller) trashControllerRef.current = null
    }
  }, [adapter.listCanvasTrash, adapter.restoreCanvasNode, stateKey, store, target, updateNativeCanvasState])

  React.useEffect(() => {
    if (!adapter.rebuildCanvasAgentNode || !conversationNode || !conversationNodeIssue) {
      rebuildCommandRef.current = null
      setRebuildState({ loading: false, error: null })
      return
    }
    /** 每个问题节点独占重建 operation，切换节点或 Canvas 后立即取消旧 UI 回调。 */
    const command = createCanvasAgentNodeRebuildController({
      target: { ...target, nodeId: conversationNode.id },
      rebuildAgentNode: adapter.rebuildCanvasAgentNode,
      createId: () => window.crypto.randomUUID(),
      onStateChange: setRebuildState,
      onSuccess: (result) => updateNativeCanvasState({
        key: stateKey,
        update: createRebuiltNativeCanvasStateUpdate(result, conversationNode.id),
      }),
    })
    rebuildCommandRef.current = command
    return () => {
      command.cancel()
      if (rebuildCommandRef.current === command) rebuildCommandRef.current = null
    }
  }, [
    adapter.rebuildCanvasAgentNode,
    conversationNode,
    conversationNodeIssue,
    stateKey,
    target,
    updateNativeCanvasState,
  ])

  /** 创建期间要求权威快照无本地待提交变更，避免立即制造 revision conflict。 */
  const canCreateNode = Boolean(
    adapter.createCanvasAgentNode
    && adapter.createCanvasContentNode
    && state.snapshot
    && state.snapshot.writable
    && state.saveState === 'saved'
    && state.pendingMutations.length === 0
    && state.inFlightMutations.length === 0
    && state.authoritativeRecoveryState === 'idle'
    && !state.workbenchDraft?.dirty
    && !createState.loading,
  )
  /** 三个 API 缺一即 fail closed，不展示无法完整控制的对话面板。 */
  const conversationAdapter: CanvasAgentConversationAdapter | null = adapter.getCanvasAgentMessages
    && adapter.sendCanvasAgentMessage
    && adapter.stopCanvasAgent
    ? {
        getCanvasAgentMessages: adapter.getCanvasAgentMessages,
        sendCanvasAgentMessage: adapter.sendCanvasAgentMessage,
        stopCanvasAgent: adapter.stopCanvasAgent,
      }
    : null
  /** 保持生产默认组件不变，同时允许测试捕获 Workspace 提供的真实回调。 */
  const ConversationRenderer = conversationRenderer ?? CanvasAgentConversation
  /** 恢复、冲突以外的稳定状态允许结构命令。 */
  const workspaceWritable = Boolean(
    state.snapshot?.writable
    && state.authoritativeRecoveryState === 'idle'
    && state.saveState !== 'conflict',
  )
  /** 删除要求存在完整选区和可写快照，主进程继续逐节点复核运行态。 */
  const canDeleteNode = Boolean(
    workspaceWritable
    && adapter.deleteCanvasNode
    && selectedNodes.length > 0
    && state.saveState === 'saved'
    && state.pendingMutations.length === 0
    && state.inFlightMutations.length === 0
    && !deleteSubmitting,
  )
  /** 当前完整选区删除会同步移除的去重关联边数量。 */
  const connectedEdgeCount = state.snapshot && selectedNodes.length > 0
    ? getNativeCanvasBatchConnectedEdgeCount(
        state.snapshot.document,
        selectedNodes.map((node) => node.id),
      )
    : 0
  /** 切换确认只读取当前展开节点自己登记的提交器。 */
  const currentWorkbenchDraftCommitter = state.expandedNodeId
    ? workbenchDraftCommitters.get(createNativeCanvasWorkbenchDraftCommitterKey(
        stateKey,
        state.expandedNodeId,
      ))
    : undefined
  /** dirty 保存严格绑定当前节点注册的窄提交器。 */
  const workbenchCommitAvailability = getNativeCanvasWorkbenchCommitAvailability(
    state.expandedNodeId,
    currentWorkbenchDraftCommitter,
  )

  /** 收起节点工作台；dirty 时复用保存、放弃、取消确认，不改变图和普通选区。 */
  const closeWorkbench = React.useCallback((): void => {
    workbenchDraftCommitCoordinatorRef.current?.invalidate()
    setWorkbenchSwitchError(null)
    updateNativeCanvasState({
      key: stateKey,
      update: createNativeCanvasWorkbenchCloseRequestUpdate,
    })
  }, [stateKey, updateNativeCanvasState])

  /** 请求打开节点工作台；dirty 切换先进入三选一确认。 */
  const requestWorkbenchNodeChange = React.useCallback((nodeId: string): void => {
    workbenchDraftCommitCoordinatorRef.current?.invalidate()
    setWorkbenchSwitchError(null)
    updateNativeCanvasState({
      key: stateKey,
      update: (current) => createNativeCanvasWorkbenchChangeUpdate(current, nodeId),
    })
  }, [stateKey, updateNativeCanvasState])

  /** 同步当前展开节点的 dirty 状态，其他节点的迟到 effect 无副作用。 */
  const updateWorkbenchDirty = React.useCallback((nodeId: string, nextDirty: boolean): void => {
    updateNativeCanvasState({
      key: stateKey,
      update: (current) => {
        if (current.expandedNodeId !== nodeId) return {}
        const currentDirty = current.workbenchDraft?.nodeId === nodeId
          && current.workbenchDraft.dirty
        if (currentDirty === nextDirty) return {}
        return { workbenchDraft: nextDirty ? { nodeId, dirty: true } : null }
      },
    })
  }, [stateKey, updateNativeCanvasState])

  /** 保存成功或明确放弃后完成唯一工作台切换。 */
  const resolveWorkbenchSwitch = React.useCallback((): void => {
    workbenchDraftCommitCoordinatorRef.current?.invalidate()
    updateNativeCanvasState({
      key: stateKey,
      update: createResolvedNativeCanvasWorkbenchSwitchUpdate,
    })
    setWorkbenchSwitchError(null)
  }, [stateKey, updateNativeCanvasState])

  /** 仅调用当前节点已注册的窄提交器，缺失时按钮保持禁用。 */
  const saveAndSwitchWorkbench = React.useCallback((): void => {
    const currentNodeId = state.expandedNodeId
    const targetNodeId = state.pendingWorkbenchSwitchNodeId
    if (!currentNodeId || !targetNodeId
      || !workbenchCommitAvailability.enabled || !currentWorkbenchDraftCommitter) return
    setWorkbenchSwitchSaving(true)
    setWorkbenchSwitchError(null)
    void workbenchDraftCommitCoordinatorRef.current?.execute({
      stateKey,
      sourceExpandedNodeId: currentNodeId,
      sourceDraftNodeId: state.workbenchDraft?.nodeId ?? null,
      targetNodeId,
      commitDraft: currentWorkbenchDraftCommitter.commitDraft,
    })
  }, [
    state.expandedNodeId,
    state.pendingWorkbenchSwitchNodeId,
    state.workbenchDraft?.nodeId,
    stateKey,
    workbenchCommitAvailability.enabled,
    currentWorkbenchDraftCommitter,
  ])

  /** 打开统一删除确认框，并清理上一次停止错误。 */
  const requestSelectedNodeDelete = React.useCallback((): void => {
    if (!canDeleteNode) return
    setDeleteError(null)
    setDeleteDialogOpen(true)
  }, [canDeleteNode])

  /** 通过主进程生命周期删除节点，失败时完整保留图、选区、viewport 与草稿。 */
  const commitNodeDelete = React.useCallback((nodeId: string): void => {
    const latest = store.get(nativeCanvasStatesAtom).get(stateKey)
    if (!adapter.deleteCanvasNode || !latest?.snapshot) return
    let operation = deleteOperationRef.current
    if (!operation || operation.nodeId !== nodeId) {
      operation = {
        ...target,
        nodeId,
        operationId: window.crypto.randomUUID(),
        expectedRevision: latest.snapshot.document.revision,
      }
      deleteOperationRef.current = operation
    }
    const deleteGeneration = deleteGenerationRef.current
    setDeleteSubmitting(true)
    setDeleteError(null)
    void adapter.deleteCanvasNode(operation).then((result) => {
      if (deleteGenerationRef.current !== deleteGeneration) return
      workbenchDraftCommitCoordinatorRef.current?.invalidate()
      updateNativeCanvasState({
        key: stateKey,
        update: (current) => createNativeCanvasLifecycleSuccessUpdate(current, result, null),
      })
      deleteOperationRef.current = null
      invalidatePendingStopDelete()
      setDeleteSubmitting(false)
      setDeleteError(null)
      setDeleteDialogOpen(false)
    }).catch((error: unknown) => {
      if (deleteGenerationRef.current !== deleteGeneration) return
      invalidatePendingStopDelete()
      setDeleteSubmitting(false)
      setDeleteError(getNativeCanvasOperationErrorMessage('delete', error))
    })
  }, [
    adapter.deleteCanvasNode,
    invalidatePendingStopDelete,
    stateKey,
    store,
    target,
    updateNativeCanvasState,
  ])

  /** 通过既有单节点生命周期串行删除完整选区，部分失败时保留剩余节点供重试。 */
  const commitBatchNodeDelete = React.useCallback((nodeIds: readonly string[]): void => {
    const latest = store.get(nativeCanvasStatesAtom).get(stateKey)
    if (!adapter.deleteCanvasNode || !latest?.snapshot || nodeIds.length < 2) return
    /** 当前批次绑定 Canvas 删除代次，切换后不再提交后续节点。 */
    const deleteGeneration = deleteGenerationRef.current
    setDeleteSubmitting(true)
    setDeleteError(null)
    void deleteNativeCanvasNodesSequentially({
      target,
      nodeIds,
      initialRevision: latest.snapshot.document.revision,
      deleteNode: adapter.deleteCanvasNode,
      createOperationId: () => window.crypto.randomUUID(),
      operationCache: batchDeleteOperationRef.current,
      isActive: () => deleteGenerationRef.current === deleteGeneration,
      onDeleted: (_nodeId, result, remainingNodeIds) => {
        if (deleteGenerationRef.current !== deleteGeneration) return
        workbenchDraftCommitCoordinatorRef.current?.invalidate()
        const nextSelectedNodeId = remainingNodeIds[0] ?? null
        updateNativeCanvasState({
          key: stateKey,
          update: (current) => createNativeCanvasLifecycleSuccessUpdate(
            current,
            result,
            nextSelectedNodeId,
          ),
        })
        setSelectedNodeIds([...remainingNodeIds])
      },
    }).then((result) => {
      if (deleteGenerationRef.current !== deleteGeneration) return
      setDeleteSubmitting(false)
      setSelectedNodeIds(result.remainingNodeIds)
      if (result.error) {
        /** 部分成功必须明确告诉用户已完成和未完成数量。 */
        const progressMessage = result.deletedNodeIds.length > 0
          ? `已删除 ${result.deletedNodeIds.length} 个，剩余 ${result.remainingNodeIds.length} 个未删除。`
          : ''
        setDeleteError(`${progressMessage}${getNativeCanvasOperationErrorMessage('delete', result.error)}`)
        return
      }
      batchDeleteOperationRef.current.clear()
      setDeleteError(null)
      setDeleteDialogOpen(false)
    })
  }, [adapter.deleteCanvasNode, stateKey, store, target, updateNativeCanvasState])

  React.useEffect(() => {
    if (!pendingStopDelete) return
    if (pendingStopDelete.canvasKey !== stateKey) {
      invalidatePendingStopDelete()
      setDeleteSubmitting(false)
      return
    }
    /** 停止完成后再次读取当前 keyed 状态，防止切换 Canvas 或重建换绑后误删。 */
    const latest = store.get(nativeCanvasStatesAtom).get(stateKey)
    const latestNode = latest?.snapshot?.document.nodes.find((node) => (
      node.id === pendingStopDelete.nodeId && node.kind === 'agent'
    ))
    if (!isPendingCanvasStopDeleteTargetCurrent(pendingStopDelete, stateKey, latestNode)) {
      invalidatePendingStopDelete()
      setDeleteSubmitting(false)
      setDeleteDialogOpen(false)
      return
    }
    const generationStatus = getPendingCanvasStopDeleteGenerationStatus(
      pendingStopDelete,
      runGenerations,
      optimisticRunGenerations,
      runningSessionIds,
    )
    if (generationStatus === 'active') return
    if (generationStatus === 'replaced' || generationStatus === 'unknown') {
      invalidatePendingStopDelete()
      setDeleteSubmitting(false)
      setDeleteError(generationStatus === 'replaced'
        ? 'Agent 已开始新的运行，旧删除已取消。'
        : '无法确认 Agent 运行代次，节点未删除。')
      return
    }
    if (!pendingStopDelete.stopAccepted) return
    commitNodeDelete(pendingStopDelete.nodeId)
  }, [
    commitNodeDelete,
    invalidatePendingStopDelete,
    optimisticRunGenerations,
    pendingStopDelete,
    runGenerations,
    runningSessionIds,
    stateKey,
    store,
  ])

  /** 删除确认的唯一执行入口，运行节点等待权威终态后再删除。 */
  const confirmSelectedNodeDelete = React.useCallback((
    mode: 'delete' | 'stop-and-delete',
  ): void => {
    if (!selectedNode || !canDeleteNode) return
    if (selectedNodes.length > 1) {
      if (hasBusySelectedNode) {
        setDeleteError('选区中有正在运行的 Agent，请先单独停止后再批量删除。')
        return
      }
      commitBatchNodeDelete(selectedNodes.map((node) => node.id))
      return
    }
    if (mode === 'delete') {
      commitNodeDelete(selectedNode.id)
      return
    }
    if (selectedNode.kind !== 'agent' || !adapter.stopCanvasAgent) {
      setDeleteError('停止失败，节点未删除。')
      return
    }
    const startedAt = getCurrentCanvasAgentRunGeneration(
      selectedNode.agentSessionId,
      runGenerations,
      optimisticRunGenerations,
    )
    if (startedAt === null) {
      setDeleteError('无法确认 Agent 运行代次，节点未删除。')
      return
    }
    /** 当前停止请求绑定节点和 session，重建换绑后不会删除新会话节点。 */
    const pending = {
      requestGeneration: stopDeleteRequestGenerationRef.current + 1,
      canvasKey: stateKey,
      nodeId: selectedNode.id,
      sessionId: selectedNode.agentSessionId,
      startedAt,
      stopAccepted: false,
    }
    stopDeleteRequestGenerationRef.current = pending.requestGeneration
    setDeleteSubmitting(true)
    setDeleteError(null)
    replacePendingStopDelete(pending)
    void settleNativeCanvasStopDeleteAttempt(
      pending,
      adapter.stopCanvasAgent({ ...target, nodeId: selectedNode.id }),
      {
        getCurrentRequestGeneration: () => stopDeleteRequestGenerationRef.current,
        getPending: () => pendingStopDeleteRef.current,
        onAccepted: () => replacePendingStopDelete(
          createStopAcceptedPendingCanvasDelete(pendingStopDeleteRef.current, pending),
        ),
        onRejected: (error) => {
          invalidatePendingStopDelete()
          setDeleteSubmitting(false)
          setDeleteError(getNativeCanvasOperationErrorMessage('stop', error))
        },
      },
    )
  }, [
    adapter.stopCanvasAgent,
    canDeleteNode,
    commitBatchNodeDelete,
    commitNodeDelete,
    hasBusySelectedNode,
    optimisticRunGenerations,
    invalidatePendingStopDelete,
    replacePendingStopDelete,
    runGenerations,
    selectedNode,
    selectedNodes,
    stateKey,
    target,
  ])

  React.useEffect(() => {
    /** Delete/Backspace 与工具栏共用确认入口，编辑控件内部按键不拦截。 */
    const handleDeleteShortcut = (event: KeyboardEvent): void => {
      if (!isNativeCanvasDeleteShortcut({
        key: event.key,
        target: event.target as EventTarget & { closest?: (selector: string) => unknown },
      })) return
      if (!canDeleteNode || deleteDialogOpen) return
      event.preventDefault()
      requestSelectedNodeDelete()
    }
    window.addEventListener('keydown', handleDeleteShortcut)
    return () => window.removeEventListener('keydown', handleDeleteShortcut)
  }, [canDeleteNode, deleteDialogOpen, requestSelectedNodeDelete])

  React.useEffect(() => {
    /** Canvas 身份切换时本地弹窗和待停止删除不得跨工作区延续。 */
    workbenchDraftCommitCoordinatorRef.current?.invalidate()
    deleteGenerationRef.current += 1
    invalidatePendingStopDelete()
    deleteOperationRef.current = null
    batchDeleteOperationRef.current.clear()
    setSelectedNodeIds([])
    setDeleteDialogOpen(false)
    setDeleteSubmitting(false)
    setDeleteError(null)
    setTrashOpen(false)
    setTrashState({ entries: [], loading: false, restoringTrashId: null, error: null })
    setWorkbenchSwitchSaving(false)
    setWorkbenchSwitchError(null)
    return () => {
      /** Canvas 切换或真实卸载时同步失效 STOP，cleanup 不再触发 React state。 */
      stopDeleteRequestGenerationRef.current += 1
      pendingStopDeleteRef.current = null
    }
  }, [invalidatePendingStopDelete, stateKey])

  React.useEffect(() => {
    if (state.authoritativeRecoveryState === 'idle') return
    /** recovery 已改变权威工作台身份，旧草稿保存不得再产生结果。 */
    workbenchDraftCommitCoordinatorRef.current?.invalidate()
    setWorkbenchSwitchSaving(false)
    setWorkbenchSwitchError(null)
  }, [state.authoritativeRecoveryState])

  /** 聚焦第一个问题节点并打开局部恢复面板。 */
  const focusFirstIssue = React.useCallback((): void => {
    const issue = state.snapshot?.nodeIssues[0]
    if (!issue) return
    updateNativeCanvasState({
      key: stateKey,
      update: (current) => ({
        selectedNodeId: issue.nodeId,
        ...createNativeCanvasWorkbenchChangeUpdate(current, issue.nodeId),
      }),
    })
  }, [state.snapshot?.nodeIssues, stateKey, updateNativeCanvasState])

  /** 重建入口只调用当前问题节点绑定的可取消命令。 */
  const rebuildConversationNode = React.useCallback((): void => {
    if (!rebuildCommandRef.current) {
      setRebuildState({ loading: false, error: '重建功能暂时不可用。' })
      return
    }
    void rebuildCommandRef.current.execute().catch(() => undefined)
  }, [])

  /** 为唯一展开节点构造轻量工作台；Agent 对话仅在这里按需挂载。 */
  const renderNodeWorkbench = React.useCallback((node: CanvasNode): React.ReactNode => {
    /** dirty 只属于当前节点，不随工作台切换复制。 */
    const dirty = state.workbenchDraft?.nodeId === node.id && state.workbenchDraft.dirty
    /** Agent 故障与健康对话共用同一个节点锚定壳。 */
    let content: React.ReactNode
    if (node.kind === 'agent') {
      const issue = state.snapshot?.nodeIssues.find((current) => current.nodeId === node.id)
      if (issue) {
        content = (
          <CanvasAgentRecoveryPanel
            key={`${target.projectId}:${target.canvasId}:${node.id}:recovery`}
            title={node.title}
            rebuilding={rebuildState.loading}
            error={rebuildState.error}
            onRebuild={rebuildConversationNode}
            onDelete={requestSelectedNodeDelete}
            onClose={closeWorkbench}
          />
        )
      } else if (conversationAdapter) {
        content = (
          <ConversationRenderer
            key={`${target.projectId}:${target.canvasId}:${node.id}`}
            target={{ ...target, nodeId: node.id }}
            title={node.title}
            adapter={conversationAdapter}
            onClose={closeWorkbench}
          />
        )
      }
    } else if (node.kind === 'image' && imageWorkbenchAdapter) {
      content = (
        <CanvasImageNodeWorkbench
          key={`${target.projectId}:${target.canvasId}:${node.id}:image`}
          node={node}
          target={target}
          writable={workspaceWritable}
          adapter={imageWorkbenchAdapter}
          autoSaveEnabled={state.pendingWorkbenchSwitchNodeId === null}
          onDirtyChange={updateWorkbenchDirty}
          onRegisterDraftCommitter={registerWorkbenchDraftCommitter}
        />
      )
    }
    return (
      <CanvasNodeWorkbenchOverlay
        node={node}
        dirty={dirty}
        onDirtyChange={(nextDirty) => updateWorkbenchDirty(node.id, nextDirty)}
        onClose={closeWorkbench}
      >
        {content}
      </CanvasNodeWorkbenchOverlay>
    )
  }, [
    ConversationRenderer,
    closeWorkbench,
    conversationAdapter,
    imageWorkbenchAdapter,
    registerWorkbenchDraftCommitter,
    rebuildConversationNode,
    rebuildState.error,
    rebuildState.loading,
    requestSelectedNodeDelete,
    state.snapshot?.nodeIssues,
    state.workbenchDraft,
    stateKey,
    target,
    updateWorkbenchDirty,
    workspaceWritable,
  ])

  return (
    <section
      className="flex h-full min-h-0 flex-col bg-content-area"
      data-native-canvas-workspace
      data-project-id={target.projectId}
      data-canvas-id={target.canvasId}
    >
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-4">
        <h1 className="truncate text-sm font-medium text-foreground">{title}</h1>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          className="ml-auto"
          aria-label="打开回收区"
          disabled={!adapter.listCanvasTrash || !adapter.restoreCanvasNode}
          onClick={() => {
            setTrashOpen(true)
            void trashControllerRef.current?.load()
          }}
        >
          <ArchiveRestore aria-hidden="true" />
        </Button>
      </header>
      <div className="min-h-0 flex-1">
        {(state.phase === 'idle' || state.phase === 'loading') && !state.snapshot ? (
          <div className="flex h-full items-center justify-center text-muted-foreground" aria-label="正在加载 Canvas">
            <LoaderCircle className="size-5 animate-spin" aria-hidden="true" />
          </div>
        ) : state.phase === 'error' && !state.snapshot ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
            <p className="text-sm text-destructive">{state.error ?? 'Canvas 加载失败'}</p>
            <Button size="sm" variant="outline" onClick={() => controllerRef.current?.retryLoad()}>
              <RotateCcw className="mr-1.5 size-4" aria-hidden="true" />
              重试
            </Button>
          </div>
        ) : state.snapshot ? (
          <div className="relative h-full">
            <div
              ref={canvasSurfaceRef}
              data-native-canvas-surface
              className="relative h-full min-w-0"
            >
              <NativeCanvasToolbar
                activeTool={state.activeTool}
                writable={workspaceWritable}
                canAdd={canCreateNode}
                canDelete={canDeleteNode}
                issueCount={state.snapshot.nodeIssues.length}
                onToolChange={(activeTool) => updateNativeCanvasState({
                  key: stateKey,
                  update: { activeTool },
                })}
                onAddNode={(kind) => runNativeCanvasToolbarAddNode(kind, (request) => {
                  void commandRef.current?.execute(request).catch(() => undefined)
                })}
                onDelete={requestSelectedNodeDelete}
                onFocusFirstIssue={focusFirstIssue}
              />
              <NativeCanvasGraph
                document={state.snapshot.document}
                writable={workspaceWritable}
                activeTool={state.activeTool}
                nodeIssues={state.snapshot.nodeIssues}
                runningSessionIds={runningSessionIds}
                imagePreviewUrls={imagePreviewUrls}
                canCreateChild={canCreateNode}
                onCreateChild={(sourceNodeId, kind) => {
                  void commandRef.current?.execute({ kind, sourceNodeId }).catch(() => undefined)
                }}
                selectedNodeId={state.selectedNodeId}
                selectedNodeIds={validSelectedNodeIds}
                onMutation={(mutation) => controllerRef.current?.enqueueMutation(mutation)}
                onNodeSelect={(selectedNodeId) => updateNativeCanvasState({
                  key: stateKey,
                  update: { selectedNodeId },
                })}
                onNodeSelectionChange={(nodeIds) => {
                  /** Graph 是完整选区来源，首个节点继续同步给详情兼容状态。 */
                  setSelectedNodeIds([...nodeIds])
                  updateNativeCanvasState({
                    key: stateKey,
                    update: { selectedNodeId: nodeIds[0] ?? null },
                  })
                }}
                onConversationNodeChange={() => undefined}
                onWorkbenchNodeChange={requestWorkbenchNodeChange}
                expandedNodeId={state.expandedNodeId}
                renderWorkbench={renderNodeWorkbench}
                flowRenderer={flowRenderer}
              />
            </div>
            {createState.error ? (
              <div className="absolute left-1/2 top-14 z-10 max-w-[calc(100%-1.5rem)] -translate-x-1/2 rounded-[6px] border border-destructive/30 bg-background/95 px-3 py-2 text-xs text-destructive shadow-sm" role="status">
                {createState.error}
              </div>
            ) : null}
            {state.saveState === 'conflict' ? (
              <div className="absolute inset-x-3 top-14 flex items-center justify-between gap-3 rounded-[8px] border border-destructive/30 bg-background/95 px-3 py-2 shadow-sm">
                <p className="truncate text-xs text-destructive">{state.error}</p>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => controllerRef.current?.acceptRemoteVersion()}
                >
                  采用远端版本
                </Button>
              </div>
            ) : (state.authoritativeRecoveryState === 'failed'
              || (state.saveState === 'failed' && state.authoritativeRecoveryState === 'idle')) ? (
              <div className="absolute inset-x-3 top-14 flex items-center justify-between gap-3 rounded-[8px] border border-destructive/30 bg-background/95 px-3 py-2 shadow-sm">
                <p className="truncate text-xs text-destructive">{state.error}</p>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    if (state.authoritativeRecoveryState === 'failed') controllerRef.current?.retryRecovery()
                    else controllerRef.current?.retrySave()
                  }}
                >
                  <RotateCcw className="mr-1.5 size-4" aria-hidden="true" />
                  重试
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      <NativeCanvasDeleteDialog
        open={deleteDialogOpen && selectedNodes.length > 0}
        nodeTitle={selectedNode?.title ?? ''}
        connectedEdgeCount={connectedEdgeCount}
        busy={selectedNodes.length === 1 && Boolean(selectedNodeBusy)}
        kind={selectedNode?.kind}
        selectedCount={selectedNodes.length}
        hasAgent={selectedNodes.some((node) => node.kind === 'agent')}
        hasContent={selectedNodes.some((node) => node.kind !== 'agent')}
        blockedMessage={selectedNodes.length > 1 && hasBusySelectedNode
          ? '选区中有正在运行的 Agent，请先单独停止后再批量删除。'
          : null}
        submitting={deleteSubmitting}
        error={deleteError}
        onOpenChange={(open) => {
          if (deleteSubmitting) return
          setDeleteDialogOpen(open)
          if (!open) {
            /** 用户取消批量操作后丢弃旧 revision operation，下一次按新选区重建。 */
            batchDeleteOperationRef.current.clear()
            setDeleteError(null)
          }
        }}
        onConfirm={confirmSelectedNodeDelete}
      />
      <NativeCanvasTrashDialog
        open={trashOpen}
        {...trashState}
        onOpenChange={(open) => {
          setTrashOpen(open)
          if (!open) trashControllerRef.current?.close()
        }}
        onRestore={(entry) => {
          void trashControllerRef.current?.restore(entry)
        }}
      />
      <Dialog
        open={state.pendingWorkbenchSwitchNodeId !== null}
        onOpenChange={(open) => {
          if (open || workbenchSwitchSaving) return
          workbenchDraftCommitCoordinatorRef.current?.invalidate()
          updateNativeCanvasState({
            key: stateKey,
            update: { pendingWorkbenchSwitchNodeId: null },
          })
          setWorkbenchSwitchError(null)
        }}
      >
        <DialogContent className="max-w-md" hideClose>
          <DialogHeader>
            <DialogTitle>
              {state.pendingWorkbenchSwitchNodeId === NATIVE_CANVAS_WORKBENCH_CLOSE_TARGET
                ? '关闭工作台？'
                : '切换工作台？'}
            </DialogTitle>
            <DialogDescription>
              当前工作台有未保存更改。请选择保存、放弃或取消操作。
            </DialogDescription>
          </DialogHeader>
          {!workbenchCommitAvailability.enabled ? (
            <p className="text-xs text-muted-foreground">
              {workbenchCommitAvailability.reason}
            </p>
          ) : null}
          {workbenchSwitchError ? (
            <p className="text-sm text-destructive" role="alert">{workbenchSwitchError}</p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              disabled={workbenchSwitchSaving}
              onClick={() => {
                workbenchDraftCommitCoordinatorRef.current?.invalidate()
                updateNativeCanvasState({
                  key: stateKey,
                  update: { pendingWorkbenchSwitchNodeId: null },
                })
              }}
            >
              取消
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={workbenchSwitchSaving}
              onClick={resolveWorkbenchSwitch}
            >
              {state.pendingWorkbenchSwitchNodeId === NATIVE_CANVAS_WORKBENCH_CLOSE_TARGET
                ? '放弃并关闭'
                : '放弃并切换'}
            </Button>
            <Button
              type="button"
              disabled={workbenchSwitchSaving || !workbenchCommitAvailability.enabled}
              onClick={saveAndSwitchWorkbench}
            >
              {workbenchSwitchSaving
                ? '正在保存'
                : state.pendingWorkbenchSwitchNodeId === NATIVE_CANVAS_WORKBENCH_CLOSE_TARGET
                  ? '保存并关闭'
                  : '保存并切换'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
