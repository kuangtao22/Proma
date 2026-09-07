import { randomUUID } from 'node:crypto'
import { parseServerOpsConsoleAck, parseServerOpsConsoleIdentity, parseServerOpsConsoleInput,
  parseServerOpsConsoleResizeInput, parseServerOpsConsoleStartInput } from '@proma/shared'
import type { ServerOpsConsoleAck, ServerOpsConsoleExitEvent, ServerOpsConsoleIdentity, ServerOpsConsoleInput,
  ServerOpsConsoleOutputEvent, ServerOpsConsoleResizeInput, ServerOpsConsoleStartInput } from '@proma/shared'
import type { ServerOpsActiveConnectionIdentity, ServerOpsConnectionConsoleExitEvent,
  ServerOpsConnectionConsoleOutputEvent } from './server-ops-connection-service'

interface ServerOpsDockerConsoleConnection {
  getActiveIdentity(hostId: string): ServerOpsActiveConnectionIdentity
  startConsole(identity: ServerOpsActiveConnectionIdentity, consoleId: string, containerId: string, cols: number, rows: number): Promise<ServerOpsConsoleIdentity>
  stopConsole(input: ServerOpsConsoleIdentity): Promise<void>
  writeConsole(input: ServerOpsConsoleInput): void
  resizeConsole(input: ServerOpsConsoleResizeInput): void
  acknowledgeConsole(input: ServerOpsConsoleAck): void
  onConsoleOutput(listener: (event: ServerOpsConnectionConsoleOutputEvent) => void): () => void
  onConsoleExit(listener: (event: ServerOpsConnectionConsoleExitEvent) => void): () => void
}

export interface ServerOpsDockerConsoleServiceDependencies {
  connection: ServerOpsDockerConsoleConnection
  publishOutput(ownerId: number, event: ServerOpsConsoleOutputEvent): void
  publishExit(ownerId: number, event: ServerOpsConsoleExitEvent): void
  uuid?: () => string
}

interface OwnedConsole {
  ownerId: number
  generation: number
  session: ServerOpsConsoleIdentity
}

/** 按 BrowserWindow owner 编排独立 Docker Console 生命周期。 */
export class ServerOpsDockerConsoleService {
  private readonly consoles = new Map<string, OwnedConsole>()
  private readonly ownerConsoles = new Map<number, string>()
  private readonly pendingOutput = new Map<string, ServerOpsConsoleOutputEvent>()
  private readonly closing = new Map<string, Promise<void>>()
  private readonly uuid: () => string
  private readonly disposeOutput: () => void
  private readonly disposeExit: () => void
  /** dispose 后服务进入终态，禁止创建新的远程 Console。 */
  private disposed = false

  constructor(private readonly dependencies: ServerOpsDockerConsoleServiceDependencies) {
    this.uuid = dependencies.uuid ?? randomUUID
    this.disposeOutput = dependencies.connection.onConsoleOutput((event) => this.handleOutput(event))
    this.disposeExit = dependencies.connection.onConsoleExit((event) => this.handleExit(event))
  }

  /** 每个主窗口最多启动一个 Console，启动前绑定当前 SSH generation。 */
  async start(ownerId: number, input: ServerOpsConsoleStartInput): Promise<ServerOpsConsoleIdentity> {
    this.assertOwner(ownerId)
    if (this.disposed) throw new Error('SERVER_OPS_CONSOLE_UNAVAILABLE')
    const parsed = parseServerOpsConsoleStartInput(input)
    if (this.ownerConsoles.has(ownerId)) throw new Error('SERVER_OPS_CONSOLE_BUSY')
    const identity = this.dependencies.connection.getActiveIdentity(parsed.hostId)
    const consoleId = this.uuid()
    const session = { consoleId, hostId: identity.hostId, connectionId: identity.connectionId, containerId: parsed.containerId }
    const owned = { ownerId, generation: identity.generation, session }
    this.ownerConsoles.set(ownerId, consoleId)
    this.consoles.set(consoleId, owned)
    try {
      const started = await this.dependencies.connection.startConsole(identity, consoleId, parsed.containerId, parsed.cols, parsed.rows)
      if (!this.sameIdentity(session, started) || !this.isCurrent(owned)) throw new Error('SERVER_OPS_CONSOLE_CONNECTION_CHANGED')
      return { ...started }
    } catch (error) {
      /** 只有仍归本服务且尚未进入关闭单飞的 session 需要补发 stop。 */
      const shouldStop = this.consoles.get(consoleId) === owned && !this.closing.has(consoleId)
      this.remove(owned)
      if (shouldStop) {
        try { await this.dependencies.connection.stopConsole(session) } catch { /* 启动失败清理不覆盖原错误。 */ }
      }
      throw error
    }
  }

  write(ownerId: number, input: ServerOpsConsoleInput): void {
    const parsed = parseServerOpsConsoleInput(input)
    this.requireOwned(ownerId, parsed)
    this.dependencies.connection.writeConsole(parsed)
  }

  resize(ownerId: number, input: ServerOpsConsoleResizeInput): void {
    const parsed = parseServerOpsConsoleResizeInput(input)
    this.requireOwned(ownerId, parsed)
    this.dependencies.connection.resizeConsole(parsed)
  }

