import { isServerOpsId } from './server-ops'

/** 多资源只读授权使用独立通道，避免与单主机操作授权混淆。 */
export const SERVER_OPS_AGENT_READ_CHANNELS = {
  GET: 'server-ops:get-agent-read-access',
  SET: 'server-ops:set-agent-read-access',
  CHANGED: 'server-ops:agent-read-access-changed',
} as const

/** 指定数据库内的表结构权限与独立行读取权限；null 明确代表该库全部表。 */
export interface ServerOpsAgentDatabaseScope {
  database: string
  tables: string[] | null
  readRows: boolean
  /** SQL 查询须另行显式授权；省略保持旧合同，不从行预览权限推导。 */
  query?: boolean
}

/** 授权绑定连接身份；项目只是选择入口，不参与权限继承。 */
export type ServerOpsAgentReadResource =
  | { kind: 'ssh'; hostId: string }
  | { kind: 'mysql'; sourceId: string; instance: boolean; databases: ServerOpsAgentDatabaseScope[] }
  | { kind: 'redis'; sourceId: string }

/** UI 显式提交完整资源集合；空集合表示撤销该会话的只读权限。 */
export interface ServerOpsAgentReadGrant {
  sessionId: string
  resources: ServerOpsAgentReadResource[]
}

/** 主进程分配不可重用代次；不包含端点签名、凭据或内部句柄。 */
export interface ServerOpsAgentReadAccess extends ServerOpsAgentReadGrant {
  revision: number
  grantedAt: number
}

/** 跨窗口同步的公开授权快照。 */
export interface ServerOpsAgentReadChanged {
  previous: ServerOpsAgentReadAccess | null
  current: ServerOpsAgentReadAccess | null
}

/** 精确对象校验，拒绝模型/窗口混入凭据、命令或额外权限。 */
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || Object.keys(value).length !== keys.length || !Object.keys(value).every((key) => keys.includes(key))) {
    throw new Error('SERVER_OPS_READ_ACCESS_INVALID')
  }
  return value as Record<string, unknown>
}

/** 校验有界库表标识，保留大小写与合法空格，不接受控制字符。 */
function identifier(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error('SERVER_OPS_READ_ACCESS_INVALID')
  }
  return value
}

/** 给 Store、UI 与 Facade 使用同一稳定连接键；MySQL/Redis 不可用同 ID 重复授权。 */
export function serverOpsReadResourceKey(resource: ServerOpsAgentReadResource): string {
  return resource.kind === 'ssh' ? `ssh:${resource.hostId}` : `data:${resource.sourceId}`
}

