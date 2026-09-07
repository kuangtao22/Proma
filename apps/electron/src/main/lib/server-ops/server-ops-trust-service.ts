import { randomUUID } from 'node:crypto'
import {
  parseServerOpsTrustCancelInput, parseServerOpsTrustCandidate, parseServerOpsTrustCommitInput,
  parseServerOpsTrustInput, parseServerOpsTrustPrepareInput, parseServerOpsTrustSnapshot,
} from '@proma/shared'
import type {
  ServerOpsAuditAppendInput, ServerOpsConnectionState, ServerOpsHost, ServerOpsHostKey,
  ServerOpsTrustCancelInput, ServerOpsTrustCandidate, ServerOpsTrustCommitInput,
  ServerOpsTrustInput, ServerOpsTrustPrepareInput, ServerOpsTrustResult, ServerOpsTrustSnapshot,
} from '@proma/shared'
import { AtomicWritePostCommitError } from '../safe-file'
import { ServerOpsConfigOutcomeUnknownError } from './server-ops-config-transaction'
import { createServerOpsEndpoint, sameServerOpsHostKey } from './server-ops-host-trust-store'

/** 信任流程只依赖真实资产、连接身份和短期实例准入。 */
export interface ServerOpsTrustServiceDependencies {
  hosts: { list(): ServerOpsHost[]; get(hostId: string): ServerOpsHost | undefined }
  trust: {
    get(host: ServerOpsHost): ServerOpsHostKey | undefined
    replace(host: ServerOpsHost, expected: ServerOpsHostKey, next: ServerOpsHostKey): void
    revoke(host: ServerOpsHost, expected: ServerOpsHostKey): void
  }
  connections: {
    getState(hostId: string): ServerOpsConnectionState
    getGeneration(hostId: string): number
    hasPendingOperations(hostId: string): boolean
    disconnect(hostId: string): ServerOpsConnectionState
  }
  revokeHostAccess(hostId: string): void
  audit: {
    append(input: ServerOpsAuditAppendInput): unknown
    prepareForWrites?: () => Promise<void>
  }
  /** 实例准入完成后，受影响资产复核与全部本地写入共用同一同步配置事务。 */
  transaction<T>(callback: () => T): T
  acquireMutationGuard(): Promise<() => void>
  now?: () => number
  uuid?: () => string
}

/** 不向 Renderer 暴露的候选所有权与各连接代次。 */
interface OwnedTrustCandidate {
  ownerId: number
  endpoint: string
  view: ServerOpsTrustCandidate
  generations: Map<string, number>
  timer: ReturnType<typeof setTimeout>
}

/** 指纹替换、撤销和审计编排；审批不持有文件锁。 */
export class ServerOpsTrustService {
  /** 候选全局有界，每个 owner/endpoint 仅保留最后一次。 */
  private readonly candidates = new Map<string, OwnedTrustCandidate>()
  /** 用于期限与操作关联的可替换依赖。 */
  private readonly now: () => number
  private readonly uuid: () => string
  /** dispose 后不能被迟到的实例准入结果重新激活。 */
  private disposed = false

  constructor(private readonly dependencies: ServerOpsTrustServiceDependencies) {
    this.now = dependencies.now ?? Date.now
    this.uuid = dependencies.uuid ?? randomUUID
  }

  /** 获取当前权威信任和受影响主机，尚不生成变更授权。 */
  get(input: ServerOpsTrustInput): ServerOpsTrustSnapshot {
    const { hostId } = parseServerOpsTrustInput(input)
    const host = this.requireHost(hostId)
    const endpoint = createServerOpsEndpoint(host)
    const trustedKey = this.dependencies.trust.get(host) ?? null
    const state = this.dependencies.connections.getState(hostId)
    const observedKey = state.phase === 'blocked' && state.hostKey
      && sameServerOpsHostKey(state.previousHostKey, trustedKey ?? undefined) ? state.hostKey : null
    const affectedHosts = this.dependencies.hosts.list()
      .filter((entry) => createServerOpsEndpoint(entry) === endpoint)
      .map(({ id, name }) => ({ id, name })).sort((a, b) => a.id.localeCompare(b.id))
    return parseServerOpsTrustSnapshot({ hostId, name: host.name, address: host.address, port: host.port,
      trustedKey, observedKey, affectedHosts })
  }

