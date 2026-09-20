import { isServerOpsHostList, isServerOpsId } from './server-ops'
import { parseServerOpsDataSource } from './server-ops-data'
import type { ServerOpsHost } from './server-ops'
import type { ServerOpsDataSource } from './server-ops-data'

/** 独立移动一条 SSH 或数据连接，不改变连接身份与凭据。 */
export interface ServerOpsConnectionMoveInput {
  kind: 'ssh' | 'data'
  id: string
  fromProjectId: string
  targetProjectId: string
}

/** 移动完成后的权威公开连接投影。 */
export type ServerOpsConnectionMoveResult =
  | { kind: 'ssh'; host: ServerOpsHost }
  | { kind: 'data'; source: ServerOpsDataSource }

/** 判断未知值是否为普通可枚举对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 判断对象是否只包含允许的公开字段。 */
function hasOnlyKeys(value: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => keys.has(key))
}

/** 严格解析跨项目移动输入，拒绝未知字段与不稳定身份。 */
export function parseServerOpsConnectionMoveInput(value: unknown): ServerOpsConnectionMoveInput {
  const errorCode = 'SERVER_OPS_CONNECTION_MOVE_INPUT_INVALID'
  if (!isRecord(value)
    || !hasOnlyKeys(value, new Set(['kind', 'id', 'fromProjectId', 'targetProjectId']))
    || (value.kind !== 'ssh' && value.kind !== 'data')
    || !isServerOpsId(value.id)
    || !isServerOpsId(value.fromProjectId)
    || !isServerOpsId(value.targetProjectId)) {
    throw new Error(errorCode)
  }
  return {
    kind: value.kind,
    id: value.id,
    fromProjectId: value.fromProjectId,
    targetProjectId: value.targetProjectId,
  }
}

/** 严格解析移动回执，数据源投影不能夹带内部凭据引用。 */
export function parseServerOpsConnectionMoveResult(value: unknown): ServerOpsConnectionMoveResult {
  const errorCode = 'SERVER_OPS_CONNECTION_MOVE_RESULT_INVALID'
  if (!isRecord(value)) throw new Error(errorCode)
  try {
    if (value.kind === 'ssh' && hasOnlyKeys(value, new Set(['kind', 'host']))) {
      /** 用数组合同完成公开主机的运行时校验与类型收窄。 */
      const hosts: unknown = [value.host]
      if (!isServerOpsHostList(hosts)) throw new Error(errorCode)
      return { kind: 'ssh', host: hosts[0]! }
    }
    if (value.kind === 'data' && hasOnlyKeys(value, new Set(['kind', 'source']))) {
      return { kind: 'data', source: parseServerOpsDataSource(value.source) }
    }
  } catch {
    throw new Error(errorCode)
  }
  throw new Error(errorCode)
}
