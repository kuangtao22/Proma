import type { ServerOpsAgentAccess } from '@proma/shared'

/** 主进程内存中的单槽服务器 Agent 授权存储，不写入磁盘。 */
export class ServerOpsAgentAccessStore {
  /** 当前唯一活动授权；新授权会原子替换旧授权。 */
  private current: ServerOpsAgentAccess | undefined

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
    this.current = { ...access, granted: true }
  }

  /** 仅撤销完全匹配的会话与服务器组合。 */
  revoke(sessionId: string, hostId: string): boolean {
    if (this.current?.sessionId !== sessionId || this.current.hostId !== hostId) return false
    this.current = undefined
    return true
  }

  /** 撤销指定会话当前持有的授权。 */
  revokeSession(sessionId: string): boolean {
    if (this.current?.sessionId !== sessionId) return false
    this.current = undefined
    return true
  }

  /** 撤销指定服务器当前持有的授权。 */
  revokeHost(hostId: string): boolean {
    if (this.current?.hostId !== hostId) return false
    this.current = undefined
    return true
  }

  /** 清除全部内存授权，供应用退出或安全收口使用。 */
  clear(): void {
    this.current = undefined
  }
}
