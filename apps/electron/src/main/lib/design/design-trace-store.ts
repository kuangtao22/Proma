import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type {
  DesignJobTraceSummary,
  DesignJobRecord,
  DesignTraceEntry,
  SDKAssistantMessage,
  SDKMessage,
  SDKResultMessage,
  SDKToolResultBlock,
  SDKToolUseBlock,
  SDKUserMessage,
} from '@proma/shared'
import { ensureDirectoryDurable, removeFileAtomic, writeJsonLinesFileAtomic } from '../safe-file'
import { isSafeDesignStableId, type DesignPathResolver } from './design-paths'
import { formatDesignExecutionError, summarizeDesignExecutionError } from './design-execution-error'

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

/** Design trace 单页有界读取参数。 */
export interface DesignTracePageOptions {
  cursor?: string
  limit: number
  maxBytes: number
  /** 在计算页预算和 cursor 前把磁盘条目转换为最终公开结构。 */
  transformEntry?: (entry: DesignTraceEntry) => DesignTraceEntry
}

/** Design trace 单页读取结果。 */
export interface DesignTracePage {
  entries: DesignTraceEntry[]
  nextCursor?: string
  truncated: boolean
  omittedEntryCount: number
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
   * @param terminal 已提交的任务终态；SDK 未留下消息时仍保留真实业务结论。
   * @returns 可放入 Job 记录的轻量摘要和 trace 条数。
   */
  writeFromMessages(
    projectId: string,
    jobId: string,
    messages: SDKMessage[],
    terminal?: Pick<DesignJobRecord, 'status' | 'error' | 'completedAt'>,
  ): DesignTraceWriteResult {
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
      if (message.type === 'result' && !message.isSyntheticCompactionResult) {
        /** result 可能是失败回合唯一留下的结构化消息，必须先于会话回收转存。 */
        const result = message as SDKResultMessage
        /** SDKMessage 兼容扩展消息，先收窄为 result 合同再读取错误字段。 */
        const failed = result.subtype !== 'success'
        entries.push({
          timestamp, type: failed ? 'error' : 'status',
          title: failed ? 'Agent 执行失败' : 'Agent 执行完成',
          ...(failed ? { content: formatDesignExecutionError(result.errors, result.subtype) } : {}),
          isError: failed,
        })
        continue
      }
      if (message.type === 'assistant') {
        /** TypedError 可能没有后续 result；只读取 error 字段，不把正文误当失败详情。 */
        const assistant = message as SDKAssistantMessage
        if (assistant.error) {
          entries.push({
            timestamp, type: 'error', title: 'Agent 执行失败', isError: true,
            content: formatDesignExecutionError([assistant.error.message], assistant.error.errorType),
          })
        }
        const content = assistant.message?.content
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

    if (terminal) {
      /** 与 Agent result 分开标记业务结论：Agent 成功结束也可能没有有效图片。 */
      const failed = terminal.status === 'failed'
      entries.push({
        timestamp: terminal.completedAt ?? this.now(),
        type: failed ? 'error' : 'status',
        title: failed ? '设计任务失败' : terminal.status === 'succeeded' ? '设计任务完成'
          : terminal.status === 'cancelled' ? '设计任务已取消' : '设计任务已中断',
        ...(terminal.error ? { content: summarizeDesignExecutionError(terminal.error) } : {}),
        isError: failed,
      })
    }

    /** 当前任务的受信任 trace 路径，兼容尚未创建 traces 子目录的旧项目。 */
    const tracePath = resolveTracePath(this.dependencies.pathResolver, projectId, jobId)
    ensureDirectoryDurable(dirname(tracePath))
    writeJsonLinesFileAtomic(tracePath, entries)
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
   * 从字节游标开始有界读取 trace，避免先加载完整 JSONL 再截断。
   * @param projectId 已登记 Design 项目 ID。
   * @param jobId 当前单次执行 ID。
   * @param options 页大小、响应字节预算与后续游标。
   * @returns 最多 50 条公开 trace、后续字节游标和超大行省略计数。
   */
  readPage(projectId: string, jobId: string, options: DesignTracePageOptions): DesignTracePage {
    const tracePath = resolveTracePath(this.dependencies.pathResolver, projectId, jobId)
    /** 对外页大小始终收敛到合同允许范围。 */
    const limit = Number.isFinite(options.limit)
      ? Math.max(1, Math.min(50, Math.floor(options.limit)))
      : 50
    /** 字节预算限制单页内存；服务层还会校验完整响应大小。 */
    const maxBytes = Number.isFinite(options.maxBytes)
      ? Math.max(256, Math.min(60 * 1024, Math.floor(options.maxBytes)))
      : 60 * 1024
    /** 游标是下一行起始字节偏移，禁止负数、小数或任意字符串。 */
    const startOffset = options.cursor === undefined
      ? 0
      : /^\d+$/.test(options.cursor) ? Number(options.cursor) : Number.NaN
    if (!Number.isSafeInteger(startOffset) || startOffset < 0) {
      throw new Error('Design trace 游标无效')
    }

    let descriptor: number | undefined
    try {
      descriptor = openSync(tracePath, 'r')
      const fileSize = fstatSync(descriptor).size
      if (startOffset > fileSize) throw new Error('trace cursor beyond end')
      if (startOffset > 0) {
        /** 公开游标只能指向换行后的完整记录边界。 */
        const previousByte = Buffer.allocUnsafe(1)
        if (readSync(descriptor, previousByte, 0, 1, startOffset - 1) !== 1 || previousByte[0] !== 0x0a) {
          throw new Error('trace cursor is not at line boundary')
        }
      }
      if (startOffset === fileSize) {
        return { entries: [], truncated: false, omittedEntryCount: 0 }
      }

      /** 固定小块读取，单条异常大日志只扫描而不会进入进程内存结果。 */
      const chunk = Buffer.allocUnsafe(4 * 1024)
      /** 当前行在文件中的起始偏移，用于页满时返回可重放游标。 */
      let lineStart = startOffset
      /** 当前文件读取位置。 */
      let position = startOffset
      /** 未超过预算时暂存当前行片段。 */
      let lineParts: Buffer[] = []
      /** 当前行总字节数，包括已因超限丢弃的片段。 */
      let lineBytes = 0
      /** 当前行是否已超过单页预算。 */
      let skippingOversizedLine = false
      /** 已返回条目的 JSON 字节近似总量。 */
      let returnedBytes = 2
      /** 当前页公开条目。 */
      const entries: DesignTraceEntry[] = []
      /** 因单行过大而省略的条数。 */
      let omittedEntryCount = 0

      /** 完成一行校验并决定返回、延后或省略。 */
      const finishLine = (nextLineStart: number): DesignTracePage | undefined => {
        if (skippingOversizedLine || lineBytes > maxBytes) {
          omittedEntryCount += 1
        } else {
          const line = Buffer.concat(lineParts, lineBytes).toString('utf8')
          if (!line) throw new Error('empty trace line')
          const value: unknown = JSON.parse(line)
          if (!isDesignTraceEntry(value)) throw new Error('invalid trace entry')
          /** 页预算必须基于调用方最终返回的公开条目，避免后置转换破坏 cursor。 */
          const publicEntry = options.transformEntry?.(value) ?? value
          if (!isDesignTraceEntry(publicEntry)) throw new Error('invalid transformed trace entry')
          const entryBytes = Buffer.byteLength(JSON.stringify(publicEntry), 'utf8') + 1
          if (entries.length >= limit || returnedBytes + entryBytes > maxBytes) {
            if (entries.length === 0) {
              /** 单条记录连同 JSON 数组开销超限时跳过，避免游标永远停在同一行。 */
              omittedEntryCount += 1
              lineParts = []
              lineBytes = 0
              skippingOversizedLine = false
              lineStart = nextLineStart
              return undefined
            }
            return {
              entries,
              nextCursor: String(lineStart),
              truncated: true,
              omittedEntryCount,
            }
          }
          entries.push(publicEntry)
          returnedBytes += entryBytes
        }
        lineParts = []
        lineBytes = 0
        skippingOversizedLine = false
        lineStart = nextLineStart
        if (entries.length >= limit && lineStart < fileSize) {
          return {
            entries,
            nextCursor: String(lineStart),
            truncated: true,
            omittedEntryCount,
          }
        }
        return undefined
      }

      while (position < fileSize) {
        const bytesRead = readSync(descriptor, chunk, 0, Math.min(chunk.length, fileSize - position), position)
        if (bytesRead <= 0) break
        /** 当前 chunk 内尚未归入行的起点。 */
        let segmentStart = 0
        for (let index = 0; index < bytesRead; index += 1) {
          if (chunk[index] !== 0x0a) continue
          const segment = chunk.subarray(segmentStart, index)
          lineBytes += segment.length
          if (!skippingOversizedLine && lineBytes <= maxBytes) lineParts.push(Buffer.from(segment))
          else {
            skippingOversizedLine = true
            lineParts = []
          }
          const nextLineStart = position + index + 1
          const page = finishLine(nextLineStart)
          if (page) return page
          segmentStart = index + 1
        }
        const remainder = chunk.subarray(segmentStart, bytesRead)
        lineBytes += remainder.length
        if (!skippingOversizedLine && lineBytes <= maxBytes) lineParts.push(Buffer.from(remainder))
        else {
          skippingOversizedLine = true
          lineParts = []
        }
        position += bytesRead
      }

      /** 兼容没有末尾换行的最后一条合法 JSONL。 */
      if (lineBytes > 0 || skippingOversizedLine) {
        const page = finishLine(fileSize)
        if (page) return page
      }
      return { entries, truncated: false, omittedEntryCount }
    } catch (error) {
      throw new Error('Design trace 文件损坏或不可读', { cause: error })
    } finally {
      if (descriptor !== undefined) closeSync(descriptor)
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
