import { describe, expect, test } from 'bun:test'
import { digestValue, encryptValue } from './api-crypto'
import { applyRequestSteps, applyResponseSteps } from './api-crypto-plan'
import type { ApiCryptoProfile, ApiCryptoStep } from '@proma/shared'

const AES_KEY = '9f2c8a1d4b6e7f03'
const AES_IV = '1029384756abcdef'
const APP_SECRET = 'cb-app-2026-9f2c8a1d'

/** 步骤工厂：只覆盖用例关心的字段，其余留缺省。 */
function step(value: Partial<ApiCryptoStep> & Pick<ApiCryptoStep, 'id' | 'kind' | 'algo'>): ApiCryptoStep {
  return { enabled: true, ...value }
}

/** 方案工厂：默认「派生时间戳 → 对明文签名 → 加密正文」，可在用例里替换任一段。 */
function backendProfile(value: Partial<ApiCryptoProfile> = {}): ApiCryptoProfile {
  return {
    id: 'profile_backend',
    name: '车本本-后台签名',
    description: '',
    scope: 'workspace',
    appliesTo: 'all',
    revision: 1,
    updatedAt: 1,
    requestSteps: [
      step({ id: 's1', kind: 'derive', algo: 'timestamp-nonce', target: { in: 'header', name: 'X-Timestamp' } }),
      step({ id: 's2', kind: 'sign', algo: 'HMAC-SHA256', keyRef: 'appSecret', encoding: 'hex', target: { in: 'header', name: 'X-Sign' }, template: '{{method}}\n{{path}}\n{{timestamp}}\n{{body.sha256}}' }),
      step({ id: 's3', kind: 'encrypt', algo: 'AES-128-CBC', keyRef: 'aesKey', ivRef: 'aesIv', encoding: 'base64', source: 'body', target: { in: 'body', name: 'body' } }),
    ],
    responseSteps: [
      step({ id: 'r1', kind: 'decrypt', algo: 'AES-128-CBC', keyRef: 'aesKey', ivRef: 'aesIv', encoding: 'base64', source: 'response-body', onFailure: 'stop' }),
    ],
    ...value,
  }
}

const SECRETS = { appSecret: APP_SECRET, aesKey: AES_KEY, aesIv: AES_IV }
const REQUEST = { method: 'POST', path: '/admin/v1/capability', query: [], headers: [], body: '{"capabilityId":1024}' }
/** 固定时钟与随机串，让签名断言可以精确复算。 */
const FIXED_NOW = 1_758_800_000_000
const FIXED_NONCE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'

