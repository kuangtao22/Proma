import { join } from 'node:path'
import { MessageChannelMain, utilityProcess, type MessagePortMain, type UtilityProcess } from 'electron'
import { startUtilityProcessWithRetry } from './utility-process-startup'
import { createUtilityProcessLifecycle } from './utility-process-lifecycle'
import type { UtilityProcessLifecycle } from './utility-process-lifecycle'
import type {
  TerminalCreateInput,
  TerminalExitEvent,
  TerminalInput,
  TerminalOutputAck,
  TerminalOutputEvent,
  TerminalResizeInput,
  TerminalState,
} from '@proma/shared'

type RuntimePort = Pick<MessagePortMain, 'close' | 'postMessage' | 'start'> & {
  on(event: 'message', listener: (event: { data: unknown }) => void): void
}

type PendingCreate = {
  promise: Promise<TerminalState>
  resolve: (state: TerminalState) => void
  reject: (reason: Error) => void
}

interface RuntimeLease {
  /** 调用方获准使用的终端 runtime 代次。 */
  generation: number
  /** 调用方获准发送消息的终端端口。 */
  port: RuntimePort
}

interface PendingStart {
  /** 正在启动的终端 runtime 代次。 */
  generation: number
  /** 当前代次的 ready 握手 Promise。 */
  promise: Promise<void>
}

type RuntimeTerminalCreateInput = TerminalCreateInput & {
  strictCwd?: boolean
}

type RuntimeMessage =
  | { type: 'terminal.ready'; pid: number }
  | { type: 'terminal.created'; state: TerminalState }
  | { type: 'terminal.output'; event: TerminalOutputEvent }
  | { type: 'terminal.exit'; event: TerminalExitEvent }
  | { type: 'terminal.error'; terminalId: string; message: string }

const STARTUP_TIMEOUT_MS = 10_000

/**
 * 一个 utility process 管理全部本地 PTY：与 Agent runtime 隔离，又不会为每个 Tab
 * 创建一个 Node 进程。Renderer 始终经由此 client 接收已批处理的输出。
 */
export class TerminalRuntimeClient {
  private runtimeProcess: UtilityProcess | undefined
  /** 与 fork 句柄绑定的退出确认，不以 kill 已调用冒充进程已退出。 */
  private runtimeLifecycle: UtilityProcessLifecycle<UtilityProcess> | undefined
  /** 所有并发停止共享同一收尾过程，完成前禁止下一代启动。 */
  private stopPromise: Promise<void> | undefined
  private port: RuntimePort | undefined
  private starting: PendingStart | undefined
  /** 主动拒绝仍等待 terminal.ready 的当前启动流程。 */
  private cancelStarting: ((error: Error) => void) | undefined
  /** 隔离停止、重启及迟到进程事件的生命周期代次。 */
  private generation = 0
  private readonly pendingCreates = new Map<string, PendingCreate>()
  private readonly outputListeners = new Set<(event: TerminalOutputEvent) => void>()
  private readonly exitListeners = new Set<(event: TerminalExitEvent) => void>()

  onOutput(listener: (event: TerminalOutputEvent) => void): () => void {
    this.outputListeners.add(listener)
    return () => this.outputListeners.delete(listener)
  }

  onExit(listener: (event: TerminalExitEvent) => void): () => void {
    this.exitListeners.add(listener)
    return () => this.exitListeners.delete(listener)
  }

  async create(input: TerminalCreateInput, options: { strictCwd?: boolean } = {}): Promise<TerminalState> {
    /** 本次创建获准使用的 runtime 代次和端口。 */
    const runtime = await this.start()
    const port = this.requireCurrentRuntime(runtime)
    const pending = this.pendingCreates.get(input.terminalId)
    if (pending) return pending.promise

    let resolveCreate!: (state: TerminalState) => void
    let rejectCreate!: (reason: Error) => void
    const promise = new Promise<TerminalState>((resolve, reject) => {
      resolveCreate = resolve
      rejectCreate = reject
    })
    /** 当前调用登记的创建请求，用身份判断避免误删后续替换请求。 */
    const pendingCreate: PendingCreate = { promise, resolve: resolveCreate, reject: rejectCreate }
    this.pendingCreates.set(input.terminalId, pendingCreate)
    const runtimeInput: RuntimeTerminalCreateInput = options.strictCwd
      ? { ...input, strictCwd: true }
      : input
    try {
      port.postMessage({ type: 'terminal.create', input: runtimeInput })
    } catch (error) {
      if (this.pendingCreates.get(input.terminalId) === pendingCreate) {
        this.pendingCreates.delete(input.terminalId)
      }
      rejectCreate(error instanceof Error ? error : new Error(String(error)))
    }
    return promise
  }

