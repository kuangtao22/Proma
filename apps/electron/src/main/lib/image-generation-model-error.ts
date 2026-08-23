/** Renderer 与任务 journal 可安全展示的生图模型业务错误前缀。 */
const SAFE_IMAGE_MODEL_ERROR_PREFIXES = [
  '生图模型 profiles ',
  '生图模型 profile',
  '生图模型不存在:',
  '生图模型已停用:',
  '生图模型执行器不受支持:',
  '生图模型快照与当前配置不一致:',
  'Nano Banana API Key 未配置:',
  '生图模型目录 JSON 损坏',
  '生图模型目录格式无效',
  '生图模型目录 profiles ',
  '不支持的生图模型目录 schemaVersion:',
  'Design 项目生图模型偏好 JSON 损坏',
  'Design 项目生图模型偏好格式无效',
  'Design 项目生图模型偏好字段',
  'Design 项目生图模型偏好 imageModelProfileId ',
  'Design 项目生图模型偏好 updatedAt ',
  '不支持的 Design 项目生图模型偏好 schemaVersion:',
] as const

/** 判断错误是否是不含主进程路径和凭据的稳定模型业务错误。 */
export function isSafeImageModelBusinessError(error: unknown): error is Error {
  return error instanceof Error
    && SAFE_IMAGE_MODEL_ERROR_PREFIXES.some((prefix) => error.message.startsWith(prefix))
}

/**
 * 执行模型目录操作，并把未知底层错误隔离为稳定公开消息。
 * @param operation 模型目录或偏好操作。
 * @param failureMessage 未知错误对外使用的稳定中文消息。
 * @param logUnexpected 只在主进程记录原始底层诊断的回调。
 * @returns 操作的原始成功结果。
 */
export function runSafeImageModelOperation<Result>(
  operation: () => Result,
  failureMessage: string,
  logUnexpected: (error: unknown) => void,
): Result {
  try {
    return operation()
  } catch (error) {
    if (isSafeImageModelBusinessError(error)) throw error
    logUnexpected(error)
    throw new Error(failureMessage)
  }
}
