import * as React from 'react'
import type {
  CanvasImageModuleConfig,
  CanvasImageTarget,
  DesignJobRecord,
  DesignTaskDetails,
} from '@proma/shared'
import { useAtomValue, useSetAtom, useStore } from 'jotai'
import {
  canvasImageModuleStatesAtom,
  createCanvasImageModuleKey,
  createInitialCanvasImageModuleState,
  removeCanvasImageModuleStateAtom,
  updateCanvasImageModuleStateAtom,
  type CanvasImageModuleDraft,
  type CanvasImageModuleStateUpdate,
  type CanvasImageModuleViewState,
  type CanvasImageTaskDetailsState,
} from '@/atoms/native-canvas-atoms'
import {
  CanvasPublicOperationError,
  designAdapter,
  type DesignAdapter,
} from '@/lib/design-adapter'

/** 图片模块 controller 只依赖 Task 6 已提供的窄 Adapter 合同。 */
export type CanvasImageModuleAdapter = Pick<DesignAdapter,
  'loadCanvasImageModule' | 'saveCanvasImageModule' | 'createCanvasImageJob'
  | 'cancelCanvasImageJob' | 'retryCanvasImageJob' | 'adoptCanvasImageAsset'
  | 'releaseCanvasImageMedia' | 'onCanvasImageModuleChanged' | 'getTaskDetails' | 'getTaskTrace'>

/** 图片模块生命周期协调器使用的微任务调度入口。 */
export type CanvasImageModuleCleanupScheduler = (task: () => void) => void

/** 单个挂载实例持有的生命周期凭据。 */
export interface CanvasImageModuleLifecycleLease {
  /** 判断当前实例是否仍是该 key 的最新拥有者。 */
  isCurrent: () => boolean
  /** 普通卸载时延迟释放，允许 StrictMode 同 key 立即重挂接管。 */
  dispose: () => void
  /** recovery 或 delete 时立即释放当前 key。 */
  releaseNow: () => void
}

/** 图片模块媒体授权与同 key 实例所有权协调器。 */
export interface CanvasImageModuleLifecycleCoordinator {
  mount: (key: string, releaseMedia: () => void) => CanvasImageModuleLifecycleLease
}

/** 单个图片模块 key 的当前挂载和候选清理状态。 */
interface CanvasImageModuleLifecycleEntry {
  latestMountId: number
  activeMountIds: Set<number>
  pendingCleanupId: number | null
  releaseMedia: () => void
  released: boolean
}

/**
 * 创建按完整图片模块 key 隔离的媒体生命周期协调器。
 * @param scheduleMicrotask 将普通卸载释放推迟到同轮 effect setup 之后。
 * @returns StrictMode 同 key 重挂不会误释放新实例的协调器。
 */
export function createCanvasImageModuleLifecycleCoordinator(
  scheduleMicrotask: CanvasImageModuleCleanupScheduler,
): CanvasImageModuleLifecycleCoordinator {
  /** 当前仍挂载或等待清理的图片模块条目。 */
  const entries = new Map<string, CanvasImageModuleLifecycleEntry>()
  /** 为挂载和清理生成不复用的进程内身份。 */
  let nextIdentity = 1

  return {
    mount: (key, releaseMedia) => {
      /** 同 key 重挂复用协调条目并取消旧候选清理。 */
      const entry = entries.get(key) ?? {
        latestMountId: 0,
        activeMountIds: new Set<number>(),
        pendingCleanupId: null,
        releaseMedia,
        released: false,
      }
      /** 当前挂载身份始终接管后续真实卸载的释放函数。 */
      const mountId = nextIdentity
      nextIdentity += 1
      entry.latestMountId = mountId
      entry.pendingCleanupId = null
      entry.releaseMedia = releaseMedia
      entry.released = false
      entry.activeMountIds.add(mountId)
      entries.set(key, entry)
      /** 单个 lease 的 dispose 必须重复调用安全。 */
      let disposed = false

      /** 只执行一次当前 entry 的媒体释放。 */
      const releaseEntry = (): void => {
        if (entry.released) return
        entry.released = true
        entry.releaseMedia()
      }

      return {
        isCurrent: () => entries.get(key) === entry
          && entry.latestMountId === mountId
          && entry.activeMountIds.has(mountId),
        dispose: () => {
          if (disposed) return
          disposed = true
          entry.activeMountIds.delete(mountId)
          if (entry.activeMountIds.size > 0) return
          /** 候选清理身份防止旧微任务删除后续重挂条目。 */
          const cleanupId = nextIdentity
          nextIdentity += 1
          entry.pendingCleanupId = cleanupId
          scheduleMicrotask(() => {
            if (entries.get(key) !== entry
              || entry.pendingCleanupId !== cleanupId
              || entry.activeMountIds.size > 0) return
            entries.delete(key)
            entry.pendingCleanupId = null
            releaseEntry()
          })
        },
        releaseNow: () => {
          if (entries.get(key) !== entry || entry.latestMountId !== mountId) return
          entry.activeMountIds.clear()
          entry.pendingCleanupId = null
          entries.delete(key)
          releaseEntry()
        },
      }
    },
  }
}

