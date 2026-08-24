import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
} from 'node:fs'
import type { Stats } from 'node:fs'
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { DesignPathResolver } from './design-paths'

/** 明确排除的依赖、版本控制、构建和 Proma 内部目录。 */
const EXCLUDED_NAMES = new Set([
  '.git',
  '.proma',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.turbo',
  '.cache',
  'out',
])
/** 命中即禁止发现、搜索或读取的敏感文件名模式。 */
const SENSITIVE_BASENAME_PATTERNS = [
  /^\.env(?:\.|$)/i,
  /credential/i,
  /secret/i,
  /private[-_.]?key/i,
  /(?:^|[-_.])id_rsa(?:$|[-_.])/i,
  /\.(?:pem|key|p12|pfx)$/i,
]
/** 可识别为项目文本的保守扩展名。 */
const TEXT_EXTENSIONS = new Set([
  '.c', '.cc', '.cpp', '.cs', '.css', '.go', '.h', '.hpp', '.html', '.java', '.js', '.jsx',
  '.json', '.kt', '.kts', '.less', '.md', '.mdx', '.mjs', '.mts', '.php', '.properties', '.py',
  '.rb', '.rs', '.scss', '.sh', '.sql', '.svelte', '.swift', '.toml', '.ts', '.tsx', '.txt',
  '.vue', '.xml', '.yaml', '.yml', '.zsh',
])
/** 没有扩展名但明确属于项目文本的常见文件名。 */
const TEXT_BASENAMES = new Set(['Dockerfile', 'Gemfile', 'Makefile', 'Procfile'])
/** 专用读取工具允许的单文件最大字节数。 */
const MAX_READ_BYTES = 64 * 1024
/** 搜索只检查每个候选文件的首段，避免搜索本身绕过读取预算。 */
const MAX_SEARCH_BYTES = MAX_READ_BYTES
/** 单次搜索返回的硬上限。 */
const MAX_SEARCH_RESULTS = 50

/** 项目文本候选的可审计元数据，不保存文件内容或绝对路径。 */
export interface DesignProjectTextEntry {
  relativePath: string
  byteSize: number
  modifiedAt: number
  identity: string
}

/** 项目文本索引公开的受限读取合同。 */
export interface DesignProjectTextIndexContract {
  list: (projectId: string, relativeDirectory?: string) => DesignProjectTextEntry[]
  search: (projectId: string, query: string, limit?: number) => DesignProjectTextEntry[]
  read: (projectId: string, relativePath: string, maxBytes: number) => string
  invalidate: (projectId: string, relativePath?: string) => void
}

/** 项目文本索引依赖，只允许通过已登记项目 ID 解析根目录。 */
export interface DesignProjectTextIndexDependencies {
  pathResolver: Pick<DesignPathResolver, 'resolve'>
}

/** 缓存中绑定项目根和相对路径的内部文件身份。 */
interface CachedProjectTextEntry extends DesignProjectTextEntry {
  absolutePath: string
  device: number
  inode: number
}

/** 每个项目独立的增量元数据缓存。 */
interface ProjectTextCache {
  projectRoot: string
  entries: Map<string, CachedProjectTextEntry>
}

/** 延迟扫描项目并用稳定身份读取文本的安全索引。 */
export class DesignProjectTextIndex implements DesignProjectTextIndexContract {
  /** 按项目 ID 隔离的元数据缓存，不保存正文。 */
  private readonly caches = new Map<string, ProjectTextCache>()

  constructor(private readonly dependencies: DesignProjectTextIndexDependencies) {}

