/**
 * Token-gated local file protocol support for inline previews.
 *
 * The renderer never receives raw proma-file:// absolute paths. Main process
 * code registers an already-authorized file or directory and gets back an
 * opaque URL that the protocol handler can resolve.
 */

import { randomUUID } from 'node:crypto'
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, read, realpathSync, statSync } from 'node:fs'
import { extname, resolve, sep } from 'node:path'

interface RegisteredPathEntry {
  kind: 'path'
  root: string
  isDirectory: boolean
  lastAccessedAt: number
  retained: boolean
}

interface RegisteredBufferEntry {
  kind: 'buffer'
  canonicalPath: string
  content: Buffer
  lastAccessedAt: number
  retained: boolean
}

type RegisteredEntry = RegisteredPathEntry | RegisteredBufferEntry

const ENTRY_TTL_MS = 60 * 60 * 1000
const MAX_ENTRIES = 500
const MAX_AUTHORIZED_BUFFER_BYTES = 256 * 1024 * 1024

/** 本地文件协议 registry 的可注入时间与 fetch 依赖。 */
export interface PromaFileProtocolRegistryDependencies {
  /** 当前毫秒时钟，测试可精确推进且不修改全局 Date。 */
  now?: () => number
  /** realpath 校验后、no-follow 打开前调用，仅供稳定竞态测试。 */
  afterResolveBeforeOpen?: (targetPath: string) => void
  /** 稳定 fd 打开后调用，仅供验证流取消与 HEAD 及时关闭。 */
  onDescriptorOpened?: (descriptor: number) => void
  /** 已授权 Buffer 总预算，测试可用小值验证 LRU 淘汰。 */
  maxAuthorizedBufferBytes?: number
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
  registerAuthorizedFile: (canonicalPath: string, content: Buffer) => string
  registerDirectoryPath: (path: string) => string
  registerRetainedDirectoryPaths: (paths: string[]) => string[]
  retainPathUrl: (url: string) => boolean
  revokePathUrl: (url: string) => void
  handleRequest: (request: Request) => Promise<Response> | Response
}

