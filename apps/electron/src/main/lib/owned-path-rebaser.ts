import { isAbsolute, join, posix, relative, resolve, sep, win32 } from 'node:path'
import type { PlatformPath } from 'node:path'
import {
  captureDirectoryGuard,
  needsPersistentJsonCommit,
  preflightPersistentJson,
  recoverPersistentJson,
  validateDataRoots,
  validateUniqueCandidateOwnership,
  verifyTargetRootGuard,
  writePersistentJson,
} from './owned-path-rebaser-safe-json'
import type {
  DirectoryGuard,
  PersistentJson,
  PreflightPersistentJson,
  TargetRootGuard,
} from './owned-path-rebaser-safe-json'
import {
  isAgentSessionsIndex,
  isAgentWorkspacesIndex,
  isJsonObject,
  isWorkspaceConfig,
} from './owned-path-rebaser-schema'
import type { JsonObject } from './owned-path-rebaser-schema'
import { isWorkspaceSlug } from './workspace-slug'

/** 数据根重写参数。 */
export interface RebaseDataRootOwnedPathsInput {
  /** 迁移前数据根。 */
  sourceRoot: string
  /** 已完成复制、等待重写的目标数据根。 */
  targetRoot: string
}

/** 数据根重写结果，供迁移状态机记录实际 I/O。 */
export interface RebaseDataRootOwnedPathsResult {
  /** 成功读取并校验过的持久化文件。 */
  inspectedFiles: string[]
  /** 因 Proma-owned 路径发生变化而原子写回的文件。 */
  updatedFiles: string[]
}

/** 路径字符串采用的数据平台语义。 */
interface PathSemantics {
  /** 对应平台的 path API。 */
  api: PlatformPath
  /** 数据路径类型。 */
  kind: 'posix' | 'win32'
}

/** 会话索引中由 Proma 拥有的单值绝对路径字段。 */
const SESSION_PATH_FIELDS = ['piSessionFile', 'forkSourceDir'] as const
/** 会话索引中由 Proma 拥有的绝对路径数组字段。 */
const SESSION_PATH_ARRAY_FIELDS = ['attachedDirectories', 'attachedFiles'] as const
/** 工作区配置中由 Proma 拥有的绝对路径数组字段。 */
const WORKSPACE_PATH_ARRAY_FIELDS = ['attachedDirectories', 'attachedFiles'] as const

/**
 * 只重写严格位于旧根内部的绝对路径。
 *
 * @param value 待判断的持久化路径值。
 * @param sourceRoot 迁移前数据根。
 * @param targetRoot 迁移后数据根。
 * @returns 根内路径映射到目标根后的值，其余值原样返回。
 */
export function rebaseOwnedPath(value: string, sourceRoot: string, targetRoot: string): string {
  /** 旧根决定的平台语义。 */
  const semantics = getAbsolutePathSemantics(sourceRoot)
  /** 新根的平台语义。 */
  const targetSemantics = getAbsolutePathSemantics(targetRoot)
  if (!semantics || !targetSemantics) throw new Error('sourceRoot 和 targetRoot 必须是绝对路径')
  if (semantics.kind !== targetSemantics.kind) throw new Error('sourceRoot 和 targetRoot 必须使用相同路径语义')
  validateSemanticRootRelationship(sourceRoot, targetRoot, semantics.api)
  if (!isAbsoluteForSemantics(value, semantics)) return value

  /** 待判断路径相对旧根的位置。 */
  const relativePath = semantics.api.relative(semantics.api.resolve(sourceRoot), semantics.api.resolve(value))
  if (!isStrictDescendantRelativePath(relativePath, semantics.api)) return value
  return semantics.api.join(targetRoot, relativePath)
}

/**
 * 重写已复制到目标数据根的 Proma-owned 绝对路径字段。
 *
 * @param input 旧根与目标副本根。
 * @returns 已检查和实际写回的文件列表。
 */
