/**
 * LAN Bridge 进程级认证服务。
 *
 * 单个服务固定持有一个设备仓库；Bridge 重启只轮换 PIN 并清理内存票据。
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { LanBridgeDeviceStore } from './lan-bridge-device-store'
import type { LanBridgeDevice } from './lan-bridge-device-store'

const ACCESS_TOKEN_EXPIRY_MS = 15 * 60 * 1_000
export const TOKEN_FUTURE_IAT_TOLERANCE_MS = 30_000
const PAIRING_TICKET_EXPIRY_MS = 120_000
const MAX_PAIRING_TICKETS = 1_024
const PIN_LENGTH = 6
const PAIRING_WINDOW_MS = 60_000
const MAX_PAIRING_FAILURES = 5
const MAX_TOKEN_DEVICE_ID_LENGTH = 128
const DEVICE_CREDENTIAL_VERSION = 'v1'
const DEVICE_CREDENTIAL_SECRET_LENGTH = 43

/** 单个 IP 的配对失败窗口。 */
interface PairingAttemptState {
  windowStartedAt: number
  failures: number
}

/** Token payload 结构。 */
interface TokenPayload {
  deviceId: string
  tokenVersion: number
  iat: number
}

/** 一次性票据的内存状态。 */
interface PairingTicketState {
  expiresAt: number
}

/** 认证服务工厂参数。 */
export interface LanBridgeAuthServiceOptions {
  /** 固定由当前服务持有的设备仓库。 */
  deviceStore?: LanBridgeDeviceStore
  /** 仅记录无凭据警告的安全 logger。 */
  logger?: LanBridgeAuthLogger
}

/** 惰性认证服务 getter 的可测试依赖。 */
export interface LanBridgeAuthServiceGetterOptions {
  /** 首次使用时才创建固定设备仓库。 */
  deviceStoreFactory?: () => LanBridgeDeviceStore
  /** 认证服务使用的安全 logger。 */
  logger?: LanBridgeAuthLogger
}

/** 认证模块用于记录非致命持久化故障的安全 logger。 */
export interface LanBridgeAuthLogger {
  /** 记录不含凭据的中文警告。 */
  warn: (message: string) => void
}

/** 一次性配对票据。 */
export interface PairingTicket {
  value: string
  expiresAt: number
}

/** 签发后的设备 Token。 */
export interface IssuedDeviceToken {
  token: string
  expiresIn: number
  expiresAt: number
  deviceId: string
}

/** 首次配对后返回的短期访问令牌和长期设备凭证。 */
export interface IssuedTrustedDevice extends IssuedDeviceToken {
  /** 只返回给当前客户端一次的高熵长期凭证。 */
  deviceCredential: string
}

/** Token 的结构化失败结果。 */
export interface TokenFailure {
  valid: false
  errorCode: 'TOKEN_INVALID' | 'TOKEN_EXPIRED' | 'DEVICE_REVOKED'
}

/** Token 的结构化验证结果。 */
export type TokenVerificationResult = {
  valid: true
  deviceId: string
  expiresAt: number
} | TokenFailure

/** Token 刷新的结构化结果。 */
export type TokenRefreshResult =
  | ({ valid: true } & IssuedDeviceToken)
  | TokenFailure

export type PairingVerificationResult = 'valid' | 'invalid' | 'rate_limited'

const DEFAULT_LOGGER: LanBridgeAuthLogger = {
  warn: message => console.warn(message),
}

/** 固定持有设备仓库的进程级认证服务。 */
export class LanBridgeAuthService {
  private currentPin = ''
  /** 服务实例生命周期内固定的 Token 签名密钥。 */
  private readonly hmacKey = randomBytes(32).toString('hex')
  private readonly pairingAttempts = new Map<string, PairingAttemptState>()
  private readonly pairingTickets = new Map<string, PairingTicketState>()

  /**
   * 创建隔离认证服务。
   *
   * @param deviceStore 当前服务生命周期内唯一设备仓库
   * @param logger 安全警告 logger
   */
  constructor(
    private readonly deviceStore: LanBridgeDeviceStore,
    private readonly logger: LanBridgeAuthLogger = DEFAULT_LOGGER,
  ) {
    this.initialize()
  }

