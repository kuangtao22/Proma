/** 认证恢复时已保存的最小凭证集合。 */
export interface TrustedDeviceAuthSnapshot {
  token: string | null
  deviceCredential: string | null
}

/** 认证恢复使用的 WebSocket 动作。 */
export interface TrustedDeviceAuthTransport {
  verifyToken: (token: string) => Promise<{ valid: boolean; errorCode?: string }>
  refreshCredential: (credential: string) => Promise<{ token: string }>
}

/** 认证恢复的稳定状态结果。 */
export type TrustedDeviceAuthRecoveryResult =
  | { status: 'authenticated'; token: string; refreshed: boolean }
  | { status: 'invalidated' }
  | { status: 'unavailable' }
  | { status: 'anonymous' }

/** 恢复可信设备认证。 */
export async function recoverTrustedDeviceAuth(
  snapshot: TrustedDeviceAuthSnapshot,
  transport: TrustedDeviceAuthTransport,
): Promise<TrustedDeviceAuthRecoveryResult> {
  if (snapshot.token) {
    try {
      /** 当前短期访问令牌的结构化验证结果。 */
      const verification = await transport.verifyToken(snapshot.token)
      if (verification.valid) {
        return { status: 'authenticated', token: snapshot.token, refreshed: false }
      }
    } catch (error) {
      if (!isAuthenticationError(error)) return { status: 'unavailable' }
    }
  }

  if (!snapshot.deviceCredential) {
    return snapshot.token ? { status: 'invalidated' } : { status: 'anonymous' }
  }

  try {
    /** 长期设备凭证签发的新短期访问令牌。 */
    const refreshed = await transport.refreshCredential(snapshot.deviceCredential)
    if (!refreshed.token) return { status: 'invalidated' }
    return { status: 'authenticated', token: refreshed.token, refreshed: true }
  } catch (error) {
    return isAuthenticationError(error) ? { status: 'invalidated' } : { status: 'unavailable' }
  }
}

/** 判断未知异常是否表示凭证需要清除，而非临时网络故障。 */
function isAuthenticationError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  /** WebSocket 客户端异常携带的稳定错误码。 */
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' && isAuthenticationFailureCode(code)
}
import { isAuthenticationFailureCode } from './recovery-guards'
