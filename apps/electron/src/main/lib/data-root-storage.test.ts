import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as storageModule from './data-root-migration'

/** RED 阶段期望的存储检查模块合同。 */
interface ExpectedStorageModule {
  scanDataRootBytes: (rootPath: string) => Promise<number>
  toSafeByteCount: (value: bigint) => number
  classifyMacDiskInfo: (xml: string) => 'local' | 'removable' | 'network' | 'unknown'
  classifyWindowsDriveType: (driveType: number) => 'local' | 'removable' | 'network' | 'unknown'
  classifyLinuxMountInfo: (
    rootPath: string,
    mountInfo: string,
    readRemovable: (majorMinor: string) => Promise<string | null>,
  ) => Promise<'local' | 'removable' | 'network' | 'unknown'>
  DataRootStorageInspector: new (options: {
    now: () => number
    cacheTtlMs: number
    inspectFresh: (rootPath: string) => Promise<{
      occupiedBytes: number
      availableBytes: number
      deviceType: 'local' | 'removable' | 'network' | 'unknown'
    }>
  }) => {
    inspect: (rootPath: string) => Promise<{
      occupiedBytes: number
      availableBytes: number
      deviceType: 'local' | 'removable' | 'network' | 'unknown'
    }>
    invalidate: (rootPath?: string) => void
  }
}

/** 将当前模块收窄为目标合同，缺失实现会形成明确 RED。 */
function getExpectedStorageModule(): ExpectedStorageModule {
  return storageModule as unknown as ExpectedStorageModule
}

describe('数据根存储检查', () => {
  /** 每个真实目录测试创建的临时根。 */
  const temporaryRoots: string[] = []

  afterEach(() => {
    for (const rootPath of temporaryRoots.splice(0)) rmSync(rootPath, { recursive: true, force: true })
  })

  test('Given 普通文件与目录 symlink When 统计占用 Then 只累计普通文件且不跟随链接', async () => {
    const { scanDataRootBytes } = getExpectedStorageModule()
    expect(typeof scanDataRootBytes).toBe('function')
    /** 数据根与外部目录使用同一临时父目录。 */
    const temporaryRoot = mkdtempSync(join(tmpdir(), 'proma-storage-scan-'))
    temporaryRoots.push(temporaryRoot)
    /** 实际扫描的数据根。 */
    const dataRoot = join(temporaryRoot, 'data')
    /** symlink 指向的外部目录，内容不得计入。 */
    const externalRoot = join(temporaryRoot, 'external')
    mkdirSync(join(dataRoot, 'nested'), { recursive: true })
    mkdirSync(externalRoot)
    writeFileSync(join(dataRoot, 'a.txt'), '1234')
    writeFileSync(join(dataRoot, 'nested', 'b.txt'), '123456')
    writeFileSync(join(externalRoot, 'large.txt'), 'x'.repeat(1024))
    symlinkSync(externalRoot, join(dataRoot, 'external-link'))

    expect(await scanDataRootBytes(dataRoot)).toBe(10)
  })

  test('Given 并发读取与短缓存 When 检查同一路径 Then 单飞复用并可显式失效', async () => {
    const { DataRootStorageInspector } = getExpectedStorageModule()
    expect(typeof DataRootStorageInspector).toBe('function')
    /** 可控时钟，验证 TTL 前后行为。 */
    let now = 1000
    /** 记录真实检查次数。 */
    let inspections = 0
    /** 测试使用的固定快照。 */
    const snapshot = { occupiedBytes: 10, availableBytes: 100, deviceType: 'local' as const }
    const inspector = new DataRootStorageInspector({
      now: () => now,
      cacheTtlMs: 500,
      inspectFresh: async () => {
        inspections += 1
        await Promise.resolve()
        return snapshot
      },
    })

    const [first, second] = await Promise.all([inspector.inspect('/data/proma'), inspector.inspect('/data/proma')])
    expect(first).toEqual(snapshot)
    expect(second).toEqual(snapshot)
    expect(inspections).toBe(1)
    await inspector.inspect('/data/proma')
    expect(inspections).toBe(1)
    inspector.invalidate('/data/proma')
    await inspector.inspect('/data/proma')
    expect(inspections).toBe(2)
    now += 501
    await inspector.inspect('/data/proma')
    expect(inspections).toBe(3)
  })

  test('Given statfs 字节超过安全整数 When 转换 Then 饱和到 MAX_SAFE_INTEGER', () => {
    const { toSafeByteCount } = getExpectedStorageModule()
    expect(typeof toSafeByteCount).toBe('function')

    expect(toSafeByteCount(1024n)).toBe(1024)
    expect(toSafeByteCount(BigInt(Number.MAX_SAFE_INTEGER) + 1n)).toBe(Number.MAX_SAFE_INTEGER)
  })

  test('Given macOS 卷元数据 When 分类 Then 优先识别网络、可移除与本地卷', () => {
    const { classifyMacDiskInfo } = getExpectedStorageModule()
    expect(typeof classifyMacDiskInfo).toBe('function')

    expect(classifyMacDiskInfo('<plist><dict><key>Network</key><true/></dict></plist>')).toBe('network')
    expect(classifyMacDiskInfo('<plist><dict><key>RemovableMedia</key><true/></dict></plist>')).toBe('removable')
    expect(classifyMacDiskInfo('<plist><dict><key>Internal</key><true/></dict></plist>')).toBe('local')
    expect(classifyMacDiskInfo('<plist><dict/></plist>')).toBe('unknown')
  })

  test('Given Windows DriveType When 分类 Then 使用系统枚举而非路径猜测', () => {
    const { classifyWindowsDriveType } = getExpectedStorageModule()
    expect(typeof classifyWindowsDriveType).toBe('function')

    expect(classifyWindowsDriveType(4)).toBe('network')
    expect(classifyWindowsDriveType(2)).toBe('removable')
    expect(classifyWindowsDriveType(3)).toBe('local')
    expect(classifyWindowsDriveType(0)).toBe('unknown')
  })

  test('Given Linux mountinfo When 分类 Then 网络文件系统优先，块设备 removable 元数据决定本地或可移除', async () => {
    const { classifyLinuxMountInfo } = getExpectedStorageModule()
    expect(typeof classifyLinuxMountInfo).toBe('function')
    /** 包含根 ext4、USB vfat 与 NFS 的真实 mountinfo 形状。 */
    const mountInfo = [
      '24 20 8:1 / / rw,relatime - ext4 /dev/sda1 rw',
      '25 24 8:17 / /media/usb rw,relatime - vfat /dev/sdb1 rw',
      '26 24 0:42 / /mnt/nas rw,relatime - nfs server:/share rw',
    ].join('\n')

    expect(await classifyLinuxMountInfo('/mnt/nas/proma', mountInfo, async () => null)).toBe('network')
    expect(await classifyLinuxMountInfo('/media/usb/proma', mountInfo, async (id) => id === '8:17' ? '1' : '0')).toBe('removable')
    expect(await classifyLinuxMountInfo('/home/user/.proma', mountInfo, async () => '0')).toBe('local')
  })
})