  /** 轮换 PIN 并清理进程内临时状态，保留 HMAC 和设备仓库。 */
  initialize(): string {
    /** 轮换前的 PIN，用于保证旧 PIN 在重启后失效。 */
    const previousPin = this.currentPin
    do {
      this.currentPin = generatePin()
    } while (this.currentPin === previousPin)
    this.pairingAttempts.clear()
    this.pairingTickets.clear()
    return this.currentPin
  }

  /** 返回当前配对 PIN。 */
  getCurrentPin(): string {
    return this.currentPin
  }

  /** 只刷新 PIN 和失败窗口，不影响 HMAC 或已配对设备。 */
  refreshPin(): string {
    /** 刷新前的 PIN，用于保证旧 PIN 立即失效。 */
    const previousPin = this.currentPin
    do {
      this.currentPin = generatePin()
    } while (this.currentPin === previousPin)
    this.pairingAttempts.clear()
    console.log('[LAN Bridge] PIN 码已刷新')
    return this.currentPin
  }

  /** 使用常量时间比较验证 PIN。 */
  verifyPin(pin: string): boolean {
    /** 客户端提交的 PIN 字节。 */
    const submitted = Buffer.from(pin)
    /** 当前 PIN 字节。 */
    const expected = Buffer.from(this.currentPin)
    return submitted.length === expected.length && timingSafeEqual(submitted, expected)
  }

  /** 按 IP 验证 PIN 并复用统一失败窗口。 */
  verifyPairingPin(pin: string, ip: string, now = Date.now()): PairingVerificationResult {
    this.cleanupPairingAttempts(now)
    if (this.isPairingRateLimited(ip)) return 'rate_limited'
    if (this.verifyPin(pin)) {
      this.pairingAttempts.delete(ip)
      return 'valid'
    }
    this.recordPairingFailure(ip, now)
    return 'invalid'
  }

  /** 创建 120 秒有效且进程内有界的一次性票据。 */
  createPairingTicket(now = Date.now()): PairingTicket {
    this.cleanupPairingTickets(now)
    while (this.pairingTickets.size >= MAX_PAIRING_TICKETS) {
      /** Map 中最早签发的票据。 */
      const oldestTicket = this.pairingTickets.keys().next().value as string | undefined
      if (!oldestTicket) break
      this.pairingTickets.delete(oldestTicket)
    }
    /** 由 32 字节密码学随机数生成的票据值。 */
    const value = randomBytes(32).toString('base64url')
    /** 当前票据失效时间。 */
    const expiresAt = now + PAIRING_TICKET_EXPIRY_MS
    this.pairingTickets.set(value, { expiresAt })
    return { value, expiresAt }
  }

  /** 原子消费票据，并按 IP 复用配对失败限速窗口。 */
  consumePairingTicket(
    value: string,
    ip: string,
    deviceName: string,
    now = Date.now(),
    deviceId?: string,
  ): IssuedTrustedDevice {
    this.cleanupPairingAttempts(now)
    if (this.isPairingRateLimited(ip)) throwProtocolError('RATE_LIMITED')

    /** 消费前读取的票据状态。 */
    const ticket = this.pairingTickets.get(value)
    if (!ticket) {
      this.recordPairingFailure(ip, now)
      throwProtocolError('PAIRING_TICKET_INVALID')
    }

    // 先删除再注册设备，后续持久化或签名失败也不能重放。
    this.pairingTickets.delete(value)
    if (now >= ticket.expiresAt) {
      this.recordPairingFailure(ip, now)
      throwProtocolError('PAIRING_TICKET_EXPIRED')
    }

    this.pairingAttempts.delete(ip)
    return this.generateToken(ip, deviceName, now, deviceId)
  }

  /** 注册可信设备并签发短期访问令牌和长期设备凭证。 */
  generateToken(
    ip: string,
    deviceName = 'LAN 设备',
    now = Date.now(),
    deviceId?: string,
  ): IssuedTrustedDevice {
    /** 当前设备的高熵长期凭证秘密。 */
    const credentialSecret = randomBytes(32).toString('base64url')
    /** 只写入设备仓库的长期凭证哈希。 */
    const credentialHash = hashDeviceCredentialSecret(credentialSecret)
    /** PIN 或票据配对注册或重新授权的可信设备。 */
    const device = this.deviceStore.registerTrustedDevice({
      deviceId,
      name: deviceName,
      credentialHash,
      ip,
    }, now)
    /** 当前客户端持有的版本化长期设备凭证。 */
    const deviceCredential = createDeviceCredential(device.id, credentialSecret)
    return { ...this.issueDeviceToken(device, now), deviceCredential }
  }

