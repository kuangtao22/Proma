export const UTILITY_PROCESS_START_RETRY_DELAYS_MS = [25, 100] as const
export const UTILITY_PROCESS_START_CANCELLED_CODE = 'UTILITY_PROCESS_START_CANCELLED'

interface UtilityProcessStartupCancelledError extends Error {
  code: typeof UTILITY_PROCESS_START_CANCELLED_CODE
  cause?: unknown
}

interface UtilityProcessStartupOptions {
  platform?: NodeJS.Platform
  sleep?: (milliseconds: number) => Promise<void>
  shouldContinue?: () => boolean
}

/** 创建带稳定错误码的启动取消错误，供调用方区分真实崩溃。 */
function createUtilityProcessStartupCancelledError(cause?: unknown): UtilityProcessStartupCancelledError {
  /** 对外暴露的启动取消错误。 */
  const error = new Error('Utility process startup cancelled') as UtilityProcessStartupCancelledError
  error.code = UTILITY_PROCESS_START_CANCELLED_CODE
  if (cause !== undefined) error.cause = cause
  return error
}

/** 默认使用定时器等待下一次有限重试。 */
function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

/** 判断 utility process 启动失败是否属于可重试错误。 */
export function isRetryableUtilityProcessStartupError(
  error: unknown,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== 'win32') return false
  if (!error || typeof error !== 'object') return false

  /** Electron 同步启动错误的可检查字段。 */
  const candidate = error as { code?: unknown; message?: unknown }
  return candidate.code === 'ENOTCONN'
    || (typeof candidate.message === 'string' && /\bENOTCONN\b/.test(candidate.message))
}

/**
 * 启动 utility process；仅对 Windows 同步 ENOTCONN 做有限重试，
 * 并在每次尝试前后检查当前启动代次是否仍有效。
 */
export async function startUtilityProcessWithRetry<T>(
  start: () => T,
  options: UtilityProcessStartupOptions = {},
): Promise<T> {
  /** 当前平台，用于把重试严格限制在 Windows。 */
  const platform = options.platform ?? process.platform
  /** 可注入等待函数，便于测试且不增加常驻任务。 */
  const sleep = options.sleep ?? defaultSleep
  /** 调用方提供的启动代次有效性检查。 */
  const shouldContinue = options.shouldContinue ?? (() => true)

  for (let attempt = 0; ; attempt += 1) {
    if (!shouldContinue()) throw createUtilityProcessStartupCancelledError()
    try {
      return start()
    } catch (error) {
      /** 当前失败对应的有限退避时长。 */
      const delay = UTILITY_PROCESS_START_RETRY_DELAYS_MS[attempt]
      if (delay === undefined || !isRetryableUtilityProcessStartupError(error, platform)) throw error
      await sleep(delay)
      if (!shouldContinue()) throw createUtilityProcessStartupCancelledError(error)
    }
  }
}
