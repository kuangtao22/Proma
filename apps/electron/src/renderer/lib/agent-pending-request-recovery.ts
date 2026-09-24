import type {
  AgentEvent,
  AskUserRequest,
  ExitPlanModeRequest,
  PendingRequestsSnapshot,
  PermissionRequest,
} from '@proma/shared'
import type { Store } from 'jotai/vanilla/store'
import {
  allPendingAskUserRequestsAtom,
  allPendingExitPlanRequestsAtom,
  allPendingPermissionRequestsAtom,
  askUserDraftsAtom,
} from '@/atoms/agent-atoms'

/** 三类待处理请求共享的稳定身份。 */
interface PendingRequestIdentity {
  requestId: string
  sessionId: string
}

/** 待处理请求恢复所需的主进程边界。 */
export interface PendingRequestRecoveryDependencies {
  loadSnapshot: () => Promise<PendingRequestsSnapshot>
  onError?: (error: unknown) => void
}

/** 待处理请求恢复与实时事件合并器的生命周期。 */
export interface PendingRequestRecoveryCoordinator {
  start: () => Promise<void>
  handle: (sessionId: string, event: AgentEvent) => void
  completeSession: (sessionId: string) => void
  dispose: () => void
}

/** 按 requestId 从所有会话删除已处理请求，兼容父会话代答子会话的情况。 */
function removeRequest<TRequest extends PendingRequestIdentity>(
  previous: Map<string, readonly TRequest[]>,
  requestId: string,
): Map<string, readonly TRequest[]> {
  let changed = false
  const next = new Map(previous)
  previous.forEach((requests, sessionId) => {
    const remaining = requests.filter((request) => request.requestId !== requestId)
    if (remaining.length === requests.length) return
    changed = true
    if (remaining.length === 0) next.delete(sessionId)
    else next.set(sessionId, remaining)
  })
  return changed ? next : previous
}

/** 把实时请求加入所属会话，并以 requestId 去重。 */
function upsertRequest<TRequest extends PendingRequestIdentity>(
  previous: Map<string, readonly TRequest[]>,
  sessionId: string,
  request: TRequest,
): Map<string, readonly TRequest[]> {
  const withoutDuplicate = removeRequest(previous, request.requestId)
  const next = new Map(withoutDuplicate)
  next.set(sessionId, [...(next.get(sessionId) ?? []), request])
  return next
}

/** 合并启动快照，实时事件已写入的同一 requestId 保持优先。 */
function mergeSnapshotRequests<TRequest extends PendingRequestIdentity>(
  current: Map<string, readonly TRequest[]>,
  snapshotRequests: readonly TRequest[],
  resolvedRequestIds: ReadonlySet<string>,
  terminalSessionIds: ReadonlySet<string>,
): Map<string, readonly TRequest[]> {
  /** 实时对象优先于快照中的旧正文，但仍占据原快照的 FIFO 位置。 */
  const currentRequestsById = new Map<string, { sessionId: string; request: TRequest }>()
  current.forEach((requests, sessionId) => {
    requests.forEach((request) => currentRequestsById.set(request.requestId, { sessionId, request }))
  })
  const consumedCurrentIds = new Set<string>()
  const acceptedSnapshotIds = new Set<string>()
  const next = new Map<string, readonly TRequest[]>()
  /** 向目标会话末尾追加请求，保持每个来源内的稳定顺序。 */
  const append = (sessionId: string, request: TRequest): void => {
    next.set(sessionId, [...(next.get(sessionId) ?? []), request])
  }
  for (const request of snapshotRequests) {
    if (resolvedRequestIds.has(request.requestId)
      || terminalSessionIds.has(request.sessionId)
      || acceptedSnapshotIds.has(request.requestId)) continue
    acceptedSnapshotIds.add(request.requestId)
    const currentMatch = currentRequestsById.get(request.requestId)
    if (currentMatch) {
      if (currentMatch.sessionId === request.sessionId) {
        append(request.sessionId, currentMatch.request)
        consumedCurrentIds.add(request.requestId)
      }
      continue
    }
    append(request.sessionId, request)
  }
  current.forEach((requests, sessionId) => {
    requests.forEach((request) => {
      if (!consumedCurrentIds.has(request.requestId)) append(sessionId, request)
    })
  })
  return next
}

/** 删除指定会话的全部请求；无对应会话时保持原 Map 引用。 */
function removeSessionRequests<TRequest>(
  previous: Map<string, readonly TRequest[]>,
  sessionId: string,
): Map<string, readonly TRequest[]> {
  if (!previous.has(sessionId)) return previous
  const next = new Map(previous)
  next.delete(sessionId)
  return next
}

/** 每个 Jotai store 的当前恢复器；弱引用仅协调生命周期，不保留会话历史。 */
const activeRecoveryCoordinators = new WeakMap<Store, PendingRequestRecoveryCoordinator>()

/** 清理 store 中 requestIds 对应的问题草稿，不影响聊天输入草稿。 */
function removeAskUserDrafts(store: Store, requestIds: ReadonlySet<string>): void {
  if (requestIds.size === 0) return
  store.set(askUserDraftsAtom, (previous) => {
    if (![...requestIds].some((requestId) => previous.has(requestId))) return previous
    /** 保持原草稿索引不可变，仅删除已结束问题。 */
    const next = new Map(previous)
    requestIds.forEach((requestId) => next.delete(requestId))
    return next
  })
}

