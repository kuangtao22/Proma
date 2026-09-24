import { isServerOpsId } from './server-ops'
import { isServerOpsMySqlTlsServerName, isServerOpsSqliteFilePath } from './server-ops-data'

/** Agent 只能建议连接的公开参数，凭据和本地私钥路径不能进入草稿。 */
export type ServerOpsConnectionDraftInput =
  | { kind: 'ssh'; name: string; address: string; port: number; username: string; authMethod?: 'password' | 'private-key' | 'ssh-agent' }
  | { kind: 'mysql' | 'postgresql' | 'redis'; label: string; address: string; port: number; username?: string; transport: 'direct' | 'ssh'; hostId?: string; tlsMode?: 'disabled' | 'preferred' | 'required' | 'verify'; tlsServerName?: string; database?: string }
  | { kind: 'sqlite'; label: string; transport: 'ssh'; hostId?: string; filePath: string }

/** 主进程生成的会话内领取凭据，不代表连接已保存或已授权。 */
export interface ServerOpsConnectionDraft {
  id: string
  sessionId: string
  createdAt: number
  expiresAt: number
  input: ServerOpsConnectionDraftInput
}

/** 草稿新增或移除只广播身份提示；内容由所属会话按需读取。 */
export interface ServerOpsConnectionDraftChanged { sessionId: string; id: string }

export const SERVER_OPS_CONNECTION_DRAFT_CHANNELS = {
  LIST: 'server-ops:list-connection-drafts',
  DISMISS: 'server-ops:dismiss-connection-draft',
  CHANGED: 'server-ops:connection-draft-changed',
} as const

/** 限定对象自身字段，避免凭据、命令或未知配置从模型流入 UI。 */
function exact(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('SERVER_OPS_CONNECTION_DRAFT_INVALID')
  const input = value as Record<string, unknown>
  if (required.some((key) => !Object.hasOwn(input, key)) || Object.keys(input).some((key) => !required.includes(key) && !optional.includes(key))) {
    throw new Error('SERVER_OPS_CONNECTION_DRAFT_INVALID')
  }
  return input
}

/** 校验有界文本；保持用户输入原样供最终表单再次校验。 */
function text(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error('SERVER_OPS_CONNECTION_DRAFT_INVALID')
  return value.trim()
}

