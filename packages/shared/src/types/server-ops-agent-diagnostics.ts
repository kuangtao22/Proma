import { parseServerOpsLogStartInput } from './server-ops'
import type { ServerOpsLogStartInput, ServerOpsServiceSummary } from './server-ops'
import type { ServerOpsDockerContainerState } from './server-ops-docker'

/** Agent 日志快照输入复用既有固定来源、时间与优先级合同。 */
export type ServerOpsAgentLogsInput = ServerOpsLogStartInput

/** 从模型输入解析精确键与更窄的 200 行预算，返回可安全传给日志服务的请求。 */
export function parseServerOpsAgentLogsInput(value: unknown): ServerOpsAgentLogsInput {
  try {
    const parsed = parseServerOpsLogStartInput(value)
    if (parsed.tailLines > 200) throw new Error('SERVER_OPS_AGENT_READ_INPUT_INVALID')
    return parsed
  } catch { throw new Error('SERVER_OPS_AGENT_READ_INPUT_INVALID') }
}

/** 发现只展示少量服务事实及已发布端口，不返回环境变量、挂载和完整 Docker 清单。 */
export interface ServerOpsAgentDiscoveryResult {
  hostId: string
  systemd: { capability: 'available' | 'unavailable' | 'permission-denied'; services: Pick<ServerOpsServiceSummary, 'unitId' | 'activeState' | 'description'>[] }
  docker: { capability: 'available' | 'cli-missing' | 'daemon-unavailable' | 'permission-denied' | 'unavailable'; containers: { containerId: string; name: string; image: string; state: ServerOpsDockerContainerState; publishedPorts: string[] }[] }
  partial: boolean
  truncated: boolean
}

/** 一次性有界日志快照；truncated 表示服务或 Agent 预算发生裁剪。 */
export interface ServerOpsAgentLogsResult {
  hostId: string
  lines: string[]
  truncated: boolean
  warnings: string[]
}
