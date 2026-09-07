import { describe, expect, test } from 'bun:test'
import type { ElkNode } from 'elkjs/lib/elk-api'
import { withNativeCanvasLayoutEngine } from './native-canvas-layout-client'

/** 创建供真实 Worker 验证的最小有向图。 */
function createGraph(): ElkNode {
  return {
    id: 'root',
    layoutOptions: { 'elk.algorithm': 'layered', 'elk.direction': 'RIGHT' },
    children: [
      { id: 'source', width: 120, height: 80 },
      { id: 'target', width: 120, height: 80 },
    ],
    edges: [{ id: 'edge', sources: ['source'], targets: ['target'] }],
  }
}

/** 可控 Worker 只负责生命周期与错误事件测试，不模拟布局结果。 */
class ControllableWorker {
  /** ELK API 注册的消息回调。 */
  onmessage: ((event: MessageEvent) => void) | null = null
  /** Worker 消息反序列化错误回调。 */
  onmessageerror: ((event: MessageEvent) => void) | null = null
  /** Worker 运行错误回调。 */
  onerror: ((event: ErrorEvent) => void) | null = null
  /** 已调用 terminate 的次数。 */
  terminateCalls = 0
  /** ELK API 发送到 Worker 的命令列表。 */
  readonly postedCommands: string[] = []
  /** 当前 error 监听器集合。 */
  readonly errorListeners = new Set<EventListenerOrEventListenerObject>()

  /** 接收 ELK 命令；生命周期测试无需返回布局消息。 */
  postMessage(message: unknown): void {
    if (typeof message === 'object' && message !== null && 'cmd' in message
      && typeof message.cmd === 'string') {
      this.postedCommands.push(message.cmd)
    }
  }

  /** 记录 Worker 资源释放次数。 */
  terminate(): void {
    this.terminateCalls += 1
  }

  /** 注册测试关注的 error 监听器。 */
  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (type === 'error') this.errorListeners.add(listener)
  }

  /** 移除测试关注的 error 监听器。 */
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (type === 'error') this.errorListeners.delete(listener)
  }

  /** 主动发布 Worker 错误，验证 client 立即失败。 */
  emitError(error: Error): void {
    const event = {
      type: 'error',
      error,
      message: error.message,
      preventDefault: () => undefined,
    } as unknown as ErrorEvent
    for (const listener of this.errorListeners) {
      if (typeof listener === 'function') listener(event)
      else listener.handleEvent(event)
    }
    this.onerror?.(event)
  }
}

/** 将可控测试对象收窄到浏览器 Worker 合同。 */
function asWorker(worker: ControllableWorker): Worker {
  return worker as unknown as Worker
}

