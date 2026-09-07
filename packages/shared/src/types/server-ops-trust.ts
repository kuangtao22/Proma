import { isServerOpsId } from './server-ops'
import type { ServerOpsHostKey } from './server-ops'

/** 信任管理只向授权主窗口开放，Agent 没有对应工具。 */
export const SERVER_OPS_TRUST_CHANNELS = {
  GET: 'server-ops:trust-get', PREPARE: 'server-ops:trust-prepare',
  COMMIT: 'server-ops:trust-commit', CANCEL: 'server-ops:trust-cancel',
} as const

/** 显式信任变更的有限动作。 */
export type ServerOpsTrustAction = 'replace' | 'revoke'
/** 信任查询以主机资产 ID 定位，endpoint 由主进程解析。 */
export interface ServerOpsTrustInput { hostId: string }
/** 用户请求准备一次指纹变更，尚不产生写入。 */
export interface ServerOpsTrustPrepareInput extends ServerOpsTrustInput { action: ServerOpsTrustAction }
/** 提交只带主进程签发的候选身份与用户手动输入的确认名。 */
export interface ServerOpsTrustCommitInput extends ServerOpsTrustInput { candidateId: string; confirmationName: string }
/** 取消仅能清理调用窗口拥有的精确候选。 */
export interface ServerOpsTrustCancelInput extends ServerOpsTrustInput { candidateId: string }
/** 同 endpoint 主机的最小公开摘要。 */
export interface ServerOpsTrustAffectedHost { id: string; name: string }
/** 从权威主机资产及信任记录读取的公开视图。 */
export interface ServerOpsTrustSnapshot extends ServerOpsTrustInput {
  name: string
  address: string
  port: number
  trustedKey: ServerOpsHostKey | null
  observedKey: ServerOpsHostKey | null
  affectedHosts: ServerOpsTrustAffectedHost[]
}
/** 有限期候选，连接代次和窗口 owner 仅在主进程保留。 */
export interface ServerOpsTrustCandidate extends ServerOpsTrustSnapshot {
  candidateId: string
  action: ServerOpsTrustAction
  expiresAt: number
}
/** 提交后停留在未连接状态；审计落盘故障不能反转已经提交的身份。 */
export interface ServerOpsTrustResult extends ServerOpsTrustInput {
  action: ServerOpsTrustAction
  affectedHostIds: string[]
  warning?: 'SERVER_OPS_AUDIT_WRITE_FAILED' | 'SERVER_OPS_TRUST_DURABILITY_UNCONFIRMED' | 'SERVER_OPS_TRUST_GUARD_RELEASE_FAILED'
}

/** 对普通对象执行 exact-key 检查，拒绝未知字段。 */
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !Object.keys(value).every((key) => keys.includes(key))) throw new Error('SERVER_OPS_TRUST_INPUT_INVALID')
  return value as Record<string, unknown>
}

/** 校验有界可显示文本，防止控制字符或巨大 payload 穿过 IPC。 */
function text(value: unknown, maximum = 128): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('SERVER_OPS_TRUST_INPUT_INVALID')
  }
  return value
}

/** 解析 ID 并复用服务器稳定标识规则。 */
function id(value: unknown): string {
  if (!isServerOpsId(value)) throw new Error('SERVER_OPS_TRUST_INPUT_INVALID')
  return value
}

/** 解析动作枚举。 */
function action(value: unknown): ServerOpsTrustAction {
  if (value !== 'replace' && value !== 'revoke') throw new Error('SERVER_OPS_TRUST_INPUT_INVALID')
  return value
}

/** 解析可选的公开 SSH 指纹，不接纳密码或内部验证材料。 */
function key(value: unknown): ServerOpsHostKey | null {
  if (value === null) return null
  const parsed = record(value, ['algorithm', 'fingerprint'])
  if (typeof parsed.algorithm !== 'string' || !/^[A-Za-z0-9@._+-]{1,128}$/.test(parsed.algorithm)
    || typeof parsed.fingerprint !== 'string' || !/^SHA256:[A-Za-z0-9+/=]{1,128}$/.test(parsed.fingerprint)) {
    throw new Error('SERVER_OPS_TRUST_INPUT_INVALID')
  }
  return { algorithm: parsed.algorithm, fingerprint: parsed.fingerprint }
}

/** 解析信任查询，不允许 Renderer 指定 endpoint。 */
export function parseServerOpsTrustInput(value: unknown): ServerOpsTrustInput {
  const parsed = record(value, ['hostId'])
  return { hostId: id(parsed.hostId) }
}

/** 解析候选准备请求。 */
export function parseServerOpsTrustPrepareInput(value: unknown): ServerOpsTrustPrepareInput {
  const parsed = record(value, ['hostId', 'action'])
  return { hostId: id(parsed.hostId), action: action(parsed.action) }
}

