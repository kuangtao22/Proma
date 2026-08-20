import { lstatSync } from 'node:fs'
import { basename, isAbsolute, join, posix, relative, resolve, sep, win32 } from 'node:path'
import type { PlatformPath } from 'node:path'
import { readJsonFileSafe, writeJsonFileAtomic } from './safe-file'

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

/** 保留未知 JSON 字段的对象表示。 */
interface JsonObject {
  [key: string]: unknown
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
  /** 旧根决定的路径平台语义，避免 POSIX 宿主误判 Windows 数据。 */
  const semantics = getAbsolutePathSemantics(sourceRoot)
  /** 新根的平台语义，必须与旧根一致。 */
  const targetSemantics = getAbsolutePathSemantics(targetRoot)

  if (!semantics || !targetSemantics) {
    throw new Error('sourceRoot 和 targetRoot 必须是绝对路径')
  }
  if (semantics.kind !== targetSemantics.kind) {
    throw new Error('sourceRoot 和 targetRoot 必须使用相同路径语义')
  }
  validateSemanticRootRelationship(sourceRoot, targetRoot, semantics.api)
  if (!isAbsoluteForSemantics(value, semantics)) return value

  /** 归一化后的旧数据根。 */
  const resolvedSourceRoot = semantics.api.resolve(sourceRoot)
  /** 归一化后的待判断路径。 */
  const resolvedValue = semantics.api.resolve(value)
  /** 待判断路径相对旧根的位置。 */
  const relativePath = semantics.api.relative(resolvedSourceRoot, resolvedValue)

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
  validateDataRoots(input.sourceRoot, input.targetRoot)

  /** 按处理顺序记录已安全读取的文件。 */
  const inspectedFiles: string[] = []
  /** 按处理顺序记录发生实际字段变化的文件。 */
  const updatedFiles: string[] = []
  /** 目标副本中的会话索引路径。 */
  const sessionsPath = join(input.targetRoot, 'agent-sessions.json')
  /** 目标副本中的工作区索引路径。 */
  const workspacesPath = join(input.targetRoot, 'agent-workspaces.json')
  /** 经 safe-file 恢复链读取的会话索引。 */
  const sessionsIndex = readPersistentJson(sessionsPath, isAgentSessionsIndex)

  if (sessionsIndex) {
    inspectedFiles.push(sessionsPath)
    if (rebaseSessionsIndex(sessionsIndex, input.sourceRoot, input.targetRoot)) {
      writeJsonFileAtomic(sessionsPath, sessionsIndex)
      updatedFiles.push(sessionsPath)
    }
  }

  /** 经 safe-file 恢复链读取的工作区索引。 */
  const workspacesIndex = readPersistentJson(workspacesPath, isAgentWorkspacesIndex)

  if (workspacesIndex) {
    inspectedFiles.push(workspacesPath)
    rebaseWorkspaceConfigs(workspacesIndex, input, inspectedFiles, updatedFiles)
  }

  return { inspectedFiles, updatedFiles }
}

/**
 * 判断绝对路径采用 POSIX 还是 Win32 数据语义。
 *
 * @param value 待识别的根路径。
 * @returns 绝对路径对应的 API；相对路径返回 null。
 */
function getAbsolutePathSemantics(value: string): PathSemantics | null {
  /** Windows 盘符绝对路径或 UNC 路径标记。 */
  const isWindowsAbsolute = /^[a-zA-Z]:[\\/]/.test(value) || /^\\\\[^\\/]+[\\/][^\\/]+/.test(value)
  if (isWindowsAbsolute && win32.isAbsolute(value)) return { api: win32, kind: 'win32' }
  if (posix.isAbsolute(value)) return { api: posix, kind: 'posix' }
  return null
}

/**
 * 按已选平台语义判断数据路径是否为同类绝对路径。
 *
 * @param value 待判断路径。
 * @param semantics 旧根采用的平台语义。
 * @returns 路径为同平台绝对路径时返回 true。
 */
function isAbsoluteForSemantics(value: string, semantics: PathSemantics): boolean {
  /** 待判断路径自身识别出的平台语义。 */
  const valueSemantics = getAbsolutePathSemantics(value)
  return valueSemantics?.kind === semantics.kind && semantics.api.isAbsolute(value)
}

/**
 * 判断 relative() 结果是否表示严格后代。
 *
 * @param relativePath 相对根路径。
 * @param pathApi 对应数据平台的 path API。
 * @returns 非空、非父级且非绝对路径时返回 true。
 */
