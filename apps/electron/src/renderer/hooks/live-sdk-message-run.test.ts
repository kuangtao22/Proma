import { describe, expect, test } from 'bun:test'
import type { SDKMessage } from '@proma/shared'
import { applyLiveSdkMessageRunIdentity, shouldAcceptLiveSdkMessageForRun } from './useGlobalAgentListeners'

function message(fields: Record<string, unknown> = {}): SDKMessage {
  return { type: 'system', subtype: 'status', ...fields } as unknown as SDKMessage
}

describe('实时 SDK 消息运行隔离', () => {
  test('Given 旧 generation 消息迟到 When 新 run 已激活 Then 拒绝写入当前 liveMessages', () => {
    const stale = message({ _promaLiveRunStartedAt: 100, _promaLiveRunGeneration: 1 })

    expect(shouldAcceptLiveSdkMessageForRun(stale, { startedAt: 200, runGeneration: 2 })).toBe(false)
  })

  test('Given 主进程已写入运行身份 When renderer 接收消息 Then 不覆盖该身份', () => {
    const stale = message({ _promaLiveRunStartedAt: 100, _promaLiveRunGeneration: 1 })

    applyLiveSdkMessageRunIdentity(stale, { startedAt: 200, runGeneration: 2 })

    expect(stale).toMatchObject({
      _promaLiveRunStartedAt: 100,
      _promaLiveRunGeneration: 1,
    })
  })

  test('Given 旧 EventBus 消息未携带身份 When renderer 接收当前 run 消息 Then 补齐兼容标记', () => {
    const legacy = message()

    expect(shouldAcceptLiveSdkMessageForRun(legacy, { startedAt: 200, runGeneration: 2 })).toBe(true)
    applyLiveSdkMessageRunIdentity(legacy, { startedAt: 200, runGeneration: 2 })
    expect(legacy).toMatchObject({
      _promaLiveRunStartedAt: 200,
      _promaLiveRunGeneration: 2,
    })
  })
})
