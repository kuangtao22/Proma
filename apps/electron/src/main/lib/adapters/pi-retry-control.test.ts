import { describe, expect, test } from 'bun:test'
import {
  createPiRetryTerminalGate,
  mapPiNativeRetryEvent,
  PI_NATIVE_RETRY_POLICY,
  PI_NATIVE_SILENT_RETRY_ATTEMPTS,
} from './pi-retry-control'

const RETRY_CONTEXT = { runStartedAt: 1_000 }

describe('Pi 原生重试策略（渠道侧请求预算）', () => {
  test('给定上游过载重试策略，一次连续失败最多产生 4 次请求', () => {
    // 渠道后台把上游失败记为 0 token 请求，重试次数直接等于用户可见的失败请求条数。
    expect(PI_NATIVE_RETRY_POLICY.enabled).toBe(true)
    expect(PI_NATIVE_RETRY_POLICY.maxRetries).toBe(3)
    expect(1 + PI_NATIVE_RETRY_POLICY.maxRetries).toBe(4)
  })

  test('给定过载上游，退避基数足够让渠道喘口气', () => {
    expect(PI_NATIVE_RETRY_POLICY.baseDelayMs).toBe(2_000)
  })

  test('给定默认配置，重试不再对用户静默', () => {
    expect(PI_NATIVE_SILENT_RETRY_ATTEMPTS).toBe(0)
  })
})

describe('Pi 原生重试事件映射', () => {
  test('given 第一次重试被安排 when 映射事件 then 立刻产生 starting 状态', () => {
    const updates = mapPiNativeRetryEvent({
      type: 'auto_retry_start',
      attempt: 1,
      maxAttempts: 3,
      delayMs: 2_000,
      errorMessage: 'Our servers are currently overloaded. Please try again later.',
    }, RETRY_CONTEXT, 5_000)

    expect(updates).toHaveLength(1)
    expect(updates[0]).toMatchObject({
      status: 'starting',
      attempt: 1,
      maxAttempts: 3,
      delaySeconds: 2,
      scheduledAt: 5_000,
      runStartedAt: 1_000,
      reason: 'Our servers are currently overloaded. Please try again later.',
    })
  })

  test('given 重试成功 when 映射事件 then 收束为 cleared 而不是失败', () => {
    const updates = mapPiNativeRetryEvent({
      type: 'auto_retry_end',
      attempt: 2,
      maxAttempts: 3,
      delayMs: 4_000,
      success: true,
    }, RETRY_CONTEXT, 9_000)

    expect(updates.map((update) => update.status)).toEqual(['cleared'])
  })

  test('given 重试预算耗尽 when 映射事件 then 携带最后一次错误与等待时间', () => {
    const updates = mapPiNativeRetryEvent({
      type: 'auto_retry_end',
      attempt: 3,
      maxAttempts: 3,
      delayMs: 8_000,
      success: false,
      finalError: 'Our servers are currently overloaded. Please try again later.',
    }, RETRY_CONTEXT, 20_000)

    expect(updates).toHaveLength(1)
    expect(updates[0]).toMatchObject({
      status: 'failed',
      attempt: 3,
      maxAttempts: 3,
      attemptData: {
        attempt: 3,
        delaySeconds: 8,
        timestamp: 20_000,
        reason: 'Our servers are currently overloaded. Please try again later.',
        errorMessage: 'Our servers are currently overloaded. Please try again later.',
      },
    })
  })

  test('given 失败终态缺少错误正文 when 映射事件 then 使用占位文案而不是空字符串', () => {
    const updates = mapPiNativeRetryEvent({
      type: 'auto_retry_end',
      attempt: 2,
      maxAttempts: 3,
      success: false,
    }, RETRY_CONTEXT, 11_000)

    const update = updates[0]
    expect(update).toMatchObject({ status: 'failed' })
    if (update?.status !== 'failed') throw new Error('应产生 failed 状态')
    expect(update.attemptData.errorMessage).toBe('未知错误')
    expect(update.attemptData.delaySeconds).toBe(0)
  })
})

describe('Pi native retry 终态门控', () => {
  test('given 已推迟的错误 when 仍在重试 then 不把错误当作终态', () => {
    const gate = createPiRetryTerminalGate<string>()
    gate.defer('上游过载')

    expect(gate.peek()).toBe('上游过载')
    expect(gate.settle(true)).toBeUndefined()
    expect(gate.peek()).toBeUndefined()
  })

  test('given 已推迟的错误 when 不再重试 then 交出该错误作为终态', () => {
    const gate = createPiRetryTerminalGate<string>()
    gate.defer('上游过载')

    expect(gate.settle(false)).toBe('上游过载')
    expect(gate.settle(false)).toBeUndefined()
  })
})
