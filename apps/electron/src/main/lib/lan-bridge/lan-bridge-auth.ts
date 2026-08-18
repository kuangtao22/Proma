/**
 * LAN Bridge 进程级认证服务。
 *
 * 单个服务固定持有一个设备仓库；Bridge 重启只轮换 PIN/HMAC 并清理内存票据。
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { LanBridgeDeviceStore } from './lan-bridge-device-store'
import type { LanBridgeDevice } from './lan-bridge-device-store'

const TOKEN_EXPIRY_MS = 24 * 60 * 60 * 1_000
export const TOKEN_FUTURE_IAT_TOLERANCE_MS = 30_000
const PAIRING_TICKET_EXPIRY_MS = 120_000
const MAX_PAIRING_TICKETS = 1_024
const PIN_LENGTH = 6
const PAIRING_WINDOW_MS = 60_000
const MAX_PAIRING_FAILURES = 5
const MAX_TOKEN_DEVICE_ID_LENGTH = 128
const MAX_TOKEN_IP_LENGTH = 128

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
  ip: string
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
  private hmacKey = ''
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

  /** 轮换 PIN/HMAC 并清理进程内临时状态，保留设备仓库。 */
  initialize(): string {
    this.currentPin = generatePin()
    this.hmacKey = randomBytes(32).toString('hex')
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
    this.currentPin = generatePin()
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
  ): IssuedDeviceToken {
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
    return this.generateToken(ip, deviceName, now)
  }

  /** 注册设备并签发绑定 IP 和设备版本的 Token。 */
  generateToken(ip: string, deviceName = 'LAN 设备', now = Date.now()): IssuedDeviceToken {
    /** PIN 或票据配对注册的新设备。 */
    const device = this.deviceStore.registerDevice(deviceName, now)
    return this.issueDeviceToken(device, ip, now)
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

      /** Token 的绝对失效时间。 */
      const expiresAt = payload.iat + TOKEN_EXPIRY_MS
      if (!Number.isFinite(expiresAt)) return invalidToken('TOKEN_INVALID')
      if (payload.iat - now > TOKEN_FUTURE_IAT_TOLERANCE_MS) return invalidToken('TOKEN_INVALID')
      if (now >= expiresAt) return invalidToken('TOKEN_EXPIRED')
      if (payload.ip !== ip) return invalidToken('TOKEN_INVALID')

      /** Token payload 对应的当前设备记录。 */
      const device = this.deviceStore.getDevice(payload.deviceId)
      if (!device || device.revokedAt !== undefined || device.tokenVersion !== payload.tokenVersion) {
        return invalidToken('DEVICE_REVOKED')
      }

      try {
        this.deviceStore.updateLastSeen(device.id, now)
      } catch (error) {
        /** 安全摘要只保留错误类型，不包含异常消息或认证材料。 */
        const errorName = error instanceof Error ? error.name : 'UnknownError'
        this.warnSafely(`[LAN Bridge] 设备 ${device.id} 最近访问时间持久化失败（${errorName}）`)
      }
      return { valid: true, deviceId: device.id, expiresAt }
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
    return { valid: true, ...this.issueDeviceToken(device, ip, now) }
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
  private issueDeviceToken(device: LanBridgeDevice, ip: string, now: number): IssuedDeviceToken {
    /** 带设备版本和 IP 绑定的 payload。 */
    const payload: TokenPayload = {
      deviceId: device.id,
      tokenVersion: device.tokenVersion,
      iat: now,
      ip,
    }
    /** 编码后的 payload。 */
    const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url')
    return {
      token: `${payloadB64}.${this.sign(payloadB64)}`,
      expiresIn: TOKEN_EXPIRY_MS,
      expiresAt: now + TOKEN_EXPIRY_MS,
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
): IssuedDeviceToken {
  return getLanBridgeAuthService().consumePairingTicket(value, ip, deviceName, now)
}

/** 使用生产服务注册设备并签发 Token。 */
export function generateToken(ip: string, deviceName = 'LAN 设备', now = Date.now()): IssuedDeviceToken {
  return getLanBridgeAuthService().generateToken(ip, deviceName, now)
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
    && typeof candidate.ip === 'string'
    && candidate.ip.length > 0
    && candidate.ip.length <= MAX_TOKEN_IP_LENGTH
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
