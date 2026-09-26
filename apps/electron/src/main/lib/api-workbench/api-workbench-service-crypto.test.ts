import { describe, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ApiCatalog, ApiCryptoProfile, ApiResolvedRequest, ApiTransportResult } from '@proma/shared'
import { createApiRequestDraft } from '@proma/shared'
import { decryptValue, digestValue, encryptValue } from './api-crypto'
import { ApiWorkbenchService } from './api-workbench-service'
import { ApiWorkbenchStore } from './api-workbench-store'

const APP_SECRET = 'cb-app-2026-9f2c8a1d'
const AES_KEY = '9f2c8a1d4b6e7f03'
const AES_IV = '1029384756abcdef'
const PLAINTEXT = '{"capabilityId":1024}'
/** 响应明文同时带一个普通字段（断言/记录用）与一个敏感字段（验证提取读到的是明文而不是 [REDACTED]）。 */
const RESPONSE_PLAINTEXT = '{"code":0,"token":"tok_live_9"}'
const context = { workspaceId: 'workspace', sessionId: 'session', source: 'manual' as const }

/** 与 Store 测试同款的假 safeStorage：落盘文件里不会出现明文。 */
const safeStorage = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => 'unknown' as const,
  encryptString: (value: string) => Buffer.from(value, 'utf8'),
  decryptString: (value: Buffer) => value.toString('utf8'),
}

/** 后台签名方案：派生时间戳 → 对明文签名 → 加密正文；响应按同一把密钥解密。 */
function backendProfile(): ApiCryptoProfile {
  return {
    id: 'profile_backend', name: '车本本-后台签名', description: '', scope: 'workspace', appliesTo: 'all', revision: 0, updatedAt: 0,
    requestSteps: [
      { id: 's1', kind: 'derive', enabled: true, algo: 'timestamp-nonce', target: { in: 'header', name: 'X-Timestamp' } },
      { id: 's2', kind: 'sign', enabled: true, algo: 'HMAC-SHA256', keyRef: 'appSecret', encoding: 'hex', target: { in: 'header', name: 'X-Sign' }, template: '{{method}}\n{{path}}\n{{timestamp}}\n{{body.sha256}}' },
      { id: 's3', kind: 'encrypt', enabled: true, algo: 'AES-128-CBC', keyRef: 'aesKey', ivRef: 'aesIv', encoding: 'base64', source: 'body', target: { in: 'body', name: 'body' } },
    ],
    responseSteps: [{ id: 'r1', kind: 'decrypt', enabled: true, algo: 'AES-128-CBC', keyRef: 'aesKey', ivRef: 'aesIv', encoding: 'base64', source: 'response-body', onFailure: 'stop' }],
  }
}

