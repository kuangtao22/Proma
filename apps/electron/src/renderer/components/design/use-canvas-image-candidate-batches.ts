import * as React from 'react'
import type {
  AdoptCanvasImageCandidateBatchInput,
  CanvasImageCandidateBatch,
  CanvasImageCandidateBatchSummary,
  GetCanvasImageCandidateBatchInput,
} from '@proma/shared'
import { atom, useAtomValue, useSetAtom, useStore } from 'jotai'

/** Renderer 只依赖候选批次四个命令，不直接依赖完整 Design Adapter。 */
export interface CanvasImageCandidateBatchAdapter {
  getCanvasImageCandidateBatch: (input: GetCanvasImageCandidateBatchInput) => Promise<CanvasImageCandidateBatch>
  continueCanvasImageCandidateBatch: (input: GetCanvasImageCandidateBatchInput) => Promise<CanvasImageCandidateBatch>
  adoptCanvasImageCandidateBatch: (input: AdoptCanvasImageCandidateBatchInput) => Promise<CanvasImageCandidateBatch>
  abandonCanvasImageCandidateBatch: (input: GetCanvasImageCandidateBatchInput) => Promise<CanvasImageCandidateBatch>
}

/** 完整批次详情的局部读取阶段。 */
export type CanvasImageCandidateBatchPhase = 'idle' | 'loading' | 'ready' | 'error'

/** 批次写操作互斥状态，防止重复付费或重复采用。 */
export type CanvasImageCandidateBatchOperation = 'idle' | 'continuing' | 'adopting' | 'abandoning'

/** 单个候选批次在 Renderer 的按需详情状态。 */
export interface CanvasImageCandidateBatchViewState {
  phase: CanvasImageCandidateBatchPhase
  batch: CanvasImageCandidateBatch | null
  error: string | null
  operation: CanvasImageCandidateBatchOperation
}

/** 创建不会共享可变引用的初始批次状态。 */
export function createInitialCanvasImageCandidateBatchState(): CanvasImageCandidateBatchViewState {
  return { phase: 'idle', batch: null, error: null, operation: 'idle' }
}

/** 从初始 LOAD 的轻量摘要中定位节点最近一个活跃候选批次。 */
export function findCanvasImageCandidateBatchSummary(
  summaries: readonly CanvasImageCandidateBatchSummary[],
  nodeId: string,
): CanvasImageCandidateBatchSummary | undefined {
  return summaries.find((summary) => summary.entries.some((entry) => entry.nodeId === nodeId))
}

/** 不加载批次详情即可派生折叠图片卡片的候选标记。 */
export function getCanvasImageCandidateNodeState(
  summaries: readonly CanvasImageCandidateBatchSummary[],
  nodeId: string,
): 'new-version' | 'partial' | undefined {
  const summary = findCanvasImageCandidateBatchSummary(summaries, nodeId)
  const entry = summary?.entries.find((candidate) => candidate.nodeId === nodeId)
  if (!summary || !entry) return undefined
  if (entry.status === 'failed' || entry.status === 'invalid' || summary.status === 'partial') return 'partial'
  return entry.status === 'candidate' ? 'new-version' : undefined
}

/** 批次状态只按完整项目、画布与批次身份隔离。 */
function createCanvasImageCandidateBatchKey(summary: CanvasImageCandidateBatchSummary): string {
  return JSON.stringify([summary.projectId, summary.canvasId, summary.batchId])
}

/** 文件内 Jotai Map 避免详情状态污染 Canvas graph 或 Workspace snapshot。 */
const canvasImageCandidateBatchStatesAtom = atom<ReadonlyMap<string, CanvasImageCandidateBatchViewState>>(new Map())

/** 原子更新单个批次状态的写 atom。 */
const updateCanvasImageCandidateBatchStateAtom = atom(
  null,
  (get, set, input: {
    key: string
    update: (current: CanvasImageCandidateBatchViewState) => CanvasImageCandidateBatchViewState
  }) => {
    const current = get(canvasImageCandidateBatchStatesAtom)
    const next = new Map(current)
    next.set(input.key, input.update(current.get(input.key) ?? createInitialCanvasImageCandidateBatchState()))
    set(canvasImageCandidateBatchStatesAtom, next)
  },
)

/** Controller 使用的状态更新函数。 */
export type CanvasImageCandidateBatchStateUpdate = (
  current: CanvasImageCandidateBatchViewState,
) => CanvasImageCandidateBatchViewState

/** 与 React 生命周期解耦的批次 controller 依赖。 */
export interface CanvasImageCandidateBatchControllerDependencies {
  summary: CanvasImageCandidateBatchSummary
  adapter: CanvasImageCandidateBatchAdapter
  getState: () => CanvasImageCandidateBatchViewState
  updateState: (update: CanvasImageCandidateBatchStateUpdate) => void
  /** 写成功后通知宿主执行一次 Canvas 权威刷新。 */
  onBatchChanged?: (batch: CanvasImageCandidateBatch) => void | Promise<void>
}

/** 图片候选批次对工作台公开的稳定命令。 */
export interface CanvasImageCandidateBatchController {
  load: () => Promise<CanvasImageCandidateBatch | null>
  continueBatch: () => Promise<CanvasImageCandidateBatch | null>
  adopt: (mode: AdoptCanvasImageCandidateBatchInput['mode']) => Promise<CanvasImageCandidateBatch | null>
  abandon: () => Promise<CanvasImageCandidateBatch | null>
  dispose: () => void
}

