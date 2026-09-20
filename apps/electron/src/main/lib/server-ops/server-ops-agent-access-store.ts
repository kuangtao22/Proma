import { parseServerOpsAgentReadGrant, serverOpsReadResourceKey } from '@proma/shared'
import type { ServerOpsAgentAccess, ServerOpsAgentReadAccess, ServerOpsAgentReadChanged, ServerOpsAgentReadGrant } from '@proma/shared'

/** 仅主进程持有的配置身份摘要；hostId 同时标明 SSH 网络路径的撤权依赖。 */
export interface ServerOpsAgentReadBinding {
  key: string
  fingerprint: string
  hostId?: string
}

/** 主进程内存中的单槽服务器 Agent 授权存储，不写入磁盘。 */
export class ServerOpsAgentAccessStore {
  /** 当前唯一活动授权；新授权会原子替换旧授权。 */
  private current: ServerOpsAgentAccess | undefined
  /** 多连接只读授权与旧单主机操作授权互斥。 */
  private readCurrent: ServerOpsAgentReadAccess | undefined
  /** 配置摘要与公开快照分开，禁止通过 IPC 或模型返回。 */
  private readBindings = new Map<string, ServerOpsAgentReadBinding>()
  /** 单调增加的授权代次，使撤销后重授也不会接纳旧结果。 */
  private readRevision = 0
  /** 公开事件订阅者；每个订阅者得到独立快照。 */
  private readonly readListeners = new Set<(event: ServerOpsAgentReadChanged) => void>()

  /** 查询指定会话与服务器的精确授权。 */
  get(sessionId: string, hostId: string): ServerOpsAgentAccess | undefined {
    if (this.current?.sessionId !== sessionId || this.current.hostId !== hostId) return undefined
    return { ...this.current }
  }

  /** 返回当前唯一活动授权的快照。 */
  getCurrent(): ServerOpsAgentAccess | undefined {
    return this.current ? { ...this.current } : undefined
  }

  /** 授予新的会话与服务器组合，并替换旧授权。 */
  grant(access: ServerOpsAgentAccess): void {
    this.replaceRead(undefined)
    this.current = { ...access, granted: true }
  }

  /** 返回只读授权深复制；调用方必须自行验证运行会话。 */
  getReadCurrent(): ServerOpsAgentReadAccess | undefined {
    return this.readCurrent ? structuredClone(this.readCurrent) : undefined
  }

  /** 获取连接的内部配置绑定；不会向 renderer/model 暴露。 */
  getReadBinding(key: string): ServerOpsAgentReadBinding | undefined {
    const binding = this.readBindings.get(key)
    return binding ? { ...binding } : undefined
  }

  /** 原子保存用户选择与可信主进程捕获的配置身份；空集合仅撤销相同会话。 */
  grantRead(input: ServerOpsAgentReadGrant, bindings: ServerOpsAgentReadBinding[]): ServerOpsAgentReadAccess | undefined {
    const grant = parseServerOpsAgentReadGrant(input)
    if (grant.resources.length === 0) {
      if (this.readCurrent?.sessionId === grant.sessionId) this.replaceRead(undefined)
      return this.getReadCurrent()
    }
    const keys = new Set(grant.resources.map(serverOpsReadResourceKey))
    if (bindings.length !== keys.size || new Set(bindings.map((binding) => binding.key)).size !== keys.size
      || bindings.some((binding) => !keys.has(binding.key) || !binding.fingerprint)) throw new Error('SERVER_OPS_READ_BINDING_INVALID')
    this.current = undefined
    this.readBindings = new Map(bindings.map((binding) => [binding.key, { ...binding }]))
    this.replaceRead({ ...grant, revision: 0, grantedAt: Date.now() })
    return this.getReadCurrent()
  }

  /** 订阅只读权限变化；异常观察者不得打断撤权。 */
  onReadChanged(listener: (event: ServerOpsAgentReadChanged) => void): () => void {
    this.readListeners.add(listener)
    return () => { this.readListeners.delete(listener) }
  }

  /** 撤销一个数据连接，不影响其它已授权资源。 */
  revokeSource(sourceId: string): boolean {
    return this.removeReadResources(new Set([`data:${sourceId}`]))
  }

  /** 从集合移除身份匹配资源；任何缩权都推进整个快照代次。 */
  private removeReadResources(keys: Set<string>): boolean {
    if (!this.readCurrent) return false
    const resources = this.readCurrent.resources.filter((resource) => !keys.has(serverOpsReadResourceKey(resource)))
    if (resources.length === this.readCurrent.resources.length) return false
    for (const key of keys) this.readBindings.delete(key)
    this.replaceRead(resources.length ? { ...this.readCurrent, resources } : undefined)
    return true
  }

  /** 发布新快照前完成状态替换，广播只带公开字段。 */
  private replaceRead(next: ServerOpsAgentReadAccess | undefined): void {
    if (!this.readCurrent && !next) return
    const previous = this.getReadCurrent() ?? null
    this.readRevision += 1
    this.readCurrent = next ? { ...next, revision: this.readRevision } : undefined
    if (!next) this.readBindings.clear()
    for (const listener of this.readListeners) {
      try { listener({ previous: previous ? structuredClone(previous) : null, current: this.getReadCurrent() ?? null }) } catch { /* 撤权优先，不让 UI 事件异常恢复权限。 */ }
    }
  }

  /** 仅撤销完全匹配的会话与服务器组合。 */
  revoke(sessionId: string, hostId: string): boolean {
    if (this.current?.sessionId !== sessionId || this.current.hostId !== hostId) return false
    this.current = undefined
    return true
  }

  /** 撤销指定会话当前持有的授权。 */
  revokeSession(sessionId: string): boolean {
    const legacyMatches = this.current?.sessionId === sessionId
    const readMatches = this.readCurrent?.sessionId === sessionId
    if (legacyMatches) this.current = undefined
    if (readMatches) this.replaceRead(undefined)
    return legacyMatches || readMatches
  }

  /** 撤销指定服务器当前持有的授权。 */
  revokeHost(hostId: string): boolean {
    const legacyMatches = this.current?.hostId === hostId
    if (legacyMatches) this.current = undefined
    const keys = new Set([...this.readBindings.values()].filter((binding) => binding.hostId === hostId).map((binding) => binding.key))
    return this.removeReadResources(keys) || legacyMatches
  }

  /** 清除全部内存授权，供应用退出或安全收口使用。 */
  clear(): void {
    this.current = undefined
    this.replaceRead(undefined)
  }
}
