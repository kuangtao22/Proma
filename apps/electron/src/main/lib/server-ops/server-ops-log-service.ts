import {
  parseServerOpsLogIdentity,
  parseServerOpsLogOutputAck,
  parseServerOpsLogStartInput,
  type ServerOpsLogSince,
  type ServerOpsLogStartInput,
} from '@proma/shared'
import type {
  ServerOpsConnectionState,
  ServerOpsLogExitEvent,
  ServerOpsLogIdentity,
  ServerOpsLogOutputAck,
  ServerOpsLogOutputEvent,
  ServerOpsLogStartResult,
} from '@proma/shared'
import type {
  ServerOpsActiveConnectionIdentity,
  ServerOpsConnectionLogExitEvent,
  ServerOpsConnectionLogOutputEvent,
} from './server-ops-connection-service'

/** Log Service 可见的最小连接边界。 */
export interface ServerOpsLogConnection {
  getActiveIdentity(hostId: string): ServerOpsActiveConnectionIdentity
  startLog(identity: ServerOpsActiveConnectionIdentity, streamId: string, command: string): Promise<void>
  stopLog(identity: ServerOpsActiveConnectionIdentity, streamId: string): void
  acknowledgeLog(identity: ServerOpsActiveConnectionIdentity, streamId: string, sequence: number): void
  onState(listener: (state: ServerOpsConnectionState) => void): () => void
  onLogOutput(listener: (event: ServerOpsConnectionLogOutputEvent) => void): () => void
  onLogExit(listener: (event: ServerOpsConnectionLogExitEvent) => void): () => void
}

/** Log Service 可替换依赖。 */
export interface ServerOpsLogServiceDependencies {
  connection: ServerOpsLogConnection
  uuid: () => string
}

/** 一个 main owner 当前独占的日志流。 */
interface OwnedLogStream {
  ownerKey: string
  identity: ServerOpsActiveConnectionIdentity
  streamId: string
}

/** journalctl 时间范围的固定参数。 */
const JOURNAL_SINCE_ARGUMENTS: Record<ServerOpsLogSince, string> = {
  '15m': "--since='-15 minutes'",
  '1h': "--since='-1 hour'",
  '6h': "--since='-6 hours'",
  '24h': "--since='-24 hours'",
  boot: '--boot',
}

