import * as React from 'react'
import type { DesignImageModelSelection } from '@proma/shared'
import { useSetAtom } from 'jotai'
import { toast } from 'sonner'
import type { DesignProjectState } from '@/atoms/design-atoms'
import { updateDesignProjectStateAtom } from '@/atoms/design-atoms'
import type { DesignAdapter } from '@/lib/design-adapter'
import { designAdapter } from '@/lib/design-adapter'

/** 生图模型 controller 可写入的项目局部状态。 */
export type DesignImageModelStateUpdate = Partial<DesignProjectState>
  | ((current: DesignProjectState) => Partial<DesignProjectState>)

/** 生图模型选择 controller 的窄依赖。 */
export interface DesignImageModelSelectionControllerDependencies {
  /** 当前 Inspector 绑定的稳定项目 ID。 */
  projectId: string
  /** 只包含模型选择 IPC 的 Renderer adapter。 */
  adapter: Pick<DesignAdapter,
    'getImageModelSelection' | 'setImageModelSelection'
    | 'onImageModelProfilesChanged' | 'onImageModelSelectionChanged'>
  /** 原子更新当前项目状态。 */
  updateState: (update: DesignImageModelStateUpdate) => void
  /** 向用户展示选择写入失败。 */
  onError: (message: string) => void
}

/** 生图模型选择 controller 的稳定命令。 */
export interface DesignImageModelSelectionController {
  /** 进入项目时加载选择并订阅跨窗口变化。 */
  start: () => void
  /** 乐观选择 profile，失败时回读主进程权威值。 */
  selectProfile: (profileId: string) => void
  /** 手动重试当前项目模型目录与偏好加载。 */
  retryLoad: () => void
  /** 解除订阅并阻止所有迟到结果写入。 */
  dispose: () => void
}

/** 将主进程权威选择转换为项目局部模型状态。 */
function createSelectionUpdate(selection: DesignImageModelSelection): Partial<DesignProjectState> {
  return {
    imageModelLoadState: 'ready',
    imageModelOptions: selection.options.map((option) => ({ ...option })),
    imageModelProfileId: selection.selectedProfileId ?? null,
    invalidImageModelProfileId: selection.invalidSelectedProfileId ?? null,
    imageModelError: null,
  }
}

/** 将未知错误转换为紧凑中文错误文本。 */
function getImageModelErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '加载生图模型失败'
}

/**
 * 创建与 React 生命周期解耦的项目生图模型 controller。
 * @param dependencies 项目、adapter、状态存取与错误提示依赖。
 * @returns 只在进入项目、广播和手动重试时读取主进程的 controller。
 */
