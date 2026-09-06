import { randomUUID } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import type {
  ServerOpsConnectInput,
  ServerOpsConfirmHostKeyInput,
  ServerOpsConnectionState,
  ServerOpsCredentialInput,
  ServerOpsHost,
  ServerOpsHostKey,
  ServerOpsTerminalExitEvent,
  ServerOpsTerminalInput,
  ServerOpsTerminalIdentity,
  ServerOpsTerminalOutputAck,
  ServerOpsTerminalOutputEvent,
  ServerOpsTerminalResizeInput,
} from '@proma/shared'
import type { ServerOpsResolvedCredential } from './server-ops-credential-store'
import type {
  ServerOpsRuntimeConnectionInput,
  ServerOpsRuntimeLogExitEvent,
  ServerOpsRuntimeLogOutputEvent,
} from './server-ops-runtime-client'
import type { ServerOpsHostTrustResult } from './server-ops-host-trust-store'
import type { ServerOpsRuntimeConnectResult } from '../../../utility/server-ops/server-ops-runtime-protocol'
import type { ServerOpsRuntimeExecResult } from '../../../utility/server-ops/server-ops-runtime-protocol'

/** 连接 Service 所需的公开主机资产边界。 */
export interface ServerOpsConnectionHostStore {
  get: (hostId: string) => ServerOpsHost | undefined
  setCredentialRef: (hostId: string, credentialRef?: string) => ServerOpsHost
}

/** 连接 Service 所需的内部凭据边界。 */
export interface ServerOpsConnectionCredentialStore {
  setVolatile: (hostId: string, credential: ServerOpsResolvedCredential) => void
  remember: (hostId: string, credential: ServerOpsResolvedCredential) => string
  resolve: (hostId: string, credentialRef?: string) => ServerOpsResolvedCredential | undefined
  getCredentialRef: (hostId: string) => string | undefined
}

/** 连接 Service 所需的 Host Key 信任边界。 */
export interface ServerOpsConnectionTrustStore {
  get: (host: Pick<ServerOpsHost, 'address' | 'port'>) => ServerOpsHostKey | undefined
  check: (host: Pick<ServerOpsHost, 'address' | 'port'>, observed: ServerOpsHostKey) => ServerOpsHostTrustResult
  trust: (host: Pick<ServerOpsHost, 'address' | 'port'>, key: ServerOpsHostKey) => void
}

/** 连接 Service 所需的 SSH utility runtime 边界。 */
export interface ServerOpsConnectionRuntime {
  connect: (input: ServerOpsRuntimeConnectionInput) => Promise<ServerOpsRuntimeConnectResult>
  exec: (hostId: string, connectionId: string, command: string, timeoutMs: number) => Promise<ServerOpsRuntimeExecResult>
  startLog: (hostId: string, connectionId: string, streamId: string, command: string) => Promise<void>
  stopLog: (hostId: string, connectionId: string, streamId: string) => void
  acknowledgeLog: (hostId: string, connectionId: string, streamId: string, sequence: number) => void
  disconnect: (hostId: string, connectionId: string) => void
  input: (hostId: string, connectionId: string, data: string) => void
  resize: (hostId: string, connectionId: string, cols: number, rows: number) => void
  acknowledgeOutput: (input: ServerOpsTerminalOutputAck) => void
  onOutput: (listener: (event: ServerOpsTerminalOutputEvent) => void) => () => void
  onExit: (listener: (event: ServerOpsTerminalExitEvent) => void) => () => void
  onLogOutput: (listener: (event: ServerOpsRuntimeLogOutputEvent) => void) => () => void
  onLogExit: (listener: (event: ServerOpsRuntimeLogExitEvent) => void) => () => void
}

/** 连接 Service 可替换的系统与领域依赖。 */
export interface ServerOpsConnectionServiceDependencies {
  hosts: ServerOpsConnectionHostStore
  credentials: ServerOpsConnectionCredentialStore
  trust: ServerOpsConnectionTrustStore
  runtime: ServerOpsConnectionRuntime
  uuid: () => string
  resolveSshAgent: () => string
  readPrivateKey: (path: string) => Buffer
}

