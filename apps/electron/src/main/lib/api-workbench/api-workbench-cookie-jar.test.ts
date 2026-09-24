import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ApiResolvedRequest, ApiTransportResult } from '@proma/shared'
import { createApiRequestDraft } from '@proma/shared'
import { ApiWorkbenchService } from './api-workbench-service'
import { ApiWorkbenchStore } from './api-workbench-store'

const context = { workspaceId: 'workspace', sessionId: 'session', source: 'manual' as const }

/** 构造一次带指定 Set-Cookie 的完整响应。 */
function response(url: string, setCookies: string[]): ApiTransportResult {
  return {
    state: 'completed',
    hops: [{
      url, method: 'GET', requestHeaders: [], requestHeadersSource: 'captured', status: 200, statusText: 'OK', httpVersion: '1.1',
      responseHeaders: setCookies.map((value) => ({ name: 'Set-Cookie', value })), trailers: [],
      timings: { dnsMs: null, connectMs: null, tlsMs: null, sendMs: null, ttfbMs: null, downloadMs: null, totalMs: 1 },
      connection: { reused: false },
    }],
    body: { rawBytes: 2, decodedBytes: 2, contentType: 'text/plain', encoding: 'utf-8', preview: 'ok', previewTruncated: false, complete: true, decoded: true },
  }
}

/** 单个服务实例 + 可替换的响应脚本，便于同一实例内连续运行。 */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'api-cookie-'))
  const seen: ApiResolvedRequest[] = []
  /** 默认不带 cookie；每个用例用 setResponse 覆盖。 */
  let respond = (request: ApiResolvedRequest): ApiTransportResult => response(request.url, [])
  const service = new ApiWorkbenchService({
    store: new ApiWorkbenchStore(root),
    transport: async (request) => { seen.push(request); return respond(request) },
  })
  return {
    root, service, seen,
    setResponse: (next: (request: ApiResolvedRequest) => ApiTransportResult): void => { respond = next },
    cleanup: (): void => rmSync(root, { recursive: true, force: true }),
  }
}

/** 开启自动 Cookie 的请求草稿。 */
function jarDraft(url: string) {
  return { ...createApiRequestDraft(), url, useCookieJar: true }
}

