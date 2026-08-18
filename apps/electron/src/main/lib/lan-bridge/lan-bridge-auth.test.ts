import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { WebSocket } from 'ws'
import {
  createLanBridgeAuthService,
  createLanBridgeAuthServiceGetter,
} from './lan-bridge-auth'
import type { LanBridgeAuthService } from './lan-bridge-auth'
import { LanBridgeDeviceStore } from './lan-bridge-device-store'
import { LanBridgeSessionManager } from './lan-bridge-session'

/** 单个认证测试的隔离服务与设备仓库。 */
interface AuthTestHarness {
  store: LanBridgeDeviceStore
  service: LanBridgeAuthService
}

/** 当前测试创建的临时目录，避免设备记录污染真实用户配置。 */
const temporaryDirectories: string[] = []

/** 初始化使用临时设备仓库的认证模块。 */
function initTestAuth(logger?: { warn: (message: string) => void }): AuthTestHarness {
  /** 当前用例独占的配置目录。 */
  const configDir = mkdtempSync(join(tmpdir(), 'proma-lan-auth-'))
  temporaryDirectories.push(configDir)
  /** 当前用例的设备仓库。 */
  const store = new LanBridgeDeviceStore(configDir)
  /** 使用隔离仓库创建的认证服务。 */
  const service = createTestAuthService(store, logger)
  if (!service) throw new Error('认证服务工厂不可用')
  service.initialize()
  return { store, service }
}

/** 创建由测试统一回收的隔离设备仓库。 */
function createIsolatedDeviceStore(prefix: string): LanBridgeDeviceStore {
  /** 当前用例独占的配置目录。 */
  const configDir = mkdtempSync(join(tmpdir(), prefix))
  temporaryDirectories.push(configDir)
  return new LanBridgeDeviceStore(configDir)
}

/** 创建隔离设备仓库使用的认证服务；接口缺失时返回 undefined 触发红灯。 */
function createTestAuthService(
  store: LanBridgeDeviceStore,
  logger?: { warn: (message: string) => void },
): LanBridgeAuthService {
  return createLanBridgeAuthService({ deviceStore: store, logger })
}

