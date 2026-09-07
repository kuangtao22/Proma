import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerOpsHost } from '@proma/shared'
import { ServerOpsHostTrustStore } from './server-ops-host-trust-store'
import { writeJsonFileAtomic } from '../safe-file'

/** 当前测试创建的隔离配置目录。 */
const temporaryDirectories: string[] = []

/** 创建一个隔离的 Proma 配置目录。 */
function createConfigDir(): string {
  /** 当前用例使用的临时目录。 */
  const configDir = mkdtempSync(join(tmpdir(), 'proma-server-ops-trust-'))
  temporaryDirectories.push(configDir)
  return configDir
}

/** 创建 Host Key 测试使用的公开主机。 */
function createHost(overrides: Partial<ServerOpsHost> = {}): ServerOpsHost {
  return {
    id: 'host-1',
    name: '生产 API',
    address: 'api.internal',
    port: 22,
    username: 'deploy',
    authMethod: 'password',
    tags: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

/** Store 单测隔离原生锁，只验证 fresh-read 与原子文件语义。 */
function createStore(configDir = createConfigDir(), now: () => number = Date.now): ServerOpsHostTrustStore {
  return new ServerOpsHostTrustStore(configDir, { now, transaction: (callback) => callback() })
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('服务器运维 Host Key Store', () => {
  test('Given 旧指纹快照 When 条件替换与撤销 Then 冲突不写入且撤销后成为未知', () => {
    /** 独立信任配置及新旧公钥摘要。 */
    const store = createStore()
    const first = { algorithm: 'ssh-ed25519', fingerprint: 'SHA256:first' }
    const changed = { algorithm: 'ssh-ed25519', fingerprint: 'SHA256:changed' }
    store.trust(createHost(), first)
    store.replace(createHost(), first, changed)
    expect(store.get(createHost())).toEqual(changed)
    expect(() => store.revoke(createHost(), first)).toThrow('SERVER_OPS_TRUST_CONFLICT')
    expect(store.get(createHost())).toEqual(changed)
    store.revoke(createHost(), changed)
    expect(store.get(createHost())).toBeUndefined()
  })
  test('Given endpoint 已固定指纹 When 首次确认接口提交另一指纹 Then 拒绝覆盖', () => {
    /** 已固定旧密钥的隔离信任 Store。 */
    const store = createStore()
    /** 原始身份与发生变化的服务器身份。 */
    const first = { algorithm: 'ssh-ed25519', fingerprint: 'SHA256:first' }
    const changed = { algorithm: 'ssh-ed25519', fingerprint: 'SHA256:changed' }
    store.trust(createHost(), first)
    expect(() => store.trust(createHost(), changed)).toThrow('SERVER_OPS_TRUST_CONFLICT')
    expect(store.get(createHost())).toEqual(first)
  })

  test('Given 两个 Store 读取同一文件 When 分别保存不同 endpoint Then 保留两次成功写入', () => {
    /** 两个模拟应用实例共享同一临时配置根。 */
    const directory = createConfigDir()
    const firstStore = createStore(directory)
    const secondStore = createStore(directory)
    /** 不同 endpoint 的独立身份。 */
    const key = { algorithm: 'ssh-ed25519', fingerprint: 'SHA256:first' }
    firstStore.trust(createHost(), key)
    secondStore.trust(createHost({ port: 2222 }), key)
    expect(firstStore.get(createHost({ port: 2222 }))).toEqual(key)
    expect(createStore(directory).get(createHost())).toEqual(key)
  })

  test('Given 已有信任文件损坏 When 读取或首次确认 Then 阻断且保留现场', () => {
    /** 只写测试配置，不接触用户信任文件。 */
    const directory = createConfigDir()
    const store = createStore(directory)
    writeJsonFileAtomic(join(directory, 'server-ops/known-hosts.json'), { version: 999, hosts: [] })
    expect(() => store.get(createHost())).toThrow('SERVER_OPS_TRUST_READ_FAILED')
    expect(() => store.trust(createHost(), { algorithm: 'ssh-ed25519', fingerprint: 'SHA256:first' }))
      .toThrow('SERVER_OPS_TRUST_READ_FAILED')
  })

  test('未知、可信和变化三种结果严格区分', () => {
    /** 当前测试的 Host Key Store。 */
    const store = createStore(createConfigDir(), () => 1_000)
    /** 首次观测到的 Host Key。 */
    const first = { algorithm: 'ssh-ed25519', fingerprint: 'SHA256:first' }

    expect(store.check(createHost(), first)).toEqual({ status: 'unknown', observed: first })
    store.trust(createHost(), first)
    expect(store.check(createHost(), first)).toMatchObject({ status: 'trusted', trusted: first })
    expect(store.check(createHost(), { algorithm: 'ssh-ed25519', fingerprint: 'SHA256:changed' })).toMatchObject({
      status: 'changed',
      trusted: first,
      observed: { algorithm: 'ssh-ed25519', fingerprint: 'SHA256:changed' },
    })
  })

  test('改显示名不影响信任，改 endpoint 进入新的信任域', () => {
    /** 当前测试的 Host Key Store。 */
    const store = createStore()
    /** 被确认的 Host Key。 */
    const key = { algorithm: 'ssh-ed25519', fingerprint: 'SHA256:first' }
    store.trust(createHost(), key)

    expect(store.check(createHost({ name: '新显示名' }), key).status).toBe('trusted')
    expect(store.check(createHost({ port: 2222 }), key).status).toBe('unknown')
  })
})
