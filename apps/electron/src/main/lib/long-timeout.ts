/** Node 单次 setTimeout 可接受且不会溢出的最大毫秒数。 */
export const NODE_MAX_TIMER_DELAY_MS = 2_147_483_647

/**
 * 将远期任务拆成 Node 可安全调度的单段等待。
 * @param delayMs 本轮期望等待的毫秒数。
 * @returns 不超过 Node 定时器上限的等待毫秒数。
 */
export function clampTimerDelay(delayMs: number): number {
  return Math.min(delayMs, NODE_MAX_TIMER_DELAY_MS)
}