export function rebaseDataRootOwnedPaths(
  input: RebaseDataRootOwnedPathsInput,
): RebaseDataRootOwnedPathsResult {
  /** 在任何索引 I/O 前建立的目标根物理身份。 */
  const targetGuard = validateDataRoots(input.sourceRoot, input.targetRoot)
  /** 按处理顺序记录已安全读取的文件。 */
  const inspectedFiles: string[] = []
  /** 按处理顺序记录发生实际字段变化的文件。 */
  const updatedFiles: string[] = []
  /** 两个受管索引路径。 */
  const sessionsPath = join(input.targetRoot, 'agent-sessions.json')
  const workspacesPath = join(input.targetRoot, 'agent-workspaces.json')
  /** 尚未触发恢复写入的索引预检结果。 */
  const sessionsPreflight = preflightPersistentJson(sessionsPath, isAgentSessionsIndex, targetGuard, [])
  const workspacesPreflight = preflightPersistentJson(workspacesPath, isAgentWorkspacesIndex, targetGuard, [])
  if (sessionsPreflight) inspectedFiles.push(sessionsPath)
  if (workspacesPreflight) inspectedFiles.push(workspacesPath)

  /** 全量 schema 预检完成的工作区配置。 */
  const workspaceConfigPreflights = workspacesPreflight
    ? preflightWorkspaceConfigFiles(workspacesPreflight.value, targetGuard, inspectedFiles)
    : []
  /** 所有 main/tmp/bak 候选必须在任何恢复或提交前拥有唯一物理身份。 */
  const allPreflights = [sessionsPreflight, workspacesPreflight, ...workspaceConfigPreflights]
    .filter((preflight): preflight is PreflightPersistentJson<JsonObject> => preflight !== null)
  validateUniqueCandidateOwnership(allPreflights)

  /** 全量 schema 与所有权预检通过后，仅在内存中选择恢复值。 */
  const sessionsFile = sessionsPreflight
    ? recoverPersistentJson(sessionsPreflight, isAgentSessionsIndex, targetGuard)
    : null
  const workspacesFile = workspacesPreflight
    ? recoverPersistentJson(workspacesPreflight, isAgentWorkspacesIndex, targetGuard)
    : null
  /** 恢复完成、可进入内存重写的工作区配置。 */
  const workspaceConfigFiles = workspaceConfigPreflights.map((preflight) => (
    recoverPersistentJson(preflight, isWorkspaceConfig, targetGuard)
  ))

  /** owned 变化或候选恢复需要提交的文件。 */
  const filesToCommit: Array<PersistentJson<JsonObject>> = []
  /** 防止同一恢复对象被重复加入写队列。 */
  const queuedFiles = new Set<PersistentJson<JsonObject>>()
  /** 防止不同对象以同一路径重复加入写队列。 */
  const queuedPaths = new Set<string>()
  /** 仅记录实际发生 owned 路径变化的文件，保持结果合同稳定。 */
  const ownedChangedPaths = new Set<string>()
  if (sessionsFile) {
    if (rebaseSessionsIndex(sessionsFile.value, input.sourceRoot, input.targetRoot)) {
      ownedChangedPaths.add(sessionsFile.filePath)
    }
    if (ownedChangedPaths.has(sessionsFile.filePath) || needsPersistentJsonCommit(sessionsFile)) {
      queuePersistentCommit(sessionsFile, filesToCommit, queuedFiles, queuedPaths)
    }
  }
  if (workspacesFile && needsPersistentJsonCommit(workspacesFile)) {
    queuePersistentCommit(workspacesFile, filesToCommit, queuedFiles, queuedPaths)
  }
  for (const configFile of workspaceConfigFiles) {
    if (rebaseWorkspaceConfig(configFile.value, input.sourceRoot, input.targetRoot)) {
      ownedChangedPaths.add(configFile.filePath)
    }
    if (ownedChangedPaths.has(configFile.filePath) || needsPersistentJsonCommit(configFile)) {
      queuePersistentCommit(configFile, filesToCommit, queuedFiles, queuedPaths)
    }
  }
  for (const file of filesToCommit) {
    writePersistentJson(file, targetGuard)
    if (ownedChangedPaths.has(file.filePath)) updatedFiles.push(file.filePath)
  }
  verifyTargetRootGuard(targetGuard)
  return { inspectedFiles, updatedFiles }
}

/** 判断绝对路径采用 POSIX 还是 Win32 数据语义。 */
function getAbsolutePathSemantics(value: string): PathSemantics | null {
  /** Windows 盘符绝对路径、反斜杠 UNC 或 slash UNC 标记。 */
  const isWindowsAbsolute = /^[a-zA-Z]:[\\/]/.test(value)
    || /^\\\\[^\\/]+[\\/][^\\/]+/.test(value)
    || /^\/\/[^/]+\/[^/]+/.test(value)
  if (isWindowsAbsolute && win32.isAbsolute(value)) return { api: win32, kind: 'win32' }
  if (posix.isAbsolute(value)) return { api: posix, kind: 'posix' }
  return null
}

/** 按已选平台语义判断数据路径是否为同类绝对路径。 */
function isAbsoluteForSemantics(value: string, semantics: PathSemantics): boolean {
  /** 待判断路径自身的平台语义。 */
  const valueSemantics = getAbsolutePathSemantics(value)
  return valueSemantics?.kind === semantics.kind && semantics.api.isAbsolute(value)
}

