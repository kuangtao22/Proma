/**
 * LAN Bridge 认证管理
 *
 * PIN 码 + HMAC-SHA256 Token 认证。
 * PIN 在服务启动时生成，Token 绑定客户端 IP，24h 有效。
 */

import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { LanBridgeDeviceStore } from './lan-bridge-device-store'
import type { LanBridgeDevice } from './lan-bridge-device-store'

const TOKEN_EXPIRY_MS = 24 * 60 * 60 * 1000 // 24 hours
const PAIRING_TICKET_EXPIRY_MS = 120_000
const MAX_PAIRING_TICKETS = 1_024
const PIN_LENGTH = 6
const PAIRING_WINDOW_MS = 60_000
const MAX_PAIRING_FAILURES = 5

/** 单个 IP 的 PIN 配对失败窗口。 */
interface PairingAttemptState {
  windowStartedAt: number
  failures: number
}

export type PairingVerificationResult = 'valid' | 'invalid' | 'rate_limited'

/** Token payload 结构 */
interface TokenPayload {
  /** 已配对设备唯一标识 */
  deviceId: string
  /** 签发时的设备 Token 版本 */
  tokenVersion: number
  /** 签发时间 (ms) */
  iat: number
  /** 绑定的客户端 IP */
  ip: string
}

/** 一次性票据的内存状态。 */
interface PairingTicketState {
  expiresAt: number
}

/** 一次性配对票据。 */
export interface PairingTicket {
  /** 32 字节随机数的 base64url 表示。 */
  value: string
  /** 票据失效时间。 */
  expiresAt: number
}

/** 设备 Token 的结构化验证结果。 */
export type TokenVerificationResult =
  | { valid: true; deviceId: string }
  | { valid: false; errorCode?: 'TOKEN_INVALID' | 'TOKEN_EXPIRED' | 'DEVICE_REVOKED' }

/** 认证模块用于记录非致命持久化故障的安全 logger。 */
export interface LanBridgeAuthLogger {
  /** 记录不含凭据的中文警告。 */
  warn: (message: string) => void
}

const DEFAULT_LOGGER: LanBridgeAuthLogger = {
  warn: message => console.warn(message),
}

let currentPin = ''
let hmacKey = ''
const pairingAttempts = new Map<string, PairingAttemptState>()
const pairingTickets = new Map<string, PairingTicketState>()
let activeDeviceStore: LanBridgeDeviceStore | null = null
let activeLogger: LanBridgeAuthLogger = DEFAULT_LOGGER

/**
 * 初始化认证：生成 PIN 和 HMAC 密钥。
 *
 * @param deviceStore 已配对设备仓库
 * @param logger 仅记录无凭据警告的安全 logger
 * @returns 当前配对 PIN
 */
export function initAuth(
  deviceStore: LanBridgeDeviceStore = new LanBridgeDeviceStore(),
  logger: LanBridgeAuthLogger = DEFAULT_LOGGER,
): string {
  currentPin = generatePin()
  hmacKey = randomBytes(32).toString('hex')
  pairingAttempts.clear()
  pairingTickets.clear()
  activeDeviceStore = deviceStore
  activeLogger = logger
  return currentPin
}

/**
 * 删除旧版本落盘的明文 PIN 文件。
 *
 * @param configDir Proma 配置目录
 * @returns 是否完成清理；失败不会阻断 LAN Bridge 启动
 */
export function removeLegacyPinFile(configDir: string): boolean {
  try {
    rmSync(join(configDir, 'lan-bridge-pin.txt'), { force: true })
    return true
  } catch {
    return false
  }
}

/** 获取当前 PIN 码 */
export function getCurrentPin(): string {
  return currentPin
}

/** 刷新 PIN 码 */
export function refreshPin(): string {
  currentPin = generatePin()
  pairingAttempts.clear()
  console.log('[LAN Bridge] PIN 码已刷新')
  return currentPin
}