/** 当前活跃 SSH 连接的内部所有权身份。 */
export interface ServerOpsActiveConnectionIdentity {
  hostId: string
  connectionId: string
  generation: number
}

/** 经连接代次校验的 main 内部日志输出。 */
export interface ServerOpsConnectionLogOutputEvent extends ServerOpsRuntimeLogOutputEvent {
  generation: number
}

/** 经连接代次校验的 main 内部日志终态。 */
export interface ServerOpsConnectionLogExitEvent extends ServerOpsRuntimeLogExitEvent {
  generation: number
}

/** 首次 Host Key 候选在主进程内存中的完整绑定。 */
interface PendingHostKeyCandidate {
  candidateId: string
  hostId: string
  address: string
  port: number
  key: ServerOpsHostKey
}

/** 单台主机当前连接请求的内部所有权事实。 */
interface HostConnectionLifecycle {
  generation: number
  pendingConnectionId?: string
  activeConnectionId?: string
}

/** 读取有界私钥文件，任何失败都由上层映射为不含路径的公开错误。 */
function readPrivateKeyFile(path: string): Buffer {
  /** 支持用户常用 `~/`，但不把展开结果写日志或 DTO。 */
  const expandedPath = path === '~' ? homedir() : path.startsWith('~/') ? resolve(homedir(), path.slice(2)) : path
  /** 私钥大小上限防止误选超大文件拖垮 IPC。 */
  const size = statSync(expandedPath).size
  if (size < 1 || size > 1_048_576) throw new Error('SERVER_OPS_PRIVATE_KEY_INVALID')
  return readFileSync(expandedPath)
}

/** 编排凭据、Host Key 与独立 runtime 的真实 SSH 连接生命周期。 */
export class ServerOpsConnectionService {
  /** 完整可替换依赖。 */
  private readonly dependencies: ServerOpsConnectionServiceDependencies
  /** 当前每台主机的公开连接状态。 */
  private readonly states = new Map<string, ServerOpsConnectionState>()
  /** 每台主机的连接代次与当前在途 runtime ID。 */
  private readonly lifecycles = new Map<string, HostConnectionLifecycle>()
  /** 未确认 Host Key 候选只存在主进程内存。 */
  private readonly pendingCandidates = new Map<string, PendingHostKeyCandidate>()
  /** 连接状态订阅者。 */
  private readonly stateListeners = new Set<(state: ServerOpsConnectionState) => void>()
  /** 远程输出订阅者。 */
  private readonly outputListeners = new Set<(event: ServerOpsTerminalOutputEvent) => void>()
  /** runtime 已发出但 Renderer 尚未 ACK 的每连接输出。 */
  private readonly pendingOutput = new Map<string, ServerOpsTerminalOutputEvent>()
  /** 远程退出订阅者。 */
  private readonly exitListeners = new Set<(event: ServerOpsTerminalExitEvent) => void>()
  /** 只向 Log Service 暴露的日志输出订阅。 */
  private readonly logOutputListeners = new Set<(event: ServerOpsConnectionLogOutputEvent) => void>()
  /** 只向 Log Service 暴露的日志终态订阅。 */
  private readonly logExitListeners = new Set<(event: ServerOpsConnectionLogExitEvent) => void>()
  /** runtime 输出订阅清理器。 */
  private readonly disposeRuntimeOutput: () => void
  /** runtime 退出订阅清理器。 */
  private readonly disposeRuntimeExit: () => void
  /** runtime 日志输出订阅清理器。 */
  private readonly disposeRuntimeLogOutput: () => void
  /** runtime 日志终态订阅清理器。 */
  private readonly disposeRuntimeLogExit: () => void

