import type { AgentExternalRunSource, AgentSendInput } from '@proma/shared'

/** Headless 入口归一化后只允许可信的自动任务、委派或外部来源。 */
export type HeadlessTriggeredBy = 'automation' | 'delegation' | 'external'

/** 归一化后的 Headless Agent 输入，确保运行来源与开始时间已确定。 */
export interface NormalizedHeadlessAgentRunInput extends AgentSendInput {
  triggeredBy: HeadlessTriggeredBy
  startedAt: number
}

/**
 * 丢弃 Headless 调用方伪造的内部运行字段，并仅从可信 callback 来源推导权限来源。
 * @param input 外部调用方提交的公开 Agent 输入。
 * @param source 主进程 callback 已知的外部来源。
 * @param now 缺少开始时间时使用的时钟。
 * @returns 可交给 Orchestrator 的可信运行输入。
 */
export function normalizeHeadlessAgentRunInput(
  input: AgentSendInput,
  source: AgentExternalRunSource | undefined,
  now: () => number = Date.now,
): NormalizedHeadlessAgentRunInput {
  /** 外部输入可能在运行时夹带不属于公开合同的代次，必须与来源一起丢弃。 */
  const {
    runGeneration: _ignoredRunGeneration,
    triggeredBy: _ignoredTriggeredBy,
    ...publicInput
  } = input as AgentSendInput & { runGeneration?: unknown }
  /** Automation 与 delegation 保留各自安全策略，其余现有外部来源统一收敛为 external。 */
  const triggeredBy: HeadlessTriggeredBy = source === 'automation'
    ? 'automation'
    : source === 'delegation' ? 'delegation' : 'external'
  return {
    ...publicInput,
    triggeredBy,
    startedAt: input.startedAt ?? now(),
  }
}
