import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { chmodSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerOpsDataQueryHistoryRecordInput } from '@proma/shared'
import { writeJsonFileAtomicSecure } from '../safe-file'
import { ServerOpsDataQueryHistoryStore } from './server-ops-data-query-history-store'

/** 每项测试创建的隔离配置根，结束后统一删除。 */
const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/** 创建不会触碰真实 ~/.proma 的临时配置根。 */
function createConfigDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'proma-query-history-'))
  directories.push(directory)
  return directory
}

/** 创建固定 scope 的历史写入输入。 */
function createInput(sql: string, sourceId = 'source-1', database = 'app'): ServerOpsDataQueryHistoryRecordInput {
  return { sourceId, database, sql }
}

/** 从内存持久化快照严格提取 sourceId，避免测试用类型断言掩盖错误形状。 */
function readSnapshotSourceIds(snapshot: object | null): string[] {
  if (snapshot === null || !('entries' in snapshot) || !Array.isArray(snapshot.entries)) {
    throw new Error('查询历史测试快照无效')
  }
  return snapshot.entries.map((entry) => {
    const candidate: unknown = entry
    if (typeof candidate !== 'object' || candidate === null || !('sourceId' in candidate)
      || typeof candidate.sourceId !== 'string') {
      throw new Error('查询历史测试条目无效')
    }
    return candidate.sourceId
  })
}