  /**
   * 列出项目或其子目录内允许访问的文本文件。
   * @param projectId 已登记项目的稳定 ID。
   * @param relativeDirectory 可选的项目内相对目录。
   * @returns 按相对路径稳定排序的文件元数据。
   */
  list(projectId: string, relativeDirectory?: string): DesignProjectTextEntry[] {
    /** 规范化目录只用于结果过滤，扫描根仍来自路径解析器。 */
    const directory = relativeDirectory === undefined
      ? undefined
      : normalizeRelativePath(relativeDirectory, '项目相对目录非法', true)
    /** 每次显式列出时只刷新元数据和失效项，不缓存正文。 */
    const cache = this.refresh(projectId)
    return [...cache.entries.values()]
      .filter((entry) => directory === undefined
        || entry.relativePath === directory
        || entry.relativePath.startsWith(`${directory}/`))
      .sort(compareEntries)
      .map(toPublicEntry)
  }

  /**
   * 搜索文件名和每个候选文件的受限首段文本。
   * @param projectId 已登记项目 ID。
   * @param query 长度受限的搜索词。
   * @param limit 最多返回 50 条结果。
   * @returns 匹配文件的可审计元数据。
   */
  search(projectId: string, query: string, limit = 20): DesignProjectTextEntry[] {
    /** 用户搜索词去除首尾空白后用于大小写不敏感匹配。 */
    const normalizedQuery = query.trim()
    if (normalizedQuery.length === 0) throw new Error('搜索词不能为空')
    if (normalizedQuery.length > 200) throw new Error('搜索词不能超过 200 个字符')
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SEARCH_RESULTS) {
      throw new Error(`搜索结果上限必须为 1-${MAX_SEARCH_RESULTS}`)
    }
    /** 搜索前增量刷新文件身份，确保替换文件不会沿用旧缓存。 */
    const cache = this.refresh(projectId)
    const needle = normalizedQuery.toLocaleLowerCase()
    /** 按路径排序后收集结果，保证相同项目状态下顺序稳定。 */
    const results: DesignProjectTextEntry[] = []
    for (const entry of [...cache.entries.values()].sort(compareEntries)) {
      if (entry.relativePath.toLocaleLowerCase().includes(needle)) {
        results.push(toPublicEntry(entry))
      } else {
        try {
          /** 搜索正文只读取专用工具可读取的同一首段上限。 */
          const content = readStableEntry(entry, MAX_SEARCH_BYTES)
          if (content.toLocaleLowerCase().includes(needle)) results.push(toPublicEntry(entry))
        } catch {
          /** 搜索期间发生身份变化只跳过该候选，并移除旧缓存。 */
          cache.entries.delete(entry.relativePath)
        }
      }
      if (results.length >= limit) break
    }
    return results
  }

  /**
   * 按索引时固定的文件身份读取项目文本首段。
   * @param projectId 已登记项目 ID。
   * @param relativePath 项目内文本文件相对路径。
   * @param maxBytes 本次最多读取的 UTF-8 原始字节数，硬上限 64 KiB。
   * @returns 解码后的文本首段。
   */
  read(projectId: string, relativePath: string, maxBytes: number): string {
    /** 严格相对路径禁止绝对路径、空路径与父级跳转。 */
    const normalizedPath = normalizeRelativePath(relativePath, '项目相对路径非法', false)
    if (!Number.isInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_READ_BYTES) {
      throw new Error(`项目文件读取上限必须为 0-${MAX_READ_BYTES} 字节`)
    }
    /** read 不主动重建索引，调用方必须先通过 list/search 取得可审计候选。 */
    const cache = this.caches.get(projectId)
    if (!cache) throw new Error(`项目文件尚未建立索引: ${normalizedPath}`)
    /** 当前相对路径在既有项目缓存中的文件身份。 */
    const entry = cache.entries.get(normalizedPath)
    if (!entry) throw new Error(`项目文件尚未建立索引: ${normalizedPath}`)
    try {
      return readStableEntry(entry, maxBytes)
    } catch (error) {
      /** 身份不一致后立即清除旧授权，下一次必须重新发现。 */
      cache.entries.delete(normalizedPath)
      throw error
    }
  }

  /**
   * 失效整个项目或单个相对路径的元数据缓存。
   * @param projectId 已登记项目 ID。
   * @param relativePath 可选的项目内文件相对路径。
   */
  invalidate(projectId: string, relativePath?: string): void {
    if (relativePath === undefined) {
      this.caches.delete(projectId)
      return
    }
    /** 单文件失效同样拒绝越权路径语义。 */
    const normalizedPath = normalizeRelativePath(relativePath, '项目相对路径非法', false)
    this.caches.get(projectId)?.entries.delete(normalizedPath)
  }

  /** 增量扫描项目元数据，并移除已删除或不再安全的缓存项。 */
  private refresh(projectId: string): ProjectTextCache {
    /** 项目根只能来自已登记工作区的可信解析器。 */
    const paths = this.dependencies.pathResolver.resolve(projectId)
    const rootStat = lstatSync(paths.projectRoot)
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Error(`项目根不是实际目录: ${paths.projectRoot}`)
    }
    /** 物理项目根是所有候选 realpath 的包含基准。 */
    const projectRoot = realpathSync(paths.projectRoot)
    /** 项目根变化时丢弃旧缓存，避免跨迁移复用身份。 */
    const existingCache = this.caches.get(projectId)
    const cache: ProjectTextCache = existingCache?.projectRoot === projectRoot
      ? existingCache
      : { projectRoot, entries: new Map() }
    /** 本轮实际发现的安全相对路径。 */
    const seenPaths = new Set<string>()
    walkProjectDirectory(projectRoot, projectRoot, cache, seenPaths)
    for (const relativePath of cache.entries.keys()) {
      if (!seenPaths.has(relativePath)) cache.entries.delete(relativePath)
    }
    this.caches.set(projectId, cache)
    return cache
  }
}

