import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { basename, isAbsolute, relative, resolve, sep } from 'node:path'
import { readJsonFileSafe, writeJsonFileAtomic } from './safe-file'
import type { JsonObject } from './owned-path-rebaser-schema'

/** 用于发现目录替换的稳定文件系统身份。 */
interface FileSystemIdentity {
  /** 文件系统设备号。 */
  dev: number | bigint
  /** 文件系统 inode。 */
  ino: number | bigint
}

/** 已验证目录的路径、物理位置与身份。 */
export interface DirectoryGuard extends FileSystemIdentity {
  /** 调用方使用的目录路径。 */
  requestedPath: string
  /** realpath 解析后的物理目录路径。 */
  canonicalPath: string
}

/** 已验证普通文件的路径、物理位置与身份。 */
interface FileGuard extends FileSystemIdentity {
  /** 调用方使用的文件路径。 */
  filePath: string
  /** realpath 解析后的物理文件路径。 */
  canonicalPath: string
  /** 检测同 inode 原地修改的文件大小。 */
  size: number | bigint
  /** 检测同 inode 原地修改的最后修改时间。 */
  mtimeMs: number | bigint
}

/** 目标数据根在整个重写过程中的稳定身份。 */
export interface TargetRootGuard extends DirectoryGuard {
  /** 迁移前数据根的物理路径，用于拒绝物理别名和嵌套。 */
  canonicalSourceRoot: string
}

/** safe-file 单个候选在读取前的状态。 */
interface CandidateState<T> {
  /** 已验证的普通文件；候选缺失时为 null。 */
  guard: FileGuard | null
  /** 文件内容是否符合调用方 schema。 */
  valid: boolean
  /** schema 合法时解析出的值。 */
  value?: T
}

/** safe-file 主/tmp/bak 候选状态。 */
interface CandidateStates<T> {
  /** 主文件状态。 */
  primary: CandidateState<T>
  /** 临时文件状态。 */
  temporary: CandidateState<T>
  /** 备份文件状态。 */
  backup: CandidateState<T>
}

/** 全量 schema 阶段只读取得、尚未触发 safe-file 恢复的 JSON 文件。 */
export interface PreflightPersistentJson<T extends JsonObject> {
  /** 主文件路径。 */
  filePath: string
  /** 优先级最高的合法候选值。 */
  value: T
  /** 预检时三个候选的身份和有效性。 */
  candidateStates: CandidateStates<T>
  /** 从目标根到文件父目录之间的受保护目录。 */
  directoryGuards: DirectoryGuard[]
}

/** 完成恢复读取和 schema 校验、可进入写回阶段的 JSON 文件。 */
export interface PersistentJson<T extends JsonObject> {
  /** 主文件路径。 */
  filePath: string
  /** 解析并保留未知字段的 JSON 值。 */
  value: T
  /** safe-file 返回后主文件的稳定身份。 */
  fileGuard: FileGuard
  /** 从目标根到文件父目录之间的受保护目录。 */
  directoryGuards: DirectoryGuard[]
}

/** 在任何索引 I/O 前验证目标根并解析新旧根物理关系。 */
export function validateDataRoots(sourceRoot: string, targetRoot: string): TargetRootGuard {
  if (!isAbsolute(sourceRoot) || !isAbsolute(targetRoot)) {
    throw new Error('sourceRoot 和 targetRoot 必须是绝对路径')
  }
  /** 新根相对旧根的请求路径位置。 */
  const requestedTargetFromSource = relative(resolve(sourceRoot), resolve(targetRoot))
  /** 旧根相对新根的请求路径位置。 */
  const requestedSourceFromTarget = relative(resolve(targetRoot), resolve(sourceRoot))
  if (requestedTargetFromSource.length === 0) throw new Error('sourceRoot 和 targetRoot 必须不同')
  if (
    isStrictHostDescendantRelativePath(requestedTargetFromSource)
    || isStrictHostDescendantRelativePath(requestedSourceFromTarget)
  ) {
    throw new Error('sourceRoot 和 targetRoot 不能互相嵌套')
  }

  /** 不跟随最终 symlink 取得的目标根状态。 */
  const targetStat = lstatIfPresent(targetRoot)
  if (!targetStat || targetStat.isSymbolicLink() || !targetStat.isDirectory()) {
    throw new Error(`targetRoot 必须是实际目录: ${targetRoot}`)
  }
  /** 不跟随最终 symlink 取得的旧根状态。 */
  const sourceStat = lstatIfPresent(sourceRoot)
  if (!sourceStat || sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) {
    throw new Error(`sourceRoot 必须是实际目录: ${sourceRoot}`)
  }
  /** 目标根的物理路径。 */
  const canonicalTargetRoot = realpathSync(targetRoot)
  /** 旧根的物理路径。 */
  const canonicalSourceRoot = realpathSync(sourceRoot)
  /** 物理新根相对物理旧根的位置。 */
  const targetFromSource = relative(canonicalSourceRoot, canonicalTargetRoot)
  /** 物理旧根相对物理新根的位置。 */
  const sourceFromTarget = relative(canonicalTargetRoot, canonicalSourceRoot)
  if (targetFromSource.length === 0) throw new Error('sourceRoot 和 targetRoot 必须不同')
  if (
    isStrictHostDescendantRelativePath(targetFromSource)
    || isStrictHostDescendantRelativePath(sourceFromTarget)
  ) {
    throw new Error('sourceRoot 和 targetRoot 不能互相嵌套')
  }
  return {
    requestedPath: targetRoot,
    canonicalPath: canonicalTargetRoot,
    canonicalSourceRoot,
    dev: targetStat.dev,
    ino: targetStat.ino,
  }
}

