import { execFile } from 'node:child_process'
import { readFile, realpath } from 'node:fs/promises'
import { lstat, opendir, statfs } from 'node:fs/promises'
import { dirname, join, resolve, win32 } from 'node:path'
import { promisify } from 'node:util'
import { DOMParser } from '@xmldom/xmldom'
import type { DataRootDeviceType } from '@proma/shared'

/** 数据根设备类型。 */
export type { DataRootDeviceType } from '@proma/shared'

/** 数据根所在卷的轻量元数据，不扫描目录内容。 */
export interface DataRootVolumeSnapshot {
  availableBytes: number
  deviceType: DataRootDeviceType
}

/** 数据根设置页需要的真实存储快照。 */
export interface DataRootStorageSnapshot {
  /** 数据根普通文件总字节数。 */
  occupiedBytes: number
  /** 当前用户在所在文件系统可用字节数。 */
  availableBytes: number
  /** 基于系统卷元数据推导的设备类型。 */
  deviceType: DataRootDeviceType
}

/** 存储检查器可替换依赖。 */
export interface DataRootStorageInspectorOptions {
  /** 可注入时钟。 */
  now?: () => number
  /** 成功快照缓存时长。 */
  cacheTtlMs?: number
  /** 可注入完整检查，测试无需触碰真实卷。 */
  inspectFresh?: (rootPath: string) => Promise<DataRootStorageSnapshot>
}

/** 单条成功缓存。 */
interface StorageCacheEntry {
  expiresAt: number
  snapshot: DataRootStorageSnapshot
}

/** 平台设备类型检查的可替换系统依赖。 */
export interface DeviceTypeDetectionOptions {
  platform?: NodeJS.Platform
  execFile?: (file: string, args: string[]) => Promise<{ stdout: string }>
  readFile?: (path: string) => Promise<string>
  realpath?: (path: string) => Promise<string>
}

const DEFAULT_CACHE_TTL_MS = 5_000
const execFileAsync = promisify(execFile)

/** 会话级存储检查器，提供同路径单飞、短缓存和显式失效。 */
export class DataRootStorageInspector {
  /** 可注入时钟。 */
  private readonly now: () => number
  /** 成功快照缓存时长。 */
  private readonly cacheTtlMs: number
  /** 执行一次无缓存检查。 */
  private readonly inspectFresh: (rootPath: string) => Promise<DataRootStorageSnapshot>
  /** 按规范化绝对路径保存成功快照。 */
  private readonly cache = new Map<string, StorageCacheEntry>()
  /** 按规范化绝对路径保存进行中 Promise 及其代次。 */
  private readonly inFlight = new Map<string, { generation: number; promise: Promise<DataRootStorageSnapshot> }>()
  /** 每条路径的失效代次，旧 Promise 完成后不得回写新代缓存。 */
  private readonly generations = new Map<string, number>()

  constructor(options: DataRootStorageInspectorOptions = {}) {
    this.now = options.now ?? Date.now
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
    this.inspectFresh = options.inspectFresh ?? inspectDataRootStorageFresh
    if (!Number.isFinite(this.cacheTtlMs) || this.cacheTtlMs < 0) throw new Error('存储缓存时长必须是非负有限数')
  }

  /** 检查指定数据根，同一路径并发调用只执行一次真实扫描。 */
  inspect(rootPath: string): Promise<DataRootStorageSnapshot> {
    /** 统一缓存 key，避免等价路径重复扫描。 */
    const normalizedRoot = resolve(rootPath)
    /** 当前调用绑定的路径代次。 */
    const generation = this.generations.get(normalizedRoot) ?? 0
    /** 未过期成功快照可直接复用。 */
    const cached = this.cache.get(normalizedRoot)
    if (cached !== undefined && cached.expiresAt >= this.now()) return Promise.resolve(cached.snapshot)
    /** 已有扫描进行中时复用同一个 Promise。 */
    const pending = this.inFlight.get(normalizedRoot)
    if (pending !== undefined && pending.generation === generation) return pending.promise
    /** 只缓存成功结果，失败允许下一次立即重试。 */
    let inspection: Promise<DataRootStorageSnapshot>
    inspection = this.inspectFresh(normalizedRoot).then((snapshot) => {
      if ((this.generations.get(normalizedRoot) ?? 0) === generation) {
        this.cache.set(normalizedRoot, { expiresAt: this.now() + this.cacheTtlMs, snapshot })
      }
      return snapshot
    }).finally(() => {
      const latest = this.inFlight.get(normalizedRoot)
      if (latest?.generation === generation && latest.promise === inspection) this.inFlight.delete(normalizedRoot)
    })
    this.inFlight.set(normalizedRoot, { generation, promise: inspection })
    return inspection
  }

