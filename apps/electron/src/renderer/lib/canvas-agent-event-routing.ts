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
