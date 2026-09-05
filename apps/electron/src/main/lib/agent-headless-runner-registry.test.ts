import { describe, expect, test } from 'bun:test'
import type { AgentSendInput } from '@proma/shared'
import type { AgentRunExtensions } from './agent-run-extensions'
import {
  runRegisteredHeadlessAgent,
  setHeadlessAgentRunner,
} from './agent-headless-runner-registry'

const input: AgentSendInput = {
  sessionId: 'session-1', userMessage: '执行', channelId: 'channel-1',
}

describe('Agent headless runner 注册表', () => {
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
})
