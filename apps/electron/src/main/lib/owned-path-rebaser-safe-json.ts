import { createHash, randomBytes } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { JsonObject } from './owned-path-rebaser-schema'

/** 用于发现目录替换的稳定文件系统身份。 */
interface FileSystemIdentity {
  /** 文件系统设备号。 */
  dev: number | bigint
  /** 文件系统 inode。 */
  ino: number | bigint
}

/** Stats 与 BigIntStats 共用的文件稳定属性。 */
interface FileSystemStat extends FileSystemIdentity {
  /** 文件字节数。 */
  size: number | bigint
  /** 文件最后修改时间。 */
  mtimeMs: number | bigint
  /** 文件硬链接数。 */
  nlink: number | bigint
  /** 判断 stat 对象是否表示普通文件。 */
  isFile(): boolean
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
  /** 拒绝树外硬链接和候选别名。 */
  nlink: number | bigint
  /** 受控 fd 读取的原始字节 SHA-256。 */
  contentSha256: string
}

/** 单次受控 fd 读取返回的文件 guard 与原始字节。 */
interface CapturedFile {
  /** 包含内容摘要的稳定 guard。 */
  guard: FileGuard
  /** 与 guard 摘要对应的原始字节。 */
  bytes: Buffer
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
  /** 本次受控 fd 读取的原始字节 SHA-256。 */
  contentSha256: string | null
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
  /** 进入提交阶段前必须保持不变的三个候选状态。 */
  candidateStates: CandidateStates<T>
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

/** 全量 schema 通过后复验候选，并保持恢复值只存在于内存。 */
export function recoverPersistentJson<T extends JsonObject>(
  preflight: PreflightPersistentJson<T>,
  validate: (value: unknown) => value is T,
  targetGuard: TargetRootGuard,
): PersistentJson<T> {
  verifyTargetRootGuard(targetGuard)
  verifyDirectoryGuards(preflight.directoryGuards, targetGuard)
  /** 恢复前复验的候选状态。 */
  const candidateStates = inspectCandidateStates(preflight.filePath, validate, targetGuard)
  verifyCandidateStatesUnchanged(preflight.filePath, preflight.candidateStates, candidateStates)
  /** 按兼容优先级选择、但尚未落盘的恢复值。 */
  const value = selectCandidateValue(candidateStates)
  if (!value) throw new Error(`${basename(preflight.filePath)} 损坏或 schema 无法安全解释`)
  return {
    filePath: preflight.filePath,
    value,
    candidateStates,
    directoryGuards: preflight.directoryGuards,
  }
}

/** 判断主文件、tmp 或 backup 是否需要归一化为当前内存值。 */
export function needsPersistentJsonCommit(file: PersistentJson<JsonObject>): boolean {
  /** 当前内存目标值的稳定 JSON 表示。 */
  const expected = JSON.stringify(file.value)
  /** 当前主文件是否已是目标值。 */
  const primaryMatches = file.candidateStates.primary.valid
    && JSON.stringify(file.candidateStates.primary.value) === expected
  /** 当前 backup 是否已是目标值。 */
  const backupMatches = file.candidateStates.backup.valid
    && JSON.stringify(file.candidateStates.backup.value) === expected
  return !primaryMatches || Boolean(file.candidateStates.temporary.guard) || (Boolean(file.candidateStates.backup.guard) && !backupMatches)
}

/** 原子写回已完成全量预检的 JSON，并让 main 与 backup 保存同一目标内容。 */
export function writePersistentJson(file: PersistentJson<JsonObject>, targetGuard: TargetRootGuard): void {
  verifyTargetRootGuard(targetGuard)
  verifyDirectoryGuards(file.directoryGuards, targetGuard)
  /** 写入前复验的全部固定候选状态。 */
  const beforeWrite = inspectCandidateStates(file.filePath, isUnknown, targetGuard)
  verifyCandidateStatesUnchanged(file.filePath, file.candidateStates, beforeWrite)
  /** main 与 backup 共用的 UTF-8 目标字节。 */
  const content = `${JSON.stringify(file.value, null, 2)}\n`
  replaceWithAtomicLeaf(
    `${file.filePath}.bak`,
    beforeWrite.backup.guard,
    content,
    file.directoryGuards,
    targetGuard,
  )
  replaceWithAtomicLeaf(
    file.filePath,
    beforeWrite.primary.guard,
    content,
    file.directoryGuards,
    targetGuard,
  )
  cleanupControlledTemporary(file.filePath, beforeWrite.temporary.guard, file.directoryGuards, targetGuard)
  verifyTargetRootGuard(targetGuard)
  verifyDirectoryGuards(file.directoryGuards, targetGuard)
  /** 写回后的主/tmp/bak 状态。 */
  const afterWrite = inspectCandidateStates(file.filePath, isUnknown, targetGuard)
  if (!afterWrite.primary.valid || !afterWrite.backup.valid || afterWrite.temporary.guard) {
    throw new Error(`原子写回结果异常: ${file.filePath}`)
  }
  if (afterWrite.primary.contentSha256 !== afterWrite.backup.contentSha256) {
    throw new Error(`原子写回 main 与 backup 内容不一致: ${file.filePath}`)
  }
}

/** 拒绝所有预检文件之间 main/tmp/bak 的 canonical 路径或 dev/ino 别名。 */
export function validateUniqueCandidateOwnership(
  preflights: Array<PreflightPersistentJson<JsonObject>>,
): void {
  /** 已认领的候选 canonical 路径。 */
  const canonicalPaths = new Set<string>()
  /** 已认领的候选 dev/ino。 */
  const identities = new Set<string>()
  for (const preflight of preflights) {
    for (const candidate of Object.values(preflight.candidateStates)) {
      if (!candidate.guard) continue
      /** 跨 number/bigint 稳定表示的候选身份。 */
      const identity = `${String(candidate.guard.dev)}:${String(candidate.guard.ino)}`
      if (canonicalPaths.has(candidate.guard.canonicalPath) || identities.has(identity)) {
        throw new Error(`配置候选物理身份重复: ${candidate.guard.filePath}`)
      }
      canonicalPaths.add(candidate.guard.canonicalPath)
      identities.add(identity)
    }
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
  return {
    primary: readCandidateState(filePath, validate, targetGuard),
    temporary: readCandidateState(`${filePath}.tmp`, validate, targetGuard),
    backup: readCandidateState(`${filePath}.bak`, validate, targetGuard),
  }
}

/** 单次受控 fd 读取候选，复用同一原始字节计算摘要、解析 JSON 和校验 schema。 */
function readCandidateState<T>(
  filePath: string,
  validate: (value: unknown) => value is T,
  targetGuard: TargetRootGuard,
): CandidateState<T> {
  /** 候选 guard 与对应原始字节。 */
  const captured = captureFile(filePath, targetGuard)
  if (!captured) return { guard: null, valid: false, contentSha256: null }
  /** 本次解析与摘要共用的原始字节。 */
  const raw = captured.bytes
  /** 本次受控读取的内容身份。 */
  const contentSha256 = captured.guard.contentSha256
  try {
    if (raw.toString('utf-8').trim().length === 0) {
      return { guard: captured.guard, valid: false, contentSha256 }
    }
    /** 候选 JSON 解析值。 */
    const parsed: unknown = JSON.parse(raw.toString('utf-8'))
    return validate(parsed)
      ? { guard: captured.guard, valid: true, value: parsed, contentSha256 }
      : { guard: captured.guard, valid: false, contentSha256 }
  } catch (error) {
    if (error instanceof SyntaxError) {
      return { guard: captured.guard, valid: false, contentSha256 }
    }
    throw error
  }
}

/** 捕获目标根内一个普通文件候选的身份与内容摘要。 */
function captureFileGuard(filePath: string, targetGuard: TargetRootGuard): FileGuard | null {
  return captureFile(filePath, targetGuard)?.guard ?? null
}

/** 通过 no-follow fd 单次读取普通文件，并将路径、fd 元数据与 SHA-256 绑定。 */
function captureFile(filePath: string, targetGuard: TargetRootGuard): CapturedFile | null {
  verifyTargetRootGuard(targetGuard)
  /** 不跟随最终 symlink 取得的候选状态。 */
  const fileStat = lstatIfPresent(filePath)
  if (!fileStat) return null
  if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
    throw new Error(`配置候选必须是普通文件: ${filePath}`)
  }
  if (fileStat.nlink !== 1) throw new Error(`配置候选不得是多链接文件: ${filePath}`)
  /** 候选物理路径。 */
  const canonicalPath = realpathSync(filePath)
  assertCanonicalContainment(canonicalPath, targetGuard.canonicalPath, filePath)
  /** 使用 no-follow 打开的候选文件描述符。 */
  const descriptor = openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  /** 候选原始字节。 */
  let bytes: Buffer
  try {
    /** fd 读取前必须仍匹配路径预检元数据。 */
    const beforeRead = fstatSync(descriptor)
    if (!sameMetadataSnapshot(fileStat, beforeRead)) {
      throw new Error(`读取前配置候选被替换: ${filePath}`)
    }
    bytes = readFileSync(descriptor)
    /** fd 读取后不得发生 inode、长度、mtime 或链接数变化。 */
    const afterRead = fstatSync(descriptor)
    if (!sameMetadataSnapshot(beforeRead, afterRead)) {
      throw new Error(`读取期间配置候选被替换: ${filePath}`)
    }
  } finally {
    closeSync(descriptor)
  }
  /** 读取后路径必须仍指向相同普通单链接文件。 */
  const afterPathRead = lstatIfPresent(filePath)
  if (
    !afterPathRead
    || afterPathRead.isSymbolicLink()
    || !afterPathRead.isFile()
    || !sameMetadataSnapshot(fileStat, afterPathRead)
    || realpathSync(filePath) !== canonicalPath
  ) {
    throw new Error(`读取期间配置候选路径被替换: ${filePath}`)
  }
  /** 与本次返回 bytes 对应的内容摘要。 */
  const contentSha256 = createHash('sha256').update(bytes).digest('hex')
  return {
    bytes,
    guard: {
      filePath,
      canonicalPath,
      dev: afterPathRead.dev,
      ino: afterPathRead.ino,
      size: afterPathRead.size,
      mtimeMs: afterPathRead.mtimeMs,
      nlink: afterPathRead.nlink,
      contentSha256,
    },
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
  if (!expected || !actual || !sameFileMetadata(expected, actual)) throw new Error(message)
  if (expected.contentSha256 !== actual.contentSha256) {
    throw new Error(`${message}（内容 SHA-256 不一致）`)
  }
}

/** 断言两个文件 guard 稳定属性相同。 */
function assertSameGuard(expected: FileGuard, actual: FileGuard | null, message: string): void {
  if (!actual || !sameStableFile(expected, actual)) throw new Error(message)
}

/** 比较文件身份、大小和修改时间。 */
function sameStableFile(left: FileGuard, right: FileGuard): boolean {
  return sameFileMetadata(left, right) && left.contentSha256 === right.contentSha256
}

/** 比较不含内容摘要的稳定文件元数据。 */
function sameFileMetadata(left: FileGuard, right: FileGuard): boolean {
  return sameIdentity(left, right)
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.nlink === right.nlink
}

/** 比较两次 stat 的稳定元数据。 */
function sameMetadataSnapshot(
  left: FileSystemStat,
  right: FileSystemStat,
): boolean {
  return sameIdentity(left, right)
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.nlink === right.nlink
    && left.isFile()
    && right.isFile()
}

/** 用随机同目录临时叶子安全替换一个固定 JSON 目标。 */
function replaceWithAtomicLeaf(
  destinationPath: string,
  expectedDestination: FileGuard | null,
  content: string,
  directoryGuards: DirectoryGuard[],
  targetGuard: TargetRootGuard,
): void {
  /** 随机且不可预测的同目录临时叶子。 */
  const temporaryPath = join(dirname(destinationPath), `.proma-atomic-${randomBytes(16).toString('hex')}`)
  /** 在不跟随链接的前提下独占创建临时文件。 */
  const openFlags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0)
  /** 临时文件描述符。 */
  const descriptor = openSync(temporaryPath, openFlags, 0o600)
  /** fd 是否仍需由 finally 关闭。 */
  let descriptorOpen = true
  /** 临时文件创建时的 inode 身份，用于异常清理。 */
  let temporaryIdentity: FileSystemIdentity | null = null
  /** 随机临时叶子是否已通过 rename 提交。 */
  let committed = false
  try {
    /** 独占创建后立即绑定的 fd 身份。 */
    const initialStat = fstatSync(descriptor)
    if (!initialStat.isFile() || initialStat.nlink !== 1) {
      throw new Error(`原子临时文件身份异常: ${temporaryPath}`)
    }
    temporaryIdentity = { dev: initialStat.dev, ino: initialStat.ino }
    /** 待完整写入的 UTF-8 字节。 */
    const bytes = Buffer.from(content, 'utf-8')
    /** 已写入的字节数。 */
    let offset = 0
    while (offset < bytes.length) {
      /** 本轮实际写入的字节数。 */
      const written = writeSync(descriptor, bytes, offset, bytes.length - offset)
      if (written === 0) throw new Error(`原子临时文件写入停滞: ${temporaryPath}`)
      offset += written
    }
    fsyncSync(descriptor)
    /** 通过 fd 复验未被路径替换影响的临时 inode。 */
    const descriptorStat = fstatSync(descriptor)
    if (
      !sameIdentity(initialStat, descriptorStat)
      || !descriptorStat.isFile()
      || descriptorStat.nlink !== 1
      || descriptorStat.size !== bytes.length
    ) {
      throw new Error(`原子临时文件身份异常: ${temporaryPath}`)
    }
    closeSync(descriptor)
    descriptorOpen = false
    /** 写入关闭后随机临时叶子的完整 guard。 */
    const temporaryGuard = captureFileGuard(temporaryPath, targetGuard)
    if (!temporaryGuard || !sameIdentity(temporaryGuard, descriptorStat)) {
      throw new Error(`原子临时文件路径被替换: ${temporaryPath}`)
    }
    verifyTargetRootGuard(targetGuard)
    verifyDirectoryGuards(directoryGuards, targetGuard)
    /** rename 前固定目标的当前身份。 */
    const currentDestination = captureFileGuard(destinationPath, targetGuard)
    assertOptionalGuardUnchanged(expectedDestination, currentDestination, `提交前固定目标被替换: ${destinationPath}`)
    /** rename 前随机临时叶子的当前身份。 */
    const currentTemporary = captureFileGuard(temporaryPath, targetGuard)
    assertSameGuard(temporaryGuard, currentTemporary, `提交前原子临时文件被替换: ${temporaryPath}`)
    renameSync(temporaryPath, destinationPath)
    committed = true
    fsyncParentDirectoryBestEffort(dirname(destinationPath))
    verifyTargetRootGuard(targetGuard)
    verifyDirectoryGuards(directoryGuards, targetGuard)
    /** rename 后目标文件必须保持临时 inode 的身份和目标字节。 */
    const committedGuard = captureFileGuard(destinationPath, targetGuard)
    assertSameGuard(temporaryGuard, committedGuard, `原子提交结果身份异常: ${destinationPath}`)
    if (!readFileSync(destinationPath).equals(Buffer.from(content, 'utf-8'))) {
      throw new Error(`原子提交结果内容异常: ${destinationPath}`)
    }
  } finally {
    if (descriptorOpen) closeSync(descriptor)
    if (!committed && temporaryIdentity) cleanupRandomTemporary(temporaryPath, temporaryIdentity, targetGuard)
  }
}

/** 成功 rename 后尽力刷盘父目录；平台不支持目录 fd 时告警但不回滚已完成提交。 */
function fsyncParentDirectoryBestEffort(directoryPath: string): void {
  /** 父目录只读 fd；部分平台不允许打开目录。 */
  let descriptor: number | null = null
  try {
    descriptor = openSync(directoryPath, constants.O_RDONLY)
    fsyncSync(descriptor)
  } catch (error) {
    /** 用于跨平台诊断的文件系统错误码。 */
    const code = isNodeError(error) ? error.code : undefined
    console.warn(`[路径迁移] 父目录 fsync 不可用，已保留原子 rename 结果: ${directoryPath}${code ? ` (${code})` : ''}`)
  } finally {
    if (descriptor !== null) {
      try {
        closeSync(descriptor)
      } catch {
        // rename 已成功，目录 fd 关闭失败仅影响资源回收诊断，不得伪装为提交失败。
      }
    }
  }
}

/** 仅当随机临时叶子仍指向本次创建的单链接 inode 时清理。 */
function cleanupRandomTemporary(
  temporaryPath: string,
  expectedIdentity: FileSystemIdentity,
  targetGuard: TargetRootGuard,
): void {
  try {
    /** 异常路径上的当前随机叶子。 */
    const current = captureFileGuard(temporaryPath, targetGuard)
    if (current && sameIdentity(expectedIdentity, current)) unlinkSync(temporaryPath)
  } catch {
    // 无法证明身份时保留随机叶子，避免异常清理触碰替换后的路径。
  }
}

/** 仅在固定 .tmp 仍保持预检身份时清理；新出现的路径一律拒绝触碰。 */
function cleanupControlledTemporary(
  filePath: string,
  expectedTemporary: FileGuard | null,
  directoryGuards: DirectoryGuard[],
  targetGuard: TargetRootGuard,
): void {
  verifyTargetRootGuard(targetGuard)
  verifyDirectoryGuards(directoryGuards, targetGuard)
  /** 清理前固定 .tmp 的当前身份。 */
  const temporaryPath = `${filePath}.tmp`
  const currentTemporary = captureFileGuard(temporaryPath, targetGuard)
  assertOptionalGuardUnchanged(expectedTemporary, currentTemporary, `提交期间 tmp 被替换: ${temporaryPath}`)
  if (expectedTemporary) unlinkControlledPath(temporaryPath, expectedTemporary, targetGuard)
}

/** 复验普通文件身份后删除仅由本次协议控制的路径。 */
function unlinkControlledPath(filePath: string, expected: FileGuard, targetGuard: TargetRootGuard): void {
  /** 删除前最后一次 no-follow 身份检查。 */
  const current = captureFileGuard(filePath, targetGuard)
  assertSameGuard(expected, current, `清理前文件被替换: ${filePath}`)
  unlinkSync(filePath)
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