/** 地址只允许主机名/IP，拒绝带认证信息或 URL 路径的连接串。 */
function address(value: unknown): string {
  const host = text(value, 255)
  if (/\s|[\/@?#]/u.test(host) || host.includes('://') || !/^[\p{L}\p{N}._:[\]%-]+$/u.test(host)) throw new Error('SERVER_OPS_CONNECTION_DRAFT_INVALID')
  return host
}

/** 草稿只能包含网络连接公开信息和 SQLite 绝对路径。 */
export function parseServerOpsConnectionDraftInput(value: unknown): ServerOpsConnectionDraftInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('SERVER_OPS_CONNECTION_DRAFT_INVALID')
  const source = value as Record<string, unknown>
  if (source.kind === 'ssh') {
    const input = exact(value, ['kind', 'name', 'address', 'port', 'username'], ['authMethod'])
    const port = input.port
    if (!Number.isInteger(port) || typeof port !== 'number' || port < 1 || port > 65535) throw new Error('SERVER_OPS_CONNECTION_DRAFT_INVALID')
    if (input.authMethod !== undefined && input.authMethod !== 'password' && input.authMethod !== 'private-key' && input.authMethod !== 'ssh-agent') throw new Error('SERVER_OPS_CONNECTION_DRAFT_INVALID')
    return { kind: 'ssh', name: text(input.name, 64), address: address(input.address), port, username: text(input.username, 128), ...(input.authMethod ? { authMethod: input.authMethod } : {}) }
  }
  if (source.kind === 'sqlite') {
    const input = exact(value, ['kind', 'label', 'transport', 'filePath'], ['hostId'])
    const filePath = text(input.filePath, 1024)
    if (input.transport !== 'ssh' || !isServerOpsSqliteFilePath(filePath) || filePath.split('/').some((segment) => segment === '.' || segment === '..') || (input.hostId !== undefined && !isServerOpsId(input.hostId))) throw new Error('SERVER_OPS_CONNECTION_DRAFT_INVALID')
    return { kind: 'sqlite', label: text(input.label, 64), transport: 'ssh', filePath, ...(input.hostId ? { hostId: input.hostId } : {}) }
  }
  if (source.kind === 'mysql' || source.kind === 'postgresql' || source.kind === 'redis') {
    const input = exact(value, ['kind', 'label', 'address', 'port', 'transport'], ['username', 'hostId', 'tlsMode', 'tlsServerName', 'database'])
    if (input.transport !== 'direct' && input.transport !== 'ssh') throw new Error('SERVER_OPS_CONNECTION_DRAFT_INVALID')
    if (input.hostId !== undefined && (!isServerOpsId(input.hostId) || input.transport !== 'ssh')) throw new Error('SERVER_OPS_CONNECTION_DRAFT_INVALID')
    if (typeof input.port !== 'number' || !Number.isInteger(input.port) || input.port < 1 || input.port > 65535) throw new Error('SERVER_OPS_CONNECTION_DRAFT_INVALID')
    if (input.tlsMode !== undefined && (typeof input.tlsMode !== 'string' || !['disabled', 'preferred', 'required', 'verify'].includes(input.tlsMode))) throw new Error('SERVER_OPS_CONNECTION_DRAFT_INVALID')
    if ((source.kind === 'redis' || source.kind === 'postgresql') && input.tlsMode === 'preferred') throw new Error('SERVER_OPS_CONNECTION_DRAFT_INVALID')
    if ((source.kind === 'mysql' || source.kind === 'postgresql') && input.tlsMode === 'verify'
      && !isServerOpsMySqlTlsServerName(input.tlsServerName)) throw new Error('SERVER_OPS_CONNECTION_DRAFT_INVALID')
    if (source.kind === 'mysql' && input.database !== undefined) throw new Error('SERVER_OPS_CONNECTION_DRAFT_INVALID')
    if (source.kind === 'redis' && input.database !== undefined
      && (typeof input.database !== 'string' || !/^\d{1,2}$/u.test(input.database) || Number(input.database) > 15)) {
      throw new Error('SERVER_OPS_CONNECTION_DRAFT_INVALID')
    }
    const database = input.database === undefined ? undefined : source.kind === 'postgresql'
      ? text(input.database, 63)
      : typeof input.database === 'string' ? input.database : undefined
    if (source.kind === 'postgresql' && database !== undefined
      && new TextEncoder().encode(database).byteLength > 63) throw new Error('SERVER_OPS_CONNECTION_DRAFT_INVALID')
    return {
      kind: source.kind, label: text(input.label, 64), address: address(input.address), port: input.port,
      transport: input.transport,
      ...(input.hostId ? { hostId: input.hostId } : {}),
      ...(input.username !== undefined ? { username: text(input.username, 128) } : {}),
      ...(input.tlsMode ? { tlsMode: input.tlsMode as 'disabled' | 'preferred' | 'required' | 'verify' } : {}),
      ...(input.tlsServerName !== undefined ? { tlsServerName: text(input.tlsServerName, 255) } : {}),
      ...(database !== undefined ? { database } : {}),
    }
  }
  throw new Error('SERVER_OPS_CONNECTION_DRAFT_INVALID')
}

/** 从跨进程数据重建草稿，拒绝伪造的过期时间或秘密字段。 */
export function parseServerOpsConnectionDraft(value: unknown): ServerOpsConnectionDraft {
  const input = exact(value, ['id', 'sessionId', 'createdAt', 'expiresAt', 'input'])
  if (!isServerOpsId(input.id) || !isServerOpsId(input.sessionId) || typeof input.createdAt !== 'number' || typeof input.expiresAt !== 'number' || !Number.isSafeInteger(input.createdAt) || !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= input.createdAt) throw new Error('SERVER_OPS_CONNECTION_DRAFT_INVALID')
  return { id: input.id, sessionId: input.sessionId, createdAt: input.createdAt, expiresAt: input.expiresAt, input: parseServerOpsConnectionDraftInput(input.input) }
}

/** 限制跨进程事件为可验证的身份提示。 */
export function parseServerOpsConnectionDraftChanged(value: unknown): ServerOpsConnectionDraftChanged {
  const input = exact(value, ['sessionId', 'id'])
  if (!isServerOpsId(input.sessionId) || !isServerOpsId(input.id)) throw new Error('SERVER_OPS_CONNECTION_DRAFT_INVALID')
  return { sessionId: input.sessionId, id: input.id }
}

/** 读取与删除只能指定当前可见会话，最终仍由主进程验证身份。 */
export function parseServerOpsConnectionDraftSession(value: unknown): string {
  if (!isServerOpsId(value)) throw new Error('SERVER_OPS_CONNECTION_DRAFT_INVALID')
  return value
}

/** 领取后的删除请求携带原会话和草稿身份，不能按全局 ID 删除。 */
export function parseServerOpsConnectionDraftDismiss(value: unknown): { sessionId: string; id: string } {
  return parseServerOpsConnectionDraftChanged(value)
}
