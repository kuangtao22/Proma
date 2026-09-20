/** SQL 查询按真实窗口和请求身份归属，避免一个窗口取消另一个窗口的任务。 */
export class ServerOpsQueryRegistry {
  /** 条目一直保留到驱动结束清理，取消请求本身不释放执行槽。 */
  private readonly active = new Map<string, { owner: number; controller: AbortController; done: Promise<void> }>()

  /** 在窗口与精确查询身份下执行；返回前再次拒绝取消后的迟到结果。 */
  async run<T>(owner: number, input: { sourceId: string; queryId: string }, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    /** 元组编码避免用户 ID 中分隔符造成所有权碰撞。 */
    const key = JSON.stringify([owner, input.sourceId, input.queryId])
    if (this.active.has(key) || this.active.size >= 32) throw new Error('SERVER_OPS_SQL_BUSY')
    /** 结束通知只表示底层操作已退出，不携带业务结果。 */
    let finish!: () => void
    const entry = { owner, controller: new AbortController(), done: new Promise<void>((resolve) => { finish = resolve }) }
    this.active.set(key, entry)
    try {
      const result = await operation(entry.controller.signal)
      if (entry.controller.signal.aborted) throw new Error('SERVER_OPS_SQL_CANCELLED')
      return result
    } finally {
      this.active.delete(key)
      finish()
    }
  }

  /** 仅取消真实所有者的匹配查询；重复取消幂等，并等待真实清理完成。 */
  async cancel(owner: number, input: { sourceId: string; queryId: string }): Promise<void> {
    const entry = this.active.get(JSON.stringify([owner, input.sourceId, input.queryId]))
    if (!entry) return
    entry.controller.abort()
    await entry.done
  }

  /** 窗口关闭后立即中止本窗口查询，底层结束时自行移除条目。 */
  closeOwner(owner: number): void {
    for (const entry of this.active.values()) if (entry.owner === owner) entry.controller.abort()
  }

  /** IPC 注册器退出时中止所有在途读取，避免留下无人接收的结果。 */
  closeAll(): void {
    for (const entry of this.active.values()) entry.controller.abort()
  }
}
