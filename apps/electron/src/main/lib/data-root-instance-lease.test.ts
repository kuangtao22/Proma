import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DataRootInstanceLeaseRegistry,
  type DataRootInstanceLeaseRegistryOptions,
  type DataRootLivenessEndpoint,
  type DataRootLivenessServer,
  type DataRootMigrationGuard,
} from './data-root-instance-lease'

/** 每个测试创建的临时 home，结束后统一清理。 */
const tempHomes: string[] = []
/** 测试结束时关闭仍存活的 challenge server 并释放自身 lease。 */
const registries: DataRootInstanceLeaseRegistry[] = []

afterEach(async () => {
  for (const registry of registries.splice(0)) registry.release()
  await Promise.all(tempHomes.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

/** 创建隔离的测试 home。 */
async function createTempHome(): Promise<string> {
  const homeDir = await mkdtemp(join(tmpdir(), 'proma-instance-lease-'))
  tempHomes.push(homeDir)
  return homeDir
}

/** 可确定模拟 crash、PID/端口复用的 challenge 服务。 */
function createLivenessHarness(): {
  start: NonNullable<DataRootInstanceLeaseRegistryOptions['startLivenessServer']>
  probe: NonNullable<DataRootInstanceLeaseRegistryOptions['probeLiveness']>
  crash: (ownerToken: string) => void
  reusePort: (port: number, ownerToken: string) => void
} {
  /** 每个端口当前真正持有的 owner token。 */
  const ownersByPort = new Map<number, string>()
  /** 每个测试 owner 首次分配的端口。 */
  const portsByOwner = new Map<string, number>()
  let nextPort = 40_000
  return {
    start: async (ownerToken): Promise<DataRootLivenessServer> => {
      const port = nextPort
      nextPort += 1
      ownersByPort.set(port, ownerToken)
      portsByOwner.set(ownerToken, port)
      return {
        endpoint: { host: '127.0.0.1', port },
        close: () => { ownersByPort.delete(port) },
      }
    },
    probe: async (endpoint, ownerToken) => ownersByPort.get(endpoint.port) === ownerToken,
    crash: (ownerToken) => {
      const port = portsByOwner.get(ownerToken)
      if (port !== undefined) ownersByPort.delete(port)
    },
    reusePort: (port, ownerToken) => { ownersByPort.set(port, ownerToken) },
  }
}

/** 创建绑定同一可控 challenge harness 的 registry。 */
function createRegistry(
  homeDir: string,
  ownerToken: string,
  pid: number,
  harness: ReturnType<typeof createLivenessHarness>,
): DataRootInstanceLeaseRegistry {
  const registry = new DataRootInstanceLeaseRegistry({
    homeDir,
    pid,
    ownerToken,
    startLivenessServer: harness.start,
    probeLiveness: harness.probe,
  })
  registries.push(registry)
  return registry
}

/** 读取测试 lease 中的端点，不把跨进程 JSON 直接信任为业务类型。 */
function readLeaseEndpoint(path: string): DataRootLivenessEndpoint {
  const value = JSON.parse(readFileSync(path, 'utf8')) as { endpoint: DataRootLivenessEndpoint }
  return value.endpoint
}

describe('DataRootInstanceLeaseRegistry', () => {
  test('Given 真实 loopback challenge server When 扫描另一个实例 Then token 握手确认活跃', async () => {
    const homeDir = await createTempHome()
    /** 不注入 harness，覆盖生产 TCP listen/connect 路径。 */
    const first = new DataRootInstanceLeaseRegistry({ homeDir, ownerToken: 'real-first' })
    const second = new DataRootInstanceLeaseRegistry({ homeDir, ownerToken: 'real-second' })
    registries.push(first, second)
    try {
      await first.acquire('/data/proma')
    } catch (error) {
      /** Codex 沙箱禁止本机 listen；仅该权限错误跳过，其他生产网络错误继续失败。 */
      if (error instanceof Error && 'code' in error && error.code === 'EPERM') return
      throw error
    }
    await second.acquire('/data/proma')

    expect(await first.hasOtherActiveLease()).toBe(true)
  })

  test('Given dev 与 prod 共享 home When 都持有 challenge lease Then 迁移预检发现另一个活跃实例', async () => {
    const homeDir = await createTempHome()
    const harness = createLivenessHarness()
    const dev = createRegistry(homeDir, 'dev-owner', 101, harness)
    const prod = createRegistry(homeDir, 'prod-owner', 202, harness)

    await dev.acquire('/data/proma')
    await prod.acquire('/data/proma')

    expect(await dev.hasOtherActiveLease()).toBe(true)
    expect(await prod.hasOtherActiveLease()).toBe(true)
  })

  test('Given lease PID 已被其他进程复用 When 原 challenge 已关闭 Then 仍回收 stale lease', async () => {
    const homeDir = await createTempHome()
    const harness = createLivenessHarness()
    const crashed = createRegistry(homeDir, 'crashed-owner', 101, harness)
    await crashed.acquire('/data/proma')
    harness.crash('crashed-owner')
    /** 使用相同 PID 模拟 OS 已把 PID 分配给无关新进程。 */
    const current = createRegistry(homeDir, 'current-owner', 101, harness)
    await current.acquire('/data/proma')

    expect(await current.hasOtherActiveLease()).toBe(false)
    expect(existsSync(crashed.getOwnLeasePath())).toBe(false)
  })

  test('Given 旧端口被新 owner 复用 When 响应 token 不匹配 Then 不误判旧 lease 活跃', async () => {
    const homeDir = await createTempHome()
    const harness = createLivenessHarness()
    const crashed = createRegistry(homeDir, 'old-owner', 101, harness)
    await crashed.acquire('/data/proma')
    const endpoint = readLeaseEndpoint(crashed.getOwnLeasePath())
    harness.crash('old-owner')
    harness.reusePort(endpoint.port, 'unrelated-new-owner')
    const current = createRegistry(homeDir, 'current-owner', 202, harness)
    await current.acquire('/data/proma')

    expect(await current.hasOtherActiveLease()).toBe(false)
  })

  test('Given lease 记录损坏 When 扫描 Then fail closed', async () => {
    const homeDir = await createTempHome()
    const registryDir = join(homeDir, '.proma-instance-leases')
    mkdirSync(registryDir)
    writeFileSync(join(registryDir, 'broken.lease'), '{broken')
    const harness = createLivenessHarness()
    const current = createRegistry(homeDir, 'current-owner', 202, harness)
    await current.acquire('/data/proma')

    await expect(current.hasOtherActiveLease()).rejects.toThrow('实例 lease 损坏')
  })

  test('Given lease 路径内容被替换 When 旧实例释放 Then 不误删新 owner 文件', async () => {
    const homeDir = await createTempHome()
    const harness = createLivenessHarness()
    const oldOwner = createRegistry(homeDir, 'old-owner', 101, harness)
    await oldOwner.acquire('/data/proma')
    const leasePath = oldOwner.getOwnLeasePath()
    const previous = JSON.parse(readFileSync(leasePath, 'utf8')) as Record<string, unknown>
    writeFileSync(leasePath, JSON.stringify({ ...previous, ownerToken: 'new-owner' }))

    oldOwner.release()

    expect(existsSync(leasePath)).toBe(true)
  })

  test('Given 两个 contender 同时创建根 intent When O_EXCL 竞争 Then 恰好一个持有', async () => {
    const homeDir = await createTempHome()
    const harness = createLivenessHarness()
    const contenderA = createRegistry(homeDir, 'a-owner', 101, harness)
    const contenderB = createRegistry(homeDir, 'b-owner', 202, harness)

    const results = await Promise.allSettled([
      contenderA.acquireMigrationGuard(),
      contenderB.acquireMigrationGuard(),
    ])
    const fulfilled = results.filter((result): result is PromiseFulfilledResult<DataRootMigrationGuard> => (
      result.status === 'fulfilled'
    ))
    const rejected = results.filter((result) => result.status === 'rejected')

    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    fulfilled[0]?.value.release()
  })

  test('Given intent 持有者连续 crash When 后继 claim 链接管 Then 只保留最后活跃 owner', async () => {
    const homeDir = await createTempHome()
    const harness = createLivenessHarness()
    const ownerA = createRegistry(homeDir, 'a-owner', 101, harness)
    await ownerA.acquireMigrationGuard()
    harness.crash('a-owner')
    const ownerB = createRegistry(homeDir, 'b-owner', 202, harness)
    await ownerB.acquireMigrationGuard()
    harness.crash('b-owner')
    const ownerC = createRegistry(homeDir, 'c-owner', 303, harness)
    const activeGuard = await ownerC.acquireMigrationGuard()
    const contender = createRegistry(homeDir, 'd-owner', 404, harness)

    await expect(contender.acquireMigrationGuard()).rejects.toThrow('另一个 Proma 实例正在准备数据根迁移')
    activeGuard.release()
  })

  test('Given 迁移 intent challenge 活跃 When normal 实例尝试 acquire Then 不进入业务模式', async () => {
    const homeDir = await createTempHome()
    const harness = createLivenessHarness()
    const migrating = createRegistry(homeDir, 'migration-owner', 101, harness)
    const guard = await migrating.acquireMigrationGuard()
    const newcomer = createRegistry(homeDir, 'new-owner', 202, harness)

    await expect(newcomer.acquire('/data/proma')).rejects.toThrow('数据根正在准备迁移')
    guard.release()
  })

  test('Given registry 持有 active guard When graceful release Then 清理 claim 且下次从根路径获取', async () => {
    const homeDir = await createTempHome()
    const harness = createLivenessHarness()
    const first = createRegistry(homeDir, 'first-owner', 101, harness)
    await first.acquireMigrationGuard()

    first.release()

    const second = createRegistry(homeDir, 'second-owner', 202, harness)
    const secondGuard = await second.acquireMigrationGuard()
    /** graceful release 后不得残留死亡前驱并迫使下次增长 successor。 */
    const claims = readdirSync(join(homeDir, '.proma-instance-leases'))
      .filter((name) => name.endsWith('.claim'))
    expect(claims).toEqual(['migration.intent.claim'])
    secondGuard.release()
  })

  test('Given active guard 首次释放失败 When claim 恢复可读 Then graceful release 可重试清理', async () => {
    const homeDir = await createTempHome()
    const harness = createLivenessHarness()
    const registry = createRegistry(homeDir, 'retry-owner', 101, harness)
    const guard = await registry.acquireMigrationGuard()
    const claimPath = join(homeDir, '.proma-instance-leases', 'migration.intent.claim')
    /** 保存原 claim，模拟临时损坏后恢复同一 inode 内容。 */
    const originalClaim = readFileSync(claimPath, 'utf8')
    writeFileSync(claimPath, '{broken')

    expect(() => guard.release()).toThrow('迁移 intent 损坏')
    writeFileSync(claimPath, originalClaim)
    registry.release()

    expect(existsSync(claimPath)).toBe(false)
  })

  test('Given 100 次计划已持久化后的 clean release When 重复获取 Then claim 不增长也不阻断', async () => {
    const homeDir = await createTempHome()
    const harness = createLivenessHarness()
    const registry = createRegistry(homeDir, 'clean-owner', 101, harness)

    for (let index = 0; index < 100; index += 1) {
      const guard = await registry.acquireMigrationGuard()
      /** 模拟 locator pending 已持久化后的安全释放点。 */
      guard.release()
    }

    const claims = readdirSync(join(homeDir, '.proma-instance-leases'))
      .filter((name) => name.endsWith('.claim'))
    expect(claims).toEqual([])
  })

  test('Given crash 前驱与 clean successor When 再次获取 Then 复用同一 successor 路径', async () => {
    const homeDir = await createTempHome()
    const harness = createLivenessHarness()
    const crashed = createRegistry(homeDir, 'crashed-owner', 101, harness)
    await crashed.acquireMigrationGuard()
    harness.crash('crashed-owner')
    const clean = createRegistry(homeDir, 'clean-owner', 202, harness)
    const cleanGuard = await clean.acquireMigrationGuard()
    const registryDir = join(homeDir, '.proma-instance-leases')
    /** 第一次 clean acquisition 使用的确定性 successor。 */
    const firstSuccessor = readdirSync(registryDir)
      .filter((name) => name !== 'migration.intent.claim' && name.endsWith('.claim'))
    cleanGuard.release()

    const next = createRegistry(homeDir, 'next-owner', 303, harness)
    const nextGuard = await next.acquireMigrationGuard()
    const secondSuccessor = readdirSync(registryDir)
      .filter((name) => name !== 'migration.intent.claim' && name.endsWith('.claim'))

    expect(firstSuccessor).toEqual(secondSuccessor)
    nextGuard.release()
  })

  test('Given 256 个 crash claim When 再次接管 Then 返回可操作的恢复错误', async () => {
    const homeDir = await createTempHome()
    const harness = createLivenessHarness()
    for (let index = 0; index < 256; index += 1) {
      const ownerToken = `crash-owner-${index}`
      const registry = createRegistry(homeDir, ownerToken, index + 1, harness)
      await registry.acquireMigrationGuard()
      harness.crash(ownerToken)
    }
    const contender = createRegistry(homeDir, 'overflow-owner', 999, harness)

    await expect(contender.acquireMigrationGuard())
      .rejects.toThrow('完全退出所有 Proma 实例')
  })
})
