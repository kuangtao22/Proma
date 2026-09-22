import type { PermissionResult } from './agent-permission-service'
import type { AgentToolMode } from '@proma/shared'

/** 受限运行只注册和分派这一固定只读工具集合，新增入口须同步宿主准入。 */
const SERVER_OPS_READ_TOOL_NAMES = [
  'ops_resources', 'ops_server_overview', 'ops_server_services',
  'ops_server_discover', 'ops_server_logs',
  'ops_data_test', 'ops_data_diagnose', 'ops_database_tables',
  'ops_database_describe', 'ops_database_rows', 'ops_database_query',
  'ops_database_change_context',
] as const
const SERVER_OPS_READ_TOOL_SET = new Set<string>(SERVER_OPS_READ_TOOL_NAMES)

/** 判断工具是否属于具有独立 Facade 授权检查的只读集合，供宿主统一准入。 */
export function isServerOpsReadToolName(toolName: string): boolean {
  return SERVER_OPS_READ_TOOL_SET.has(toolName)
}

/** 返回模式限定的 Pi 工具集合；普通模式继续使用现有注册策略。 */
export function resolveAgentModeToolNames(mode: AgentToolMode): string[] | undefined {
  return mode === 'server-ops-read' ? [...SERVER_OPS_READ_TOOL_NAMES] : undefined
}

/** 宿主分派边界再次拒绝非只读工具，即使模型伪造调用也不能执行。 */
export function denyToolOutsideAgentMode(toolName: string, mode: AgentToolMode): PermissionResult | undefined {
  if (mode === 'standard' || SERVER_OPS_READ_TOOL_SET.has(toolName)) return undefined
  return { behavior: 'deny', message: `运维只读模式不允许使用工具: ${toolName}` }
}

/** Proma 对外工具名到 Pi runtime 注册名的稳定映射。 */
const PI_TOOL_NAME_BY_DISPLAY_NAME: Readonly<Record<string, string>> = {
  Read: 'read',
  Write: 'write',
  Edit: 'edit',
  MultiEdit: 'edit',
  Bash: 'bash',
  PowerShell: 'powershell',
  Grep: 'grep',
  Glob: 'find',
  LS: 'ls',
}

/**
 * 把 replace 白名单转换为 Pi 模型真正可见的工具名；普通与 extend 运行保持完整工具集合。
 * @param allowedToolNames Proma 权限边界使用的完整工具名集合。
 * @param mode 本次运行采用替换还是追加策略。
 * @returns replace 模式下去重后的 Pi 工具名；不应收窄时返回 undefined。
 */
export function resolvePiActiveToolNames(
  allowedToolNames: readonly string[] | undefined,
  mode: 'replace' | 'extend' | undefined,
): string[] | undefined {
  if (!allowedToolNames || mode === 'extend') return undefined
  return [...new Set(allowedToolNames.map((name) => PI_TOOL_NAME_BY_DISPLAY_NAME[name] ?? name))]
}

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
