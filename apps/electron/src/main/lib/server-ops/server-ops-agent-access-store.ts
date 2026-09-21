import { parseServerOpsAgentReadGrant, serverOpsReadResourceKey } from '@proma/shared'
import type { ServerOpsAgentAccess, ServerOpsAgentReadAccess, ServerOpsAgentReadChanged, ServerOpsAgentReadGrant } from '@proma/shared'

/** 仅主进程持有的配置身份摘要；hostId 同时标明 SSH 网络路径的撤权依赖。 */
export interface ServerOpsAgentReadBinding {
  key: string
  fingerprint: string
  hostId?: string
}

/** 两种时钟同时检查，避免系统时间回拨延长授权。 */
export interface ServerOpsReadClock {
  now(): number
  monotonicNow(): number
  setTimeout(callback: () => void, delay: number): unknown
  clearTimeout(handle: unknown): void
}

/** 每个会话的公开快照、内部绑定和不可延长的单调截止时间。 */
interface ReadLease {
  access: ServerOpsAgentReadAccess
  bindings: Map<string, ServerOpsAgentReadBinding>
  deadline: number
  timer?: unknown
}

const READ_LEASE_MS = 30 * 60_000
const MAX_READ_SESSIONS = 8

/** 主进程内存中的服务器 Agent 授权存储，不写入磁盘。 */
export class ServerOpsAgentAccessStore {
  /** 旧 SSH 操作权限仍使用全局单槽，与全部只读租约互斥。 */
  private current: ServerOpsAgentAccess | undefined
  /** 会话隔离的只读租约，最多八个。 */
  private readonly readLeases = new Map<string, ReadLease>()
  /** 全局单调代次，防止撤权后重授接纳旧结果。 */
  private readRevision = 0
  /** 公开事件订阅者；每个订阅者得到独立快照。 */
  private readonly readListeners = new Set<(event: ServerOpsAgentReadChanged) => void>()

  /** 注入时钟用于验证系统回拨与定时撤权。 */
  constructor(private readonly clock: ServerOpsReadClock = {
    now: () => Date.now(),
    monotonicNow: () => performance.now(),
    setTimeout: (callback, delay) => setTimeout(callback, delay),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  }) {}

  /** 查询指定会话与服务器的精确操作授权。 */
  get(sessionId: string, hostId: string): ServerOpsAgentAccess | undefined {
    if (this.current?.sessionId !== sessionId || this.current.hostId !== hostId) return undefined
    return { ...this.current }
  }

  /** 返回当前唯一旧操作授权快照。 */
  getCurrent(): ServerOpsAgentAccess | undefined {
    return this.current ? { ...this.current } : undefined
  }

  /** 授予旧操作权限，原子撤销所有只读租约。 */
  grant(access: ServerOpsAgentAccess): void {
    /** 先清空全部租约，再广播逐会话事件，监听器不会观察到两类权限并存。 */
    const revoked = [...this.readLeases.values()].map((lease) => structuredClone(lease.access))
    for (const lease of this.readLeases.values()) if (lease.timer !== undefined) this.clock.clearTimeout(lease.timer)
    this.readLeases.clear()
    this.current = { ...access, granted: true }
    for (const previous of revoked) {
      this.readRevision += 1
      for (const listener of this.readListeners) {
        try { listener({ previous: structuredClone(previous), current: null }) } catch { /* 撤权优先。 */ }
      }
    }
  }

  /** 查询会话的只读快照；访问时同步检查墙钟和单调时钟。 */
  getReadAccess(sessionId: string): ServerOpsAgentReadAccess | undefined {
    const lease = this.activeLease(sessionId)
    return lease ? structuredClone(lease.access) : undefined
  }

  /** 枚举活动会话，只返回深复制的公开字段。 */
  listReadAccesses(): ServerOpsAgentReadAccess[] {
    return [...this.readLeases.keys()].flatMap((sessionId) => {
      const access = this.getReadAccess(sessionId)
      return access ? [access] : []
    })
  }

  /** 只可在指定会话中读取配置绑定，禁止跨会话同名资源串用。 */
  getReadBinding(sessionId: string, key: string): ServerOpsAgentReadBinding | undefined {
    const binding = this.activeLease(sessionId)?.bindings.get(key)
    return binding ? { ...binding } : undefined
  }

  /** 原子保存用户选择与可信主进程捕获的身份；空集合仅撤销该会话。 */
  grantRead(input: ServerOpsAgentReadGrant, bindings: ServerOpsAgentReadBinding[]): ServerOpsAgentReadAccess | undefined {
    const grant = parseServerOpsAgentReadGrant(input)
    if (grant.resources.length === 0) {
      this.replaceRead(grant.sessionId)
      return undefined
    }
    const keys = new Set(grant.resources.map(serverOpsReadResourceKey))
    if (bindings.length !== keys.size || new Set(bindings.map((binding) => binding.key)).size !== keys.size
      || bindings.some((binding) => !keys.has(binding.key) || !binding.fingerprint)) throw new Error('SERVER_OPS_READ_BINDING_INVALID')
    // 先剔除到期租约再校验容量；拒绝时不得触动旧授权。
    this.listReadAccesses()
    if (!this.readLeases.has(grant.sessionId) && this.readLeases.size >= MAX_READ_SESSIONS) throw new Error('SERVER_OPS_READ_SESSION_LIMIT')
    const grantedAt = this.clock.now()
    const deadline = this.clock.monotonicNow() + READ_LEASE_MS
    if (!Number.isSafeInteger(grantedAt) || grantedAt < 0 || !Number.isFinite(deadline)) throw new Error('SERVER_OPS_READ_CLOCK_INVALID')
    this.current = undefined
    const access: ServerOpsAgentReadAccess = { ...grant, revision: 0, grantedAt, expiresAt: grantedAt + READ_LEASE_MS }
    const lease: ReadLease = { access, bindings: new Map(bindings.map((binding) => [binding.key, { ...binding }])), deadline }
    this.replaceRead(grant.sessionId, lease)
    return this.getReadAccess(grant.sessionId)
  }

