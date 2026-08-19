import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Message, ToolResultContent } from '../../atoms'
import { MessageBubble } from './MessageBubble'

/** 用空结果映射渲染不含工具结果的普通消息。 */
const emptyResults = new Map<string, ToolResultContent>()

describe('移动端消息视觉结构', () => {
  test('Given AI 正文和用户正文 When 渲染 Then AI 平铺且用户使用克制强调表面', () => {
    /** 用最小 AI 正文检查平铺结构。 */
    const assistant: Message = { id: 'a', role: 'assistant', content: '回答', model: 'gpt-test' }
    /** 用最小用户正文检查右侧强调表面。 */
    const user: Message = { id: 'u', role: 'user', content: '问题' }
    /** AI 静态标记必须适配长内容且不能保留渐变头像。 */
    const assistantMarkup = renderToStaticMarkup(
      <MessageBubble message={assistant} resultMap={emptyResults} />,
    )
    /** 用户静态标记必须使用语义 secondary 表面。 */
    const userMarkup = renderToStaticMarkup(
      <MessageBubble message={user} resultMap={emptyResults} />,
    )

    expect(assistantMarkup).toContain('data-message-role="assistant"')
    expect(assistantMarkup).toContain('break-words')
    expect(assistantMarkup).not.toContain('bg-gradient-to-br')
    expect(userMarkup).toContain('data-message-role="user"')
    expect(userMarkup).toContain('bg-secondary')
  })

  test('Given 思考和工具调用 When 渲染 Then 使用文字状态与可折叠次级区域', () => {
    /** 同一 AI 消息同时覆盖思考和工具调用组合。 */
    const message: Message = {
      id: 'tool',
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '分析过程' },
        { type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: '/tmp/a.ts' } },
      ],
    }
    /** 组合标记用于验证折叠区和工具摘要共享统一视觉语言。 */
    const markup = renderToStaticMarkup(
      <MessageBubble message={message} resultMap={emptyResults} />,
    )

    expect(markup).toContain('思考过程')
    expect(markup).toContain('读取文件 a.ts')
    expect(markup).not.toMatch(/[🧠📄]/u)
  })
})
