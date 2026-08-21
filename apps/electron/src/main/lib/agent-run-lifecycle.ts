/** Agent 运行生命周期依赖。 */
export interface AgentRunLifecycleDependencies {
  /** 当前请求是否仍持有自己的运行代际。 */
  isCurrent: () => boolean
  /** 当前请求的运行代际是否已被用户停止。 */
  isStopped: () => boolean
  /** 仅释放当前请求仍持有的运行代际。 */
  release: () => void
  /** 当前代际已被停止时完成尚未启动 adapter 的请求。 */
  onStopped: () => void
}

/** Agent 终端通知 callback。 */
export interface AgentRunTerminalCallbacks<TMessages, TOptions> {
  /** 外部错误 callback。 */
  onError: (error: string) => void
  /** 外部完成 callback。 */
  onComplete: (messages?: TMessages, options?: TOptions) => void
  /** callback 抛错后的日志边界。 */
  onCallbackError?: (kind: 'error' | 'complete', error: unknown) => void
}

/** Agent 安全终端通知器。 */
export interface AgentRunTerminalNotifier<TMessages, TOptions> {
  /** 最多尝试一次错误通知，完成后调用无效。 */
  onError: (error: string) => void
  /** 最多尝试一次完成通知。 */
  onComplete: (messages?: TMessages, options?: TOptions) => void
}

/** Agent service 单个终态副作用。 */
export interface AgentServiceTerminalEffect {
  /** 用于错误日志定位的副作用名称。 */
  name: string
  /** 需要独立隔离执行的副作用。 */
  run: () => void
}

/** 内部停止信号，仅用于跨异步 preflight 快速退出。 */
const AGENT_RUN_STOPPED = Symbol('agent-run-stopped')

/** 生命周期执行期间用于验证当前运行代际的同步检查点。 */
export type AgentRunCheckpoint = () => void

/**
 * 创建不会向 Agent 业务层抛出 callback 异常的终端通知器。
 * complete 在调用外部 callback 前锁定，确保重入和异常路径都只尝试一次。
 */
export function createAgentRunTerminalNotifier<TMessages, TOptions>(
  callbacks: AgentRunTerminalCallbacks<TMessages, TOptions>,
): AgentRunTerminalNotifier<TMessages, TOptions> {
  /** 是否已经尝试完成通知。 */
  let completed = false
  /** 是否已经尝试错误通知。 */
  let errorAttempted = false

  /** 记录外部 callback 异常，日志边界自身异常也不得回流业务层。 */
  const reportCallbackError = (kind: 'error' | 'complete', error: unknown): void => {
    try {
      callbacks.onCallbackError?.(kind, error)
    } catch (logError) {
      console.error('[Agent 生命周期] 记录终端 callback 异常失败:', logError)
    }
  }

  return {
    onError: (error) => {
      if (completed || errorAttempted) return
      errorAttempted = true
      try {
        callbacks.onError(error)
      } catch (callbackError) {
        reportCallbackError('error', callbackError)
      }
    },
    onComplete: (messages, options) => {
      if (completed) return
      completed = true
      try {
        callbacks.onComplete(messages, options)
      } catch (callbackError) {
        reportCallbackError('complete', callbackError)
      }
    },
  }
}

/**
 * 依次执行 Agent service 终态副作用，并隔离任一 callback、IPC 或发布异常。
 * 每个 effect 最多尝试一次，前一个失败不会阻止后续内部状态推进。
 */
export function runAgentServiceTerminalEffects(
  effects: AgentServiceTerminalEffect[],
  onEffectError: (name: string, error: unknown) => void,
): void {
  for (const effect of effects) {
    try {
      effect.run()
    } catch (error) {
      try {
        onEffectError(effect.name, error)
      } catch {
        // 错误记录器属于外部边界，不能反向中断后续内部收尾。
      }
    }
  }
}

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

/** 判断会话中的指定运行代际是否已被用户停止。 */
export function hasStoppedGeneration(
  markers: Map<string, Set<number>>,
  sessionId: string,
  generation: number,
): boolean {
  return markers.get(sessionId)?.has(generation) === true
}

