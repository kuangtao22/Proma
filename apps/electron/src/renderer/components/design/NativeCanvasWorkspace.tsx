import * as React from 'react'
import { applyCanvasMutations } from '@proma/shared'
import type {
  CanvasChangeEvent,
  CanvasDocument,
  CanvasMutation,
  CanvasTarget,
  CanvasWorkspaceSnapshot,
} from '@proma/shared'
import { useAtomValue, useSetAtom, useStore } from 'jotai'
import { LoaderCircle, RotateCcw } from 'lucide-react'
import {
  createInitialNativeCanvasState,
  createNativeCanvasKey,
  nativeCanvasStatesAtom,
  updateNativeCanvasStateAtom,
} from '@/atoms/native-canvas-atoms'
import type { NativeCanvasState } from '@/atoms/native-canvas-atoms'
import { Button } from '@/components/ui/button'
import { designAdapter } from '@/lib/design-adapter'
import type { DesignAdapter } from '@/lib/design-adapter'
import { NativeCanvasGraph } from './NativeCanvasGraph'
import type { NativeCanvasFlowRenderer } from './NativeCanvasGraph'
import {
  areNativeCanvasMutationsPositionOnly,
  coalesceNativeCanvasMutationsForSave,
  replayNativeCanvasPositionMutations,
} from './native-canvas-model'

/** 原生 Canvas 自动保存采用 400ms 尾触发。 */
export const NATIVE_CANVAS_SAVE_DEBOUNCE_MS = 400
/** 无法安全重放结构修改时显示的稳定冲突文本。 */
export const NATIVE_CANVAS_STRUCTURAL_CONFLICT_MESSAGE = 'Canvas 结构已在恢复期间变化，请处理本地结构冲突'

/** controller 使用的最小原生 Canvas adapter 合同。 */
export interface NativeCanvasAdapter {
  loadCanvas: DesignAdapter['loadCanvas']
  saveCanvas: DesignAdapter['saveCanvas']
  onCanvasChanged: DesignAdapter['onCanvasChanged']
}

/** 可注入的尾触发调度器。 */
export interface NativeCanvasScheduler {
  setTimeout: (callback: () => void, delayMs: number) => number
  clearTimeout: (timerId: number) => void
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
  dispose: () => void
}

/** 当前 controller 持有的单个在途保存批次。 */
interface ActiveNativeCanvasSave {
  generation: number
  batch: CanvasMutation[]
}

/** 将未知异常转换为稳定用户文本。 */
function getNativeCanvasErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Canvas 操作失败'
}