/** 捕获协议错误码，避免测试依赖错误文案。 */
function captureErrorCode(callback: () => unknown): string | undefined {
  try {
    callback()
    return undefined
  } catch (error) {
    return (error as { errorCode?: string }).errorCode
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('LAN Bridge PIN 配对限速', () => {
  test('同一 IP 连续失败后拒绝继续尝试，并在窗口结束后恢复', () => {
    /** 当前用例的隔离认证服务。 */
    const { service } = initTestAuth()
    const startedAt = 1_000
    for (let attempt = 0; attempt < 5; attempt++) {
      expect(service.verifyPairingPin('wrong-pin', '192.168.1.9', startedAt + attempt)).toBe('invalid')
    }
    expect(service.verifyPairingPin('wrong-pin', '192.168.1.9', startedAt + 5)).toBe('rate_limited')
    expect(service.verifyPairingPin('wrong-pin', '192.168.1.10', startedAt + 5)).toBe('invalid')
    expect(service.verifyPairingPin('wrong-pin', '192.168.1.9', startedAt + 60_001)).toBe('invalid')
  })
})

describe('LAN Bridge 一次性配对票据', () => {
  test('刷新二维码签发新票据时旧票据继续保留到自身 TTL', () => {
    /** 当前用例的隔离认证服务。 */
    const { service } = initTestAuth()
    /** 首次展示二维码签发的旧票据。 */
    const previousTicket = service.createPairingTicket(1_000)
    /** 用户刷新二维码后签发的新票据。 */
    const refreshedTicket = service.createPairingTicket(2_000)

    expect(service.consumePairingTicket(previousTicket.value, '192.168.1.8', 'iPhone', 3_000).token)
      .toBeString()
    expect(service.consumePairingTicket(refreshedTicket.value, '192.168.1.9', 'Android', 3_000).token)
      .toBeString()
  })

  test('票据在 120 秒内可消费且只能成功一次', () => {
    /** 当前用例的隔离认证服务。 */
    const { service } = initTestAuth()
    /** 固定时间签发的一次性票据。 */
    const ticket = service.createPairingTicket(1_000)

    expect(ticket.value).toHaveLength(43)
    expect(ticket.expiresAt).toBe(121_000)
    expect(typeof service.consumePairingTicket(ticket.value, '192.168.1.8', 'iPhone', 120_999).token).toBe('string')
    expect(() => service.consumePairingTicket(ticket.value, '192.168.1.8', 'iPhone', 121_000))
      .toThrow('PAIRING_TICKET_INVALID')
  })

  test('过期票据和未知票据返回稳定协议错误码', () => {
    /** 当前用例的隔离认证服务。 */
    const { service } = initTestAuth()
    /** 即将过期的一次性票据。 */
    const ticket = service.createPairingTicket(1_000)

    expect(() => service.consumePairingTicket(ticket.value, '192.168.1.8', 'iPhone', 121_000))
      .toThrow('PAIRING_TICKET_EXPIRED')
    expect(() => service.consumePairingTicket('unknown', '192.168.1.8', 'iPhone', 1_001))
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
    /** 当前用例的隔离认证服务。 */
    const service = createTestAuthService(failingStore)!
    service.initialize()
    /** 消费后将遇到持久化失败的票据。 */
    const ticket = service.createPairingTicket(1_000)

    expect(() => service.consumePairingTicket(ticket.value, '192.168.1.8', 'iPhone', 1_001))
      .toThrow('disk failure')
    expect(() => service.consumePairingTicket(ticket.value, '192.168.1.8', 'iPhone', 1_002))
      .toThrow('PAIRING_TICKET_INVALID')
  })
})

describe('LAN Bridge 设备 Token', () => {
  test('PIN 配对路径签发绑定设备和 IP 的 24 小时 Token', () => {
    /** 当前用例的设备仓库。 */
    const { store, service } = initTestAuth()
    /** PIN 配对路径签发的设备 Token。 */
    const result = service.generateToken('192.168.1.8', 'iPhone', 1_000)

    expect(result.expiresIn).toBe(24 * 60 * 60 * 1_000)
    expect(result.expiresAt).toBe(86_401_000)
    expect(store.listDevices()).toHaveLength(1)
    expect(service.verifyTokenDetails(result.token, '192.168.1.8', 86_400_999)).toMatchObject({
      valid: true,
      deviceId: store.listDevices()[0]?.id,
      expiresAt: 86_401_000,
    })
    expect(service.verifyToken(result.token, '192.168.1.9', 1_001)).toBe(false)
    expect(service.verifyToken(result.token, '192.168.1.8', 86_401_000)).toBe(false)
    expect(service.verifyToken(result.token, '192.168.1.8', 86_401_001)).toBe(false)
  })

  test('连续刷新不能越过首次配对后的 24 小时绝对期限', () => {
    /** 当前用例的隔离认证服务。 */
    const { service } = initTestAuth()
    /** 首次配对时刻。 */
    const pairedAt = 1_000
    /** 首次配对后不可延长的绝对失效时间。 */
    const absoluteExpiresAt = pairedAt + 24 * 60 * 60 * 1_000
    /** 首次配对签发的设备 Token。 */
    const initialToken = service.generateToken('192.168.1.8', 'iPhone', pairedAt)

    /** 配对 12 小时后的首次刷新结果。 */
    const firstRefresh = service.refreshTokenDetails(
      initialToken.token,
      '192.168.1.8',
      pairedAt + 12 * 60 * 60 * 1_000,
    )
    expect(firstRefresh.valid).toBe(true)
    if (!firstRefresh.valid) throw new Error('首次刷新失败')
    expect(firstRefresh.expiresAt).toBe(absoluteExpiresAt)
    expect(firstRefresh.expiresIn).toBe(12 * 60 * 60 * 1_000)

    /** 绝对期限前一秒的连续刷新结果。 */
    const secondRefresh = service.refreshTokenDetails(
      firstRefresh.token,
      '192.168.1.8',
      absoluteExpiresAt - 1_000,
    )
    expect(secondRefresh.valid).toBe(true)
    if (!secondRefresh.valid) throw new Error('连续刷新失败')
    expect(secondRefresh.expiresAt).toBe(absoluteExpiresAt)
    expect(secondRefresh.expiresIn).toBe(1_000)
    expect(service.verifyTokenDetails(
      secondRefresh.token,
      '192.168.1.8',
      absoluteExpiresAt,
    )).toEqual({ valid: false, errorCode: 'TOKEN_EXPIRED' })
    expect(service.refreshTokenDetails(
      secondRefresh.token,
      '192.168.1.8',
      absoluteExpiresAt,
    )).toEqual({ valid: false, errorCode: 'TOKEN_EXPIRED' })
  })

  test('PIN 认证签发的真实设备 Token 可让 SessionManager 记录 deviceId', () => {
    /** 当前用例的真实设备仓库。 */
    const { store, service } = initTestAuth()
    /** 当前 PIN 通过既有配对认证入口的结果。 */
    const pairingResult = service.verifyPairingPin(service.getCurrentPin(), '192.168.1.8')
    expect(pairingResult).toBe('valid')
    /** PIN 配对成功后按现有 handler 路径签发的设备 Token。 */
    const token = service.generateToken('192.168.1.8', 'iPhone').token
    /** 使用生产默认 Token 验证器的会话管理器。 */
    const manager = new LanBridgeSessionManager(20, {
      uuid: () => 'client-1',
      verifyToken: (candidate, ip) => service.verifyTokenDetails(candidate, ip),
    })
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
    /** 当前用例捕获的安全 warning，不修改全局 console。 */
    const warnings: string[] = []
    /** 当前用例独占的配置目录。 */
    const configDir = mkdtempSync(join(tmpdir(), 'proma-lan-auth-last-seen-'))
    temporaryDirectories.push(configDir)
    /** 注册成功、首次 lastSeen 写失败、下次恢复的设备仓库。 */
    const store = new LanBridgeDeviceStore(configDir, {
      writeJson: () => {
        writeCount++
        if (writeCount === 2) throw new Error('token=secret-credential')
      },
      uuid: () => 'device-1',
    })
    /** 当前用例的隔离认证服务。 */
    const service = createTestAuthService(store, { warn: message => warnings.push(message) })!
    service.initialize()
    /** 用于触发节流持久化的设备 Token。 */
    const result = service.generateToken('192.168.1.8', 'iPhone', 1_000)

    expect(service.verifyTokenDetails(result.token, '192.168.1.8', 61_000)).toEqual({
      valid: true,
      deviceId: 'device-1',
      expiresAt: 86_401_000,
    })
    expect(warnings).toEqual(['[LAN Bridge] 设备 device-1 最近访问时间持久化失败（Error）'])
    expect(warnings[0]).not.toContain('secret-credential')
    expect(warnings[0]).not.toContain(result.token)
    expect(service.verifyTokenDetails(result.token, '192.168.1.8', 61_001)).toEqual({
      valid: true,
      deviceId: 'device-1',
      expiresAt: 86_401_000,
    })
    expect(writeCount).toBe(3)
    expect(warnings).toHaveLength(1)
  })

  test('最近访问失败时 logger 自身异常不应否定合法 Token', () => {
    /** 当前用例累计的原子写入次数。 */
    let writeCount = 0
    /** 当前用例独占的配置目录。 */
    const configDir = mkdtempSync(join(tmpdir(), 'proma-lan-auth-logger-'))
    temporaryDirectories.push(configDir)
    /** 注册成功但最近访问持久化失败的设备仓库。 */
    const store = new LanBridgeDeviceStore(configDir, {
      writeJson: () => {
        writeCount++
        if (writeCount === 2) throw new Error('disk failure')
      },
      uuid: () => 'device-1',
    })
    /** 模拟日志设施异常的认证服务。 */
    const service = createTestAuthService(store, {
      warn: () => { throw new Error('logger failure') },
    })
    /** 当前设备签发的 Token。 */
    const issued = service.generateToken('192.168.1.8', 'iPhone', 1_000)

    expect(service.verifyTokenDetails(issued.token, '192.168.1.8', 61_000)).toEqual({
      valid: true,
      deviceId: 'device-1',
      expiresAt: 86_401_000,
    })
  })

  test('设备撤销后旧 Token 立即失效', () => {
    /** 当前用例的设备仓库。 */
    const { store, service } = initTestAuth()
    /** 撤销前签发的设备 Token。 */
    const result = service.generateToken('192.168.1.8', 'iPhone', 1_000)
    /** Token 对应的设备。 */
    const device = store.listDevices()[0]!

    store.revokeDevice(device.id, 2_000)

    expect(service.verifyTokenDetails(result.token, '192.168.1.8', 2_001)).toEqual({
      valid: false,
      errorCode: 'DEVICE_REVOKED',
    })
  })
})

describe('LanBridgeAuthService 生命周期与协议安全', () => {
  test('真实模块 import 不触碰用户目录且生产 getter 全进程只返回一个实例', () => {
    /** 当前子进程使用的隔离 HOME。 */
    const isolatedHome = mkdtempSync(join(tmpdir(), 'proma-auth-import-'))
    temporaryDirectories.push(isolatedHome)
    /** 认证核心模块的绝对 URL。 */
    const authModuleUrl = pathToFileURL(join(import.meta.dir, 'lan-bridge-auth.ts')).href
    /** 子进程内验证 import 前后目录状态和生产实例身份的脚本。 */
    const script = `
      import { existsSync } from 'node:fs'
      import { homedir } from 'node:os'
      import { join } from 'node:path'
      import { getLanBridgeAuthService } from ${JSON.stringify(authModuleUrl)}
      const configDir = join(homedir(), '.proma')
      const existsBeforeGetter = existsSync(configDir)
      const firstService = getLanBridgeAuthService()
      const secondService = getLanBridgeAuthService()
      console.log(JSON.stringify({
        existsBeforeGetter,
        existsAfterGetter: existsSync(configDir),
        sameService: firstService === secondService,
      }))
    `
    /** 隔离 HOME 中执行认证模块导入的子进程结果。 */
    const result = Bun.spawnSync({
      cmd: [process.execPath, '-e', script],
      cwd: process.cwd(),
      env: { ...process.env, HOME: isolatedHome },
      stderr: 'pipe',
      stdout: 'pipe',
    })
    /** 子进程最后一行的结构化验证结果。 */
    const output = new TextDecoder().decode(result.stdout).trim().split('\n').at(-1)

    expect(result.exitCode).toBe(0)
    expect(output ? JSON.parse(output) : undefined).toEqual({
      existsBeforeGetter: false,
      existsAfterGetter: true,
      sameService: true,
    })
  })

  test('生产 getter 未使用前不创建默认仓库且首次使用只创建一次', () => {
    /** 当前用例累计的设备仓库工厂调用次数。 */
    let storeFactoryCalls = 0
    /** 使用生产同款惰性策略的认证服务 getter。 */
    const getService = createLanBridgeAuthServiceGetter({
      deviceStoreFactory: () => {
        storeFactoryCalls++
        return createIsolatedDeviceStore('proma-lazy-auth-')
      },
    })

    expect(storeFactoryCalls).toBe(0)
    expect(temporaryDirectories).toEqual([])
    /** 首次获取的认证服务。 */
    const firstService = getService()
    expect(storeFactoryCalls).toBe(1)
    expect(temporaryDirectories).toHaveLength(1)
    expect(getService()).toBe(firstService)
    expect(storeFactoryCalls).toBe(1)
  })

  test('Bridge 重启只轮换临时配对状态并保留已配对设备 Token', () => {
    /** 当前用例的隔离设备仓库。 */
    const { store } = initTestAuth()
    /** 当前用例的认证服务。 */
    const service = createTestAuthService(store)
    expect(service).toBeDefined()

    service!.initialize()
    /** 重启前的 PIN。 */
    const oldPin = service!.getCurrentPin()
    /** 首轮凭据签发的 Token。 */
    const oldToken = service!.generateToken('192.168.1.8', 'iPhone', 1_000).token
    /** 重启前签发的一次性配对票据。 */
    const oldTicket = service!.createPairingTicket(1_000)
    /** 首轮注册的设备 ID。 */
    const deviceId = service!.listDevices()[0]?.id
    service!.initialize()

    expect(service!.listDevices()[0]?.id).toBe(deviceId)
    expect(service!.verifyPin(oldPin)).toBe(false)
    expect(captureErrorCode(() => (
      service!.consumePairingTicket(oldTicket.value, '192.168.1.8', 'iPad', 1_001)
    ))).toBe('PAIRING_TICKET_INVALID')
    expect(service!.verifyTokenDetails(oldToken, '192.168.1.8', 1_001)).toMatchObject({
      valid: true,
      deviceId,
    })
  })

  test('无效和过期票据按 IP 限速，窗口重置且不影响其他 IP 的合法票据', () => {
    /** 当前用例的认证服务。 */
    const service = createTestAuthService(createIsolatedDeviceStore('proma-ticket-rate-'))
    expect(service).toBeDefined()
    service!.initialize()
    /** 用于制造过期失败的票据。 */
    const expiredTicket = service!.createPairingTicket(1_000)

    expect(captureErrorCode(() => (
      service!.consumePairingTicket(expiredTicket.value, '192.168.1.8', 'iPhone', 121_000)
    ))).toBe('PAIRING_TICKET_EXPIRED')
    for (let attempt = 0; attempt < 4; attempt++) {
      expect(captureErrorCode(() => (
        service!.consumePairingTicket(`invalid-${attempt}`, '192.168.1.8', 'iPhone', 121_001 + attempt)
      ))).toBe('PAIRING_TICKET_INVALID')
    }
    /** 等待同一 IP 限速窗口重置的合法票据。 */
    const resetTicket = service!.createPairingTicket(121_005)
    expect(captureErrorCode(() => (
      service!.consumePairingTicket(resetTicket.value, '192.168.1.8', 'iPhone', 121_010)
    ))).toBe('RATE_LIMITED')

    /** 其他 IP 使用的合法票据。 */
    const otherIpTicket = service!.createPairingTicket(121_010)
    expect(typeof service!.consumePairingTicket(
      otherIpTicket.value,
      '192.168.1.9',
      'iPhone',
      121_011,
    ).token).toBe('string')
    expect(typeof service!.consumePairingTicket(
      resetTicket.value,
      '192.168.1.8',
      'iPhone',
      181_001,
    ).token).toBe('string')
  })

  test('Token 拒绝额外段和超出容差的未来签发时间', () => {
    /** 当前用例的认证服务。 */
    const service = createTestAuthService(createIsolatedDeviceStore('proma-token-format-'))
    expect(service).toBeDefined()
    service!.initialize()
    /** 正常签发的设备 Token。 */
    const token = service!.generateToken('192.168.1.8', 'iPhone', 100_000).token

    expect(service!.verifyTokenDetails(`${token}.extra`, '192.168.1.8', 100_001)).toMatchObject({
      valid: false,
      errorCode: 'TOKEN_INVALID',
    })
    expect(service!.verifyTokenDetails(token, '192.168.1.8', 69_999)).toMatchObject({
      valid: false,
      errorCode: 'TOKEN_INVALID',
    })
    expect(service!.verifyTokenDetails(token, '192.168.1.8', 70_000)).toMatchObject({
      valid: true,
    })
  })
})
