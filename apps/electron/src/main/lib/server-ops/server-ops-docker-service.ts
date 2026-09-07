import { randomUUID } from 'node:crypto'
import type { ServerOpsAuditAppendInput } from '@proma/shared'
import {
  isServerOpsId,
  parseServerOpsDockerActionCandidate,
  parseServerOpsDockerActionCancelInput,
  parseServerOpsDockerActionCommitInput,
  parseServerOpsDockerActionPrepareInput,
  parseServerOpsDockerActionResult,
  parseServerOpsDockerContainerDetailInput,
  parseServerOpsDockerContainerDetailResult,
  parseServerOpsDockerResourcesInput,
  parseServerOpsDockerResourcesResult,
} from '@proma/shared'
import type {
  ServerOpsDockerAction,
  ServerOpsDockerActionCandidate,
  ServerOpsDockerActionCancelInput,
  ServerOpsDockerActionCommitInput,
  ServerOpsDockerActionPrepareInput,
  ServerOpsDockerActionResult,
  ServerOpsDockerCapability,
  ServerOpsDockerContainerDetail,
  ServerOpsDockerContainerDetailInput,
  ServerOpsDockerContainerDetailResult,
  ServerOpsDockerContainerState,
  ServerOpsDockerMount,
  ServerOpsDockerPortBinding,
  ServerOpsDockerResourcesInput,
  ServerOpsDockerResourcesResult,
} from '@proma/shared'
import type { ServerOpsActiveConnectionIdentity } from './server-ops-connection-service'
import type { ServerOpsRuntimeExecResult } from '../../../utility/server-ops/server-ops-runtime-protocol'

/** 清除 Docker 客户端环境继承并固定到当前 SSH 主机的本地 Unix socket。 */
export const SERVER_OPS_DOCKER_COMMAND_PREFIX = 'LC_ALL=C env -u DOCKER_HOST -u DOCKER_CONTEXT -u DOCKER_TLS -u DOCKER_TLS_VERIFY -u DOCKER_CERT_PATH -u DOCKER_CONFIG -u DOCKER_API_VERSION docker --host unix:///var/run/docker.sock'
/** Docker CLI、daemon 与访问权限探测命令。 */
export const SERVER_OPS_DOCKER_CAPABILITY_COMMAND = `${SERVER_OPS_DOCKER_COMMAND_PREFIX} version --format '{{json .Server.Version}}'`
/** 完整容器摘要的固定 JSON 行命令。 */
export const SERVER_OPS_DOCKER_CONTAINERS_COMMAND = `${SERVER_OPS_DOCKER_COMMAND_PREFIX} container ls --all --no-trunc --format '{{json .}}'`
/** 完整镜像摘要的固定 JSON 行命令。 */
export const SERVER_OPS_DOCKER_IMAGES_COMMAND = `${SERVER_OPS_DOCKER_COMMAND_PREFIX} image ls --no-trunc --digests --format '{{json .}}'`
/** 完整网络摘要的固定 JSON 行命令。 */
export const SERVER_OPS_DOCKER_NETWORKS_COMMAND = `${SERVER_OPS_DOCKER_COMMAND_PREFIX} network ls --no-trunc --format '{{json .}}'`
/** 卷摘要的固定 JSON 行命令。 */
export const SERVER_OPS_DOCKER_VOLUMES_COMMAND = `${SERVER_OPS_DOCKER_COMMAND_PREFIX} volume ls --format '{{json .}}'`
/** Docker 只读命令固定超时。 */
const SERVER_OPS_DOCKER_READ_TIMEOUT_MS = 10_000
/** Docker 变更命令固定超时。 */
const SERVER_OPS_DOCKER_ACTION_TIMEOUT_MS = 30_000
/** 动作候选固定有效期。 */
const SERVER_OPS_DOCKER_CANDIDATE_TTL_MS = 300_000
/** 单条 JSON 行最大长度。 */
const SERVER_OPS_DOCKER_MAX_LINE_LENGTH = 32_768

/** Docker Service 只依赖当前 SSH 连接的身份、exec 与审计能力。 */
export interface ServerOpsDockerServiceDependencies {
  getActiveIdentity(hostId: string): ServerOpsActiveConnectionIdentity
  exec(hostId: string, connectionId: string, command: string, timeoutMs: number): Promise<ServerOpsRuntimeExecResult>
  audit: {
    append(input: ServerOpsAuditAppendInput): unknown
    prepareForWrites?: () => Promise<void>
  }
  now?: () => number
  uuid?: () => string
}

