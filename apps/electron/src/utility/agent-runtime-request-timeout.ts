import { AGENT_RUNTIME_METHODS } from '@proma/shared'

const DEFAULT_PARENT_REQUEST_TIMEOUT_MS = 120_000
const DESIGN_IMAGE_TOOL = 'mcp__nano_banana__generate_image'
// AskUserQuestion 属于用户主导的自由文本交互；两分钟不足以完成输入。
export const ASK_USER_QUESTION_TIMEOUT_MS = 15 * 60_000
// 图片生成可能超过两分钟；只放宽可信图片工具，普通主进程能力仍快速暴露故障。
export const DESIGN_IMAGE_TOOL_TIMEOUT_MS = 10 * 60_000

/**
 * Utility Process 请求主进程的等待时间。
 * AskUserQuestion 与可信 Design 图片工具分别使用独立长时限，其他能力保持默认故障检测。
 */
export function getParentRequestTimeoutMs(method: string, payload: unknown): number {
  /** 当前跨进程能力请求声明的工具名；非工具请求保持 undefined。 */
  const toolName = (payload as { toolName?: unknown } | null)?.toolName
  if (
    method === AGENT_RUNTIME_METHODS.CAPABILITY_CAN_USE_TOOL
    && toolName === 'AskUserQuestion'
  ) {
    return ASK_USER_QUESTION_TIMEOUT_MS
  }
  if (
    method === AGENT_RUNTIME_METHODS.CAPABILITY_CUSTOM_TOOL
    && toolName === DESIGN_IMAGE_TOOL
  ) {
    return DESIGN_IMAGE_TOOL_TIMEOUT_MS
  }
  return DEFAULT_PARENT_REQUEST_TIMEOUT_MS
}