  async input(input: TerminalInput): Promise<void> {
    /** 本次输入获准使用的 runtime 代次和端口。 */
    const runtime = await this.start()
    this.requireCurrentRuntime(runtime).postMessage({ type: 'terminal.input', input })
  }

  async resize(input: TerminalResizeInput): Promise<void> {
    /** 本次尺寸更新获准使用的 runtime 代次和端口。 */
    const runtime = await this.start()
    this.requireCurrentRuntime(runtime).postMessage({ type: 'terminal.resize', input })
  }

  acknowledgeOutput(input: TerminalOutputAck): void {
    this.port?.postMessage({ type: 'terminal.ack-output', input })
  }

  kill(terminalId: string): void {
    this.port?.postMessage({ type: 'terminal.kill', terminalId })
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise
    if (!this.runtimeLifecycle && !this.starting) return
    this.generation += 1
    /** 本次停止拥有的端口、生命周期与尚未完成的启动。 */
    const port = this.port
    const lifecycle = this.runtimeLifecycle
    const pendingStart = this.starting
    /** 在清理共享字段前捕获启动拒绝入口。 */
    const cancelStarting = this.cancelStarting
    this.port = undefined
    this.starting = undefined
    this.cancelStarting = undefined
    /** 停止先拒绝业务请求，再等待操作系统的实际 exit。 */
    const stopping = (async (): Promise<void> => {
      if (port) {
        try { port.postMessage({ type: 'terminal.shutdown' }) } catch { /* 端口可能已由 runtime 关闭 */ }
        try { port.close() } catch { /* 端口可能已关闭 */ }
      }
      /** 创建与启动均立即得到相同的停止原因。 */
      const stoppedError = new Error('终端运行时已停止')
      cancelStarting?.(stoppedError)
      this.rejectPendingCreates(stoppedError)
      await lifecycle?.stop()
      await pendingStart?.promise.catch(() => {})
      // 超时或终止失败会保留句柄，后续只能重新收尾，不能覆盖仍存活的进程。
      if (this.runtimeLifecycle === lifecycle) {
        this.runtimeLifecycle = undefined
        this.runtimeProcess = undefined
      }
    })()
    this.stopPromise = stopping
    try {
      await stopping
    } finally {
      if (this.stopPromise === stopping) this.stopPromise = undefined
    }
  }

  private async start(): Promise<RuntimeLease> {
    if (this.stopPromise) throw new Error('终端运行时正在停止')
    // 启动失败遗留的句柄必须先完成回收；并行 create 则继续共用在途启动。
    if (this.runtimeLifecycle && !this.port && !this.starting) await this.stop()
    if (this.port) return { generation: this.generation, port: this.port }

    /** 当前调用等待的启动代次，防止旧调用借用随后替换的新端口。 */
    let starting = this.starting
    if (!starting) {
      const generation = ++this.generation
      starting = { generation, promise: this.startRuntime(generation) }
      this.starting = starting
    }
    try {
      await starting.promise
    } catch (error) {
      if (!this.stopPromise && this.runtimeLifecycle) await this.stop()
      throw error
    } finally {
      if (this.starting === starting) this.starting = undefined
    }
    const port = this.port
    if (starting.generation !== this.generation || !port) {
      throw new Error('终端运行时已停止')
    }
    return { generation: starting.generation, port }
  }

  /** 验证异步启动后 runtime 所有权仍有效，禁止旧调用向替换代次发送消息。 */
  private requireCurrentRuntime(runtime: RuntimeLease): RuntimePort {
    if (runtime.generation !== this.generation || this.port !== runtime.port) {
      throw new Error('终端运行时已停止')
    }
    return runtime.port
  }