/** React 运行时共享协调器，用微任务区分 StrictMode 演练和真实卸载。 */
const canvasImageModuleLifecycleCoordinator = createCanvasImageModuleLifecycleCoordinator(
  (task) => { void Promise.resolve().then(task) },
)

/** Canvas 图片模块 controller 的状态与服务依赖。 */
export interface CanvasImageModuleControllerDependencies {
  target: CanvasImageTarget
  adapter: CanvasImageModuleAdapter
  lifecycle: CanvasImageModuleLifecycleCoordinator
  getState: (key: string) => CanvasImageModuleViewState | undefined
  updateState: (key: string, update: CanvasImageModuleStateUpdate) => void
  removeState: (key: string) => void
  /** 媒体释放失败仅用于诊断，不允许恢复已失效状态。 */
  onReleaseError?: (error: unknown) => void
}

/** 图片模块失效原因，二者都必须清理状态并立即释放媒体。 */
export type CanvasImageModuleInvalidationReason = 'recovery' | 'delete'

/** Canvas 图片模块 controller 对工作台公开的稳定命令。 */
export interface CanvasImageModuleController {
  start: () => void
  retryLoad: () => void
  updateDraft: (patch: Partial<Omit<CanvasImageModuleDraft, 'dirty'>>) => void
  previewAsset: (assetId: string | null) => void
  commitDraft: () => Promise<CanvasImageModuleConfig | null>
  createJob: () => Promise<DesignJobRecord | null>
  cancelJob: (jobId: string) => Promise<DesignJobRecord | null>
  retryJob: (jobId: string) => Promise<DesignJobRecord | null>
  adoptAsset: (jobId: string, assetId: string) => Promise<CanvasImageModuleConfig | null>
  loadTaskDetails: (jobId: string, includeTrace?: boolean) => Promise<DesignTaskDetails | null>
  invalidate: (reason: CanvasImageModuleInvalidationReason) => void
  dispose: () => void
}

/** 从权威配置复制独立的可编辑草稿。 */
function createDraftFromConfig(config: CanvasImageModuleConfig): CanvasImageModuleDraft {
  return {
    prompt: config.prompt,
    selectedModelProfileId: config.selectedModelProfileId,
    aspectRatio: config.aspectRatio,
    imageSize: config.imageSize,
    contextMode: config.contextMode,
    dirty: false,
  }
}

/** 将未知异步失败压缩为 Renderer 可展示文本。 */
function getCanvasImageModuleErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '生图节点操作失败，请重试。'
}

/** 判断公开错误是否表示配置 revision 冲突。 */
function isCanvasImageRevisionConflict(error: unknown): boolean {
  return error instanceof CanvasPublicOperationError
    && error.code === 'CANVAS_IMAGE_REVISION_CONFLICT'
}

/** 判断当前 dirty 草稿是否仍是指定 SAVE 提交的同一份可编辑内容。 */
function isSameCanvasImageDraft(
  current: CanvasImageModuleDraft | null,
  submitted: CanvasImageModuleDraft,
): boolean {
  return current?.dirty === true
    && current.prompt === submitted.prompt
    && current.selectedModelProfileId === submitted.selectedModelProfileId
    && current.aspectRatio === submitted.aspectRatio
    && current.imageSize === submitted.imageSize
    && current.contextMode === submitted.contextMode
}

