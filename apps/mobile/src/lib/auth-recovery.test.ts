import { describe, expect, test } from 'bun:test'
import { recoverTrustedDeviceAuth } from './auth-recovery'

describe('移动端可信设备认证恢复', () => {
  test('Given 访问令牌过期且存在长期凭证 When 恢复认证 Then 自动续签并返回新令牌', async () => {
    /** 当前用例记录的长期凭证提交值。 */
    const submittedCredentials: string[] = []
    /** 当前恢复结果。 */
    const result = await recoverTrustedDeviceAuth({
      token: 'expired-token',
      deviceCredential: 'device-credential',
    }, {
      verifyToken: async () => ({ valid: false, errorCode: 'TOKEN_EXPIRED' }),
      refreshCredential: async (credential) => {
        submittedCredentials.push(credential)
        return { token: 'new-access-token' }
      },
    })

    expect(submittedCredentials).toEqual(['device-credential'])
    expect(result).toEqual({
      status: 'authenticated',
      token: 'new-access-token',
      refreshed: true,
    })
  })

  test('Given 长期凭证已撤销 When 自动续签 Then 标记授权失效', async () => {
    /** 当前恢复结果。 */
    const result = await recoverTrustedDeviceAuth({
      token: null,
      deviceCredential: 'revoked-credential',
    }, {
      verifyToken: async () => ({ valid: false }),
      refreshCredential: async () => {
        throw Object.assign(new Error('revoked'), { code: 'DEVICE_REVOKED' })
      },
    })

    expect(result).toEqual({ status: 'invalidated' })
  })

  test('Given 网络中断 When 验证访问令牌 Then 保留认证材料等待自动重连', async () => {
    /** 当前恢复结果。 */
    const result = await recoverTrustedDeviceAuth({
      token: 'saved-token',
      deviceCredential: 'device-credential',
    }, {
      verifyToken: async () => {
        throw Object.assign(new Error('offline'), { code: 'CONNECTION_LOST' })
      },
      refreshCredential: async () => ({ token: 'unused' }),
    })

    expect(result).toEqual({ status: 'unavailable' })
  })
})
