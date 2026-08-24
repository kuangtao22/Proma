import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  DesignJobTraceSummary,
  DesignTraceEntry,
  SDKAssistantMessage,
  SDKMessage,
  SDKToolResultBlock,
  SDKToolUseBlock,
  SDKUserMessage,
} from '@proma/shared'
import { removeFileAtomic, writeJsonLinesFileAtomic } from '../safe-file'
import { isSafeDesignStableId, type DesignPathResolver } from './design-paths'

/** Design 内部 Agent 当前唯一可信的图片工具入口。 */
const DESIGN_IMAGE_TOOL = 'mcp__nano_banana__generate_image'
/** trace 允许持久化的事件类型，用于严格读取损坏检测。 */
const TRACE_ENTRY_TYPES = new Set<DesignTraceEntry['type']>([
  'thinking', 'context', 'tool', 'image', 'validation', 'status', 'error',
])

/** 写入 trace 后返回给 Job 列表的轻量事实摘要。 */
export interface DesignTraceWriteResult {
  summary: DesignJobTraceSummary
  entryCount: number
}

/** Design trace store 依赖，只接受可信项目路径解析器。 */
export interface DesignTraceStoreDependencies {
  /** 根据项目 ID 解析 Design cache 路径。 */
  pathResolver: Pick<DesignPathResolver, 'resolve'>
  /** 返回事件缺少原始时间戳时使用的当前时间。 */
  now?: () => number
}

/** 判断未知值是否为普通键值对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 判断字符串是否包含可展示内容，同时保留原始空白和措辞。 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/** 从 SDK 消息解析稳定时间戳，缺失或非法时使用注入时钟。 */
function resolveTimestamp(message: SDKMessage, now: () => number): number {
  if ('timestamp' in message && typeof message.timestamp === 'string') {
    /** ISO 时间只在能解析为有限数字时采用。 */
    const parsed = Date.parse(message.timestamp)
    if (Number.isFinite(parsed)) return parsed
  }
  return now()
}

/** 严格校验单条公开 trace，损坏或未知字段一律拒绝。 */
function isDesignTraceEntry(value: unknown): value is DesignTraceEntry {
  if (!isRecord(value)) return false
  /** JSONL 只允许共享公开合同中的字段，避免旧/伪造详情穿透。 */
  const keys = Object.keys(value)
  if (keys.some((key) => !['timestamp', 'type', 'title', 'content', 'toolName', 'isError'].includes(key))) {
    return false
  }
  return typeof value.timestamp === 'number'
    && Number.isFinite(value.timestamp)
    && typeof value.type === 'string'
    && TRACE_ENTRY_TYPES.has(value.type as DesignTraceEntry['type'])
    && typeof value.title === 'string'
    && (value.content === undefined || typeof value.content === 'string')
    && (value.toolName === undefined || typeof value.toolName === 'string')
    && (value.isError === undefined || typeof value.isError === 'boolean')
}

/** 根据受信任项目路径和安全 job ID 构造 trace 文件路径。 */
function resolveTracePath(
  pathResolver: Pick<DesignPathResolver, 'resolve'>,
  projectId: string,
  jobId: string,
): string {
  if (!isSafeDesignStableId(jobId)) throw new Error(`Design Job ID 非法: ${jobId}`)
  return join(pathResolver.resolve(projectId).tracesDir, `${jobId}.jsonl`)
}

/**
 * 保存内部 Pi Agent 的最小可审计事实，并按需读取公开 trace。
 * 未知工具详情、结果正文、附件路径和二进制不会进入持久化文件。
 */
export class DesignTraceStore {
  /** 缺少消息时间戳时使用的时钟。 */
  private readonly now: () => number

  constructor(private readonly dependencies: DesignTraceStoreDependencies) {
    this.now = dependencies.now ?? Date.now
  }

