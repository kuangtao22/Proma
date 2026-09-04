import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerOpsHost } from '@proma/shared'
import { ServerOpsHostTrustStore } from './server-ops-host-trust-store'

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

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('服务器运维 Host Key Store', () => {
  test('未知、可信和变化三种结果严格区分', () => {
    /** 当前测试的 Host Key Store。 */
    const store = new ServerOpsHostTrustStore(createConfigDir(), { now: () => 1_000 })
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
    const store = new ServerOpsHostTrustStore(createConfigDir())
    /** 被确认的 Host Key。 */
    const key = { algorithm: 'ssh-ed25519', fingerprint: 'SHA256:first' }
    store.trust(createHost(), key)

    expect(store.check(createHost({ name: '新显示名' }), key).status).toBe('trusted')
    expect(store.check(createHost({ port: 2222 }), key).status).toBe('unknown')
  })
})