/** 创建具备滑动 TTL 的本地文件授权 registry。 */
export function createPromaFileProtocolRegistry(
  dependencies: PromaFileProtocolRegistryDependencies = {},
): PromaFileProtocolRegistry {
  /** 当前 registry 独占的授权 token 集合。 */
  const registeredEntries = new Map<string, RegisteredEntry>()

  /** 清理普通闲置 token；retained token 只能显式释放。 */
  function pruneExpiredEntries(currentTime: number): void {
    for (const [token, entry] of registeredEntries) {
      if (!entry.retained && currentTime - entry.lastAccessedAt >= ENTRY_TTL_MS) registeredEntries.delete(token)
    }
  }

  /** 为新 token 预留容量，普通 token 按最久未访问顺序淘汰。 */
  function reserveEntryCapacity(currentTime: number, newEntryCount: number, newBufferBytes = 0): void {
    pruneExpiredEntries(currentTime)
    const evictionCount = Math.max(0, registeredEntries.size + newEntryCount - MAX_ENTRIES)
    const evictable = [...registeredEntries.entries()]
      .filter(([, entry]) => !entry.retained)
      .sort((left, right) => left[1].lastAccessedAt - right[1].lastAccessedAt)
    if (evictable.length < evictionCount) throw new Error('本地文件授权数量已达上限')
    const evictedTokens = new Set(evictable.slice(0, evictionCount).map(([token]) => token))
    const maxBufferBytes = dependencies.maxAuthorizedBufferBytes ?? MAX_AUTHORIZED_BUFFER_BYTES
    if (newBufferBytes > maxBufferBytes) throw new Error('本地文件授权内容超过内存预算')
    let retainedBufferBytes = [...registeredEntries.entries()].reduce((total, [token, entry]) => (
      total + (entry.kind === 'buffer' && !evictedTokens.has(token) ? entry.content.byteLength : 0)
    ), 0)
    for (const [token, entry] of evictable) {
      if (retainedBufferBytes + newBufferBytes <= maxBufferBytes) break
      if (entry.kind !== 'buffer' || evictedTokens.has(token)) continue
      evictedTokens.add(token)
      retainedBufferBytes -= entry.content.byteLength
    }
    if (retainedBufferBytes + newBufferBytes > maxBufferBytes) {
      throw new Error('本地文件授权内容超过内存预算')
    }
    for (const token of evictedTokens) registeredEntries.delete(token)
  }

  /** 批量校验路径并原子预留容量，失败时不插入任何新 token。 */
  function registerEntries(
    inputs: Array<{ path: string, isDirectory: boolean }>,
    retained: boolean,
  ): string[] {
    const currentTime = (dependencies.now ?? Date.now)()
    /** 全部路径先验证，第二项非法时不得污染 registry。 */
    const validated = inputs.map(({ path, isDirectory }) => {
      const root = realpathExisting(path)
      const st = statSync(root)
      if (isDirectory && !st.isDirectory()) throw new Error(`不是目录: ${path}`)
      if (!isDirectory && !st.isFile()) throw new Error(`不是文件: ${path}`)
      return { root, isDirectory }
    })
    reserveEntryCapacity(currentTime, validated.length)
    return validated.map(({ root, isDirectory }) => {
      const token = randomUUID()
      registeredEntries.set(token, { kind: 'path', root, isDirectory, lastAccessedAt: currentTime, retained })
      return `proma-file://${token}`
    })
  }

  /** 注册已由上游稳定 lease 读取的单文件 Buffer，协议后续不再按路径打开。 */
  function registerAuthorizedFile(canonicalPath: string, content: Buffer): string {
    const currentTime = (dependencies.now ?? Date.now)()
    reserveEntryCapacity(currentTime, 1, content.byteLength)
    const token = randomUUID()
    registeredEntries.set(token, {
      kind: 'buffer',
      canonicalPath,
      content,
      lastAccessedAt: currentTime,
      retained: false,
    })
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
  function retainPathUrl(url: string): boolean {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return false
    }
    if (parsed.protocol !== 'proma-file:') return false
    const entry = registeredEntries.get(parsed.hostname)
    if (!entry) return false
    entry.retained = true
    return true
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

    if (entry.kind === 'buffer') {
      if (url.pathname && url.pathname !== '/') return new Response('Not Found', { status: 404 })
      const range = parseByteRange(request.headers.get('range'), entry.content.byteLength)
      if (range === 'unsatisfiable') {
        return new Response(null, {
          status: 416,
          headers: { 'accept-ranges': 'bytes', 'content-range': `bytes */${entry.content.byteLength}` },
        })
      }
      const start = range?.start ?? 0
      const end = range?.end ?? entry.content.byteLength - 1
      const body = entry.content.subarray(start, Math.max(start, end + 1))
      const headers = new Headers({
        'accept-ranges': 'bytes',
        'content-length': String(body.byteLength),
        'content-type': contentTypeForPath(entry.canonicalPath),
      })
      if (range) headers.set('content-range', `bytes ${start}-${end}/${entry.content.byteLength}`)
      entry.lastAccessedAt = currentTime
      const responseBody = request.method === 'HEAD' ? null : Uint8Array.from(body)
      return new Response(responseBody, { status: range ? 206 : 200, headers })
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
      dependencies.onDescriptorOpened?.(descriptor)
      const openedStat = fstatSync(descriptor)
      if (!openedStat.isFile() || openedStat.dev !== pathStat.dev || openedStat.ino !== pathStat.ino) {
        return new Response('Forbidden', { status: 403 })
      }
      const range = parseByteRange(request.headers.get('range'), openedStat.size)
      if (range === 'unsatisfiable') {
        closeSync(descriptor)
        descriptor = null
        return new Response(null, {
          status: 416,
          headers: { 'accept-ranges': 'bytes', 'content-range': `bytes */${openedStat.size}` },
        })
      }
      const start = range?.start ?? 0
      const end = range?.end ?? openedStat.size - 1
      const contentLength = Math.max(0, end - start + 1)
      const headers = new Headers({
        'accept-ranges': 'bytes',
        'content-length': String(contentLength),
        'content-type': contentTypeForPath(target),
      })
      if (range) headers.set('content-range', `bytes ${start}-${end}/${openedStat.size}`)
      const status = range ? 206 : 200
      entry.lastAccessedAt = currentTime
      if (request.method === 'HEAD') {
        closeSync(descriptor)
        descriptor = null
        return new Response(null, { status, headers })
      }
      /** Response 只消费已验证 fd，取消或读完时由 stream 精确关闭句柄。 */
      const body = createDescriptorStream(descriptor, start, end)
      const response = new Response(body, { status, headers })
      descriptor = null
      return response
    } catch {
      return new Response('Forbidden', { status: 403 })
    } finally {
      if (descriptor !== null) closeSync(descriptor)
    }
  }

  return {
    registerFilePath: (path) => registerEntries([{ path, isDirectory: false }], false)[0]!,
    registerAuthorizedFile,
    registerDirectoryPath: (path) => registerEntries([{ path, isDirectory: true }], false)[0]!,
    registerRetainedDirectoryPaths: (paths) => registerEntries(
      paths.map((path) => ({ path, isDirectory: true })),
      true,
    ),
    retainPathUrl,
    revokePathUrl,
    handleRequest,
  }
}

