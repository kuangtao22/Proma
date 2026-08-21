/** Agent 运行生命周期依赖。 */
export interface AgentRunLifecycleDependencies {
  /** 当前请求是否仍持有自己的运行代际。 */
  isCurrent: () => boolean
  /** 仅释放当前请求仍持有的运行代际。 */
  release: () => void
  /** 当前代际已被停止时完成尚未启动 adapter 的请求。 */
  onStopped: () => void
}

/** 内部停止信号，仅用于跨异步 preflight 快速退出。 */
const AGENT_RUN_STOPPED = Symbol('agent-run-stopped')

/** 生命周期执行期间用于验证当前运行代际的同步检查点。 */
export type AgentRunCheckpoint = () => void

/**
 * 统一包裹 active 注册后的全部 Agent 流程。
 * checkpoint 在每次异步 preflight 后验证 generation，finally 保证所有异常路径释放。
 */
export async function runAgentLifecycle(
  dependencies: AgentRunLifecycleDependencies,
  execute: (checkpoint: AgentRunCheckpoint) => Promise<void>,
): Promise<void> {
  /** 在继续副作用前验证当前请求仍拥有 active 槽。 */
  const checkpoint = (): void => {
    if (!dependencies.isCurrent()) throw AGENT_RUN_STOPPED
  }

  try {
    await execute(checkpoint)
  } catch (error) {
    if (error === AGENT_RUN_STOPPED) {
      dependencies.onStopped()
      return
    }
    throw error
  } finally {
    dependencies.release()
  }
}
