import { describe, expect, test } from 'bun:test'
import type { SDKMessage } from '@proma/shared'
import {
  MAX_AGENT_COMPLETION_CONTINUATIONS,
  applyAgentCompletionPolicy,
  type AgentCompletionEvaluation,
} from './agent-completion-policy'

/** 创建供完成检查判断的成功终态。 */
function successResult(): SDKMessage {
  return {
    type: 'result', subtype: 'success', terminal_reason: 'completed', session_id: 'session-1',
    usage: { input_tokens: 1, output_tokens: 1 },
  } as unknown as SDKMessage
}

describe('Agent Host 完成检查', () => {
  test('Given 普通运行没有完成检查 When 模型成功结束 Then 原终态直接返回且不续行', async () => {
    const continued: string[] = []
    const result = await applyAgentCompletionPolicy({
      terminalResult: successResult(), continuationCount: 0, signal: new AbortController().signal,
      canContinue: true, continueTask: async (message) => { continued.push(message) },
    })

    expect(result).toEqual({ terminalResult: successResult(), continuationCount: 0, continued: false })
    expect(continued).toEqual([])
  })

  const terminalCases: Array<[
    string,
    { terminalResult: SDKMessage; canContinue: boolean; stopped?: boolean },
  ]> = [
    ['失败终态', { terminalResult: { ...successResult(), subtype: 'error_during_execution' }, canContinue: true }],
    ['用户停止', { terminalResult: successResult(), canContinue: true, stopped: true }],
  ]
  test.each(terminalCases)('Given %s When 配置完成检查 Then 不调用检查或续行', async (_name, state) => {
    let evaluated = false
    const continued: string[] = []
    const result = await applyAgentCompletionPolicy({
      ...state,
      continuationCount: 0,
      signal: new AbortController().signal,
      evaluateCompletion: async () => { evaluated = true; return { action: 'continue', message: '继续' } },
      continueTask: async (message) => { continued.push(message) },
    })

    expect(result.continued).toBe(false)
    expect(evaluated).toBe(false)
    expect(continued).toEqual([])
    if (state.stopped) expect(result.terminalResult).toBeUndefined()
  })

  test('Given 运行预算已耗尽 When Host 判断任务未完成 Then 仍执行验收并返回非成功结果', async () => {
    let evaluated = false
    const result = await applyAgentCompletionPolicy({
      terminalResult: successResult(), continuationCount: 0,
      signal: new AbortController().signal, canContinue: false,
      evaluateCompletion: async () => {
        evaluated = true
        return { action: 'continue', message: '继续完成剩余工作' }
      },
      continueTask: async () => { throw new Error('预算耗尽后不应续行') },
    })

    expect(evaluated).toBe(true)
    expect((result.terminalResult as Record<string, unknown>).terminal_reason)
      .toBe('completion_continuation_unavailable')
    expect(result.continued).toBe(false)
  })

  test('Given Host 判断仍需执行 When 未达到限额 Then 在同一会话续行并隐藏本轮成功终态', async () => {
    const continued: string[] = []
    const result = await applyAgentCompletionPolicy({
      terminalResult: successResult(), continuationCount: 1, signal: new AbortController().signal,
      canContinue: true,
      evaluateCompletion: async (): Promise<AgentCompletionEvaluation> => ({ action: 'continue', message: '读取剩余节点并完成验收' }),
      continueTask: async (message) => { continued.push(message) },
    })

    expect(result).toEqual({ terminalResult: undefined, continuationCount: 2, continued: true })
    expect(continued).toEqual(['读取剩余节点并完成验收'])
  })

  test.each([
    ['Host 阻断', async (): Promise<AgentCompletionEvaluation> => ({ action: 'blocked', message: '缺少可验证交付物' }), 'completion_blocked'],
    ['续行次数耗尽', async (): Promise<AgentCompletionEvaluation> => ({ action: 'continue', message: '继续' }), 'completion_continuation_limit'],
    ['检查失败', async (): Promise<AgentCompletionEvaluation> => { throw new Error('检查服务不可用') }, 'completion_check_failed'],
  ])('Given %s When 处理成功终态 Then 返回明确非成功结果', async (_name, evaluateCompletion, terminalReason) => {
    const continued: string[] = []
    const result = await applyAgentCompletionPolicy({
      terminalResult: successResult(),
      continuationCount: terminalReason === 'completion_continuation_limit' ? MAX_AGENT_COMPLETION_CONTINUATIONS : 0,
      signal: new AbortController().signal, canContinue: true, evaluateCompletion,
      continueTask: async (message) => { continued.push(message) },
    })

    expect((result.terminalResult as Record<string, unknown>)?.subtype).toBe('error_during_execution')
    expect((result.terminalResult as Record<string, unknown>)?.terminal_reason).toBe(terminalReason)
    expect(continued).toEqual([])
  })
})
