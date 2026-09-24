import { describe, expect, test } from 'bun:test'
import type { ApiCatalog, ApiRequestDefinition } from './api-workbench'
import { API_LIMITS, createApiRequestDraft } from './api-workbench'
import {
  detectApiWorkbenchImportKind,
  createApiCatalogSnapshotExport,
  describeApiCatalogSnapshot,
  mergeApiCatalogSnapshot,
  parseApiCatalogSnapshot,
} from './api-workbench-sharing'

/** 构造一个最小可用请求定义，避免每个用例重复展开字段。 */
function request(id: string, collectionId: string, overrides: Partial<ApiRequestDefinition> = {}): ApiRequestDefinition {
  return { ...createApiRequestDraft(collectionId), id, revision: 1, updatedAt: 1, ...overrides }
}

/** 构造包含一个集合、一个环境和一个请求的完整目录。 */
function catalog(overrides: Partial<ApiCatalog> = {}): ApiCatalog {
  return {
    version: 1,
    revision: 3,
    collections: [{ id: 'default', name: '默认', description: '', variables: [] }],
    environments: [],
    requests: [request('req-1', 'default')],
    ...overrides,
  }
}

describe('集合快照导出', () => {
  test('Given 目录含秘密 When 导出快照 Then 秘密清空并列位置且普通值保留', () => {
    const source = catalog({
      environments: [{
        id: 'env-test',
        name: '测试',
        kind: 'test',
        variables: [
          { id: 'v1', name: 'apiKey', value: 'tok_live_123', enabled: true, secret: true },
          { id: 'v2', name: 'baseUrl', value: 'https://api.example.com', enabled: true },
        ],
      }],
      requests: [
        request('req-1', 'default', {
          name: '创建用户',
          headers: [
            { id: 'h1', name: 'Authorization', value: 'Bearer abc', enabled: true, secret: true },
            { id: 'h2', name: 'X-Trace', value: 'keep-me', enabled: true },
          ],
        }),
      ],
    })

    const exported = createApiCatalogSnapshotExport(source, 1_700_000_000_000)
    const snapshot = parseApiCatalogSnapshot(exported.text)
    const parsedRequest = snapshot.catalog.requests[0]!
    const secretHeader = parsedRequest.headers.find((header) => header.name === 'Authorization')!
    const plainHeader = parsedRequest.headers.find((header) => header.name === 'X-Trace')!

    expect(exported.text).not.toContain('Bearer abc')
    expect(exported.text).not.toContain('tok_live_123')
    expect(secretHeader.value).toBe('')
    expect(secretHeader.secret).toBe(true)
    expect(plainHeader.value).toBe('keep-me')
    expect(snapshot.catalog.environments[0]?.variables[0]?.value).toBe('')
    expect(snapshot.catalog.environments[0]?.variables[1]?.value).toBe('https://api.example.com')
    expect(exported.emptiedSecrets.join(' ')).toContain('Authorization')
    expect(exported.emptiedSecrets.join(' ')).toContain('apiKey')
  })

  test('Given 导出的快照文本 When 解析 Then 保留版本、时间与目录事实', () => {
    const exported = createApiCatalogSnapshotExport(catalog(), 1_700_000_000_123)
    const snapshot = parseApiCatalogSnapshot(exported.text)

    expect(snapshot.version).toBe(1)
    expect(snapshot.exportedAt).toBe(1_700_000_000_123)
    expect(snapshot.catalog.requests).toHaveLength(1)
    expect(snapshot.catalog.collections[0]?.name).toBe('默认')
  })

  test('Given 目录超过共享上限 When 导出 Then 拒绝而不是产出无法导入的文本', () => {
    const tooMany = catalog({
      requests: Array.from({ length: API_LIMITS.maxRequests + 1 }, (_, index) => request(`req-${index}`, 'default')),
    })

    expect(() => createApiCatalogSnapshotExport(tooMany, 1)).toThrow()
  })
})

