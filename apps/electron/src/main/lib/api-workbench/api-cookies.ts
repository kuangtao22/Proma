import type { ApiCookieJarEntry } from '@proma/shared'

/**
 * 主进程内存里的一条 cookie：只有这里带取值，永不进入运行记录、历史摘要或模型上下文。
 * 作用域按 host-only 记录，domain 就是收到 Set-Cookie 的那个 host。
 */
export interface ApiCookieJarRecord extends ApiCookieJarEntry {
  value: string
}

/** 单条 cookie 取值的字符上限；超过就整条丢弃，不做截断（截断的凭据只会制造假失败）。 */
export const MAX_COOKIE_VALUE_CHARS = 4096
/** 单次请求注入的 Cookie 头字符上限；超出部分按路径长度优先保留。 */
export const MAX_COOKIE_HEADER_CHARS = 8192
/** 每个 workspace 保留的 cookie 条数上限。 */
export const MAX_COOKIE_JAR_ENTRIES = 128

/** cookie 名与取值都必须是可安全放进头部的可见字符。 */
const COOKIE_NAME = /^[^\s\x00-\x1f;,"\\]{1,256}$/
const UNSAFE_VALUE = /[\r\n\x00]/

/** 存储键：同名 cookie 按 domain + path 并存，与浏览器语义一致。 */
export function cookieKey(cookie: Pick<ApiCookieJarRecord, 'name' | 'domain' | 'path'>): string {
  return `${cookie.name}\u0000${cookie.domain.toLowerCase()}\u0000${cookie.path}`
}

/** cookie 是否已被判定为删除：过期时间已到即视为删除。 */
export function isCookieExpired(cookie: ApiCookieJarRecord, now: number): boolean {
  return cookie.expiresAt !== null && cookie.expiresAt <= now
}

/** 路径按 RFC 6265 的前缀规则匹配：完全相等，或 cookie 路径以 / 结尾时的纯前缀。 */
function matchesPath(cookiePath: string, requestPath: string): boolean {
  const path = requestPath || '/'
  if (cookiePath === path) return true
  if (!path.startsWith(cookiePath)) return false
  return cookiePath.endsWith('/') || path[cookiePath.length] === '/'
}

/**
 * 选出这次请求要带上的 cookie 并拼成单个 Cookie 头。
 * @param jar 当前 workspace 的 cookie 记录。
 * @param url 插值后的最终请求 URL。
 * @param now 当前时间戳，用于过滤已过期的 cookie。
 * @returns Cookie 头的值；没有匹配或超出头部预算时返回空字符串。
 */
export function cookieHeaderValue(jar: readonly ApiCookieJarRecord[], url: URL, now: number): string {
  /** host-only 匹配，先按最长路径优先，再按名称稳定排序，保证同一份 jar 产生同一头。 */
  const matched = jar
    .filter((cookie) => cookie.domain.toLowerCase() === url.hostname.toLowerCase())
    .filter((cookie) => cookie.secure ? url.protocol === 'https:' : true)
    .filter((cookie) => !isCookieExpired(cookie, now))
    .filter((cookie) => matchesPath(cookie.path, url.pathname))
    .sort((left, right) => right.path.length - left.path.length || left.name.localeCompare(right.name))
  const parts: string[] = []
  let length = 0
  for (const cookie of matched) {
    const part = `${cookie.name}=${cookie.value}`
    if (length + part.length + 2 > MAX_COOKIE_HEADER_CHARS) break
    parts.push(part)
    length += part.length + 2
  }
  return parts.join('; ')
}

/**
 * 解析一条 Set-Cookie 响应头。
 * @param header 响应头的名称与原始值（重复头由调用方逐条传入）。
 * @param url 产生该响应的跳转 URL，用于确定 host-only 作用域。
 * @param now 当前时间戳，用于把 Max-Age 换算成过期时间。
 * @returns 可写入 jar 的记录与存储键；无法安全解析时返回 null（宁可少存，不存坏值）。
 */
export function parseApiSetCookie(header: { name: string; value: string }, url: URL, now: number): { record: ApiCookieJarRecord; key: string } | null {
  if (header.name.toLowerCase() !== 'set-cookie') return null
  const segments = header.value.split(';')
  const [first = '', ...attributes] = segments
  const separator = first.indexOf('=')
  if (separator <= 0) return null
  const name = first.slice(0, separator).trim()
  const value = first.slice(separator + 1).trim()
  if (!COOKIE_NAME.test(name) || UNSAFE_VALUE.test(value) || value.length > MAX_COOKIE_VALUE_CHARS) return null
  /** Domain= 不参与作用域计算：第一版固定 host-only，避免第三方 cookie 被跨站回送。 */
  let secure = false
  let httpOnly = false
  let path = '/'
  let expiresAt: number | null = null
  for (const attribute of attributes) {
    const index = attribute.indexOf('=')
    const key = (index < 0 ? attribute : attribute.slice(0, index)).trim().toLowerCase()
    const raw = index < 0 ? '' : attribute.slice(index + 1).trim()
    if (key === 'secure') secure = true
    else if (key === 'httponly') httpOnly = true
    else if (key === 'path' && raw.startsWith('/')) path = raw
    else if (key === 'max-age' && /^-?\d+$/.test(raw)) expiresAt = now + Number(raw) * 1000
    else if (key === 'expires' && expiresAt === null) {
      const parsed = Date.parse(raw)
      if (Number.isFinite(parsed)) expiresAt = parsed
    }
  }
  const record: ApiCookieJarRecord = { name, domain: url.hostname, path, secure, httpOnly, expiresAt, updatedAt: now, value }
  return { record, key: cookieKey(record) }
}