  /** 验证 Token 并返回认证设备和稳定错误码。 */
  verifyTokenDetails(token: string, ip: string, now = Date.now()): TokenVerificationResult {
    try {
      /** Token 必须恰好包含 payload 和签名两段。 */
      const parts = token.split('.')
      if (parts.length !== 2) return invalidToken('TOKEN_INVALID')
      /** base64url payload。 */
      const payloadB64 = parts[0]
      /** base64url HMAC 签名。 */
      const signature = parts[1]
      if (!payloadB64 || !signature) return invalidToken('TOKEN_INVALID')

      /** 当前 payload 的期望签名。 */
      const expectedSignature = this.sign(payloadB64)
      /** 客户端签名字节。 */
      const signatureBuffer = Buffer.from(signature)
      /** 期望签名字节。 */
      const expectedBuffer = Buffer.from(expectedSignature)
      if (signatureBuffer.length !== expectedBuffer.length) return invalidToken('TOKEN_INVALID')
      if (!timingSafeEqual(signatureBuffer, expectedBuffer)) return invalidToken('TOKEN_INVALID')

      /** 解析后的未知 payload。 */
      const parsed: unknown = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf-8'))
      if (!isTokenPayload(parsed)) return invalidToken('TOKEN_INVALID')
      /** 通过运行时字段验证的 payload。 */
      const payload = parsed

      /** 当前访问令牌按自身签发时间计算的失效时间。 */
      const tokenExpiresAt = payload.iat + ACCESS_TOKEN_EXPIRY_MS
      if (!Number.isFinite(tokenExpiresAt)) return invalidToken('TOKEN_INVALID')
      if (payload.iat - now > TOKEN_FUTURE_IAT_TOLERANCE_MS) return invalidToken('TOKEN_INVALID')
      if (now >= tokenExpiresAt) return invalidToken('TOKEN_EXPIRED')
      /** Token payload 对应的当前设备记录。 */
      const device = this.deviceStore.getDevice(payload.deviceId)
      if (!device || device.revokedAt !== undefined || device.tokenVersion !== payload.tokenVersion) {
        return invalidToken('DEVICE_REVOKED')
      }

      try {
        this.deviceStore.updateLastSeen(device.id, now, ip)
      } catch (error) {
        /** 安全摘要只保留错误类型，不包含异常消息或认证材料。 */
        const errorName = error instanceof Error ? error.name : 'UnknownError'
        this.warnSafely(`[LAN Bridge] 设备 ${device.id} 最近访问时间持久化失败（${errorName}）`)
      }
      return { valid: true, deviceId: device.id, expiresAt: tokenExpiresAt }
    } catch {
      return invalidToken('TOKEN_INVALID')
    }
  }

  /** 保留旧客户端使用的布尔验证接口。 */
  verifyToken(token: string, ip: string, now = Date.now()): boolean {
    return this.verifyTokenDetails(token, ip, now).valid
  }

  /** 验证旧 Token 后为同一设备刷新 Token，并保留具体失败码。 */
  refreshTokenDetails(token: string, ip: string, now = Date.now()): TokenRefreshResult {
    /** 旧 Token 的结构化验证结果。 */
    const verification = this.verifyTokenDetails(token, ip, now)
    if (!verification.valid) return verification
    /** 刷新 Token 时复用的已配对设备。 */
    const device = this.deviceStore.getDevice(verification.deviceId)
    if (!device) return invalidToken('DEVICE_REVOKED')
    return { valid: true, ...this.issueDeviceToken(device, now) }
  }

