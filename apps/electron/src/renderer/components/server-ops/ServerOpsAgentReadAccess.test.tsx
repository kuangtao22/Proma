import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ServerOpsDataSource, ServerOpsProject } from '@proma/shared'
import { ServerOpsAgentReadAccess } from './ServerOpsAgentReadAccess'
import type { ServerOpsConnection } from './server-ops-connections'

const projects: readonly ServerOpsProject[] = [
  { id: 'project-1', name: '生产', createdAt: 1, updatedAt: 1 },
  { id: 'project-2', name: '测试', createdAt: 2, updatedAt: 2 },
]
const connections: readonly ServerOpsConnection[] = [
  { id: 'ssh:host-1', kind: 'ssh', projectId: 'project-1', label: '生产服务器', detail: 'root@10.0.0.1:22', hostId: 'host-1', connected: true },
  { id: 'data:mysql-1', kind: 'database', projectId: 'project-1', label: '业务库', detail: '127.0.0.1:3306', sourceId: 'mysql-1' },
  { id: 'data:redis-1', kind: 'redis', projectId: 'project-2', label: '缓存', detail: '127.0.0.1:6379', sourceId: 'redis-1' },
]
const dataSources: readonly ServerOpsDataSource[] = [
  { id: 'mysql-1', projectId: 'project-1', transport: 'direct', engine: 'mysql', label: '业务库', address: '127.0.0.1', port: 3306, tlsMode: 'verify', hasPassword: true, createdAt: 1, updatedAt: 1 },
  { id: 'redis-1', projectId: 'project-2', transport: 'direct', engine: 'redis', label: '缓存', address: '127.0.0.1', port: 6379, tlsMode: 'verify', hasPassword: true, createdAt: 1, updatedAt: 1 },
]

describe('ServerOpsAgentReadAccess', () => {
  test('Given 运维工具栏 When 渲染 Then 保留单个只读授权入口，不拆分数据库和服务器按钮', () => {
    const html = renderToStaticMarkup(<ServerOpsAgentReadAccess sessionId="session-1" projectId="project-1" projects={projects} connections={connections} allConnections={connections} dataSources={dataSources} />)
    expect(html).toContain('aria-label="Agent 只读授权"')
    expect(html.match(/<button\b/g)?.length).toBe(1)
    expect(html).not.toContain('aria-label="Agent 禁用表"')
    expect(html).not.toContain('aria-label="Agent 服务器授权"')
    expect(html).not.toContain('结构/行/SQL 未启用')
    expect(html).not.toContain('无租约')
  })

  test('Given 无会话但持久规则可用 When 渲染 Then 同一个入口仍可管理禁用表', () => {
    const html = renderToStaticMarkup(<ServerOpsAgentReadAccess sessionId={null} projectId="project-1" projects={projects} connections={connections} allConnections={connections} dataSources={dataSources}
      policyApi={{ get: async () => ({ revision: 0, exclusions: [] }), set: async () => ({ revision: 1, exclusions: [] }) }} />)
    expect(html).toContain('aria-label="Agent 只读授权"')
    expect(html).not.toMatch(/aria-label="Agent 只读授权"[^>]*disabled=""/)
  })
})