  /** 启动指定代次的终端 runtime，并拒绝迟到事件影响替换代次。 */
  private async startRuntime(generation: number): Promise<void> {
    /** 终端 utility process 入口。 */
    const entryPath = join(__dirname, 'terminal-runtime.cjs')
    /** 判断启动及其事件是否仍属于当前代次。 */
    const isCurrentStartup = () => generation === this.generation
    /** 当前代次启动的终端 utility process。 */
    const { runtimeProcess, lifecycle } = await startUtilityProcessWithRetry(
      () => {
        /** fork 返回时立刻监听 spawn/exit，覆盖 await 前的取消窗口。 */
        const runtimeProcess = utilityProcess.fork(entryPath, [], { serviceName: 'Proma Terminal Runtime' })
        /** 当前进程的唯一生命周期追踪对象。 */
        const createdLifecycle = createUtilityProcessLifecycle(runtimeProcess)
        this.runtimeProcess = runtimeProcess
        this.runtimeLifecycle = createdLifecycle
        return { runtimeProcess, lifecycle: createdLifecycle }
      },
      { shouldContinue: isCurrentStartup },
    )
    if (!isCurrentStartup()) {
      await lifecycle.stop()
      throw new Error('终端运行时启动已取消')
    }

    await new Promise<void>((resolve, reject) => {
      const channel = new MessageChannelMain()
      const port = channel.port2 as unknown as RuntimePort
      /** 当前启动是否已经完成或失败。 */
      let settled = false
      /** 复核事件仍来自当前进程、端口和代次。 */
      const isCurrentRuntime = () => (
        generation === this.generation
        && this.runtimeProcess === runtimeProcess
        && this.port === port
      )
      /** 结束本代次启动，并仅在仍持有所有权时清理共享字段。 */
      const fail = (error: Error): void => {
        /** ready 尚未完成时才需要拒绝握手 Promise。 */
        const rejectStartup = !settled
        if (rejectStartup) {
          settled = true
          clearTimeout(timeout)
          if (this.cancelStarting === cancelStartup) this.cancelStarting = undefined
        }
        if (isCurrentRuntime()) this.handleRuntimeFailure(error, runtimeProcess, port)
        if (rejectStartup) reject(error)
      }
      const timeout = setTimeout(() => {
        if (this.port !== port) return
        fail(new Error('终端运行时启动超时'))
      }, STARTUP_TIMEOUT_MS)
      const ready = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        if (this.cancelStarting === cancelStartup) this.cancelStarting = undefined
        resolve()
      }
      /** stop 用于主动拒绝本代次 ready 握手的函数。 */
      const cancelStartup = (error: Error): void => fail(error)
      this.cancelStarting = cancelStartup
      this.port = port
      port.on('message', ({ data }) => {
        if (!isCurrentRuntime()) return
        const message = data as RuntimeMessage
        if (message?.type === 'terminal.ready') ready()
        this.handleMessage(message)
      })
      port.start()
      runtimeProcess.on('error', (type) => fail(new Error(`终端运行时错误：${type}`)))
      const processEvents = runtimeProcess as unknown as { on(event: 'exit', listener: (code: number) => void): void }
      processEvents.on('exit', (code) => fail(new Error(`终端运行时已退出（${code}）`)))
      runtimeProcess.postMessage({ type: 'proma-terminal-runtime-port' }, [channel.port1])
    })
  }

  private handleMessage(message: RuntimeMessage): void {
    if (message.type === 'terminal.created') {
      const pending = this.pendingCreates.get(message.state.terminalId)
      this.pendingCreates.delete(message.state.terminalId)
      pending?.resolve(message.state)
    } else if (message.type === 'terminal.error') {
      const pending = this.pendingCreates.get(message.terminalId)
      this.pendingCreates.delete(message.terminalId)
      pending?.reject(new Error(message.message))
    } else if (message.type === 'terminal.output') {
      for (const listener of this.outputListeners) listener(message.event)
    } else if (message.type === 'terminal.exit') {
      for (const listener of this.exitListeners) listener(message.event)
    }
  }

  private handleRuntimeFailure(
    error: Error,
    runtimeProcess: UtilityProcess | undefined = this.runtimeProcess,
    port: RuntimePort | undefined = this.port,
  ): void {
    if (this.runtimeProcess !== runtimeProcess || this.port !== port) return
    this.rejectPendingCreates(error)
    // 失败与主动停止共用同一退出屏障，迟到事件不能遗留或替换旧进程。
    void this.stop().catch((shutdownError: unknown) => {
      console.warn('[TerminalRuntime] 失败后的进程收尾未完成:', shutdownError)
    })
  }

  private rejectPendingCreates(error: Error): void {
    for (const pending of this.pendingCreates.values()) pending.reject(error)
    this.pendingCreates.clear()
  }
}

export const terminalRuntimeClient = new TerminalRuntimeClient()
