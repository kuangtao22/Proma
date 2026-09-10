import type { SDKMessage } from '@proma/shared'

/** Host 对一次 Agent 成功终态的业务完成判断。 */
export type AgentCompletionEvaluation =
  | { action: 'complete' }
  | { action: 'continue'; message: string }
  | { action: 'blocked'; message: string }

/** 无外部成功终态时最多允许三次 Host 驱动续行。 */
export const MAX_AGENT_COMPLETION_CONTINUATIONS = 3

/** 单次完成检查所需的运行态与副作用入口。 */
export interface ApplyAgentCompletionPolicyInput {
  terminalResult: SDKMessage | undefined
  continuationCount: number
  signal: AbortSignal
  canContinue: boolean
  /** 用户停止或新消息中断时吞掉旧成功终态，不再发起验收。 */
  stopped?: boolean
  evaluateCompletion?: (signal: AbortSignal) => Promise<AgentCompletionEvaluation>
  continueTask: (message: string) => Promise<void>
}

/** 单次完成检查后的终态或同会话续行计划。 */
export interface ApplyAgentCompletionPolicyResult {
  terminalResult: SDKMessage | undefined
  continuationCount: number
  continued: boolean
}

/** 判断当前消息是否为可交给 Host 验收的成功终态。 */
function isSuccessfulTerminalResult(message: SDKMessage | undefined): boolean {
  const result = message as unknown as Record<string, unknown> | undefined
  return result?.type === 'result' && result.subtype === 'success'
}

/** 将 Host 阻断原因转换为 Pi 兼容的非成功终态。 */
function createCompletionErrorResult(
  original: SDKMessage,
  terminalReason: string,
  message: string,
): SDKMessage {
  const result = original as unknown as Record<string, unknown>
  return {
    ...result,
    subtype: 'error_during_execution',
    terminal_reason: terminalReason,
    errors: [message],
  } as unknown as SDKMessage
}

/** 在模型成功后应用可选 Host 完成检查。 */
export async function applyAgentCompletionPolicy(
  input: ApplyAgentCompletionPolicyInput,
): Promise<ApplyAgentCompletionPolicyResult> {
  const unchanged = (): ApplyAgentCompletionPolicyResult => ({
    terminalResult: input.terminalResult,
    continuationCount: input.continuationCount,
    continued: false,
  })
  if (input.stopped || input.signal.aborted) {
    return { terminalResult: undefined, continuationCount: input.continuationCount, continued: false }
  }
  if (!input.evaluateCompletion || !input.terminalResult
    || !isSuccessfulTerminalResult(input.terminalResult)) {
    return unchanged()
  }

  let evaluation: AgentCompletionEvaluation
  try {
    evaluation = await input.evaluateCompletion(input.signal)
  } catch {
    if (input.signal.aborted) {
      return { terminalResult: undefined, continuationCount: input.continuationCount, continued: false }
    }
    return {
      terminalResult: createCompletionErrorResult(
        input.terminalResult,
        'completion_check_failed',
        '任务完成检查失败，尚未确认交付完成。请检查当前状态后继续。',
      ),
      continuationCount: input.continuationCount,
      continued: false,
    }
  }
  if (input.signal.aborted) {
    return { terminalResult: undefined, continuationCount: input.continuationCount, continued: false }
  }
  if (evaluation.action === 'complete') return unchanged()
  if (evaluation.action === 'blocked') {
    return {
      terminalResult: createCompletionErrorResult(
        input.terminalResult,
        'completion_blocked',
        evaluation.message.trim() || '任务完成检查发现阻断，尚未确认交付完成。',
      ),
      continuationCount: input.continuationCount,
      continued: false,
    }
  }
  const continuationMessage = evaluation.message.trim()
  if (!input.canContinue) {
    return {
      terminalResult: createCompletionErrorResult(
        input.terminalResult,
        'completion_continuation_unavailable',
        '任务尚未完成，但当前运行预算或生命周期不允许继续执行。请检查当前状态后继续。',
      ),
      continuationCount: input.continuationCount,
      continued: false,
    }
  }
  if (input.continuationCount >= MAX_AGENT_COMPLETION_CONTINUATIONS) {
    return {
      terminalResult: createCompletionErrorResult(
        input.terminalResult,
        'completion_continuation_limit',
        `任务自动续行已达上限（${MAX_AGENT_COMPLETION_CONTINUATIONS} 次），尚未确认交付完成。请检查当前状态后继续。`,
      ),
      continuationCount: input.continuationCount,
      continued: false,
    }
  }
  if (!continuationMessage) {
    return {
      terminalResult: createCompletionErrorResult(
        input.terminalResult,
        'completion_blocked',
        '任务完成检查没有提供可执行的续行指令，尚未确认交付完成。',
      ),
      continuationCount: input.continuationCount,
      continued: false,
    }
  }
  await input.continueTask(continuationMessage)
  return {
    terminalResult: undefined,
    continuationCount: input.continuationCount + 1,
    continued: true,
  }
}