  constructor(dependencies: ServerOpsConnectionServiceDependencies) {
    this.dependencies = dependencies
    this.disposeRuntimeOutput = dependencies.runtime.onOutput((event) => {
      if (!this.isActiveConnection(event.hostId, event.connectionId)) return
      this.pendingOutput.set(event.connectionId, { ...event })
      for (const listener of this.outputListeners) listener(event)
    })
    this.disposeRuntimeExit = dependencies.runtime.onExit((event) => {
      if (!this.isActiveConnection(event.hostId, event.connectionId)) return
      this.pendingOutput.delete(event.connectionId)
      /** 当前连接退出后立即撤销内部 active 所有权。 */
      const lifecycle = this.lifecycles.get(event.hostId)
      if (lifecycle) this.lifecycles.set(event.hostId, { generation: lifecycle.generation })
      this.publish({ hostId: event.hostId, phase: 'disconnected', message: event.message })
      for (const listener of this.exitListeners) listener(event)
    })
    this.disposeRuntimeLogOutput = dependencies.runtime.onLogOutput((event) => {
      /** 事件转发前 fresh-read 当前连接代次。 */
      const identity = this.tryGetActiveIdentity(event.hostId)
      if (!identity || identity.connectionId !== event.connectionId) return
      this.notifyLogOutput({ ...event, generation: identity.generation })
    })
    this.disposeRuntimeLogExit = dependencies.runtime.onLogExit((event) => {
      /** 迟到终态不能穿透到新连接代次。 */
      const identity = this.tryGetActiveIdentity(event.hostId)
      if (!identity || identity.connectionId !== event.connectionId) return
      this.notifyLogExit({ ...event, generation: identity.generation })
    })
  }

  /** 订阅公开连接状态。 */
  onState(listener: (state: ServerOpsConnectionState) => void): () => void {
    this.stateListeners.add(listener)
    return () => this.stateListeners.delete(listener)
  }

  /** 订阅远程 PTY 输出。 */
  onOutput(listener: (event: ServerOpsTerminalOutputEvent) => void): () => void {
    this.outputListeners.add(listener)
    return () => this.outputListeners.delete(listener)
  }

  /** 订阅远程 PTY 退出。 */
  onExit(listener: (event: ServerOpsTerminalExitEvent) => void): () => void {
    this.exitListeners.add(listener)
    return () => this.exitListeners.delete(listener)
  }

  /** 订阅 main 内部日志输出，事件已附带当前 generation。 */
  onLogOutput(listener: (event: ServerOpsConnectionLogOutputEvent) => void): () => void {
    this.logOutputListeners.add(listener)
    return () => this.logOutputListeners.delete(listener)
  }

  /** 订阅 main 内部日志终态。 */
  onLogExit(listener: (event: ServerOpsConnectionLogExitEvent) => void): () => void {
    this.logExitListeners.add(listener)
    return () => this.logExitListeners.delete(listener)
  }

  /** 返回指定主机当前公开连接状态。 */
  getState(hostId: string): ServerOpsConnectionState {
    return { ...(this.states.get(hostId) ?? { hostId, phase: 'disconnected' as const }) }
  }

  /** 返回指定主机当前活跃连接的独立身份副本。 */
  getActiveIdentity(hostId: string): ServerOpsActiveConnectionIdentity {
    /** fresh-read 的内部连接生命周期。 */
    const lifecycle = this.lifecycles.get(hostId)
    if (!lifecycle?.activeConnectionId) throw new Error('SERVER_OPS_CONNECTION_NOT_ACTIVE')
    return { hostId, connectionId: lifecycle.activeConnectionId, generation: lifecycle.generation }
  }

