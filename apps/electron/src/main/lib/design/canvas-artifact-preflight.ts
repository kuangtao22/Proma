/** 创建事务开始前可由权威图和纯输入证明的稳定拒绝码。 */
export type CanvasArtifactPreflightErrorCode =
  | 'CANVAS_ARTIFACT_ADOPTED_ASSET_UNEXPECTED'
  | 'CANVAS_ARTIFACT_RELATION_REQUIRED'
  | 'CANVAS_ARTIFACT_RELATION_UNEXPECTED'
  | 'CANVAS_ARTIFACT_SOURCE_NODE_NOT_FOUND'
  | 'CANVAS_BATCH_OPERATION_ENVELOPE_INVALID'
  | 'CANVAS_MUTATION_INVALID'
  | 'CANVAS_REVISION_CONFLICT'

/** 仅表示创建事务尚未开始时已经确定的输入拒绝。 */
export class CanvasArtifactPreflightError extends Error {
  /** 保留既有稳定错误码，供上层完成确定失败回执。 */
  readonly code: CanvasArtifactPreflightErrorCode

  /**
   * 创建可辨识的事务前拒绝。
   * @param code 已有稳定错误码。
   * @param cause 产生该错误码的原始校验异常。
   */
  constructor(code: CanvasArtifactPreflightErrorCode, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause })
    this.name = 'CanvasArtifactPreflightError'
    this.code = code
  }
}

/** 可安全提升为事务前拒绝的精确错误码集合。 */
const CANVAS_ARTIFACT_PREFLIGHT_ERROR_CODES = new Set<CanvasArtifactPreflightErrorCode>([
  'CANVAS_ARTIFACT_ADOPTED_ASSET_UNEXPECTED',
  'CANVAS_ARTIFACT_RELATION_REQUIRED',
  'CANVAS_ARTIFACT_RELATION_UNEXPECTED',
  'CANVAS_ARTIFACT_SOURCE_NODE_NOT_FOUND',
  'CANVAS_BATCH_OPERATION_ENVELOPE_INVALID',
  'CANVAS_MUTATION_INVALID',
  'CANVAS_REVISION_CONFLICT',
])

/** 从 exact 或“稳定码: 诊断”消息中提取 allowlist 错误码。 */
function extractCanvasArtifactPreflightErrorCode(message: string): CanvasArtifactPreflightErrorCode | null {
  for (const code of CANVAS_ARTIFACT_PREFLIGHT_ERROR_CODES) {
    if (message === code || message.startsWith(`${code}:`)) return code
  }
  return null
}

/** 把纯预检产生的已知错误码提升为专用类型，未知错误保持原样。 */
export function throwCanvasArtifactPreflightError(error: unknown): never {
  if (error instanceof CanvasArtifactPreflightError) throw error
  if (error instanceof Error) {
    /** Store 可附带 expected/current 等诊断，公开分类只保留稳定码。 */
    const code = extractCanvasArtifactPreflightErrorCode(error.message)
    if (code) throw new CanvasArtifactPreflightError(code, error)
  }
  throw error
}