describe('Server Ops SQL 查询历史 Store', () => {
  test('Given 已保存历史 When 重建 Store Then 从安全 JSON 恢复且文件权限为 0600', () => {
    const configDir = createConfigDir()
    const store = new ServerOpsDataQueryHistoryStore(configDir)
    store.save(createInput('SELECT 1'))

    const reloaded = new ServerOpsDataQueryHistoryStore(configDir)
    expect(reloaded.list({ sourceId: 'source-1', database: 'app' }).entries.map((entry) => entry.sql))
      .toEqual(['SELECT 1'])
    const filePath = join(configDir, 'server-ops', 'query-history.json')
    expect(lstatSync(filePath).mode & 0o777).toBe(0o600)
  })

  test('Given 主历史文件超过 2 MiB 且备份有效 When 重建 Store Then 读取前跳过主文件并恢复备份', () => {
    const configDir = createConfigDir()
    const store = new ServerOpsDataQueryHistoryStore(configDir)
    store.save(createInput('SELECT 1'))
    store.save(createInput('SELECT 2'))
    const filePath = join(configDir, 'server-ops', 'query-history.json')
    writeFileSync(filePath, JSON.stringify({ version: 1, entries: [], padding: 'x'.repeat(2 * 1024 * 1024) }), 'utf8')
    const warning = spyOn(console, 'warn').mockImplementation(() => undefined)
    const log = spyOn(console, 'log').mockImplementation(() => undefined)
    try {
      expect(store.list({ sourceId: 'source-1', database: 'app' }).entries.map((entry) => entry.sql))
        .toEqual(['SELECT 1'])
      expect(lstatSync(filePath).mode & 0o777).toBe(0o600)
    } finally {
      warning.mockRestore()
      log.mockRestore()
    }
  })

  test('Given 有效 tmp 权限过宽且主文件损坏 When 重建 Store Then 安全恢复内容并保持主文件 0600', () => {
    const configDir = createConfigDir()
    const store = new ServerOpsDataQueryHistoryStore(configDir)
    store.save(createInput('SELECT 1'))
    const filePath = join(configDir, 'server-ops', 'query-history.json')
    const validSnapshot = readFileSync(filePath, 'utf8')
    writeFileSync(filePath, '{', 'utf8')
    writeFileSync(`${filePath}.tmp`, validSnapshot, 'utf8')
    chmodSync(`${filePath}.tmp`, 0o644)
    const warning = spyOn(console, 'warn').mockImplementation(() => undefined)
    const log = spyOn(console, 'log').mockImplementation(() => undefined)
    try {
      expect(store.list({ sourceId: 'source-1', database: 'app' }).entries.map((entry) => entry.sql))
        .toEqual(['SELECT 1'])
      expect(lstatSync(filePath).mode & 0o777).toBe(0o600)
    } finally {
      warning.mockRestore()
      log.mockRestore()
    }
  })

  test('Given 仅首尾空白不同的重复 SQL When 保存 Then 不写盘、不更新时间且保留原始文本', () => {
    const configDir = createConfigDir()
    let now = 10
    let writeCount = 0
    const store = new ServerOpsDataQueryHistoryStore(configDir, {
      now: () => now,
      writeJson: (filePath, data, expectedDestination, priorBackup) => {
        writeCount += 1
        writeJsonFileAtomicSecure(filePath, data, {
          expectedDestination,
          ...(priorBackup ? { priorBackup: { filePath: `${filePath}.bak`, data: priorBackup } } : {}),
        })
      },
    })
    const first = store.save(createInput('  SELECT 1\n'))
    now = 20
    const duplicate = store.save(createInput('\nSELECT 1  '))

    expect(writeCount).toBe(1)
    expect(duplicate).toEqual(first)
    expect(duplicate.entries[0]).toMatchObject({ sql: '  SELECT 1\n', createdAt: 10 })
  })

  test('Given 多数据源与数据库 When 保存和列出 Then scope 严格隔离且新记录在前', () => {
    const configDir = createConfigDir()
    let now = 1
    const store = new ServerOpsDataQueryHistoryStore(configDir, { now: () => now++ })
    store.save(createInput('SELECT 1'))
    store.save(createInput('SELECT 2'))
    store.save(createInput('SELECT 3', 'source-1', 'analytics'))
    store.save(createInput('SELECT 4', 'source-2', 'app'))

    expect(store.list({ sourceId: 'source-1', database: 'app' }).entries.map((entry) => entry.sql))
      .toEqual(['SELECT 2', 'SELECT 1'])
    expect(store.list({ sourceId: 'source-1', database: 'analytics' }).entries.map((entry) => entry.sql))
      .toEqual(['SELECT 3'])
    expect(store.list({ sourceId: 'source-2', database: 'app' }).entries.map((entry) => entry.sql))
      .toEqual(['SELECT 4'])
  })

  test('Given 两个已创建 Store When 交错保存 Then 每次锁内 fresh-read 不丢更新', () => {
    const configDir = createConfigDir()
    const first = new ServerOpsDataQueryHistoryStore(configDir)
    const second = new ServerOpsDataQueryHistoryStore(configDir)
    first.save(createInput('SELECT 1'))
    second.save(createInput('SELECT 2'))
    first.save(createInput('SELECT 3'))

    expect(second.list({ sourceId: 'source-1', database: 'app' }).entries.map((entry) => entry.sql))
      .toEqual(['SELECT 3', 'SELECT 2', 'SELECT 1'])
  })

  test('Given scope、全局条数与总字节持续增长 When 保存 Then 保留有界最近记录', () => {
    const configDir = createConfigDir()
    /** 限额算法使用共享内存快照，真实磁盘与权限边界由其它用例独立覆盖。 */
    let snapshot: object | null = null
    let now = 1
    const store = new ServerOpsDataQueryHistoryStore(configDir, {
      readJson: <T>() => snapshot as T | null,
      writeJson: (_filePath, data) => { snapshot = data },
      uuid: () => `history-${now}`,
      now: () => now++,
      transaction: (callback) => callback(),
    })
    for (let index = 0; index < 101; index += 1) store.save(createInput(`SELECT ${index}`))
    expect(store.list({ sourceId: 'source-1', database: 'app' }).entries).toHaveLength(100)
    expect(store.list({ sourceId: 'source-1', database: 'app' }).entries.at(-1)?.sql).toBe('SELECT 1')

    /** 120 条近 16 KiB SQL 会触发 2 MiB 总字节预算，但新记录必须保留。 */
    for (let index = 0; index < 120; index += 1) {
      store.save(createInput(`SELECT '${'x'.repeat(16_000)}' /* ${index} */`, `source-${index + 2}`, 'app'))
    }
    let total = store.list({ sourceId: 'source-1', database: 'app' }).entries.length
    for (let index = 0; index < 120; index += 1) {
      total += store.list({ sourceId: `source-${index + 2}`, database: 'app' }).entries.length
    }
    expect(total).toBeLessThan(221)
    expect(store.list({ sourceId: 'source-121', database: 'app' }).entries[0]?.sql).toContain('/* 119 */')
  })

  test('Given 超过 1000 条短历史 When 保存 Then 全局只保留最新 1000 条', () => {
    const configDir = createConfigDir()
    /** 用共享内存快照隔离条数算法，避免 1001 次真实磁盘 fsync 干扰行为测试。 */
    let snapshot: object | null = null
    let sequence = 0
    const store = new ServerOpsDataQueryHistoryStore(configDir, {
      readJson: <T>() => snapshot as T | null,
      writeJson: (_filePath, data) => { snapshot = data },
      uuid: () => `history-${sequence}`,
      now: () => sequence,
      transaction: (callback) => callback(),
    })
    for (sequence = 0; sequence < 1_001; sequence += 1) {
      store.save(createInput(`SELECT ${sequence}`, `source-${sequence}`, 'app'))
    }
    const sourceIds = readSnapshotSourceIds(snapshot)
    expect(sourceIds).toHaveLength(1_000)
    expect(sourceIds[0]).toBe('source-1000')
    expect(sourceIds.at(-1)).toBe('source-1')
  })

  test('Given 安全写入失败 When 保存 Then 旧历史保持可读且错误向上传播', () => {
    const configDir = createConfigDir()
    const stable = new ServerOpsDataQueryHistoryStore(configDir)
    stable.save(createInput('SELECT 1'))
    const failing = new ServerOpsDataQueryHistoryStore(configDir, {
      writeJson: () => { throw new Error('WRITE_FAILED') },
    })

    expect(() => failing.save(createInput('SELECT 2'))).toThrow('WRITE_FAILED')
    expect(stable.list({ sourceId: 'source-1', database: 'app' }).entries.map((entry) => entry.sql))
      .toEqual(['SELECT 1'])
  })

  test('Given 主/tmp/bak 均损坏 When 列出或保存 Then 抛错且绝不覆盖为空', () => {
    const configDir = createConfigDir()
    const directory = join(configDir, 'server-ops')
    const store = new ServerOpsDataQueryHistoryStore(configDir)
    const filePath = join(directory, 'query-history.json')
    writeFileSync(filePath, '{broken', { mode: 0o600 })
    writeFileSync(`${filePath}.tmp`, '{broken', { mode: 0o600 })
    writeFileSync(`${filePath}.bak`, '{broken', { mode: 0o600 })

    /** safe-file 的恢复诊断属于预期路径，本测试只验证 Store 的稳定错误与不覆盖行为。 */
    const warning = spyOn(console, 'warn').mockImplementation(() => undefined)
    const error = spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      expect(() => store.list({ sourceId: 'source-1', database: 'app' })).toThrow('SERVER_OPS_DATA_QUERY_HISTORY_READ_FAILED')
      expect(() => store.save(createInput('SELECT 1'))).toThrow('SERVER_OPS_DATA_QUERY_HISTORY_READ_FAILED')
      expect(readFileSync(filePath, 'utf8')).toBe('{broken')
    } finally {
      warning.mockRestore()
      error.mockRestore()
    }
  })
})
