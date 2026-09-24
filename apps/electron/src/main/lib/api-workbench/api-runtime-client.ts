import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { ApiResolvedRequest, ApiSseEvent, ApiTransportResult } from '@proma/shared'
import { parseApiRuntimeResponse, type ApiRuntimeArtifacts, type ApiRuntimeRequest } from './api-runtime-protocol'

/** Electron utility process 的最小可测试边界。 */
export interface ApiRuntimeProcess {
  readonly pid?: number
  postMessage(message: unknown): void
  kill(): boolean
  on(event: 'spawn' | 'message' | 'error' | 'exit', listener: (...args: unknown[]) => void): void
}

/** 允许单元测试注入进程和 requestId。 */
export interface ApiRuntimeClientDependencies {
  createProcess: (entryPath: string) => ApiRuntimeProcess
  uuid: () => string
  /** utility 完成传输后允许自行收尾并退出的宽限，仅测试覆盖。 */
  exitGraceMs?: number
  /** shutdown 首次 kill 后等待真实 exit 的时限。 */
  shutdownGraceMs?: number
  /** SIGKILL 后再次等待真实 exit 的时限。 */
  forceKillGraceMs?: number
  /** 按已观测 PID 请求操作系统强制终止，仅 shutdown 升级使用。 */
  forceKill?: (pid: number) => void
}

/** 单次执行的调用选项。 */
export interface ApiRuntimeRunOptions {
  signal?: AbortSignal
  artifacts?: ApiRuntimeArtifacts
  /** 事件流增量回调；只在结果回执之前到达，且已按批上限切分。 */
  onEvent?: (events: ApiSseEvent[]) => void
}

/** client 维护到真实 exit 的一次子进程所有权。 */
interface ActiveRun {
  requestId: string
  process: ApiRuntimeProcess
  spawned: boolean
  abortRequested: boolean
  terminationReason?: 'abort' | 'shutdown' | 'timeout' | 'protocol' | 'process'
  result?: ApiTransportResult
  fallbackResult?: ApiTransportResult
  done: Promise<ApiTransportResult>
  resolve: (result: ApiTransportResult) => void
  hardTimer: ReturnType<typeof setTimeout>
  killTimer?: ReturnType<typeof setTimeout>
  removeAbort: () => void
}

/** 进程退出但没有可信回执时的公开结果。 */
function failedResult(code: string, phase: string, message: string, state: ApiTransportResult['state'] = 'failed'): ApiTransportResult {
  return {
    state, hops: [], body: { rawBytes: 0, decodedBytes: 0, contentType: '', encoding: '', preview: '', previewTruncated: false, complete: false, decoded: false },
    error: { code, phase, message },
  }
}

/** 生产环境延迟加载 Electron，纯 Bun 测试无需导入原生模块。 */
const DEFAULT_DEPENDENCIES: ApiRuntimeClientDependencies = {
  createProcess: (entryPath) => {
    const { utilityProcess } = require('electron') as typeof import('electron')
    const child = utilityProcess.fork(entryPath, [], { serviceName: 'Proma API Workbench Runtime' })
    return {
      get pid() { return child.pid },
      postMessage: (message) => child.postMessage(message), kill: () => child.kill(),
      on: (event, listener) => {
        if (event === 'spawn') child.on('spawn', () => listener())
        else if (event === 'message') child.on('message', (message) => listener(message))
        else if (event === 'error') child.on('error', (type, location, report) => listener(type, location, report))
        else child.on('exit', (code) => listener(code))
      },
    }
  },
  uuid: randomUUID,
  forceKill: (pid) => process.kill(pid, 'SIGKILL'),
}

/** 每次运行创建独立 utility 子进程；并发上限由上层 service 调度。 */
export class ApiRuntimeClient {
  private readonly active = new Map<string, ActiveRun>()
  private readonly exitGraceMs: number
  private readonly shutdownGraceMs: number
  private readonly forceKillGraceMs: number
  private shuttingDown = false

