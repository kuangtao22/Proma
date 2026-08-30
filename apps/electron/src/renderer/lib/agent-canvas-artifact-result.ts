/** Agent 创建成功后，Renderer 导航所需的最小公开结果。 */
export interface CanvasArtifactToolResult {
  canvasId: string
  nodeId: string
  revision: number
  artifactType: 'webview' | 'image'
}

/** 工具结果当前允许携带的字段；sourceToolCallId 只用于主进程审计，不进入 Renderer 状态。 */
const ALLOWED_RESULT_FIELDS = new Set([
  'canvasId',
  'nodeId',
  'revision',
  'artifactType',
  'sourceToolCallId',
])

/** 判断 JSON 值是否为可检查的普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 校验 Canvas 与节点使用的短身份字段。 */
function isValidIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128
}

/** 从 Pi 的字符串或纯文本块数组中读取实际 JSON 对象。 */
function parseToolResultValue(value: string): unknown {
  let parsed: unknown
  try {
    parsed = JSON.parse(value) as unknown
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return parsed
  if (parsed.length === 0 || !parsed.every((block) => (
    isRecord(block)
    && block.type === 'text'
    && typeof block.text === 'string'
  ))) return null
  const text = parsed.map((block) => (block as { text: string }).text).join('')
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

/**
 * 严格解析 canvas_create_artifact 的成功文本结果。
 * @param value Pi tool_result 的原始文本内容。
 * @returns 仅含导航公开字段的结果；损坏或越权形态返回 null。
 */
export function parseCanvasArtifactToolResult(value: string): CanvasArtifactToolResult | null {
  const parsed = parseToolResultValue(value)
  if (!isRecord(parsed) || !Object.keys(parsed).every((key) => ALLOWED_RESULT_FIELDS.has(key))) return null
  if (!isValidIdentity(parsed.canvasId) || !isValidIdentity(parsed.nodeId)) return null
  if (!Number.isInteger(parsed.revision) || typeof parsed.revision !== 'number' || parsed.revision < 0) return null
  if (parsed.artifactType !== 'webview' && parsed.artifactType !== 'image') return null
  if (parsed.sourceToolCallId !== undefined && !isValidIdentity(parsed.sourceToolCallId)) return null
  return {
    canvasId: parsed.canvasId,
    nodeId: parsed.nodeId,
    revision: parsed.revision,
    artifactType: parsed.artifactType,
  }
}
