import type {
  AgentCanvasBinding,
  AgentCanvasBindingChangeEvent,
  CanvasOrchestrationChangedEvent,
  CanvasOrchestrationRecord,
  CanvasTarget,
} from '@proma/shared'
import type { CanvasOrchestrationState } from '@/atoms/canvas-orchestration-atoms'
import { createCanvasOrchestrationController, type CanvasOrchestrationController } from '@/components/design/CanvasOrchestrationPanel'

/** 普通聊天中一个已关联画布的编排状态。 */
export interface AgentCanvasOrchestrationItem {
  canvasId: string
  state: CanvasOrchestrationState
}

/** 普通聊天会话的多画布编排读取状态。 */
export interface AgentCanvasOrchestrationControllerState {
  phase: 'idle' | 'loading' | 'ready' | 'error'
  error: string | null
  canvases: AgentCanvasOrchestrationItem[]
}

/** 会话级控制器仅组合关联和既有单画布轻量读取边界。 */
export interface AgentCanvasOrchestrationControllerDependencies {
  projectId: string
  sessionId: string
  listBindings: (input: { projectId: string }) => Promise<AgentCanvasBinding[]>
  onBindingChanged: (
    target: { projectId: string; sessionId: string },
    listener: (event: AgentCanvasBindingChangeEvent) => void,
  ) => () => void
  getRecord: (target: CanvasTarget) => Promise<CanvasOrchestrationRecord | null>
  onChanged: (target: CanvasTarget, listener: (event: CanvasOrchestrationChangedEvent) => void) => () => void
  onStateChange: (state: AgentCanvasOrchestrationControllerState) => void
}

/** 会话级控制器公开的加载、重试、等待与释放协议。 */
export interface AgentCanvasOrchestrationController {
  load: () => Promise<void>
  retry: () => Promise<void>
  whenIdle: () => Promise<void>
  dispose: () => void
  getSnapshot: () => AgentCanvasOrchestrationControllerState
}

/** 创建会话级多画布编排控制器。 */
export function createAgentCanvasOrchestrationController(
  dependencies: AgentCanvasOrchestrationControllerDependencies,
): AgentCanvasOrchestrationController {
  /** 子控制器按 canvasId 复用，关联顺序单独保留用于稳定展示。 */
  interface CanvasEntry {
    controller: CanvasOrchestrationController
    state: CanvasOrchestrationState
  }
  let state: AgentCanvasOrchestrationControllerState = { phase: 'idle', error: null, canvases: [] }
  const entries = new Map<string, CanvasEntry>()
  let orderedCanvasIds: string[] = []
  /** 只等待最新关联请求，已被取消的旧代次不阻塞 whenIdle。 */
  let currentBindingRequest: Promise<void> | null = null
  let bindingGeneration = 0
  let disposed = false

  /** 发布完整会话快照，避免调用方合并多画布旧状态。 */
  const publish = (update: Partial<Pick<AgentCanvasOrchestrationControllerState, 'phase' | 'error'>> = {}): void => {
    if (disposed) return
    state = {
      ...state,
      ...update,
      canvases: orderedCanvasIds.flatMap((canvasId) => {
        const entry = entries.get(canvasId)
        return entry ? [{ canvasId, state: entry.state }] : []
      }),
    }
    dependencies.onStateChange(state)
  }

  /** 为新关联画布创建既有单画布控制器，并在外层强制 owner 隔离。 */
  const createEntry = (canvasId: string): CanvasEntry => {
    const entry = {} as CanvasEntry
    entry.state = { phase: 'idle', record: null, error: null }
    entry.controller = createCanvasOrchestrationController({
      target: { projectId: dependencies.projectId, canvasId },
      getRecord: dependencies.getRecord,
      onChanged: dependencies.onChanged,
      onStateChange: (nextState) => {
        if (disposed || entries.get(canvasId) !== entry) return
        entry.state = nextState.record && nextState.record.ownerSessionId !== dependencies.sessionId
          ? { phase: 'ready', record: null, error: null }
          : nextState
        publish()
      },
    })
    return entry
  }

  /** 使用最新关联集合只增删差异，保留未变画布的 revision 去重状态。 */
  const applyBinding = (bindings: AgentCanvasBinding[]): CanvasEntry[] => {
    const binding = bindings.find(item => item.projectId === dependencies.projectId && item.sessionId === dependencies.sessionId)
    const nextCanvasIds = binding ? [...binding.linkedCanvasIds] : []
    const nextSet = new Set(nextCanvasIds)
    for (const [canvasId, entry] of entries) {
      if (nextSet.has(canvasId)) continue
      entry.controller.dispose()
      entries.delete(canvasId)
    }
    const created: CanvasEntry[] = []
    for (const canvasId of nextCanvasIds) {
      if (entries.has(canvasId)) continue
      const entry = createEntry(canvasId)
      entries.set(canvasId, entry)
      created.push(entry)
    }
    orderedCanvasIds = nextCanvasIds
    return created
  }

  /** 重读关联并以代次丢弃迟到结果；变化事件可直接取消在途旧请求。 */
  const refreshBindings = (): Promise<void> => {
    if (disposed) return Promise.resolve()
    const requestGeneration = ++bindingGeneration
    publish({ phase: 'loading', error: null })
    const request = dependencies.listBindings({ projectId: dependencies.projectId }).then(async (bindings) => {
      if (disposed || requestGeneration !== bindingGeneration) return
      const created = applyBinding(bindings)
      publish({ phase: 'ready', error: null })
      await Promise.all(created.map(entry => entry.controller.load()))
      if (!disposed && requestGeneration === bindingGeneration) publish({ phase: 'ready', error: null })
    }).catch(() => {
      if (disposed || requestGeneration !== bindingGeneration) return
      publish({ phase: entries.size > 0 ? 'ready' : 'error', error: '画布关联暂时无法加载。' })
    }).finally(() => {
      if (currentBindingRequest === request) currentBindingRequest = null
    })
    currentBindingRequest = request
    return request
  }

  const releaseBinding = dependencies.onBindingChanged(
    { projectId: dependencies.projectId, sessionId: dependencies.sessionId },
    (event) => {
      if (disposed || event.projectId !== dependencies.projectId || event.sessionId !== dependencies.sessionId) return
      void refreshBindings()
    },
  )

  return {
    load: () => currentBindingRequest ?? refreshBindings(),
    retry: async () => {
      if (disposed) return
      if (state.error || entries.size === 0) {
        await (currentBindingRequest ?? refreshBindings())
        return
      }
      await Promise.all([...entries.values()].map(entry => entry.controller.load()))
    },
    whenIdle: async () => {
      /** 关联结果可创建子请求，因此循环到最新代次和全部子控制器都空闲。 */
      while (!disposed) {
        const bindingRequest = currentBindingRequest
        if (bindingRequest) await bindingRequest
        const controllers = [...entries.values()].map(entry => entry.controller)
        await Promise.all(controllers.map(controller => controller.whenIdle()))
        if (!currentBindingRequest && controllers.length === entries.size
          && controllers.every((controller, index) => controller === [...entries.values()][index]?.controller)) return
      }
    },
    dispose: () => {
      if (disposed) return
      disposed = true
      bindingGeneration += 1
      currentBindingRequest = null
      releaseBinding()
      for (const entry of entries.values()) entry.controller.dispose()
      entries.clear()
      orderedCanvasIds = []
    },
    getSnapshot: () => state,
  }
}
