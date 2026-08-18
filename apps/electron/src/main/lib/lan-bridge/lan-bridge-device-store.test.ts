import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createLanBridgeDeviceStoreDependencies,
  LanBridgeDeviceStore,
} from './lan-bridge-device-store'
import { readJsonFileSafe, writeJsonFileAtomic } from '../safe-file'

/** 当前测试创建的临时目录，测试结束后统一回收。 */
const temporaryDirectories: string[] = []

/** 创建隔离的 Proma 配置目录。 */
function createConfigDir(): string {
  /** 当前用例独占的配置目录。 */
  const configDir = mkdtempSync(join(tmpdir(), 'proma-lan-device-store-'))
  temporaryDirectories.push(configDir)
  return configDir
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('LAN Bridge 设备存储', () => {
  test('生产默认依赖直接绑定 safe-file 安全 JSON API', () => {
    /** 生产默认设备存储依赖。 */
    const dependencies = createLanBridgeDeviceStoreDependencies()

    expect(dependencies.writeJson).toBe(writeJsonFileAtomic)
    expect(dependencies.readJson).toBe(readJsonFileSafe)
  })

  test('生产默认写入具备原子 API 的备份行为且只持久化安全元数据', () => {
    /** 当前用例的配置目录。 */
    const configDir = createConfigDir()
    /** 仅固定 ID、保留生产默认安全读写依赖的设备仓库。 */
    const store = new LanBridgeDeviceStore(configDir, {
      uuid: () => 'device-1',
    })

    /** 在固定时间注册的设备。 */
    const device = store.registerDevice('iPhone', 1_000)

    expect(device).toEqual({
      id: 'device-1',
      name: 'iPhone',
      createdAt: 1_000,
      lastSeenAt: 1_000,
      tokenVersion: 1,
      revokedAt: undefined,
    })
    /** 生产设备文件路径。 */
    const filePath = join(configDir, 'lan-bridge-devices.json')
    expect(JSON.parse(readFileSync(filePath, 'utf-8'))).toEqual([device])
    expect(Object.keys(device).sort()).toEqual([
      'createdAt', 'id', 'lastSeenAt', 'name', 'revokedAt', 'tokenVersion',
    ])

    store.revokeDevice(device.id, 2_000)
    expect(existsSync(`${filePath}.bak`)).toBe(true)
    expect(JSON.parse(readFileSync(`${filePath}.bak`, 'utf-8'))).toEqual([device])
  })

  test('最后访问时间在 60 秒窗口内只更新内存，达到窗口后才持久化', () => {
    /** 当前用例累计的安全写入次数。 */
    let writeCount = 0
    /** 当前用例的设备仓库。 */
    const store = new LanBridgeDeviceStore(createConfigDir(), {
      writeJson: () => { writeCount++ },
      uuid: () => 'device-1',
    })
    store.registerDevice('iPhone', 1_000)

    store.updateLastSeen('device-1', 30_000)
    expect(writeCount).toBe(1)
    expect(store.getDevice('device-1')?.lastSeenAt).toBe(30_000)

    store.updateLastSeen('device-1', 61_000)
    expect(writeCount).toBe(2)
    expect(store.getDevice('device-1')?.lastSeenAt).toBe(61_000)
  })

  test('最后访问写入失败时不推进节流标记并允许下次访问重试', () => {
    /** 当前用例累计的原子写入次数。 */
    let writeCount = 0
    /** 第二次写入失败、第三次恢复的设备仓库。 */
    const store = new LanBridgeDeviceStore(createConfigDir(), {
      writeJson: () => {
        writeCount++
        if (writeCount === 2) throw new Error('disk failure')
      },
      uuid: () => 'device-1',
    })
    store.registerDevice('iPhone', 1_000)

    expect(() => store.updateLastSeen('device-1', 61_000)).toThrow('disk failure')
    expect(() => store.updateLastSeen('device-1', 61_001)).not.toThrow()
    expect(writeCount).toBe(3)
  })

  test('撤销设备会记录时间并递增 Token 版本', () => {
    /** 当前用例的设备仓库。 */
    const store = new LanBridgeDeviceStore(createConfigDir(), { uuid: () => 'device-1' })
    store.registerDevice('iPhone', 1_000)

    /** 撤销后的设备状态。 */
    const revoked = store.revokeDevice('device-1', 2_000)
    if (!revoked) throw new Error('测试设备应可撤销')

    expect(revoked).toMatchObject({ tokenVersion: 2, revokedAt: 2_000 })
    expect(store.listDevices()).toEqual([])
    expect(store.listDevices(true)).toEqual([revoked])
  })

  test('设备 JSON 损坏时降级为空列表', () => {
    /** 当前用例的配置目录。 */
    const configDir = createConfigDir()
    writeFileSync(join(configDir, 'lan-bridge-devices.json'), '{broken', 'utf-8')

    /** 从损坏文件恢复的设备仓库。 */
    const store = new LanBridgeDeviceStore(configDir)

    expect(store.listDevices(true)).toEqual([])
  })

  test('加载设备文件时丢弃凭据和未知字段', () => {
    /** 当前用例的配置目录。 */
    const configDir = createConfigDir()
    writeFileSync(join(configDir, 'lan-bridge-devices.json'), JSON.stringify([{
      id: 'device-1',
      name: 'iPhone',
      createdAt: 1_000,
      lastSeenAt: 2_000,
      tokenVersion: 1,
      token: 'must-not-load',
    }]), 'utf-8')

    /** 从含多余字段的文件加载的设备仓库。 */
    const store = new LanBridgeDeviceStore(configDir)

    expect(Object.keys(store.getDevice('device-1')!).sort()).toEqual([
      'createdAt', 'id', 'lastSeenAt', 'name', 'revokedAt', 'tokenVersion',
    ])
  })
})