  acknowledge(ownerId: number, input: ServerOpsConsoleAck): void {
    const parsed = parseServerOpsConsoleAck(input)
    this.requireOwned(ownerId, parsed)
    const pending = this.pendingOutput.get(parsed.consoleId)
    if (pending?.sequence === parsed.sequence) this.pendingOutput.delete(parsed.consoleId)
    this.dependencies.connection.acknowledgeConsole(parsed)
  }

  getSnapshot(ownerId: number, input: ServerOpsConsoleIdentity): ServerOpsConsoleOutputEvent | undefined {
    const parsed = parseServerOpsConsoleIdentity(input)
    this.requireOwned(ownerId, parsed)
    const pending = this.pendingOutput.get(parsed.consoleId)
    return pending && this.sameIdentity(pending, parsed) ? { ...pending } : undefined
  }

  async close(ownerId: number, input: ServerOpsConsoleIdentity): Promise<void> {
    const parsed = parseServerOpsConsoleIdentity(input)
    const owned = this.findOwned(ownerId, parsed)
    const existing = this.closing.get(parsed.consoleId)
    if (existing) return await existing
    const closing = this.dependencies.connection.stopConsole(parsed).finally(() => {
      this.closing.delete(parsed.consoleId)
      this.remove(owned)
    })
    this.closing.set(parsed.consoleId, closing)
    return await closing
  }

  disposeOwner(ownerId: number): void {
    const consoleId = this.ownerConsoles.get(ownerId)
    const owned = consoleId ? this.consoles.get(consoleId) : undefined
    if (!owned) return
    void this.close(ownerId, owned.session).catch(() => this.remove(owned))
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.disposeOutput(); this.disposeExit()
    for (const ownerId of [...this.ownerConsoles.keys()]) this.disposeOwner(ownerId)
  }

  private handleOutput(event: ServerOpsConnectionConsoleOutputEvent): void {
    const owned = this.consoles.get(event.consoleId)
    if (!owned || owned.generation !== event.generation || !this.sameIdentity(owned.session, event) || !this.isCurrent(owned)) return
    const output = { consoleId: event.consoleId, hostId: event.hostId, connectionId: event.connectionId,
      containerId: event.containerId, sequence: event.sequence, data: event.data }
    this.pendingOutput.set(event.consoleId, output)
    try { this.dependencies.publishOutput(owned.ownerId, { ...output }) } catch { /* 窗口销毁由 disposeOwner 统一收口。 */ }
  }

  private handleExit(event: ServerOpsConnectionConsoleExitEvent): void {
    const owned = this.consoles.get(event.consoleId)
    if (!owned || owned.generation !== event.generation || !this.sameIdentity(owned.session, event)) return
    this.remove(owned)
    const exit = { consoleId: event.consoleId, hostId: event.hostId, connectionId: event.connectionId,
      containerId: event.containerId, ...(event.exitCode === undefined ? {} : { exitCode: event.exitCode }),
      ...(event.signal === undefined ? {} : { signal: event.signal }), message: event.message }
    try { this.dependencies.publishExit(owned.ownerId, exit) } catch { /* 已销毁窗口无需继续发布。 */ }
  }

  private requireOwned(ownerId: number, input: ServerOpsConsoleIdentity): OwnedConsole {
    const owned = this.findOwned(ownerId, input)
    if (!this.isCurrent(owned)) throw new Error('SERVER_OPS_CONSOLE_NOT_ACTIVE')
    return owned
  }

  private findOwned(ownerId: number, input: ServerOpsConsoleIdentity): OwnedConsole {
    this.assertOwner(ownerId)
    const owned = this.consoles.get(input.consoleId)
    if (!owned || owned.ownerId !== ownerId || !this.sameIdentity(owned.session, input)) {
      throw new Error('SERVER_OPS_CONSOLE_NOT_ACTIVE')
    }
    return owned
  }

  private isCurrent(owned: OwnedConsole): boolean {
    if (this.disposed || this.consoles.get(owned.session.consoleId) !== owned
      || this.ownerConsoles.get(owned.ownerId) !== owned.session.consoleId
      || this.closing.has(owned.session.consoleId)) return false
    try {
      const current = this.dependencies.connection.getActiveIdentity(owned.session.hostId)
      return current.connectionId === owned.session.connectionId && current.generation === owned.generation
    } catch { return false }
  }

  private sameIdentity(left: ServerOpsConsoleIdentity, right: ServerOpsConsoleIdentity): boolean {
    return left.consoleId === right.consoleId && left.hostId === right.hostId && left.connectionId === right.connectionId
      && left.containerId === right.containerId
  }

  private remove(owned: OwnedConsole): void {
    if (this.consoles.get(owned.session.consoleId) === owned) this.consoles.delete(owned.session.consoleId)
    if (this.ownerConsoles.get(owned.ownerId) === owned.session.consoleId) this.ownerConsoles.delete(owned.ownerId)
    this.pendingOutput.delete(owned.session.consoleId)
  }

  private assertOwner(ownerId: number): void {
    if (!Number.isSafeInteger(ownerId) || ownerId < 1) throw new Error('SERVER_OPS_CONSOLE_OWNER_INVALID')
  }
}