  constructor(private readonly dependencies: ApiRuntimeClientDependencies = DEFAULT_DEPENDENCIES) {
    this.exitGraceMs = Math.min(30_000, Math.max(0, dependencies.exitGraceMs ?? 5_000))
    this.shutdownGraceMs = Math.min(30_000, Math.max(1, dependencies.shutdownGraceMs ?? 5_000))
    this.forceKillGraceMs = Math.min(10_000, Math.max(1, dependencies.forceKillGraceMs ?? 2_000))
  }

  /** 执行一个固定请求，只有对应 utility 真实 exit 后 Promise 才结算。 */
  run(request: ApiResolvedRequest, options: ApiRuntimeRunOptions = {}): Promise<ApiTransportResult> {
    if (this.shuttingDown) return Promise.resolve(failedResult('API_RUNTIME_SHUTTING_DOWN', 'runtime', '接口运行时正在关闭'))
    if (options.signal?.aborted) return Promise.resolve(failedResult('API_ABORTED', 'cancel', '请求已取消', 'cancelled'))
    const requestId = this.dependencies.uuid()
    let runtimeProcess: ApiRuntimeProcess
    try {
      runtimeProcess = this.dependencies.createProcess(join(__dirname, 'api-workbench-runtime.cjs'))
    } catch {
      return Promise.resolve(failedResult('API_RUNTIME_PROCESS_ERROR', 'runtime', '接口运行时进程无法启动'))
    }
    let resolveRun!: (result: ApiTransportResult) => void
    const done = new Promise<ApiTransportResult>((resolve) => { resolveRun = resolve })
    const active: ActiveRun = {
      requestId, process: runtimeProcess, spawned: false, abortRequested: false, done, resolve: resolveRun,
      hardTimer: setTimeout(() => {}, 0), removeAbort: () => {},
    }
    clearTimeout(active.hardTimer)
    this.active.set(requestId, active)

    /** 超出传输时限后仍给 utility 五秒完成关闭和 GCM 收尾。 */
    active.hardTimer = setTimeout(() => {
      active.terminationReason = 'timeout'
      active.fallbackResult = failedResult('API_RUNTIME_TIMEOUT', 'runtime', '接口运行时未在总时限后退出')
      this.kill(active)
    }, request.timeoutMs + this.exitGraceMs)

    const abort = (): void => {
      if (!this.active.has(requestId) || active.abortRequested) return
      active.abortRequested = true
      active.terminationReason = 'abort'
      active.fallbackResult = failedResult('API_ABORTED', 'cancel', '请求已取消', 'cancelled')
      if (active.spawned) {
        const cancel: ApiRuntimeRequest = { type: 'api-workbench.cancel', requestId }
        try {
          active.process.postMessage(cancel)
          active.killTimer = setTimeout(() => this.kill(active), this.exitGraceMs)
        } catch {
          this.kill(active)
        }
      } else {
        this.kill(active)
      }
    }
    if (options.signal) {
      options.signal.addEventListener('abort', abort, { once: true })
      active.removeAbort = () => options.signal?.removeEventListener('abort', abort)
    }

    runtimeProcess.on('spawn', () => {
      if (!this.active.has(requestId)) return
      active.spawned = true
      if (active.terminationReason || this.shuttingDown) {
        this.kill(active)
        return
      }
      const message: ApiRuntimeRequest = {
        type: 'api-workbench.run', requestId, request,
        ...(options.artifacts ? { artifacts: options.artifacts } : {}),
      }
      try {
        runtimeProcess.postMessage(message)
      } catch {
        active.terminationReason = 'process'
        active.fallbackResult = failedResult('API_RUNTIME_PROCESS_ERROR', 'runtime', '接口运行时消息发送失败')
        this.kill(active)
      }
    })
    runtimeProcess.on('message', (rawMessage) => {
      if (!this.active.has(requestId)) return
      if (active.result) return
      try {
        const message = parseApiRuntimeResponse(rawMessage)
        if (message.requestId !== requestId) return
        /** 事件增量先于结果回执到达，不改变本次运行的终态判定。 */
        if (message.type === 'api-workbench.stream') {
          options.onEvent?.(message.events)
          return
        }
        active.result = message.result
        const acknowledgement: ApiRuntimeRequest = { type: 'api-workbench.ack', requestId }
        try {
          runtimeProcess.postMessage(acknowledgement)
        } catch {
          active.terminationReason = 'process'
          active.fallbackResult = failedResult('API_RUNTIME_PROCESS_ERROR', 'runtime', '接口运行时确认消息发送失败')
          this.kill(active)
        }
      } catch {
        active.terminationReason = 'protocol'
        active.fallbackResult = failedResult('API_RUNTIME_PROTOCOL_INVALID', 'runtime', '接口运行时返回了无效消息')
        this.kill(active)
      }
    })
    runtimeProcess.on('error', () => {
      if (!this.active.has(requestId)) return
      active.terminationReason = 'process'
      active.fallbackResult = failedResult('API_RUNTIME_PROCESS_ERROR', 'runtime', '接口运行时进程发生错误')
      this.kill(active)
    })
    runtimeProcess.on('exit', (code) => this.finishAfterExit(active, typeof code === 'number' ? code : null))
    return done
  }

