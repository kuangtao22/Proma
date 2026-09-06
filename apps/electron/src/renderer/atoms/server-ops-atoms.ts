import { atom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'
import type { ServerOpsAgentAccess, ServerOpsAgentAccessTarget, ServerOpsConnectionState, ServerOpsHost } from '@proma/shared'

/** 运维主机列表的加载阶段。 */
export type ServerOpsHostsStatus = 'idle' | 'loading' | 'ready' | 'error'

/** 当前 Agent 与服务器精确组合的授权同步阶段。 */
export type ServerOpsAgentAccessStatus = 'idle' | 'loading' | 'ready' | 'error'

/** Renderer 对主进程授权事实的当前内存投影。 */
export interface ServerOpsAgentAccessProjection {
  target: ServerOpsAgentAccessTarget | null
  access: ServerOpsAgentAccess | null
  status: ServerOpsAgentAccessStatus
  error: string | null
}

/** 当前 Renderer 内缓存的全局服务器资产。 */
export const serverOpsHostsAtom = atom<ServerOpsHost[]>([])

/** 主机资产首次读取或错误状态。 */
export const serverOpsHostsStatusAtom = atom<ServerOpsHostsStatus>('idle')

/** 主机读取错误的用户可见摘要。 */
export const serverOpsHostsErrorAtom = atom<string | null>(null)

/** 每台服务器当前公开 SSH 连接状态；不持久化且不含凭据。 */
export const serverOpsConnectionStatesAtom = atom<Record<string, ServerOpsConnectionState>>({})

/** 授权不持久化；身份变化时必须重新读取主进程权威事实。 */
export const serverOpsAgentAccessProjectionAtom = atom<ServerOpsAgentAccessProjection>({
  target: null,
  access: null,
  status: 'idle',
  error: null,
})

/** 用户最后选择的服务器 ID；跨 Agent 会话和应用重启保留。 */
export const selectedServerOpsHostIdAtom = atomWithStorage<string | null>(
  'proma-server-ops-selected-host-id',
  null,
  undefined,
  { getOnInit: true },
)
