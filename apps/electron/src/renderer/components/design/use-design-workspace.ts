import * as React from 'react'
import type {
  DesignCanvasDocument,
  DesignChangeEvent,
  DesignMutation,
  DesignWorkspaceSnapshot,
} from '@proma/shared'
import { applyDesignEntityPatch } from '@proma/shared'
import { useAtomValue, useSetAtom, useStore } from 'jotai'
import { toast } from 'sonner'
import {
  createInitialDesignProjectState,
  designProjectStatesAtom,
  updateDesignProjectStateAtom,
} from '@/atoms/design-atoms'
import type { DesignProjectState } from '@/atoms/design-atoms'
import { designAdapter, type DesignAdapter } from '@/lib/design-adapter'

/** 防抖保存等待时间，连续编辑会合并为一个 revision 请求。 */
export const DESIGN_SAVE_DEBOUNCE_MS = 400
/** 主进程 revision 冲突错误的稳定识别码。 */
const DESIGN_REVISION_CONFLICT_CODE = 'DESIGN_REVISION_CONFLICT'
/** 主进程发现磁盘恢复后要求 Renderer 重新加载的稳定识别码。 */
const DESIGN_RECOVERY_REQUIRED_CODE = 'DESIGN_RECOVERY_REQUIRED'
/** 用户可理解的保存冲突提示。 */
const DESIGN_REVISION_CONFLICT_MESSAGE = '保存冲突：设计画布已在其他位置更新，请重试保存'
/** 结构 mutation 无法安全自动重放时的阻断提示。 */
const DESIGN_STRUCTURAL_CONFLICT_MESSAGE = '保存冲突：远端画布结构已更新，本地结构修改未自动应用，请基于远端版本重新编辑'
/** 已向用户提示过的恢复快照，避免 React 重渲染重复 toast。 */
const shownRecoveryNotices = new Set<string>()

/** 将未知错误转换为可稳定展示的中文错误文本。 */
function getDesignErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '设计工作区操作失败'
}

/**
 * 判断保存错误是否为 revision 冲突。
 * @param error adapter.save 拒绝的未知错误。
 * @returns 错误文本包含稳定冲突码时返回 true。
 */
function isDesignRevisionConflict(error: unknown): boolean {
  return error instanceof Error && error.message.includes(DESIGN_REVISION_CONFLICT_CODE)
}

/**
 * 判断保存错误是否要求重新加载恢复后的权威画布。
 * @param error adapter.save 拒绝的未知错误。
 * @returns 错误文本包含稳定恢复码时返回 true。
 */
export function isDesignRecoveryRequired(error: unknown): boolean {
  return error instanceof Error && error.message.includes(DESIGN_RECOVERY_REQUIRED_CODE)
}

/** 判断远端事件是否可安全替换当前快照。 */
export function shouldRefreshDesignSnapshot(
  projectId: string,
  state: DesignProjectState,
  change: DesignChangeEvent,
): boolean {
  return change.projectId === projectId
    && state.pendingMutations.length === 0
    && state.saveState === 'saved'
    && change.revision > (state.snapshot?.document.revision ?? -1)
}

/**
 * 判断异步加载结果是否仍可写入当前项目状态。
 * @param state Promise 返回时读取到的最新项目状态。
 * @param snapshot 本次加载返回的服务端快照。
 * @param requestSequence 本次加载请求的递增序号。
 * @param latestRequestSequence 当前项目最后发起的加载请求序号。
 * @returns 仅当结果仍是最新请求且不会覆盖本地编辑时返回 true。
 */
export function shouldApplyLoadedDesignSnapshot(
  state: DesignProjectState,
  snapshot: DesignWorkspaceSnapshot,
  requestSequence: number,
  latestRequestSequence: number,
): boolean {
  const currentRevision = state.snapshot?.document.revision ?? -1
  return requestSequence === latestRequestSequence
    && state.pendingMutations.length === 0
    && state.saveState === 'saved'
    && snapshot.document.revision >= currentRevision
}

/**
 * 判断权威快照是否替换了当前编辑历史依赖的文档基线。
 * @param state Promise 返回时读取到的最新项目状态。
 * @param snapshot 本次加载返回的权威快照。
 * @returns 首次加载、恢复快照或文档内容变化时返回 true。
 */
