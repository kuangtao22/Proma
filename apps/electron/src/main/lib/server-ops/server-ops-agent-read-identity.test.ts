import { describe, expect, test } from 'bun:test'
import type { ServerOpsDataSource, ServerOpsHost } from '@proma/shared'
import { ServerOpsAgentAccessStore } from './server-ops-agent-access-store'
import { captureServerOpsReadBindings, revalidateServerOpsReadBindings } from './server-ops-agent-read-identity'

describe('运维只读授权配置身份', () => {
  test('Given 已授权数据库 When 改名移动 Then 身份不变；修改端点或跳板账号 Then 身份变化', () => {
    /** 内存配置，不访问磁盘或网络。 */
    const host: ServerOpsHost = { id: 'jump-1', name: 'jump', address: '127.0.0.1', port: 22, username: 'u', authMethod: 'ssh-agent', tags: [], createdAt: 1, updatedAt: 1 }
    const source: ServerOpsDataSource = { id: 'db-1', label: 'db', engine: 'mysql', transport: 'ssh', hostId: host.id, address: '127.0.0.1', port: 3306, tlsMode: 'disabled', hasPassword: true, createdAt: 1, updatedAt: 1 }
    const services = { hosts: { get: () => host }, data: { listSources: () => ({ sources: [source] }), getReadCredentialVersion: () => source.hasPassword ? 'fixture-version' : null } }
    const resources = [{ kind: 'mysql' as const, sourceId: source.id, instance: true, databases: [] }]
    const first = captureServerOpsReadBindings(resources, services)
    source.label = 'renamed'; source.projectId = 'other'; source.updatedAt = 2
    host.name = 'new'; host.tags.push('tag'); host.projectId = 'elsewhere'
    expect(captureServerOpsReadBindings(resources, services)).toEqual(first)
    source.address = '127.0.0.2'
    expect(captureServerOpsReadBindings(resources, services)).not.toEqual(first)
    source.address = '127.0.0.1'; host.username = 'other'
    expect(captureServerOpsReadBindings(resources, services)).not.toEqual(first)
    expect(first[0]?.hostId).toBe(host.id)
    expect(JSON.stringify(first)).not.toContain('127.0.0.1')
  })

  test('Given 错误引擎或不存在的资源 Then 不产生绑定', () => {
    const services = { hosts: { get: () => undefined }, data: { listSources: () => ({ sources: [] }) } }
    expect(() => captureServerOpsReadBindings([{ kind: 'ssh', hostId: 'missing' }], services)).toThrow('SERVER_OPS_HOST_NOT_FOUND')
    expect(() => captureServerOpsReadBindings([{ kind: 'redis', sourceId: 'missing' }], services)).toThrow('SERVER_OPS_DATA_SOURCE_NOT_FOUND')
  })

  test('Given SQLite 文件已授权 When 改名或切换文件 Then 改名保留授权身份而文件变化失效', () => {
    /** 固定 SSH 目标与仅包含文件端点的 SQLite 配置，不连接真实服务器。 */
    const host: ServerOpsHost = { id: 'sqlite-host', name: 'fixture', address: '127.0.0.1', port: 22, username: 'u', authMethod: 'ssh-agent', tags: [], createdAt: 1, updatedAt: 1 }
    const source: ServerOpsDataSource = { id: 'sqlite-source', label: 'SQLite', engine: 'sqlite', transport: 'ssh', hostId: host.id, filePath: '/srv/app.db', database: 'main', tlsMode: 'disabled', hasPassword: false, createdAt: 1, updatedAt: 1 }
    /** 授权仅覆盖 main 的结构；捕获的摘要不得泄露路径。 */
    const resources = [{ kind: 'sqlite' as const, sourceId: source.id, instance: false as const, databases: [{ database: 'main', tables: null, readRows: false, query: false }] }]
    const services = { hosts: { get: () => host }, data: { listSources: () => ({ sources: [source] }), getReadCredentialVersion: () => source.hasPassword ? 'fixture-version' : null } }
    const first = captureServerOpsReadBindings(resources, services)
    source.label = '重命名'; source.updatedAt = 2
    expect(captureServerOpsReadBindings(resources, services)).toEqual(first)
    source.filePath = '/srv/other.db'
    expect(captureServerOpsReadBindings(resources, services)).not.toEqual(first)
    expect(JSON.stringify(first)).not.toContain('/srv/')
  })

  test('Given 旧授权与变更后新授权并存 When 复核旧绑定 Then 只撤旧会话', () => {
    const source: ServerOpsDataSource = { id: 'redis-1', label: 'Redis', engine: 'redis', transport: 'direct', address: '127.0.0.1', port: 6379, tlsMode: 'disabled', hasPassword: false, createdAt: 1, updatedAt: 1 }
    const services = { hosts: { get: () => undefined }, data: { listSources: () => ({ sources: [source] }), getReadCredentialVersion: () => source.hasPassword ? 'fixture-version' : null } }
    const resource = { kind: 'redis' as const, sourceId: source.id }
    const access = new ServerOpsAgentAccessStore()
    access.grantRead({ sessionId: 'old', resources: [resource] }, captureServerOpsReadBindings([resource], services))
    source.address = '127.0.0.2'
    access.grantRead({ sessionId: 'new', resources: [resource] }, captureServerOpsReadBindings([resource], services))
    revalidateServerOpsReadBindings(access, services)
    expect(access.listReadAccesses().map((entry) => entry.sessionId)).toEqual(['new'])
    access.clear()
  })

  test('Given 同一密码引用 When 密文版本改变 Then 旧绑定失效且摘要不含凭据材料', () => {
    const source: ServerOpsDataSource = { id: 'redis-1', label: 'Redis', engine: 'redis', transport: 'direct', address: '127.0.0.1', port: 6379, tlsMode: 'disabled', hasPassword: true, createdAt: 1, updatedAt: 1 }
    let version = 'cipher-version-one'
    const services = { hosts: { get: () => undefined }, data: { listSources: () => ({ sources: [source] }), getReadCredentialVersion: () => version } }
    const resource = { kind: 'redis' as const, sourceId: source.id }
    const first = captureServerOpsReadBindings([resource], services)
    version = 'cipher-version-two'
    expect(captureServerOpsReadBindings([resource], services)).not.toEqual(first)
    expect(JSON.stringify(first)).not.toContain('cipher-version')
  })

  test('Given 多会话授权同一来源 When 来源端点变化 Then 复核撤销全部关联会话', () => {
    /** 两个授权会话共享一条 Redis 连接，目录读取只发生一次。 */
    const source: ServerOpsDataSource = { id: 'redis-1', label: 'Redis', engine: 'redis', transport: 'direct', address: '127.0.0.1', port: 6379, tlsMode: 'disabled', hasPassword: false, createdAt: 1, updatedAt: 1 }
    let listCalls = 0
    const services = { hosts: { get: () => undefined }, data: { listSources: () => { listCalls += 1; return { sources: [source] } } } }
    const resource = { kind: 'redis' as const, sourceId: source.id }
    const access = new ServerOpsAgentAccessStore()
    for (const sessionId of ['session-1', 'session-2']) access.grantRead({ sessionId, resources: [resource] }, captureServerOpsReadBindings([resource], services))
    listCalls = 0
    source.address = '127.0.0.2'
    revalidateServerOpsReadBindings(access, services)
    expect(access.listReadAccesses()).toEqual([])
    expect(listCalls).toBe(1)
    access.clear()
  })
})