function isStrictDescendantRelativePath(relativePath: string, pathApi: PlatformPath): boolean {
  return relativePath.length > 0
    && relativePath !== '..'
    && !relativePath.startsWith(`..${pathApi.sep}`)
    && !pathApi.isAbsolute(relativePath)
}

/**
 * 按数据平台语义验证新旧根不同且不嵌套。
 *
 * @param sourceRoot 迁移前数据根。
 * @param targetRoot 迁移后数据根。
 * @param pathApi 对应数据平台的 path API。
 */
function validateSemanticRootRelationship(
  sourceRoot: string,
  targetRoot: string,
  pathApi: PlatformPath,
): void {
  /** 新根相对旧根的位置。 */
  const targetFromSource = pathApi.relative(pathApi.resolve(sourceRoot), pathApi.resolve(targetRoot))
  /** 旧根相对新根的位置。 */
  const sourceFromTarget = pathApi.relative(pathApi.resolve(targetRoot), pathApi.resolve(sourceRoot))
  if (targetFromSource.length === 0) {
    throw new Error('sourceRoot 和 targetRoot 必须不同')
  }
  if (
    isStrictDescendantRelativePath(targetFromSource, pathApi)
    || isStrictDescendantRelativePath(sourceFromTarget, pathApi)
  ) {
    throw new Error('sourceRoot 和 targetRoot 不能互相嵌套')
  }
}

/**
 * 在任何文件 I/O 前验证数据根合同。
 *
 * @param sourceRoot 迁移前数据根。
 * @param targetRoot 目标副本数据根。
 */
function validateDataRoots(sourceRoot: string, targetRoot: string): void {
  if (!isAbsolute(sourceRoot) || !isAbsolute(targetRoot)) {
    throw new Error('sourceRoot 和 targetRoot 必须是绝对路径')
  }

  /** 归一化后的旧根。 */
  const resolvedSourceRoot = resolve(sourceRoot)
  /** 归一化后的目标根。 */
  const resolvedTargetRoot = resolve(targetRoot)
  /** 新根相对旧根的位置。 */
  const targetFromSource = relative(resolvedSourceRoot, resolvedTargetRoot)
  /** 旧根相对新根的位置。 */
  const sourceFromTarget = relative(resolvedTargetRoot, resolvedSourceRoot)

  if (targetFromSource.length === 0) {
    throw new Error('sourceRoot 和 targetRoot 必须不同')
  }
  if (
    isStrictHostDescendantRelativePath(targetFromSource)
    || isStrictHostDescendantRelativePath(sourceFromTarget)
  ) {
    throw new Error('sourceRoot 和 targetRoot 不能互相嵌套')
  }
}

/**
 * 读取一个支持主/tmp/bak 恢复的持久化 JSON 文件。
 *
 * @param filePath 主文件路径。
 * @param validate 目标 schema 校验器。
 * @returns 文件完全缺失时返回 null；存在但不可解释时抛错。
 */
function readPersistentJson<T extends JsonObject>(
  filePath: string,
  validate: (value: unknown) => value is T,
): T | null {
  /** 主文件及 safe-file 恢复候选。 */
  const candidatePaths = [filePath, `${filePath}.tmp`, `${filePath}.bak`]
  /** 是否至少存在一个普通文件候选。 */
  let hasCandidate = false

  for (const candidatePath of candidatePaths) {
    /** 候选的 lstat 结果；缺失时为 null。 */
    const candidateStat = lstatIfPresent(candidatePath)
    if (!candidateStat) continue
    if (candidateStat.isSymbolicLink() || !candidateStat.isFile()) {
      throw new Error(`配置候选必须是普通文件: ${candidatePath}`)
    }
    hasCandidate = true
  }

  if (!hasCandidate) return null

  /** safe-file 从第一个语法和 schema 均合法的候选恢复出的值。 */
  const value = readJsonFileSafe(filePath, { validate })
  if (!value) {
    throw new Error(`${basename(filePath)} 损坏或 schema 无法安全解释`)
  }
  return value
}

/**
 * 不跟随符号链接地读取文件状态。
 *
 * @param filePath 待检查路径。
 * @returns 路径不存在时返回 null，其余错误向上传播。
 */
function lstatIfPresent(filePath: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(filePath)
  } catch (error) {
    /** Node 文件系统错误码。 */
    const code = isNodeError(error) ? error.code : undefined
    if (code === 'ENOENT') return null
    throw error
  }
}

/**
 * 判断未知异常是否带 Node 错误码。
 *
 * @param error 捕获的未知异常。
 * @returns 可读取 code 字段时返回 true。
 */
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