/** 解析指纹提交请求，指纹本身只取主进程候选。 */
export function parseServerOpsTrustCommitInput(value: unknown): ServerOpsTrustCommitInput {
  const parsed = record(value, ['hostId', 'candidateId', 'confirmationName'])
  return { hostId: id(parsed.hostId), candidateId: id(parsed.candidateId), confirmationName: text(parsed.confirmationName) }
}

/** 解析取消请求。 */
export function parseServerOpsTrustCancelInput(value: unknown): ServerOpsTrustCancelInput {
  const parsed = record(value, ['hostId', 'candidateId'])
  return { hostId: id(parsed.hostId), candidateId: id(parsed.candidateId) }
}

/** 公开快照允许的唯一字段集。 */
const snapshotKeys = ['hostId', 'name', 'address', 'port', 'trustedKey', 'observedKey', 'affectedHosts'] as const

/** 解析快照正文，并隔离数组/指纹对象引用。 */
function snapshotBody(parsed: Record<string, unknown>): ServerOpsTrustSnapshot {
  if (typeof parsed.port !== 'number' || !Number.isInteger(parsed.port) || parsed.port < 1 || parsed.port > 65535
    || !Array.isArray(parsed.affectedHosts) || parsed.affectedHosts.length < 1 || parsed.affectedHosts.length > 1000) {
    throw new Error('SERVER_OPS_TRUST_INPUT_INVALID')
  }
  const affectedHosts = parsed.affectedHosts.map((host) => {
    const entry = record(host, ['id', 'name'])
    return { id: id(entry.id), name: text(entry.name) }
  })
  if (new Set(affectedHosts.map((host) => host.id)).size !== affectedHosts.length
    || !affectedHosts.some((host) => host.id === parsed.hostId)) throw new Error('SERVER_OPS_TRUST_INPUT_INVALID')
  return {
    hostId: id(parsed.hostId), name: text(parsed.name), address: text(parsed.address, 253), port: parsed.port,
    trustedKey: key(parsed.trustedKey), observedKey: key(parsed.observedKey), affectedHosts,
  }
}

/** 对主进程信任查询结果执行严格公开合同校验。 */
export function parseServerOpsTrustSnapshot(value: unknown): ServerOpsTrustSnapshot {
  return snapshotBody(record(value, snapshotKeys))
}

/** 解析有期限的候选，替换必须具备两种身份。 */
export function parseServerOpsTrustCandidate(value: unknown): ServerOpsTrustCandidate {
  const parsed = record(value, [...snapshotKeys, 'candidateId', 'action', 'expiresAt'])
  const snapshot = snapshotBody(parsed)
  const parsedAction = action(parsed.action)
  if (!snapshot.trustedKey || (parsedAction === 'replace' && !snapshot.observedKey)
    || (parsedAction === 'replace' && snapshot.trustedKey?.algorithm === snapshot.observedKey?.algorithm
      && snapshot.trustedKey?.fingerprint === snapshot.observedKey?.fingerprint)
    || typeof parsed.expiresAt !== 'number' || !Number.isSafeInteger(parsed.expiresAt)
    || parsed.expiresAt < 0 || parsed.expiresAt > 8_640_000_000_000_000) throw new Error('SERVER_OPS_TRUST_INPUT_INVALID')
  return { ...snapshot, candidateId: id(parsed.candidateId), action: parsedAction, expiresAt: parsed.expiresAt }
}

/** 解析最终结果，不暴露内部连接身份或文件路径。 */
export function parseServerOpsTrustResult(value: unknown): ServerOpsTrustResult {
  const parsed = record(value, ['hostId', 'action', 'affectedHostIds', 'warning'])
  if (!Array.isArray(parsed.affectedHostIds) || parsed.affectedHostIds.length < 1 || parsed.affectedHostIds.length > 1000
    || new Set(parsed.affectedHostIds).size !== parsed.affectedHostIds.length || !parsed.affectedHostIds.includes(parsed.hostId)
    || (parsed.warning !== undefined && parsed.warning !== 'SERVER_OPS_AUDIT_WRITE_FAILED'
      && parsed.warning !== 'SERVER_OPS_TRUST_DURABILITY_UNCONFIRMED'
      && parsed.warning !== 'SERVER_OPS_TRUST_GUARD_RELEASE_FAILED')) throw new Error('SERVER_OPS_TRUST_INPUT_INVALID')
  return { hostId: id(parsed.hostId), action: action(parsed.action), affectedHostIds: parsed.affectedHostIds.map(id),
    ...(parsed.warning === undefined ? {} : { warning: parsed.warning }) }
}
