import {
  parseCanvasImageTarget,
  type CanvasImageAspectRatio,
  type CanvasImageModuleSnapshot,
  type CanvasImageSize,
  type CanvasImageTarget,
  type CanvasMutation,
  type CanvasWorkspaceSnapshot,
  type DesignContextMode,
  type DesignTaskDetails,
  type SDKMessage,
} from '@proma/shared'
import { atom } from 'jotai'
import type { Store } from 'jotai/vanilla/store'
import type { CanvasAgentOwner } from '@/lib/canvas-agent-event-routing'
import {
  agentSessionStreamingStateAtomFamily,
  agentStreamErrorsAtom,
  liveMessagesMapAtom,
} from '@/atoms/agent-atoms'

/** 原生 Canvas 单工作区的加载阶段。 */
export type NativeCanvasPhase = 'idle' | 'loading' | 'ready' | 'error'

/** 原生 Canvas mutation 保存阶段。 */
export type NativeCanvasSaveState = 'saved' | 'dirty' | 'saving' | 'failed' | 'conflict'

/** Canvas 生图模块加载阶段。 */
export type CanvasImageModulePhase = 'idle' | 'loading' | 'ready' | 'error'

/** Canvas 生图模块配置保存阶段。 */
export type CanvasImageModuleSaveState = 'saved' | 'dirty' | 'saving' | 'failed' | 'conflict'

/** Canvas 生图模块可编辑字段及本地 dirty 标记。 */
export interface CanvasImageModuleDraft {
  prompt: string
  selectedModelProfileId: string | null
  aspectRatio: CanvasImageAspectRatio
  imageSize: CanvasImageSize
  contextMode: DesignContextMode
  dirty: boolean
}

/** 单个任务详情的按需加载状态。 */
export interface CanvasImageTaskDetailsState {
  phase: 'idle' | 'loading' | 'ready' | 'failed'
  details: DesignTaskDetails | null
  error: string | null
}

/** 单个四元身份图片模块的 Renderer 状态。 */
export interface CanvasImageModuleViewState {
  snapshot: CanvasImageModuleSnapshot | null
  draft: CanvasImageModuleDraft | null
  phase: CanvasImageModulePhase
  saveState: CanvasImageModuleSaveState
  error: string | null
  previewAssetId: string | null
  taskDetails: Map<string, CanvasImageTaskDetailsState>
}

/** 创建互不共享任务详情 Map 的图片模块初始状态。 */
export function createInitialCanvasImageModuleState(): CanvasImageModuleViewState {
  return {
    snapshot: null,
    draft: null,
    phase: 'idle',
    saveState: 'saved',
    error: null,
    previewAssetId: null,
    taskDetails: new Map(),
  }
}

/**
 * 创建 Canvas 图片模块完整身份键。
 * @param target 项目、Canvas、节点和图片模块四元身份。
 * @returns 经过安全 ID 校验且无分隔符碰撞的结构化键。
 */
export function createCanvasImageModuleKey(target: CanvasImageTarget): string {
  /** 复用共享边界校验，避免 Renderer 接受主进程不会接受的身份。 */
  const validated = parseCanvasImageTarget(target)
  return JSON.stringify([
    validated.projectId,
    validated.canvasId,
    validated.nodeId,
    validated.imageModuleId,
  ])
}

/** 共享 graph 的结构生命周期操作身份。 */
export interface NativeCanvasStructuralOperation {
  id: string
  kind: 'create' | 'delete' | 'restore' | 'rebuild' | 'arrange'
}

/** 按项目与 Canvas 双重身份隔离的 Renderer 状态。 */
export interface NativeCanvasState {
  phase: NativeCanvasPhase
  snapshot: CanvasWorkspaceSnapshot | null
  pendingMutations: CanvasMutation[]
  inFlightMutations: CanvasMutation[]
  saveState: NativeCanvasSaveState
  authoritativeRecoveryState: 'idle' | 'loading' | 'failed'
  /** recovery 期间观察到的最高普通 graph revision，跨 remount 保留。 */
  deferredGraphRevision: number | null
  /** 当前共享 graph 正在执行的唯一结构生命周期操作。 */
  structuralOperation: NativeCanvasStructuralOperation | null
  error: string | null
}

