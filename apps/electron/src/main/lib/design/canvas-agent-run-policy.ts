import type {
  AgentSessionMeta,
  CanvasAgentNode,
  CanvasDocument,
  CanvasTarget,
} from '@proma/shared'
import { hasValidCanvasAgentOwnership } from '../agent-session-visibility'

/** Canvas 对话单次运行唯一允许的只读 Pi 工具。 */
export const CANVAS_AGENT_ALLOWED_TOOL_NAMES = ['Read', 'Glob', 'Grep'] as const

/** 解析 Canvas Agent 权威归属所需的可信输入。 */
export interface CanvasAgentRunOwnerInput {
  target: CanvasTarget
  nodeId: string
  document: CanvasDocument
  getSession: (sessionId: string) => AgentSessionMeta | undefined
}

/** 已双向验证的 Canvas 节点与内部会话。 */
export interface CanvasAgentRunOwner {
  node: CanvasAgentNode
  session: AgentSessionMeta
}

/**
 * 从权威 Canvas 文档解析节点引用，并复核会话三字段的完整独占归属。
 * @param input 权威文档、目标身份和会话查询边界。
 * @returns 只能用于本次 GET/SEND/STOP 的节点与会话事实。
 */
export function requireCanvasAgentRunOwner(input: CanvasAgentRunOwnerInput): CanvasAgentRunOwner {
  const node = input.document.nodes.find((candidate) => candidate.id === input.nodeId)
  if (!node || node.kind !== 'agent') throw new Error('Canvas Agent 归属无效')
  const session = input.getSession(node.agentSessionId)
  if (!session
    || !hasValidCanvasAgentOwnership(session)
    || session.sourceCanvasProjectId !== input.target.projectId
    || session.sourceCanvasId !== input.target.canvasId
    || session.sourceCanvasNodeId !== node.id) {
    throw new Error('Canvas Agent 归属无效')
  }
  return { node, session }
}
