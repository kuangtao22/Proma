import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerOpsDataSourceUpsertInput } from '@proma/shared'
import { ServerOpsDataService } from './server-ops-data-service'
import type { ServerOpsStoredDataSource } from './server-ops-data-source-store'
import { ServerOpsDataSchemaCache } from './server-ops-data-schema-cache'
import type { ServerOpsDataSchemaCacheScope, ServerOpsDataSchemaCacheValue } from './server-ops-data-schema-cache'
import type { ServerOpsRuntimeDataReadRequest, ServerOpsRuntimeDataReadResult } from '../../../utility/server-ops/server-ops-runtime-protocol'

/** 内存数据源 Store 替身，只实现服务实际使用的方法。 */
class FakeSourceStore {
  /** 当前记录集合。 */
  private readonly sources: ServerOpsStoredDataSource[] = []
  /** 自增 ID 计数器。 */
  private sequence = 0

  list(): ServerOpsStoredDataSource[] {
    return this.sources.map((source) => ({ ...source }))
  }

  getById(sourceId: string): ServerOpsStoredDataSource | undefined {
    /** 按稳定身份定位记录。 */
    const found = this.sources.find((source) => source.id === sourceId)
    return found ? { ...found } : undefined
  }

  create(input: ServerOpsDataSourceUpsertInput, credentialRef?: string): ServerOpsStoredDataSource {
    /** 新建记录使用的稳定 ID。 */
    const id = `source-${++this.sequence}`
    /** 新建后的内部记录。 */
    const created: ServerOpsStoredDataSource = {
      id,
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      transport: input.transport,
      ...(input.hostId === undefined ? {} : { hostId: input.hostId }),
      engine: input.engine,
      label: input.label,
      address: input.address,
      port: input.port,
      ...(input.database === undefined ? {} : { database: input.database }),
      ...(input.username === undefined ? {} : { username: input.username }),
      tlsMode: input.tlsMode,
      ...(input.tlsServerName === undefined ? {} : { tlsServerName: input.tlsServerName }),
      ...(credentialRef === undefined ? {} : { credentialRef }),
      createdAt: 1_000,
      updatedAt: 1_000,
    }
    this.sources.push(created)
    return { ...created }
  }

  update(
    sourceId: string,
    patch: {
      projectId?: string; transport?: ServerOpsStoredDataSource['transport']; hostId?: string | null; label?: string
      address?: string; port?: number; database?: string | null; username?: string | null
      tlsMode?: ServerOpsStoredDataSource['tlsMode']; tlsServerName?: string | null; credentialRef?: string | null
    },
  ): ServerOpsStoredDataSource {
    /** 待更新记录的位置。 */
    const index = this.sources.findIndex((source) => source.id === sourceId)
    if (index < 0) throw new Error('SERVER_OPS_DATA_SOURCE_NOT_FOUND')
    /** 当前记录副本。 */
    const updated = { ...this.sources[index]! }
    if (patch.projectId !== undefined && patch.projectId !== updated.projectId) {
      throw new Error('SERVER_OPS_DATA_SOURCE_PROJECT_MISMATCH')
    }
    if (patch.label !== undefined) updated.label = patch.label
    if (patch.transport !== undefined) updated.transport = patch.transport
    if (patch.hostId === null) delete updated.hostId
    else if (patch.hostId !== undefined) updated.hostId = patch.hostId
    if (patch.address !== undefined) updated.address = patch.address
    if (patch.port !== undefined) updated.port = patch.port
    if (patch.database === null) delete updated.database
    else if (patch.database !== undefined) updated.database = patch.database
    if (patch.username === null) delete updated.username
    else if (patch.username !== undefined) updated.username = patch.username
    if (patch.tlsMode !== undefined) updated.tlsMode = patch.tlsMode
    if (patch.tlsServerName === null) delete updated.tlsServerName
    else if (patch.tlsServerName !== undefined) updated.tlsServerName = patch.tlsServerName
    if (patch.credentialRef === null) delete updated.credentialRef
    else if (patch.credentialRef !== undefined) updated.credentialRef = patch.credentialRef
    this.sources[index] = updated
    return { ...updated }
  }

  /** 测试独立移动：只改变归属，保留密码引用供服务层投影。 */
  move(sourceId: string, fromProjectId: string, targetProjectId: string): ServerOpsStoredDataSource {
    const index = this.sources.findIndex((source) => source.id === sourceId)
    if (index < 0) throw new Error('SERVER_OPS_DATA_SOURCE_NOT_FOUND')
    const existing = this.sources[index]!
    if (existing.projectId !== fromProjectId) throw new Error('SERVER_OPS_CONNECTION_PROJECT_CHANGED')
    const moved = { ...existing, projectId: targetProjectId, updatedAt: 2_000 }
    this.sources[index] = moved
    return { ...moved }
  }

  remove(sourceId: string): boolean {
    /** 待删除记录的位置。 */
    const index = this.sources.findIndex((source) => source.id === sourceId)
    if (index < 0) return false
    this.sources.splice(index, 1)
    return true
  }

  removeByHost(hostId: string): number {
    /** 删除前的主机数据源数量。 */
    const before = this.sources.length
    for (let index = this.sources.length - 1; index >= 0; index -= 1) {
      if (this.sources[index]!.hostId === hostId) this.sources.splice(index, 1)
    }
    return before - this.sources.length
  }
}

/** 内存凭据 Store 替身，明文只存在内存里。 */
class FakeCredentialStore {
  /** ref 到主机、数据源与明文的映射。 */
  private readonly secrets = new Map<string, { hostId: string; sourceId: string; secret: string }>()
  /** 自增 ref 计数器。 */
  private sequence = 0

  setSecret(hostId: string, sourceId: string, secret: string): string {
    /** 同一数据源复用原 ref。 */
    const existing = [...this.secrets.entries()].find(([, value]) => value.sourceId === sourceId)
    if (existing) {
      this.secrets.set(existing[0], { hostId, sourceId, secret })
      return existing[0]
    }
    /** 新建的稳定 ref。 */
    const ref = `ref-${++this.sequence}`
    this.secrets.set(ref, { hostId, sourceId, secret })
    return ref
  }

  resolveSecret(ref: string): string | undefined {
    return this.secrets.get(ref)?.secret
  }

  /** 密文版本替身；测试中用明文变化模拟 safeStorage 密文变化。 */
  getSecretVersion(ref: string): string | undefined {
    const secret = this.secrets.get(ref)?.secret
    return secret === undefined ? undefined : `version:${secret}`
  }

  removeSecret(sourceId: string): boolean {
    /** 本次是否实际删除。 */
    let removed = false
    for (const [ref, entry] of [...this.secrets]) {
      if (entry.sourceId !== sourceId) continue
      this.secrets.delete(ref)
      removed = true
    }
    return removed
  }

  removeByHost(hostId: string): number {
    /** 记录实际删除的条数。 */
    let removed = 0
    for (const [ref, entry] of [...this.secrets]) {
      if (entry.hostId !== hostId) continue
      this.secrets.delete(ref)
      removed += 1
    }
    return removed
  }
}

