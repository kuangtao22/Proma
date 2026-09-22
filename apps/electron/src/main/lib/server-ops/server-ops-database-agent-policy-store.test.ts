import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ServerOpsDatabaseAgentPolicyStore } from './server-ops-database-agent-policy-store'

const temporaryDirectories: string[] = []

/** 为禁用表策略测试创建独立的配置根，并在用例后清理。 */
function createConfigDir(): string {
  const path = mkdtempSync(join(tmpdir(), 'proma-agent-policy-'))
  temporaryDirectories.push(path)
  return path
}

/** Store 测试沿用真实安全文件写入，只替换已单独测试的原生配置锁。 */
function createStore(configDir: string): ServerOpsDatabaseAgentPolicyStore {
  return new ServerOpsDatabaseAgentPolicyStore(configDir, { transaction: (callback) => callback() })
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('服务器运维数据库 Agent 禁用表 Store', () => {
  test('Given 订阅者修改回执 When 保存 Then 后续订阅者与保存调用方仍得到权威副本', () => {
    /** 回调只能修改自己的投影，不能影响其它窗口或调用者。 */
    const store = createStore(createConfigDir())
    store.onChanged((value) => { value.revision = 999; value.exclusions.length = 0 })
    const events: unknown[] = []
    store.onChanged((value) => { events.push(value) })
    const result = store.set({ expectedRevision: 0, exclusions: [{ sourceId: 'mysql-1', database: 'app', excludedTables: ['secret'] }] })
    expect(events).toEqual([store.get()])
    expect(result).toEqual(store.get())
  })
  test('Given 接近文件预算的策略 When 格式化后超限 Then 保存前拒绝且旧规则可读', () => {
    /** 紧凑 JSON 小于 1 MiB，但原子写的缩进 JSON 超过上限。 */
    const exclusions = Array.from({ length: 76 }, (_, database) => ({ sourceId: 'mysql-1', database: `d${database}`, excludedTables: Array.from({ length: 100 }, (_, table) => `${table}`.padEnd(128, 'x')) }))
    const store = createStore(createConfigDir())
    expect(() => store.set({ expectedRevision: 0, exclusions })).toThrow()
    expect(store.get()).toEqual({ revision: 0, exclusions: [] })
  })
  test('Given 从未保存策略 When 获取并首次写入 Then 默认全可查且跨重启保留禁用项', () => {
    const root = createConfigDir()
    const store = createStore(root)
    expect(store.get()).toEqual({ revision: 0, exclusions: [] })
    const policy = store.set({ expectedRevision: 0, exclusions: [{ sourceId: 'mysql-1', database: 'app', excludedTables: ['private'] }] })
    expect(policy).toEqual({ revision: 1, exclusions: [{ sourceId: 'mysql-1', database: 'app', excludedTables: ['private'] }] })
    expect(createStore(root).get()).toEqual(policy)
    const path = join(root, 'server-ops', 'database-agent-policy.json')
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ revision: 1 })
  })

  test('Given 多个连接与库 When 整份更新 Then 保留其他禁用项并拒绝跨实例旧 revision', () => {
    const root = createConfigDir()
    const first = createStore(root)
    const second = createStore(root)
    first.set({ expectedRevision: 0, exclusions: [{ sourceId: 'mysql-1', database: 'app', excludedTables: ['secret'] }] })
    const updated = second.set({ expectedRevision: 1, exclusions: [
      { sourceId: 'mysql-1', database: 'app', excludedTables: ['secret', 'audit'] },
      { sourceId: 'sqlite-1', database: 'main', excludedTables: ['internal'] },
    ] })
    expect(first.get()).toEqual(updated)
    expect(() => first.set({ expectedRevision: 1, exclusions: [] })).toThrow('SERVER_OPS_DATABASE_AGENT_POLICY_CONFLICT')
    expect(second.get().exclusions).toHaveLength(2)
  })

  test('Given 编辑禁用项 When 成功写入 Then 只广播新策略并隔离订阅者异常', () => {
    const store = createStore(createConfigDir())
    const revisions: number[] = []
    store.onChanged(() => { throw new Error('listener failed') })
    const unsubscribe = store.onChanged((value) => { revisions.push(value.revision) })
    store.set({ expectedRevision: 0, exclusions: [] })
    unsubscribe()
    store.set({ expectedRevision: 1, exclusions: [] })
    expect(revisions).toEqual([1])
  })

  test('Given 禁用策略存在 When 主文件损坏、删除或只剩旧备份 Then 不得回退到放开表', () => {
    const root = createConfigDir()
    const store = createStore(root)
    store.set({ expectedRevision: 0, exclusions: [{ sourceId: 'mysql-1', database: 'app', excludedTables: ['secret'] }] })
    store.set({ expectedRevision: 1, exclusions: [{ sourceId: 'mysql-1', database: 'app', excludedTables: ['secret', 'new_secret'] }] })
    const path = join(root, 'server-ops', 'database-agent-policy.json')
    expect(existsSync(`${path}.bak`)).toBe(true)
    writeFileSync(path, '{corrupt')
    expect(() => createStore(root).get()).toThrow('SERVER_OPS_DATABASE_AGENT_POLICY_READ_FAILED')
    expect(() => store.set({ expectedRevision: 2, exclusions: [] })).toThrow('SERVER_OPS_DATABASE_AGENT_POLICY_READ_FAILED')
    renameSync(path, `${path}.broken`)
    expect(() => createStore(root).get()).toThrow('SERVER_OPS_DATABASE_AGENT_POLICY_READ_FAILED')
  })

  test('Given 单实例已看到禁用项 When 文件随后消失 Then 拒绝将缺失解释成初始空策略', () => {
    const root = createConfigDir()
    const store = createStore(root)
    store.set({ expectedRevision: 0, exclusions: [{ sourceId: 'mysql-1', database: 'main', excludedTables: ['secret'] }] })
    const path = join(root, 'server-ops', 'database-agent-policy.json')
    rmSync(path)
    expect(() => store.get()).toThrow('SERVER_OPS_DATABASE_AGENT_POLICY_READ_FAILED')
    expect(() => createStore(root).get()).toThrow('SERVER_OPS_DATABASE_AGENT_POLICY_READ_FAILED')
  })

  test('Given 文件内容被旧版回滚 When 已观察到更新版本 Then 当前实例拒绝放宽策略', () => {
    const root = createConfigDir()
    const store = createStore(root)
    store.set({ expectedRevision: 0, exclusions: [{ sourceId: 'mysql-1', database: 'main', excludedTables: ['secret'] }] })
    store.set({ expectedRevision: 1, exclusions: [{ sourceId: 'mysql-1', database: 'main', excludedTables: ['secret', 'new_secret'] }] })
    const path = join(root, 'server-ops', 'database-agent-policy.json')
    const prior = readFileSync(`${path}.bak`, 'utf8')
    writeFileSync(path, prior)
    expect(() => store.get()).toThrow('SERVER_OPS_DATABASE_AGENT_POLICY_ROLLBACK')
  })
})