  /** 保存一次性凭据并建立真实 SSH 连接。 */
  async connect(input: ServerOpsConnectInput): Promise<ServerOpsConnectionState> {
    /** 新请求先取得独占代次，并释放同主机旧连接或旧在途请求。 */
    const generation = this.invalidateConnections(input.hostId)
    /** 每次操作 fresh-read 的主机资产。 */
    const host = this.dependencies.hosts.get(input.hostId)
    if (!host) return this.publishError(input.hostId, 'SERVER_OPS_HOST_NOT_FOUND', '服务器配置不存在')
    this.publish({ hostId: host.id, phase: 'connecting' })

    /** 本次连接的唯一归属 ID，在调用 runtime 前登记以允许同步取消。 */
    let connectionId: string | undefined
    try {
      this.acceptCredential(host, input.credential)
      /** 每次连接都从 Store fresh-read 的内部凭据。 */
      const authentication = this.resolveAuthentication(host)
      /** 当前 endpoint 已固定的 Host Key；不存在时 runtime 必须在认证前拒绝。 */
      const expectedHostKey = this.dependencies.trust.get(host)
      connectionId = this.dependencies.uuid()
      this.lifecycles.set(host.id, { generation, pendingConnectionId: connectionId })
      /** utility process 返回的 Host Key 或已打开 PTY 结果。 */
      const result = await this.dependencies.runtime.connect({
        hostId: host.id,
        connectionId,
        address: host.address,
        port: host.port,
        username: host.username,
        ...(expectedHostKey ? { expectedHostKey } : {}),
        authentication,
        cols: input.cols,
        rows: input.rows,
      })
      if (!this.isCurrentConnectionAttempt(host.id, generation, connectionId)) {
        this.disconnectRuntimeConnection(host.id, connectionId)
        return this.getState(host.id)
      }
      this.lifecycles.set(host.id, result.status === 'connected'
        ? { generation, activeConnectionId: connectionId }
        : { generation })
      return this.handleConnectResult(host, connectionId, result)
    } catch (error) {
      /** ID 生成前的同步失败只需匹配代次；runtime 启动后还必须匹配 pending ID。 */
      const isCurrentAttempt = connectionId
        ? this.isCurrentConnectionAttempt(host.id, generation, connectionId)
        : this.isCurrentGeneration(host.id, generation)
      if (!isCurrentAttempt) {
        if (connectionId) this.disconnectRuntimeConnection(host.id, connectionId)
        return this.getState(host.id)
      }
      this.lifecycles.set(host.id, { generation })
      if (isServerOpsRuntimeError(error)) return this.publishError(host.id, error.code, error.message)
      /** 领域错误只允许已知稳定码，其余统一收敛。 */
      const code = error instanceof Error && error.message.startsWith('SERVER_OPS_') ? error.message : 'SERVER_OPS_CONNECTION_FAILED'
      return this.publishError(host.id, code, getPublicErrorMessage(code))
    }
  }

