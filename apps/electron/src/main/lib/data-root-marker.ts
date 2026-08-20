import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { DataRootLocator } from './data-root-locator'
import type { DataRootLocatorResult } from './data-root-locator'
import { writeJsonFileAtomicSecure } from './safe-file'

/** Proma 数据根所有权 marker 的固定文件名。 */
export const PROMA_DATA_ROOT_MARKER_FILE = '.proma-data-root.json'

/** 单个 JSON 身份文件允许同步读取的最大字节数。 */
export const DATA_ROOT_IDENTITY_JSON_MAX_BYTES = 1024 * 1024

/** Proma 数据根 marker 的精确持久化结构。 */
interface PromaDataRootMarker {
  /** 固定所有者，防止普通同名目录被识别为 Proma 数据根。 */
  owner: 'proma'
  /** marker schema 版本。 */
  version: 1
}

/** 写入磁盘的唯一合法 marker 值。 */
const PROMA_DATA_ROOT_MARKER: PromaDataRootMarker = { owner: 'proma', version: 1 }

/** 历史 settings 至少命中一个稳定 Proma 键，拒绝普通项目配置。 */
const PROMA_SETTINGS_KEYS: ReadonlySet<string> = new Set([
  'theme',
  'themeMode',
  'themeStyle',
  'interfaceVariant',
  'onboardingCompleted',
  'environmentCheckSkipped',
  'notificationsEnabled',
  'agentChannelId',
  'agentModelId',
  'builtinMcpDisabledIds',
])

/** 尚未写 marker 的历史 Proma 根可用于证明身份的 JSON 文件。 */
const LEGACY_PROMA_JSON_FILES: ReadonlyArray<{
  /** 相对数据根的历史文件名。 */
  name: string
  /** 对有界解析结果执行的稳定结构校验。 */
  validate: (value: unknown) => boolean
}> = [
  { name: 'settings.json', validate: isPromaSettings },
  { name: 'channels.json', validate: (value) => isJsonRecord(value) && Array.isArray(value.channels) },
  { name: 'agent-workspaces.json', validate: (value) => isJsonRecord(value) && Array.isArray(value.workspaces) },
  { name: 'automations.json', validate: (value) => isJsonRecord(value) && Array.isArray(value.automations) },
]

/** 身份文件安全打开后的结果。 */
interface IdentityFileOpenResult {
  /** missing 表示路径不可确认存在，invalid 表示存在但不安全，opened 表示可有界读取。 */
  status: 'missing' | 'invalid' | 'opened'
  /** 仅 opened 状态携带调用方负责关闭的文件描述符。 */
  descriptor?: number
}

/** JSON 身份文件的有界读取结果。 */
interface BoundedJsonReadResult {
  /** 用于让显式 marker 存在但无效时阻断 legacy 回退。 */
  exists: boolean
  /** 解析成功的未知 JSON 值；读取或解析失败时为 null。 */
  value: unknown | null
}

/**
 * 有界识别目录是否为显式 marker 根或兼容的 legacy Proma 根。
 *
 * @param root 已确认在线的数据根目录。
 * @returns 已证明的身份类型；无法证明时返回 null。
 */
export function inspectPromaDataRootIdentity(root: string): 'marker' | 'legacy' | null {
  /** 显式 marker 一旦存在就必须精确有效，不允许回退到 legacy 证据。 */
  const markerPath = join(root, PROMA_DATA_ROOT_MARKER_FILE)
  /** marker 读取结果保留存在性，避免损坏 marker 被 legacy 文件掩盖。 */
  const marker = readBoundedJson(markerPath)
  if (marker.exists) {
    return isPromaDataRootMarker(marker.value) ? 'marker' : null
  }

  for (const candidate of LEGACY_PROMA_JSON_FILES) {
    /** 每个 legacy 文件独立受大小上限约束，损坏或超限时不作为身份证据。 */
    const candidatePath = join(root, candidate.name)
    if (candidate.validate(readBoundedJson(candidatePath).value)) {
      return 'legacy'
    }
  }

  /** SQLite 只读取固定 16 字节 header，禁止把 planning.db 整体载入内存。 */
  const planningPath = join(root, 'planning.db')
  if (hasSqliteHeader(planningPath)) return 'legacy'
  return null
}

