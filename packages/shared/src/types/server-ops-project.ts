import { isServerOpsId } from './server-ops'

/** 运维项目领域 IPC 通道。 */
export const SERVER_OPS_PROJECT_CHANNELS = {
  LIST: 'server-ops:list-projects',
  CREATE: 'server-ops:create-project',
  RENAME: 'server-ops:rename-project',
  DELETE: 'server-ops:delete-project',
  MOVE_CONNECTION: 'server-ops:move-connection',
} as const

/**
 * 运维项目：运维工作台的顶层分组。
 *
 * 项目里可以只放一个数据库，也可以同时放多台 SSH 连接、多个数据库与 Redis；
 * 项目本身不持有连接信息，只是连接与审计的归属边界。
 */
export interface ServerOpsProject {
  id: string
  /** 用户可读名称，例如「生产环境」。 */
  name: string
  createdAt: number
  updatedAt: number
}

/** 列出全部项目。 */
export interface ServerOpsProjectListInput {}

/** 项目列表结果；按创建时间升序返回。 */
export interface ServerOpsProjectListResult {
  projects: ServerOpsProject[]
}

/** 新建项目。 */
export interface ServerOpsProjectCreateInput { name: string }

/** 重命名项目。 */
export interface ServerOpsProjectRenameInput { projectId: string; name: string }

/** 删除项目；项目内仍有连接时必须拒绝，避免产生孤儿连接。 */
export interface ServerOpsProjectDeleteInput { projectId: string }

/** 新建或重命名回执。 */
export interface ServerOpsProjectResult {
  project: ServerOpsProject
}

/** 判断未知值是否为普通可枚举对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 拒绝公开 DTO 中的未知字段。 */
function hasOnlyKeys(value: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => keys.has(key))
}

/** 判断时间戳是否位于可安全持久化范围。 */
function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000
}

/** 解析项目名称；禁止空白、控制字符与超长文本。 */
function parseProjectName(value: unknown, errorCode: string): string {
  if (typeof value !== 'string') throw new Error(errorCode)
  const name = value.trim()
  if (name.length < 1 || name.length > 60 || /[\u0000-\u001f\u007f-\u009f]/u.test(name)) throw new Error(errorCode)
  return name
}

/** 严格解析项目公开投影。 */
export function parseServerOpsProject(value: unknown): ServerOpsProject {
  const errorCode = 'SERVER_OPS_PROJECT_INVALID'
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(['id', 'name', 'createdAt', 'updatedAt']))
    || !isServerOpsId(value.id) || !isTimestamp(value.createdAt) || !isTimestamp(value.updatedAt)) {
    throw new Error(errorCode)
  }
  return { id: value.id, name: parseProjectName(value.name, errorCode), createdAt: value.createdAt, updatedAt: value.updatedAt }
}

/** 严格解析项目列表输入。 */
export function parseServerOpsProjectListInput(value: unknown): ServerOpsProjectListInput {
  if (!isRecord(value) || !hasOnlyKeys(value, new Set())) throw new Error('SERVER_OPS_PROJECT_LIST_INPUT_INVALID')
  return {}
}

/** 严格解析项目列表结果。 */
export function parseServerOpsProjectListResult(value: unknown): ServerOpsProjectListResult {
  const errorCode = 'SERVER_OPS_PROJECT_LIST_RESULT_INVALID'
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(['projects']))
    || !Array.isArray(value.projects) || value.projects.length > 200) throw new Error(errorCode)
  return { projects: value.projects.map((entry) => parseServerOpsProject(entry)) }
}

/** 严格解析项目新建输入。 */
export function parseServerOpsProjectCreateInput(value: unknown): ServerOpsProjectCreateInput {
  const errorCode = 'SERVER_OPS_PROJECT_CREATE_INPUT_INVALID'
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(['name']))) throw new Error(errorCode)
  return { name: parseProjectName(value.name, errorCode) }
}

/** 严格解析项目重命名输入。 */
export function parseServerOpsProjectRenameInput(value: unknown): ServerOpsProjectRenameInput {
  const errorCode = 'SERVER_OPS_PROJECT_RENAME_INPUT_INVALID'
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(['projectId', 'name'])) || !isServerOpsId(value.projectId)) throw new Error(errorCode)
  return { projectId: value.projectId, name: parseProjectName(value.name, errorCode) }
}

/** 严格解析项目删除输入。 */
export function parseServerOpsProjectDeleteInput(value: unknown): ServerOpsProjectDeleteInput {
  const errorCode = 'SERVER_OPS_PROJECT_DELETE_INPUT_INVALID'
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(['projectId'])) || !isServerOpsId(value.projectId)) throw new Error(errorCode)
  return { projectId: value.projectId }
}

/** 严格解析项目新建或重命名回执。 */
export function parseServerOpsProjectResult(value: unknown): ServerOpsProjectResult {
  const errorCode = 'SERVER_OPS_PROJECT_RESULT_INVALID'
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(['project']))) throw new Error(errorCode)
  return { project: parseServerOpsProject(value.project) }
}
