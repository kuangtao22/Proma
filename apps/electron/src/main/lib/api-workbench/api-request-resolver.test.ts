import { describe, expect, test } from 'bun:test'
import type { ApiCatalog, ApiRequestDraft } from '@proma/shared'
import { resolveApiCryptoSecrets, resolveApiRequest } from './api-request-resolver'

const catalog: ApiCatalog = {
  version: 1,
  revision: 3,
  collections: [{
    id: 'collection',
    name: '默认',
    description: '',
    variables: [{ id: 'base', name: 'base', value: 'https://example.test', enabled: true }],
  }],
  environments: [{
    id: 'test',
    name: '测试',
    kind: 'test',
    variables: [
      { id: 'path', name: 'path', value: 'a/b c', enabled: true },
      { id: 'token', name: 'token', value: '', secret: true, secretRef: 'secret_token', enabled: true },
      { id: 'big', name: 'big', value: '900719925474099312345', enabled: true },
    ],
  }],
  requests: [],
}

function draft(): ApiRequestDraft {
  return {
    name: '查询', collectionId: 'collection', folder: '', description: '', method: 'POST',
    url: '{{base}}/users/{{path}}',
    query: [{ id: 'q', name: 'q', value: '{{path}}', enabled: true }],
    headers: [{ id: 'h', name: 'X-Token', value: '{{token}}', enabled: true, secret: true }],
    body: { kind: 'json', text: '{"id":{{big}},"label":"{{path}}"}', fields: [] },
    auth: { type: 'bearer', value: { value: '{{token}}' } },
    timeoutMs: 30_000, followRedirects: false, maxRedirects: 0, assertions: [],
  }
}

describe('接口请求解析', () => {
  test('Given 运行时变量 When 解析 Then 覆盖环境变量但不覆盖显式单次覆盖', () => {
    const withRuntime = resolveApiRequest({
      catalog,
      request: draft(),
      environmentId: 'test',
      runtimeVariables: [{ id: 'rt', name: 'path', value: 'runtime/value', enabled: true }],
      resolveSecret: ({ ref }) => ref === 'secret_token' ? { value: 's3cret', revision: 'v1' } : undefined,
    })
    const overridden = resolveApiRequest({
      catalog,
      request: draft(),
      environmentId: 'test',
      runtimeVariables: [{ id: 'rt', name: 'path', value: 'runtime/value', enabled: true }],
      overrides: [{ id: 'ov', name: 'path', value: 'override/value', enabled: true }],
      resolveSecret: ({ ref }) => ref === 'secret_token' ? { value: 's3cret', revision: 'v1' } : undefined,
    })

    expect(withRuntime.request.url).toBe('https://example.test/users/runtime%2Fvalue?q=runtime%2Fvalue')
    expect(overridden.request.url).toBe('https://example.test/users/override%2Fvalue?q=override%2Fvalue')
  })

  test('Given 运行时秘密变量 When 解析 Then 供模板使用且被标记为敏感', () => {
    const result = resolveApiRequest({
      catalog,
      request: { ...draft(), headers: [{ id: 'h', name: 'Authorization', value: 'Bearer {{fresh}}', enabled: true }] },
      environmentId: 'test',
      runtimeVariables: [{ id: 'rt', name: 'fresh', value: 'tok_live_9', enabled: true, secret: true }],
      resolveSecret: ({ ref }) => ref === 'secret_token' ? { value: 's3cret', revision: 'v1' } : undefined,
    })

    expect(result.request.headers.find((header) => header.source === 'user')?.value).toBe('Bearer tok_live_9')
    expect(result.request.sensitiveHeaderNames).toContain('authorization')
    expect(result.secretValues).toContain('tok_live_9')
  })

  test('Given collection/environment/override When 解析 Then 按优先级和字段语义编码且保留 JSON 大整数原文', () => {
    const result = resolveApiRequest({
      catalog,
      request: draft(),
      environmentId: 'test',
      overrides: [{ id: 'override', name: 'path', value: 'override/value', enabled: true }],
      resolveSecret: ({ ref }) => ref === 'secret_token' ? { value: 's3cret', revision: 'v1' } : undefined,
    })

    expect(result.request.url).toBe('https://example.test/users/override%2Fvalue?q=override%2Fvalue')
    expect(result.request.body).toBe('{"id":900719925474099312345,"label":"override/value"}')
    expect(result.request.headers).toEqual([
      { name: 'X-Token', value: 's3cret', source: 'user' },
      { name: 'Authorization', value: 'Bearer s3cret', source: 'generated' },
      { name: 'Content-Type', value: 'application/json', source: 'generated' },
    ])
    expect(result.secretValues).toContain('s3cret')
    expect(result.request.sensitiveHeaderNames).toContain('x-token')
  })

  test('Given 秘密变量进入未标记的自定义 query When 解析 Then taint 传播为敏感字段', () => {
    const request = draft()
    request.query = [{ id: 'custom', name: 'custom', value: '{{token}}', enabled: true }]
    const result = resolveApiRequest({
      catalog,
      request,
      environmentId: 'test',
      resolveSecret: ({ ref }) => ref === 'secret_token' ? { value: 's3cret', revision: 'v1' } : undefined,
    })
    expect(result.request.sensitiveQueryNames).toContain('custom')
  })

  test('Given URL 内嵌 userinfo When 解析 Then 拒绝并引导使用 Auth', () => {
    expect(() => resolveApiRequest({
      catalog,
      request: { ...draft(), url: 'https://user:password@example.test' },
      environmentId: 'test',
      resolveSecret: ({ ref }) => ref === 'secret_token' ? { value: 's3cret', revision: 'v1' } : undefined,
    })).toThrow('API_WORKBENCH_URL_CREDENTIALS_FORBIDDEN')
  })

  test('Given 未解析变量或跨 owner 秘密 When 解析 Then 发送前拒绝', () => {
    expect(() => resolveApiRequest({ catalog, request: { ...draft(), url: '{{missing}}' }, environmentId: 'test', resolveSecret: () => undefined }))
      .toThrow('API_WORKBENCH_VARIABLE_UNRESOLVED')
    expect(() => resolveApiRequest({ catalog, request: draft(), environmentId: 'test', resolveSecret: () => undefined }))
      .toThrow('API_WORKBENCH_SECRET_NOT_FOUND')
  })
})