  /** 为直接用户操作签发五分钟候选，不能以客户端指纹替代真实观测。 */
  prepare(ownerId: number, input: ServerOpsTrustPrepareInput): ServerOpsTrustCandidate {
    this.assertOwner(ownerId)
    const parsed = parseServerOpsTrustPrepareInput(input)
    const snapshot = this.get({ hostId: parsed.hostId })
    if (!snapshot.trustedKey || (parsed.action === 'replace' && (!snapshot.observedKey
      || sameServerOpsHostKey(snapshot.observedKey, snapshot.trustedKey)))) throw new Error('SERVER_OPS_TRUST_CANDIDATE_UNAVAILABLE')
    const endpoint = createServerOpsEndpoint(snapshot)
    for (const [candidateId, candidate] of this.candidates) {
      if (candidate.ownerId === ownerId && candidate.endpoint === endpoint) this.remove(candidateId)
    }
    if (this.candidates.size >= 256) throw new Error('SERVER_OPS_TRUST_BUSY')
    const candidateId = this.uuid()
    const view = parseServerOpsTrustCandidate({ ...snapshot, candidateId, action: parsed.action, expiresAt: this.now() + 300_000 })
    const timer = setTimeout(() => this.remove(candidateId), 300_000)
    timer.unref?.()
    this.candidates.set(candidateId, { ownerId, endpoint, view,
      generations: new Map(snapshot.affectedHosts.map((host) => [host.id, this.dependencies.connections.getGeneration(host.id)])), timer })
    return parseServerOpsTrustCandidate(view)
  }

  /** 提交先复核审批快照和实例准入，所有写入都发生在新的权威校验之后。 */
  async commit(ownerId: number, input: ServerOpsTrustCommitInput): Promise<ServerOpsTrustResult> {
    this.assertOwner(ownerId)
    const parsed = parseServerOpsTrustCommitInput(input)
    this.requireCandidate(ownerId, parsed)
    /** schema 准备不得持有信任 mutation guard，避免同一旧实例 guard 嵌套死锁。 */
    if (this.dependencies.audit.prepareForWrites) await this.dependencies.audit.prepareForWrites()
    this.requireCandidate(ownerId, parsed)
    const release = await this.dependencies.acquireMutationGuard()
    /** 提交事实独立于清理结果，避免释放故障诱发用户重复提交。 */
    let result: ServerOpsTrustResult | undefined
    /** 外层事务 post-verify 失败时仍能关联同一次信任审计。 */
    let auditContext: {
      base: Pick<ServerOpsAuditAppendInput, 'actor' | 'hostId' | 'operation' | 'operationId' | 'windowId' | 'resourceType'>
      startedAt: number
    } | undefined
    try {
      result = this.dependencies.transaction(() => this.commitLocked(ownerId, parsed, (context) => { auditContext = context }))
      return result
    } catch (error) {
      if (error instanceof ServerOpsConfigOutcomeUnknownError) {
        if (auditContext) this.appendResult(auditContext.base, auditContext.startedAt, 'unknown', 'SERVER_OPS_TRUST_RESULT_UNKNOWN')
        throw new Error('SERVER_OPS_TRUST_RESULT_UNKNOWN')
      }
      throw error
    } finally {
      try { release() } catch {
        if (result) result.warning ??= 'SERVER_OPS_TRUST_GUARD_RELEASE_FAILED'
      }
    }
  }