/** 创建互不共享数组引用的原生 Canvas 初始状态。 */
export function createInitialNativeCanvasState(): NativeCanvasState {
  return {
    phase: 'idle',
    snapshot: null,
    pendingMutations: [],
    inFlightMutations: [],
    saveState: 'saved',
    authoritativeRecoveryState: 'idle',
    deferredGraphRevision: null,
    structuralOperation: null,
    error: null,
  }
}

/**
 * 创建项目与 Canvas 组合键。
 * @param projectId Canvas 所属项目 ID。
 * @param canvasId Canvas 会话 ID。
 * @returns 用于 Renderer Map 隔离的稳定键。
 */
export function createNativeCanvasKey(projectId: string, canvasId: string): string {
  return `${projectId}:${canvasId}`
}

/** 所有已挂载原生 Canvas 的隔离状态。 */
export const nativeCanvasStatesAtom = atom<Map<string, NativeCanvasState>>(new Map())

/** 所有已挂载 Canvas 图片模块按完整四元身份隔离的状态。 */
export const canvasImageModuleStatesAtom = atom<Map<string, CanvasImageModuleViewState>>(new Map())

/** 图片模块状态支持局部对象或基于当前值的函数更新。 */
export type CanvasImageModuleStateUpdate = Partial<CanvasImageModuleViewState>
  | ((current: CanvasImageModuleViewState) => Partial<CanvasImageModuleViewState>)

/** 单个 Canvas 图片模块状态更新输入。 */
export interface UpdateCanvasImageModuleStateInput {
  key: string
  update: CanvasImageModuleStateUpdate
}

/** 只复制 Map 与目标图片模块状态的原子更新入口。 */
export const updateCanvasImageModuleStateAtom = atom(
  null,
  (get, set, input: UpdateCanvasImageModuleStateInput): void => {
    /** 未加载过的 key 获得独立初始状态，禁止跨节点共享 taskDetails。 */
    const states = get(canvasImageModuleStatesAtom)
    const current = states.get(input.key) ?? createInitialCanvasImageModuleState()
    const update = typeof input.update === 'function' ? input.update(current) : input.update
    const nextStates = new Map(states)
    nextStates.set(input.key, { ...current, ...update })
    set(canvasImageModuleStatesAtom, nextStates)
  },
)

/** 删除已失效图片模块状态的输入键。 */
export const removeCanvasImageModuleStateAtom = atom(
  null,
  (get, set, key: string): void => {
    /** 无目标时保留原 Map 引用，避免无意义 Renderer 更新。 */
    const states = get(canvasImageModuleStatesAtom)
    if (!states.has(key)) return
    const nextStates = new Map(states)
    nextStates.delete(key)
    set(canvasImageModuleStatesAtom, nextStates)
  },
)

/** 全局流事件按 sessionId 保存的最小 Canvas owner，切换 Canvas 或关闭面板不会清理。 */
export const canvasAgentOwnersAtom = atom<Map<string, CanvasAgentOwner>>(new Map())

/** 仅在打开对话后填充的权威 JSONL 消息缓存，未打开节点不会触发读取。 */
export const canvasAgentPersistedMessagesAtom = atom<Map<string, SDKMessage[]>>(new Map())

/** 当前仍打开对话面板的 Canvas Agent session。 */
export const canvasAgentOpenSessionIdsAtom = atom<Set<string>>(new Set<string>())

/** 当前启动、运行或排队中的 Canvas Agent session。 */
export const canvasAgentRunningSessionIdsAtom = atom<Set<string>>(new Set<string>())

/** 已由 bootstrap 或 Agent 流事件确认运行的 Canvas Agent session。 */
export const canvasAgentAuthoritativeRunningSessionIdsAtom = atom<Set<string>>(new Set<string>())