interface ByteRange {
  start: number
  end: number
}

/** 解析单段 HTTP bytes Range；格式无效或无法满足时统一返回 416。 */
function parseByteRange(header: string | null, size: number): ByteRange | 'unsatisfiable' | undefined {
  if (!header) return undefined
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match || size === 0) return 'unsatisfiable'
  const [, rawStart, rawEnd] = match
  if (!rawStart && !rawEnd) return 'unsatisfiable'
  if (!rawStart) {
    const suffixLength = Number(rawEnd)
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return 'unsatisfiable'
    return { start: Math.max(0, size - suffixLength), end: size - 1 }
  }
  const start = Number(rawStart)
  const requestedEnd = rawEnd ? Number(rawEnd) : size - 1
  if (!Number.isSafeInteger(start)
    || !Number.isSafeInteger(requestedEnd)
    || start < 0
    || start >= size
    || requestedEnd < start) return 'unsatisfiable'
  return { start, end: Math.min(requestedEnd, size - 1) }
}

/** 从已验证 fd 分块创建 Web ReadableStream，完成、错误或取消均幂等关闭。 */
function createDescriptorStream(descriptor: number, start: number, end: number): ReadableStream<Uint8Array> {
  /** 下一次分块读取的绝对文件偏移。 */
  let position = start
  /** fd 只能由一个终止路径关闭一次。 */
  let closed = false
  const closeDescriptor = (): void => {
    if (closed) return
    closed = true
    closeSync(descriptor)
  }
  return new ReadableStream<Uint8Array>({
    pull: (controller) => new Promise<void>((resolvePull) => {
      const remaining = end - position + 1
      if (remaining <= 0) {
        closeDescriptor()
        controller.close()
        resolvePull()
        return
      }
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining))
      read(descriptor, chunk, 0, chunk.byteLength, position, (error, bytesRead) => {
        /** cancel 可能与异步 read 同时发生；关闭后不得再写入已取消 controller。 */
        if (closed) {
          resolvePull()
          return
        }
        if (error || bytesRead === 0) {
          closeDescriptor()
          if (error) controller.error(error)
          else controller.error(new Error('本地媒体文件读取期间被截断'))
          resolvePull()
          return
        }
        position += bytesRead
        controller.enqueue(chunk.subarray(0, bytesRead))
        if (position > end) {
          closeDescriptor()
          controller.close()
        }
        resolvePull()
      })
    }),
    cancel: () => closeDescriptor(),
  })
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

/** 注册稳定授权内容；token 生命周期内协议不会重新按 canonicalPath 打开文件。 */
export function registerPromaAuthorizedFile(canonicalPath: string, content: Buffer): string {
  return defaultRegistry.registerAuthorizedFile(canonicalPath, content)
}

export function registerPromaDirectoryPath(path: string): string {
  return defaultRegistry.registerDirectoryPath(path)
}

/** 原子注册并 retain 多个 Design 媒体目录，容量不足时一个 token 都不创建。 */
export function registerRetainedPromaDirectoryPaths(paths: string[]): string[] {
  return defaultRegistry.registerRetainedDirectoryPaths(paths)
}

/** 将默认 registry 中的 token 提升为显式 release 生命周期。 */
export function retainPromaPathUrl(url: string): boolean {
  return defaultRegistry.retainPathUrl(url)
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