  /**
   * 使用长期设备凭证签发新的短期访问令牌。
   *
   * @param credential 移动端保存的版本化高熵设备凭证
   * @param ip 当前来源 IP，仅用于审计
   * @param now 当前时间戳
   * @returns 新访问令牌或稳定认证失败码
   */
  refreshDeviceCredential(
    credential: string,
    ip: string,
    now = Date.now(),
  ): TokenRefreshResult {
    /** 从长期凭证中解析出的设备 ID 和秘密。 */
    const parsed = parseDeviceCredential(credential)
    if (!parsed) return invalidToken('TOKEN_INVALID')
    /** 长期凭证对应的设备记录。 */
    const device = this.deviceStore.getDevice(parsed.deviceId)
    if (!device || device.revokedAt !== undefined) return invalidToken('DEVICE_REVOKED')
    /** 设备仓库中只保存的预期凭证哈希。 */
    const expectedHash = this.deviceStore.getCredentialHash(parsed.deviceId)
    if (!expectedHash) return invalidToken('TOKEN_INVALID')
    /** 客户端秘密计算得到的候选哈希。 */
    const candidateHash = hashDeviceCredentialSecret(parsed.secret)
    /** 两个固定长度哈希的字节表示。 */
    const expectedBuffer = Buffer.from(expectedHash)
    const candidateBuffer = Buffer.from(candidateHash)
    if (candidateBuffer.length !== expectedBuffer.length
      || !timingSafeEqual(candidateBuffer, expectedBuffer)) {
      return invalidToken('TOKEN_INVALID')
    }

    try {
      this.deviceStore.updateLastSeen(device.id, now, ip)
    } catch (error) {
      /** 安全摘要只保留错误类型，不包含异常消息或认证材料。 */
      const errorName = error instanceof Error ? error.name : 'UnknownError'
      this.warnSafely(`[LAN Bridge] 设备 ${device.id} 最近访问时间持久化失败（${errorName}）`)
    }
    return { valid: true, ...this.issueDeviceToken(device, now) }
  }

  /** 保留旧客户端使用的 nullable 刷新接口。 */
  refreshToken(token: string, ip: string, now = Date.now()): IssuedDeviceToken | null {
    /** 结构化刷新结果。 */
    const result = this.refreshTokenDetails(token, ip, now)
    if (!result.valid) return null
    /** 去除结构化判别字段后的旧响应。 */
    const { valid: _valid, ...issuedToken } = result
    return issuedToken
  }

  /** 列出当前服务固定仓库中的设备。 */
  listDevices(includeRevoked = false): LanBridgeDevice[] {
    return this.deviceStore.listDevices(includeRevoked)
  }

  /** 原子撤销当前服务固定仓库中的设备。 */
  revokeDevice(deviceId: string, now = Date.now()): LanBridgeDevice | undefined {
    return this.deviceStore.revokeDevice(deviceId, now)
  }

  /** 为已有设备签发 Token，刷新时不会重复注册。 */
  private issueDeviceToken(device: LanBridgeDevice, now: number): IssuedDeviceToken {
    /** 只绑定设备版本的短期访问令牌 payload。 */
    const payload: TokenPayload = {
      deviceId: device.id,
      tokenVersion: device.tokenVersion,
      iat: now,
    }
    /** 编码后的 payload。 */
    const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url')
    /** 当前访问令牌的固定短期失效时间。 */
    const expiresAt = now + ACCESS_TOKEN_EXPIRY_MS
    return {
      token: `${payloadB64}.${this.sign(payloadB64)}`,
      expiresIn: Math.max(0, expiresAt - now),
      expiresAt,
      deviceId: device.id,
    }
  }

  /** 为 Token payload 生成 HMAC-SHA256 签名。 */
  private sign(data: string): string {
    return createHmac('sha256', this.hmacKey).update(data).digest('base64url')
  }

  /** 记录非致命告警；自定义 logger 故障不能改变认证结果。 */
  private warnSafely(message: string): void {
    try {
      this.logger.warn(message)
    } catch (error) {
      /** logger 异常仅保留错误类型，避免异常消息泄漏外部数据。 */
      const errorName = error instanceof Error ? error.name : 'UnknownError'
      DEFAULT_LOGGER.warn(`[LAN Bridge] 认证警告日志写入失败（${errorName}）`)
    }
  }

  /** 清理已结束的配对失败窗口。 */
  private cleanupPairingAttempts(now: number): void {
    for (const [ip, state] of this.pairingAttempts) {
      if (now - state.windowStartedAt >= PAIRING_WINDOW_MS) this.pairingAttempts.delete(ip)
    }
  }