test('Given 多字节变量重复展开 When 准备请求 Then 在形成巨大字符串前按字节预算拒绝', () => {
  const request = { ...draft(), url: 'https://example.test', headers: [], query: [], auth: { type: 'none' as const, value: { value: '' } }, body: { kind: 'text' as const, text: '{{large}}'.repeat(10000), fields: [] } }
  expect(() => resolveApiRequest({ catalog, request, overrides: [{ id: 'large', name: 'large', value: '汉'.repeat(120000), enabled: true }], resolveSecret: () => undefined })).toThrow('REQUEST_TOO_LARGE')
})

describe('自动 Cookie 注入', () => {
  /** 该 host 的一条会话 cookie。 */
  const jar = [{ name: 'sid', domain: 'example.test', path: '/', secure: false, httpOnly: true, expiresAt: null, updatedAt: 1, value: 'jar-value-1' }]
  /** 只带 URL 的最小请求：清掉默认草稿里的模板与秘密，避免与被测行为耦合。 */
  const plain: ApiRequestDraft = {
    ...draft(), url: 'https://example.test/users', headers: [], query: [],
    body: { kind: 'none', text: '', fields: [] }, auth: { type: 'none', value: { value: '' } },
  }

  test('Given 未开启自动 Cookie When 解析 Then 即使传入 jar 也不注入', () => {
    const result = resolveApiRequest({ catalog, request: plain, cookieJar: jar, resolveSecret: () => undefined })

    expect(result.request.headers.some((header) => header.name.toLowerCase() === 'cookie')).toBe(false)
    expect(result.request.sensitiveHeaderNames).not.toContain('cookie')
  })

  test('Given 开启自动 Cookie When 解析 Then 合成敏感 Cookie 头且不进入秘密取值集合', () => {
    const result = resolveApiRequest({ catalog, request: { ...plain, useCookieJar: true }, cookieJar: jar, now: 10, resolveSecret: () => undefined })

    expect(result.request.headers).toContainEqual({ name: 'Cookie', value: 'sid=jar-value-1', source: 'generated' })
    /** 记录与预览按敏感头规则遮罩，不需要额外把取值加进秘密集合。 */
    expect(result.request.sensitiveHeaderNames).toContain('cookie')
    expect(result.secretValues).not.toContain('jar-value-1')
  })

  test('Given 草稿已写 Cookie 头 When 开启自动 Cookie Then 以人的写法为准且不叠加', () => {
    const result = resolveApiRequest({
      catalog,
      request: { ...plain, useCookieJar: true, headers: [{ id: 'h', name: 'Cookie', value: 'manual=1', enabled: true }] },
      cookieJar: jar,
      now: 10,
      resolveSecret: () => undefined,
    })
    const cookies = result.request.headers.filter((header) => header.name.toLowerCase() === 'cookie')

    expect(cookies).toEqual([{ name: 'Cookie', value: 'manual=1', source: 'user' }])
  })

  test('Given 作用域或过期不匹配 When 开启自动 Cookie Then 不注入空头', () => {
    const otherHost = resolveApiRequest({ catalog, request: { ...plain, useCookieJar: true }, cookieJar: [{ ...jar[0]!, domain: 'other.test' }], now: 10, resolveSecret: () => undefined })
    const expired = resolveApiRequest({ catalog, request: { ...plain, useCookieJar: true }, cookieJar: [{ ...jar[0]!, expiresAt: 5 }], now: 10, resolveSecret: () => undefined })

    expect(otherHost.request.headers.some((header) => header.name.toLowerCase() === 'cookie')).toBe(false)
    expect(expired.request.headers.some((header) => header.name.toLowerCase() === 'cookie')).toBe(false)
  })

  test('Given 模板变量拼出的最终 URL When 选 cookie Then 按插值后的 host 判定', () => {
    const result = resolveApiRequest({
      catalog,
      request: { ...plain, url: 'https://{{host}}/users', useCookieJar: true },
      overrides: [{ id: 'o', name: 'host', value: 'example.test', enabled: true }],
      cookieJar: jar,
      now: 10,
      resolveSecret: () => undefined,
    })

    expect(result.request.url).toBe('https://example.test/users')
    expect(result.request.headers.some((header) => header.name.toLowerCase() === 'cookie')).toBe(true)
  })
})