export function shouldResetDesignHistoryForSnapshot(
  state: DesignProjectState,
  snapshot: DesignWorkspaceSnapshot,
): boolean {
  const currentDocument = state.snapshot?.document
  return !currentDocument
    || Boolean(snapshot.recoveredFrom)
    || JSON.stringify(currentDocument) !== JSON.stringify(snapshot.document)
}

/**
 * 接管新 load 的媒体与可写状态元数据，同时保留本地乐观 document。
 * @param localSnapshot 当前缓存及其不可覆盖的本地 document。
 * @param loadedSnapshot 新 load 返回的媒体授权与状态元数据。
 * @returns 使用新元数据但保持本地 document 引用的快照。
 */
export function mergeLoadedDesignSnapshotMetadata(
  localSnapshot: DesignWorkspaceSnapshot,
  loadedSnapshot: DesignWorkspaceSnapshot,
): DesignWorkspaceSnapshot {
  return { ...loadedSnapshot, document: localSnapshot.document }
}

/**
 * 按稳定 ID 合并画布实体，保留未更新实体的原有顺序。
 * @param current 服务端基线中的现有实体。
 * @param updates 本地 mutation 中需要新增或替换的实体。
 * @returns 合并后的新实体数组。
 */
function upsertDesignEntities<T extends { id: string }>(current: T[], updates: T[]): T[] {
  /** 以现有顺序初始化，并让同 ID 更新覆盖原值。 */
  const entities = new Map(current.map((item) => [item.id, item]))
  for (const update of updates) entities.set(update.id, update)
  return [...entities.values()]
}

/**
 * 在 renderer 内以纯函数方式依次应用全部受控 Design mutation。
 * @param document 服务端返回的权威画布基线。
 * @param mutations 保存期间尚未提交、需要按顺序重放的变更。
 * @returns 不修改输入对象的新画布文档。
 */
export function applyDesignMutationsToDocument(
  document: DesignCanvasDocument,
  mutations: DesignMutation[],
): DesignCanvasDocument {
  /** 深拷贝基线，避免重放过程修改 adapter 返回对象。 */
  let next = structuredClone(document)
  for (const mutation of mutations) {
    switch (mutation.type) {
      case 'set-viewport':
        next.viewport = mutation.viewport
        break
      case 'move-nodes': {
        /** 索引本次移动的目标位置，避免为每个节点重复扫描 mutation。 */
        const positions = new Map(mutation.positions.map((item) => [item.nodeId, item.position]))
        next.nodes = next.nodes.map((node) => positions.has(node.id)
          ? { ...node, position: positions.get(node.id)! }
          : node)
        break
      }
      case 'upsert-nodes':
        next.nodes = upsertDesignEntities(next.nodes, mutation.nodes)
        break
      case 'remove-nodes': {
        /** 待删除节点 ID 集合，用于线性过滤现有节点。 */
        const removedIds = new Set(mutation.nodeIds)
        next.nodes = next.nodes.filter((node) => !removedIds.has(node.id))
        break
      }
      case 'patch-nodes':
        next.nodes = applyDesignEntityPatch(next.nodes, mutation.removeIds, mutation.upserts)
        break
      case 'upsert-assets':
        next.assets = upsertDesignEntities(next.assets, mutation.assets)
        break
      case 'remove-assets': {
        /** 待删除素材 ID 集合，用于线性过滤现有素材。 */
        const removedIds = new Set(mutation.assetIds)
        next.assets = next.assets.filter((asset) => !removedIds.has(asset.id))
        break
      }
      case 'upsert-groups':
        next.groups = upsertDesignEntities(next.groups, mutation.groups)
        break
      case 'remove-groups': {
        /** 待删除分组 ID 集合，用于线性过滤现有分组。 */
        const removedIds = new Set(mutation.groupIds)
        next.groups = next.groups.filter((group) => !removedIds.has(group.id))
        break
      }
      case 'patch-groups':
        next.groups = applyDesignEntityPatch(next.groups, mutation.removeIds, mutation.upserts)
        break
      case 'upsert-annotations':
        next.annotations = upsertDesignEntities(next.annotations, mutation.annotations)
        break
      case 'remove-annotations': {
        /** 待删除批注 ID 集合，用于线性过滤现有批注。 */
        const removedIds = new Set(mutation.annotationIds)
        next.annotations = next.annotations.filter((annotation) => !removedIds.has(annotation.id))
        break
      }
      case 'patch-annotations':
        next.annotations = applyDesignEntityPatch(next.annotations, mutation.removeIds, mutation.upserts)
        break
    }
  }
  return next
}