/**
 * 创建与 React 生命周期解耦的 Canvas 图片模块 controller。
 * @param dependencies 完整目标、Adapter、Jotai 状态入口和生命周期协调器。
 * @returns 所有异步写入均受完整 key、实例所有权和单调代次保护的命令集合。
 */
export function createCanvasImageModuleController(
  dependencies: CanvasImageModuleControllerDependencies,
): CanvasImageModuleController {
  /** 结构化完整身份键，构造时同步完成 safe ID 校验。 */
  const key = createCanvasImageModuleKey(dependencies.target)
  /** recovery、delete 或真实卸载统一递增，失效当前实例全部异步回调。 */
  let instanceEpoch = 0
  /** 只有新 LOAD 会淘汰旧 LOAD。 */
  let loadGeneration = 0
  /** 只有新 SAVE 会淘汰旧 SAVE。 */
  let saveGeneration = 0
  /** 创建、取消和重试共享任务控制通道，只有后发任务命令可淘汰前一条。 */
  let jobGeneration = 0
  /** 只有新采用操作会淘汰旧采用操作。 */
  let adoptGeneration = 0
  /** 任务详情按 jobId 独立计数，不同任务允许并发完成。 */
  const detailGenerations = new Map<string, number>()
  /** start 只能注册一次订阅和媒体 lease。 */
  let started = false
  /** dispose 或显式失效后永久阻止当前 controller 副作用。 */
  let disposed = false
  /** 图片模块广播订阅释放函数。 */
  let unsubscribe: (() => void) | null = null
  /** 当前挂载实例的媒体和所有权凭据。 */
  let lifecycleLease: CanvasImageModuleLifecycleLease | null = null

  /** 判断异步回调是否仍属于当前完整身份和实例代次。 */
  const isCurrentInstance = (epoch: number): boolean => (
    !disposed
    && epoch === instanceEpoch
    && lifecycleLease?.isCurrent() === true
  )

  /** 以当前权威配置和草稿 dirty 状态接管一次模块快照。 */
  const applySnapshot = (snapshot: Awaited<ReturnType<CanvasImageModuleAdapter['loadCanvasImageModule']>>): void => {
    if (createCanvasImageModuleKey(snapshot.target) !== key
      || snapshot.config.contentId !== dependencies.target.imageModuleId) return
    dependencies.updateState(key, (current) => {
      /** SAVE 或 adopt 可能已接管更高 revision，迟到 LOAD 不得回退配置。 */
      const authoritativeConfig = current.snapshot
        && current.snapshot.config.revision > snapshot.config.revision
        ? current.snapshot.config
        : snapshot.config
      return {
        snapshot: { ...snapshot, config: authoritativeConfig },
        draft: current.draft?.dirty ? current.draft : createDraftFromConfig(authoritativeConfig),
        phase: 'ready',
        saveState: current.draft?.dirty ? current.saveState : 'saved',
        error: null,
        previewAssetId: current.previewAssetId ?? authoritativeConfig.adoptedAssetId,
      }
    })
  }

  /** 读取完整模块权威快照，事件刷新与手动重试共用同一代次门禁。 */
  const load = (): void => {
    if (disposed || lifecycleLease?.isCurrent() !== true) return
    /** 当前 LOAD 同时捕获实例代次和 LOAD 通道代次。 */
    const epoch = instanceEpoch
    const generation = ++loadGeneration
    dependencies.updateState(key, { phase: 'loading', error: null })
    void dependencies.adapter.loadCanvasImageModule(dependencies.target).then((snapshot) => {
      if (!isCurrentInstance(epoch) || generation !== loadGeneration) return
      applySnapshot(snapshot)
    }).catch((error: unknown) => {
      if (!isCurrentInstance(epoch) || generation !== loadGeneration) return
      dependencies.updateState(key, {
        phase: 'error',
        error: getCanvasImageModuleErrorMessage(error),
      })
    })
  }

  /** 执行任务控制操作，并在成功后按权威 LOAD 对账任务与素材。 */
  const runJobOperation = async (
    operation: () => Promise<DesignJobRecord>,
  ): Promise<DesignJobRecord | null> => {
    if (disposed || lifecycleLease?.isCurrent() !== true) return null
    /** 当前任务命令同时捕获实例代次和任务控制通道代次。 */
    const epoch = instanceEpoch
    const generation = ++jobGeneration
    dependencies.updateState(key, { error: null })
    try {
      /** 主进程返回的权威任务记录。 */
      const job = await operation()
      if (!isCurrentInstance(epoch) || generation !== jobGeneration) return null
      load()
      return job
    } catch (error) {
      if (isCurrentInstance(epoch) && generation === jobGeneration) {
        dependencies.updateState(key, { error: getCanvasImageModuleErrorMessage(error) })
      }
      throw error
    }
  }

  return {
    start: () => {
      if (started || disposed) return
      started = true
      lifecycleLease = dependencies.lifecycle.mount(key, () => {
        dependencies.removeState(key)
        void dependencies.adapter.releaseCanvasImageMedia(dependencies.target)
          .catch((error: unknown) => dependencies.onReleaseError?.(error))
      })
      unsubscribe = dependencies.adapter.onCanvasImageModuleChanged(dependencies.target, load)
      load()
    },
    retryLoad: load,
    updateDraft: (patch) => {
      if (disposed || lifecycleLease?.isCurrent() !== true) return
      dependencies.updateState(key, (current) => {
        if (!current.draft) return {}
        return {
          draft: { ...current.draft, ...patch, dirty: true },
          saveState: 'dirty',
          error: null,
        }
      })
    },
    previewAsset: (assetId) => {
      if (disposed || lifecycleLease?.isCurrent() !== true) return
      dependencies.updateState(key, { previewAssetId: assetId })
    },
    commitDraft: async () => {
      if (disposed || lifecycleLease?.isCurrent() !== true) return null
      /** 保存必须同时捕获权威 revision 与当前草稿，禁止从后续状态拼装。 */
      const current = dependencies.getState(key)
      if (!current?.snapshot || !current.draft?.dirty) return current?.snapshot?.config ?? null
      /** 当前 SAVE 同时捕获实例代次和 SAVE 通道代次。 */
      const epoch = instanceEpoch
      const generation = ++saveGeneration
      /** 请求使用的本地草稿副本。 */
      const draft = { ...current.draft }
      dependencies.updateState(key, { saveState: 'saving', error: null })
      try {
        /** 服务端返回的权威配置可能含规范化字段和新 revision。 */
        const savedConfig = await dependencies.adapter.saveCanvasImageModule({
          ...dependencies.target,
          expectedConfigRevision: current.snapshot.config.revision,
          prompt: draft.prompt,
          selectedModelProfileId: draft.selectedModelProfileId,
          aspectRatio: draft.aspectRatio,
          imageSize: draft.imageSize,
          contextMode: draft.contextMode,
        })
        if (!isCurrentInstance(epoch) || generation !== saveGeneration) return null
        if (savedConfig.contentId !== dependencies.target.imageModuleId) return null
        dependencies.updateState(key, (latest) => {
          if (!latest.snapshot) return {}
          /** 配置只允许 revision 单调前进，事件 LOAD 的更高权威值优先。 */
          const authoritativeConfig = latest.snapshot.config.revision > savedConfig.revision
            ? latest.snapshot.config
            : savedConfig
          /** SAVE 期间的新编辑不属于本次提交，必须继续保持 dirty。 */
          const submittedDraftIsCurrent = isSameCanvasImageDraft(latest.draft, draft)
          return {
            snapshot: { ...latest.snapshot, config: authoritativeConfig },
            draft: submittedDraftIsCurrent
              ? createDraftFromConfig(authoritativeConfig)
              : latest.draft ?? createDraftFromConfig(authoritativeConfig),
            saveState: submittedDraftIsCurrent ? 'saved' : latest.draft?.dirty ? 'dirty' : 'saved',
            error: null,
          }
        })
        return savedConfig
      } catch (error) {
        if (isCurrentInstance(epoch) && generation === saveGeneration) {
          dependencies.updateState(key, {
            saveState: isCanvasImageRevisionConflict(error) ? 'conflict' : 'failed',
            error: getCanvasImageModuleErrorMessage(error),
          })
        }
        throw error
      }
    },
    createJob: () => {
      /** 创建付费任务只能使用当前权威配置 revision。 */
      const revision = dependencies.getState(key)?.snapshot?.config.revision
      if (revision === undefined) return Promise.resolve(null)
      return runJobOperation(() => dependencies.adapter.createCanvasImageJob({
        ...dependencies.target,
        expectedConfigRevision: revision,
      }))
    },
    cancelJob: (jobId) => runJobOperation(() => dependencies.adapter.cancelCanvasImageJob({
      ...dependencies.target,
      jobId,
    })),
    retryJob: (jobId) => runJobOperation(() => dependencies.adapter.retryCanvasImageJob({
      ...dependencies.target,
      jobId,
    })),
    adoptAsset: async (jobId, assetId) => {
      if (disposed || lifecycleLease?.isCurrent() !== true) return null
      /** 采用素材同样以当前权威配置 revision 进行 CAS。 */
      const revision = dependencies.getState(key)?.snapshot?.config.revision
      if (revision === undefined) return null
      /** 当前采用操作同时捕获实例代次和采用通道代次。 */
      const epoch = instanceEpoch
      const generation = ++adoptGeneration
      try {
        /** 主进程返回采用后配置，禁止 Renderer 自行拼 adoptedAssetId。 */
        const savedConfig = await dependencies.adapter.adoptCanvasImageAsset({
          ...dependencies.target,
          jobId,
          assetId,
          expectedConfigRevision: revision,
        })
        if (!isCurrentInstance(epoch) || generation !== adoptGeneration) return null
        if (savedConfig.contentId !== dependencies.target.imageModuleId) return null
        dependencies.updateState(key, (current) => {
          if (!current.snapshot) return {}
          /** 采用结果不得回退事件 LOAD 或 SAVE 已接管的更高配置 revision。 */
          const authoritativeConfig = current.snapshot.config.revision > savedConfig.revision
            ? current.snapshot.config
            : savedConfig
          return {
            snapshot: { ...current.snapshot, config: authoritativeConfig },
            draft: current.draft?.dirty ? current.draft : createDraftFromConfig(authoritativeConfig),
            previewAssetId: authoritativeConfig.adoptedAssetId,
            error: null,
          }
        })
        return savedConfig
      } catch (error) {
        if (isCurrentInstance(epoch) && generation === adoptGeneration) {
          dependencies.updateState(key, { error: getCanvasImageModuleErrorMessage(error) })
        }
        throw error
      }
    },
    loadTaskDetails: async (jobId, includeTrace = false) => {
      if (disposed || lifecycleLease?.isCurrent() !== true) return null
      /** 当前详情同时捕获实例代次和目标 job 独立代次。 */
      const epoch = instanceEpoch
      const generation = (detailGenerations.get(jobId) ?? 0) + 1
      detailGenerations.set(jobId, generation)
      dependencies.updateState(key, (current) => {
        /** 每次详情更新只复制该 key 内的小 Map。 */
        const taskDetails = new Map(current.taskDetails)
        taskDetails.set(jobId, { phase: 'loading', details: null, error: null })
        return { taskDetails }
      })
      try {
        /** Thinking 或日志展开时改读包含 trace 的完整详情合同。 */
        const completeDetails = await (includeTrace
          ? dependencies.adapter.getTaskTrace({
              projectId: dependencies.target.projectId,
              jobId,
            })
          : dependencies.adapter.getTaskDetails({
              projectId: dependencies.target.projectId,
              jobId,
            }))
        if (!isCurrentInstance(epoch) || detailGenerations.get(jobId) !== generation) return null
        dependencies.updateState(key, (current) => {
          const taskDetails = new Map(current.taskDetails)
          taskDetails.set(jobId, { phase: 'ready', details: completeDetails, error: null })
          return { taskDetails }
        })
        return completeDetails
      } catch (error) {
        if (isCurrentInstance(epoch) && detailGenerations.get(jobId) === generation) {
          dependencies.updateState(key, (current) => {
            const taskDetails = new Map(current.taskDetails)
            /** 详情失败只影响目标 job，不覆盖模块配置错误。 */
            const failed: CanvasImageTaskDetailsState = {
              phase: 'failed', details: null, error: getCanvasImageModuleErrorMessage(error),
            }
            taskDetails.set(jobId, failed)
            return { taskDetails }
          })
        }
        throw error
      }
    },
    invalidate: (_reason) => {
      if (disposed) return
      disposed = true
      instanceEpoch += 1
      unsubscribe?.()
      unsubscribe = null
      if (lifecycleLease?.isCurrent()) {
        dependencies.removeState(key)
        lifecycleLease.releaseNow()
      }
    },
    dispose: () => {
      if (disposed) return
      disposed = true
      instanceEpoch += 1
      unsubscribe?.()
      unsubscribe = null
      lifecycleLease?.dispose()
    },
  }
}