/** 创建无 React 依赖、绑定固定双身份的原生 Canvas controller。 */
export function createNativeCanvasWorkspaceController(
  dependencies: NativeCanvasWorkspaceControllerDependencies,
): NativeCanvasWorkspaceController {
  /** LOAD 与 SAVE 使用独立代次，互不错误取消。 */
  let loadGeneration = 0
  let saveGeneration = 0
  /** 当前远端变化订阅释放函数。 */
  let unsubscribe: (() => void) | null = null
  /** 尚未触发的 trailing save 任务。 */
  let saveTimerId: number | null = null
  /** 已从共享状态移出的在途 mutation 所有权。 */
  let activeSave: ActiveNativeCanvasSave | null = null
  /** controller 卸载后所有迟到回调均无副作用。 */
  let disposed = false

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

  /** 权威恢复成功后按位置/结构边界接管新快照。 */
  const applyAuthoritativeSnapshot = (snapshot: CanvasWorkspaceSnapshot): void => {
    const latest = dependencies.getState()
    const pending = latest.pendingMutations
    if (!areNativeCanvasMutationsPositionOnly(pending)) {
      dependencies.updateState({
        phase: 'ready',
        snapshot,
        inFlightMutations: [],
        saveState: 'conflict',
        selectedNodeId: null,
        conversationNodeId: null,
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
      authoritativeRecoveryState: 'idle',
      error: null,
    })
    scheduleSave()
  }

  /** 发起普通或权威 LOAD；每次新请求都使同类旧回调失效。 */
  const loadSnapshot = (authoritative: boolean): void => {
    if (disposed) return
    const generation = loadGeneration + 1
    loadGeneration = generation
    if (!authoritative && !dependencies.getState().snapshot) {
      dependencies.updateState({ phase: 'loading', error: null })
    }
    void dependencies.adapter.loadCanvas(dependencies.target).then((snapshot) => {
      if (disposed || generation !== loadGeneration) return
      if (authoritative || snapshot.recoveredFrom) {
        applyAuthoritativeSnapshot(snapshot)
        return
      }
      /** 普通图刷新保留本窗口尚未提交的乐观 mutation。 */
      const latest = dependencies.getState()
      const localMutations = [...latest.inFlightMutations, ...latest.pendingMutations]
      const document = applyCanvasMutations(snapshot.document, localMutations)
      dependencies.updateState({
        phase: 'ready',
        snapshot: { ...snapshot, document },
        saveState: localMutations.length > 0 ? latest.saveState : 'saved',
        error: null,
      })
    }).catch((error: unknown) => {
      if (disposed || generation !== loadGeneration) return
      if (authoritative) {
        dependencies.updateState((latest) => ({
          phase: latest.snapshot ? 'ready' : 'error',
          saveState: 'failed',
          authoritativeRecoveryState: 'failed',
          error: `恢复 Canvas 失败：${getNativeCanvasErrorMessage(error)}`,
        }))
        return
      }
      dependencies.updateState({ phase: 'error', error: getNativeCanvasErrorMessage(error) })
    })
  }

  /** 开始权威恢复：先归还在途所有权，再失效旧 SAVE 与 LOAD 回调。 */
  const startAuthoritativeRecovery = (): void => {
    if (disposed) return
    clearSaveTimer()
    restoreActiveSave()
    saveGeneration += 1
    dependencies.updateState((latest) => ({
      phase: latest.snapshot ? 'ready' : 'loading',
      inFlightMutations: [],
      saveState: 'failed',
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
        activeSave = null
        dependencies.updateState((latest) => ({
          pendingMutations: [...batch, ...latest.pendingMutations],
          inFlightMutations: [],
          saveState: 'failed',
          error: getNativeCanvasErrorMessage(error),
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
        /** 普通图事件只在 revision 单调前进时刷新。 */
        const currentRevision = dependencies.getState().snapshot?.document.revision ?? -1
        if (event.revision > currentRevision) loadSnapshot(false)
      })
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
    dispose: () => {
      if (disposed) return
      clearSaveTimer()
      /** 归还在途 batch 后再使旧回调失效，避免 mutation 丢失或重复归还。 */
      restoreActiveSave()
      disposed = true
      loadGeneration += 1
      saveGeneration += 1
      unsubscribe?.()
      unsubscribe = null
    },
  }
}

/** 原生 Canvas React 壳输入。 */
export interface NativeCanvasWorkspaceProps {
  target: CanvasTarget
  title: string
  adapter?: NativeCanvasAdapter
  flowRenderer?: NativeCanvasFlowRenderer
}

/** 将隔离 Jotai 状态绑定到纯 controller，并渲染当前加载阶段。 */
export function NativeCanvasWorkspace({
  target,
  title,
  adapter = designAdapter,
  flowRenderer,
}: NativeCanvasWorkspaceProps): React.ReactElement {
  /** 双身份 key 决定唯一状态与 effect 生命周期。 */
  const stateKey = createNativeCanvasKey(target.projectId, target.canvasId)
  const states = useAtomValue(nativeCanvasStatesAtom)
  const updateNativeCanvasState = useSetAtom(updateNativeCanvasStateAtom)
  const store = useStore()
  const controllerRef = React.useRef<NativeCanvasWorkspaceController | null>(null)
  /** SSR 首帧使用该 key 专属的全新状态，不启动任何消息或 Canvas API。 */
  const fallbackState = React.useMemo(createInitialNativeCanvasState, [stateKey])
  const state = states.get(stateKey) ?? fallbackState

  React.useEffect(() => {
    /** 浏览器调度器仅在 effect 内创建，SSR 不触发副作用。 */
    const scheduler: NativeCanvasScheduler = {
      setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
      clearTimeout: (timerId) => window.clearTimeout(timerId),
    }
    const controller = createNativeCanvasWorkspaceController({
      target,
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

  return (
    <section
      className="flex h-full min-h-0 flex-col bg-content-area"
      data-native-canvas-workspace
      data-project-id={target.projectId}
      data-canvas-id={target.canvasId}
    >
      <header className="flex h-11 shrink-0 items-center border-b border-border px-4">
        <h1 className="truncate text-sm font-medium text-foreground">{title}</h1>
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
            <NativeCanvasGraph
              document={state.snapshot.document}
              writable={state.authoritativeRecoveryState === 'idle' && state.saveState !== 'conflict'}
              selectedNodeId={state.selectedNodeId}
              onMutation={(mutation) => controllerRef.current?.enqueueMutation(mutation)}
              onNodeSelect={(selectedNodeId, conversationNodeId) => updateNativeCanvasState({
                key: stateKey,
                update: { selectedNodeId, conversationNodeId },
              })}
              flowRenderer={flowRenderer}
            />
            {(state.authoritativeRecoveryState === 'failed'
              || (state.saveState === 'failed' && state.authoritativeRecoveryState === 'idle')) ? (
              <div className="absolute inset-x-3 top-3 flex items-center justify-between gap-3 rounded-[8px] border border-destructive/30 bg-background/95 px-3 py-2 shadow-sm">
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
    </section>
  )
}