  /** 判断目标 IP 是否达到配对失败上限。 */
  private isPairingRateLimited(ip: string): boolean {
    return (this.pairingAttempts.get(ip)?.failures ?? 0) >= MAX_PAIRING_FAILURES
  }

  /** 记录目标 IP 的一次配对失败。 */
  private recordPairingFailure(ip: string, now: number): void {
    /** 仍在当前窗口内的失败状态。 */
    const previous = this.pairingAttempts.get(ip)
    this.pairingAttempts.set(ip, {
      windowStartedAt: previous?.windowStartedAt ?? now,
      failures: (previous?.failures ?? 0) + 1,
    })
  }

  /** 惰性清理过期票据，避免 Map 无界增长。 */
  private cleanupPairingTickets(now: number): void {
    for (const [value, ticket] of this.pairingTickets) {
      if (now >= ticket.expiresAt) this.pairingTickets.delete(value)
    }
  }
}

/** 创建固定持有单一设备仓库的隔离认证服务。 */
export function createLanBridgeAuthService(options: LanBridgeAuthServiceOptions = {}): LanBridgeAuthService {
  return new LanBridgeAuthService(
    options.deviceStore ?? new LanBridgeDeviceStore(),
    options.logger ?? DEFAULT_LOGGER,
  )
}

/** 创建首次调用才构造仓库和服务的进程级 getter。 */
export function createLanBridgeAuthServiceGetter(
  options: LanBridgeAuthServiceGetterOptions = {},
): () => LanBridgeAuthService {
  /** 当前 getter 固定复用的认证服务。 */
  let service: LanBridgeAuthService | undefined
  return () => {
    if (!service) {
      /** 首次调用时才创建的固定设备仓库。 */
      const deviceStore = (options.deviceStoreFactory ?? (() => new LanBridgeDeviceStore()))()
      service = createLanBridgeAuthService({ deviceStore, logger: options.logger })
    }
    return service
  }
}

/** 生产进程唯一认证服务的惰性 getter。 */
const getProductionLanBridgeAuthService = createLanBridgeAuthServiceGetter()

/** 获取生产认证服务；Bridge stop/start 始终复用同一实例和仓库。 */
export function getLanBridgeAuthService(): LanBridgeAuthService {
  return getProductionLanBridgeAuthService()
}

/** 轮换生产认证凭据；保留旧模块 facade。 */
export function initAuth(): string {
  return getLanBridgeAuthService().initialize()
}

/** 获取生产服务当前 PIN。 */
export function getCurrentPin(): string {
  return getLanBridgeAuthService().getCurrentPin()
}

/** 刷新生产服务 PIN。 */
export function refreshPin(): string {
  return getLanBridgeAuthService().refreshPin()
}

/** 验证生产服务 PIN。 */
export function verifyPin(pin: string): boolean {
  return getLanBridgeAuthService().verifyPin(pin)
}

/** 按 IP 验证生产服务 PIN。 */
export function verifyPairingPin(pin: string, ip: string, now = Date.now()): PairingVerificationResult {
  return getLanBridgeAuthService().verifyPairingPin(pin, ip, now)
}

/** 创建生产服务的一次性票据。 */
export function createPairingTicket(now = Date.now()): PairingTicket {
  return getLanBridgeAuthService().createPairingTicket(now)
}

/** 消费生产服务的一次性票据。 */
export function consumePairingTicket(
  value: string,
  ip: string,
  deviceName: string,
  now = Date.now(),
  deviceId?: string,
): IssuedTrustedDevice {
  return getLanBridgeAuthService().consumePairingTicket(value, ip, deviceName, now, deviceId)
}

/** 使用生产服务注册设备并签发 Token。 */
export function generateToken(
  ip: string,
  deviceName = 'LAN 设备',
  now = Date.now(),
  deviceId?: string,
): IssuedTrustedDevice {
  return getLanBridgeAuthService().generateToken(ip, deviceName, now, deviceId)
}

/** 使用生产服务验证 Token。 */
export function verifyTokenDetails(token: string, ip: string, now = Date.now()): TokenVerificationResult {
  return getLanBridgeAuthService().verifyTokenDetails(token, ip, now)
}

