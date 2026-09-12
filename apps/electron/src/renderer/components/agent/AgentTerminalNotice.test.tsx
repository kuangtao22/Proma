import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { AgentTerminalNotice } from './AgentTerminalNotice'

describe('Agent 终态提示展示', () => {
  test('Given 宿主验收阻塞 When 渲染助手回合尾部 Then 同时展示结论和真实原因', () => {
    const html = renderToStaticMarkup(
      <AgentTerminalNotice
        notice={{
          kind: 'blocked',
          title: '交付检查尚未通过',
          detail: '终验记录不完整',
        }}
      />,
    )

    expect(html).toContain('交付检查尚未通过')
    expect(html).toContain('终验记录不完整')
    expect(html).toContain('data-agent-terminal-status="blocked"')
  })
})
