import type { AgentSessionMeta, DesignTraceState } from '@proma/shared'
import { hasValidDesignSessionOwnership } from '../agent-session-visibility'

/** 内部 Design 执行会话回收输入。 */
export interface CleanupDesignExecutionSessionInput {
  /** 需要回收的内部 Agent 会话 ID。 */
  sessionId: string
  /** 已由 Job journal 提交的 trace 状态。 */
  traceState: DesignTraceState
}

/** 内部会话关联资源的窄清理依赖。 */
export interface DesignExecutionSessionLifecycleDependencies {
  /** 从内部全量索引读取会话。 */
  getSession: (sessionId: string) => AgentSessionMeta | undefined
  /** 清理会话级权限白名单和待处理请求。 */
  clearPermission: (sessionId: string) => void
  /** 清理尚未答复的 AskUser 请求。 */
  clearAskUser: (sessionId: string) => void
  /** 清理尚未答复的退出计划请求。 */
  clearExitPlan: (sessionId: string) => void
  /** 清理尚未执行的排队消息。 */
  clearQueue: (sessionId: string) => void
  /** 关闭会话拥有的浏览器资源。 */
  closeBrowser: (sessionId: string) => Promise<void>
  /** 从索引和磁盘删除会话。 */
  deleteSession: (sessionId: string) => void
}

/** trace 提交后按固定顺序回收 Design 内部执行会话。 */
export class DesignExecutionSessionLifecycle {
  constructor(private readonly dependencies: DesignExecutionSessionLifecycleDependencies) {}

  /**
   * 清理交互资源并最终删除内部会话；任一步失败由 Job pending 状态驱动重试。
   * @param input 会话 ID 和已提交 trace 状态。
   */
  async cleanup(input: CleanupDesignExecutionSessionInput): Promise<void> {
    if (input.traceState !== 'ready') throw new Error('Design trace 尚未就绪')
    /** 已删除会话表示此前清理已越过最终提交点，重复调用直接成功。 */
    const session = this.dependencies.getSession(input.sessionId)
    if (!session) return
    if (!hasValidDesignSessionOwnership(session)) throw new Error('Design 内部会话归属无效')

    this.dependencies.clearPermission(input.sessionId)
    this.dependencies.clearAskUser(input.sessionId)
    this.dependencies.clearExitPlan(input.sessionId)
    this.dependencies.clearQueue(input.sessionId)
    await this.dependencies.closeBrowser(input.sessionId)
    this.dependencies.deleteSession(input.sessionId)
  }
}
