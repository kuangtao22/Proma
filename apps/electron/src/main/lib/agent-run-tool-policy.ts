import type { PermissionResult } from './agent-permission-service'

/**
 * 按单次运行白名单拒绝越界工具；未提供白名单时保持普通 Agent 行为。
 * @param toolName 当前准备执行的工具名。
 * @param allowedToolNames 本次运行允许的完整工具名集合。
 * @returns 越界时返回拒绝结果，否则返回 undefined 继续原权限流程。
 */
export function denyToolOutsideRunAllowlist(
  toolName: string,
  allowedToolNames: readonly string[] | undefined,
): PermissionResult | undefined {
  if (!allowedToolNames || allowedToolNames.includes(toolName)) return undefined
  return { behavior: 'deny', message: `当前任务不允许使用工具: ${toolName}` }
}

/**
 * 为单次 Agent run 创建独立工具调用计数器。
 * @param limits 按完整工具名配置的本轮最大准入次数。
 * @returns 同步占位当前调用；超限时返回拒绝结果。
 */
export function createRunToolCallLimiter(
  limits: Readonly<Record<string, number>> | undefined,
): (toolName: string) => PermissionResult | undefined {
  /** 当前 run 已为各工具同步占用的调用次数。 */
  const counts = new Map<string, number>()
  return (toolName) => {
    const limit = limits?.[toolName]
    if (limit === undefined) return undefined
    const count = counts.get(toolName) ?? 0
    if (count >= limit) {
      return { behavior: 'deny', message: `当前任务工具调用次数已达上限: ${toolName}` }
    }
    counts.set(toolName, count + 1)
    return undefined
  }
}