/**
 * 校验会话索引可安全按声明字段解释。
 *
 * @param value JSON 候选值。
 * @returns 符合最小会话索引 schema 时返回 true。
 */
function isAgentSessionsIndex(value: unknown): value is JsonObject & { sessions: JsonObject[] } {
  if (!isJsonObject(value) || typeof value.version !== 'number' || !Array.isArray(value.sessions)) return false
  return value.sessions.every((session) => {
    if (!isJsonObject(session)) return false
    return SESSION_PATH_FIELDS.every((field) => isNullableString(session[field]))
      && SESSION_PATH_ARRAY_FIELDS.every((field) => isNullableStringArray(session[field]))
  })
}

/**
 * 校验工作区索引并取得可信 slug。
 *
 * @param value JSON 候选值。
 * @returns 符合最小工作区索引 schema 时返回 true。
 */
function isAgentWorkspacesIndex(value: unknown): value is JsonObject & { workspaces: Array<JsonObject & { slug: string }> } {
  return isJsonObject(value)
    && typeof value.version === 'number'
    && Array.isArray(value.workspaces)
    && value.workspaces.every((workspace) => isJsonObject(workspace) && typeof workspace.slug === 'string')
}

/**
 * 校验工作区配置中的已知路径字段，未知字段原样保留。
 *
 * @param value JSON 候选值。
 * @returns 已知字段可安全解释时返回 true。
 */
function isWorkspaceConfig(value: unknown): value is JsonObject {
  if (!isJsonObject(value)) return false
  if (!WORKSPACE_PATH_ARRAY_FIELDS.every((field) => isNullableStringArray(value[field]))) return false
  if (value.worktreeRepos === undefined || value.worktreeRepos === null) return true
  if (!Array.isArray(value.worktreeRepos)) return false
  return value.worktreeRepos.every((repo) => repo === null || (
    isJsonObject(repo)
    && isNullableString(repo.repoPath)
    && isNullableString(repo.worktreesPath)
  ))
}

/**
 * 判断值是否为可保留未知字段的 JSON 对象。
 *
 * @param value JSON 候选值。
 * @returns 非 null、非数组对象时返回 true。
 */
function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 判断可选路径单值是否安全。
 *
 * @param value 待校验字段。
 * @returns 缺失、null 或字符串时返回 true。
 */
function isNullableString(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || typeof value === 'string'
}

/**
 * 判断可选路径数组是否只含字符串或 null。
 *
 * @param value 待校验字段。
 * @returns 缺失、null 或合法数组时返回 true。
 */
function isNullableStringArray(value: unknown): value is Array<string | null> | null | undefined {
  return value === undefined
    || value === null
    || (Array.isArray(value) && value.every((item) => item === null || typeof item === 'string'))
}

/**
 * 重写会话索引的声明路径字段。
 *
 * @param index 已校验会话索引。
 * @param sourceRoot 迁移前数据根。
 * @param targetRoot 目标数据根。
 * @returns 至少一个字段变化时返回 true。
 */
function rebaseSessionsIndex(
  index: JsonObject & { sessions: JsonObject[] },
  sourceRoot: string,
  targetRoot: string,
): boolean {
  /** 索引是否发生实际字段变化。 */
  let changed = false
  for (const session of index.sessions) {
    for (const field of SESSION_PATH_FIELDS) {
      changed = rebaseStringField(session, field, sourceRoot, targetRoot) || changed
    }
    for (const field of SESSION_PATH_ARRAY_FIELDS) {
      changed = rebaseStringArrayField(session, field, sourceRoot, targetRoot) || changed
    }
  }
  return changed
}

/**
 * 按工作区索引重写受管配置文件。
 *
 * @param index 已校验工作区索引。
 * @param input 旧根与目标根。
 * @param inspectedFiles 已检查文件结果数组。
 * @param updatedFiles 已写回文件结果数组。
 */
