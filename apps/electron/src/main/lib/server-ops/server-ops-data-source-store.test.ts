import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerOpsDataSourceUpsertInput } from '@proma/shared'
import {
  createServerOpsDataSourceStoreDependencies,
  ServerOpsDataSourceStore as ProductionServerOpsDataSourceStore,
} from './server-ops-data-source-store'
import type { ServerOpsDataSourceStoreDependencies } from './server-ops-data-source-store'
import { ServerOpsDataSourceCredentialStore as ProductionServerOpsDataSourceCredentialStore } from './server-ops-data-credential-store'
import type {
  ServerOpsDataSourceCredentialStoreDependencies,
} from './server-ops-data-credential-store'

/** Store 单元测试复用已独立验证的事务合同，只隔离原生 addon 装载。 */
class ServerOpsDataSourceStore extends ProductionServerOpsDataSourceStore {
  constructor(configDir?: string, dependencies: Partial<ServerOpsDataSourceStoreDependencies> = {}) {
    super(configDir, { transaction: (callback) => callback(), ...dependencies })
  }
}

/** 凭据 Store 同样使用直通事务，只验证自身语义。 */
class ServerOpsDataSourceCredentialStore extends ProductionServerOpsDataSourceCredentialStore {
  constructor(configDir?: string, dependencies: Partial<ServerOpsDataSourceCredentialStoreDependencies> = {}) {
    super(configDir, { transaction: (callback) => callback(), ...dependencies })
  }
}

/** 当前测试创建的隔离配置目录。 */
const temporaryDirectories: string[] = []

/** 创建一个独占的 Proma 配置目录。 */
function createConfigDir(): string {
  /** 当前用例使用的临时目录。 */
  const configDir = mkdtempSync(join(tmpdir(), 'proma-server-ops-data-'))
  temporaryDirectories.push(configDir)
  return configDir
}

/** 可逆的假 safeStorage，用于验证密文落盘而不依赖 Electron。 */
function createFakeSafeStorage(): ServerOpsDataSourceCredentialStoreDependencies['safeStorage'] {
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: (value) => Buffer.from(`enc:${value}`, 'utf8'),
    decryptString: (value) => {
      /** 反向解出原始明文，用于断言密文可读回。 */
      const text = value.toString('utf8')
      if (!text.startsWith('enc:')) throw new Error('bad ciphertext')
      return text.slice(4)
    },
  }
}

