import { describe, expect, test } from 'bun:test'
import type { SDKMessage } from '@proma/shared'
import {
  finalizePiAgentCompletionTurns,
  sendPiTaskContinuation,
} from './pi-agent-adapter'

/** 创建带可辨识原因的成功终态。 */
function successResult(reason: string): SDKMessage {
  return {
    type: 'result', subtype: 'success', terminal_reason: reason, session_id: 'session-1',
    usage: { input_tokens: 1, output_tokens: 1 },
  } as unknown as SDKMessage
}

describe('Pi Agent Host 完成续行', () => {
  test('Given Host 判断任务未完成 When 触发续行 Then 只发送隐藏 custom message 且不重投原用户 prompt', async () => {
    const customMessages: unknown[] = []
    let promptCalls = 0
    const session = {
      prompt: async () => { promptCalls += 1 },
      sendCustomMessage: async (message: unknown, options: unknown) => {
        customMessages.push({ message, options })
      },
    }

    await sendPiTaskContinuation(session, '继续读取剩余节点并完成验收')

    expect(promptCalls).toBe(0)
    expect(customMessages).toEqual([{
      message: {
        customType: 'proma-task-continuation',
        content: '继续读取剩余节点并完成验收',
        display: false,
      },
      options: { triggerTurn: true },
    }])
  })

  test('Given 普通运行未配置检查 When turn 完成 Then 原终态只上送一次', async () => {
    let terminalResult: SDKMessage | undefined = successResult('original')
    const emitted: SDKMessage[] = []
    let controllerCount = 0
    const count = await finalizePiAgentCompletionTurns({
      continuationCount: 0,
      prepareTerminalResult: async () => undefined,
      takeTerminalResult: () => {
        const result = terminalResult
        terminalResult = undefined
        return result
      },
      emitTerminalResult: (result) => { emitted.push(result) },
      isStopped: () => false,
      canContinue: () => true,
      createEvaluationController: () => { controllerCount += 1; return new AbortController() },
      continueTask: async () => undefined,
    })

    expect(count).toBe(0)
    expect(controllerCount).toBe(0)
    expect(emitted.map((result) => (result as Record<string, unknown>).terminal_reason)).toEqual(['original'])
  })

  test('Given Host 先要求续行再确认完成 When 同一 session 产生新终态 Then 只上送最终结果', async () => {
    let terminalResult: SDKMessage | undefined = successResult('first')
    const emitted: SDKMessage[] = []
    let evaluations = 0
    const count = await finalizePiAgentCompletionTurns({
      continuationCount: 0,
      prepareTerminalResult: async () => undefined,
      takeTerminalResult: () => {
        const result = terminalResult
        terminalResult = undefined
        return result
      },
      emitTerminalResult: (result) => { emitted.push(result) },
      isStopped: () => false,
      canContinue: () => true,
      createEvaluationController: () => new AbortController(),
      evaluateCompletion: async () => {
        evaluations += 1
        return evaluations === 1
          ? { action: 'continue', message: '继续完成验收' }
          : { action: 'complete' }
      },
      continueTask: async () => { terminalResult = successResult('final') },
    })

    expect(count).toBe(1)
    expect(evaluations).toBe(2)
    expect(emitted.map((result) => (result as Record<string, unknown>).terminal_reason)).toEqual(['final'])
  })

  test('Given Host 验收阻断 When turn 原本成功 Then 只上送明确失败结果', async () => {
    let terminalResult: SDKMessage | undefined = successResult('stale-success')
    const emitted: SDKMessage[] = []
    await finalizePiAgentCompletionTurns({
      continuationCount: 0,
      prepareTerminalResult: async () => undefined,
      takeTerminalResult: () => {
        const result = terminalResult
        terminalResult = undefined
        return result
      },
      emitTerminalResult: (result) => { emitted.push(result) },
      isStopped: () => false,
      canContinue: () => true,
      createEvaluationController: () => new AbortController(),
      evaluateCompletion: async () => ({ action: 'blocked', message: '缺少交付证据' }),
      continueTask: async () => undefined,
    })

    expect(emitted).toHaveLength(1)
    expect((emitted[0] as Record<string, unknown>).subtype).toBe('error_during_execution')
    expect((emitted[0] as Record<string, unknown>).terminal_reason).toBe('completion_blocked')
  })

  test.each([
    ['用户中断', true, false],
    ['压缩需要原任务续行', false, true],
  ])('Given %s When 准备终态 Then 不上送旧 success', async (_name, stopped, clearDuringPrepare) => {
    let terminalResult: SDKMessage | undefined = successResult('stale')
    const emitted: SDKMessage[] = []
    let evaluations = 0
    await finalizePiAgentCompletionTurns({
      continuationCount: 0,
      prepareTerminalResult: async () => {
        if (clearDuringPrepare) terminalResult = undefined
      },
      takeTerminalResult: () => {
        const result = terminalResult
        terminalResult = undefined
        return result
      },
      emitTerminalResult: (result) => { emitted.push(result) },
      isStopped: () => stopped,
      canContinue: () => !stopped,
      createEvaluationController: () => new AbortController(),
      evaluateCompletion: async () => { evaluations += 1; return { action: 'complete' } },
      continueTask: async () => undefined,
    })

    expect(emitted).toEqual([])
    expect(evaluations).toBe(0)
  })
})
