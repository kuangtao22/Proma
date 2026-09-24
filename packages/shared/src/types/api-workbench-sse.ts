/** 单个 SSE 帧的字符上限，防止一个畸形帧占满进程内存。 */
export const API_SSE_MAX_EVENT_CHARS = 16 * 1024
/** 没有显式配置时使用的每帧上限。 */
const DEFAULT_MAX_EVENT_CHARS = API_SSE_MAX_EVENT_CHARS

/** 已切分但尚未编号的 SSE 帧；字段语义与规范一致。 */
export interface ApiSseFrame {
  /** event 字段；未声明时为空串。 */
  event: string
  /** id 字段；未声明时为空串。 */
  id: string
  /** 以冒号开头的注释行内容，用于观察心跳。 */
  comment: string
  /** 多行 data 用换行连接后的文本。 */
  data: string
  /** retry 字段的毫秒数；非法或缺失时为 undefined。 */
  retry?: number
  /** 原始帧文本，便于核对服务端实际发送内容。 */
  raw: string
  /** 该帧是否因超长被截断，或被流式结束提前中断。 */
  truncated: boolean
}

/** 增量读取器：跨 chunk 保存未完成帧，并在结束时交出残余。 */
export interface ApiSseReader {
  /** 送入新解码文本，返回本次切出的完整帧。 */
  push: (text: string) => ApiSseFrame[]
  /** 流结束时交出尚未闭合的残余帧；没有残余时返回 null。 */
  flush: () => ApiSseFrame | null
}

/** 单帧上限的可选配置。 */
export interface ApiSseReaderOptions {
  maxEventChars?: number
}

/**
 * 找到缓冲区里第一个空行的位置。
 * @param buffer 当前待解析文本。
 * @returns 帧文本结束位置与下一帧起点；尚无空行时返回 null。
 */
function findFrameEnd(buffer: string): { frameEnd: number; resumeAt: number } | null {
  let index = 0
  while (index < buffer.length) {
    const lineStart = index
    let cursor = index
    while (cursor < buffer.length && buffer[cursor] !== '\n' && buffer[cursor] !== '\r') cursor += 1
    if (cursor >= buffer.length) return null
    const isEmptyLine = cursor === lineStart
    const terminatorLength = buffer[cursor] === '\r' && buffer[cursor + 1] === '\n' ? 2 : 1
    index = cursor + terminatorLength
    if (isEmptyLine) return { frameEnd: lineStart, resumeAt: index }
  }
  return null
}

/**
 * 把一段帧文本解析为字段。
 * @param raw 原始帧文本，最后可能带换行。
 * @param truncated 是否已因上限或流结束被截断。
 * @returns 已归一化的帧事实。
 */
function parseFrame(raw: string, truncated: boolean): ApiSseFrame {
  const dataLines: string[] = []
  const commentLines: string[] = []
  let event = ''
  let id = ''
  let retry: number | undefined

  for (const line of raw.split(/\r\n|\r|\n/)) {
    if (line === '') continue
    if (line.startsWith(':')) {
      commentLines.push(line.slice(1).replace(/^ /, ''))
      continue
    }
    const separator = line.indexOf(':')
    const field = separator < 0 ? line : line.slice(0, separator)
    const rawValue = separator < 0 ? '' : line.slice(separator + 1)
    const value = rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue
    if (field === 'data') dataLines.push(value)
    else if (field === 'event') event = value
    else if (field === 'id') id = value
    else if (field === 'retry') {
      const milliseconds = Number(value)
      if (Number.isSafeInteger(milliseconds) && milliseconds >= 0) retry = milliseconds
    }
  }

  return {
    event,
    id,
    comment: commentLines.join('\n'),
    data: dataLines.join('\n'),
    ...(retry === undefined ? {} : { retry }),
    raw,
    truncated,
  }
}

/**
 * 创建 SSE 增量读取器。
 * @param options 单帧上限；超出上限的帧会被截断并跳过剩余部分。
 * @returns 可跨 chunk 复用的读取器。
 */
export function createApiSseReader(options: ApiSseReaderOptions = {}): ApiSseReader {
  /** 调用方可以收紧上限，但不能超过硬上限；过小值由调用方自行承担截断后果。 */
  const maxEventChars = Math.min(API_SSE_MAX_EVENT_CHARS, Math.max(1, Math.trunc(options.maxEventChars ?? DEFAULT_MAX_EVENT_CHARS)))
  let pending = ''
  /** 超长帧截断后，丢弃内容直到下一个空行。 */
  let discarding = false

  /** 裁剪剩余缓冲区，避免丢弃模式无限增长。 */
  const dropUntilFrameEnd = (): void => {
    const boundary = findFrameEnd(pending)
    if (!boundary) {
      pending = ''
      return
    }
    pending = pending.slice(boundary.resumeAt)
    discarding = false
  }

  return {
    push: (text: string): ApiSseFrame[] => {
      pending += text
      const frames: ApiSseFrame[] = []
      for (;;) {
        if (discarding) {
          dropUntilFrameEnd()
          if (discarding) return frames
        }
        const boundary = findFrameEnd(pending)
        if (boundary) {
          const frameText = pending.slice(0, boundary.frameEnd)
          /** 完整但超长的帧同样必须按上限截断，不能把畸形帧整段留在内存里。 */
          frames.push(frameText.length > maxEventChars
            ? parseFrame(frameText.slice(0, maxEventChars), true)
            : parseFrame(frameText, false))
          pending = pending.slice(boundary.resumeAt)
          continue
        }
        if (pending.length > maxEventChars) {
          frames.push(parseFrame(pending.slice(0, maxEventChars), true))
          pending = pending.slice(maxEventChars)
          discarding = true
          continue
        }
        return frames
      }
    },
    flush: (): ApiSseFrame | null => {
      const leftover = pending
      pending = ''
      discarding = false
      return leftover === '' ? null : parseFrame(leftover, true)
    },
  }
}
