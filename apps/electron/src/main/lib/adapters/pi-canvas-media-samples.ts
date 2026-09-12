import type { Agent, AgentMessage } from '@earendil-works/pi-agent-core'
import type { ImageContent, TextContent } from '@earendil-works/pi-ai'

/** 只管理 Canvas 新增的临时抽样工具，普通附件和图片编辑历史不受影响。 */
const INSPECTION_TOOL = 'canvas_inspect_media_content'
/** Base64 预算对应最多约 9 MiB 原始图片；多工具同轮合并共享上限。 */
const MAX_PENDING_CHARACTERS = 12 * 1024 * 1024

/** 一个工具调用的临时样本只供下一轮模型读取，不进入 Pi transcript。 */
interface PendingSamples {
  content: (ImageContent | TextContent)[]
  evidenceId: string
  characters: number
}

/** 读取工具字段时只接受普通对象，避免把用户文字当作 Host 证据。 */
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/** 用可恢复说明代替临时字节；完整检查身份仍保留在原文本与 details。 */
function withoutSamples(content: (ImageContent | TextContent)[]): (ImageContent | TextContent)[] {
  return content.map(block => block.type === 'image'
    ? { type: 'text', text: '[临时媒体样本：仅提供给紧接着的模型评审；后续需要重新观看时再次检查同一素材，不要重复生成。]' }
    : block)
}

/**
 * 将样本与持久消息分开：工具事件及 transcript 仅留摘要，在实际模型上下文按需注入一次。
 * 返回释放函数供会话结束清理；取消、失败、恢复和压缩不会重放过期图片。
 */
export function installCanvasMediaSampleLifecycle(agent: Agent): () => void {
  const pending = new Map<string, PendingSamples>()
  const delivered = new Set<string>()
  let pendingCharacters = 0
  const clearPending = (): void => { pending.clear(); pendingCharacters = 0 }
  const previousAfter = agent.afterToolCall
  const previousBefore = agent.beforeToolCall
  const previousTransform = agent.transformContext

  agent.beforeToolCall = async (context, signal) => {
    const previous = await previousBefore?.(context, signal)
    if (previous?.block || context.toolCall.name !== 'canvas_review_media') return previous
    const evidenceId = record(context.args)?.inspectionEvidenceId
    if (typeof evidenceId !== 'string' || !delivered.has(evidenceId)) return {
      block: true, reason: 'CANVAS_MEDIA_SAMPLES_NOT_DELIVERED: 请先读取样本，待下一轮看到实际画面后再评审；不能同批检查并盲评。',
    }
    return previous
  }

  agent.afterToolCall = async (context, signal) => {
    const previous = await previousAfter?.(context, signal)
    if (context.toolCall.name !== INSPECTION_TOOL) return previous
    const content = previous?.content ?? context.result.content
    const images = content.filter((block): block is ImageContent => block.type === 'image')
    if (images.length === 0) return previous
    if (!agent.state.model?.input.includes('image')) return { ...previous, content: [...withoutSamples(content),
      { type: 'text', text: 'CANVAS_MEDIA_VISION_UNAVAILABLE: 当前模型不支持图片输入，本次只能核对技术信息，不能提交样本内容评审。' }] }
    const details = record(previous?.details ?? context.result.details)
    const evidenceId = details?.inspectionEvidenceId
    if (typeof evidenceId !== 'string' || !/^[a-f0-9]{64}$/.test(evidenceId)) throw new Error('CANVAS_MEDIA_SAMPLE_EVIDENCE_INVALID')
    const characters = images.reduce((total, block) => total + block.data.length, 0)
    if (pendingCharacters + characters > MAX_PENDING_CHARACTERS) {
      throw new Error('CANVAS_MEDIA_SAMPLE_BUDGET: 本轮样本达到上限，请先评审已收到的样本，再单独检查下一素材。')
    }
    pending.set(context.toolCall.id, { content, evidenceId, characters })
    pendingCharacters += characters
    return { ...previous, content: withoutSamples(content) }
  }

  agent.transformContext = async (messages, signal) => {
    const transformed = await previousTransform?.(messages, signal) ?? messages
    /** 只向请求副本注入，不修改 agent.state、会话 JSONL 或压缩输入。 */
    return transformed.map((message): AgentMessage => {
      if (message.role !== 'toolResult' || message.toolName !== INSPECTION_TOOL) return message
      const samples = pending.get(message.toolCallId)
      if (samples) {
        if (delivered.size >= 256) delivered.delete(delivered.values().next().value!)
        delivered.add(samples.evidenceId)
        return { ...message, content: samples.content }
      }
      /** 恢复早期测试历史时同样去掉旧样本，要求重新检查而非重生成。 */
      return message.content.some(block => block.type === 'image') ? { ...message, content: withoutSamples(message.content) } : message
    })
  }
  const unsubscribe = agent.subscribe(event => {
    /** 成功模型响应后释放图片；原生网络重试期间仍可复用这一次样本。 */
    if (event.type === 'message_end' && event.message.role === 'assistant'
      && event.message.stopReason !== 'error' && event.message.stopReason !== 'aborted') clearPending()
    if (event.type === 'agent_end') { clearPending(); delivered.clear() }
  })
  return () => { unsubscribe(); clearPending(); delivered.clear() }
}