describe('加密步骤编排', () => {
  test('按顺序执行派生、签名、加密，签名对明文求值', () => {
    const result = applyRequestSteps({ profile: backendProfile(), secrets: SECRETS, request: REQUEST, now: FIXED_NOW, nonce: FIXED_NONCE })
    const timestamp = result.headers.find((row) => row.name === 'X-Timestamp')?.value
    expect(timestamp).toBe('1758800000')
    const expected = digestValue('HMAC-SHA256', APP_SECRET, `POST\n/admin/v1/capability\n${timestamp}\n${digestValue('SHA256', '', REQUEST.body, 'hex')}`, 'hex')
    expect(result.headers.find((row) => row.name === 'X-Sign')?.value).toBe(expected)
    expect(result.executed.map((item) => item.kind)).toEqual(['derive', 'sign', 'encrypt'])
    expect(result.body).not.toContain('capabilityId')
    /** 记录要能对照「发出的密文 ↔ 变形前明文」，所以明文在被加密时留一份非秘密副本。 */
    expect(result.bodyBeforeTransform).toBe(REQUEST.body)
    expect(result.derived).toEqual({ timestamp: '1758800000', nonce: FIXED_NONCE })
    expect(result.plaintextSent).toBe(false)
  })

  test('加密密钥缺失时只跳过该步，签名照常执行且标记明文发出', () => {
    const result = applyRequestSteps({ profile: backendProfile(), secrets: { appSecret: APP_SECRET }, request: REQUEST, now: FIXED_NOW, nonce: FIXED_NONCE })
    expect(result.skipped).toEqual([expect.objectContaining({ kind: 'encrypt', reason: 'missing-secret', keyRef: 'aesKey' })])
    expect(result.plaintextSent).toBe(true)
    expect(result.body).toBe(REQUEST.body)
    expect(result.headers.find((row) => row.name === 'X-Sign')?.value).toBeTruthy()
  })

  test('签名密钥缺失时同样只跳过该步并标记明文发出', () => {
    const result = applyRequestSteps({ profile: backendProfile(), secrets: { aesKey: AES_KEY, aesIv: AES_IV }, request: REQUEST, now: FIXED_NOW, nonce: FIXED_NONCE })
    expect(result.skipped).toEqual([expect.objectContaining({ kind: 'sign', reason: 'missing-secret', keyRef: 'appSecret' })])
    expect(result.plaintextSent).toBe(true)
    expect(result.headers.some((row) => row.name === 'X-Sign')).toBe(false)
  })

  test('数组顺序即语义：签名排在加密之后就对密文求值', () => {
    const encrypt = step({ id: 's3', kind: 'encrypt', algo: 'AES-128-CBC', keyRef: 'aesKey', ivRef: 'aesIv', encoding: 'base64', source: 'body', target: { in: 'body', name: 'body' } })
    const sign = step({ id: 's2', kind: 'sign', algo: 'HMAC-SHA256', keyRef: 'appSecret', encoding: 'hex', target: { in: 'header', name: 'X-Sign' }, template: '{{body.raw}}' })
    const result = applyRequestSteps({ profile: backendProfile({ requestSteps: [encrypt, sign] }), secrets: SECRETS, request: REQUEST, now: FIXED_NOW, nonce: FIXED_NONCE })
    expect(result.executed.map((item) => item.kind)).toEqual(['encrypt', 'sign'])
    expect(result.headers.find((row) => row.name === 'X-Sign')?.value).toBe(digestValue('HMAC-SHA256', APP_SECRET, result.body, 'hex'))
  })

  test('接口级覆盖项优先于方案：换密钥变量与输出名称', () => {
    const profile = backendProfile({ requestSteps: [step({ id: 's2', kind: 'sign', algo: 'HMAC-SHA256', keyRef: 'appSecret', encoding: 'hex', target: { in: 'header', name: 'X-Sign' }, template: '{{method}}' })] })
    const result = applyRequestSteps({
      profile, secrets: { ...SECRETS, appSecretProd: 'prod-secret' }, request: REQUEST,
      overrides: { keyRefs: { s2: 'appSecretProd' }, targetNames: { s2: 'X-Sign-Prod' } },
    })
    expect(result.headers.find((row) => row.name === 'X-Sign-Prod')?.value).toBe(digestValue('HMAC-SHA256', 'prod-secret', 'POST', 'hex'))
    expect(result.headers.some((row) => row.name === 'X-Sign')).toBe(false)
  })

  test('未启用步骤记为 disabled，且不算明文发出', () => {
    const disabled = backendProfile({ requestSteps: [step({ id: 's3', kind: 'encrypt', enabled: false, algo: 'AES-128-CBC', keyRef: 'aesKey', ivRef: 'aesIv', encoding: 'base64', source: 'body', target: { in: 'body', name: 'body' } })] })
    const result = applyRequestSteps({ profile: disabled, secrets: SECRETS, request: REQUEST })
    expect(result.skipped).toEqual([expect.objectContaining({ kind: 'encrypt', reason: 'disabled' })])
    expect(result.plaintextSent).toBe(false)
    expect(result.body).toBe(REQUEST.body)
  })

  test('签名步骤缺少输出目标时按配置不完整跳过，不抛错', () => {
    const broken = backendProfile({ requestSteps: [step({ id: 's2', kind: 'sign', algo: 'HMAC-SHA256', keyRef: 'appSecret', encoding: 'hex', template: '{{method}}' })] })
    const result = applyRequestSteps({ profile: broken, secrets: SECRETS, request: REQUEST })
    expect(result.skipped).toEqual([expect.objectContaining({ kind: 'sign', reason: 'invalid-config' })])
    expect(result.plaintextSent).toBe(true)
  })

  test('响应解密成功返回明文与事实', () => {
    const ciphertext = encryptValue('AES-128-CBC', AES_KEY, AES_IV, '{"code":0}', { encoding: 'base64' }).ciphertext
    const outcome = applyResponseSteps({ profile: backendProfile(), secrets: SECRETS, responseBody: ciphertext })
    expect(outcome.decrypted).toBe(true)
    expect(outcome.body).toBe('{"code":0}')
    expect(outcome.executed).toEqual([expect.objectContaining({ kind: 'decrypt', algo: 'AES-128-CBC' })])
    expect(outcome.failure).toBeUndefined()
  })

  test('响应缺密钥时标记未解密并给出跳过原因', () => {
    const outcome = applyResponseSteps({ profile: backendProfile(), secrets: {}, responseBody: 'xxx' })
    expect(outcome.decrypted).toBe(false)
    expect(outcome.body).toBe('xxx')
    expect(outcome.skipped[0]).toMatchObject({ kind: 'decrypt', reason: 'missing-secret', keyRef: 'aesKey' })
  })

  test('响应解密失败给出可分类原因；onFailure=stop 时不再执行后续步骤', () => {
    const wrongKey = step({ id: 'r1', kind: 'decrypt', algo: 'AES-128-CBC', keyRef: 'aesKeyWrong', ivRef: 'aesIv', encoding: 'base64', source: 'response-body', onFailure: 'stop' })
    const goodKey = step({ id: 'r2', kind: 'decrypt', algo: 'AES-128-CBC', keyRef: 'aesKey', ivRef: 'aesIv', encoding: 'base64', source: 'response-body' })
    const ciphertext = encryptValue('AES-128-CBC', AES_KEY, AES_IV, '{"code":0}', { encoding: 'base64' }).ciphertext
    const outcome = applyResponseSteps({ profile: backendProfile({ responseSteps: [wrongKey, goodKey] }), secrets: { aesKeyWrong: 'ffffffffffffffff', aesKey: AES_KEY, aesIv: AES_IV }, responseBody: ciphertext })
    expect(outcome.failure?.code).toBe('API_CRYPTO_DECRYPT_FAILED')
    expect(outcome.decrypted).toBe(false)
    expect(outcome.executed).toEqual([])
  })

  test('onFailure=continue 时解密失败仍继续执行后续步骤', () => {
    const wrongKey = step({ id: 'r1', kind: 'decrypt', algo: 'AES-128-CBC', keyRef: 'aesKeyWrong', ivRef: 'aesIv', encoding: 'base64', source: 'response-body', onFailure: 'continue' })
    const goodKey = step({ id: 'r2', kind: 'decrypt', algo: 'AES-128-CBC', keyRef: 'aesKey', ivRef: 'aesIv', encoding: 'base64', source: 'response-body' })
    const ciphertext = encryptValue('AES-128-CBC', AES_KEY, AES_IV, '{"code":0}', { encoding: 'base64' }).ciphertext
    const outcome = applyResponseSteps({ profile: backendProfile({ responseSteps: [wrongKey, goodKey] }), secrets: { aesKeyWrong: 'ffffffffffffffff', aesKey: AES_KEY, aesIv: AES_IV }, responseBody: ciphertext })
    expect(outcome.failure?.code).toBe('API_CRYPTO_DECRYPT_FAILED')
    expect(outcome.decrypted).toBe(true)
    expect(outcome.body).toBe('{"code":0}')
    expect(outcome.executed).toEqual([expect.objectContaining({ id: 'r2' })])
  })
})