/** Main 内部保存的候选所有权和不可伪造连接身份。 */
interface OwnedDockerActionCandidate {
  ownerId: number | string
  identity: ServerOpsActiveConnectionIdentity
  view: ServerOpsDockerActionCandidate
  timer: ReturnType<typeof setTimeout>
}

/** 动作命令返回的确定性分类。 */
interface DockerActionExecution {
  outcome: 'success' | 'error' | 'unknown'
  errorCode?: 'SERVER_OPS_DOCKER_ACTION_FAILED' | 'SERVER_OPS_DOCKER_ACTION_UNKNOWN'
}

/** 判断未知值是否为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 判断两次读取是否仍属于同一活跃连接代次。 */
function identitiesEqual(left: ServerOpsActiveConnectionIdentity, right: ServerOpsActiveConnectionIdentity): boolean {
  return left.hostId === right.hostId && left.connectionId === right.connectionId && left.generation === right.generation
}

/** 读取 Docker JSON 字符串字段并拒绝控制字符和越界文本。 */
function readString(value: Record<string, unknown>, key: string, maximum = 512, allowEmpty = false): string {
  const field = value[key]
  if (typeof field !== 'string' || field.length > maximum || (!allowEmpty && field.length === 0)
    || /[\u0000-\u001f\u007f]/u.test(field)) throw new Error('SERVER_OPS_DOCKER_OUTPUT_INVALID')
  return field
}

/** 将逗号分隔的 Docker formatter 字段转换为有界展示数组。 */
function splitDisplayList(value: string, maximumItems: number, maximumLength: number): string[] {
  if (value.length === 0) return []
  /** formatter 使用逗号分隔多个展示值。 */
  const entries = value.split(',').map((entry) => entry.trim()).filter(Boolean)
  if (entries.length > maximumItems || entries.some((entry) => entry.length > maximumLength
    || /[\u0000-\u001f\u007f]/u.test(entry))) throw new Error('SERVER_OPS_DOCKER_OUTPUT_INVALID')
  return entries
}

/** 严格解析一个有界 JSON 行列表。 */
function parseJsonLines(output: string, maximumItems: number): Record<string, unknown>[] {
  if (output.includes('\0') || output.length > maximumItems * (SERVER_OPS_DOCKER_MAX_LINE_LENGTH + 1)) {
    throw new Error('SERVER_OPS_DOCKER_OUTPUT_INVALID')
  }
  const normalized = output.replace(/\r?\n$/u, '')
  if (normalized.length === 0) return []
  /** 每行必须是独立普通 JSON 对象。 */
  const lines = normalized.split(/\r?\n/u)
  if (lines.length > maximumItems || lines.some((line) => line.length > SERVER_OPS_DOCKER_MAX_LINE_LENGTH || line.includes('\r'))) {
    throw new Error('SERVER_OPS_DOCKER_OUTPUT_INVALID')
  }
  return lines.map((line) => {
    try {
      const parsed: unknown = JSON.parse(line)
      if (!isRecord(parsed)) throw new Error('invalid object')
      return parsed
    } catch {
      throw new Error('SERVER_OPS_DOCKER_OUTPUT_INVALID')
    }
  })
}

/** 容器状态只允许 Docker 已知生命周期枚举。 */
function parseContainerState(value: string): ServerOpsDockerContainerState {
  if (value === 'created' || value === 'running' || value === 'paused' || value === 'restarting'
    || value === 'removing' || value === 'exited' || value === 'dead') return value
  throw new Error('SERVER_OPS_DOCKER_OUTPUT_INVALID')
}

/** 把经过完整 ID 校验的容器身份编码为固定命令参数。 */
function quoteContainerId(containerId: string): string {
  return `'${containerId}'`
}

/** 编排 Docker 能力、资源读取和候选式容器动作。 */
export class ServerOpsDockerService {
  /** 全局有界的短期用户动作候选。 */
  private readonly candidates = new Map<string, OwnedDockerActionCandidate>()
  /** 防止同一候选并发提交。 */
  private readonly candidateFlights = new Set<string>()
  /** 按连接代次和完整容器 ID 隔离的动作单飞。 */
  private readonly actionFlights = new Set<string>()
  /** owner 当前在途 prepare 令牌，用于使窗口销毁期间的迟到结果失效。 */
  private readonly ownerPreparations = new Map<number | string, Set<object>>()
  /** 可替换时间与 ID 源。 */
  private readonly now: () => number
  private readonly uuid: () => string
  /** 销毁后拒绝迟到调用。 */
  private disposed = false