/**
 * 合并服务端保存确认与保存期间继续产生的本地 mutation。
 * @param savedDocument 服务端确认本批 mutation 并完成 rebase 后返回的文档。
 * @param pendingMutations Promise 返回时仍未提交的本地 mutation。
 * @returns 以服务端结果为基线重放 pending mutation 后的画布文档。
 */
export function mergeSavedDesignDocument(
  savedDocument: DesignCanvasDocument,
  pendingMutations: DesignMutation[],
): DesignCanvasDocument {
  return applyDesignMutationsToDocument(savedDocument, pendingMutations)
}

/**
 * 准备失败保存的再次自动提交状态。
 * @param state 当前项目状态，用于判断是否处于可重试的失败阶段。
 * @returns 仅包含保存重试所需字段的局部状态。
 */
export function prepareFailedSaveRetry(state: DesignProjectState): Partial<DesignProjectState> {
  return state.saveState === 'failed'
    ? { saveState: 'dirty', error: null }
    : {}
}

/** 保存失败时把旧批次放回队首，保持用户操作顺序。 */
export function restoreFailedMutationBatch(
  failedBatch: DesignMutation[],
  currentPending: DesignMutation[],
): DesignMutation[] {
  return [...failedBatch, ...currentPending]
}

/**
 * 判断一批 mutation 是否只包含主进程允许自动 rebase 的位置类变更。
 * @param mutations 冲突后待处理的完整本地 mutation 队列。
 * @returns 仅全部为视口或节点移动时返回 true。
 */
export function canAutomaticallyRebaseDesignMutations(mutations: DesignMutation[]): boolean {
  return mutations.every((mutation) => (
    mutation.type === 'set-viewport' || mutation.type === 'move-nodes'
  ))
}

/** 判断当前项目是否已接管远端基线并等待用户放弃本地结构冲突修改。 */
export function isDesignStructuralConflictBlocked(state: DesignProjectState): boolean {
  return state.conflictRecoveryPending
    && state.saveState === 'failed'
    && state.error === DESIGN_STRUCTURAL_CONFLICT_MESSAGE
}

/** Controller 可写入的项目局部状态或基于最新状态的更新函数。 */
export type DesignProjectStateUpdate = Partial<DesignProjectState>
  | ((current: DesignProjectState) => Partial<DesignProjectState>)

/** 可注入的保存防抖调度器，测试无需真实浏览器时钟。 */
export interface DesignWorkspaceScheduler {
  /** 安排延迟任务并返回可取消 ID。 */
  setTimeout: (callback: () => void, delayMs: number) => number
  /** 取消尚未执行的延迟任务。 */
  clearTimeout: (timerId: number) => void
}

/** Design 生命周期 controller 的外部依赖。 */
export interface DesignWorkspaceControllerDependencies {
  /** 当前项目稳定 ID。 */
  projectId: string
  /** Renderer Design adapter。 */
  adapter: Pick<DesignAdapter, 'load' | 'save' | 'onChanged' | 'releaseMediaAccess'>
  /** 读取当前项目最新状态。 */
  getState: () => DesignProjectState
  /** 原子应用项目局部状态更新。 */
  updateState: (update: DesignProjectStateUpdate) => void
  /** 保存防抖调度器。 */
  scheduler: DesignWorkspaceScheduler
  /** 快照恢复后发出一次性用户提示。 */
  onRecovered?: (snapshot: DesignWorkspaceSnapshot) => void
  /** 媒体访问释放失败时上报原始错误。 */
  onReleaseError: (error: unknown) => void
}

/** 无 React 依赖的 Design 工作区生命周期控制器。 */
export interface DesignWorkspaceController {
  /** 启动首次加载与远端变化订阅。 */
  start: () => void
  /** 根据最新项目状态安排或取消保存。 */
  sync: () => void
  /** 重试首次加载。 */
  retryLoad: () => void
  /** 重试失败保存。 */
  retrySave: () => void
  /** 放弃本地结构冲突修改并采用已加载的远端版本。 */
  acceptRemoteVersion: () => void
  /** 释放订阅、定时器与媒体访问权限。 */
  dispose: () => void
}

/**
 * 创建可独立测试的 Design 工作区生命周期控制器。
 * @param dependencies adapter、状态存取、调度器与提示回调。
 * @returns 由 hook 启停和同步的 controller。
 */
