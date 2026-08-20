import { basename, isAbsolute, join, posix, relative, resolve, sep, win32 } from 'node:path'
import type { PlatformPath } from 'node:path'
import {
  captureDirectoryGuard,
  preflightPersistentJson,
  recoverPersistentJson,
  validateDataRoots,
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

  /** 全量 schema 通过后才执行 safe-file 恢复。 */
  const sessionsFile = sessionsPreflight
    ? recoverPersistentJson(sessionsPreflight, isAgentSessionsIndex, targetGuard)
    : null
  if (workspacesPreflight) recoverPersistentJson(workspacesPreflight, isAgentWorkspacesIndex, targetGuard)
  /** 恢复完成、可进入内存重写的工作区配置。 */
  const workspaceConfigFiles = workspaceConfigPreflights.map((preflight) => (
    recoverPersistentJson(preflight, isWorkspaceConfig, targetGuard)
  ))

  /** 实际发生 owned 字段变化的文件。 */
  const changedFiles: Array<PersistentJson<JsonObject>> = []
  if (sessionsFile && rebaseSessionsIndex(sessionsFile.value, input.sourceRoot, input.targetRoot)) {
    changedFiles.push(sessionsFile)
  }
  for (const configFile of workspaceConfigFiles) {
    if (rebaseWorkspaceConfig(configFile.value, input.sourceRoot, input.targetRoot)) changedFiles.push(configFile)
  }
  for (const changedFile of changedFiles) {
    writePersistentJson(changedFile, targetGuard)
    updatedFiles.push(changedFile.filePath)
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
  index: JsonObject & { workspaces: Array<JsonObject & { slug: string }> },
  targetGuard: TargetRootGuard,
  inspectedFiles: string[],
): Array<PreflightPersistentJson<JsonObject>> {
  for (const workspace of index.workspaces) {
    /** 在目录缺失快速路径前也必须校验的 slug。 */
    const slug = workspace.slug
    if (slug.length === 0 || basename(slug) !== slug) {
      throw new Error(`工作区配置路径越过目标数据根: ${slug}`)
    }
  }
  /** 目标副本中的工作区容器目录及 guard。 */
  const workspacesRootPath = resolve(targetGuard.requestedPath, 'agent-workspaces')
  const workspacesRootGuard = captureDirectoryGuard(workspacesRootPath, targetGuard)
  if (!workspacesRootGuard) return []
  /** 已完成 schema 预检的配置文件。 */
  const configFiles: Array<PreflightPersistentJson<JsonObject>> = []

  for (const workspace of index.workspaces) {
    /** 当前工作区目录和配置路径。 */
    const workspaceDirPath = resolve(workspacesRootPath, workspace.slug)
    const workspaceDirGuard = captureDirectoryGuard(workspaceDirPath, targetGuard)
    if (!workspaceDirGuard) continue
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