  constructor(private readonly dependencies: ServerOpsDockerServiceDependencies) {
    this.now = dependencies.now ?? Date.now
    this.uuid = dependencies.uuid ?? randomUUID
  }

  /** 读取当前连接上的容器、镜像、网络和卷摘要。 */
  async listResources(input: ServerOpsDockerResourcesInput): Promise<ServerOpsDockerResourcesResult> {
    const parsed = parseServerOpsDockerResourcesInput(input)
    const identity = this.readInitialIdentity(parsed.hostId)
    const capability = await this.discoverCapability(identity)
    if (capability !== 'available') return parseServerOpsDockerResourcesResult({
      hostId: parsed.hostId, capability, containers: [], images: [], networks: [], volumes: [], warnings: [],
    })
    try {
      const containers = this.parseContainers(await this.execRead(identity, SERVER_OPS_DOCKER_CONTAINERS_COMMAND), 500)
      const images = this.parseImages(await this.execRead(identity, SERVER_OPS_DOCKER_IMAGES_COMMAND), 500)
      const networks = this.parseNetworks(await this.execRead(identity, SERVER_OPS_DOCKER_NETWORKS_COMMAND), 256)
      const volumes = this.parseVolumes(await this.execRead(identity, SERVER_OPS_DOCKER_VOLUMES_COMMAND), 512)
      this.assertIdentityUnchanged(identity)
      return parseServerOpsDockerResourcesResult({ hostId: parsed.hostId, capability, containers, images, networks, volumes, warnings: [] })
    } catch {
      throw new Error('SERVER_OPS_DOCKER_OUTPUT_INVALID')
    }
  }

  /** 按完整 ID 读取并投影单个容器详情。 */
  async getContainerDetail(input: ServerOpsDockerContainerDetailInput): Promise<ServerOpsDockerContainerDetailResult> {
    const parsed = parseServerOpsDockerContainerDetailInput(input)
    const identity = this.readInitialIdentity(parsed.hostId)
    const capability = await this.discoverCapability(identity)
    if (capability !== 'available') return parseServerOpsDockerContainerDetailResult({ hostId: parsed.hostId, capability, warnings: [] })
    const container = await this.inspectContainer(identity, parsed.containerId)
    return parseServerOpsDockerContainerDetailResult({ hostId: parsed.hostId, capability, container, warnings: [] })
  }

  /** 读取真实 inspect 并签发绑定 owner 与连接代次的五分钟候选。 */
  async prepareAction(ownerId: number | string, input: ServerOpsDockerActionPrepareInput): Promise<ServerOpsDockerActionCandidate> {
    this.assertOwner(ownerId)
    /** 登记本次 prepare 的独立生命周期。 */
    const ownerPreparation = this.beginOwnerPreparation(ownerId)
    const parsed = parseServerOpsDockerActionPrepareInput(input)
    try {
      const identity = this.readInitialIdentity(parsed.hostId)
      if (await this.discoverCapability(identity) !== 'available') throw new Error('SERVER_OPS_DOCKER_UNAVAILABLE')
      this.assertOwnerPreparation(ownerId, ownerPreparation)
      const container = await this.inspectContainer(identity, parsed.containerId)
      this.assertOwnerPreparation(ownerId, ownerPreparation)
      this.assertIdentityUnchanged(identity)
      for (const [candidateId, candidate] of this.candidates) {
        if (candidate.ownerId === ownerId && candidate.view.hostId === parsed.hostId
          && candidate.view.container.containerId === parsed.containerId) this.removeCandidate(candidateId)
      }
      if (this.candidates.size >= 256) throw new Error('SERVER_OPS_DOCKER_ACTION_BUSY')
      const candidateId = this.uuid()
      const view = parseServerOpsDockerActionCandidate({ candidateId, hostId: parsed.hostId, action: parsed.action,
        container, expiresAt: this.now() + SERVER_OPS_DOCKER_CANDIDATE_TTL_MS })
      const timer = setTimeout(() => this.removeCandidate(candidateId), SERVER_OPS_DOCKER_CANDIDATE_TTL_MS)
      timer.unref?.()
      this.candidates.set(candidateId, { ownerId, identity, view, timer })
      return parseServerOpsDockerActionCandidate(view)
    } finally {
      this.finishOwnerPreparation(ownerId, ownerPreparation)
    }
  }

