import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as auth from './lan-bridge-auth'
import { LanBridgeDeviceStore } from './lan-bridge-device-store'

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
    expect(auth.verifyToken(result.token, '192.168.1.8', 86_401_001)).toBe(false)
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
