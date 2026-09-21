/** 单条排队读取携带的授权、配置和取消边界。 */
export interface ServerOpsScheduledReadOptions {
  signal?: AbortSignal
  ownerSessionId?: string
  check?: () => void
  validate?: () => void
  /** 待排队读取额外锁定完整配置，已执行读取仍按真实连接身份校验。 */
  validateQueued?: () => void
}

/** 等待执行的任务；只保存闭包，不保存 SQL 或数据库行。 */
interface PendingRead<T> {
  sourceId: string
  ownerSessionId?: string
  /** 单调时钟上的排队截止时间，timer 迟到时仍能在出队处硬校验。 */
  deadlineAt: number
  options: ServerOpsScheduledReadOptions
  execute: () => Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
  timer: ReturnType<typeof setTimeout>
  onAbort: () => void
}

/** UI 与 Agent 共用的有界数据库读取调度器。 */
export class ServerOpsReadScheduler {
  private readonly pending = new Map<string, PendingRead<unknown>[]>()
  private readonly ready: string[] = []
  private readonly active = new Set<string>()
  private pendingCount = 0
  private disposed = false
  private validationTimer: ReturnType<typeof setInterval> | undefined

  /** 注入单调时钟便于测试事件循环延迟；不依赖可调整的墙钟时间。 */
  constructor(private readonly now: () => number = () => performance.now()) {}

  /** 入队或直接启动一次读取；同源串行且最多三个来源并行。 */
  run<T>(sourceId: string, execute: () => Promise<T>, options: ServerOpsScheduledReadOptions = {}): Promise<T> {
    if (this.disposed) return Promise.reject(new Error('SERVER_OPS_DATA_UNAVAILABLE'))
    try {
      this.check(options)
      if (options.signal?.aborted) throw new Error('SERVER_OPS_DATA_CANCELLED')
    } catch (error) { return Promise.reject(error) }
    if (!this.active.has(sourceId) && this.active.size < 3 && (this.pending.get(sourceId)?.length ?? 0) === 0) {
      return this.start(sourceId, execute, options)
    }
    const queue = this.pending.get(sourceId) ?? []
    if (queue.length >= 8 || this.pendingCount >= 24
      || (options.ownerSessionId !== undefined && this.countSession(options.ownerSessionId) >= 8)) {
      return Promise.reject(new Error('SERVER_OPS_DATA_QUEUE_FULL'))
    }
    return new Promise<T>((resolve, reject) => {
      /** 在队列内保留独立取消监听和五秒等待预算。 */
      const entry: PendingRead<unknown> = {
        sourceId, ownerSessionId: options.ownerSessionId, deadlineAt: this.now() + 5_000,
        options, execute, resolve: (value) => resolve(value as T), reject,
        timer: setTimeout(() => this.remove(entry, new Error('SERVER_OPS_DATA_QUEUE_TIMEOUT')), 5_000),
        onAbort: () => {
          try { this.check(options); this.remove(entry, new Error('SERVER_OPS_DATA_CANCELLED')) }
          catch (error) { this.remove(entry, error instanceof Error ? error : new Error('SERVER_OPS_DATA_CANCELLED')) }
        },
      }
      if (queue.length === 0) {
        this.pending.set(sourceId, queue)
        this.ready.push(sourceId)
      }
      queue.push(entry)
      this.pendingCount += 1
      options.signal?.addEventListener('abort', entry.onAbort, { once: true })
      if (options.signal?.aborted) entry.onAbort()
      if (!this.validationTimer && this.pendingCount > 0) {
        /** 跨实例配置文件没有事件，短周期 fresh read 能及时取消排队中的旧目标。 */
        this.validationTimer = setInterval(() => this.validatePending(), 250)
      }
      this.drain()
    })
  }

  /** 配置更新/删除后立即清理该目标的排队请求。 */
  cancelQueued(sourceId: string, reason = 'SERVER_OPS_DATA_SOURCE_CHANGED'): void {
    for (const entry of [...(this.pending.get(sourceId) ?? [])]) this.remove(entry, new Error(reason))
  }

