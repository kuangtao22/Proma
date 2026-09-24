import { describe, expect, test } from 'bun:test'
import { API_LIMITS, parseApiResolvedRequest, type ApiResolvedRequest } from '@proma/shared'
import { redactApiBody, redactApiRequest } from './api-redaction'

/**
 * 创建只关注公开投影的固定请求。
 * @param url 待脱敏的完整 HTTP(S) URL。
 * @param body 待脱敏的请求正文。
 * @returns 可直接传给公开投影函数的已解析请求。
 */
function request(url: string, body = ''): ApiResolvedRequest {
  return {
    method: 'POST', url, headers: [], body, timeoutMs: 1_000,
    followRedirects: false, maxRedirects: 0,
    sensitiveHeaderNames: [], sensitiveQueryNames: [],
  }
}

describe('api redaction bounds', () => {
  test('Given 大正文重复单字符秘密，When 脱敏，Then 不产生数量级扩张', () => {
    /** 模拟可触发遮罩倍增的大正文。 */
    const body = 'a'.repeat(256 * 1024)

    /** 公开正文应在预算超限后降级为整段遮罩。 */
    const redacted = redactApiBody(body, ['a'])

    expect(redacted).toBe('[REDACTED]')
    expect(redacted.length).toBeLessThanOrEqual(body.length)
  })

  test('Given 后续秘密出现在遮罩标记中，When 脱敏，Then 不会再次破坏已生成遮罩', () => {
    expect(redactApiBody('credential', ['credential', 'A'])).toBe('[REDACTED]')
    expect(redactApiBody('abc', ['ab', 'abc'])).toBe('[REDACTED]')
  })

  test('Given 普通明文和 URL 编码秘密，When 脱敏，Then 保持既有输出格式', () => {
    expect(redactApiBody(
      'plain=secret encoded=s%2Fe lower=s%2fe form=a+b tilde=a%7Eb bang=a%21b',
      ['secret', 's/e', 'a b', 'a~b', 'a!b'],
    )).toBe(
      'plain=[REDACTED] encoded=%5BREDACTED%5D lower=%5BREDACTED%5D form=%5BREDACTED%5D tilde=%5BREDACTED%5D bang=%5BREDACTED%5D',
    )
    expect(redactApiBody('{"token":"returned","message":"secret"}', ['secret']))
      .toBe('{"token":"[REDACTED]","message":"[REDACTED]"}')
  })

  test('Given 短秘密命中敏感 JSON 键名，When 脱敏，Then 值先被整体遮罩且不泄漏', () => {
    /** 同时命中 token 键名的单字符秘密。 */
    const redacted = redactApiBody('{"token":"private-value"}', ['t'])

    expect(redacted).toBe('{"[REDACTED]oken":"[REDACTED]"}')
  })

  test('Given 单字符秘密也出现在 hostname，When 公开 URL，Then 保留真实目标且只遮罩 URL 内容', () => {
    /** 包含同字符 hostname 与路径/query 的公开请求。 */
    const redacted = redactApiRequest(request('https://api.example.test/path/aaaa?q=aaaa'), ['a'])
    /** 用标准 URL 解析器验证输出仍有效。 */
    const parsed = new URL(redacted.url)

    expect(parsed.origin).toBe('https://api.example.test')
    expect(redacted.url).not.toContain('/path/aaaa')
    expect(redacted.url.length).toBeLessThan(16 * 1024)
  })

  test('Given 秘密命中 URL 结构分隔符，When 公开 URL，Then origin、根路径与 Shared 合同保持有效', () => {
    for (const secret of ['/', '?', '#', '&', '=']) {
      /** 每轮覆盖一种不得移除的 URL 结构分隔符。 */
      const redacted = redactApiRequest(request('https://api.example.test/a/b?first=what?&second=value#frag#tail'), [secret])
      /** 标准解析器用于确认脱敏结果没有改变目标主机。 */
      const parsed = new URL(redacted.url)

      expect(parsed.origin).toBe('https://api.example.test')
      expect(redacted.url.startsWith('https://api.example.test/')).toBe(true)
      expect([...parsed.searchParams]).toHaveLength(2)
      expect(() => parseApiResolvedRequest(redacted)).not.toThrow()
    }
  })

  test('Given 已知秘密跨越路径分隔符，When 公开 URL，Then 整个秘密仍被遮罩', () => {
    /** 秘密文本与 URL pathname 一样跨越两个路径段。 */
    const redacted = redactApiRequest(request('https://api.example.test/abc/def?safe=ok'), ['abc/def'])

    expect(redacted.url).toBe('https://api.example.test/%5BREDACTED%5D?safe=ok')
  })

  test('Given URL 脱敏扩张超过公开上限，When 公开 URL，Then 后缀整段遮罩且仍可解析', () => {
    /** 原始 URL 合法但逐字符遮罩会远超 IPC 字符串上限。 */
    const input = request(`https://example.test/${'a'.repeat(8_000)}`)
    /** 超限后应保留 origin 并将整个后缀降级为固定遮罩。 */
    const redacted = redactApiRequest(input, ['a'])

    expect(redacted.url).toBe('https://example.test/%5BREDACTED%5D')
    expect(redacted.url.length).toBeLessThanOrEqual(8_192)
    expect(() => parseApiResolvedRequest(redacted)).not.toThrow()
  })

  test('Given 正文与 Header 接近 Shared 上限，When 短秘密造成扩张，Then 公开请求仍满足解析合同', () => {
    /** 256 KiB 正文对应公开 run 的 preview 上限。 */
    const input = request('https://example.test', 'a'.repeat(API_LIMITS.previewBytes))
    input.headers = [{ name: 'X-Data', value: 'a'.repeat(65_536) }]

    /** 正文与 Header 超预算后均应采用固定遮罩。 */
    const redacted = redactApiRequest(input, ['a'])

    expect(redacted.body).toBe('[REDACTED]')
    expect(redacted.headers[0]?.value).toBe('[REDACTED]')
    expect(() => parseApiResolvedRequest(redacted)).not.toThrow()
  })

  test('Given 2 MiB 完整响应正文，When 无秘密或等长局部秘密，Then 保留可分页原文且不发生净增长', () => {
    /** 模拟 Store.readBody 可读取的超出请求上限的完整响应正文。 */
    const body = `${'x'.repeat(1024 * 1024)}long-secret${'y'.repeat(1024 * 1024)}`

    expect(redactApiBody(body)).toBe(body)
    /** 等长遮罩只替换局部秘密，其余正文仍可供分页读取。 */
    const redacted = redactApiBody(body, ['long-secret'])
    expect(redacted).toContain('[REDACTED]')
    expect(redacted.startsWith('x'.repeat(1024))).toBe(true)
    expect(redacted.endsWith('y'.repeat(1024))).toBe(true)
    expect(redacted.length).toBeLessThanOrEqual(body.length)
  })

  test('Given 敏感 query 有重复值，When 公开 URL，Then URL 仍有效且全部值保持标准遮罩', () => {
    /** 包含重复敏感 query 的待公开请求。 */
    const input = request('https://example.test/items?token=one&safe=ok&token=two')
    input.sensitiveQueryNames = ['token']

    /** 同时使用会命中遮罩文本的短秘密验证标记保护。 */
    const redacted = redactApiRequest(input, ['A'])
    /** 用标准 URL 解析器读取脱敏后的 query。 */
    const parsed = new URL(redacted.url)

    expect([...parsed.searchParams.entries()]).toEqual([
      ['token', '[REDACTED]'],
      ['safe', 'ok'],
      ['token', '[REDACTED]'],
    ])
  })
})
