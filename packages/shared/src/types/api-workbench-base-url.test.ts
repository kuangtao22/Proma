import { describe, expect, test } from 'bun:test'
import { createApiRequestDraft } from './api-workbench'
import { extractApiBaseUrlVariable } from './api-workbench-base-url'
import type { ApiCatalog, ApiRequestDefinition } from './api-workbench'

/** 构造只关心名字与 URL 的请求定义。 */
function request(id: string, name: string, url: string, collectionId = 'default'): ApiRequestDefinition {
  return { ...createApiRequestDraft(collectionId), id, revision: 1, updatedAt: 1, name, url, method: 'POST' }
}

/** 构造一个集合 + 若干请求的目录。 */
function catalog(requests: ApiRequestDefinition[], variables: ApiCatalog['collections'][number]['variables'] = []): ApiCatalog {
  return {
    version: 1, revision: 1,
    collections: [{ id: 'default', name: '默认', description: '', variables }],
    environments: [],
    requests,
  }
}

describe('把硬编码主机抽成集合变量', () => {
  test('Given 多条请求写死同一个主机 When 抽取 Then 换成 {{baseUrl}} 并声明变量', () => {
    const source = catalog([
      request('request_a', '管理员登录', 'http://127.0.0.1:18080/admin/v1/auth/login'),
      request('request_b', '管理员列表', 'http://127.0.0.1:18080/admin/v1/admin-accounts/query?page=1'),
      request('request_c', '其它服务', 'https://api.example.test/open/v1/ping'),
    ])

    const result = extractApiBaseUrlVariable(source, 'default')

    expect(result.variableName).toBe('baseUrl')
    expect(result.origin).toBe('http://127.0.0.1:18080')
    expect(result.updated).toBe(2)
    expect(result.catalog.collections[0]?.variables).toEqual([{ id: 'var_baseUrl', name: 'baseUrl', value: 'http://127.0.0.1:18080', enabled: true }])
    expect(result.catalog.requests.map((item) => item.url)).toEqual([
      '{{baseUrl}}/admin/v1/auth/login',
      '{{baseUrl}}/admin/v1/admin-accounts/query?page=1',
      'https://api.example.test/open/v1/ping',
    ])
  })

  test('Given 集合里已有同名变量且值一致 When 抽取 Then 复用变量不重复声明', () => {
    const source = catalog(
      [request('request_a', '管理员登录', 'http://127.0.0.1:18080/admin/v1/auth/login')],
      [{ id: 'var_baseUrl', name: 'baseUrl', value: 'http://127.0.0.1:18080', enabled: true }],
    )

    const result = extractApiBaseUrlVariable(source, 'default')

    expect(result.catalog.collections[0]?.variables).toHaveLength(1)
    expect(result.catalog.requests[0]?.url).toBe('{{baseUrl}}/admin/v1/auth/login')
  })

  test('Given 同名变量是别的主机 When 抽取 Then 拒绝改写并说明原因', () => {
    const source = catalog(
      [request('request_a', '管理员登录', 'http://127.0.0.1:18080/admin/v1/auth/login')],
      [{ id: 'var_baseUrl', name: 'baseUrl', value: 'https://prod.example.test', enabled: true }],
    )

    const result = extractApiBaseUrlVariable(source, 'default')

    expect(result.updated).toBe(0)
    expect(result.variableName).toBeUndefined()
    expect(result.message).toContain('与要抽取的 http://127.0.0.1:18080 不一致')
    expect(result.catalog.requests[0]?.url).toBe('http://127.0.0.1:18080/admin/v1/auth/login')
  })

  test('Given 已经是变量或没有硬编码主机 When 抽取 Then 原样返回并说明', () => {
    const already = catalog([request('request_a', '管理员登录', '{{baseUrl}}/admin/v1/auth/login')])
    expect(extractApiBaseUrlVariable(already, 'default').updated).toBe(0)
    expect(extractApiBaseUrlVariable(already, 'default').message).toBe('这个集合里没有硬编码主机的请求')

    const other = catalog([request('request_a', '别的服务', 'https://api.example.test/ping')], [{ id: 'var_x', name: 'x', value: '1', enabled: true }])
    const result = extractApiBaseUrlVariable(other, 'default', { variableName: 'baseUrl' })
    expect(result.updated).toBe(1)
    expect(result.catalog.requests[0]?.url).toBe('{{baseUrl}}/ping')
  })

  test('Given 指定环境 When 抽取 Then 变量写进环境并把这些请求绑定到该环境', () => {
    const source: ApiCatalog = {
      ...catalog([
        request('request_a', '管理员登录', 'http://127.0.0.1:18080/admin/v1/auth/login'),
        request('request_b', '管理员列表', 'http://127.0.0.1:18080/admin/v1/admin-accounts/query'),
      ]),
      environments: [{ id: 'env_test', name: '测试环境', kind: 'test', variables: [] }],
    }

    const result = extractApiBaseUrlVariable(source, 'default', { environmentId: 'env_test' })

    expect(result.target).toBe('environment')
    expect(result.environmentName).toBe('测试环境')
    expect(result.updated).toBe(2)
    /** 变量落在环境里，集合变量保持为空；请求同时被绑定到该环境。 */
    expect(result.catalog.collections[0]?.variables).toEqual([])
    expect(result.catalog.environments[0]?.variables).toEqual([{ id: 'var_baseUrl', name: 'baseUrl', value: 'http://127.0.0.1:18080', enabled: true }])
    expect(result.catalog.requests.map((item) => `${item.url}|${item.targetEnvironmentId}`)).toEqual([
      '{{baseUrl}}/admin/v1/auth/login|env_test',
      '{{baseUrl}}/admin/v1/admin-accounts/query|env_test',
    ])
  })

  test('Given 目标环境不存在或环境里同名变量值不同 When 抽取 Then 拒绝且不改目录', () => {
    const source: ApiCatalog = {
      ...catalog([request('request_a', '管理员登录', 'http://127.0.0.1:18080/admin/v1/auth/login')]),
      environments: [{ id: 'env_test', name: '测试环境', kind: 'test', variables: [{ id: 'var_baseUrl', name: 'baseUrl', value: 'https://prod.example.test', enabled: true }] }],
    }

    const missing = extractApiBaseUrlVariable(source, 'default', { environmentId: 'env_missing' })
    expect(missing.updated).toBe(0)
    expect(missing.message).toBe('目标环境不存在')

    const conflict = extractApiBaseUrlVariable(source, 'default', { environmentId: 'env_test' })
    expect(conflict.updated).toBe(0)
    expect(conflict.message).toContain('环境「测试环境」里已有变量 baseUrl=https://prod.example.test')
    expect(conflict.catalog.requests[0]?.url).toBe('http://127.0.0.1:18080/admin/v1/auth/login')
  })

  test('Given 主机大小写不同 When 抽取 Then 视为同一主机并只替换前缀', () => {
    const source = catalog([
      request('request_a', 'A', 'HTTP://127.0.0.1:18080/a'),
      request('request_b', 'B', 'http://127.0.0.1:18080/b'),
    ])

    const result = extractApiBaseUrlVariable(source, 'default')

    expect(result.updated).toBe(2)
    expect(result.catalog.requests.map((item) => item.url)).toEqual(['{{baseUrl}}/a', '{{baseUrl}}/b'])
  })
})