/** 夹具：真实目录 + 假 safeStorage + 一个会验签/解密/回密文的「服务端」。 */
function fixture(options: { withAesKey?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'api-crypto-service-')))
  let sequence = 0
  const store = new ApiWorkbenchStore(root, { safeStorage, now: () => 1_000, uuid: () => `ref_${++sequence}` })
  const catalog: ApiCatalog = {
    version: 1, revision: 0,
    collections: [{
      id: 'backend', name: '后台接口', description: '',
      variables: [
        ...(options.withAesKey === false ? [] : [
          { id: 'v_key', name: 'aesKey', value: AES_KEY, enabled: true, secret: true },
          { id: 'v_iv', name: 'aesIv', value: AES_IV, enabled: true, secret: true },
        ]),
      ],
    }],
    environments: [{ id: 'test', name: '测试', kind: 'test', variables: [] }],
    requests: [],
  }
  store.saveCatalog('workspace', 0, catalog)
  store.saveCryptoProfile('workspace', backendProfile(), null)
  /** 工作区级密钥：验证「工作区作用域」真的参与密钥解析。 */
  store.saveWorkspaceVariables('workspace', [{ id: 'w_secret', name: 'appSecret', value: APP_SECRET, enabled: true, secret: true }])

  const seen: ApiResolvedRequest[] = []
  const server = { signMatched: false, decryptedBody: '', sawCiphertext: false, responseCiphertext: '' }
  const transport = async (request: ApiResolvedRequest): Promise<ApiTransportResult> => {
    seen.push(request)
    /** 服务端拿到的是密文：先解密，再用明文重算签名核对。 */
    let plaintext = request.body
    try {
      plaintext = decryptValue('AES-128-CBC', AES_KEY, AES_IV, request.body, { encoding: 'base64' })
      server.sawCiphertext = true
    } catch { server.sawCiphertext = false }
    server.decryptedBody = plaintext
    const timestamp = request.headers.find((header) => header.name === 'X-Timestamp')?.value ?? ''
    const sign = request.headers.find((header) => header.name === 'X-Sign')?.value ?? ''
    server.signMatched = sign === digestValue('HMAC-SHA256', APP_SECRET, `POST\n/backend/capability\n${timestamp}\n${digestValue('SHA256', '', plaintext, 'hex')}`, 'hex')
    const encrypted = encryptValue('AES-128-CBC', AES_KEY, AES_IV, RESPONSE_PLAINTEXT, { encoding: 'base64' })
    server.responseCiphertext = encrypted.ciphertext
    return {
      state: 'completed', hops: [],
      body: { rawBytes: encrypted.ciphertext.length, decodedBytes: encrypted.ciphertext.length, contentType: 'text/plain', encoding: 'utf-8', preview: encrypted.ciphertext, previewTruncated: false, complete: true, decoded: true },
    }
  }
  const service = new ApiWorkbenchService({ store, transport })
  const draft = {
    ...createApiRequestDraft('backend'),
    name: '保存 AI 能力', method: 'POST' as const, url: 'https://example.test/backend/capability',
    body: { kind: 'json' as const, text: PLAINTEXT, fields: [], files: [] },
    selectedProfileId: 'profile_backend',
    assertions: [{ id: 'a_code', kind: 'json-value' as const, path: 'code', expected: '0' }],
  }
  return { root, store, service, draft, seen, server, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

describe('发送链路接入加密步骤', () => {
  test('发送时按方案派生、签名并加密，服务端验签通过且只收到密文', async () => {
    const f = fixture()
    try {
      const preview = await f.service.prepare(context, { request: f.draft, environmentId: 'test' })
      const run = await f.service.send(context, preview.preparedId)

      expect(f.server.signMatched).toBe(true)
      expect(f.server.sawCiphertext).toBe(true)
      expect(f.server.decryptedBody).toBe(PLAINTEXT)
      expect(f.seen[0]?.body).not.toContain('capabilityId')
      /** executed 按执行顺序同时收纳请求侧与响应侧步骤（decrypt 即响应侧）。 */
      expect(run.crypto?.executed.map((step) => step.kind)).toEqual(['derive', 'sign', 'encrypt', 'decrypt'])
      expect(run.crypto?.plaintextSent).toBe(false)
      expect(run.crypto?.profileName).toBe('车本本-后台签名')
      /** 记录里的请求是实际发出的形态：带签名头、正文是密文。 */
      expect(run.request.headers.some((header) => header.name === 'X-Sign')).toBe(true)
      expect(run.request.body).toBe(f.seen[0]!.body)
      expect(run.crypto?.bodyBeforeTransform).toBe(PLAINTEXT)
      expect(run.crypto?.derived?.timestamp).toMatch(/^\d{10}$/)
    } finally { f.cleanup() }
  })

  test('响应解密后才交给断言与提取，记录里保存解密后的正文', async () => {
    const f = fixture()
    try {
      const withExtraction = { ...f.draft, extractions: [{ id: 'ex_1', name: 'token', from: 'json' as const, path: 'token', secret: true }] }
      const run = await f.service.send(context, (await f.service.prepare(context, { request: withExtraction, environmentId: 'test' })).preparedId)

      expect(run.crypto?.decrypted).toBe(true)
      expect(run.crypto?.failure).toBeUndefined()
      /** 断言读的是明文：如果跑在密文上，这条 json-value 必然失败。 */
      expect(run.assertions[0]).toMatchObject({ id: 'a_code', passed: true })
      /** 记录的正文是解密后的可读 JSON；敏感字段仍按既有脱敏规则遮罩。 */
      expect(run.body.preview).toContain('"code":0')
      expect(run.body.preview).toBe('{"code":0,"token":"[REDACTED]"}')
      expect(run.body.preview).not.toBe(f.server.responseCiphertext)
      /** 提取拿到的也是明文值，不是 [REDACTED]、也不是密文。 */
      expect(run.extracted).toEqual([{ id: 'ex_1', name: 'token', from: 'json', found: true, secret: true }])
      expect(f.service.getRuntimeVariables('workspace').map((item) => item.name)).toEqual(['token'])
    } finally { f.cleanup() }
  })

  test('缺密钥时明文发出且不阻断：服务端照样收到请求，记录里标明未加密', async () => {
    const f = fixture({ withAesKey: false })
    try {
      const run = await f.service.send(context, (await f.service.prepare(context, { request: f.draft, environmentId: 'test' })).preparedId)

      expect(f.server.sawCiphertext).toBe(false)
      expect(f.server.decryptedBody).toBe(PLAINTEXT)
      expect(f.server.signMatched).toBe(true)
      expect(run.crypto?.plaintextSent).toBe(true)
      expect(run.crypto?.skipped).toContainEqual(
        expect.objectContaining({ kind: 'encrypt', reason: 'missing-secret', keyRef: 'aesKey' }),
      )
      expect(run.crypto?.skipped).toContainEqual(
        expect.objectContaining({ kind: 'decrypt', reason: 'missing-secret', keyRef: 'aesKey' }),
      )
      /** 解密侧同样缺密钥：密文原文照常可查，只标「未解密」。 */
      expect(run.crypto?.decrypted).toBe(false)
      expect(run.body.preview).not.toBe(RESPONSE_PLAINTEXT)
      expect(run.assertions[0]).toMatchObject({ id: 'a_code', passed: false })
    } finally { f.cleanup() }
  })

  test('解密失败给出可分类原因，并保留服务端返回的密文原文', async () => {
    const f = fixture()
    try {
      /** 篡改响应密钥：只改环境不存在的变量，改用请求级覆盖指向错密钥。 */
      const wrong = { ...f.draft, cryptoOverrides: { keyRefs: { r1: 'aesKeyWrong' } } }
      f.store.saveWorkspaceVariables('workspace', [
        { id: 'w_secret', name: 'appSecret', value: APP_SECRET, enabled: true, secret: true },
        { id: 'w_wrong', name: 'aesKeyWrong', value: 'ffffffffffffffff', enabled: true, secret: true },
      ])
      const run = await f.service.send(context, (await f.service.prepare(context, { request: wrong, environmentId: 'test' })).preparedId)

      expect(run.crypto?.decrypted).toBe(false)
      expect(run.crypto?.failure?.code).toBe('API_CRYPTO_DECRYPT_FAILED')
      /** 失败原因是给人看的分类结论，不是 OpenSSL 内部文案。 */
      expect(run.crypto?.failure?.message).toContain('解密失败')
      expect(run.crypto?.failure?.message).not.toContain('OPENSSL_internal')
      expect(run.body.preview).not.toBe(RESPONSE_PLAINTEXT)
      expect(run.body.preview).toBe(f.server.responseCiphertext)
    } finally { f.cleanup() }
  })

  test('运行记录与日志里不出现任何密钥值', async () => {
    const f = fixture()
    try {
      const run = await f.service.send(context, (await f.service.prepare(context, { request: f.draft, environmentId: 'test' })).preparedId)
      const record = JSON.stringify(f.store.getRun('workspace', run.id))
      for (const secret of [AES_KEY, AES_IV, APP_SECRET]) expect(record).not.toContain(secret)
      expect(JSON.stringify(run)).not.toContain(AES_KEY)
    } finally { f.cleanup() }
  })

  test('方案被删除后拒绝准备，不静默按明文发出', async () => {
    const f = fixture()
    try {
      f.store.saveCatalog('workspace', f.store.getCatalog('workspace').revision, {
        ...f.store.getCatalog('workspace'),
        cryptoProfiles: [],
      })
      await expect(f.service.prepare(context, { request: f.draft, environmentId: 'test' })).rejects.toThrow('API_WORKBENCH_CRYPTO_PROFILE_NOT_FOUND')
    } finally { f.cleanup() }
  })
})
