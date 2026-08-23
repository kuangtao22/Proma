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
