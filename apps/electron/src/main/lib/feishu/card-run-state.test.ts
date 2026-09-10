import { describe, expect, test } from 'bun:test'
import type { AgentStreamPayload } from '@proma/shared'
import { renderCard } from './card-renderer-v2'
import { createInitialState, reduce } from './card-run-state'

function resultPayload(
  usageStatus: 'known' | 'partial' | 'unknown' | undefined,
): AgentStreamPayload {
  return {
    kind: 'sdk_message',
    message: {
      type: 'result',
      subtype: 'success',
      usage: { input_tokens: 900, output_tokens: 80 },
      ...(usageStatus ? { usageStatus } : {}),
    },
  } as unknown as AgentStreamPayload
}

describe('飞书卡片用量展示', () => {
  test.each(['unknown', 'partial'] as const)(
    'Given result 用量是 %s When 运行结束 Then 不将累计数字作为完整 token 用量展示',
    (usageStatus) => {
      const state = reduce(createInitialState(), resultPayload(usageStatus))
      const card = renderCard(state)

      expect(state.meta.inputTokens).toBeUndefined()
      expect(state.meta.outputTokens).toBeUndefined()
      expect(JSON.stringify(card)).not.toContain('900↑ 80↓ tokens')
    },
  )

  test('Given 旧 result 没有用量状态 When 运行结束 Then 保留既有 token 展示', () => {
    const state = reduce(createInitialState(), resultPayload(undefined))
    const card = renderCard(state)

    expect(state.meta.inputTokens).toBe(900)
    expect(state.meta.outputTokens).toBe(80)
    expect(JSON.stringify(card)).toContain('900↑ 80↓ tokens')
  })
})