  /** 订阅只读权限变化；观察者异常不得打断撤权。 */
  onReadChanged(listener: (event: ServerOpsAgentReadChanged) => void): () => void {
    this.readListeners.add(listener)
    return () => { this.readListeners.delete(listener) }
  }

  /** 配置复核只缩减所检查的会话与代次，不误撤其它会话已确认的新身份。 */
  revokeReadResource(sessionId: string, key: string, expectedRevision: number): boolean {
    const lease = this.activeLease(sessionId)
    if (!lease || lease.access.revision !== expectedRevision) return false
    const resources = lease.access.resources.filter((resource) => serverOpsReadResourceKey(resource) !== key)
    if (resources.length === lease.access.resources.length) return false
    const bindings = new Map(lease.bindings)
    bindings.delete(key)
    this.replaceRead(sessionId, resources.length ? { ...lease, access: { ...lease.access, resources }, bindings, timer: undefined } : undefined)
    return true
  }

  /** 撤销所有会话中的指定数据连接，不影响其它资源。 */
  revokeSource(sourceId: string): boolean {
    return this.removeReadResources(new Set([`data:${sourceId}`]))
  }

  /** 从每个会话移除指定资源，缩权保持原到期时间。 */
  private removeReadResources(keys: Set<string>): boolean {
    let changed = false
    for (const sessionId of [...this.readLeases.keys()]) {
      const lease = this.activeLease(sessionId)
      if (!lease) continue
      const resources = lease.access.resources.filter((resource) => !keys.has(serverOpsReadResourceKey(resource)))
      if (resources.length === lease.access.resources.length) continue
      changed = true
      if (resources.length === 0) {
        this.replaceRead(sessionId)
      } else {
        const bindings = new Map(lease.bindings)
        for (const key of keys) bindings.delete(key)
        this.replaceRead(sessionId, { ...lease, access: { ...lease.access, resources }, bindings, timer: undefined })
      }
    }
    return changed
  }

  /** 检查两种截止时间；过期即同步撤权并发布当前会话事件。 */
  private activeLease(sessionId: string): ReadLease | undefined {
    const lease = this.readLeases.get(sessionId)
    if (lease && (this.clock.now() >= lease.access.expiresAt || this.clock.monotonicNow() >= lease.deadline)) {
      this.replaceRead(sessionId)
      return undefined
    }
    return lease
  }

  /** 单个会话原子替换并广播；代次全局递增，其他会话快照不变。 */
  private replaceRead(sessionId: string, next?: ReadLease): void {
    const old = this.readLeases.get(sessionId)
    if (!old && !next) return
    const previous = old ? structuredClone(old.access) : null
    if (old?.timer !== undefined) this.clock.clearTimeout(old.timer)
    this.readLeases.delete(sessionId)
    if (next) {
      next.access = { ...next.access, revision: ++this.readRevision }
      this.readLeases.set(sessionId, next)
    } else {
      this.readRevision += 1
    }
    for (const listener of this.readListeners) {
      try { listener({ previous: previous ? structuredClone(previous) : null, current: next ? structuredClone(next.access) : null }) } catch { /* 撤权优先。 */ }
    }
    if (next && this.readLeases.get(sessionId) === next) this.scheduleLease(sessionId, next)
  }

  /** 主动计时撤权；回拨时按尚余单调时间重排，不延长截止点。 */
  private scheduleLease(sessionId: string, lease: ReadLease): void {
    const remaining = Math.min(lease.access.expiresAt - this.clock.now(), lease.deadline - this.clock.monotonicNow())
    if (remaining <= 0) {
      this.replaceRead(sessionId)
      return
    }
    lease.timer = this.clock.setTimeout(() => {
      lease.timer = undefined
      if (this.readLeases.get(sessionId) !== lease) return
      if (this.activeLease(sessionId)) this.scheduleLease(sessionId, lease)
    }, remaining)
  }

  /** 仅撤销完全匹配的旧会话与服务器组合。 */
  revoke(sessionId: string, hostId: string): boolean {
    if (this.current?.sessionId !== sessionId || this.current.hostId !== hostId) return false
    this.current = undefined
    return true
  }

  /** 只撤销旧 SSH 操作授权，不触碰只读会话。 */
  revokeLegacySession(sessionId: string): boolean {
    if (this.current?.sessionId !== sessionId) return false
    this.current = undefined
    return true
  }

  /** 撤销指定会话的两类授权。 */
  revokeSession(sessionId: string): boolean {
    const legacy = this.revokeLegacySession(sessionId)
    const read = this.readLeases.has(sessionId)
    this.replaceRead(sessionId)
    return legacy || read
  }

  /** 撤销指定服务器旧权限及所有依赖它的只读资源。 */
  revokeHost(hostId: string): boolean {
    const legacy = this.current?.hostId === hostId
    if (legacy) this.current = undefined
    const keys = new Set<string>()
    for (const lease of this.readLeases.values()) {
      for (const binding of lease.bindings.values()) if (binding.hostId === hostId) keys.add(binding.key)
    }
    return this.removeReadResources(keys) || legacy
  }

  /** 清除全部授权并注销所有定时器。 */
  clear(): void {
    this.current = undefined
    for (const sessionId of [...this.readLeases.keys()]) this.replaceRead(sessionId)
  }
}
