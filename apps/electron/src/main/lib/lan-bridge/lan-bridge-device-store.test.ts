import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LanBridgeDeviceStore } from './lan-bridge-device-store'

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
  test('注册设备时只持久化安全元数据并通过安全 JSON 写入依赖', () => {
    /** 当前用例的写入调用，用于确认仓库没有绕过安全文件 API。 */
    const writes: Array<{ filePath: string; data: object }> = []
    /** 当前用例的配置目录。 */
    const configDir = createConfigDir()
    /** 使用真实读取和可观测安全写入依赖的设备仓库。 */
    const store = new LanBridgeDeviceStore(configDir, {
      writeJson: (filePath, data) => {
        writes.push({ filePath, data })
        writeFileSync(filePath, JSON.stringify(data), 'utf-8')
      },
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
    expect(writes).toHaveLength(1)
    expect(writes[0]?.filePath).toBe(join(configDir, 'lan-bridge-devices.json'))
    expect(JSON.parse(readFileSync(writes[0]!.filePath, 'utf-8'))).toEqual([device])
    expect(Object.keys(device).sort()).toEqual([
      'createdAt', 'id', 'lastSeenAt', 'name', 'revokedAt', 'tokenVersion',
    ])
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