/** 判断 relative() 结果是否表示严格后代。 */
function isStrictDescendantRelativePath(relativePath: string, pathApi: PlatformPath): boolean {
  return relativePath.length > 0
    && relativePath !== '..'
    && !relativePath.startsWith(`..${pathApi.sep}`)
    && !pathApi.isAbsolute(relativePath)
}

/** 按数据平台语义验证新旧根不同且不嵌套。 */
function validateSemanticRootRelationship(sourceRoot: string, targetRoot: string, pathApi: PlatformPath): void {
  /** 新旧根的双向相对位置。 */
  const targetFromSource = pathApi.relative(pathApi.resolve(sourceRoot), pathApi.resolve(targetRoot))
  const sourceFromTarget = pathApi.relative(pathApi.resolve(targetRoot), pathApi.resolve(sourceRoot))
  if (targetFromSource.length === 0) throw new Error('sourceRoot 和 targetRoot 必须不同')
  if (
    isStrictDescendantRelativePath(targetFromSource, pathApi)
    || isStrictDescendantRelativePath(sourceFromTarget, pathApi)
  ) {
    throw new Error('sourceRoot 和 targetRoot 不能互相嵌套')
  }
}

/** 根据工作区索引只读预检所有实际配置文件。 */
function preflightWorkspaceConfigFiles(
  index: JsonObject & { workspaces: Array<JsonObject & { id: string; slug: string }> },
  targetGuard: TargetRootGuard,
  inspectedFiles: string[],
): Array<PreflightPersistentJson<JsonObject>> {
  /** 已声明的 workspace id，用于建立唯一所有权。 */
  const workspaceIds = new Set<string>()
  /** 已声明的 workspace slug，用于阻止同一配置被重复处理。 */
  const workspaceSlugs = new Set<string>()
  for (const workspace of index.workspaces) {
    /** 在目录缺失快速路径前也必须校验的 slug。 */
    const slug = workspace.slug
    if (!isWorkspaceSlug(slug)) throw new Error(`workspace slug 不符合生成合同: ${slug}`)
    if (workspaceIds.has(workspace.id)) {
      throw new Error(`agent-workspaces.json 存在重复 workspace id: ${workspace.id}`)
    }
    if (workspaceSlugs.has(slug)) {
      throw new Error(`agent-workspaces.json 存在重复 workspace slug: ${slug}`)
    }
    workspaceIds.add(workspace.id)
    workspaceSlugs.add(slug)
  }
  /** 目标副本中的工作区容器目录及 guard。 */
  const workspacesRootPath = resolve(targetGuard.requestedPath, 'agent-workspaces')
  const workspacesRootGuard = captureDirectoryGuard(workspacesRootPath, targetGuard)
  if (!workspacesRootGuard) return []
  /** 已完成 schema 预检的配置文件。 */
  const configFiles: Array<PreflightPersistentJson<JsonObject>> = []
  /** 已认领的 workspace 目录 canonical 路径。 */
  const workspaceDirectoryCanonicalPaths = new Set<string>()
  /** 已认领的 workspace 目录 dev/ino。 */
  const workspaceDirectoryIdentities = new Set<string>()

  for (const workspace of index.workspaces) {
    /** 当前工作区目录和配置路径。 */
    const workspaceDirPath = resolve(workspacesRootPath, workspace.slug)
    const workspaceDirGuard = captureDirectoryGuard(workspaceDirPath, targetGuard)
    if (!workspaceDirGuard) continue
    claimUniquePhysicalOwnership(
      workspaceDirGuard.canonicalPath,
      workspaceDirGuard.dev,
      workspaceDirGuard.ino,
      workspaceDirectoryCanonicalPaths,
      workspaceDirectoryIdentities,
      'workspace 目录',
    )
    const configPath = resolve(workspaceDirPath, 'config.json')
    if (!isContainedPath(configPath, targetGuard.requestedPath)) {
      throw new Error(`工作区配置路径越过目标数据根: ${workspace.slug}`)
    }
    /** 配置父目录的完整保护链。 */
    const directoryGuards: DirectoryGuard[] = [workspacesRootGuard, workspaceDirGuard]
    /** 只读预检结果。 */
    const configFile = preflightPersistentJson(configPath, isWorkspaceConfig, targetGuard, directoryGuards)
    if (!configFile) continue
    inspectedFiles.push(configPath)
    configFiles.push(configFile)
  }
  return configFiles
}