/** Renderer 已提交但主进程尚未确认的 Canvas Agent 运行 token。 */
export const canvasAgentOptimisticRunTokensAtom = atom<Map<string, string>>(new Map<string, string>())

/** 每个 Canvas Agent 最新权威运行代次；null 表示 bootstrap 只确认 busy、未确认代次。 */
export const canvasAgentRunGenerationsAtom = atom<Map<string, number | null>>(new Map<string, number | null>())

/** Renderer 已提交但主进程尚未确认的 Canvas Agent 乐观运行代次。 */
export const canvasAgentOptimisticRunGenerationsAtom = atom<Map<string, number>>(new Map<string, number>())

/** Canvas hard completion 后等待权威 JSONL GET 接管的运行代次。 */
export const canvasAgentPendingHandoffGenerationsAtom = atom<Map<string, number>>(new Map<string, number>())

/** 已确认 Canvas 字段损坏的内部 session，未知事件必须 fail closed。 */
export const canvasAgentInternalInvalidSessionIdsAtom = atom<Set<string>>(new Set<string>())

/** bootstrap 确认仍在运行的损坏内部 session，不受 terminal tombstone 上限影响。 */
export const canvasAgentActiveInternalInvalidSessionIdsAtom = atom<Set<string>>(new Set<string>())

/** 已终态的损坏内部 session tombstone，仅用于抑制迟到事件并按 LRU 有界。 */
export const canvasAgentTerminalInternalInvalidSessionIdsAtom = atom<Set<string>>(new Set<string>())

/** Canvas owner 与持久化消息缓存的生命周期事件。 */
export type CanvasAgentLifecycleEvent =
  | {
      type: 'bootstrap'
      owners: Array<CanvasAgentOwner & { startedAt?: number }>
      internalInvalidRuns: Array<{ sessionId: string; startedAt: number; valid: false }>
    }
  | { type: 'opened'; owner: CanvasAgentOwner; messages: SDKMessage[] }
  | { type: 'started'; owner: CanvasAgentOwner; startedAt: number }
  | { type: 'invalid-started'; sessionId: string; startedAt: number }
  | { type: 'owner-updated'; owner: CanvasAgentOwner }
  | { type: 'optimistic-started'; owner: CanvasAgentOwner; token: string; startedAt: number }
  | { type: 'send-rejected'; sessionId: string; token: string; preserveRunning: boolean }
  | { type: 'closed'; sessionId: string }
  | { type: 'completed' | 'settled'; sessionId: string; startedAt: number }
  | { type: 'invalidated'; sessionId: string; terminal: boolean; startedAt?: number }
  | { type: 'prune' }

/** 非打开、非运行的历史消息缓存最大 session 数。 */
const MAX_UNPROTECTED_CANVAS_AGENT_SESSIONS = 20
/** 单个 Canvas Agent 的持久化消息缓存上限。 */
const MAX_CANVAS_AGENT_MESSAGES_PER_SESSION = 500
/** 非保护 Canvas Agent 的持久化消息总上限。 */
const MAX_UNPROTECTED_CANVAS_AGENT_MESSAGES = 2_000
/** 终态损坏 session tombstone 上限；active invalid 不受此限制。 */
const MAX_INVALID_CANVAS_AGENT_SESSIONS = 100

/** 判断异步终态副作用是否仍属于当前 Canvas Agent 运行代次。 */
export function isCanvasAgentGenerationCurrent(
  store: Pick<Store, 'get'>,
  sessionId: string,
  startedAt: number,
): boolean {
  const authoritativeGenerations = store.get(canvasAgentRunGenerationsAtom)
  if (authoritativeGenerations.has(sessionId)) return authoritativeGenerations.get(sessionId) === startedAt
  return store.get(canvasAgentOptimisticRunGenerationsAtom).get(sessionId) === startedAt
}

/** 判断异步 JSONL GET 是否仍属于等待交接的 Canvas Agent 终态代次。 */
export function isCanvasAgentHandoffGenerationCurrent(
  store: Pick<Store, 'get'>,
  sessionId: string,
  startedAt: number,
): boolean {
  return store.get(canvasAgentPendingHandoffGenerationsAtom).get(sessionId) === startedAt
}

