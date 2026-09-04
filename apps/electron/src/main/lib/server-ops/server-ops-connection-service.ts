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
import type { ServerOpsRuntimeConnectionInput } from './server-ops-runtime-client'
import type { ServerOpsHostTrustResult } from './server-ops-host-trust-store'
import type { ServerOpsRuntimeConnectResult } from '../../../utility/server-ops/server-ops-runtime-protocol'

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
  disconnect: (hostId: string, connectionId: string) => void
  input: (hostId: string, connectionId: string, data: string) => void
  resize: (hostId: string, connectionId: string, cols: number, rows: number) => void
  acknowledgeOutput: (input: ServerOpsTerminalOutputAck) => void
  onOutput: (listener: (event: ServerOpsTerminalOutputEvent) => void) => () => void
  onExit: (listener: (event: ServerOpsTerminalExitEvent) => void) => () => void
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

/** 首次 Host Key 候选在主进程内存中的完整绑定。 */
interface PendingHostKeyCandidate {
  candidateId: string
  hostId: string
  address: string
  port: number
  key: ServerOpsHostKey
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
  /** runtime 输出订阅清理器。 */
  private readonly disposeRuntimeOutput: () => void
  /** runtime 退出订阅清理器。 */
  private readonly disposeRuntimeExit: () => void

  constructor(dependencies: ServerOpsConnectionServiceDependencies) {
    this.dependencies = dependencies
    this.disposeRuntimeOutput = dependencies.runtime.onOutput((event) => {
      this.pendingOutput.set(event.connectionId, { ...event })
      for (const listener of this.outputListeners) listener(event)
    })
    this.disposeRuntimeExit = dependencies.runtime.onExit((event) => {
      /** 旧连接退出不得覆盖同主机的新连接状态。 */
      const current = this.states.get(event.hostId)
      if (current?.connectionId === event.connectionId) this.publish({ hostId: event.hostId, phase: 'disconnected', message: event.message })
      for (const listener of this.exitListeners) listener(event)
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

  /** 返回指定主机当前公开连接状态。 */
  getState(hostId: string): ServerOpsConnectionState {
    return { ...(this.states.get(hostId) ?? { hostId, phase: 'disconnected' as const }) }
  }

  /** 保存一次性凭据并建立真实 SSH 连接。 */
  async connect(input: ServerOpsConnectInput): Promise<ServerOpsConnectionState> {
    /** 每次操作 fresh-read 的主机资产。 */
    const host = this.dependencies.hosts.get(input.hostId)
    if (!host) return this.publishError(input.hostId, 'SERVER_OPS_HOST_NOT_FOUND', '服务器配置不存在')
    /** 当前主机旧连接必须在新连接前显式释放。 */
    const current = this.states.get(host.id)
    if (current?.connectionId) this.dependencies.runtime.disconnect(host.id, current.connectionId)
    this.publish({ hostId: host.id, phase: 'connecting' })

    try {
      this.acceptCredential(host, input.credential)
      /** 每次连接都从 Store fresh-read 的内部凭据。 */
      const authentication = this.resolveAuthentication(host)
      /** 当前 endpoint 已固定的 Host Key；不存在时 runtime 必须在认证前拒绝。 */
      const expectedHostKey = this.dependencies.trust.get(host)
      /** 本次连接的唯一归属 ID。 */
      const connectionId = this.dependencies.uuid()
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
      return this.handleConnectResult(host, connectionId, result)
    } catch (error) {
      if (isServerOpsRuntimeError(error)) return this.publishError(host.id, error.code, error.message)
      /** 领域错误只允许已知稳定码，其余统一收敛。 */
      const code = error instanceof Error && error.message.startsWith('SERVER_OPS_') ? error.message : 'SERVER_OPS_CONNECTION_FAILED'
      return this.publishError(host.id, code, getPublicErrorMessage(code))
    }
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
      this.dependencies.runtime.disconnect(hostId, current.connectionId)
    }
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
    for (const [hostId, state] of this.states) {
      if (state.connectionId) this.dependencies.runtime.disconnect(hostId, state.connectionId)
    }
    this.states.clear()
    this.pendingCandidates.clear()
    this.pendingOutput.clear()
    this.stateListeners.clear()
    this.outputListeners.clear()
    this.exitListeners.clear()
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
    /** 当前主机公开连接状态。 */
    const current = this.states.get(hostId)
    if (current?.phase !== 'connected' || current.connectionId !== connectionId) throw new Error('SERVER_OPS_CONNECTION_NOT_ACTIVE')
  }

  /** 保存并广播不可变公开状态副本。 */
  private publish(state: ServerOpsConnectionState): ServerOpsConnectionState {
    /** 与内部 Map 隔离的公开状态副本。 */
    const snapshot = { ...state }
    this.states.set(state.hostId, snapshot)
    for (const listener of this.stateListeners) listener({ ...snapshot })
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
