import type { AgentSessionMeta } from '@proma/shared'

/** 包含内部 Agent 会话所有权字段的最小判断输入。 */
type InternalSessionFields = Pick<
  AgentSessionMeta,
  | 'workspaceId'
  | 'sourceDesignProjectId'
  | 'sourceDesignJobId'
  | 'sourceCanvasProjectId'
  | 'sourceCanvasId'
  | 'sourceCanvasNodeId'
>

/**
 * 判断会话是否声明了任一 Canvas 来源字段。
 * @param session 待判断的内部来源字段。
 * @returns 任一 Canvas 字段存在时返回 true，包含空字符串等损坏值。
 */
function hasAnyCanvasSourceField(session: InternalSessionFields): boolean {
  return session.sourceCanvasProjectId !== undefined
    || session.sourceCanvasId !== undefined
    || session.sourceCanvasNodeId !== undefined
}

/**
 * 判断会话是否带有任一 Design 来源标记。
 * @param session 待判断的会话来源字段。
 * @returns 任一字段存在即返回 true，损坏的半元数据也会 fail closed。
 */
export function isInternalDesignSession(session: InternalSessionFields): boolean {
  return session.sourceDesignProjectId !== undefined || session.sourceDesignJobId !== undefined
}

/**
 * 判断内部 Design 会话是否拥有完整可执行归属。
 * @param session 待判断的会话来源字段。
 * @returns 项目和任务字段都为非空字符串时返回 true。
 */
export function hasValidDesignSessionOwnership(session: InternalSessionFields): boolean {
  return Boolean(session.sourceDesignProjectId?.trim() && session.sourceDesignJobId?.trim())
}

/**
 * 判断内部 Canvas Agent 是否拥有完整且唯一的项目归属。
 * @param session 待判断的工作区及内部来源字段。
 * @returns Canvas 三字段非空、项目匹配且未混入 Design 来源时返回 true。
 */
export function hasValidCanvasAgentOwnership(session: InternalSessionFields): boolean {
  if (isInternalDesignSession(session)) return false
  return Boolean(
    session.sourceCanvasProjectId?.trim()
      && session.sourceCanvasId?.trim()
      && session.sourceCanvasNodeId?.trim()
      && session.workspaceId === session.sourceCanvasProjectId,
  )
}

/**
 * 判断会话是否允许出现在普通用户入口。
 * @param session 待判断的会话来源字段。
 * @returns 不带任何 Design 或 Canvas 来源标记时返回 true。
 */
export function isAgentSessionUserVisible(session: InternalSessionFields): boolean {
  return !isInternalDesignSession(session) && !hasAnyCanvasSourceField(session)
}

/**
 * 收窄普通用户入口可访问的 Agent 会话。
 * @param session 会话索引中的候选记录。
 * @returns 已验证为普通用户可见的会话。
 */
export function requireUserVisibleAgentSession(
  session: AgentSessionMeta | undefined,
): AgentSessionMeta {
  if (!session || !isAgentSessionUserVisible(session)) throw new Error('Agent 会话不存在')
  return session
}
