import { describe, expect, test } from 'bun:test'
import { streamSimple } from '@earendil-works/pi-ai/api/openai-completions'
import { retryAssistantCall, type Model } from '@earendil-works/pi-ai/compat'
import type { SDKAssistantMessage, SDKResultMessage } from '@proma/shared'
import { convertPiMessage, convertResultMessage } from './pi-message-adapter'

/** 模拟兼容渠道；全部请求由内存 fetch 承接，不访问模型服务。 */
const model: Model<'openai-completions'> = {
  id: 'gpt-6-astra', name: 'Astra', api: 'openai-completions',
  provider: 'proma-offline-test', baseUrl: 'https://fixture.invalid/v1',
  reasoning: true, input: ['text'], contextWindow: 372000, maxTokens: 32000,
  cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
}

/** 构造 SSE choice，允许空文本和不同结束原因。 */
function chunk(text: string, finish: string | null = 'stop'): Record<string, unknown> {
  return { id: 'fixture', choices: [{ index: 0, delta: { content: text }, finish_reason: finish }] }
}

/** 生成独立 usage 帧，覆盖真实网关只在最后发送统计的情况。 */
function usage(raw: Record<string, unknown>): Record<string, unknown> {
  return { choices: [], usage: raw }
}

/** 运行实际 SDK 流解析，再走实际 Proma 转换；返回两层消息便于校验。 */
async function runFixture(chunks: Record<string, unknown>[], signal?: AbortSignal, status = 200) {
  /** 记录传输次数，确保没有因缺 usage 重复付费请求。 */
  let requests = 0
  /** 内存响应替身，校验出站请求仍含用户消息和有效输出预算。 */
  const fakeFetch = (async (_request: unknown, init?: RequestInit): Promise<Response> => {
    requests += 1
    const payload = JSON.parse(String(init?.body)) as Record<string, unknown>
    expect(payload.messages).toBeArrayOfSize(1)
    expect(payload.stream_options).toEqual({ include_usage: true })
    expect(payload.max_completion_tokens ?? payload.max_tokens).toBe(50)
    return new Response(status === 200
      ? chunks.map((entry) => `data: ${JSON.stringify(entry)}\n\n`).join('') + 'data: [DONE]\n\n'
      : JSON.stringify({ error: { message: '503 overloaded', type: 'server_error' } }), {
      status, headers: { 'content-type': status === 200 ? 'text/event-stream' : 'application/json' },
    })
  }) as typeof fetch
  const message = await streamSimple(model, {
    messages: [{ role: 'user', content: '生成简短标题', timestamp: 1 }],
  }, { apiKey: 'offline-key', maxTokens: 50, maxRetries: 0, fetch: fakeFetch, signal }).result()
  expect(requests).toBeLessThanOrEqual(1)
  return {
    message,
    assistant: convertPiMessage(message, 'fixture') as SDKAssistantMessage,
    result: convertResultMessage([message], 'fixture') as SDKResultMessage,
  }
}

