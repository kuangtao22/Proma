import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createServerOpsProjectStoreDependencies,
  ServerOpsProjectStore as ProductionServerOpsProjectStore,
} from './server-ops-project-store'
import type { ServerOpsProjectStoreDependencies } from './server-ops-project-store'
import { ServerOpsHostStore } from './server-ops-host-store'
import { ServerOpsDataSourceStore } from './server-ops-data-source-store'

/** Store 单测复用已独立验证的事务合同，只隔离原生 addon 装载。 */
class ServerOpsProjectStore extends ProductionServerOpsProjectStore {
  constructor(configDir?: string, dependencies: Partial<ServerOpsProjectStoreDependencies> = {}) {
    super(configDir, { transaction: (callback) => callback(), ...dependencies })
  }
}

/** 当前测试创建的隔离配置目录。 */
const temporaryDirectories: string[] = []

/** 创建一个独占的 Proma 配置目录。 */
function createConfigDir(): string {
  const configDir = mkdtempSync(join(tmpdir(), 'proma-server-ops-projects-'))
  temporaryDirectories.push(configDir)
  return configDir
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('服务器运维项目 Store', () => {
  test('生产依赖固定使用 safe-file 读取与安全原子 JSON 写入边界', () => {
    const dependencies = createServerOpsProjectStoreDependencies()
    expect(typeof dependencies.readJson).toBe('function')
    expect(typeof dependencies.writeJson).toBe('function')
  })

  test('Given 空目录 When 保证默认项目 Then 落盘并复用同一 ID', () => {
    const configDir = createConfigDir()
    let sequence = 0
    const store = new ServerOpsProjectStore(configDir, { uuid: () => `project-${++sequence}`, now: () => 1_000 })

    const first = store.ensureDefaultProject()
    expect(first).toBe('project-1')
    expect(store.list()).toEqual([{ id: 'project-1', name: '默认项目', createdAt: 1_000, updatedAt: 1_000 }])
    /** 再次调用必须复用已有项目，避免每次启动都新增一个。 */
    expect(store.ensureDefaultProject()).toBe('project-1')
    expect(store.list()).toHaveLength(1)

    /** 落盘文件满足版本化 schema。 */
    const persisted = JSON.parse(readFileSync(join(configDir, 'server-ops', 'projects.json'), 'utf8')) as { version: number; projects: unknown[] }
    expect(persisted.version).toBe(1)
    expect(persisted.projects).toHaveLength(1)
  })

  test('Given 已有项目 When 新建重命名删除 Then 逐个生效并拒绝重名', () => {
    const configDir = createConfigDir()
    let sequence = 0
    const store = new ServerOpsProjectStore(configDir, { uuid: () => `project-${++sequence}`, now: () => 1_000 })
    store.ensureDefaultProject()
    const created = store.create('本地开发')
    expect(created).toEqual({ id: 'project-2', name: '本地开发', createdAt: 1_000, updatedAt: 1_000 })
    expect(store.list().map((project) => project.name)).toEqual(['默认项目', '本地开发'])

    expect(() => store.create('本地开发')).toThrow('SERVER_OPS_PROJECT_NAME_TAKEN')
    expect(store.rename('project-2', '本地调试').name).toBe('本地调试')
    expect(() => store.rename('project-2', '默认项目')).toThrow('SERVER_OPS_PROJECT_NAME_TAKEN')
    expect(() => store.rename('project-missing', '任意')).toThrow('SERVER_OPS_PROJECT_NOT_FOUND')

    expect(store.remove('project-2')).toBe(true)
    expect(store.remove('project-2')).toBe(false)
    /** 只剩一个项目时不允许删除，保证连接始终有归属。 */
    expect(() => store.remove('project-1')).toThrow('SERVER_OPS_PROJECT_LAST_REMAINING')
    expect(store.list()).toHaveLength(1)
  })

  test('Given 创建与删除可能竞态 When 项目仍有引用 Then 锁内检查并稳定拒绝', () => {
    const configDir = createConfigDir()
    /** 当前是否模拟存在引用。 */
    let referenced = false
    /** 当前同步配置事务的嵌套深度。 */
    let transactionDepth = 0
    /** 模拟生产配置事务的同步可重入边界。 */
    const transaction = <T>(callback: () => T): T => {
      transactionDepth += 1
      try { return callback() } finally { transactionDepth -= 1 }
    }
    const store = new ProductionServerOpsProjectStore(configDir, {
      transaction,
      uuid: (() => { let sequence = 0; return () => `project-${++sequence}` })(),
      now: () => 1_000,
      hasProjectReferences: () => {
        expect(transactionDepth).toBeGreaterThan(0)
        return referenced
      },
    })
    store.create('生产环境')
    store.create('测试环境')
    referenced = true
    expect(() => store.remove('project-1')).toThrow('SERVER_OPS_PROJECT_NOT_EMPTY')
    expect(store.list()).toHaveLength(2)
    referenced = false
    expect(store.remove('project-1')).toBe(true)
  })

  test('Given 旧主机与数据源缺少归属 When 删除默认项目 Then 迁移后按非空项目拒绝', () => {
    const configDir = createConfigDir()
    /** 三个 Store 共用的同步配置事务。 */
    const transaction = <T>(callback: () => T): T => callback()
    /** 资产 Store 在项目引用回调执行前完成赋值。 */
    let hostStore: ServerOpsHostStore
    let dataSourceStore: ServerOpsDataSourceStore
    /** 当前用例按生产方式装配的项目 Store。 */
    const projectStore = new ProductionServerOpsProjectStore(configDir, {
      transaction,
      uuid: (() => { let sequence = 0; return () => `project-${++sequence}` })(),
      now: () => 1_000,
      hasProjectReferences: (projectId) => {
        /** 两类资产都必须 fresh-read，避免短路后留下另一类旧记录未迁移。 */
        const hasHost = hostStore.list().some((host) => host.projectId === projectId)
        const hasDataSource = dataSourceStore.list().some((source) => source.projectId === projectId)
        return hasHost || hasDataSource
      },
    })
    const defaultProjectId = projectStore.ensureDefaultProject()
    projectStore.create('测试环境')
    hostStore = new ServerOpsHostStore(configDir, {
      transaction,
      resolveDefaultProjectId: () => projectStore.ensureDefaultProject(),
      resolveProjectId: (projectId) => projectStore.resolveProjectId(projectId),
    })
    dataSourceStore = new ServerOpsDataSourceStore(configDir, {
      transaction,
      resolveDefaultProjectId: () => projectStore.ensureDefaultProject(),
      resolveProjectId: (projectId) => projectStore.resolveProjectId(projectId),
    })
    /** 模拟升级前没有 projectId 的权威资产文件。 */
    const opsDir = join(configDir, 'server-ops')
    mkdirSync(opsDir, { recursive: true })
    writeFileSync(join(opsDir, 'hosts.json'), JSON.stringify([{
      id: 'host-1', name: '旧服务器', address: '10.0.0.8', port: 22, username: 'root',
      authMethod: 'ssh-agent', tags: [], createdAt: 1, updatedAt: 1,
    }]))
    writeFileSync(join(opsDir, 'data-sources.json'), JSON.stringify({
      version: 1,
      sources: [{
        id: 'source-1', transport: 'direct', engine: 'mysql', label: '旧数据库', address: '127.0.0.1',
        port: 3306, tlsMode: 'disabled', createdAt: 1, updatedAt: 1,
      }],
    }))

    expect(() => projectStore.remove(defaultProjectId)).toThrow('SERVER_OPS_PROJECT_NOT_EMPTY')
    expect(hostStore.list()[0]?.projectId).toBe(defaultProjectId)
    expect(dataSourceStore.list()[0]?.projectId).toBe(defaultProjectId)
  })

  test('Given 显式项目 When 解析创建归属 Then 不存在拒绝且旧调用落到默认项目', () => {
    const configDir = createConfigDir()
    const store = new ServerOpsProjectStore(configDir, { uuid: () => 'project-1', now: () => 1_000 })
    expect(store.resolveProjectId()).toBe('project-1')
    expect(store.resolveProjectId('project-1')).toBe('project-1')
    expect(() => store.resolveProjectId('project-missing')).toThrow('SERVER_OPS_PROJECT_NOT_FOUND')
  })

  test('Given 已有 200 个项目 When 再创建 Then 返回稳定上限错误且不写入', () => {
    const configDir = createConfigDir()
    /** 项目配置文件路径。 */
    const target = join(configDir, 'server-ops', 'projects.json')
    const store = new ServerOpsProjectStore(configDir, { uuid: () => 'project-201', now: () => 2_000 })
    /** 达到公开列表合同上限的权威项目快照。 */
    const projects = Array.from({ length: 200 }, (_, index) => ({
      id: `project-${index + 1}`, name: `项目 ${index + 1}`, createdAt: 1_000 + index, updatedAt: 1_000 + index,
    }))
    writeFileSync(target, JSON.stringify({ version: 1, projects }))
    expect(() => store.create('第 201 个项目')).toThrow('SERVER_OPS_PROJECT_LIMIT_REACHED')
    expect(JSON.parse(readFileSync(target, 'utf8')).projects).toHaveLength(200)
  })

  test('Given 损坏或未知字段文件 When 读取 Then fail closed 而不是当作空列表', () => {
    const configDir = createConfigDir()
    const target = join(configDir, 'server-ops', 'projects.json')
    const store = new ServerOpsProjectStore(configDir)
    expect(store.list()).toEqual([])
    writeFileSync(target, '{ not json')
    expect(() => store.list()).toThrow('SERVER_OPS_PROJECT_READ_FAILED')
    writeFileSync(target, JSON.stringify({ version: 1, projects: [{ id: 'project-1', name: '默认项目', createdAt: 1, updatedAt: 1, extra: true }] }))
    expect(() => store.list()).toThrow('SERVER_OPS_PROJECT_FILE_INVALID')
    writeFileSync(target, JSON.stringify({ version: 1, projects: [], extra: true }))
    expect(() => store.list()).toThrow('SERVER_OPS_PROJECT_FILE_INVALID')
    /** 重复 ID 一律视为损坏文件。 */
    const duplicated = { id: 'project-1', name: '默认项目', createdAt: 1, updatedAt: 1 }
    writeFileSync(target, JSON.stringify({ version: 1, projects: [duplicated, duplicated] }))
    expect(() => store.list()).toThrow('SERVER_OPS_PROJECT_FILE_INVALID')
  })

  test('Given 两个 Store 实例 When 交替写入 Then 互不覆盖', () => {
    const configDir = createConfigDir()
    const first = new ServerOpsProjectStore(configDir, { uuid: () => 'project-1', now: () => 1_000 })
    const second = new ServerOpsProjectStore(configDir, { uuid: () => 'project-2', now: () => 1_100 })
    first.create('生产环境')
    second.create('测试环境')
    expect(second.list().map((project) => project.name)).toEqual(['生产环境', '测试环境'])
  })
})
