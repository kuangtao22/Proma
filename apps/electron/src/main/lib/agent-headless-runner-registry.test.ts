import { describe, expect, test } from 'bun:test'
import type { AgentSendInput } from '@proma/shared'
import type { AgentRunExtensions } from './agent-run-extensions'
import {
  resolveHeadlessAgentRunTerminalStatus,
  runRegisteredHeadlessAgent,
  setHeadlessAgentRunner,
} from './agent-headless-runner-registry'

const input: AgentSendInput = {
  sessionId: 'session-1', userMessage: '执行', channelId: 'channel-1',
}

describe('Agent headless runner 注册表', () => {
  test('Given Pi typed-error 未提供 result subtype When 归一化终态 Then fail closed 为错误', () => {
    expect(resolveHeadlessAgentRunTerminalStatus({
      runErrored: false,
      stoppedByUser: false,
    })).toBe('errored')
  })

  test('Given Pi 正常 result 明确提供 success When 归一化终态 Then 允许完成', () => {
    expect(resolveHeadlessAgentRunTerminalStatus({
      runErrored: false,
      stoppedByUser: false,
      resultSubtype: 'success',
    })).toBe('completed')
  })

  test('Given Pi result 明确提供非 success subtype When 归一化终态 Then 判定为错误', () => {
    expect(resolveHeadlessAgentRunTerminalStatus({
      runErrored: false,
      stoppedByUser: false,
      resultSubtype: 'error_during_execution',
    })).toBe('errored')
  })

  test('Given 本轮已经触发 onError When 后续 completion 到达 Then 错误事实优先', () => {
    expect(resolveHeadlessAgentRunTerminalStatus({
      runErrored: true,
      stoppedByUser: false,
      resultSubtype: 'success',
    })).toBe('errored')
  })

  test('Given 用户已停止 When completion 同时携带其它信号 Then STOP 优先判定为取消', () => {
    expect(resolveHeadlessAgentRunTerminalStatus({
      runErrored: true,
      stoppedByUser: true,
      resultSubtype: 'success',
    })).toBe('cancelled')
  })

  test('Given 调用方提供单次运行扩展 When 启动已注册 runner Then 原样传递且旧两参数调用仍兼容', async () => {
    /** 记录 runner 收到的可信单次扩展。 */
    const received: Array<AgentRunExtensions | undefined> = []
    setHeadlessAgentRunner(async (_input, _callbacks, extensions) => {
      received.push(extensions)
    })
    const callbacks = {
      onError: () => undefined,
      onComplete: () => undefined,
      onTitleUpdated: () => undefined,
    }
    const extensions: AgentRunExtensions = {
      systemPromptAppend: 'Canvas 运行上下文',
      allowedToolNames: ['Read'],
    }

    await runRegisteredHeadlessAgent(input, callbacks, extensions)
    await runRegisteredHeadlessAgent(input, callbacks)

    expect(received).toEqual([extensions, undefined])
  })

  test('Given runner 返回有界终态 metadata When 完成 Then 调用方收到完整身份且旧单参数 callback 仍兼容', async () => {
    let terminal: unknown
    setHeadlessAgentRunner(async (_input, callbacks) => {
      callbacks.onComplete(undefined, {
        status: 'cancelled', stoppedByUser: true, startedAt: 123,
        runGeneration: 4, resultSubtype: 'success',
      })
    })

    await runRegisteredHeadlessAgent(input, {
      onError: () => undefined,
      onComplete: (_messages, options) => { terminal = options },
      onTitleUpdated: () => undefined,
    })

    expect(terminal).toEqual({
      status: 'cancelled', stoppedByUser: true, startedAt: 123,
      runGeneration: 4, resultSubtype: 'success',
    })
  })
})