/** 保留旧布尔 Token 验证 facade。 */
export function verifyToken(token: string, ip: string, now = Date.now()): boolean {
  return getLanBridgeAuthService().verifyToken(token, ip, now)
}

/** 保留旧 nullable Token 刷新 facade。 */
export function refreshToken(token: string, ip: string, now = Date.now()): IssuedDeviceToken | null {
  return getLanBridgeAuthService().refreshToken(token, ip, now)
}

/** 删除旧版本落盘的明文 PIN 文件。 */
export function removeLegacyPinFile(configDir: string): boolean {
  try {
    rmSync(join(configDir, 'lan-bridge-pin.txt'), { force: true })
    return true
  } catch {
    return false
  }
}

/** 生成六位随机 PIN。 */
function generatePin(): string {
  const digits = '0123456789'
  /** 生成 PIN 使用的随机字节。 */
  const bytes = randomBytes(PIN_LENGTH)
  /** 正在构造的 PIN。 */
  let pin = ''
  for (let index = 0; index < PIN_LENGTH; index++) {
    pin += digits[bytes[index]! % digits.length]
  }
  return pin
}

/** 判断未知值是否为完整安全的 Token payload。 */
function isTokenPayload(value: unknown): value is TokenPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  /** 待验证 payload 字段。 */
  const candidate = value as Record<string, unknown>
  return typeof candidate.deviceId === 'string'
    && candidate.deviceId.length > 0
    && candidate.deviceId.length <= MAX_TOKEN_DEVICE_ID_LENGTH
    && Number.isSafeInteger(candidate.tokenVersion)
    && (candidate.tokenVersion as number) > 0
    && typeof candidate.iat === 'number'
    && Number.isFinite(candidate.iat)
    && candidate.iat >= 0
}

/** 从设备 ID 和高熵秘密构造版本化长期凭证。 */
function createDeviceCredential(deviceId: string, secret: string): string {
  /** 避免设备 ID 中的分隔符影响凭证解析。 */
  const encodedDeviceId = Buffer.from(deviceId).toString('base64url')
  return `${DEVICE_CREDENTIAL_VERSION}.${encodedDeviceId}.${secret}`
}

/** 解析并严格校验版本化长期设备凭证。 */
function parseDeviceCredential(
  credential: string,
): { deviceId: string; secret: string } | null {
  /** 长期凭证必须恰好包含版本、设备 ID 和秘密三段。 */
  const parts = credential.split('.')
  if (parts.length !== 3 || parts[0] !== DEVICE_CREDENTIAL_VERSION) return null
  /** base64url 编码的稳定设备标识。 */
  const encodedDeviceId = parts[1]
  /** 固定长度的高熵设备秘密。 */
  const secret = parts[2]
  if (!encodedDeviceId || !secret || secret.length !== DEVICE_CREDENTIAL_SECRET_LENGTH) return null
  if (!/^[A-Za-z0-9_-]+$/.test(encodedDeviceId) || !/^[A-Za-z0-9_-]+$/.test(secret)) return null
  try {
    /** 解码后的稳定设备标识。 */
    const deviceId = Buffer.from(encodedDeviceId, 'base64url').toString('utf-8')
    if (!deviceId || deviceId.length > MAX_TOKEN_DEVICE_ID_LENGTH) return null
    /** 重新编码必须一致，拒绝非规范 base64url 表示。 */
    if (Buffer.from(deviceId).toString('base64url') !== encodedDeviceId) return null
    return { deviceId, secret }
  } catch {
    return null
  }
}

/** 对高熵长期设备秘密计算固定长度 SHA-256 哈希。 */
function hashDeviceCredentialSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('base64url')
}

/** 创建结构化 Token 失败结果。 */
function invalidToken(
  errorCode: 'TOKEN_INVALID' | 'TOKEN_EXPIRED' | 'DEVICE_REVOKED',
): TokenFailure {
  return { valid: false, errorCode }
}

/** 抛出携带稳定协议错误码的认证错误。 */
function throwProtocolError(
  errorCode: 'RATE_LIMITED' | 'PAIRING_TICKET_INVALID' | 'PAIRING_TICKET_EXPIRED',
): never {
  throw Object.assign(new Error(errorCode), { errorCode })
}
