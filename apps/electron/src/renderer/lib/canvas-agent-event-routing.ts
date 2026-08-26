import type { AgentSessionMeta } from '@proma/shared'

/** Renderer 可公开持有的最小 Canvas Agent owner，不包含路径或存储形态。 */
export interface CanvasAgentOwner {
  sessionId: string
  projectId: string
  canvasId: string
  nodeId: string
  title: string
}

/** 全局事件只分为 Canvas 内部会话或普通 Agent 两条路径。 */
export type CanvasAgentEventRoute =
  | { kind: 'canvas'; owner: CanvasAgentOwner }
  | { kind: 'agent' }
  | { kind: 'internal-invalid' }

/** bootstrap gate 对单个事件的当前分类。 */
export type CanvasAgentBootstrapEventKind = CanvasAgentEventRoute['kind'] | 'unknown'

/** 一次性 bootstrap gate 的依赖。 */
export interface CanvasAgentBootstrapGateOptions<T extends { sessionId: string }> {
  classify: (event: T) => CanvasAgentBootstrapEventKind
  dispatch: (event: T) => void
  maxBufferedEvents?: number
  /** ready 后是否允许未知事件进入普通恢复路径。 */
  allowUnknownAfterReady?: (event: T) => boolean
  /** 是否允许已确认损坏的内部事件进入专用终态清理。 */
  allowInternalInvalid?: (event: T) => boolean
}

/** renderer reload 期间未知事件的有界暂存入口。 */
export interface CanvasAgentBootstrapGate<T extends { sessionId: string }> {
  handle: (event: T) => void
  complete: () => void
  fail: () => void
}

/**
 * 创建一次性 Canvas owner bootstrap gate。
 * @param options 动态分类、真实分发与最大暂存数。
 * @returns bootstrap 前暂存未知事件、成功后重放、失败后 fail closed 的 gate。
 */
export function createCanvasAgentBootstrapGate<T extends { sessionId: string }>(
  options: CanvasAgentBootstrapGateOptions<T>,
): CanvasAgentBootstrapGate<T> {
  /** pending 只持续一次本地主进程 IPC；failed 时未知事件持续 fail closed。 */
  let phase: 'pending' | 'ready' | 'failed' = 'pending'
  /** 防止异常 IPC 长挂时事件数组无限增长。 */
  const maxBufferedEvents = options.maxBufferedEvents ?? 2_000
  /** 保持 stream/title 到达顺序的有界队列。 */
  const bufferedEvents: T[] = []
  const route = (event: T): void => {
    const kind = options.classify(event)
    if (kind === 'canvas' || kind === 'agent') options.dispatch(event)
    else if (kind === 'internal-invalid' && options.allowInternalInvalid?.(event) === true) {
      options.dispatch(event)
    } else if (kind === 'unknown'
      && phase === 'ready'
      && (options.allowUnknownAfterReady?.(event) ?? true)) {
      options.dispatch(event)
    }
    else if (kind === 'unknown' && phase === 'pending') {
      if (bufferedEvents.length >= maxBufferedEvents) bufferedEvents.shift()
      bufferedEvents.push(event)
    }
  }
  return {
    handle: route,
    complete: () => {
      if (phase !== 'pending') return
      phase = 'ready'
      const replay = bufferedEvents.splice(0)
      for (const event of replay) route(event)
    },
    fail: () => {
      if (phase !== 'pending') return
      phase = 'failed'
      bufferedEvents.length = 0
    },
  }
}

/** Canvas owner 必须排除的其它内部来源，保持与主进程会话可见性合同一致。 */
const CANVAS_EXCLUSIVE_OWNERSHIP_FIELDS = [
  'sourceDesignProjectId',
  'sourceDesignJobId',
  'sourceAutomationId',
  'automationGraduated',
  'parentSessionId',
  'rootSessionId',
  'sourceDelegationId',
  'delegationRole',
  'delegationStatus',
  'delegationDepth',
  'delegationGoal',
] as const satisfies readonly (keyof AgentSessionMeta)[]

/**
 * 根据主进程安全 metadata 纯函数路由 Agent 事件。
 * @param session 完成事件或启动事件携带的轻量会话元数据。
 * @returns 完整 Canvas 归属才进入内部路径，损坏元数据 fail closed 为普通不可提升路径。
 */
export function routeCanvasAgentEvent(session: AgentSessionMeta | undefined): CanvasAgentEventRoute {
  if (!session) return { kind: 'agent' }
  const hasCanvasSource = session.sourceCanvasProjectId !== undefined
    || session.sourceCanvasId !== undefined
    || session.sourceCanvasNodeId !== undefined
  if (!hasCanvasSource) return { kind: 'agent' }
  if (CANVAS_EXCLUSIVE_OWNERSHIP_FIELDS.some((field) => session[field] !== undefined)) {
    return { kind: 'internal-invalid' }
  }
  if (typeof session.sourceCanvasProjectId !== 'string'
    || typeof session.sourceCanvasId !== 'string'
    || typeof session.sourceCanvasNodeId !== 'string'
    || session.sourceCanvasProjectId.length === 0
    || session.sourceCanvasId.length === 0
    || session.sourceCanvasNodeId.length === 0
    || session.sourceCanvasProjectId.trim() !== session.sourceCanvasProjectId
    || session.sourceCanvasId.trim() !== session.sourceCanvasId
    || session.sourceCanvasNodeId.trim() !== session.sourceCanvasNodeId
    || session.workspaceId !== session.sourceCanvasProjectId) {
    return { kind: 'internal-invalid' }
  }
  return {
    kind: 'canvas',
    owner: {
      sessionId: session.id,
      projectId: session.sourceCanvasProjectId,
      canvasId: session.sourceCanvasId,
      nodeId: session.sourceCanvasNodeId,
      title: session.title,
    },
  }
}

/**
 * 解析 completion 的 Canvas 归属，明确 metadata 永远优先于旧缓存。
 * @param sessionId completion 会话 ID。
 * @param session completion 携带的安全 metadata，缺失表示旧协议或异常路径。
 * @param cachedOwner Renderer 已验证的 owner 缓存。
 * @returns 损坏 metadata fail closed；仅 metadata 缺失时允许使用缓存。
 */
export function resolveCanvasAgentCompletion(
  sessionId: string,
  session: AgentSessionMeta | undefined,
  cachedOwner: CanvasAgentOwner | undefined,
  knownInternalInvalid = false,
): CanvasAgentEventRoute {
  const route = routeCanvasAgentEvent(session)
  if (route.kind !== 'agent') return route
  if (session === undefined && knownInternalInvalid) return { kind: 'internal-invalid' }
  if (session === undefined && cachedOwner?.sessionId === sessionId) {
    return { kind: 'canvas', owner: cachedOwner }
  }
  return route
}