  /** 在当前 SSH 连接上执行结构化非 PTY 命令。 */
  async exec(hostId: string, connectionId: string, command: string, timeoutMs: number): Promise<ServerOpsRuntimeExecResult> {
    this.assertActiveConnection(hostId, connectionId)
    if (!command || command.length > 8192 || command.includes('\0')) throw new Error('SERVER_OPS_EXEC_COMMAND_INVALID')
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) throw new Error('SERVER_OPS_EXEC_TIMEOUT_INVALID')
    return this.dependencies.runtime.exec(hostId, connectionId, command, timeoutMs)
  }

  /** 以当前连接身份启动日志，await 前后都复核 generation。 */
  async startLog(identity: ServerOpsActiveConnectionIdentity, streamId: string, command: string): Promise<void> {
    this.assertActiveIdentity(identity)
    await this.dependencies.runtime.startLog(identity.hostId, identity.connectionId, streamId, command)
    if (this.isActiveIdentity(identity)) return
    this.dependencies.runtime.stopLog(identity.hostId, identity.connectionId, streamId)
    throw new Error('SERVER_OPS_CONNECTION_CHANGED')
  }

  /** 只停止当前 generation 上的精确日志流。 */
  stopLog(identity: ServerOpsActiveConnectionIdentity, streamId: string): void {
    if (!this.isActiveIdentity(identity)) return
    this.dependencies.runtime.stopLog(identity.hostId, identity.connectionId, streamId)
  }

  /** 只确认当前 generation 上的精确日志批次。 */
  acknowledgeLog(identity: ServerOpsActiveConnectionIdentity, streamId: string, sequence: number): void {
    if (!this.isActiveIdentity(identity)) return
    this.dependencies.runtime.acknowledgeLog(identity.hostId, identity.connectionId, streamId, sequence)
  }

  /** 确认首次 Host Key，持久化固定值后使用 fresh 数据重新连接。 */
  async confirmHostKey(input: ServerOpsConfirmHostKeyInput): Promise<ServerOpsConnectionState> {
    /** 候选必须同时匹配不可枚举 ID 与目标主机。 */
    const candidate = this.pendingCandidates.get(input.candidateId)
    if (!candidate || candidate.hostId !== input.hostId) {
      return this.publishError(input.hostId, 'SERVER_OPS_HOST_KEY_CANDIDATE_EXPIRED', '服务器指纹确认已失效，请重新连接')
    }
    /** 确认时再次读取主机，endpoint 变化会使候选失效。 */
    const host = this.dependencies.hosts.get(input.hostId)
    if (!host || host.address !== candidate.address || host.port !== candidate.port) {
      this.pendingCandidates.delete(input.candidateId)
      return this.publishError(input.hostId, 'SERVER_OPS_HOST_KEY_CANDIDATE_EXPIRED', '服务器地址已变化，请重新连接')
    }
    this.dependencies.trust.trust(host, candidate.key)
    this.pendingCandidates.delete(input.candidateId)
    return this.connect({ hostId: input.hostId, cols: input.cols, rows: input.rows })
  }

  /** 主动断开指定主机当前连接。 */
  disconnect(hostId: string): ServerOpsConnectionState {
    /** 当前主机的连接快照。 */
    const current = this.states.get(hostId)
    if (current?.connectionId) {
      this.publish({ hostId, connectionId: current.connectionId, phase: 'disconnecting' })
    }
    this.invalidateConnections(hostId)
    for (const [candidateId, candidate] of this.pendingCandidates) {
      if (candidate.hostId === hostId) this.pendingCandidates.delete(candidateId)
    }
    return this.publish({ hostId, phase: 'disconnected' })
  }

  /** 向当前活跃远程 PTY 写入有界用户输入。 */
  writeTerminal(input: ServerOpsTerminalInput): void {
    this.assertActiveConnection(input.hostId, input.connectionId)
    if (!input.data || input.data.length > 65_536) throw new Error('SERVER_OPS_TERMINAL_INPUT_INVALID')
    this.dependencies.runtime.input(input.hostId, input.connectionId, input.data)
  }

  /** 调整当前活跃远程 PTY 大小。 */
  resizeTerminal(input: ServerOpsTerminalResizeInput): void {
    this.assertActiveConnection(input.hostId, input.connectionId)
    this.dependencies.runtime.resize(input.hostId, input.connectionId, input.cols, input.rows)
  }

  /** ACK 当前活跃远程 PTY 的有序输出。 */
  acknowledgeOutput(input: ServerOpsTerminalOutputAck): void {
    const current = this.states.get(input.hostId)
    if (current?.connectionId !== input.connectionId || current.phase !== 'connected') return
    /** 只有精确序号 ACK 才清除快照，避免旧 ACK 丢失新输出。 */
    const pending = this.pendingOutput.get(input.connectionId)
    if (pending?.sequence === input.sequence) this.pendingOutput.delete(input.connectionId)
    this.dependencies.runtime.acknowledgeOutput(input)
  }

  /** 返回当前连接尚未 ACK 的输出，供 Renderer 挂载竞态恢复。 */
  getTerminalSnapshot(input: ServerOpsTerminalIdentity): ServerOpsTerminalOutputEvent | undefined {
    this.assertActiveConnection(input.hostId, input.connectionId)
    /** 与调用方连接身份精确匹配的未确认输出。 */
    const pending = this.pendingOutput.get(input.connectionId)
    return pending?.hostId === input.hostId ? { ...pending } : undefined
  }

  /** 释放订阅与全部当前连接。 */
  dispose(): void {
    this.disposeRuntimeOutput()
    this.disposeRuntimeExit()
    this.disposeRuntimeLogOutput()
    this.disposeRuntimeLogExit()
    /** states 与 lifecycles 的并集覆盖活跃和仅在途的主机。 */
    const hostIds = new Set([...this.states.keys(), ...this.lifecycles.keys()])
    for (const hostId of hostIds) this.invalidateConnections(hostId)
    this.states.clear()
    this.lifecycles.clear()
    this.pendingCandidates.clear()
    this.pendingOutput.clear()
    this.stateListeners.clear()
    this.outputListeners.clear()
    this.exitListeners.clear()
    this.logOutputListeners.clear()
    this.logExitListeners.clear()
  }

  /** 验证并保存 Renderer 本次提交的短生命周期凭据。 */
  private acceptCredential(host: ServerOpsHost, input?: ServerOpsCredentialInput): void {
    if (!input) return
    if (input.kind !== host.authMethod) throw new Error('SERVER_OPS_CREDENTIAL_METHOD_MISMATCH')
    if (input.kind === 'ssh-agent') return
    /** 去掉 remember 控制字段后的内部凭据。 */
    const credential: ServerOpsResolvedCredential = input.kind === 'password'
      ? { kind: 'password', password: input.password }
      : { kind: 'private-key', keyPath: input.keyPath, ...(input.passphrase === undefined ? {} : { passphrase: input.passphrase }) }
    if (input.remember) {
      /** safeStorage 持久化后返回的非敏感引用。 */
      const credentialRef = this.dependencies.credentials.remember(host.id, credential)
      this.dependencies.hosts.setCredentialRef(host.id, credentialRef)
    } else {
      this.dependencies.credentials.setVolatile(host.id, credential)
    }
  }

  /** 将主进程凭据转换为 runtime 认证材料。 */
  private resolveAuthentication(host: ServerOpsHost): ServerOpsRuntimeConnectionInput['authentication'] {
    if (host.authMethod === 'ssh-agent') return { kind: 'ssh-agent', agent: this.dependencies.resolveSshAgent() }
    /** 先按主机记录引用，兼容刚持久化但 fresh host 快照尚未更新时再查 Store 引用。 */
    const credential = this.dependencies.credentials.resolve(host.id, host.credentialRef ?? this.dependencies.credentials.getCredentialRef(host.id))
    if (!credential || credential.kind !== host.authMethod) throw new Error('SERVER_OPS_CREDENTIAL_REQUIRED')
    if (credential.kind === 'password') return credential
    try {
      /** 私钥内容只从主进程读取并发送给隔离 runtime，不返回 Renderer。 */
      const privateKey = this.dependencies.readPrivateKey(credential.keyPath)
      return { kind: 'private-key', privateKey, ...(credential.passphrase === undefined ? {} : { passphrase: credential.passphrase }) }
    } catch {
      throw new Error('SERVER_OPS_PRIVATE_KEY_UNAVAILABLE')
    }
  }

  /** 将 runtime 结果与当前 Host Key Store 比较并发布公开状态。 */
  private handleConnectResult(host: ServerOpsHost, connectionId: string, result: ServerOpsRuntimeConnectResult): ServerOpsConnectionState {
    if (result.status === 'connected') {
      return this.publish({ hostId: host.id, connectionId, phase: 'connected', hostKey: result.hostKey })
    }
    /** 主进程是 Host Key 信任决策的唯一所有者。 */
    const trustResult = this.dependencies.trust.check(host, result.observedHostKey)
    if (trustResult.status === 'changed') {
      return this.publish({
        hostId: host.id,
        phase: 'blocked',
        hostKey: trustResult.observed,
        previousHostKey: trustResult.trusted,
        errorCode: 'SERVER_OPS_HOST_KEY_CHANGED',
        message: '服务器指纹已变化，连接已阻断',
      })
    }
    if (trustResult.status === 'trusted') {
      return this.publishError(host.id, 'SERVER_OPS_HOST_KEY_REJECTED', '服务器身份校验失败')
    }
    /** 未知候选只在主进程内存中保留，确认后必须 fresh reconnect。 */
    const candidateId = this.dependencies.uuid()
    this.pendingCandidates.set(candidateId, { candidateId, hostId: host.id, address: host.address, port: host.port, key: trustResult.observed })
    return this.publish({ hostId: host.id, phase: 'host-key-required', candidate: { candidateId, ...trustResult.observed } })
  }

  /** 校验终端操作归属当前 connected 状态。 */
  private assertActiveConnection(hostId: string, connectionId: string): void {
    if (!this.isActiveConnection(hostId, connectionId)) throw new Error('SERVER_OPS_CONNECTION_NOT_ACTIVE')
  }

  /** 校验调用方捕获的完整连接身份。 */
  private assertActiveIdentity(identity: ServerOpsActiveConnectionIdentity): void {
    if (!this.isActiveIdentity(identity)) throw new Error('SERVER_OPS_CONNECTION_NOT_ACTIVE')
  }

  /** 判断 host、connection 与 generation 是否仍为当前所有权事实。 */
  private isActiveIdentity(identity: ServerOpsActiveConnectionIdentity): boolean {
    const current = this.tryGetActiveIdentity(identity.hostId)
    return current?.connectionId === identity.connectionId && current.generation === identity.generation
  }

  /** 无异常读取当前连接身份，供高频事件过滤使用。 */
  private tryGetActiveIdentity(hostId: string): ServerOpsActiveConnectionIdentity | undefined {
    try { return this.getActiveIdentity(hostId) } catch { return undefined }
  }

  /** 隔离日志输出订阅者异常。 */
  private notifyLogOutput(event: ServerOpsConnectionLogOutputEvent): void {
    for (const listener of this.logOutputListeners) {
      try { listener({ ...event }) } catch { /* 单个消费者不能阻断其它日志观察者。 */ }
    }
  }

  /** 隔离日志终态订阅者异常。 */
  private notifyLogExit(event: ServerOpsConnectionLogExitEvent): void {
    for (const listener of this.logExitListeners) {
      try { listener({ ...event }) } catch { /* 单个消费者不能阻断资源收口。 */ }
    }
  }

  /** 判断事件或终端操作是否属于当前公开活跃连接。 */
  private isActiveConnection(hostId: string, connectionId: string): boolean {
    /** 当前主机公开连接状态。 */
    const current = this.states.get(hostId)
    /** 当前主机内部连接所有权。 */
    const lifecycle = this.lifecycles.get(hostId)
    return current?.phase === 'connected'
      && current.connectionId === connectionId
      && lifecycle?.activeConnectionId === connectionId
  }

  /** 推进主机连接代次，并尽力释放当前 active 与 pending runtime。 */
  private invalidateConnections(hostId: string): number {
    /** 失效前的内部连接生命周期。 */
    const lifecycle = this.lifecycles.get(hostId)
    /** 下一代次用于拒绝全部旧异步结果。 */
    const generation = (lifecycle?.generation ?? 0) + 1
    /** Set 避免 active 与 pending 指向同一 runtime 时重复处理。 */
    const connectionIds = new Set<string>()
    /** 内部 active ID 优先，公开状态用于兼容进入生命周期管理前的连接。 */
    const activeConnectionId = lifecycle?.activeConnectionId ?? this.states.get(hostId)?.connectionId
    if (activeConnectionId) connectionIds.add(activeConnectionId)
    if (lifecycle?.pendingConnectionId) connectionIds.add(lifecycle.pendingConnectionId)
    this.lifecycles.set(hostId, { generation })
    for (const connectionId of connectionIds) {
      this.pendingOutput.delete(connectionId)
      this.disconnectRuntimeConnection(hostId, connectionId)
    }
    return generation
  }

  /** 复核 await 返回仍属于当前主机连接代次与在途 ID。 */
  private isCurrentConnectionAttempt(hostId: string, generation: number, connectionId?: string): connectionId is string {
    if (!connectionId) return false
    /** await 后 fresh-read 的内部所有权事实。 */
    const lifecycle = this.lifecycles.get(hostId)
    return lifecycle?.generation === generation && lifecycle.pendingConnectionId === connectionId
  }

  /** 判断尚未分配 runtime ID 的同步阶段是否仍属于当前代次。 */
  private isCurrentGeneration(hostId: string, generation: number): boolean {
    return this.lifecycles.get(hostId)?.generation === generation
  }

  /** runtime 断开属于清理动作，失败不得阻止状态收口或后续连接。 */
  private disconnectRuntimeConnection(hostId: string, connectionId: string): void {
    try {
      this.dependencies.runtime.disconnect(hostId, connectionId)
    } catch {
      // best-effort 清理：runtime 自身退出或已释放时继续收口本地所有权。
    }
  }

  /** 保存并广播不可变公开状态副本。 */
  private publish(state: ServerOpsConnectionState): ServerOpsConnectionState {
    /** 与内部 Map 隔离的公开状态副本。 */
    const snapshot = { ...state }
    this.states.set(state.hostId, snapshot)
    for (const listener of this.stateListeners) {
      try {
        listener({ ...snapshot })
      } catch {
        // 状态观察者无权中断连接事务，单个失败也不得阻止后续观察者。
      }
    }
    return { ...snapshot }
  }

  /** 发布带稳定错误码的连接失败状态。 */
  private publishError(hostId: string, errorCode: string, message: string): ServerOpsConnectionState {
    return this.publish({ hostId, phase: 'error', errorCode, message })
  }
}