/**
 * 修剪非打开、非运行的 Canvas Agent owner 与消息缓存。
 * @param owners 当前 owner Map，可在函数内原位修剪。
 * @param messages 当前消息 Map，可在函数内原位修剪。
 * @param protectedIds 当前打开或运行中的 session 集合。
 */
function pruneCanvasAgentCaches(
  owners: Map<string, CanvasAgentOwner>,
  messages: Map<string, SDKMessage[]>,
  protectedIds: Set<string>,
): void {
  /** 只有非保护历史允许截断；open/running 必须保留完整权威 JSONL。 */
  for (const [sessionId, entries] of messages) {
    if (!protectedIds.has(sessionId) && entries.length > MAX_CANVAS_AGENT_MESSAGES_PER_SESSION) {
      messages.set(sessionId, entries.slice(-MAX_CANVAS_AGENT_MESSAGES_PER_SESSION))
    }
  }
  /** Map 插入顺序作为轻量 LRU；GET/open 会重新插入目标 session。 */
  const unprotectedIds = [...messages.keys()].filter((sessionId) => !protectedIds.has(sessionId))
  /** 非保护消息总数，超限时优先回收最旧 session。 */
  let unprotectedMessageCount = unprotectedIds.reduce(
    (count, sessionId) => count + (messages.get(sessionId)?.length ?? 0),
    0,
  )
  while (unprotectedIds.length > MAX_UNPROTECTED_CANVAS_AGENT_SESSIONS
    || unprotectedMessageCount > MAX_UNPROTECTED_CANVAS_AGENT_MESSAGES) {
    const sessionId = unprotectedIds.shift()
    if (!sessionId) break
    unprotectedMessageCount -= messages.get(sessionId)?.length ?? 0
    messages.delete(sessionId)
    owners.delete(sessionId)
  }
  /** 没有消息条目的非保护 owner 同样不允许无限残留。 */
  for (const sessionId of owners.keys()) {
    if (!protectedIds.has(sessionId) && !messages.has(sessionId)) owners.delete(sessionId)
  }
}