export function createDesignWorkspaceController(
  dependencies: DesignWorkspaceControllerDependencies,
): DesignWorkspaceController {
  /** 最后发起的 load 序号，用于丢弃乱序返回。 */
  let latestLoadSequence = 0
  /** 当前远端变化订阅的释放函数。 */
  let unsubscribe: (() => void) | null = null
  /** 当前尚未触发的保存防抖定时器 ID。 */
  let saveTimerId: number | null = null
  /** 标记 controller 已释放，阻止后续 load 与 timer 副作用。 */
  let disposed = false
  /** 当前 controller 是否已有冲突恢复 load 在途，避免重复请求。 */
  let conflictRecoveryInFlight = false

  /**
   * 加载并按返回时最新状态决定是否提交快照。
   * @param rebasePendingAfterConflict 是否以远端 document 重放冲突后全部 pending。
   * @returns 本次加载及状态提交完成后的 Promise。
   */
  const loadSnapshot = async (rebasePendingAfterConflict = false): Promise<void> => {
    if (disposed) return
    if (rebasePendingAfterConflict && conflictRecoveryInFlight) return
    if (rebasePendingAfterConflict) conflictRecoveryInFlight = true
    /** 本次 load 的稳定递增序号。 */
    const requestSequence = latestLoadSequence + 1
    latestLoadSequence = requestSequence
    if (!dependencies.getState().snapshot) {
      dependencies.updateState({ phase: 'loading', error: null })
    }
    try {
      /** adapter 返回的项目快照。 */
      const snapshot = await dependencies.adapter.load(dependencies.projectId)
      if (disposed) return
      /** Promise 返回时读取的最新项目状态。 */
      const latest = dependencies.getState()
      if (requestSequence !== latestLoadSequence) return
      if (rebasePendingAfterConflict) {
        if (!canAutomaticallyRebaseDesignMutations(latest.pendingMutations)) {
          /** 结构 patch 携带旧实体快照，必须完整采用远端文档以免覆盖并发修改。 */
          dependencies.updateState({
            phase: 'ready',
            snapshot,
            history: [],
            future: [],
            saveState: 'failed',
            conflictRecoveryPending: true,
            error: DESIGN_STRUCTURAL_CONFLICT_MESSAGE,
          })
          if (snapshot.recoveredFrom) dependencies.onRecovered?.(snapshot)
          return
        }
        /** 远端最新 document 重放当前全部 pending 后的乐观文档。 */
        const rebasedDocument = mergeSavedDesignDocument(snapshot.document, latest.pendingMutations)
        dependencies.updateState({
          phase: 'ready',
          snapshot: { ...snapshot, document: rebasedDocument },
          history: [],
          future: [],
          saveState: 'failed',
          conflictRecoveryPending: false,
          error: DESIGN_REVISION_CONFLICT_MESSAGE,
        })
        if (snapshot.recoveredFrom) dependencies.onRecovered?.(snapshot)
        return
      }
      if (!shouldApplyLoadedDesignSnapshot(
        latest,
        snapshot,
        requestSequence,
        latestLoadSequence,
      )) {
        if (!latest.snapshot) return
        dependencies.updateState({
          phase: 'ready',
          snapshot: mergeLoadedDesignSnapshotMetadata(latest.snapshot, snapshot),
        })
        if (snapshot.recoveredFrom) dependencies.onRecovered?.(snapshot)
        scheduleSave()
        return
      }
      /** 相同权威文档的普通 remount 保留该项目既有撤销与重做历史。 */
      const resetHistory = shouldResetDesignHistoryForSnapshot(latest, snapshot)
      dependencies.updateState({
        phase: 'ready',
        snapshot,
        ...(resetHistory ? { history: [], future: [] } : {}),
        error: null,
        saveState: 'saved',
      })
      if (snapshot.recoveredFrom) dependencies.onRecovered?.(snapshot)
    } catch (error) {
      if (disposed || requestSequence !== latestLoadSequence) return
      if (dependencies.getState().snapshot) return
      dependencies.updateState({ phase: 'error', error: getDesignErrorMessage(error) })
    } finally {
      if (rebasePendingAfterConflict) conflictRecoveryInFlight = false
    }
  }

  /** 取消尚未触发的保存任务。 */
  const clearSaveTimer = (): void => {
    if (saveTimerId === null) return
    dependencies.scheduler.clearTimeout(saveTimerId)
    saveTimerId = null
  }

  /** 判断最新状态是否具备自动保存条件。 */
  const canSave = (state: DesignProjectState): boolean => Boolean(
    state.snapshot
    && state.snapshot.writable
    && state.pendingMutations.length > 0
    && state.saveState !== 'saving'
    && state.saveState !== 'failed'
    && !state.conflictRecoveryPending
    && !conflictRecoveryInFlight,
  )

  /** 按最新状态重新安排一次 400ms 自动保存。 */
  const scheduleSave = (): void => {
    clearSaveTimer()
    if (disposed) return
    if (!canSave(dependencies.getState())) return
    saveTimerId = dependencies.scheduler.setTimeout(() => {
      saveTimerId = null
      if (disposed) return
      /** 定时器触发时再次读取的最新项目状态。 */
      const current = dependencies.getState()
      if (!current.snapshot || !canSave(current)) return
      /** 本次从 pending 队列移出的保存批次。 */
      const batch = current.pendingMutations
      /** 本批 mutation 基于的服务端 revision。 */
      const expectedRevision = current.snapshot.document.revision
      dependencies.updateState({ pendingMutations: [], saveState: 'saving', error: null })
      void dependencies.adapter.save({
        projectId: dependencies.projectId,
        expectedRevision,
        mutations: batch,
      }).then((savedDocument) => {
        dependencies.updateState((latest) => ({
          snapshot: latest.snapshot
            ? {
                ...latest.snapshot,
                document: mergeSavedDesignDocument(savedDocument, latest.pendingMutations),
              }
            : latest.snapshot,
          saveState: latest.pendingMutations.length > 0 ? 'dirty' : 'saved',
          error: null,
        }))
        scheduleSave()
      }).catch((error) => {
        /** revision 冲突与磁盘恢复都必须先基于新权威快照处理旧 batch。 */
        const recoveryRequired = isDesignRecoveryRequired(error)
        if (isDesignRevisionConflict(error) || recoveryRequired) {
          dependencies.updateState((latest) => ({
            pendingMutations: restoreFailedMutationBatch(batch, latest.pendingMutations),
            saveState: 'failed',
            conflictRecoveryPending: true,
            error: recoveryRequired ? getDesignErrorMessage(error) : DESIGN_REVISION_CONFLICT_MESSAGE,
          }))
          void loadSnapshot(true)
          return
        }
        dependencies.updateState((latest) => ({
          pendingMutations: restoreFailedMutationBatch(batch, latest.pendingMutations),
          saveState: 'failed',
          error: getDesignErrorMessage(error),
        }))
      })
    }, DESIGN_SAVE_DEBOUNCE_MS)
  }

  return {
    start: () => {
      if (disposed || unsubscribe) return
      unsubscribe = dependencies.adapter.onChanged((change) => {
        /** 事件到达时的最新项目状态。 */
        const latest = dependencies.getState()
        if (shouldRefreshDesignSnapshot(dependencies.projectId, latest, change)) void loadSnapshot()
      })
      /** mount 时优先恢复上个 controller 留下的 revision 冲突。 */
      const current = dependencies.getState()
      const recoverConflict = current.conflictRecoveryPending && !isDesignStructuralConflictBlocked(current)
      void loadSnapshot(recoverConflict)
    },
    sync: () => {
      if (disposed) return
      /** sync 时读取最新共享状态，接管其他 controller 异步留下的冲突恢复任务。 */
      const latest = dependencies.getState()
      if (isDesignStructuralConflictBlocked(latest)) {
        clearSaveTimer()
        return
      }
      if (latest.conflictRecoveryPending || conflictRecoveryInFlight) {
        void loadSnapshot(true)
        return
      }
      scheduleSave()
    },
    retryLoad: () => {
      if (disposed) return
      /** 重试前读取的最新状态，用于缓存画布保持 ready。 */
      const latest = dependencies.getState()
      if (isDesignStructuralConflictBlocked(latest)) return
      if (latest.conflictRecoveryPending || conflictRecoveryInFlight) {
        void loadSnapshot(true)
        return
      }
      dependencies.updateState({
        phase: latest.snapshot ? 'ready' : 'loading',
        error: null,
      })
      void loadSnapshot()
    },
    retrySave: () => {
      if (disposed) return
      /** retry 时的最新状态用于优先完成冲突恢复。 */
      const latest = dependencies.getState()
      if (isDesignStructuralConflictBlocked(latest)) return
      if (latest.conflictRecoveryPending || conflictRecoveryInFlight) {
        void loadSnapshot(true)
        return
      }
      dependencies.updateState((latest) => prepareFailedSaveRetry(latest))
      scheduleSave()
    },
    acceptRemoteVersion: () => {
      if (disposed) return
      /** 只有远端快照已接管后的明确结构冲突允许放弃本地队列。 */
      const latest = dependencies.getState()
      if (!isDesignStructuralConflictBlocked(latest)) return
      clearSaveTimer()
      dependencies.updateState({
        phase: 'ready',
        selectedNodeIds: [],
        inspectorAssetId: null,
        history: [],
        future: [],
        pendingMutations: [],
        saveState: 'saved',
        conflictRecoveryPending: false,
        error: null,
      })
    },
    dispose: () => {
      if (disposed) return
      disposed = true
      latestLoadSequence += 1
      clearSaveTimer()
      unsubscribe?.()
      unsubscribe = null
      void dependencies.adapter.releaseMediaAccess().catch((error) => dependencies.onReleaseError(error))
    },
  }
}

