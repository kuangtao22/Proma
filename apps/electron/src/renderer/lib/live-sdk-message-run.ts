import type { SDKMessage } from '@proma/shared'

export interface LiveSdkMessageRunIdentity {
  startedAt?: number
  runGeneration?: number
}

interface RunScopedSdkMessage extends Record<string, unknown> {
  _promaLiveRunStartedAt?: number
  _promaLiveRunGeneration?: number
}

/** 读取仅存在于实时 EventBus 消息上的运行身份；这些字段不会进入持久化 JSONL。 */
function getRunScopedMessage(message: SDKMessage): RunScopedSdkMessage {
  return message as RunScopedSdkMessage
}

/**
 * 判断实时 SDK 消息是否属于当前运行。
 * 新协议优先使用严格递增的 generation；旧协议仅在缺少 generation 时回退到 startedAt。
 */
export function shouldAcceptLiveSdkMessageForRun(
  message: SDKMessage,
  currentRun: LiveSdkMessageRunIdentity | undefined,
): boolean {
  if (!currentRun) return true

  const scopedMessage = getRunScopedMessage(message)
  if (currentRun.runGeneration != null && scopedMessage._promaLiveRunGeneration != null) {
    return currentRun.runGeneration === scopedMessage._promaLiveRunGeneration
  }
  if (currentRun.startedAt != null && scopedMessage._promaLiveRunStartedAt != null) {
    return currentRun.startedAt === scopedMessage._promaLiveRunStartedAt
  }
  return true
}

/**
 * 为旧 EventBus 协议补齐实时运行身份。
 * 主进程已经携带的身份必须保留，否则迟到消息会被错误改写成当前 run。
 */
export function applyLiveSdkMessageRunIdentity(
  message: SDKMessage,
  currentRun: LiveSdkMessageRunIdentity | undefined,
): void {
  if (!currentRun) return

  const scopedMessage = getRunScopedMessage(message)
  if (scopedMessage._promaLiveRunStartedAt == null && currentRun.startedAt != null) {
    scopedMessage._promaLiveRunStartedAt = currentRun.startedAt
  }
  if (scopedMessage._promaLiveRunGeneration == null && currentRun.runGeneration != null) {
    scopedMessage._promaLiveRunGeneration = currentRun.runGeneration
  }
}
