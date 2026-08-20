import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open, unlink, realpath } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { readJsonFileSafe, writeJsonFileAtomic } from './safe-file'
import {
  assertDirectoryIdentity,
  captureDirectoryIdentity,
  lstatOrNull,
} from './verified-directory-copy-filesystem'

/** 目标根同级 sidecar 使用的固定前缀；迁移 ID 永不参与路径拼接。 */
const DIRECTORY_COPY_SIDECAR_PREFIX = '.proma-directory-copy-'

/** 复制断点 sidecar 的严格 schema。 */
interface DirectoryCopyMarker {
  version: 1
  migrationId: string
  sourceRoot: string
  targetRoot: string
}

/** 创建或恢复 sidecar 所需的归一化路径。 */
export interface PrepareDirectoryCopySidecarInput {
  migrationId: string
  requestedSourceRoot: string
  requestedTargetRoot: string
  sidecarPath: string
  targetIsEmpty: boolean
}

/** finalize 只需要目标根和迁移标识，不接触目标数据。 */
export interface FinalizeDirectoryCopyInput {
  migrationId: string
  targetRoot: string
}

/** 只读检查 sidecar 归属所需字段。 */
export interface InspectDirectoryCopyOwnershipInput {
  migrationId: string
  sourceRoot: string
  targetRoot: string
}

/** sidecar 对指定迁移的只读归属结果。 */
export type DirectoryCopyOwnership = 'absent' | 'owned' | 'foreign' | 'invalid'

/** 返回与目标绝对路径稳定绑定的树外 sidecar 路径。 */
export function getDirectoryCopySidecarPath(targetRoot: string): string {
  /** 调用方目标路径的绝对字符串，仅用于稳定哈希。 */
  const requestedTargetRoot = resolve(targetRoot)
  /** 目标路径哈希避免同一父目录下的多个迁移互相覆盖。 */
  const targetHash = createHash('sha256').update(normalizePathForIdentity(requestedTargetRoot)).digest('hex').slice(0, 32)
  return join(dirname(requestedTargetRoot), `${DIRECTORY_COPY_SIDECAR_PREFIX}${targetHash}.json`)
}

/** 只读检查 main/tmp/bak sidecar，不提升、删除或改写任何候选。 */
export async function inspectDirectoryCopyOwnership(
  input: InspectDirectoryCopyOwnershipInput,
): Promise<DirectoryCopyOwnership> {
  const requestedSourceRoot = resolve(input.sourceRoot)
  const requestedTargetRoot = resolve(input.targetRoot)
  const sidecarPath = getDirectoryCopySidecarPath(requestedTargetRoot)
  let hasCandidate: boolean
  try {
    hasCandidate = await validateSidecarCandidateTypes(sidecarPath)
  } catch {
    return 'invalid'
  }
  if (!hasCandidate) return 'absent'
  for (const candidatePath of sidecarCandidatePaths(sidecarPath)) {
    const stats = await lstatOrNull(candidatePath)
    if (!stats) continue
    if (!stats.isFile()) return 'invalid'
    let handle: FileHandle | undefined
    try {
      handle = await open(candidatePath, constants.O_RDONLY | constants.O_NOFOLLOW)
      if (!(await handle.stat()).isFile()) return 'invalid'
      const value: unknown = JSON.parse(await handle.readFile('utf-8'))
      if (!isDirectoryCopyMarker(value)) continue
      if (
        value.migrationId === input.migrationId
        && value.sourceRoot === requestedSourceRoot
        && value.targetRoot === requestedTargetRoot
      ) return 'owned'
      return 'foreign'
    } catch {
      // 当前候选损坏时继续只读检查后续原子恢复候选。
    } finally {
      await handle?.close()
    }
  }
  return 'invalid'
}

/** 验证或原子创建树外 sidecar，非空目标只有同 migrationId 才视为迁移拥有。 */
export async function prepareDirectoryCopySidecar(input: PrepareDirectoryCopySidecarInput): Promise<void> {
  /** sidecar 父目录身份用于原子读写前后复验。 */
  const sidecarParentIdentity = await captureDirectoryIdentity(dirname(input.sidecarPath))
  /** 是否存在可恢复的普通文件候选。 */
  const hasCandidate = await validateSidecarCandidateTypes(input.sidecarPath)
  if (!hasCandidate) {
    if (!input.targetIsEmpty) throw new Error('复制目标非空且没有可信断点 sidecar，拒绝覆盖')
    /** 首次迁移写入的严格 marker。 */
    const marker: DirectoryCopyMarker = {
      version: 1,
      migrationId: input.migrationId,
      sourceRoot: input.requestedSourceRoot,
      targetRoot: input.requestedTargetRoot,
    }
    await assertDirectoryIdentity(sidecarParentIdentity)
    writeJsonFileAtomic(input.sidecarPath, marker)
    await assertDirectoryIdentity(sidecarParentIdentity)
    return
  }
  /** 经 safe-file 恢复并严格校验的 marker。 */
  const marker = readJsonFileSafe<DirectoryCopyMarker>(input.sidecarPath, { validate: isDirectoryCopyMarker })
  if (!marker) throw new Error('目录复制 sidecar marker 无效，拒绝恢复')
  if (marker.migrationId !== input.migrationId) throw new Error('目录复制 sidecar 的迁移标识与当前任务不一致')
  if (marker.sourceRoot !== input.requestedSourceRoot || marker.targetRoot !== input.requestedTargetRoot) {
    throw new Error('目录复制 sidecar 的源目标路径与当前任务不一致')
  }
  await assertDirectoryIdentity(sidecarParentIdentity)
}

