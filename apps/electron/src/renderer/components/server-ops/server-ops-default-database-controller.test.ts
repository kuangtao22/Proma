import { describe, expect, test } from 'bun:test'
import type { ServerOpsDataSource } from '@proma/shared'
import { getServerOpsDatabaseReadIdentity } from '@/atoms/server-ops-database-atoms'
import { createServerOpsDefaultDatabaseController } from './server-ops-default-database-controller'

/** 创建不含凭据的连接快照；入参覆盖测试关心的连接字段。 */
function createSource(overrides: Partial<ServerOpsDataSource> = {}): ServerOpsDataSource {
  return { id: 'source-1', engine: 'postgresql', transport: 'direct', label: '业务库', address: 'localhost',
    port: 5432, database: 'postgres', tlsMode: 'disabled', hasPassword: true, createdAt: 1, updatedAt: 1, ...overrides }
}

describe('记住上次打开的数据库', () => {
  test('Given 成功选库 When 保存并收到配置刷新 Then 保持浏览身份且后续保存使用最新快照', async () => {
    /** 捕获每次 CAS 输入，确认第二次使用第一次的权威回执。 */
    const snapshots: ServerOpsDataSource[] = []
    /** 最新已保存来源，模拟主进程单字段更新。 */
    let saved = createSource()
    const controller = createServerOpsDefaultDatabaseController({ source: saved,
      save: async ({ source, database }) => { snapshots.push(source); saved = { ...source, database, updatedAt: source.updatedAt + 1 }; return { source: saved } },
      onSaved: () => undefined })
    const identity = controller.getReadIdentity(saved)
    await controller.remember('app', () => true)
    expect(controller.getReadIdentity(saved)).toBe(identity)
    controller.setSource(saved)
    await controller.remember('analytics', () => true)
    expect(snapshots.map((source) => source.database)).toEqual(['postgres', 'app'])
    expect(controller.getReadIdentity(saved)).toBe(identity)
    expect(controller.getSource().database).toBe('analytics')
  })

  test('Given 快速切库 When 旧保存未返回 Then 串行保存最新目标并跳过中间失效选择', async () => {
    /** 暂停第一次保存，覆盖回执乱序风险。 */
    let finish!: () => void
    const waiting = new Promise<void>((resolve) => { finish = resolve })
    const databases: string[] = []
    const controller = createServerOpsDefaultDatabaseController({ source: createSource(),
      save: async ({ source, database }) => { databases.push(database); if (database === 'app') await waiting; return { source: { ...source, database, updatedAt: source.updatedAt + 1 } } },
      onSaved: () => undefined })
    const first = controller.remember('app', () => true)
    await Promise.resolve()
    const skipped = controller.remember('intermediate', () => false)
    const last = controller.remember('analytics', () => true)
    expect(databases).toEqual(['app'])
    finish()
    await Promise.all([first, skipped, last])
    expect(databases).toEqual(['app', 'analytics'])
    expect(controller.getSource().database).toBe('analytics')
  })

  test('Given 保存失败或重复打开同库 When 再选其他库 Then 可恢复且相同库没有额外写入', async () => {
    let calls = 0
    const controller = createServerOpsDefaultDatabaseController({ source: createSource(),
      save: async ({ source, database }) => { calls += 1; if (calls === 1) throw new Error('磁盘不可写'); return { source: { ...source, database, updatedAt: 2 } } },
      onSaved: () => undefined })
    await controller.remember('postgres', () => true)
    expect(calls).toBe(0)
    await expect(controller.remember('app', () => true)).rejects.toThrow('磁盘不可写')
    expect(controller.getSource().database).toBe('postgres')
    await controller.remember('analytics', () => true)
    await controller.remember('analytics', () => true)
    expect(calls).toBe(2)
  })

  test('Given 保存中连接被编辑 When 旧回执返回 Then 不覆盖新连接也不保留旧导航身份', async () => {
    let finish!: () => void
    const waiting = new Promise<void>((resolve) => { finish = resolve })
    let notifications = 0
    const original = createSource()
    const controller = createServerOpsDefaultDatabaseController({ source: original,
      save: async ({ source, database }) => { await waiting; return { source: { ...source, database, updatedAt: 2 } } },
      onSaved: () => { notifications += 1 } })
    const pending = controller.remember('app', () => true)
    await Promise.resolve()
    const edited = createSource({ address: 'new.example', updatedAt: 3 })
    expect(controller.getReadIdentity(edited)).toBe(getServerOpsDatabaseReadIdentity(edited))
    controller.setSource(edited)
    finish()
    await pending
    expect(controller.getSource()).toEqual(edited)
    expect(notifications).toBe(0)
  })

  test('Given SQLite 或 Redis When 调用记忆 Then 不改变其连接语义', async () => {
    let calls = 0
    for (const engine of ['sqlite', 'redis'] as const) {
      const controller = createServerOpsDefaultDatabaseController({ source: createSource({ engine }),
        save: async ({ source }) => { calls += 1; return { source } }, onSaved: () => undefined })
      await controller.remember('app', () => true)
    }
    expect(calls).toBe(0)
  })
})