/** 内存 schema 缓存替身，记录失效范围与写入次数。 */
class FakeSchemaCache {
  /** 精确范围与身份到值的映射。 */
  private readonly entries = new Map<string, ServerOpsDataSchemaCacheValue>()
  /** 服务触发的失效范围。 */
  readonly invalidations: Array<{ sourceId: string; database?: string; table?: string }> = []
  /** 实际写入缓存的次数。 */
  writes = 0
  /** 测试缓存故障降级时注入写失败。 */
  failWrites = false
  /** 测试 refresh 失效提交失败时注入异常。 */
  failInvalidations = false
  /** 模拟跨实例 fresh-read CAS 的全局代次。 */
  private revision = 0

  /** 生成无分隔符碰撞的精确键。 */
  private key(scope: ServerOpsDataSchemaCacheScope, identity: string): string {
    return JSON.stringify([scope.kind, scope.sourceId, scope.database ?? null, scope.kind === 'table' ? scope.table : null, identity])
  }

  /** 返回精确身份命中的缓存副本。 */
  get(scope: ServerOpsDataSchemaCacheScope, identity: string): { value: ServerOpsDataSchemaCacheValue; cachedAt: number } | undefined {
    const value = this.entries.get(this.key(scope, identity))
    return value === undefined ? undefined : { value: structuredClone(value), cachedAt: 1_000 }
  }

  /** 返回当前代次和可选命中。 */
  lookup(scope: ServerOpsDataSchemaCacheScope, identity: string): { revision: number; value?: ServerOpsDataSchemaCacheValue; cachedAt?: number } {
    const found = this.get(scope, identity)
    return found === undefined ? { revision: this.revision } : { revision: this.revision, ...found }
  }

  /** 保存精确身份的结果副本。 */
  set(scope: ServerOpsDataSchemaCacheScope, identity: string, value: ServerOpsDataSchemaCacheValue): void {
    if (this.failWrites) throw new Error('CACHE_WRITE_FAILED')
    this.writes += 1
    this.entries.set(this.key(scope, identity), structuredClone(value))
    this.revision += 1
  }

  /** 仅代次未变化时写入，模拟生产 Store 的跨实例 CAS。 */
  setIfRevision(scope: ServerOpsDataSchemaCacheScope, identity: string, value: ServerOpsDataSchemaCacheValue, expectedRevision: number): boolean {
    if (expectedRevision !== this.revision) return false
    this.set(scope, identity, value)
    return true
  }

  /** 按 source / database / table 范围失效。 */
  invalidate(scope: { sourceId: string; database?: string; table?: string }): void {
    if (this.failInvalidations) throw new Error('CACHE_INVALIDATE_FAILED')
    this.invalidations.push({ ...scope })
    for (const key of [...this.entries.keys()]) {
      const [kind, sourceId, database, table] = JSON.parse(key) as [string, string, string | null, string | null]
      if (sourceId === scope.sourceId
        && (scope.database === undefined || database === scope.database)
        && (scope.table === undefined || (kind === 'table' && table === scope.table))) this.entries.delete(key)
    }
    this.revision += 1
  }
}

/** 创建一个受控 runtime 替身，可手动结算在途读取。 */
function createRuntimeHarness() {
  /** 已收到的读取请求。 */
  const requests: Array<Omit<ServerOpsRuntimeDataReadRequest, 'requestId'>> = []
  /** 待手动结算的读取。 */
  const pending: Array<{ resolve: (result: ServerOpsRuntimeDataReadResult) => void; reject: (error: Error) => void }> = []
  /** 每次读取收到的取消信号。 */
  const signals: Array<AbortSignal | undefined> = []
  return {
    requests,
    signals,
    settle(result: ServerOpsRuntimeDataReadResult): void {
      pending.shift()?.resolve(result)
    },
    fail(error: Error): void {
      pending.shift()?.reject(error)
    },
    dataRead(input: Omit<ServerOpsRuntimeDataReadRequest, 'requestId'>, signal?: AbortSignal): Promise<ServerOpsRuntimeDataReadResult> {
      requests.push(input)
      signals.push(signal)
      return new Promise<ServerOpsRuntimeDataReadResult>((resolve, reject) => { pending.push({ resolve, reject }) })
    },
  }
}

/** 可用诊断结果。 */
const availableResult: ServerOpsRuntimeDataReadResult = {
  capability: 'available',
  serverVersion: '8.0.36',
  metrics: [{ id: 'threads-connected', label: '活跃连接', value: '12 / 200', ratio: 0.06 }],
  tables: [{ id: 'databases', title: '数据库', columns: [{ id: 'name', label: '名称' }], rows: [['app']], truncated: false }],
  warnings: [],
}

/** 构造服务与替身。 */
function createService(options: {
  /** 是否模拟 SSH 已连接。 */
  connected?: boolean
  /** 可替换的服务时间源。 */
  now?: () => number
  /** 是否注入可控内存缓存替身。 */
  cache?: boolean
  /** 可选真实 schema 缓存，用于跨 Store 集成回归。 */
  schemaCache?: ServerOpsDataSchemaCache
} = {}) {
  const store = new FakeSourceStore()
  const credentials = new FakeCredentialStore()
  /** 可控 runtime。 */
  const runtime = createRuntimeHarness()
  /** 记录 getActiveIdentity 调用的主机。 */
  const identityCalls: string[] = []
  /** 当前 SSH 活跃代次，可由竞态测试推进。 */
  let connectionGeneration = 1
  const schemaCache = new FakeSchemaCache()
  /** 可选真实缓存供 Store 与服务集成回归使用，其余用例继续使用可控替身。 */
  const injectedSchemaCache = options.schemaCache ?? (options.cache === true ? schemaCache : undefined)
  const service = new ServerOpsDataService({
    store,
    credentials,
    connection: {
      getActiveIdentity: (hostId: string) => {
        identityCalls.push(hostId)
        if (options.connected === false) throw new Error('SERVER_OPS_CONNECTION_NOT_ACTIVE')
        return { hostId, connectionId: `connection-${connectionGeneration}`, generation: connectionGeneration }
      },
    },
    runtime,
    now: options.now ?? (() => 5_000),
    ...(injectedSchemaCache === undefined ? {} : { schemaCache: injectedSchemaCache }),
  })
  return {
    service, store, credentials, runtime, identityCalls, schemaCache,
    advanceConnection: () => { connectionGeneration += 1 },
  }
}

/** 构造数据源写入输入。 */
function createInput(overrides: Partial<ServerOpsDataSourceUpsertInput> = {}): ServerOpsDataSourceUpsertInput {
  return {
    transport: 'ssh',
    hostId: 'host-1',
    engine: 'mysql',
    label: '业务主库',
    address: '127.0.0.1',
    port: 3306,
    username: 'monitor',
    tlsMode: 'disabled',
    ...overrides,
  }
}

