import {
  closeSync,
  existsSync,
  openSync,
  readSync,
  readdirSync,
} from 'node:fs'
import { join } from 'node:path'
import { DataRootLocator } from './data-root-locator'
import type { DataRootLocatorResult } from './data-root-locator'
import { writeJsonFileAtomic } from './safe-file'

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

/** 初始化 marker 时允许的受控例外。 */
export interface EnsurePromaDataRootMarkerOptions {
  /** 仅隐式默认根可允许无任何文件时建立初始所有权。 */
  allowEmptyRoot?: boolean
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
  if (existsSync(markerPath)) {
    return isPromaDataRootMarker(readBoundedJson(markerPath)) ? 'marker' : null
  }

  for (const candidate of LEGACY_PROMA_JSON_FILES) {
    /** 每个 legacy 文件独立受大小上限约束，损坏或超限时不作为身份证据。 */
    const candidatePath = join(root, candidate.name)
    if (existsSync(candidatePath) && candidate.validate(readBoundedJson(candidatePath))) {
      return 'legacy'
    }
  }

  /** SQLite 只读取固定 16 字节 header，禁止把 planning.db 整体载入内存。 */
  const planningPath = join(root, 'planning.db')
  if (existsSync(planningPath) && hasSqliteHeader(planningPath)) return 'legacy'
  return null
}

/**
 * 确保已证明所有权的数据根拥有精确 marker，并在写后重新校验。
 *
 * @param root 已确认在线且可写的数据根目录。
 * @param options 隐式默认空根的受控初始化选项。
 */
export function ensurePromaDataRootMarker(
  root: string,
  options: EnsurePromaDataRootMarkerOptions = {},
): void {
  /** 写入前的身份结果，决定直接接受、升级或拒绝。 */
  const identity = inspectPromaDataRootIdentity(root)
  if (identity === 'marker') return
  if (identity === null && !(options.allowEmptyRoot === true && isEmptyDirectory(root))) {
    throw new Error('所选目录不是可识别的 Proma 数据根')
  }

  /** marker 使用共享原子写封装，避免崩溃留下截断身份文件。 */
  const markerPath = join(root, PROMA_DATA_ROOT_MARKER_FILE)
  writeJsonFileAtomic(markerPath, PROMA_DATA_ROOT_MARKER)
  if (inspectPromaDataRootIdentity(root) !== 'marker') {
    throw new Error('Proma 数据根标记写入后校验失败')
  }
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
  /** 无 locator 文件时才是允许创建和初始化空目录的隐式默认根。 */
  const usesImplicitDefault = locatorResult.locatorFile === undefined
  /** 仅隐式默认根允许按启动合同创建，custom 根离线时保持零写入。 */
  const activeRoot = locator.requireActiveRoot({ createDefault: usesImplicitDefault })
  ensurePromaDataRootMarker(activeRoot, { allowEmptyRoot: usesImplicitDefault })
  return activeRoot
}

/** 有界读取并解析 JSON；超限、短读异常或语法错误统一返回 null。 */
function readBoundedJson(path: string): unknown {
  /** 多分配一个字节，用于可靠识别超过上限的文件。 */
  const buffer = Buffer.alloc(DATA_ROOT_IDENTITY_JSON_MAX_BYTES + 1)
  /** 只读文件描述符，确保身份探测本身不修改文件。 */
  const descriptor = openSync(path, 'r')
  try {
    /** 循环处理合法的短读，累计量仍严格受 buffer 大小约束。 */
    let bytesRead = 0
    while (bytesRead < buffer.length) {
      /** 本次读取量最多填满剩余的有界 buffer。 */
      const currentRead = readSync(descriptor, buffer, bytesRead, buffer.length - bytesRead, null)
      if (currentRead === 0) break
      bytesRead += currentRead
    }
    if (bytesRead > DATA_ROOT_IDENTITY_JSON_MAX_BYTES) return null
    return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')) as unknown
  } catch {
    return null
  } finally {
    closeSync(descriptor)
  }
}

/** 仅读取 planning.db 的固定 SQLite header。 */
function hasSqliteHeader(path: string): boolean {
  /** SQLite 稳定文件头固定为 16 字节。 */
  const buffer = Buffer.alloc(16)
  /** 只读打开数据库，避免身份检查触发写入。 */
  const descriptor = openSync(path, 'r')
  try {
    /** 数据库不足 16 字节时不能证明 SQLite 身份。 */
    const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null)
    return bytesRead === buffer.length && buffer.toString('utf8') === 'SQLite format 3\u0000'
  } catch {
    return false
  } finally {
    closeSync(descriptor)
  }
}

/** 判断目录在初始化 marker 前确实为空。 */
function isEmptyDirectory(root: string): boolean {
  try {
    return readdirSync(root).length === 0
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