describe('原生 Canvas ELK Worker 生命周期', () => {
  test('Given 真实 Bun Worker When 同一任务连续布局两次 Then 复用 Worker 并返回坐标', async () => {
    /** elkjs 发布包中的真实 Worker URL。 */
    const workerUrl = import.meta.resolve('elkjs/lib/elk-worker.min.js')
    /** 本次任务实际创建的 Worker 数量。 */
    let workerCount = 0
    /** 本次任务实际释放的 Worker 数量。 */
    let terminateCount = 0

    const positions = await withNativeCanvasLayoutEngine(async (layout) => {
      const first = await layout(createGraph())
      const second = await layout(createGraph())
      return [first, second].map((graph) => graph.children?.map((node) => ({ x: node.x, y: node.y })))
    }, {
      workerFactory: () => {
        workerCount += 1
        /** 真实 Bun Worker 验证 ELK 消息协议和重计算均在子线程执行。 */
        const worker = new Worker(workerUrl)
        /** 保留真实终止方法，同时记录 client 是否释放资源。 */
        const terminate = worker.terminate.bind(worker)
        worker.terminate = () => {
          terminateCount += 1
          terminate()
        }
        return worker
      },
    })

    expect(workerCount).toBe(1)
    expect(terminateCount).toBe(1)
    expect(positions).toHaveLength(2)
    expect(positions.flat().every((point) => Number.isFinite(point?.x) && Number.isFinite(point?.y))).toBe(true)
  })

  test('Given signal 已取消 When 开始任务 Then 不创建 Worker', async () => {
    const controller = new AbortController()
    controller.abort()
    let workerCount = 0

    await expect(withNativeCanvasLayoutEngine(async () => undefined, {
      signal: controller.signal,
      workerFactory: () => {
        workerCount += 1
        return asWorker(new ControllableWorker())
      },
    })).rejects.toMatchObject({ name: 'AbortError' })
    expect(workerCount).toBe(0)
  })

  test('Given workerFactory 内同步取消 When 准备执行 run Then 不进入 run', async () => {
    const worker = new ControllableWorker()
    const controller = new AbortController()
    let runCalls = 0

    await expect(withNativeCanvasLayoutEngine(async () => {
      runCalls += 1
    }, {
      signal: controller.signal,
      workerFactory: () => {
        controller.abort()
        return asWorker(worker)
      },
    })).rejects.toMatchObject({ name: 'AbortError' })

    expect(runCalls).toBe(0)
    expect(worker.postedCommands).toEqual(['register'])
    expect(worker.terminateCalls).toBe(1)
  })

  test('Given run 保存 layout When 任务已结束 Then late layout 拒绝且不访问已终止 Worker', async () => {
    const worker = new ControllableWorker()
    let retainedLayout: Parameters<typeof withNativeCanvasLayoutEngine>[0] extends (
      layout: infer Layout,
    ) => Promise<unknown> ? Layout : never

    await withNativeCanvasLayoutEngine(async (layout) => {
      retainedLayout = layout
    }, { workerFactory: () => asWorker(worker) })
    await expect(retainedLayout!(createGraph())).rejects.toThrow('NATIVE_CANVAS_LAYOUT_FINISHED')

    expect(worker.postedCommands).toEqual(['register'])
    expect(worker.terminateCalls).toBe(1)
  })

  test('Given run 抛错 When 任务结束 Then 原样抛错并释放 Worker 与监听器', async () => {
    const worker = new ControllableWorker()
    const expected = new Error('布局转换失败')

    await expect(withNativeCanvasLayoutEngine(async () => {
      throw expected
    }, { workerFactory: () => asWorker(worker) })).rejects.toBe(expected)

    expect(worker.terminateCalls).toBe(1)
    expect(worker.errorListeners.size).toBe(0)
  })

  test('Given 任务超过预算 When timeout 触发 Then 失败并吞住迟到拒绝', async () => {
    const worker = new ControllableWorker()
    let rejectLate: ((error: Error) => void) | undefined
    let unhandledReason: unknown
    /** 捕获测试窗口内的未处理拒绝，确保 Promise.race 败者仍有 handler。 */
    const onUnhandled = (reason: unknown): void => { unhandledReason = reason }
    process.on('unhandledRejection', onUnhandled)

    try {
      await expect(withNativeCanvasLayoutEngine(async () => new Promise<never>((_resolve, reject) => {
        rejectLate = reject
      }), {
        workerFactory: () => asWorker(worker),
        timeoutMs: 10,
      })).rejects.toMatchObject({ name: 'TimeoutError' })
      rejectLate?.(new Error('迟到失败'))
      await Bun.sleep(10)
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }

    expect(unhandledReason).toBeUndefined()
    expect(worker.terminateCalls).toBe(1)
    expect(worker.errorListeners.size).toBe(0)
  })

  test('Given 任务运行中取消 When abort 触发 Then 立即失败并释放资源', async () => {
    const worker = new ControllableWorker()
    const controller = new AbortController()

    const result = withNativeCanvasLayoutEngine(async () => new Promise<never>(() => undefined), {
      workerFactory: () => asWorker(worker),
      signal: controller.signal,
    })
    controller.abort()

    await expect(result).rejects.toMatchObject({ name: 'AbortError' })
    expect(worker.terminateCalls).toBe(1)
    expect(worker.errorListeners.size).toBe(0)
  })

  test('Given Worker 发布 error When 任务仍运行 Then 立即透传错误并释放资源', async () => {
    const worker = new ControllableWorker()
    const expected = new Error('ELK Worker 崩溃')

    const result = withNativeCanvasLayoutEngine(async () => new Promise<never>(() => undefined), {
      workerFactory: () => asWorker(worker),
    })
    queueMicrotask(() => worker.emitError(expected))

    await expect(result).rejects.toBe(expected)
    expect(worker.terminateCalls).toBe(1)
    expect(worker.errorListeners.size).toBe(0)
  })
})
