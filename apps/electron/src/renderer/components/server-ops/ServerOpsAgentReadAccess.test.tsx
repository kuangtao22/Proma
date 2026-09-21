import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ServerOpsDataSource, ServerOpsProject } from '@proma/shared'
import { SERVER_OPS_AGENT_QUERY_PERMISSION_LABEL, ServerOpsAgentReadAccess, updateServerOpsAgentScopeReadRows } from './ServerOpsAgentReadAccess'
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
  test('展示当前项目入口并保留跨项目已授权资源管理入口', () => {
    const html = renderToStaticMarkup(<ServerOpsAgentReadAccess sessionId="session-1" projectId="project-1" projects={projects} connections={connections} allConnections={connections} dataSources={dataSources} />)
    expect(html).toContain('aria-label="Agent 只读授权"')
    expect(html).not.toContain('结构/行/SQL 未启用')
    expect(html).not.toContain('无租约')
  })

  test('无会话时入口不可用且不加载资源目录', () => {
    const html = renderToStaticMarkup(<ServerOpsAgentReadAccess sessionId={null} projectId="project-1" projects={projects} connections={connections} allConnections={connections} dataSources={dataSources} />)
    expect(html).toMatch(/disabled=""[^>]*aria-label="Agent 只读授权"|aria-label="Agent 只读授权"[^>]*disabled=""/)
  })

  test('授权说明明确SQL查询独立授权且仍受表范围约束', () => {
    expect(SERVER_OPS_AGENT_QUERY_PERMISSION_LABEL).toContain('允许只读 SQL 查询')
    expect(SERVER_OPS_AGENT_QUERY_PERMISSION_LABEL).toContain('仍限制在上述库表范围')
    expect(updateServerOpsAgentScopeReadRows({ database: 'app', tables: ['users'], readRows: true, query: true }, false)).toMatchObject({ readRows: false, query: false })
    expect(updateServerOpsAgentScopeReadRows({ database: 'app', tables: ['users'], readRows: false }, true)).not.toHaveProperty('query')
  })
})
