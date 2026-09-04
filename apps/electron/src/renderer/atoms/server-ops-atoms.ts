import { atom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'
import type { ServerOpsConnectionState, ServerOpsHost } from '@proma/shared'

/** 运维主机列表的加载阶段。 */
export type ServerOpsHostsStatus = 'idle' | 'loading' | 'ready' | 'error'

/** 当前 Renderer 内缓存的全局服务器资产。 */
export const serverOpsHostsAtom = atom<ServerOpsHost[]>([])

/** 主机资产首次读取或错误状态。 */
export const serverOpsHostsStatusAtom = atom<ServerOpsHostsStatus>('idle')

/** 主机读取错误的用户可见摘要。 */
export const serverOpsHostsErrorAtom = atom<string | null>(null)

/** 每台服务器当前公开 SSH 连接状态；不持久化且不含凭据。 */
export const serverOpsConnectionStatesAtom = atom<Record<string, ServerOpsConnectionState>>({})

/** 用户最后选择的服务器 ID；跨 Agent 会话和应用重启保留。 */
export const selectedServerOpsHostIdAtom = atomWithStorage<string | null>(
  'proma-server-ops-selected-host-id',
  null,
  undefined,
  { getOnInit: true },
)