  /** 短锁内同步复核和提交，SSH 断开只发停止通知，绝不等待远程响应。 */
  private commitLocked(
    ownerId: number,
    parsed: ServerOpsTrustCommitInput,
    publishAuditContext: (context: {
      base: Pick<ServerOpsAuditAppendInput, 'actor' | 'hostId' | 'operation' | 'operationId' | 'windowId' | 'resourceType'>
      startedAt: number
    }) => void,
  ): ServerOpsTrustResult {
      /** await 后重新读取候选、主机、信任和全部连接代次。 */
      const candidate = this.requireCandidate(ownerId, parsed)
      const host = this.requireHost(parsed.hostId)
      const affectedHostIds = candidate.view.affectedHosts.map((entry) => entry.id)
      if (affectedHostIds.some((id) => this.dependencies.connections.hasPendingOperations(id))) throw new Error('SERVER_OPS_TRUST_BUSY')
      const operationId = this.uuid()
      const operation = candidate.view.action === 'replace' ? 'trust-replace' : 'trust-revoke'
      const start = this.now()
      const auditBase = { actor: 'user' as const, hostId: host.id, operation, operationId, windowId: ownerId,
        resourceType: 'host-trust' as const } satisfies Partial<ServerOpsAuditAppendInput>
      publishAuditContext({ base: auditBase, startedAt: start })
      /** 开始记录失败时还未撤权、断线或修改信任。 */
      this.dependencies.audit.append({ ...auditBase, phase: 'start', outcome: 'pending' })
      const result: ServerOpsTrustResult = { hostId: host.id, action: candidate.view.action, affectedHostIds }
      try {
        this.requireCandidate(ownerId, parsed)
        for (const hostId of affectedHostIds) this.dependencies.revokeHostAccess(hostId)
        for (const hostId of affectedHostIds) this.dependencies.connections.disconnect(hostId)
        this.invalidateEndpoint(candidate.endpoint)
        if (candidate.view.action === 'replace') {
          this.dependencies.trust.replace(host, candidate.view.trustedKey!, candidate.view.observedKey!)
        } else {
          this.dependencies.trust.revoke(host, candidate.view.trustedKey!)
        }
      } catch (error) {
        if (error instanceof ServerOpsConfigOutcomeUnknownError) {
          /** 嵌套配置事务已执行写入但无法证明最终路径身份，禁止降级为可重试失败。 */
          this.appendResult(auditBase, start, 'unknown', 'SERVER_OPS_TRUST_RESULT_UNKNOWN')
          throw new Error('SERVER_OPS_TRUST_RESULT_UNKNOWN')
        }
        if (error instanceof AtomicWritePostCommitError) {
          /** 原子替换后的耐久错误不能诱发第二次覆盖，只回查已提交事实。 */
          let committed = false
          try {
            committed = sameServerOpsHostKey(this.dependencies.trust.get(host), candidate.view.action === 'replace' ? candidate.view.observedKey! : undefined)
          } catch { /* 无法读取权威文件时只能记录未知，不重复写入。 */ }
          if (committed) result.warning = 'SERVER_OPS_TRUST_DURABILITY_UNCONFIRMED'
          else {
            this.appendResult(auditBase, start, 'unknown', 'SERVER_OPS_TRUST_RESULT_UNKNOWN')
            throw new Error('SERVER_OPS_TRUST_RESULT_UNKNOWN')
          }
        } else {
          this.appendResult(auditBase, start, 'error', 'SERVER_OPS_TRUST_COMMIT_FAILED')
          throw new Error('SERVER_OPS_TRUST_COMMIT_FAILED')
        }
      }
      if (!this.appendResult(auditBase, start, result.warning ? 'unknown' : 'success')) result.warning = 'SERVER_OPS_AUDIT_WRITE_FAILED'
      return result
  }

  /** 取消仅处理本窗口的精确候选，不产生远程或磁盘副作用。 */
  cancel(ownerId: number, input: ServerOpsTrustCancelInput): void {
    this.assertOwner(ownerId)
    const parsed = parseServerOpsTrustCancelInput(input)
    const candidate = this.candidates.get(parsed.candidateId)
    if (candidate?.ownerId === ownerId && candidate.view.hostId === parsed.hostId) this.remove(parsed.candidateId)
  }

