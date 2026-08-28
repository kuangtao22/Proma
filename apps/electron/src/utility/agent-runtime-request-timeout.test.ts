import { describe, expect, test } from 'bun:test'
import { AGENT_RUNTIME_METHODS } from '@proma/shared'
import {
  ASK_USER_QUESTION_TIMEOUT_MS,
  DESIGN_IMAGE_TOOL_TIMEOUT_MS,
  getParentRequestTimeoutMs,
} from './agent-runtime-request-timeout'

const DESIGN_IMAGE_TOOL = 'mcp__nano_banana__generate_image'

describe('Agent utility 主进程请求超时', () => {
  test('Given Design 图片工具可能长时间生成 When 解析超时 Then 使用独立长时限', () => {
    expect(getParentRequestTimeoutMs(AGENT_RUNTIME_METHODS.CAPABILITY_CUSTOM_TOOL, {
      toolName: DESIGN_IMAGE_TOOL,
    })).toBe(DESIGN_IMAGE_TOOL_TIMEOUT_MS)
  })

  test('Given 普通自定义工具 When 解析超时 Then 不放宽默认故障检测', () => {
    expect(getParentRequestTimeoutMs(AGENT_RUNTIME_METHODS.CAPABILITY_CUSTOM_TOOL, {
      toolName: 'ordinary-tool',
    })).toBe(120_000)
  })

  test('Given AskUserQuestion When 等待用户输入 Then 保留交互长时限', () => {
    expect(getParentRequestTimeoutMs(AGENT_RUNTIME_METHODS.CAPABILITY_CAN_USE_TOOL, {
      toolName: 'AskUserQuestion',
    })).toBe(ASK_USER_QUESTION_TIMEOUT_MS)
  })
})
