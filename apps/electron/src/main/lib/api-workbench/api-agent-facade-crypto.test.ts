import { describe, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentSessionMeta, ApiCatalog } from '@proma/shared'
import { ApiWorkbenchService } from './api-workbench-service'
import { ApiWorkbenchStore } from './api-workbench-store'
import { createApiAgentFacade } from './api-agent-facade'

/** 单测环境没有系统安全存储：注入可用替身。 */
const safeStorage = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: (): 'basic_text' => 'basic_text',
  encryptString: (value: string) => Buffer.from(`enc:${value}`),
  decryptString: (buffer: Buffer) => buffer.toString().replace(/^enc:/, ''),
}

/** 一条接口 + 一个集合 + 一个测试环境；加密方案与变量由用例自己声明。 */
function catalog(): ApiCatalog {
  return {
    version: 1, revision: 0,
    collections: [{ id: 'backend', name: '后台', description: '', variables: [] }],
    environments: [{ id: 'test', name: '测试', kind: 'test', variables: [] }],
    requests: [{
      id: 'request-a', revision: 1, updatedAt: 0, name: '请求 A', collectionId: 'backend', folder: '', description: '',
      method: 'POST', url: 'https://example.test/x', query: [], headers: [],
      body: { kind: 'json', text: '{}', fields: [] }, auth: { type: 'none', value: { value: '' } },
      timeoutMs: 30_000, followRedirects: false, maxRedirects: 0, assertions: [],
    }],
  }
}

