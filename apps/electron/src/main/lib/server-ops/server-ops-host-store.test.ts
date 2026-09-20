import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readJsonFileSafe, writeJsonFileAtomic } from '../safe-file'
import {
  createServerOpsHostStoreDependencies,
  ServerOpsHostStore as ProductionServerOpsHostStore,
} from './server-ops-host-store'
import type { ServerOpsHostStoreDependencies } from './server-ops-host-store'

/** Store 单元测试复用已独立验证的事务合同，只隔离原生 addon 装载。 */
class ServerOpsHostStore extends ProductionServerOpsHostStore {
  constructor(configDir?: string, dependencies: Partial<ServerOpsHostStoreDependencies> = {}) {
    super(configDir, { transaction: (callback) => callback(), ...dependencies })
  }
}

/** 当前测试创建的隔离配置目录。 */
const temporaryDirectories: string[] = []

/** 创建一个独占的 Proma 配置目录。 */
function createConfigDir(): string {
  /** 当前用例使用的临时目录。 */
  const configDir = mkdtempSync(join(tmpdir(), 'proma-server-ops-hosts-'))
  temporaryDirectories.push(configDir)
  return configDir
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('服务器运维主机资产 Store', () => {
  test('生产依赖固定使用 safe-file 读取与安全原子 JSON 写入边界', () => {
    /** Store 的生产默认依赖。 */
    const dependencies = createServerOpsHostStoreDependencies()

    expect(dependencies.readJson).toBe(readJsonFileSafe)
    expect(typeof dependencies.writeJson).toBe('function')
  })

  test('新增、更新和删除主机均持久化到 server-ops/hosts.json', () => {
    /** 当前用例使用的配置目录。 */
    const configDir = createConfigDir()
    /** 使用固定 ID 和时间的主机 Store。 */
    const store = new ServerOpsHostStore(configDir, {
      uuid: () => 'host-1',
      now: () => 1_000,
    })

    /** 新增后的主机。 */
    const created = store.upsert({
      name: '生产 API',
      address: '10.0.0.8',
      port: 22,
      username: 'deploy',
      authMethod: 'ssh-agent',
      tags: ['生产'],
    })

    expect(created).toEqual({
      id: 'host-1',
      name: '生产 API',
      address: '10.0.0.8',
      port: 22,
      username: 'deploy',
      authMethod: 'ssh-agent',
      tags: ['生产'],
      createdAt: 1_000,
      updatedAt: 1_000,
    })
    /** 主机资产文件路径。 */
    const filePath = join(configDir, 'server-ops', 'hosts.json')
    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual([created])

    /** 更新时间改为下一毫秒的可控 Store。 */
    const updateStore = new ServerOpsHostStore(configDir, { now: () => 2_000 })
    /** 更新后的主机。 */
    const updated = updateStore.upsert({
      id: created.id,
      name: '生产 API 01',
      address: created.address,
      port: 2222,
      username: created.username,
      authMethod: created.authMethod,
      tags: created.tags,
    })
    expect(updated).toMatchObject({
      id: 'host-1',
      name: '生产 API 01',
      port: 2222,
      createdAt: 1_000,
      updatedAt: 2_000,
    })

    expect(updateStore.remove('host-1')).toBe(true)
    expect(updateStore.list()).toEqual([])
    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual([])
    expect(existsSync(`${filePath}.bak`)).toBe(true)
  })

  test('损坏主文件和无有效备份时读取失败且保留现场', () => {
    /** 当前用例的配置目录。 */
    const configDir = createConfigDir()
    /** 主机资产目录。 */
    const opsDir = join(configDir, 'server-ops')
    mkdirSync(opsDir, { recursive: true })
    writeFileSync(join(opsDir, 'hosts.json'), '{broken', 'utf8')

    expect(() => new ServerOpsHostStore(configDir).list()).toThrow('SERVER_OPS_HOST_READ_FAILED')
  })

  test('返回副本且磁盘写失败不会提交幽灵状态', () => {
    /** 当前测试累计的写入次数。 */
    let writeCount = 0
    /** 第二次写入失败的 Store。 */
    const configDir = createConfigDir()
    const store = new ServerOpsHostStore(configDir, {
      uuid: () => 'host-1',
      now: () => 1_000 + writeCount,
      writeJson: (targetPath, data) => {
        writeCount++
        if (writeCount === 2) throw new Error('disk failure')
        writeJsonFileAtomic(targetPath, data)
      },
    })
    /** 首次成功创建的主机。 */
    const created = store.upsert({
      name: '生产 API',
      address: '10.0.0.8',
      port: 22,
      username: 'deploy',
      authMethod: 'ssh-agent',
      tags: [],
    })
    /** 调用方可修改但不应污染 Store 的返回数组。 */
    const listed = store.list()
    /** 首次列表中的唯一主机。 */
    const listedHost = listed[0]
    if (!listedHost) throw new Error('测试主机应存在')
    listedHost.name = '被外部篡改'
    expect(store.list()[0]?.name).toBe('生产 API')

    expect(() => store.upsert({
      id: created.id,
      name: '未落盘名称',
      address: created.address,
      port: created.port,
      username: created.username,
      authMethod: created.authMethod,
      tags: created.tags,
    })).toThrow('disk failure')
    expect(store.list()[0]?.name).toBe('生产 API')
  })

  test('拒绝更新不存在的主机并幂等处理缺失删除', () => {
    /** 空主机 Store。 */
    const store = new ServerOpsHostStore(createConfigDir())
    expect(() => store.upsert({
      id: 'missing',
      name: '不存在',
      address: '10.0.0.9',
      port: 22,
      username: 'deploy',
      authMethod: 'ssh-agent',
      tags: [],
    })).toThrow('SERVER_OPS_HOST_NOT_FOUND')
    expect(store.remove('missing')).toBe(false)
  })

  test('Given 新主机 When 指定项目或沿用旧调用 Then 在事务内解析归属', () => {
    const configDir = createConfigDir()
    /** 记录归属解析时事务是否仍然持有。 */
    let transactionDepth = 0
    /** 测试使用的同步事务。 */
    const transaction = <T>(callback: () => T): T => {
      transactionDepth += 1
      try { return callback() } finally { transactionDepth -= 1 }
    }
    const store = new ProductionServerOpsHostStore(configDir, {
      transaction,
      uuid: (() => { let sequence = 0; return () => `host-${++sequence}` })(),
      now: () => 1_000,
      resolveProjectId: (projectId) => {
        expect(transactionDepth).toBeGreaterThan(0)
        if (projectId === 'project-missing') throw new Error('SERVER_OPS_PROJECT_NOT_FOUND')
        return projectId ?? 'project-default'
      },
    })
    /** 基础主机输入。 */
    const input = { name: '生产 API', address: '10.0.0.8', port: 22, username: 'deploy', authMethod: 'ssh-agent' as const, tags: [] }
    expect(store.upsert({ ...input, projectId: 'project-2' }).projectId).toBe('project-2')
    expect(store.upsert(input).projectId).toBe('project-default')
    expect(() => store.upsert({ ...input, projectId: 'project-missing' })).toThrow('SERVER_OPS_PROJECT_NOT_FOUND')
    expect(store.list()).toHaveLength(2)
  })

  test('Given 已归属主机 When 编辑 Then 保留归属且拒绝迁移', () => {
    const configDir = createConfigDir()
    const store = new ServerOpsHostStore(configDir, {
      uuid: () => 'host-1', now: () => 1_000, resolveProjectId: (projectId) => projectId ?? 'project-1',
    })
    /** 已归属项目一的主机。 */
    const created = store.upsert({
      projectId: 'project-1', name: '生产 API', address: '10.0.0.8', port: 22,
      username: 'deploy', authMethod: 'ssh-agent', tags: [],
    })
    expect(store.upsert({ ...created, name: '生产 API 01', projectId: undefined }).projectId).toBe('project-1')
    expect(() => store.upsert({ ...created, projectId: 'project-2' })).toThrow('SERVER_OPS_HOST_PROJECT_MISMATCH')
  })

  test('Given 已归属 SSH 主机 When 独立移动 Then 仅更新项目与时间并保留身份凭据', () => {
    const configDir = createConfigDir()
    let now = 1_000
    const store = new ServerOpsHostStore(configDir, {
      uuid: () => 'host-1', now: () => now, resolveProjectId: (projectId) => projectId ?? 'project-1',
    })
    const created = store.upsert({
      projectId: 'project-1', name: '生产 API', address: '10.0.0.8', port: 2222,
      username: 'deploy', authMethod: 'password', tags: ['生产'],
    })
    store.setCredentialRef(created.id, 'credential-1')
    now = 2_000

    expect(store.move('host-1', 'project-1', 'project-2')).toEqual({
      ...created, projectId: 'project-2', credentialRef: 'credential-1', updatedAt: 2_000,
    })
  })

  test('Given 目标缺失、源缺失或原项目过期 When 移动 SSH 主机 Then 拒绝且不写盘', () => {
    const configDir = createConfigDir()
    const store = new ServerOpsHostStore(configDir, {
      uuid: () => 'host-1', now: () => 1_000,
      resolveProjectId: (projectId) => {
        if (projectId === 'project-missing') throw new Error('SERVER_OPS_PROJECT_NOT_FOUND')
        return projectId ?? 'project-1'
      },
    })
    store.upsert({ projectId: 'project-1', name: 'A', address: '10.0.0.1', port: 22, username: 'root', authMethod: 'ssh-agent', tags: [] })
    const filePath = join(configDir, 'server-ops', 'hosts.json')
    const before = readFileSync(filePath, 'utf8')

    expect(() => store.move('host-missing', 'project-1', 'project-2')).toThrow('SERVER_OPS_HOST_NOT_FOUND')
    expect(() => store.move('host-1', 'project-stale', 'project-2')).toThrow('SERVER_OPS_CONNECTION_PROJECT_CHANGED')
    expect(() => store.move('host-1', 'project-1', 'project-missing')).toThrow('SERVER_OPS_PROJECT_NOT_FOUND')
    expect(readFileSync(filePath, 'utf8')).toBe(before)
  })

  test('Given 同项目、缺少项目解析器或写盘失败 When 移动 SSH 主机 Then 幂等或 fail closed 且保留原文件', () => {
    const configDir = createConfigDir()
    const dependencies = createServerOpsHostStoreDependencies()
    let writes = 0
    let failWrite = false
    const store = new ServerOpsHostStore(configDir, {
      uuid: () => 'host-1', now: () => 2_000, resolveProjectId: (projectId) => projectId ?? 'project-1',
      writeJson: (filePath, data, expectedDestination, priorBackup) => {
        writes += 1
        if (failWrite) throw new Error('WRITE_FAILED')
        dependencies.writeJson(filePath, data, expectedDestination, priorBackup)
      },
    })
    store.upsert({ projectId: 'project-1', name: 'A', address: '10.0.0.1', port: 22, username: 'root', authMethod: 'ssh-agent', tags: [] })
    const filePath = join(configDir, 'server-ops', 'hosts.json')
    const before = readFileSync(filePath, 'utf8')
    const writesBeforeIdempotentMove = writes
    expect(store.move('host-1', 'project-1', 'project-1').updatedAt).toBe(2_000)
    expect(writes).toBe(writesBeforeIdempotentMove)

    const unavailable = new ServerOpsHostStore(configDir, { now: () => 3_000 })
    expect(() => unavailable.move('host-1', 'project-1', 'project-2')).toThrow('SERVER_OPS_PROJECT_UNAVAILABLE')
    failWrite = true
    expect(() => store.move('host-1', 'project-1', 'project-2')).toThrow('WRITE_FAILED')
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
    const seed = new ProductionServerOpsHostStore(configDir, {
      transaction,
      uuid: () => `host-${++sequence}`,
      now: () => 1_000,
      resolveProjectId: (projectId) => projectId ?? 'project-1',
    })
    const input = { projectId: 'project-1', address: '10.0.0.1', port: 22,
      username: 'root', authMethod: 'ssh-agent' as const, tags: [] }
    seed.upsert({ ...input, name: 'A' })
    seed.upsert({ ...input, name: 'B', address: '10.0.0.2' })
    /** 两个实例在移动前都读取同一份旧归属，模拟两个 Pane 的陈旧视图。 */
    const createStore = (now: number): ProductionServerOpsHostStore => new ProductionServerOpsHostStore(configDir, {
      transaction,
      now: () => now,
      resolveProjectId: (projectId) => {
        expect(transactionDepth).toBeGreaterThan(0)
        return projectId ?? 'project-1'
      },
    })
    const first = createStore(2_000)
    const second = createStore(3_000)
    expect(first.list().map((host) => host.projectId)).toEqual(['project-1', 'project-1'])
    expect(second.list().map((host) => host.projectId)).toEqual(['project-1', 'project-1'])

    first.move('host-1', 'project-1', 'project-2')
    expect(() => second.move('host-1', 'project-1', 'project-3'))
      .toThrow('SERVER_OPS_CONNECTION_PROJECT_CHANGED')
    second.move('host-2', 'project-1', 'project-3')

    expect(second.list().map((host) => ({ id: host.id, projectId: host.projectId }))).toEqual([
      { id: 'host-1', projectId: 'project-2' },
      { id: 'host-2', projectId: 'project-3' },
    ])
  })

  test('凭据引用由 Store 内部绑定且切换认证方式时清除', () => {
    /** 当前测试使用的主机 Store。 */
    const store = new ServerOpsHostStore(createConfigDir(), {
      uuid: () => 'host-1',
      now: () => 1_000,
    })
    /** 新建的密码主机。 */
    const host = store.upsert({
      name: '生产 API',
      address: '10.0.0.8',
      port: 22,
      username: 'deploy',
      authMethod: 'password',
      tags: [],
    })

    expect(store.setCredentialRef(host.id, 'credential-1').credentialRef).toBe('credential-1')
    expect(store.upsert({ ...host, authMethod: 'ssh-agent' }).credentialRef).toBeUndefined()
  })

  test('旧版私钥路径被移出公开主机文件且保留主机资产', () => {
    /** 当前用例的配置目录。 */
    const configDir = createConfigDir()
    /** 旧版运维数据目录。 */
    const opsDir = join(configDir, 'server-ops')
    mkdirSync(opsDir, { recursive: true })
    /** 旧版曾把私钥路径错误保存在主机资产中。 */
    writeFileSync(join(opsDir, 'hosts.json'), JSON.stringify([{
      id: 'host-1',
      name: '旧私钥主机',
      address: '10.0.0.9',
      port: 22,
      username: 'deploy',
      authMethod: 'private-key',
      keyPath: '/Users/demo/.ssh/private-key-canary',
      tags: [],
      createdAt: 1,
      updatedAt: 1,
    }]), 'utf8')

    /** 加载时完成公开 schema 迁移的 Store。 */
    const store = new ServerOpsHostStore(configDir)
    expect(store.list()).toHaveLength(1)
    expect(readFileSync(join(opsDir, 'hosts.json'), 'utf8')).not.toContain('private-key-canary')
    expect(readFileSync(join(opsDir, 'hosts.json.bak'), 'utf8')).not.toContain('private-key-canary')
  })

  test('Given 两个已构造 Store When 依次新增不同主机 Then fresh-read 保留双方提交', () => {
    const configDir = createConfigDir()
    let nextId = 0
    const transaction = <T>(callback: () => T): T => callback()
    const first = new ServerOpsHostStore(configDir, { transaction, uuid: () => `host-${++nextId}`, now: () => nextId })
    const second = new ServerOpsHostStore(configDir, { transaction, uuid: () => `host-${++nextId}`, now: () => nextId })

    first.upsert({ name: 'A', address: '10.0.0.1', port: 22, username: 'root', authMethod: 'ssh-agent', tags: [] })
    second.upsert({ name: 'B', address: '10.0.0.2', port: 22, username: 'root', authMethod: 'ssh-agent', tags: [] })

    expect(first.list().map((host) => host.name)).toEqual(['A', 'B'])
  })

  test('Given 已有主机文件损坏 When 尝试写入 Then fail closed 且不覆盖现场', () => {
    const configDir = createConfigDir()
    const opsDir = join(configDir, 'server-ops')
    mkdirSync(opsDir, { recursive: true })
    const filePath = join(opsDir, 'hosts.json')
    writeFileSync(filePath, '{broken-hosts', 'utf8')
    const store = new ServerOpsHostStore(configDir, { transaction: (callback) => callback() })

    expect(() => store.upsert({ name: 'A', address: '10.0.0.1', port: 22, username: 'root', authMethod: 'ssh-agent', tags: [] }))
      .toThrow('SERVER_OPS_HOST_READ_FAILED')
    expect(readFileSync(filePath, 'utf8')).toBe('{broken-hosts')
  })
})
