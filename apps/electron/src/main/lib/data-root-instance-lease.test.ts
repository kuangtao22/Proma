import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DataRootInstanceLeaseRegistry } from './data-root-instance-lease'

/** 每个测试创建的临时 home，结束后统一清理。 */
const tempHomes: string[] = []

afterEach(async () => {
  await Promise.all(tempHomes.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

/** 创建隔离的测试 home。 */
async function createTempHome(): Promise<string> {
  const homeDir = await mkdtemp(join(tmpdir(), 'proma-instance-lease-'))
  tempHomes.push(homeDir)
  return homeDir
}

describe('DataRootInstanceLeaseRegistry', () => {
  test('Given dev 与 prod 进程共享 home When 都持有 normal lease Then 迁移预检发现另一个活跃实例', async () => {
    const homeDir = await createTempHome()
    const dev = new DataRootInstanceLeaseRegistry({
      homeDir,
      pid: 101,
      ownerToken: 'dev-owner',
      isPidRunning: () => true,
    })
    const prod = new DataRootInstanceLeaseRegistry({
      homeDir,
      pid: 202,
      ownerToken: 'prod-owner',
      isPidRunning: () => true,
    })

    dev.acquire('/data/proma')
    prod.acquire('/data/proma')

    expect(dev.hasOtherActiveLease()).toBe(true)
    expect(prod.hasOtherActiveLease()).toBe(true)
  })

  test('Given 死 PID lease When 扫描 Then 原子回收且不阻止迁移', async () => {
    const homeDir = await createTempHome()
    const dead = new DataRootInstanceLeaseRegistry({
      homeDir,
      pid: 101,
      ownerToken: 'dead-owner',
      isPidRunning: () => false,
    })
    dead.acquire('/data/proma')
    const current = new DataRootInstanceLeaseRegistry({
      homeDir,
      pid: 202,
      ownerToken: 'current-owner',
      isPidRunning: (pid) => pid === 202,
    })
    current.acquire('/data/proma')

    expect(current.hasOtherActiveLease()).toBe(false)
  })

  test('Given lease 记录损坏 When 扫描 Then fail closed', async () => {
    const homeDir = await createTempHome()
    const registryDir = join(homeDir, '.proma-instance-leases')
    mkdirSync(registryDir)
    writeFileSync(join(registryDir, 'broken.lease'), '{broken')
    const current = new DataRootInstanceLeaseRegistry({
      homeDir,
      pid: 202,
      ownerToken: 'current-owner',
      isPidRunning: () => true,
    })
    current.acquire('/data/proma')

    expect(() => current.hasOtherActiveLease()).toThrow('实例 lease 损坏')
  })

  test('Given owner token 已被替换 When 旧实例释放 Then 不误删新 owner lease', async () => {
    const homeDir = await createTempHome()
    const oldOwner = new DataRootInstanceLeaseRegistry({
      homeDir,
      pid: 101,
      ownerToken: 'old-owner',
      isPidRunning: () => true,
    })
    oldOwner.acquire('/data/proma')
    const leasePath = oldOwner.getOwnLeasePath()
    writeFileSync(leasePath, JSON.stringify({
      version: 1,
      pid: 101,
      ownerToken: 'new-owner',
      activeRoot: '/data/proma',
      createdAt: 1,
    }))

    oldOwner.release()

    expect(existsSync(leasePath)).toBe(true)
  })

  test('Given 迁移 intent 已持有 When normal 实例尝试 acquire Then 不进入业务模式', async () => {
    const homeDir = await createTempHome()
    const migrating = new DataRootInstanceLeaseRegistry({
      homeDir,
      pid: 101,
      ownerToken: 'migration-owner',
      isPidRunning: () => true,
    })
    migrating.acquire('/data/proma')
    const guard = migrating.acquireMigrationGuard()
    const newcomer = new DataRootInstanceLeaseRegistry({
      homeDir,
      pid: 202,
      ownerToken: 'new-owner',
      isPidRunning: () => true,
    })

    expect(() => newcomer.acquire('/data/proma')).toThrow('数据根正在准备迁移')
    guard.release()
  })
})