function rebaseWorkspaceConfigs(
  index: JsonObject & { workspaces: Array<JsonObject & { slug: string }> },
  input: RebaseDataRootOwnedPathsInput,
  inspectedFiles: string[],
  updatedFiles: string[],
): void {
  /** 目标副本中的工作区受管目录。 */
  const workspacesRoot = resolve(input.targetRoot, 'agent-workspaces')
  /** 工作区根的状态，存在时不得为 symlink 或特殊文件。 */
  const workspacesRootStat = lstatIfPresent(workspacesRoot)
  if (workspacesRootStat && (workspacesRootStat.isSymbolicLink() || !workspacesRootStat.isDirectory())) {
    throw new Error(`工作区配置目录必须是普通目录: ${workspacesRoot}`)
  }

  for (const workspace of index.workspaces) {
    /** 索引声明的稳定工作区目录名。 */
    const slug = workspace.slug
    /** 当前工作区目录路径。 */
    const workspaceDir = resolve(workspacesRoot, slug)
    /** 当前工作区配置路径。 */
    const configPath = resolve(workspaceDir, 'config.json')
    if (
      slug.length === 0
      || basename(slug) !== slug
      || !isContainedPath(configPath, input.targetRoot)
      || !isContainedPath(configPath, workspacesRoot)
    ) {
      throw new Error(`工作区配置路径越过目标数据根: ${slug}`)
    }

    /** 当前工作区目录的状态。 */
    const workspaceDirStat = lstatIfPresent(workspaceDir)
    if (workspaceDirStat && (workspaceDirStat.isSymbolicLink() || !workspaceDirStat.isDirectory())) {
      throw new Error(`工作区配置目录必须是普通目录: ${workspaceDir}`)
    }

    /** 经恢复链读取并校验的工作区配置。 */
    const config = readPersistentJson(configPath, isWorkspaceConfig)
    if (!config) continue
    inspectedFiles.push(configPath)
    if (rebaseWorkspaceConfig(config, input.sourceRoot, input.targetRoot)) {
      writeJsonFileAtomic(configPath, config)
      updatedFiles.push(configPath)
    }
  }
}

/**
 * 判断候选路径是否严格位于指定根内。
 *
 * @param candidatePath 已解析的候选路径。
 * @param rootPath 约束根路径。
 * @returns 候选为根的严格后代时返回 true。
 */
function isContainedPath(candidatePath: string, rootPath: string): boolean {
  /** 候选相对约束根的位置。 */
  const relativePath = relative(resolve(rootPath), resolve(candidatePath))
  return isStrictHostDescendantRelativePath(relativePath)
}

/**
 * 按当前宿主平台判断 relative() 结果是否表示严格后代。
 *
 * @param relativePath 宿主 path.relative() 的结果。
 * @returns 非空、非父级且非绝对路径时返回 true。
 */
function isStrictHostDescendantRelativePath(relativePath: string): boolean {
  return relativePath.length > 0
    && relativePath !== '..'
    && !relativePath.startsWith(`..${sep}`)
    && !isAbsolute(relativePath)
}

/**
 * 重写单个工作区配置的声明路径字段。
 *
 * @param config 已校验配置对象。
 * @param sourceRoot 迁移前数据根。
 * @param targetRoot 目标数据根。
 * @returns 至少一个字段变化时返回 true。
 */
function rebaseWorkspaceConfig(config: JsonObject, sourceRoot: string, targetRoot: string): boolean {
  /** 配置是否发生实际字段变化。 */
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

/**
 * 重写对象中的一个字符串路径字段。
 *
 * @param object 持有字段的 JSON 对象。
 * @param field 字段名。
 * @param sourceRoot 迁移前数据根。
 * @param targetRoot 目标数据根。
 * @returns 字段实际变化时返回 true。
 */
function rebaseStringField(
  object: JsonObject,
  field: string,
  sourceRoot: string,
  targetRoot: string,
): boolean {
  /** 当前原始字段值。 */
  const currentValue = object[field]
  if (typeof currentValue !== 'string') return false
  /** 按严格根边界计算的新字段值。 */
  const rebasedValue = rebaseOwnedPath(currentValue, sourceRoot, targetRoot)
  if (rebasedValue === currentValue) return false
  object[field] = rebasedValue
  return true
}

/**
 * 重写对象中的一个字符串路径数组并保持顺序和 null。
 *
 * @param object 持有字段的 JSON 对象。
 * @param field 字段名。
 * @param sourceRoot 迁移前数据根。
 * @param targetRoot 目标数据根。
 * @returns 数组至少一个元素变化时返回 true。
 */
function rebaseStringArrayField(
  object: JsonObject,
  field: string,
  sourceRoot: string,
  targetRoot: string,
): boolean {
  /** 当前原始字段值。 */
  const currentValue = object[field]
  if (!Array.isArray(currentValue)) return false
  /** 数组是否存在实际变化。 */
  let changed = false
  /** 保持原顺序的新数组。 */
  const rebasedValues = currentValue.map((value) => {
    if (typeof value !== 'string') return value
    /** 当前数组元素按严格根边界计算的新值。 */
    const rebasedValue = rebaseOwnedPath(value, sourceRoot, targetRoot)
    if (rebasedValue !== value) changed = true
    return rebasedValue
  })
  if (changed) object[field] = rebasedValues
  return changed
}