/** React 工作台使用的图片模块状态与命令。 */
export interface UseCanvasImageModuleResult extends CanvasImageModuleController {
  state: CanvasImageModuleViewState
}

/**
 * 将单个 Canvas 图片模块 controller 连接到 Jotai 与 Design Adapter。
 * @param target 当前展开图片节点的完整四元身份。
 * @param adapter 测试可替换的 Renderer Adapter，默认使用真实 Design Adapter。
 * @returns 当前 key 独立状态和图片模块命令。
 */
export function useCanvasImageModule(
  target: CanvasImageTarget,
  adapter: CanvasImageModuleAdapter = designAdapter,
): UseCanvasImageModuleResult {
  /** 完整 key 同时作为 effect 生命周期和 Jotai Map 查询身份。 */
  const key = createCanvasImageModuleKey(target)
  /** 当前图片模块 Map 状态。 */
  const states = useAtomValue(canvasImageModuleStatesAtom)
  /** controller 写前通过 store 获取最新 Map，避免捕获旧 render 快照。 */
  const store = useStore()
  /** Jotai 图片模块原子更新入口。 */
  const updateState = useSetAtom(updateCanvasImageModuleStateAtom)
  /** Jotai 图片模块失效删除入口。 */
  const removeState = useSetAtom(removeCanvasImageModuleStateAtom)
  /** 当前挂载 controller，公开命令通过 ref 避免返回对象频繁变化。 */
  const controllerRef = React.useRef<CanvasImageModuleController | null>(null)

  React.useEffect(() => {
    /** effect 内固定当前四元身份，避免对象引用变化导致无意义重挂。 */
    const currentTarget = { ...target }
    /** 当前 key 的纯 controller。 */
    const controller = createCanvasImageModuleController({
      target: currentTarget,
      adapter,
      lifecycle: canvasImageModuleLifecycleCoordinator,
      getState: (stateKey) => store.get(canvasImageModuleStatesAtom).get(stateKey),
      updateState: (stateKey, update) => updateState({ key: stateKey, update }),
      removeState,
    })
    controllerRef.current = controller
    controller.start()
    return () => {
      controller.dispose()
      if (controllerRef.current === controller) controllerRef.current = null
    }
  }, [key, adapter, store, updateState, removeState])

  /** 当前 key 尚未加载时使用新的只读初始状态。 */
  const state = states.get(key) ?? createInitialCanvasImageModuleState()
  return React.useMemo(() => ({
    state,
    start: () => controllerRef.current?.start(),
    retryLoad: () => controllerRef.current?.retryLoad(),
    updateDraft: (patch) => controllerRef.current?.updateDraft(patch),
    previewAsset: (assetId) => controllerRef.current?.previewAsset(assetId),
    commitDraft: () => controllerRef.current?.commitDraft() ?? Promise.resolve(null),
    createJob: () => controllerRef.current?.createJob() ?? Promise.resolve(null),
    cancelJob: (jobId) => controllerRef.current?.cancelJob(jobId) ?? Promise.resolve(null),
    retryJob: (jobId) => controllerRef.current?.retryJob(jobId) ?? Promise.resolve(null),
    adoptAsset: (jobId, assetId) => controllerRef.current?.adoptAsset(jobId, assetId) ?? Promise.resolve(null),
    loadTaskDetails: (jobId, includeTrace) => controllerRef.current?.loadTaskDetails(jobId, includeTrace) ?? Promise.resolve(null),
    invalidate: (reason) => controllerRef.current?.invalidate(reason),
    dispose: () => controllerRef.current?.dispose(),
  }), [state])
}
