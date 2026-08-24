/** 单个同步退出清理步骤。 */
export interface ShutdownCleanupStep {
  /** 用于错误日志定位的中文步骤名。 */
  name: string
  /** 必须同步启动的清理动作。 */
  run: () => void
}

/**
 * 逐项隔离退出清理，任何单点失败都不会阻断后续资源释放。
 * @param steps 按业务依赖顺序排列的同步清理步骤。
 * @param reportError 单项失败日志出口。
 */
export function runShutdownCleanupSteps(
  steps: ShutdownCleanupStep[],
  reportError: (message: string) => void = (message) => { console.error(message) },
): void {
  for (const step of steps) {
    try {
      step.run()
    } catch (error) {
      reportError(`[退出清理] ${step.name} 失败，已继续后续清理: ${String(error)}`)
    }
  }
}
