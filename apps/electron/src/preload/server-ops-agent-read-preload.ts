import { SERVER_OPS_AGENT_ACCESS_MANAGEMENT_CHANNELS, parseServerOpsAgentAccessImpact } from '@proma/shared'
import type { ServerOpsAgentAccessImpact } from '@proma/shared'
import { SERVER_OPS_AGENT_READ_CHANNELS, parseServerOpsAgentReadAccess, parseServerOpsAgentReadChanged, parseServerOpsAgentReadGrant, parseServerOpsAgentReadSession } from '@proma/shared'
import type { ServerOpsAgentReadAccess, ServerOpsAgentReadChanged, ServerOpsAgentReadGrant } from '@proma/shared'
import { SERVER_OPS_DATABASE_AGENT_POLICY_CHANNELS, parseServerOpsDatabaseAgentPolicy, parseServerOpsDatabaseAgentPolicyUpdate } from '@proma/shared'
import type { ServerOpsDatabaseAgentPolicy, ServerOpsDatabaseAgentPolicyUpdate } from '@proma/shared'

/** 只读授权桥接与旧单服务器授权隔离；不接受配置或凭据材料。 */
export interface ServerOpsAgentReadPreload {
  /** 数据库禁用规则独立于会话，默认全部业务表只读可用。 */
  getServerOpsDatabaseAgentPolicy(): Promise<ServerOpsDatabaseAgentPolicy>
  setServerOpsDatabaseAgentPolicy(input: ServerOpsDatabaseAgentPolicyUpdate): Promise<ServerOpsDatabaseAgentPolicy>
  onServerOpsDatabaseAgentPolicyChanged(listener: (policy: ServerOpsDatabaseAgentPolicy) => void): () => void
  getServerOpsAgentAccessImpact(): Promise<ServerOpsAgentAccessImpact>
  revokeServerOpsLegacyAgentAccessSession(sessionId: string): Promise<void>
  getServerOpsAgentReadAccess(sessionId: string): Promise<ServerOpsAgentReadAccess | null>
  setServerOpsAgentReadAccess(input: ServerOpsAgentReadGrant, impactToken?: string): Promise<ServerOpsAgentReadAccess | null>
  onServerOpsAgentReadAccessChanged(listener: (event: ServerOpsAgentReadChanged) => void): () => void
}

/** 创建可隔离验证的授权桥接；请求、响应和广播均执行严格校验。 */
export function createServerOpsAgentReadPreload(
  invoke: (channel: string, input: unknown) => Promise<unknown>,
  subscribe: (channel: string, listener: (value: unknown) => void) => () => void,
): ServerOpsAgentReadPreload {
  return {
    getServerOpsDatabaseAgentPolicy: async () => parseServerOpsDatabaseAgentPolicy(await invoke(SERVER_OPS_DATABASE_AGENT_POLICY_CHANNELS.GET, undefined)),
    setServerOpsDatabaseAgentPolicy: async (input) => parseServerOpsDatabaseAgentPolicy(await invoke(SERVER_OPS_DATABASE_AGENT_POLICY_CHANNELS.SET, parseServerOpsDatabaseAgentPolicyUpdate(input))),
    onServerOpsDatabaseAgentPolicyChanged: (listener) => subscribe(SERVER_OPS_DATABASE_AGENT_POLICY_CHANNELS.CHANGED, (value) => {
      /** 丢弃污染广播，不吞掉消费方自己的异常。 */
      let policy: ServerOpsDatabaseAgentPolicy
      try { policy = parseServerOpsDatabaseAgentPolicy(value) } catch { return }
      listener(policy)
    }),
    getServerOpsAgentAccessImpact: async () => parseServerOpsAgentAccessImpact(await invoke(SERVER_OPS_AGENT_ACCESS_MANAGEMENT_CHANNELS.IMPACT, undefined)),
    revokeServerOpsLegacyAgentAccessSession: async (sessionId) => { await invoke(SERVER_OPS_AGENT_ACCESS_MANAGEMENT_CHANNELS.REVOKE_LEGACY_SESSION, parseServerOpsAgentReadSession(sessionId)) },
    getServerOpsAgentReadAccess: async (sessionId) => parseServerOpsAgentReadAccess(await invoke(SERVER_OPS_AGENT_READ_CHANNELS.GET, parseServerOpsAgentReadSession(sessionId))),
    setServerOpsAgentReadAccess: async (input, impactToken) => parseServerOpsAgentReadAccess(await invoke(SERVER_OPS_AGENT_READ_CHANNELS.SET, impactToken === undefined ? parseServerOpsAgentReadGrant(input) : { grant: parseServerOpsAgentReadGrant(input), impactToken })),
    onServerOpsAgentReadAccessChanged: (listener) => subscribe(SERVER_OPS_AGENT_READ_CHANNELS.CHANGED, (value) => {
      /** 只吞校验失败；不把未知字段/秘密作为事件转发。 */
      let event: ServerOpsAgentReadChanged
      try { event = parseServerOpsAgentReadChanged(value) } catch { return }
      listener(event)
    }),
  }
}