/** 递归遍历实际目录并增量更新普通文本文件元数据。 */
function walkProjectDirectory(
  projectRoot: string,
  directoryPath: string,
  cache: ProjectTextCache,
  seenPaths: Set<string>,
): void {
  /** 目录项排序确保跨文件系统返回顺序稳定。 */
  const entries = readdirSync(directoryPath, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
  for (const directoryEntry of entries) {
    if (EXCLUDED_NAMES.has(directoryEntry.name)) continue
    /** 当前候选的绝对路径只在主进程内存中使用。 */
    const absolutePath = join(directoryPath, directoryEntry.name)
    /** lstat 保证不跟随目录或文件叶子的符号链接。 */
    const stat = lstatSync(absolutePath)
    if (stat.isSymbolicLink()) continue
    if (stat.isDirectory()) {
      walkProjectDirectory(projectRoot, absolutePath, cache, seenPaths)
      continue
    }
    if (!isSafeTextCandidate(directoryEntry.name, stat)) continue
    /** 候选物理路径必须继续位于项目物理根内。 */
    const canonicalPath = realpathSync(absolutePath)
    if (!isContainedPath(projectRoot, canonicalPath)) continue
    /** 对外只保留 POSIX 风格相对路径。 */
    const relativePath = relative(projectRoot, canonicalPath).split(sep).join('/')
    seenPaths.add(relativePath)
    /** 当前身份用于决定是否可以复用已有元数据对象。 */
    const identity = createIdentity(stat)
    const existing = cache.entries.get(relativePath)
    if (existing
      && existing.identity === identity
      && existing.byteSize === stat.size
      && existing.modifiedAt === stat.mtimeMs) {
      continue
    }
    cache.entries.set(relativePath, {
      relativePath,
      absolutePath,
      byteSize: stat.size,
      modifiedAt: stat.mtimeMs,
      identity,
      device: stat.dev,
      inode: stat.ino,
    })
  }
}

/** 判断目录项名称、扩展名和文件身份是否适合文本索引。 */
function isSafeTextCandidate(name: string, stat: Stats): boolean {
  if (!stat.isFile() || stat.nlink !== 1) return false
  if (SENSITIVE_BASENAME_PATTERNS.some((pattern) => pattern.test(name))) return false
  return TEXT_EXTENSIONS.has(extname(name).toLocaleLowerCase()) || TEXT_BASENAMES.has(name)
}

/** 使用缓存身份、no-follow descriptor 和读取后复验返回受限文本。 */
function readStableEntry(entry: CachedProjectTextEntry, maxBytes: number): string {
  /** 打开前路径身份必须与索引缓存完全一致。 */
  const pathStat = lstatSync(entry.absolutePath)
  assertCachedIdentity(entry, pathStat)
  /** descriptor 仅由本次读取拥有。 */
  let descriptor: number | null = null
  try {
    descriptor = openSync(entry.absolutePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const openedStat = fstatSync(descriptor)
    assertCachedIdentity(entry, openedStat)
    /** 只分配调用方允许的读取容量，避免大文件整体进入内存。 */
    const targetBytes = Math.min(maxBytes, entry.byteSize)
    const buffer = Buffer.alloc(targetBytes)
    /** 已读字节数，用于处理短读。 */
    let offset = 0
    while (offset < targetBytes) {
      const bytesRead = readSync(descriptor, buffer, offset, targetBytes - offset, null)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    /** 读取后再次复验同一 descriptor 的身份与 metadata。 */
    assertCachedIdentity(entry, fstatSync(descriptor))
    return buffer.subarray(0, offset).toString('utf8')
  } finally {
    if (descriptor !== null) closeSync(descriptor)
  }
}

/** 确认当前文件仍与索引时的 dev/ino/size/mtime 身份一致。 */
function assertCachedIdentity(entry: CachedProjectTextEntry, stat: Stats): void {
  if (!stat.isFile()
    || stat.nlink !== 1
    || stat.dev !== entry.device
    || stat.ino !== entry.inode
    || stat.size !== entry.byteSize
    || stat.mtimeMs !== entry.modifiedAt) {
    throw new Error(`项目文件身份已变化: ${entry.relativePath}`)
  }
}

/** 生成包含文件对象与内容版本 metadata 的稳定身份字符串。 */
function createIdentity(stat: Stats): string {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`
}

/** 规范化并验证用户可见的项目相对路径。 */
function normalizeRelativePath(value: string, message: string, allowDot: boolean): string {
  /** 统一路径分隔符后拒绝绝对路径和父级跳转。 */
  const normalizedInput = value.trim().replaceAll('\\', '/')
  if (normalizedInput.length === 0 || isAbsolute(normalizedInput)) throw new Error(message)
  /** resolve 后再转回相对路径，消除重复分隔符和当前目录片段。 */
  const normalized = relative('/', resolve('/', normalizedInput)).split(sep).join('/')
  if ((!allowDot && normalized === '')
    || normalized === '..'
    || normalized.startsWith('../')
    || normalizedInput.split('/').includes('..')) {
    throw new Error(message)
  }
  return normalized
}

/** 判断候选物理路径是否位于项目物理根内。 */
function isContainedPath(projectRoot: string, candidatePath: string): boolean {
  /** 相对关系为空表示项目根本身，文件候选不会出现但仍安全。 */
  const relativePath = relative(projectRoot, candidatePath)
  return relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath)
}

/** 复制公开字段，确保调用方无法接触绝对路径与内部身份字段。 */
function toPublicEntry(entry: CachedProjectTextEntry): DesignProjectTextEntry {
  return {
    relativePath: entry.relativePath,
    byteSize: entry.byteSize,
    modifiedAt: entry.modifiedAt,
    identity: entry.identity,
  }
}

/** 按相对路径稳定排序项目文本条目。 */
function compareEntries(left: DesignProjectTextEntry, right: DesignProjectTextEntry): number {
  return left.relativePath.localeCompare(right.relativePath)
}
