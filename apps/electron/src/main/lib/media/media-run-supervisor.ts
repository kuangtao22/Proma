import type { MediaRunSnapshot } from '@proma/shared'
import { ComfyProgressStream } from './comfyui-progress-stream'
import type { ComfyProgressEvent } from './comfyui-progress-stream'
import type { MediaRunService } from './media-run-service'

/** 监督器只消费统一任务服务，测试可注入内存运行与事件流。 */
export interface MediaRunSupervisorDependencies {
  runs: Pick<MediaRunService, 'get' | 'advance' | 'reconcile' | 'getWatchTarget' | 'recordProgress' | 'subscribe' | 'listRecoverable'>
  stream?: Pick<ComfyProgressStream, 'subscribe' | 'dispose'>
  onError?: (projectId: string, runId: string, error: unknown) => void
  pollMs?: number
}

/** 一次监督只有一个串行对账和一个后备定时器，WS 仅负责唤醒。 */
interface WatchedRun {
  projectId: string
  runId: string
  submitRevision?: number
  timer?: ReturnType<typeof setTimeout>
  scheduledAt?: number
  progressTimer?: ReturnType<typeof setTimeout>
  unsubscribe?: () => void
  busy: boolean
  dirty: boolean
  failures: number
  lastProgressAt: number
  progress?: { promptId: string; value: NonNullable<MediaRunSnapshot['progress']> }
}

/** 运行终态只描述生成与收集，不代表画布已经采用结果。 */
function terminal(snapshot: MediaRunSnapshot): boolean {
  return ['succeeded', 'failed', 'cancelled'].includes(snapshot.phase)
}

/** 后台持续跟踪远端运行；窗口关闭或一次 Agent wait 超时都不取消生成。 */
export class MediaRunSupervisor {
  /** 主进程唯一任务观察索引，跨入口同一 run 不重复提交或轮询。 */
  private readonly watched = new Map<string, WatchedRun>()
  /** 共享协议事件连接，认证与 prompt_id 仅留在主进程。 */
  private readonly stream: Pick<ComfyProgressStream, 'subscribe' | 'dispose'>
  /** 退出时只停止本地观察，远端任务通过 journal 在下次启动恢复。 */
  private disposed = false
  /** 全应用最多四个对账/提交请求组，避免恢复大量任务时突发占用连接。 */
  private activeRequests = 0
  /** 用于结束本地 wait，绝不传给远端 prompt 作为取消指令。 */
  private readonly stopController = new AbortController()

  constructor(private readonly dependencies: MediaRunSupervisorDependencies) {
    this.stream = dependencies.stream ?? new ComfyProgressStream()
  }

  /** 启动已获 Host 授权的准备，不在网络等待期间占用 UI/Agent 工具调用。 */
  start(projectId: string, runId: string, expectedRevision: number): MediaRunSnapshot {
    const snapshot = this.dependencies.runs.get(projectId, runId)
    if (snapshot.revision !== expectedRevision) throw new Error('MEDIA_RUN_CONFLICT')
    this.watch(projectId, runId, expectedRevision)
    return snapshot
  }

  /** 恢复只对账已提交任务；启动扫描不会自动提交遗留 prepared。 */
  recover(projectId: string): void {
    for (const run of this.dependencies.runs.listRecoverable(projectId)) this.watch(projectId, run.id)
  }

  /** 对单个历史运行重新开始观察，允许用户恢复已暂停的收集。 */
  watch(projectId: string, runId: string, submitRevision?: number): void {
    if (this.disposed) throw new Error('MEDIA_RUNTIME_STOPPED')
    const key = `${projectId}:${runId}`
    if (this.watched.has(key)) return
    if (this.watched.size >= 128) throw new Error('MEDIA_ACTIVE_RUN_LIMIT')
    if (terminal(this.dependencies.runs.get(projectId, runId))) return
    const run: WatchedRun = { projectId, runId, submitRevision, busy: false, dirty: false, failures: 0, lastProgressAt: 0 }
    this.watched.set(key, run)
    this.schedule(run, 0)
  }

