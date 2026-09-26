import { createHash } from 'node:crypto'
import { describe, expect, test } from 'bun:test'
import { ApiCryptoError, decodeValue, decryptValue, digestValue, encodeValue, encryptValue, evaluateCryptoTemplate } from './api-crypto'

/** 密钥与 IV 在测试里按 UTF-8 字节使用，长度刚好对应 AES-128。 */
const AES_KEY = '9f2c8a1d4b6e7f03'
const AES_IV = '1029384756abcdef'

/** Bun 的 BoringSSL 不带国密实现，Electron/Node 的 OpenSSL 3 才有；据此决定向量用例是否执行。 */
function runtimeHasSm3(): boolean {
  try {
    createHash('sm3')
    return true
  } catch {
    return false
  }
}

describe('加解密引擎', () => {
  test('摘要与 HMAC 与公开测试向量一致', () => {
    // RFC 4231 Test Case 2
    expect(digestValue('HMAC-SHA256', 'Jefe', 'what do ya want for nothing?', 'hex'))
      .toBe('5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843')
    // RFC 2202 Test Case 2
    expect(digestValue('HMAC-SHA1', 'Jefe', 'what do ya want for nothing?', 'hex'))
      .toBe('effcdf6ae5eb2fa2d27416d5f184df9c259a7c79')
    expect(digestValue('MD5', '', 'abc', 'hex')).toBe('900150983cd24fb0d6963f7d28e17f72')
    expect(digestValue('SHA1', '', 'abc', 'hex')).toBe('a9993e364706816aba3e25717850c26c9cd0d89d')
    expect(digestValue('SHA256', '', 'abc', 'hex')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(digestValue('SHA256', '', 'abc', 'base64')).toBe('ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=')
  })

  test('未实现的算法报可分类错误', () => {
    expect(() => digestValue('MD5-ROT13', '', 'abc', 'hex')).toThrow('API_CRYPTO_UNSUPPORTED_ALGO')
    expect(() => encryptValue('RC4', AES_KEY, AES_IV, 'x', { encoding: 'base64' })).toThrow('API_CRYPTO_UNSUPPORTED_ALGO')
  })

  test('AES-128-CBC 往返一致，密文不残留明文', () => {
    const cipher = encryptValue('AES-128-CBC', AES_KEY, AES_IV, '{"capabilityId":1024}', { encoding: 'base64' })
    expect(cipher.ciphertext).not.toContain('capabilityId')
    expect(cipher.tag).toBeUndefined()
    expect(decryptValue('AES-128-CBC', AES_KEY, AES_IV, cipher.ciphertext, { encoding: 'base64' })).toBe('{"capabilityId":1024}')
  })

  test('AES-256-CBC 与 AES-128-GCM 往返一致，GCM 带 tag 且能识别篡改', () => {
    const key256 = '9f2c8a1d4b6e7f039f2c8a1d4b6e7f03'
    const cbc = encryptValue('AES-256-CBC', key256, AES_IV, '订单 1001', { encoding: 'hex' })
    expect(decryptValue('AES-256-CBC', key256, AES_IV, cbc.ciphertext, { encoding: 'hex' })).toBe('订单 1001')
    const gcm = encryptValue('AES-128-GCM', AES_KEY, AES_IV, '{"a":1}', { encoding: 'base64' })
    expect(gcm.tag).toMatch(/^[0-9a-f]{32}$/)
    expect(decryptValue('AES-128-GCM', AES_KEY, AES_IV, gcm.ciphertext, { encoding: 'base64', tag: gcm.tag })).toBe('{"a":1}')
    /** 认证标签不对必须失败，绝不能静默返回半截明文。 */
    expect(() => decryptValue('AES-128-GCM', AES_KEY, AES_IV, gcm.ciphertext, { encoding: 'base64', tag: '00'.repeat(16) })).toThrow('API_CRYPTO_DECRYPT_FAILED')
  })

  test('密钥或 IV 长度不匹配时报可分类错误', () => {
    expect(() => encryptValue('AES-128-CBC', 'short', AES_IV, 'x', { encoding: 'base64' })).toThrow('API_CRYPTO_KEY_MISMATCH')
    expect(() => encryptValue('AES-128-CBC', AES_KEY, 'short', 'x', { encoding: 'base64' })).toThrow('API_CRYPTO_KEY_MISMATCH')
    expect(() => decryptValue('AES-128-CBC', AES_KEY, AES_IV, 'AAAA', { encoding: 'base64' })).toThrow('API_CRYPTO_DECRYPT_FAILED')
  })

  test('编解码支持 hex / base64 / raw，并拒绝不是该编码的内容', () => {
    expect(encodeValue('abc', 'hex')).toBe('616263')
    expect(encodeValue('abc', 'base64')).toBe('YWJj')
    expect(encodeValue('abc', 'raw')).toBe('abc')
    expect(decodeValue('616263', 'hex')).toBe('abc')
    expect(decodeValue('YWJj', 'base64')).toBe('abc')
    expect(decodeValue('616\n263', 'hex')).toBe('abc')
    expect(decodeValue('abc', 'raw')).toBe('abc')
    expect(() => decodeValue('zzz', 'hex')).toThrow('API_CRYPTO_DECRYPT_FAILED')
    expect(() => decodeValue('!!!', 'base64')).toThrow('API_CRYPTO_DECRYPT_FAILED')
  })

  test('模板求值支持换行与嵌套占位符，未知占位符保持原样', () => {
    const context = { method: 'POST', path: '/admin/v1/x', timestamp: '1758800000', body: { raw: 'abc', sha256: 'ba7816bf' } }
    expect(evaluateCryptoTemplate('{{method}}\n{{path}}\n{{body.sha256}}', context)).toBe('POST\n/admin/v1/x\nba7816bf')
    expect(evaluateCryptoTemplate('{{method}}\n{{timestamp}}\n{{unknown}}', context)).toBe('POST\n1758800000\n{{unknown}}')
    expect(evaluateCryptoTemplate('{{body.missing}}', context)).toBe('{{body.missing}}')
  })

  test('错误类型带稳定 code，便于界面分类展示', () => {
    const error = new ApiCryptoError('API_CRYPTO_KEY_MISMATCH', '密钥长度不对')
    expect(error.code).toBe('API_CRYPTO_KEY_MISMATCH')
    expect(error.message).toContain('API_CRYPTO_KEY_MISMATCH')
  })

  test.skipIf(!runtimeHasSm3())('SM3 与公开测试向量一致（需要 OpenSSL 3 运行时）', () => {
    expect(digestValue('SM3', '', 'abc', 'hex')).toBe('66c7f0f462eeedd9d1f2d46bdc10e4e24167c4875cf2f7a2297da02b8f4ba8e0')
  })

  test('当前运行时缺少国密实现时给出可分类错误而不是崩在底层', () => {
    if (runtimeHasSm3()) return
    expect(() => digestValue('SM3', '', 'abc', 'hex')).toThrow('API_CRYPTO_UNSUPPORTED_ALGO')
    expect(() => encryptValue('SM4-CBC', AES_KEY, AES_IV, 'x', { encoding: 'base64' })).toThrow('API_CRYPTO_UNSUPPORTED_ALGO')
  })
})
