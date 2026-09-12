import type { SDKMessage } from '@proma/shared'

/** 只接受内容块对象；工具参数和其它任意 JSON 不参与图片投影。 */
function isContentRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 把图片内容块转换为轻量展示元数据，保留原始对象供运行与持久化使用。
 * @param block Pi 或旧格式的消息内容块。
 * @returns 无内嵌字节的图片元数据；其它内容保持原引用。
 */
function projectImageBlock(block: unknown): unknown {
  if (!isContentRecord(block) || block.type !== 'image') return block
  /** Pi 将字节放在 data，旧格式将字节放在 source.data。 */
  const source = isContentRecord(block.source) ? block.source : undefined
  const data = typeof block.data === 'string'
    ? block.data
    : typeof source?.data === 'string' ? source.data : undefined
  if (data === undefined) return block
  /** 展示只需要格式与大小；原图仍在原始 JSONL/Pi 会话及既有文件预览入口中。 */
  const mimeType = typeof block.mimeType === 'string'
    ? block.mimeType
    : typeof source?.media_type === 'string' ? source.media_type : undefined
  return {
    type: 'image',
    ...(mimeType ? { mimeType } : {}),
    _promaDeferred: true,
    _originalLength: data.length,
  }
}

/** 仅在内容真正改变时创建数组，普通文本与流式快照保持原引用。 */
function projectContent(content: unknown[]): unknown[] {
  /** 延迟创建副本，避免没有图片的绝大部分消息发生分配。 */
  let projected: unknown[] | undefined
  for (let index = 0; index < content.length; index += 1) {
    /** 只扫描消息内容与 tool_result 内容，不进入 tool_use.input。 */
    const block = content[index]
    let next = projectImageBlock(block)
    if (isContentRecord(block) && block.type === 'tool_result' && Array.isArray(block.content)) {
      /** 嵌套工具结果采用同一规则，保留 imageAttachments 等已验证附件字段。 */
      const nested = projectContent(block.content)
      if (nested !== block.content) next = { ...block, content: nested }
    }
    if (next !== block) {
      projected ??= content.slice()
      projected[index] = next
    }
  }
  return projected ?? content
}

/**
 * 在主进程到界面的边界延迟内嵌图片，不修改原始消息或其持久化语义。
 * @param message 仍归运行时/历史读取方所有的原始 SDK 消息。
 * @returns 只含展示所需内容的消息；无图片时返回原引用。
 */
export function projectSDKMessageForDisplay(message: SDKMessage): SDKMessage {
  if (message.type !== 'user' && message.type !== 'assistant') return message
  /** SDK 联合类型允许扩展消息，先验证实际正文结构再遍历。 */
  const body = message.message
  if (!isContentRecord(body) || !Array.isArray(body.content)) return message
  /** 此投影不得写入原始对象：同一事件还会被 trace、恢复与落盘消费。 */
  const content = projectContent(body.content)
  if (content === body.content) return message
  return { ...message, message: { ...body, content } } as SDKMessage
}
