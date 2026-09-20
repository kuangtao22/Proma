import { describe, expect, test } from 'bun:test'
import type { ServerOpsDataSource, ServerOpsHost } from '@proma/shared'
import { captureServerOpsReadBindings } from './server-ops-agent-read-identity'

describe('运维只读授权配置身份', () => {
  test('Given 已授权数据库 When 改名移动 Then 身份不变；修改端点或跳板账号 Then 身份变化', () => {
    /** 内存配置，不访问磁盘或网络。 */
    const host: ServerOpsHost = { id: 'jump-1', name: 'jump', address: '127.0.0.1', port: 22, username: 'u', authMethod: 'ssh-agent', tags: [], createdAt: 1, updatedAt: 1 }
    const source: ServerOpsDataSource = { id: 'db-1', label: 'db', engine: 'mysql', transport: 'ssh', hostId: host.id, address: '127.0.0.1', port: 3306, tlsMode: 'disabled', hasPassword: true, createdAt: 1, updatedAt: 1 }
    const services = { hosts: { get: () => host }, data: { listSources: () => ({ sources: [source] }) } }
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
})
