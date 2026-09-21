import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AgentSessionMeta } from '@proma/shared'
import { AgentOpsAccessControl, persistAgentToolMode, resolveAgentSendToolMode } from './AgentOpsAccessControl'
import { summarizeServerOpsReadAccess } from '../server-ops/server-ops-agent-read-summary'

describe('Agent 运维模式入口', () => {
  test('Given 会话模式变化 When 再次构造发送参数 Then 使用最新持久化模式', () => {
    const sessions = [{ id: 's1', toolMode: 'standard' }, { id: 's2', toolMode: 'server-ops-read' }] as AgentSessionMeta[]
    expect(resolveAgentSendToolMode(sessions, 's1')).toBe('standard')
    sessions[0] = { ...sessions[0]!, toolMode: 'server-ops-read' }
    expect(resolveAgentSendToolMode(sessions, 's1')).toBe('server-ops-read')
    expect(resolveAgentSendToolMode(sessions, 'missing')).toBe('standard')
  })

  test('Given 模式更新失败 When 主进程拒绝 Then 不更新会话 atom', async () => {
    const published: AgentSessionMeta[] = []
    await expect(persistAgentToolMode('s1', 'server-ops-read', async () => { throw new Error('save-failed') }, (session) => published.push(session))).rejects.toThrow('save-failed')
    expect(published).toEqual([])
  })

  test('Given 运维授权弹窗的模式设置 When 没有可用会话 Then 禁用切换且不再重复展示授权入口', () => {
    const html = renderToStaticMarkup(<AgentOpsAccessControl sessionId="missing" />)
    expect(html).toContain('选择 Agent 工具模式')
    expect(html).toContain('标准')
    expect(html).not.toContain('管理运维授权')
    expect(html).not.toContain('无租约')
  })
  test('Given 多连接与独立库表权限 When 摘要授权 Then 入口直接提供目标、能力和剩余时间且不暴露资源ID', () => {
    const summary = summarizeServerOpsReadAccess({ sessionId: 's1', revision: 1, grantedAt: 0, expiresAt: 1_800_000,
      resources: [
        { kind: 'ssh', hostId: 'secret-host-id' },
        { kind: 'mysql', sourceId: 'secret-db-id', instance: false, databases: [{ database: 'orders', tables: ['items'], readRows: true, query: true }] },
      ] }, 60_000)
    expect(summary).toEqual({ target: 'MySQL · orders · items · 服务器 1 台', capability: '结构/行/SQL · 概览', remaining: '剩余 29 分钟' })
    expect(JSON.stringify(summary)).not.toContain('secret-')
    expect(summarizeServerOpsReadAccess({ sessionId: 's1', revision: 1, grantedAt: 0, expiresAt: 1_800_000,
      resources: [{ kind: 'ssh', hostId: 'secret-host-id' }, { kind: 'redis', sourceId: 'secret-redis-id' }] }, 60_000,
    new Map([['ssh:secret-host-id', '生产服务器'], ['data:secret-redis-id', '缓存实例']])).target).toBe('生产服务器 · 缓存实例')
    expect(summarizeServerOpsReadAccess({ sessionId: 's1', revision: 2, grantedAt: 0, expiresAt: 1_800_000,
      resources: [{ kind: 'mysql', sourceId: 'private-source-id', instance: false, databases: [
        { database: '订单数据库', tables: ['items', 'shipments'], readRows: true, query: false },
        { database: '日志库', tables: null, readRows: false },
      ] }] }, 60_000, new Map([['data:private-source-id', '业务连接-名称特别长但不应遮挡能力与期限']])).target)
      .toBe('业务连接-名称特别长但不应遮挡能力与期限 · 订单数据库 · items 等 2 表 / 日志库 · 全部表')
    expect(summarizeServerOpsReadAccess(null, 60_000)).toEqual({ target: '未授权', capability: '结构/行/SQL 未启用', remaining: '无租约' })
  })
})
