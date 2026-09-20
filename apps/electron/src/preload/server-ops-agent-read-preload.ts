import { SERVER_OPS_AGENT_READ_CHANNELS, parseServerOpsAgentReadAccess, parseServerOpsAgentReadChanged, parseServerOpsAgentReadGrant, parseServerOpsAgentReadSession } from '@proma/shared'
import type { ServerOpsAgentReadAccess, ServerOpsAgentReadChanged, ServerOpsAgentReadGrant } from '@proma/shared'

/** 只读授权桥接与旧单服务器授权隔离；不接受配置或凭据材料。 */
export interface ServerOpsAgentReadPreload {
  getServerOpsAgentReadAccess(sessionId: string): Promise<ServerOpsAgentReadAccess | null>
  setServerOpsAgentReadAccess(input: ServerOpsAgentReadGrant): Promise<ServerOpsAgentReadAccess | null>
  onServerOpsAgentReadAccessChanged(listener: (event: ServerOpsAgentReadChanged) => void): () => void
}

/** 创建可隔离验证的授权桥接；请求、响应和广播均执行严格校验。 */
export function createServerOpsAgentReadPreload(
  invoke: (channel: string, input: unknown) => Promise<unknown>,
  subscribe: (channel: string, listener: (value: unknown) => void) => () => void,
): ServerOpsAgentReadPreload {
  return {
    getServerOpsAgentReadAccess: async (sessionId) => parseServerOpsAgentReadAccess(await invoke(SERVER_OPS_AGENT_READ_CHANNELS.GET, parseServerOpsAgentReadSession(sessionId))),
    setServerOpsAgentReadAccess: async (input) => parseServerOpsAgentReadAccess(await invoke(SERVER_OPS_AGENT_READ_CHANNELS.SET, parseServerOpsAgentReadGrant(input))),
    onServerOpsAgentReadAccessChanged: (listener) => subscribe(SERVER_OPS_AGENT_READ_CHANNELS.CHANGED, (value) => {
      /** 只吞校验失败；不把未知字段/秘密作为事件转发。 */
      let event: ServerOpsAgentReadChanged
      try { event = parseServerOpsAgentReadChanged(value) } catch { return }
      listener(event)
    }),
  }
}
