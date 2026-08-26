import type { AgentSessionMeta, CanvasAgentActiveRunSnapshot } from '@proma/shared'

/** 包含内部 Agent 会话所有权字段的最小判断输入。 */
type InternalSessionFields = Pick<
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

/** Canvas 内部会话必须排除的其它来源与协作字段。 */
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
] as const

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
 * 从全量会话索引构造 Renderer 重载所需的最小运行快照。
 * @param sessions 主进程全量会话元数据。
 * @param isBusy 判断会话是否处于启动、运行或排队状态。
 * @returns 仅包含合法 owner 与损坏内部会话 ID 的安全快照。
 */
export function buildCanvasAgentActiveRunSnapshot(
  sessions: AgentSessionMeta[],
  isBusy: (sessionId: string) => boolean,
  getStartedAt: (sessionId: string) => number | undefined = () => undefined,
): CanvasAgentActiveRunSnapshot {
  /** 完整且独占的运行中 Canvas owner。 */
  const owners: CanvasAgentActiveRunSnapshot['owners'] = []
  /** 带 Canvas 字段但归属损坏的运行中会话，Renderer 必须 fail closed。 */
  const internalInvalidSessionIds: string[] = []
  for (const session of sessions) {
    if (!isBusy(session.id) || !hasAnyCanvasSourceField(session)) continue
    if (!hasValidCanvasAgentOwnership(session)) {
      internalInvalidSessionIds.push(session.id)
      continue
    }
    const startedAt = getStartedAt(session.id)
    owners.push({
      sessionId: session.id,
      projectId: session.sourceCanvasProjectId!,
      canvasId: session.sourceCanvasId!,
      nodeId: session.sourceCanvasNodeId!,
      title: session.title,
      ...(startedAt !== undefined ? { startedAt } : {}),
    })
  }
  return { owners, internalInvalidSessionIds }
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
 * @returns Canvas 三字段规范、项目匹配且未混入其它来源或协作字段时返回 true。
 */
export function hasValidCanvasAgentOwnership(session: InternalSessionFields): boolean {
  /** Canvas Agent 是独占会话类型，任何其它来源字段都表示所有权污染。 */
  if (CANVAS_EXCLUSIVE_OWNERSHIP_FIELDS.some((field) => session[field] !== undefined)) return false
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