/**
 * 确保已证明所有权的数据根拥有精确 marker，并在写后重新校验。
 *
 * @param root 已确认在线且可写的数据根目录。
 */
export function ensurePromaDataRootMarker(root: string): void {
  /** 写入前的身份结果，决定直接接受、升级或拒绝。 */
  const identity = inspectPromaDataRootIdentity(root)
  if (identity === 'marker') return
  if (identity === null) throw new Error('所选目录不是可识别的 Proma 数据根')
  writeAndVerifyPromaDataRootMarker(root)
}

/**
 * 在 normal 业务启动前准备活动根，并建立 marker 不变量。
 *
 * @param locator 当前进程使用的数据根定位器。
 * @param locatorResult bootstrap 首次无副作用检查结果。
 * @returns 已在线且拥有精确 marker 的活动根绝对路径。
 */
export function prepareNormalDataRoot(
  locator: DataRootLocator,
  locatorResult: DataRootLocatorResult,
): string {
  if (locatorResult.status !== 'ready') throw new Error('数据根不可用')
  /** locator 文件缺失时解析出的唯一受控默认根。 */
  const expectedDefaultRoot = join(dirname(locator.getLocatorPath()), '.proma')
  /** 无 locator 文件时才允许创建固定默认根。 */
  const hasNoLocator = locatorResult.locatorFile === undefined
  /** custom 根离线时不创建目录，默认根缺失时按启动合同创建。 */
  const activeRoot = locator.requireActiveRoot({ createDefault: hasNoLocator })
  /** 已有合法 marker 时保持启动只读，避免生成备份或替换文件身份。 */
  const identity = inspectPromaDataRootIdentity(activeRoot)
  if (identity === 'marker') return activeRoot
  /** 默认根例外必须同时满足 locator 缺失与精确固定路径，不能扩散到 custom 根。 */
  const isControlledDefaultRoot = hasNoLocator && resolve(activeRoot) === resolve(expectedDefaultRoot)
  if (identity === 'legacy' || isControlledDefaultRoot) {
    writeAndVerifyPromaDataRootMarker(activeRoot)
    return activeRoot
  }
  throw new Error('所选目录不是可识别的 Proma 数据根')
}

/** 原子写入唯一合法 marker，并通过同一 no-follow 读取链精确复验。 */
function writeAndVerifyPromaDataRootMarker(root: string): void {
  /** marker 使用共享原子写封装，避免崩溃留下截断身份文件。 */
  const markerPath = join(root, PROMA_DATA_ROOT_MARKER_FILE)
  writeJsonFileAtomicSecure(markerPath, PROMA_DATA_ROOT_MARKER)
  if (inspectPromaDataRootIdentity(root) !== 'marker') {
    throw new Error('Proma 数据根标记写入后校验失败')
  }
}

/** 有界读取并解析普通 JSON 文件；不安全、超限或语法错误均 fail closed。 */
function readBoundedJson(path: string): BoundedJsonReadResult {
  /** 打开前后都校验普通文件与大小，最终路径不跟随 symlink。 */
  const opened = openIdentityFile(path, DATA_ROOT_IDENTITY_JSON_MAX_BYTES)
  if (opened.status !== 'opened' || opened.descriptor === undefined) {
    return { exists: opened.status === 'invalid', value: null }
  }
  /** 多分配一个字节，用于可靠识别超过上限的文件。 */
  const buffer = Buffer.alloc(DATA_ROOT_IDENTITY_JSON_MAX_BYTES + 1)
  /** 读取、解析与关闭全部成功后才返回可验证的 JSON 值。 */
  let value: unknown | null = null
  /** close 失败同样视为当前 evidence 无效。 */
  let closed = false
  try {
    /** 循环处理合法的短读，累计量仍严格受 buffer 大小约束。 */
    let bytesRead = 0
    while (bytesRead < buffer.length) {
      /** 本次读取量最多填满剩余的有界 buffer。 */
      const currentRead = readSync(opened.descriptor, buffer, bytesRead, buffer.length - bytesRead, null)
      if (currentRead === 0) break
      bytesRead += currentRead
    }
    if (bytesRead <= DATA_ROOT_IDENTITY_JSON_MAX_BYTES) {
      value = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')) as unknown
    }
  } catch {
    value = null
  } finally {
    closed = closeIdentityFile(opened.descriptor)
  }
  return { exists: true, value: closed ? value : null }
}