describe('工作区变量与加密密钥解析', () => {
  /** 分层目录：工作区定义 base/shared，集合再用同名变量覆盖，环境只有 path。 */
  const layered: ApiCatalog = {
    ...catalog,
    workspaceVariables: [
      { id: 'w_only', name: 'onlyWorkspace', value: 'w-value', enabled: true },
      { id: 'w_shared', name: 'shared', value: 'from-workspace', enabled: true },
    ],
    collections: [{
      ...catalog.collections[0]!,
      variables: [...catalog.collections[0]!.variables, { id: 'c_shared', name: 'shared', value: 'from-collection', enabled: true }],
    }],
  }

  test('Given 工作区变量 When 解析 Then 参与模板且让位于集合与环境', () => {
    const result = resolveApiRequest({
      catalog: layered,
      request: { ...draft(), url: '{{base}}/{{onlyWorkspace}}/{{shared}}' },
      /** 夹具草稿的 query/body 引用环境里的 path，带上环境才是完整解析。 */
      environmentId: 'test',
      /** 夹具草稿的 Auth 用 {{token}}，秘密解析要给非空值，否则会按「鉴权为空」拒绝。 */
      resolveSecret: () => ({ value: 'fixture-token', revision: '1' }),
    })
    /** base 由集合提供（工作区没有同名变量），shared 两边都有时集合胜出。 */
    const resolvedUrl = new URL(result.request.url)
    expect(resolvedUrl.host).toBe('example.test')
    expect(resolvedUrl.pathname).toBe('/w-value/from-collection')
  })

  test('Given 只点名部分密钥 When 解析加密密钥 Then 只返回被点名的变量', () => {
    const secrets = resolveApiCryptoSecrets({
      catalog: layered,
      collectionId: 'collection',
      environmentId: 'test',
      names: ['onlyWorkspace', 'shared', '不存在的密钥'],
      /** 夹具环境里的 token 是秘密字段：解析密钥的用例只需要它不抛错。 */
      resolveSecret: () => ({ value: '', revision: '1' }),
    })
    /** 没被点名的变量（如环境里的 path）根本不会出现在结果里。 */
    expect(secrets).toEqual({ onlyWorkspace: 'w-value', shared: 'from-collection' })
  })

  test('Given 未登记同名变量 When 解析加密密钥 Then 该名字缺席而不是空串', () => {
    const secrets = resolveApiCryptoSecrets({
      catalog: layered,
      collectionId: 'collection',
      names: ['neverDeclared'],
      /** 夹具环境里的 token 是秘密字段：解析密钥的用例只需要它不抛错。 */
      resolveSecret: () => ({ value: '', revision: '1' }),
    })
    expect('neverDeclared' in secrets).toBe(false)
  })
})