describe('Pi 响应完整性（真实 SDK，完全离线）', () => {
  test('Given 正常正文缺 usage When 结束 Then 保留成功回复并标记用量未知', async () => {
    const { message, assistant, result } = await runFixture([chunk('标题')])
    expect(message.stopReason).toBe('stop')
    expect(assistant.message.usage).toBeUndefined()
    expect(assistant.message.usageStatus).toBe('unknown')
    expect(result.subtype).toBe('success')
    expect(result.usage).toBeUndefined()
    expect(result.usageStatus).toBe('unknown')
    expect(result.total_cost_usd).toBeUndefined()
  })

  test.each(['', ' \n\t'])('Given 空白回复 %j When stop Then 返回明确错误而非成功', async (body) => {
    const { message, assistant, result } = await runFixture([chunk(body)])
    expect(message.stopReason).toBe('error')
    expect(message.errorMessage).toContain('Empty assistant response')
    expect(assistant.error?.errorType).toBe('service_error')
    expect(result.subtype).toBe('error_during_execution')
    expect(result.terminal_reason).not.toBe('completed')
  })

  test('Given 网关无需 finish_reason When 空流结束 Then 同样拒绝空成功', async () => {
    const response = await streamSimple({ ...model, compat: { supportsFinishReason: false } }, {
      messages: [{ role: 'user', content: '测试', timestamp: 1 }],
    }, { apiKey: 'offline-key', maxRetries: 0, fetch: (async () => new Response('data: [DONE]\n\n', {
      headers: { 'content-type': 'text/event-stream' },
    })) as unknown as typeof fetch }).result()
    expect(response.stopReason).toBe('error')
  })

  test('Given 真实零计数 When 正常完成 Then 保留已知 0', async () => {
    const { result } = await runFixture([chunk('标题'), usage({ prompt_tokens: 0, completion_tokens: 0 })])
    expect(result.usageStatus).toBe('known')
    expect(result.usage).toMatchObject({ input_tokens: 0, output_tokens: 0 })
  })

  test.each([
    {}, { prompt_tokens: 99 }, { total_tokens: 99 },
    { prompt_tokens: null, completion_tokens: 3 },
    { prompt_tokens: '12', completion_tokens: 3 },
    { prompt_tokens: -1, completion_tokens: 3 },
    { prompt_tokens: 12, completion_tokens: -1 },
    { prompt_tokens: 12, completion_tokens: 3, prompt_tokens_details: { cached_tokens: -1 } },
    { prompt_tokens: 12, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 20 } },
  ])('Given 已有有效 usage When 后续无效快照 %j Then 保留此前用量', async (invalid) => {
    const { message, result } = await runFixture([
      chunk('标题'), usage({ prompt_tokens: 12, completion_tokens: 3 }), usage(invalid),
    ])
    expect(message.usage.input).toBe(12)
    expect(message.usage.output).toBe(3)
    expect(result.usageStatus).toBe('known')
    expect(result.usage).toMatchObject({ input_tokens: 12, output_tokens: 3 })
  })

  test('Given 不完整 usage 且没有此前快照 When 完成 Then 不伪造另一项为零', async () => {
    const { result } = await runFixture([chunk('标题'), usage({ prompt_tokens: 12 })])
    expect(result.usageStatus).toBe('unknown')
    expect(result.usage).toBeUndefined()
  })

  test('Given chunk usage 空对象和有效 choice usage When 解析 Then 使用有效后备统计', async () => {
    const { message } = await runFixture([{
      usage: {}, choices: [{ index: 0, delta: { content: '标题' }, finish_reason: 'stop',
        usage: { prompt_tokens: 12, completion_tokens: 3 } }],
    }])
    expect(message.usage.input).toBe(12)
  })

  test('Given 先后完整 usage 含缓存 When 结束 Then 采用最后快照而非累加或逐字段最大值', async () => {
    const { message } = await runFixture([chunk('标题'),
      usage({ prompt_tokens: 20, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 8 } }),
      usage({ prompt_tokens: 15, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 10, cache_write_tokens: 2 } }),
    ])
    expect(message.usage).toMatchObject({ input: 3, output: 3, cacheRead: 10, cacheWrite: 2, totalTokens: 18 })
  })

  test('Given 只有工具或思考 When 结束 Then 不误判空回复', async () => {
    const tool = await runFixture([{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call-1',
      type: 'function', function: { name: 'read', arguments: '{"path":"test.txt"}' } }] }, finish_reason: 'tool_calls' }] }])
    const thinking = await runFixture([{ choices: [{ index: 0, delta: { reasoning_content: '思考中' }, finish_reason: 'stop' }] }])
    expect(tool.message.stopReason).toBe('toolUse')
    expect(tool.result.subtype).toBe('success')
    expect(thinking.result.subtype).toBe('success')
  })

  test('Given 只有不可见 reasoning 重放签名 When stop Then 不能用元数据冒充有效回复', async () => {
    const { message, result } = await runFixture([{ choices: [{ index: 0,
      delta: { reasoning_details: [{ type: 'reasoning.encrypted', data: 'opaque-signature', id: 'reason-1' }] },
      finish_reason: 'stop' }] }])
    expect(message.stopReason).toBe('error')
    expect(result.subtype).toBe('error_during_execution')
  })

  test('Given token 上限或中断 When 结束 Then 保留终态及已生成内容', async () => {
    const limited = await runFixture([chunk('', 'length')])
    const broken = await runFixture([chunk('部分正文', 'network_error')])
    const missingFinish = await runFixture([])
    const overloaded = await runFixture([], undefined, 503)
    expect(limited.result.subtype).toBe('max_tokens')
    expect(broken.result.subtype).toBe('error_during_execution')
    expect(broken.assistant.message.content).toEqual([{ type: 'text', text: '部分正文' }])
    expect(missingFinish.message.errorMessage).toContain('Stream ended without finish_reason')
    expect(overloaded.message.errorMessage).toContain('overloaded')
    expect(overloaded.result.usage).toBeUndefined()
  })

  test('Given 空回复可重试 When 原生预算为一次 Then 最多两次调用并能恢复', async () => {
    let calls = 0
    const response = await retryAssistantCall(async () => {
      calls += 1
      return (await runFixture([chunk(calls === 1 ? '' : '已恢复')])).message
    }, { enabled: true, maxRetries: 1, baseDelayMs: 0 }, undefined)
    expect(calls).toBe(2)
    expect(response.stopReason).toBe('stop')
    calls = 0
    const exhausted = await retryAssistantCall(async () => {
      calls += 1
      return (await runFixture([chunk('')])).message
    }, { enabled: true, maxRetries: 1, baseDelayMs: 0 }, undefined)
    expect(calls).toBe(2)
    expect(exhausted.stopReason).toBe('error')
  })

  test('Given 已取消 When 请求返回 Then 保持 aborted 且不重试', async () => {
    const controller = new AbortController()
    controller.abort()
    const { message, result } = await runFixture([chunk('')], controller.signal)
    expect(message.stopReason).toBe('aborted')
    expect(result.subtype).not.toBe('success')
    expect(result.terminal_reason).toBe('aborted')
  })

  test('Given 多次调用只有部分 usage When 聚合 Then 已知小计标记 partial 且省略总费用', async () => {
    const known = await runFixture([chunk('第一步'), usage({ prompt_tokens: 12, completion_tokens: 3 })])
    const unknown = await runFixture([chunk('完成')])
    const result = convertResultMessage([known.message, unknown.message], 'fixture') as SDKResultMessage
    expect(result.usageStatus).toBe('partial')
    expect(result.usage).toMatchObject({ input_tokens: 12, output_tokens: 3 })
    expect(result.total_cost_usd).toBeUndefined()
  })
})
