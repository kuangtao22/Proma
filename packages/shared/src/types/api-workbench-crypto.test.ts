import { describe, expect, test } from 'bun:test'
import { createApiRequestDraft, parseApiCatalog, parseApiCryptoOverrides, parseApiCryptoProfile, parseApiRequestDraft } from './api-workbench'

/** 构造一份最小可用方案，供多个用例复用；overrides 用于替换或追加字段。 */
function backendProfile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'profile_backend',
    name: '车本本-后台签名',
    description: '',
    scope: 'workspace',
    appliesTo: 'all',
    revision: 1,
    updatedAt: 1,
    requestSteps: [
      { id: 's1', kind: 'derive', enabled: true, algo: 'timestamp-nonce', target: { in: 'header', name: 'X-Timestamp' } },
      { id: 's2', kind: 'sign', enabled: true, algo: 'HMAC-SHA256', keyRef: 'appSecret', encoding: 'hex', target: { in: 'header', name: 'X-Sign' }, template: '{{method}}\n{{path}}' },
    ],
    responseSteps: [{ id: 'r1', kind: 'decrypt', enabled: true, algo: 'AES-128-CBC', keyRef: 'aesKey', ivRef: 'aesIv', encoding: 'base64' }],
    ...overrides,
  }
}

describe('加密方案与工作区变量解析', () => {
  test('合法方案可解析，步骤顺序保留', () => {
    const profile = parseApiCryptoProfile(backendProfile())
    expect(profile.requestSteps.map((step) => step.kind)).toEqual(['derive', 'sign'])
    expect(profile.responseSteps[0]?.ivRef).toBe('aesIv')
    expect(profile.scope).toBe('workspace')
  })

  test('旧目录（无 cryptoProfiles / workspaceVariables）仍能整份解析', () => {
    const catalog = parseApiCatalog({
      version: 1, revision: 3,
      collections: [{ id: 'default', name: '默认集合', description: '', variables: [] }],
      environments: [], requests: [],
    })
    expect(catalog.cryptoProfiles).toEqual([])
    expect(catalog.workspaceVariables).toEqual([])
  })

  test('目录里的方案与工作区变量按原顺序保留', () => {
    const catalog = parseApiCatalog({
      version: 1, revision: 4,
      collections: [{ id: 'default', name: '默认集合', description: '', variables: [] }],
      environments: [], requests: [],
      workspaceVariables: [{ id: 'v1', name: 'appSecret', value: '', enabled: true, secret: true }],
      cryptoProfiles: [backendProfile(), backendProfile({ id: 'profile_app', name: '车本本-APP 签名' })],
    })
    expect((catalog.workspaceVariables ?? []).map((field) => field.name)).toEqual(['appSecret'])
    expect((catalog.cryptoProfiles ?? []).map((profile) => profile.id)).toEqual(['profile_backend', 'profile_app'])
  })

  test('目录里的方案 id 重复时整份解析失败', () => {
    expect(() => parseApiCatalog({
      version: 1, revision: 4,
      collections: [{ id: 'default', name: '默认集合', description: '', variables: [] }],
      environments: [], requests: [],
      cryptoProfiles: [backendProfile(), backendProfile()],
    })).toThrow()
  })

  test('非法算法或缺失 keyRef 的签名步骤被拒绝', () => {
    expect(() => parseApiCryptoProfile({ id: 'x', name: 'x', requestSteps: [{ id: 's', kind: 'sign', enabled: true, algo: 'MD5-ROT13' }], responseSteps: [] })).toThrow()
    expect(() => parseApiCryptoProfile({ id: 'x', name: 'x', requestSteps: [{ id: 's', kind: 'sign', enabled: true, algo: 'MD5' }], responseSteps: [] })).toThrow()
  })

  test('derive 步骤不需要 keyRef，但非法 kind 仍被拒绝', () => {
    const profile = parseApiCryptoProfile({ id: 'x', name: 'x', requestSteps: [{ id: 's', kind: 'derive', enabled: true, algo: 'timestamp-nonce' }], responseSteps: [] })
    expect(profile.requestSteps[0]?.keyRef).toBeUndefined()
    expect(() => parseApiCryptoProfile({ id: 'x', name: 'x', requestSteps: [{ id: 's', kind: 'rotate', enabled: true, algo: 'timestamp-nonce' }], responseSteps: [] })).toThrow()
  })

  test('接口级覆盖项按步骤 id 保存密钥与输出名称', () => {
    const overrides = parseApiCryptoOverrides({ keyRefs: { s2: 'appSecretProd' }, targetNames: { s2: 'X-Sign-Prod' }, onFailure: 'continue' })
    expect(overrides).toEqual({ keyRefs: { s2: 'appSecretProd' }, targetNames: { s2: 'X-Sign-Prod' }, onFailure: 'continue' })
    expect(() => parseApiCryptoOverrides({ keyRefs: { 'bad id': 'x' } })).toThrow()
    expect(parseApiCryptoOverrides(undefined)).toBeUndefined()
  })

  test('请求草稿默认未选方案，选中值可解析', () => {
    expect(createApiRequestDraft('default').selectedProfileId).toBeUndefined()
    const draft = parseApiRequestDraft({ ...createApiRequestDraft('default'), selectedProfileId: 'profile_backend', cryptoOverrides: { keyRefs: { s2: 'appSecret' } } })
    expect(draft.selectedProfileId).toBe('profile_backend')
    expect(draft.cryptoOverrides?.keyRefs).toEqual({ s2: 'appSecret' })
  })
})
