import type { AgentSessionMeta } from './agent'

/** 包含内部 Agent 会话所有权字段的最小判断输入。 */
export type AgentSessionOwnershipFields = Pick<
  AgentSessionMeta,
  | 'workspaceId'
  | 'sourceDesignProjectId'
  | 'sourceDesignJobId'
  | 'sourceCanvasProjectId'
  | 'sourceCanvasId'
  | 'sourceCanvasNodeId'
  | 'sourceAutomationId'
  | 'automationGraduated'
  | 'parentSessionId'
  | 'rootSessionId'
  | 'sourceDelegationId'
  | 'delegationRole'
  | 'delegationStatus'
  | 'delegationDepth'
  | 'delegationGoal'
>

/** 项目画布可关联的普通 Agent 额外需要的生命周期字段。 */
export type ProjectAgentEligibilityFields = AgentSessionOwnershipFields & Pick<
  AgentSessionMeta,
  'archived' | 'explorationParentSessionId'
>

/** Canvas 内部会话必须排除的其它来源与协作字段。 */
export const AGENT_CANVAS_EXCLUSIVE_OWNERSHIP_FIELDS = [
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
] as const

/** 普通顶层交互式 Agent 不得携带的后台任务与父子协作字段。 */
export const ORDINARY_TOP_LEVEL_EXCLUDED_FIELDS = [
  'sourceAutomationId',
  'automationGraduated',
  'parentSessionId',
  'rootSessionId',
  'sourceDelegationId',
  'delegationRole',
  'delegationStatus',
  'delegationDepth',
  'delegationGoal',
] as const

/**
 * 判断会话是否声明了任一 Canvas 来源字段。
 * @param session 待判断的内部来源字段。
 * @returns 任一 Canvas 字段存在时返回 true，包含空字符串等损坏值。
 */
export function hasAnyCanvasSourceField(session: AgentSessionOwnershipFields): boolean {
  return session.sourceCanvasProjectId !== undefined
    || session.sourceCanvasId !== undefined
    || session.sourceCanvasNodeId !== undefined
}

/**
 * 判断会话是否带有任一 Design 来源标记。
 * @param session 待判断的会话来源字段。
 * @returns 任一字段存在即返回 true，损坏的半元数据也会 fail closed。
 */
export function isInternalDesignSession(session: AgentSessionOwnershipFields): boolean {
  return session.sourceDesignProjectId !== undefined || session.sourceDesignJobId !== undefined
}

/**
 * 判断内部 Canvas Agent 是否拥有完整且唯一的项目归属。
 * @param session 待判断的工作区及内部来源字段。
 * @returns Canvas 三字段规范、项目匹配且未混入其它来源或协作字段时返回 true。
 */
export function hasValidCanvasAgentOwnership(session: AgentSessionOwnershipFields): boolean {
  /** Canvas Agent 是独占会话类型，任何其它来源字段都表示所有权污染。 */
  if (AGENT_CANVAS_EXCLUSIVE_OWNERSHIP_FIELDS.some((field) => session[field] !== undefined)) return false
  const canvasFields = [
    session.sourceCanvasProjectId,
    session.sourceCanvasId,
    session.sourceCanvasNodeId,
  ]
  return canvasFields.every((value) => typeof value === 'string'
    && value.length > 0
    && value.trim() === value)
    && session.workspaceId === session.sourceCanvasProjectId
}

/**
 * 判断会话是否允许出现在普通用户入口。
 * @param session 待判断的会话来源字段。
 * @returns 不带任何 Design 或 Canvas 来源标记时返回 true。
 */
export function isAgentSessionUserVisible(session: AgentSessionOwnershipFields): boolean {
  return !isInternalDesignSession(session) && !hasAnyCanvasSourceField(session)
}

/**
 * 判断会话是否为普通顶层交互式 Agent。
 *
 * 主进程的服务器授权、Electron 侧的高权限入口都以此为准；渲染层复用同一份规则，
 * 只为在按钮上提前给出禁用原因，真正的边界仍只在主进程执行。
 *
 * @param session 待判断的会话；不存在时直接拒绝。
 * @returns 会话用户可见且不带后台任务、父子或 Delegation 残留字段时返回 true。
 */
export function isOrdinaryTopLevelAgentSession(
  session: AgentSessionMeta | undefined,
): session is AgentSessionMeta {
  return !!session
    && isAgentSessionUserVisible(session)
    && ORDINARY_TOP_LEVEL_EXCLUDED_FIELDS.every((field) => session[field] === undefined)
}

/**
 * 收窄仅允许普通顶层交互式 Agent 使用的高权限入口。
 * @param session 会话索引中的候选记录。
 * @returns 已验证的普通顶层 Agent 会话。
 */
export function requireOrdinaryTopLevelAgentSession(
  session: AgentSessionMeta | undefined,
): AgentSessionMeta {
  if (!isOrdinaryTopLevelAgentSession(session)) throw new Error('Agent 会话不存在')
  return session
}
