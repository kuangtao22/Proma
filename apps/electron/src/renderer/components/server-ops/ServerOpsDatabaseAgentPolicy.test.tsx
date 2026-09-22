import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ServerOpsDataSource } from '@proma/shared'
import { ServerOpsDatabaseAgentPolicy } from './ServerOpsDatabaseAgentPolicy'

/** 不含凭据的合成 MySQL 连接，模拟从项目首页打开弹窗。 */
const source: ServerOpsDataSource = { id: 'db', engine: 'mysql', transport: 'direct', label: '业务库', address: 'example.test', port: 3306, tlsMode: 'verify', hasPassword: false, createdAt: 1, updatedAt: 1 }

describe('数据库禁用表入口', () => {
  test('Given 首页没有工作台选库和禁用项 When 打开编辑区 Then 始终显示可展开的禁用表入口且不自动读取', () => {
    /** 统计目录请求，保证仅渲染卡片不连接数据库。 */
    let reads = 0
    const html = renderToStaticMarkup(<ServerOpsDatabaseAgentPolicy source={source} exclusions={[]} disabled={false}
      api={{ listServerOpsDataSchemaTables: async () => { reads++; return { databases: ['app'], tables: [] } } }} onChange={() => undefined} />)
    expect(html).toContain('选择禁用表')
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('disabled=""')
    expect(html).not.toContain('请先在该连接的数据库工作台')
    expect(reads).toBe(0)
  })

  test('Given 首页连接配置有默认库 When 打开编辑区 Then 直接使用该库显示禁用表入口', () => {
    const html = renderToStaticMarkup(<ServerOpsDatabaseAgentPolicy source={{ ...source, database: 'app' }} exclusions={[]} disabled={false} onChange={() => undefined} />)
    expect(html).toContain('选择禁用表')
    expect(html).toContain('当前数据库：app')
  })

  test('Given 工作台库与默认库不同 When 打开编辑区 Then 保留当前库且其他库禁用项仍可见', () => {
    const html = renderToStaticMarkup(<ServerOpsDatabaseAgentPolicy source={{ ...source, database: 'app' }} currentDatabase="audit"
      exclusions={[{ sourceId: 'db', database: 'app', excludedTables: ['tokens'] }]} disabled={false} onChange={() => undefined} />)
    expect(html).toContain('当前数据库：audit')
    expect(html).toContain('取消禁用 app.tokens')
  })

  test('Given SQLite 无工作台选库 When 打开编辑区 Then 直接展示 main 的禁用表入口', () => {
    const html = renderToStaticMarkup(<ServerOpsDatabaseAgentPolicy source={{ ...source, engine: 'sqlite' }} exclusions={[]} disabled={false} onChange={() => undefined} />)
    expect(html).toContain('选择禁用表')
    expect(html).toContain('当前数据库：main')
  })
})
