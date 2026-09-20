import { hasAnyCanvasSourceField, hasValidCanvasAgentOwnership, isAgentSessionUserVisible }
  from '@proma/shared'
import type {
  AgentSessionMeta,
  AgentSessionOwnershipFields,
  CanvasAgentActiveRunSnapshot,
  ProjectAgentEligibilityFields,
} from '@proma/shared'

/**
 * 会话归属与可见性判定已下沉到 `@proma/shared`，渲染层复用同一份规则。
 * 这里继续重导出，保持既有主进程调用点不变。
 */
export {
  AGENT_CANVAS_EXCLUSIVE_OWNERSHIP_FIELDS,
  ORDINARY_TOP_LEVEL_EXCLUDED_FIELDS,
  hasAnyCanvasSourceField,
  hasValidCanvasAgentOwnership,
  isAgentSessionUserVisible,
  isInternalDesignSession,
  isOrdinaryTopLevelAgentSession,
  requireOrdinaryTopLevelAgentSession,
} from '@proma/shared'

/**
 * 从全量会话索引构造 Renderer 重载所需的最小运行快照。
 * @param sessions 主进程全量会话元数据。
 * @param isBusy 判断会话是否处于启动、运行或排队状态。
 * @returns 仅包含合法 owner 与损坏内部会话安全代次的快照。
 */
export function buildCanvasAgentActiveRunSnapshot(
  sessions: AgentSessionMeta[],
  isBusy: (sessionId: string) => boolean,
  getStartedAt: (sessionId: string) => number | undefined = () => undefined,
): CanvasAgentActiveRunSnapshot {
  /** 完整且独占的运行中 Canvas owner。 */
  const owners: CanvasAgentActiveRunSnapshot['owners'] = []
  /** 带 Canvas 字段但归属损坏的运行中会话，仅公开终态校验所需代次。 */
  const internalInvalidRuns: CanvasAgentActiveRunSnapshot['internalInvalidRuns'] = []
  for (const session of sessions) {
    if (!isBusy(session.id) || !hasAnyCanvasSourceField(session)) continue
    const startedAt = getStartedAt(session.id)
    if (!hasValidCanvasAgentOwnership(session)) {
      /** 缺少权威代次时保持未知 fail closed，禁止构造无法安全终态化的 invalid run。 */
      if (startedAt !== undefined) internalInvalidRuns.push({ sessionId: session.id, startedAt, valid: false })
      continue
    }
    owners.push({
      sessionId: session.id,
      projectId: session.sourceCanvasProjectId!,
      canvasId: session.sourceCanvasId!,
      nodeId: session.sourceCanvasNodeId!,
      title: session.title,
      ...(startedAt !== undefined ? { startedAt } : {}),
    })
  }
  return { owners, internalInvalidRuns }
}

/**
 * 判断内部 Design 会话是否拥有完整可执行归属。
 * @param session 待判断的会话来源字段。
 * @returns 项目和任务字段都为非空字符串时返回 true。
 */
export function hasValidDesignSessionOwnership(session: AgentSessionOwnershipFields): boolean {
  return Boolean(session.sourceDesignProjectId?.trim() && session.sourceDesignJobId?.trim())
}

/** 判断会话是否为目标项目可持有 Canvas 关联的普通顶层 Agent。 */
export function isEligibleProjectAgent(session: ProjectAgentEligibilityFields, projectId: string): boolean {
  return isAgentSessionUserVisible(session)
    && session.workspaceId === projectId
    && !session.archived
    && session.explorationParentSessionId === undefined
    && session.sourceAutomationId === undefined
    && session.parentSessionId === undefined
    && session.rootSessionId === undefined
    && session.sourceDelegationId === undefined
    && session.delegationRole === undefined
    && session.delegationStatus === undefined
    && session.delegationDepth === undefined
    && session.delegationGoal === undefined
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