/** 只读预检主/tmp/bak，不触发 safe-file 恢复写入。 */
export function preflightPersistentJson<T extends JsonObject>(
  filePath: string,
  validate: (value: unknown) => value is T,
  targetGuard: TargetRootGuard,
  directoryGuards: DirectoryGuard[],
): PreflightPersistentJson<T> | null {
  verifyTargetRootGuard(targetGuard)
  verifyDirectoryGuards(directoryGuards, targetGuard)
  /** no-follow 检查并解析完成的候选状态。 */
  const candidateStates = inspectCandidateStates(filePath, validate, targetGuard)
  if (!candidateStates.primary.guard && !candidateStates.temporary.guard && !candidateStates.backup.guard) return null
  /** 按 safe-file 优先级选择但尚不提升的合法值。 */
  const value = selectCandidateValue(candidateStates)
  if (!value) throw new Error(`${basename(filePath)} 损坏或 schema 无法安全解释`)
  return { filePath, value, candidateStates, directoryGuards }
}

/** 全量 schema 通过后执行 safe-file 恢复并验证文件身份转换。 */
export function recoverPersistentJson<T extends JsonObject>(
  preflight: PreflightPersistentJson<T>,
  validate: (value: unknown) => value is T,
  targetGuard: TargetRootGuard,
): PersistentJson<T> {
  verifyTargetRootGuard(targetGuard)
  verifyDirectoryGuards(preflight.directoryGuards, targetGuard)
  /** 恢复前复验的候选状态。 */
  const beforeRecovery = inspectCandidateStates(preflight.filePath, validate, targetGuard)
  verifyCandidateStatesUnchanged(preflight.filePath, preflight.candidateStates, beforeRecovery)
  /** safe-file 从第一个合法候选恢复出的值。 */
  const value = readJsonFileSafe(preflight.filePath, { validate })
  verifyTargetRootGuard(targetGuard)
  verifyDirectoryGuards(preflight.directoryGuards, targetGuard)
  /** 恢复后的候选状态。 */
  const after = inspectCandidateStates(preflight.filePath, validate, targetGuard)
  if (!value) throw new Error(`${basename(preflight.filePath)} 损坏或 schema 无法安全解释`)
  verifySafeReadTransition(preflight.filePath, beforeRecovery, after)
  if (!after.primary.guard) throw new Error(`safe-file 未生成有效主文件: ${preflight.filePath}`)
  return {
    filePath: preflight.filePath,
    value,
    fileGuard: after.primary.guard,
    directoryGuards: preflight.directoryGuards,
  }
}

/** 原子写回已完成全量预检且 owned 字段有变化的 JSON。 */
export function writePersistentJson(file: PersistentJson<JsonObject>, targetGuard: TargetRootGuard): void {
  verifyTargetRootGuard(targetGuard)
  verifyDirectoryGuards(file.directoryGuards, targetGuard)
  /** 写入前主文件身份。 */
  const currentFile = captureFileGuard(file.filePath, targetGuard)
  assertSameGuard(file.fileGuard, currentFile, `写入前主文件被替换: ${file.filePath}`)
  inspectCandidateStates(file.filePath, isUnknown, targetGuard)
  writeJsonFileAtomic(file.filePath, file.value)
  verifyTargetRootGuard(targetGuard)
  verifyDirectoryGuards(file.directoryGuards, targetGuard)
  /** 写回后的主/tmp/bak 状态。 */
  const afterWrite = inspectCandidateStates(file.filePath, isUnknown, targetGuard)
  if (!afterWrite.primary.valid || afterWrite.temporary.guard) {
    throw new Error(`原子写回结果异常: ${file.filePath}`)
  }
}

