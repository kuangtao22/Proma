import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ServerOpsCredentialStore as ProductionServerOpsCredentialStore } from './server-ops-credential-store'
import type { ServerOpsCredentialStoreDependencies } from './server-ops-credential-store'

/** Store 单元测试复用已独立验证的事务合同，只隔离原生 addon 装载。 */
class ServerOpsCredentialStore extends ProductionServerOpsCredentialStore {
  constructor(configDir?: string, dependencies: Partial<ServerOpsCredentialStoreDependencies> = {}) {
    super(configDir, { transaction: (callback) => callback(), ...dependencies })
  }
}

/** 当前测试创建的隔离配置目录。 */
const temporaryDirectories: string[] = []

/** 创建一个隔离的 Proma 配置目录。 */
function createConfigDir(): string {
  /** 当前用例使用的临时目录。 */
  const configDir = mkdtempSync(join(tmpdir(), 'proma-server-ops-credentials-'))
  temporaryDirectories.push(configDir)
  return configDir
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('服务器运维凭据 Store', () => {
  test('默认密码只存在主进程内存且公开文件不存在明文', () => {
    /** 记录 safeStorage 调用次数。 */
    let encryptCalls = 0
    /** 使用可控加密器的凭据 Store。 */
    const store = new ServerOpsCredentialStore(createConfigDir(), {
      platform: 'darwin',
      safeStorage: {
        isEncryptionAvailable: () => true,
        getSelectedStorageBackend: () => 'unknown',
        encryptString: (value) => { encryptCalls++; return Buffer.from(`encrypted:${value}`) },
        decryptString: (value) => value.toString().replace(/^encrypted:/, ''),
      },
      uuid: () => 'credential-1',
      now: () => 1_000,
    })

    store.setVolatile('host-1', { kind: 'password', password: 'password-canary' })

    expect(store.resolve('host-1')).toEqual({ kind: 'password', password: 'password-canary' })
    expect(encryptCalls).toBe(0)
    expect(store.getCredentialRef('host-1')).toBeUndefined()
  })

  test('记住密码只写 safeStorage 密文并可在重启后解密', () => {
    /** 当前用例的配置目录。 */
    const configDir = createConfigDir()
    /** 测试用可逆加密边界。 */
    const safeStorage = {
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => 'unknown' as const,
      encryptString: (value: string) => Buffer.from(`cipher:${value}`),
      decryptString: (value: Buffer) => value.toString().replace(/^cipher:/, ''),
    }
    /** 首次保存凭据的 Store。 */
    const store = new ServerOpsCredentialStore(configDir, {
      platform: 'darwin',
      safeStorage,
      uuid: () => 'credential-1',
      now: () => 1_000,
    })

    const ref = store.remember('host-1', { kind: 'password', password: 'password-canary' })
    /** 凭据密文文件的原始文本。 */
    const raw = readFileSync(join(configDir, 'server-ops', 'credentials.json'), 'utf8')
    expect(raw).not.toContain('password-canary')
    expect(ref).toBe('credential-1')

    /** 模拟应用重启后重新加载的 Store。 */
    const reloaded = new ServerOpsCredentialStore(configDir, { platform: 'darwin', safeStorage })
    expect(reloaded.resolve('host-1', ref)).toEqual({ kind: 'password', password: 'password-canary' })
  })

  test('Linux basic_text backend 拒绝持久化但仍允许本次内存凭据', () => {
    /** 使用不安全 Linux backend 的 Store。 */
    const store = new ServerOpsCredentialStore(createConfigDir(), {
      platform: 'linux',
      safeStorage: {
        isEncryptionAvailable: () => true,
        getSelectedStorageBackend: () => 'basic_text',
        encryptString: (value) => Buffer.from(value),
        decryptString: (value) => value.toString(),
      },
    })

    expect(() => store.remember('host-1', { kind: 'password', password: 'password-canary' }))
      .toThrow('SERVER_OPS_SECURE_STORAGE_UNAVAILABLE')
    store.setVolatile('host-1', { kind: 'password', password: 'password-canary' })
    expect(store.resolve('host-1')).toMatchObject({ password: 'password-canary' })
  })

  test('Given 两个已构造凭据 Store When 分别保存不同主机 Then fresh-read 保留双方密文', () => {
    const configDir = createConfigDir()
    let nextId = 0
    const safeStorage = {
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => 'unknown' as const,
      encryptString: (value: string) => Buffer.from(`cipher:${value}`),
      decryptString: (value: Buffer) => value.toString().replace(/^cipher:/, ''),
    }
    const transaction = <T>(callback: () => T): T => callback()
    const first = new ServerOpsCredentialStore(configDir, { platform: 'darwin', safeStorage, transaction, uuid: () => `credential-${++nextId}`, now: () => nextId })
    const second = new ServerOpsCredentialStore(configDir, { platform: 'darwin', safeStorage, transaction, uuid: () => `credential-${++nextId}`, now: () => nextId })

    const firstRef = first.remember('host-1', { kind: 'password', password: 'first-secret' })
    const secondRef = second.remember('host-2', { kind: 'password', password: 'second-secret' })

    expect(first.getCredentialRef('host-2')).toBe(secondRef)
    expect(second.resolve('host-1', firstRef)).toEqual({ kind: 'password', password: 'first-secret' })
  })

  test('Given 已有凭据文件损坏 When 尝试保存 Then fail closed 且不覆盖现场', () => {
    const configDir = createConfigDir()
    const opsDir = join(configDir, 'server-ops')
    const filePath = join(opsDir, 'credentials.json')
    const safeStorage = {
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => 'unknown' as const,
      encryptString: (value: string) => Buffer.from(value),
      decryptString: (value: Buffer) => value.toString(),
    }
    mkdirSync(opsDir, { recursive: true })
    writeFileSync(filePath, '{broken-credentials', 'utf8')
    const store = new ServerOpsCredentialStore(configDir, {
      platform: 'darwin', safeStorage, transaction: (callback) => callback(),
    })

    expect(() => store.remember('host-1', { kind: 'password', password: 'new-secret' }))
      .toThrow('SERVER_OPS_CREDENTIAL_READ_FAILED')
    expect(readFileSync(filePath, 'utf8')).toBe('{broken-credentials')
  })
})
