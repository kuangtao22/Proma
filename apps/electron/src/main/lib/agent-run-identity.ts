/** 本轮受信任身份仅在主进程内创建，不出现在模型工具参数或 IPC DTO。 */
export interface AgentRunIdentity {
  sessionId: string
  generation: number
  signal: AbortSignal
  assertActive(): void
  abort(): void
}

/**
 * 为单次运行创建可立即撤销的会话代际身份。
 * @param sessionId 主进程已验证的会话 ID。
 * @param generation 该会话本轮运行的代次。
 * @param isCurrent 查询主进程当前槽位是否仍属于本轮。
 * @returns 可传给只读 facade 的信号和返回前校验闭包。
 */
export function createAgentRunIdentity(
  sessionId: string,
  generation: number,
  isCurrent: () => boolean,
): AgentRunIdentity {
  const controller = new AbortController()
  return {
    sessionId,
    generation,
    signal: controller.signal,
    assertActive() {
      if (controller.signal.aborted || !isCurrent()) throw new Error('当前 Agent 运行已停止')
    },
    abort() { controller.abort() },
  }
}