  /** 停止全部在途 utility，并等待真实 exit 后才释放所有权。 */
  async shutdown(): Promise<void> {
    this.shuttingDown = true
    const runs = [...this.active.values()]
    for (const active of runs) {
      active.terminationReason = 'shutdown'
      active.fallbackResult = active.fallbackResult ?? failedResult('API_ABORTED', 'cancel', '应用正在关闭', 'cancelled')
      this.kill(active)
    }
    if (runs.length === 0) return
    if (await this.waitForExit(runs, this.shutdownGraceMs)) return
    for (const active of runs) {
      if (!this.active.has(active.requestId) || !active.process.pid) continue
      try { (this.dependencies.forceKill ?? DEFAULT_DEPENDENCIES.forceKill)?.(active.process.pid) } catch { /* 下一阶段仍以真实 exit 为准。 */ }
    }
    if (await this.waitForExit(runs, this.forceKillGraceMs)) return
    throw new Error('API_RUNTIME_SHUTDOWN_TIMEOUT: utility 未确认退出')
  }

  /** 在固定时限内只把真实 exit 对应的 done 视为完成。 */
  private async waitForExit(runs: ActiveRun[], timeoutMs: number): Promise<boolean> {
    let timeout: ReturnType<typeof setTimeout> | undefined
    const timedOut = new Promise<false>((resolve) => { timeout = setTimeout(() => resolve(false), timeoutMs) })
    const exited = Promise.all(runs.map((active) => active.done)).then(() => true as const)
    const result = await Promise.race([exited, timedOut])
    if (timeout) clearTimeout(timeout)
    return result
  }

  /** kill 可能在 spawn 前返回 false；spawn 回调会按 abort/shutdown 状态补发。 */
  private kill(active: ActiveRun): void {
    try { active.process.kill() } catch { /* 仍保留所有权并等待真实 exit。 */ }
  }

  /** 只由真实 exit 事件完成运行并清理监听、定时器和所有权。 */
  private finishAfterExit(active: ActiveRun, code: number | null): void {
    if (!this.active.delete(active.requestId)) return
    clearTimeout(active.hardTimer)
    if (active.killTimer) clearTimeout(active.killTimer)
    active.removeAbort()
    if (active.terminationReason === 'abort' && code === 0 && active.result) {
      active.resolve(active.result)
      return
    }
    if (active.terminationReason) {
      active.resolve(active.fallbackResult ?? failedResult('API_RUNTIME_EXITED', 'runtime', `接口运行时异常退出（${code ?? 'unknown'}）`))
      return
    }
    if (code === 0 && active.result) {
      active.resolve(active.result)
      return
    }
    active.resolve({
      state: 'failed', hops: active.result?.hops ?? [], body: active.result?.body ?? failedResult('', '', '').body,
      error: { code: 'API_RUNTIME_EXITED', phase: 'runtime', message: `接口运行时异常退出（${code ?? 'unknown'}）` },
    })
  }
}

export const apiRuntimeClient = new ApiRuntimeClient()