  /** 迁移计划、进度或完成事件发生时失效单路径或全部成功缓存。 */
  invalidate(rootPath?: string): void {
    if (rootPath === undefined) {
      /** 全量失效只需推进当前已知路径，后续新路径默认从 0 开始。 */
      const knownRoots = new Set([...this.generations.keys(), ...this.cache.keys(), ...this.inFlight.keys()])
      for (const knownRoot of knownRoots) {
        this.generations.set(knownRoot, (this.generations.get(knownRoot) ?? 0) + 1)
      }
      this.cache.clear()
      this.inFlight.clear()
      return
    }
    const normalizedRoot = resolve(rootPath)
    this.generations.set(normalizedRoot, (this.generations.get(normalizedRoot) ?? 0) + 1)
    this.cache.delete(normalizedRoot)
    this.inFlight.delete(normalizedRoot)
  }
}

/** 默认进程级 inspector，供正常窗口状态与迁移预检共享。 */
const defaultStorageInspector = new DataRootStorageInspector()

/** 异步读取真实数据根存储元数据。 */
export function inspectDataRootStorage(rootPath: string): Promise<DataRootStorageSnapshot> {
  return defaultStorageInspector.inspect(rootPath)
}

/** 迁移事件后失效默认存储元数据缓存。 */
export function invalidateDataRootStorage(rootPath?: string): void {
  defaultStorageInspector.invalidate(rootPath)
}

/** no-follow 递归统计普通文件；符号链接和其他特殊项忽略。 */
export async function scanDataRootBytes(rootPath: string): Promise<number> {
  /** 待扫描目录栈，避免深目录递归调用栈溢出。 */
  const pendingDirectories = [resolve(rootPath)]
  let totalBytes = 0
  while (pendingDirectories.length > 0) {
    /** 数组已非空，pop 必然返回目录。 */
    const currentDirectory = pendingDirectories.pop()
    if (currentDirectory === undefined) continue
    const directory = await opendir(currentDirectory)
    for await (const entry of directory) {
      /** lstat 明确不跟随 symlink。 */
      const stats = await lstat(resolve(currentDirectory, entry.name), { bigint: true })
      if (stats.isDirectory()) {
        pendingDirectories.push(resolve(currentDirectory, entry.name))
      } else if (stats.isFile()) {
        totalBytes += toSafeByteCount(stats.size)
        if (!Number.isSafeInteger(totalBytes)) return Number.MAX_SAFE_INTEGER
      }
    }
  }
  return totalBytes
}

/** 把 bigint 字节数安全饱和到 JavaScript 安全整数。 */
export function toSafeByteCount(value: bigint): number {
  if (value <= 0n) return 0
  return value > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(value)
}

/** 从 diskutil plist 中读取可信卷布尔元数据。 */
export function classifyMacDiskInfo(xml: string): DataRootDeviceType {
  /** diskutil 不同 macOS 版本使用 DAVolumeNetwork 或文件系统类型标记网络卷。 */
  const fileSystemType = readPlistString(xml, 'FilesystemType')?.toLowerCase()
  if (
    readPlistBoolean(xml, 'DAVolumeNetwork') === true
    || readPlistBoolean(xml, 'Network') === true
    || (fileSystemType !== undefined && MAC_NETWORK_FILE_SYSTEMS.has(fileSystemType))
  ) return 'network'
  if (
    readPlistBoolean(xml, 'RemovableMediaOrExternalDevice') === true
    || readPlistBoolean(xml, 'RemovableMedia') === true
    || readPlistBoolean(xml, 'Ejectable') === true
  ) return 'removable'
  if (readPlistBoolean(xml, 'Internal') === true) return 'local'
  return 'unknown'
}

