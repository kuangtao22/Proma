import type { AgentSessionMeta } from '@proma/shared'

/** 仅包含 Design 内部会话所有权字段的最小判断输入。 */
type DesignSessionFields = Pick<AgentSessionMeta, 'sourceDesignProjectId' | 'sourceDesignJobId'>

/**
 * 判断会话是否带有任一 Design 来源标记。
 * @param session 待判断的会话来源字段。
 * @returns 任一字段存在即返回 true，损坏的半元数据也会 fail closed。
 */
export function isInternalDesignSession(session: DesignSessionFields): boolean {
  return Boolean(session.sourceDesignProjectId || session.sourceDesignJobId)
}

/**
 * 判断内部 Design 会话是否拥有完整可执行归属。
 * @param session 待判断的会话来源字段。
 * @returns 项目和任务字段都为非空字符串时返回 true。
 */
export function hasValidDesignSessionOwnership(session: DesignSessionFields): boolean {
  return Boolean(session.sourceDesignProjectId?.trim() && session.sourceDesignJobId?.trim())
}

/**
 * 判断会话是否允许出现在普通用户入口。
 * @param session 待判断的会话来源字段。
 * @returns 不带任何 Design 来源标记时返回 true。
 */
export function isAgentSessionUserVisible(session: DesignSessionFields): boolean {
  return !isInternalDesignSession(session)
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
