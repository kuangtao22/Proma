import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ServerOpsCredentialStore } from './server-ops-credential-store'

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
})
