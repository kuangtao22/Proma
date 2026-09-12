import { describe, expect, test } from 'bun:test'
import { AGENT_RUNTIME_METHODS } from '@proma/shared'
import {
  CANVAS_EXECUTION_TOOL_TIMEOUT_MS,
  DESIGN_IMAGE_TOOL_TIMEOUT_MS,
  getParentRequestTimeoutMs,
} from './agent-runtime-request-timeout'
import { ParentRequestRegistry } from './agent-runtime-parent-request-registry'

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

  test('Given canvas_run_agent 等待子 Agent 完整终态 When 解析超时 Then 由运行生命周期终结', () => {
    expect(getParentRequestTimeoutMs(AGENT_RUNTIME_METHODS.CAPABILITY_CUSTOM_TOOL, {
      toolName: 'canvas_run_agent',
    })).toBeUndefined()
  })

  test('Given 批量工作流有独立预算 When 解析超时 Then 保留十五分钟时限', () => {
    expect(getParentRequestTimeoutMs(AGENT_RUNTIME_METHODS.CAPABILITY_CUSTOM_TOOL, {
      toolName: 'canvas_run_workflow',
    })).toBe(CANVAS_EXECUTION_TOOL_TIMEOUT_MS)
  })

  test('Given AskUserQuestion When 等待用户输入 Then 不设置墙钟时限', () => {
    expect(getParentRequestTimeoutMs(AGENT_RUNTIME_METHODS.CAPABILITY_CAN_USE_TOOL, {
      toolName: 'AskUserQuestion',
    })).toBeUndefined()
  })

  test('Given 普通工具等待用户审批 When 解析超时 Then 由运行生命周期负责终结而不设置墙钟时限', () => {
    expect(getParentRequestTimeoutMs(AGENT_RUNTIME_METHODS.CAPABILITY_CAN_USE_TOOL, {
      toolName: 'Write',
    })).toBeUndefined()
  })

  test('Given canvas_run_nodes 批量排队并启动图片任务 When 解析超时 Then 使用十五分钟长时限', () => {
    expect(getParentRequestTimeoutMs(AGENT_RUNTIME_METHODS.CAPABILITY_CUSTOM_TOOL, {
      toolName: 'canvas_run_nodes',
    })).toBe(CANVAS_EXECUTION_TOOL_TIMEOUT_MS)
  })

  test('Given 非自定义工具能力携带导演工具名 When 解析超时 Then 不绕过普通故障检测', () => {
    expect(getParentRequestTimeoutMs(AGENT_RUNTIME_METHODS.CAPABILITY_EVALUATE_COMPLETION, {
      toolName: 'canvas_run_agent',
    })).toBe(120_000)
  })

  test.each(['成功', '用户取消', '运行时退出', '子运行失败'] as const)(
    'Given 导演审核超过旧 RPC 时限 When %s Then 依实际生命周期结束且清理等待',
    async (ending) => {
      /** 真实请求注册器，验证策略最终作用于等待和取消链。 */
      const registry = new ParentRequestRegistry()
      /** 父运行拥有的取消信号。 */
      const controller = new AbortController()
      /** 记录实际发送的请求与取消，防止误触发主进程停止。 */
      const sent: string[] = []
      /** 生产策略解析结果；测试将任何有限时限压缩为 1ms，避免真实等待十五分钟。 */
      const timeoutMs = getParentRequestTimeoutMs(AGENT_RUNTIME_METHODS.CAPABILITY_CUSTOM_TOOL, {
        toolName: 'canvas_run_agent',
      })
      /** 提前消费失败，避免旧实现超时产生未处理拒绝。 */
      const pending = registry.wait({
        requestId: 'director-review',
        method: AGENT_RUNTIME_METHODS.CAPABILITY_CUSTOM_TOOL,
        timeoutMs: timeoutMs === undefined ? undefined : 1,
        signal: controller.signal,
        sendRequest: () => { sent.push('request') },
        sendCancel: () => { sent.push('cancel') },
      }).catch((error: unknown) => error)

      try {
        await new Promise<void>((resolve) => setTimeout(resolve, 10))
        expect(sent).toEqual(['request'])
        expect(registry.size).toBe(1)

        if (ending === '成功') {
          registry.resolve('director-review', { status: 'completed', output: '正式导演方案' })
          expect(await pending).toEqual({ status: 'completed', output: '正式导演方案' })
        } else if (ending === '用户取消') {
          controller.abort()
          expect(await pending).toEqual(new Error('Main runtime request aborted: agent.capability.customTool'))
          expect(sent).toEqual(['request', 'cancel'])
        } else {
          /** 真实主进程错误或 utility 退出传来的终态原因。 */
          const error = new Error(ending === '运行时退出' ? 'Agent runtime is shutting down' : 'Child runtime crashed')
          if (ending === '运行时退出') registry.rejectAll(error)
          else registry.reject('director-review', error)
          expect(await pending).toBe(error)
        }

        expect(registry.size).toBe(0)
        expect(registry.resolve('director-review', { status: 'completed' })).toBe(false)
        expect(registry.reject('director-review', new Error('迟到错误'))).toBe(false)
        controller.abort()
        expect(sent).toEqual(ending === '用户取消' ? ['request', 'cancel'] : ['request'])
      } finally {
        registry.rejectAll(new Error('测试结束'))
      }
    },
  )
})
