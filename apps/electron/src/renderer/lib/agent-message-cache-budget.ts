import type { SDKMessage } from '@proma/shared'

/** 单个 JavaScript 字符的 UTF-16 近似字节数。 */
const UTF16_BYTES_PER_CHAR = 2
/** 估算对象、数组和属性引用的保守固定开销。 */
const OBJECT_OVERHEAD_BYTES = 32
const ARRAY_OVERHEAD_BYTES = 24
const PROPERTY_REFERENCE_BYTES = 8
/** 只扫描消息传输结构的有限层数，避免缓存写入递归遍历任意历史对象图。 */
const MAX_ESTIMATE_DEPTH = 7

/** SDK 消息对象身份到近似字节数的弱引用缓存，不延长消息生命周期。 */
const messageWeightCache = new WeakMap<object, number>()

/** 缓存上限参数，供生产默认值和小预算单元测试共用。 */
export interface SDKMessageCacheLimits {
  maxEntries: number
  maxEstimatedBytes: number
}

/** 判断未知值是否可按普通 Record 读取。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 判断消息是否仍可能在流式过程中原地变化，变化中的消息不复用估算缓存。 */
function isMutablePartialMessage(message: SDKMessage): boolean {
  return isRecord(message) && message._partial === true
}

/**
 * 估算一个传输值的内存占用。
 *
 * 入参为任意 SDK 消息字段，返回值是 UTF-16 字符与有限容器开销的近似字节数。
 */
function estimateValueBytes(value: unknown, depth: number, seen: WeakSet<object>): number {
  if (typeof value === 'string') return value.length * UTF16_BYTES_PER_CHAR
  if (typeof value === 'number') return 8
  if (typeof value === 'boolean') return 4
  if (value == null || typeof value !== 'object') return 0
  if (seen.has(value)) return PROPERTY_REFERENCE_BYTES
  seen.add(value)

  if (depth >= MAX_ESTIMATE_DEPTH) return OBJECT_OVERHEAD_BYTES
  if (Array.isArray(value)) {
    /** 数组元素仍受最大深度约束，避免未知嵌套触发完整历史遍历。 */
    let bytes = ARRAY_OVERHEAD_BYTES
    for (const item of value) bytes += PROPERTY_REFERENCE_BYTES + estimateValueBytes(item, depth + 1, seen)
    return bytes
  }

  /** 只忽略 Renderer 注入的运行时标记，避免稳定 key 的后续写入污染缓存权重。 */
  let bytes = OBJECT_OVERHEAD_BYTES
  for (const [key, item] of Object.entries(value)) {
    if (key.startsWith('_proma')) continue
    bytes += key.length * UTF16_BYTES_PER_CHAR + PROPERTY_REFERENCE_BYTES
    bytes += estimateValueBytes(item, depth + 1, seen)
  }
  return bytes
}

/**
 * 估算一条 SDKMessage 在 Renderer 缓存中的近似字节数。
 *
 * 入参为 SDK 消息，返回值复用同一稳定对象的先前估算，不序列化完整消息。
 */
export function estimateSDKMessageCacheBytes(message: SDKMessage): number {
  if (!isMutablePartialMessage(message)) {
    const cached = messageWeightCache.get(message)
    if (cached !== undefined) return cached
  }

  /** 每条消息独立的已访问集合，避免共享嵌套对象被重复计入或循环引用失控。 */
  const bytes = estimateValueBytes(message, 0, new WeakSet<object>())
  if (!isMutablePartialMessage(message)) messageWeightCache.set(message, bytes)
  return bytes
}

/**
 * 聚合缓存 Map 的近似字节数。
 *
 * 入参为完整 LRU Map，返回值将共享消息对象的正文只计算一次，但保留每个会话数组的引用开销。
 */
function estimateSDKMessageCacheMapBytes(cache: Map<string, SDKMessage[]>): number {
  /** 同一消息可同时出现在多个短暂视图数组中，正文只按对象身份计量一次。 */
  const seenMessages = new WeakSet<object>()
  let bytes = 0
  for (const messages of cache.values()) {
    bytes += ARRAY_OVERHEAD_BYTES
    for (const message of messages) {
      bytes += PROPERTY_REFERENCE_BYTES
      if (seenMessages.has(message)) continue
      seenMessages.add(message)
      bytes += estimateSDKMessageCacheBytes(message)
    }
  }
  return bytes
}

/**
 * 写入会话历史缓存并同时执行消息数量和估算字节预算的 LRU 淘汰。
 *
 * 入参为旧缓存、目标会话、目标消息与上限；返回新的不可变缓存 Map。
 */
export function setBoundedSDKMessageCache(
  previous: Map<string, SDKMessage[]>,
  sessionId: string,
  messages: SDKMessage[],
  limits: SDKMessageCacheLimits,
): Map<string, SDKMessage[]> {
  /** 移除同会话旧条目后再计量，防止重载时把旧消息权重重复累计。 */
  const next = new Map(previous)
  next.delete(sessionId)
  const incomingBytes = estimateSDKMessageCacheMapBytes(new Map([[sessionId, messages]]))

  /** 单个会话超预算时不进入全局 LRU，但调用方仍可保持自己的当前视图状态。 */
  if (incomingBytes > limits.maxEstimatedBytes) return next

  /** 已存在会话被重新 set 到尾部，保留当前 LRU 的最近访问语义。 */
  next.set(sessionId, messages)
  let totalBytes = estimateSDKMessageCacheMapBytes(next)

  while (next.size > limits.maxEntries || totalBytes > limits.maxEstimatedBytes) {
    const oldestSessionId = next.keys().next().value
    if (oldestSessionId === undefined) break
    next.delete(oldestSessionId)
    totalBytes = estimateSDKMessageCacheMapBytes(next)
  }

  return next
}
