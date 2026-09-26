import { describe, expect, test } from 'bun:test'
import type { SDKMessage } from '@proma/shared'
import { collectFilePaths, hasShellToolCall } from './TurnFileChangesSummary'

/** 构造 assistant 侧的工具调用消息。 */
function toolUse(id: string, toolName: string, filePath: string): SDKMessage {
  return {
    type: 'assistant',
    parent_tool_use_id: null,
    message: {
      content: [{ type: 'tool_use', id, name: toolName, input: { file_path: filePath } }],
    },
  } as unknown as SDKMessage
}

/** 构造 user 侧的工具结果消息。 */
function toolResult(id: string, isError = false): SDKMessage {
  return {
    type: 'user',
    parent_tool_use_id: null,
    message: {
      content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: 'ok' }],
    },
  } as unknown as SDKMessage
}

describe('本轮文件改动汇总', () => {
  test('Given 工具已成功返回 When 收集路径 Then 纳入汇总', () => {
    const paths = collectFilePaths([
      toolUse('call-1', 'Write', '/tmp/project/报告.md'),
      toolResult('call-1'),
    ])

    expect(paths).toEqual(['/tmp/project/报告.md'])
  })

  test('Given 工具仍在流式执行未返回结果 When 收集路径 Then 不提前渲染 Chip', () => {
    expect(collectFilePaths([toolUse('call-2', 'Edit', '/tmp/project/a.ts')])).toEqual([])
  })

  test('Given 工具调用报错 When 收集路径 Then 排除该文件', () => {
    expect(collectFilePaths([
      toolUse('call-3', 'Edit', '/tmp/project/b.ts'),
      toolResult('call-3', true),
    ])).toEqual([])
  })

  test('Given 同一文件被多次改动 When 收集路径 Then 按首次出现顺序去重', () => {
    const paths = collectFilePaths([
      toolUse('call-4', 'Edit', '/tmp/project/c.ts'),
      toolResult('call-4'),
      toolUse('call-5', 'Write', '/tmp/project/c.ts'),
      toolResult('call-5'),
      toolUse('call-6', 'Write', '/tmp/project/d.ts'),
      toolResult('call-6'),
    ])

    expect(paths).toEqual(['/tmp/project/c.ts', '/tmp/project/d.ts'])
  })

  test('Given Read 等非改动工具 When 收集路径 Then 默认不进入底部汇总', () => {
    expect(collectFilePaths([
      toolUse('call-7', 'Read', '/tmp/project/e.ts'),
      toolResult('call-7'),
    ])).toEqual([])
  })
})

describe('命令行工具识别', () => {
  test('Given 本轮调用了命令行 When 识别 Then 认为可能存在范围外写入', () => {
    expect(hasShellToolCall([
      toolUse('call-shell', 'Bash', '/tmp/project/f.ts'),
      toolResult('call-shell'),
    ])).toBe(true)
  })

  test('Given 本轮只有读写文件工具 When 识别 Then 不追加范围说明', () => {
    expect(hasShellToolCall([
      toolUse('call-8', 'Edit', '/tmp/project/g.ts'),
      toolResult('call-8'),
      toolUse('call-9', 'Read', '/tmp/project/h.ts'),
      toolResult('call-9'),
    ])).toBe(false)
  })

  test('Given 本轮没有工具调用 When 识别 Then 返回 false', () => {
    expect(hasShellToolCall([])).toBe(false)
  })
})