describe('接口工作台 Cookie Jar', () => {
  test('Given 登录响应带 Set-Cookie When 后续请求开启自动 Cookie Then 带上 cookie 且记录里看不到取值', async () => {
    const f = fixture()
    try {
      f.setResponse((request) => response(request.url, ['sid=cookie-value-1; Path=/; HttpOnly']))
      const login = await f.service.prepare(context, { request: jarDraft('https://api.example.test/login') })
      await f.service.send(context, login.preparedId)

      const stored = f.service.getCookieJar('workspace')
      /** 只回元数据：取值永不出主进程。 */
      expect(stored).toEqual([{ name: 'sid', domain: 'api.example.test', path: '/', secure: false, httpOnly: true, expiresAt: null, updatedAt: expect.any(Number) }])
      expect(JSON.stringify(stored)).not.toContain('cookie-value-1')

      const follow = await f.service.prepare(context, { request: jarDraft('https://api.example.test/me') })
      const run = await f.service.send(context, follow.preparedId)

      expect(f.seen.at(-1)?.headers).toContainEqual({ name: 'Cookie', value: 'sid=cookie-value-1', source: 'generated' })
      /** 运行记录与预览按敏感头遮罩，取值不出现。 */
      expect(run.request.sensitiveHeaderNames).toContain('cookie')
      expect(run.request.headers.find((header) => header.name === 'Cookie')?.value).toBe('[REDACTED]')
      expect(JSON.stringify(run)).not.toContain('cookie-value-1')
    } finally { f.cleanup() }
  })

  test('Given 未开启自动 Cookie When 响应带 Set-Cookie Then 既不写入也不回送', async () => {
    const f = fixture()
    try {
      f.setResponse((request) => response(request.url, ['sid=ignored-1; Path=/']))
      const plain = { ...createApiRequestDraft(), url: 'https://api.example.test/login' }
      const prepared = await f.service.prepare(context, { request: plain })
      await f.service.send(context, prepared.preparedId)

      expect(f.service.getCookieJar('workspace')).toEqual([])
      const follow = await f.service.prepare(context, { request: { ...plain, url: 'https://api.example.test/me' } })
      await f.service.send(context, follow.preparedId)
      expect(f.seen.at(-1)?.headers.some((header) => header.name === 'Cookie')).toBe(false)
    } finally { f.cleanup() }
  })

  test('Given 同一实例连续运行 When 服务端删除指定 cookie Then 只删该条', async () => {
    const f = fixture()
    try {
      f.setResponse((request) => response(request.url, request.url.endsWith('/logout')
        ? ['sid=; Max-Age=0; Path=/']
        : ['sid=a; Path=/', 'theme=dark']))
      const first = await f.service.prepare(context, { request: jarDraft('https://api.example.test/login') })
      await f.service.send(context, first.preparedId)
      expect(f.service.getCookieJar('workspace').map((cookie) => cookie.name).sort()).toEqual(['sid', 'theme'])

      const logout = await f.service.prepare(context, { request: jarDraft('https://api.example.test/logout') })
      await f.service.send(context, logout.preparedId)

      expect(f.service.getCookieJar('workspace').map((cookie) => cookie.name)).toEqual(['theme'])
    } finally { f.cleanup() }
  })

  test('Given 跨 workspace 与跨 host When 开启自动 Cookie Then 互不可见', async () => {
    const f = fixture()
    try {
      f.setResponse((request) => response(request.url, ['sid=a; Path=/']))
      const prepared = await f.service.prepare(context, { request: jarDraft('https://a.example.test/login') })
      await f.service.send(context, prepared.preparedId)

      /** 另一个 host 不共享 cookie，也不会因此产生空 Cookie 头。 */
      const otherHost = await f.service.prepare(context, { request: jarDraft('https://b.example.test/me') })
      await f.service.send(context, otherHost.preparedId)
      expect(f.seen.at(-1)?.headers.some((header) => header.name === 'Cookie')).toBe(false)
      /** 每个 host 各自记账，互不当作对方的凭据。 */
      expect(f.service.getCookieJar('workspace').map((cookie) => cookie.domain).sort()).toEqual(['a.example.test', 'b.example.test'])
      expect(f.service.getCookieJar('other')).toEqual([])
    } finally { f.cleanup() }
  })

  test('Given 清空与关闭服务 When 读取 cookie Then 一律为空', async () => {
    const f = fixture()
    try {
      f.setResponse((request) => response(request.url, ['sid=a; Path=/', 'theme=dark']))
      const prepared = await f.service.prepare(context, { request: jarDraft('https://api.example.test/login') })
      await f.service.send(context, prepared.preparedId)

      expect(f.service.clearCookieJar('workspace')).toBe(2)
      expect(f.service.getCookieJar('workspace')).toEqual([])

      const again = await f.service.prepare(context, { request: jarDraft('https://api.example.test/login') })
      await f.service.send(context, again.preparedId)
      expect(f.service.getCookieJar('workspace')).toHaveLength(2)
      await f.service.shutdown()
      /** 只活在主进程内存：关闭服务即清空，重启不残留。 */
      expect(f.service.getCookieJar('workspace')).toEqual([])
    } finally { f.cleanup() }
  })

  test('Given 过期、畸形与超量 Set-Cookie When 采集 Then 过期与坏值丢弃且条目守上限', async () => {
    const f = fixture()
    try {
      const many = Array.from({ length: 200 }, (_value, index) => `c${index}=v${index}; Path=/`)
      f.setResponse((request) => response(request.url, [...many, 'old=a; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT', 'broken']))
      const prepared = await f.service.prepare(context, { request: jarDraft('https://api.example.test/login') })
      await f.service.send(context, prepared.preparedId)

      const stored = f.service.getCookieJar('workspace')
      expect(stored.length).toBe(128)
      expect(stored.some((cookie) => cookie.name === 'old' || cookie.name === 'broken')).toBe(false)
    } finally { f.cleanup() }
  })

  test('Given 新实例 When 读取 cookie Then 只能看到自己内存里的内容', async () => {
    const f = fixture()
    try {
      f.setResponse((request) => response(request.url, ['sid=a; Path=/']))
      const prepared = await f.service.prepare(context, { request: jarDraft('https://api.example.test/login') })
      await f.service.send(context, prepared.preparedId)
      expect(f.service.getCookieJar('workspace')).toHaveLength(1)

      /** 不落盘：换一个实例读同一个数据根也拿不到任何 cookie。 */
      const reopened = new ApiWorkbenchService({ store: new ApiWorkbenchStore(f.root), transport: async () => response('https://api.example.test/', []) })
      expect(reopened.getCookieJar('workspace')).toEqual([])
    } finally { f.cleanup() }
  })
})
