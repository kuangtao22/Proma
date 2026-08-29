import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { ImageGenerationModelSnapshot } from '@proma/shared'
import type { ResolveImageGenerationRoute } from './image-generation-runtime'

/**
 * 仅主进程内部传递的单次 Agent 运行扩展。
 * 不经过 IPC、会话 JSONL 或全局工具配置持久化。
 */
export interface AgentRunExtensions {
  /** 本次可信运行场景追加到通用系统提示词末尾，不写入用户消息或会话 JSONL。 */
  systemPromptAppend?: string
  /** 本次运行额外注入的 Pi 工具。 */
  piCustomTools?: ToolDefinition[]
  /** 本次运行允许的完整工具名；缺失时保持普通 Agent 权限行为。 */
  allowedToolNames?: readonly string[]
  /** Design Job 固化的可信生图模型，只对本次运行有效。 */
  trustedImageRoute?: ImageGenerationModelSnapshot
  /** 工具执行前同时复核配置并解析只在内存存在的凭据。 */
  resolveTrustedImageRoute?: ResolveImageGenerationRoute
  /** 本次运行按完整工具名设置的最大准入次数；缺失时不限制普通 Agent。 */
  toolCallLimits?: Readonly<Record<string, number>>
  /** 工具参数校验和次数占位后、真实执行前的同步运行守卫。 */
  beforeToolCall?: (toolName: string, input: Readonly<Record<string, unknown>>) => void
  /** Design 可信图片工具在执行前回传的真实摘要和精确提示词。 */
  captureDesignImageCall?: (input: { designSummary: string; prompt: string }) => void
}