  /** 提交候选前 fresh inspect，审计成功后只 dispatch 一次固定动作。 */
  async commitAction(ownerId: number | string, input: ServerOpsDockerActionCommitInput, assertAuthorized: () => void = () => undefined): Promise<ServerOpsDockerActionResult> {
    this.assertOwner(ownerId)
    const parsed = parseServerOpsDockerActionCommitInput(input)
    if (this.candidateFlights.has(parsed.candidateId)) throw new Error('SERVER_OPS_DOCKER_ACTION_BUSY')
    const candidate = this.requireCandidate(ownerId, parsed)
    const actionFlightKey = JSON.stringify([
      candidate.identity.hostId, candidate.identity.connectionId, candidate.identity.generation, candidate.view.container.containerId,
    ])
    if (this.actionFlights.has(actionFlightKey)) throw new Error('SERVER_OPS_DOCKER_ACTION_BUSY')
    this.candidateFlights.add(parsed.candidateId)
    this.actionFlights.add(actionFlightKey)
    /** 只有 start 审计成功后才视为可能已 dispatch。 */
    let dispatched = false
    try {
      if (!this.identityIsCurrent(candidate.identity)) throw new Error('SERVER_OPS_DOCKER_ACTION_CONFLICT')
      const current = await this.inspectContainer(candidate.identity, candidate.view.container.containerId)
      this.requireSameCandidate(ownerId, parsed, candidate)
      if (!this.identityIsCurrent(candidate.identity) || JSON.stringify(current) !== JSON.stringify(candidate.view.container)) {
        throw new Error('SERVER_OPS_DOCKER_ACTION_CONFLICT')
      }
      if (this.dependencies.audit.prepareForWrites) await this.dependencies.audit.prepareForWrites()
      /** guard 等待后候选所有权、期限与连接代次必须仍与审批事实一致。 */
      this.requireSameCandidate(ownerId, parsed, candidate)
      if (!this.identityIsCurrent(candidate.identity)) throw new Error('SERVER_OPS_DOCKER_ACTION_CONFLICT')
      /** 最后一次异步读取紧邻 dispatch，防止审计 guard 等待期间容器被替换。 */
      const approved = await this.inspectContainer(candidate.identity, candidate.view.container.containerId)
      this.requireSameCandidate(ownerId, parsed, candidate)
      if (!this.identityIsCurrent(candidate.identity) || JSON.stringify(approved) !== JSON.stringify(candidate.view.container)) {
        throw new Error('SERVER_OPS_DOCKER_ACTION_CONFLICT')
      }
      assertAuthorized()
      /** 授权回调也无权恢复已取消、过期或失去连接所有权的候选。 */
      this.requireSameCandidate(ownerId, parsed, candidate)
      if (!this.identityIsCurrent(candidate.identity)) throw new Error('SERVER_OPS_DOCKER_ACTION_CONFLICT')
      const operationId = this.uuid()
      const operation = `docker-${candidate.view.action}` as const
      const startedAt = this.now()
      const actor = typeof ownerId === 'number' ? { actor: 'user' as const, windowId: ownerId } : { actor: 'agent' as const, sessionId: ownerId.slice(6) }
      const auditBase = { ...actor, operationId, hostId: candidate.view.hostId,
        resourceType: 'docker-container' as const, containerId: candidate.view.container.containerId, operation }
      try {
        this.dependencies.audit.append({ ...auditBase, phase: 'start', outcome: 'pending' })
      } catch {
        throw new Error('SERVER_OPS_AUDIT_WRITE_FAILED')
      }
      dispatched = true
      this.removeCandidate(parsed.candidateId)
      let execution = await this.executeAction(candidate.identity, candidate.view.container.containerId, candidate.view.action)
      /** 动作异常和正常返回都只执行一次 inspect 对账。 */
      let inspected: ServerOpsDockerContainerDetail | undefined
      try {
        inspected = await this.inspectContainer(candidate.identity, candidate.view.container.containerId)
        if (!this.identityIsCurrent(candidate.identity)) execution = { outcome: 'unknown', errorCode: 'SERVER_OPS_DOCKER_ACTION_UNKNOWN' }
      } catch {
        execution = { outcome: 'unknown', errorCode: 'SERVER_OPS_DOCKER_ACTION_UNKNOWN' }
      }
      const warnings: string[] = []
      if (execution.outcome === 'success' && inspected && !this.actionMatchesState(candidate.view.action, inspected)) {
        warnings.push('SERVER_OPS_DOCKER_STATE_MISMATCH')
      }
      try {
        this.dependencies.audit.append({ ...auditBase, phase: 'result', outcome: execution.outcome,
          durationMs: this.readDuration(startedAt), ...(execution.errorCode ? { errorCode: execution.errorCode } : {}) })
      } catch {
        if (execution.outcome === 'success') warnings.push('SERVER_OPS_AUDIT_RESULT_WRITE_FAILED')
      }
      if (execution.errorCode) throw new Error(execution.errorCode)
      return parseServerOpsDockerActionResult({ hostId: candidate.view.hostId,
        containerId: candidate.view.container.containerId, action: candidate.view.action,
        ...(inspected ? { container: inspected } : {}), warnings })
    } finally {
      this.candidateFlights.delete(parsed.candidateId)
      this.actionFlights.delete(actionFlightKey)
      if (dispatched) this.removeCandidate(parsed.candidateId)
    }
  }