/** 仅读取 planning.db 的固定 SQLite header。 */
function hasSqliteHeader(path: string): boolean {
  /** SQLite 文件也必须是 no-follow 打开的普通文件。 */
  const opened = openIdentityFile(path)
  if (opened.status !== 'opened' || opened.descriptor === undefined) return false
  /** SQLite 稳定文件头固定为 16 字节。 */
  const buffer = Buffer.alloc(16)
  /** 读取与关闭都成功时才接受稳定 header。 */
  let matchesHeader = false
  /** close 异常必须使当前 evidence 失效。 */
  let closed = false
  try {
    /** 数据库不足 16 字节时不能证明 SQLite 身份。 */
    const bytesRead = readSync(opened.descriptor, buffer, 0, buffer.length, null)
    matchesHeader = bytesRead === buffer.length && buffer.toString('utf8') === 'SQLite format 3\u0000'
  } catch {
    matchesHeader = false
  } finally {
    closed = closeIdentityFile(opened.descriptor)
  }
  return closed && matchesHeader
}

/** 在 no-follow lstat 判型后安全打开并用 fstat 复验同一身份文件。 */
function openIdentityFile(path: string, maxBytes?: number): IdentityFileOpenResult {
  /** 打开前的路径状态，不跟随最终 symlink。 */
  let pathStat: ReturnType<typeof lstatSync>
  try {
    pathStat = lstatSync(path)
  } catch {
    return { status: 'missing' }
  }
  if (!pathStat.isFile() || (maxBytes !== undefined && pathStat.size > maxBytes)) {
    return { status: 'invalid' }
  }

  /** O_NONBLOCK 防止判型后的替换竞态把主进程阻塞在 FIFO/device。 */
  const openFlags = constants.O_RDONLY
    | (constants.O_NOFOLLOW ?? 0)
    | (constants.O_NONBLOCK ?? 0)
  /** 打开失败与打开后的身份不匹配都作为无效 evidence。 */
  let descriptor: number | null = null
  try {
    descriptor = openSync(path, openFlags)
    /** 打开后的文件状态用于阻断 lstat 与 open 之间的替换竞态。 */
    const openedStat = fstatSync(descriptor)
    if (!openedStat.isFile() || (maxBytes !== undefined && openedStat.size > maxBytes)) {
      closeIdentityFile(descriptor)
      return { status: 'invalid' }
    }
    return { status: 'opened', descriptor }
  } catch {
    if (descriptor !== null) closeIdentityFile(descriptor)
    return { status: 'invalid' }
  }
}

/** 捕获 closeSync 异常，避免一个坏 evidence 中断后续合法身份检查。 */
function closeIdentityFile(descriptor: number): boolean {
  try {
    closeSync(descriptor)
    return true
  } catch {
    return false
  }
}

/** 判断解析结果为非数组 JSON 对象。 */
function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 判断 marker 严格匹配唯一 owner/version schema。 */
function isPromaDataRootMarker(value: unknown): value is PromaDataRootMarker {
  return isJsonRecord(value)
    && Object.keys(value).length === 2
    && value.owner === 'proma'
    && value.version === 1
}

/** 判断旧 settings 文件至少包含一个 Proma 稳定字段。 */
function isPromaSettings(value: unknown): boolean {
  return isJsonRecord(value) && Object.keys(value).some((key) => PROMA_SETTINGS_KEYS.has(key))
}
