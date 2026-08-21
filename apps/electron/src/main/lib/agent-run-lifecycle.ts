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

/** 为会话添加指定运行代际的停止标记。 */
export function markStoppedGeneration(
  markers: Map<string, Set<number>>,
  sessionId: string,
  generation: number,
): void {
  /** 当前会话尚未被对应旧 run 消费的停止代际。 */
  const generations = markers.get(sessionId) ?? new Set<number>()
  generations.add(generation)
  markers.set(sessionId, generations)
}

/** 消费会话中指定运行代际的停止标记，并在集合为空时释放 session key。 */
export function consumeStoppedGeneration(
  markers: Map<string, Set<number>>,
  sessionId: string,
  generation: number,
): boolean {
  /** 当前会话尚未被对应旧 run 消费的停止代际。 */
  const generations = markers.get(sessionId)
  if (!generations?.delete(generation)) return false
  if (generations.size === 0) markers.delete(sessionId)
  return true
}

/** 判断指定运行代际是否仍是会话最新启动的代际。 */
export function isLatestRunGeneration(
  latestGenerations: Map<string, number>,
  sessionId: string,
  generation: number,
): boolean {
  return latestGenerations.get(sessionId) === generation
}

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
