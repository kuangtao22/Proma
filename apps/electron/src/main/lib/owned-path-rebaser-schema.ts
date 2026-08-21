/** 保留未知 JSON 字段的对象表示。 */
export interface JsonObject {
  [key: string]: unknown
}

/** AgentSessionMeta 中由 Task4 拥有的可选单值路径字段。 */
const SESSION_OPTIONAL_PATH_FIELDS = ['piSessionFile', 'forkSourceDir'] as const
/** AgentSessionMeta 的路径数组字段。 */
const SESSION_PATH_ARRAY_FIELDS = ['attachedDirectories', 'attachedFiles'] as const
/** WorkspaceConfig 的路径数组字段。 */
const WORKSPACE_PATH_ARRAY_FIELDS = ['attachedDirectories', 'attachedFiles'] as const
/** 校验会话索引、记录身份和 Task4 owned 路径字段。 */
export function isAgentSessionsIndex(value: unknown): value is JsonObject & { sessions: JsonObject[] } {
  if (!isJsonObject(value) || !isVersion(value.version) || !Array.isArray(value.sessions)) return false
  return value.sessions.every(isAgentSessionMeta)
}

/** 校验 AgentSessionMeta 的身份必填字段和 Task4 owned 路径字段。 */
function isAgentSessionMeta(value: unknown): value is JsonObject {
  if (!isJsonObject(value)) return false
  if (!isString(value.id)
    || !isString(value.title)
    || !isString(value.workspaceId)
    || !isNumber(value.createdAt)
    || !isNumber(value.updatedAt)) return false
  if (!SESSION_OPTIONAL_PATH_FIELDS.every((field) => isOptional(value[field], isString))) return false
  if (!SESSION_PATH_ARRAY_FIELDS.every((field) => isOptional(value[field], isStringArray))) return false
  return true
}

/** 校验工作区索引及所有已知 AgentWorkspace 字段。 */
export function isAgentWorkspacesIndex(
  value: unknown,
): value is JsonObject & { workspaces: Array<JsonObject & { id: string; slug: string }> } {
  return isJsonObject(value)
    && isVersion(value.version)
    && Array.isArray(value.workspaces)
    && value.workspaces.every(isAgentWorkspace)
}

/** 校验 AgentWorkspace 的身份必填字段；非 owned 字段由业务读取层解释。 */
function isAgentWorkspace(value: unknown): value is JsonObject & { id: string; slug: string } {
  return isJsonObject(value)
    && isString(value.id)
    && isString(value.name)
    && isString(value.slug)
    && isNumber(value.createdAt)
    && isNumber(value.updatedAt)
    && isOptional(value.projectRootPath, isString)
    && isOptional(value.projectRootStatus, isLocalProjectRootStatus)
}

/** 校验 AgentWorkspace 的运行时项目根状态。 */
function isLocalProjectRootStatus(value: unknown): boolean {
  return value === 'available'
    || value === 'missing'
    || value === 'not_directory'
    || value === 'unavailable'
}

/** 校验 WorkspaceConfig 中 Task4 owned 路径及其容器结构。 */
export function isWorkspaceConfig(value: unknown): value is JsonObject {
  if (!isJsonObject(value)) return false
  if (!WORKSPACE_PATH_ARRAY_FIELDS.every((field) => isOptional(value[field], isStringArray))) return false
  return isOptional(value.worktreeRepos, isWorktreeRepos)
}

/** 校验 worktree repo 数组及真实必填字段。 */
function isWorktreeRepos(value: unknown): boolean {
  return Array.isArray(value) && value.every((repo) => isJsonObject(repo)
    && isString(repo.name)
    && isString(repo.repoPath)
    && isString(repo.worktreesPath))
}

/** 校验正整数配置版本。 */
function isVersion(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

/** 校验 JSON 字符串。 */
function isString(value: unknown): value is string {
  return typeof value === 'string'
}

/** 校验有限数字。 */
function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** 校验字符串数组。 */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString)
}

/** 校验可选字段；null 不是 TypeScript optional 字段的合法替代。 */
function isOptional(value: unknown, validate: (item: unknown) => boolean): boolean {
  return value === undefined || validate(value)
}

/** 校验值是否为可保留未知字段的 JSON 对象。 */
export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