/** owner、打开态、运行态与消息缓存的唯一生命周期写入口。 */
export const canvasAgentLifecycleAtom = atom(
  null,
  (get, set, event: CanvasAgentLifecycleEvent): void => {
    /** 生命周期事件频率远低于 token 事件，可以在此集中复制一次 Map/Set。 */
    const owners = new Map(get(canvasAgentOwnersAtom))
    const messages = new Map(get(canvasAgentPersistedMessagesAtom))
    const openSessionIds = new Set(get(canvasAgentOpenSessionIdsAtom))
    const runningSessionIds = new Set(get(canvasAgentRunningSessionIdsAtom))
    const authoritativeRunningSessionIds = new Set(get(canvasAgentAuthoritativeRunningSessionIdsAtom))
    const optimisticRunTokens = new Map(get(canvasAgentOptimisticRunTokensAtom))
    const runGenerations = new Map(get(canvasAgentRunGenerationsAtom))
    const optimisticRunGenerations = new Map(get(canvasAgentOptimisticRunGenerationsAtom))
    const pendingHandoffGenerations = new Map(get(canvasAgentPendingHandoffGenerationsAtom))
    const activeInvalidSessionIds = new Set(get(canvasAgentActiveInternalInvalidSessionIdsAtom))
    const terminalInvalidSessionIds = new Set(get(canvasAgentTerminalInternalInvalidSessionIdsAtom))

    if (event.type === 'completed' || (event.type === 'invalidated' && event.terminal)) {
      /** 权威代次存在时绝不回退乐观值，避免 busy 误发覆盖真实运行。 */
      const currentGeneration = runGenerations.has(event.sessionId)
        ? runGenerations.get(event.sessionId)
        : optimisticRunGenerations.get(event.sessionId)
      if (currentGeneration !== event.startedAt) return
    }
    if (event.type === 'settled'
      && pendingHandoffGenerations.get(event.sessionId) !== event.startedAt) return

    if (event.type === 'bootstrap') {
      /** reload 初始快照替换运行态；仍打开的面板由后续 GET 再建立。 */
      authoritativeRunningSessionIds.clear()
      runGenerations.clear()
      activeInvalidSessionIds.clear()
      for (const owner of event.owners) {
        /** bootstrap 快照的运行代次与纯 owner 分开保存，避免内部字段污染导航归属。 */
        const { startedAt, ...canvasOwner } = owner
        owners.delete(owner.sessionId)
        owners.set(owner.sessionId, canvasOwner)
        authoritativeRunningSessionIds.add(owner.sessionId)
        runGenerations.set(owner.sessionId, startedAt ?? null)
      }
      for (const invalidRun of event.internalInvalidRuns) {
        terminalInvalidSessionIds.delete(invalidRun.sessionId)
        activeInvalidSessionIds.add(invalidRun.sessionId)
        runGenerations.set(invalidRun.sessionId, invalidRun.startedAt)
      }
    } else if (event.type === 'opened') {
      owners.delete(event.owner.sessionId)
      owners.set(event.owner.sessionId, event.owner)
      messages.delete(event.owner.sessionId)
      messages.set(event.owner.sessionId, event.messages)
      openSessionIds.add(event.owner.sessionId)
      activeInvalidSessionIds.delete(event.owner.sessionId)
      terminalInvalidSessionIds.delete(event.owner.sessionId)
    } else if (event.type === 'started') {
      const currentGeneration = runGenerations.get(event.owner.sessionId)
      if (typeof currentGeneration === 'number' && currentGeneration > event.startedAt) return
      owners.delete(event.owner.sessionId)
      owners.set(event.owner.sessionId, event.owner)
      activeInvalidSessionIds.delete(event.owner.sessionId)
      terminalInvalidSessionIds.delete(event.owner.sessionId)
      authoritativeRunningSessionIds.add(event.owner.sessionId)
      runGenerations.set(event.owner.sessionId, event.startedAt)
      pendingHandoffGenerations.delete(event.owner.sessionId)
    } else if (event.type === 'invalid-started') {
      const currentGeneration = runGenerations.get(event.sessionId)
      if (typeof currentGeneration === 'number' && currentGeneration > event.startedAt) return
      owners.delete(event.sessionId)
      messages.delete(event.sessionId)
      authoritativeRunningSessionIds.delete(event.sessionId)
      activeInvalidSessionIds.add(event.sessionId)
      terminalInvalidSessionIds.delete(event.sessionId)
      runGenerations.set(event.sessionId, event.startedAt)
      pendingHandoffGenerations.delete(event.sessionId)
    } else if (event.type === 'owner-updated') {
      owners.delete(event.owner.sessionId)
      owners.set(event.owner.sessionId, event.owner)
      activeInvalidSessionIds.delete(event.owner.sessionId)
      terminalInvalidSessionIds.delete(event.owner.sessionId)
    } else if (event.type === 'optimistic-started') {
      owners.delete(event.owner.sessionId)
      owners.set(event.owner.sessionId, event.owner)
      optimisticRunTokens.set(event.owner.sessionId, event.token)
      optimisticRunGenerations.set(event.owner.sessionId, event.startedAt)
      pendingHandoffGenerations.delete(event.owner.sessionId)
      activeInvalidSessionIds.delete(event.owner.sessionId)
      terminalInvalidSessionIds.delete(event.owner.sessionId)
    } else if (event.type === 'send-rejected') {
      /** 迟到的旧请求只能收口自己的 token，不能覆盖同 session 的新一轮运行。 */
      if (optimisticRunTokens.get(event.sessionId) === event.token) {
        optimisticRunTokens.delete(event.sessionId)
        optimisticRunGenerations.delete(event.sessionId)
        if (event.preserveRunning) {
          if (!authoritativeRunningSessionIds.has(event.sessionId)) runGenerations.set(event.sessionId, null)
          authoritativeRunningSessionIds.add(event.sessionId)
        } else if (!authoritativeRunningSessionIds.has(event.sessionId)) {
          runGenerations.delete(event.sessionId)
        }
        if (!event.preserveRunning
          && !authoritativeRunningSessionIds.has(event.sessionId)
          && !openSessionIds.has(event.sessionId)) {
          owners.delete(event.sessionId)
          messages.delete(event.sessionId)
        }
      }
    } else if (event.type === 'closed') {
      openSessionIds.delete(event.sessionId)
      pendingHandoffGenerations.delete(event.sessionId)
      if (!runningSessionIds.has(event.sessionId)) {
        owners.delete(event.sessionId)
        messages.delete(event.sessionId)
        runGenerations.delete(event.sessionId)
        optimisticRunGenerations.delete(event.sessionId)
      }
    } else if (event.type === 'completed') {
      authoritativeRunningSessionIds.delete(event.sessionId)
      optimisticRunTokens.delete(event.sessionId)
      runGenerations.delete(event.sessionId)
      optimisticRunGenerations.delete(event.sessionId)
      if (openSessionIds.has(event.sessionId)) {
        pendingHandoffGenerations.set(event.sessionId, event.startedAt)
      } else {
        pendingHandoffGenerations.delete(event.sessionId)
        owners.delete(event.sessionId)
        messages.delete(event.sessionId)
      }
    } else if (event.type === 'settled') {
      pendingHandoffGenerations.delete(event.sessionId)
    } else if (event.type === 'invalidated') {
      owners.delete(event.sessionId)
      messages.delete(event.sessionId)
      openSessionIds.delete(event.sessionId)
      pendingHandoffGenerations.delete(event.sessionId)
      if (event.terminal) {
        authoritativeRunningSessionIds.delete(event.sessionId)
        optimisticRunTokens.delete(event.sessionId)
        runGenerations.delete(event.sessionId)
        optimisticRunGenerations.delete(event.sessionId)
        activeInvalidSessionIds.delete(event.sessionId)
        terminalInvalidSessionIds.delete(event.sessionId)
        terminalInvalidSessionIds.add(event.sessionId)
      } else if (!terminalInvalidSessionIds.has(event.sessionId)) {
        /** soft completion 后运行仍可恢复，继续以 active invalid 阻断后续流事件。 */
        activeInvalidSessionIds.add(event.sessionId)
      }
    }

    /** 对外 busy 集合始终由权威运行与当前乐观 token 的并集派生。 */
    runningSessionIds.clear()
    for (const sessionId of authoritativeRunningSessionIds) runningSessionIds.add(sessionId)
    for (const sessionId of optimisticRunTokens.keys()) runningSessionIds.add(sessionId)

    /** 只有不再打开且不再运行，或 GET 已完成交接时，才释放共享流式状态。 */
    const shouldReleaseRuntimeState = (event.type === 'settled' && !runningSessionIds.has(event.sessionId))
      || ((event.type === 'closed' || event.type === 'completed')
        && !openSessionIds.has(event.sessionId)
        && !runningSessionIds.has(event.sessionId))
      || (event.type === 'invalidated' && event.terminal)
    if (shouldReleaseRuntimeState) {
      set(liveMessagesMapAtom, (previous) => {
        if (!previous.has(event.sessionId)) return previous
        const next = new Map(previous)
        next.delete(event.sessionId)
        return next
      })
      set(agentStreamErrorsAtom, (previous) => {
        if (!previous.has(event.sessionId)) return previous
        const next = new Map(previous)
        next.delete(event.sessionId)
        return next
      })
      set(agentSessionStreamingStateAtomFamily(event.sessionId), undefined)
    }

    /** 打开或运行的 session 是保护项，可暂时超过非保护总量。 */
    const protectedIds = new Set([...openSessionIds, ...runningSessionIds])
    pruneCanvasAgentCaches(owners, messages, protectedIds)
    while (terminalInvalidSessionIds.size > MAX_INVALID_CANVAS_AGENT_SESSIONS) {
      const oldestSessionId = terminalInvalidSessionIds.values().next().value
      if (oldestSessionId === undefined) break
      terminalInvalidSessionIds.delete(oldestSessionId)
    }
    /** union 只在低频 lifecycle 写入口重建；token 分类继续直接 O(1) 查询。 */
    const invalidSessionIds = new Set([...activeInvalidSessionIds, ...terminalInvalidSessionIds])
    set(canvasAgentOwnersAtom, owners)
    set(canvasAgentPersistedMessagesAtom, messages)
    set(canvasAgentOpenSessionIdsAtom, openSessionIds)
    set(canvasAgentRunningSessionIdsAtom, runningSessionIds)
    set(canvasAgentAuthoritativeRunningSessionIdsAtom, authoritativeRunningSessionIds)
    set(canvasAgentOptimisticRunTokensAtom, optimisticRunTokens)
    set(canvasAgentRunGenerationsAtom, runGenerations)
    set(canvasAgentOptimisticRunGenerationsAtom, optimisticRunGenerations)
    set(canvasAgentPendingHandoffGenerationsAtom, pendingHandoffGenerations)
    set(canvasAgentActiveInternalInvalidSessionIdsAtom, activeInvalidSessionIds)
    set(canvasAgentTerminalInternalInvalidSessionIdsAtom, terminalInvalidSessionIds)
    set(canvasAgentInternalInvalidSessionIdsAtom, invalidSessionIds)
  },
)