  /** 窗口销毁时撤销其全部尚未提交的候选。 */
  disposeOwner(ownerId: number): void {
    for (const [id, candidate] of this.candidates) if (candidate.ownerId === ownerId) this.remove(id)
  }

  /** 退出或重新注册时清除计时器和全部候选。 */
  dispose(): void {
    this.disposed = true
    for (const id of this.candidates.keys()) this.remove(id)
  }

  /** 仅接受已由 IPC 证明来源的活跃窗口 ID。 */
  private assertOwner(ownerId: number): void {
    if (this.disposed || !Number.isSafeInteger(ownerId) || ownerId < 1) throw new Error('SERVER_OPS_ACCESS_DENIED')
  }

  /** 获取真实主机资产，缺失或服务已销毁时阻断。 */
  private requireHost(hostId: string): ServerOpsHost {
    if (this.disposed) throw new Error('SERVER_OPS_ACCESS_DENIED')
    const host = this.dependencies.hosts.get(hostId)
    if (!host) throw new Error('SERVER_OPS_HOST_NOT_FOUND')
    return host
  }

  /** 候选只在 owner、期限、名称、endpoint、信任、影响范围及代次均未变化时有效。 */
  private requireCandidate(ownerId: number, input: ServerOpsTrustCommitInput): OwnedTrustCandidate {
    this.assertOwner(ownerId)
    const candidate = this.candidates.get(input.candidateId)
    if (!candidate || candidate.ownerId !== ownerId || candidate.view.hostId !== input.hostId
      || candidate.view.expiresAt <= this.now()) throw new Error('SERVER_OPS_TRUST_CANDIDATE_EXPIRED')
    if (input.confirmationName !== candidate.view.name) throw new Error('SERVER_OPS_TRUST_NAME_MISMATCH')
    const snapshot = this.get({ hostId: input.hostId })
    const old = candidate.view
    if (snapshot.name !== old.name || snapshot.address !== old.address || snapshot.port !== old.port
      || !sameServerOpsHostKey(snapshot.trustedKey ?? undefined, old.trustedKey ?? undefined)
      || (old.action === 'replace' && !sameServerOpsHostKey(snapshot.observedKey ?? undefined, old.observedKey ?? undefined))
      || JSON.stringify(snapshot.affectedHosts) !== JSON.stringify(old.affectedHosts)
      || snapshot.affectedHosts.some((host) => this.dependencies.connections.getGeneration(host.id) !== candidate.generations.get(host.id))) {
      this.remove(input.candidateId)
      throw new Error('SERVER_OPS_TRUST_CONFLICT')
    }
    return candidate
  }

  /** 同 endpoint 的一次提交使所有窗口旧候选失效。 */
  private invalidateEndpoint(endpoint: string): void {
    for (const [id, candidate] of this.candidates) if (candidate.endpoint === endpoint) this.remove(id)
  }

  /** 同时清理候选和期限计时器。 */
  private remove(candidateId: string): void {
    const candidate = this.candidates.get(candidateId)
    if (candidate) clearTimeout(candidate.timer)
    this.candidates.delete(candidateId)
  }

  /** 结果审计失败仅返回警告，不反转已经发生的真实操作。 */
  private appendResult(base: Pick<ServerOpsAuditAppendInput, 'actor' | 'hostId' | 'operation' | 'operationId' | 'windowId' | 'resourceType'>,
    startedAt: number, outcome: 'success' | 'error' | 'unknown', errorCode?: string): boolean {
    try {
      this.dependencies.audit.append({ ...base, phase: 'result', outcome, durationMs: Math.max(0, this.now() - startedAt),
        ...(errorCode ? { errorCode } : {}) })
      return true
    } catch { return false }
  }
}