describe('集合快照导入', () => {
  test('Given 非法 JSON 或错误版本 When 解析 Then 明确拒绝', () => {
    expect(() => parseApiCatalogSnapshot('这不是 JSON')).toThrow('API_IMPORT_INVALID')
    expect(() => parseApiCatalogSnapshot('[]')).toThrow('API_IMPORT_INVALID')
    expect(() => parseApiCatalogSnapshot(JSON.stringify({ kind: 'proma-api-catalog', version: 2, exportedAt: 1, catalog: catalog() }))).toThrow('API_IMPORT_INVALID')
    expect(() => parseApiCatalogSnapshot(JSON.stringify({ kind: 'other', version: 1, exportedAt: 1, catalog: catalog() }))).toThrow('API_IMPORT_INVALID')
  })

  test('Given 快照含未知字段 When 解析 Then 拒绝而不静默忽略', () => {
    const base = JSON.parse(createApiCatalogSnapshotExport(catalog(), 1).text) as Record<string, unknown>
    expect(() => parseApiCatalogSnapshot(JSON.stringify({ ...base, extra: true }))).toThrow('API_IMPORT_INVALID')

    const catalogWithExtra = JSON.parse(createApiCatalogSnapshotExport(catalog(), 1).text) as { catalog: { requests: Record<string, unknown>[] } }
    catalogWithExtra.catalog.requests[0]!.workspaceId = 'other'
    expect(() => parseApiCatalogSnapshot(JSON.stringify(catalogWithExtra))).toThrow('API_IMPORT_INVALID')
  })

  test('Given 快照文本超过目录大小上限 When 解析 Then 拒绝', () => {
    const oversized = 'x'.repeat(API_LIMITS.catalogBytes + 1)

    expect(() => parseApiCatalogSnapshot(oversized)).toThrow('API_IMPORT_INVALID')
  })

  test('Given 导入快照 When 合并 Then 全部新增且现有资产逐字不变', () => {
    const current = catalog()
    const incoming = parseApiCatalogSnapshot(createApiCatalogSnapshotExport(catalog({
      collections: [{ id: 'users', name: '用户服务', description: '', variables: [] }],
      requests: [request('users-req', 'users', { name: '创建用户' })],
    }), 1).text)

    const merged = mergeApiCatalogSnapshot(current, incoming)

    expect(merged.catalog.revision).toBe(current.revision)
    expect(merged.catalog.collections).toHaveLength(2)
    expect(merged.catalog.requests).toHaveLength(2)
    expect(merged.catalog.collections[0]).toEqual(current.collections[0]!)
    expect(merged.catalog.requests[0]).toEqual(current.requests[0]!)
    expect(merged.added).toEqual({ collections: 1, environments: 0, requests: 1 })
    expect(merged.emptiedSecrets).toEqual([])
  })

  test('Given 导入资产与现有 ID 相同 When 合并 Then 分配新 ID 并保留名称与引用关系', () => {
    const current = catalog()
    const incoming = parseApiCatalogSnapshot(createApiCatalogSnapshotExport(catalog(), 1).text)

    const merged = mergeApiCatalogSnapshot(current, incoming)
    const importedCollection = merged.catalog.collections[1]!
    const importedRequest = merged.catalog.requests[1]!

    expect(importedCollection.id).not.toBe('default')
    expect(importedCollection.name).toBe('默认')
    expect(importedRequest.id).not.toBe('req-1')
    expect(importedRequest.collectionId).toBe(importedCollection.id)
    expect(new Set(merged.catalog.requests.map((item) => item.id)).size).toBe(2)
  })

  test('Given 合并后超过请求条数上限 When 导入 Then 明确拒绝且不返回部分目录', () => {
    const current = catalog({
      requests: Array.from({ length: API_LIMITS.maxRequests }, (_, index) => request(`req-${index}`, 'default')),
    })
    const incoming = parseApiCatalogSnapshot(createApiCatalogSnapshotExport(catalog({
      requests: [request('extra-1', 'default')],
    }), 1).text)

    expect(() => mergeApiCatalogSnapshot(current, incoming)).toThrow('API_IMPORT_INVALID')
  })

  test('Given 导入后仍存在需要重填的秘密 When 合并 Then 逐条列出位置', () => {
    const incoming = parseApiCatalogSnapshot(createApiCatalogSnapshotExport(catalog({
      requests: [request('req-1', 'default', { headers: [{ id: 'h1', name: 'Authorization', value: 'Bearer abc', enabled: true, secret: true }] })],
    }), 1).text)

    const merged = mergeApiCatalogSnapshot(catalog(), incoming)

    expect(merged.emptiedSecrets.join(' ')).toContain('Authorization')
  })

  test('Given 快照含被清空的秘密 When 读取摘要 Then 返回计数与需要重填的位置', () => {
    const snapshot = parseApiCatalogSnapshot(createApiCatalogSnapshotExport(catalog({
      requests: [request('req-1', 'default', {
        headers: [{ id: 'h1', name: 'Authorization', value: 'Bearer abc', enabled: true, secret: true }],
      })],
    }), 1).text)

    const summary = describeApiCatalogSnapshot(snapshot)

    expect(summary.counts).toEqual({ collections: 1, environments: 0, requests: 1 })
    expect(summary.emptiedSecrets.join(' ')).toContain('Authorization')
  })
})

describe('导入内容识别', () => {
  test('Given 粘贴内容 When 识别 Then 区分快照 JSON 与 cURL 文本', () => {
    expect(detectApiWorkbenchImportKind(createApiCatalogSnapshotExport(catalog(), 1).text)).toBe('catalog')
    expect(detectApiWorkbenchImportKind("curl https://api.example.com/users -H 'X-A: 1'")).toBe('curl')
    expect(detectApiWorkbenchImportKind('  \n curl -X POST https://api.example.com/users')).toBe('curl')
    expect(detectApiWorkbenchImportKind('{ 不是合法 JSON')).toBe('curl')
  })
})
