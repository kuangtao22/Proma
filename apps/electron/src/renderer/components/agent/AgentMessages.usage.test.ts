import { describe, expect, test } from 'bun:test'
import { buildUsageTooltip } from './AgentMessages'

describe('Agent usage display', () => {
  test('Given unknown 兼容记录携带占位零 When 展示 Then 忽略数字', () => {
    const text = buildUsageTooltip(1000, { usageStatus: 'unknown', inputTokens: 0, outputTokens: 0 })
    expect(text).toContain('用量未知')
    expect(text).not.toContain('输入:')
    expect(text).not.toContain('输出:')
  })

  test('Given 真实零或旧格式零 When 展示 Then 不丢失有效的零统计', () => {
    for (const usageStatus of ['known', undefined] as const) {
      const text = buildUsageTooltip(1000, { usageStatus, inputTokens: 0, outputTokens: 0 })
      expect(text).toContain('输入: 0')
      expect(text).toContain('输出: 0')
      expect(text).not.toContain('未知')
    }
  })

  test('unknown usage is shown explicitly instead of as zero', () => {
    expect(buildUsageTooltip(1000, { usageStatus: 'unknown' })).toContain('用量未知')
    expect(buildUsageTooltip(1000, { usageStatus: 'unknown' })).not.toContain('输入: 0')
  })

  test('partial usage is marked as partial statistics', () => {
    expect(buildUsageTooltip(1000, { usageStatus: 'partial', inputTokens: 12_000 })).toContain('部分统计')
  })
})