  /** 取消只撤销当前 owner 的精确候选。 */
  cancelAction(ownerId: number | string, input: ServerOpsDockerActionCancelInput): void {
    this.assertOwner(ownerId)
    const parsed = parseServerOpsDockerActionCancelInput(input)
    const candidate = this.candidates.get(parsed.candidateId)
    if (candidate?.ownerId === ownerId && candidate.view.hostId === parsed.hostId) this.removeCandidate(parsed.candidateId)
  }

  /** 窗口销毁时清理该 owner 的全部候选。 */
  disposeOwner(ownerId: number | string): void {
    this.ownerPreparations.delete(ownerId)
    for (const [candidateId, candidate] of this.candidates) if (candidate.ownerId === ownerId) this.removeCandidate(candidateId)
  }

  /** 服务销毁时清理所有期限计时器并拒绝迟到调用。 */
  dispose(): void {
    this.disposed = true
    this.ownerPreparations.clear()
    for (const candidateId of this.candidates.keys()) this.removeCandidate(candidateId)
  }

  /** 已获 Pi 逐次审批的 Agent 复用同一候选链，按真实 session 记录审计。 */
  async runAgentAction(sessionId: string, input: ServerOpsDockerActionPrepareInput, assertAuthorized: () => void): Promise<ServerOpsDockerActionResult> {
    if (!isServerOpsId(sessionId)) throw new Error('SERVER_OPS_AGENT_SESSION_NOT_ALLOWED')
    assertAuthorized()
    const owner = `agent:${sessionId}`
    const candidate = await this.prepareAction(owner, input)
    const target = { hostId: candidate.hostId, candidateId: candidate.candidateId }
    try {
      assertAuthorized()
      return await this.commitAction(owner, target, assertAuthorized)
    } finally { this.removeCandidate(candidate.candidateId) }
  }

  /** 探测 Docker CLI、daemon 和 Unix socket 权限。 */
  private async discoverCapability(identity: ServerOpsActiveConnectionIdentity): Promise<ServerOpsDockerCapability> {
    let response: ServerOpsRuntimeExecResult
    try {
      response = await this.dependencies.exec(identity.hostId, identity.connectionId,
        SERVER_OPS_DOCKER_CAPABILITY_COMMAND, SERVER_OPS_DOCKER_READ_TIMEOUT_MS)
    } catch {
      this.assertIdentityUnchanged(identity)
      return 'daemon-unavailable'
    }
    this.assertIdentityUnchanged(identity)
    if (response.exitCode === 127 && response.signal === undefined && !response.truncated) return 'cli-missing'
    if (response.exitCode !== 0 || response.signal !== undefined || response.truncated) {
      if (/permission denied/iu.test(response.stderr) && response.stderr.includes('unix:///var/run/docker.sock')) return 'permission-denied'
      return 'daemon-unavailable'
    }
    try {
      const version: unknown = JSON.parse(response.stdout.trim())
      if (typeof version !== 'string' || version.length < 1 || version.length > 128) throw new Error('invalid version')
      return 'available'
    } catch {
      throw new Error('SERVER_OPS_DOCKER_OUTPUT_INVALID')
    }
  }

  /** 执行固定只读命令并校验资格和连接代次。 */
  private async execRead(identity: ServerOpsActiveConnectionIdentity, command: string): Promise<string> {
    let response: ServerOpsRuntimeExecResult
    try {
      response = await this.dependencies.exec(identity.hostId, identity.connectionId, command, SERVER_OPS_DOCKER_READ_TIMEOUT_MS)
    } catch {
      this.assertIdentityUnchanged(identity)
      throw new Error('SERVER_OPS_DOCKER_OUTPUT_INVALID')
    }
    this.assertIdentityUnchanged(identity)
    if (response.exitCode !== 0 || response.signal !== undefined || response.truncated || response.stderr.length > 0) {
      throw new Error('SERVER_OPS_DOCKER_OUTPUT_INVALID')
    }
    return response.stdout
  }