/** 为会话登记尚未完全退出的运行代际。 */
export function markInFlightGeneration(
  generationsBySession: Map<string, Set<number>>,
  sessionId: string,
  generation: number,
): void {
  /** 当前会话尚未完全退出的运行代际。 */
  const generations = generationsBySession.get(sessionId) ?? new Set<number>()
  generations.add(generation)
  generationsBySession.set(sessionId, generations)
}

/** 判断会话是否仍有 adapter 或生命周期收尾尚未退出。 */
export function hasInFlightGeneration(
  generationsBySession: Map<string, Set<number>>,
  sessionId: string,
): boolean {
  return (generationsBySession.get(sessionId)?.size ?? 0) > 0
}

/** 为会话保留指定 generation 的后台任务所有权。 */
export function retainGenerationTask(
  generationsBySession: Map<string, Set<number>>,
  sessionId: string,
  generation: number,
): void {
  /** 当前会话仍可能写入 generation 结果的后台任务。 */
  const generations = generationsBySession.get(sessionId) ?? new Set<number>()
  generations.add(generation)
  generationsBySession.set(sessionId, generations)
}

/** 判断会话是否仍有 generation-owned 后台任务。 */
export function hasRetainedGenerationTask(
  generationsBySession: Map<string, Set<number>>,
  sessionId: string,
): boolean {
  return (generationsBySession.get(sessionId)?.size ?? 0) > 0
}

/** 判断是否仍有前台运行或后台 generation-owned 任务可能写入业务数据。 */
export function hasGenerationOwnedWrites(
  inFlightGenerationsBySession: Map<string, Set<number>>,
  retainedTasksBySession: Map<string, Set<number>>,
): boolean {
  return inFlightGenerationsBySession.size > 0 || retainedTasksBySession.size > 0
}

/**
 * 释放已经完全退出的运行代际。
 * 仅当会话最后一个 in-flight 代际退出时清理 latest，避免旧代际重新获得写权限。
 */
export function releaseInFlightGeneration(
  generationsBySession: Map<string, Set<number>>,
  latestGenerations: Map<string, number>,
  sessionId: string,
  generation: number,
  retainedTasksBySession?: Map<string, Set<number>>,
): void {
  /** 当前会话尚未完全退出的运行代际。 */
  const generations = generationsBySession.get(sessionId)
  if (!generations?.delete(generation)) return
  if (generations.size > 0) return
  generationsBySession.delete(sessionId)
  if (retainedTasksBySession && hasRetainedGenerationTask(retainedTasksBySession, sessionId)) return
  latestGenerations.delete(sessionId)
}

/**
 * 释放 generation-owned 后台任务。
 * 仅当前台运行与全部后台任务都结束后清理 latest，保证正常迟到结果仍可提交。
 */
export function releaseGenerationTask(
  retainedTasksBySession: Map<string, Set<number>>,
  inFlightGenerationsBySession: Map<string, Set<number>>,
  latestGenerations: Map<string, number>,
  sessionId: string,
  generation: number,
): void {
  /** 当前会话仍持有 generation 所有权的后台任务。 */
  const retainedGenerations = retainedTasksBySession.get(sessionId)
  if (!retainedGenerations?.delete(generation)) return
  if (retainedGenerations.size > 0) return
  retainedTasksBySession.delete(sessionId)
  if (hasInFlightGeneration(inFlightGenerationsBySession, sessionId)) return
  latestGenerations.delete(sessionId)
}

/**
 * 等待 Agent iterator 完成底层 cleanup，并消费 cleanup 自身的拒绝。
 * 调用方 await 后才可释放 in-flight 生命周期。
 */
export async function closeAgentQueryIterator<T>(
  iterator: Pick<AsyncIterator<T>, 'return'>,
  onCleanupError?: (error: unknown) => void,
): Promise<void> {
  try {
    await iterator.return?.(undefined as never)
  } catch (error) {
    try {
      onCleanupError?.(error)
    } catch {
      // 日志边界异常不能替代或重新抛出已消费的 iterator cleanup 异常。
    }
  }
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
    if (error === AGENT_RUN_STOPPED || dependencies.isStopped()) {
      dependencies.onStopped()
      return
    }
    throw error
  } finally {
    dependencies.release()
  }
}