/** 捕获目标根内一个实际目录的身份，拒绝 symlink 和根外物理位置。 */
export function captureDirectoryGuard(
  directoryPath: string,
  targetGuard: TargetRootGuard,
): DirectoryGuard | null {
  verifyTargetRootGuard(targetGuard)
  /** 不跟随最终 symlink 取得的目录状态。 */
  const directoryStat = lstatIfPresent(directoryPath)
  if (!directoryStat) return null
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    throw new Error(`工作区配置目录必须是普通目录: ${directoryPath}`)
  }
  /** 目录的物理路径。 */
  const canonicalPath = realpathSync(directoryPath)
  assertCanonicalContainment(canonicalPath, targetGuard.canonicalPath, directoryPath)
  return { requestedPath: directoryPath, canonicalPath, dev: directoryStat.dev, ino: directoryStat.ino }
}

/** 复验目标根没有被替换、改成 symlink 或改变物理位置。 */
export function verifyTargetRootGuard(guard: TargetRootGuard): void {
  /** 当前目标根状态。 */
  const currentStat = lstatIfPresent(guard.requestedPath)
  if (!currentStat || currentStat.isSymbolicLink() || !currentStat.isDirectory()) {
    throw new Error(`targetRoot 必须是实际目录: ${guard.requestedPath}`)
  }
  /** 当前目标根物理路径。 */
  const currentCanonicalPath = realpathSync(guard.requestedPath)
  if (!sameIdentity(guard, currentStat) || currentCanonicalPath !== guard.canonicalPath) {
    throw new Error(`重写期间 targetRoot 被替换: ${guard.requestedPath}`)
  }
}

/** 检查主/tmp/bak 候选并安全解析 schema。 */
function inspectCandidateStates<T>(
  filePath: string,
  validate: (value: unknown) => value is T,
  targetGuard: TargetRootGuard,
): CandidateStates<T> {
  /** 三个候选各自的 no-follow guard。 */
  const primaryGuard = captureFileGuard(filePath, targetGuard)
  const temporaryGuard = captureFileGuard(`${filePath}.tmp`, targetGuard)
  const backupGuard = captureFileGuard(`${filePath}.bak`, targetGuard)
  return {
    primary: readCandidateState(primaryGuard, validate, targetGuard),
    temporary: readCandidateState(temporaryGuard, validate, targetGuard),
    backup: readCandidateState(backupGuard, validate, targetGuard),
  }
}

/** 读取候选内容并复验同一文件身份。 */
function readCandidateState<T>(
  guard: FileGuard | null,
  validate: (value: unknown) => value is T,
  targetGuard: TargetRootGuard,
): CandidateState<T> {
  if (!guard) return { guard: null, valid: false }
  try {
    /** 候选文件原文。 */
    const raw = readFileSync(guard.filePath, 'utf-8')
    /** 读取后文件身份。 */
    const afterRead = captureFileGuard(guard.filePath, targetGuard)
    if (!afterRead || !sameStableFile(guard, afterRead)) {
      throw new Error(`读取期间配置候选被替换: ${guard.filePath}`)
    }
    if (raw.trim().length === 0) return { guard, valid: false }
    /** 候选 JSON 解析值。 */
    const parsed: unknown = JSON.parse(raw)
    return validate(parsed) ? { guard, valid: true, value: parsed } : { guard, valid: false }
  } catch (error) {
    if (error instanceof SyntaxError) return { guard, valid: false }
    throw error
  }
}

/** 捕获目标根内一个普通文件候选的身份。 */
function captureFileGuard(filePath: string, targetGuard: TargetRootGuard): FileGuard | null {
  verifyTargetRootGuard(targetGuard)
  /** 不跟随最终 symlink 取得的候选状态。 */
  const fileStat = lstatIfPresent(filePath)
  if (!fileStat) return null
  if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
    throw new Error(`配置候选必须是普通文件: ${filePath}`)
  }
  /** 候选物理路径。 */
  const canonicalPath = realpathSync(filePath)
  assertCanonicalContainment(canonicalPath, targetGuard.canonicalPath, filePath)
  return {
    filePath,
    canonicalPath,
    dev: fileStat.dev,
    ino: fileStat.ino,
    size: fileStat.size,
    mtimeMs: fileStat.mtimeMs,
  }
}

/** 按 safe-file 主/tmp/bak 优先级选择只读预检值。 */
function selectCandidateValue<T>(states: CandidateStates<T>): T | undefined {
  if (states.primary.valid) return states.primary.value
  if (states.temporary.valid) return states.temporary.value
  if (states.backup.valid) return states.backup.value
  return undefined
}

/** 验证恢复前所有候选均未变化。 */
function verifyCandidateStatesUnchanged<T>(
  filePath: string,
  expected: CandidateStates<T>,
  actual: CandidateStates<T>,
): void {
  assertOptionalGuardUnchanged(expected.primary.guard, actual.primary.guard, `预检后主文件被替换: ${filePath}`)
  assertOptionalGuardUnchanged(expected.temporary.guard, actual.temporary.guard, `预检后 tmp 被替换: ${filePath}.tmp`)
  assertOptionalGuardUnchanged(expected.backup.guard, actual.backup.guard, `预检后 bak 被替换: ${filePath}.bak`)
}

