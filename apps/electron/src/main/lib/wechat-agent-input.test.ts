import { describe, expect, test } from 'bun:test'
import { appendWeChatAgentSourceMarker, WECHAT_AGENT_SOURCE_MARKER } from './wechat-agent-input'

describe('微信模型输入来源', () => {
  test('Given 含附件引用的原文 When 加入模型来源 Then 保留原文且仅在末尾标记', () => {
    /** 附件引用必须和用户问题一同传给 Agent。 */
    const original = '<attached_files>报告.pdf</attached_files>\n解释这份报告'
    expect(appendWeChatAgentSourceMarker(original)).toBe(`${original}\n\n${WECHAT_AGENT_SOURCE_MARKER}`)
  })

  test('Given 已有来源标记的输入 When 再次处理 Then 不重复追加标记', () => {
    /** 重放输入末尾可能带有平台换行。 */
    const marked = `继续\n\n${WECHAT_AGENT_SOURCE_MARKER}`
    expect(appendWeChatAgentSourceMarker(`${marked}\n `)).toBe(marked)
  })
})
