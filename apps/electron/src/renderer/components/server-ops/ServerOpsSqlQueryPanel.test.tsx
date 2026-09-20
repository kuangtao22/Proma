import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ServerOpsSqlQueryPanel, ServerOpsSqlQueryResult } from './ServerOpsSqlQueryPanel'
import { ServerOpsSqlQueryHistory } from './ServerOpsSqlQueryHistory'
import { createServerOpsSqlQueryHistoryIdleProjection } from './server-ops-sql-query-history-controller'

describe('ServerOpsSqlQueryPanel', () => {
  test('Given 当前数据库 When 渲染 Then 提供显式执行取消与有界行数控件', () => {
    const html = renderToStaticMarkup(<ServerOpsSqlQueryPanel api={{}} sourceId="source-1" database="app" configurationKey="v1" available />)
    expect(html).toContain('SQL 编辑器')
    expect(html).toContain('执行查询')
    expect(html).toContain('取消查询')
    expect(html).toContain('max="200"')
    expect(html).toContain('Ctrl/Cmd + Enter')
    expect(html).toContain('aria-label="查询说明"')
    expect(html).toContain('aria-label="查询输出"')
    expect(html).toMatch(/role="tab"[^>]*aria-selected="true"[^>]*>.*?查询结果/s)
    expect(html).toContain('查询历史')
    expect(html).toContain('role="tabpanel"')
  })

  test('Given 查询接口缺失 When 渲染 Then 执行入口不可用且说明升级原因', () => {
    const html = renderToStaticMarkup(<ServerOpsSqlQueryPanel api={{}} sourceId="source-1" database="app" configurationKey="v1" available />)
    expect(html).toMatch(/disabled=""[^>]*aria-label="执行查询"|aria-label="执行查询"[^>]*disabled=""/)
    expect(html).toContain('查询接口尚未就绪')
  })

  test('Given 空查询结果 When 渲染 Then 保留真实列头与执行快照', () => {
    const html = renderToStaticMarkup(<ServerOpsSqlQueryResult busy={false} execution={{
      sql: 'SELECT id FROM users',
      database: 'app',
      result: { queryId: 'query-1', database: 'app', columns: ['id'], rows: [], rowCount: 0, durationMs: 12, truncated: false, warnings: [] },
    }} />)
    expect(html).toContain('<th')
    expect(html).toContain('>id</th>')
    expect(html).toContain('执行 SQL：SELECT id FROM users')
    expect(html).toContain('数据库：')
    expect(html).toContain('12 ms')
    expect(html).toContain('查询成功，结果为空')
  })

  test('Given 已保存历史含SQL字面值 When 渲染 Then 显示原语句和回填入口并转义HTML', () => {
    /** SQL 文本保持可复用，但不能作为 HTML 注入列表。 */
    const html = renderToStaticMarkup(<ServerOpsSqlQueryHistory projection={{
      ...createServerOpsSqlQueryHistoryIdleProjection(),
      context: { sourceId: 'source-1', database: 'app', configurationKey: 'v1' },
      status: 'ready',
      entries: [{ id: 'entry-1', sourceId: 'source-1', database: 'app', createdAt: 1, sql: "SELECT '<script>alert(1)</script>' AS value" }],
    }} onUse={() => undefined} onRefresh={() => undefined} />)
    expect(html).toContain('最近 100 条')
    expect(html).toContain('相同语句仅保留一条')
    expect(html).toContain('填入编辑器')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('执行查询')
  })
})