/** 解析一次用户授权；最多 32 个连接、每个连接 20 个库、每库 100 张指定表。 */
export function parseServerOpsAgentReadGrant(value: unknown): ServerOpsAgentReadGrant {
  /** 最外层只允许会话与资源，revision 必须由主进程生成。 */
  const input = record(value, ['sessionId', 'resources'])
  if (!isServerOpsId(input.sessionId) || !Array.isArray(input.resources) || input.resources.length > 32) throw new Error('SERVER_OPS_READ_ACCESS_INVALID')
  /** 限制整个授权文档的最终 JSON 字节，避免分层上限相乘造成内存与广播放大。 */
  try {
    if (new TextEncoder().encode(JSON.stringify(input, null, 2)).byteLength > 16_384) throw new Error('SERVER_OPS_READ_ACCESS_INVALID')
  } catch { throw new Error('SERVER_OPS_READ_ACCESS_INVALID') }
  /** 解析后重建每一层对象，防止调用方事后修改已授予的表范围。 */
  const resources = input.resources.map((entry): ServerOpsAgentReadResource => {
    if (typeof entry !== 'object' || entry === null) throw new Error('SERVER_OPS_READ_ACCESS_INVALID')
    if (entry.kind === 'ssh') {
      const item = record(entry, ['kind', 'hostId'])
      if (!isServerOpsId(item.hostId)) throw new Error('SERVER_OPS_READ_ACCESS_INVALID')
      return { kind: 'ssh', hostId: item.hostId }
    }
    if (entry.kind === 'redis') {
      const item = record(entry, ['kind', 'sourceId'])
      if (!isServerOpsId(item.sourceId)) throw new Error('SERVER_OPS_READ_ACCESS_INVALID')
      return { kind: 'redis', sourceId: item.sourceId }
    }
    const item = record(entry, ['kind', 'sourceId', 'instance', 'databases'])
    if (item.kind !== 'mysql' || !isServerOpsId(item.sourceId) || typeof item.instance !== 'boolean'
      || !Array.isArray(item.databases) || item.databases.length > 20 || (!item.instance && item.databases.length === 0)) throw new Error('SERVER_OPS_READ_ACCESS_INVALID')
    const databases = item.databases.map((entry): ServerOpsAgentDatabaseScope => {
      const scope = record(entry, typeof entry === 'object' && entry !== null && 'query' in entry
        ? ['database', 'tables', 'readRows', 'query'] : ['database', 'tables', 'readRows'])
      const database = identifier(scope.database, 64)
      if (typeof scope.readRows !== 'boolean' || (scope.tables !== null && (!Array.isArray(scope.tables) || scope.tables.length === 0 || scope.tables.length > 100))) throw new Error('SERVER_OPS_READ_ACCESS_INVALID')
      if (scope.query !== undefined && (typeof scope.query !== 'boolean' || (scope.query && !scope.readRows))) throw new Error('SERVER_OPS_READ_ACCESS_INVALID')
      const tables = scope.tables === null ? null : (scope.tables as unknown[]).map((table) => identifier(table, 128))
      if (tables && new Set(tables).size !== tables.length) throw new Error('SERVER_OPS_READ_ACCESS_INVALID')
      return { database, tables, readRows: scope.readRows, ...(typeof scope.query === 'boolean' ? { query: scope.query } : {}) }
    })
    if (new Set(databases.map((scope) => scope.database)).size !== databases.length) throw new Error('SERVER_OPS_READ_ACCESS_INVALID')
    return { kind: 'mysql', sourceId: item.sourceId, instance: item.instance, databases }
  })
  if (new Set(resources.map(serverOpsReadResourceKey)).size !== resources.length) throw new Error('SERVER_OPS_READ_ACCESS_INVALID')
  return { sessionId: input.sessionId, resources }
}

/** IPC 读取只接受会话 ID，不允许窗口传入任意主进程上下文。 */
export function parseServerOpsAgentReadSession(value: unknown): string {
  if (!isServerOpsId(value)) throw new Error('SERVER_OPS_AGENT_SESSION_ID_INVALID')
  return value
}

/** 解析公开快照，null 为无授权。 */
export function parseServerOpsAgentReadAccess(value: unknown): ServerOpsAgentReadAccess | null {
  if (value === null) return null
  const input = record(value, ['sessionId', 'resources', 'revision', 'grantedAt'])
  if (typeof input.revision !== 'number' || !Number.isSafeInteger(input.revision) || input.revision < 1
    || typeof input.grantedAt !== 'number' || !Number.isSafeInteger(input.grantedAt) || input.grantedAt < 0) throw new Error('SERVER_OPS_READ_ACCESS_INVALID')
  const grant = parseServerOpsAgentReadGrant({ sessionId: input.sessionId, resources: input.resources })
  if (grant.resources.length === 0) throw new Error('SERVER_OPS_READ_ACCESS_INVALID')
  return { ...grant, revision: input.revision, grantedAt: input.grantedAt }
}

/** 解析广播，阻止污染或携带内部信息的事件进入渲染层。 */
export function parseServerOpsAgentReadChanged(value: unknown): ServerOpsAgentReadChanged {
  const event = record(value, ['previous', 'current'])
  return { previous: parseServerOpsAgentReadAccess(event.previous), current: parseServerOpsAgentReadAccess(event.current) }
}