/** 声明 canonical 路径和 dev/ino 的唯一所有权。 */
function claimUniquePhysicalOwnership(
  canonicalPath: string,
  dev: number | bigint,
  ino: number | bigint,
  canonicalPaths: Set<string>,
  identities: Set<string>,
  label: string,
): void {
  /** 跨 number/bigint 稳定表示的设备和 inode 组合。 */
  const identity = `${String(dev)}:${String(ino)}`
  if (canonicalPaths.has(canonicalPath) || identities.has(identity)) {
    throw new Error(`${label}物理身份重复: ${canonicalPath}`)
  }
  canonicalPaths.add(canonicalPath)
  identities.add(identity)
}

/** 将待归一化文件加入提交队列，并拒绝对象或主路径重复。 */
function queuePersistentCommit(
  file: PersistentJson<JsonObject>,
  changedFiles: Array<PersistentJson<JsonObject>>,
  queuedFiles: Set<PersistentJson<JsonObject>>,
  queuedPaths: Set<string>,
): void {
  /** 归一化后的写回主路径。 */
  const normalizedPath = resolve(file.filePath)
  if (queuedFiles.has(file) || queuedPaths.has(normalizedPath)) {
    throw new Error(`PersistentJson 重复加入写队列: ${file.filePath}`)
  }
  queuedFiles.add(file)
  queuedPaths.add(normalizedPath)
  changedFiles.push(file)
}

/** 重写会话索引的声明路径字段。 */
function rebaseSessionsIndex(
  index: JsonObject & { sessions: JsonObject[] },
  sourceRoot: string,
  targetRoot: string,
): boolean {
  /** 索引是否发生实际变化。 */
  let changed = false
  for (const session of index.sessions) {
    for (const field of SESSION_PATH_FIELDS) changed = rebaseStringField(session, field, sourceRoot, targetRoot) || changed
    for (const field of SESSION_PATH_ARRAY_FIELDS) {
      changed = rebaseStringArrayField(session, field, sourceRoot, targetRoot) || changed
    }
  }
  return changed
}

/** 重写单个工作区配置的声明路径字段。 */
function rebaseWorkspaceConfig(config: JsonObject, sourceRoot: string, targetRoot: string): boolean {
  /** 配置是否发生实际变化。 */
  let changed = false
  for (const field of WORKSPACE_PATH_ARRAY_FIELDS) {
    changed = rebaseStringArrayField(config, field, sourceRoot, targetRoot) || changed
  }
  if (Array.isArray(config.worktreeRepos)) {
    for (const repo of config.worktreeRepos) {
      if (!isJsonObject(repo)) continue
      changed = rebaseStringField(repo, 'repoPath', sourceRoot, targetRoot) || changed
      changed = rebaseStringField(repo, 'worktreesPath', sourceRoot, targetRoot) || changed
    }
  }
  return changed
}

/** 重写对象中的一个字符串路径字段。 */
function rebaseStringField(object: JsonObject, field: string, sourceRoot: string, targetRoot: string): boolean {
  /** 当前原始字段值。 */
  const currentValue = object[field]
  if (typeof currentValue !== 'string') return false
  /** 严格根边界计算的新值。 */
  const rebasedValue = rebaseOwnedPath(currentValue, sourceRoot, targetRoot)
  if (rebasedValue === currentValue) return false
  object[field] = rebasedValue
  return true
}

/** 重写字符串路径数组并保持重复项与顺序。 */
function rebaseStringArrayField(
  object: JsonObject,
  field: string,
  sourceRoot: string,
  targetRoot: string,
): boolean {
  /** 当前原始字段值。 */
  const currentValue = object[field]
  if (!Array.isArray(currentValue)) return false
  /** 数组是否发生实际变化。 */
  let changed = false
  /** 保持重复项和原顺序的新数组。 */
  const rebasedValues = currentValue.map((value) => {
    if (typeof value !== 'string') return value
    /** 当前元素的新值。 */
    const rebasedValue = rebaseOwnedPath(value, sourceRoot, targetRoot)
    if (rebasedValue !== value) changed = true
    return rebasedValue
  })
  if (changed) object[field] = rebasedValues
  return changed
}

/** 判断候选路径是否严格位于指定根内。 */
function isContainedPath(candidatePath: string, rootPath: string): boolean {
  /** 候选相对约束根的位置。 */
  const relativePath = relative(resolve(rootPath), resolve(candidatePath))
  return relativePath.length > 0
    && relativePath !== '..'
    && !relativePath.startsWith(`..${sep}`)
    && !isAbsolute(relativePath)
}
