import ELK from 'elkjs/lib/elk-api'
import type { ElkNode } from 'elkjs/lib/elk-api'

/** 单个任务内复用的 ELK 图布局函数。 */
export type NativeCanvasLayoutEngine = (graph: ElkNode) => Promise<ElkNode>

/** 单次原生 Canvas 布局任务的 Worker 与终止条件。 */
export interface NativeCanvasLayoutEngineOptions {
  /** 为本次任务创建唯一 Worker。 */
  workerFactory: () => Worker
  /** 可选的调用方取消信号。 */
  signal?: AbortSignal
  /** 包含 Worker 初始化和全部布局调用的总预算。 */
  timeoutMs?: number
}

/** 默认单次智能整理总预算，避免异常图长期占用 Worker。 */
const DEFAULT_NATIVE_CANVAS_LAYOUT_TIMEOUT_MS = 8_000

/** 创建具有稳定类型的取消错误。 */
function createNativeCanvasLayoutAbortError(): DOMException {
  return new DOMException('Canvas 智能整理已取消', 'AbortError')
}

/** 创建具有稳定类型的超时错误。 */
function createNativeCanvasLayoutTimeoutError(): Error {
  const error = new Error('Canvas 智能整理超时')
  error.name = 'TimeoutError'
  return error
}

/** 将浏览器 Worker error 事件转换为可透传的 Error。 */
function resolveNativeCanvasLayoutWorkerError(event: ErrorEvent): Error {
  if (event.error instanceof Error) return event.error
  return new Error(event.message || 'ELK Worker 运行失败')
}

/** 创建 ELK Worker、执行任务并在所有终态释放资源。 */
export async function withNativeCanvasLayoutEngine<T>(
  run: (layout: NativeCanvasLayoutEngine) => Promise<T>,
  options: NativeCanvasLayoutEngineOptions,
): Promise<T> {
  if (options.signal?.aborted) throw createNativeCanvasLayoutAbortError()
  /** 本次任务从入口开始计算总预算。 */
  const startedAt = Date.now()
  /** 调用方预算缺省为八秒。 */
  const timeoutMs = options.timeoutMs ?? DEFAULT_NATIVE_CANVAS_LAYOUT_TIMEOUT_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('NATIVE_CANVAS_LAYOUT_TIMEOUT_INVALID')
  }

  /** 每次任务只创建一个 Worker，由 finally 唯一释放。 */
  const worker = options.workerFactory()
  /** ELK 构造成功后通过其公开 API 终止 Worker。 */
  let terminateWorker: (() => void) | undefined
  /** 任务终态门禁，阻止调用方使用已经释放的 Worker。 */
  let finished = false
  /** 超时句柄在所有终态清理。 */
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  /** 运行中取消监听器在所有终态移除。 */
  let abortListener: (() => void) | undefined
  /** Worker 错误监听器在所有终态移除。 */
  let workerErrorListener: ((event: ErrorEvent) => void) | undefined

  try {
    /** elk-api 只负责消息协议，重计算始终由注入的真实 Worker 执行。 */
    const elk = new ELK({ workerFactory: () => worker })
    terminateWorker = () => elk.terminateWorker()
    /** 在进入 run 或发送布局命令前确认任务仍拥有 Worker。 */
    const assertActive = (): void => {
      if (finished) throw new Error('NATIVE_CANVAS_LAYOUT_FINISHED')
      if (options.signal?.aborted) throw createNativeCanvasLayoutAbortError()
    }
    /** 同一 run 内的多次调用共享上面的 ELK 实例和 Worker。 */
    const layout: NativeCanvasLayoutEngine = async (graph) => {
      assertActive()
      return elk.layout(graph)
    }
    /** 剩余预算包含 Worker 和 ELK 初始化已经消耗的时间。 */
    const remainingTimeoutMs = Math.max(0, timeoutMs - (Date.now() - startedAt))

    /** 将所有外部终止条件合并为一个拒绝 Promise。 */
    const interruption = new Promise<never>((_resolve, reject) => {
      abortListener = () => reject(createNativeCanvasLayoutAbortError())
      workerErrorListener = (event) => {
        event.preventDefault()
        reject(resolveNativeCanvasLayoutWorkerError(event))
      }
      options.signal?.addEventListener('abort', abortListener, { once: true })
      worker.addEventListener('error', workerErrorListener)
      timeoutHandle = setTimeout(() => reject(createNativeCanvasLayoutTimeoutError()), remainingTimeoutMs)
      // 信号可能在入口预检查和监听器注册之间取消。
      if (options.signal?.aborted) abortListener()
    })
    /** 微任务边界将 run 的同步抛错也纳入统一 Promise 竞态。 */
    const runResult = Promise.resolve().then(() => {
      assertActive()
      return run(layout)
    })
    return await Promise.race([runResult, interruption])
  } finally {
    finished = true
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)
    if (abortListener) options.signal?.removeEventListener('abort', abortListener)
    if (workerErrorListener) worker.removeEventListener('error', workerErrorListener)
    if (terminateWorker) terminateWorker()
    else worker.terminate()
  }
}