/** 构造一个合法数据源写入输入。 */
function createSourceInput(overrides: Partial<ServerOpsDataSourceUpsertInput> = {}): ServerOpsDataSourceUpsertInput {
  return {
    transport: 'ssh',
    hostId: 'host-1',
    engine: 'mysql',
    label: '业务主库',
    address: '127.0.0.1',
    port: 3306,
    database: 'app',
    username: 'monitor',
    tlsMode: 'disabled',
    ...overrides,
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('服务器运维数据源 Store', () => {
  test('生产依赖固定使用 safe-file 读取与安全原子 JSON 写入边界', () => {
    /** Store 的生产默认依赖。 */
    const dependencies = createServerOpsDataSourceStoreDependencies()
    expect(typeof dependencies.readJson).toBe('function')
    expect(typeof dependencies.writeJson).toBe('function')
  })

  test('Given 新数据源 When 创建更新删除 Then 持久化到 server-ops/data-sources.json', () => {
    const configDir = createConfigDir()
    const store = new ServerOpsDataSourceStore(configDir, { uuid: () => 'source-1', now: () => 1_000 })

    const created = store.create(createSourceInput(), 'ref-1')
    expect(created).toEqual({
      id: 'source-1', transport: 'ssh', hostId: 'host-1', engine: 'mysql', label: '业务主库',
      address: '127.0.0.1', port: 3306, database: 'app', username: 'monitor',
      tlsMode: 'disabled', credentialRef: 'ref-1', createdAt: 1_000, updatedAt: 1_000,
    })
    expect(store.list()).toHaveLength(1)
    expect(store.getById('source-1')?.label).toBe('业务主库')
    /** 数据源是全局条目，不再按主机过滤，因此不同主机也能读到同一条。 */
    expect(store.getById('source-2')).toBeUndefined()

    const updated = store.update('source-1', { label: '业务从库', database: null, credentialRef: null })
    expect(updated.label).toBe('业务从库')
    expect(updated.database).toBeUndefined()
    expect(updated.credentialRef).toBeUndefined()

    /** 落盘文件必须满足版本化 schema。 */
    const persisted = JSON.parse(readFileSync(join(configDir, 'server-ops', 'data-sources.json'), 'utf8')) as { version: number; sources: unknown[] }
    expect(persisted.version).toBe(1)
    expect(persisted.sources).toHaveLength(1)

    expect(store.remove('source-1')).toBe(true)
    expect(store.remove('source-1')).toBe(false)
    expect(store.list()).toEqual([])
  })

  test('Given 多数据源 When 操作 Then 全局可见且按身份精确定位', () => {
    const configDir = createConfigDir()
    let sequence = 0
    const store = new ServerOpsDataSourceStore(configDir, { uuid: () => `source-${++sequence}`, now: () => 1_000 })
    store.create(createSourceInput())
    store.create(createSourceInput({ hostId: 'host-2', label: '另一个主库' }))
    store.create(createSourceInput({ hostId: 'host-2', label: '缓存', engine: 'redis', port: 6379, database: '0' }))

    /** 数据源是全局条目：不再按跳板主机过滤，但每条仍保留自己的归属。 */
    expect(store.list().map((source) => source.label)).toEqual(['业务主库', '另一个主库', '缓存'])
    expect(store.getById('source-2')?.hostId).toBe('host-2')
    expect(() => store.update('source-missing', { label: '改名' })).toThrow('SERVER_OPS_DATA_SOURCE_NOT_FOUND')
    expect(store.remove('source-missing')).toBe(false)
    expect(store.getById('source-2')?.label).toBe('另一个主库')
    /** 删除主机时只能清掉归属该主机的条目。 */
    expect(store.removeByHost('host-2')).toBe(2)
    expect(store.list().map((source) => source.label)).toEqual(['业务主库'])
  })

  test('Given 创建时间不同 When 列出 Then 按创建时间升序稳定排序', () => {
    const configDir = createConfigDir()
    let sequence = 0
    const store = new ServerOpsDataSourceStore(configDir, { uuid: () => `source-${++sequence}`, now: () => 1_000 })
    store.create(createSourceInput({ label: '先建' }))
    /** 后建的记录使用更晚时间。 */
    const later = new ServerOpsDataSourceStore(configDir, { uuid: () => 'source-9', now: () => 2_000 })
    later.create(createSourceInput({ label: '后建' }))
    expect(later.list().map((source) => source.label)).toEqual(['先建', '后建'])
  })

  test('Given 损坏或未知字段文件 When 读取 Then fail closed 而不是当作空列表', () => {
    const configDir = createConfigDir()
    const target = join(configDir, 'server-ops', 'data-sources.json')
    const store = new ServerOpsDataSourceStore(configDir)
    expect(store.list()).toEqual([])
    writeFileSync(target, '{ not json')
    expect(() => store.list()).toThrow('SERVER_OPS_DATA_SOURCE_READ_FAILED')
    writeFileSync(target, JSON.stringify({ version: 1, sources: [{ id: 'source-1' }] }))
    expect(() => store.list()).toThrow('SERVER_OPS_DATA_SOURCE_FILE_INVALID')
    writeFileSync(target, JSON.stringify({ version: 1, sources: [], extra: true }))
    expect(() => store.list()).toThrow('SERVER_OPS_DATA_SOURCE_FILE_INVALID')
  })

  test('Given 非法更新 When 属性越界 Then 拒绝写入并保留原文件', () => {
    const configDir = createConfigDir()
    const store = new ServerOpsDataSourceStore(configDir, { uuid: () => 'source-1', now: () => 1_000 })
    store.create(createSourceInput({ tlsMode: 'verify', tlsServerName: 'db.internal' }))
    const filePath = join(configDir, 'server-ops', 'data-sources.json')
    /** 更新前文件内容，用于断言失败不落盘。 */
    const before = readFileSync(filePath, 'utf8')
    expect(() => store.update('source-1', { tlsMode: 'verify', tlsServerName: null }))
      .toThrow('SERVER_OPS_DATA_SOURCE_FILE_INVALID')
    expect(readFileSync(filePath, 'utf8')).toBe(before)
  })

  test('Given 两个 Store 实例 When 交替写入 Then 互不覆盖', () => {
    const configDir = createConfigDir()
    const first = new ServerOpsDataSourceStore(configDir, { uuid: () => 'source-1', now: () => 1_000 })
    const second = new ServerOpsDataSourceStore(configDir, { uuid: () => 'source-2', now: () => 1_100 })
    first.create(createSourceInput({ label: '第一个' }))
    // 第二个实例必须读到第一个实例的提交后再追加。
    second.create(createSourceInput({ label: '第二个' }))
    expect(second.list().map((source) => source.label)).toEqual(['第一个', '第二个'])
    expect(existsSync(join(configDir, 'server-ops', 'data-sources.json.bak'))).toBe(true)
  })

  test('Given 新数据源 When 指定项目或沿用旧调用 Then 在事务内解析归属', () => {
    const configDir = createConfigDir()
    /** 记录归属解析时事务是否仍然持有。 */
    let transactionDepth = 0
    /** 测试使用的同步事务。 */
    const transaction = <T>(callback: () => T): T => {
      transactionDepth += 1
      try { return callback() } finally { transactionDepth -= 1 }
    }
    const store = new ProductionServerOpsDataSourceStore(configDir, {
      transaction,
      uuid: (() => { let sequence = 0; return () => `source-${++sequence}` })(),
      now: () => 1_000,
      resolveProjectId: (projectId) => {
        expect(transactionDepth).toBeGreaterThan(0)
        if (projectId === 'project-missing') throw new Error('SERVER_OPS_PROJECT_NOT_FOUND')
        return projectId ?? 'project-default'
      },
    })
    expect(store.create(createSourceInput({ projectId: 'project-2' })).projectId).toBe('project-2')
    expect(store.create(createSourceInput()).projectId).toBe('project-default')
    expect(() => store.create(createSourceInput({ projectId: 'project-missing' }))).toThrow('SERVER_OPS_PROJECT_NOT_FOUND')
    expect(store.list()).toHaveLength(2)
  })

  test('Given 已归属数据源 When 编辑 Then 保留归属且拒绝迁移', () => {
    const configDir = createConfigDir()
    const store = new ServerOpsDataSourceStore(configDir, {
      uuid: () => 'source-1', now: () => 1_000, resolveProjectId: (projectId) => projectId ?? 'project-1',
    })
    /** 已归属项目一的数据源。 */
    const created = store.create(createSourceInput({ projectId: 'project-1' }))
    expect(store.update(created.id, { label: '改名' }).projectId).toBe('project-1')
    expect(() => store.update(created.id, { projectId: 'project-2' })).toThrow('SERVER_OPS_DATA_SOURCE_PROJECT_MISMATCH')
  })

  test('Given MySQL 与 Redis 数据源 When 独立移动 Then 仅更新项目与时间并保留凭据和跳板', () => {
    const configDir = createConfigDir()
    let sequence = 0
    let now = 1_000
    const store = new ServerOpsDataSourceStore(configDir, {
      uuid: () => `source-${++sequence}`, now: () => now,
      resolveProjectId: (projectId) => projectId ?? 'project-1',
    })
    const mysql = store.create(createSourceInput({ projectId: 'project-1' }), 'credential-1')
    const redis = store.create(createSourceInput({
      projectId: 'project-1', engine: 'redis', label: '缓存', port: 6379, database: '0',
    }), 'credential-2')
    now = 2_000

    expect(store.move(mysql.id, 'project-1', 'project-2')).toEqual({ ...mysql, projectId: 'project-2', updatedAt: 2_000 })
    expect(store.move(redis.id, 'project-1', 'project-2')).toEqual({ ...redis, projectId: 'project-2', updatedAt: 2_000 })
  })

  test('Given 目标缺失、源缺失或原项目过期 When 移动数据源 Then 拒绝且不写盘', () => {
    const configDir = createConfigDir()
    const store = new ServerOpsDataSourceStore(configDir, {
      uuid: () => 'source-1', now: () => 1_000,
      resolveProjectId: (projectId) => {
        if (projectId === 'project-missing') throw new Error('SERVER_OPS_PROJECT_NOT_FOUND')
        return projectId ?? 'project-1'
      },
    })
    store.create(createSourceInput({ projectId: 'project-1' }), 'credential-1')
    const filePath = join(configDir, 'server-ops', 'data-sources.json')
    const before = readFileSync(filePath, 'utf8')

    expect(() => store.move('source-missing', 'project-1', 'project-2')).toThrow('SERVER_OPS_DATA_SOURCE_NOT_FOUND')
    expect(() => store.move('source-1', 'project-stale', 'project-2')).toThrow('SERVER_OPS_CONNECTION_PROJECT_CHANGED')
    expect(() => store.move('source-1', 'project-1', 'project-missing')).toThrow('SERVER_OPS_PROJECT_NOT_FOUND')
    expect(readFileSync(filePath, 'utf8')).toBe(before)
  })

  test('Given 同项目、缺少项目解析器或写盘失败 When 移动数据源 Then 幂等或 fail closed 且保留原文件', () => {
    const configDir = createConfigDir()
    const dependencies = createServerOpsDataSourceStoreDependencies()
    let writes = 0
    let failWrite = false
    const store = new ServerOpsDataSourceStore(configDir, {
      uuid: () => 'source-1', now: () => 2_000, resolveProjectId: (projectId) => projectId ?? 'project-1',
      writeJson: (filePath, data, expectedDestination, priorBackup) => {
        writes += 1
        if (failWrite) throw new Error('WRITE_FAILED')
        dependencies.writeJson(filePath, data, expectedDestination, priorBackup)
      },
    })
    store.create(createSourceInput({ projectId: 'project-1' }), 'credential-1')
    const filePath = join(configDir, 'server-ops', 'data-sources.json')
    const before = readFileSync(filePath, 'utf8')
    const writesBeforeIdempotentMove = writes
    expect(store.move('source-1', 'project-1', 'project-1').updatedAt).toBe(2_000)
    expect(writes).toBe(writesBeforeIdempotentMove)

    const unavailable = new ServerOpsDataSourceStore(configDir, { now: () => 3_000 })
    expect(() => unavailable.move('source-1', 'project-1', 'project-2')).toThrow('SERVER_OPS_PROJECT_UNAVAILABLE')
    failWrite = true
    expect(() => store.move('source-1', 'project-1', 'project-2')).toThrow('WRITE_FAILED')
    expect(readFileSync(filePath, 'utf8')).toBe(before)
  })

  test('Given 同目录两个 Store 已读取旧归属 When A 移动后 B 继续操作 Then 过期移动拒绝且另一记录不覆盖 A', () => {
    const configDir = createConfigDir()
    /** 模拟生产共用事务，并验证目标项目解析发生在持锁期间。 */
    let transactionDepth = 0
    const transaction = <T>(callback: () => T): T => {
      transactionDepth += 1
      try { return callback() } finally { transactionDepth -= 1 }
    }
    let sequence = 0
    const seed = new ProductionServerOpsDataSourceStore(configDir, {
      transaction,
      uuid: () => `source-${++sequence}`,
      now: () => 1_000,
      resolveProjectId: (projectId) => projectId ?? 'project-1',
    })
    seed.create(createSourceInput({ projectId: 'project-1', label: 'A' }))
    seed.create(createSourceInput({ projectId: 'project-1', label: 'B', hostId: 'host-2' }))
    /** 两个实例在移动前都读取同一份旧归属，模拟两个 Pane 的陈旧视图。 */
    const createStore = (now: number): ProductionServerOpsDataSourceStore => new ProductionServerOpsDataSourceStore(configDir, {
      transaction,
      now: () => now,
      resolveProjectId: (projectId) => {
        expect(transactionDepth).toBeGreaterThan(0)
        return projectId ?? 'project-1'
      },
    })
    const first = createStore(2_000)
    const second = createStore(3_000)
    expect(first.list().map((source) => source.projectId)).toEqual(['project-1', 'project-1'])
    expect(second.list().map((source) => source.projectId)).toEqual(['project-1', 'project-1'])

    first.move('source-1', 'project-1', 'project-2')
    expect(() => second.move('source-1', 'project-1', 'project-3'))
      .toThrow('SERVER_OPS_CONNECTION_PROJECT_CHANGED')
    second.move('source-2', 'project-1', 'project-3')

    expect(second.list().map((source) => ({ id: source.id, projectId: source.projectId }))).toEqual([
      { id: 'source-1', projectId: 'project-2' },
      { id: 'source-2', projectId: 'project-3' },
    ])
  })
})

describe('服务器运维数据源凭据 Store', () => {
  test('Given 密码 When 保存 Then 只落密文并以稳定 ref 读回', () => {
    const configDir = createConfigDir()
    const safeStorage = createFakeSafeStorage()
    const store = new ServerOpsDataSourceCredentialStore(configDir, {
      safeStorage, uuid: () => 'ref-1', now: () => 1_000,
    })

    const ref = store.setSecret('host-1', 'source-1', 'p@ssw0rd')
    expect(ref).toBe('ref-1')
    const firstVersion = store.getSecretVersion(ref)
    expect(firstVersion).toMatch(/^[a-f0-9]{64}$/)
    expect(store.resolveSecret('ref-1')).toBe('p@ssw0rd')
    expect(store.hasSecret('ref-1')).toBe(true)
    expect(store.hasSecret('ref-unknown')).toBe(false)

    /** 密文文件不得出现明文密码。 */
    const raw = readFileSync(join(configDir, 'server-ops', 'data-source-credentials.json'), 'utf8')
    expect(raw).not.toContain('p@ssw0rd')
    /** 落盘内容必须是 base64 密文，而不是可读的明文包装。 */
    const persistedCipher = (JSON.parse(raw) as { credentials: Array<{ ciphertext: string }> }).credentials[0]!.ciphertext
    expect(Buffer.from(persistedCipher, 'base64').toString('utf8')).toBe('enc:p@ssw0rd')

    /** 覆盖写入保持同一 ref，避免数据源元数据失效。 */
    expect(store.setSecret('host-1', 'source-1', 'next-secret')).toBe('ref-1')
    expect(store.getSecretVersion(ref)).not.toBe(firstVersion)
    expect(store.resolveSecret('ref-1')).toBe('next-secret')
    expect(store.removeSecret('source-1')).toBe(true)
    expect(store.resolveSecret('ref-1')).toBeUndefined()
    expect(store.getSecretVersion(ref)).toBeUndefined()
    expect(store.removeSecret('source-1')).toBe(false)
  })

  test('Given 两个数据源 When 保存 Then ref 各自独立且互不串用', () => {
    const configDir = createConfigDir()
    let sequence = 0
    const store = new ServerOpsDataSourceCredentialStore(configDir, {
      safeStorage: createFakeSafeStorage(), uuid: () => `ref-${++sequence}`, now: () => 1_000,
    })
    expect(store.setSecret('host-1', 'source-1', 'one')).toBe('ref-1')
    expect(store.setSecret('host-1', 'source-2', 'two')).toBe('ref-2')
    expect(store.resolveSecret('ref-1')).toBe('one')
    expect(store.resolveSecret('ref-2')).toBe('two')
    expect(store.removeByHost('host-1')).toBe(2)
    expect(store.resolveSecret('ref-1')).toBeUndefined()
  })

  test('Given safeStorage 不可用 When 保存或解密 Then fail closed', () => {
    const configDir = createConfigDir()
    const unavailable = { ...createFakeSafeStorage(), isEncryptionAvailable: () => false }
    const store = new ServerOpsDataSourceCredentialStore(configDir, {
      safeStorage: unavailable, uuid: () => 'ref-1', now: () => 1_000,
    })
    expect(() => store.setSecret('host-1', 'source-1', 'secret')).toThrow('SERVER_OPS_SECURE_STORAGE_UNAVAILABLE')
  })

  test('Given 未注入 safeStorage When 保存 Then 报接线错误而不是误导性的系统不可用', () => {
    const configDir = createConfigDir()
    // 主进程漏注入 safeStorage 时，Store 会退化成 fail-closed 占位实现；
    // 这时必须报"未接线"，否则会被当成系统密钥库不可用而查错方向。
    const store = new ServerOpsDataSourceCredentialStore(configDir, { uuid: () => 'ref-1', now: () => 1_000 })
    expect(() => store.setSecret('host-1', 'source-1', 'secret')).toThrow('SERVER_OPS_SAFE_STORAGE_NOT_INJECTED')
  })

  test('Given Linux basic_text 后端 When 保存 Then fail closed', () => {
    const configDir = createConfigDir()
    const insecure = { ...createFakeSafeStorage(), getSelectedStorageBackend: () => 'basic_text' as const }
    const store = new ServerOpsDataSourceCredentialStore(configDir, {
      platform: 'linux', safeStorage: insecure, uuid: () => 'ref-1', now: () => 1_000,
    })
    expect(() => store.setSecret('host-1', 'source-1', 'secret')).toThrow('SERVER_OPS_SECURE_STORAGE_UNAVAILABLE')
  })

  test('Given 密文损坏 When 解密 Then 抛稳定错误而不是返回空串', () => {
    const configDir = createConfigDir()
    const store = new ServerOpsDataSourceCredentialStore(configDir, {
      safeStorage: createFakeSafeStorage(), uuid: () => 'ref-1', now: () => 1_000,
    })
    store.setSecret('host-1', 'source-1', 'secret')
    writeFileSync(
      join(configDir, 'server-ops', 'data-source-credentials.json'),
      JSON.stringify({ version: 1, credentials: [{ ref: 'ref-1', sourceId: 'source-1', hostId: 'host-1', ciphertext: 'bm90LWVuYw==', createdAt: 1, updatedAt: 1 }] }),
    )
    expect(() => store.resolveSecret('ref-1')).toThrow('SERVER_OPS_DATA_CREDENTIAL_CORRUPTED')
  })

  test('Given 凭据文件损坏 When 读取 Then fail closed 而不是当作空文件覆盖', () => {
    const configDir = createConfigDir()
    const store = new ServerOpsDataSourceCredentialStore(configDir, {
      safeStorage: createFakeSafeStorage(), uuid: () => 'ref-1', now: () => 1_000,
    })
    expect(store.hasSecret('ref-1')).toBe(false)
    writeFileSync(join(configDir, 'server-ops', 'data-source-credentials.json'), '{ broken')
    expect(() => store.hasSecret('ref-1')).toThrow('SERVER_OPS_DATA_CREDENTIAL_READ_FAILED')
  })
})
