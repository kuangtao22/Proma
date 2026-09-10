import { describe, expect, test } from 'bun:test'
import { Provider } from 'jotai'
import { createStore } from 'jotai/vanilla'
import { renderToStaticMarkup } from 'react-dom/server'
import { agentSessionStreamingStateAtomFamily, type AgentStreamState } from '@/atoms/agent-atoms'
import { ContextUsageBadge } from './ContextUsageBadge'

/** 使用真实 Jotai 状态和组件渲染，验证未知统计不会伪装为零占用。 */
function renderUsage(state: AgentStreamState): string {
  const store = createStore()
  store.set(agentSessionStreamingStateAtomFamily('usage-badge'), state)
  return renderToStaticMarkup(
    <Provider store={store}>
      <ContextUsageBadge sessionId="usage-badge" isProcessing={false} onCompact={() => {}} />
    </Provider>,
  )
}

describe('上下文用量指示器', () => {
  test('Given 从未有统计 When 本次未知 Then 明确显示未知入口', () => {
    expect(renderUsage({ running: false, usageStatus: 'unknown' })).toContain('aria-label="用量未知"')
  })
  test('Given 已有统计 When 最新未知 Then 标注最近已知值', () => {
    expect(renderUsage({ running: false, usageStatus: 'unknown', inputTokens: 12_000, contextWindow: 200_000 }))
      .toContain('aria-label="用量未知，显示最近已知值"')
  })
  test('Given 明确报告零 When 渲染 Then 保留真实零', () => {
    expect(renderUsage({ running: false, usageStatus: 'known', inputTokens: 0, contextWindow: 200_000 }))
      .toContain('aria-label="上下文用量 0%"')
  })
})