export interface UseDesignWorkspaceResult {
  /** 当前项目状态；未选择项目时为 null。 */
  state: DesignProjectState | null
  /** 重新加载当前项目，用于恢复加载错误。 */
  retry: () => void
  /** 将失败 mutation 恢复为 dirty，由 400ms 自动保存流程再次提交。 */
  retrySave: () => void
  /** 放弃本地结构冲突修改并采用已接管的远端版本。 */
  acceptRemoteVersion: () => void
}

/** 管理项目切换、远端 revision 订阅和 400ms mutation 自动保存。 */
export function useDesignWorkspace(
  projectId: string | null,
  adapter: DesignAdapter = designAdapter,
): UseDesignWorkspaceResult {
  const states = useAtomValue(designProjectStatesAtom)
  const updateProjectState = useSetAtom(updateDesignProjectStateAtom)
  const store = useStore()
  /** 当前项目的无 React 生命周期 controller。 */
  const controllerRef = React.useRef<DesignWorkspaceController | null>(null)
  /** 未初始化项目在首帧也返回稳定 loading 状态。 */
  const state = projectId
    ? states.get(projectId) ?? createInitialDesignProjectState()
    : null

  React.useEffect(() => {
    if (!projectId) {
      controllerRef.current = null
      return
    }
    /** 浏览器定时器适配为 controller 可注入 scheduler。 */
    const scheduler: DesignWorkspaceScheduler = {
      setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
      clearTimeout: (timerId) => window.clearTimeout(timerId),
    }
    /** 当前项目对应的 controller 实例。 */
    const controller = createDesignWorkspaceController({
      projectId,
      adapter,
      getState: () => store.get(designProjectStatesAtom).get(projectId)
        ?? createInitialDesignProjectState(),
      updateState: (update) => updateProjectState({ projectId, update }),
      scheduler,
      onRecovered: (snapshot) => {
        /** 项目、revision 与来源共同标识一次恢复提示。 */
        const noticeKey = `${projectId}:${snapshot.document.revision}:${snapshot.recoveredFrom}`
        if (shownRecoveryNotices.has(noticeKey)) return
        shownRecoveryNotices.add(noticeKey)
        toast.info('设计画布已从临时文件恢复')
      },
      onReleaseError: (error) => {
        console.warn('释放设计媒体访问权限失败', error)
      },
    })
    controllerRef.current = controller
    controller.start()

    return () => {
      controller.dispose()
      if (controllerRef.current === controller) controllerRef.current = null
    }
  }, [adapter, projectId, store, updateProjectState])

  /** Jotai 中的外部编辑发生后，由 controller 统一重置保存防抖。 */
  React.useEffect(() => {
    controllerRef.current?.sync()
  }, [
    projectId,
    state?.conflictRecoveryPending,
    state?.pendingMutations,
    state?.saveState,
    state?.snapshot,
  ])

  /** 仅重新加载当前项目，用于恢复首次加载错误。 */
  const retry = React.useCallback(() => {
    controllerRef.current?.retryLoad()
  }, [])

  /** 单独恢复失败保存，不触发快照重新加载。 */
  const retrySave = React.useCallback(() => {
    controllerRef.current?.retrySave()
  }, [])

  /** 明确采用远端基线，清理无法安全 rebase 的本地结构队列。 */
  const acceptRemoteVersion = React.useCallback(() => {
    controllerRef.current?.acceptRemoteVersion()
  }, [])

  return { state, retry, retrySave, acceptRemoteVersion }
}