/** 删除 store 中 sessionId 的三类请求及问题草稿，不更改运行身份。 */
function clearSessionPendingRequests(store: Store, sessionId: string): void {
  /** 删除请求之前收集它们的问题草稿身份。 */
  const askUserRequestIds = new Set(
    (store.get(allPendingAskUserRequestsAtom).get(sessionId) ?? []).map((request) => request.requestId),
  )
  store.set(allPendingPermissionRequestsAtom, (current) => removeSessionRequests(current, sessionId))
  store.set(allPendingAskUserRequestsAtom, (current) => removeSessionRequests(current, sessionId))
  store.set(allPendingExitPlanRequestsAtom, (current) => removeSessionRequests(current, sessionId))
  removeAskUserDrafts(store, askUserRequestIds)
}

/** 将 sessionId 的权威终态交给 store 当前恢复器，阻止迟到快照复活旧请求。 */
export function completePendingRequestSession(store: Store, sessionId: string): void {
  /** 正常应用挂载时复用全局监听器的同一个恢复器。 */
  const coordinator = activeRecoveryCoordinators.get(store)
  if (coordinator) coordinator.completeSession(sessionId)
  else clearSessionPendingRequests(store, sessionId)
}

/** 创建 Renderer reload 后的一次性待处理请求恢复器。 */
export function createPendingRequestRecoveryCoordinator(
  store: Store,
  dependencies: PendingRequestRecoveryDependencies,
): PendingRequestRecoveryCoordinator {
  /** 这些集合只覆盖启动快照窗口，防止迟到快照复活已解决请求。 */
  const resolvedPermissionIds = new Set<string>()
  const resolvedAskUserIds = new Set<string>()
  const resolvedExitPlanIds = new Set<string>()
  const terminalSessionIds = new Set<string>()
  let bootstrapPending = true
  let disposed = false
  let startPromise: Promise<void> | null = null

  /** 快照结束后释放短期墓碑，避免把请求历史常驻 Renderer。 */
  const finishBootstrap = (): void => {
    bootstrapPending = false
    resolvedPermissionIds.clear()
    resolvedAskUserIds.clear()
    resolvedExitPlanIds.clear()
    terminalSessionIds.clear()
  }

  /** 读取并合并一次主进程权威快照。 */
  const start = (): Promise<void> => {
    if (startPromise) return startPromise
    if (disposed) return Promise.resolve()
    startPromise = Promise.resolve()
      .then(() => dependencies.loadSnapshot())
      .then((snapshot) => {
        if (disposed) return
        store.set(allPendingPermissionRequestsAtom, (current) => mergeSnapshotRequests(
          current, snapshot.permissions, resolvedPermissionIds, terminalSessionIds,
        ))
        store.set(allPendingAskUserRequestsAtom, (current) => mergeSnapshotRequests(
          current, snapshot.askUsers, resolvedAskUserIds, terminalSessionIds,
        ))
        store.set(allPendingExitPlanRequestsAtom, (current) => mergeSnapshotRequests(
          current, snapshot.exitPlans, resolvedExitPlanIds, terminalSessionIds,
        ))
        finishBootstrap()
      })
      .catch((error: unknown) => {
        if (disposed) return
        finishBootstrap()
        dependencies.onError?.(error)
      })
    return startPromise
  }

  /** 合并实时请求事件；其它 AgentEvent 由原全局监听器继续处理。 */
  const handle = (sessionId: string, event: AgentEvent): void => {
    if (disposed) return
    if (event.type === 'permission_request') {
      if (resolvedPermissionIds.has(event.request.requestId)) return
      store.set(allPendingPermissionRequestsAtom, (current) => upsertRequest(current, sessionId, event.request))
    } else if (event.type === 'permission_resolved') {
      if (bootstrapPending) resolvedPermissionIds.add(event.requestId)
      store.set(allPendingPermissionRequestsAtom, (current) => removeRequest(current, event.requestId))
    } else if (event.type === 'ask_user_request') {
      if (resolvedAskUserIds.has(event.request.requestId)) return
      store.set(allPendingAskUserRequestsAtom, (current) => upsertRequest(current, sessionId, event.request))
    } else if (event.type === 'ask_user_resolved') {
      if (bootstrapPending) resolvedAskUserIds.add(event.requestId)
      store.set(allPendingAskUserRequestsAtom, (current) => removeRequest(current, event.requestId))
      removeAskUserDrafts(store, new Set([event.requestId]))
    } else if (event.type === 'exit_plan_mode_request') {
      if (resolvedExitPlanIds.has(event.request.requestId)) return
      store.set(allPendingExitPlanRequestsAtom, (current) => upsertRequest(current, sessionId, event.request))
    } else if (event.type === 'exit_plan_mode_resolved') {
      if (bootstrapPending) resolvedExitPlanIds.add(event.requestId)
      store.set(allPendingExitPlanRequestsAtom, (current) => removeRequest(current, event.requestId))
    }
  }

  /** 会话真正结束时清除三类阻塞请求，并阻止启动快照恢复该会话的旧请求。 */
  const completeSession = (sessionId: string): void => {
    if (disposed) return
    if (bootstrapPending) terminalSessionIds.add(sessionId)
    clearSessionPendingRequests(store, sessionId)
  }

  /** 登记本次挂载实例，供停止回执复用同一批短期终态标记。 */
  const coordinator: PendingRequestRecoveryCoordinator = {
    start,
    handle,
    completeSession,
    dispose: () => {
      disposed = true
      if (activeRecoveryCoordinators.get(store) === coordinator) activeRecoveryCoordinators.delete(store)
      finishBootstrap()
    },
  }
  activeRecoveryCoordinators.set(store, coordinator)
  return coordinator
}
