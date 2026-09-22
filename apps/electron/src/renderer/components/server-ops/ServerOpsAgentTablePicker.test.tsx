import { expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ServerOpsAgentReadAccess, ServerOpsDataSource } from '@proma/shared'
import { ServerOpsAgentDatabaseExclusions, ServerOpsAgentTableExclusions } from './ServerOpsAgentTablePicker'
import { summarizeServerOpsReadAccess } from './server-ops-agent-read-summary'
import { createServerOpsQueryableScope } from './server-ops-agent-table-scope'

/** 公开合成连接，不含凭据，不访问真实数据源。 */
const source: ServerOpsDataSource = { id: 'db', engine: 'mysql', transport: 'direct', label: '测试库', address: 'example.test', port: 3306, tlsMode: 'verify', hasPassword: false, createdAt: 1, updatedAt: 1 }

test('Given 已有屏蔽项且目录未打开 When 渲染 Then 标签保留、无手输表名且不自动读目录', () => {
  /** 用计数器证明首屏展示只用授权快照。 */
  let reads = 0
  const api = { listServerOpsDataSchemaTables: async () => { reads++; return { databases: [], tables: [] } } }
  const html = renderToStaticMarkup(<ServerOpsAgentTableExclusions source={source} api={api} disabled={false} scope={{ database: 'app', tables: null, excludedTables: ['private_table'], readRows: false }} onChange={() => undefined} />)
  expect(reads).toBe(0)
  expect(html).toContain('已禁用 1 张')
  expect(html).toContain('取消禁用 app.private_table')
  expect(html).toContain('aria-expanded="false"')
  expect(html).not.toContain('<textarea')
  expect(html).not.toContain('type="text"')
})

test('Given 工作台已有当前库 When 渲染连接授权 Then 第一入口直接多选禁用表而不是再次选库', () => {
  /** 直接使用当前库范围，不再展示授权数据库添加器。 */
  const database = renderToStaticMarkup(<ServerOpsAgentDatabaseExclusions source={source} resource={{ kind: 'mysql', sourceId: 'db', instance: false, databases: [createServerOpsQueryableScope('app')] }} currentDatabase="app" disabled={false} onChange={() => undefined} />)
  expect(database).toContain('选择禁用表')
  expect(database).toContain('当前数据库：app')
  expect(database).not.toContain('role="combobox"')
  expect(database).not.toContain('选择要授权的数据库')
  expect(database).not.toContain('删除 app 授权')
  /** 未禁用任何表时不出现旧白名单转换或分层权限。 */
  const scope = renderToStaticMarkup(<ServerOpsAgentTableExclusions source={source} disabled={false} scope={createServerOpsQueryableScope('app')} onChange={() => undefined} />)
  expect(scope).toContain('选择禁用表')
  expect(scope).toContain('默认全部表可查询')
  expect(scope).not.toContain('白名单')
  expect(scope).not.toContain('允许只读 SQL')
  expect(scope).not.toContain('允许行')
})

test('Given 已有其他库禁用项 When 展示当前库编辑 Then 保留其他库入口且不与主入口嵌套混排', () => {
  /** 已保存范围不能因移除选库器而被隐藏或丢弃。 */
  const html = renderToStaticMarkup(<ServerOpsAgentDatabaseExclusions source={source} resource={{ kind: 'mysql', sourceId: 'db', instance: false, databases: [createServerOpsQueryableScope('audit', ['private']), createServerOpsQueryableScope('app')] }} currentDatabase="app" disabled={false} onChange={() => undefined} />)
  expect(html.indexOf('当前数据库：app')).toBeLessThan(html.indexOf('其他已授权数据库'))
  expect(html).toContain('取消禁用 audit.private')
  expect(html).toContain('<details')
})

test('Given 已保存屏蔽授权 When 展示摘要 Then 不声称全部表可读', () => {
  const access: ServerOpsAgentReadAccess = { sessionId: 'test', revision: 1, grantedAt: 1, expiresAt: 1_800_001, resources: [{ kind: 'mysql', sourceId: 'db', instance: false, databases: [{ database: 'app', tables: null, excludedTables: ['private_table'], readRows: true, query: true }] }] }
  const summary = summarizeServerOpsReadAccess(access, 2)
  expect(summary.target).toContain('已禁用 1 张表')
  expect(summary.target).not.toContain('全部表')
  expect(summary.capability).toBe('结构/行/SQL')
})