  /**
   * 从真实 SDK 消息提取 Thinking、工具名和图片工具白名单输入。
   * @param projectId 已登记 Design 项目 ID。
   * @param jobId 当前单次执行 ID。
   * @param messages 当前内部会话的持久化 SDK 消息。
   * @returns 可放入 Job 记录的轻量摘要和 trace 条数。
   */
  writeFromMessages(projectId: string, jobId: string, messages: SDKMessage[]): DesignTraceWriteResult {
    /** 仅包含公开白名单字段的 trace 记录。 */
    const entries: DesignTraceEntry[] = []
    /** 用于把 user/tool_result 与此前真实 tool_use 精确关联。 */
    const toolNames = new Map<string, string>()
    /** 最终图片工具参数来自实际 tool_use 输入，不从自然语言推断。 */
    let finalImagePrompt: string | undefined
    /** 设计摘要同样只接受实际图片工具白名单字段。 */
    let designSummary: string | undefined
    /** 是否观察到模型真实返回的 Thinking 块。 */
    let rawThinkingAvailable = false

    for (const message of messages) {
      const timestamp = resolveTimestamp(message, this.now)
      if (message.type === 'assistant') {
        const content = (message as SDKAssistantMessage).message?.content
        if (!Array.isArray(content)) continue
        for (const block of content) {
          if (block.type === 'thinking') {
            const thinking = (block as { thinking?: unknown }).thinking
            if (!isNonEmptyString(thinking)) continue
            rawThinkingAvailable = true
            entries.push({ timestamp, type: 'thinking', title: '模型原始 Thinking', content: thinking })
            continue
          }
          if (block.type !== 'tool_use') continue
          const toolUse = block as SDKToolUseBlock
          toolNames.set(toolUse.id, toolUse.name)
          entries.push({ timestamp, type: 'tool', title: '调用工具', toolName: toolUse.name })
          if (toolUse.name !== DESIGN_IMAGE_TOOL || !isRecord(toolUse.input)) continue
          if (isNonEmptyString(toolUse.input.prompt)) finalImagePrompt = toolUse.input.prompt
          if (isNonEmptyString(toolUse.input.designSummary)) designSummary = toolUse.input.designSummary
        }
        continue
      }
      if (message.type !== 'user') continue
      const content = (message as SDKUserMessage).message?.content
      if (!Array.isArray(content)) continue
      for (const block of content) {
        if (block.type !== 'tool_result') continue
        const result = block as SDKToolResultBlock
        const toolName = toolNames.get(result.tool_use_id)
        if (!toolName) continue
        entries.push({
          timestamp,
          type: toolName === DESIGN_IMAGE_TOOL ? 'image' : 'tool',
          title: result.is_error === true ? '工具执行失败' : '工具执行完成',
          toolName,
          isError: result.is_error === true,
        })
      }
    }

    writeJsonLinesFileAtomic(
      resolveTracePath(this.dependencies.pathResolver, projectId, jobId),
      entries,
    )
    return {
      summary: { designSummary, finalImagePrompt, rawThinkingAvailable },
      entryCount: entries.length,
    }
  }

  /**
   * 严格读取一份完整 trace；任一行损坏都不返回部分事实。
   * @param projectId 已登记 Design 项目 ID。
   * @param jobId 当前单次执行 ID。
   * @returns 完整且逐条通过共享合同校验的 trace。
   */
  read(projectId: string, jobId: string): DesignTraceEntry[] {
    const tracePath = resolveTracePath(this.dependencies.pathResolver, projectId, jobId)
    try {
      const content = readFileSync(tracePath, 'utf8')
      /** JSONL 允许末尾换行，但不允许中间空行掩盖损坏。 */
      const lines = content.endsWith('\n') ? content.slice(0, -1).split('\n') : content.split('\n')
      if (lines.length === 1 && lines[0] === '') return []
      return lines.map((line) => {
        if (!line) throw new Error('empty trace line')
        const value: unknown = JSON.parse(line)
        if (!isDesignTraceEntry(value)) throw new Error('invalid trace entry')
        return value
      })
    } catch (error) {
      throw new Error('Design trace 文件损坏或不可读', { cause: error })
    }
  }

  /**
   * 判断主 trace 是否完整可读；临时文件永不构成 ready 事实。
   * @param projectId 已登记 Design 项目 ID。
   * @param jobId 当前单次执行 ID。
   * @returns 主文件存在且严格读取成功时返回 true。
   */
  isReadable(projectId: string, jobId: string): boolean {
    const tracePath = resolveTracePath(this.dependencies.pathResolver, projectId, jobId)
    if (!existsSync(tracePath)) return false
    try {
      this.read(projectId, jobId)
      return true
    } catch {
      return false
    }
  }

  /**
   * 幂等删除指定单次执行 trace。
   * @param projectId 已登记 Design 项目 ID。
   * @param jobId 当前单次执行 ID。
   */
  delete(projectId: string, jobId: string): void {
    removeFileAtomic(resolveTracePath(this.dependencies.pathResolver, projectId, jobId))
  }
}