  /** 等待 revision 变化或终态，最多 30 秒；超时返回最新事实供 Agent 继续。 */
  async wait(projectId: string, runId: string, timeoutMs = 30_000, afterRevision?: number, signal?: AbortSignal): Promise<MediaRunSnapshot> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 30_000) throw new Error('MEDIA_WAIT_INVALID')
    const current = this.dependencies.runs.get(projectId, runId)
    if (terminal(current) || timeoutMs === 0 || (afterRevision !== undefined && current.revision > afterRevision)) return current
    return await new Promise<MediaRunSnapshot>((resolve, reject) => {
      /** 监听结束统一释放所有资源，防止每次 Agent wait 累积监听器。 */
      const finish = (): void => {
        clearTimeout(timer)
        unsubscribe()
        signal?.removeEventListener('abort', abort)
        this.stopController.signal.removeEventListener('abort', abort)
        try { resolve(this.dependencies.runs.get(projectId, runId)) } catch (error) { reject(error) }
      }
      /** 本地调用取消只结束等待，保留远端任务。 */
      const abort = (): void => { finish() }
      const unsubscribe = this.dependencies.runs.subscribe((snapshot) => {
        if (snapshot.projectId === projectId && snapshot.id === runId && (terminal(snapshot) || (afterRevision !== undefined && snapshot.revision > afterRevision))) finish()
      })
      const timer = setTimeout(finish, timeoutMs)
      signal?.addEventListener('abort', abort, { once: true })
      this.stopController.signal.addEventListener('abort', abort, { once: true })
      if (signal?.aborted || this.disposed) finish()
      else {
        const latest = this.dependencies.runs.get(projectId, runId)
        if (terminal(latest) || (afterRevision !== undefined && latest.revision > afterRevision)) finish()
      }
    })
  }

  /** 应用退出释放 WS、timer 和等待，不伪造取消成功。 */
  dispose(): void {
    this.disposed = true
    this.stopController.abort()
    for (const run of this.watched.values()) this.remove(run)
    this.stream.dispose()
  }

  /** 有界串行唤醒，同一 run 的 WS 风暴只合并为一次后续对账。 */
  private schedule(run: WatchedRun, delay: number): void {
    if (this.disposed || !this.watched.has(`${run.projectId}:${run.runId}`)) return
    if (run.busy) { run.dirty = true; return }
    if (run.timer && run.scheduledAt !== undefined && run.scheduledAt <= Date.now() + delay) return
    if (run.timer) clearTimeout(run.timer)
    run.scheduledAt = Date.now() + delay
    run.timer = setTimeout(() => { run.timer = undefined; void this.tick(run) }, delay)
    run.timer.unref?.()
  }

  /** 先校验当前权限/实例，再建立 WS 并读取权威 queue/history。 */
  private async tick(run: WatchedRun): Promise<void> {
    if (this.disposed || run.busy) return
    if (this.activeRequests >= 4) { this.schedule(run, 250); return }
    this.activeRequests += 1
    run.busy = true
    try {
      let snapshot = this.dependencies.runs.get(run.projectId, run.runId)
      if (run.submitRevision !== undefined) {
        const revision = run.submitRevision
        run.submitRevision = undefined
        snapshot = await this.dependencies.runs.advance(run.projectId, run.runId, revision)
      }
      if (terminal(snapshot)) { this.remove(run); return }
      const target = this.dependencies.runs.getWatchTarget(run.projectId, run.runId)
      if (!target) { this.remove(run); return }
      if (!run.unsubscribe) run.unsubscribe = this.stream.subscribe(target, (event) => {
        if (event.type === 'disconnected' || event.promptId === target.promptId) this.onEvent(run, event)
      })
      snapshot = await this.dependencies.runs.reconcile(run.projectId, run.runId)
      run.failures = snapshot.phase === 'collection-failed' ? run.failures + 1 : 0
      // 收集失败继续按有界退避补收原输出，不能因停止观察而丢失恢复入口。
      if (terminal(snapshot)) this.remove(run)
    } catch (error) {
      run.failures += 1
      run.unsubscribe?.()
      run.unsubscribe = undefined
      try { this.dependencies.onError?.(run.projectId, run.runId, error) } catch { /* 诊断订阅不得中断监督。 */ }
    } finally {
      run.busy = false
      this.activeRequests -= 1
      const delay = run.dirty ? 500 : Math.min(60_000, (this.dependencies.pollMs ?? 5_000) * 2 ** Math.min(run.failures, 4))
      run.dirty = false
      this.schedule(run, delay)
    }
  }

  /** 精确节点采样计数留作节流投影，终态事件只唤醒权威对账。 */
  private onEvent(run: WatchedRun, event: ComfyProgressEvent): void {
    if (event.type === 'progress' && event.nodeId !== undefined && event.value !== undefined && event.max !== undefined) {
      run.progress = { promptId: event.promptId, value: { nodeId: event.nodeId, value: event.value, max: event.max } }
      this.flushProgress(run)
      return
    }
    this.schedule(run, 500)
  }

  /** 采样事件最多每 500ms 合并一次本地投影，不为每一帧请求 HTTP。 */
  private flushProgress(run: WatchedRun): void {
    if (run.progressTimer || this.disposed || !this.watched.has(`${run.projectId}:${run.runId}`)) return
    run.progressTimer = setTimeout(() => {
      run.progressTimer = undefined
      if (!run.progress) return
      if (run.busy) { this.flushProgress(run); return }
      try {
        this.dependencies.runs.recordProgress(run.projectId, run.runId, run.progress.promptId, run.progress.value)
        run.lastProgressAt = Date.now()
        run.progress = undefined
      } catch { run.progress = undefined /* 权限或磁盘异常由后续对账报告，禁止进度事件形成重试风暴。 */ }
      if (run.progress) this.flushProgress(run)
    }, Math.max(100, 500 - (Date.now() - run.lastProgressAt)))
    run.progressTimer.unref?.()
  }

  /** 单项完成只释放该项订阅，共享连接仍可服务其它 prompt。 */
  private remove(run: WatchedRun): void {
    if (run.timer) clearTimeout(run.timer)
    if (run.progressTimer) clearTimeout(run.progressTimer)
    run.unsubscribe?.()
    this.watched.delete(`${run.projectId}:${run.runId}`)
  }
}
