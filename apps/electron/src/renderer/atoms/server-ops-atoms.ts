import { atom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'
import type { ServerOpsAgentAccess, ServerOpsAgentAccessTarget, ServerOpsConnectionState, ServerOpsDataSource, ServerOpsHost, ServerOpsProject } from '@proma/shared'
import type { ServerOpsProjectsStatus } from '@/components/server-ops/server-ops-project-controller'
import type { ServerOpsDataSourcesStatus } from '@/components/server-ops/server-ops-data-source-list-controller'

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

/** 运维项目列表的加载阶段。 */
export const serverOpsProjectsStatusAtom = atom<ServerOpsProjectsStatus>('idle')

/** 运维项目列表；项目是连接与授权的顶层分组。 */
export const serverOpsProjectsAtom = atom<ServerOpsProject[]>([])

/** 项目列表读取失败的公开错误。 */
export const serverOpsProjectsErrorAtom = atom<string | null>(null)

/** 用户最后选择的项目 ID；跨 Agent 会话和应用重启保留。 */
export const selectedServerOpsProjectIdAtom = atomWithStorage<string | null>(
  'proma-server-ops-selected-project-id',
  null,
  undefined,
  { getOnInit: true },
)

/** 数据源列表的加载阶段；一次加载全量，项目过滤在渲染层完成。 */
export const serverOpsDataSourcesStatusAtom = atom<ServerOpsDataSourcesStatus>('idle')

/** 全部数据源；作为项目下的数据库/Redis 连接来源。 */
export const serverOpsDataSourcesAtom = atom<ServerOpsDataSource[]>([])

/** 数据源列表读取失败的公开错误。 */
export const serverOpsDataSourcesErrorAtom = atom<string | null>(null)

/** 用户最后选择的连接 ID（`ssh:<hostId>` 或 `data:<sourceId>`）；跨会话保留。 */
export const selectedServerOpsConnectionIdAtom = atomWithStorage<string | null>(
  'proma-server-ops-selected-connection-id',
  null,
  undefined,
  { getOnInit: true },
)
