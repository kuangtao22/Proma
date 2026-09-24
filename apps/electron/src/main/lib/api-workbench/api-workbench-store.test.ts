import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ApiCatalog, ApiRun } from '@proma/shared'
import { ApiWorkbenchStore } from './api-workbench-store'

const safeStorage = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => 'unknown' as const,
  encryptString: (value: string) => Buffer.from(value, 'utf8'),
  decryptString: (value: Buffer) => value.toString('utf8'),
}

function catalog(secret = 'alpha'): ApiCatalog {
  return {
    version: 1, revision: 0,
    collections: [{ id: 'default', name: '默认', description: '', variables: [] }], environments: [],
    requests: [{
      id: 'request', revision: 1, updatedAt: 0, name: '请求', collectionId: 'default', folder: '', description: '',
      method: 'GET', url: 'https://example.test', query: [],
      headers: [{ id: 'secret-header', name: 'X-Key', value: secret, secret: true, enabled: true }],
      body: { kind: 'none', text: '', fields: [] }, auth: { type: 'none', value: { value: '' } },
      timeoutMs: 30_000, followRedirects: false, maxRedirects: 0, assertions: [],
    }],
  }
}

describe('接口工作台 Store', () => {
  test('Given 新目录 When 保存秘密 catalog Then 原子提交 revision 且公开结果不含明文', () => {
    const root = mkdtempSync(join(tmpdir(), 'api-store-'))
    try {
      const store = new ApiWorkbenchStore(root, { safeStorage, now: () => 10, uuid: () => 'secret_ref' })
      const saved = store.saveCatalog('workspace', 0, catalog())
      expect(saved.revision).toBe(1)
      expect(saved.requests[0]?.headers[0]).toMatchObject({ value: '', secretRef: 'secret_ref' })
      expect(store.resolveSecret('workspace', 'secret_ref', 'request:request:header:secret-header')).toEqual({ value: 'alpha', revision: '1' })
      expect(() => store.resolveSecret('other', 'secret_ref', 'request:request:header:secret-header')).toThrow('API_WORKBENCH_SECRET_NOT_FOUND')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test('Given 两个调用方持有同一 revision When 依次保存 Then 后者冲突且不覆盖前者', () => {
    const root = mkdtempSync(join(tmpdir(), 'api-store-'))
    try {
      const storeA = new ApiWorkbenchStore(root, { safeStorage, uuid: () => 'secret_a' })
      const storeB = new ApiWorkbenchStore(root, { safeStorage, uuid: () => 'secret_b' })
      storeA.saveCatalog('workspace', 0, catalog('one'))
      expect(() => storeB.saveCatalog('workspace', 0, catalog('two'))).toThrow('API_WORKBENCH_REVISION_CONFLICT')
      expect(storeA.resolveSecret('workspace', 'secret_a', 'request:request:header:secret-header')?.value).toBe('one')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test('Given 未显式标 secret 的 Authorization When 保存 Then 仍自动秘密化', () => {
    const root = mkdtempSync(join(tmpdir(), 'api-store-'))
    try {
      const store = new ApiWorkbenchStore(root, { safeStorage, uuid: () => 'authorization_ref' })
      const input = catalog()
      input.requests[0]!.headers[0] = { id: 'authorization', name: 'Authorization', value: 'Bearer alpha', enabled: true }
      const saved = store.saveCatalog('workspace', 0, input)
      expect(saved.requests[0]?.headers[0]).toMatchObject({ value: '', secret: true, secretRef: 'authorization_ref' })
      expect(store.resolveSecret('workspace', 'authorization_ref', 'request:request:header:authorization')?.value).toBe('Bearer alpha')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test('Given 系统安全存储不可用 When 保存含秘密目录 Then 整体失败且 catalog 不提交', () => {
    const root = mkdtempSync(join(tmpdir(), 'api-store-'))
    try {
      const store = new ApiWorkbenchStore(root)
      expect(() => store.saveCatalog('workspace', 0, catalog('alpha'))).toThrow('API_WORKBENCH_SECURE_STORAGE_UNAVAILABLE')
      expect(store.getCatalog('workspace').revision).toBe(0)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test('Given catalog 文件损坏 When 读取 Then fail closed 而不是覆盖为空目录', () => {
    const root = mkdtempSync(join(tmpdir(), 'api-store-'))
    try {
      const store = new ApiWorkbenchStore(root, { safeStorage })
      store.saveCatalog('workspace', 0, catalog())
      writeFileSync(join(root, 'api-workbench', 'workspaces', 'workspace', 'catalog.json'), '{broken')
      writeFileSync(join(root, 'api-workbench', 'workspaces', 'workspace', 'catalog.json.bak'), '{broken')
      expect(() => store.getCatalog('workspace')).toThrow()
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test('Given 持久秘密和旧运行 When Store 重建后脱敏读取 Then 响应回显仍不泄漏秘密', async () => {
    const root = mkdtempSync(join(tmpdir(), 'api-store-'))
    try {
      const store = new ApiWorkbenchStore(root, { safeStorage, uuid: () => 'secret_ref' })
      const saved = store.saveCatalog('workspace', 0, catalog('alpha'))
      const request = { method: 'GET' as const, url: 'https://example.test', headers: [], body: '', timeoutMs: 1_000, followRedirects: false, maxRedirects: 0, sensitiveHeaderNames: [], sensitiveQueryNames: [] }
      const run: ApiRun = {
        id: 'run', workspaceId: 'workspace', sessionId: 'session', source: 'manual', requestName: '请求',
        catalogRevision: saved.revision, createdAt: 1, state: 'completed', request, hops: [],
        body: { rawBytes: 10, decodedBytes: 10, contentType: 'text/plain', encoding: 'utf-8', preview: 'echo alpha', previewTruncated: false, complete: true, decoded: true },
        assertions: [], recording: 'saved', pinned: false,
      }
      store.createRun(run, request)
      const reopened = new ApiWorkbenchStore(root, { safeStorage })
      expect((await reopened.readBody('workspace', 'run')).text).toBe('echo [REDACTED]')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
