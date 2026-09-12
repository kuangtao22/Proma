import { expect, test } from 'bun:test'
import { Agent } from '@earendil-works/pi-agent-core'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai'
import { Type } from 'typebox'
import { installCanvasMediaSampleLifecycle } from './pi-canvas-media-samples'

/** 稳定证据和有界样本用于验证真实 Pi 循环，不调用收费模型或媒体服务。 */
const evidenceId = 'a'.repeat(64)
const image = { type: 'image' as const, mimeType: 'image/jpeg', data: 'A'.repeat(1024 * 1024) }

/** 构造两个受管工具，记录实际执行的评审次数。 */
function fixture(sameBatch = false) {
  const provider = fauxProvider()
  const inspectCall = fauxToolCall('canvas_inspect_media_content', {}, { id: 'inspect-1' })
  const reviewCall = fauxToolCall('canvas_review_media', { inspectionEvidenceId: evidenceId }, { id: 'review-1' })
  provider.setResponses(sameBatch ? [
    fauxAssistantMessage([inspectCall, reviewCall], { stopReason: 'toolUse' }),
    fauxAssistantMessage('检查结果'),
  ] : [
    fauxAssistantMessage(inspectCall, { stopReason: 'toolUse' }),
    fauxAssistantMessage(reviewCall, { stopReason: 'toolUse' }),
    fauxAssistantMessage('抽样评审已完成'),
  ])
  let reviews = 0
  const modelImages: number[] = []
  const eventImages: number[] = []
  const tools: AgentTool[] = [
    { name: 'canvas_inspect_media_content', label: '检查', description: '检查', parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: 'text', text: '样本摘要' }, image], details: { inspectionEvidenceId: evidenceId } }) },
    { name: 'canvas_review_media', label: '评审', description: '评审', parameters: Type.Object({ inspectionEvidenceId: Type.String() }),
      execute: async () => { reviews += 1; return { content: [{ type: 'text', text: '样本已评审' }], details: {} } } },
  ]
  const agent = new Agent({ initialState: { model: { ...provider.models[0]!, input: ['text', 'image'] }, tools }, streamFn: (model, context, options) => {
    modelImages.push(context.messages.reduce((count, message) => count + (Array.isArray(message.content)
      ? message.content.filter(block => block.type === 'image').length : 0), 0))
    return provider.provider.streamSimple(model, context, options)
  } })
  const release = installCanvasMediaSampleLifecycle(agent)
  agent.subscribe(event => {
    if (event.type === 'message_end' && event.message.role === 'toolResult') {
      eventImages.push(event.message.content.filter(block => block.type === 'image').length)
    }
  })
  return { agent, release, provider, modelImages, eventImages, getReviews: () => reviews }
}

test('Given 视频抽样 When 真实Pi读取并评审 Then 只有下一次模型上下文含图且持久事件始终无图', async () => {
  const current = fixture()
  try {
    await current.agent.prompt('检查视频样本')
    expect(current.modelImages).toEqual([0, 1, 0])
    expect(current.eventImages).toEqual([0, 0])
    expect(current.getReviews()).toBe(1)
    expect(JSON.stringify(current.agent.state.messages)).not.toContain(image.data)
    expect(JSON.stringify(current.agent.state.messages)).toContain(evidenceId)
  } finally { current.release() }
})

test('Given 同一批检查和盲评 When 模型尚未见到样本 Then 阻止评审而保留下一轮样本', async () => {
  const current = fixture(true)
  try {
    await current.agent.prompt('检查视频')
    expect(current.getReviews()).toBe(0)
    expect(current.modelImages).toEqual([0, 1])
    expect(JSON.stringify(current.agent.state.messages)).toContain('CANVAS_MEDIA_SAMPLES_NOT_DELIVERED')
  } finally { current.release() }
})

test('Given 历史检查已结束 When 新轮从摘要恢复 Then 不重放图片且要求重新读取后再评审', async () => {
  const current = fixture()
  try {
    await current.agent.prompt('第一次检查')
    current.provider.setResponses([
      fauxAssistantMessage(fauxToolCall('canvas_review_media', { inspectionEvidenceId: evidenceId }, { id: 'review-2' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage('需要重新读取样本'),
    ])
    await current.agent.prompt('继续检查')
    expect(current.getReviews()).toBe(1)
    expect(current.modelImages.slice(3)).toEqual([0, 0])
    expect(current.eventImages.every(count => count === 0)).toBe(true)
  } finally { current.release() }
})

test('Given 当前模型不支持图片 When 请求抽样评审 Then 保留技术摘要且禁止内容通过', async () => {
  const current = fixture()
  try {
    current.agent.state.model = { ...current.agent.state.model!, input: ['text'] }
    await current.agent.prompt('检查视频')
    expect(current.getReviews()).toBe(0)
    expect(current.modelImages.every(count => count === 0)).toBe(true)
    expect(JSON.stringify(current.agent.state.messages)).toContain('CANVAS_MEDIA_VISION_UNAVAILABLE')
  } finally { current.release() }
})

test('Given 同批样本超出共享预算 When 多次检查 Then 拒绝额外图片且已接受样本仍只发送一次', async () => {
  const current = fixture()
  try {
    current.agent.state.tools[0]!.execute = async () => ({
      content: [{ ...image, data: 'A'.repeat(7 * 1024 * 1024) }], details: { inspectionEvidenceId: evidenceId },
    })
    current.provider.setResponses([
      fauxAssistantMessage([
        fauxToolCall('canvas_inspect_media_content', {}, { id: 'first' }),
        fauxToolCall('canvas_inspect_media_content', {}, { id: 'second' }),
      ], { stopReason: 'toolUse' }),
      fauxAssistantMessage('先评审第一份'),
    ])
    await current.agent.prompt('检查多份视频')
    expect(current.modelImages).toEqual([0, 1])
    expect(JSON.stringify(current.agent.state.messages)).toContain('CANVAS_MEDIA_SAMPLE_BUDGET')
    expect(JSON.stringify(current.agent.state.messages).length).toBeLessThan(10000)
    expect(current.eventImages).toEqual([0, 0])
  } finally { current.release() }
})