export function createDesignImageModelSelectionController(
  dependencies: DesignImageModelSelectionControllerDependencies,
): DesignImageModelSelectionController {
  /** 最新请求代次，目录广播、项目切换或卸载都会让旧结果失效。 */
  let latestRequestSequence = 0
  /** controller 释放后永久阻止异步副作用。 */
  let disposed = false
  /** 目录变化订阅释放函数。 */
  let unsubscribeProfiles: (() => void) | null = null
  /** 项目选择变化订阅释放函数。 */
  let unsubscribeSelection: (() => void) | null = null

  /** 判断指定请求是否仍属于当前 controller 的最新代次。 */
  const isCurrentRequest = (requestSequence: number): boolean => (
    !disposed && requestSequence === latestRequestSequence
  )

  /** 读取当前项目权威选择，且不触碰 prompt、选区或 pending mutation。 */
  const load = (): void => {
    /** 每次显式加载都会取消此前在途结果。 */
    const requestSequence = ++latestRequestSequence
    dependencies.updateState({ imageModelLoadState: 'loading', imageModelError: null })
    void dependencies.adapter.getImageModelSelection(dependencies.projectId).then((selection) => {
      if (!isCurrentRequest(requestSequence) || selection.projectId !== dependencies.projectId) return
      dependencies.updateState(createSelectionUpdate(selection))
    }).catch((error: unknown) => {
      if (!isCurrentRequest(requestSequence)) return
      dependencies.updateState({
        imageModelLoadState: 'failed',
        imageModelError: getImageModelErrorMessage(error),
      })
    })
  }

  /** 写入失败后回读主进程，禁止用乐观前值自行猜测回滚。 */
  const restoreAuthoritativeSelection = (failedRequestSequence: number, error: unknown): void => {
    if (!isCurrentRequest(failedRequestSequence)) return
    /** 回读使用新代次，隔离失败写入之后到达的旧加载。 */
    const rollbackSequence = ++latestRequestSequence
    void dependencies.adapter.getImageModelSelection(dependencies.projectId).then((selection) => {
      if (!isCurrentRequest(rollbackSequence) || selection.projectId !== dependencies.projectId) return
      dependencies.updateState(createSelectionUpdate(selection))
      dependencies.onError(getImageModelErrorMessage(error))
    }).catch((rollbackError: unknown) => {
      if (!isCurrentRequest(rollbackSequence)) return
      dependencies.updateState({
        imageModelLoadState: 'failed',
        imageModelError: getImageModelErrorMessage(rollbackError),
      })
      dependencies.onError(getImageModelErrorMessage(error))
    })
  }

  return {
    start: () => {
      if (disposed || unsubscribeProfiles || unsubscribeSelection) return
      /** 全局目录变化会影响当前项目选项和已有选择可用性。 */
      unsubscribeProfiles = dependencies.adapter.onImageModelProfilesChanged(load)
      /** 项目偏好广播只处理本 controller 绑定的项目。 */
      unsubscribeSelection = dependencies.adapter.onImageModelSelectionChanged((event) => {
        if (event.projectId === dependencies.projectId) load()
      })
      load()
    },
    selectProfile: (profileId) => {
      if (disposed || !profileId.trim()) return
      /** 选择操作使旧加载失效，并立即展示乐观 profile。 */
      const requestSequence = ++latestRequestSequence
      dependencies.updateState({
        imageModelLoadState: 'loading',
        imageModelProfileId: profileId,
        invalidImageModelProfileId: null,
        imageModelError: null,
      })
      void dependencies.adapter.setImageModelSelection({
        projectId: dependencies.projectId,
        imageModelProfileId: profileId,
      }).then((selection) => {
        if (!isCurrentRequest(requestSequence) || selection.projectId !== dependencies.projectId) return
        dependencies.updateState(createSelectionUpdate(selection))
      }).catch((error: unknown) => restoreAuthoritativeSelection(requestSequence, error))
    },
    retryLoad: load,
    dispose: () => {
      if (disposed) return
      disposed = true
      latestRequestSequence += 1
      unsubscribeProfiles?.()
      unsubscribeSelection?.()
      unsubscribeProfiles = null
      unsubscribeSelection = null
    },
  }
}

/** 当前项目生图模型选择 hook 的公开命令。 */
export interface UseDesignImageModelSelectionResult {
  /** 选择当前项目生图 profile。 */
  selectProfile: (profileId: string) => void
  /** 重试加载当前项目模型状态。 */
  retryLoad: () => void
}

/** 连接项目 Jotai 状态、模型 IPC 和跨窗口广播。 */
export function useDesignImageModelSelection(projectId: string): UseDesignImageModelSelectionResult {
  const updateProjectState = useSetAtom(updateDesignProjectStateAtom)
  /** 当前挂载项目的 controller 引用，供事件回调稳定调用。 */
  const controllerRef = React.useRef<DesignImageModelSelectionController | null>(null)

  React.useEffect(() => {
    /** Hook 只拥有模型选择生命周期，不进入画布 load/save controller。 */
    const controller = createDesignImageModelSelectionController({
      projectId,
      adapter: designAdapter,
      updateState: (update) => updateProjectState({ projectId, update }),
      onError: (message) => toast.error(message),
    })
    controllerRef.current = controller
    controller.start()
    return () => {
      controller.dispose()
      if (controllerRef.current === controller) controllerRef.current = null
    }
  }, [projectId, updateProjectState])

  return React.useMemo(() => ({
    selectProfile: (profileId: string) => controllerRef.current?.selectProfile(profileId),
    retryLoad: () => controllerRef.current?.retryLoad(),
  }), [])
}
