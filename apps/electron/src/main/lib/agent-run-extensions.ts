import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { ImageGenerationModelSnapshot } from '@proma/shared'
import type { ResolveImageGenerationRoute } from './image-generation-runtime'
import type { AgentCompletionEvaluation } from './agent-completion-policy'

/** 高影响工具的动态审批策略，只能作用于本轮显式列入逐次审批名单的工具。 */
export interface AgentToolApprovalPolicy {
  /** 返回指定工具当前应逐次询问，还是由 Agent 自动执行。 */
  getMode(toolName: string): 'ask' | 'automatic'
  /** 订阅策略变化；返回值用于在工具审批结束时释放监听。 */
  subscribe(listener: () => void): () => void
}

/**
 * 仅主进程内部传递的单次 Agent 运行扩展。
 * 不经过 IPC、会话 JSONL 或全局工具配置持久化。
 */
export interface AgentRunExtensions {
  /** 本次可信运行场景追加到通用系统提示词末尾，不写入用户消息或会话 JSONL。 */
  systemPromptAppend?: string
  /** 本次运行额外注入的 Pi 工具。 */
  piCustomTools?: ToolDefinition[]
  /** 本次运行的 Workspace Skills 暴露策略；默认 workspace，内部受限运行可显式禁用。 */
  skillsMode?: 'workspace' | 'disabled'
  /** 本次运行允许的完整工具名；缺失时保持普通 Agent 权限行为。 */
  allowedToolNames?: readonly string[]
  /** replace 用于受限内部 Agent；extend 仅声明新增工具，不替换普通 Agent 既有能力。 */
  allowedToolNamesMode?: 'replace' | 'extend'
  /** Host 明确声明的只读扩展工具，仅供计划模式准入，不提升作用域或写权限。 */
  readOnlyToolNames?: readonly string[]
  /** Design Job 固化的可信生图模型，只对本次运行有效。 */
  trustedImageRoute?: ImageGenerationModelSnapshot
  /** 工具执行前同时复核配置并解析只在内存存在的凭据。 */
  resolveTrustedImageRoute?: ResolveImageGenerationRoute
  /** 本次运行按完整工具名设置的最大准入次数；缺失时不限制普通 Agent。 */
  toolCallLimits?: Readonly<Record<string, number>>
  /** 即使处于 bypassPermissions，也必须按 toolUseID 逐次请求用户批准的工具名。 */
  singleApprovalToolNames?: readonly string[]
  /** 仅对 singleApprovalToolNames 生效的可信动态审批策略。 */
  toolApprovalPolicy?: AgentToolApprovalPolicy
  /** 工具参数校验和次数占位后、真实执行前的同步运行守卫。 */
  beforeToolCall?: (toolName: string, input: Readonly<Record<string, unknown>>) => void
  /** Design 可信图片工具在执行前回传的真实摘要和精确提示词。 */
  captureDesignImageCall?: (input: { designSummary: string; prompt: string }) => void
  /** 可选 Host 完成检查；缺失时普通 Agent 沿用模型原始终态。 */
  evaluateCompletion?: (signal: AbortSignal) => Promise<AgentCompletionEvaluation>
}