/** 把未知失败压缩为不泄露内部结构的可见文本。 */
function getCandidateBatchErrorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : '候选批次操作失败，请重试。'
}

/** 创建具备惰性读取、迟到结果隔离和写操作互斥的批次 controller。 */
export function createCanvasImageCandidateBatchController(
  dependencies: CanvasImageCandidateBatchControllerDependencies,
): CanvasImageCandidateBatchController {
  const target: GetCanvasImageCandidateBatchInput = {
    projectId: dependencies.summary.projectId,
    canvasId: dependencies.summary.canvasId,
    batchId: dependencies.summary.batchId,
  }
  /** 失效或后发请求会淘汰旧异步结果。 */
  let generation = 0
  let disposed = false

  /** 执行批次写动作并只接管当前代次返回的权威事实。 */
  const runOperation = async (
    operation: Exclude<CanvasImageCandidateBatchOperation, 'idle'>,
    effect: () => Promise<CanvasImageCandidateBatch>,
  ): Promise<CanvasImageCandidateBatch | null> => {
    if (disposed || dependencies.getState().operation !== 'idle') return null
    generation += 1
    const currentGeneration = generation
    dependencies.updateState((current) => ({ ...current, operation, error: null }))
    try {
      const batch = await effect()
      if (disposed || generation !== currentGeneration) return null
      dependencies.updateState((current) => ({ ...current, phase: 'ready', batch, operation: 'idle', error: null }))
      try {
        await dependencies.onBatchChanged?.(batch)
      } catch {
        /** 批次写已经成功，宿主刷新失败不能把已提交操作伪装成失败。 */
      }
      return batch
    } catch (error) {
      if (disposed || generation !== currentGeneration) return null
      dependencies.updateState((current) => ({
        ...current,
        phase: current.batch ? 'ready' : 'error',
        operation: 'idle',
        error: getCandidateBatchErrorMessage(error),
      }))
      return null
    }
  }

  return {
    load: async () => {
      if (disposed) return null
      generation += 1
      const currentGeneration = generation
      dependencies.updateState((current) => ({ ...current, phase: 'loading', error: null }))
      try {
        const batch = await dependencies.adapter.getCanvasImageCandidateBatch(target)
        if (disposed || generation !== currentGeneration) return null
        dependencies.updateState((current) => ({ ...current, phase: 'ready', batch, error: null }))
        return batch
      } catch (error) {
        if (disposed || generation !== currentGeneration) return null
        dependencies.updateState((current) => ({
          ...current,
          phase: current.batch ? 'ready' : 'error',
          error: getCandidateBatchErrorMessage(error),
        }))
        return null
      }
    },
    continueBatch: () => runOperation(
      'continuing',
      () => dependencies.adapter.continueCanvasImageCandidateBatch(target),
    ),
    adopt: (mode) => runOperation(
      'adopting',
      () => dependencies.adapter.adoptCanvasImageCandidateBatch({ ...target, mode }),
    ),
    abandon: () => runOperation(
      'abandoning',
      () => dependencies.adapter.abandonCanvasImageCandidateBatch(target),
    ),
    dispose: () => {
      if (disposed) return
      disposed = true
      generation += 1
    },
  }
}

/** React 工作台使用的候选批次状态与命令。 */
export interface UseCanvasImageCandidateBatchResult extends CanvasImageCandidateBatchController {
  state: CanvasImageCandidateBatchViewState
}

/** 将单个批次 controller 连接到文件内 Jotai 状态；不会在挂载时主动读取详情。 */
export function useCanvasImageCandidateBatch(
  summary: CanvasImageCandidateBatchSummary,
  adapter: CanvasImageCandidateBatchAdapter,
  onBatchChanged?: CanvasImageCandidateBatchControllerDependencies['onBatchChanged'],
): UseCanvasImageCandidateBatchResult {
  const key = createCanvasImageCandidateBatchKey(summary)
  const states = useAtomValue(canvasImageCandidateBatchStatesAtom)
  const store = useStore()
  const updateState = useSetAtom(updateCanvasImageCandidateBatchStateAtom)
  const controllerRef = React.useRef<CanvasImageCandidateBatchController | null>(null)

  React.useEffect(() => {
    const controller = createCanvasImageCandidateBatchController({
      summary: { ...summary },
      adapter,
      getState: () => store.get(canvasImageCandidateBatchStatesAtom).get(key)
        ?? createInitialCanvasImageCandidateBatchState(),
      updateState: (update) => updateState({ key, update }),
      onBatchChanged,
    })
    controllerRef.current = controller
    return () => {
      controller.dispose()
      if (controllerRef.current === controller) controllerRef.current = null
    }
  }, [key, adapter, store, updateState, onBatchChanged])

  const state = states.get(key) ?? createInitialCanvasImageCandidateBatchState()
  return React.useMemo(() => ({
    state,
    load: () => controllerRef.current?.load() ?? Promise.resolve(null),
    continueBatch: () => controllerRef.current?.continueBatch() ?? Promise.resolve(null),
    adopt: (mode) => controllerRef.current?.adopt(mode) ?? Promise.resolve(null),
    abandon: () => controllerRef.current?.abandon() ?? Promise.resolve(null),
    dispose: () => controllerRef.current?.dispose(),
  }), [state])
}