/** 验证 safe-file 只执行主文件读取、tmp 提升或 bak 恢复之一。 */
function verifySafeReadTransition<T>(filePath: string, before: CandidateStates<T>, after: CandidateStates<T>): void {
  if (before.primary.valid && before.primary.guard) {
    assertSameGuard(before.primary.guard, after.primary.guard, `读取期间主文件被替换: ${filePath}`)
    assertOptionalGuardUnchanged(before.temporary.guard, after.temporary.guard, `读取期间 tmp 被替换: ${filePath}.tmp`)
    assertOptionalGuardUnchanged(before.backup.guard, after.backup.guard, `读取期间 bak 被替换: ${filePath}.bak`)
    return
  }
  if (before.temporary.valid && before.temporary.guard) {
    assertSameGuard(before.temporary.guard, after.primary.guard, `tmp 恢复身份异常: ${filePath}`)
    if (after.temporary.guard) throw new Error(`tmp 恢复后候选仍存在: ${filePath}.tmp`)
    assertOptionalGuardUnchanged(before.backup.guard, after.backup.guard, `tmp 恢复期间 bak 被替换: ${filePath}.bak`)
    return
  }
  if (before.backup.valid && before.backup.guard) {
    assertSameGuard(before.backup.guard, after.backup.guard, `bak 恢复期间备份被替换: ${filePath}.bak`)
    if (!after.primary.guard || !after.primary.valid) throw new Error(`bak 恢复未生成有效主文件: ${filePath}`)
    return
  }
  throw new Error(`${basename(filePath)} 损坏或 schema 无法安全解释`)
}

/** 复验配置父目录链身份和物理 containment。 */
function verifyDirectoryGuards(guards: DirectoryGuard[], targetGuard: TargetRootGuard): void {
  for (const guard of guards) {
    /** 当前目录状态。 */
    const currentStat = lstatIfPresent(guard.requestedPath)
    if (!currentStat || currentStat.isSymbolicLink() || !currentStat.isDirectory()) {
      throw new Error(`工作区配置目录必须是普通目录: ${guard.requestedPath}`)
    }
    /** 当前目录物理路径。 */
    const currentCanonicalPath = realpathSync(guard.requestedPath)
    if (!sameIdentity(guard, currentStat) || currentCanonicalPath !== guard.canonicalPath) {
      throw new Error(`重写期间工作区配置目录被替换: ${guard.requestedPath}`)
    }
    assertCanonicalContainment(currentCanonicalPath, targetGuard.canonicalPath, guard.requestedPath)
  }
}

/** 断言物理路径严格位于 canonical 目标根内部。 */
function assertCanonicalContainment(candidate: string, canonicalRoot: string, requestedPath: string): void {
  /** 候选物理路径相对目标物理根的位置。 */
  const relativePath = relative(canonicalRoot, candidate)
  if (!isStrictHostDescendantRelativePath(relativePath)) {
    throw new Error(`配置候选越过目标数据根: ${requestedPath}`)
  }
}

/** 比较可选文件 guard 的存在性和稳定文件属性。 */
function assertOptionalGuardUnchanged(expected: FileGuard | null, actual: FileGuard | null, message: string): void {
  if (!expected && !actual) return
  if (!expected || !actual || !sameStableFile(expected, actual)) throw new Error(message)
}

/** 断言两个文件 guard 稳定属性相同。 */
function assertSameGuard(expected: FileGuard, actual: FileGuard | null, message: string): void {
  if (!actual || !sameStableFile(expected, actual)) throw new Error(message)
}

/** 比较文件身份、大小和修改时间。 */
function sameStableFile(left: FileGuard, right: FileGuard): boolean {
  return sameIdentity(left, right) && left.size === right.size && left.mtimeMs === right.mtimeMs
}

/** 比较两个文件系统对象的设备号和 inode。 */
function sameIdentity(left: FileSystemIdentity, right: FileSystemIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

/** 按当前宿主平台判断 relative() 结果是否表示严格后代。 */
function isStrictHostDescendantRelativePath(relativePath: string): boolean {
  return relativePath.length > 0
    && relativePath !== '..'
    && !relativePath.startsWith(`..${sep}`)
    && !isAbsolute(relativePath)
}

/** 不跟随符号链接地读取文件状态。 */
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

/** 判断未知异常是否带 Node 错误码。 */
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

/** 写后只检查文件安全属性时接受任意已解析 JSON 值。 */
function isUnknown(_value: unknown): _value is unknown {
  return true
}
