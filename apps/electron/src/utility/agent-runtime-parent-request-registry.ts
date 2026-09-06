import {
  AGENT_RUNTIME_METHODS,
  createAgentRuntimeRequest,
  type AgentRuntimeRequest,
} from '@proma/shared'

/**
 * 基于原始能力请求创建精确取消消息，避免迟到取消读取到新运行代次。
 */
export function createCapabilityCancelRequest(
  request: AgentRuntimeRequest,
): AgentRuntimeRequest<{ requestId: string }> {
  return createAgentRuntimeRequest(
    AGENT_RUNTIME_METHODS.CAPABILITY_CANCEL,
    { requestId: request.requestId },
    { sessionId: request.sessionId, queryId: request.queryId },
    request.bootId,
  )
}

/** 单个 utility -> main 请求的生命周期输入。 */
export interface ParentRequestWaitOptions {
  /** 跨进程请求唯一标识。 */
  requestId: string
  /** 用于稳定错误信息的协议方法名。 */
  method: string
  /** 基础设施故障截止时间；省略表示由运行生命周期终结。 */
  timeoutMs?: number
  /** 工具运行取消信号。 */
  signal?: AbortSignal
  /** 发送原始请求。 */
  sendRequest: () => void
  /** 通知主进程取消对应能力请求。 */
  sendCancel: () => void
}

/** 注册器内部保存的请求完成函数。 */
interface PendingParentRequest {
  /** 完成请求。 */
  resolve: (value: unknown) => void
  /** 拒绝请求。 */
  reject: (reason: unknown) => void
  /** 清理定时器与取消监听。 */
  cleanup: () => void
}

/**
 * 管理 utility 发往主进程的请求，确保超时、取消、响应和退出只结算一次。
 */
export class ParentRequestRegistry {
  /** 仍等待主进程响应的请求。 */
  private readonly requests = new Map<string, PendingParentRequest>()

  /** 返回当前待处理请求数量。 */
  get size(): number {
    return this.requests.size
  }

  /** 创建请求等待，并按可选时限或工具取消信号结束。 */
  wait<Result = unknown>(options: ParentRequestWaitOptions): Promise<Result> {
    if (options.signal?.aborted) {
      return Promise.reject(new Error(`Main runtime request aborted: ${options.method}`))
    }

    return new Promise<Result>((resolve, reject) => {
      /** 可选的基础设施故障定时器。 */
      let timer: ReturnType<typeof setTimeout> | undefined
      /** 移除工具取消监听。 */
      let removeAbortListener = (): void => undefined
      /** 清理该请求拥有的本地资源。 */
      const cleanup = (): void => {
        if (timer) clearTimeout(timer)
        removeAbortListener()
      }
      /** 尽力通知主进程；端口关闭不能阻止本地 Promise 终结。 */
      const sendCancel = (): void => {
        try {
          options.sendCancel()
        } catch {
          // 主进程或 MessagePort 已退出时，本地清理仍然是权威终态。
        }
      }
      /** 运行取消时同步取消主进程中的对应能力。 */
      const abort = (): void => {
        if (!this.requests.delete(options.requestId)) return
        cleanup()
        sendCancel()
        reject(new Error(`Main runtime request aborted: ${options.method}`))
      }
      /** 注册本次请求的完成边界。 */
      const pending: PendingParentRequest = {
        resolve: (value) => resolve(value as Result),
        reject,
        cleanup,
      }
      this.requests.set(options.requestId, pending)

      if (options.signal) {
        options.signal.addEventListener('abort', abort, { once: true })
        removeAbortListener = () => options.signal?.removeEventListener('abort', abort)
      }
      if (options.timeoutMs !== undefined) {
        timer = setTimeout(() => {
          if (!this.requests.delete(options.requestId)) return
          cleanup()
          sendCancel()
          reject(new Error(`Main runtime request timed out: ${options.method}`))
        }, options.timeoutMs)
      }

      try {
        options.sendRequest()
      } catch (error) {
        if (!this.requests.delete(options.requestId)) return
        cleanup()
        reject(error)
      }
    })
  }

  /** 使用主进程返回值完成指定请求。 */
  resolve(requestId: string, value: unknown): boolean {
    /** 待完成的对应请求。 */
    const pending = this.requests.get(requestId)
    if (!pending) return false
    this.requests.delete(requestId)
    pending.cleanup()
    pending.resolve(value)
    return true
  }

  /** 使用错误拒绝指定请求。 */
  reject(requestId: string, reason: unknown): boolean {
    /** 待拒绝的对应请求。 */
    const pending = this.requests.get(requestId)
    if (!pending) return false
    this.requests.delete(requestId)
    pending.cleanup()
    pending.reject(reason)
    return true
  }

  /** utility 退出时拒绝并清理全部请求。 */
  rejectAll(reason: unknown): void {
    for (const pending of this.requests.values()) {
      pending.cleanup()
      pending.reject(reason)
    }
    this.requests.clear()
  }
}
