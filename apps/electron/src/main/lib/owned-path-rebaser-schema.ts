/** 保留未知 JSON 字段的对象表示。 */
export interface JsonObject {
  [key: string]: unknown
}

/** AgentSessionMeta 的可选字符串字段。 */
const SESSION_OPTIONAL_STRING_FIELDS = [
  'channelId',
  'modelId',
  'sdkSessionId',
  'piSessionFile',
  'workspaceId',
  'forkSourceDir',
  'sourceAutomationId',
  'parentSessionId',
  'rootSessionId',
  'sourceDelegationId',
  'delegationGoal',
] as const
/** AgentSessionMeta 的可选布尔字段。 */
const SESSION_OPTIONAL_BOOLEAN_FIELDS = [
  'codexFastMode',
  'pinned',
  'starred',
  'archived',
  'manualWorking',
  'completedButUnconfirmed',
  'stoppedByUser',
  'automationGraduated',
] as const
/** AgentSessionMeta 的路径数组字段。 */
const SESSION_PATH_ARRAY_FIELDS = ['attachedDirectories', 'attachedFiles'] as const
/** WorkspaceConfig 的路径数组字段。 */
const WORKSPACE_PATH_ARRAY_FIELDS = ['attachedDirectories', 'attachedFiles'] as const
/** 合法的会话推理等级。 */
const THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
/** 合法的委派角色。 */
const DELEGATION_ROLES = new Set(['explore', 'research', 'implement', 'review', 'custom'])
/** 合法的委派状态。 */
const DELEGATION_STATUSES = new Set(['running', 'completed', 'failed', 'cancelled', 'interrupted'])

/** 校验会话索引及所有已知 AgentSessionMeta 字段。 */
export function isAgentSessionsIndex(value: unknown): value is JsonObject & { sessions: JsonObject[] } {
  if (!isJsonObject(value) || !isVersion(value.version) || !Array.isArray(value.sessions)) return false
  if (!isOptional(value.openAIThinkingDefaultEnabledMigrationCompleted, isBoolean)) return false
  return value.sessions.every(isAgentSessionMeta)
}

/** 校验 AgentSessionMeta 的必填字段和所有已知可选字段。 */
function isAgentSessionMeta(value: unknown): value is JsonObject {
  if (!isJsonObject(value)) return false
  if (!isString(value.id) || !isString(value.title) || !isNumber(value.createdAt) || !isNumber(value.updatedAt)) return false
  if (!SESSION_OPTIONAL_STRING_FIELDS.every((field) => isOptional(value[field], isString))) return false
  if (!SESSION_OPTIONAL_BOOLEAN_FIELDS.every((field) => isOptional(value[field], isBoolean))) return false
  if (!SESSION_PATH_ARRAY_FIELDS.every((field) => isOptional(value[field], isStringArray))) return false
  if (!isOptional(value.piEntryBindings, isStringRecord)) return false
  if (!isOptional(value.legacyTranscript, isLegacyTranscript)) return false
  if (!isOptional(value.reasoningLevel, (item) => isEnumString(item, THINKING_LEVELS))) return false
  if (!isOptional(value.openAIThinkingLevel, (item) => isEnumString(item, THINKING_LEVELS))) return false
  if (!isOptional(value.agentCwdMode, (item) => item === 'session' || item === 'project')) return false
  if (!isOptional(value.activeWorktree, isActiveWorktree)) return false
  if (!isOptional(value.sessionWorkbenchLayout, (item) => item === 'legacy-context' || item === 'root')) return false
  if (!isOptional(value.permissionMode, (item) => item === 'bypassPermissions' || item === 'plan')) return false
  if (!isOptional(value.delegationRole, (item) => isEnumString(item, DELEGATION_ROLES))) return false
  if (!isOptional(value.delegationStatus, (item) => isEnumString(item, DELEGATION_STATUSES))) return false
  return isOptional(value.delegationDepth, isNumber)
}

/** 校验工作区索引及所有已知 AgentWorkspace 字段。 */
export function isAgentWorkspacesIndex(
  value: unknown,
): value is JsonObject & { workspaces: Array<JsonObject & { slug: string }> } {
  return isJsonObject(value)
    && isVersion(value.version)
    && Array.isArray(value.workspaces)
    && value.workspaces.every(isAgentWorkspace)
}

/** 校验 AgentWorkspace 的必填字段和已知可选字段。 */
function isAgentWorkspace(value: unknown): value is JsonObject & { slug: string } {
  return isJsonObject(value)
    && isString(value.id)
    && isString(value.name)
    && isString(value.slug)
    && isNumber(value.createdAt)
    && isNumber(value.updatedAt)
    && isOptional(value.projectRootPath, isString)
    && isOptional(
      value.projectRootStatus,
      (item) => item === 'available' || item === 'missing' || item === 'not_directory' || item === 'unavailable',
    )
}

/** 校验 WorkspaceConfig 及 WorkspaceWorktreeRepo 字段。 */
export function isWorkspaceConfig(value: unknown): value is JsonObject {
  if (!isJsonObject(value)) return false
  if (!WORKSPACE_PATH_ARRAY_FIELDS.every((field) => isOptional(value[field], isStringArray))) return false
  if (!isOptional(value.worktreeRepos, isWorktreeRepos)) return false
  if (!isOptional(value.projectKnowledgeMaintenanceApproved, isBoolean)) return false
  return isOptional(value.memoryReview, isMemoryReview)
}

/** 校验 Pi entry binding 字典。 */
function isStringRecord(value: unknown): boolean {
  return isJsonObject(value) && Object.values(value).every(isString)
}

/** 校验退役 runtime transcript 标记。 */
function isLegacyTranscript(value: unknown): boolean {
  return isJsonObject(value) && value.sourceRuntime === 'claude' && value.continuationRequired === true
}

/** 校验活动 worktree 持久化对象。 */
function isActiveWorktree(value: unknown): boolean {
  return isJsonObject(value)
    && isString(value.path)
    && isString(value.mainRepoRoot)
    && isString(value.branch)
    && isNumber(value.selectedAt)
}

/** 校验 worktree repo 数组及真实必填字段。 */
function isWorktreeRepos(value: unknown): boolean {
  return Array.isArray(value) && value.every((repo) => isJsonObject(repo)
    && isString(repo.name)
    && isString(repo.repoPath)
    && isString(repo.worktreesPath)
    && isOptional(repo.priority, isNumber))
}

/** 校验工作区记忆复查元数据。 */
function isMemoryReview(value: unknown): boolean {
  return isJsonObject(value) && isOptional(value.lastPromptAt, isNumber)
}

/** 校验正整数配置版本。 */
function isVersion(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

/** 校验 JSON 字符串。 */
function isString(value: unknown): value is string {
  return typeof value === 'string'
}

/** 校验 JSON 布尔值。 */
function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean'
}

/** 校验有限数字。 */
function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** 校验字符串数组。 */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString)
}

/** 校验字符串是否属于给定枚举集合。 */
function isEnumString(value: unknown, allowed: Set<string>): boolean {
  return typeof value === 'string' && allowed.has(value)
}

/** 校验可选字段；null 不是 TypeScript optional 字段的合法替代。 */
function isOptional(value: unknown, validate: (item: unknown) => boolean): boolean {
  return value === undefined || validate(value)
}

/** 校验值是否为可保留未知字段的 JSON 对象。 */
export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
