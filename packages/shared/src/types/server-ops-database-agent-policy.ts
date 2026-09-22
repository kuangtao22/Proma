import { isServerOpsId } from './server-ops'

/** 数据库禁用表策略的独立通道；读取权限不再依赖临时会话租约。 */
export const SERVER_OPS_DATABASE_AGENT_POLICY_CHANNELS = {
  GET: 'server-ops:get-database-agent-policy',
  SET: 'server-ops:set-database-agent-policy',
  CHANGED: 'server-ops:database-agent-policy-changed',
} as const

/** 一个连接中的精确数据库及其大小写保守匹配的禁用表名。 */
export interface ServerOpsDatabaseAgentExclusion {
  sourceId: string
  database: string
  excludedTables: string[]
}

/** 主进程分配的持久策略版本和完整禁用名单；未出现的库默认可只读查询。 */
export interface ServerOpsDatabaseAgentPolicy {
  revision: number
  exclusions: ServerOpsDatabaseAgentExclusion[]
}

/** UI 提交整份名单，按 revision 拒绝多窗口覆盖。 */
export interface ServerOpsDatabaseAgentPolicyUpdate {
  expectedRevision: number
  exclusions: ServerOpsDatabaseAgentExclusion[]
}

/** 限制策略文档大小，避免大规模广播和反复解析放大资源开销。 */
const MAX_POLICY_BYTES = 1_048_576

/** 严格解析对象字段，拒绝混入意外的授权能力。 */
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || Object.keys(value).length !== keys.length || !Object.keys(value).every((key) => keys.includes(key))) {
    throw new Error('SERVER_OPS_DATABASE_AGENT_POLICY_INVALID')
  }
  return value as Record<string, unknown>
}

/** 校验数据库和表标识；保留业务合法的空格和原始大小写。 */
function identifier(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error('SERVER_OPS_DATABASE_AGENT_POLICY_INVALID')
  }
  return value
}

/** 校验并复制有界完整禁用名单。 */
function parseExclusions(value: unknown): ServerOpsDatabaseAgentExclusion[] {
  if (!Array.isArray(value) || value.length > 1024) throw new Error('SERVER_OPS_DATABASE_AGENT_POLICY_INVALID')
  const exclusions = value.map((item): ServerOpsDatabaseAgentExclusion => {
    const candidate = record(item, ['sourceId', 'database', 'excludedTables'])
    if (!isServerOpsId(candidate.sourceId) || !Array.isArray(candidate.excludedTables)
      || candidate.excludedTables.length > 100) throw new Error('SERVER_OPS_DATABASE_AGENT_POLICY_INVALID')
    const database = identifier(candidate.database, 64)
    const excludedTables = candidate.excludedTables.map((table) => identifier(table, 128))
    if (new Set(excludedTables.map((table) => table.toLowerCase())).size !== excludedTables.length) {
      throw new Error('SERVER_OPS_DATABASE_AGENT_POLICY_INVALID')
    }
    return { sourceId: candidate.sourceId, database, excludedTables }
  })
  const keys = exclusions.map((item) => JSON.stringify([item.sourceId, item.database]))
  if (new Set(keys).size !== keys.length) throw new Error('SERVER_OPS_DATABASE_AGENT_POLICY_INVALID')
  return exclusions
}

/** 解析完整持久策略；未知字段或越界输入一律拒绝。 */
export function parseServerOpsDatabaseAgentPolicy(value: unknown): ServerOpsDatabaseAgentPolicy {
  const candidate = record(value, ['revision', 'exclusions'])
  if (!Number.isSafeInteger(candidate.revision) || (candidate.revision as number) < 0) {
    throw new Error('SERVER_OPS_DATABASE_AGENT_POLICY_INVALID')
  }
  try {
    // 与原子文件写入的缩进格式采用相同预算，避免保存成功后因文件超限无法读取。
    if (new TextEncoder().encode(JSON.stringify(candidate, null, 2)).byteLength + 1 > MAX_POLICY_BYTES) {
      throw new Error('SERVER_OPS_DATABASE_AGENT_POLICY_INVALID')
    }
  } catch { throw new Error('SERVER_OPS_DATABASE_AGENT_POLICY_INVALID') }
  return { revision: candidate.revision as number, exclusions: parseExclusions(candidate.exclusions) }
}

/** 解析整份策略更新；expectedRevision 用于与权威文件做 CAS。 */
export function parseServerOpsDatabaseAgentPolicyUpdate(value: unknown): ServerOpsDatabaseAgentPolicyUpdate {
  const candidate = record(value, ['expectedRevision', 'exclusions'])
  const parsed = parseServerOpsDatabaseAgentPolicy({ revision: candidate.expectedRevision, exclusions: candidate.exclusions })
  return { expectedRevision: parsed.revision, exclusions: parsed.exclusions }
}