/** 单个原生 Canvas 状态更新输入。 */
export interface UpdateNativeCanvasStateInput {
  key: string
  update: Partial<NativeCanvasState> | ((current: NativeCanvasState) => Partial<NativeCanvasState>)
}

/** 只复制 Map 与目标状态的原子更新入口。 */
export const updateNativeCanvasStateAtom = atom(
  null,
  (get, set, input: UpdateNativeCanvasStateInput): void => {
    /** 未挂载过的键始终取得全新数组，避免跨 Canvas 共享队列。 */
    const states = get(nativeCanvasStatesAtom)
    const current = states.get(input.key) ?? createInitialNativeCanvasState()
    const update = typeof input.update === 'function' ? input.update(current) : input.update
    const nextStates = new Map(states)
    nextStates.set(input.key, { ...current, ...update })
    set(nativeCanvasStatesAtom, nextStates)
  },
)

/** 共享 graph 结构操作获取输入。 */
export interface AcquireNativeCanvasStructuralOperationInput {
  key: string
  operation: NativeCanvasStructuralOperation
}

/** 仅在 graph 空闲时原子取得结构操作 token。 */
export const acquireNativeCanvasStructuralOperationAtom = atom(
  null,
  (get, set, input: AcquireNativeCanvasStructuralOperationInput): boolean => {
    const states = get(nativeCanvasStatesAtom)
    const current = states.get(input.key) ?? createInitialNativeCanvasState()
    if (!current.snapshot?.writable
      || current.structuralOperation !== null
      || current.pendingMutations.length > 0
      || current.inFlightMutations.length > 0
      || current.saveState !== 'saved'
      || current.authoritativeRecoveryState !== 'idle') return false
    const nextStates = new Map(states)
    nextStates.set(input.key, { ...current, structuralOperation: input.operation })
    set(nativeCanvasStatesAtom, nextStates)
    return true
  },
)

/** 共享 graph 结构操作释放输入。 */
export interface ReleaseNativeCanvasStructuralOperationInput {
  key: string
  operationId: string
}

/** 只有持有者可释放结构操作 token。 */
export const releaseNativeCanvasStructuralOperationAtom = atom(
  null,
  (get, set, input: ReleaseNativeCanvasStructuralOperationInput): boolean => {
    const states = get(nativeCanvasStatesAtom)
    const current = states.get(input.key)
    if (!current || current.structuralOperation?.id !== input.operationId) return false
    const nextStates = new Map(states)
    nextStates.set(input.key, { ...current, structuralOperation: null })
    set(nativeCanvasStatesAtom, nextStates)
    return true
  },
)
