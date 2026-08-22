import { describe, expect, test } from 'bun:test'
import type { Api, Model, ModelsSimpleStreamOptions } from '@earendil-works/pi-ai'
import type { Dispatcher } from 'undici'
import {
  completePiTitleRequest,
  extractPiResponseText,
  type PiTitleRequestEnvironment,
  type PiTitleRuntime,
} from './pi-title-generator'

/** 通用 Pi 协议测试模型。 */
const model = {} as Model<Api>
/** 需要显式关闭推理的 Codex 协议测试模型。 */
const codexModel = { api: 'openai-codex-responses' } as Model<Api>

/** 创建可观测代理环境，用于验证请求作用域和资源清理。 */
function createEnvironment(dispatcher?: Dispatcher): PiTitleRequestEnvironment & {
  closed: Dispatcher | undefined
  installed: boolean
} {
  return {
    dispatcher,
    closed: undefined,
    installed: false,
    installRequestProxyFetch() { this.installed = true },
    runWithRequestProxy(_dispatcher, operation) { return operation() },
    async closeRequestProxyDispatcher(closed) { this.closed = closed },
  }
}

describe('Pi 自动标题生成', () => {
  test('Given Pi response with reasoning and text When extracting title Then returns visible text only', () => {
    expect(extractPiResponseText([
      { type: 'thinking', thinking: '先理解用户意图' },
      { type: 'text', text: '修复自定义渠道' },
      { type: 'toolCall', id: 'tool-1', name: 'ignored', arguments: {} },
      { type: 'text', text: '标题' },
    ])).toBe('修复自定义渠道标题')
  })

  test('Given Pi response without text When extracting title Then returns an empty string', () => {
    expect(extractPiResponseText([{ type: 'thinking', thinking: '不应显示' }])).toBe('')
  })

  test('Given current Pi model When requesting title Then uses an isolated non-reasoning request and closes its proxy', async () => {
    /** 捕获发送给 Pi 的轻量请求参数。 */
    let receivedOptions: ModelsSimpleStreamOptions | undefined
    /** 捕获隔离上下文中的标题提示词。 */
    let receivedPrompt: string | undefined
    /** 模拟通用 Pi runtime，确保不进入 provider 专用 complete。 */
    const runtime: PiTitleRuntime = {
      async complete() { throw new Error('通用标题应走 completeSimple') },
      async completeSimple(_model, context, options) {
        receivedPrompt = context.messages[0]?.role === 'user' ? context.messages[0].content as string : undefined
        receivedOptions = options
        return { content: [{ type: 'text', text: '统一 Pi 标题' }], stopReason: 'stop' }
      },
    }
    /** 模拟需要在请求结束后释放的代理资源。 */
    const dispatcher = {} as Dispatcher
    /** 记录代理安装与关闭状态。 */
    const environment = createEnvironment(dispatcher)

    await expect(completePiTitleRequest(runtime, model, '生成标题', environment)).resolves.toBe('统一 Pi 标题')
    expect(receivedPrompt).toBe('生成标题')
    expect(receivedOptions).toMatchObject({
      sessionId: expect.stringMatching(/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i),
      transport: 'auto',
      maxTokens: 50,
      timeoutMs: 30_000,
      maxRetries: 0,
    })
    expect(receivedOptions).not.toHaveProperty('reasoning')
    expect(environment.installed).toBe(true)
    expect(environment.closed).toBe(dispatcher)
  })

  test('Given Pi title request failure When completing title Then still closes its proxy', async () => {
    /** 模拟 provider 请求直接失败的 Pi runtime。 */
    const runtime: PiTitleRuntime = {
      async complete() { throw new Error('通用标题应走 completeSimple') },
      async completeSimple() { throw new Error('quota exceeded') },
    }
    /** 模拟失败路径仍需释放的代理资源。 */
    const dispatcher = {} as Dispatcher
    /** 记录异常路径的代理关闭状态。 */
    const environment = createEnvironment(dispatcher)

    await expect(completePiTitleRequest(runtime, model, '生成标题', environment)).rejects.toThrow('quota exceeded')
    expect(environment.closed).toBe(dispatcher)
  })

  test('Given Codex Pi model When requesting title Then explicitly disables reasoning and tools', async () => {
    /** 捕获 Codex provider 专用请求参数。 */
    let receivedOptions: Record<string, unknown> | undefined
    /** 模拟 Codex runtime，禁止测试误走 completeSimple。 */
    const runtime = {
      async complete(_model: Model<Api>, _context: unknown, options?: Record<string, unknown>) {
        receivedOptions = options
        return { content: [{ type: 'text', text: 'Codex 标题' }], stopReason: 'stop' as const }
      },
      async completeSimple() {
        throw new Error('Codex 标题不应走 completeSimple')
      },
    } as unknown as PiTitleRuntime
    /** Codex 无代理测试环境。 */
    const environment = createEnvironment()

    await expect(completePiTitleRequest(runtime, codexModel, '生成标题', environment)).resolves.toBe('Codex 标题')
    expect(receivedOptions).toMatchObject({
      reasoningEffort: 'none',
      textVerbosity: 'low',
      toolChoice: 'none',
    })
  })
})