  /** 把容器 JSON 行投影为公开摘要。 */
  private parseContainers(output: string, maximum: number): ServerOpsDockerResourcesResult['containers'] {
    return parseJsonLines(output, maximum).map((entry) => ({
      containerId: readString(entry, 'ID', 64),
      names: splitDisplayList(readString(entry, 'Names', 2_048, true), 16, 128),
      image: readString(entry, 'Image'),
      state: parseContainerState(readString(entry, 'State', 32)),
      status: readString(entry, 'Status', 512, true),
      createdAt: readString(entry, 'CreatedAt', 128),
      publishedPorts: splitDisplayList(readString(entry, 'Ports', 16_384, true), 64, 256),
      mountNames: splitDisplayList(readString(entry, 'Mounts', 8_192, true), 64, 128),
    }))
  }

  /** 把镜像 JSON 行投影为公开摘要。 */
  private parseImages(output: string, maximum: number): ServerOpsDockerResourcesResult['images'] {
    return parseJsonLines(output, maximum).map((entry) => ({ imageId: readString(entry, 'ID', 71),
      repository: readString(entry, 'Repository'), tag: readString(entry, 'Tag', 256),
      digest: readString(entry, 'Digest', 256), createdAt: readString(entry, 'CreatedAt', 128), size: readString(entry, 'Size', 64) }))
  }

  /** 把网络 JSON 行投影为公开摘要。 */
  private parseNetworks(output: string, maximum: number): ServerOpsDockerResourcesResult['networks'] {
    return parseJsonLines(output, maximum).map((entry) => {
      const internal = entry.Internal
      if (internal !== true && internal !== false && internal !== 'true' && internal !== 'false') throw new Error('SERVER_OPS_DOCKER_OUTPUT_INVALID')
      return { networkId: readString(entry, 'ID', 64), name: readString(entry, 'Name', 128),
        driver: readString(entry, 'Driver', 64), scope: readString(entry, 'Scope', 64), internal: internal === true || internal === 'true' }
    })
  }

  /** 把卷 JSON 行投影为公开摘要。 */
  private parseVolumes(output: string, maximum: number): ServerOpsDockerResourcesResult['volumes'] {
    return parseJsonLines(output, maximum).map((entry) => ({ name: readString(entry, 'Name', 128),
      driver: readString(entry, 'Driver', 64), scope: readString(entry, 'Scope', 64) }))
  }

