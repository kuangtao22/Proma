/** 工作区写操作守卫的可注入查询依赖。 */
export interface WorkspaceOperationGuardDependencies {
  /** 按会话 ID 解析权威工作区 ID。 */
  getWorkspaceIdBySessionId: (sessionId: string) => string | null | undefined
  /** 按工作区 slug 解析权威工作区 ID。 */
  getWorkspaceIdBySlug: (slug: string) => string | undefined
  /** 查询指定工作区当前操作的稳定阻断原因。 */
  getWorkspaceOperationBlockReason: (workspaceId: string) => string | undefined
}

/** Agent 运行准入所需的工作区来源与固定回调。 */
export interface AgentWorkspaceAdmissionInput {
  /** 会话元数据中的权威工作区 ID。 */
  sessionWorkspaceId?: string
  /** renderer 请求携带的回退工作区 ID。 */
  requestedWorkspaceId?: string
  /** 向调用入口返回迁移阻断错误。 */
  onError: (error: string) => void
  /** 结束尚未启动的 Agent 请求。 */
  onComplete: () => void
}

/** Agent 工作区准入结果。 */
export interface AgentWorkspaceAdmissionResult {
  /** 是否允许调用方继续执行运行副作用。 */
  admitted: boolean
  /** 本次运行解析出的权威工作区 ID。 */
  workspaceId?: string
}

/** 工作区写操作守卫能力。 */
export interface WorkspaceOperationGuard {
  /** 直接按工作区 ID 拒绝迁移期间的写操作。 */
  assertWorkspaceWritable: (workspaceId: string) => void
  /** 先按会话解析工作区，再拒绝迁移期间的写操作。 */
  assertSessionWritable: (sessionId: string) => void
  /** 先按 slug 解析工作区，再拒绝迁移期间的写操作。 */
  assertWorkspaceSlugWritable: (slug: string) => void
  /** 按会话权威归属完成 Agent 准入，并在阻断时执行固定回调。 */
  admitAgentRun: (input: AgentWorkspaceAdmissionInput) => AgentWorkspaceAdmissionResult
}

/** 创建只负责解析工作区归属与检查独占操作锁的守卫。 */
export function createWorkspaceOperationGuard(
  dependencies: WorkspaceOperationGuardDependencies,
): WorkspaceOperationGuard {
  /** 按 ID 查询并抛出稳定的迁移阻断原因。 */
  const assertWorkspaceWritable = (workspaceId: string): void => {
    const blockReason = dependencies.getWorkspaceOperationBlockReason(workspaceId)
    if (blockReason) throw new Error(blockReason)
  }

  return {
    assertWorkspaceWritable,
    assertSessionWritable: (sessionId) => {
      const workspaceId = dependencies.getWorkspaceIdBySessionId(sessionId)
      if (workspaceId === undefined) throw new Error(`会话不存在: ${sessionId}`)
      if (workspaceId === null) return
      assertWorkspaceWritable(workspaceId)
    },
    assertWorkspaceSlugWritable: (slug) => {
      const workspaceId = dependencies.getWorkspaceIdBySlug(slug)
      if (!workspaceId) throw new Error(`项目不存在: ${slug}`)
      assertWorkspaceWritable(workspaceId)
    },
    admitAgentRun: (input) => {
      const workspaceId = input.sessionWorkspaceId ?? input.requestedWorkspaceId
      if (!workspaceId) return { admitted: true, workspaceId }
      const blockReason = dependencies.getWorkspaceOperationBlockReason(workspaceId)
      if (!blockReason) return { admitted: true, workspaceId }
      input.onError(blockReason)
      input.onComplete()
      return { admitted: false, workspaceId }
    },
  }
}
