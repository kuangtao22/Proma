import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ApiCatalog, ApiCryptoProfile, ApiField } from '@proma/shared'
import { ApiWorkbenchStore } from './api-workbench-store'

/** 假 safeStorage：不做真实加密，只把明文包一层，便于断言「落盘文件里没有明文」。 */
const safeStorage = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => 'unknown' as const,
  encryptString: (value: string) => Buffer.from(value, 'utf8'),
  decryptString: (value: Buffer) => value.toString('utf8'),
}

const APP_SECRET = 'cb-app-2026-9f2c8a1d'
const AES_KEY = '9f2c8a1d4b6e7f03'
const AES_IV = '1029384756abcdef'

/** 一份带签名与加密步骤的方案，供存储与引用检查用例复用。 */
function backendProfile(revision = 0): ApiCryptoProfile {
  return {
    id: 'profile_backend',
    name: '车本本-后台签名',
    description: '后台接口统一签名与加密',
    scope: 'workspace',
    appliesTo: 'all',
    revision,
    updatedAt: 0,
    requestSteps: [
      { id: 's1', kind: 'sign', enabled: true, algo: 'HMAC-SHA256', keyRef: 'appSecret', encoding: 'hex', target: { in: 'header', name: 'X-Sign' }, template: '{{method}}\n{{path}}' },
      { id: 's2', kind: 'encrypt', enabled: true, algo: 'AES-128-CBC', keyRef: 'aesKey', ivRef: 'aesIv', encoding: 'base64', source: 'body', target: { in: 'body', name: 'body' } },
    ],
    responseSteps: [],
  }
}

/** 两条请求：一条选用方案，一条不选，用于验证引用计数只算真正引用的那一条。 */
function catalogWithRequests(): ApiCatalog {
  const request = (id: string, selectedProfileId?: string) => ({
    id, revision: 1, updatedAt: 0, name: id, collectionId: 'default', folder: '', description: '',
    method: 'POST' as const, url: 'https://example.test', query: [], headers: [],
    body: { kind: 'none' as const, text: '', fields: [] }, auth: { type: 'none' as const, value: { value: '' } },
    timeoutMs: 30_000, followRedirects: false, maxRedirects: 0, assertions: [],
    ...(selectedProfileId === undefined ? {} : { selectedProfileId }),
  })
  return {
    version: 1, revision: 0,
    collections: [{ id: 'default', name: '后台接口', description: '', variables: [] }],
    environments: [], requests: [request('request-a', 'profile_backend'), request('request-b')],
  }
}

/** 变量工厂：默认按名称自动秘密化。 */
function variable(id: string, name: string, value: string): ApiField {
  return { id, name, value, enabled: true, secret: true }
}

