import { describe, expect, test } from 'bun:test'
import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import {
  CANVAS_MEDIA_REVIEW_TOOL_NAMES,
  createCanvasMediaReviewTools,
  type CanvasMediaReviewToolDependencies,
} from './canvas-media-review-tools'

/** 调用指定工具，模拟 Pi 直接执行并保留真实取消信号。 */
async function executeTool(
  tools: readonly ToolDefinition[],
  name: string,
  input: Record<string, unknown>,
  signal: AbortSignal = new AbortController().signal,
): Promise<AgentToolResult<unknown>> {
  const tool = tools.find((candidate) => candidate.name === name)
  if (!tool) throw new Error(`工具不存在: ${name}`)
  return tool.execute('tool-call-1', input as never, signal as never, undefined as never, undefined as never)
}

/** 创建返回可识别真实回执的最小后端。 */
function createDependencies(): CanvasMediaReviewToolDependencies {
  return {
    inspect: async () => ({
      content: [{ type: 'text', text: 'inspection receipt' }],
      details: { evidenceId: 'a'.repeat(64), coverage: 'sampled' },
    }),
    review: async () => ({
      content: [{ type: 'text', text: 'review receipt' }],
      details: { recorded: true },
    }),
  }
}

describe('Canvas 音视频内容验收工具', () => {
  test('Given 工具已装配 When 读取元数据 Then 明确只读边界与抽样验收限制', () => {
    const tools = createCanvasMediaReviewTools(createDependencies())
    expect(tools.map((tool) => tool.name)).toEqual([...CANVAS_MEDIA_REVIEW_TOOL_NAMES])
    const descriptions = tools.map((tool) => tool.description).join('\n')
    expect(descriptions).toContain('已采用')
    expect(descriptions).toContain('有界抽样')
    expect(descriptions).toContain('完整观看')
    expect(descriptions).toContain('当前只支持 sampled')
    expect(descriptions).toContain('不修改媒体')
  })

  test('Given 合法检查请求 When 后端完成 Then 原样保留回执并传递同一取消信号', async () => {
    const controller = new AbortController()
    const receipt: AgentToolResult<unknown> = {
      content: [{ type: 'text', text: '真实抽样已生成' }],
      details: { evidenceId: 'b'.repeat(64), sampledAtMs: [0, 1_000] },
    }
    let receivedSignal: AbortSignal | undefined
    let receivedInput: unknown
    const tools = createCanvasMediaReviewTools({
      ...createDependencies(),
      inspect: async (input, signal) => {
        receivedInput = input
        receivedSignal = signal
        return receipt
      },
    })

    const result = await executeTool(tools, 'canvas_inspect_media_content', {
      canvasId: 'canvas-1', nodeId: 'video_node.1',
    }, controller.signal)

    expect(result).toBe(receipt)
    expect(receivedInput).toEqual({ canvasId: 'canvas-1', nodeId: 'video_node.1' })
    expect(receivedSignal).toBe(controller.signal)
  })

  test('Given 基于真实样本的评审 When 后端记录 Then 完整传递证据身份与评审范围', async () => {
    const received: unknown[] = []
    const receipt: AgentToolResult<unknown> = {
      content: [{ type: 'text', text: '评审已记录' }],
      details: { revision: 7, accepted: true },
    }
    const tools = createCanvasMediaReviewTools({
      ...createDependencies(),
      review: async (input) => {
        received.push(input)
        return receipt
      },
    })
    const input = {
      canvasId: 'canvas-1', nodeId: 'video-1', inspectionEvidenceId: 'c'.repeat(64),
      verdict: 'failed' as const, coverage: 'sampled' as const, notes: '第 2 个样本存在跳帧。',
    }

    expect(await executeTool(tools, 'canvas_review_media', input)).toBe(receipt)
    expect(received).toEqual([input])
  })

  test('Given 非法 ID、证据或额外字段 When 执行工具 Then 在进入后端前拒绝', async () => {
    let calls = 0
    const dependencies = createDependencies()
    const tools = createCanvasMediaReviewTools({
      inspect: async (...args) => { calls += 1; return dependencies.inspect(...args) },
      review: async (...args) => { calls += 1; return dependencies.review(...args) },
    })
    const validReview = {
      canvasId: 'canvas-1', nodeId: 'video-1', inspectionEvidenceId: 'd'.repeat(64),
      verdict: 'passed', coverage: 'sampled', notes: '抽样内容符合当前验收范围。',
    }

    for (const invalidInput of [
      { canvasId: '../canvas', nodeId: 'video-1' },
      { canvasId: 'canvas-1', nodeId: 'video-1', localPath: '/tmp/video.mp4' },
    ]) {
      await expect(executeTool(tools, 'canvas_inspect_media_content', invalidInput))
        .rejects.toThrow('CANVAS_MEDIA_REVIEW_INPUT_INVALID')
    }
    for (const invalidInput of [
      { ...validReview, inspectionEvidenceId: 'D'.repeat(64) },
      { ...validReview, notes: 'x'.repeat(2_049) },
      { ...validReview, coverage: 'metadata' },
      { ...validReview, assetId: 'asset-1' },
    ]) {
      await expect(executeTool(tools, 'canvas_review_media', invalidInput))
        .rejects.toThrow('CANVAS_MEDIA_REVIEW_INPUT_INVALID')
    }
    expect(calls).toBe(0)
  })

  test('Given 请求 full 覆盖 When 当前后端不支持 Then schema 允许表达并保留后端拒绝', async () => {
    const tools = createCanvasMediaReviewTools({
      ...createDependencies(),
      review: async (input) => {
        expect(input.coverage).toBe('full')
        throw new Error('CANVAS_MEDIA_REVIEW_FULL_UNSUPPORTED')
      },
    })

    await expect(executeTool(tools, 'canvas_review_media', {
      canvasId: 'canvas-1', nodeId: 'video-1', inspectionEvidenceId: 'e'.repeat(64),
      verdict: 'passed', coverage: 'full', notes: '请求完整覆盖。',
    })).rejects.toThrow('CANVAS_MEDIA_REVIEW_FULL_UNSUPPORTED')
  })
})
