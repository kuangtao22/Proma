import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readJsonFileSafe, writeJsonFileAtomic } from '../safe-file'
import {
  createServerOpsHostStoreDependencies,
  ServerOpsHostStore,
} from './server-ops-host-store'

/** 当前测试创建的隔离配置目录。 */
const temporaryDirectories: string[] = []

/** 创建一个独占的 Proma 配置目录。 */
function createConfigDir(): string {
  /** 当前用例使用的临时目录。 */
  const configDir = mkdtempSync(join(tmpdir(), 'proma-server-ops-hosts-'))
  temporaryDirectories.push(configDir)
  return configDir
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('服务器运维主机资产 Store', () => {
  test('生产依赖固定使用 safe-file 原子 JSON API', () => {
    /** Store 的生产默认依赖。 */
    const dependencies = createServerOpsHostStoreDependencies()

    expect(dependencies.readJson).toBe(readJsonFileSafe)
    expect(dependencies.writeJson).toBe(writeJsonFileAtomic)
  })

  test('新增、更新和删除主机均持久化到 server-ops/hosts.json', () => {
    /** 当前用例使用的配置目录。 */
    const configDir = createConfigDir()
    /** 使用固定 ID 和时间的主机 Store。 */
    const store = new ServerOpsHostStore(configDir, {
      uuid: () => 'host-1',
      now: () => 1_000,
    })

    /** 新增后的主机。 */
    const created = store.upsert({
      name: '生产 API',
      address: '10.0.0.8',
      port: 22,
      username: 'deploy',
      authMethod: 'ssh-agent',
      tags: ['生产'],
    })

    expect(created).toEqual({
      id: 'host-1',
      name: '生产 API',
      address: '10.0.0.8',
      port: 22,
      username: 'deploy',
      authMethod: 'ssh-agent',
      tags: ['生产'],
      createdAt: 1_000,
      updatedAt: 1_000,
    })
    /** 主机资产文件路径。 */
    const filePath = join(configDir, 'server-ops', 'hosts.json')
    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual([created])

    /** 更新时间改为下一毫秒的可控 Store。 */
    const updateStore = new ServerOpsHostStore(configDir, { now: () => 2_000 })
    /** 更新后的主机。 */
    const updated = updateStore.upsert({
      id: created.id,
      name: '生产 API 01',
      address: created.address,
      port: 2222,
      username: created.username,
      authMethod: created.authMethod,
      tags: created.tags,
    })
    expect(updated).toMatchObject({
      id: 'host-1',
      name: '生产 API 01',
      port: 2222,
      createdAt: 1_000,
      updatedAt: 2_000,
    })

    expect(updateStore.remove('host-1')).toBe(true)
    expect(updateStore.list()).toEqual([])
    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual([])
    expect(existsSync(`${filePath}.bak`)).toBe(true)
  })

  test('损坏主文件和无有效备份时降级为空列表', () => {
    /** 当前用例的配置目录。 */
    const configDir = createConfigDir()
    /** 主机资产目录。 */
    const opsDir = join(configDir, 'server-ops')
    mkdirSync(opsDir, { recursive: true })
    writeFileSync(join(opsDir, 'hosts.json'), '{broken', 'utf8')

    expect(new ServerOpsHostStore(configDir).list()).toEqual([])
  })

  test('返回副本且磁盘写失败不会提交幽灵状态', () => {
    /** 当前测试累计的写入次数。 */
    let writeCount = 0
    /** 第二次写入失败的 Store。 */
    const store = new ServerOpsHostStore(createConfigDir(), {
      uuid: () => 'host-1',
      now: () => 1_000 + writeCount,
      writeJson: () => {
        writeCount++
        if (writeCount === 2) throw new Error('disk failure')
      },
    })
    /** 首次成功创建的主机。 */
    const created = store.upsert({
      name: '生产 API',
      address: '10.0.0.8',
      port: 22,
      username: 'deploy',
      authMethod: 'ssh-agent',
      tags: [],
    })
    /** 调用方可修改但不应污染 Store 的返回数组。 */
    const listed = store.list()
    /** 首次列表中的唯一主机。 */
    const listedHost = listed[0]
    if (!listedHost) throw new Error('测试主机应存在')
    listedHost.name = '被外部篡改'
    expect(store.list()[0]?.name).toBe('生产 API')

    expect(() => store.upsert({
      id: created.id,
      name: '未落盘名称',
      address: created.address,
      port: created.port,
      username: created.username,
      authMethod: created.authMethod,
      tags: created.tags,
    })).toThrow('disk failure')
    expect(store.list()[0]?.name).toBe('生产 API')
  })

  test('拒绝更新不存在的主机并幂等处理缺失删除', () => {
    /** 空主机 Store。 */
    const store = new ServerOpsHostStore(createConfigDir())
    expect(() => store.upsert({
      id: 'missing',
      name: '不存在',
      address: '10.0.0.9',
      port: 22,
      username: 'deploy',
      authMethod: 'ssh-agent',
      tags: [],
    })).toThrow('SERVER_OPS_HOST_NOT_FOUND')
    expect(store.remove('missing')).toBe(false)
  })

  test('凭据引用由 Store 内部绑定且切换认证方式时清除', () => {
    /** 当前测试使用的主机 Store。 */
    const store = new ServerOpsHostStore(createConfigDir(), {
      uuid: () => 'host-1',
      now: () => 1_000,
    })
    /** 新建的密码主机。 */
    const host = store.upsert({
      name: '生产 API',
      address: '10.0.0.8',
      port: 22,
      username: 'deploy',
      authMethod: 'password',
      tags: [],
    })

    expect(store.setCredentialRef(host.id, 'credential-1').credentialRef).toBe('credential-1')
    expect(store.upsert({ ...host, authMethod: 'ssh-agent' }).credentialRef).toBeUndefined()
  })

  test('旧版私钥路径被移出公开主机文件且保留主机资产', () => {
    /** 当前用例的配置目录。 */
    const configDir = createConfigDir()
    /** 旧版运维数据目录。 */
    const opsDir = join(configDir, 'server-ops')
    mkdirSync(opsDir, { recursive: true })
    /** 旧版曾把私钥路径错误保存在主机资产中。 */
    writeFileSync(join(opsDir, 'hosts.json'), JSON.stringify([{
      id: 'host-1',
      name: '旧私钥主机',
      address: '10.0.0.9',
      port: 22,
      username: 'deploy',
      authMethod: 'private-key',
      keyPath: '/Users/demo/.ssh/private-key-canary',
      tags: [],
      createdAt: 1,
      updatedAt: 1,
    }]), 'utf8')

    /** 加载时完成公开 schema 迁移的 Store。 */
    const store = new ServerOpsHostStore(configDir)
    expect(store.list()).toHaveLength(1)
    expect(readFileSync(join(opsDir, 'hosts.json'), 'utf8')).not.toContain('private-key-canary')
    expect(readFileSync(join(opsDir, 'hosts.json.bak'), 'utf8')).not.toContain('private-key-canary')
  })
})
