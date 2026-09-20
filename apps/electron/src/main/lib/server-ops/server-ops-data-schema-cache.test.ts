import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ServerOpsDataSchemaCache } from './server-ops-data-schema-cache'

/** 测试创建的隔离配置根，结束后统一清理。 */
const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/** 创建隔离配置根。 */
function createConfigDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'proma-schema-cache-'))
  temporaryDirectories.push(directory)
  return directory
}

describe('数据库 schema 派生缓存', () => {
  test('Given 已持久化目录与表结构 When 新实例读取 Then fresh-read 命中且 TTL 后失效', () => {
    const configDir = createConfigDir()
    let now = 1_000
    const first = new ServerOpsDataSchemaCache(configDir, { now: () => now, transaction: (callback) => callback() })
    first.set({ kind: 'tables', sourceId: 'source-1', database: 'app' }, 'identity-1', {
      databases: ['app'], database: 'app', tables: [{ name: 'users' }],
    })
    first.set({ kind: 'table', sourceId: 'source-1', database: 'app', table: 'users' }, 'identity-1', {
      columns: [{ name: 'id', type: 'int', nullable: false, primaryKey: true }], indexes: [],
    })

    const second = new ServerOpsDataSchemaCache(configDir, { now: () => now, transaction: (callback) => callback() })
    expect(second.get({ kind: 'tables', sourceId: 'source-1', database: 'app' }, 'identity-1')?.value)
      .toMatchObject({ tables: [{ name: 'users' }] })
    expect(second.get({ kind: 'table', sourceId: 'source-1', database: 'app', table: 'users' }, 'identity-1')?.value)
      .toMatchObject({ columns: [{ name: 'id' }] })

    now += 10 * 60_000
    expect(second.get({ kind: 'tables', sourceId: 'source-1', database: 'app' }, 'identity-1')).toBeUndefined()
  })

  test('Given 缓存时间晚于当前时间 When 读取 Then 不把时钟回退误判为永久新鲜', () => {
    const configDir = createConfigDir()
    let now = 2_000
    const cache = new ServerOpsDataSchemaCache(configDir, { now: () => now, transaction: (callback) => callback() })
    cache.set({ kind: 'tables', sourceId: 'source-1' }, 'identity-1', { databases: [], tables: [] })
    now = 1_000
    expect(cache.get({ kind: 'tables', sourceId: 'source-1' }, 'identity-1')).toBeUndefined()
  })

  test('Given 多库多身份缓存 When 定向失效 Then 不串库且只清目标范围', () => {
    const configDir = createConfigDir()
    const cache = new ServerOpsDataSchemaCache(configDir, { now: () => 1_000, transaction: (callback) => callback() })
    cache.set({ kind: 'table', sourceId: 'source-1', database: 'app', table: 'users' }, 'identity-1', { columns: [], indexes: [] })
    cache.set({ kind: 'table', sourceId: 'source-1', database: 'audit', table: 'events' }, 'identity-1', { columns: [], indexes: [] })
    cache.set({ kind: 'table', sourceId: 'source-2', database: 'app', table: 'users' }, 'identity-2', { columns: [], indexes: [] })

    expect(cache.get({ kind: 'table', sourceId: 'source-1', database: 'app', table: 'users' }, 'identity-other')).toBeUndefined()
    cache.invalidate({ sourceId: 'source-1', database: 'app' })
    expect(cache.get({ kind: 'table', sourceId: 'source-1', database: 'app', table: 'users' }, 'identity-1')).toBeUndefined()
    expect(cache.get({ kind: 'table', sourceId: 'source-1', database: 'audit', table: 'events' }, 'identity-1')).toBeDefined()
    expect(cache.get({ kind: 'table', sourceId: 'source-2', database: 'app', table: 'users' }, 'identity-2')).toBeDefined()
  })

  test('Given refresh 已推进 revision When 刷新前读取迟到 Then CAS 拒绝回填且备份不会复活旧值', () => {
    const configDir = createConfigDir()
    const cache = new ServerOpsDataSchemaCache(configDir, { now: () => 1_000, transaction: (callback) => callback() })
    const scope = { kind: 'table' as const, sourceId: 'source-1', database: 'app', table: 'users' }
    cache.set(scope, 'identity-1', { columns: [{ name: 'old', type: 'int', nullable: false, primaryKey: false }], indexes: [] })
    const staleRevision = cache.lookup(scope, 'identity-1').revision
    cache.invalidate({ sourceId: 'source-1', database: 'app' })
    expect(cache.setIfRevision(scope, 'identity-1', { columns: [], indexes: [] }, staleRevision)).toBe(false)

    const filePath = join(configDir, 'server-ops', 'schema-cache.json')
    writeFileSync(filePath, '{broken', 'utf8')
    expect(cache.get(scope, 'identity-1')).toBeUndefined()
  })

  test('Given 主文件与备份均损坏或超过预算 When 读取 Then 明确抛错供服务禁用缓存', () => {
    const configDir = createConfigDir()
    const serverOpsDir = join(configDir, 'server-ops')
    const cache = new ServerOpsDataSchemaCache(configDir, { transaction: (callback) => callback() })
    cache.set({ kind: 'tables', sourceId: 'source-1' }, 'identity-1', { databases: [], tables: [] })
    const filePath = join(serverOpsDir, 'schema-cache.json')
    writeFileSync(filePath, '{broken', 'utf8')
    writeFileSync(`${filePath}.bak`, '{broken', 'utf8')
    expect(() => cache.get({ kind: 'tables', sourceId: 'source-1' }, 'identity-1'))
      .toThrow('schema 派生缓存的所有 JSON 候选均损坏')
    writeFileSync(filePath, 'x'.repeat(4 * 1024 * 1024 + 1), 'utf8')
    expect(() => cache.get({ kind: 'tables', sourceId: 'source-1' }, 'identity-1'))
      .toThrow('schema 派生缓存的所有 JSON 候选均损坏')
  })

  test('Given tables scope 与结果数据库不一致 When 读取持久化缓存 Then 按损坏候选明确抛错', () => {
    const configDir = createConfigDir()
    const serverOpsDir = join(configDir, 'server-ops')
    const cache = new ServerOpsDataSchemaCache(configDir, { transaction: (callback) => callback() })
    const filePath = join(serverOpsDir, 'schema-cache.json')
    writeFileSync(filePath, JSON.stringify({
      version: 1,
      revision: 1,
      entries: [{
        scope: { kind: 'tables', sourceId: 'source-1', database: 'app' },
        identity: 'identity-1',
        cachedAt: Date.now(),
        value: { databases: ['app', 'audit'], database: 'audit', tables: [{ name: 'events' }] },
      }],
    }), 'utf8')

    expect(() => cache.get({ kind: 'tables', sourceId: 'source-1', database: 'app' }, 'identity-1'))
      .toThrow('schema 派生缓存的所有 JSON 候选均损坏')
  })

  test('Given 写入超过 256 项 When 持久化 Then 只保留最近 256 项且文件不超过 4MiB', () => {
    const configDir = createConfigDir()
    let now = 0
    const cache = new ServerOpsDataSchemaCache(configDir, { now: () => ++now, transaction: (callback) => callback() })
    for (let index = 0; index < 300; index += 1) {
      cache.set({ kind: 'table', sourceId: 'source-1', database: 'app', table: `table-${index}` }, 'identity-1', {
        columns: [], indexes: [],
      })
    }
    const raw = readFileSync(join(configDir, 'server-ops', 'schema-cache.json'), 'utf8')
    const file = JSON.parse(raw) as { entries: unknown[] }
    expect(file.entries).toHaveLength(256)
    expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(4 * 1024 * 1024)
    expect(cache.get({ kind: 'table', sourceId: 'source-1', database: 'app', table: 'table-0' }, 'identity-1')).toBeUndefined()
    expect(cache.get({ kind: 'table', sourceId: 'source-1', database: 'app', table: 'table-299' }, 'identity-1')).toBeDefined()
  })
})