/** 按 Windows Win32_LogicalDisk DriveType 枚举分类。 */
export function classifyWindowsDriveType(driveType: number): DataRootDeviceType {
  if (driveType === 4) return 'network'
  if (driveType === 2) return 'removable'
  if (driveType === 3) return 'local'
  return 'unknown'
}

/** 按 Linux mountinfo 文件系统类型与块设备 removable 元数据分类。 */
export async function classifyLinuxMountInfo(
  rootPath: string,
  mountInfo: string,
  readRemovable: (majorMinor: string) => Promise<string | null>,
): Promise<DataRootDeviceType> {
  /** 找到覆盖目标路径且 mount point 最长的挂载记录。 */
  const matchedMount = mountInfo.split('\n').map(parseLinuxMountLine).filter((mount): mount is LinuxMount => mount !== null)
    .filter((mount) => isPathInsideMount(resolve(rootPath), mount.mountPoint))
    .sort((left, right) => right.mountPoint.length - left.mountPoint.length)[0]
  if (matchedMount === undefined) return 'unknown'
  if (NETWORK_FILE_SYSTEMS.has(matchedMount.fileSystemType)) return 'network'
  /** 内核块设备属性能明确区分可移动与固定本地设备。 */
  const removable = await readRemovable(matchedMount.majorMinor)
  if (removable?.trim() === '1') return 'removable'
  if (removable?.trim() === '0') return 'local'
  return 'unknown'
}

/** Linux mountinfo 中本任务需要的最小字段。 */
interface LinuxMount {
  majorMinor: string
  mountPoint: string
  fileSystemType: string
}

const NETWORK_FILE_SYSTEMS = new Set([
  'nfs', 'nfs4', 'cifs', 'smbfs', 'smb3', 'sshfs', 'fuse.sshfs', '9p', 'ceph', 'glusterfs',
  'davfs', 'webdav', 'fuse.davfs', 'fuse.webdav',
])

const MAC_NETWORK_FILE_SYSTEMS = new Set(['smbfs', 'nfs', 'webdav', 'afpfs', 'cifs'])

/** 执行一次无缓存数据根检查。 */
async function inspectDataRootStorageFresh(rootPath: string): Promise<DataRootStorageSnapshot> {
  /** 容量与目录扫描相互独立，并行减少设置页等待。 */
  const [occupiedBytes, volume] = await Promise.all([
    scanDataRootBytes(rootPath),
    inspectDataRootVolume(rootPath),
  ])
  return {
    occupiedBytes,
    ...volume,
  }
}

/** 读取目标所在卷容量与设备类型，不遍历目标目录。 */
export async function inspectDataRootVolume(rootPath: string): Promise<DataRootVolumeSnapshot> {
  const [fileSystemStats, deviceType] = await Promise.all([
    statfs(rootPath, { bigint: true }),
    detectDataRootDeviceType(rootPath),
  ])
  return {
    availableBytes: toSafeByteCount(fileSystemStats.bavail * fileSystemStats.bsize),
    deviceType,
  }
}

/** 按当前平台读取系统卷元数据；失败时明确返回 unknown。 */
export async function detectDataRootDeviceType(
  rootPath: string,
  options: DeviceTypeDetectionOptions = {},
): Promise<DataRootDeviceType> {
  /** 默认依赖封装成窄接口，测试可精确断言命令是否执行。 */
  const execute = options.execFile ?? (async (file, args) => {
    const result = await execFileAsync(file, args, { encoding: 'utf8' })
    return { stdout: String(result.stdout) }
  })
  const readTextFile = options.readFile ?? (async (path) => await readFile(path, 'utf8'))
  const resolveRealPath = options.realpath ?? realpath
  const platform = options.platform ?? process.platform
  try {
    if (platform === 'darwin') {
      /** diskutil plist 是 macOS 的卷元数据来源。 */
      const result = await execute('diskutil', ['info', '-plist', rootPath])
      return classifyMacDiskInfo(result.stdout)
    }
    if (platform === 'win32') {
      /** UNC 由路径语法即可确定为网络位置，绝不进入命令解释器。 */
      if (/^\\\\[^\\]+\\[^\\]+/.test(rootPath)) return 'network'
      /** 只允许 win32 parser 得到的单字母规范盘符进入固定脚本。 */
      const driveRoot = win32.parse(rootPath).root.replace(/[\\/]$/, '').toUpperCase()
      if (!/^[A-Z]:$/.test(driveRoot)) return 'unknown'
      const script = '$drive = $args[0]; (Get-CimInstance Win32_LogicalDisk -Filter ("DeviceID=\'" + $drive + "\'")).DriveType'
      const result = await execute('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command', script, driveRoot,
      ])
      return classifyWindowsDriveType(Number.parseInt(result.stdout.trim(), 10))
    }
    if (platform === 'linux') {
      const mountInfo = await readTextFile('/proc/self/mountinfo')
      return classifyLinuxMountInfo(rootPath, mountInfo, async (majorMinor) => await readLinuxBlockRemovable(
        majorMinor,
        { readFile: readTextFile, realpath: resolveRealPath },
      ))
    }
  } catch {
    return 'unknown'
  }
  return 'unknown'
}

