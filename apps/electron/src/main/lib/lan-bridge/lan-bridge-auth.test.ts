import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WebSocket } from 'ws'
import * as auth from './lan-bridge-auth'
import { LanBridgeDeviceStore } from './lan-bridge-device-store'
import { LanBridgeSessionManager } from './lan-bridge-session'

type PairingResult = 'valid' | 'invalid' | 'rate_limited'

/** 当前测试创建的临时目录，避免设备记录污染真实用户配置。 */
const temporaryDirectories: string[] = []

/** 初始化使用临时设备仓库的认证模块。 */
function initTestAuth(): LanBridgeDeviceStore {
  /** 当前用例独占的配置目录。 */
  const configDir = mkdtempSync(join(tmpdir(), 'proma-lan-auth-'))
  temporaryDirectories.push(configDir)
  /** 当前用例的设备仓库。 */
  const store = new LanBridgeDeviceStore(configDir)
  auth.initAuth(store)
  return store
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('LAN Bridge PIN 配对限速', () => {
  test('同一 IP 连续失败后拒绝继续尝试，并在窗口结束后恢复', () => {
    const verifyPairingPin = (auth as unknown as {
      verifyPairingPin?: (pin: string, ip: string, now?: number) => PairingResult
    }).verifyPairingPin

    expect(typeof verifyPairingPin).toBe('function')

    initTestAuth()
    const startedAt = 1_000
    for (let attempt = 0; attempt < 5; attempt++) {
      expect(verifyPairingPin?.('wrong-pin', '192.168.1.9', startedAt + attempt)).toBe('invalid')
    }
    expect(verifyPairingPin?.('wrong-pin', '192.168.1.9', startedAt + 5)).toBe('rate_limited')
    expect(verifyPairingPin?.('wrong-pin', '192.168.1.10', startedAt + 5)).toBe('invalid')
    expect(verifyPairingPin?.('wrong-pin', '192.168.1.9', startedAt + 60_001)).toBe('invalid')
  })
})

describe('LAN Bridge 一次性配对票据', () => {
  test('票据在 120 秒内可消费且只能成功一次', () => {
    initTestAuth()
    /** 固定时间签发的一次性票据。 */
    const ticket = auth.createPairingTicket(1_000)

    expect(ticket.value).toHaveLength(43)
    expect(ticket.expiresAt).toBe(121_000)
    expect(typeof auth.consumePairingTicket(ticket.value, '192.168.1.8', 'iPhone', 120_999).token).toBe('string')
    expect(() => auth.consumePairingTicket(ticket.value, '192.168.1.8', 'iPhone', 121_000))
      .toThrow('PAIRING_TICKET_INVALID')
  })

  test('过期票据和未知票据返回稳定协议错误码', () => {
    initTestAuth()
    /** 即将过期的一次性票据。 */
    const ticket = auth.createPairingTicket(1_000)

    expect(() => auth.consumePairingTicket(ticket.value, '192.168.1.8', 'iPhone', 121_000))
      .toThrow('PAIRING_TICKET_EXPIRED')
    expect(() => auth.consumePairingTicket('unknown', '192.168.1.8', 'iPhone', 1_001))
      .toThrow('PAIRING_TICKET_INVALID')
  })

  test('设备持久化失败后票据仍不可重放', () => {
    /** 当前用例独占的配置目录。 */
    const configDir = mkdtempSync(join(tmpdir(), 'proma-lan-auth-failure-'))
    temporaryDirectories.push(configDir)
    /** 模拟原子写失败的设备仓库。 */
    const failingStore = new LanBridgeDeviceStore(configDir, {
      writeJson: () => { throw new Error('disk failure') },
    })
    auth.initAuth(failingStore)
    /** 消费后将遇到持久化失败的票据。 */
    const ticket = auth.createPairingTicket(1_000)

    expect(() => auth.consumePairingTicket(ticket.value, '192.168.1.8', 'iPhone', 1_001))
      .toThrow('disk failure')
    expect(() => auth.consumePairingTicket(ticket.value, '192.168.1.8', 'iPhone', 1_002))
      .toThrow('PAIRING_TICKET_INVALID')
  })
})

describe('LAN Bridge 设备 Token', () => {
  test('PIN 配对路径签发绑定设备和 IP 的 24 小时 Token', () => {
    /** 当前用例的设备仓库。 */
    const store = initTestAuth()
    /** PIN 配对路径签发的设备 Token。 */
    const result = auth.generateToken('192.168.1.8', 'iPhone', 1_000)

    expect(result.expiresIn).toBe(24 * 60 * 60 * 1_000)
    expect(store.listDevices()).toHaveLength(1)
    expect(auth.verifyTokenDetails(result.token, '192.168.1.8', 86_400_999)).toMatchObject({
      valid: true,
      deviceId: store.listDevices()[0]?.id,
    })
    expect(auth.verifyToken(result.token, '192.168.1.9', 1_001)).toBe(false)
    expect(auth.verifyToken(result.token, '192.168.1.8', 86_401_000)).toBe(false)
    expect(auth.verifyToken(result.token, '192.168.1.8', 86_401_001)).toBe(false)
  })

  test('PIN 认证签发的真实设备 Token 可让 SessionManager 记录 deviceId', () => {
    /** 当前用例的真实设备仓库。 */
    const store = initTestAuth()
    /** 当前 PIN 通过既有配对认证入口的结果。 */
    const pairingResult = auth.verifyPairingPin(auth.getCurrentPin(), '192.168.1.8')
    expect(pairingResult).toBe('valid')
    /** PIN 配对成功后按现有 handler 路径签发的设备 Token。 */
    const token = auth.generateToken('192.168.1.8', 'iPhone').token
    /** 使用生产默认 Token 验证器的会话管理器。 */
    const manager = new LanBridgeSessionManager(20, { uuid: () => 'client-1' })
    /** 测试用最小 WebSocket。 */
    const socket = {
      readyState: 1,
      send: () => undefined,
      close: () => undefined,
      terminate: () => undefined,
    } as unknown as WebSocket
    /** 等待真实 Token 认证的客户端。 */
    const client = manager.addClient(socket, '192.168.1.8')!

    expect(manager.authenticateFromData(client, { token })).toBe(true)
    expect(client.deviceId).toBe(store.listDevices()[0]?.id)
  })

  test('lastSeen 原子写失败不改变 Token 认证结果且下次访问会重试', () => {
    /** 当前用例累计的原子写入次数。 */
    let writeCount = 0
    /** 当前用例独占的配置目录。 */
    const configDir = mkdtempSync(join(tmpdir(), 'proma-lan-auth-last-seen-'))
    temporaryDirectories.push(configDir)
    /** 注册成功、首次 lastSeen 写失败、下次恢复的设备仓库。 */
    const store = new LanBridgeDeviceStore(configDir, {
      writeJson: () => {
        writeCount++
        if (writeCount === 2) throw new Error('disk failure')
      },
      uuid: () => 'device-1',
    })
    auth.initAuth(store)
    /** 用于触发节流持久化的设备 Token。 */
    const result = auth.generateToken('192.168.1.8', 'iPhone', 1_000)

    expect(auth.verifyTokenDetails(result.token, '192.168.1.8', 61_000)).toEqual({
      valid: true,
      deviceId: 'device-1',
    })
    expect(auth.verifyTokenDetails(result.token, '192.168.1.8', 61_001)).toEqual({
      valid: true,
      deviceId: 'device-1',
    })
    expect(writeCount).toBe(3)
  })

  test('设备撤销后旧 Token 立即失效', () => {
    /** 当前用例的设备仓库。 */
    const store = initTestAuth()
    /** 撤销前签发的设备 Token。 */
    const result = auth.generateToken('192.168.1.8', 'iPhone', 1_000)
    /** Token 对应的设备。 */
    const device = store.listDevices()[0]!

    store.revokeDevice(device.id, 2_000)

    expect(auth.verifyTokenDetails(result.token, '192.168.1.8', 2_001)).toEqual({
      valid: false,
      errorCode: 'DEVICE_REVOKED',
    })
  })
})