/** 验证 PIN 码 */
export function verifyPin(pin: string): boolean {
  const a = Buffer.from(pin)
  const b = Buffer.from(currentPin)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * 按客户端 IP 验证配对 PIN，并对连续失败进行独立限速。
 *
 * @param pin 客户端提交的 PIN
 * @param ip 客户端 IP
 * @param now 当前时间戳，测试可注入固定时间
 * @returns 配对结果
 */
export function verifyPairingPin(pin: string, ip: string, now = Date.now()): PairingVerificationResult {
  for (const [candidateIp, state] of pairingAttempts) {
    if (now - state.windowStartedAt >= PAIRING_WINDOW_MS) pairingAttempts.delete(candidateIp)
  }

  const previous = pairingAttempts.get(ip)
  if (previous && previous.failures >= MAX_PAIRING_FAILURES) return 'rate_limited'

  if (verifyPin(pin)) {
    pairingAttempts.delete(ip)
    return 'valid'
  }

  pairingAttempts.set(ip, {
    windowStartedAt: previous?.windowStartedAt ?? now,
    failures: (previous?.failures ?? 0) + 1,
  })
  return 'invalid'
}

/**
 * 创建 120 秒有效的一次性配对票据。
 *
 * @param now 当前时间戳
 * @returns 只保存在内存中的配对票据
 */
export function createPairingTicket(now = Date.now()): PairingTicket {
  cleanupPairingTickets(now)
  while (pairingTickets.size >= MAX_PAIRING_TICKETS) {
    /** Map 中最早签发的票据。 */
    const oldestTicket = pairingTickets.keys().next().value as string | undefined
    if (!oldestTicket) break
    pairingTickets.delete(oldestTicket)
  }
  /** 由 32 字节密码学随机数生成的票据值。 */
  const value = randomBytes(32).toString('base64url')
  /** 当前票据的失效时间。 */
  const expiresAt = now + PAIRING_TICKET_EXPIRY_MS
  pairingTickets.set(value, { expiresAt })
  return { value, expiresAt }
}

/**
 * 原子消费一次性票据并签发设备 Token。
 *
 * @param value 票据值
 * @param ip 客户端 IP
 * @param deviceName 设备显示名
 * @param now 当前时间戳
 * @returns 新设备的 Token
 */
export function consumePairingTicket(
  value: string,
  ip: string,
  deviceName: string,
  now = Date.now(),
): { token: string; expiresIn: number } {
  /** 消费前读取的票据状态。 */
  const ticket = pairingTickets.get(value)
  if (!ticket) throwPairingTicketError('PAIRING_TICKET_INVALID')

  // 先删除再执行注册和签名，后续任一步骤失败也不能重放票据。
  pairingTickets.delete(value)
  if (now >= ticket.expiresAt) throwPairingTicketError('PAIRING_TICKET_EXPIRED')
  return generateToken(ip, deviceName, now)
}

/**
 * 注册设备并生成 Token；保留原有仅传 IP 的 PIN 配对调用方式。
 *
 * @param ip 客户端 IP
 * @param deviceName 设备显示名
 * @param now 当前时间戳
 * @returns 24 小时有效的设备 Token
 */
export function generateToken(
  ip: string,
  deviceName = 'LAN 设备',
  now = Date.now(),
): { token: string; expiresIn: number } {
  /** PIN 或票据配对注册的新设备。 */
  const device = getDeviceStore().registerDevice(deviceName, now)
  return issueDeviceToken(device, ip, now)
}

/** 为已有设备签发 Token，避免刷新时重复注册设备。 */
function issueDeviceToken(
  device: LanBridgeDevice,
  ip: string,
  now: number,
): { token: string; expiresIn: number } {
  /** 带设备版本和 IP 绑定的 Token payload。 */
  const payload: TokenPayload = {
    deviceId: device.id,
    tokenVersion: device.tokenVersion,
    iat: now,
    ip,
  }
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const signature = sign(payloadB64)
  return {
    token: `${payloadB64}.${signature}`,
    expiresIn: TOKEN_EXPIRY_MS,
  }
}

/** 验证 Token，返回是否有效；保留旧调用方的布尔契约。 */
export function verifyToken(token: string, ip: string, now = Date.now()): boolean {
  return verifyTokenDetails(token, ip, now).valid
}

/**
 * 验证 Token 并返回认证设备。
 *
 * @param token 待验证 Token
 * @param ip 当前客户端 IP
 * @param now 当前时间戳
 * @returns 可供 SessionManager 记录设备的结构化结果
 */
export function verifyTokenDetails(token: string, ip: string, now = Date.now()): TokenVerificationResult {
  try {
    const [payloadB64, signature] = token.split('.')
    if (!payloadB64 || !signature) return { valid: false, errorCode: 'TOKEN_INVALID' }

    // 验证签名
    const expectedSig = sign(payloadB64)
    const sigBuf = Buffer.from(signature)
    const expectBuf = Buffer.from(expectedSig)
    if (sigBuf.length !== expectBuf.length) return { valid: false, errorCode: 'TOKEN_INVALID' }
    if (!timingSafeEqual(sigBuf, expectBuf)) return { valid: false, errorCode: 'TOKEN_INVALID' }

    // 解析 payload
    const payload: TokenPayload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf-8'))

    // 检查过期
    if (now - payload.iat >= TOKEN_EXPIRY_MS) return { valid: false, errorCode: 'TOKEN_EXPIRED' }

    // 检查 IP 绑定
    if (payload.ip !== ip) return { valid: false, errorCode: 'TOKEN_INVALID' }

    /** Token payload 对应的当前设备记录。 */
    const device = getDeviceStore().getDevice(payload.deviceId)
    if (!device || device.revokedAt !== undefined || device.tokenVersion !== payload.tokenVersion) {
      return { valid: false, errorCode: 'DEVICE_REVOKED' }
    }

    try {
      getDeviceStore().updateLastSeen(device.id, now)
    } catch (error) {
      /** 安全错误摘要只保留类型，不包含可能携带凭据的异常消息。 */
      const errorName = error instanceof Error ? error.name : 'UnknownError'
      activeLogger.warn(`[LAN Bridge] 设备 ${device.id} 最近访问时间持久化失败（${errorName}）`)
    }
    return { valid: true, deviceId: device.id }
  } catch {
    return { valid: false, errorCode: 'TOKEN_INVALID' }
  }
}

/** 刷新 Token（验证旧 Token 后签发新的） */
export function refreshToken(token: string, ip: string, now = Date.now()): { token: string; expiresIn: number } | null {
  /** 旧 Token 的结构化验证结果。 */
  const verification = verifyTokenDetails(token, ip, now)
  if (!verification.valid) return null
  /** 刷新 Token 时复用的已配对设备。 */
  const device = getDeviceStore().getDevice(verification.deviceId)
  return device ? issueDeviceToken(device, ip, now) : null
}

// ===== 内部工具 =====

function generatePin(): string {
  const digits = '0123456789'
  let pin = ''
  const bytes = randomBytes(PIN_LENGTH)
  for (let i = 0; i < PIN_LENGTH; i++) {
    pin += digits[bytes[i]! % digits.length]
  }
  return pin
}

function sign(data: string): string {
  return createHmac('sha256', hmacKey).update(data).digest('base64url')
}

/** 获取已初始化的设备仓库。 */
function getDeviceStore(): LanBridgeDeviceStore {
  if (!activeDeviceStore) activeDeviceStore = new LanBridgeDeviceStore()
  return activeDeviceStore
}

/** 惰性清理所有已过期票据，避免内存 Map 无界增长。 */
function cleanupPairingTickets(now: number): void {
  for (const [value, ticket] of pairingTickets) {
    if (now >= ticket.expiresAt) pairingTickets.delete(value)
  }
}

/** 抛出携带稳定协议错误码的一次性票据错误。 */
function throwPairingTicketError(errorCode: 'PAIRING_TICKET_INVALID' | 'PAIRING_TICKET_EXPIRED'): never {
  throw Object.assign(new Error(errorCode), { errorCode })
}