/** 沿 sysfs 分区到父 block device 查找 removable 标记。 */
export async function readLinuxBlockRemovable(
  majorMinor: string,
  options: Required<Pick<DeviceTypeDetectionOptions, 'readFile' | 'realpath'>>,
): Promise<string | null> {
  let currentPath: string
  try {
    currentPath = await options.realpath(`/sys/dev/block/${majorMinor}`)
  } catch {
    return null
  }
  for (let depth = 0; depth < 16 && currentPath.startsWith('/sys/'); depth += 1) {
    try {
      return await options.readFile(join(currentPath, 'removable'))
    } catch {
      const parentPath = dirname(currentPath)
      if (parentPath === currentPath) return null
      currentPath = parentPath
    }
  }
  return null
}

/** 从 plist dict 中读取指定布尔 key。 */
function readPlistBoolean(xml: string, keyName: string): boolean | undefined {
  const document = new DOMParser().parseFromString(xml, 'application/xml')
  const keys = document.getElementsByTagName('key')
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys.item(index)
    if (key?.textContent !== keyName) continue
    /** plist key 后的下一个元素节点保存值。 */
    let valueNode = key.nextSibling
    while (valueNode !== null && valueNode.nodeType !== 1) valueNode = valueNode.nextSibling
    if (valueNode?.nodeName === 'true') return true
    if (valueNode?.nodeName === 'false') return false
  }
  return undefined
}

/** 从 plist dict 中读取指定字符串 key。 */
function readPlistString(xml: string, keyName: string): string | undefined {
  const document = new DOMParser().parseFromString(xml, 'application/xml')
  const keys = document.getElementsByTagName('key')
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys.item(index)
    if (key?.textContent !== keyName) continue
    let valueNode = key.nextSibling
    while (valueNode !== null && valueNode.nodeType !== 1) valueNode = valueNode.nextSibling
    if (valueNode?.nodeName === 'string') return valueNode.textContent ?? undefined
  }
  return undefined
}

/** 解析单行 Linux mountinfo。 */
function parseLinuxMountLine(line: string): LinuxMount | null {
  const separatorIndex = line.indexOf(' - ')
  if (separatorIndex < 0) return null
  const before = line.slice(0, separatorIndex).split(' ')
  const after = line.slice(separatorIndex + 3).split(' ')
  if (before.length < 5 || after.length < 1) return null
  return {
    majorMinor: before[2] ?? '',
    mountPoint: decodeMountInfoPath(before[4] ?? ''),
    fileSystemType: after[0] ?? '',
  }
}

/** 解码 mountinfo 对空格、tab、换行和反斜杠的八进制转义。 */
function decodeMountInfoPath(value: string): string {
  return value.replace(/\\(040|011|012|134)/g, (_match, code: string) => {
    const replacements: Record<string, string> = { '040': ' ', '011': '\t', '012': '\n', '134': '\\' }
    return replacements[code] ?? ''
  })
}

/** 判断绝对路径是否由指定 mount point 覆盖。 */
function isPathInsideMount(rootPath: string, mountPoint: string): boolean {
  return mountPoint === '/' || rootPath === mountPoint || rootPath.startsWith(`${mountPoint}/`)
}
