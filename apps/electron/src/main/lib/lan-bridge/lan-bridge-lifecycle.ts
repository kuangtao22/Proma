/** 单次 Bridge 启动操作收到的取消状态读取器。 */
export type LanBridgeStartOperation = (isCancelled: () => boolean) => Promise<void>

/** 合并并发启动并隔离 stop 前后资源代次的控制器。 */
export interface LanBridgeStartCoordinator {
  /** 在当前代次执行或复用唯一启动操作。 */
  run: (operation: LanBridgeStartOperation) => Promise<void>
  /** 推进生命周期代次，使当前或排队中的旧启动失效。 */
  cancelPending: () => void
}

/** 创建单个 Bridge 进程实例使用的启动协调器。 */
export function createLanBridgeStartCoordinator(): LanBridgeStartCoordinator {
  /** stop 每次推进的生命周期代次。 */
  let generation = 0
  /** 当前代次唯一的启动操作。 */
  let activeStart: { generation: number; promise: Promise<void> } | null = null

  return {
    run: (operation) => {
      /** 本次调用所属的生命周期代次。 */
      const requestedGeneration = generation
      if (activeStart?.generation === requestedGeneration) return activeStart.promise

      /** 上一代仍在退出时，新启动必须等待其资源清理完成。 */
      const previousStart = activeStart?.promise.catch(() => undefined)
      /** 检查本次操作是否已被后续 stop 取消。 */
      const isCancelled = (): boolean => requestedGeneration !== generation
      /** 当前代次唯一执行的原始启动 Promise。 */
      const startPromise = previousStart
        ? previousStart.then(() => {
            if (isCancelled()) return
            return operation(isCancelled)
          })
        : operation(isCancelled)
      /** 当前代次对调用方公开的已跟踪 Promise。 */
      let trackedPromise: Promise<void>
      trackedPromise = startPromise.finally(() => {
        if (activeStart?.promise === trackedPromise) activeStart = null
      })
      activeStart = { generation: requestedGeneration, promise: trackedPromise }
      return trackedPromise
    },
    cancelPending: () => {
      generation++
    },
  }
}