  /** 服务退出时拒绝全部待排队任务，在途任务由 runtime 自行收尾。 */
  dispose(): void {
    this.disposed = true
    for (const sourceId of [...this.pending.keys()]) this.cancelQueued(sourceId, 'SERVER_OPS_DATA_UNAVAILABLE')
  }

  /** 授权与连接身份在任务入队、出队、执行前及返回前均重新核验。 */
  private check(options: ServerOpsScheduledReadOptions, queued = false): void {
    options.check?.()
    options.validate?.()
    if (queued) options.validateQueued?.()
  }

  /** 按来源轮转领取一个任务，同源保持 FIFO。 */
  private drain(): void {
    let attempts = this.ready.length
    while (this.active.size < 3 && attempts-- > 0 && this.ready.length > 0) {
      const sourceId = this.ready.shift()!
      const queue = this.pending.get(sourceId)
      if (!queue?.length) continue
      if (this.active.has(sourceId)) { this.ready.push(sourceId); continue }
      const entry = queue.shift()!
      this.cleanup(entry)
      if (queue.length) this.ready.push(sourceId)
      else this.pending.delete(sourceId)
      if (this.now() >= entry.deadlineAt) {
        entry.reject(new Error('SERVER_OPS_DATA_QUEUE_TIMEOUT'))
        attempts = this.ready.length
        continue
      }
      /** 取消和配置变更可能恰好发生在出队边界。 */
      try { this.check(entry.options, true); if (entry.options.signal?.aborted) throw new Error('SERVER_OPS_DATA_CANCELLED') }
      catch (error) { entry.reject(error); attempts = this.ready.length; continue }
      void this.start(sourceId, entry.execute, entry.options).then(entry.resolve, entry.reject)
      attempts = this.ready.length
    }
  }

  /** 保留来源占用直至 runtime 确认完成，避免取消后提前启动同源任务。 */
  private async start<T>(sourceId: string, execute: () => Promise<T>, options: ServerOpsScheduledReadOptions): Promise<T> {
    this.active.add(sourceId)
    try {
      this.check(options)
      if (options.signal?.aborted) throw new Error('SERVER_OPS_DATA_CANCELLED')
      const result = await execute()
      this.check(options)
      if (options.signal?.aborted) throw new Error('SERVER_OPS_DATA_CANCELLED')
      return result
    } catch (error) {
      this.check(options)
      throw error
    } finally {
      this.active.delete(sourceId)
      this.drain()
    }
  }

  /** 排队任务主动取消或超时后，释放监听、计时和会话预算。 */
  private remove(entry: PendingRead<unknown>, error: Error): void {
    const queue = this.pending.get(entry.sourceId)
    const index = queue?.indexOf(entry) ?? -1
    if (index < 0 || !queue) return
    queue.splice(index, 1)
    this.cleanup(entry)
    if (!queue.length) {
      this.pending.delete(entry.sourceId)
      const readyIndex = this.ready.indexOf(entry.sourceId)
      if (readyIndex >= 0) this.ready.splice(readyIndex, 1)
    }
    entry.reject(error)
    this.drain()
  }

  /** 统一清理单条排队任务占用的资源。 */
  private cleanup(entry: PendingRead<unknown>): void {
    clearTimeout(entry.timer)
    entry.options.signal?.removeEventListener('abort', entry.onAbort)
    this.pendingCount -= 1
    if (this.pendingCount === 0 && this.validationTimer) {
      clearInterval(this.validationTimer)
      this.validationTimer = undefined
    }
  }

  /** 仅统计待排队请求，运行中的请求不计入会话配额。 */
  private countSession(sessionId: string): number {
    let count = 0
    for (const queue of this.pending.values()) for (const entry of queue) {
      if (entry.ownerSessionId === sessionId) count += 1
    }
    return count
  }

  /** 轮询跨实例文件变化与授权撤销，不等待五秒排队超时。 */
  private validatePending(): void {
    for (const queue of [...this.pending.values()]) for (const entry of [...queue]) {
      if (this.now() >= entry.deadlineAt) { this.remove(entry, new Error('SERVER_OPS_DATA_QUEUE_TIMEOUT')); continue }
      try { this.check(entry.options, true) } catch (error) { this.remove(entry, error instanceof Error ? error : new Error('SERVER_OPS_DATA_SOURCE_CHANGED')) }
    }
  }
}