/** 创建生产连接 Service 使用的系统依赖。 */
export function createServerOpsConnectionSystemDependencies(): Pick<ServerOpsConnectionServiceDependencies, 'uuid' | 'resolveSshAgent' | 'readPrivateKey'> {
  return {
    uuid: randomUUID,
    resolveSshAgent: () => {
      /** OpenSSH Agent 的 Unix socket 或 Windows named pipe。 */
      const socket = process.env.SSH_AUTH_SOCK?.trim()
      if (socket) return socket
      if (process.platform === 'win32') return 'pageant'
      throw new Error('SERVER_OPS_SSH_AGENT_UNAVAILABLE')
    },
    readPrivateKey: readPrivateKeyFile,
  }
}

/** 将稳定错误码映射为不含秘密的中文说明。 */
function getPublicErrorMessage(code: string): string {
  switch (code) {
    case 'SERVER_OPS_CREDENTIAL_REQUIRED': return '请输入当前服务器的登录凭据'
    case 'SERVER_OPS_CREDENTIAL_METHOD_MISMATCH': return '登录凭据与服务器认证方式不匹配'
    case 'SERVER_OPS_SECURE_STORAGE_UNAVAILABLE': return '系统安全存储不可用，无法记住凭据；可取消记住后仅用于本次连接'
    case 'SERVER_OPS_PRIVATE_KEY_UNAVAILABLE': return '无法读取私钥文件，请重新选择'
    case 'SERVER_OPS_SSH_AGENT_UNAVAILABLE': return '未检测到可用的 SSH Agent'
    default: return 'SSH 连接失败'
  }
}

/** 识别 runtime client 提供的公开错误，避免连接 Service 依赖 Electron 值模块。 */
function isServerOpsRuntimeError(error: unknown): error is Error & { code: string } {
  return error instanceof Error
    && error.name === 'ServerOpsRuntimeError'
    && typeof (error as Error & { code?: unknown }).code === 'string'
}
