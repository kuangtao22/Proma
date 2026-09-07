import type { ServerOpsConsoleAck, ServerOpsConsoleExitEvent, ServerOpsConsoleIdentity, ServerOpsConsoleInput, ServerOpsConsoleOutputEvent, ServerOpsConsoleResizeInput } from '@proma/shared'
import { acknowledgeRuntimeOutput, createRuntimeOutputState, enqueueRuntimeOutput, takeRuntimeOutput } from './server-ops-runtime-core'

/** 固定 Docker 环境与 socket，禁止继承用户远程环境中的 context/TLS 配置。 */
export const SERVER_OPS_DOCKER_CONSOLE_COMMAND_PREFIX = 'LC_ALL=C env -u DOCKER_HOST -u DOCKER_CONTEXT -u DOCKER_TLS -u DOCKER_TLS_VERIFY -u DOCKER_CERT_PATH -u DOCKER_CONFIG -u DOCKER_API_VERSION docker --host unix:///var/run/docker.sock'

export interface ServerOpsConsoleRuntimeStart extends ServerOpsConsoleIdentity { cols: number; rows: number }
export type ServerOpsConsoleRuntimeMessage =
  | { type: 'server-ops.console-started'; session: ServerOpsConsoleIdentity }
  | { type: 'server-ops.console-output'; event: ServerOpsConsoleOutputEvent }
  | { type: 'server-ops.console-exit'; event: ServerOpsConsoleExitEvent }

export interface ServerOpsConsoleRuntimeChannel {
  write(data: string): void
  setWindow(rows: number, cols: number, height: number, width: number): void
  onData(listener: (data: Buffer | string) => void): void
  onStderrData(listener: (data: Buffer | string) => void): void
  onceExit(listener: (code: number | null, signal?: string) => void): void
  onceClose(listener: () => void): void
  close(): void
}

export interface ServerOpsConsoleRuntimeControllerDependencies<TTimer> {
  execute(command: string, options: { pty: { term: string; cols: number; rows: number } }, callback: (error?: Error, channel?: ServerOpsConsoleRuntimeChannel) => void): void
  post(message: ServerOpsConsoleRuntimeMessage): void
  setTimer(callback: () => void, delayMs: number): TTimer
  clearTimer(timer: TTimer): void
}

interface ManagedConsole<TTimer> {
  identity: ServerOpsConsoleIdentity
  channel: ServerOpsConsoleRuntimeChannel
  output: ReturnType<typeof createRuntimeOutputState>
  flushTimer?: TTimer
  exitEvent?: ServerOpsConsoleExitEvent
}

/** 管理单条 SSH 连接上的独立 Docker Console channels。 */
export class ServerOpsConsoleRuntimeController<TTimer> {
  private readonly consoles = new Map<string, ManagedConsole<TTimer>>()
  private disposed = false

  constructor(private readonly dependencies: ServerOpsConsoleRuntimeControllerDependencies<TTimer>) {}

  /** 使用固定 shell 和独立 PTY 打开容器 Console。 */
  start(input: ServerOpsConsoleRuntimeStart): void {
    if (this.disposed || this.consoles.has(input.consoleId)) {
      this.postExit(input, '容器终端无法启动')
      return
    }
    const command = `${SERVER_OPS_DOCKER_CONSOLE_COMMAND_PREFIX} container exec -it -- ${input.containerId} /bin/sh`
    this.dependencies.execute(command, { pty: { term: 'xterm-256color', cols: input.cols, rows: input.rows } }, (error, channel) => {
      if (this.disposed || error || !channel || this.consoles.has(input.consoleId)) {
        channel?.close()
        this.postExit(input, '容器终端无法启动')
        return
      }
      const identity = this.identity(input)
      const managed: ManagedConsole<TTimer> = { identity, channel, output: createRuntimeOutputState() }
      this.consoles.set(identity.consoleId, managed)
      channel.onData((data) => this.enqueue(managed, data.toString()))
      channel.onStderrData((data) => this.enqueue(managed, data.toString()))
      channel.onceExit((code, signal) => {
        managed.exitEvent = { ...identity, ...(typeof code === 'number' ? { exitCode: code } : {}),
          ...(signal ? { signal } : {}), message: '容器终端已退出' }
      })
      channel.onceClose(() => this.closeManaged(managed, managed.exitEvent?.message ?? '容器终端已关闭'))
      this.dependencies.post({ type: 'server-ops.console-started', session: identity })
    })
  }

  write(input: ServerOpsConsoleInput): void { this.match(input)?.channel.write(input.data) }
  resize(input: ServerOpsConsoleResizeInput): void { this.match(input)?.channel.setWindow(input.rows, input.cols, 0, 0) }
  stop(input: ServerOpsConsoleIdentity): void { this.match(input)?.channel.close() }

  acknowledge(input: ServerOpsConsoleAck): void {
    const managed = this.match(input)
    if (!managed) return
    if (acknowledgeRuntimeOutput(managed.output, input.sequence)) this.flush(managed)
    this.emitExitWhenDrained(managed)
  }

  dispose(message = 'SSH 连接已关闭'): void {
    this.disposed = true
    for (const managed of [...this.consoles.values()]) {
      try { managed.channel.close() } catch { /* channel 已关闭时继续本地收口。 */ }
      this.closeManaged(managed, message)
    }
  }

  private identity(input: ServerOpsConsoleIdentity): ServerOpsConsoleIdentity {
    return { consoleId: input.consoleId, hostId: input.hostId, connectionId: input.connectionId, containerId: input.containerId }
  }

  private match(input: ServerOpsConsoleIdentity): ManagedConsole<TTimer> | undefined {
    const managed = this.consoles.get(input.consoleId)
    return managed && managed.identity.hostId === input.hostId && managed.identity.connectionId === input.connectionId
      && managed.identity.containerId === input.containerId ? managed : undefined
  }

  private enqueue(managed: ManagedConsole<TTimer>, data: string): void {
    if (this.consoles.get(managed.identity.consoleId) !== managed) return
    enqueueRuntimeOutput(managed.output, data)
    if (!managed.flushTimer) managed.flushTimer = this.dependencies.setTimer(() => this.flush(managed), 16)
  }

  private flush(managed: ManagedConsole<TTimer>): void {
    if (managed.flushTimer) this.dependencies.clearTimer(managed.flushTimer)
    managed.flushTimer = undefined
    const output = takeRuntimeOutput(managed.output, managed.identity.hostId, managed.identity.connectionId)
    if (output) this.dependencies.post({ type: 'server-ops.console-output', event: { ...managed.identity, sequence: output.sequence, data: output.data } })
  }

  private closeManaged(managed: ManagedConsole<TTimer>, message: string): void {
    if (this.consoles.get(managed.identity.consoleId) !== managed) return
    this.flush(managed)
    managed.exitEvent ??= { ...managed.identity, message }
    this.emitExitWhenDrained(managed)
  }

  private emitExitWhenDrained(managed: ManagedConsole<TTimer>): void {
    if (!managed.exitEvent || managed.output.inFlight || managed.output.pending || managed.output.droppedChars > 0) return
    this.consoles.delete(managed.identity.consoleId)
    this.dependencies.post({ type: 'server-ops.console-exit', event: managed.exitEvent })
  }

  private postExit(identity: ServerOpsConsoleIdentity, message: string): void {
    this.dependencies.post({ type: 'server-ops.console-exit', event: { ...this.identity(identity), message } })
  }
}