describe('服务器运维数据服务编排', () => {
  test('Given 新建数据源 When 带密码 Then 只暴露 hasPassword 且密码可解密复用', () => {
    const { service, credentials } = createService()
    const created = service.upsertSource(createInput({ password: 'p@ss' }))
    expect(created.source.hasPassword).toBe(true)
    expect(created.source.id).toBe('source-1')
    expect(credentials.resolveSecret('ref-1')).toBe('p@ss')
    expect(service.listSources()).toEqual({ sources: [created.source] })
    /** 未归属任何主机的直连数据源同样出现在全局列表里。 */
    service.upsertSource(createInput({ transport: 'direct', hostId: undefined, label: '本机库' }))
    expect(service.listSources().sources.map((source) => source.label)).toEqual(['业务主库', '本机库'])
  })

  test('Given 编辑数据源 When 不提供密码 Then 保留原密文；提供清除则删除', () => {
    const { service, credentials } = createService()
    /** 先建带密码的数据源。 */
    const created = service.upsertSource(createInput({ password: 'p@ss' }))
    const kept = service.upsertSource(createInput({ sourceId: created.source.id, label: '改名' }))
    expect(kept.source.hasPassword).toBe(true)
    expect(kept.source.label).toBe('改名')
    const cleared = service.upsertSource(createInput({ sourceId: created.source.id, clearPassword: true }))
    expect(cleared.source.hasPassword).toBe(false)
    expect(credentials.resolveSecret('ref-1')).toBeUndefined()
  })

  test('Given 数据源归属项目 When 新建和编辑 Then 服务透传归属且拒绝迁移', () => {
    const { service, credentials } = createService()
    /** 显式归入项目一的数据源。 */
    const created = service.upsertSource(createInput({ projectId: 'project-1', password: 'old-secret' }))
    expect(created.source.projectId).toBe('project-1')
    expect(service.upsertSource(createInput({ sourceId: created.source.id, projectId: 'project-1', label: '改名' })).source.projectId)
      .toBe('project-1')
    expect(() => service.upsertSource(createInput({ sourceId: created.source.id, projectId: 'project-2', password: 'new-secret' })))
      .toThrow('SERVER_OPS_DATA_SOURCE_PROJECT_MISMATCH')
    expect(credentials.resolveSecret('ref-1')).toBe('old-secret')
    expect(() => service.upsertSource(createInput({ sourceId: created.source.id, projectId: 'project-2', clearPassword: true })))
      .toThrow('SERVER_OPS_DATA_SOURCE_PROJECT_MISMATCH')
    expect(credentials.resolveSecret('ref-1')).toBe('old-secret')
  })

  test('Given 带密码的数据源 When 独立移动 Then 返回公开投影且不泄漏 credentialRef', () => {
    const { service } = createService()
    const created = service.upsertSource(createInput({ projectId: 'project-1', password: 'old-secret' }))

    const moved = service.moveSource(created.source.id, 'project-1', 'project-2')

    expect(moved).toMatchObject({ id: created.source.id, projectId: 'project-2', hasPassword: true, updatedAt: 2_000 })
    expect('credentialRef' in moved).toBe(false)
  })

  test('Given 数据源已不存在 When 编辑或删除 Then 返回稳定不存在错误', () => {
    const { service } = createService()
    /** 直接引用一个从未创建过的数据源身份。 */
    expect(() => service.upsertSource(createInput({ sourceId: 'source-missing', label: '改名' })))
      .toThrow('SERVER_OPS_DATA_SOURCE_NOT_FOUND')
    expect(() => service.deleteSource({ sourceId: 'source-missing' }))
      .toThrow('SERVER_OPS_DATA_SOURCE_NOT_FOUND')
  })

  test('Given 删除数据源 When 提交 Then 元数据与密文一起清理', () => {
    const { service, credentials } = createService()
    /** 先建带密码的数据源。 */
    const created = service.upsertSource(createInput({ password: 'p@ss' }))
    service.deleteSource({ sourceId: created.source.id })
    expect(service.listSources().sources).toEqual([])
    expect(credentials.resolveSecret('ref-1')).toBeUndefined()
  })

  test('Given 连接测试 When 成功 Then 返回版本与往返耗时且密码进入请求', async () => {
    const { service, runtime } = createService({ now: () => 5_000 })
    /** 先建带密码的数据源。 */
    const created = service.upsertSource(createInput({ password: 'p@ss' }))
    const pending = service.probeSource({ sourceId: created.source.id })
    expect(runtime.requests[0]!.mode).toBe('probe')
    expect(runtime.requests[0]!.password).toBe('p@ss')
    expect(runtime.requests[0]!.connectionId).toBe('connection-1')
    expect(runtime.requests[0]!.timeoutMs).toBe(15_000)
    runtime.settle(availableResult)
    const result = await pending
    expect(result).toMatchObject({ capability: 'available', serverVersion: '8.0.36', latencyMs: 0, engine: 'mysql' })
  })

  test('Given 只读诊断 When 成功 Then 返回指标表格与采集时间', async () => {
    const { service, runtime } = createService({ now: () => 7_777 })
    /** 先建数据源。 */
    const created = service.upsertSource(createInput())
    const pending = service.diagnoseSource({ sourceId: created.source.id })
    runtime.settle(availableResult)
    const result = await pending
    expect(result.collectedAt).toBe(7_777)
    expect(result.metrics[0]!.id).toBe('threads-connected')
    expect(result.tables[0]!.rows).toEqual([['app']])
  })

  test('Given 分区诊断 When 读取 Then section 进入 runtime 且单飞键按分区隔离', async () => {
    const { service, runtime } = createService()
    const created = service.upsertSource(createInput())
    const sessions = service.diagnoseSource({ sourceId: created.source.id, section: 'sessions' })
    expect(runtime.requests[0]).toMatchObject({ mode: 'diagnostics', diagnosticSection: 'sessions' })
    const parameters = service.diagnoseSource({ sourceId: created.source.id, section: 'parameters' })
    expect(runtime.requests[1]).toMatchObject({ mode: 'diagnostics', diagnosticSection: 'parameters' })
    runtime.settle(availableResult)
    runtime.settle({ ...availableResult, parameters: [{ name: 'autocommit', value: 'ON', scope: 'global' }], parametersTruncated: false })
    await sessions
    await expect(parameters).resolves.toMatchObject({ parameters: [{ name: 'autocommit', value: 'ON', scope: 'global' }] })
  })

  test('Given MySQL 会话按库诊断 When 并发读取不同库 Then runtime 参数与单飞键均按库隔离', async () => {
    const { service, runtime } = createService()
    const created = service.upsertSource(createInput())
    const app = service.diagnoseSource({ sourceId: created.source.id, section: 'sessions', database: 'app' })
    const audit = service.diagnoseSource({ sourceId: created.source.id, section: 'sessions', database: 'audit log' })
    expect(runtime.requests).toHaveLength(2)
    expect(runtime.requests[0]).toMatchObject({ diagnosticSection: 'sessions', diagnosticDatabase: 'app' })
    expect(runtime.requests[1]).toMatchObject({ diagnosticSection: 'sessions', diagnosticDatabase: 'audit log' })
    runtime.settle(availableResult)
    runtime.settle(availableResult)
    await Promise.all([app, audit])
  })

  test('Given Redis 或实例级诊断 When 携带数据库 Then 主进程拒绝歧义请求', async () => {
    const mysql = createService()
    const mysqlSource = mysql.service.upsertSource(createInput()).source
    await expect(mysql.service.diagnoseSource({ sourceId: mysqlSource.id, section: 'parameters', database: 'app' }))
      .rejects.toThrow('SERVER_OPS_DATA_DIAGNOSE_INPUT_INVALID')
    expect(mysql.runtime.requests).toEqual([])

    const redis = createService()
    const redisSource = redis.service.upsertSource(createInput({ engine: 'redis', port: 6379, database: '0' })).source
    await expect(redis.service.diagnoseSource({ sourceId: redisSource.id, section: 'sessions', database: '0' }))
      .rejects.toThrow('SERVER_OPS_DATA_DIAGNOSE_INPUT_INVALID')
    expect(redis.runtime.requests).toEqual([])
  })

  test('Given 同数据源重复读取 When 前一次未完成 Then 拒绝而不是排队', async () => {
    const { service, runtime } = createService()
    /** 先建数据源。 */
    const created = service.upsertSource(createInput())
    const first = service.diagnoseSource({ sourceId: created.source.id })
    await expect(service.diagnoseSource({ sourceId: created.source.id }))
      .rejects.toThrow('SERVER_OPS_DATA_SOURCE_BUSY')
    runtime.settle(availableResult)
    await first
    expect(runtime.requests).toHaveLength(1)
  })

  test('Given 全局并发已满 When 新读取 Then 拒绝而不是排队', async () => {
    const { service, runtime } = createService()
    /** 建立四个不同数据源以突破全局上限。 */
    const sources = [1, 2, 3, 4].map(() => service.upsertSource(createInput()).source)
    const pending = sources.slice(0, 3).map((source) => service.diagnoseSource({ sourceId: source.id }))
    await expect(service.diagnoseSource({ sourceId: sources[3]!.id }))
      .rejects.toThrow('SERVER_OPS_DATA_BUSY')
    for (let index = 0; index < 3; index += 1) runtime.settle(availableResult)
    await Promise.all(pending)
  })

  test('Given SSH 未连接 When 读取 Then 直接拒绝且不消耗并发', async () => {
    const { service, runtime } = createService({ connected: false })
    /** 先建数据源。 */
    const created = service.upsertSource(createInput())
    await expect(service.diagnoseSource({ sourceId: created.source.id }))
      .rejects.toThrow('SERVER_OPS_CONNECTION_NOT_ACTIVE')
    expect(runtime.requests).toEqual([])
  })

  test('Given runtime 失败 When 读取 Then 异常向上抛出且并发标记释放', async () => {
    const { service, runtime } = createService()
    /** 先建数据源。 */
    const created = service.upsertSource(createInput())
    const pending = service.probeSource({ sourceId: created.source.id })
    runtime.fail(new Error('SERVER_OPS_DATA_TIMEOUT'))
    await expect(pending).rejects.toThrow('SERVER_OPS_DATA_TIMEOUT')
    /** 释放后可以立即重新发起同一数据源读取。 */
    const retry = service.probeSource({ sourceId: created.source.id })
    runtime.settle(availableResult)
    expect((await retry).capability).toBe('available')
  })

  test('Given 服务进入终态 When 继续操作 Then 拒绝', () => {
    const { service } = createService()
    service.dispose()
    expect(() => service.upsertSource(createInput())).toThrow('SERVER_OPS_DATA_UNAVAILABLE')
    expect(service.listSources().sources).toEqual([])
  })

  test('Given 主机被删除 When 清理 Then 数据源与密码密文一并移除', () => {
    const { service, credentials } = createService()
    /** 同一主机下的两个数据源。 */
    const first = service.upsertSource(createInput({ password: 'p@ss' }))
    service.upsertSource(createInput({ password: 'other' }))
    service.removeHost('host-1')
    expect(service.listSources().sources).toEqual([])
    expect(credentials.resolveSecret('ref-1')).toBeUndefined()
    /** 已删除的数据源不能再被读取。 */
    expect(() => service.deleteSource({ sourceId: first.source.id }))
      .toThrow('SERVER_OPS_DATA_SOURCE_NOT_FOUND')
  })

  test('Given 未保存草稿 When 测试连接 Then 用内联密码走 runtime 且不落盘', async () => {
    const { service, store, runtime, identityCalls } = createService()
    /** 一条还没保存的直连草稿。 */
    const pending = service.probeSource({ draft: {
      transport: 'direct', engine: 'redis', address: '127.0.0.1', port: 16379, username: 'default',
      password: 'secret', tlsMode: 'disabled',
    } })
    expect(runtime.requests).toHaveLength(1)
    expect(runtime.requests[0]).toMatchObject({
      transport: 'direct', mode: 'probe', engine: 'redis', address: '127.0.0.1', port: 16379, password: 'secret',
    })
    /** 直连不依赖任何主机连接。 */
    expect(identityCalls).toEqual([])
    runtime.settle({ capability: 'available', serverVersion: '7.2.4', metrics: [], tables: [], warnings: [] })
    expect(await pending).toEqual({ engine: 'redis', capability: 'available', serverVersion: '7.2.4', latencyMs: 0, warnings: [] })
    /** 草稿测试绝不产生数据源记录。 */
    expect(store.list()).toEqual([])
  })

  test('Given 经跳板草稿 When 测试连接 Then 复用当前活跃连接身份', async () => {
    const { service, runtime, identityCalls } = createService()
    const pending = service.probeSource({ draft: {
      transport: 'ssh', hostId: 'host-1', engine: 'mysql', address: '10.0.0.9', port: 3306, tlsMode: 'disabled',
    } })
    expect(identityCalls).toEqual(['host-1'])
    expect(runtime.requests[0]).toMatchObject({ transport: 'ssh', hostId: 'host-1', connectionId: 'connection-1' })
    runtime.settle(availableResult)
    expect((await pending).capability).toBe('available')
  })

  test('Given 编辑态复用已保存密码 When 测试连接 Then 解密旧密文而不要求重填', async () => {
    const { service, credentials, runtime } = createService()
    /** 已保存且带密码的数据源。 */
    const created = service.upsertSource(createInput({ password: 'p@ss' }))
    const pending = service.probeSource({ draft: {
      transport: 'ssh', hostId: 'host-1', engine: 'mysql', address: '127.0.0.1', port: 3306,
      savedSourceId: created.source.id, tlsMode: 'disabled',
    } })
    expect(credentials.resolveSecret('ref-1')).toBe('p@ss')
    expect(runtime.requests[0]).toMatchObject({ password: 'p@ss' })
    runtime.settle(availableResult)
    await pending
  })

  test('Given 直连非回环且关闭 TLS When 测试草稿 Then 与保存路径同一条硬规则', async () => {
    const { service, runtime } = createService()
    await expect(service.probeSource({ draft: {
      transport: 'direct', engine: 'mysql', address: '8.8.8.8', port: 3306, tlsMode: 'disabled',
    } })).rejects.toThrow('SERVER_OPS_DATA_TLS_REQUIRED')
    expect(runtime.requests).toEqual([])
  })

  test('Given 私有网段直连且关闭 TLS When 读取 Then 放行并照常带上密码', async () => {
    /** 内网数据库：允许明文直连，但要真的发出请求。 */
    const { service, store, runtime } = createService()
    const pending = service.probeSource({ draft: {
      transport: 'direct', engine: 'mysql', address: '172.16.10.198', port: 3306, username: 'yuxutao',
      password: 'p@ss', tlsMode: 'disabled',
    } })
    expect(runtime.requests[0]).toMatchObject({ transport: 'direct', address: '172.16.10.198', password: 'p@ss' })
    runtime.settle({ capability: 'available', serverVersion: '8.0.36', metrics: [], tables: [], warnings: [] })
    expect((await pending).capability).toBe('available')
    /** 明文放行不等于放行落盘：草稿依然不产生任何数据源记录。 */
    expect(store.list()).toEqual([])
  })

  test('Given 已保存的内网明文连接 When 只读诊断 Then 与草稿走同一条判据', async () => {
    const { service, runtime } = createService()
    /** 直连内网且关闭 TLS 的数据源。 */
    const created = service.upsertSource(createInput({
      transport: 'direct', hostId: undefined, address: '192.168.31.20', tlsMode: 'disabled',
    }))
    const pending = service.diagnoseSource({ sourceId: created.source.id })
    expect(runtime.requests[0]).toMatchObject({ mode: 'diagnostics', address: '192.168.31.20' })
    runtime.settle({ capability: 'available', serverVersion: '8.0.36', metrics: [], tables: [], warnings: [] })
    await pending
  })

  test('Given 主机名直连且关闭 TLS When 读取 Then 仍拒绝并要求 TLS', async () => {
    /** 主机名无法离线判定归属，因此不在明文白名单里。 */
    const { service, runtime } = createService()
    await expect(service.probeSource({ draft: {
      transport: 'direct', engine: 'mysql', address: 'db.internal', port: 3306, tlsMode: 'disabled',
    } })).rejects.toThrow('SERVER_OPS_DATA_TLS_REQUIRED')
    expect(runtime.requests).toEqual([])
  })

  test('Given 复用不存在的数据源 When 测试草稿 Then 报数据源不存在而不是静默无密码连接', async () => {
    const { service, runtime } = createService()
    await expect(service.probeSource({ draft: {
      transport: 'ssh', hostId: 'host-1', engine: 'mysql', address: '127.0.0.1', port: 3306,
      savedSourceId: 'source-missing', tlsMode: 'disabled',
    } })).rejects.toThrow('SERVER_OPS_DATA_SOURCE_NOT_FOUND')
    expect(runtime.requests).toEqual([])
  })

  test('Given 密码写入失败 When 新建数据源 Then 回滚元数据不留半成品', () => {
    /** 让密文写入稳定失败，模拟系统安全存储不可用。 */
    const store = new FakeSourceStore()
    /** 凭据 Store 替身：写入即抛错。 */
    const failingCredentials = {
      setSecret: () => { throw new Error('SERVER_OPS_SECURE_STORAGE_UNAVAILABLE') },
      resolveSecret: () => undefined,
      removeSecret: () => false,
      removeByHost: () => 0,
    }
    const service = new ServerOpsDataService({
      store,
      credentials: failingCredentials,
      connection: { getActiveIdentity: (hostId: string) => ({ hostId, connectionId: 'connection-1', generation: 1 }) },
      runtime: createRuntimeHarness(),
    })
    expect(() => service.upsertSource(createInput({ password: 'p@ss' })))
      .toThrow('SERVER_OPS_SECURE_STORAGE_UNAVAILABLE')
    /** 失败后不得留下没有密码的数据源。 */
    expect(store.list()).toEqual([])
  })

  test('Given 已保存密码 When 读取明文 Then 返回同一条密文的明文且不产生第二份记录', () => {
    const { service, store } = createService()
    /** 带密码的数据源。 */
    const created = service.upsertSource(createInput({ password: 'p@ss' }))
    expect(service.revealSourcePassword({ sourceId: created.source.id })).toEqual({ password: 'p@ss' })
    /** 读取明文不得改动元数据与记录数。 */
    expect(store.list()).toHaveLength(1)
    expect(store.list()[0]!.updatedAt).toBe(created.source.updatedAt)
  })

  test('Given 没有保存密码或数据源不存在 When 读取明文 Then 返回 null 或稳定错误', () => {
    const { service } = createService()
    /** 未设置密码的数据源：返回 null，让界面提示"请直接填写"。 */
    const created = service.upsertSource(createInput())
    expect(service.revealSourcePassword({ sourceId: created.source.id })).toEqual({ password: null })
    expect(() => service.revealSourcePassword({ sourceId: 'source-missing' }))
      .toThrow('SERVER_OPS_DATA_SOURCE_NOT_FOUND')
  })

  test('Given 密文损坏 When 读取明文 Then 抛稳定错误而不是返回空串', () => {
    const { service, credentials } = createService()
    /** 先存一份密码，再让解密稳定失败。 */
    const created = service.upsertSource(createInput({ password: 'p@ss' }))
    credentials.resolveSecret = () => { throw new Error('SERVER_OPS_DATA_CREDENTIAL_CORRUPTED') }
    expect(() => service.revealSourcePassword({ sourceId: created.source.id }))
      .toThrow('SERVER_OPS_DATA_CREDENTIAL_CORRUPTED')
  })

  test('Given 表浏览请求 When 读取 Then 走同一条只读通道并带上库表参数', async () => {
    const { service, runtime } = createService()
    /** 已保存的直连数据源；表浏览复用它的连接与凭据。 */
    const created = service.upsertSource(createInput({ transport: 'direct', hostId: undefined, database: 'app', password: 'p@ss' }))

    const tablesPending = service.listSchemaTables({ sourceId: created.source.id })
    expect(runtime.requests[0]).toMatchObject({ mode: 'schema-tables', schemaDatabase: 'app', password: 'p@ss' })
    runtime.settle({
      mode: 'schema-tables',
      capability: 'available',
      database: 'app',
      databases: ['app'],
      tables: [{ name: 'users', engine: 'InnoDB', rows: 12 }],
      warnings: [],
    })
    expect(await tablesPending).toEqual({
      databases: ['app'],
      tables: [{ name: 'users', engine: 'InnoDB', rows: 12 }],
      database: 'app',
    })

    const structurePending = service.describeSchemaTable({ sourceId: created.source.id, database: 'app', table: 'users' })
    expect(runtime.requests[1]).toMatchObject({ mode: 'schema-table', schemaDatabase: 'app', schemaTable: 'users' })
    runtime.settle({
      mode: 'schema-table',
      capability: 'available',
      columns: [{ name: 'id', type: 'int', nullable: false, primaryKey: true }],
      indexes: [{ name: 'PRIMARY', unique: true, columns: ['id'] }],
      warnings: [],
    })
    expect((await structurePending).columns[0]?.name).toBe('id')

    const rowsPending = service.readSchemaRows({ sourceId: created.source.id, database: 'app', table: 'users', offset: 50, limit: 50 })
    expect(runtime.requests[2]).toMatchObject({ mode: 'schema-rows', rowOffset: 50, rowLimit: 50 })
    runtime.settle({
      mode: 'schema-rows',
      capability: 'available',
      columns: ['id'],
      rows: [['51']],
      offset: 50,
      limit: 50,
      truncated: false,
      warnings: [],
    })
    expect(await rowsPending).toMatchObject({ rows: [['51']], offset: 50, limit: 50 })
  })

  test('Given 未显式启用缓存 When 连续读取目录 Then 每次都实时访问 runtime', async () => {
    const { service, runtime } = createService({ cache: true })
    const created = service.upsertSource(createInput({ transport: 'direct', hostId: undefined, database: 'app' }))
    for (const tableName of ['users', 'orders']) {
      const pending = service.listSchemaTables({ sourceId: created.source.id })
      runtime.settle({ mode: 'schema-tables', capability: 'available', database: 'app', databases: ['app'], tables: [{ name: tableName }], warnings: [] })
      await pending
    }
    expect(runtime.requests).toHaveLength(2)
  })

  test('Given prefer-cache 目录读取 When 首次成功后再次读取 Then 返回缓存且不重复访问 runtime', async () => {
    const { service, runtime, schemaCache } = createService({ cache: true })
    const created = service.upsertSource(createInput({ transport: 'direct', hostId: undefined, database: 'app' }))
    const input = { sourceId: created.source.id, cacheMode: 'prefer-cache' as const }
    const first = service.listSchemaTables(input)
    runtime.settle({ mode: 'schema-tables', capability: 'available', database: 'app', databases: ['app'], tables: [{ name: 'users' }], warnings: [] })
    await expect(first).resolves.toMatchObject({ tables: [{ name: 'users' }] })
    await expect(service.listSchemaTables(input)).resolves.toMatchObject({ tables: [{ name: 'users' }] })
    expect(runtime.requests).toHaveLength(1)
    expect(schemaCache.writes).toBe(1)
  })

  test('Given 两个相同 prefer-cache 请求并发未命中 When 实时结果返回 Then 共用一次 runtime 读取', async () => {
    const { service, runtime } = createService({ cache: true })
    const created = service.upsertSource(createInput({ transport: 'direct', hostId: undefined, database: 'app' }))
    const input = { sourceId: created.source.id, database: 'app', table: 'users', cacheMode: 'prefer-cache' as const }
    const first = service.describeSchemaTable(input)
    const second = service.describeSchemaTable(input)
    expect(runtime.requests).toHaveLength(1)
    runtime.settle({ mode: 'schema-table', capability: 'available', columns: [], indexes: [], warnings: [] })
    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
  })

  test('Given 有凭据但缺少密文版本能力 When prefer-cache Then 禁用缓存并保持实时读取', async () => {
    const { service, runtime, credentials, schemaCache } = createService({ cache: true })
    Object.defineProperty(credentials, 'getSecretVersion', { value: undefined })
    const created = service.upsertSource(createInput({ transport: 'direct', hostId: undefined, database: 'app', password: 'secret' }))
    for (let index = 0; index < 2; index += 1) {
      const pending = service.listSchemaTables({ sourceId: created.source.id, cacheMode: 'prefer-cache' })
      runtime.settle({ mode: 'schema-tables', capability: 'available', database: 'app', databases: ['app'], tables: [], warnings: [] })
      await pending
    }
    expect(runtime.requests).toHaveLength(2)
    expect(schemaCache.writes).toBe(0)
  })

  test('Given 派生缓存写入失败 When 实时读取成功 Then 仍返回实时结果', async () => {
    const { service, runtime, schemaCache } = createService({ cache: true })
    schemaCache.failWrites = true
    const created = service.upsertSource(createInput({ transport: 'direct', hostId: undefined, database: 'app' }))
    const pending = service.listSchemaTables({ sourceId: created.source.id, cacheMode: 'prefer-cache' })
    runtime.settle({ mode: 'schema-tables', capability: 'available', database: 'app', databases: ['app'], tables: [{ name: 'users' }], warnings: [] })
    await expect(pending).resolves.toMatchObject({ tables: [{ name: 'users' }] })
  })

  test('Given refresh 目录读取 When 指定或未指定库 Then 失效对应库或整个数据源缓存', async () => {
    const { service, runtime, schemaCache } = createService({ cache: true })
    const created = service.upsertSource(createInput({ transport: 'direct', hostId: undefined, database: 'app' }))
    for (const database of ['app', undefined]) {
      const pending = service.listSchemaTables({ sourceId: created.source.id, ...(database === undefined ? {} : { database }), cacheMode: 'refresh' })
      runtime.settle({ mode: 'schema-tables', capability: 'available', ...(database === undefined ? { database: 'app' } : { database }), databases: ['app'], tables: [], warnings: [] })
      await pending
    }
    expect(schemaCache.invalidations).toEqual([
      { sourceId: created.source.id, database: 'app' },
      { sourceId: created.source.id },
    ])
  })

  test('Given 表结构读取先于目录 refresh 在途 When 旧结构迟到 Then revision CAS 不会重新回填', async () => {
    const { service, runtime, schemaCache } = createService({ cache: true })
    const created = service.upsertSource(createInput({ transport: 'direct', hostId: undefined, database: 'app' }))
    const oldTable = service.describeSchemaTable({
      sourceId: created.source.id, database: 'app', table: 'users', cacheMode: 'prefer-cache',
    })
    const refreshedDirectory = service.listSchemaTables({ sourceId: created.source.id, database: 'app', cacheMode: 'refresh' })
    expect(runtime.requests.map((request) => request.mode)).toEqual(['schema-table', 'schema-tables'])

    runtime.settle({ mode: 'schema-table', capability: 'available', columns: [{ name: 'old', type: 'int', nullable: false, primaryKey: false }], indexes: [], warnings: [] })
    await oldTable
    expect(schemaCache.writes).toBe(0)
    runtime.settle({ mode: 'schema-tables', capability: 'available', database: 'app', databases: ['app'], tables: [{ name: 'users' }], warnings: [] })
    await refreshedDirectory
    expect(schemaCache.writes).toBe(1)
  })

  test('Given 目录 refresh 的缓存失效写失败 When 后续读取表结构 Then 本实例绕过旧缓存并实时读取', async () => {
    const { service, runtime, schemaCache } = createService({ cache: true })
    const created = service.upsertSource(createInput({ transport: 'direct', hostId: undefined, database: 'app' }))
    const tableInput = { sourceId: created.source.id, database: 'app', table: 'users', cacheMode: 'prefer-cache' as const }
    const oldTable = service.describeSchemaTable(tableInput)
    runtime.settle({
      mode: 'schema-table', capability: 'available',
      columns: [{ name: 'old_column', type: 'int', nullable: false, primaryKey: false }], indexes: [], warnings: [],
    })
    await oldTable

    schemaCache.failInvalidations = true
    const refresh = service.listSchemaTables({ sourceId: created.source.id, database: 'app', cacheMode: 'refresh' })
    runtime.settle({ mode: 'schema-tables', capability: 'available', database: 'app', databases: ['app'], tables: [{ name: 'users' }], warnings: [] })
    await refresh

    const freshTable = service.describeSchemaTable(tableInput)
    expect(runtime.requests.at(-1)?.mode).toBe('schema-table')
    runtime.settle({
      mode: 'schema-table', capability: 'available',
      columns: [{ name: 'new_column', type: 'int', nullable: false, primaryKey: false }], indexes: [], warnings: [],
    })
    await expect(freshTable).resolves.toMatchObject({ columns: [{ name: 'new_column' }] })

    schemaCache.failInvalidations = false
    const otherScopeRefresh = service.listSchemaTables({ sourceId: created.source.id, database: 'analytics', cacheMode: 'refresh' })
    runtime.settle({ mode: 'schema-tables', capability: 'available', database: 'analytics', databases: ['app', 'analytics'], tables: [], warnings: [] })
    await otherScopeRefresh
    const appAfterOtherScopeRefresh = service.describeSchemaTable(tableInput)
    expect(runtime.requests.at(-1)?.mode).toBe('schema-table')
    runtime.settle({
      mode: 'schema-table', capability: 'available',
      columns: [{ name: 'latest_column', type: 'int', nullable: false, primaryKey: false }], indexes: [], warnings: [],
    })
    await expect(appAfterOtherScopeRefresh).resolves.toMatchObject({ columns: [{ name: 'latest_column' }] })
  })

  test('Given schema 主文件与备份均损坏 When 连续 prefer-cache Then 本实例两次都实时读取', async () => {
    /** 隔离真实缓存文件，覆盖 safe-file 严格读取到服务降级的完整链路。 */
    const configDir = mkdtempSync(join(tmpdir(), 'proma-schema-service-'))
    try {
      /** 使用真实 Store，但用同步空事务避免本用例重复验证原生锁。 */
      const cache = new ServerOpsDataSchemaCache(configDir, { transaction: (callback) => callback() })
      /** 主文件和备份同时损坏，不能被解释为首次缺失。 */
      const filePath = join(configDir, 'server-ops', 'schema-cache.json')
      writeFileSync(filePath, '{broken', 'utf8')
      writeFileSync(`${filePath}.bak`, '{broken', 'utf8')
      /** 注入真实损坏缓存的服务与可控 runtime。 */
      const { service, runtime } = createService({ schemaCache: cache })
      /** 不含凭据的直连数据源，避免其它身份门禁干扰缓存故障断言。 */
      const created = service.upsertSource(createInput({ transport: 'direct', hostId: undefined, database: 'app' }))
      /** 两次相同 opt-in 请求用于证明首次异常后的实例级禁用闩锁。 */
      const input = { sourceId: created.source.id, database: 'app', table: 'users', cacheMode: 'prefer-cache' as const }

      /** 首次读取应在缓存异常后降级到实时 runtime。 */
      const first = service.describeSchemaTable(input)
      expect(runtime.requests.at(-1)?.mode).toBe('schema-table')
      runtime.settle({
        mode: 'schema-table', capability: 'available',
        columns: [{ name: 'first_live', type: 'int', nullable: false, primaryKey: false }], indexes: [], warnings: [],
      })
      await expect(first).resolves.toMatchObject({ columns: [{ name: 'first_live' }] })

      /** 第二次读取应命中实例禁用闩锁，不能重新读取或修复缓存。 */
      const second = service.describeSchemaTable(input)
      expect(runtime.requests.filter((request) => request.mode === 'schema-table')).toHaveLength(2)
      runtime.settle({
        mode: 'schema-table', capability: 'available',
        columns: [{ name: 'second_live', type: 'int', nullable: false, primaryKey: false }], indexes: [], warnings: [],
      })
      await expect(second).resolves.toMatchObject({ columns: [{ name: 'second_live' }] })
    } finally {
      rmSync(configDir, { recursive: true, force: true })
    }
  })

  test('Given 缓存读取期间密码或 SSH 身份变化 When 迟到结果返回 Then 拒绝回填旧身份', async () => {
    const { service, runtime, schemaCache, advanceConnection } = createService({ cache: true })
    const created = service.upsertSource(createInput({ database: 'app', password: 'old-secret' }))
    const input = { sourceId: created.source.id, cacheMode: 'prefer-cache' as const }
    const passwordChanged = service.listSchemaTables(input)
    service.upsertSource(createInput({ sourceId: created.source.id, database: 'app', password: 'new-secret' }))
    runtime.settle({ mode: 'schema-tables', capability: 'available', database: 'app', databases: ['app'], tables: [], warnings: [] })
    await expect(passwordChanged).rejects.toThrow('SERVER_OPS_DATA_SOURCE_CHANGED')
    expect(schemaCache.writes).toBe(0)

    const connectionChanged = service.listSchemaTables(input)
    advanceConnection()
    runtime.settle({ mode: 'schema-tables', capability: 'available', database: 'app', databases: ['app'], tables: [], warnings: [] })
    await expect(connectionChanged).rejects.toThrow('SERVER_OPS_DATA_SOURCE_CHANGED')
    expect(schemaCache.writes).toBe(0)
  })

  test('Given opt-in 实时读取期间数据源被删除 When 结果迟到 Then 不返回也不写缓存', async () => {
    const { service, runtime, schemaCache } = createService({ cache: true })
    const created = service.upsertSource(createInput({ transport: 'direct', hostId: undefined, database: 'app' }))
    const pending = service.listSchemaTables({ sourceId: created.source.id, cacheMode: 'prefer-cache' })
    service.deleteSource({ sourceId: created.source.id })
    runtime.settle({ mode: 'schema-tables', capability: 'available', database: 'app', databases: ['app'], tables: [], warnings: [] })
    await expect(pending).rejects.toThrow('SERVER_OPS_DATA_SOURCE_NOT_FOUND')
    expect(schemaCache.writes).toBe(0)
  })

  test('Given SQL 查询 When 成功 Then 下传取消信号并返回精确查询结果', async () => {
    const { service, runtime } = createService()
    const created = service.upsertSource(createInput({ database: 'app', password: 'p@ss' }))
    const controller = new AbortController()
    const pending = service.querySource({
      sourceId: created.source.id, database: 'app', queryId: 'query-1', sql: 'SELECT id FROM users', maxRows: 20,
    }, controller.signal)
    expect(runtime.requests[0]).toMatchObject({
      mode: 'sql-query', database: 'app', queryId: 'query-1', sql: 'SELECT id FROM users', maxRows: 20, password: 'p@ss',
    })
    expect(runtime.signals[0]).toBe(controller.signal)
    runtime.settle({ queryId: 'query-1', database: 'app', columns: ['id'], rows: [['1']], rowCount: 1, durationMs: 5, truncated: false, warnings: [] })
    await expect(pending).resolves.toMatchObject({ queryId: 'query-1', rowCount: 1 })
  })

  test('Given 查询期间数据源目标变化 When 迟到结果返回 Then 拒绝旧目标结果', async () => {
    const { service, runtime } = createService()
    const created = service.upsertSource(createInput({ database: 'app' }))
    const pending = service.querySource({
      sourceId: created.source.id, database: 'app', queryId: 'query-1', sql: 'SELECT id FROM users', maxRows: 20,
    })
    service.upsertSource(createInput({ sourceId: created.source.id, database: 'app', address: '10.0.0.99' }))
    runtime.settle({ queryId: 'query-1', database: 'app', columns: ['id'], rows: [['1']], rowCount: 1, durationMs: 5, truncated: false, warnings: [] })
    await expect(pending).rejects.toThrow('SERVER_OPS_DATA_SOURCE_CHANGED')
  })

  test('Given 查询收到取消 When runtime 尚未确认清理 Then 保留单源占用直到终态', async () => {
    const { service, runtime } = createService()
    const created = service.upsertSource(createInput({ database: 'app' }))
    const controller = new AbortController()
    const input = { sourceId: created.source.id, database: 'app', queryId: 'query-1', sql: 'SELECT id FROM users', maxRows: 20 }
    const first = service.querySource(input, controller.signal)

    controller.abort()
    await expect(service.querySource({ ...input, queryId: 'query-2' })).rejects.toThrow('SERVER_OPS_DATA_SOURCE_BUSY')
    runtime.fail(new Error('SERVER_OPS_DATA_CANCELLED'))
    await expect(first).rejects.toThrow('SERVER_OPS_DATA_CANCELLED')

    const next = service.querySource({ ...input, queryId: 'query-3' })
    expect(runtime.requests.at(-1)?.queryId).toBe('query-3')
    runtime.fail(new Error('TEST_FINISH'))
    await expect(next).rejects.toThrow('TEST_FINISH')
  })

  test('Given 查询期间同一 credentialRef 原位换密码 When 返回 Then 拒绝旧认证结果', async () => {
    const { service, runtime } = createService()
    const created = service.upsertSource(createInput({ database: 'app', password: 'old-secret' }))
    const pending = service.querySource({
      sourceId: created.source.id, database: 'app', queryId: 'query-1', sql: 'SELECT id FROM users', maxRows: 20,
    })
    service.upsertSource(createInput({ sourceId: created.source.id, database: 'app', password: 'new-secret' }))
    runtime.settle({ queryId: 'query-1', database: 'app', columns: ['id'], rows: [['1']], rowCount: 1, durationMs: 5, truncated: false, warnings: [] })

    await expect(pending).rejects.toThrow('SERVER_OPS_DATA_SOURCE_CHANGED')
  })

  test('Given 表浏览失败 When 读取 Then 抛出带中文原因的错误而不是空结果', async () => {
    const { service, runtime } = createService()
    const created = service.upsertSource(createInput({ transport: 'direct', hostId: undefined, database: 'app' }))
    const pending = service.listSchemaTables({ sourceId: created.source.id })
    runtime.settle({
      mode: 'schema-tables',
      capability: 'auth-failed',
      databases: [],
      tables: [],
      warnings: ['认证失败（ER_ACCESS_DENIED_ERROR）'],
    })
    await expect(pending).rejects.toThrow('SERVER_OPS_DATA_SCHEMA_UNAVAILABLE: 认证失败（ER_ACCESS_DENIED_ERROR）')
  })

  test('Given 请求第 2 页 When runtime 回执页码或页大小不匹配 Then 拒绝错页并释放读取预算', async () => {
    /** 模拟合法连接，但 utility 回传另一个页身份。 */
    const { service, runtime } = createService()
    const created = service.upsertSource(createInput({ transport: 'direct', hostId: undefined, database: 'app' }))
    /** 每次都要求 offset 50 / limit 50，只有最后一份回执匹配。 */
    const input = { sourceId: created.source.id, database: 'app', table: 'users', offset: 50, limit: 50 }
    for (const paging of [{ offset: 0, limit: 50 }, { offset: 50, limit: 25 }]) {
      const pending = service.readSchemaRows(input)
      runtime.settle({ mode: 'schema-rows', capability: 'available', columns: ['id'], rows: [['wrong-page']], ...paging, truncated: false, warnings: [] })
      await expect(pending).rejects.toThrow('SERVER_OPS_DATA_UNEXPECTED_RESULT')
    }
    /** 协议错误后允许重试，不能卡住单飞读取。 */
    const retry = service.readSchemaRows(input)
    runtime.settle({ mode: 'schema-rows', capability: 'available', columns: ['id'], rows: [['51']], offset: 50, limit: 50, truncated: false, warnings: [] })
    await expect(retry).resolves.toMatchObject({ rows: [['51']], offset: 50, limit: 50 })
  })

  test('Given 数据源没有库名 When 列清单 Then 仍读取可见库且不擅自选择', async () => {
    const { service, runtime } = createService()
    /** 直连但没有配置库名的数据源。 */
    const created = service.upsertSource(createInput({ transport: 'direct', hostId: undefined, database: undefined }))
    const pending = service.listSchemaTables({ sourceId: created.source.id })
    expect(runtime.requests[0]).toMatchObject({ mode: 'schema-tables' })
    expect(runtime.requests[0]?.schemaDatabase).toBeUndefined()
    runtime.settle({ mode: 'schema-tables', capability: 'available', databases: ['app', 'mysql'], tables: [], warnings: [] })
    await expect(pending).resolves.toEqual({ databases: ['app', 'mysql'], tables: [] })
  })

  test('Given 数据源默认库不可见 When 列清单 Then 不回填库也不返回其它库的表', async () => {
    const { service, runtime } = createService()
    const created = service.upsertSource(createInput({ transport: 'direct', hostId: undefined, database: 'secret' }))
    const pending = service.listSchemaTables({ sourceId: created.source.id })
    runtime.settle({ mode: 'schema-tables', capability: 'available', databases: ['app'], tables: [], warnings: ['库 secret 不存在或当前账号不可见'] })
    await expect(pending).resolves.toEqual({ databases: ['app'], tables: [] })
  })

  test('Given 默认库位于截断目录之外但 runtime 已精确验证 When 列清单 Then 信任显式库回执', async () => {
    const { service, runtime } = createService()
    const created = service.upsertSource(createInput({ transport: 'direct', hostId: undefined, database: 'target_db' }))
    const pending = service.listSchemaTables({ sourceId: created.source.id })
    runtime.settle({
      mode: 'schema-tables', capability: 'available', database: 'target_db', databases: ['db_1', 'target_db'],
      databasesTruncated: true, tables: [{ name: 'users', type: 'table' }], warnings: [],
    })
    await expect(pending).resolves.toEqual({
      database: 'target_db', databases: ['db_1', 'target_db'], databasesTruncated: true,
      tables: [{ name: 'users', type: 'table' }],
    })
  })

  test('Given 显式库未被 runtime 精确验证 When 列清单 Then 即使目录含同名项也拒绝', async () => {
    const { service, runtime } = createService()
    const created = service.upsertSource(createInput({ transport: 'direct', hostId: undefined, database: undefined }))
    const pending = service.listSchemaTables({ sourceId: created.source.id, database: 'hidden_db' })
    runtime.settle({
      mode: 'schema-tables', capability: 'available', databases: ['hidden_db'], tables: [],
      databasesTruncated: true, warnings: ['库 hidden_db 不存在或当前账号不可见'],
    })
    await expect(pending).rejects.toThrow('库 hidden_db 不存在或当前账号不可见')
  })
})
