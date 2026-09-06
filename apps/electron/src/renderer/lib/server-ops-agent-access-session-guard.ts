/** 常驻会话撤权守卫依赖。 */
export interface ServerOpsAgentAccessSessionGuardOptions {
  revokeSession: (sessionId: string) => Promise<void>
  reportError: (message: string) => void
}

/** 常驻会话撤权守卫的最小控制合同。 */
export interface ServerOpsAgentAccessSessionGuard {
  select: (sessionId: string | null) => void
}

/** 创建普通 Agent 会话切换守卫。 */
export function createServerOpsAgentAccessSessionGuard(
  options: ServerOpsAgentAccessSessionGuardOptions,
): ServerOpsAgentAccessSessionGuard {
  /** AppShell 最近一次接管的普通 Agent 会话；首帧只建立基线。 */
  let currentSessionId: string | null | undefined
  return {
    select: (sessionId) => {
      /** 严格相同的 render/effect 重放不产生重复撤权。 */
      if (currentSessionId === sessionId) return
      /** 先推进本地身份，确保旧请求失败也不会冻结后续会话切换。 */
      const previousSessionId = currentSessionId
      currentSessionId = sessionId
      if (!previousSessionId) return
      void options.revokeSession(previousSessionId).catch((error: unknown) => {
        /** Renderer 只报告稳定文本，异常对象不进入 UI 状态。 */
        options.reportError(error instanceof Error ? error.message : String(error))
      })
    },
  }
}
