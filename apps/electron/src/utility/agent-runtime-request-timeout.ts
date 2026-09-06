import { AGENT_RUNTIME_METHODS } from '@proma/shared'

const DEFAULT_PARENT_REQUEST_TIMEOUT_MS = 120_000
const DESIGN_IMAGE_TOOL = 'mcp__nano_banana__generate_image'
const CANVAS_EXECUTION_TOOLS = new Set(['canvas_run_agent', 'canvas_run_workflow', 'canvas_run_nodes'])
// 图片生成可能超过两分钟；只放宽可信图片工具，普通主进程能力仍快速暴露故障。
export const DESIGN_IMAGE_TOOL_TIMEOUT_MS = 10 * 60_000
// Canvas 长任务按既有工作流总时限收口；批量节点启动也复用同一上限。
export const CANVAS_EXECUTION_TOOL_TIMEOUT_MS = 15 * 60_000

/**
 * Utility Process 请求主进程的等待时间。
 * canUseTool 可能合法等待用户操作，因此由运行取消或 utility 退出终结；
 * Canvas 执行与可信 Design 图片工具使用独立业务时限，其他能力保持默认故障检测。
 */
export function getParentRequestTimeoutMs(method: string, payload: unknown): number | undefined {
  /** 当前跨进程能力请求声明的工具名；非工具请求保持 undefined。 */
  const toolName = (payload as { toolName?: unknown } | null)?.toolName
  if (method === AGENT_RUNTIME_METHODS.CAPABILITY_CAN_USE_TOOL) return undefined
  if (
    method === AGENT_RUNTIME_METHODS.CAPABILITY_CUSTOM_TOOL
    && toolName === DESIGN_IMAGE_TOOL
  ) {
    return DESIGN_IMAGE_TOOL_TIMEOUT_MS
  }
  if (
    method === AGENT_RUNTIME_METHODS.CAPABILITY_CUSTOM_TOOL
    && typeof toolName === 'string'
    && CANVAS_EXECUTION_TOOLS.has(toolName)
  ) {
    return CANVAS_EXECUTION_TOOL_TIMEOUT_MS
  }
  return DEFAULT_PARENT_REQUEST_TIMEOUT_MS
}
