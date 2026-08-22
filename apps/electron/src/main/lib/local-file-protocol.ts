/**
 * Token-gated local file protocol support for inline previews.
 *
 * The renderer never receives raw proma-file:// absolute paths. Main process
 * code registers an already-authorized file or directory and gets back an
 * opaque URL that the protocol handler can resolve.
 */

import { randomUUID } from 'node:crypto'
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { extname, resolve, sep } from 'node:path'

interface RegisteredEntry {
  root: string
  isDirectory: boolean
  lastAccessedAt: number
  retained: boolean
}

const ENTRY_TTL_MS = 60 * 60 * 1000
const MAX_ENTRIES = 500

/** 本地文件协议 registry 的可注入时间与 fetch 依赖。 */
export interface PromaFileProtocolRegistryDependencies {
  /** 当前毫秒时钟，测试可精确推进且不修改全局 Date。 */
  now?: () => number
  /** realpath 校验后、no-follow 打开前调用，仅供稳定竞态测试。 */
  afterResolveBeforeOpen?: (targetPath: string) => void
}

function realpathExisting(path: string): string {
  const resolved = realpathSync(resolve(path))
  if (!existsSync(resolved)) {
    throw new Error(`文件不存在: ${path}`)
  }
  return resolved
}

function isInsideDirectory(target: string, root: string): boolean {
  return target === root || target.startsWith(root.endsWith(sep) ? root : root + sep)
}

/** 单个独立的 opaque 本地文件授权 registry。 */
export interface PromaFileProtocolRegistry {
  registerFilePath: (path: string) => string
  registerDirectoryPath: (path: string) => string
  retainPathUrl: (url: string) => void
  revokePathUrl: (url: string) => void
  handleRequest: (request: Request) => Promise<Response> | Response
}

