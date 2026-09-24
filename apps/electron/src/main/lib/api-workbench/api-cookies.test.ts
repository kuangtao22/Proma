import { describe, expect, test } from 'bun:test'
import { cookieHeaderValue, cookieKey, isCookieExpired, parseApiSetCookie, MAX_COOKIE_HEADER_CHARS } from './api-cookies'
import type { ApiCookieJarRecord } from './api-cookies'

/** 构造一条 cookie 记录。 */
function cookie(overrides: Partial<ApiCookieJarRecord> = {}): ApiCookieJarRecord {
  return { name: 'session', domain: 'api.example.test', path: '/', secure: false, httpOnly: false, expiresAt: null, updatedAt: 1, value: 'abc123', ...overrides }
}
/** 解析 Set-Cookie 的便捷入口。 */
function parse(value: string, url = 'https://api.example.test/login', now = 1_000): ApiCookieJarRecord | null {
  return parseApiSetCookie({ name: 'Set-Cookie', value }, new URL(url), now)?.record ?? null
}
/** 取出 Cookie 头里的名称顺序，避免对拼接细节做过度断言。 */
function names(header: string): string[] {
  return header === '' ? [] : header.split('; ').map((part) => part.slice(0, part.indexOf('=')))
}

describe('Cookie Jar 解析与选值', () => {
  test('Given 常规 Set-Cookie When 解析 Then 记录 host-only 作用域与安全标记', () => {
    const record = parse('session=abc123; Path=/app; HttpOnly; Secure; Max-Age=3600')
    const other = parse('plain=1')

    expect(record).toEqual({ name: 'session', domain: 'api.example.test', path: '/app', secure: true, httpOnly: true, expiresAt: 1_000 + 3_600_000, updatedAt: 1_000, value: 'abc123' })
    /** 没有属性的会话 cookie 默认根路径、非安全、无过期时间。 */
    expect(other).toEqual({ name: 'plain', domain: 'api.example.test', path: '/', secure: false, httpOnly: false, expiresAt: null, updatedAt: 1_000, value: '1' })
  })

  test('Given Domain 属性 When 解析 Then 不放宽作用域（保持 host-only）', () => {
    const record = parse('wide=1; Domain=.example.test')

    expect(record?.domain).toBe('api.example.test')
  })

  test('Given Expires 或 Max-Age=0 When 解析 Then 换算成过期时间', () => {
    const expires = parse('a=1; Expires=Wed, 01 Jan 2031 00:00:00 GMT')
    const deleted = parse('b=1; Max-Age=0')
    const negative = parse('c=1; Max-Age=-1')

    expect(expires?.expiresAt).toBe(Date.parse('Wed, 01 Jan 2031 00:00:00 GMT'))
    expect(deleted && isCookieExpired(deleted, 1_000)).toBe(true)
    expect(negative && isCookieExpired(negative, 1_000)).toBe(true)
  })

  test('Given 畸形或超长的 Set-Cookie When 解析 Then 整条丢弃而不是截断', () => {
    expect(parse('')).toBeNull()
    expect(parse('=novalue')).toBeNull()
    expect(parse('bad name=1')).toBeNull()
    expect(parse(`long=${'x'.repeat(4097)}`)).toBeNull()
    /** 值里出现 CR/LF 会破坏请求头，直接丢弃。 */
    expect(parse('split=a\r\nb')).toBeNull()
    expect(parseApiSetCookie({ name: 'Set-Cookie2', value: 'a=1' }, new URL('https://api.example.test/'), 1)).toBeNull()
  })

  test('Given 作用域不同的 cookie When 选值 Then 只带 host、路径、协议与时间都匹配的那些', () => {
    const now = 1_000
    const jar = [
      cookie({ name: 'root', path: '/', value: 'r' }),
      cookie({ name: 'scoped', path: '/app', value: 's' }),
      cookie({ name: 'other', path: '/app', value: 'x', domain: 'other.example.test' }),
      cookie({ name: 'secureOnly', path: '/', value: 'c', secure: true }),
      cookie({ name: 'expired', path: '/', value: 'e', expiresAt: 500 }),
      cookie({ name: 'userdir', path: '/app2', value: 'u' }),
    ]

    /** 最长路径在前，同级按名称排序。 */
    expect(names(cookieHeaderValue(jar, new URL('http://api.example.test/app/orders'), now))).toEqual(['scoped', 'root'])
    /** https 才会带上 Secure cookie。 */
    expect(names(cookieHeaderValue(jar, new URL('https://api.example.test/app'), now))).toEqual(['scoped', 'root', 'secureOnly'])
    /** 前缀边界不能靠字符串前缀蒙混：/app 不匹配 /application。 */
    expect(names(cookieHeaderValue(jar, new URL('https://api.example.test/application'), now))).toEqual(['root', 'secureOnly'])
    expect(names(cookieHeaderValue(jar, new URL('https://api.example.test/app2'), now))).toEqual(['userdir', 'root', 'secureOnly'])
  })

  test('Given 没有可用 cookie When 选值 Then 返回空字符串而不是空头部', () => {
    expect(cookieHeaderValue([], new URL('https://api.example.test/'), 1)).toBe('')
    expect(cookieHeaderValue([cookie({ domain: 'other.test' })], new URL('https://api.example.test/'), 1)).toBe('')
    expect(cookieHeaderValue([cookie({ expiresAt: 1 })], new URL('https://api.example.test/'), 2)).toBe('')
  })

  test('Given cookie 总量很大 When 选值 Then 按路径优先截断以守住头部预算', () => {
    const jar = [
      cookie({ name: 'deep', path: '/app/orders', value: 'd'.repeat(4000) }),
      cookie({ name: 'root', path: '/', value: 'r'.repeat(4000) }),
      cookie({ name: 'root2', path: '/', value: 'q'.repeat(4000) }),
    ]

    const header = cookieHeaderValue(jar, new URL('https://api.example.test/app/orders'), 1)

    expect(header.startsWith('deep=d')).toBe(true)
    expect(header.includes('root=r')).toBe(true)
    expect(header.includes('root2=')).toBe(false)
    expect(header.length).toBeLessThanOrEqual(MAX_COOKIE_HEADER_CHARS)
  })

  test('Given 同名不同路径 When 生成存储键 Then 互不覆盖', () => {
    expect(cookieKey(cookie({ name: 'a', path: '/' }))).not.toBe(cookieKey(cookie({ name: 'a', path: '/app' })))
    expect(cookieKey(cookie({ name: 'a' }))).toBe(cookieKey(cookie({ name: 'a', domain: 'API.EXAMPLE.TEST' })))
  })
})