/** 建立带目录的 Agent 场景；不发真实网络（transport 只在发送用例里被调用）。 */
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'api-agent-crypto-')))
  const session = { id: 'session', workspaceId: 'workspace' } as AgentSessionMeta
  const abort = new AbortController()
  const store = new ApiWorkbenchStore(root, { safeStorage })
  store.saveCatalog('workspace', 0, catalog())
  const service = new ApiWorkbenchService({ store, transport: async () => { throw new Error('本用例不应真的出网') } })
  const facade = createApiAgentFacade({ sessionId: 'session', toolMode: 'standard', getSession: () => session, service, runSignal: abort.signal, assertRunActive: () => undefined })!
  const revision = () => store.getCatalog('workspace').revision
  return { facade, store, service, revision, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

describe('Agent 加密配置能力', () => {
  test('声明变量只写名字与类型：传值的调用被拒绝，且快照里没有任何取值字段', async () => {
    const f = fixture()
    try {
      const input = { scope: 'workspace' as const, variables: [{ name: 'appSecret', secret: true }], expectedRevision: f.revision() }
      const snapshot = await f.facade.approval('api_declare_variables', input)
      expect(snapshot.variableDeclare?.variables).toEqual([{ name: 'appSecret', secret: true, enabled: true, existing: false }])
      /** 审批快照里连一个 value 字段都不该有：密钥值是人的事。 */
      expect(JSON.stringify(snapshot)).not.toContain('value')
      /** 模型试图写值：直接拒绝，而不是静默丢弃（静默丢弃会让它以为配好了）。 */
      await expect(f.facade.approval('api_declare_variables', { ...input, variables: [{ name: 'appSecret', secret: true, value: 'should-be-ignored' }] }))
        .rejects.toThrow('API_WORKBENCH_INVALID')
      await f.facade.authorize('api_declare_variables', input, snapshot)
      expect(await f.facade.declareVariables(input)).toMatchObject({ declared: 1, skippedExisting: 0 })
      const field = f.store.getCatalog('workspace').workspaceVariables?.[0]
      expect(field).toMatchObject({ name: 'appSecret', value: '', secret: true })
      /** 没填值 = 没有密文引用：执行时按缺密钥跳过。 */
      expect(field?.secretRef).toBeUndefined()
    } finally { f.cleanup() }
  })

  test('重复声明同名变量不动原值', async () => {
    const f = fixture()
    try {
      const first = { scope: 'workspace' as const, variables: [{ name: 'appSecret', secret: true }], expectedRevision: f.revision() }
      await f.facade.authorize('api_declare_variables', first, await f.facade.approval('api_declare_variables', first))
      await f.facade.declareVariables(first)
      /** 人填了值以后，Agent 再声明一次不能把值弄丢。 */
      f.store.saveWorkspaceVariables('workspace', [{ id: 'w1', name: 'appSecret', value: 'cb-app-2026', enabled: true, secret: true }])
      const second = { scope: 'workspace' as const, variables: [{ name: 'appSecret' }, { name: 'aesKey', secret: true }], expectedRevision: f.revision() }
      await f.facade.authorize('api_declare_variables', second, await f.facade.approval('api_declare_variables', second))
      expect(await f.facade.declareVariables(second)).toMatchObject({ declared: 1, skippedExisting: 1 })
      const fields = f.store.getCatalog('workspace').workspaceVariables ?? []
      expect(fields.map((field) => field.name)).toEqual(['appSecret', 'aesKey'])
      expect(fields[0]?.secretRef).toBeTruthy()
    } finally { f.cleanup() }
  })

  test('保存方案：快照只列算法与密钥变量名，落盘后 revision 由 Store 维护', async () => {
    const f = fixture()
    try {
      const input = {
        profile: {
          name: '后台签名', description: '后台统一签名', appliesTo: 'all',
          requestSteps: [
            { kind: 'derive', algo: 'timestamp-nonce', target: { in: 'header', name: 'X-Timestamp' } },
            { kind: 'sign', algo: 'HMAC-SHA256', keyRef: 'appSecret', template: '{{method}}\n{{path}}', target: { in: 'header', name: 'X-Sign' } },
          ],
          responseSteps: [{ kind: 'decrypt', algo: 'AES-128-CBC', keyRef: 'aesKey', ivRef: 'aesIv', source: 'response-body', encoding: 'base64' }],
        },
        expectedRevision: f.revision(),
      }
      const snapshot = await f.facade.approval('api_save_crypto_profile', input)
      expect(snapshot.cryptoProfileSave?.keyRefs).toEqual(['appSecret', 'aesKey', 'aesIv'])
      expect(snapshot.cryptoProfileSave?.steps).toEqual([
        expect.objectContaining({ side: 'request', index: 0, kind: 'derive', algo: 'timestamp-nonce', target: 'header:X-Timestamp' }),
        expect.objectContaining({ side: 'request', index: 1, kind: 'sign', keyRef: 'appSecret', target: 'header:X-Sign' }),
        expect.objectContaining({ side: 'response', index: 0, kind: 'decrypt', keyRef: 'aesKey', ivRef: 'aesIv' }),
      ])
      /** 变量还没声明：审批卡上必须提醒，别让人批准一个必然按明文发出的方案。 */
      expect(snapshot.cryptoProfileSave?.warnings.join('|')).toContain('还没声明')

      await f.facade.authorize('api_save_crypto_profile', input, snapshot)
      const saved = await f.facade.saveCryptoProfile(input)
      expect(saved).toMatchObject({ profileName: '后台签名', revision: 1, steps: 3 })
      expect(f.store.getCatalog('workspace').cryptoProfiles?.[0]?.requestSteps.map((step) => step.kind)).toEqual(['derive', 'sign'])
    } finally { f.cleanup() }
  })

  test('绑定方案：未批准直接拒绝，批准后只改 selectedProfileId', async () => {
    const f = fixture()
    try {
      const profileInput = {
        profile: { name: '后台签名', requestSteps: [{ kind: 'sign', algo: 'HMAC-SHA256', keyRef: 'appSecret', template: '{{method}}', target: { in: 'header', name: 'X-Sign' } }], responseSteps: [] },
        expectedRevision: f.revision(),
      }
      await f.facade.authorize('api_save_crypto_profile', profileInput, await f.facade.approval('api_save_crypto_profile', profileInput))
      const profile = await f.facade.saveCryptoProfile(profileInput)

      const binding = { bindings: [{ requestId: 'request-a', profileId: profile.profileId }], expectedRevision: f.revision() }
      await expect(f.facade.bindCryptoProfile(binding)).rejects.toThrow('APPROVAL_REQUIRED')
      const snapshot = await f.facade.approval('api_bind_crypto_profile', binding)
      expect(snapshot.cryptoBind?.bindings).toEqual([{ requestId: 'request-a', requestName: '请求 A', after: profile.profileId, profileName: '后台签名' }])
      await f.facade.authorize('api_bind_crypto_profile', binding, snapshot)
      expect(await f.facade.bindCryptoProfile(binding)).toMatchObject({ bound: 1 })
      const request = f.store.getCatalog('workspace').requests[0]
      expect(request?.selectedProfileId).toBe(profile.profileId)
      /** 只改选方案：URL 与正文一个字节都不动。 */
      expect(request?.url).toBe('https://example.test/x')
      expect(request?.body.text).toBe('{}')
    } finally { f.cleanup() }
  })

  test('发送审批带上「本次发送形态」：缺密钥时明确写出会明文发出', async () => {
    const f = fixture()
    try {
      const profileInput = {
        profile: { name: '后台加密', requestSteps: [{ kind: 'encrypt', algo: 'AES-128-CBC', keyRef: 'aesKey', ivRef: 'aesIv', source: 'body', encoding: 'base64', target: { in: 'body', name: 'body' } }], responseSteps: [] },
        expectedRevision: f.revision(),
      }
      await f.facade.authorize('api_save_crypto_profile', profileInput, await f.facade.approval('api_save_crypto_profile', profileInput))
      const profile = await f.facade.saveCryptoProfile(profileInput)
      const binding = { bindings: [{ requestId: 'request-a', profileId: profile.profileId }], expectedRevision: f.revision() }
      await f.facade.authorize('api_bind_crypto_profile', binding, await f.facade.approval('api_bind_crypto_profile', binding))
      await f.facade.bindCryptoProfile(binding)

      const prepared = await f.facade.prepare({ requestId: 'request-a', environmentId: 'test' })
      const snapshot = await f.facade.approval('api_send_request', { preparedId: prepared.preparedId })
      expect(snapshot.sendShape).toEqual({ profileName: '后台加密', steps: ['加密 AES-128-CBC'], missing: ['aesKey', 'aesIv'] })
    } finally { f.cleanup() }
  })
})