/** 在定位提交成功后清理树外 sidecar，不删除任何目标数据。 */
export async function finalizeDirectoryCopy(input: FinalizeDirectoryCopyInput): Promise<void> {
  if (input.migrationId.trim().length === 0) throw new Error('目录复制 migrationId 不能为空')
  /** 调用方目标绝对路径，用于 sidecar 哈希和 schema 绑定。 */
  const requestedTargetRoot = resolve(input.targetRoot)
  /** sidecar 的调用方可见路径。 */
  const requestedSidecarPath = getDirectoryCopySidecarPath(requestedTargetRoot)
  /** sidecar 父目录的 canonical 路径。 */
  const canonicalParent = await realpath(dirname(requestedSidecarPath))
  /** 实际执行清理的 canonical sidecar 路径。 */
  const sidecarPath = join(canonicalParent, basename(requestedSidecarPath))
  /** 三个候选的类型安全检查结果。 */
  const hasCandidate = await validateSidecarCandidateTypes(sidecarPath)
  if (!hasCandidate) return
  /** 由 safe-file 恢复并严格校验的 marker。 */
  const marker = readJsonFileSafe<DirectoryCopyMarker>(sidecarPath, { validate: isDirectoryCopyMarker })
  if (!marker) throw new Error('目录复制 sidecar 无效，拒绝 finalize')
  if (marker.migrationId !== input.migrationId || marker.targetRoot !== requestedTargetRoot) {
    throw new Error('目录复制 sidecar 与 finalize 请求不匹配')
  }
  for (const candidatePath of sidecarCandidatePaths(sidecarPath)) {
    /** safe-file 可能提升候选，因此删除前重新 lstat。 */
    const stats = await lstatOrNull(candidatePath)
    if (!stats) continue
    if (!stats.isFile()) throw new Error(`目录复制 sidecar 候选必须是普通文件: ${basename(candidatePath)}`)
    await unlink(candidatePath)
  }
}

/** 分别 lstat main/tmp/bak，任一非普通文件都整体拒绝。 */
async function validateSidecarCandidateTypes(sidecarPath: string): Promise<boolean> {
  /** 是否至少存在一个普通候选。 */
  let hasCandidate = false
  for (const candidatePath of sidecarCandidatePaths(sidecarPath)) {
    /** 当前固定候选的 lstat，不跟随符号链接。 */
    const stats = await lstatOrNull(candidatePath)
    if (!stats) continue
    if (!stats.isFile()) throw new Error(`目录复制 sidecar 候选必须是普通文件: ${basename(candidatePath)}`)
    hasCandidate = true
  }
  return hasCandidate
}

/** 返回 safe-file 可能读取的全部固定候选。 */
function sidecarCandidatePaths(sidecarPath: string): string[] {
  return [sidecarPath, `${sidecarPath}.tmp`, `${sidecarPath}.bak`]
}

/** 严格校验 sidecar marker 字段集合和值类型。 */
function isDirectoryCopyMarker(value: unknown): value is DirectoryCopyMarker {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  /** 未知 JSON 对象的字段映射。 */
  const record = value as Record<string, unknown>
  /** marker 唯一允许的字段集合。 */
  const expectedKeys = ['migrationId', 'sourceRoot', 'targetRoot', 'version']
  /** 实际字段按字典序排列后严格比较。 */
  const actualKeys = Object.keys(record).sort()
  return actualKeys.length === expectedKeys.length
    && actualKeys.every((key, index) => key === expectedKeys[index])
    && record.version === 1
    && typeof record.migrationId === 'string'
    && typeof record.sourceRoot === 'string'
    && typeof record.targetRoot === 'string'
}

/** 当前平台路径身份比较规范化。 */
function normalizePathForIdentity(filePath: string): string {
  return process.platform === 'win32' ? filePath.toLowerCase() : filePath
}