describe('方案与工作区变量存储', () => {
  test('保存方案后 revision 递增，旧 revision 再保存被拒绝', () => {
    const root = mkdtempSync(join(tmpdir(), 'api-crypto-store-'))
    try {
      const store = new ApiWorkbenchStore(root, { safeStorage, now: () => 10, uuid: () => 'secret_ref' })
      const created = store.saveCryptoProfile('workspace', backendProfile(), null)
      expect(created.revision).toBe(1)
      expect(created.updatedAt).toBe(10)
      const updated = store.saveCryptoProfile('workspace', { ...created, name: '改名后的方案' }, 1)
      expect(updated.revision).toBe(2)
      expect(store.getCatalog('workspace').cryptoProfiles?.map((item) => item.name)).toEqual(['改名后的方案'])
      expect(() => store.saveCryptoProfile('workspace', backendProfile(1), 1)).toThrow('API_WORKBENCH_CRYPTO_REVISION_CONFLICT')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test('工作区变量批写：秘密值不落 catalog.json，引用与名称落盘', () => {
    const root = mkdtempSync(join(tmpdir(), 'api-crypto-store-'))
    try {
      const store = new ApiWorkbenchStore(root, { safeStorage, now: () => 10, uuid: () => 'secret_ref' })
      const saved = store.saveWorkspaceVariables('workspace', [variable('v1', 'appSecret', APP_SECRET)])
      expect(saved[0]).toMatchObject({ name: 'appSecret', value: '', secret: true, secretRef: 'secret_ref' })
      const raw = readFileSync(join(root, 'api-workbench', 'workspaces', 'workspace', 'catalog.json'), 'utf8')
      expect(raw).not.toContain(APP_SECRET)
      expect(raw).toContain('appSecret')
      expect(JSON.stringify(store.getCatalog('workspace'))).not.toContain(APP_SECRET)
      expect(store.resolveSecret('workspace', 'secret_ref', 'workspace:variable:v1')).toEqual({ value: APP_SECRET, revision: '1' })
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test('删除方案：仍被请求引用时默认拒绝，force 才删除', () => {
    const root = mkdtempSync(join(tmpdir(), 'api-crypto-store-'))
    try {
      const store = new ApiWorkbenchStore(root, { safeStorage, now: () => 10, uuid: () => 'secret_ref' })
      store.saveCatalog('workspace', 0, catalogWithRequests())
      store.saveCryptoProfile('workspace', backendProfile(), null)
      expect(store.deleteCryptoProfile('workspace', 'profile_backend')).toEqual({ removed: false, referencedBy: 1 })
      expect(store.getCatalog('workspace').cryptoProfiles).toHaveLength(1)
      expect(store.deleteCryptoProfile('workspace', 'profile_backend', true)).toEqual({ removed: true, referencedBy: 1 })
      /** 强制删除后请求会留下悬空引用，界面按「方案已删除」显示，与既有环境引用同语义。 */
      expect(store.getCatalog('workspace').requests[0]?.selectedProfileId).toBe('profile_backend')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test('引用检查：变量给出方案名与请求数，方案给出选中它的请求数', () => {
    const root = mkdtempSync(join(tmpdir(), 'api-crypto-store-'))
    try {
      const store = new ApiWorkbenchStore(root, { safeStorage, now: () => 10, uuid: () => 'secret_ref' })
      store.saveCatalog('workspace', 0, catalogWithRequests())
      store.saveCryptoProfile('workspace', backendProfile(), null)
      expect(store.inspectCryptoReferences('workspace', 'variable', 'aesIv')).toEqual({ profiles: ['车本本-后台签名'], requests: 1, collections: ['后台接口'] })
      expect(store.inspectCryptoReferences('workspace', 'variable', 'unusedVar')).toEqual({ profiles: [], requests: 0, collections: [] })
      expect(store.inspectCryptoReferences('workspace', 'profile', 'profile_backend')).toEqual({ profiles: ['车本本-后台签名'], requests: 1, collections: ['后台接口'] })
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test('工作区变量批写不动请求与集合，且整份目录 revision 递增', () => {
    const root = mkdtempSync(join(tmpdir(), 'api-crypto-store-'))
    try {
      /** 一次批写多个秘密：uuid 必须递增，否则会撞上 Store 的 ref 冲突保护。 */
      let sequence = 0
      const store = new ApiWorkbenchStore(root, { safeStorage, now: () => 10, uuid: () => `ref_${++sequence}` })
      store.saveCatalog('workspace', 0, catalogWithRequests())
      const before = store.getCatalog('workspace')
      store.saveWorkspaceVariables('workspace', [
        { id: 'v0', name: 'baseUrl', value: 'https://api.test', enabled: true },
        variable('v1', 'appSecret', APP_SECRET), variable('v2', 'aesKey', AES_KEY), variable('v3', 'aesIv', AES_IV),
      ])
      const after = store.getCatalog('workspace')
      expect(after.revision).toBe(before.revision + 1)
      expect(after.requests).toEqual(before.requests)
      expect(after.collections).toEqual(before.collections)
      expect(after.workspaceVariables?.map((item) => item.name)).toEqual(['baseUrl', 'appSecret', 'aesKey', 'aesIv'])
      /** 非秘密变量保留明文，秘密变量落盘后被替换为引用。 */
      expect(after.workspaceVariables?.find((item) => item.name === 'baseUrl')?.value).toBe('https://api.test')
      expect(after.workspaceVariables?.find((item) => item.name === 'aesKey')?.secretRef).toBeTruthy()
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test('明文揭示通道：按 owner 精确读一个字段，跨作用域取不到', () => {
    const root = mkdtempSync(join(tmpdir(), 'api-crypto-store-'))
    try {
      const store = new ApiWorkbenchStore(root, { safeStorage, now: () => 10, uuid: () => 'secret_ref' })
      store.saveWorkspaceVariables('workspace', [
        variable('v1', 'appSecret', APP_SECRET),
        { id: 'v2', name: 'baseUrl', value: 'https://api.test', enabled: true },
      ])
      expect(store.revealVariable('workspace', { scope: 'workspace', fieldId: 'v1' })).toEqual({ name: 'appSecret', value: APP_SECRET })
      /** 非秘密字段本来就在目录里，直接回原值。 */
      expect(store.revealVariable('workspace', { scope: 'workspace', fieldId: 'v2' })).toEqual({ name: 'baseUrl', value: 'https://api.test' })
      expect(() => store.revealVariable('workspace', { scope: 'collection', fieldId: 'v1' })).toThrow('API_WORKBENCH_VARIABLE_SCOPE_REQUIRED')
      expect(() => store.revealVariable('workspace', { scope: 'environment', scopeId: 'missing', fieldId: 'v1' })).toThrow('API_WORKBENCH_VARIABLE_NOT_FOUND')
      expect(() => store.revealVariable('workspace', { scope: 'workspace', fieldId: 'nope' })).toThrow('API_WORKBENCH_VARIABLE_NOT_FOUND')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
