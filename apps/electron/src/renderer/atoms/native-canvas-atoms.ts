import type { CanvasMutation, CanvasWorkspaceSnapshot, SDKMessage } from '@proma/shared'
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

/** 按项目与 Canvas 双重身份隔离的 Renderer 状态。 */
export interface NativeCanvasState {
  phase: NativeCanvasPhase
  snapshot: CanvasWorkspaceSnapshot | null
  pendingMutations: CanvasMutation[]
  inFlightMutations: CanvasMutation[]
  saveState: NativeCanvasSaveState
  selectedNodeId: string | null
  conversationNodeId: string | null
  authoritativeRecoveryState: 'idle' | 'loading' | 'failed'
  /** recovery 期间观察到的最高普通 graph revision，跨 remount 保留。 */
  deferredGraphRevision: number | null
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
    selectedNodeId: null,
    conversationNodeId: null,
    authoritativeRecoveryState: 'idle',
    deferredGraphRevision: null,
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

/** 每个 Canvas Agent 最新已知运行代次；null 表示 bootstrap 只确认 busy、未确认代次。 */
export const canvasAgentRunGenerationsAtom = atom<Map<string, number | null>>(new Map<string, number | null>())

/** 已确认 Canvas 字段损坏的内部 session，未知事件必须 fail closed。 */
export const canvasAgentInternalInvalidSessionIdsAtom = atom<Set<string>>(new Set<string>())

/** bootstrap 确认仍在运行的损坏内部 session，不受 terminal tombstone 上限影响。 */
export const canvasAgentActiveInternalInvalidSessionIdsAtom = atom<Set<string>>(new Set<string>())

/** 已终态的损坏内部 session tombstone，仅用于抑制迟到事件并按 LRU 有界。 */
export const canvasAgentTerminalInternalInvalidSessionIdsAtom = atom<Set<string>>(new Set<string>())

/** Canvas owner 与持久化消息缓存的生命周期事件。 */
export type CanvasAgentLifecycleEvent =
  | { type: 'bootstrap'; owners: Array<CanvasAgentOwner & { startedAt?: number }>; internalInvalidSessionIds: string[] }
  | { type: 'opened'; owner: CanvasAgentOwner; messages: SDKMessage[] }
  | { type: 'started'; owner: CanvasAgentOwner; startedAt: number }
  | { type: 'owner-updated'; owner: CanvasAgentOwner }
  | { type: 'optimistic-started'; owner: CanvasAgentOwner; token: string; startedAt: number }
  | { type: 'send-rejected'; sessionId: string; token: string; preserveRunning: boolean }
  | { type: 'closed'; sessionId: string }
  | { type: 'completed' | 'settled'; sessionId: string; startedAt: number }
  | { type: 'invalidated'; sessionId: string; terminal: boolean }
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
  return store.get(canvasAgentRunGenerationsAtom).get(sessionId) === startedAt
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
    const activeInvalidSessionIds = new Set(get(canvasAgentActiveInternalInvalidSessionIdsAtom))
    const terminalInvalidSessionIds = new Set(get(canvasAgentTerminalInternalInvalidSessionIdsAtom))

    if ((event.type === 'completed' || event.type === 'settled')
      && runGenerations.get(event.sessionId) !== event.startedAt) return

    if (event.type === 'bootstrap') {
      /** reload 初始快照替换运行态；仍打开的面板由后续 GET 再建立。 */
      authoritativeRunningSessionIds.clear()
      activeInvalidSessionIds.clear()
      for (const owner of event.owners) {
        /** bootstrap 快照的运行代次与纯 owner 分开保存，避免内部字段污染导航归属。 */
        const { startedAt, ...canvasOwner } = owner
        owners.delete(owner.sessionId)
        owners.set(owner.sessionId, canvasOwner)
        authoritativeRunningSessionIds.add(owner.sessionId)
        runGenerations.set(owner.sessionId, startedAt ?? null)
      }
      for (const sessionId of event.internalInvalidSessionIds) {
        terminalInvalidSessionIds.delete(sessionId)
        activeInvalidSessionIds.add(sessionId)
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
    } else if (event.type === 'owner-updated') {
      owners.delete(event.owner.sessionId)
      owners.set(event.owner.sessionId, event.owner)
      activeInvalidSessionIds.delete(event.owner.sessionId)
      terminalInvalidSessionIds.delete(event.owner.sessionId)
    } else if (event.type === 'optimistic-started') {
      owners.delete(event.owner.sessionId)
      owners.set(event.owner.sessionId, event.owner)
      optimisticRunTokens.set(event.owner.sessionId, event.token)
      runGenerations.set(event.owner.sessionId, event.startedAt)
      activeInvalidSessionIds.delete(event.owner.sessionId)
      terminalInvalidSessionIds.delete(event.owner.sessionId)
    } else if (event.type === 'send-rejected') {
      /** 迟到的旧请求只能收口自己的 token，不能覆盖同 session 的新一轮运行。 */
      if (optimisticRunTokens.get(event.sessionId) === event.token) {
        optimisticRunTokens.delete(event.sessionId)
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
      if (!runningSessionIds.has(event.sessionId)) {
        owners.delete(event.sessionId)
        messages.delete(event.sessionId)
        runGenerations.delete(event.sessionId)
      }
    } else if (event.type === 'completed') {
      authoritativeRunningSessionIds.delete(event.sessionId)
      optimisticRunTokens.delete(event.sessionId)
      if (!openSessionIds.has(event.sessionId)) {
        owners.delete(event.sessionId)
        messages.delete(event.sessionId)
        runGenerations.delete(event.sessionId)
      }
    } else if (event.type === 'settled') {
      runGenerations.delete(event.sessionId)
    } else if (event.type === 'invalidated') {
      owners.delete(event.sessionId)
      messages.delete(event.sessionId)
      openSessionIds.delete(event.sessionId)
      if (event.terminal) {
        authoritativeRunningSessionIds.delete(event.sessionId)
        optimisticRunTokens.delete(event.sessionId)
        runGenerations.delete(event.sessionId)
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
