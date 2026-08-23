import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRunToolCallLimiter, denyToolOutsideRunAllowlist } from './agent-run-tool-policy'

describe('Design Agent 运行级工具策略', () => {
  test('Given Design run 仅允许 Nano Banana When 检查工具 Then 其它内置和 MCP 工具全部拒绝', () => {
    const allowedToolNames = ['mcp__nano_banana__generate_image'] as const
    const deniedToolNames = [
      'Bash',
      'Write',
      'Read',
      'BrowserNavigate',
      'mcp__other__generate_image',
    ]

    expect(denyToolOutsideRunAllowlist(allowedToolNames[0], allowedToolNames)).toBeUndefined()
    for (const toolName of deniedToolNames) {
      expect(denyToolOutsideRunAllowlist(toolName, allowedToolNames)).toEqual({
        behavior: 'deny',
        message: `当前任务不允许使用工具: ${toolName}`,
      })
    }
  })

  test('Given 普通 Agent run 未传 allowlist When 检查任意工具 Then 保持原权限流程', () => {
    expect(denyToolOutsideRunAllowlist('Bash', undefined)).toBeUndefined()
    expect(denyToolOutsideRunAllowlist('mcp__other__tool', undefined)).toBeUndefined()
  })

  test('Given Design 单轮 Nano Banana 上限为一 When 连续准入两次 Then 首次占位且第二次明确拒绝', () => {
    const toolName = 'mcp__nano_banana__generate_image'
    const consumeLimit = createRunToolCallLimiter({ [toolName]: 1 })

    expect(consumeLimit(toolName)).toBeUndefined()
    expect(consumeLimit(toolName)).toEqual({
      behavior: 'deny',
      message: `当前任务工具调用次数已达上限: ${toolName}`,
    })
  })

  test('Given 普通 Agent 未设置工具上限 When 重复准入 Then 保持原行为', () => {
    const consumeLimit = createRunToolCallLimiter(undefined)
    expect(consumeLimit('mcp__nano_banana__generate_image')).toBeUndefined()
    expect(consumeLimit('mcp__nano_banana__generate_image')).toBeUndefined()
  })

  test('Given canUseTool 进入权限边界 When 检查源码顺序 Then stale 后且参数处理前执行 allowlist', () => {
    const source = readFileSync(join(import.meta.dir, 'agent-orchestrator.ts'), 'utf8')
    const canUseToolStart = source.indexOf('const canUseTool = async')
    const canUseToolEnd = source.indexOf('// ── Write 大文件', canUseToolStart)
    const body = source.slice(canUseToolStart, canUseToolEnd)
    const staleIndex = body.indexOf('denyStaleToolRun()')
    const allowlistIndex = body.indexOf('denyToolOutsideRunAllowlist(')
    const limitIndex = body.indexOf('consumeRunToolCallLimit(')
    const validationIndex = body.indexOf('validateToolInput(')

    expect(staleIndex).toBeGreaterThan(-1)
    expect(allowlistIndex).toBeGreaterThan(staleIndex)
    expect(validationIndex).toBeGreaterThan(allowlistIndex)
    expect(limitIndex).toBeGreaterThan(validationIndex)
  })
})
