/**
 * Agent headless runner 注册表
 *
 * 用于主进程内置工具在不直接 import agent-service.ts 的情况下启动/停止真实 Agent 会话，
 * 避免 AgentOrchestrator 与 agent-service 形成难以维护的循环依赖。
 */

import type {
  AgentExternalRunSource,
  AgentMessage,
  AgentSendInput,
} from '@proma/shared'
import type { AgentRunExtensions } from './agent-run-extensions'

/** Headless 调用方用于判定本轮是否可提交业务结果的有界终态。 */
export interface HeadlessAgentRunTerminalOptions {
  status: 'completed' | 'errored' | 'cancelled'
  stoppedByUser: boolean
  startedAt: number
  runGeneration?: number
  resultSubtype?: string
  /** Pi result 的本轮错误详情，供业务调用方在没有 onError 时仍能识别真实失败。 */
  resultErrors?: string[]
}

export interface HeadlessAgentRunCallbacks {
  onError: (error: string) => void
  /** 第二参数可选以保持现有 Feishu、Automation 与 Collaboration 回调源码兼容。 */
  onComplete: (messages?: AgentMessage[], options?: HeadlessAgentRunTerminalOptions) => void
  onTitleUpdated: (title: string) => void
  source?: AgentExternalRunSource
  /** 发起此次 headless 运行的可见会话，用于将事件路由回其 renderer。 */
  originSessionId?: string
}

/**
 * 解析 headless Agent 的公开终态。
 * 入参包含本轮错误、停止与 Pi result subtype；返回调用方可消费的有界终态。
 */
export function resolveHeadlessAgentRunTerminalStatus(input: {
  runErrored: boolean
  stoppedByUser?: boolean
  resultSubtype?: string
}): HeadlessAgentRunTerminalOptions['status'] {
  if (input.stoppedByUser) return 'cancelled'
  if (input.runErrored || input.resultSubtype !== 'success') return 'errored'
  return 'completed'
}

export type HeadlessAgentRunner = (
  input: AgentSendInput,
  callbacks: HeadlessAgentRunCallbacks,
  extensions?: AgentRunExtensions,
) => Promise<void>

export type AgentStopper = (sessionId: string) => void

let headlessRunner: HeadlessAgentRunner | null = null
let agentStopper: AgentStopper | null = null

export function setHeadlessAgentRunner(runner: HeadlessAgentRunner): void {
  headlessRunner = runner
}

export function setAgentStopper(stopper: AgentStopper): void {
  agentStopper = stopper
}

export async function runRegisteredHeadlessAgent(
  input: AgentSendInput,
  callbacks: HeadlessAgentRunCallbacks,
  extensions?: AgentRunExtensions,
): Promise<void> {
  if (!headlessRunner) {
    throw new Error('Agent headless runner 尚未初始化')
  }
  await headlessRunner(input, callbacks, extensions)
}

export function stopRegisteredAgent(sessionId: string): void {
  if (!agentStopper) {
    throw new Error('Agent stopper 尚未初始化')
  }
  agentStopper(sessionId)
}