/** 将已验证文本仍以 POSIX 单引号安全形式嵌入 shell。 */
function quotePosix(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

/** 从严格 Shared 输入构造唯一 journalctl 命令模板。 */
function buildJournalCommand(input: ServerOpsLogStartInput): string {
  /** 只有 unit 来源附加受控的 systemd unit 参数。 */
  const unitArgument = input.source.kind === 'unit' ? ` --unit=${quotePosix(input.source.unitId)}` : ''
  return `LC_ALL=C journalctl --no-pager --output=short-iso-precise --priority=${input.priority} --lines=${input.tailLines} ${JOURNAL_SINCE_ARGUMENTS[input.since]}${unitArgument} --follow`
}

/** 按 main owner 管理日志流，公开边界不暴露 connectionId。 */
export class ServerOpsLogService {
  /** 可替换连接与 ID 依赖。 */
  private readonly dependencies: ServerOpsLogServiceDependencies
  /** 每个 owner 最多一条 pending 或 active 流。 */
  private readonly streamsByOwner = new Map<string, OwnedLogStream>()
  /** streamId 反查 owner，使高频输出保持 O(1)。 */
  private readonly ownersByStream = new Map<string, string>()
  /** 公开日志输出订阅者。 */
  private readonly outputListeners = new Set<(event: ServerOpsLogOutputEvent) => void>()
  /** 公开日志终态订阅者。 */
  private readonly exitListeners = new Set<(event: ServerOpsLogExitEvent) => void>()
  /** 三类上游订阅清理器。 */
  private readonly disposers: Array<() => void>

  constructor(dependencies: ServerOpsLogServiceDependencies) {
    this.dependencies = dependencies
    this.disposers = [
      dependencies.connection.onState((state) => this.handleConnectionState(state)),
      dependencies.connection.onLogOutput((event) => this.handleOutput(event)),
      dependencies.connection.onLogExit((event) => this.handleExit(event)),
    ]
  }

  /** 严格解析查询并在 runtime started 后复核连接代次。 */
  async start(ownerKey: string, input: ServerOpsLogStartInput): Promise<ServerOpsLogStartResult> {
    this.assertOwnerKey(ownerKey)
    /** 不信任上层 TypeScript 类型，再次经 Shared exact-key parser 重建。 */
    const parsed = parseServerOpsLogStartInput(input)
    const previous = this.streamsByOwner.get(ownerKey)
    if (previous) this.finishOwnedStream(previous, 'stopped', true)
    /** 旧 owner 流收口后，fresh-read 新主机的连接所有权。 */
    const identity = this.dependencies.connection.getActiveIdentity(parsed.hostId)
    /** 新流 ID 只在 main 内部生成。 */
    const streamId = this.dependencies.uuid()
    /** pending 期间即占用 owner，使后发 start 可取消它。 */
    const owned: OwnedLogStream = { ownerKey, identity: { ...identity }, streamId }
    this.streamsByOwner.set(ownerKey, owned)
    this.ownersByStream.set(streamId, ownerKey)
    try {
      await this.dependencies.connection.startLog(identity, streamId, buildJournalCommand(parsed))
    } catch (error) {
      this.removeIfCurrent(owned)
      throw error
    }
    /** await 后必须同时复核 owner 与 fresh 连接代次。 */
    if (this.streamsByOwner.get(ownerKey) !== owned) {
      this.dependencies.connection.stopLog(identity, streamId)
      throw new Error('SERVER_OPS_LOG_START_SUPERSEDED')
    }
    let fresh: ServerOpsActiveConnectionIdentity
    try {
      fresh = this.dependencies.connection.getActiveIdentity(parsed.hostId)
    } catch {
      this.dependencies.connection.stopLog(identity, streamId)
      this.removeIfCurrent(owned)
      throw new Error('SERVER_OPS_LOG_CONNECTION_CHANGED')
    }
    if (!this.identitiesEqual(identity, fresh)) {
      this.dependencies.connection.stopLog(identity, streamId)
      this.removeIfCurrent(owned)
      throw new Error('SERVER_OPS_LOG_CONNECTION_CHANGED')
    }
    return { hostId: parsed.hostId, streamId }
  }

  /** 停止指定 owner 当前且属于当前连接代次的流。 */
  stop(ownerKey: string, input: ServerOpsLogIdentity): void {
    const parsed = parseServerOpsLogIdentity(input)
    const owned = this.streamsByOwner.get(ownerKey)
    if (!owned || owned.streamId !== parsed.streamId || owned.identity.hostId !== parsed.hostId) return
    if (!this.isFresh(owned.identity)) return
    this.finishOwnedStream(owned, 'stopped', true)
  }

  /** 只转发当前 owner、stream、generation 与 sequence 的精确 ACK。 */
  acknowledge(ownerKey: string, input: ServerOpsLogOutputAck): void {
    const parsed = parseServerOpsLogOutputAck(input)
    const owned = this.streamsByOwner.get(ownerKey)
    if (!owned || owned.streamId !== parsed.streamId || owned.identity.hostId !== parsed.hostId) return
    if (!this.isFresh(owned.identity)) return
    this.dependencies.connection.acknowledgeLog(owned.identity, owned.streamId, parsed.sequence)
  }

  /** 释放一个 main owner 的日志流。 */
  disposeOwner(ownerKey: string): void {
    const owned = this.streamsByOwner.get(ownerKey)
    if (owned) this.finishOwnedStream(owned, 'stopped', this.isFresh(owned.identity))
  }

  /** 订阅不含连接 ID 的公开日志输出。 */
  onOutput(listener: (event: ServerOpsLogOutputEvent) => void): () => void {
    this.outputListeners.add(listener)
    return () => this.outputListeners.delete(listener)
  }

  /** 订阅不含连接 ID 的公开日志终态。 */
  onExit(listener: (event: ServerOpsLogExitEvent) => void): () => void {
    this.exitListeners.add(listener)
    return () => this.exitListeners.delete(listener)
  }

  /** 释放所有 owner 与上游订阅。 */
  dispose(): void {
    for (const owned of [...this.streamsByOwner.values()]) this.finishOwnedStream(owned, 'stopped', this.isFresh(owned.identity))
    for (const dispose of this.disposers) dispose()
    this.outputListeners.clear()
    this.exitListeners.clear()
  }

  /** 连接离开捕获代次时立即公开 connection-closed。 */
  private handleConnectionState(state: ServerOpsConnectionState): void {
    for (const owned of [...this.streamsByOwner.values()]) {
      if (owned.identity.hostId !== state.hostId) continue
      if (state.phase === 'connected' && this.isFresh(owned.identity)) continue
      this.finishOwnedStream(owned, 'connection-closed', false)
    }
  }

  /** 将 main 内部日志输出映射为 Shared 公开 DTO。 */
  private handleOutput(event: ServerOpsConnectionLogOutputEvent): void {
    const owned = this.findOwnedStream(event.streamId)
    if (!owned || !this.matchesEvent(owned, event)) return
    /** 公开事件显式不构造 connectionId 与 generation。 */
    const output: ServerOpsLogOutputEvent = { hostId: event.hostId, streamId: event.streamId, sequence: event.sequence, data: event.data }
    for (const listener of this.outputListeners) {
      try { listener({ ...output }) } catch { /* 单个订阅者不能阻断其它 owner 消费。 */ }
    }
  }

  /** 将 runtime 终态幂等映射为 Shared 公开 DTO。 */
  private handleExit(event: ServerOpsConnectionLogExitEvent): void {
    const owned = this.findOwnedStream(event.streamId)
    if (!owned || !this.matchesEvent(owned, event)) return
    this.finishOwnedStream(owned, event.reason, false, event.errorCode)
  }

  /** 根据 streamId 常数时间找到当前 owner 流。 */
  private findOwnedStream(streamId: string): OwnedLogStream | undefined {
    const ownerKey = this.ownersByStream.get(streamId)
    return ownerKey ? this.streamsByOwner.get(ownerKey) : undefined
  }

  /** 只接纳 host、connection、generation 与 stream 完全一致的事件。 */
  private matchesEvent(owned: OwnedLogStream, event: ServerOpsConnectionLogOutputEvent | ServerOpsConnectionLogExitEvent): boolean {
    return owned.streamId === event.streamId
      && owned.identity.hostId === event.hostId
      && owned.identity.connectionId === event.connectionId
      && owned.identity.generation === event.generation
  }

  /** 幂等移除 owner/stream 双向索引并发布一次终态。 */
  private finishOwnedStream(owned: OwnedLogStream, reason: ServerOpsLogExitEvent['reason'], stopRuntime: boolean, errorCode?: string): void {
    if (!this.removeIfCurrent(owned)) return
    if (stopRuntime) this.dependencies.connection.stopLog(owned.identity, owned.streamId)
    /** 公开终态不含内部连接身份。 */
    const event: ServerOpsLogExitEvent = {
      hostId: owned.identity.hostId,
      streamId: owned.streamId,
      reason,
      ...(errorCode ? { errorCode } : {}),
    }
    for (const listener of this.exitListeners) {
      try { listener({ ...event }) } catch { /* 单个终态订阅者无权阻断释放。 */ }
    }
  }

  /** 仅当 owner 仍指向该对象时移除，避免迟到异步回调删除新流。 */
  private removeIfCurrent(owned: OwnedLogStream): boolean {
    if (this.streamsByOwner.get(owned.ownerKey) !== owned) return false
    this.streamsByOwner.delete(owned.ownerKey)
    if (this.ownersByStream.get(owned.streamId) === owned.ownerKey) this.ownersByStream.delete(owned.streamId)
    return true
  }

  /** 复核捕获身份是否仍为当前连接代次。 */
  private isFresh(identity: ServerOpsActiveConnectionIdentity): boolean {
    try { return this.identitiesEqual(identity, this.dependencies.connection.getActiveIdentity(identity.hostId)) } catch { return false }
  }

  /** 比较完整连接身份。 */
  private identitiesEqual(left: ServerOpsActiveConnectionIdentity, right: ServerOpsActiveConnectionIdentity): boolean {
    return left.hostId === right.hostId && left.connectionId === right.connectionId && left.generation === right.generation
  }

  /** ownerKey 只存于 main，但仍需防止空值与无界输入。 */
  private assertOwnerKey(ownerKey: string): void {
    if (!ownerKey || ownerKey.length > 256 || ownerKey.includes('\0')) throw new Error('SERVER_OPS_LOG_OWNER_INVALID')
  }
}