/** 创建具备滑动 TTL 的本地文件授权 registry。 */
export function createPromaFileProtocolRegistry(
  dependencies: PromaFileProtocolRegistryDependencies = {},
): PromaFileProtocolRegistry {
  /** 当前 registry 独占的授权 token 集合。 */
  const registeredEntries = new Map<string, RegisteredEntry>()

  /** 注册新 token 前清理闲置过期和超过容量的最久未访问条目。 */
  function pruneEntries(currentTime: number): void {
    for (const [token, entry] of registeredEntries) {
      if (!entry.retained && currentTime - entry.lastAccessedAt >= ENTRY_TTL_MS) registeredEntries.delete(token)
    }
    while (registeredEntries.size >= MAX_ENTRIES) {
      /** 容量淘汰按实际最后访问时间，而不是最初插入顺序。 */
      let oldestToken: string | undefined
      let oldestAccess = Number.POSITIVE_INFINITY
      for (const [token, entry] of registeredEntries) {
        if (!entry.retained && entry.lastAccessedAt < oldestAccess) {
          oldestAccess = entry.lastAccessedAt
          oldestToken = token
        }
      }
      if (!oldestToken) throw new Error('本地文件授权数量已达上限')
      registeredEntries.delete(oldestToken)
    }
  }

  /** 注册单个已授权实际文件或目录。 */
  function registerEntry(path: string, isDirectory: boolean): string {
    const currentTime = (dependencies.now ?? Date.now)()
    pruneEntries(currentTime)
    const root = realpathExisting(path)
    const st = statSync(root)
    if (isDirectory && !st.isDirectory()) throw new Error(`不是目录: ${path}`)
    if (!isDirectory && !st.isFile()) throw new Error(`不是文件: ${path}`)
    const token = randomUUID()
    registeredEntries.set(token, { root, isDirectory, lastAccessedAt: currentTime, retained: false })
    return `proma-file://${token}`
  }

  /** 显式释放单个 opaque URL。 */
  function revokePathUrl(url: string): void {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return
    }
    if (parsed.protocol !== 'proma-file:') return
    registeredEntries.delete(parsed.hostname)
  }

  /** 将普通滑动 TTL token 提升为显式 release 前持续有效的 lease。 */
  function retainPathUrl(url: string): void {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return
    }
    if (parsed.protocol !== 'proma-file:') return
    const entry = registeredEntries.get(parsed.hostname)
    if (entry) entry.retained = true
  }

  /** 解析并读取单个已授权请求，在成功交给 fetch 前续期 token。 */
  function handleRequest(request: Request): Promise<Response> | Response {
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      return new Response('Bad Request', { status: 400 })
    }
    const token = url.hostname
    const entry = registeredEntries.get(token)
    if (!entry) return new Response('Not Found', { status: 404 })
    const currentTime = (dependencies.now ?? Date.now)()
    if (!entry.retained && currentTime - entry.lastAccessedAt >= ENTRY_TTL_MS) {
      registeredEntries.delete(token)
      return new Response('Not Found', { status: 404 })
    }

    let target = entry.root
    if (entry.isDirectory) {
      /** 非法百分号编码属于请求格式错误，不能让协议 handler 抛出。 */
      let relativePath: string
      try {
        relativePath = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
      } catch {
        return new Response('Bad Request', { status: 400 })
      }
      try {
        target = realpathSync(resolve(entry.root, relativePath))
      } catch {
        return new Response('Not Found', { status: 404 })
      }
      if (!isInsideDirectory(target, entry.root)) return new Response('Forbidden', { status: 403 })
    } else if (url.pathname && url.pathname !== '/') {
      return new Response('Not Found', { status: 404 })
    }
    /** realpath 后绑定目标身份，后续不得再次按路径交给网络栈打开。 */
    let pathStat: ReturnType<typeof lstatSync>
    try {
      pathStat = lstatSync(target)
    } catch {
      return new Response('Not Found', { status: 404 })
    }
    if (!pathStat.isFile() || pathStat.isSymbolicLink()) return new Response('Forbidden', { status: 403 })
    dependencies.afterResolveBeforeOpen?.(target)
    /** O_NOFOLLOW 固定叶子，fstat 身份比较同时捕获祖先目录替换。 */
    let descriptor: number | null = null
    try {
      descriptor = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      const openedStat = fstatSync(descriptor)
      if (!openedStat.isFile() || openedStat.dev !== pathStat.dev || openedStat.ino !== pathStat.ino) {
        return new Response('Forbidden', { status: 403 })
      }
      const bytes = readFileSync(descriptor)
      const finalStat = fstatSync(descriptor)
      if (finalStat.dev !== openedStat.dev
        || finalStat.ino !== openedStat.ino
        || finalStat.size !== openedStat.size
        || bytes.byteLength !== openedStat.size) {
        return new Response('Forbidden', { status: 403 })
      }
      /** 只有完整读取稳定 fd 的有效请求才刷新滑动 TTL。 */
      entry.lastAccessedAt = currentTime
      return new Response(bytes, { headers: { 'content-type': contentTypeForPath(target) } })
    } catch {
      return new Response('Forbidden', { status: 403 })
    } finally {
      if (descriptor !== null) closeSync(descriptor)
    }
  }

  return {
    registerFilePath: (path) => registerEntry(path, false),
    registerDirectoryPath: (path) => registerEntry(path, true),
    retainPathUrl,
    revokePathUrl,
    handleRequest,
  }
}

/** 生产进程共享的默认本地文件授权 registry。 */
const defaultRegistry = createPromaFileProtocolRegistry({
  now: Date.now,
})

/** 根据预览文件扩展名返回最小必要响应类型。 */
function contentTypeForPath(path: string): string {
  const extension = extname(path).toLowerCase()
  const contentTypes: Record<string, string> = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
    '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.json': 'application/json', '.js': 'text/javascript',
    '.mjs': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.txt': 'text/plain', '.woff': 'font/woff',
    '.woff2': 'font/woff2',
  }
  return contentTypes[extension] ?? 'application/octet-stream'
}

export function registerPromaFilePath(path: string): string {
  return defaultRegistry.registerFilePath(path)
}

export function registerPromaDirectoryPath(path: string): string {
  return defaultRegistry.registerDirectoryPath(path)
}

/** 将默认 registry 中的 token 提升为显式 release 生命周期。 */
export function retainPromaPathUrl(url: string): void {
  defaultRegistry.retainPathUrl(url)
}

/**
 * 释放单个 opaque 本地文件授权，非法或非 proma-file URL 保持幂等忽略。
 * @param url 之前由注册函数返回的 opaque URL。
 */
export function revokePromaPathUrl(url: string): void {
  defaultRegistry.revokePathUrl(url)
}

export function handlePromaFileRequest(request: Request): Promise<Response> | Response {
  return defaultRegistry.handleRequest(request)
}
