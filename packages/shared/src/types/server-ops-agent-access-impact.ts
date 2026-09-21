import { parseServerOpsAgentAccessInput } from './server-ops'
import type { ServerOpsAgentAccess } from './server-ops'
import { parseServerOpsAgentReadAccess } from './server-ops-agent-read'
import type { ServerOpsAgentReadAccess } from './server-ops-agent-read'

/** 授权管理的主进程快照；仅供受信任界面，不能作为模型资源目录。 */
export interface ServerOpsAgentAccessImpact {
  token: string
  legacy: ServerOpsAgentAccess | null
  reads: ServerOpsAgentReadAccess[]
}

/** 影响预览与切会话撤旧 SSH 权限的独立通道。 */
export const SERVER_OPS_AGENT_ACCESS_MANAGEMENT_CHANNELS = {
  IMPACT: 'server-ops:agent-access-impact',
  REVOKE_LEGACY_SESSION: 'server-ops:revoke-legacy-agent-access-session',
} as const

/** 严格解析主进程回执，防止未知配置字段通过桥接泄漏。 */
export function parseServerOpsAgentAccessImpact(value: unknown): ServerOpsAgentAccessImpact {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('SERVER_OPS_ACCESS_IMPACT_INVALID')
  const record = value as Record<string, unknown>
  if (Object.keys(record).length !== 3 || !Object.keys(record).every((key) => ['token', 'legacy', 'reads'].includes(key))
    || typeof record.token !== 'string' || record.token.length > 8192 || !Array.isArray(record.reads) || record.reads.length > 8) throw new Error('SERVER_OPS_ACCESS_IMPACT_INVALID')
  const reads = record.reads.map((entry) => {
    const access = parseServerOpsAgentReadAccess(entry)
    if (!access) throw new Error('SERVER_OPS_ACCESS_IMPACT_INVALID')
    return access
  })
  return { token: record.token, legacy: record.legacy === null ? null : parseServerOpsAgentAccessInput(record.legacy), reads }
}