  /** 执行一次固定 inspect 并严格剥离秘密字段。 */
  private async inspectContainer(identity: ServerOpsActiveConnectionIdentity, containerId: string): Promise<ServerOpsDockerContainerDetail> {
    const command = `${SERVER_OPS_DOCKER_COMMAND_PREFIX} container inspect -- ${quoteContainerId(containerId)}`
    let response: ServerOpsRuntimeExecResult
    try {
      response = await this.dependencies.exec(identity.hostId, identity.connectionId, command, SERVER_OPS_DOCKER_READ_TIMEOUT_MS)
    } catch {
      if (!this.identityIsCurrent(identity)) throw new Error('SERVER_OPS_CONNECTION_CHANGED')
      throw new Error('SERVER_OPS_DOCKER_OUTPUT_INVALID')
    }
    this.assertIdentityUnchanged(identity)
    /** Docker 对精确旧 ID 的 canonical 不存在响应。 */
    const missingMessage = `Error: No such container: ${containerId}`
    if (response.exitCode === 1 && response.signal === undefined && !response.truncated && response.stdout.length === 0
      && response.stderr.replace(/\r?\n$/u, '') === missingMessage) throw new Error('SERVER_OPS_DOCKER_CONTAINER_NOT_FOUND')
    if (response.exitCode !== 0 || response.signal !== undefined || response.truncated || response.stderr.length > 0) {
      throw new Error('SERVER_OPS_DOCKER_OUTPUT_INVALID')
    }
    try {
      const parsed: unknown = JSON.parse(response.stdout)
      if (!Array.isArray(parsed) || parsed.length !== 1 || !isRecord(parsed[0])) throw new Error('invalid inspect')
      const root = parsed[0]
      const config = root.Config
      const state = root.State
      const networkSettings = root.NetworkSettings
      if (!isRecord(config) || !isRecord(state) || !isRecord(networkSettings) || !Array.isArray(root.Mounts)) throw new Error('invalid inspect')
      const rawName = readString(root, 'Name', 129)
      const name = rawName.startsWith('/') ? rawName.slice(1) : rawName
      const status = parseContainerState(readString(state, 'Status', 32))
      if (typeof state.Running !== 'boolean' || !Number.isSafeInteger(state.ExitCode)
        || typeof state.ExitCode !== 'number' || state.ExitCode < 0 || state.ExitCode > 255
        || !Number.isSafeInteger(root.RestartCount) || typeof root.RestartCount !== 'number'
        || root.RestartCount < 0 || root.RestartCount > 2_147_483_647) throw new Error('invalid inspect')
      const detail = {
        containerId: readString(root, 'Id', 64), name, image: readString(config, 'Image'), imageId: readString(root, 'Image', 71),
        createdAt: readString(root, 'Created', 128), platform: readString(root, 'Platform', 64), state: status,
        running: state.Running, exitCode: state.ExitCode, restartCount: root.RestartCount,
        ports: this.parsePorts(networkSettings.Ports), mounts: this.parseMounts(root.Mounts),
      }
      return parseServerOpsDockerContainerDetailResult({ hostId: identity.hostId, capability: 'available', container: detail, warnings: [] }).container!
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('SERVER_OPS_')) throw error
      throw new Error('SERVER_OPS_DOCKER_OUTPUT_INVALID')
    }
  }

  /** 将 inspect 端口 Map 转换为无秘密结构。 */
  private parsePorts(value: unknown): ServerOpsDockerPortBinding[] {
    if (!isRecord(value) || Object.keys(value).length > 128) throw new Error('SERVER_OPS_DOCKER_OUTPUT_INVALID')
    const ports: ServerOpsDockerPortBinding[] = []
    for (const [key, bindings] of Object.entries(value)) {
      const match = /^(\d{1,5})\/(tcp|udp|sctp)$/u.exec(key)
      if (!match) throw new Error('SERVER_OPS_DOCKER_OUTPUT_INVALID')
      const privatePort = Number(match[1])
      const protocol = match[2] as ServerOpsDockerPortBinding['protocol']
      if (bindings === null) ports.push({ privatePort, protocol })
      else {
        if (!Array.isArray(bindings) || bindings.length > 32) throw new Error('SERVER_OPS_DOCKER_OUTPUT_INVALID')
        for (const binding of bindings) {
          if (!isRecord(binding)) throw new Error('SERVER_OPS_DOCKER_OUTPUT_INVALID')
          const publicPortText = readString(binding, 'HostPort', 5)
          const publicPort = Number(publicPortText)
          ports.push({ privatePort, protocol, publicPort, address: readString(binding, 'HostIp', 128) })
        }
      }
      if (ports.length > 128) throw new Error('SERVER_OPS_DOCKER_OUTPUT_INVALID')
    }
    return ports
  }

  /** 将 inspect 挂载数组投影为类型、名称、目标和只读状态。 */
  private parseMounts(value: unknown[]): ServerOpsDockerMount[] {
    if (value.length > 128) throw new Error('SERVER_OPS_DOCKER_OUTPUT_INVALID')
    return value.map((entry) => {
      if (!isRecord(entry) || (entry.Type !== 'bind' && entry.Type !== 'volume' && entry.Type !== 'tmpfs')
        || typeof entry.RW !== 'boolean') throw new Error('SERVER_OPS_DOCKER_OUTPUT_INVALID')
      const name = entry.Name === undefined || entry.Name === '' ? undefined : readString(entry, 'Name', 128)
      return { type: entry.Type, ...(name ? { name } : {}), destination: readString(entry, 'Destination', 1_024), readOnly: !entry.RW }
    })
  }

  /** 唯一执行一次固定 start/stop/restart 命令。 */
  private async executeAction(identity: ServerOpsActiveConnectionIdentity, containerId: string, action: ServerOpsDockerAction): Promise<DockerActionExecution> {
    const command = action === 'start'
      ? `${SERVER_OPS_DOCKER_COMMAND_PREFIX} container start -- ${quoteContainerId(containerId)}`
      : `${SERVER_OPS_DOCKER_COMMAND_PREFIX} container ${action} --time 10 -- ${quoteContainerId(containerId)}`
    try {
      const response = await this.dependencies.exec(identity.hostId, identity.connectionId, command, SERVER_OPS_DOCKER_ACTION_TIMEOUT_MS)
      if (!this.identityIsCurrent(identity) || response.exitCode === undefined || response.signal !== undefined || response.truncated) {
        return { outcome: 'unknown', errorCode: 'SERVER_OPS_DOCKER_ACTION_UNKNOWN' }
      }
      if (response.exitCode !== 0) return { outcome: 'error', errorCode: 'SERVER_OPS_DOCKER_ACTION_FAILED' }
      return { outcome: 'success' }
    } catch {
      return { outcome: 'unknown', errorCode: 'SERVER_OPS_DOCKER_ACTION_UNKNOWN' }
    }
  }

  /** 判断动作后的 inspect 状态是否符合用户意图。 */
  private actionMatchesState(action: ServerOpsDockerAction, detail: ServerOpsDockerContainerDetail): boolean {
    return action === 'stop' ? !detail.running : detail.running
  }

  /** owner 只能为可信窗口 ID，或 Main Facade 派生的普通会话身份。 */
  private assertOwner(ownerId: number | string): void {
    const valid = typeof ownerId === 'number' ? Number.isSafeInteger(ownerId) && ownerId > 0
      : ownerId.startsWith('agent:') && isServerOpsId(ownerId.slice(6))
    if (this.disposed || !valid) throw new Error('SERVER_OPS_ACCESS_DENIED')
  }

  /** 同步读取请求起点的活跃连接身份。 */
  private readInitialIdentity(hostId: string): ServerOpsActiveConnectionIdentity {
    if (this.disposed) throw new Error('SERVER_OPS_ACCESS_DENIED')
    try { return this.dependencies.getActiveIdentity(hostId) } catch { throw new Error('SERVER_OPS_CONNECTION_CHANGED') }
  }

  /** 判断连接是否仍处于同一代次。 */
  private identityIsCurrent(expected: ServerOpsActiveConnectionIdentity): boolean {
    try { return identitiesEqual(this.dependencies.getActiveIdentity(expected.hostId), expected) } catch { return false }
  }

  /** 连接变化时立即阻断发布或后续动作。 */
  private assertIdentityUnchanged(expected: ServerOpsActiveConnectionIdentity): void {
    if (!this.identityIsCurrent(expected)) throw new Error('SERVER_OPS_CONNECTION_CHANGED')
  }

  /** 读取并验证候选的 owner、主机与期限。 */
  private requireCandidate(ownerId: number | string, input: ServerOpsDockerActionCommitInput): OwnedDockerActionCandidate {
    const candidate = this.candidates.get(input.candidateId)
    if (!candidate || candidate.ownerId !== ownerId || candidate.view.hostId !== input.hostId
      || candidate.view.expiresAt <= this.now()) throw new Error('SERVER_OPS_DOCKER_ACTION_EXPIRED')
    return candidate
  }

  /** 复核异步等待前后仍是同一个候选对象，禁止同 ID 替换接管在途提交。 */
  private requireSameCandidate(
    ownerId: number | string,
    input: ServerOpsDockerActionCommitInput,
    expected: OwnedDockerActionCandidate,
  ): OwnedDockerActionCandidate {
    const candidate = this.requireCandidate(ownerId, input)
    if (candidate !== expected || !identitiesEqual(candidate.identity, expected.identity)) {
      throw new Error('SERVER_OPS_DOCKER_ACTION_CONFLICT')
    }
    return candidate
  }

  /** 登记一条仅在 prepare await 期间存活的 owner 令牌。 */
  private beginOwnerPreparation(ownerId: number | string): object {
    const preparation = {}
    const current = this.ownerPreparations.get(ownerId) ?? new Set<object>()
    current.add(preparation)
    this.ownerPreparations.set(ownerId, current)
    return preparation
  }

  /** 异步 prepare 只能在 owner 未销毁且自身令牌仍登记时签发候选。 */
  private assertOwnerPreparation(ownerId: number | string, expected: object): void {
    if (this.disposed || !this.ownerPreparations.get(ownerId)?.has(expected)) throw new Error('SERVER_OPS_ACCESS_DENIED')
  }

  /** prepare 结束立即释放令牌，使内存只与当前并发量相关。 */
  private finishOwnerPreparation(ownerId: number | string, preparation: object): void {
    const current = this.ownerPreparations.get(ownerId)
    if (!current) return
    current.delete(preparation)
    if (current.size === 0) this.ownerPreparations.delete(ownerId)
  }

  /** 同时清理候选和期限计时器。 */
  private removeCandidate(candidateId: string): void {
    const candidate = this.candidates.get(candidateId)
    if (candidate) clearTimeout(candidate.timer)
    this.candidates.delete(candidateId)
  }

  /** 读取非负有界动作耗时。 */
  private readDuration(startedAt: number): number {
    try { return Math.max(0, Math.min(86_400_000, Math.floor(this.now() - startedAt))) } catch { return 0 }
  }
}
