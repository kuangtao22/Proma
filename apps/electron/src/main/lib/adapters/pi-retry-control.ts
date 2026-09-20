import type { RetryAttempt } from '@proma/shared'

/**
 * 前 N 次 Pi native retry 静默处理；0 表示第一次重试就通知 UI。
 *
 * 为什么改为 0：上游过载时每次重试都要重新上传整段上下文并等待 20~40 秒，
 * 静默 5 次会让用户只看到「长时间没有输出」，既不知道 Proma 在做什么，也无法
 * 在此之前停手；从第一次重试起展示「第 N/M 次继续当前回答」后，用户可据此决定
 * 是否取消或换渠道。对用户的影响是重试提示会更早出现，重试成功后的收束逻辑不变。
 */
export const PI_NATIVE_SILENT_RETRY_ATTEMPTS = 0

/**
 * Pi 原生重试策略（单个连续失败段）。
 *
 * 为什么是 3 次：Pi 把 `overloaded` 视为可重试错误，而一次上游过载通常持续数分钟，
 * 多试几次既救不回来，又会把一次失败放大成渠道后台的多条 0 token 请求（每条都重传
 * 当前完整上下文），实测 8 次重试会让一个用户回合在渠道后台变成 9 条连续请求，容易
 * 触发渠道商风控。取 Pi 上游默认值 3 并把退避基数提高到 2 秒后，一次失败最多产生
 * 4 次请求、失败窗口从约 8 分钟压到约 1 分钟；代价是需要 20 秒以上才恢复的过载会更早
 * 失败并提示用户手动重试。退避由 Pi 按 `baseDelayMs * 2 ** (attempt - 1)` 计算，
 * 即 2 秒、4 秒、8 秒。
 */
export const PI_NATIVE_RETRY_POLICY = {
  enabled: true,
  maxRetries: 3,
  baseDelayMs: 2_000,
} as const

/** 将 Pi native retry 与当前 renderer stream 绑定，拒绝迟到事件污染下一轮。 */
export interface PiRetryEventContext {
  runStartedAt: number
}

interface PiRetryMetadata {
  attempt: number
  maxAttempts: number
  totalAttempt: number
  maxTotalAttempts: number
  runStartedAt: number
}

export type PiRetryUpdate =
  | ({ status: 'starting'; delaySeconds: number; reason: string; scheduledAt: number } & PiRetryMetadata)
  | ({ status: 'attempt'; attemptData: RetryAttempt } & PiRetryMetadata)
  | ({ status: 'cleared' } & PiRetryMetadata)
  | ({ status: 'failed'; attemptData: RetryAttempt } & PiRetryMetadata)
  | ({ status: 'cancelled'; reason: string } & PiRetryMetadata)

type PiNativeRetryDetails = {
  attempt: number
  maxAttempts?: number
  delayMs?: number
  errorMessage?: string
}

type PiNativeRetryEvent =
  | ({ type: 'auto_retry_start' } & PiNativeRetryDetails)
  | ({ type: 'auto_retry_end'; success: boolean; finalError?: string } & PiNativeRetryDetails)

/**
 * Pi native retry 的终态事件门控。
 *
 * Pi 在判定可重试时会先结束一次失败的 agent loop，再在同一 transcript 上 continue。
 * 在确认 `willRetry` 前，调用方不能把 error 或 result 当作最终状态交给外层编排器。
 */
export function createPiRetryTerminalGate<T>(): {
  defer: (error: T) => void
  peek: () => T | undefined
  settle: (willRetry: boolean) => T | undefined
} {
  let pendingError: T | undefined

  return {
    defer(error) {
      pendingError = error
    },
    peek() {
      return pendingError
    },
    settle(willRetry) {
      const terminalError = willRetry ? undefined : pendingError
      pendingError = undefined
      return terminalError
    },
  }
}

function retryMetadata(event: PiNativeRetryDetails, context: PiRetryEventContext): PiRetryMetadata {
  return {
    attempt: event.attempt,
    maxAttempts: event.maxAttempts ?? event.attempt,
    totalAttempt: event.attempt,
    maxTotalAttempts: event.maxAttempts ?? event.attempt,
    runStartedAt: context.runStartedAt,
  }
}

function retryAttempt(event: PiNativeRetryDetails, timestamp: number, errorMessage: string): RetryAttempt {
  return {
    attempt: event.attempt,
    totalAttempt: event.attempt,
    maxTotalAttempts: event.maxAttempts ?? event.attempt,
    timestamp,
    reason: errorMessage,
    errorMessage,
    // 这里记录的是本次 retry 实际开始前已经等待的退避时间。
    delaySeconds: (event.delayMs ?? 0) / 1_000,
  }
}

/** Pi 只暴露连续失败段的 attempt；按静默次数门控后决定是否向 UI 展示重试生命周期。 */
function shouldExposePiRetry(event: PiNativeRetryDetails): boolean {
  return event.attempt > PI_NATIVE_SILENT_RETRY_ATTEMPTS
}

/**
 * 将 Pi native retry 生命周期转换为 Proma UI 已识别的 retry 事件。
 * 静默次数内的生命周期会被过滤；若最终未恢复，终态 assistant error 仍会正常展示。
 */
export function mapPiNativeRetryEvent(
  event: PiNativeRetryEvent,
  context: PiRetryEventContext,
  timestamp = Date.now(),
): PiRetryUpdate[] {
  if (!shouldExposePiRetry(event)) return []

  const metadata = retryMetadata(event, context)

  if (event.type === 'auto_retry_start') {
    return [{
      status: 'starting',
      ...metadata,
      scheduledAt: timestamp,
      delaySeconds: (event.delayMs ?? 0) / 1_000,
      reason: event.errorMessage ?? '未知错误',
    }]
  }

  if (event.type === 'auto_retry_end' && event.success) {
    return [{ status: 'cleared', ...metadata }]
  }

  const error = event.type === 'auto_retry_end' ? event.finalError ?? '未知错误' : 'Retry cancelled'
  return [{
    status: 'failed',
    ...metadata,
    attemptData: retryAttempt(event, timestamp, error),
  }]
}
